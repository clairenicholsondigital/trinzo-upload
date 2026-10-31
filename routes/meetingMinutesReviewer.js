'use strict';

const { requireAuth } = require('./auth');
const { loadOwnedMeetingAgentDraft, sendMeetingAgentFailure } = require('../utils/meetingMinutesDraftHttp');
const parallelMinutes = require('../utils/meetingMinutesParallel');
const { meetingAgentReviewHistoryEntry, assertMeetingAgentDateInput, reopenFlagsOfReAddedItems, meetingAgentDerivedStaleStages, meetingAgentReviewSnapshot, meetingAgentRestoreReviewSnapshot } = require('../utils/meetingMinutesReviewerState');
const { saveMeetingAgentDraft } = require('../utils/meetingMinutesDraftPersistence');
const { publicMeetingAgentDraft, reconcileMeetingAgentOrphanFlags } = require('../utils/meetingMinutesDraftView');
const { sanitiseDetails: sanitiseMeetingAgentDetails, meetingAgentTimingAnchor } = require('../utils/meetingMinutesDraftContext');
const { TIMING_POLICY_VERSION } = require('../utils/meetingMinutesTiming');
const { meetingAgentSummaryTextHash } = require('../utils/meetingMinutesSummaryPublication');
const { markMeetingAgentReviewerEdits } = require('../utils/meetingMinutesReviewerEdits');
const { normaliseAgentResult } = require('../utils/meetingMinutesResultNormalization');
const { originalEnquiryActions, sameEnquiryActionSnapshot } = require('../utils/meetingMinutesEnquiryRecovery');
const discussionClaims = require('../utils/canonicalMinutes/discussionClaimConsolidation');
const discussionActionSeparation = require('../utils/canonicalMinutes/discussionActionSeparation');
const timingRecovery = require('../utils/meetingMinutesTimingRecoveryState');
const actionUnion = require('../utils/meetingMinutesActionUnionRewrite');
const actionPhase = require('../utils/meetingMinutesActionPhaseCorrection');
const { reconcileDiscussionClauseSources } = require('../utils/meetingMinutesDiscussionSources');
const { resolveEvidence } = require('../utils/meetingMinutesEvidenceResolution');
const { rebaseMeetingAgentProposal, automaticMeetingAgentProposalReview, resolveMeetingAgentProposalFlags } = require('../utils/meetingMinutesProposalReview');
const { PAYLOAD_VERSION: MEETING_AGENT_PAYLOAD_VERSION } = require('../utils/meetingMinutesDraftStorage');
const { MEETING_AGENT_MAX_STEP } = require('../utils/meetingMinutesStageProtocol');
const optionalReview = require('../utils/meetingMinutesOptionalReview');
const { withoutRepresentedUnassignedDetails, normalizeUnassignedSupportingDetails } = require('../utils/meetingMinutesSupportingDetails');
const { mergeMeetingAgentFlags } = require('../utils/meetingMinutesReviewFlags');
const { meetingMinutesAgentText } = require('../utils/meetingMinutesPlainText');
const { includedSections } = require('../utils/includedSections');
const { normaliseKeptActionIds, normaliseKeptActionOccurrenceIds, normaliseRemovedActions } = require('../utils/actionReviewState');
const { normaliseSourceUnits } = require('../utils/meetingMinutesSource');
const { preparedTranscriptFromUnits } = require('../utils/meetingMinutesEvidenceContext');
const { salientDetailInventory } = require('../utils/meetingMinutesAssessmentEvidence');
const { finaliseMeetingAgentTimingProposal } = require('../utils/meetingMinutesProposalTiming');
const { applyProposal } = require('../utils/meetingMinutesProposals');
const crypto = require('crypto');
const { actionProvenanceSignature, preserveActionIdentity } = require('../utils/meetingMinutesActionIdentity');
const { rebindReconciliationReceipt } = require('../utils/canonicalMinutes/actionSemanticReconciliation');

function registerMeetingMinutesReviewerParallelProposals(router) {
router.post('/meeting-minutes-agent/drafts/:draftId/parallel-proposals/:proposalId', requireAuth, async (req,res) => {
  try {
    const draft = await loadOwnedMeetingAgentDraft(req);
    if (!parallelMinutes.isParallel(draft)) return res.status(404).json({ok:false,error:'Suggestion not found.'});
    if (Number(req.body?.revision)!==draft.revision) return res.status(409).json({ok:false,error:'Reload the saved draft before deciding.'});
    const proposal = (draft.parallelActionProposals || []).find(a=>a.id===req.params.proposalId);
    if (!proposal || proposal.status!=='open') return res.status(409).json({ok:false,error:'This suggestion has already been reviewed.'});
    if (!['accept','dismiss'].includes(req.body?.decision)) return res.status(400).json({ok:false,error:'Choose Add action or Dismiss.'});
    const accepted = req.body.decision==='accept';
    const id = 'reviewed-'+proposal.id;
    const action = {...proposal,id,reviewerAuthored:true};
    delete action.reason; delete action.status;
    const changes = {
      parallelActionProposals:draft.parallelActionProposals.map(a=>a.id===proposal.id?{...a,status:accepted?'accepted':'dismissed'}:a),
      actions:accepted?[...(draft.actions || []),action]:draft.actions,
      changeHistory:[...(draft.changeHistory || []),meetingAgentReviewHistoryEntry(draft,accepted?'Add suggested action':'Dismiss suggested action')].slice(-30),
      redoHistory:[]
    };
    // Acceptance records a reviewer choice; it does not claim source certainty.
    if (accepted) changes.reviewFlags = [...(draft.reviewFlags || []),{
      id:'review-'+id,kind:'possible_missed_follow_up',status:'open',stage:'actions',
      message:'This suggested action was added by a reviewer. '+proposal.reason,evidenceIds:proposal.evidenceIds,note:''
    }];
    const saved = await saveMeetingAgentDraft(draft,req,changes);
    return res.json({ok:true,draft:publicMeetingAgentDraft(saved)});
  } catch (error) { return sendMeetingAgentFailure(res,error); }
});
}

function registerMeetingMinutesReviewerSave(router, scheduleStageSpeculation) {
router.patch('/meeting-minutes-agent/drafts/:draftId', requireAuth, async (req, res) => {
  try {
    const draft = await loadOwnedMeetingAgentDraft(req);
    if (Number(req.body?.revision) !== draft.revision) {
      const error = new Error('This draft was updated elsewhere. Reload it before saving again.');
      error.statusCode = 409;
      error.currentDraft = draft;
      throw error;
    }
    assertMeetingAgentDateInput(req.body?.details || {}, req.body?.actions || [], draft);
    if (parallelMinutes.isParallel(draft)) {
      const changes = parallelMinutes.reviewChanges(draft, req.body || {}, {
        sanitiseDetails: sanitiseMeetingAgentDetails, historyEntry: meetingAgentReviewHistoryEntry
      });
      const saved = await saveMeetingAgentDraft(draft, req, changes);
      return res.json({ok:true,draft:publicMeetingAgentDraft(saved)});
    }
    const details = sanitiseMeetingAgentDetails(req.body?.details || draft.details);
    const dateChanged = details.meetingDate !== sanitiseMeetingAgentDetails(draft.details).meetingDate;
    const dateConfirmedByReviewer = (req.body?.reviewFlags || []).some(flag =>
      flag?.id === 'meeting-date-source-check' && flag.status === 'confirmed'
      && (draft.reviewFlags || []).some(old => old.id === flag.id && old.status === 'open'));
    let qualityState = dateChanged || dateConfirmedByReviewer ? { ...(draft.qualityState || {}), preparation: {
      ...(draft.qualityState?.preparation || {}), dateContext: {
        meetingDate: details.meetingDate, source: 'reviewer', timingPolicyVersion: TIMING_POLICY_VERSION
      }
    } } : draft.qualityState;
    const publishedBeforeSave = publicMeetingAgentDraft(draft);
    if (typeof req.body?.executiveSummary === 'string'
      && meetingAgentSummaryTextHash(req.body.executiveSummary) !== meetingAgentSummaryTextHash(publishedBeforeSave.executiveSummary)) {
      qualityState = { ...(qualityState || {}), summary: { ...(qualityState?.summary || {}),
        reviewerSummaryHash: meetingAgentSummaryTextHash(req.body.executiveSummary)
      } };
    }
    // A save carries the reviewer's edits: flag what the evidence does not
    // support, but never strip it back out from under them.
    const reviewerContent = markMeetingAgentReviewerEdits(publishedBeforeSave, {
      ...(Array.isArray(req.body?.discussion) ? { discussion: req.body.discussion } : {}),
      ...(Array.isArray(req.body?.actions) ? { actions: req.body.actions } : {}),
      ...(Array.isArray(req.body?.meetingObjectives) ? { meetingObjectives: req.body.meetingObjectives } : {})
    });
    const normalised = normaliseAgentResult({
      discussion: reviewerContent.discussion ?? draft.discussion,
      actions: reviewerContent.actions ?? draft.actions,
      reviewFlags: req.body?.reviewFlags ?? draft.reviewFlags
    }, draft.sourceUnits, '', { enforceEvidence: false, dedupeActions: false, mergeTopics: false, preserveReviewerEdits: true,
      meetingDate: meetingAgentTimingAnchor({ ...draft, details, qualityState }) });
    // An unchanged save is not a fresh source judgement. Keep the sealed
    // register and its proof intact; actual action/date edits take the usual
    // normalisation path and invalidate whole-register recovery.
    if (!dateChanged && originalEnquiryActions(draft)
      && (!Array.isArray(req.body?.actions)
        || sameEnquiryActionSnapshot(req.body.actions, publishedBeforeSave.actions))) {
      normalised.actions = structuredClone(draft.actions);
    }
    // This proof is owned server state. Keep independently verified paired
    // action witnesses on an unchanged save instead of repicking citations.
    const pairedProof = draft.qualityState?.discussion?.claimConsolidation;
    if (!dateChanged && !dateConfirmedByReviewer
      && discussionClaims.canRestore(draft.discussion, draft.sourceUnits, pairedProof)) {
      normalised.actions = discussionActionSeparation.preserveUnchangedPairedActions(normalised.actions,
        draft.actions, req.body?.actions, publishedBeforeSave.actions, pairedProof);
    }
    // Reuse only server-owned nominal proofs on an unchanged action/date save.
    if (!dateChanged && !dateConfirmedByReviewer) normalised.actions = timingRecovery.preserveUnchangedActions(
      normalised.actions, draft.actions || [], req.body?.actions, draft.qualityState?.actions?.timingRecovery?.proofs,
      draft.sourceUnits, meetingAgentTimingAnchor(draft));
    if (!dateChanged && !dateConfirmedByReviewer) normalised.actions = actionUnion.preserveUnchanged(
      normalised.actions, draft.actions || [], req.body?.actions, draft.qualityState?.actions?.actionUnionRewrite,
      draft.sourceUnits, meetingAgentTimingAnchor(draft));
    if (!dateChanged && !dateConfirmedByReviewer) normalised.actions = actionPhase.preserveUnchanged(
      normalised.actions,draft.actions||[],req.body?.actions,draft.qualityState?.actions?.actionPhaseCorrection,
      draft.sourceUnits,meetingAgentTimingAnchor(draft));
    // Save normalisation must not undo a generated multi-clause source repair.
    normalised.discussion = reconcileDiscussionClauseSources(normalised.discussion, draft.sourceUnits,
      { resolve: resolveEvidence, meetingDate: meetingAgentTimingAnchor({ ...draft, details, qualityState }) }).discussion;
    const discussionProof = draft.qualityState?.discussion?.claimConsolidation;
    const unchangedDiscussionSubmission = !Array.isArray(req.body?.discussion)
      || discussionClaims.hash(req.body.discussion) === discussionClaims.hash(publishedBeforeSave.discussion);
    const actionSubmissionChanged = Array.isArray(req.body?.actions)
      && discussionClaims.hash(req.body.actions) !== discussionClaims.hash(publishedBeforeSave.actions);
    const restoredActionCoverage = !dateChanged && unchangedDiscussionSubmission && actionSubmissionChanged
      ? discussionActionSeparation.restoreChangedActionCoverage(draft.discussion, normalised.actions, draft.sourceUnits, discussionProof)
      : { restored: false };
    if (restoredActionCoverage.restored) {
      normalised.discussion = restoredActionCoverage.discussion;
      qualityState = { ...(qualityState || {}), discussion: { ...(qualityState?.discussion || {}),
        claimConsolidation: restoredActionCoverage.audit } };
    }
    if (!restoredActionCoverage.restored && !dateChanged && !dateConfirmedByReviewer
      && discussionClaims.canRestore(draft.discussion, draft.sourceUnits, discussionProof)
      && (!Array.isArray(req.body?.discussion)
        || discussionClaims.hash(req.body.discussion) === discussionClaims.hash(publishedBeforeSave.discussion))) {
      // The proof comes only from the owned server draft, never the request.
      // An unchanged save is not another source judgement. Keep the verified
      // existing survivor/rewrite and restoration hash together, including paragraphs
      // whose complete proof needs more than the lexical picker's eight refs.
      normalised.discussion = structuredClone(draft.discussion);
    }
    const pendingProposal = draft.pendingProposal?.stage === 'actions'
      ? rebaseMeetingAgentProposal(draft.pendingProposal, draft.actions || [], normalised.actions, [], { preserveSelection: true })
      : draft.pendingProposal;
    // A tab loaded before the six-step deploy sends a currentStep that means a
    // different screen than it does now. Ignore it rather than storing the wrong
    // one; the client stamps payloadVersion to say it speaks the new numbering.
    const clientSpeaksCurrentSteps = Number(req.body?.payloadVersion || 0) >= MEETING_AGENT_PAYLOAD_VERSION;
    const requestedStep = clientSpeaksCurrentSteps
      ? Math.max(0, Math.min(MEETING_AGENT_MAX_STEP, Number(req.body?.currentStep ?? draft.currentStep) || 0))
      : Number(draft.currentStep || 0);
    const furthestStep = Math.max(Number(draft.currentStep || 0), requestedStep);
    const requestedSelectedStep = clientSpeaksCurrentSteps
      ? Math.max(0, Math.min(furthestStep,
        Number(req.body?.selectedStep ?? req.body?.currentStep ?? draft.selectedStep ?? draft.currentStep) || 0))
      : Math.max(0, Math.min(furthestStep, Number(draft.selectedStep ?? draft.currentStep) || 0));
    const excludedSupportingDetails = req.body?.excludedSupportingDetails === undefined ? optionalReview.entries(draft)
      : optionalReview.selection(publishedBeforeSave, req.body.excludedSupportingDetails);
    const optionalState = { ...draft, excludedSupportingDetails };
    const unassignedSupportingDetails = optionalReview.active(withoutRepresentedUnassignedDetails(
      Array.isArray(req.body?.unassignedSupportingDetails)
        ? req.body.unassignedSupportingDetails : draft.unassignedSupportingDetails,
      normalised.discussion
    ), optionalState);
    const mergedReviewFlags = reopenFlagsOfReAddedItems(
      mergeMeetingAgentFlags(req.body?.reviewFlags ?? draft.reviewFlags, normalised.reviewFlags),
      [...normalised.discussion, ...normalised.actions, ...unassignedSupportingDetails, ...excludedSupportingDetails.map(entry=>entry.record)]
    );
    const reconciledReviewFlags = reconcileMeetingAgentOrphanFlags(
      mergedReviewFlags,
      [...normalised.discussion, ...normalised.actions, ...unassignedSupportingDetails, ...excludedSupportingDetails.map(entry=>entry.record)],
      pendingProposal,
      [...(draft.discussion || []), ...(draft.actions || []), ...normalizeUnassignedSupportingDetails(draft.unassignedSupportingDetails)]
    );
    const reviewDecisionLabel = meetingMinutesAgentText(req.body?.reviewDecisionLabel, 160);
    const changeHistory = reviewDecisionLabel
      ? [...(draft.changeHistory || []), meetingAgentReviewHistoryEntry(draft, reviewDecisionLabel)].slice(-30)
      : draft.changeHistory;
    const saved = await saveMeetingAgentDraft(draft, req, {
      details,
      qualityState,
      steer: req.body?.steer ?? draft.steer,
      discussion: normalised.discussion,
      excludedSupportingDetails,
      ...(Array.isArray(req.body?.unassignedSupportingDetails) || Array.isArray(draft.unassignedSupportingDetails)
        ? { unassignedSupportingDetails } : {}),
      actions: normalised.actions,
      executiveSummary: req.body?.executiveSummary ?? draft.executiveSummary,
      meetingObjectives: reviewerContent.meetingObjectives ?? draft.meetingObjectives,
      reviewFlags: reconciledReviewFlags,
      pendingProposal,
      staleStages: [...new Set([
        ...(draft.staleStages || []),
        ...meetingAgentDerivedStaleStages(draft, {
          ...draft, discussion: normalised.discussion, actions: normalised.actions,
          steer: req.body?.steer ?? draft.steer, details, qualityState
        })
      ])],
      currentStep: furthestStep,
      selectedStep: requestedSelectedStep,
      changeHistory,
      // Kept ids are filtered against the actions being saved, so a row the
      // reviewer ticked and then removed in the same save does not linger.
      redoHistory: reviewDecisionLabel ? [] : draft.redoHistory,
      includeSections: includedSections({ includeSections: req.body?.includeSections ?? draft.includeSections }),
      keptActionIds: normaliseKeptActionIds(req.body?.keptActionIds ?? draft.keptActionIds, normalised.actions),
      keptActionOccurrenceIds: normaliseKeptActionOccurrenceIds(
        req.body?.keptActionOccurrenceIds ?? draft.keptActionOccurrenceIds,
        [...normalised.actions, ...normaliseRemovedActions(req.body?.removedActions ?? draft.removedActions)],
        [...(draft.actions || []), ...(draft.removedActions || [])]),
      removedActions: normaliseRemovedActions(req.body?.removedActions ?? draft.removedActions),
      status: req.body?.status
    });
    // Edits settle for a while before the next stage is run ahead of the
    // reviewer, so a burst of typing costs one speculative run, not many.
    scheduleStageSpeculation(saved.draftId, req.authUser?.userId);
    return res.json({ ok: true, draft: publicMeetingAgentDraft(saved) });
  } catch (error) {
    return sendMeetingAgentFailure(res, error);
  }
});
}

function registerMeetingMinutesReviewerSource(router) {
router.patch('/meeting-minutes-agent/drafts/:draftId/source/:unitId', requireAuth, async (req, res) => {
  try {
    const draft = await loadOwnedMeetingAgentDraft(req);
    if (Number(req.body?.revision) !== draft.revision) {
      const error = new Error('This draft was updated elsewhere. Reload it before changing the prepared transcript.');
      error.statusCode = 409;
      error.currentDraft = draft;
      throw error;
    }
    let found = false;
    const sourceUnits = normaliseSourceUnits(draft.sourceUnits).map((unit) => {
      if (unit.id !== req.params.unitId) return unit;
      found = true;
      return { ...unit, restored: req.body?.restored === true };
    });
    if (!found) return res.status(404).json({ ok: false, error: 'Transcript passage not found.' });
    const staleStages = [...new Set([...(draft.staleStages || []), ...(draft.discussion?.length ? ['discussion'] : []), ...(draft.actions?.length ? ['actions'] : []), ...(draft.executiveSummary ? ['summary'] : [])])];
    const saved = await saveMeetingAgentDraft(draft, req, {
      sourceUnits,
      preparedTranscript: preparedTranscriptFromUnits(sourceUnits),
      salientDetails: salientDetailInventory(sourceUnits),
      candidateLedger: [],
      passProvenance: [],
      passCache: [],
      qualityState: {},
      staleStages
    });
    return res.json({ ok: true, draft: publicMeetingAgentDraft(saved) });
  } catch (error) {
    return sendMeetingAgentFailure(res, error);
  }
});
}

function registerMeetingMinutesReviewerDecisionsHistory(router) {
router.post('/meeting-minutes-agent/drafts/:draftId/proposal', requireAuth, async (req, res) => {
  try {
    const draft = await loadOwnedMeetingAgentDraft(req);
    if (Number(req.body?.revision) !== draft.revision) {
      const error = new Error('This draft was updated elsewhere. Reload it before reviewing the proposal.');
      error.statusCode = 409;
      error.currentDraft = draft;
      throw error;
    }
    let proposal = draft.pendingProposal;
    if (!proposal) return res.status(409).json({ ok: false, error: 'There is no pending AI proposal.' });
    const decision = String(req.body?.decision || '').toLowerCase();
    if (!['accept', 'reject'].includes(decision)) return res.status(400).json({ ok: false, error: 'Choose accept or reject.' });
    const timingReview = decision === 'accept' && req.body?.automatic === true
      ? finaliseMeetingAgentTimingProposal(proposal, draft) : null;
    if (timingReview) proposal = timingReview.proposal;
    const allIds = (proposal.changes || []).map((change) => change.id);
    const automaticReview = decision === 'accept' && req.body?.automatic === true
      ? automaticMeetingAgentProposalReview(proposal, mergeMeetingAgentFlags(draft.reviewFlags, timingReview?.flags || []),
        proposal.stage === 'discussion' ? draft.discussion : draft.actions, draft.sourceUnits) : null;
    const acceptedIds = decision === 'reject' ? []
      : automaticReview ? automaticReview.acceptedIds
      : req.body?.acceptAll === true ? allIds
        : (Array.isArray(req.body?.changeIds) ? req.body.changeIds : []);
    const acceptedIdSet = new Set(acceptedIds.filter((id) => allIds.includes(id)));
    if (decision === 'reject') {
      const history = [...(draft.changeHistory || []), meetingAgentReviewHistoryEntry(
        draft, `${allIds.length} suggestion${allIds.length === 1 ? '' : 's'} dismissed`
      )].slice(-30);
      const saved = await saveMeetingAgentDraft(draft, req, {
        pendingProposal: null,
        changeHistory: history,
        redoHistory: [],
        reviewFlags: resolveMeetingAgentProposalFlags(draft.reviewFlags, proposal, [], allIds)
      });
      return res.json({ ok: true, draft: publicMeetingAgentDraft(saved) });
    }
    const before = proposal.stage === 'discussion' ? draft.discussion || [] : draft.actions || [];
    // Applying suggestions is a literal review transaction. Do not run the
    // complete editable register through generation-time deduplication here:
    // it can remove an untouched action or even the addition just selected.
    const after = applyProposal(before, proposal, [...acceptedIdSet], { reservedActions: draft.removedActions || [] });
    const remainingProposal = automaticReview ? null
      : rebaseMeetingAgentProposal(proposal, before, after, [...acceptedIdSet]);
    const unacceptedChanges = automaticReview ? []
      : (proposal.changes || []).filter((change) => !acceptedIdSet.has(change.id));
    const history = [...(draft.changeHistory || []), {
      id: crypto.randomUUID(), type: 'ai_proposal', stage: proposal.stage,
      label: `${acceptedIdSet.size} suggestion${acceptedIdSet.size === 1 ? '' : 's'} applied`,
      acceptedChangeIds: [...acceptedIdSet], before, after, acceptedAt: new Date().toISOString(),
      // Undo restores the old content without queueing the consumed changes
      // for automatic application again. Redo retains the applied snapshot.
      beforeState: {
        ...meetingAgentReviewSnapshot(draft),
        pendingProposal: unacceptedChanges.length ? { ...proposal, changes: unacceptedChanges } : null
      }
    }].slice(-30);
    const contentChanges = proposal.stage === 'discussion' ? { discussion: after } : { actions: after };
    const saved = await saveMeetingAgentDraft(draft, req, {
      ...contentChanges,
      ...(timingReview ? { qualityState: { ...(draft.qualityState || {}), actions: {
        ...(draft.qualityState?.actions || {}), timingPolicyVersion: TIMING_POLICY_VERSION,
        timingAssessments: [...(draft.qualityState?.actions?.timingAssessments || []), ...timingReview.assessments]
      } } } : {}),
      staleStages: [...new Set([
        ...(draft.staleStages || []),
        ...meetingAgentDerivedStaleStages(draft, { ...draft, ...contentChanges })
      ])],
      pendingProposal: remainingProposal,
      changeHistory: history,
      redoHistory: [],
      reviewFlags: automaticReview ? automaticReview.reviewFlags
        : resolveMeetingAgentProposalFlags(draft.reviewFlags, proposal, [...acceptedIdSet], [])
    });
    return res.json({ ok: true, draft: publicMeetingAgentDraft(saved) });
  } catch (error) {
    return sendMeetingAgentFailure(res, error);
  }
});

router.post('/meeting-minutes-agent/drafts/:draftId/redo', requireAuth, async (req, res) => {
  try {
    const draft = await loadOwnedMeetingAgentDraft(req);
    if (Number(req.body?.revision) !== draft.revision) {
      const error = new Error('This draft was updated elsewhere. Reload it before redoing.');
      error.statusCode = 409;
      error.currentDraft = draft;
      throw error;
    }
    const redoHistory = [...(draft.redoHistory || [])];
    const latest = redoHistory.pop();
    if (!latest || !latest.beforeState) return res.status(409).json({ ok: false, error: 'There is nothing to redo.' });
    const restored = meetingAgentRestoreReviewSnapshot(latest.beforeState, draft);
    // Redoing is itself undoable: the state it replaces goes back on the undo
    // stack, so the reviewer can step either way rather than into a dead end.
    const changeHistory = [...(draft.changeHistory || []), {
      id: crypto.randomUUID(),
      type: latest.type || 'review_decision',
      label: latest.label,
      createdAt: new Date().toISOString(),
      beforeState: meetingAgentReviewSnapshot(draft)
    }].slice(-30);
    const saved = await saveMeetingAgentDraft(draft, req, { ...restored, changeHistory, redoHistory });
    return res.json({ ok: true, draft: publicMeetingAgentDraft(saved) });
  } catch (error) {
    return sendMeetingAgentFailure(res, error);
  }
});

router.post('/meeting-minutes-agent/drafts/:draftId/restore-combined-actions', requireAuth, async (req, res) => {
  try {
    const draft = await loadOwnedMeetingAgentDraft(req);
    let actions = originalEnquiryActions(draft);
    if (Number(req.body?.revision) !== draft.revision || draft.generation?.status === 'running' || !actions) {
      const error = new Error('These actions changed or are still generating. Your edits have been preserved.');
      error.statusCode = 409; throw error;
    }
    const actionState=draft.qualityState.actions, union=actionState.actionUnionRewrite;
    const phase=actionState.actionPhaseCorrection;
    const restoringPhase=phase?.applied && actionPhase.restore(draft.actions,phase,draft.sourceUnits,meetingAgentTimingAnchor(draft));
    const restoringCompilation=!restoringPhase && union?.version==='compilation-union-v1'&&union.applied;
    const audit=actionState.semanticReconciliation;
    if(restoringCompilation || restoringPhase) {
      // Restore the compiled originals, retaining the admitted identity of
      // every unique unchanged row. Raw generated snapshots can predate ID
      // allocation; restoring those IDs would strand an earlier merge proof.
      actions=actions.map(action=>{
        const matches=(draft.actions||[]).filter(current=>actionProvenanceSignature(current)===actionProvenanceSignature(action));
        return matches.length===1?preserveActionIdentity(matches[0],action):action;
      });
    }
    // Restoring the compilation snapshot can restore an earlier identity on
    // an otherwise unchanged contact survivor. Rebind its existing proof;
    // never strand the preceding independently recoverable reconciliation.
    const restoredContactReceipts = (restoringCompilation || restoringPhase) && audit?.applied
      ? (audit.receipts||[]).map(receipt=>{
        const matches=actions.map(action=>rebindReconciliationReceipt(receipt,receipt.survivor,action,normaliseSourceUnits(draft.sourceUnits))).filter(Boolean);
        return matches.length===1?matches[0]:null;
      }) : [];
    if(restoredContactReceipts.some(receipt=>!receipt)) {
      const error=new Error('The earlier action proof cannot be safely rebound. Your current actions were preserved.');error.statusCode=409;throw error;
    }
    const qualityState = { ...draft.qualityState, actions: { ...actionState,
      ...(restoringPhase ? {actionPhaseCorrection:{...phase,applied:false,restored:true},
        ...(union?.applied ? {actionUnionRewrite:{...union,finalHash:actionUnion.hash(actions)}} : {}),
        ...(audit?.applied?{semanticReconciliation:{...audit,receipts:restoredContactReceipts,restoreSnapshot:structuredClone(actions)}}:{})}
        : restoringCompilation ? {actionUnionRewrite:{...union,applied:false,restored:true},
        ...(audit?.applied?{semanticReconciliation:{...audit,receipts:restoredContactReceipts,restoreSnapshot:structuredClone(actions)}}:{})}
        : {semanticReconciliation:{...audit,applied:false,restored:true}})
    } };
    const saved = await saveMeetingAgentDraft(draft, req, { actions, qualityState,
      changeHistory: [...(draft.changeHistory || []), meetingAgentReviewHistoryEntry(draft, restoringPhase ? 'Restore original action wording' : 'Restore separate actions')].slice(-30),
      redoHistory: [], staleStages: [...new Set([...(draft.staleStages || []),
        ...meetingAgentDerivedStaleStages(draft, { ...draft, actions })])] });
    return res.json({ ok: true, draft: publicMeetingAgentDraft(saved) });
  } catch (error) { return sendMeetingAgentFailure(res, error); }
});

router.post('/meeting-minutes-agent/drafts/:draftId/restore-combined-discussion', requireAuth, async (req, res) => {
  try {
    const draft = await loadOwnedMeetingAgentDraft(req);
    if (Number(req.body?.revision) !== draft.revision || draft.generation?.status === 'running') {
      const error = new Error('This draft changed or is still generating. Reload it before restoring paragraphs.');
      error.statusCode = 409;
      throw error;
    }
    const audit = draft.qualityState?.discussion?.claimConsolidation;
    const discussion = discussionClaims.restore(draft.discussion, draft.sourceUnits, audit);
    if (!discussion) {
      const error = new Error('These paragraphs have changed since they were combined. Your edits have been preserved.');
      error.statusCode = 409;
      throw error;
    }
    const qualityState = { ...draft.qualityState, discussion: { ...draft.qualityState.discussion,
      claimConsolidation: { ...audit, applied: false, restored: true } } };
    const actions = req.body?.restorePairedActions === true
      ? discussionActionSeparation.restorePairedActions(draft.actions, audit) : draft.actions;
    const saved = await saveMeetingAgentDraft(draft, req, { discussion, actions, qualityState,
      changeHistory: [...(draft.changeHistory || []), meetingAgentReviewHistoryEntry(draft, actions !== draft.actions ? 'Restore original discussion and action wording' : 'Restore combined paragraphs')].slice(-30),
      redoHistory: [], staleStages: [...new Set([...(draft.staleStages || []),
        ...meetingAgentDerivedStaleStages(draft, { ...draft, discussion, actions })])] });
    return res.json({ ok: true, draft: publicMeetingAgentDraft(saved) });
  } catch (error) { return sendMeetingAgentFailure(res, error); }
});

router.post('/meeting-minutes-agent/drafts/:draftId/undo', requireAuth, async (req, res) => {
  try {
    const draft = await loadOwnedMeetingAgentDraft(req);
    if (Number(req.body?.revision) !== draft.revision) {
      const error = new Error('This draft was updated elsewhere. Reload it before undoing.');
      error.statusCode = 409;
      error.currentDraft = draft;
      throw error;
    }
    const history = [...(draft.changeHistory || [])];
    const latest = history.pop();
    if (!latest) return res.status(409).json({ ok: false, error: 'There is nothing to undo.' });
    // What undo is about to replace becomes the redo entry.
    const redoHistory = [...(draft.redoHistory || []), {
      id: crypto.randomUUID(),
      type: latest.type || 'review_decision',
      label: latest.label,
      createdAt: new Date().toISOString(),
      beforeState: meetingAgentReviewSnapshot(draft)
    }].slice(-30);
    const restored = latest.beforeState && typeof latest.beforeState === 'object'
      ? meetingAgentRestoreReviewSnapshot(latest.beforeState, draft)
      : {
          ...(latest.stage === 'discussion' ? { discussion: latest.before || [] } : { actions: latest.before || [] }),
          pendingProposal: null
        };
    // Old history entries restore only one content stage. Their downstream
    // output remains in place, so it must be reviewed against the restored text.
    // Full snapshots already include the matching content and stale markers.
    if (!latest.beforeState || typeof latest.beforeState !== 'object') {
      restored.staleStages = [...new Set([
        ...(draft.staleStages || []),
        ...meetingAgentDerivedStaleStages(draft, { ...draft, ...restored })
      ])];
    }
    // Older proposal history snapshots still carry the accepted changes.
    // Filter those too, while keeping any suggestions the reviewer left open.
    if (latest.type === 'ai_proposal' && restored.pendingProposal) {
      const consumed = new Set(latest.acceptedChangeIds || []);
      const changes = (restored.pendingProposal.changes || []).filter((change) => !consumed.has(change.id));
      restored.pendingProposal = changes.length ? { ...restored.pendingProposal, changes } : null;
    }
    const saved = await saveMeetingAgentDraft(draft, req, { ...restored, changeHistory: history, redoHistory });
    return res.json({ ok: true, draft: publicMeetingAgentDraft(saved) });
  } catch (error) {
    return sendMeetingAgentFailure(res, error);
  }
});
}

module.exports = { registerMeetingMinutesReviewerParallelProposals, registerMeetingMinutesReviewerSave, registerMeetingMinutesReviewerSource, registerMeetingMinutesReviewerDecisionsHistory };
