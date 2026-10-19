'use strict';

const { cleanGeneratedMinutesText } = require('./meetingMinutesContentHygiene');
const { isReviewerAuthored } = require('./canonicalMinutes/state');

// Only call on a newly generated stage, before it is merged with saved reviewer
// work. Read/save/export paths must never rerun generation cleanup on old drafts.
function cleanGeneratedMeetingAgentResult(result, stage) {
  if (!result) return result;
  const containsReviewerDetail = (record) => isReviewerAuthored(record)
    || (record?.supportingDetails || []).some(containsReviewerDetail);
  const cleanRecord = (record, field) => {
    if (!record || containsReviewerDetail(record)) return record;
    const cleaned = cleanGeneratedMinutesText(record[field]);
    if (!cleaned.text) return null;
    return { ...record, [field]: cleaned.text };
  };
  const cleanDiscussion = (topics) => (topics || []).map((topic) => {
    if (isReviewerAuthored(topic)) return topic;
    const next = { ...topic };
    for (const kind of ['points', 'decisions', 'openQuestions']) {
      next[kind] = (topic[kind] || []).map((record) => {
        const cleaned = cleanRecord(record, 'text');
        if (!cleaned || containsReviewerDetail(record)) return cleaned;
        return { ...cleaned, supportingDetails: (record.supportingDetails || [])
          .map((detail) => cleanRecord(detail, 'text')).filter(Boolean) };
      }).filter(Boolean);
    }
    return next;
  }).filter((topic) => isReviewerAuthored(topic)
    || ['points', 'decisions', 'openQuestions'].some((kind) => topic[kind]?.length));
  const cleanFields = (fields = {}) => {
    const next = { ...fields };
    if (stage === 'discussion' && Array.isArray(fields.discussion)) next.discussion = cleanDiscussion(fields.discussion);
    if (stage === 'actions' && Array.isArray(fields.actions)) next.actions = fields.actions
      .map((record) => cleanRecord(record, 'action')).filter(Boolean);
    if (stage === 'summary') {
      if (typeof fields.executiveSummary === 'string') next.executiveSummary = cleanGeneratedMinutesText(fields.executiveSummary).text;
      if (Array.isArray(fields.meetingObjectives)) next.meetingObjectives = fields.meetingObjectives.map((record) =>
        typeof record === 'string' ? cleanGeneratedMinutesText(record).text : cleanRecord(record, 'text')).filter(Boolean);
    }
    // Suggestions are generated content too. Never modify the "before" side
    // or turn an empty rewrite into a deletion of existing reviewer content.
    if (fields.pendingProposal?.stage === stage && Array.isArray(fields.pendingProposal.changes)) {
      const changes = fields.pendingProposal.changes.flatMap((change) => {
        if (!change.after || change.type === 'remove') return [change];
        const after = stage === 'actions' ? cleanRecord(change.after, 'action')
          : stage === 'discussion' ? cleanDiscussion([change.after])[0] : change.after;
        return after ? [{ ...change, after }] : [];
      });
      next.pendingProposal = changes.length ? { ...fields.pendingProposal, changes } : null;
    }
    return next;
  };
  return { ...result, changes: cleanFields(result.changes),
    ...(result.normalised ? { normalised: cleanFields(result.normalised) } : {}) };
}

module.exports = { cleanGeneratedMeetingAgentResult };
