'use strict';

// A repeated ID is ambiguous even when its two replies happen to agree.
// Keep one explicit disposition for every requested item; never let Map's
// last-write-wins behaviour turn an incomplete reply into a successful check.
function indexReviewResults(items = [], results = [], allowedVerdicts = []) {
  const expected = new Map(items.map(item => [String(item.id), item]));
  const grouped = new Map();
  const unknown = [];
  const rows = Array.isArray(results) ? results : [];
  rows.forEach((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.id !== 'string' || !expected.has(row.id)) {
      unknown.push({ index, id: typeof row?.id === 'string' ? row.id.slice(0, 80) : '', reason: 'unknown_or_malformed_result' });
      return;
    }
    grouped.set(row.id, [...(grouped.get(row.id) || []), row]);
  });
  const byId = new Map(), states = new Map();
  for (const item of items) {
    const supplied = grouped.get(String(item.id)) || [];
    if (!supplied.length) states.set(item.id, { id: item.id, status: 'missing', reason: 'missing_result' });
    else if (supplied.length !== 1) states.set(item.id, { id: item.id, status: 'duplicate', reason: 'duplicate_result_id' });
    else if (typeof supplied[0].verdict !== 'string' || !allowedVerdicts.includes(supplied[0].verdict)) {
      states.set(item.id, { id: item.id, status: 'malformed', reason: 'invalid_verdict' });
    } else {
      byId.set(item.id, supplied[0]);
      states.set(item.id, { id: item.id, status: 'pending', reason: '' });
    }
  }
  return { byId, states, unknown, received: rows.length, malformedPacket: !Array.isArray(results) };
}

function finishReviewAccounting(indexed) {
  const items = [...indexed.states.values()];
  const counts = {};
  for (const item of items) counts[item.status] = (counts[item.status] || 0) + 1;
  return {
    expected: items.length, received: indexed.received,
    complete: !indexed.malformedPacket && indexed.unknown.length === 0
      && items.every(item => ['supported', 'corrected'].includes(item.status)),
    counts, items, unknown: indexed.unknown, malformedPacket: indexed.malformedPacket
  };
}

function meetingAgentReviewPacketError(items = [], result, verdicts = []) {
  const indexed = indexReviewResults(items, result?.results, verdicts);
  const invalid = [...indexed.states.values()].filter(item => item.status !== 'pending');
  if (!indexed.malformedPacket && !indexed.unknown.length && !invalid.length) return null;
  const error = new Error('The timing review did not return one valid result for each supplied item.');
  error.code = 'invalid_meeting_timing_review_accounting';
  error.statusCode = 502;
  error.retryable = true;
  error.invalidCandidateIds = invalid.map(item => item.id);
  return error;
}

module.exports = { indexReviewResults, finishReviewAccounting, meetingAgentReviewPacketError };
