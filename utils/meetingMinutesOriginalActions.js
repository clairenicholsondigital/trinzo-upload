'use strict';

const { finaliseMeetingAgentTimingProposal, finaliseActionTimings, reconcileSiblingTimingDecisions } = require('./meetingMinutesProposalTiming');
const { retainedDocumentReferenceReviewFlags } = require('./meetingMinutesProposalReview');

const { isVagueReconstructedAction } = require('./meetingMinutesDraftView');

const { stripMinorCommunicationCourtesy } = require('./meetingMinutesPublication');

const { surroundingEvidence } = require('./meetingMinutesEvidenceContext');

const { normaliseAgentDeclaredProposals } = require('./meetingMinutesDiscoveryValidation');

const {
  dedupeHybridActionProposals, dedupeHybridActionRecords, isClientReadyActionWording,
  mergePublishedActionEvidence
} = require('./meetingMinutesActionDuplicatePolicy');
const { meetingAgentInfrastructureFailure, normaliseAgentCandidateDispositions, reconcileRefereeActionMaterialization } = require('./meetingMinutesResponseContracts');
const {
  isUsefulReviewFlag: isUsefulMeetingAgentReviewFlag, normaliseFlag: normaliseMeetingAgentFlag,
  reconcileRecordFlags, mergeMeetingAgentFlags, meetingAgentProposalReviewFlagId
} = require('./meetingMinutesReviewFlags');
const { actionNegatedByEvidence, isMeetingAdminAction } = require('./meetingMinutesActionEvidence');
const { applyRequesterOwnerRule, meetingAgentPeopleNames } = require('./meetingMinutesPeopleEvidence');

const { TIMING_POLICY_VERSION } = require('./meetingMinutesTiming');
const {
  actionCompletenessCheckItems, actionCompletenessCheckPrompt, answeredCheckItems, answeredCheckPrompt,
  applyActionCompletenessResults, applyAnsweredCheckResults, applyChainedTimingRule,
  applyCommitmentCheckResults, applyCompletedInMeetingCheckResults, applyFinalActionLifecycleResults,
  applyTimingCheckResults, applyTimingClauseChecks, attachNearbyDependencyConditions,
  backfillActionCommitmentEvidence, commitmentCheckItems, commitmentCheckPrompt,
  completedInMeetingCheckItems, completedInMeetingCheckPrompt, describesUsualPractice,
  finalActionLifecycleCheckItems, finalActionLifecycleCheckPrompt,
  isAobPersonalAside, isFarewellAction, isMinuteInstruction, isNotAnAction, isSocialAside,
  answeredCheckEnabled: meetingMinutesAnsweredCheckEnabled,
  commitmentCheckEnabled: meetingMinutesCommitmentCheckEnabled,
  timingCheckEnabled: meetingMinutesTimingCheckEnabled, mergeDuplicateCommitments,
  softenBestEffortCompletion, splitExplicitMultiOwnerActions,
  timingCheckItems, timingCheckPrompt, uncoveredCandidateInventory
} = require('./meetingMinutesAgentV2');
const { correctnessChecksEnabled } = require('./meetingMinutesEvidenceChecks');
const {
  timingClauseChecksEnabled: meetingMinutesTimingClauseChecksEnabled
} = require('./meetingMinutesActionTimingInference');
const { normaliseAgentResult } = require('./meetingMinutesResultNormalization');
const actionDiagnostics = require('./meetingMinutesActionDiagnostics');
const {
  annotateMeetingAgentPassImpact, meetingAgentCallPerformance, meetingAgentExecutionTelemetry,
  meetingAgentMaterialPassImpact
} = require('./meetingMinutesAgentGeneration');
const { applyPresenterAidGate } = require('./presenterAidGate');
const { buildProposal } = require('./meetingMinutesProposals');
const crypto = require('crypto');
const discussionActionSeparation = require('./canonicalMinutes/discussionActionSeparation');
const discussionClaims = require('./canonicalMinutes/discussionClaimConsolidation');
const { meetingMinutesAgentText } = require('./meetingMinutesPlainText');
const { normalisePublishedParticipantReference } = require('./entityNormalization');
const { removeDiscussionActionDuplicates } = require('./discussionShape');
const { timedStepCoverage } = require('./meetingMinutesTimedStepCoverage');
const timingRecovery = require('./meetingMinutesTimingRecovery');
const { meetingAgentReviewPacketError } = require('./meetingMinutesReviewAccounting');

function createOriginalActionsStage(services) {
  const {
    acceptedVisitAssignmentActions,
    annotateActionProposalChains,
    commitmentThreadBackstopProposals,
    corroboratedOmittedActionProposals,
    criticConfirmedActionPromotions,
    dedupeCommitmentsSemantically,
    foldUnownedNearCopies,
    gateTranscriptShapedActionChanges,
    gateTranscriptShapedActions,
    highConfidenceRefereedAction,
    hybridActionSourceInfo,
    hybridCandidateCoveredByRecord,
    hybridCandidateDispositions,
    hybridCandidateLedgerFromResult,
    isReviewableActionProposal,
    meetingAgentActionAuditCandidates,
    meetingAgentCommitmentRecheckNeeded,
    meetingAgentProposalChangeIsVisible,
    meetingMinutesAgentCompactDiscussionEnabled,
    meetingMinutesAgentCriticPrompt,
    meetingMinutesAgentSalvagePrompt,
    meetingMinutesMinuteInstructionRuleEnabled,
    meetingMinutesProposalRecheckEnabled,
    preselectActionProposal,
    publishedActionCoversProposal,
    reconcileAcceptedRefereeActions,
    reconcileFinalApprovedActions,
    removePublishedActionProposalDuplicates,
    safeAgentProposalPromotion,
    splitCompoundActionList,
    strongOmittedDiscoveryProposals,
    strongUnresolvedActionCandidateFlags,
    traceOwners,
    traceProposals,
    unresolvedOperationalGapProposals,
  } = services;

  return async function runOriginalActionsStage(context) {
    let {
      actionChains,
      actionDiscoveryInventory,
      actionThreads,
      agentCandidateDispositions,
      agentDeclaredProposals,
      cachedStaged,
      call,
      candidateLedger,
      completedPasses,
      degradedSources,
      details,
      draft,
      ensemble,
      fastRefereeAuthoritative,
      initialTimedStepCoverage,
      options,
      passProvenance,
      primary,
      primarySecondResult,
      recovery,
      referee,
      refereeFlags,
      refereeRoute,
      settledRefereeActionDispositions,
      sourceActionCandidates,
      stage,
      stageStartedAt,
      stagedCandidateElapsedMs,
      stagedCandidateJoin,
      stagedCandidatesFromPrewarm,
      timingAnchor,
      transcript,
      unresolvedActionMaterializations,
      vetoedModelActions,
      execution,
    } = context;
    let refereeActions = referee.actions.filter((record) => !isVagueReconstructedAction(record.action)
      && isClientReadyActionWording(record.action));

    const sparseFloor = Math.max(2, Math.ceil(primary.actions.length * 0.5));
    if (primary.actions.length && refereeActions.length < sparseFloor) {
      degradedSources.push('The final action referee returned an implausibly sparse result; the evidence-normalised primary draft was retained for safety.');
      refereeActions = primary.actions;
    }
    actionDiagnostics.checkpoint('referee_publication', refereeActions);
    // The second discovery leg is a discovery source in its own right. Its
    // actions were folded into the first leg's list for the referee, so an
    // action both legs found still counted as one source and a referee
    // "proposal" left it in the suggestions queue (draft 1055: three real,
    // owned actions). Added after the referee so its prompts are unchanged.
    if (stage === 'actions' && primarySecondResult) {
      const secondLeg = normaliseAgentResult(primarySecondResult, draft.sourceUnits, 'actions', { meetingDate: timingAnchor });
      ensemble.push(...hybridCandidateLedgerFromResult({ actions: secondLeg.actions }, 'primary-2'));
    }
    const automatic = [];
    let singleSource = [];
    let highConfidencePromotionCount = 0;
    for (const action of refereeActions) {
      const sourceInfo = hybridActionSourceInfo(action, ensemble);
      if (sourceInfo.discoverySources.length >= 2 || sourceInfo.explicitDeterministic
        || highConfidenceRefereedAction(action, ensemble, draft.sourceUnits)) {
        automatic.push(action);
        if (sourceInfo.discoverySources.length < 2 && !sourceInfo.explicitDeterministic) highConfidencePromotionCount += 1;
      } else singleSource.push(action);
    }
    const acceptedVisitAssignments = acceptedVisitAssignmentActions(
      draft.sourceUnits, refereeActions, { meetingDate: timingAnchor }
    );
    automatic.push(...acceptedVisitAssignments);
    if (options.onPreview) {
      await options.onPreview({
        previewActions: dedupeHybridActionRecords([...refereeActions, ...acceptedVisitAssignments]),
        previewUpdatedAt: new Date().toISOString()
      });
    }
    // Audit the publication set, not the referee's entire working set. This lets
    // the critic independently confirm a strong single-source referee action;
    // auditing refereeActions would instruct it not to return the very records
    // that need a second judgement before automatic publication.
    const remaining = uncoveredCandidateInventory(actionDiscoveryInventory, automatic);
    const criticCandidates = fastRefereeAuthoritative ? [] : meetingAgentActionAuditCandidates(remaining, 12000, 40);
    let criticError = null;
    const criticPrompt = criticCandidates.length ? meetingMinutesAgentCriticPrompt({
      transcript, details, discussion: draft.discussion || [], actions: automatic, candidates: criticCandidates
    }) : '';
    const criticParsed = criticCandidates.length ? await call('critic', criticPrompt, {
      optional: true, candidateCount: criticCandidates.length,
      captureError: (error) => { criticError = error; }
    }) : null;
    const critic = normaliseAgentResult(criticParsed || {}, draft.sourceUnits, 'actions', { meetingDate: timingAnchor });
    agentDeclaredProposals.push(...normaliseAgentDeclaredProposals(criticParsed || {}, draft.sourceUnits, { meetingDate: timingAnchor }));
    agentCandidateDispositions.push(...normaliseAgentCandidateDispositions(criticParsed || {}, draft.sourceUnits));
    const criticPromotions = criticConfirmedActionPromotions(
      critic.actions, singleSource, ensemble, draft.sourceUnits, { meetingDate: timingAnchor }
    ).filter((record) => !automatic.some((existing) => publishedActionCoversProposal(existing, record)));
    if (criticPromotions.length) {
      automatic.push(...criticPromotions);
      singleSource = singleSource.filter((record) => !criticPromotions.some((promoted) => publishedActionCoversProposal(promoted, record)));
    }
    const unpromotedCriticActions = critic.actions.filter((record) => !criticPromotions.some((promoted) => publishedActionCoversProposal(promoted, record)));
    const salvageCandidates = (fastRefereeAuthoritative ? [] : uncoveredCandidateInventory(
      actionDiscoveryInventory,
      [...automatic, ...critic.actions]
    )).filter((candidate) => candidate?.context
      // Salvage is an expensive last adjudication, not another general sweep.
      // Lower-priority unresolved rows remain available to the deterministic
      // proposal backstops below without consuming another Microsoft call.
      && Number(candidate.priority || 0) >= 8
      && ['committed', 'accepted_request', 'conditional_commitment'].includes(candidate.dispositionHint))
      .slice(0, Math.max(1, Math.min(12,
        Number(process.env.MEETING_MINUTES_AGENT_SALVAGE_CANDIDATE_LIMIT || 8))));
    let salvage = { actions: [], reviewFlags: [] };
    let salvagePrompt = '';
    const salvageSkippedAfterInfrastructureFailure = salvageCandidates.length > 0
      && meetingAgentInfrastructureFailure(criticError);
    if (salvageSkippedAfterInfrastructureFailure) {
      degradedSources.push('The action salvage pass was not started because the preceding critic failed at the Power Automate transport boundary; evidence-backed candidates remain available as review proposals.');
    } else if (salvageCandidates.length) {
      salvagePrompt = meetingMinutesAgentSalvagePrompt({
        transcript, details, actions: automatic, candidates: salvageCandidates
      });
      const salvageParsed = await call('salvage', salvagePrompt, {
        optional: true, candidateCount: salvageCandidates.length
      });
      salvage = normaliseAgentResult(salvageParsed || {}, draft.sourceUnits, 'actions', { meetingDate: timingAnchor });
      agentDeclaredProposals.push(...normaliseAgentDeclaredProposals(salvageParsed || {}, draft.sourceUnits, { meetingDate: timingAnchor }));
      agentCandidateDispositions.push(...normaliseAgentCandidateDispositions(salvageParsed || {}, draft.sourceUnits));
      const salvageLedger = hybridCandidateLedgerFromResult(salvage, 'salvage');
      ensemble.push(...salvageLedger);
      for (const candidate of salvageLedger) {
        if (!candidateLedger.some((existing) => existing.candidateId === candidate.candidateId)) candidateLedger.push(candidate);
      }
      candidateLedger.splice(1200);
    }
    const salvageAutomatic = [];
    const salvageProposal = [];
    for (const action of salvage.actions) {
      const sourceInfo = hybridActionSourceInfo(action, ensemble);
      if (sourceInfo.discoverySources.length >= 2 || sourceInfo.explicitDeterministic) salvageAutomatic.push(action);
      else salvageProposal.push(action);
    }
    automatic.push(...salvageAutomatic.filter((record) => !automatic.some((existing) => publishedActionCoversProposal(existing, record))));
    const candidateBackstop = corroboratedOmittedActionProposals(
      ensemble, [...refereeActions, ...critic.actions], draft.sourceUnits, { meetingDate: timingAnchor }
    );
    const strongDiscoveryBackstop = strongOmittedDiscoveryProposals(
      ensemble,
      [...refereeActions, ...critic.actions, ...salvage.actions, ...candidateBackstop],
      draft.sourceUnits,
      { meetingDate: timingAnchor }
    );
    const processGapBackstop = unresolvedOperationalGapProposals(
      draft.discussion || [], [...refereeActions, ...critic.actions, ...candidateBackstop, ...strongDiscoveryBackstop], draft.sourceUnits,
      { meetingDate: timingAnchor }
    );
    const threadBackstop = commitmentThreadBackstopProposals(
      [...actionChains, ...actionThreads], [...refereeActions, ...critic.actions, ...candidateBackstop, ...strongDiscoveryBackstop, ...processGapBackstop], draft.sourceUnits,
      { meetingDate: timingAnchor }
    );
    let commitmentRescueCount = 0;
    let proposalRescueCount = 0;
    let rescuedActionTexts = [];
    const proposalRecheck = meetingMinutesProposalRecheckEnabled();
    if (meetingMinutesCommitmentCheckEnabled() && (vetoedModelActions.length || proposalRecheck)) {
      // Model-extracted work that did not reach the published list gets one
      // quote-verified look: actions the keyword reading vetoed and, when
      // enabled, the model's own proposals. A proposal is published only with a
      // verified commitment quote and a named owner the passage supports.
      const notPublished = (record) => meetingAgentCommitmentRecheckNeeded(record, automatic);
      const deterministic = [...candidateBackstop, ...strongDiscoveryBackstop, ...processGapBackstop, ...threadBackstop];
      const covered = [...automatic, ...singleSource, ...critic.actions, ...salvage.actions, ...deterministic, ...agentDeclaredProposals];
      const vetoRecheck = dedupeHybridActionRecords(vetoedModelActions.filter((record) => notPublished(record)
        && (proposalRecheck || !covered.some((existing) => publishedActionCoversProposal(existing, record)))));
      const poolRecheck = proposalRecheck
        ? dedupeHybridActionRecords([...singleSource, ...unpromotedCriticActions, ...salvageProposal, ...agentDeclaredProposals]
          .filter((record) => (record.owners || []).length && notPublished(record)
            && !vetoRecheck.some((existing) => publishedActionCoversProposal(existing, record))))
        : [];
      const recheck = [...vetoRecheck, ...poolRecheck].slice(0, 24);
      const commitmentItems = commitmentCheckItems(recheck, draft.sourceUnits);
      const commitmentBatches = [];
      for (let index = 0; index < commitmentItems.length; index += 8) commitmentBatches.push(commitmentItems.slice(index, index + 8));
      const commitmentResults = (await Promise.all(commitmentBatches.map((batch, index) => call(
        `critic-commitment-${index + 1}`, commitmentCheckPrompt(batch),
        { optional: true, responseKind: 'commitment_check', maxAttempts: 2, candidateCount: batch.length }
      )))).flatMap((result) => (Array.isArray(result?.results) ? result.results : []));
      const fromPool = new Set(poolRecheck.map((record) => record.action));
      const poolItems = commitmentItems.filter((item) => fromPool.has(recheck[item.index].action));
      const vetoItems = commitmentItems.filter((item) => !fromPool.has(recheck[item.index].action));
      const rescued = [
        ...applyCommitmentCheckResults(recheck, vetoItems, commitmentResults),
        // A proposal becomes published only when the verified words tie the work to its owner.
        ...applyCommitmentCheckResults(recheck, poolItems, commitmentResults, { requireOwnerTie: true })
      ];
      const accepted = rescued.filter((record) => !fromPool.has(record.action) || (record.owners || []).length);
      proposalRescueCount = accepted.filter((record) => fromPool.has(record.action)).length;
      rescuedActionTexts = accepted.map((record) => meetingMinutesAgentText(record.action, 200));
      commitmentRescueCount = accepted.length - proposalRescueCount;
      automatic.push(...accepted);
    }
    const publishedActions = dedupeHybridActionRecords(automatic, { sourceUnits: draft.sourceUnits })
      .filter((record) => !isVagueReconstructedAction(record.action));
    agentDeclaredProposals = dedupeHybridActionRecords(agentDeclaredProposals)
      .filter((record) => !publishedActions.some((existing) => hybridCandidateCoveredByRecord({
        recordType: 'action', text: record.action, evidenceIds: record.evidenceIds, record
      }, existing)));
    const proposalCandidates = dedupeHybridActionProposals([
      ...singleSource, ...unpromotedCriticActions, ...salvageProposal, ...agentDeclaredProposals,
      ...candidateBackstop, ...strongDiscoveryBackstop, ...processGapBackstop, ...threadBackstop
    ]);
    // Apply one publication rule after every proposal-producing branch has been
    // combined. Previously an identical safe commitment could be promoted or
    // review-gated solely according to which Agent response property carried it.
    traceProposals('proposalCandidates', proposalCandidates, draft.draftId);
    const safeProposalPromotions = proposalCandidates.filter((record) =>
      !isVagueReconstructedAction(record.action)
      && !isAobPersonalAside(record, draft.sourceUnits)
      && safeAgentProposalPromotion(record, ensemble, draft.sourceUnits));
    automatic.push(...safeProposalPromotions.filter((record) => !automatic.some((existing) =>
      hybridCandidateCoveredByRecord({ recordType: 'action', text: record.action, evidenceIds: record.evidenceIds, record }, existing))));
    const remainingProposalCandidates = proposalCandidates.filter((record) =>
      !safeProposalPromotions.includes(record) && !isVagueReconstructedAction(record.action)
      && !isAobPersonalAside(record, draft.sourceUnits)
      && isReviewableActionProposal(record, draft.sourceUnits));
    traceProposals('safePromotions', safeProposalPromotions, draft.draftId);
    traceProposals('remainingProposalCandidates', remainingProposalCandidates, draft.draftId);
    const finalPublishedActions = dedupeHybridActionRecords(automatic, { sourceUnits: draft.sourceUnits })
      .filter((record) => !isVagueReconstructedAction(record.action));
    const acceptedActionAccounting = reconcileAcceptedRefereeActions(
      finalPublishedActions, refereeActions, remainingProposalCandidates, ensemble, draft.sourceUnits
    );
    // A named-owner commitment that passed the strict transcript gate in the
    // primary extraction must not vanish solely because a later aggregation
    // response omitted it. This uses the same narrow grounding test as Referee
    // reconciliation and never promotes suggestion/status evidence.
    const primaryActionAccounting = reconcileAcceptedRefereeActions(
      acceptedActionAccounting.actions, primary.actions, remainingProposalCandidates, ensemble, draft.sourceUnits
    );
    traceProposals('publishedBeforeComplete', primaryActionAccounting.actions, draft.draftId);
    const completeNormalised = normaliseAgentResult({
      actions: [...primaryActionAccounting.actions, ...remainingProposalCandidates]
    }, draft.sourceUnits, 'actions', { enforceEvidence: false, meetingDate: timingAnchor }).actions;
    traceProposals('completeNormalised', completeNormalised, draft.draftId);
    const complete = dedupeHybridActionRecords(completeNormalised, { sourceUnits: draft.sourceUnits });
    traceProposals('complete', complete, draft.draftId);
    const reconciledPublishedActions = attachNearbyDependencyConditions(backfillActionCommitmentEvidence(
      mergePublishedActionEvidence(primaryActionAccounting.actions, complete), draft.sourceUnits,
      { meetingDate: timingAnchor }
    ), draft.sourceUnits);
    traceProposals('reconciledPublished', reconciledPublishedActions, draft.draftId);
    const builtProposal = removePublishedActionProposalDuplicates(
      buildProposal('actions', reconciledPublishedActions, complete), reconciledPublishedActions
    );
    builtProposal.changes = gateTranscriptShapedActionChanges(
      (builtProposal.changes || []).filter(meetingAgentProposalChangeIsVisible),
      draft.sourceUnits, draft.draftId, 'proposal'
    );
    traceProposals('builtProposal', builtProposal.changes, draft.draftId);
    const proposal = annotateActionProposalChains(builtProposal, actionChains);
    const corroboratedProposalIds = new Set(candidateBackstop.map((action) => action.id));
    const strongDiscoveryProposalIds = new Set(strongDiscoveryBackstop.map((action) => action.id));
    const processGapProposalIds = new Set(processGapBackstop.map((action) => action.id));
    const threadBackstopProposalIds = new Set(threadBackstop.map((action) => action.id));
    const proposalFlags = proposal.changes.filter((change) => change.type === 'add').map((change, index) => normaliseMeetingAgentFlag({
      id: meetingAgentProposalReviewFlagId(change),
      kind: 'possible_missed_follow_up',
      message: corroboratedProposalIds.has(change.after?.id)
        ? `Possible action to check. It was found twice in the transcript but not added automatically: ${change.after?.action || 'Review this proposed action.'}`
        : strongDiscoveryProposalIds.has(change.after?.id)
          ? `Possible action to check. Someone clearly committed to this, but it was not added automatically: ${change.after?.action || 'Review this proposed action.'}`
        : processGapProposalIds.has(change.after?.id)
          ? `Possible follow-up to check. A question about a current process gap was left open, and no one took it on: ${change.after?.action || 'Review this proposed follow-up.'}`
          : threadBackstopProposalIds.has(change.after?.id)
            ? `Possible action to check. Someone asked for this and it was accepted, but it was not added automatically: ${change.after?.action || 'Review this proposed action.'}`
          : `Possible action to check. The transcript suggests it, but it was not added automatically: ${change.after?.action || 'Review this proposed action.'}`,
      evidenceIds: change.after?.evidenceIds || []
    }, index));
    const proposedRecords = proposal.changes.filter((change) => change.type === 'add').map((change) => change.after).filter(Boolean);
    const proposedEvidenceSets = [...reconciledPublishedActions, ...proposedRecords]
      .map((record) => new Set(record.evidenceIds || []));
    const unresolvedStrongCandidateFlags = strongUnresolvedActionCandidateFlags(
      actionDiscoveryInventory, complete
    ).filter((flag) => {
      const flagIds = flag.evidenceIds || [];
      return !proposedEvidenceSets.some((ids) => flagIds.length && flagIds.some((id) => ids.has(id)));
    });
    const materializationReview = reconcileRefereeActionMaterialization(
      unresolvedActionMaterializations, ensemble,
      hybridCandidateDispositions(ensemble, reconciledPublishedActions, proposedRecords),
      draft.sourceUnits, settledRefereeActionDispositions
    );
    const candidateDispositions = materializationReview.candidateDispositions;
    const passImpact = meetingAgentMaterialPassImpact(candidateDispositions, {
      referee: { materialContributionCount: completedPasses.includes('referee')
        ? reconciledPublishedActions.length + proposedRecords.length : 0,
        materialCandidateIds: candidateDispositions.filter((item) =>
          ['publish', 'proposal', 'supporting'].includes(item?.disposition))
          .map((item) => meetingMinutesAgentText(item?.candidateId, 160)).filter(Boolean) },
      critic: { materialContributionCount: criticPromotions.length
        + unpromotedCriticActions.filter((record) => proposedRecords.some((proposalRecord) =>
          hybridCandidateCoveredByRecord({
            recordType: 'action', text: record.action, evidenceIds: record.evidenceIds, record
          }, proposalRecord))).length },
      salvage: { materialContributionCount: salvageAutomatic.length
        + salvageProposal.filter((record) => proposedRecords.some((proposalRecord) =>
          hybridCandidateCoveredByRecord({
            recordType: 'action', text: record.action, evidenceIds: record.evidenceIds, record
          }, proposalRecord))).length }
    });
    const measuredProvenance = annotateMeetingAgentPassImpact(passProvenance, passImpact);
    // Timing ownership is corrected once, on what the reviewer will see, so
    // every change carries its flag.
    traceOwners('reconciledPublished', reconciledPublishedActions, draft.draftId);
    let timingChecked = meetingMinutesTimingClauseChecksEnabled()
      ? applyTimingClauseChecks(reconciledPublishedActions, draft.sourceUnits, { meetingDate: timingAnchor })
      : { actions: reconciledPublishedActions, flags: [] };
    traceOwners('timingClause', timingChecked.actions, draft.draftId);
    timingChecked = {
      ...timingChecked,
      actions: foldUnownedNearCopies(
        gateTranscriptShapedActions(timingChecked.actions, draft.sourceUnits, draft.draftId, 'published'), draft.draftId)
    };
    traceOwners('gate+foldUnowned', timingChecked.actions, draft.draftId);
    let timingRecoveryAudit = null;
    if (meetingMinutesTimingCheckEnabled()) {
      // The model says which step each timing was spoken for, quoting the
      // passage; applyTimingCheckResults verifies every quote before changing
      // anything. A failed call preserves the work and leaves explicit unresolved
      // accounting; independent source-integrity checks still reject proven errors.
      const timingItems = timingCheckItems(timingChecked.actions, draft.sourceUnits, { meetingDate: timingAnchor });
      const timingBatches = [];
      for (let index = 0; index < timingItems.length; index += 8) timingBatches.push(timingItems.slice(index, index + 8));
      const timingResults = (await Promise.all(timingBatches.map((batch, index) => call(
        `critic-timing-${index + 1}`, timingCheckPrompt(batch, timingAnchor),
        { optional: true, responseKind: 'timing_check', maxAttempts: 2, candidateCount: batch.length,
          validateResult: result => meetingAgentReviewPacketError(batch, result, ['correct', 'qualified', 'belongs_to_other_step', 'past_event', 'misread', 'uncertain']) }
      )))).flatMap((result) => (Array.isArray(result?.results) ? result.results : []));
      const recoveryStartedAt = Date.now();
      const reviewed = /^(?:0|false)$/i.test(process.env.MEETING_MINUTES_AGENT_TIMING_RECOVERY_V1 || '1')
        ? applyTimingCheckResults(timingChecked.actions,timingItems,timingResults,{meetingDate:timingAnchor})
        : await timingRecovery.review(timingChecked.actions, timingItems, timingResults, draft.sourceUnits, {
        meetingDate: timingAnchor, nominalEnabled: /^(?:1|true)$/i.test(process.env.MEETING_MINUTES_AGENT_NOMINAL_TIMING_PROOF_V1 || '0'),
        request: (part,prompt,budget) => call('critic-timing-recovery-'+part,prompt,{optional:true,silentOptionalFailure:true,responseKind:part==='isolated'?'timing_check':'correction_check',maxAttempts:1,independentBudgetMs:budget,attemptTimeoutMs:budget})
      });
      execution.stageDeadlineAt += Date.now()-recoveryStartedAt;
      timingRecoveryAudit = reviewed.audit;
      if (reviewed.rejected.length) console.log(JSON.stringify({
        event: 'meeting_agent_timing_check_rejected', journeyId: draft.draftId, rejected: reviewed.rejected
      }));
      timingChecked = { actions: reviewed.actions, flags: [...timingChecked.flags, ...reviewed.flags], accounting: reviewed.accounting };
      traceOwners('timingCheck', timingChecked.actions, draft.draftId);
    }
    const siblingTiming = reconcileSiblingTimingDecisions(timingChecked.actions, draft.sourceUnits, { meetingDate: timingAnchor });
    timingChecked = { ...timingChecked, actions: siblingTiming.actions, flags: [...timingChecked.flags, ...siblingTiming.flags] };
    if (correctnessChecksEnabled()) {
      const chained = applyChainedTimingRule(timingChecked.actions, draft.sourceUnits, { meetingDate: timingAnchor });
      traceOwners('chained', chained.actions, draft.draftId);
      const separated = splitExplicitMultiOwnerActions(chained.actions, draft.sourceUnits, { meetingDate: timingAnchor });
      traceOwners('separated', separated.actions, draft.draftId);
      const deduped = mergeDuplicateCommitments(separated.actions);
      traceOwners('mergeDuplicateCommitments', deduped.actions, draft.draftId);
      const dedupedActions = await dedupeCommitmentsSemantically(deduped.actions, draft.draftId, 'merged', draft.sourceUnits);
      const ownersChecked = applyRequesterOwnerRule(dedupedActions, draft.sourceUnits);
      traceOwners('applyRequesterOwnerRule', ownersChecked.actions, draft.draftId);
      const softened = softenBestEffortCompletion(ownersChecked.actions, draft.sourceUnits);
      traceOwners('softened', softened.actions, draft.draftId);
      timingChecked = { ...timingChecked, actions: softened.actions, flags: [...timingChecked.flags, ...chained.flags, ...(separated.flags || []), ...ownersChecked.flags, ...softened.flags] };
    }
    let actionCompletenessCheckedCount = 0;
    let actionCompletenessCorrectedCount = 0;
    if (correctnessChecksEnabled()) {
      const completenessItems = actionCompletenessCheckItems(timingChecked.actions, draft.sourceUnits);
      const completenessBatches = [];
      for (let index = 0; index < completenessItems.length; index += 8) completenessBatches.push(completenessItems.slice(index, index + 8));
      const completenessResults = (await Promise.all(completenessBatches.map((batch, index) => call(
        `critic-action-completeness-${index + 1}`, actionCompletenessCheckPrompt(batch),
        { optional: true, responseKind: 'correction_check', maxAttempts: 2, candidateCount: batch.length }
      )))).flatMap((result) => (Array.isArray(result?.results) ? result.results : []));
      const completeness = applyActionCompletenessResults(timingChecked.actions, completenessItems, completenessResults, { meetingDate: timingAnchor });
      timingChecked = { ...timingChecked, actions: completeness.actions,
        flags: [...timingChecked.flags, ...(completeness.flags || [])] };
      traceOwners('completeness', timingChecked.actions, draft.draftId);
      actionCompletenessCheckedCount = completeness.checked;
      actionCompletenessCorrectedCount = completeness.corrected;
      if (completeness.checked || completeness.rejected.length) console.log(JSON.stringify({
        event: 'meeting_agent_action_completeness', journeyId: draft.draftId,
        checked: completeness.checked, corrected: completeness.corrected, rejected: completeness.rejected
      }));
    }
    let answeredInMeetingCount = 0;
    let completedDuringMeetingCount = 0;
    if (meetingMinutesAnsweredCheckEnabled()) {
      // A clarify/confirm action whose question was answered and accepted in the
      // meeting is not outstanding work. It leaves the published list only with
      // both quotes verified, and comes back as a one-click proposal.
      const answeredItems = answeredCheckItems(timingChecked.actions, draft.sourceUnits);
      const answeredBatches = [];
      for (let index = 0; index < answeredItems.length; index += 8) answeredBatches.push(answeredItems.slice(index, index + 8));
      const answeredResults = (await Promise.all(answeredBatches.map((batch, index) => call(
        `critic-answered-${index + 1}`, answeredCheckPrompt(batch),
        { optional: true, responseKind: 'answered_check', maxAttempts: 2, candidateCount: batch.length }
      )))).flatMap((result) => (Array.isArray(result?.results) ? result.results : []));
      const answered = applyAnsweredCheckResults(timingChecked.actions, answeredItems, answeredResults);
      answeredInMeetingCount = answered.answered.length;
      if (answeredInMeetingCount) {
        timingChecked = { ...timingChecked, actions: answered.actions };
        const at = answered.actions.length;
        for (const item of answered.answered) {
          proposal.changes.push({
            id: `change-answered-${crypto.createHash('sha1').update(item.action.action || '').digest('hex').slice(0, 10)}`,
            selected: false,
            type: 'add', before: null, after: { ...item.action, reviewFlagIds: [] },
            beforeIndex: at, afterIndex: null, index: at,
            reviewContext: {
              label: 'answered, then accepted',
              reason: `This looks answered during the meeting ("${item.answerQuote}" … "${item.acceptanceQuote}"). Add it only if something is still open.`,
              evidenceIds: item.action.evidenceIds || []
            }
          });
        }
      }
      const completedItems = completedInMeetingCheckItems(timingChecked.actions, draft.sourceUnits);
      const completedBatches = [];
      for (let index = 0; index < completedItems.length; index += 8) completedBatches.push(completedItems.slice(index, index + 8));
      const completedResults = (await Promise.all(completedBatches.map((batch, index) => call(
        `critic-completed-in-meeting-${index + 1}`, completedInMeetingCheckPrompt(batch),
        { optional: true, responseKind: 'answered_check', maxAttempts: 2, candidateCount: batch.length }
      )))).flatMap((result) => (Array.isArray(result?.results) ? result.results : []));
      const completed = applyCompletedInMeetingCheckResults(timingChecked.actions, completedItems, completedResults);
      completedDuringMeetingCount = completed.completed.length;
      if (completed.rejected.length) console.log(JSON.stringify({
        event: 'meeting_agent_completed_check_rejected', journeyId: draft.draftId, rejected: completed.rejected
      }));
      if (completedDuringMeetingCount) {
        timingChecked = { ...timingChecked, actions: completed.actions };
        const at = completed.actions.length;
        for (const item of completed.completed) {
          proposal.changes.push({
            id: `change-completed-live-${crypto.createHash('sha1').update(item.action.action || '').digest('hex').slice(0, 10)}`,
            selected: false,
            type: 'add', before: null, after: { ...item.action, reviewFlagIds: [] },
            beforeIndex: at, afterIndex: null, index: at,
            reviewContext: {
              label: 'completed during the meeting',
              reason: `This appears to have been done during the meeting ("${item.completionQuote}"). Add it only if follow-up work remains.`,
              evidenceIds: item.action.evidenceIds || []
            }
          });
        }
      }
    }
    if (correctnessChecksEnabled()) {
      // "Possibly have some questions on the reviewed document." describes a state
      // of mind, not work anyone is doing. Dropped rather than offered: there is
      // nothing here for a reviewer to accept.
      // Running the call ("give it thirty seconds for Dermot and then") is
      // screened here as well as at candidate time, because the referee can
      // publish from an older ledger and the model legs never saw the screen.
      const notActions = timingChecked.actions.filter((action) => isNotAnAction(action?.action) || isMeetingAdminAction(action?.action));
      if (notActions.length) {
        timingChecked = { ...timingChecked, actions: timingChecked.actions.filter((action) => !notActions.includes(action)) };
        console.log(JSON.stringify({
          event: 'meeting_agent_not_actions', journeyId: draft.draftId, removed: notActions.length,
          meetingAdmin: notActions.filter((action) => isMeetingAdminAction(action?.action)).length,
          wording: notActions.map((action) => meetingMinutesAgentText(action?.action, 120))
        }));
      }
      const farewells = timingChecked.actions.filter((action) => isFarewellAction(action, draft.sourceUnits));
      if (farewells.length) {
        timingChecked = { ...timingChecked, actions: timingChecked.actions.filter((action) => !farewells.includes(action)) };
        console.log(JSON.stringify({ event: 'meeting_agent_farewell_actions', journeyId: draft.draftId, removed: farewells.length }));
      }
      // A commitment in the goodbyes about something the meeting never otherwise
      // discusses - "Book a holiday." - is offered, not published. The signal is
      // statistical, so a genuine late commitment costs the reviewer one click
      // rather than being lost.
      const asides = timingChecked.actions.filter((action) =>
        isSocialAside(action, draft.sourceUnits) || isAobPersonalAside(action, draft.sourceUnits));
      if (asides.length) {
        timingChecked = { ...timingChecked, actions: timingChecked.actions.filter((action) => !asides.includes(action)) };
        const at = timingChecked.actions.length;
        for (const action of asides) {
          proposal.changes.push({
            id: `change-aside-${crypto.createHash('sha1').update(action.action || '').digest('hex').slice(0, 10)}`,
            selected: false,
            type: 'add', before: null, after: { ...action, reviewFlagIds: [] },
            beforeIndex: at, afterIndex: null, index: at,
            reviewContext: {
              label: 'said in passing at the end',
              reason: 'This was said in the closing moments and the meeting does not discuss it anywhere else. Add it only if it is really a task.',
              evidenceIds: action.evidenceIds || []
            }
          });
        }
        console.log(JSON.stringify({ event: 'meeting_agent_social_asides', journeyId: draft.draftId, offered: asides.length }));
      }
      // "Write down that the July date is at risk" is an instruction to the
      // note-taker, and the tool is the note-taker. Offered rather than published
      // so the fact is not lost if the reviewer wants it as an action after all.
      const minuteNotes = meetingMinutesMinuteInstructionRuleEnabled()
        ? timingChecked.actions.filter((action) => isMinuteInstruction(action?.action, {
          action, sourceUnits: draft.sourceUnits
        })) : [];
      if (minuteNotes.length) {
        timingChecked = { ...timingChecked, actions: timingChecked.actions.filter((action) => !minuteNotes.includes(action)) };
        const at = timingChecked.actions.length;
        for (const action of minuteNotes) {
          proposal.changes.push({
            id: `change-minute-note-${crypto.createHash('sha1').update(action.action || '').digest('hex').slice(0, 10)}`,
            selected: false,
            type: 'add', before: null, after: { ...action, reviewFlagIds: [] },
            beforeIndex: at, afterIndex: null, index: at,
            reviewContext: {
              label: 'a note for the minutes',
              reason: 'This is someone asking for a point to be recorded, not a piece of work for a named person. Add it only if it is really an action.',
              evidenceIds: action.evidenceIds || []
            }
          });
        }
        console.log(JSON.stringify({ event: 'meeting_agent_minute_instructions', journeyId: draft.draftId, offered: minuteNotes.length }));
      }
      // A description of how someone usually works is offered, not published.
      const practice = timingChecked.actions.filter((action) => describesUsualPractice(action, draft.sourceUnits));
      if (practice.length) {
        timingChecked = { ...timingChecked, actions: timingChecked.actions.filter((action) => !practice.includes(action)) };
        const at = timingChecked.actions.length;
        for (const action of practice) {
          proposal.changes.push({
            id: `change-practice-${crypto.createHash('sha1').update(action.action || '').digest('hex').slice(0, 10)}`,
            selected: false,
            type: 'add', before: null, after: { ...action, reviewFlagIds: [] },
            beforeIndex: at, afterIndex: null, index: at,
            reviewContext: {
              label: 'described as usual practice',
              reason: 'This describes how things are usually done rather than a task someone took on. Add it only if someone committed to it.',
              evidenceIds: action.evidenceIds || []
            }
          });
        }
      }
    }
    let finalLifecycleCheckedCount = 0;
    let finalLifecycleWithheldCount = 0;
    let finalLifecycleRejectedCount = 0;
    if (meetingMinutesCommitmentCheckEnabled() && timingChecked.actions.length) {
      const lifecycleItems = finalActionLifecycleCheckItems(timingChecked.actions, draft.sourceUnits);
      const lifecycleBatches = [];
      for (let index = 0; index < lifecycleItems.length; index += 8) lifecycleBatches.push(lifecycleItems.slice(index, index + 8));
      const lifecycleResults = (await Promise.all(lifecycleBatches.map((batch, index) => call(
        `critic-final-lifecycle-${index + 1}`, finalActionLifecycleCheckPrompt(batch),
        { optional: true, responseKind: 'commitment_check', maxAttempts: 2, candidateCount: batch.length }
      )))).flatMap((result) => (Array.isArray(result?.results) ? result.results : []));
      const lifecycle = applyFinalActionLifecycleResults(timingChecked.actions, lifecycleItems, lifecycleResults);
      finalLifecycleCheckedCount = lifecycleItems.length;
      finalLifecycleWithheldCount = lifecycle.withheld.length;
      finalLifecycleRejectedCount = lifecycle.rejected.length;
      if (lifecycle.withheld.length) {
        timingChecked = { ...timingChecked, actions: lifecycle.actions };
        const at = lifecycle.actions.length;
        for (const item of lifecycle.withheld) {
          proposal.changes.push({
            id: `change-lifecycle-${crypto.createHash('sha1').update(item.action.action || '').digest('hex').slice(0, 10)}`,
            selected: false,
            type: 'add', before: null, after: { ...item.action, reviewFlagIds: [] },
            beforeIndex: at, afterIndex: null, index: at,
            reviewContext: {
              label: 'not outstanding after the meeting', disposition:'not_outstanding',
              reason: `This appears not to be outstanding work ("${item.evidenceQuote}"). Add it only if follow-up is still required.`,
              evidenceIds: item.action.evidenceIds || []
            }
          });
        }
      }
      console.log(JSON.stringify({
        event: 'meeting_agent_final_action_lifecycle', journeyId: draft.draftId,
        checked: finalLifecycleCheckedCount, withheld: finalLifecycleWithheldCount, rejected: lifecycle.rejected
      }));
    }
    // A later model or merge can produce an affirmative task from an evidence
    // window whose settled instruction is explicitly negative (for example,
    // "do not choose or book a transfer"). Recheck the finished lifecycle set
    // with the deterministic, object-matched polarity rule before presentation.
    const contradictedActions = timingChecked.actions.filter((action) => {
      const evidence = surroundingEvidence(draft.sourceUnits, action.evidenceIds || [])
        .map((unit) => `${unit.speaker}: ${unit.text}`).join('\n');
      return actionNegatedByEvidence(action.action, evidence);
    });
    if (contradictedActions.length) {
      timingChecked = {
        ...timingChecked,
        actions: timingChecked.actions.filter((action) => !contradictedActions.includes(action))
      };
      console.log(JSON.stringify({
        event: 'meeting_agent_action_polarity_veto', journeyId: draft.draftId,
        removed: contradictedActions.map((action) => meetingMinutesAgentText(action.action, 180))
      }));
    }
    // Earlier dedupe passes run before timing, completeness and lifecycle checks,
    // which can rewrite two variants into the same finished action. Reconcile the
    // finished rows before they reach the editable Actions screen, carrying all
    // evidence and flags forward and retaining the stronger timing.
    const actionPeople = meetingAgentPeopleNames(draft.sourceUnits);
    const participantNormalisedActions = timingChecked.actions.map((record) => ({
      ...record,
      action: normalisePublishedParticipantReference(record?.action, actionPeople)
    }));
    const actionsBeforeDisplayDedupe = participantNormalisedActions.length;
    const splitTimingFlags = [];
    const splitRows = splitCompoundActionList(participantNormalisedActions, draft.draftId, {
      sourceUnits: draft.sourceUnits, flags: splitTimingFlags
    });
    const splitOwnership = applyRequesterOwnerRule(splitRows, draft.sourceUnits);
    // Apply only the narrow final eligibility filters here. The ordinary display
    // dedupers below may merge wording, but this set remains the survival
    // authority for distinct lifecycle-approved deliverables.
    const displayEligibleApproved = applyPresenterAidGate(splitOwnership.actions, details.meetingType).actions
      .map((record) => ({
        ...record,
        action: normalisePublishedParticipantReference(record?.action, actionPeople)
      }))
      .map((record) => stripMinorCommunicationCourtesy(record, draft.sourceUnits))
      .filter((record) => record && !isVagueReconstructedAction(record?.action));
    // The completeness, answered and lifecycle checks rewrite wording after the
    // earlier fold ran, which can leave an unowned paraphrase beside the owned
    // action it restates. Fold once more on what the reviewer will actually see.
    const actionScreenRows = foldUnownedNearCopies(dedupeHybridActionRecords(
      splitOwnership.actions, { sourceUnits: draft.sourceUnits }
    ), draft.draftId);
    const actionScreenDuplicateCount = actionsBeforeDisplayDedupe - actionScreenRows.length;
    if (actionScreenDuplicateCount) console.log(JSON.stringify({
      event: 'meeting_agent_action_screen_dedupe', journeyId: draft.draftId,
      before: actionsBeforeDisplayDedupe, after: actionScreenRows.length,
      merged: actionScreenDuplicateCount
    }));
    // On a rehearsal, delivery advice reads as work: "Find and use the clock at
    // the top right while presenting", "Keep your phone next to you". Nothing is
    // produced and nobody receives anything. Applied here, last, because the
    // completeness, answered and lifecycle checks rewrite wording after the
    // earlier filters have run, so only this list is the finished one.
    const presenterAidGate = applyPresenterAidGate(actionScreenRows, details.meetingType);
    if (presenterAidGate.dropped.length) console.log(JSON.stringify({
      event: 'meeting_agent_presenter_aid_gate', journeyId: draft.draftId,
      meetingType: details.meetingType, dropped: presenterAidGate.dropped
    }));
    traceOwners('presenterAidGate(final)', presenterAidGate.actions, draft.draftId);
    // Later passes (lifecycle, answered, salvage) can add a second wording of a
    // commitment after the merge above, so the finished list is read once more.
    const finalDedupedActions = (await dedupeCommitmentsSemantically(presenterAidGate.actions, draft.draftId, 'final', draft.sourceUnits))
      .map((record) => ({
        ...record,
        action: normalisePublishedParticipantReference(record?.action, actionPeople)
      }))
      .map((record) => stripMinorCommunicationCourtesy(record, draft.sourceUnits))
      .filter((record) => record && !isVagueReconstructedAction(record?.action));
    const finalSurvival = reconcileFinalApprovedActions(finalDedupedActions, displayEligibleApproved, {
      sourceUnits: draft.sourceUnits
    });
    // Approved-row reconciliation can restore a second wording after the last
    // semantic pass. Apply the same guarded source-aware comparison to the
    // final published list, preserving distinct or uncovered instructions.
    const finalSourceAwareActions = dedupeHybridActionRecords(finalSurvival.actions, {
      sourceUnits: draft.sourceUnits
    });
    const finalSiblingTiming = reconcileSiblingTimingDecisions(finalSourceAwareActions, draft.sourceUnits, { meetingDate: timingAnchor });
    const finalTiming = finaliseActionTimings(finalSiblingTiming.actions, draft.sourceUnits, {
      meetingDate: timingAnchor, assessments: draft.qualityState?.actions?.timingAssessments || [],
      verifiedBindingFor: timingRecovery.bindingReader(timingRecoveryAudit?.proofs, draft.sourceUnits, timingAnchor)
    });
    const finalActions = finalTiming.actions;
    actionDiagnostics.checkpoint('final_timing', finalActions);
    const finalTimedStepCoverage = timedStepCoverage(sourceActionCandidates, finalActions, draft.sourceUnits, { meetingDate: timingAnchor });
    const timedStepFlags = finalTimedStepCoverage.items.filter(item => item.status !== 'covered').map((item, index) => normaliseMeetingAgentFlag({
      kind: 'timing', temporalField: 'timedStepCoverage', message: `A source-stated timed step still needs review: "${item.focusText}" (${item.expression}). Confirm that this work and its own timing are represented.`,
      evidenceIds: [item.focusEvidenceId]
    }, index));
    if (finalSurvival.restored.length) console.log(JSON.stringify({
      event: 'meeting_agent_final_action_survival', journeyId: draft.draftId,
      restored: finalSurvival.restored.map((record) => meetingMinutesAgentText(record.action, 180))
    }));
    const assembledActionFlagState = reconcileRecordFlags({ actions: finalActions }, mergeMeetingAgentFlags([
      ...materializationReview.flags, ...refereeFlags,
      ...primary.reviewFlags.filter(flag => flag.sourceReviewContext?.kind === 'assessment_ownership_notice'),
      // Keep the source question even if revalidation or coverage filtering
      // withholds its proposal. The original ledger carries the typed warning;
      // a referee verdict must not erase the work from human review.
      ...retainedDocumentReferenceReviewFlags([
        ...agentDeclaredProposals, ...proposedRecords,
        ...ensemble.filter(candidate => candidate.recordType === 'action').map(candidate => candidate.record)
      ])
    ], [
      ...splitTimingFlags,
      ...finalTiming.flags,
      ...timedStepFlags,
      ...finalSiblingTiming.flags,
      ...splitOwnership.flags,
      ...timingChecked.flags,
      ...critic.reviewFlags.filter(isUsefulMeetingAgentReviewFlag),
      ...(meetingMinutesAgentCompactDiscussionEnabled() ? [] : proposalFlags),
      ...unresolvedStrongCandidateFlags
    ]), isUsefulMeetingAgentReviewFlag);
    const reconciledTimingWarnings = require('../utils/meetingMinutesTimingFlags').reconcileActionTimingWarnings(
      assembledActionFlagState.content.actions, assembledActionFlagState.flags, draft.sourceUnits,
      { meetingDate: timingAnchor, verifiedBindingFor: timingRecovery.bindingReader(timingRecoveryAudit?.proofs,draft.sourceUnits,timingAnchor), proposals: [proposal, draft.pendingProposal], otherRecords: [draft.discussion, draft.meetingObjectives] }
    );
    const actionFlagState = { ...assembledActionFlagState,
      content: { ...assembledActionFlagState.content, actions: reconciledTimingWarnings.actions },
      flags: reconciledTimingWarnings.flags };
    if (reconciledTimingWarnings.retired.length) console.log(JSON.stringify({
      event: 'meeting_agent_stale_timing_warning_retired', journeyId: draft.draftId,
      retired: reconciledTimingWarnings.retired
    }));
    const discussionActionDedupe = removeDiscussionActionDuplicates(
      draft.discussion,
      actionFlagState.content.actions,
      actionPeople
    );
    if (discussionActionDedupe.dropped.length) console.log(JSON.stringify({
      event: 'meeting_agent_discussion_action_dedupe', journeyId: draft.draftId,
      dropped: discussionActionDedupe.dropped
    }));
    // Compare only against the finished accepted register. Failed or incomplete
    // proofs keep discussion verbatim; never turn an action into source truth.
    let separatedDiscussion = discussionActionSeparation.restoreChangedActionCoverage(discussionActionDedupe.discussion,
      actionFlagState.content.actions, draft.sourceUnits, draft.qualityState?.discussion?.claimConsolidation);
    const separationCoverageRestored = separatedDiscussion.restored;
    separatedDiscussion.audit ||= { applied: false, reason: 'no_prior_archive' };
    let separationAudit = null;
    const existingSeparation = separatedDiscussion.audit?.method === discussionActionSeparation.VERSION
      && separatedDiscussion.audit.applied && discussionClaims.canRestore(separatedDiscussion.discussion, draft.sourceUnits, separatedDiscussion.audit);
    if (!existingSeparation && /^(?:1|true|yes|on)$/i.test(String(process.env.MEETING_MINUTES_AGENT_DISCUSSION_BOUNDED_REWRITE_V1 || '0'))
      && !/^(?:0|false|no|off)$/i.test(String(process.env.MEETING_MINUTES_AGENT_DISCUSSION_ACTION_SEPARATION_V1 || '1'))) {
      const separationCall = (part, prompt, packet) => call('critic-discussion-action-separation-' + part, prompt, {
        optional: true, silentOptionalFailure: true, responseKind: 'correction_check', maxAttempts: 1,
        independentBudgetMs: 45000, attemptTimeoutMs: 45000, candidateCount: packet.candidates.length
      });
      const separation = await discussionActionSeparation.separate(separatedDiscussion.discussion,
        actionFlagState.content.actions, draft.sourceUnits,
        [...(draft.reviewFlags || []), ...actionFlagState.flags].filter((flag, index, flags) => flags.findIndex(f => f.id === flag.id) === index), {
          propose: (prompt, packet) => separationCall('proposal', prompt, packet),
          verify: (prompt, packet) => separationCall('verification', prompt, packet)
        });
      separationAudit = separation.audit;
      separatedDiscussion = discussionActionSeparation.combine(separatedDiscussion, separation, draft.sourceUnits);
    }
    const separationPublishedActions = separatedDiscussion.actions || actionFlagState.content.actions;
    const discussionSeparated = separationAudit?.applied === true
      && separatedDiscussion.audit?.packetHash === separationAudit.packetHash;
    // Proposals were assembled before the final checks. Their timing must agree
    // with finished source-bound decisions before either automatic or manual
    // review can apply them.
    const proposalTiming = finaliseMeetingAgentTimingProposal({
      ...proposal,
      changes: (proposal.changes || []).filter(change =>
        !isVagueReconstructedAction(change?.after?.action || change?.before?.action))
    }, { ...draft, actions: actionFlagState.content.actions, qualityState: {
      ...(draft.qualityState || {}), actions: { ...(draft.qualityState?.actions || {}),
        timingAssessments: [...(draft.qualityState?.actions?.timingAssessments || []), ...finalTiming.assessments]
      }
    } });
    const finalProposal = removePublishedActionProposalDuplicates(proposalTiming.proposal, separationPublishedActions);
    const finalMaterializationReview = materializationReview.accounting.complete ? materializationReview
      : reconcileRefereeActionMaterialization(unresolvedActionMaterializations, ensemble,
        hybridCandidateDispositions(ensemble, actionFlagState.content.actions,
          finalProposal.changes.filter((change) => change.type === 'add').map((change) => change.after)),
        draft.sourceUnits, settledRefereeActionDispositions);
    actionDiagnostics.checkpoint('final_flag_state', actionFlagState.content.actions);
    actionDiagnostics.checkpoint('discussion_action_separation', separationPublishedActions);
    return {
      changes: {
        actions: separationPublishedActions,
        ...(discussionActionDedupe.dropped.length || discussionSeparated || separationCoverageRestored ? { discussion: separatedDiscussion.discussion } : {}),
        pendingProposal: finalProposal.changes.length
          ? preselectActionProposal(finalProposal, separationPublishedActions, draft.sourceUnits) : null,
        candidateLedger,
        passProvenance: [...(draft.passProvenance || []), ...measuredProvenance].slice(-40),
        passCache: execution.passCache,
        qualityState: { ...(draft.qualityState || {}),
          discussion: { ...(draft.qualityState?.discussion || {}), claimConsolidation: separatedDiscussion.audit },
          actions: {
          ...(execution.refereeFailureAudit ? { refereeFailureAudit: execution.refereeFailureAudit } : {}),
          timingPolicyVersion: TIMING_POLICY_VERSION,
          ...(timingRecoveryAudit ? { timingRecovery: timingRecoveryAudit } : {}),
          timingReview: timingChecked.accounting || { expected: 0, received: 0, complete: false, disabled: true },
          timedStepCoverage: { initial: initialTimedStepCoverage, final: finalTimedStepCoverage },
          timingAssessments: [...finalTiming.assessments, ...proposalTiming.assessments],
          completedPasses, recoveryUsed: Boolean(recovery), degradedSources,
          completedAt: new Date().toISOString(), passImpact,
          callPerformance: meetingAgentCallPerformance(measuredProvenance),
          stageElapsedMs: Date.now() - stageStartedAt, stagedCandidateElapsedMs, stagedCandidateJoin,
          stagedCandidatesFromCache: cachedStaged.length > 0 || stagedCandidatesFromPrewarm,
          automaticCount: actionFlagState.content.actions.length, proposalCount: proposal.changes.length,
          highConfidencePromotionCount,
          agentProposalPromotionCount: safeProposalPromotions.length,
          acceptedVisitAssignmentCount: acceptedVisitAssignments.length,
          criticPromotionCount: criticPromotions.length,
          commitmentRescueCount,
          proposalRescueCount,
          rescuedActionTexts,
          answeredInMeetingCount,
          completedDuringMeetingCount,
          actionCompletenessCheckedCount,
          actionCompletenessCorrectedCount,
          finalLifecycleCheckedCount,
          finalLifecycleWithheldCount,
          finalLifecycleRejectedCount,
          finalActionSurvivalRestoredCount: finalSurvival.restored.length,
          discussionActionDuplicateCount: discussionActionDedupe.dropped.length,
          discussionActionSeparationCount: discussionSeparated ? separationAudit.ledger.length : 0,
          sourceClarificationCorrectionCount: discussionSeparated ? separationAudit.ledger.filter(entry => entry.revisedAction).length : 0,
          discussionActionSeparationCoverageRestored: Boolean(separationCoverageRestored),
          discussionActionSeparationAssessment: { method: discussionActionSeparation.VERSION, applied: discussionSeparated,
            candidates: separationAudit?.candidates || 0, reason: separationAudit?.reason || (existingSeparation ? 'existing_pair_preserved' : 'disabled'),
            packetHash: separationAudit?.packetHash || '', diagnostics: separationAudit?.diagnostics || [], rejectedAttempts: separationAudit?.rejectedAttempts || [] },
          actionScreenDuplicateCount,
          acceptedActionEligibleCount: acceptedActionAccounting.eligibleCount,
          acceptedActionRestoredCount: acceptedActionAccounting.restored.length,
          primaryActionEligibleCount: primaryActionAccounting.eligibleCount,
          primaryActionRestoredCount: primaryActionAccounting.restored.length,
          criticCandidateCount: criticCandidates.length,
          criticPromptChars: criticPrompt.length,
          salvageCandidateCount: salvageCandidates.length,
          salvagePromptChars: salvagePrompt.length,
          salvageSkippedAfterInfrastructureFailure,
          salvageAutomaticCount: salvageAutomatic.length,
          salvageProposalCount: salvageProposal.length,
          agentDeclaredProposalCount: agentDeclaredProposals.length,
          refereeRoute,
          refereeMaterialization: finalMaterializationReview.accounting,
          agentCandidateDispositions: agentCandidateDispositions.slice(0, 320),
          corroboratedBackstopCount: candidateBackstop.length,
          strongDiscoveryProposalCount: strongDiscoveryBackstop.length,
          operationalGapProposalCount: processGapBackstop.length,
          commitmentThreadProposalCount: threadBackstop.length,
          telemetry: meetingAgentExecutionTelemetry(measuredProvenance),
          candidateDispositions: finalMaterializationReview.candidateDispositions
        } }
      },
      reviewFlags: mergeMeetingAgentFlags(actionFlagState.flags, proposalTiming.flags),
      replaceCoverageFlags: false
    };
  };
}

module.exports = { createOriginalActionsStage };
