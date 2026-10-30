'use strict';

const { meetingMinutesAgentText } = require('./meetingMinutesPlainText');
const { normalizeUnassignedSupportingDetails } = require('./meetingMinutesSupportingDetails');
const { normaliseMeetingAgentPassCache } = require('./meetingMinutesPassCache');
const { meetingAgentDiscussionFingerprint } = require('./meetingMinutesDiscussionFingerprint');
const { normaliseSourceUnits } = require('./meetingMinutesSource');
const discussionActionSeparation = require('./canonicalMinutes/discussionActionRecovery');
const discussionClaims = require('./canonicalMinutes/discussionClaimConsolidationState');

function meetingAgentStageContentFields(stage) {
  if (stage === 'discussion') return ['discussion', 'meetingObjectives', 'unassignedSupportingDetails'];
  // The Actions pass may remove a generated Discussion point only when the
  // finished accepted action register strictly duplicates it. Persistence
  // applies that optional cleanup only if Discussion was not edited while the
  // pass was running.
  if (stage === 'actions') return ['actions', 'pendingProposal', 'discussion'];
  if (stage === 'summary') return ['executiveSummary', 'meetingObjectives'];
  return [];
}

function meetingAgentStageFieldWasGeneratedElsewhere(sourceDraft = {}, freshDraft = {}, stage = '', field = '') {
  if (stage !== 'summary' || field !== 'meetingObjectives') return false;
  return JSON.stringify(sourceDraft?.qualityState?.discussion ?? null)
    !== JSON.stringify(freshDraft?.qualityState?.discussion ?? null);
}

function meetingAgentStageFieldValue(draft, field) {
  return field === 'unassignedSupportingDetails'
    ? normalizeUnassignedSupportingDetails(draft?.[field]) : draft?.[field] ?? null;
}

function meetingAgentStageContentConflicts(sourceDraft = {}, freshDraft = {}, stage = '') {
  const protectedFields = stage === 'discussion' ? ['discussion', 'unassignedSupportingDetails']
    : stage === 'actions' ? ['actions', 'pendingProposal']
      : stage === 'summary' ? ['executiveSummary', 'meetingObjectives'] : [];
  return protectedFields.filter((field) =>
    JSON.stringify(meetingAgentStageFieldValue(sourceDraft, field)) !== JSON.stringify(meetingAgentStageFieldValue(freshDraft, field))
      && !meetingAgentStageFieldWasGeneratedElsewhere(sourceDraft, freshDraft, stage, field));
}

function meetingAgentStageOwnsCandidate(stage, candidate = {}) {
  const recordType = meetingMinutesAgentText(candidate?.recordType, 80);
  return stage === 'actions'
    ? recordType === 'action'
    : stage === 'discussion' && ['discussion_point', 'decision', 'open_question', 'objective'].includes(recordType);
}

function meetingAgentStageScopedArray(fresh = [], incoming = [], stage, owns) {
  return [
    ...(Array.isArray(fresh) ? fresh : []).filter((item) => !owns(stage, item)),
    ...(Array.isArray(incoming) ? incoming : []).filter((item) => owns(stage, item))
  ];
}

function meetingAgentStagePersistenceChanges(sourceDraft = {}, freshDraft = {}, stage = '', resultChanges = {}) {
  const conflictFields = meetingAgentStageContentConflicts(sourceDraft, freshDraft, stage);
  if (conflictFields.length) return { conflictFields, changes: {} };
  const changes = {};
  for (const field of meetingAgentStageContentFields(stage)) {
    const changedSinceStart = JSON.stringify(meetingAgentStageFieldValue(sourceDraft, field))
      !== JSON.stringify(meetingAgentStageFieldValue(freshDraft, field));
    const generatedElsewhere = meetingAgentStageFieldWasGeneratedElsewhere(
      sourceDraft, freshDraft, stage, field
    );
    if ((!changedSinceStart || generatedElsewhere) && Object.prototype.hasOwnProperty.call(resultChanges, field)) {
      changes[field] = resultChanges[field];
    }
  }
  if (Object.prototype.hasOwnProperty.call(resultChanges, 'candidateLedger')) {
    changes.candidateLedger = meetingAgentStageScopedArray(
      freshDraft.candidateLedger, resultChanges.candidateLedger, stage, meetingAgentStageOwnsCandidate
    );
  }
  if (Object.prototype.hasOwnProperty.call(resultChanges, 'passProvenance')) {
    changes.passProvenance = meetingAgentStageScopedArray(
      freshDraft.passProvenance, resultChanges.passProvenance, stage,
      (ownedStage, item) => item?.stage === ownedStage
    ).slice(-40);
  }
  if (Object.prototype.hasOwnProperty.call(resultChanges, 'passCache')) {
    changes.passCache = normaliseMeetingAgentPassCache(meetingAgentStageScopedArray(
      freshDraft.passCache, resultChanges.passCache, stage,
      (ownedStage, item) => item?.stage === ownedStage
    ));
  }
  if (resultChanges.qualityState && Object.prototype.hasOwnProperty.call(resultChanges.qualityState, stage)) {
    changes.qualityState = {
      ...(freshDraft.qualityState && typeof freshDraft.qualityState === 'object' ? freshDraft.qualityState : {}),
      [stage]: resultChanges.qualityState[stage]
    };
  }
  if (stage === 'actions') {
    const proposed = resultChanges.qualityState?.discussion?.claimConsolidation;
    const current = resultChanges.qualityState?.actions;
    if (proposed?.method === discussionActionSeparation.VERSION && proposed.applied
      && current?.discussionActionSeparationCount > 0) {
      const publishable = Array.isArray(changes.discussion)
        && sourceDraft.details?.meetingDate === freshDraft.details?.meetingDate
        && discussionClaims.canRestore(changes.discussion, normaliseSourceUnits(freshDraft.sourceUnits), proposed);
      if (publishable) {
        changes.qualityState = { ...(changes.qualityState || {}), discussion: { ...(freshDraft.qualityState?.discussion || {}),
          claimConsolidation: proposed, generatedFingerprint: meetingAgentDiscussionFingerprint(changes.discussion) } };
      } else {
        if (Array.isArray(changes.actions)) changes.actions = discussionActionSeparation.restorePairedActions(changes.actions, proposed);
        delete changes.discussion;
        changes.qualityState = { ...(changes.qualityState || {}), actions: { ...(changes.qualityState?.actions || {}),
          discussionActionSeparationCount: 0, sourceClarificationCorrectionCount: 0,
          deferredDiscussionActionSeparation: { ...proposed, applied: false, reason: 'discussion_or_source_changed_before_publication' } } };
      }
    } else if (current?.discussionActionSeparationCoverageRestored && Array.isArray(changes.discussion)) {
      const restored = discussionActionSeparation.restoreChangedActionCoverage(sourceDraft.discussion || [],
        resultChanges.actions || [], sourceDraft.sourceUnits || [], sourceDraft.qualityState?.discussion?.claimConsolidation);
      if (restored.restored && discussionClaims.hash(restored.discussion) === discussionClaims.hash(changes.discussion)
        && discussionClaims.hash(restored.audit) === discussionClaims.hash(proposed)) {
        changes.qualityState = { ...(changes.qualityState || {}), discussion: { ...(freshDraft.qualityState?.discussion || {}),
          claimConsolidation: proposed, generatedFingerprint: meetingAgentDiscussionFingerprint(changes.discussion) } };
      }
    }
  }
  return { conflictFields: [], changes };
}

module.exports = {
  meetingAgentStageContentFields,
  meetingAgentStageFieldWasGeneratedElsewhere,
  meetingAgentStageFieldValue,
  meetingAgentStageContentConflicts,
  meetingAgentStageOwnsCandidate,
  meetingAgentStageScopedArray,
  meetingAgentStagePersistenceChanges
};
