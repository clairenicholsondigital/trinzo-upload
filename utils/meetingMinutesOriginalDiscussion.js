'use strict';

const { sanitiseDetails: sanitiseMeetingAgentDetails } = require('./meetingMinutesDraftContext');
const { refereeDiscussionTargetId, refereeDiscussionContractDiagnostics, discussionRefereeHasCompleteCandidateAccounting } = require('./meetingMinutesResponseContracts');
const { flattenHybridDiscussion } = require('./meetingMinutesDiscussionRows');
const { isUsefulReviewFlag: isUsefulMeetingAgentReviewFlag, reconcileUsefulRecordFlags } = require('./meetingMinutesReviewFlags');
const { resolveEvidence } = require('./meetingMinutesEvidenceResolution');
const { flagConflictingDiscussionRoles, groundRowAttributions } = require('./meetingMinutesPeopleEvidence');

const {
  annotateMeetingAgentPassImpact,
  meetingAgentCallPerformance,
  meetingAgentExecutionTelemetry,
  meetingAgentMaterialPassImpact,
} = require('./meetingMinutesAgentGeneration');
const {
    applyDecisionCheckResults,
    applyDiscussionFidelityResults,
    applyOpenQuestionCheckResults,
    correctnessChecksEnabled,
    decisionCheckItems,
    decisionCheckPrompt,
    demoteSupersededRows,
    discussionFidelityCheckItems,
    discussionFidelityCheckPrompt,
    filterUnsupportedQuantifiedDiscussion,
    groundUnstatedDiscussionMonths,
    labelSupersededContext,
    answeredCheckEnabled: meetingMinutesAnsweredCheckEnabled,
    decisionCheckEnabled: meetingMinutesDecisionCheckEnabled,
    mergeGroundedObjectiveRecords,
    openQuestionCheckItems,
    openQuestionCheckPrompt,
    promoteMaterialObjectionDetails,
    promoteNamedFactDetails,
    supersededCheckItems,
    supersededVerdicts,
  } = require('./meetingMinutesAgentV2');
const {
  applyDiscussionTopicArrangement,
  dedupeAdjacentRestatements,
  dedupeGlobalRestatements,
  demoteContainedPrimaryRows,
  discussionTopicArrangementInput,
  finaliseDiscussionForPublication,
  normaliseDiscussionPresentation,
  organiseDiscussionForReview,
  removePersonalAsides,
  removeRawGeneratedDiscussionRows,
  validateDiscussionTopicArrangement,
} = require('./canonicalMinutes/discussionOrganiser');
const { carryExactDiscussionProvenance } = require('./meetingMinutesExactDiscussionProvenance');
const citedFilingAliases = require('./meetingMinutesCitedFilingAliases');
const {
  collectUnassignedSupportingDetails,
  foldLiteralParentSupportingRepeats,
  mergeUnassignedSupportingDetails,
  withoutRepresentedUnassignedDetails,
} = require('./meetingMinutesSupportingDetails');
const {
  dedupeDiscussionBody,
  shapeDiscussion,
} = require('./discussionShape');
const discussionClaims = require('./canonicalMinutes/discussionClaimConsolidation');
const { discussionCoveragePolicyForRun } = require('./meetingMinutesDiscussionCoveragePolicy');
const discussionDirectional = require('./canonicalMinutes/discussionDirectionalCoverage');
const discussionMainPoint = require('./canonicalMinutes/discussionMainPointCoverage');
const discussionOwnParent = require('./canonicalMinutes/discussionOwnParentCoverage');
const discussionPointDecision = require('./canonicalMinutes/discussionPointDecisionCoverage');
const { discussionPublicationCoverage } = require('./meetingMinutesDiscussionCoverage');
const discussionRewrite = require('./canonicalMinutes/discussionBoundedRewrite');
const filingAliases = require('./meetingMinutesFilingAliases');
const { isRawTranscriptDiscussionPoint } = require('./stagedEditorial');
const { meetingMinutesAgentText } = require('./meetingMinutesPlainText');
const minimalFidelityRepair = require('./meetingMinutesMinimalFidelityRepair');
const optionalReview = require('./meetingMinutesOptionalReview');
const { promoteMaterialTimingDetails } = require('./meetingMinutesTemporalPublication');
const { reconcileDiscussionClauseSources } = require('./meetingMinutesDiscussionSources');
const { regroupDiscussionBySegments } = require('./canonicalMinutes/discourseSegments');
const { retainPureFutureAssignments } = require('./meetingMinutesDiscussionTaskBoundary');
const { safeLogError } = require('./apiErrors');
const { stampPrimaryDiscussionEvidence } = require('./canonicalMinutes/discussionPublication');
const { meetingAgentReviewPacketError } = require('./meetingMinutesReviewAccounting');

// API-owned orchestration helpers and outward prewarm ports remain explicit.
function createOriginalDiscussionStage(services) {
  const {
    compactDiscussionPropositions,
    corroboratedOmittedDiscussionRecords,
    dedupeSupportingDetailsSemantically,
    discussionOverlapConsolidationPrompt,
    discussionRefereeFallbackPlan,
    discussionRefereeSufficiency,
    discussionStructureDiagnostics,
    effectiveDiscussionRefereeDispositions,
    finalisePromotedDiscussion,
    hybridCandidateDispositions,
    includeAllDiscussionDetailsExperiment,
    limitSupportingDetails,
    meetingAgentPeopleNames,
    meetingMinutesAgentCompactDiscussionEnabled,
    meetingMinutesAgentCompactDiscussionShadowEnabled,
    meetingMinutesAgentDiscussionOrganiseEnabled,
    meetingMinutesAgentGlobalTopicArrangerEnabled,
    meetingMinutesAgentPromoteMaterialSupportingEnabled,
    meetingMinutesAgentTopicArrangementPrompt,
    meetingMinutesAgentTopicArrangementRepairPrompt,
    meetingMinutesDiscussionRestatementsEnabled,
    meetingMinutesPromoteNamedFactsEnabled,
    mergeHybridDiscussionTopics,
    promoteAllDiscussionDetails,
    promotePrioritySupportingDetails,
    reconstructMissingRefereeDiscussion,
    refereeClusterSupportingCandidates,
    removeHeadingFragmentsFromDiscussion,
    removeMinorCommunicationCourtesyDiscussion,
    removeWithheldGeneratedDiscussion,
    startPrivateActionPrimaryPrewarm,
    startPrivateStagedCandidateLedger,
  } = services;

  return async function runOriginalDiscussionStage(context) {
    let {
      cachedStaged,
      call,
      candidateLedger,
      completedPasses,
      degradedSources,
      draft,
      ensemble,
      passProvenance,
      primary,
      primaryParsed,
      recovery,
      referee,
      refereeContract,
      refereeFlags,
      refereeParsed,
      refereeRoute,
      selectionCoverage,
      stageStartedAt,
      stagedCandidateElapsedMs,
      stagedCandidatesFromPrewarm,
      suppliedRefereeCandidates,
      timingAnchor,
      topicLabels,
      topicSegments,
      execution,
    } = context;
    const rawRefereeDiscussionDispositions = (Array.isArray(refereeParsed?.candidateDispositions)
      ? refereeParsed.candidateDispositions : []);
    const rawContractDiagnostics = refereeDiscussionContractDiagnostics(
      referee.discussion, rawRefereeDiscussionDispositions, suppliedRefereeCandidates
    );
    const authoritativeStructuredReferee = refereeRoute === 'structured_prompt'
      && discussionRefereeHasCompleteCandidateAccounting(rawContractDiagnostics);
    const baselineDiscussion = mergeHybridDiscussionTopics(
      primary.discussion, recovery?.discussion || []
    );
    const partialFallback = discussionRefereeFallbackPlan(refereeParsed, refereeContract, ensemble, baselineDiscussion);
    const preserveStructuredDecisions = authoritativeStructuredReferee || partialFallback.active;
    // A valid typed verdict remains authoritative for its own candidate even
    // when another candidate is missing. Keep facet-anchor repair for legacy
    // or wholly failed contracts only.
    const refereeDiscussionDispositions = preserveStructuredDecisions
      ? partialFallback.dispositions.map((item) => ({ ...item }))
      : effectiveDiscussionRefereeDispositions(
        rawRefereeDiscussionDispositions, suppliedRefereeCandidates
      );
    const reconstructed = reconstructMissingRefereeDiscussion(
      referee.discussion, refereeDiscussionDispositions, ensemble, draft.sourceUnits, { meetingDate: timingAnchor }
    );
    let refereeDiscussion = reconstructed.discussion;
    if (reconstructed.reconstructedTargetIds.length
      && Array.isArray(refereeParsed?.discussion) && refereeParsed.discussion.length) {
      degradedSources.push(`The discussion referee omitted ${reconstructed.reconstructedTargetIds.length} referenced primary record${reconstructed.reconstructedTargetIds.length === 1 ? '' : 's'}; the website rebuilt them from their evidence-backed candidates.`);
    }
    if (rawContractDiagnostics.undisposedCandidateCount) {
      degradedSources.push(`The discussion referee did not classify ${rawContractDiagnostics.undisposedCandidateCount} supplied candidate${rawContractDiagnostics.undisposedCandidateCount === 1 ? '' : 's'}; corroborated discovery results were retained as a safety backstop.`);
    }
    if (!preserveStructuredDecisions && !flattenHybridDiscussion(refereeDiscussion).length) {
      if (flattenHybridDiscussion(baselineDiscussion).length) {
        refereeDiscussion = baselineDiscussion;
        degradedSources.push('The discussion referee returned no usable primary propositions; the evidence-normalised primary and recovery drafts were retained for safety.');
      }
    }
    // A fully accounted structured-referee response is authoritative. Running
    // the old recall backstop after it would promote candidates the referee
    // deliberately classified as supporting, merge or reject, undoing the
    // global proposition-level judgement and recreating reviewer-visible rows.
    // Partial typed responses recover only discovery records not already
    // routed by valid verdicts; legacy/failed responses retain their backstop.
    const completeStructuredReferee = authoritativeStructuredReferee
      && reconstructed.unresolvedTargetIds.length === 0;
    const recoveredDiscussion = completeStructuredReferee
      ? []
      : [
        ...corroboratedOmittedDiscussionRecords(partialFallback.active ? partialFallback.candidates : ensemble,
          refereeDiscussion, draft.sourceUnits, { meetingDate: timingAnchor }),
        // Retain the remaining discovery text even when it was found by only
        // one pass. Existing compacting validates it and either files it under
        // a justified parent, publishes material work, or retains it for review.
        ...(partialFallback.active ? partialFallback.discussion : [])
      ];
    const compactEnabled = meetingMinutesAgentCompactDiscussionEnabled();
    const compactShadowEnabled = !compactEnabled && meetingMinutesAgentCompactDiscussionShadowEnabled();
    const ensembleById = new Map(ensemble.map((candidate) => [candidate.candidateId, candidate]));
    const supportingCandidates = refereeDiscussionDispositions
      .filter((item) => ['supporting', 'merge'].includes(item?.disposition || item?.classification)
        && ensembleById.has(item.candidateId))
      .map((item) => ({
        candidate: ensembleById.get(item.candidateId),
        mergeTarget: item.mergeTarget || item.targetId
          || item.discussionId || item.targetRecordId || item.primaryId
      }));
    supportingCandidates.push(...refereeClusterSupportingCandidates(
      refereeDiscussionDispositions, suppliedRefereeCandidates
    ));
    const structuredReferee = refereeRoute === 'structured_prompt';
    // Overflow has no verdict and no inherited target. Readable discovery can
    // still be filed by the existing positive subject match, or retained in
    // Needs filing. This is not a referee core vote; the normal downstream
    // evidence, promotion and editorial safeguards still apply.
    if (structuredReferee) supportingCandidates.push(...selectionCoverage.unassessedEditorialCandidates
      .filter(candidate => candidate.text && !isRawTranscriptDiscussionPoint(candidate.text))
      .map(candidate => ({ candidate })));
    const unassignedSupportingDetails = [];
    const filingAliasHandoffs = [];
    const retainUnassignedSupportingDetail = (detail, context = {}) => {
      const retained = collectUnassignedSupportingDetails(detail, context);
      if (discussionCoveragePolicyForRun(draft).filingAliases && filingAliasHandoffs.length <= 2400) filingAliasHandoffs.push(structuredClone({ record: detail, context }));
      if (!retained.length) return false;
      unassignedSupportingDetails.push(...retained);
      return true;
    };
    const compactPreview = (compactEnabled || compactShadowEnabled || structuredReferee)
      ? compactDiscussionPropositions(refereeDiscussion, recoveredDiscussion, draft.sourceUnits, {
        meetingDate: timingAnchor,
        supportingCandidates,
        supportingSubjectPolicy: discussionCoveragePolicyForRun(draft).supportingSubjects ? 'meeting_minutes_v2' : undefined,
        authoritativeCoreIds: discussionCoveragePolicyForRun(draft).corePriority && preserveStructuredDecisions
          ? refereeDiscussionDispositions.filter(row => (row.disposition || row.classification) === 'core')
            .map(row => refereeDiscussionTargetId(row) || row.candidateId) : [],
        onUnassignedSupportingDetail: retainUnassignedSupportingDetail,
        // The Referee remains authoritative by default. A separately gated
        // deterministic marginal-information pass can recover a genuinely
        // material proposition which it labelled as context, without exposing
        // ordinary supporting detail or requiring another AI call.
        promoteMaterialSupporting: !preserveStructuredDecisions
          || meetingMinutesAgentPromoteMaterialSupportingEnabled()
      })
      : null;
    const measuredSufficiency = discussionRefereeSufficiency(compactPreview || [], baselineDiscussion);
    const compactPublication = discussionPublicationCoverage(compactPreview || [], refereeDiscussionDispositions, ensemble,
      { unassignedSupportingDetails });
    const compactSufficiency = completeStructuredReferee
      ? { ...measuredSufficiency, sufficient: compactPublication.complete, accountingAuthoritative: true,
        publicationComplete: compactPublication.complete }
      : measuredSufficiency;
    let finalDiscussion = (compactEnabled || structuredReferee)
      ? compactPreview
      : mergeHybridDiscussionTopics(refereeDiscussion, recoveredDiscussion);
    finalDiscussion = stampPrimaryDiscussionEvidence(finalDiscussion, draft.sourceUnits);
    if (structuredReferee && !preserveStructuredDecisions && !completeStructuredReferee && !compactSufficiency.sufficient
      && flattenHybridDiscussion(baselineDiscussion).length) {
      // An incomplete Referee must never bypass the normal evidence/client-
      // readiness gate. The raw discovery draft can contain a record whose
      // cited IDs were removed during grounding; serving baselineDiscussion
      // directly previously allowed that uncited row into the UI precisely on
      // the degraded path where validation matters most.
      finalDiscussion = (compactEnabled || structuredReferee)
        ? compactDiscussionPropositions(baselineDiscussion, [], draft.sourceUnits, {
          meetingDate: timingAnchor, supportingSubjectPolicy: discussionCoveragePolicyForRun(draft).supportingSubjects ? 'meeting_minutes_v2' : undefined, onUnassignedSupportingDetail: retainUnassignedSupportingDetail
        })
        : baselineDiscussion;
      degradedSources.push(`The structured discussion referee covered only ${compactSufficiency.coveredTopicCount} of ${compactSufficiency.baselineTopicCount} discovered topic groups; the evidence-normalised discovery draft was retained for completeness.`);
    }
    finalDiscussion = await dedupeSupportingDetailsSemantically(finalDiscussion, { journeyId: draft.draftId });
    // The referee and recovery passes publish whichever candidate they chose,
    // label and all, so subjects are filed once more here, on the final
    // records, by the segment their evidence sits in.
    if (topicLabels.some(Boolean)) {
      const refiled = regroupDiscussionBySegments(finalDiscussion, draft.sourceUnits, topicSegments, topicLabels);
      console.info(JSON.stringify({
        event: 'meeting_agent_topic_segments_final', journeyId: draft.draftId || '',
        topicsBefore: finalDiscussion.length, topicsAfter: refiled.discussion.length,
        moved: refiled.moved, relinked: refiled.relinked
      }));
      finalDiscussion = refiled.discussion;
    }
    if (meetingMinutesAgentDiscussionOrganiseEnabled()) {
      try {
        // Segment-named topics are already grouped by subject: merge only on
        // the same label, not on captions that happen to share a word.
        // Measured 2026-09-27 on stored replies for five transcripts: this
        // setting gave 7.6 topics / 0.6 singletons per run against 14.3 / 7.2
        // without segments, and kept every row.
        const organiserOptions = {
          ...(topicLabels.some(Boolean) ? { mergeSimilarity: 0.85, adjacentSimilarity: 0.92, labelSimilarity: 0.6 } : {}),
          // The same fact stated twice under one subject becomes one row.
          // Measured 2026-09-27 on the 21 live drafts: 3 of 377 rows, all
          // restatements, gold discussion recall unchanged (263/270).
          mergeRestatements: meetingMinutesDiscussionRestatementsEnabled(),
          supportingSubjectPolicy: discussionCoveragePolicyForRun(draft).supportingSubjects ? 'meeting_minutes_v2' : undefined,
          onUnassignedSupportingDetail: retainUnassignedSupportingDetail,
          onRestatements: (merges) => console.log(JSON.stringify({ event: 'meeting_agent_discussion_restatements', journeyId: draft.draftId, merges }))
        };
        const organised = await organiseDiscussionForReview(finalDiscussion, draft.sourceUnits, organiserOptions);
        console.log(JSON.stringify({ event: 'meeting_agent_discussion_organised', journeyId: draft.draftId, ...organised.before, afterTopics: organised.after.topics, afterRows: organised.after.rows }));
        finalDiscussion = organised.discussion;
      } catch (error) {
        safeLogError('[meeting-minutes-agent] discussion organiser skipped', error);
      }
    }
    // Apply the policy before later checks so irrelevant asides do not consume
    // reviewer calls. This is deliberately unconditional when the optional
    // organiser is disabled or safely falls back after an internal error.
    const quantifiedGrounding = filterUnsupportedQuantifiedDiscussion(finalDiscussion, draft.sourceUnits);
    finalDiscussion = removePersonalAsides(quantifiedGrounding.discussion);
    // One deliverable, one entry: a named person's task tagged as a decision
    // becomes an ordinary point, and a topic that only restates who is doing
    // what (Actions are extracted separately) is folded away.
    const shaped = shapeDiscussion(finalDiscussion, meetingAgentPeopleNames(draft.sourceUnits));
    finalDiscussion = shaped.discussion;
    if (shaped.demoted || shaped.droppedTopics.length) console.log(JSON.stringify({
      event: 'meeting_agent_discussion_shape', journeyId: draft.draftId,
      demotedAssignmentDecisions: shaped.demoted, droppedRecapTopics: shaped.droppedTopics
    }));
    if (quantifiedGrounding.removed.length) console.log(JSON.stringify({
      event: 'meeting_agent_quantified_claim_filter', journeyId: draft.draftId,
      removed: quantifiedGrounding.removed.map((item) => ({ id: item.id, signatures: item.signatures, subject: item.subject }))
    }));
    if (meetingMinutesAnsweredCheckEnabled()) {
      // Open questions are checked against a bounded forward window rather
      // than only their cited lines. A verified answer becomes a normal point;
      // failed or uncertain checks leave the question untouched.
      const questionItems = openQuestionCheckItems(finalDiscussion, draft.sourceUnits);
      const questionBatches = [];
      for (let index = 0; index < questionItems.length; index += 8) questionBatches.push(questionItems.slice(index, index + 8));
      const questionResults = (await Promise.all(questionBatches.map((batch, index) => call(
        `critic-open-question-${index + 1}`, openQuestionCheckPrompt(batch),
        { optional: true, responseKind: 'answered_check', maxAttempts: 2, candidateCount: batch.length }
      )))).flatMap((result) => (Array.isArray(result?.results) ? result.results : []));
      const questionChecked = applyOpenQuestionCheckResults(finalDiscussion, questionItems, questionResults);
      finalDiscussion = questionChecked.discussion;
      console.log(JSON.stringify({
        event: 'meeting_agent_open_question_check', journeyId: draft.draftId,
        checked: questionChecked.checked, resolved: questionChecked.resolved
      }));
    }
    let supersededContextFlags = [];
    let attributionFlags = [];
    let fidelityFlags = [];
    let fidelityWithheldRows = [];
    let fidelityReview = { expected: 0, received: 0, complete: false, disabled: true };
    let minimalFidelityRepairAudit = null;
    if (correctnessChecksEnabled()) {
      // Rows citing an assumption and its correction are rare; those that do
      // not carry the correction's content leave the primary rows.
      const supersededItems = supersededCheckItems(finalDiscussion, draft.sourceUnits);
      const outdatedRows = supersededVerdicts(supersededItems);
      const superseded = outdatedRows.size
        ? demoteSupersededRows(finalDiscussion, draft.sourceUnits, outdatedRows)
        : { demoted: 0 };
      if (superseded.demoted) finalDiscussion = superseded.discussion;
      // The same statement can arrive already in supporting context.
      const labelled = labelSupersededContext(finalDiscussion, draft.sourceUnits);
      if (labelled.labelled) {
        finalDiscussion = labelled.discussion;
        supersededContextFlags = labelled.flags;
      }
      if (meetingMinutesPromoteNamedFactsEnabled()) {
        // The exported minutes carry primary rows only: bring a few named or
        // dated facts back out of supporting context.
        const details = sanitiseMeetingAgentDetails(draft.details);
        const facts = promoteNamedFactDetails(finalDiscussion, draft.sourceUnits,
          [...(details.internalAttendees || []), ...(details.clientAttendees || [])]);
        if (facts.promoted) {
          finalDiscussion = facts.discussion;
          console.log(JSON.stringify({ event: 'meeting_agent_promoted_facts', journeyId: draft.draftId, promoted: facts.promoted }));
        }
      }
      // A row naming someone its cited lines never mention is usually a
      // citation one turn short; that is repaired. Where no nearby line
      // supplies the person, the wording stands and the row is flagged.
      const attributions = groundRowAttributions(finalDiscussion, draft.sourceUnits);
      if (attributions.widened || attributions.flags.length) {
        finalDiscussion = attributions.discussion;
        attributionFlags = attributions.flags;
        console.log(JSON.stringify({ event: 'meeting_agent_row_attributions', journeyId: draft.draftId, widened: attributions.widened, flagged: attributions.flags.length }));
      }
      if (superseded.demoted || labelled.labelled) {
        console.log(JSON.stringify({ event: 'meeting_agent_superseded_rows', journeyId: draft.draftId, demoted: superseded.demoted, labelledInContext: labelled.labelled }));
      }
    }
    if (meetingMinutesDecisionCheckEnabled()) {
      // Each "decision" must be backed by a verified quote of the words that
      // make the choice; the rest become points, wording unchanged. A failed
      // call leaves every label as it was.
      const decisionItems = decisionCheckItems(finalDiscussion, draft.sourceUnits);
      const decisionBatches = [];
      for (let index = 0; index < decisionItems.length; index += 8) decisionBatches.push(decisionItems.slice(index, index + 8));
      const decisionResults = (await Promise.all(decisionBatches.map((batch, index) => call(
        `critic-decision-${index + 1}`, decisionCheckPrompt(batch),
        { optional: true, responseKind: 'decision_check', maxAttempts: 2, candidateCount: batch.length }
      )))).flatMap((result) => (Array.isArray(result?.results) ? result.results : []));
      const decisionChecked = applyDecisionCheckResults(finalDiscussion, decisionItems, decisionResults);
      console.log(JSON.stringify({ event: 'meeting_agent_decision_check', journeyId: draft.draftId, checked: decisionChecked.checked, demoted: decisionChecked.demoted }));
      finalDiscussion = decisionChecked.discussion;
    }
    if (correctnessChecksEnabled()) {
      const fidelityDetails = sanitiseMeetingAgentDetails(draft.details);
      const fidelityItems = discussionFidelityCheckItems(finalDiscussion, draft.sourceUnits, {
        meetingDate: timingAnchor,
        people: [...(fidelityDetails.internalAttendees || []), ...(fidelityDetails.clientAttendees || []),
          ...(fidelityDetails.allAttendees || [])]
      });
      const fidelityBatches = [];
      for (let index = 0; index < fidelityItems.length; index += 8) fidelityBatches.push(fidelityItems.slice(index, index + 8));
      const fidelityResults = (await Promise.all(fidelityBatches.map((batch, index) => call(
        `critic-discussion-fidelity-${index + 1}`, discussionFidelityCheckPrompt(batch),
        { optional: true, responseKind: 'correction_check', maxAttempts: 2, candidateCount: batch.length,
          validateResult: result => meetingAgentReviewPacketError(batch, result, ['supported', 'corrected', 'uncertain']) }
      )))).flatMap((result) => (Array.isArray(result?.results) ? result.results : []));
      const minimalRepairEnabled = !/^(?:0|false|no|off)$/i.test(String(process.env.MEETING_MINUTES_AGENT_MINIMAL_FIDELITY_REPAIR_V1 || '1'));
      const minimalRepairStartedAt = Date.now();
      const fidelityChecked = !minimalRepairEnabled
        ? applyDiscussionFidelityResults(finalDiscussion, fidelityItems, fidelityResults)
        : await minimalFidelityRepair.repair(finalDiscussion, fidelityItems, fidelityResults, {
          request: (part, prompt) => call('critic-discussion-minimal-fidelity-' + part, prompt, {
            optional: true, silentOptionalFailure: true, responseKind: 'correction_check', maxAttempts: 1,
            independentBudgetMs: 45000, attemptTimeoutMs: 45000, candidateCount: 1
          })
        });
      // This optional repair must not consume the remaining time reserved for
      // existing placement, duplication and source checks later in the stage.
      if (minimalRepairEnabled) execution.stageDeadlineAt += Date.now() - minimalRepairStartedAt;
      finalDiscussion = fidelityChecked.discussion;
      fidelityFlags = fidelityChecked.flags;
      fidelityWithheldRows = fidelityChecked.withheld || [];
      ({minimalCorrectionRepair:minimalFidelityRepairAudit,...fidelityReview}=fidelityChecked.accounting);
      console.log(JSON.stringify({
        event: 'meeting_agent_discussion_fidelity', journeyId: draft.draftId,
        checked: fidelityChecked.checked, corrected: fidelityChecked.corrected, uncertain: fidelityChecked.uncertain,
        withheld: fidelityWithheldRows.length,
        rejected: fidelityChecked.rejected
      }));
    }
    // A month the speakers never named is replaced with a visible placeholder
    // and flagged, whichever pass wrote it.
    const monthGrounding = groundUnstatedDiscussionMonths(finalDiscussion, draft.sourceUnits);
    if (monthGrounding.changed.length) {
      finalDiscussion = monthGrounding.discussion;
      fidelityFlags = [...fidelityFlags, ...monthGrounding.flags];
      console.log(JSON.stringify({ event: 'meeting_agent_unstated_month', journeyId: draft.draftId, changed: monthGrounding.changed }));
    }
    if (correctnessChecksEnabled()) {
      const objections = promoteMaterialObjectionDetails(finalDiscussion);
      if (objections.promoted) {
        finalDiscussion = objections.discussion;
        console.log(JSON.stringify({ event: 'meeting_agent_promoted_objections', journeyId: draft.draftId, promoted: objections.promoted }));
      }
    }
    const rewritePartialOverlaps = async (candidates) => {
      const result = await call(
        'critic-discussion-overlap-consolidation',
        discussionOverlapConsolidationPrompt(candidates),
        {
          optional: true,
          responseKind: 'correction_check',
          maxAttempts: 1,
          silentOptionalFailure: true,
          candidateCount: candidates.length,
          candidateIds: candidates.map((candidate) => candidate.candidateId)
        }
      );
      return Array.isArray(result?.results) ? result.results : [];
    };
    // A final publication-boundary pass also covers wording returned by the
    // later question, attribution and fidelity checks. Flag reconciliation
    // below then drops any warning whose only target was removed here.
    const finalQuantifiedGrounding = filterUnsupportedQuantifiedDiscussion(finalDiscussion, draft.sourceUnits);
    finalDiscussion = await finaliseDiscussionForPublication(finalQuantifiedGrounding.discussion, {
      sourceUnits: draft.sourceUnits,
      people: meetingAgentPeopleNames(draft.sourceUnits),
      onUnassignedSupportingDetail: retainUnassignedSupportingDetail,
      rewritePartialOverlaps,
      onPartialOverlapConsolidated: ({ candidates, applied }) => console.log(JSON.stringify({
        event: 'meeting_agent_partial_overlap_consolidation', journeyId: draft.draftId,
        candidates, applied
      }))
    });
    if (finalQuantifiedGrounding.removed.length) console.log(JSON.stringify({
      event: 'meeting_agent_final_quantified_claim_filter', journeyId: draft.draftId,
      removed: finalQuantifiedGrounding.removed.map((item) => ({ id: item.id, signatures: item.signatures, subject: item.subject }))
    }));
    // Rows are rebuilt by several steps that keep the rows but not the flags
    // those steps raised; recover what the rows point at, drop dead references.
    // Last, on the finished body: the only point where every row is visible at
    // once, so a fact that arrived twice from two stages can be seen as one.
    const bodyDedupe = dedupeDiscussionBody(finalDiscussion, meetingAgentPeopleNames(draft.sourceUnits));
    if (bodyDedupe.dropped.length) {
      finalDiscussion = bodyDedupe.discussion;
      console.log(JSON.stringify({
        event: 'meeting_agent_body_dedupe', journeyId: draft.draftId,
        dropped: bodyDedupe.dropped.slice(0, 20)
      }));
    }
    const priorityDetails = promotePrioritySupportingDetails(finalDiscussion, 6, 2, draft.sourceUnits);
    const includeAllDetails = includeAllDiscussionDetailsExperiment();
    const includedDetails = includeAllDetails
      ? promoteAllDiscussionDetails(priorityDetails.discussion)
      : { discussion: priorityDetails.discussion, promoted: 0 };
    const postPromotion = (priorityDetails.promoted || includedDetails.promoted)
      ? await finalisePromotedDiscussion(includedDetails.discussion, {
        sourceUnits: draft.sourceUnits,
        topicSegments,
        topicLabels,
        people: meetingAgentPeopleNames(draft.sourceUnits),
        organise: meetingMinutesAgentDiscussionOrganiseEnabled(),
        onUnassignedSupportingDetail: retainUnassignedSupportingDetail,
        includeAllDetails,
        supportingSubjectPolicy: discussionCoveragePolicyForRun(draft).supportingSubjects ? 'meeting_minutes_v2' : undefined,
        rewritePartialOverlaps,
        onPartialOverlapConsolidated: ({ candidates, applied }) => console.log(JSON.stringify({
          event: 'meeting_agent_post_promotion_overlap_consolidation', journeyId: draft.draftId,
          candidates, applied
        })),
        onRestatements: (merges) => console.log(JSON.stringify({
          event: 'meeting_agent_post_promotion_restatements', journeyId: draft.draftId, merges
        }))
      })
      : {
        discussion: includedDetails.discussion,
        moved: 0,
        rePromoted: 0,
        organiser: null,
        dropped: [],
        diagnostics: discussionStructureDiagnostics(includedDetails.discussion)
      };
    const preCapMaterialTiming = promoteMaterialTimingDetails(postPromotion.discussion, draft.sourceUnits, {
      meetingDate: timingAnchor
    });
    finalDiscussion = removeMinorCommunicationCourtesyDiscussion(
      removeHeadingFragmentsFromDiscussion(limitSupportingDetails(preCapMaterialTiming.discussion, 12, 2, draft.sourceUnits)), draft.sourceUnits
    );
    let topicArrangement = {
      enabled: meetingMinutesAgentGlobalTopicArrangerEnabled(),
      applied: false,
      version: 0,
      diagnostics: null,
      fallbackReason: ''
    };
    if (topicArrangement.enabled) {
      const arrangementInput = discussionTopicArrangementInput(finalDiscussion, draft.sourceUnits);
      const eligibleTopicCount = new Set(arrangementInput.records.map((record) => record.currentTopic)).size;
      if (arrangementInput.invalidReason) {
        topicArrangement.fallbackReason = arrangementInput.invalidReason;
      } else if (arrangementInput.records.length >= 3 || eligibleTopicCount >= 2) {
        const arrangedResult = await call(
          'topic-arranger',
          meetingMinutesAgentTopicArrangementPrompt({ discussion: finalDiscussion, sourceUnits: draft.sourceUnits }),
          {
            optional: true,
            responseKind: 'topic_arrangement',
            maxAttempts: 2,
            // This pass is deliberately last because it must see every final
            // row. Give it fresh headroom instead of whatever happens to be
            // left from discovery/referee/critic work. The five-minute total
            // remains bounded; each upstream attempt may use at most three
            // minutes and the existing retry ladder gets one retry.
            independentBudgetMs: Number(process.env.MEETING_MINUTES_AGENT_TOPIC_ARRANGER_BUDGET_MS || 300000),
            attemptTimeoutMs: Number(process.env.MEETING_MINUTES_AGENT_TOPIC_ARRANGER_TIMEOUT_MS || 180000),
            candidateCount: arrangementInput.records.length,
            candidateIds: arrangementInput.records.map((record) => record.recordId),
            validateResult: (result) => validateDiscussionTopicArrangement(result, arrangementInput, { maximumRows: 8 }),
            repairPrompt: meetingMinutesAgentTopicArrangementRepairPrompt,
            captureError: (error) => { topicArrangement.fallbackReason = error.message; }
          }
        );
        if (arrangedResult) {
          const applied = applyDiscussionTopicArrangement(
            finalDiscussion, arrangedResult, draft.sourceUnits,
            { input: arrangementInput, maximumRows: 8 }
          );
          if (applied.applied) {
            finalDiscussion = applied.discussion;
            topicArrangement = {
              ...topicArrangement,
              applied: true,
              version: 1,
              diagnostics: applied.diagnostics,
              fallbackReason: ''
            };
          } else {
            topicArrangement.fallbackReason = applied.error?.message || 'The topic arrangement could not be applied.';
          }
        }
      }
      console.log(JSON.stringify({
        event: 'meeting_agent_global_topic_arrangement', journeyId: draft.draftId,
        ...topicArrangement
      }));
    }
    // The arranger is intentionally the last structural pass, but it can split
    // paraphrases which previously shared a card across newly generated topic
    // boundaries. Run the existing conservative whole-draft merge once more;
    // its figure, polarity, uncertainty, predicate and provenance checks still
    // protect genuinely distinct claims. Then apply the shared raw-speech guard
    // to every generated row/detail. Neither step invents wording.
    const postArrangementRows = flattenHybridDiscussion(finalDiscussion).length;
    finalDiscussion = await dedupeAdjacentRestatements(finalDiscussion, {
      sourceUnits: draft.sourceUnits
    });
    finalDiscussion = await demoteContainedPrimaryRows(finalDiscussion, {
      sourceUnits: draft.sourceUnits,
      onPrimaryDemotions: (demotions) => console.log(JSON.stringify({
        event: 'meeting_agent_post_arrangement_primary_demotions', journeyId: draft.draftId,
        count: demotions.length,
        reasons: demotions.reduce((counts, demotion) => ({
          ...counts, [demotion.reason]: (counts[demotion.reason] || 0) + 1
        }), {})
      }))
    });
    finalDiscussion = await dedupeGlobalRestatements(finalDiscussion, {
      sourceUnits: draft.sourceUnits
    });
    finalDiscussion = removeRawGeneratedDiscussionRows(finalDiscussion);
    const finalBoundaryRows = flattenHybridDiscussion(finalDiscussion).length;
    if (finalBoundaryRows !== postArrangementRows) console.log(JSON.stringify({
      event: 'meeting_agent_post_arrangement_dedupe', journeyId: draft.draftId,
      beforeRows: postArrangementRows, afterRows: finalBoundaryRows
    }));
    // Nothing after this boundary is allowed to manufacture or rewrite prose.
    // Run the idempotent presentation guard after dedupe, detail promotion and
    // global topic arrangement so every generated row is safe to persist.
    finalDiscussion = normaliseDiscussionPresentation(removeWithheldGeneratedDiscussion(finalDiscussion, fidelityWithheldRows));
    const materialDeadlines = promoteMaterialTimingDetails(finalDiscussion, draft.sourceUnits, { meetingDate: timingAnchor });
    finalDiscussion = materialDeadlines.discussion;
    const roleConflicts = flagConflictingDiscussionRoles(finalDiscussion, draft.sourceUnits);
    finalDiscussion = roleConflicts.discussion;
    // A model core verdict cannot turn a task-only sentence into discussion.
    // Retain the entire original in the filing pool and keep the raw verdict;
    // the publication audit must honestly report it as filed, not published.
    const actionOnlyDiscussion = structuredReferee
      ? retainPureFutureAssignments(finalDiscussion, meetingAgentPeopleNames(draft.sourceUnits), retainUnassignedSupportingDetail)
      : { discussion: finalDiscussion, retained: [] };
    finalDiscussion = actionOnlyDiscussion.discussion;
    if (roleConflicts.conflicts.length) console.log(JSON.stringify({
      event: 'meeting_agent_discussion_role_conflicts', journeyId: draft.draftId,
      conflicts: roleConflicts.conflicts
    }));
    const structureDiagnostics = discussionStructureDiagnostics(finalDiscussion);
    if (priorityDetails.promoted) console.log(JSON.stringify({
      event: 'meeting_agent_priority_details_promoted', journeyId: draft.draftId,
      promoted: priorityDetails.promoted
    }));
    if (includedDetails.promoted) console.log(JSON.stringify({
      event: 'meeting_agent_all_discussion_details_included', journeyId: draft.draftId,
      promoted: includedDetails.promoted
    }));
    console.log(JSON.stringify({
      event: 'meeting_agent_post_promotion_editorial', journeyId: draft.draftId,
      promoted: priorityDetails.promoted + includedDetails.promoted,
      moved: postPromotion.moved,
      rePromoted: postPromotion.rePromoted,
      organiser: postPromotion.organiser,
      deduped: postPromotion.dropped.length,
      diagnostics: structureDiagnostics
    }));
    // Coalesce only proven candidate/original aliases from this generated
    // handoff. Existing reviewer filing state never grants alias permission.
    const mergedUnassignedSupportingDetails = mergeUnassignedSupportingDetails(
      draft.unassignedSupportingDetails, unassignedSupportingDetails);
    const filingAliasReconciliation = discussionCoveragePolicyForRun(draft).filingAliases
      ? filingAliases.reconcile(
      mergedUnassignedSupportingDetails, candidateLedger, draft.sourceUnits, {
        enabled: discussionCoveragePolicyForRun(draft).filingAliases === true,
        handoffs: filingAliasHandoffs, priorRows: [...(draft.unassignedSupportingDetails || []),...optionalReview.entries(draft).map(entry=>entry.record)], discussion: finalDiscussion
      }) : { rows: mergedUnassignedSupportingDetails, audit: { applied: false, reason: 'disabled' } };
    const citedFilingAliasReconciliation = citedFilingAliases.reconcile(filingAliasReconciliation.rows,draft.sourceUnits,{
      enabled:discussionCoveragePolicyForRun(draft).citedFilingAliases===true,priorRows:[...(draft.unassignedSupportingDetails||[]),...optionalReview.entries(draft).map(entry=>entry.record)],discussion:finalDiscussion
    });
    const retainedUnassignedSupportingDetails = withoutRepresentedUnassignedDetails(
      citedFilingAliasReconciliation.rows, finalDiscussion
    );
    // Reconcile review links on unfiled context too. Primary/recovery flag
    // definitions may be recoverable only through the existing flag registry.
    const discussionFlagState = reconcileUsefulRecordFlags({ discussion: finalDiscussion,
      supportingDetails: retainedUnassignedSupportingDetails }, [...refereeFlags,
      ...(quantifiedGrounding.flags || []), ...(finalQuantifiedGrounding.flags || []),
      ...supersededContextFlags, ...attributionFlags, ...fidelityFlags, ...roleConflicts.flags], isUsefulMeetingAgentReviewFlag);
    const literalSupportCleanup = foldLiteralParentSupportingRepeats(discussionFlagState.content.discussion);
    const discussionSourceCoverage = reconcileDiscussionClauseSources(literalSupportCleanup.discussion, draft.sourceUnits,
      { resolve: resolveEvidence, meetingDate: timingAnchor });
    finalDiscussion = carryExactDiscussionProvenance(reconstructed.exactPublicationOrigins,
      discussionSourceCoverage.discussion);
    // The bounded editor has its own opt-in. It never enables the older
    // semantic/claim flags, and shares their private topic-scoped restore path.
    const boundedRewrite = /^(?:1|true|yes|on)$/i.test(String(process.env.MEETING_MINUTES_AGENT_DISCUSSION_BOUNDED_REWRITE_V1 || '0'));
    const rewriteCall = (stage, prompt, packet) => call('critic-discussion-rewrite-' + stage, prompt, {
      optional: true, silentOptionalFailure: true, responseKind: 'correction_check', maxAttempts: 1,
      independentBudgetMs: 45000, attemptTimeoutMs: 45000, candidateCount: packet.candidates.length
    });
    let claimConsolidation = boundedRewrite
      ? await discussionRewrite.consolidate(finalDiscussion, draft.sourceUnits, {
        crossMention: /^(?:1|true|yes|on)$/i.test(String(process.env.MEETING_MINUTES_AGENT_DISCUSSION_CROSS_MENTION_V1 || '0')),
        partialOverlap: /^(?:1|true|yes|on)$/i.test(String(
          process.env.MEETING_MINUTES_AGENT_DISCUSSION_PARTIAL_OVERLAP_REWRITE_V1 || '0')),
        inventory: (prompt, packet) => rewriteCall('inventory', prompt, packet),
        propose: (prompt, packet) => rewriteCall('proposal', prompt, packet),
        verify: (prompt, packet) => rewriteCall('verification', prompt, packet)
      })
      : /^(?:1|true|yes|on)$/i.test(String(process.env.MEETING_MINUTES_AGENT_DISCUSSION_CLAIM_CONSOLIDATION_V1 || '0'))
      ? await discussionClaims.consolidate(finalDiscussion, draft.sourceUnits, {
        assess: (prompt, packet) => call('critic-discussion-claim-proposal', prompt, {
          optional: true, silentOptionalFailure: true, responseKind: 'correction_check', maxAttempts: 1,
          independentBudgetMs: 45000, attemptTimeoutMs: 45000, candidateCount: packet.candidates.length
        }),
        verify: (prompt, packet, selected) => call('critic-discussion-claim-verification', prompt, {
          optional: true, silentOptionalFailure: true, responseKind: 'correction_check', maxAttempts: 1,
          independentBudgetMs: 45000, attemptTimeoutMs: 45000, candidateCount: selected.length
        })
      }) : { discussion: finalDiscussion, audit: { applied: false, reason: 'disabled' } };
    // Run after late demotion/organisation and the existing bounded editor.
    // Reviewer records remain ineligible. The captured warning policy can
    // preserve narrowly qualified reference warnings; parent text and source
    // references and warning targets remain unchanged. Reuse the private,
    // topic-scoped restore archive without discarding an earlier editor's proof.
    if (/^(?:1|true|yes|on)$/i.test(String(process.env.MEETING_MINUTES_AGENT_DISCUSSION_OWN_PARENT_COVERAGE_V1 || '0'))) {
      const ownParent = await discussionOwnParent.consolidate(claimConsolidation.discussion, draft.sourceUnits, {
        warnedChildren: discussionCoveragePolicyForRun(draft).warnedOwnParent === true,
        presentConsideration: discussionCoveragePolicyForRun(draft).presentConsideration === true,
        reviewFlags: discussionFlagState.flags,
        inventory: (prompt, packet) => rewriteCall('own-parent-inventory', prompt, packet),
        verify: (prompt, packet) => rewriteCall('own-parent-verification', prompt, packet)
      });
      claimConsolidation = discussionOwnParent.combine(claimConsolidation, ownParent, draft.sourceUnits);
    }
    // One unchanged existing survivor at most. This does not enable the broad
    // semantic merger or loosen its guards. Any provider veto keeps both rows.
    if (boundedRewrite && !/^(?:0|false|no|off)$/i.test(String(
      process.env.MEETING_MINUTES_AGENT_DISCUSSION_DIRECTIONAL_COVERAGE_V1 || '1'))) {
      const directional = await discussionClaims.consolidate(claimConsolidation.discussion, draft.sourceUnits, {
        nominationMode: 'directional',
        assess: (prompt, packet) => rewriteCall('directional-proposal', prompt, packet),
        verify: (prompt, packet) => rewriteCall('directional-verification', prompt, packet)
      });
      claimConsolidation = discussionDirectional.combine(claimConsolidation, directional, draft.sourceUnits);
    }
    if (boundedRewrite && discussionCoveragePolicyForRun(draft).mainPoint) {
      const mainPoint = await discussionMainPoint.consolidate(claimConsolidation.discussion, draft.sourceUnits, {
        inventory: (prompt, packet) => rewriteCall('main-point-inventory', prompt, packet),
        verify: (prompt, packet) => rewriteCall('main-point-verification', prompt, packet)
      });
      claimConsolidation = discussionMainPoint.combine(claimConsolidation, mainPoint, draft.sourceUnits);
    }
    if (boundedRewrite && discussionCoveragePolicyForRun(draft).pointDecision) {
      const pointDecision = await discussionPointDecision.consolidate(claimConsolidation.discussion, draft.sourceUnits, {
        assess: (prompt, packet) => rewriteCall('point-decision-proposal', prompt, packet),
        verify: (prompt, packet) => rewriteCall('point-decision-verification', prompt, packet)
      });
      claimConsolidation = discussionPointDecision.combine(claimConsolidation, pointDecision, draft.sourceUnits);
    }
    finalDiscussion = claimConsolidation.discussion;
    const finalPublication = discussionPublicationCoverage(finalDiscussion, refereeDiscussionDispositions, ensemble,
      { unassignedSupportingDetails: retainedUnassignedSupportingDetails, withheldRows: fidelityWithheldRows });
    const objectives = mergeGroundedObjectiveRecords([
      primaryParsed.meetingObjectives || primaryParsed.objectives || [],
      recovery ? (recovery.meetingObjectives || recovery.objectives || []) : [],
      refereeParsed.meetingObjectives || refereeParsed.objectives || []
    ], draft.sourceUnits);
    const supportingRecords = flattenHybridDiscussion(finalDiscussion).flatMap((item) => item.record?.supportingDetails || []);
    const candidateDispositions = hybridCandidateDispositions(
      ensemble,
      flattenHybridDiscussion(finalDiscussion).map((item) => ({ ...item.record, _recordType: item.recordType })),
      [], [...supportingRecords, ...retainedUnassignedSupportingDetails]
    );
    const passImpact = meetingAgentMaterialPassImpact(candidateDispositions, {
      referee: { materialContributionCount: completedPasses.includes('referee')
        ? flattenHybridDiscussion(finalDiscussion).length + supportingRecords.length : 0,
        materialCandidateIds: candidateDispositions.filter((item) =>
          ['publish', 'proposal', 'supporting'].includes(item?.disposition))
          .map((item) => meetingMinutesAgentText(item?.candidateId, 160)).filter(Boolean) }
    });
    const measuredProvenance = annotateMeetingAgentPassImpact(passProvenance, passImpact);
    // The user now has a discussion draft to review. Use that review interval
    // to prepare the private action candidate source without delaying upload or
    // competing with foreground discussion work.
    startPrivateStagedCandidateLedger(draft, 'actions').catch((error) => {
      console.warn(JSON.stringify({ event: 'meeting_agent_staged_prewarm', stage: 'actions', ok: false, message: error.message }));
    });
    startPrivateActionPrimaryPrewarm(draft).catch((error) => {
      console.warn(JSON.stringify({ event: 'meeting_agent_primary_prewarm', stage: 'actions', ok: false, message: error.message }));
    });
    return {
      changes: {
        discussion: finalDiscussion, unassignedSupportingDetails: retainedUnassignedSupportingDetails,
        meetingObjectives: objectives, candidateLedger,
        passProvenance: [...(draft.passProvenance || []), ...measuredProvenance].slice(-40),
        passCache: execution.passCache,
        qualityState: { ...(draft.qualityState || {}), discussion: {
          ...(execution.refereeFailureAudit ? { refereeFailureAudit: execution.refereeFailureAudit } : {}),
          completedPasses, recoveryUsed: Boolean(recovery), degradedSources,
          completedAt: new Date().toISOString(), passImpact,
          callPerformance: meetingAgentCallPerformance(measuredProvenance),
          stageElapsedMs: Date.now() - stageStartedAt, stagedCandidateElapsedMs,
          stagedCandidatesFromCache: cachedStaged.length > 0 || stagedCandidatesFromPrewarm,
          corroboratedRecoveryCount: flattenHybridDiscussion(recoveredDiscussion).length,
          compactDiscussionEnabled: compactEnabled,
          compactDiscussionShadowEnabled: compactShadowEnabled,
          shadowVisiblePropositionCount: compactShadowEnabled ? flattenHybridDiscussion(compactPreview).length : null,
          shadowSupportingDetailCount: compactShadowEnabled
            ? flattenHybridDiscussion(compactPreview).flatMap((item) => item.record?.supportingDetails || []).length : null,
          visiblePropositionCount: flattenHybridDiscussion(finalDiscussion).length,
          supportingDetailCount: supportingRecords.length,
          literalSupportingRepeatsFolded: literalSupportCleanup.foldedCount,
          claimConsolidation: claimConsolidation.audit,
          ...(discussionCoveragePolicyForRun(draft).filingAliases ? { filingAliasReconciliation: filingAliasReconciliation.audit } : {}),
          ...(discussionCoveragePolicyForRun(draft).citedFilingAliases ? {citedFilingAliasReconciliation:citedFilingAliasReconciliation.audit} : {}),
          discussionSourceCoverage: discussionSourceCoverage.audit,
          unassignedSupportingDetailCount: retainedUnassignedSupportingDetails.length,
          fidelityWithheldRows,
          fidelityReview,
          ...(minimalFidelityRepairAudit ? {minimalFidelityRepair:minimalFidelityRepairAudit} : {}),
          materialDeadlinePromotionCount: preCapMaterialTiming.promoted + materialDeadlines.promoted,
          topicArrangementVersion: topicArrangement.version,
          topicArrangement,
          postPromotionEditorial: {
            promoted: priorityDetails.promoted + includedDetails.promoted,
            moved: postPromotion.moved,
            rePromoted: postPromotion.rePromoted,
            organiser: postPromotion.organiser,
            deduped: postPromotion.dropped.length,
            diagnostics: structureDiagnostics
          },
          telemetry: meetingAgentExecutionTelemetry(measuredProvenance),
          refereeRoute,
          partialRefereeFallback: {
            applied: partialFallback.active && !completeStructuredReferee,
            settledCandidateIds: partialFallback.active && !completeStructuredReferee
              ? partialFallback.settledCandidateIds : [],
            // Private provenance: retain the exact discovery versions whose
            // existing referee route is preserved, including their metadata.
            routedRecords: partialFallback.active && !completeStructuredReferee
              ? partialFallback.routedRecords : []
          },
          refereeSufficiency: { ...compactSufficiency,
            sufficient: compactSufficiency.sufficient && finalPublication.complete,
            publicationComplete: finalPublication.complete },
          selectionCoverage: {
            suppliedCandidateIds: selectionCoverage.suppliedCandidateIds,
            clusteredCandidateIds: selectionCoverage.clusteredCandidateIds,
            unassessedCandidateIds: selectionCoverage.unassessedCandidateIds
          },
          refereePublication: { compact: compactPublication, final: finalPublication },
          actionOnlyDiscussionRetained: actionOnlyDiscussion.retained,
          refereeContract: {
            ...rawContractDiagnostics,
            reconstructedTargetIds: reconstructed.reconstructedTargetIds,
            unresolvedTargetIds: reconstructed.unresolvedTargetIds
          },
          refereeCandidateDispositions: rawRefereeDiscussionDispositions.slice(0, 400),
          effectiveRefereeCandidateDispositions: refereeDiscussionDispositions.slice(0, 400),
          candidateDispositions
        } }
      },
      reviewFlags: discussionFlagState.flags, replaceCoverageFlags: false
    };
  };
}

module.exports = { createOriginalDiscussionStage };
