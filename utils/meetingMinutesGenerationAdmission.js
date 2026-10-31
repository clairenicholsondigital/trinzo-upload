'use strict';

const { MEETING_AGENT_STAGE_STEP } = require('./meetingMinutesStageProtocol');
const actionDiagnostics = require('./meetingMinutesActionDiagnostics');
const actionPhase = require('./meetingMinutesActionPhaseCorrection');
const actionUnion = require('./meetingMinutesActionUnionRewrite');
const { assignGeneratedActionIdentities, findActionOccurrenceIndex, preserveActionIdentity } = require('./meetingMinutesActionIdentity');
const { buildProposal } = require('./meetingMinutesProposals');
const crypto = require('crypto');
const { dedupeHybridActionRecords } = require('./meetingMinutesActionDuplicatePolicy');
const discussionActionSeparation = require('./canonicalMinutes/discussionActionSeparation');
const { hybridActionsEquivalent, meetingAgentProposalChangeIsVisible, preselectActionProposal, preselectDiscussionProposal } = require('./meetingMinutesProposalSelection');
const { isActionOnlySemanticScope } = require('./meetingMinutesSemanticPolicy');
const { isSalientCoverageFlag: isMeetingAgentCoverageFlag, meetingAgentFlagUntouched, meetingAgentProposalReviewFlagId, mergeMeetingAgentFlags } = require('./meetingMinutesReviewFlags');
const { isReviewerAuthored } = require('./canonicalMinutes/state');
const { meetingAgentDiscussionFingerprint } = require('./meetingMinutesDiscussionFingerprint');
const { meetingAgentEditableActionSignature } = require('./meetingMinutesProposalReview');
const { meetingAgentReferencedFlagIds } = require('./meetingMinutesDraftView');
const { meetingAgentTimingAnchor } = require('./meetingMinutesDraftContext');
const { meetingMinutesAgentText } = require('./meetingMinutesPlainText');
const { mergeUnassignedSupportingDetails, normalizeUnassignedSupportingDetails, withoutRepresentedUnassignedDetails } = require('./meetingMinutesSupportingDetails');
const { normaliseAgentResult } = require('./meetingMinutesResultNormalization');
const { normaliseKeptActionOccurrenceIds } = require('./actionReviewState');
const { normaliseSourceUnits } = require('./meetingMinutesSource');
const optionalReview = require('./meetingMinutesOptionalReview');
const { rebindReconciliationReceipt } = require('./canonicalMinutes/actionSemanticReconciliation');

function mergeMeetingAgentGenerationFlags(existing = [], added = [], replaceCoverage = false, recheck = {}) {
  const fields = new Set();
  const changes = recheck.changes || {};
  if (recheck.stage === 'summary' && changes.qualityState?.summary?.temporalReview?.complete === true) {
    for (const field of ['executiveSummary', 'meetingObjectives']) {
      if (Object.prototype.hasOwnProperty.call(changes, field)) fields.add(field);
    }
  }
  if (recheck.stage === 'actions' && Object.prototype.hasOwnProperty.call(changes, 'actions')
    && changes.qualityState?.actions?.timedStepCoverage?.final?.complete === true) fields.add('timedStepCoverage');
  // Retire stale generated warnings only after an authoritative successful
  // recheck was actually applied. Reviewer decisions/notes and incomplete
  // checks retain their previous warnings.
  const prior = (Array.isArray(existing) ? existing : []).filter(flag =>
    !(replaceCoverage && isMeetingAgentCoverageFlag(flag))
    && !(fields.has(flag.temporalField) && meetingAgentFlagUntouched(flag)));
  const merged = mergeMeetingAgentFlags(prior, added);
  if (recheck.stage !== 'actions' || !Array.isArray(changes.actions) || !Array.isArray(recheck.draft?.sourceUnits)) return merged;
  // A fresh final action pass has removed resolved references already. Recheck
  // older persisted warnings against that same applied work/source; do not
  // trust a retirement ID alone or retire a still-referenced live warning.
  const references = meetingAgentReferencedFlagIds(changes.actions);
  const checked = require('../utils/meetingMinutesTimingFlags').reconcileActionTimingWarnings(
    changes.actions, merged, recheck.draft.sourceUnits,
    { meetingDate: meetingAgentTimingAnchor(recheck.draft), proposals: [changes.pendingProposal, recheck.draft.pendingProposal],
      otherRecords: [changes.discussion ?? recheck.draft.discussion, changes.meetingObjectives ?? recheck.draft.meetingObjectives,
        changes.unassignedSupportingDetails ?? recheck.draft.unassignedSupportingDetails] }
  );
  const retired = checked.retired.filter(item => !references.has(item.id));
  if (retired.length) console.log(JSON.stringify({ event: 'meeting_agent_persisted_timing_warning_retired',
    journeyId: recheck.draft.draftId || '', retired }));
  const ids = new Set(retired.map(item => item.id));
  return merged.filter(flag => !ids.has(flag.id));
}

function meetingAgentActionsFingerprint(actions = []) {
  const rows = (Array.isArray(actions) ? actions : []).map(meetingAgentEditableActionSignature);
  return crypto.createHash('sha1').update(JSON.stringify(rows)).digest('hex').slice(0, 16);
}

function admitMeetingAgentGeneratedActionChanges(fresh = {}, input = {}, generationKey = '') {
  const changes = { ...input };
  const checkedBefore = normaliseKeptActionOccurrenceIds(fresh.keptActionOccurrenceIds,
    [...(fresh.actions || []), ...(fresh.removedActions || [])]);
  if (JSON.stringify(checkedBefore) !== JSON.stringify(fresh.keptActionOccurrenceIds || [])) {
    changes.keptActionOccurrenceIds = checkedBefore;
  }
  const original = Array.isArray(changes.actions) ? changes.actions : (fresh.actions || []);
  const reserved = [...(fresh.actions || []), ...(fresh.removedActions || [])];
  const allocated = Array.isArray(changes.actions)
    ? assignGeneratedActionIdentities(original, {
      existingActions: fresh.actions || [], reservedActions: reserved, generationKey
    }).actions : original;
  if (Array.isArray(changes.actions)) changes.actions = allocated;
  const diagnostics = changes.qualityState?.actions?.actionDiagnostics;
  if (diagnostics && Array.isArray(changes.actions)) {
    changes.qualityState = { ...changes.qualityState, actions: { ...changes.qualityState.actions,
      actionDiagnostics: actionDiagnostics.bindPublished(diagnostics, original, allocated) } };
  }
  const separation = changes.qualityState?.discussion?.claimConsolidation;
  if (Array.isArray(changes.actions) && Array.isArray(changes.discussion)
    && separation?.method === discussionActionSeparation.VERSION && separation.applied) {
    const bound = discussionActionSeparation.rebindActionIdentities(original, allocated, separation);
    if (!bound) {
      const reverted = discussionActionSeparation.revertGeneratedPair(input, separation);
      return admitMeetingAgentGeneratedActionChanges(fresh, { ...reverted, qualityState: { ...reverted.qualityState,
        discussion: { ...reverted.qualityState.discussion, claimConsolidation: separation.priorAudit || { ...separation, applied: false, reason: 'identity_binding_failed' } },
        actions: { ...reverted.qualityState.actions, discussionActionSeparationCount: 0, sourceClarificationCorrectionCount: 0,
          deferredDiscussionActionSeparation: { ...separation, applied: false, reason: 'identity_binding_failed' } }
      } }, generationKey);
    }
    changes.qualityState = { ...changes.qualityState, discussion: { ...changes.qualityState.discussion, claimConsolidation: bound } };
  }
  const phase = changes.qualityState?.actions?.actionPhaseCorrection;
  if (phase?.applied) {
    const bound=actionPhase.rebind(phase,original,allocated,normaliseSourceUnits(fresh.sourceUnits),meetingAgentTimingAnchor(fresh));
    if (!bound) return admitMeetingAgentGeneratedActionChanges(fresh,{...input,actions:structuredClone(phase.original),
      qualityState:{...changes.qualityState,actions:{...changes.qualityState.actions,
        actionPhaseCorrection:{...phase,applied:false,receipts:[],reason:'identity_binding_failed'}}}},generationKey);
    changes.qualityState={...changes.qualityState,actions:{...changes.qualityState.actions,actionPhaseCorrection:bound}};
  }
  const union = changes.qualityState?.actions?.actionUnionRewrite;
  if (Array.isArray(changes.actions) && union?.applied) {
    const bound = union.receipts.map(receipt => {
      const candidates = original.flatMap((row, index) => {
        const proof = actionUnion.rebind(receipt, row, allocated[index], normaliseSourceUnits(fresh.sourceUnits));
        return proof ? [proof] : [];
      });
      return candidates.length === 1 ? candidates[0] : null;
    });
    if (bound.some(receipt => !receipt)) return admitMeetingAgentGeneratedActionChanges(fresh, { ...input,
      actions: structuredClone(union.original),
      pendingProposal: union.coveredProposalChanges?.length ? { ...(input.pendingProposal || {stage:'actions'}),
        changes: [...(input.pendingProposal?.changes || []), ...union.coveredProposalChanges] } : input.pendingProposal,
      qualityState: { ...changes.qualityState, actions: { ...changes.qualityState.actions,
        actionUnionRewrite: { ...union, applied:false, receipts:[], reason:'identity_binding_failed' } } }
    }, generationKey);
    changes.qualityState = { ...changes.qualityState, actions: { ...changes.qualityState.actions,
      actionUnionRewrite: { ...union, receipts:bound,...(union.version==='compilation-union-v1'?{finalHash:actionUnion.hash(allocated)}:{}), identityBinding:{complete:true} } } };
  }
  const semantic = changes.qualityState?.actions?.semanticReconciliation;
  if (Array.isArray(changes.actions) && semantic?.applied && semantic.receipts?.length) {
    const bound = semantic.receipts.map(receipt => {
      const candidates = original.map((row, index) => ({ index,
        bound: rebindReconciliationReceipt(receipt, row, allocated[index], normaliseSourceUnits(fresh.sourceUnits)) }))
        .filter(item => item.bound);
      return candidates.length === 1 ? candidates[0].bound : null;
    });
    if (bound.some(receipt => !receipt)) {
      // Identity admission is mandatory. An unbindable proof cannot justify
      // deletion: recover the retained originals and allocate them normally.
      return admitMeetingAgentGeneratedActionChanges(fresh, { ...input,
        actions: structuredClone(semantic.original),
        qualityState: { ...changes.qualityState, actions: { ...changes.qualityState.actions,
          semanticReconciliation: { ...semantic, applied: false, receipts: [], ledger: [],
            identityBinding: { complete: false },
            unresolved: [...(semantic.unresolved || []), { reason: 'semantic_identity_binding_failed' }] }
        } }
      }, generationKey);
    }
    changes.qualityState = { ...changes.qualityState, actions: { ...changes.qualityState.actions,
      semanticReconciliation: { ...semantic, receipts: bound, identityBinding: { complete: true },
        ...(isActionOnlySemanticScope(semantic.policy?.scope) ? { restoreSnapshot: structuredClone(allocated) } : {}) }
    } };
  }
  const proposal = changes.pendingProposal;
  if (proposal?.stage !== 'actions' || !Array.isArray(proposal.changes)) return changes;
  const additions = proposal.changes.filter(change => change.type === 'add' && change.after);
  const admittedAdds = assignGeneratedActionIdentities(additions.map(change => change.after), {
    reservedActions: [...reserved, ...allocated], generationKey: generationKey + ':proposal'
  }).actions;
  let addIndex = 0;
  changes.pendingProposal = { ...proposal, changes: proposal.changes.map(change => {
    if (change.type === 'add' && change.after) return { ...change, after: admittedAdds[addIndex++] };
    if (!change.before) return change;
    const index = findActionOccurrenceIndex(original, change.before);
    if (index < 0) return change;
    const target = allocated[index];
    return { ...change,
      before: preserveActionIdentity(target, change.before),
      ...(change.type === 'modify' && change.after ? { after: preserveActionIdentity(target, change.after) } : {})
    };
  }) };
  return changes;
}

function meetingAgentRegenerationChanges(fresh = {}, stage = '', scopedChanges = {}, result = {}) {
  const changes = { ...scopedChanges };
  let incomingFlags = Array.isArray(result.reviewFlags) ? result.reviewFlags : [];
  let keptReviewerActions = false;
  if (stage === 'discussion' && Object.prototype.hasOwnProperty.call(changes, 'discussion')) {
    const generated = Array.isArray(changes.discussion) ? changes.discussion : [];
    const current = Array.isArray(fresh.discussion) ? fresh.discussion : [];
    const previousFingerprint = fresh.qualityState?.discussion?.generatedFingerprint || '';
    const reviewerEdited = current.length > 0 && (!previousFingerprint
      || meetingAgentDiscussionFingerprint(current) !== previousFingerprint);
    const qualityState = changes.qualityState || { ...(fresh.qualityState || {}) };
    changes.qualityState = {
      ...qualityState,
      discussion: {
        ...(qualityState.discussion || {}),
        generatedFingerprint: meetingAgentDiscussionFingerprint(generated)
      }
    };
    if (reviewerEdited) {
      const proposal = preselectDiscussionProposal(buildProposal('discussion', current, generated));
      changes.pendingProposal = proposal?.changes?.length ? { ...proposal, source: 'regeneration' } : null;
      delete changes.discussion;
      const semantic = changes.qualityState?.discussion?.semanticReconciliation;
      if (semantic) changes.qualityState.discussion = { ...changes.qualityState.discussion,
        semanticReconciliation: { ...semantic, applied: false, publishedApplied: false, deferredToProposal: true } };
      const generatedFlagIds = meetingAgentReferencedFlagIds(generated);
      incomingFlags = incomingFlags.filter((flag) => !generatedFlagIds.has(String(flag.id)));
    }
  }
  if (stage === 'actions' && Object.prototype.hasOwnProperty.call(changes, 'actions')) {
    const generated = Array.isArray(changes.actions) ? changes.actions : [];
    const current = Array.isArray(fresh.actions) ? fresh.actions : [];
    // Both lists go through the same normalisation a save applies, so a
    // save's own tidying never reads as a reviewer edit.
    const asSaved = (actions) => meetingAgentActionsFingerprint(
      normaliseAgentResult({ actions }, fresh.sourceUnits || [], '', { enforceEvidence: false }).actions
    );
    const previousFingerprint = fresh.qualityState?.actions?.generatedFingerprint || '';
    const keptOccurrences = new Set(fresh.keptActionOccurrenceIds || []);
    const isExplicitlyKept = row => Boolean(row?.occurrenceId && keptOccurrences.has(row.occurrenceId));
    const reviewerEdited = current.length > 0 && (current.some(isReviewerAuthored) || current.some(isExplicitlyKept)
      || (Boolean(previousFingerprint) && asSaved(current) !== previousFingerprint));
    const qualityState = changes.qualityState || { ...(fresh.qualityState || {}) };
    // What was generated last time, so a later regeneration can tell the
    // reviewer's own edits, additions and deletions apart.
    const generatedTexts = generated.map((action) => meetingMinutesAgentText(action?.action, 1600)).filter(Boolean);
    changes.qualityState = {
      ...qualityState,
      actions: { ...(qualityState.actions || {}), generatedFingerprint: asSaved(generated), generatedTexts,
        generatedSignatures: generated.map(meetingAgentEditableActionSignature), fingerprintVersion: 2 }
    };
    if (reviewerEdited) {
      keptReviewerActions = true;
      const previousTexts = Array.isArray(fresh.qualityState?.actions?.generatedTexts) ? fresh.qualityState.actions.generatedTexts : null;
      const previousSignatures = Array.isArray(fresh.qualityState?.actions?.generatedSignatures)
        ? fresh.qualityState.actions.generatedSignatures : null;
      const reviewerTouched = (row) => isReviewerAuthored(row) || isExplicitlyKept(row)
        || (previousSignatures ? !previousSignatures.includes(meetingAgentEditableActionSignature(row))
          : previousTexts && !previousTexts.includes(meetingMinutesAgentText(row?.action, 1600)));
      const deletedByReviewer = previousTexts
        ? previousTexts.filter((textValue) => !current.some((row) => meetingMinutesAgentText(row?.action, 1600) === textValue))
        : [];
      // Never propose undoing the reviewer's work: re-adding what they deleted,
      // changing a row they wrote or edited, or removing a row they added.
      const respectsReviewer = (change) => {
        if (change.type === 'add') return !deletedByReviewer.some((textValue) => hybridActionsEquivalent(textValue, change.after?.action || ''));
        if (change.type === 'modify' || change.type === 'remove') return !reviewerTouched(change.before);
        return true;
      };
      const diff = buildProposal('actions', current, generated);
      const generatedProposal = changes.pendingProposal && Array.isArray(changes.pendingProposal.changes) ? changes.pendingProposal : null;
      const extraAdds = (generatedProposal?.changes || []).filter((change) => change?.type === 'add' && change.after)
        .map((change) => ({ ...change, beforeIndex: current.length, index: current.length, afterIndex: null }));
      const combined = [...diff.changes.filter(meetingAgentProposalChangeIsVisible), ...extraAdds].filter(respectsReviewer);
      changes.pendingProposal = combined.length
        ? preselectActionProposal({ ...diff, changes: combined, source: 'regeneration' }, current, fresh.sourceUnits || [])
        : null;
      delete changes.actions;
      const semantic = changes.qualityState?.actions?.semanticReconciliation;
      if (semantic) changes.qualityState.actions = { ...changes.qualityState.actions,
        semanticReconciliation: { ...semantic, applied: false, publishedApplied: false, deferredToProposal: true } };
      // The generated action register was not applied, so it cannot justify
      // removing a corresponding row from the reviewer's Discussion.
      delete changes.discussion;
      const separation = changes.qualityState?.discussion?.claimConsolidation;
      if (separation?.method === discussionActionSeparation.VERSION && separation.applied) {
        changes.qualityState = { ...changes.qualityState, discussion: { ...(fresh.qualityState?.discussion || {}) },
          actions: { ...changes.qualityState.actions, discussionActionSeparationCount: 0, sourceClarificationCorrectionCount: 0,
            deferredDiscussionActionSeparation: { ...separation, applied: false, deferredToProposal: true } } };
      }
      // Flags raised on rows that were not applied would point at nothing.
      const generatedFlagIds = meetingAgentReferencedFlagIds(generated);
      incomingFlags = incomingFlags.filter((flag) => !generatedFlagIds.has(String(flag.id)));
    }
  }
  if (stage === 'discussion' && Array.isArray(changes.unassignedSupportingDetails)) {
    changes.unassignedSupportingDetails = withoutRepresentedUnassignedDetails(
      optionalReview.active(mergeUnassignedSupportingDetails(fresh.unassignedSupportingDetails, changes.unassignedSupportingDetails), fresh),
      changes.discussion || fresh.discussion || []
    );
  }
  const field = stage === 'actions' ? 'actions' : stage === 'discussion' ? 'discussion' : '';
  let priorFlags = Array.isArray(fresh.reviewFlags) ? fresh.reviewFlags : [];
  if (field && Object.prototype.hasOwnProperty.call(changes, field)) {
    const oldIds = meetingAgentReferencedFlagIds([...(fresh[field] || []),
      ...(stage === 'discussion' ? normalizeUnassignedSupportingDetails(fresh.unassignedSupportingDetails) : [])]);
    const newIds = meetingAgentReferencedFlagIds([...(changes[field] || []),
      ...(stage === 'discussion' ? normalizeUnassignedSupportingDetails(changes.unassignedSupportingDetails ?? fresh.unassignedSupportingDetails) : [])]);
    priorFlags = priorFlags.filter((flag) => !(oldIds.has(String(flag.id)) && !newIds.has(String(flag.id)) && meetingAgentFlagUntouched(flag)));
  }
  if (stage === 'actions' && Object.prototype.hasOwnProperty.call(changes, 'pendingProposal')) {
    const liveProposalFlagIds = new Set(((changes.pendingProposal && changes.pendingProposal.changes) || []).map(meetingAgentProposalReviewFlagId));
    priorFlags = priorFlags.filter((flag) => !(String(flag.id || '').startsWith('proposal-review-')
      && !liveProposalFlagIds.has(String(flag.id)) && meetingAgentFlagUntouched(flag)));
  }
  const merged = mergeMeetingAgentGenerationFlags(priorFlags, incomingFlags, result.replaceCoverageFlags, { stage, changes, draft: fresh });
  const effectiveProposal = Object.prototype.hasOwnProperty.call(changes, 'pendingProposal')
    ? changes.pendingProposal : fresh.pendingProposal;
  const referencedFlagIds = meetingAgentReferencedFlagIds([
    changes.actions ?? fresh.actions, changes.discussion ?? fresh.discussion,
    ...(effectiveProposal?.changes || []).flatMap(change => [change.before, change.after]),
    changes.unassignedSupportingDetails ?? fresh.unassignedSupportingDetails,
    changes.meetingObjectives ?? fresh.meetingObjectives
  ]);
  const seen = new Set();
  const reviewFlags = merged.filter((flag) => {
    // Same display wording is not the same warning. Dropping a referenced ID
    // strands its record and loses its source/check context. Exact unlinked
    // automatic duplicates may still collapse; reviewed flags stay untouched.
    if (!meetingAgentFlagUntouched(flag) || referencedFlagIds.has(String(flag.id))) return true;
    const key = flag.systemTimingIssue ? `system-timing|${flag.id}`
      : require('../utils/meetingMinutesProofHash').hash({ ...flag, id: '' });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { changes: stage === 'actions'
    ? admitMeetingAgentGeneratedActionChanges(fresh, changes,
      `${fresh.draftId || ''}:${fresh.generation?.startedAt || ''}:actions`) : changes,
    reviewFlags, keptReviewerActions };
}

function applyStageResultVirtually(draft = {}, stage = '', result = {}) {
  const changes = result?.changes || {};
  return {
    ...draft,
    ...changes,
    reviewFlags: mergeMeetingAgentGenerationFlags(draft.reviewFlags, result.reviewFlags, result.replaceCoverageFlags, { stage, changes, draft }),
    staleStages: (Array.isArray(draft.staleStages) ? draft.staleStages : []).filter((value) => value !== stage),
    currentStep: Math.max(MEETING_AGENT_STAGE_STEP[stage] || 0, Number(draft.currentStep || 0)),
    generation: null
  };
}

function meetingAgentUntouchedSpeculationChanges(fresh = {}, stage = '', input = {}) {
  const { currentStep: _step, selectedStep: _selected, ...changes } = input;
  // Speculative publication is still generated admission. It needs the same
  // occurrence allocation and exact proof rebinding as a foreground run.
  return stage === 'actions' ? admitMeetingAgentGeneratedActionChanges(fresh, changes,
    `${fresh.draftId || ''}:${changes.qualityState?.actions?.completedAt || ''}:speculation`) : changes;
}

function meetingAgentPreviewSavedActions(preview = [], saved = [], sourceUnits = []) {
  const cloneAction = (record = {}) => ({
    ...record,
    owners: [...(record.owners || [])],
    timing: record.timing ? { ...record.timing } : record.timing,
    evidenceIds: [...(record.evidenceIds || [])],
    reviewFlagIds: [...(record.reviewFlagIds || [])]
  });
  const previewActions = dedupeHybridActionRecords(
    (Array.isArray(preview) ? preview : []).map(cloneAction), { sourceUnits }
  );
  const dedupedSaved = dedupeHybridActionRecords(
    (Array.isArray(saved) ? saved : []).map(cloneAction), { sourceUnits }
  );
  const savedActions = dedupedSaved.filter((record) =>
    dedupeHybridActionRecords([
      ...previewActions.map(cloneAction), cloneAction(record)
    ], { sourceUnits }).length > previewActions.length);
  return { previewActions, savedActions };
}

function meetingAgentCompletedStagePerformance(draft = {}) {
  const stages = ['discussion', 'actions', 'summary'].map((stage) => ({
    stage, ...(draft.qualityState?.[stage] || {})
  })).filter((item) => item.completedAt);
  return stages.sort((left, right) => new Date(right.completedAt) - new Date(left.completedAt))[0] || null;
}

module.exports = {
  mergeMeetingAgentGenerationFlags,
  meetingAgentActionsFingerprint,
  admitMeetingAgentGeneratedActionChanges,
  meetingAgentRegenerationChanges,
  applyStageResultVirtually,
  meetingAgentUntouchedSpeculationChanges,
  meetingAgentPreviewSavedActions,
  meetingAgentCompletedStagePerformance
};
