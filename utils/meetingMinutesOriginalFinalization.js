'use strict';

const { TIMING_POLICY_VERSION } = require('./meetingMinutesTiming');
const actionDiagnostics = require('./meetingMinutesActionDiagnostics');
const actionPhase = require('./meetingMinutesActionPhaseCorrection');
const actionUnion = require('./meetingMinutesActionUnionRewrite');
const { cleanGeneratedMeetingAgentResult } = require('./meetingMinutesGeneratedHygiene');
const { discussionPublicationCoverage } = require('./meetingMinutesDiscussionCoverage');
const { isActionOnlySemanticScope, semanticPolicyForRun } = require('./meetingMinutesSemanticPolicy');
const { meetingAgentCallPerformance, meetingAgentExecutionTelemetry } = require('./meetingMinutesAgentGeneration');
const { normaliseDatePhrasesDeep } = require('./spokenForms');
const { normaliseKnownTerms: normaliseMeetingAgentKnownTerms } = require('./meetingMinutesText');
const { normalisePresentationCurrency } = require('./canonicalMinutes/textNormalisation');
const { normaliseSourceUnits } = require('./meetingMinutesSource');
const { reconcileGeneratedSemanticStage } = require('./meetingMinutesSemanticStage');

function createOriginalFinalization(services) {
  const {
    askPowerAutomateMeetingMinutesAgentWithRetry,
    meetingAgentFlagUntouched,
    meetingAgentPromptDetails,
    meetingAgentProposalReviewFlagId,
    meetingAgentTimingAnchor,
    normaliseMeetingAgentMinuteNumbers,
    reconcileFinalApprovedActions,
    semanticReceiptCoversActionProposal
  } = services;

  async function finishMeetingAgentSemanticStage(result, draft, stage, options = {}) {
    // Bind witnesses to the exact prepared-source schema persisted by payload(),
    // including legacy callers lacking default source fields. Raw transcript
    // storage remains separate and is never rewritten by this boundary.
    draft = { ...draft, sourceUnits: normaliseSourceUnits(draft.sourceUnits) };
    if (stage === 'actions') actionDiagnostics.checkpoint('raw_generation_complete', result?.changes?.actions || []);
    let cleaned = cleanGeneratedMeetingAgentResult(result, stage);
    if (stage === 'actions') actionDiagnostics.checkpoint('generated_hygiene', cleaned?.changes?.actions || []);
    const shadowOriginal = cleaned;
    const policy = semanticPolicyForRun(draft, options.semanticPolicy);
    const previousSemantic = cleaned?.changes?.qualityState?.[stage]?.semanticReconciliation
      || draft.qualityState?.[stage]?.semanticReconciliation;
    if (policy.mode === 'off' && ['actions', 'discussion'].includes(stage)
      && Array.isArray(cleaned?.changes?.[stage]) && previousSemantic) {
      // Legacy generation can omit qualityState. Retain its predecessor only as
      // inactive recovery history; it cannot authorize deletion in this new run.
      const qualityState = { ...(draft.qualityState || {}), ...(cleaned.changes.qualityState || {}) };
      cleaned = { ...cleaned, changes: { ...cleaned.changes, qualityState: { ...qualityState,
        [stage]: { ...(qualityState[stage] || {}), semanticReconciliation: { ...previousSemantic,
          applied: false, publishedApplied: false, mode: 'off', supersededByPolicyOff: true,
          previousPolicy: previousSemantic.previousPolicy || previousSemantic.policy, policy } }
      } } };
    }
    // Freeze the same visible presentation that save/publication will expose,
    // before creating content-bound proofs. Keep source and receipt metadata raw.
    if (policy.mode !== 'off' && (!isActionOnlySemanticScope(policy.scope) || stage === 'actions')
      && ['actions', 'discussion'].includes(stage) && cleaned?.changes?.[stage]) {
      const numbered = normaliseMeetingAgentMinuteNumbers({ [stage]: cleaned.changes[stage] });
      const format = value => normaliseMeetingAgentKnownTerms(normaliseDatePhrasesDeep(normalisePresentationCurrency(value)));
      const formatRecord = (record, field) => ({ ...record, [field]: format(record[field]),
        ...(field === 'action' && record.timing ? { timing: { ...record.timing, wording: format(record.timing.wording) } } : {}),
        ...(Array.isArray(record.supportingDetails) ? { supportingDetails: record.supportingDetails.map(item => formatRecord(item, 'text')) } : {}) });
      const formatted = stage === 'actions' ? numbered.actions.map(record => formatRecord(record, 'action'))
        : numbered.discussion.map(topic => ({ ...topic, ...Object.fromEntries(['points', 'decisions', 'openQuestions']
          .filter(key => Array.isArray(topic[key])).map(key => [key, topic[key].map(record => formatRecord(record, 'text'))])) }));
      cleaned = { ...cleaned, changes: { ...cleaned.changes, [stage]: formatted } };
    }
    if (stage === 'actions') actionDiagnostics.checkpoint('presentation_normalisation', cleaned?.changes?.actions || []);
    const reconciled = await reconcileGeneratedSemanticStage(cleaned, draft, stage, {
      policy: semanticPolicyForRun(draft, options.semanticPolicy),
      meetingDate: meetingAgentTimingAnchor(draft),
      context: { details: meetingAgentPromptDetails(draft), timingPolicyVersion: TIMING_POLICY_VERSION,
        steer: draft.steer || '', salientDetails: draft.salientDetails || [] },
      ask: options.semanticAsk || askPowerAutomateMeetingMinutesAgentWithRetry,
      onProgress: options.onProgress,
      verifySurvival: reconcileFinalApprovedActions
    });
    if (policy.mode === 'shadow' && reconciled?.changes && shadowOriginal?.changes) {
      reconciled.changes = { ...reconciled.changes, [stage]: shadowOriginal.changes[stage] };
    }
    const publicationState = reconciled?.changes?.qualityState?.discussion;
    if (stage === 'discussion' && publicationState?.refereePublication) {
      const final = discussionPublicationCoverage(reconciled.changes.discussion,
        publicationState.effectiveRefereeCandidateDispositions || [], reconciled.changes.candidateLedger || [], {
          unassignedSupportingDetails: reconciled.changes.unassignedSupportingDetails,
          withheldRows: publicationState.fidelityWithheldRows
        });
      publicationState.refereePublication = { ...publicationState.refereePublication, final };
      publicationState.refereeSufficiency = { ...publicationState.refereeSufficiency,
        sufficient: (publicationState.refereeSufficiency?.accountingAuthoritative
          || publicationState.refereeSufficiency?.sufficient) && final.complete,
        publicationComplete: final.complete };
    }
    const semantic = reconciled?.changes?.qualityState?.[stage]?.semanticReconciliation;
    if (isActionOnlySemanticScope(policy.scope) && stage !== 'actions') return reconciled;
    if (!semantic || policy.mode === 'off') return reconciled;
    if (stage === 'actions' && semantic.applied && semantic.receipts?.length && reconciled.changes.pendingProposal) {
      const proposal = reconciled.changes.pendingProposal;
      const proofOptions = { receipts: semantic.receipts, sourceUnits: draft.sourceUnits };
      const represented = (proposal.changes || []).filter(change => change?.type === 'add' && change.after
        && semanticReceiptCoversActionProposal(change.after, reconciled.changes.actions, proofOptions));
      if (represented.length) {
        const covered = new Set(represented);
        const remaining = proposal.changes.filter(change => !covered.has(change));
        reconciled.changes.pendingProposal = remaining.length ? { ...proposal, changes: remaining } : null;
        semantic.coveredProposalChanges = structuredClone(represented);
        // The original warning state remains recoverable. Only an untouched
        // missing-work flag for the exact represented proposal can be resolved.
        const ids = new Set(represented.map(meetingAgentProposalReviewFlagId));
        const isCoveredFlag = flag => ids.has(String(flag?.id || ''))
          && flag.kind === 'possible_missed_follow_up' && meetingAgentFlagUntouched(flag);
        const retainedFlags = [];
        for (const target of [reconciled, reconciled.changes]) {
          if (!Array.isArray(target.reviewFlags)) continue;
          retainedFlags.push(...target.reviewFlags.filter(isCoveredFlag));
          target.reviewFlags = target.reviewFlags.filter(flag => !isCoveredFlag(flag));
        }
        if (retainedFlags.length) semantic.coveredProposalFlags = structuredClone(retainedFlags);
      }
    }
    const calls = semantic.calls || [];
    const state = reconciled.changes.qualityState[stage];
    const provenance = [...(reconciled.changes.passProvenance || []), ...calls].slice(-40);
    return { ...reconciled, changes: { ...reconciled.changes,
      passProvenance: provenance,
      qualityState: { ...reconciled.changes.qualityState, [stage]: { ...state,
        ...(stage === 'actions' ? { automaticCount: reconciled.changes.actions.length } : {}),
        callPerformance: [...(state.callPerformance || []), ...meetingAgentCallPerformance(calls)],
        telemetry: meetingAgentExecutionTelemetry(provenance.filter(item => item.stage === stage)),
        stageElapsedMs: Number(state.stageElapsedMs || 0) + semantic.elapsedMs
      } }
    } };
  }
  async function finishMeetingAgentGeneratedStage(result, draft, stage, options = {}) {
    const finished = await finishMeetingAgentSemanticStage(result, draft, stage, options);
    if (stage !== 'actions' || !Array.isArray(finished?.changes?.actions)) return finished;
    const finishPhases = async input => {
      const policy=semanticPolicyForRun(draft,options.semanticPolicy);
      if (policy.mode !== 'on' || policy.phaseClarifications !== true) return input;
      const corrected = await actionPhase.correct(input.changes.actions, normaliseSourceUnits(draft.sourceUnits), {
        meetingDate:meetingAgentTimingAnchor(draft),
        protectedIds:[...(draft.keptActionOccurrenceIds||[]),...(draft.keptActionIds||[])],
        ask:options.phaseAsk || options.semanticAsk || askPowerAutomateMeetingMinutesAgentWithRetry
      });
      const state=input.changes.qualityState || draft.qualityState || {};
      return { ...input, changes:{ ...input.changes,actions:corrected.actions,qualityState:{...state,
        actions:{...state.actions,actionPhaseCorrection:corrected.audit,automaticCount:corrected.actions.length}} } };
    };
    if (!/^(?:1|true|yes|on)$/i.test(process.env.MEETING_MINUTES_AGENT_WORKFLOW_UNION_V1 || '0')) return finishPhases(finished);
    const started = Date.now();
    const checked = await actionUnion.rewrite(finished.changes.actions, normaliseSourceUnits(draft.sourceUnits), {
      meetingDate: meetingAgentTimingAnchor(draft), protectedIds: [...(draft.keptActionOccurrenceIds || []),...(draft.keptActionIds || [])],
      compilation:semanticPolicyForRun(draft,options.semanticPolicy).compilationUnions===true,
      ask: options.unionAsk || options.semanticAsk || askPowerAutomateMeetingMinutesAgentWithRetry
    });
    const state = finished.changes.qualityState || draft.qualityState || {};
    const changes = { ...finished.changes, actions: checked.actions, qualityState: { ...state, actions: {
      ...state.actions, actionUnionRewrite: checked.audit, automaticCount: checked.actions.length,
      stageElapsedMs: Number(state.actions?.stageElapsedMs || 0) + Date.now() - started
    } } };
    if (checked.audit.applied && changes.pendingProposal?.changes) {
      checked.audit.coveredProposalChanges = changes.pendingProposal.changes.filter(change => change.type === 'add'
        && checked.audit.receipts.some(r => checked.actions.some(a => actionUnion.valid(r, change.after, a, draft.sourceUnits))));
      const remaining = changes.pendingProposal.changes.filter(change => !checked.audit.coveredProposalChanges.includes(change));
      changes.pendingProposal = remaining.length ? { ...changes.pendingProposal, changes: remaining } : null;
    }
    return finishPhases({ ...finished, changes });
  }

  return { finishMeetingAgentSemanticStage, finishMeetingAgentGeneratedStage };
}

module.exports = { createOriginalFinalization };
