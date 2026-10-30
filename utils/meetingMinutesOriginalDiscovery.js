'use strict';

const { sanitiseDetails: sanitiseMeetingAgentDetails } = require('./meetingMinutesDraftContext');
const { meetingAgentRefereeRoute, refereeDiscussionTargetId, meetingAgentDispositionError, meetingAgentRefereeAccountedForAllCandidates } = require('./meetingMinutesResponseContracts');
const { meetingAgentRefereeBatchPlan, meetingAgentRunOrderedConcurrent, shouldStopMeetingAgentRefereeBatches } = require('./meetingMinutesRefereeBatches');
const { flattenHybridDiscussion } = require('./meetingMinutesDiscussionRows');

const { SCHEMA_VERSION: MEETING_AGENT_SCHEMA_VERSION } = require("./meetingMinutesAgentV2");
const { actionCandidateInventory } = require("./meetingMinutesAgentV2");
const { actionCommitmentChainInventory } = require("./meetingMinutesAgentV2");
const { actionCommitmentThreadInventory } = require("./meetingMinutesAgentV2");
const { actionRecoveryNeeded } = require("./meetingMinutesAgentV2");
const { discourseSegments } = require("./canonicalMinutes/discourseSegments");
const { discussionActionCandidates } = require("./meetingMinutesAgentV2");
const { discussionAnchorInventory } = require("./meetingMinutesAgentV2");
const { discussionCandidateInventory } = require("./meetingMinutesAgentV2");
const { discussionRecoveryNeeded } = require("./meetingMinutesAgentV2");
const { discussionSelectionCoverage } = require("./meetingMinutesDiscussionCoverage");
const { groundedObjectiveRecords } = require("./meetingMinutesAgentV2");
const { isUsefulReviewFlag: isUsefulMeetingAgentReviewFlag } = require("./meetingMinutesAgentV2");
const { meetingMinutesAgentText } = require("./meetingMinutesPlainText");
const { mergeTimedStepRecovery } = require("./meetingMinutesTimedStepCoverage");
const { normaliseAgentResult } = require("./meetingMinutesAgentV2");
const { normaliseMeetingAgentPassCache } = require("./meetingMinutesPassCache");
const { normaliseRefereeOutput } = require("./refereeNormaliser");
const { normaliseReferenceArrays } = require("./refereeNormaliser");
const { regroupDiscussionBySegments } = require("./canonicalMinutes/discourseSegments");
const { safeLogError } = require("./apiErrors");

const { segmentAnchors } = require("./canonicalMinutes/discourseSegments");
const { segmentLabels } = require("./canonicalMinutes/discourseSegments");
const { semanticPolicyForRun } = require("./meetingMinutesSemanticPolicy");
const { stampPrimaryDiscussionEvidence } = require("./canonicalMinutes/discussionPublication");
const { timedStepCoverage } = require("./meetingMinutesTimedStepCoverage");

function createOriginalDiscovery(services) {
  const {
    awaitPrivateStagedCandidateLedger,
    cachedStagedCandidatesForStage,
    compactMeetingAgentRefereeCandidate,
    dedupeActionDiscoveryInventory,
    dedupeHybridActionProposals,
    dedupeHybridActionRecords,
    deterministicHybridLedger,
    enrichDiscussionEvidenceFromDispositions,
    hybridCandidateLedgerFromResult,
    meetingAgentActionPrimaryPromptForDraft,
    meetingAgentEmptyDiscoveryError,
    meetingAgentEmptyDiscoveryRepairPrompt,
    meetingAgentRefereeRepairCandidates,
    meetingAgentTopicSegmentsEnabled,
    meetingMinutesAgentAnchoredActionEnabled,
    meetingMinutesAgentAnchoredActionPrompt,
    meetingMinutesAgentAnchoredDiscussionEnabled,
    meetingMinutesAgentAnchoredDiscussionPrompt,
    meetingMinutesAgentDedupedCoverageEnabled,
    meetingMinutesAgentFastActionPathEnabled,
    meetingMinutesAgentGlobalDiscussionRefereeEnabled,
    meetingMinutesAgentPrimaryPrompt,
    meetingMinutesAgentPrimaryUnionEnabled,
    meetingMinutesAgentRecoveryPrompt,
    meetingMinutesAgentRefereeContract,
    meetingMinutesAgentRefereePrompt,
    meetingMinutesAgentRefereeRepairPrompt,
    meetingMinutesAgentTopicNamingPrompt,
    meetingMinutesDiscussionActionCandidatesEnabled,
    mergeBatchedMeetingAgentRefereeResults,
    mergeMeetingAgentRefereeResults,
    normaliseAgentCandidateDispositions,
    normaliseAgentDeclaredProposals,
    normaliseAnchoredActionDiscovery,
    normaliseAnchoredDiscussionDiscovery,
    normaliseMeetingAgentRefereeContractResult,
    normaliseRefereeDeclaredProposals,
    peekReadyPrivateStagedCandidateLedger,
    reconstructRefereeActions,
    unionActionDiscoveryResults,
  } = services;

  return async function runOriginalDiscovery(context) {
    let {
      call,
      completedPasses,
      degradedSources,
      details,
      draft,
      options,
      passProvenance,
      salientDetails,
      stage,
      timingAnchor,
      transcript,
      execution,
    } = context;
  const deterministic = deterministicHybridLedger(draft, stage);
  const sourceActionCandidates = stage === 'actions' ? actionCandidateInventory(draft.sourceUnits) : [];
  const deterministicActionCandidates = stage === 'actions'
    ? [...sourceActionCandidates,
      ...(meetingMinutesDiscussionActionCandidatesEnabled()
        ? discussionActionCandidates(draft.discussion || [], draft.sourceUnits,
          [...(sanitiseMeetingAgentDetails(draft.details).internalAttendees || []), ...(sanitiseMeetingAgentDetails(draft.details).clientAttendees || [])])
        : [])]
    : [];
  const actionThreads = stage === 'actions'
    ? actionCommitmentThreadInventory(draft.sourceUnits, deterministicActionCandidates)
    : [];
  const actionChains = stage === 'actions'
    ? actionCommitmentChainInventory(draft.sourceUnits, deterministicActionCandidates)
    : [];
  const actionDiscoveryInventory = stage === 'actions'
    ? (meetingMinutesAgentDedupedCoverageEnabled()
      ? dedupeActionDiscoveryInventory(actionChains, actionThreads, deterministicActionCandidates)
      : [...actionChains, ...actionThreads, ...deterministicActionCandidates])
    : [];
  const cachedStaged = cachedStagedCandidatesForStage(draft, stage);
  const stagedCandidateStartedAt = Date.now();
  let stagedCandidateElapsedMs = 0;
  let stagedCandidatesFromPrewarm = false;
  let stagedJoinPending = false;
  let stagedJoinStatus = cachedStaged.length ? 'cached' : 'pending';
  const stagedPromise = cachedStaged.length
    ? Promise.resolve(cachedStaged)
    : awaitPrivateStagedCandidateLedger(draft, stage, Number(process.env.MEETING_MINUTES_AGENT_STAGED_JOIN_WAIT_MS || 12000)).then((rows) => {
      if (rows === null) {
        stagedJoinPending = true;
        return [];
      }
      stagedCandidatesFromPrewarm = true;
      stagedJoinStatus = 'ready';
      return rows;
    }).catch((error) => {
      stagedJoinStatus = 'failed';
      degradedSources.push(`Staged candidate extraction failed: ${error.message}`);
      return [];
    }).finally(() => { stagedCandidateElapsedMs = Date.now() - stagedCandidateStartedAt; });
  const primaryDiscussionCandidates = stage === 'discussion' ? discussionCandidateInventory(draft.sourceUnits) : [];
  const anchoredDiscussion = stage === 'discussion' && meetingMinutesAgentAnchoredDiscussionEnabled();
  const discussionAnchors = anchoredDiscussion ? discussionAnchorInventory(draft.sourceUnits, {
    maxAnchors: Number(process.env.MEETING_MINUTES_AGENT_DISCUSSION_ANCHOR_LIMIT || 24),
    maxChars: Number(process.env.MEETING_MINUTES_AGENT_DISCUSSION_ANCHOR_BUDGET || 48000)
  }) : [];
  const anchoredActionRecovery = stage === 'actions' && meetingMinutesAgentAnchoredActionEnabled();
  const primaryPrompt = stage === 'actions'
    ? meetingAgentActionPrimaryPromptForDraft(draft)
    : anchoredDiscussion
    ? meetingMinutesAgentAnchoredDiscussionPrompt({
      transcript, details, anchors: discussionAnchors, steer: draft.steer
    })
    : meetingMinutesAgentPrimaryPrompt({
      stage, transcript, details, steer: draft.steer, salientDetails
    });
  const primaryValidationCandidates = stage === 'discussion' ? primaryDiscussionCandidates : actionDiscoveryInventory;
  // Subject naming leg: segments of the transcript, named by the same prompt.
  let topicSegments = [];
  let topicSegmentAnchors = [];
  if (anchoredDiscussion && meetingAgentTopicSegmentsEnabled()) {
    try {
      topicSegments = await discourseSegments(draft.sourceUnits);
      topicSegmentAnchors = segmentAnchors(draft.sourceUnits, topicSegments);
    } catch (error) {
      safeLogError('[meeting-minutes-agent] discourse segmentation skipped', error);
      topicSegments = []; topicSegmentAnchors = [];
    }
  }
  const topicNamingPromise = topicSegmentAnchors.length
    ? call('primary-topics', meetingMinutesAgentTopicNamingPrompt({ transcript, details, anchors: topicSegmentAnchors, steer: draft.steer }), {
      optional: true, maxAttempts: 2, responseKind: 'anchored_discussion_discovery',
      candidateCount: topicSegmentAnchors.length,
      transformResult: (result) => ({ segmentLabels: segmentLabels(result, topicSegmentAnchors) })
    }).catch((error) => { safeLogError('[meeting-minutes-agent] topic naming skipped', error); return null; })
    : Promise.resolve(null);
  // The second discovery leg runs beside the first, never instead of it: it
  // is optional, so a failure here costs nothing but the union.
  const secondPrimaryPromise = stage === 'actions' && meetingMinutesAgentPrimaryUnionEnabled()
    ? call('primary-2', primaryPrompt, {
      optional: true, maxAttempts: 2,
      candidateCount: primaryValidationCandidates.length,
      repairPrompt: meetingAgentEmptyDiscoveryRepairPrompt,
      validateResult: (result) => meetingAgentEmptyDiscoveryError(
        result, stage, primaryValidationCandidates, draft.sourceUnits, { meetingDate: timingAnchor }
      )
    })
    : Promise.resolve(null);
  let [primaryResult, stagedAll, primarySecondResult, topicNaming] = await Promise.all([call('primary', primaryPrompt, {
    optional: true,
    candidateCount: primaryValidationCandidates.length,
    ...(stage === 'actions' ? { repairPrompt: meetingAgentEmptyDiscoveryRepairPrompt } : {}),
    // A valid empty discussion response is a discovery miss, not a transport
    // failure. Repeating the identical request has proved both slow and
    // stochastic; the dedicated gap pass and deterministic ledger are the
    // appropriate recovery path. Actions retain the stricter empty-result
    // validation because their publication gate has different consequences.
    ...(stage === 'discussion' ? {
      maxAttempts: 2,
      // The dedicated AI Builder Discussion Prompt intentionally uses the
      // flat scalar contract which its typed schema editor can enforce. Adapt
      // that response before applying the normal schema-v4/evidence checks.
      responseKind: anchoredDiscussion ? 'anchored_discussion_discovery' : 'discussion_discovery',
      transformResult: anchoredDiscussion
        ? (result) => normaliseAnchoredDiscussionDiscovery(result, discussionAnchors, draft.sourceUnits)
        : (result) => normaliseReferenceArrays(result, {
          validEvidenceIds: (draft.sourceUnits || []).map((unit) => unit?.id).filter(Boolean)
        })
    } : {
      validateResult: (result) => meetingAgentEmptyDiscoveryError(
        result, stage, primaryValidationCandidates, draft.sourceUnits, { meetingDate: timingAnchor }
      )
    })
  }), stagedPromise, secondPrimaryPromise, topicNamingPromise]);
  const topicLabels = Array.isArray(topicNaming?.segmentLabels) ? topicNaming.segmentLabels : [];
  if (stage === 'discussion' && primaryResult && topicLabels.some(Boolean)) {
    const before = (primaryResult.discussion || []).length;
    const regrouped = regroupDiscussionBySegments(primaryResult.discussion, draft.sourceUnits, topicSegments, topicLabels);
    primaryResult = { ...primaryResult, discussion: regrouped.discussion };
    console.info(JSON.stringify({
      event: 'meeting_agent_topic_segments', journeyId: draft.draftId || '',
      segments: topicSegments.length, labelled: topicLabels.filter(Boolean).length,
      topicsBefore: before, topicsAfter: regrouped.discussion.length,
      moved: regrouped.moved, relinked: regrouped.relinked
    }));
  }
  if (primarySecondResult) {
    const before = Array.isArray(primaryResult?.actions) ? primaryResult.actions.length : 0;
    primaryResult = unionActionDiscoveryResults(primaryResult, primarySecondResult);
    console.info(JSON.stringify({
      event: 'meeting_agent_primary_union', journeyId: draft.draftId || '', stage,
      firstLeg: before, secondLeg: (primarySecondResult.actions || []).length,
      union: (primaryResult.actions || []).length
    }));
  }
  if (stage === 'discussion' && !cachedStaged.length && stagedJoinPending && !stagedAll.length) {
    // Discussion completeness benefits from the private staged comparison.
    // Recheck the same cached job once discovery has returned: in the common
    // case it is already complete, and otherwise only this small bounded wait
    // is added before candidate adjudication. Actions retain their existing
    // latency/noise profile and do not wait a second time for staged output.
    const lateRows = await awaitPrivateStagedCandidateLedger(
      draft, stage, Number(process.env.MEETING_MINUTES_AGENT_STAGED_LATE_JOIN_WAIT_MS || 20000)
    ).catch((error) => {
      degradedSources.push(`Staged candidate extraction failed: ${error.message}`);
      return [];
    });
    if (Array.isArray(lateRows)) {
      stagedAll = lateRows;
      stagedCandidatesFromPrewarm = true;
    } else {
      degradedSources.push('Private staged candidates are still processing in the background; this draft continued without blocking on them.');
    }
    stagedCandidateElapsedMs = Date.now() - stagedCandidateStartedAt;
  }
  const stagedCandidateJoin = { initial: stagedJoinStatus, atAdjudication: stagedJoinStatus,
    adoptedWithoutWait: false };
  if (stage === 'actions' && stagedJoinPending && !stagedAll.length) {
    // Discovery can outlast the first join timeout. Adopt only a result that
    // is ALREADY ready for these exact inputs; do not wait or start new work.
    const ready = peekReadyPrivateStagedCandidateLedger(draft, stage);
    stagedCandidateJoin.atAdjudication = ready.status;
    if (ready.status === 'ready') {
      stagedAll = ready.rows;
      stagedCandidatesFromPrewarm = true;
      stagedCandidateJoin.adoptedWithoutWait = true;
    }
  }
  stagedCandidateJoin.usedCount = stagedAll.length;
  const primaryParsed = primaryResult || {
    schemaVersion: MEETING_AGENT_SCHEMA_VERSION,
    meetingObjectives: [], discussion: [], actions: [], actionProposals: [],
    candidateDispositions: [], reviewFlags: []
  };
  // Model actions vetoed by the keyword reading, for the commitment check.
  const vetoedModelActions = [];
  const vetoSink = stage === 'actions' ? { vetoed: vetoedModelActions } : {};
  const primary = normaliseAgentResult(primaryParsed, draft.sourceUnits, stage, { meetingDate: timingAnchor, ...vetoSink });
  if (stage === 'discussion') primary.discussion = stampPrimaryDiscussionEvidence(primary.discussion, draft.sourceUnits);
  if (stage === 'discussion' && !flattenHybridDiscussion(primary.discussion).length) {
    degradedSources.push('Primary discussion discovery returned no grounded propositions; deterministic evidence and gap recovery were used without repeating the same request.');
  }
  const primaryDeclaredProposals = stage === 'actions'
    ? normaliseAgentDeclaredProposals(primaryParsed, draft.sourceUnits, { meetingDate: timingAnchor })
    : [];
  let agentDeclaredProposals = [...primaryDeclaredProposals];
  let agentCandidateDispositions = stage === 'actions'
    ? normaliseAgentCandidateDispositions(primaryParsed, draft.sourceUnits)
    : [];
  const primaryLedger = hybridCandidateLedgerFromResult({
    ...primary,
    objectives: groundedObjectiveRecords(primaryParsed.meetingObjectives || primaryParsed.objectives || [], draft.sourceUnits)
  }, 'primary');
  const staged = stagedAll.filter((candidate) => stage === 'discussion'
    ? ['discussion_point', 'decision', 'open_question', 'objective'].includes(candidate.recordType)
    : candidate.recordType === 'action');
  let ensemble = [
    ...deterministic, ...staged, ...primaryLedger,
    ...hybridCandidateLedgerFromResult({ actions: primaryDeclaredProposals }, 'primary')
  ];
  let recovery = null;
  const represented = stage === 'discussion'
    ? [...flattenHybridDiscussion(primary.discussion).map((item) => item.record), ...staged.map((item) => item.record)]
    : [...primary.actions, ...staged.map((item) => item.record)];
  let recoveryDecision = stage === 'discussion'
    ? discussionRecoveryNeeded(discussionCandidateInventory(draft.sourceUnits), represented)
    : actionRecoveryNeeded(actionDiscoveryInventory, represented);
  const initialTimedStepCoverage = stage === 'actions'
    ? timedStepCoverage(sourceActionCandidates, represented, draft.sourceUnits, { meetingDate: timingAnchor }) : null;
  if (initialTimedStepCoverage) recoveryDecision = mergeTimedStepRecovery(recoveryDecision, initialTimedStepCoverage);
  if (recoveryDecision.needed) {
    const recoveryPolicy = semanticPolicyForRun(draft, options.semanticPolicy);
    const recoveryPrompt = anchoredActionRecovery
      ? meetingMinutesAgentAnchoredActionPrompt({
        transcript, details, candidates: recoveryDecision.uncovered,
        currentActions: primary.actions, steer: draft.steer, mode: 'recovery',
        phaseClarifications: recoveryPolicy.mode === 'on' && recoveryPolicy.phaseClarifications === true
      })
      : meetingMinutesAgentRecoveryPrompt({
        stage, transcript, details, salientDetails,
        current: stage === 'discussion' ? { discussion: primary.discussion } : { actions: primary.actions },
        discussion: stage === 'actions' ? (draft.discussion || []) : [],
        candidates: recoveryDecision.uncovered
      });
    const recoveryParsed = await call('recovery', recoveryPrompt, {
      optional: true,
      candidateCount: recoveryDecision.uncovered.length,
      ...(stage === 'actions' ? { repairPrompt: meetingAgentEmptyDiscoveryRepairPrompt } : {}),
      ...(stage === 'discussion' ? {
        responseKind: 'discussion_discovery',
        transformResult: (result) => normaliseReferenceArrays(result, {
          validEvidenceIds: (draft.sourceUnits || []).map((unit) => unit?.id).filter(Boolean),
          trustedEvidenceLinks: recoveryDecision.uncovered.flatMap((candidate) =>
            (candidate?.evidenceIds || candidate?.record?.evidenceIds || []).map((evidenceId) => ({
              candidateId: candidate?.candidateId,
              evidenceId
            })))
        })
      } : anchoredActionRecovery ? {
        responseKind: 'anchored_action_discovery',
        transformResult: (result) => normaliseAnchoredActionDiscovery(
          result, draft.sourceUnits, { meetingDate: timingAnchor }
        )
      } : {}),
      // A valid empty discussion recovery result means the dedicated gap pass
      // found no additional grounded proposition. Accept it and continue to
      // the Referee instead of paying for repeated identical calls. Action
      // recovery remains strict because a missed commitment has a different
      // publication risk.
      ...(stage === 'discussion' ? {} : {
        validateResult: (result) => meetingAgentEmptyDiscoveryError(
          result, stage, recoveryDecision.uncovered, draft.sourceUnits, { meetingDate: timingAnchor }
        )
      })
    });
    if (recoveryParsed) {
      recovery = normaliseAgentResult(recoveryParsed, draft.sourceUnits, stage, { meetingDate: timingAnchor, ...vetoSink });
      if (stage === 'actions') {
        const recoveryDeclaredProposals = normaliseAgentDeclaredProposals(
          recoveryParsed, draft.sourceUnits, { meetingDate: timingAnchor }
        );
        agentDeclaredProposals.push(...recoveryDeclaredProposals);
        ensemble.push(...hybridCandidateLedgerFromResult({ actions: recoveryDeclaredProposals }, 'recovery'));
        agentCandidateDispositions.push(...normaliseAgentCandidateDispositions(recoveryParsed, draft.sourceUnits));
      }
      ensemble.push(...hybridCandidateLedgerFromResult({
        ...recovery,
        objectives: groundedObjectiveRecords(recoveryParsed.meetingObjectives || recoveryParsed.objectives || [], draft.sourceUnits)
      }, 'recovery'));
    }
  }
  const refereeContract = meetingMinutesAgentRefereeContract(stage, ensemble);
  const suppliedRefereeCandidates = refereeContract.candidates;
  const selectionCoverage = stage === 'discussion'
    ? discussionSelectionCoverage(ensemble, suppliedRefereeCandidates) : null;
  const configuredRefereeBatchSize = stage === 'discussion'
    ? process.env.MEETING_MINUTES_AGENT_DISCUSSION_REFEREE_BATCH_SIZE
    : process.env.MEETING_MINUTES_AGENT_ACTION_REFEREE_BATCH_SIZE;
  const refereeBatchSize = Math.max(1, Math.min(8,
    Number(configuredRefereeBatchSize || process.env.MEETING_MINUTES_AGENT_REFEREE_BATCH_SIZE || 6)));
  const globalDiscussionReferee = stage === 'discussion'
    && meetingMinutesAgentGlobalDiscussionRefereeEnabled();
  const initialRefereePlan = meetingAgentRefereeBatchPlan(
    stage, suppliedRefereeCandidates, refereeBatchSize, globalDiscussionReferee
  );
  const runRefereeBatchSet = async (plan) => {
    const batches = (plan.batches || []).map((batch) => Object.freeze([...(batch || [])]));
    const passProvenanceStart = passProvenance.length;
    const completedPassesStart = completedPasses.length;
    const executeBatch = async (selectedBatchCandidates, batchIndex) => {
      const globalBatch = plan.mode === 'global';
      const batchLabel = globalBatch ? 'global' : String(batchIndex + 1);
      const batchContract = globalBatch
        ? refereeContract
        : meetingMinutesAgentRefereeContract(
          stage, selectedBatchCandidates, `${refereeContract.requestId}:batch:${batchIndex + 1}`, { selected: true }
        );
      const batchCandidates = batchContract.candidates;
      const initialPass = `referee-${globalBatch ? 'global' : `batch-${batchIndex + 1}`}`;
      const repairPass = `referee-${globalBatch ? 'global-repair' : `repair-${batchIndex + 1}`}`;
      const batchUnresolvedIds = [];
      const batchMaterializationIssues = [];
      const batchDegradedSources = [];
      let batchError = null;
      let batchResult = await call(initialPass,
        meetingMinutesAgentRefereePrompt({
          stage, transcript, sourceUnits: draft.sourceUnits, details,
          discussion: stage === 'actions' ? (draft.discussion || []) : [],
          candidates: batchCandidates, allCandidates: suppliedRefereeCandidates,
          salientDetails, requestId: batchContract.requestId, contract: batchContract
        }), {
          optional: true, maxAttempts: 1, responseKind: 'referee', refereeContract: batchContract,
          requestId: batchContract.requestId, candidateCount: batchCandidates.length,
          candidateIds: batchCandidates.map((candidate) => candidate.candidateId),
          transformResult: (result) => normaliseMeetingAgentRefereeContractResult(
            result, batchCandidates, batchContract
          ),
          validateResult: (result) => meetingAgentDispositionError(result, batchCandidates, batchContract, suppliedRefereeCandidates),
          captureError: (error) => {
            batchError = error;
            batchMaterializationIssues.push(...(error.unresolvedMaterializations || []));
          }
        });
      if (!batchResult && batchError?.structurallyUnwritableGroupsOnly === true) {
        const valid = batchError.validCandidateDispositions;
        batchUnresolvedIds.push(...batchError.unresolvedMaterializations.map((issue) => issue.candidateId));
        batchDegradedSources.push(`Referee ${batchLabel} batch contains grouped follow-ups without a supported atomic mapping; review remains required. The unsupported group repair was not retried.`);
        batchResult = {
          schemaVersion: MEETING_AGENT_SCHEMA_VERSION,
          requestId: batchContract.requestId, stage: batchContract.stage,
          expectedCandidateCount: batchCandidates.length, returnedDispositionCount: valid.length,
          repairAttempted: false, candidateDispositions: valid,
          discussion: [], actions: [], actionProposals: [], reviewFlags: []
        };
      } else if (!batchResult) {
        const retainedValid = Array.isArray(batchError?.validCandidateDispositions)
          ? batchError.validCandidateDispositions : [];
        // A strict error normally carries no partial Referee output. In that
        // case retry the entire set: repairing only named rows would silently
        // lose valid rows which never reached Node.
        // When partial output is available, derive the repair subset from the
        // complement of rows which passed *all* contract checks. An output can
        // contain a missing ID and malformed rows simultaneously; selecting
        // only the first reported error class leaves the malformed rows absent
        // after merge and needlessly triggers the old multi-batch fallback.
        const repairCandidates = meetingAgentRefereeRepairCandidates(batchCandidates, retainedValid);
        const repairContract = meetingMinutesAgentRefereeContract(
          stage, repairCandidates, `${batchContract.requestId}:repair`, {
            selected: true,
            retainedDiscussionTargets: [
              ...(batchContract.retainedDiscussionTargets || []),
              ...retainedValid.filter((item) => (item.disposition || item.classification) === 'core')
                .map((item) => ({
                  ...compactMeetingAgentRefereeCandidate(batchCandidates.find((candidate) => candidate.candidateId === item.candidateId)),
                  targetId: refereeDiscussionTargetId(item) || String(item.candidateId || '')
                }))
            ]
          }
        );
        let repairError = null;
        const repaired = await call(repairPass,
          meetingMinutesAgentRefereeRepairPrompt({
            stage, transcript, sourceUnits: draft.sourceUnits, details,
            discussion: stage === 'actions' ? (draft.discussion || []) : [],
            candidates: repairCandidates, allCandidates: suppliedRefereeCandidates,
            salientDetails, requestId: repairContract.requestId, contract: repairContract
          }), {
            optional: true, maxAttempts: 1, responseKind: 'referee', refereeContract: repairContract,
            requestId: repairContract.requestId, candidateCount: repairCandidates.length,
            candidateIds: repairCandidates.map((candidate) => candidate.candidateId),
            transformResult: (result) => normaliseMeetingAgentRefereeContractResult(
              result, repairCandidates, repairContract
            ),
            validateResult: (result) => meetingAgentDispositionError(result, repairCandidates, repairContract, suppliedRefereeCandidates),
            captureError: (error) => {
              repairError = error;
              batchMaterializationIssues.push(...(error.unresolvedMaterializations || []));
            }
          });
        if (repaired) {
          batchResult = retainedValid.length
            ? mergeMeetingAgentRefereeResults({
              requestId: batchContract.requestId, stage: batchContract.stage,
              candidateDispositions: retainedValid
            }, repaired, batchContract)
            : repaired;
          const mergedError = meetingAgentDispositionError(batchResult, batchCandidates, batchContract, suppliedRefereeCandidates);
          if (mergedError) {
            const valid = mergedError.validCandidateDispositions || [];
            const validIds = new Set(valid.map((item) => item.candidateId));
            batchUnresolvedIds.push(...batchCandidates.filter((candidate) => !validIds.has(candidate.candidateId))
              .map((candidate) => candidate.candidateId));
            batchMaterializationIssues.push(...(mergedError.unresolvedMaterializations || []));
            batchDegradedSources.push(`Referee ${batchLabel} batch could not be reconciled after targeted repair: ${mergedError.message}`);
            batchResult = valid.length ? { ...batchResult,
              candidateDispositions: valid, returnedDispositionCount: valid.length, repairAttempted: true } : null;
          }
        } else {
          const repairValid = Array.isArray(repairError?.validCandidateDispositions)
            ? repairError.validCandidateDispositions : [];
          const partialById = new Map([...retainedValid, ...repairValid]
            .map((item) => [meetingMinutesAgentText(item?.candidateId, 160), item])
            .filter(([candidateId]) => candidateId));
          const partialUnresolved = batchCandidates.filter((candidate) =>
            !partialById.has(meetingMinutesAgentText(candidate?.candidateId, 160)));
          batchUnresolvedIds.push(...partialUnresolved.map((candidate) => candidate.candidateId));
          const reason = repairError?.message || batchError?.message || 'The referee batch did not complete.';
          batchDegradedSources.push(`Referee ${batchLabel} batch remained unavailable for ${partialUnresolved.length} candidate${partialUnresolved.length === 1 ? '' : 's'} after targeted repair: ${reason}`);
          if (partialById.size) {
            // Preserve all contract-valid rows from both attempts. Downstream
            // incomplete-accounting handling recovers only the unresolved
            // evidence-backed subset. Returning this partial result also stops
            // a failed global repair from causing four redundant Referee calls.
            batchResult = {
              schemaVersion: MEETING_AGENT_SCHEMA_VERSION,
              requestId: batchContract.requestId,
              stage: batchContract.stage,
              expectedCandidateCount: batchContract.expectedCandidateIds.length,
              returnedDispositionCount: partialById.size,
              repairAttempted: true,
              candidateDispositions: [...partialById.values()],
              discussion: [], actions: [], actionProposals: [], reviewFlags: []
            };
          }
          const deterministicContractFailure = shouldStopMeetingAgentRefereeBatches(batchError, repairError);
          if (!batchResult && deterministicContractFailure) batchDegradedSources.push('stop_remaining_referee_batches');
        }
      }
      return {
        batchResult,
        unresolvedIds: batchUnresolvedIds,
        unresolvedMaterializations: batchMaterializationIssues.filter((issue) => batchUnresolvedIds.includes(issue.candidateId)),
        degradedSources: batchDegradedSources,
        stopRemaining: batchDegradedSources.includes('stop_remaining_referee_batches')
      };
    };

    let ordered;
    const concurrentBatchStage = ['actions', 'discussion'].includes(stage)
      && batches.length > 1 && plan.mode !== 'global';
    if (concurrentBatchStage) {
      const configuredConcurrency = Number(stage === 'discussion'
        ? process.env.MEETING_MINUTES_AGENT_DISCUSSION_REFEREE_CONCURRENCY
        : process.env.MEETING_MINUTES_AGENT_ACTION_REFEREE_CONCURRENCY);
      const defaultConcurrency = stage === 'discussion' ? 4 : 3;
      const concurrencyLimit = Number.isFinite(configuredConcurrency) && configuredConcurrency > 0
        ? configuredConcurrency : defaultConcurrency;
      ordered = (await meetingAgentRunOrderedConcurrent(
        batches, executeBatch, Math.min(batches.length, concurrencyLimit)
      )).values;
    } else {
      ordered = [];
      for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
        const outcome = await executeBatch(batches[batchIndex], batchIndex);
        ordered.push(outcome);
        if (outcome.stopRemaining && batchIndex + 1 < batches.length) {
          const skippedCandidates = batches.slice(batchIndex + 1).flat();
          outcome.unresolvedIds.push(...skippedCandidates.map((candidate) => candidate.candidateId));
          outcome.degradedSources.push(`The remaining ${skippedCandidates.length} referee candidate${skippedCandidates.length === 1 ? '' : 's'} skipped repeated calls after the same strict contract failure occurred twice.`);
          break;
        }
      }
    }

    const refereeOrder = (value = '') => {
      const text = String(value);
      if (/referee-global(?:-repair)?$/.test(text)) return /repair/.test(text) ? 1 : 0;
      const match = text.match(/referee-(?:batch|repair)-(\d+)/);
      if (!match) return Number.MAX_SAFE_INTEGER;
      return (Number(match[1]) - 1) * 2 + (/repair/.test(text) ? 1 : 0);
    };
    const orderedProvenance = passProvenance.splice(passProvenanceStart)
      .sort((left, right) => refereeOrder(left.pass) - refereeOrder(right.pass));
    passProvenance.push(...orderedProvenance);
    const orderedCompleted = completedPasses.splice(completedPassesStart)
      .sort((left, right) => refereeOrder(left) - refereeOrder(right));
    completedPasses.push(...orderedCompleted);
    const refereeCacheEntries = execution.passCache.filter((entry) => entry.stage === stage
      && /^referee-(?:global|global-repair|batch-\d+|repair-\d+)$/.test(entry.pass || ''))
      .sort((left, right) => refereeOrder(left.pass) - refereeOrder(right.pass));
    if (refereeCacheEntries.length) {
      const refereeCacheSet = new Set(refereeCacheEntries);
      execution.passCache = normaliseMeetingAgentPassCache([
        ...execution.passCache.filter((entry) => !refereeCacheSet.has(entry)),
        ...refereeCacheEntries
      ]);
    }
    degradedSources.push(...ordered.flatMap((outcome) => outcome.degradedSources)
      .filter((message) => message !== 'stop_remaining_referee_batches'));
    return {
      results: ordered.map((outcome) => outcome.batchResult).filter(Boolean),
      unresolvedIds: [...new Set(ordered.flatMap((outcome) => outcome.unresolvedIds))],
      unresolvedMaterializations: ordered.flatMap((outcome) => outcome.unresolvedMaterializations || [])
    };
  };
  let refereeRun = await runRefereeBatchSet(initialRefereePlan);
  if (initialRefereePlan.mode === 'global' && !refereeRun.results.length) {
    degradedSources.push('The global discussion referee was unavailable; the existing bounded batch route was used as a fallback.');
    refereeRun = await runRefereeBatchSet(meetingAgentRefereeBatchPlan(
      stage, suppliedRefereeCandidates, refereeBatchSize, false
    ));
  }
  const refereeBatchResults = refereeRun.results;
  const unresolvedRefereeIds = refereeRun.unresolvedIds;
  const mergedRefereeResult = refereeBatchResults.length
    ? mergeBatchedMeetingAgentRefereeResults(refereeBatchResults, refereeContract)
    : {
    schemaVersion: MEETING_AGENT_SCHEMA_VERSION,
    meetingObjectives: [], discussion: [], actions: [], actionProposals: [],
    candidateDispositions: [], reviewFlags: []
  };
  const refereeParsed = normaliseRefereeOutput(mergedRefereeResult, suppliedRefereeCandidates, {
    preserveUntargetedSupporting: stage === 'discussion'
  })
    || mergedRefereeResult;
  if (refereeBatchResults.length && !completedPasses.includes('referee')) completedPasses.push('referee');
  if (unresolvedRefereeIds.length) {
    degradedSources.push(`${unresolvedRefereeIds.length} referee candidate${unresolvedRefereeIds.length === 1 ? '' : 's'} remained unresolved; only those candidates use evidence-grounded fallback handling.`);
  }
  const refereeRoute = completedPasses.includes('referee')
    ? meetingAgentRefereeRoute(refereeParsed, refereeContract)
    : 'not_completed';
  const fastRefereeAuthoritative = stage === 'actions' && meetingMinutesAgentFastActionPathEnabled()
    && meetingAgentRefereeAccountedForAllCandidates(refereeParsed, refereeContract, refereeRoute);
  if (fastRefereeAuthoritative) {
    console.log(JSON.stringify({
      event: 'meeting_agent_fast_action_path', journeyId: draft.draftId, stage,
      expectedCandidateCount: refereeContract.expectedCandidateIds.length, skipped: ['critic', 'salvage']
    }));
  }
  const reconstructedRefereeActions = stage === 'actions'
    ? reconstructRefereeActions(
      refereeParsed?.candidateDispositions,
      suppliedRefereeCandidates,
      draft.sourceUnits,
      { meetingDate: timingAnchor, ownerPool: ensemble, journeyId: draft.draftId || '' }
    )
    : { actions: [], actionProposals: [] };
  const unresolvedActionMaterializations = [
    ...(refereeRun.unresolvedMaterializations || []),
    ...(reconstructedRefereeActions.unresolvedMaterializations || [])
  ];
  const refereeInput = stage === 'discussion' ? {
    ...refereeParsed,
    discussion: enrichDiscussionEvidenceFromDispositions(
      refereeParsed?.discussion,
      refereeParsed?.candidateDispositions,
      ensemble
    )
  } : {
    ...refereeParsed,
    discussion: Array.isArray(refereeParsed?.discussion) ? refereeParsed.discussion : [],
    actions: dedupeHybridActionRecords([
      ...(Array.isArray(refereeParsed?.actions) ? refereeParsed.actions : []),
      ...reconstructedRefereeActions.actions
    ]),
    actionProposals: dedupeHybridActionProposals([
      ...(Array.isArray(refereeParsed?.actionProposals) ? refereeParsed.actionProposals : []),
      ...reconstructedRefereeActions.actionProposals
    ])
  };
  const referee = normaliseAgentResult(refereeInput, draft.sourceUnits, stage, { meetingDate: timingAnchor, ...vetoSink });
  const settledRefereeActionDispositions = stage === 'actions'
    ? normaliseAgentCandidateDispositions(refereeParsed, draft.sourceUnits) : [];
  if (stage === 'actions') {
    agentDeclaredProposals.push(...normaliseRefereeDeclaredProposals(
      refereeParsed, reconstructedRefereeActions, draft.sourceUnits, { meetingDate: timingAnchor }
    ));
    agentCandidateDispositions.push(...settledRefereeActionDispositions);
  }
  const priorLedger = (draft.candidateLedger || []).filter((candidate) => stage === 'discussion'
    ? candidate.recordType === 'action'
    : !['action'].includes(candidate.recordType));
  const candidateLedger = [...new Map([...priorLedger, ...stagedAll, ...ensemble].map((candidate) => [candidate.candidateId, candidate])).values()].slice(0, 1200);
  const refereeFlags = referee.reviewFlags.filter(isUsefulMeetingAgentReviewFlag);

    return {
      ...context,
      cachedStaged,
      candidateLedger,
      ensemble,
      primary,
      primaryParsed,
      recovery,
      referee,
      refereeContract,
      refereeFlags,
      refereeParsed,
      refereeRoute,
      selectionCoverage,
      stagedCandidateElapsedMs,
      stagedCandidatesFromPrewarm,
      suppliedRefereeCandidates,
      topicLabels,
      topicSegments,
      actionChains,
      actionDiscoveryInventory,
      actionThreads,
      agentCandidateDispositions,
      agentDeclaredProposals,
      fastRefereeAuthoritative,
      initialTimedStepCoverage,
      primarySecondResult,
      settledRefereeActionDispositions,
      sourceActionCandidates,
      stagedCandidateJoin,
      unresolvedActionMaterializations,
      vetoedModelActions,
    };
  };
}

module.exports = { createOriginalDiscovery };
