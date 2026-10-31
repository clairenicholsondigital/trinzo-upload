'use strict';

const parallelMinutes = require('./meetingMinutesParallel');
const { normaliseKeptActionOccurrenceIds } = require('./actionReviewState');
const { updateMeetingMinutesAgentDraft } = require('./db');
const { sanitiseDetails: sanitiseMeetingAgentDetails } = require('./meetingMinutesDraftContext');
const { meetingAgentDraftPayload } = require('./meetingMinutesReviewerState');
const { normalisePresentationCurrency } = require('./canonicalMinutes/textNormalisation');

async function saveMeetingAgentDraft(draft, req, changes = {}) {
  const persistedChanges = parallelMinutes.isParallel(draft) ? changes : normaliseMeetingAgentDraftChanges(changes);
  const merged = { ...draft, ...persistedChanges };
  // A transaction that removes one ambiguous occurrence must not turn its old
  // shared checked token into approval of the surviving sibling.
  if (Object.prototype.hasOwnProperty.call(persistedChanges, 'actions')
    || Object.prototype.hasOwnProperty.call(persistedChanges, 'removedActions')) {
    merged.keptActionOccurrenceIds = normaliseKeptActionOccurrenceIds(merged.keptActionOccurrenceIds,
      [...(merged.actions || []), ...(merged.removedActions || [])],
      [...(draft.actions || []), ...(draft.removedActions || [])]);
  }
  return updateMeetingMinutesAgentDraft(draft.draftId, req.authUser?.userId, draft.revision, {
    title: sanitiseMeetingAgentDetails(merged.details).meetingTitle || draft.title,
    status: persistedChanges.status || draft.status,
    payload: meetingAgentDraftPayload(merged)
  });
}

function normaliseMeetingAgentDraftChanges(changes = {}) {
  const visibleFields = [
    'discussion', 'actions', 'executiveSummary', 'meetingObjectives',
    'pendingProposal', 'reviewFlags'
  ];
  const normalised = { ...changes };
  for (const field of visibleFields) {
    if (Object.prototype.hasOwnProperty.call(normalised, field)) {
      normalised[field] = normalisePresentationCurrency(normalised[field]);
    }
  }
  return normalised;
}

module.exports = {
  saveMeetingAgentDraft,
  normaliseMeetingAgentDraftChanges
};
