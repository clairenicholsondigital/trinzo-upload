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

// A removed row keeps only what is needed to show it and put it back.
function normaliseRemovedAction(value = {}) {
  const action = clean(value?.action);
  if (!action) return null;
  const timing = value?.timing && typeof value.timing === 'object' ? value.timing : {};
  return {
    id: actionId(value?.id),
    action,
    owners: (Array.isArray(value?.owners) ? value.owners : []).map((owner) => clean(owner, 180)).filter(Boolean).slice(0, 8),
    timing: {
      kind: ['deadline', 'target', 'dependency', 'not_stated'].includes(clean(timing.kind, 40)) ? clean(timing.kind, 40) : 'not_stated',
      wording: clean(timing.wording, 220),
      exactDate: /^\d{4}-\d{2}-\d{2}$/.test(clean(timing.exactDate, 20)) ? clean(timing.exactDate, 20) : ''
    },
    evidenceIds: (Array.isArray(value?.evidenceIds) ? value.evidenceIds : []).map((id) => clean(id, 40)).filter(Boolean).slice(0, 24),
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
    const key = `${row.id}::${row.action.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  // Newest first, so the most recent rejection is the one to undo.
  return rows.slice(-MAX_REMOVED);
}

// What the header shows. "Undecided" is the number still to look at, which is
// the only count that tells a reviewer how much work is left.
function actionReviewCounts(actions = [], keptActionIds = [], removedActions = [], pendingProposal = null) {
  const rows = Array.isArray(actions) ? actions : [];
  const kept = new Set(normaliseKeptActionIds(keptActionIds, rows));
  const proposed = (pendingProposal && Array.isArray(pendingProposal.changes) ? pendingProposal.changes : [])
    .filter((change) => change && change.type === 'add').length;
  return {
    inRegister: rows.length,
    kept: kept.size,
    undecided: Math.max(0, rows.length - kept.size),
    removed: normaliseRemovedActions(removedActions).length,
    proposed
  };
}

module.exports = {
  MAX_REMOVED,
  normaliseKeptActionIds,
  normaliseRemovedAction,
  normaliseRemovedActions,
  actionReviewCounts
};
