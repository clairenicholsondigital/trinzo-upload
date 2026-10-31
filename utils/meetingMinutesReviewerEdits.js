'use strict';

const { isReviewerAuthored } = require('./canonicalMinutes/state');
const { validOccurrenceId, actionProvenanceSignature } = require('./meetingMinutesActionIdentity');

// Compare with the published version the editor received, not raw model text:
// presentation-only number/date formatting must not turn an autosave into a
// human edit. Only fields a reviewer can change confer authorship.
function markRows(previous, incoming, fields, children) {
  const available = [...(Array.isArray(previous) ? previous : [])];
  return (Array.isArray(incoming) ? incoming : []).map((row) => {
    if (!row || typeof row !== 'object') return row;
    const signature = (value) => JSON.stringify(fields.map((field) => value?.[field] ?? null));
    const isAction = fields.includes('action');
    const occurrenceId = isAction && validOccurrenceId(row.occurrenceId);
    let at = -1;
    if (occurrenceId) {
      const matches = available.map((old, index) => validOccurrenceId(old?.occurrenceId) === occurrenceId ? index : -1)
        .filter(index => index >= 0);
      if (matches.length === 1) at = matches[0];
    }
    // A new UI occurrence may be attached on the first explicit save of an
    // older draft. Match its unchanged content/provenance; never inherit a
    // different already-identified sibling's reviewer state.
    const eligible = (old) => old?.id === row.id
      && (!isAction || !occurrenceId || !validOccurrenceId(old?.occurrenceId));
    if (at < 0) {
      const matches = available.map((old, index) => eligible(old) && signature(old) === signature(row) ? index : -1)
        .filter(index => index >= 0);
      if (matches.length === 1 || !isAction) at = matches[0] ?? -1;
      else if (matches.length > 1) {
        const exact = matches.filter(index => actionProvenanceSignature(available[index]) === actionProvenanceSignature(row));
        if (exact.length === 1) at = exact[0];
      }
    }
    if (at < 0 && row.id) {
      const matches = available.map((old, index) => eligible(old) ? index : -1).filter(index => index >= 0);
      if (!isAction || matches.length === 1) at = matches[0] ?? -1;
    }
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

function reviewerProvenance(value, options = {}) {
  // Only a reviewer-save boundary may carry authorship into persisted rows.
  // Generated JSON cannot grant itself an exemption from publication checks.
  if (options.preserveReviewerEdits !== true) return {};
  return {
    ...(value?.reviewerAuthored === true ? { reviewerAuthored: true } : {}),
    ...(value?.confirmedTopic === true ? { confirmedTopic: true } : {})
  };
}

// Merge history describes deleted predecessor records; it is not evidence or
// reviewer authorship. Only the editor-save boundary carries this metadata,
// without requiring its historical IDs to exist in the current register.
// Historical topic writers allowed 220-character IDs: reject longer values
// rather than truncating them into a different record's identity.
function reviewerFilingProvenance(value, options = {}) {
  return options.preserveReviewerEdits === true
    ? require('./meetingMinutesFilingProvenance').filingProvenance(value) : {};
}

function reviewerMergeHistory(value, field, survivorId, options = {}) {
  if (options.preserveReviewerEdits !== true || !Array.isArray(value?.[field])) return {};
  const ids = [...new Set(value[field].slice(0, 1000)
    .filter(id => typeof id === 'string' && id.length <= 220)
    .map(id => id.trim())
    .filter(id => id && id !== survivorId && !/[\u0000-\u001f\u007f]/.test(id)))];
  return ids.length ? { [field]: ids } : {};
}

module.exports = {
  markMeetingAgentReviewerEdits,
  reviewerFilingProvenance,
  reviewerMergeHistory,
  reviewerProvenance
};
