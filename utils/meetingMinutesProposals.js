'use strict';

const { text } = require('./meetingMinutesText');
const { stableId, tokenOverlap } = require('./meetingMinutesRecordMatching');
const { validOccurrenceId, actionProvenanceSignature, findActionOccurrenceIndex, preserveActionIdentity, assignGeneratedActionIdentities } = require('./meetingMinutesActionIdentity');

// Anchors on rows that are unchanged, so an insertion is ONE change rather than
// a modify of every row after it. Positional diffing made partial acceptance
// unsound: accepting a lone "add" duplicated a row, accepting a lone "modify"
// deleted one. Lists here are capped at 250 rows, so the DP table is cheap.
function unchangedRowPairs(before, after) {
  const a = before.map((row) => JSON.stringify(row));
  const b = after.map((row) => JSON.stringify(row));
  const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { pairs.push([i, j]); i += 1; j += 1; }
    else if (table[i + 1][j] >= table[i][j + 1]) i += 1;
    else j += 1;
  }
  return pairs;
}

function proposalRowText(row) {
  if (!row) return '';
  if (typeof row === 'string') return row;
  const parts = [row.action, row.topic, row.text].filter((value) => typeof value === 'string' && value);
  return parts.length ? parts.join(' ') : JSON.stringify(row);
}

// Inside a run of changed rows, decide which old row became which new row.
// Identity first (a stable id survives an edit), then content similarity.
// Pairing by position instead is what made a rewritten row read as "delete this
// one, add an unrelated one" and corrupted partial acceptance.
function pairGapRows(oldRows, newRows, removed, added) {
  const pairs = new Map();
  const takenNew = new Set();
  const rowId = (row) => (row && typeof row.id === 'string' ? row.id : '');
  for (const oldIndex of removed) {
    const id = rowId(oldRows[oldIndex]);
    if (!id) continue;
    const match = added.find((newIndex) => !takenNew.has(newIndex) && rowId(newRows[newIndex]) === id);
    if (match !== undefined) { pairs.set(oldIndex, match); takenNew.add(match); }
  }
  for (const oldIndex of removed) {
    if (pairs.has(oldIndex)) continue;
    let best = -1;
    let bestScore = 0;
    for (const newIndex of added) {
      if (takenNew.has(newIndex)) continue;
      const score = tokenOverlap(proposalRowText(oldRows[oldIndex]), proposalRowText(newRows[newIndex]));
      if (score > bestScore) { bestScore = score; best = newIndex; }
    }
    if (best >= 0 && bestScore >= 0.5) { pairs.set(oldIndex, best); takenNew.add(best); }
  }
  return pairs;
}

function proposalChange(stage, type, previous, next, beforeIndex, afterIndex) {
  return {
    id: stableId('change', `${stage}|${type}|${JSON.stringify(previous)}|${JSON.stringify(next)}`, afterIndex == null ? beforeIndex : afterIndex),
    type,
    before: previous,
    after: next,
    // Positions in the ORIGINAL list. An add carries the original index it is
    // inserted in front of, so accepting any subset lands in the right place.
    beforeIndex,
    afterIndex,
    index: afterIndex == null ? beforeIndex : afterIndex
  };
}

function buildProposal(stage, before = [], after = []) {
  const oldRows = Array.isArray(before) ? before : [];
  const newRows = Array.isArray(after) ? after : [];
  const changes = [];
  let oldCursor = 0;
  let newCursor = 0;
  const emitGap = (oldEnd, newEnd) => {
    const removed = [];
    for (let i = oldCursor; i < oldEnd; i += 1) removed.push(i);
    const added = [];
    for (let j = newCursor; j < newEnd; j += 1) added.push(j);
    if (!removed.length && !added.length) return;
    const pairs = pairGapRows(oldRows, newRows, removed, added);
    for (const oldIndex of removed) {
      if (pairs.has(oldIndex)) changes.push(proposalChange(stage, 'modify', oldRows[oldIndex], newRows[pairs.get(oldIndex)], oldIndex, pairs.get(oldIndex)));
      else changes.push(proposalChange(stage, 'remove', oldRows[oldIndex], null, oldIndex, null));
    }
    const pairedNew = new Set([...pairs.values()]);
    for (const newIndex of added) {
      if (pairedNew.has(newIndex)) continue;
      let insertAt = oldCursor;
      for (const [oldIndex, partner] of pairs) if (partner < newIndex) insertAt = Math.max(insertAt, oldIndex + 1);
      changes.push(proposalChange(stage, 'add', null, newRows[newIndex], insertAt, newIndex));
    }
  };
  for (const [oldIndex, newIndex] of unchangedRowPairs(oldRows, newRows)) {
    emitGap(oldIndex, newIndex);
    oldCursor = oldIndex + 1;
    newCursor = newIndex + 1;
  }
  emitGap(oldRows.length, newRows.length);
  return { id: stableId('proposal', `${stage}|${Date.now()}`), stage, createdAt: new Date().toISOString(), changes };
}

function applyProposal(before = [], proposal = {}, acceptedIds = [], options = {}) {
  const accepted = new Set(acceptedIds);
  const rows = Array.isArray(before) ? before : [];
  // IDs from independent model responses are ordinal labels, not globally
  // unique identities. Destructive changes require the same editable content;
  // evidence/flag updates do not make an otherwise unchanged row stale.
  const reviewShape = (row) => {
    if (!row || typeof row !== 'object') return row;
    if (row.action != null) return { action: row.action, owners: [...(row.owners || [])].sort(),
      timing: { kind: row.timing?.kind || 'not_stated', wording: row.timing?.wording || '', exactDate: row.timing?.exactDate || '' } };
    return { ...(row.topic != null ? { topic: row.topic, hideHeading: row.hideHeading === true } : { text: row.text }),
      ...Object.fromEntries(['points', 'decisions', 'openQuestions', 'supportingDetails']
        .filter(kind => Array.isArray(row[kind])).map(kind => [kind, row[kind].map(reviewShape)])) };
  };
  const signature = row => JSON.stringify(reviewShape(row));
  const targetKey = row => JSON.stringify([text(row?.id, 80), signature(row)]);
  const targetIdCounts = new Map();
  const legacyActionTargetCounts = new Map();
  const legacyActionKey = row => JSON.stringify([text(row?.id, 80), actionProvenanceSignature(row)]);
  for (const change of proposal.changes || []) {
    if (change.type === 'add') continue;
    const key = targetKey(change.before);
    targetIdCounts.set(key, (targetIdCounts.get(key) || 0) + 1);
    if (change.before?.action != null && !validOccurrenceId(change.before.occurrenceId)) {
      const legacyKey = legacyActionKey(change.before);
      const positions = legacyActionTargetCounts.get(legacyKey) || new Set();
      // Several suggestions can address the same original row. Count captured
      // occurrences, not alternative edits/removals of that one occurrence.
      positions.add(Number.isInteger(change.beforeIndex) ? change.beforeIndex
        : Number.isInteger(change.index) ? change.index : `unknown:${change.id}`);
      legacyActionTargetCounts.set(legacyKey, positions);
    }
  }
  const originalIndex = (change) => (Number.isInteger(change.beforeIndex) ? change.beforeIndex : Number(change.index) || 0);
  const currentIndex = (change) => {
    const beforeRecord = change?.before;
    if (!beforeRecord || typeof beforeRecord !== 'object') return -1;
    if (beforeRecord.action != null) {
      if (!validOccurrenceId(beforeRecord.occurrenceId)) {
        const key = legacyActionKey(beforeRecord);
        const captured = legacyActionTargetCounts.get(key)?.size || 0;
        const remaining = rows.filter(row => row?.action != null && legacyActionKey(row) === key).length;
        if (captured > 1 && remaining < captured && !rows.some(row => row === beforeRecord)) return -1;
      }
      return findActionOccurrenceIndex(rows, beforeRecord);
    }
    const id = text(beforeRecord.id, 80);
    if (id) {
      const candidates = rows.map((row, index) => text(row?.id, 80) === id
        && signature(row) === signature(beforeRecord) ? index : -1).filter((index) => index >= 0);
      if (targetIdCounts.get(targetKey(beforeRecord)) > 1 || candidates.length > 1) {
        // Generated lists have historically contained duplicate IDs. When a
        // proposal addressed two such rows and autosave has already removed
        // one, the surviving ID is not proof that the other target remains.
        // Only its original occurrence is safe to edit or remove.
        const expected = originalIndex(change);
        return candidates.includes(expected) ? expected : -1;
      }
      return candidates.length === 1 ? candidates[0] : -1;
    }
    const matches = rows.map((row, index) => signature(row) === signature(beforeRecord) ? index : -1).filter(index => index >= 0);
    return matches.length === 1 ? matches[0] : -1;
  };
  const modified = new Map();
  const removed = new Set();
  const inserted = new Map();
  const claimedTargets = new Set();
  for (const change of proposal.changes || []) {
    if (!accepted.has(change.id)) continue;
    if (change.type === 'add') {
      const afterId = text(change.after?.id, 80);
      let addition = change.after;
      if (proposal.stage === 'actions' && addition?.action != null) {
        const generationKey = `${proposal.id || ''}|${change.id || ''}`;
        const claimedOccurrence = validOccurrenceId(addition.occurrenceId);
        if (claimedOccurrence && rows.some(row => validOccurrenceId(row.occurrenceId) === claimedOccurrence
          && actionProvenanceSignature(row) !== actionProvenanceSignature(addition))) {
          addition = { ...addition };
          delete addition.occurrenceId;
        }
        const expected = assignGeneratedActionIdentities([addition], { generationKey }).actions[0];
        const occurrenceId = validOccurrenceId(addition.occurrenceId) || expected.occurrenceId;
        if (rows.some(row => validOccurrenceId(row.occurrenceId) === occurrenceId
          && actionProvenanceSignature(row) === actionProvenanceSignature(addition))) continue;
        if (!validOccurrenceId(addition.occurrenceId) && rows.some(row => text(row.id, 80) === afterId
          && actionProvenanceSignature(row) === actionProvenanceSignature(addition))) continue;
        addition = assignGeneratedActionIdentities([{ ...addition, occurrenceId }], { generationKey,
          reservedActions: [...rows, ...[...inserted.values()].flat(), ...(options.reservedActions || [])] }).actions[0];
      } else if (rows.some((row) => (!afterId || text(row?.id, 80) === afterId)
        && signature(row) === signature(addition))) continue;
      const at = Math.max(0, Math.min(rows.length, originalIndex(change)));
      inserted.set(at, [...(inserted.get(at) || []), addition]);
      if (typeof options.onAppliedChange === 'function') options.onAppliedChange(change);
      continue;
    }
    // Never use an old numeric position for a destructive change. Autosave,
    // regeneration or a prior accepted suggestion may have reordered or
    // removed the original row; applying that stale index deleted unrelated
    // actions in the finished minutes.
    const at = currentIndex(change);
    if (at < 0 || claimedTargets.has(at)) continue;
    claimedTargets.add(at);
    if (change.type === 'remove') {
      removed.add(at);
      if (typeof options.onAppliedChange === 'function') options.onAppliedChange(change);
    } else if (change.type === 'modify') {
      modified.set(at, rows[at]?.action != null
        ? preserveActionIdentity(rows[at], change.after) : change.after);
      if (typeof options.onAppliedChange === 'function') options.onAppliedChange(change);
    }
  }
  // Rebuild from the original rows rather than splicing, so each accepted change
  // is independent of which other changes were accepted.
  const result = [];
  for (let i = 0; i <= rows.length; i += 1) {
    for (const row of inserted.get(i) || []) result.push(row);
    if (i === rows.length) break;
    if (removed.has(i)) continue;
    result.push(modified.has(i) ? modified.get(i) : rows[i]);
  }
  return result;
}

module.exports = { buildProposal, applyProposal };
