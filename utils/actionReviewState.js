'use strict';

// The reviewer's own decisions about the action register, kept apart from the
// actions themselves.
//
// Two things are recorded. KEPT is an acknowledgement that a row has been
// looked at and is right; it carries no meaning for the minutes, only for the
// reviewer's place in the list. REMOVED holds rows the reviewer has rejected,
// so they can be shown in a collapsed section and put back with one key rather
// than being retyped.
//
// These live as their own draft fields because normaliseAgentResult rebuilds
// action objects from a fixed set of keys, so anything hung on an action is
// dropped on the next save.

const { validOccurrenceId, actionProvenanceSignature } = require('./meetingMinutesActionIdentity');

const MAX_REMOVED = 60;

function clean(value, limit = 1600) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, limit);
}

function actionId(value) {
  return clean(value, 200);
}

// Only ids of actions that are actually in the register: a kept id for a row
// that has since been removed or regenerated away is noise, and would make the
// "still to review" count wrong.
function normaliseKeptActionIds(value, actions = []) {
  const present = new Set((Array.isArray(actions) ? actions : []).map((action) => actionId(action?.id)).filter(Boolean));
  const seen = new Set();
  const kept = [];
  for (const raw of Array.isArray(value) ? value : []) {
    const id = actionId(raw);
    if (!id || seen.has(id) || !present.has(id)) continue;
    seen.add(id);
    kept.push(id);
  }
  return kept;
}

// Exact checks belong to one occurrence, never every row sharing a model ID.
// Keep legacy IDs separately for compatibility; ambiguous ones are history,
// not proof that either occurrence was checked.
function normaliseKeptActionOccurrenceIds(value, actions = [], previousActions = []) {
  const previousCounts = new Map();
  for (const row of Array.isArray(previousActions) ? previousActions : []) {
    const id = validOccurrenceId(row?.occurrenceId);
    if (id) previousCounts.set(id, (previousCounts.get(id) || 0) + 1);
  }
  const counts = new Map();
  for (const row of Array.isArray(actions) ? actions : []) {
    const id = validOccurrenceId(row?.occurrenceId);
    if (id) counts.set(id, (counts.get(id) || 0) + 1);
  }
  return [...new Set((Array.isArray(value) ? value : []).map(validOccurrenceId)
    .filter(id => id && counts.get(id) === 1 && (previousCounts.get(id) || 0) < 2))];
}

// A removed row keeps what is needed to show it and put it back.
function normaliseRemovedAction(value = {}) {
  const action = clean(value?.action);
  if (!action) return null;
  const timing = value?.timing && typeof value.timing === 'object' ? value.timing : {};
  return {
    id: actionId(value?.id),
    ...(validOccurrenceId(value?.occurrenceId) ? { occurrenceId: validOccurrenceId(value.occurrenceId) } : {}),
    action,
    owners: (Array.isArray(value?.owners) ? value.owners : []).map((owner) => clean(owner, 180)).filter(Boolean).slice(0, 8),
    timing: {
      ...timing,
      kind: ['deadline', 'target', 'dependency', 'not_stated'].includes(clean(timing.kind, 40)) ? clean(timing.kind, 40) : 'not_stated',
      wording: clean(timing.wording, 220),
      exactDate: /^\d{4}-\d{2}-\d{2}$/.test(clean(timing.exactDate, 20)) ? clean(timing.exactDate, 20) : ''
    },
    evidenceIds: (Array.isArray(value?.evidenceIds) ? value.evidenceIds : []).map((id) => clean(id, 40)).filter(Boolean).slice(0, 24),
    ...(Array.isArray(value?.reviewFlagIds) ? { reviewFlagIds: value.reviewFlagIds.map(id => clean(id, 80)).filter(Boolean) } : {}),
    ...(value?.reviewerAuthored === true ? { reviewerAuthored: true } : {}),
    ...(value?.timingDecision && typeof value.timingDecision === 'object'
      ? { timingDecision: JSON.parse(JSON.stringify(value.timingDecision)) } : {}),
    removedAt: /^\d{4}-\d{2}-\d{2}T/.test(clean(value?.removedAt, 40)) ? clean(value.removedAt, 40) : new Date().toISOString()
  };
}

function normaliseRemovedActions(value) {
  const rows = [];
  const seen = new Set();
  for (const raw of Array.isArray(value) ? value : []) {
    const row = normaliseRemovedAction(raw);
    if (!row) continue;
    // The same wording removed twice is one entry; a reviewer putting a row
    // back and rejecting it again should not stack up duplicates.
    const key = JSON.stringify([row.id, row.occurrenceId || '',
      actionProvenanceSignature({ ...row, removedAt: undefined })]);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  // Newest first, so the most recent rejection is the one to undo.
  return rows.slice(-MAX_REMOVED);
}

// What the header shows. "Undecided" is the number still to look at, which is
// the only count that tells a reviewer how much work is left.
function actionReviewCounts(actions = [], keptActionIds = [], removedActions = [], pendingProposal = null, keptActionOccurrenceIds = []) {
  const rows = Array.isArray(actions) ? actions : [];
  const allRows = [...rows, ...(Array.isArray(removedActions) ? removedActions : [])];
  const idCounts = new Map();
  for (const row of allRows) {
    const id = actionId(row?.id);
    if (id) idCounts.set(id, (idCounts.get(id) || 0) + 1);
  }
  const legacy = new Set(normaliseKeptActionIds(keptActionIds, rows).filter(id => idCounts.get(id) === 1));
  const exact = new Set(normaliseKeptActionOccurrenceIds(keptActionOccurrenceIds, allRows));
  const kept = rows.filter(row => exact.has(validOccurrenceId(row?.occurrenceId)) || legacy.has(actionId(row?.id))).length;
  const proposed = (pendingProposal && Array.isArray(pendingProposal.changes) ? pendingProposal.changes : [])
    .filter((change) => change && change.type === 'add').length;
  return {
    inRegister: rows.length,
    kept,
    undecided: Math.max(0, rows.length - kept),
    removed: normaliseRemovedActions(removedActions).length,
    proposed
  };
}

module.exports = {
  MAX_REMOVED,
  normaliseKeptActionIds,
  normaliseKeptActionOccurrenceIds,
  normaliseRemovedAction,
  normaliseRemovedActions,
  actionReviewCounts
};
