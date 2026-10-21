'use strict';

const { isReviewerAuthored } = require('./canonicalMinutes/state');

// Compare with the published version the editor received, not raw model text:
// presentation-only number/date formatting must not turn an autosave into a
// human edit. Only fields a reviewer can change confer authorship.
function markRows(previous, incoming, fields, children) {
  const available = [...(Array.isArray(previous) ? previous : [])];
  return (Array.isArray(incoming) ? incoming : []).map((row) => {
    if (!row || typeof row !== 'object') return row;
    const signature = (value) => JSON.stringify(fields.map((field) => value?.[field] ?? null));
    let at = available.findIndex((old) => old?.id === row.id && signature(old) === signature(row));
    if (at < 0 && row.id) at = available.findIndex((old) => old?.id === row.id);
    const old = at < 0 ? null : available.splice(at, 1)[0];
    const edited = !old || signature(old) !== signature(row);
    const next = { ...row };
    if (edited || isReviewerAuthored(old) || isReviewerAuthored(row)) next.reviewerAuthored = true;
    if (children) children(next, old);
    return next;
  });
}

function markMeetingAgentReviewerEdits(previous = {}, incoming = {}) {
  const next = { ...incoming };
  if (Array.isArray(incoming.discussion)) {
    next.discussion = markRows(previous.discussion, incoming.discussion, ['topic', 'hideHeading'], (topic, old) => {
      for (const kind of ['points', 'decisions', 'openQuestions']) {
        topic[kind] = markRows(old?.[kind], topic[kind], ['text'], (record, prior) => {
          record.supportingDetails = markRows(prior?.supportingDetails, record.supportingDetails, ['text']);
        });
      }
    });
  }
  if (Array.isArray(incoming.actions)) {
    next.actions = markRows(previous.actions, incoming.actions, ['action', 'owners', 'timing']);
  }
  if (Array.isArray(incoming.meetingObjectives)) {
    const asRecords = rows => (rows || []).map((row, index) => typeof row === 'string'
      ? { id: `objective-${index + 1}`, text: row, evidenceIds: [] } : row);
    next.meetingObjectives = markRows(asRecords(previous.meetingObjectives), asRecords(incoming.meetingObjectives), ['text']);
  }
  return next;
}

module.exports = { markMeetingAgentReviewerEdits };
