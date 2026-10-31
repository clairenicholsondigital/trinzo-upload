'use strict';

// Owned draft reads and the shared HTTP failure response; persistence stays in the existing database owner.

const { getMeetingMinutesAgentDraft } = require('./db');
const { meetingAgentWithLegacyDateReview, publicMeetingAgentDraft } = require('./meetingMinutesDraftView');

async function loadOwnedMeetingAgentDraft(req, options = {}) {
  const draft = await getMeetingMinutesAgentDraft(req.params.draftId || req.body?.draftId, req.authUser?.userId, { includeTranscript: options.includeTranscript === true });
  if (!draft) {
    const error = new Error('Meeting-minutes draft not found.');
    error.statusCode = 404;
    throw error;
  }
  return meetingAgentWithLegacyDateReview(draft);
}

function sendMeetingAgentFailure(res, error) {
  if (error.retryable) {
    return res.status(503).json({ ok: false, code: 'M365_AGENT_USAGE_LIMIT', retryable: true, error: 'Microsoft is temporarily busy.' });
  }
  const status = error.statusCode || 500;
  return res.status(status).json({
    ok: false,
    code: status === 409 ? 'DRAFT_REVISION_CONFLICT' : '',
    error: [400, 404, 409, 413, 422, 502, 504].includes(status) ? error.message : 'The meeting-minutes agent could not complete this request.',
    currentDraft: error.currentDraft ? publicMeetingAgentDraft(error.currentDraft) : undefined
  });
}

module.exports = {
  loadOwnedMeetingAgentDraft,
  sendMeetingAgentFailure
};
