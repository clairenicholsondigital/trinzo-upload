'use strict';

const parallelMinutes = require('./meetingMinutesParallel');
const { meetingAgentWithLegacyDateReview, reconcileMeetingAgentOrphanFlags, meetingAgentReferencedFlagIds, MEETING_AGENT_ITEM_REMOVED_NOTE } = require('./meetingMinutesDraftView');
const { normaliseMeetingAgentMinuteNumbers } = require('./meetingMinutesPublication');
const { filingReviewFlags } = require('./meetingMinutesFilingReview');
const { isUsefulReviewFlag: isUsefulMeetingAgentReviewFlag } = require('./meetingMinutesReviewFlags');
const { normalizeUnassignedSupportingDetails } = require('./meetingMinutesSupportingDetails');
const optionalReview = require('./meetingMinutesOptionalReview');
const { SCHEMA_VERSION: MEETING_AGENT_SCHEMA_VERSION } = require('./meetingMinutesResponseContracts');
const { PAYLOAD_VERSION: MEETING_AGENT_PAYLOAD_VERSION } = require('./meetingMinutesDraftStorage');
const { normaliseSourceUnits } = require('./meetingMinutesSource');
const { normaliseKnownTerms: normaliseMeetingAgentKnownTerms, normaliseKnownTermsDeep: normaliseMeetingAgentKnownTermsDeep, normaliseExecutiveSummary } = require('./meetingMinutesText');
const { sanitiseDetails: sanitiseMeetingAgentDetails, meetingAgentTimingAnchor } = require('./meetingMinutesDraftContext');
const { meetingAgentSteerText } = require('./meetingMinutesAgentPrompts');
const { normaliseMeetingAgentPassCache } = require('./meetingMinutesPassCache');
const { MEETING_AGENT_MAX_STEP, MEETING_AGENT_STAGE_STEP, meetingAgentStageHasContent, meetingAgentStageInputFingerprint } = require('./meetingMinutesStageProtocol');
const { includedSections } = require('./includedSections');
const { normaliseKeptActionIds, normaliseKeptActionOccurrenceIds, normaliseRemovedActions } = require('./actionReviewState');
const { meetingMinutesAgentText } = require('./meetingMinutesPlainText');
const { isReviewerAuthored } = require('./canonicalMinutes/state');
const { normaliseMeetingAgentGeneration: normaliseGeneration } = require('./meetingMinutesAgentGeneration');
const crypto = require('crypto');
const { isValidCalendarDate } = require('./meetingMinutesTiming');

function meetingAgentObjectiveRecords(value) {
  return (Array.isArray(value) ? value : []).map((item, index) => {
    const objective = meetingMinutesAgentText(typeof item === 'string' ? item : item?.text, 400);
    if (!objective) return null;
    return {
      id: meetingMinutesAgentText(item?.id, 80) || `objective-${index + 1}`,
      text: objective,
      ...(isReviewerAuthored(item) ? { reviewerAuthored: true } : {}),
      evidenceIds: (Array.isArray(item?.evidenceIds) ? item.evidenceIds : []).map((id) => meetingMinutesAgentText(id, 30)).filter(Boolean)
    };
  }).filter(Boolean).slice(0, 20);
}

function normaliseMeetingAgentGeneration(generation) {
  return normaliseGeneration(generation, MEETING_AGENT_STAGE_STEP);
}

function meetingAgentWithoutDanglingFlagRefs(records = [], flagIds = new Set()) {
  const clean = (value) => {
    if (Array.isArray(value)) return value.map(clean);
    if (!value || typeof value !== 'object') return value;
    const next = { ...value };
    if (Array.isArray(next.reviewFlagIds)) next.reviewFlagIds = [...new Set(next.reviewFlagIds)].filter((id) => flagIds.has(String(id)));
    for (const key of ['points', 'decisions', 'openQuestions', 'supportingDetails']) if (Array.isArray(next[key])) next[key] = next[key].map(clean);
    return next;
  };
  return (Array.isArray(records) ? records : []).map(clean);
}

function normaliseMeetingAgentQualityState(qualityState = {}) {
  // Source witnesses, hashes, cache packets and receipt originals are immutable
  // evidence. They must never pass through prose/glossary correction walkers.
  const source = qualityState && typeof qualityState === 'object' ? qualityState : {};
  const prose = { ...source };
  const protectedStates = new Map();
  for (const stage of ['discussion', 'actions', 'summary']) {
    if (!source[stage]) continue;
    const rest = { ...source[stage] }, protectedFields = {};
    for (const key of ['semanticReconciliation', 'claimConsolidation', 'discussionSourceCoverage', 'refereeFailureAudit', 'minimalFidelityRepair', 'timingRecovery', 'actionUnionRewrite', 'actionPhaseCorrection', 'filingAliasReconciliation', 'citedFilingAliasReconciliation', 'actionDiagnostics']) {
      if (Object.hasOwn(rest, key)) { protectedFields[key] = rest[key]; delete rest[key]; }
    }
    prose[stage] = rest;
    protectedStates.set(stage, protectedFields);
  }
  const normalised = normaliseMeetingAgentKnownTermsDeep(prose);
  for (const [stage, protectedFields] of protectedStates) {
    normalised[stage] = { ...normalised[stage], ...protectedFields };
  }
  return normalised;
}

function meetingAgentDraftPayload(draft = {}) {
  if (parallelMinutes.isParallel(draft)) return parallelMinutes.payload(draft);
  draft = meetingAgentWithLegacyDateReview(normaliseMeetingAgentMinuteNumbers(draft));
  const payloadFlags = reconcileMeetingAgentOrphanFlags(
    filingReviewFlags(draft).filter(isUsefulMeetingAgentReviewFlag),
    [...(draft.discussion || []), ...(draft.actions || []), ...normalizeUnassignedSupportingDetails(draft.unassignedSupportingDetails), ...optionalReview.entries(draft).map(entry=>entry.record)],
    draft.pendingProposal
  );
  const payloadFlagIds = new Set(payloadFlags.map((flag) => String(flag.id)));
  return {
    schemaVersion: MEETING_AGENT_SCHEMA_VERSION,
    payloadVersion: MEETING_AGENT_PAYLOAD_VERSION,
    transcriptSha256: draft.transcriptSha256 || '',
    // Kept so a later upload of the same file can be recognised as a duplicate.
    uploadSizeBytes: Math.max(0, Number(draft.uploadSizeBytes) || 0),
    denoise: draft.denoise || {},
    sourceUnits: normaliseSourceUnits(draft.sourceUnits),
    preparedTranscript: normaliseMeetingAgentKnownTerms(draft.preparedTranscript || ''),
    salientDetails: normaliseMeetingAgentKnownTermsDeep(Array.isArray(draft.salientDetails) ? draft.salientDetails : []),
    details: sanitiseMeetingAgentDetails(draft.details),
    discussion: normaliseMeetingAgentKnownTermsDeep(meetingAgentWithoutDanglingFlagRefs(draft.discussion, payloadFlagIds)),
    ...(Array.isArray(draft.unassignedSupportingDetails) ? {
      unassignedSupportingDetails: optionalReview.active(normalizeUnassignedSupportingDetails(draft.unassignedSupportingDetails), draft)
    } : {}),
    actions: normaliseMeetingAgentKnownTermsDeep(meetingAgentWithoutDanglingFlagRefs(draft.actions, payloadFlagIds)),
    reviewFlags: normaliseMeetingAgentKnownTermsDeep(payloadFlags),
    pendingProposal: normaliseMeetingAgentKnownTermsDeep(draft.pendingProposal || null),
    changeHistory: Array.isArray(draft.changeHistory) ? draft.changeHistory.slice(-30) : [],
    redoHistory: Array.isArray(draft.redoHistory) ? draft.redoHistory.slice(-30) : [],
    staleStages: Array.isArray(draft.staleStages) ? [...new Set(draft.staleStages)] : [],
    steer: meetingAgentSteerText(draft.steer),
    executiveSummary: normaliseMeetingAgentKnownTerms(normaliseExecutiveSummary(draft.executiveSummary)),
    meetingObjectives: normaliseMeetingAgentKnownTermsDeep(meetingAgentObjectiveRecords(draft.meetingObjectives)),
    candidateLedger: normaliseMeetingAgentKnownTermsDeep(Array.isArray(draft.candidateLedger) ? draft.candidateLedger.slice(0, 1200) : []),
    passProvenance: normaliseMeetingAgentKnownTermsDeep(Array.isArray(draft.passProvenance) ? draft.passProvenance.slice(-40) : []),
    passCache: normaliseMeetingAgentPassCache(draft.passCache),
    qualityState: normaliseMeetingAgentQualityState(draft.qualityState),
    generation: normaliseMeetingAgentGeneration(draft.generation),
    currentStep: Math.max(0, Math.min(MEETING_AGENT_MAX_STEP, Number(draft.currentStep || 0))),
    selectedStep: Math.max(0, Math.min(MEETING_AGENT_MAX_STEP,
      Number(draft.selectedStep == null ? draft.currentStep : draft.selectedStep) || 0)),
    // The reviewer's own decisions about the register: which rows they have
    // checked off, and which they rejected and could still put back.
    includeSections: includedSections(draft),
    keptActionIds: normaliseKeptActionIds(draft.keptActionIds, draft.actions),
    keptActionOccurrenceIds: normaliseKeptActionOccurrenceIds(draft.keptActionOccurrenceIds,
      [...(draft.actions || []), ...(draft.removedActions || [])]),
    ...(optionalReview.entries(draft).length ? { excludedSupportingDetails:optionalReview.entries(draft) } : {}),
    removedActions: normaliseMeetingAgentKnownTermsDeep(normaliseRemovedActions(draft.removedActions))
  };
}

const MEETING_AGENT_REVIEW_SNAPSHOT_FIELDS = [
  'details', 'steer', 'discussion', 'unassignedSupportingDetails', 'excludedSupportingDetails', 'actions', 'executiveSummary',
  'meetingObjectives', 'reviewFlags', 'pendingProposal', 'staleStages',
  'currentStep', 'selectedStep', 'status',
  // Undoing a change has to restore what it did to the reviewer's own state
  // too: which sections they included, what they checked off, what they
  // rejected. Without these, undo puts the text back and loses the rest.
  'includeSections', 'keptActionIds', 'keptActionOccurrenceIds', 'removedActions', 'parallelActionProposals'
];

function meetingAgentReviewSnapshot(draft = {}) {
  return { ...Object.fromEntries(MEETING_AGENT_REVIEW_SNAPSHOT_FIELDS.map((key) => [
    key, JSON.parse(JSON.stringify(draft[key] == null ? null : draft[key]))
  ])), meetingDateContext: JSON.parse(JSON.stringify(draft.qualityState?.preparation?.dateContext || null)),
    reviewerSummaryHash: draft.qualityState?.summary?.reviewerSummaryHash || '' };
}

function meetingAgentRestoreReviewSnapshot(snapshot = {}, draft = {}) {
  const restored = Object.fromEntries(MEETING_AGENT_REVIEW_SNAPSHOT_FIELDS
    .filter(key => Object.prototype.hasOwnProperty.call(snapshot, key))
    .map(key => [key, snapshot[key]]));
  if (Object.prototype.hasOwnProperty.call(snapshot, 'meetingDateContext')) {
    restored.qualityState = { ...(draft.qualityState || {}), preparation: {
      ...(draft.qualityState?.preparation || {}), dateContext: snapshot.meetingDateContext
    } };
  }
  if (Object.prototype.hasOwnProperty.call(snapshot, 'reviewerSummaryHash')) {
    restored.qualityState = { ...(restored.qualityState || draft.qualityState || {}), summary: {
      ...(draft.qualityState?.summary || {}), reviewerSummaryHash: snapshot.reviewerSummaryHash || ''
    } };
  }
  return restored;
}

function meetingAgentReviewHistoryEntry(draft = {}, label = 'Review decision') {
  return {
    id: crypto.randomUUID(),
    type: 'review_decision',
    label: meetingMinutesAgentText(label, 160) || 'Review decision',
    createdAt: new Date().toISOString(),
    beforeState: meetingAgentReviewSnapshot(draft)
  };
}

function meetingAgentDerivedStaleStages(previous = {}, next = {}) {
  const stale = ['actions', 'summary'].filter((stage) => meetingAgentStageHasContent(previous, stage)
    && meetingAgentStageInputFingerprint(previous, stage) !== meetingAgentStageInputFingerprint(next, stage));
  if (meetingAgentTimingAnchor(previous) !== meetingAgentTimingAnchor(next)
    && meetingAgentStageHasContent(previous, 'discussion') && meetingAgentDiscussionUsesDateAnchor(previous)) stale.unshift('discussion');
  return stale;
}

function meetingAgentDiscussionUsesDateAnchor(draft = {}) {
  const byId = new Map((draft.sourceUnits || []).map(unit => [unit.id, unit]));
  const relative = /\b(?:today|tomorrow|tonight|this (?:week|month|year)|next (?:week|month|year)|in \w+ (?:days?|weeks?))\b/i;
  const months = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  const weekdays = '(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)';
  const day = '\\d{1,2}(?:st|nd|rd|th)?';
  const named = `(?:${day}\\s+(?:of\\s+)?${months}|${months}\\s+${day})`;
  const calendar = new RegExp(`\\b(?:\\d{4}-\\d{2}-\\d{2}|${named}|${weekdays})\\b`, 'i');
  const absolute = new RegExp(`(?:\\b${weekdays}\\b[\\s,()]*)?\\b(?:\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}|\\d{1,2}[/-]\\d{1,2}[/-]\\d{4}|${named},?\\s+\\d{4})\\b(?:\\s*\\(\\s*${weekdays}\\s*\\))?`, 'gi');
  const sourceUsesAnchor = value => {
    // Fully stated calendar dates (including their weekday label) do not
    // depend on the meeting date. Other expressions in the same cited turn
    // still can; inspect them after removing only those complete dates.
    const remaining = String(value || '').replace(absolute, ' ');
    return relative.test(remaining) || new RegExp(`\\b(?:${weekdays}|${named})\\b`, 'i').test(remaining);
  };
  const bound = record => calendar.test(record?.text || '')
    && (record.evidenceIds || []).some(id => sourceUsesAnchor(byId.get(id)?.text || ''));
  const contains = record => bound(record) || (record?.supportingDetails || []).some(contains);
  return (draft.discussion || []).some(topic => ['points', 'decisions', 'openQuestions']
    .some(kind => (topic[kind] || []).some(contains)));
}

function meetingAgentStaleStagesAfterGeneration(fresh = {}, sourceDraft = {}, stage = '', changes = {}) {
  const current = [...new Set([
    ...(Array.isArray(fresh.staleStages) ? fresh.staleStages : []),
    ...meetingAgentDerivedStaleStages(fresh, { ...fresh, ...changes })
  ])];
  const upstreamChangedDuringRun = ['actions', 'summary'].includes(stage)
    && meetingAgentStageInputFingerprint(fresh, stage) !== meetingAgentStageInputFingerprint(sourceDraft, stage);
  if (upstreamChangedDuringRun) return [...new Set([...current, stage])];
  if (stage === 'discussion' && meetingAgentTimingAnchor(fresh) !== meetingAgentTimingAnchor(sourceDraft)
    && meetingAgentDiscussionUsesDateAnchor({ ...fresh, ...changes })) return [...new Set([...current, stage])];
  return current.filter((value) => value !== stage);
}

function assertMeetingAgentDateInput(details = {}, actions = [], previous = {}) {
  const meetingDate = String(details?.meetingDate || '').trim();
  const badAction = (Array.isArray(actions) ? actions : []).find(action => action?.timing?.exactDate
    && !isValidCalendarDate(String(action.timing.exactDate))
    && !(previous.actions || []).some(old => old.id === action.id && old.action === action.action
      && old.timing?.exactDate === action.timing.exactDate));
  if ((meetingDate && !isValidCalendarDate(meetingDate)) || badAction) {
    const error = new Error(badAction
      ? 'Enter a valid calendar date for the action timing, or clear the exact date.'
      : 'Enter a valid meeting date, or leave the meeting date empty.');
    error.statusCode = 400;
    error.code = 'invalid_meeting_agent_date';
    throw error;
  }
}

function reopenFlagsOfReAddedItems(flags = [], records = []) {
  const referenced = meetingAgentReferencedFlagIds(records);
  return (Array.isArray(flags) ? flags : []).map((flag) => (referenced.has(String(flag.id))
    && flag.status === 'dismissed' && meetingMinutesAgentText(flag.correctionNote, 500) === MEETING_AGENT_ITEM_REMOVED_NOTE
    ? { ...flag, status: 'open', correctionNote: '' } : flag));
}

module.exports = {
  meetingAgentDraftPayload,
  meetingAgentWithoutDanglingFlagRefs,
  meetingAgentObjectiveRecords,
  normaliseMeetingAgentQualityState,
  normaliseMeetingAgentGeneration,
  meetingAgentReviewSnapshot,
  MEETING_AGENT_REVIEW_SNAPSHOT_FIELDS,
  meetingAgentRestoreReviewSnapshot,
  meetingAgentReviewHistoryEntry,
  meetingAgentDerivedStaleStages,
  meetingAgentDiscussionUsesDateAnchor,
  meetingAgentStaleStagesAfterGeneration,
  assertMeetingAgentDateInput,
  reopenFlagsOfReAddedItems
};
