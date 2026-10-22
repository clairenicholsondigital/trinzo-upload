'use strict';

const crypto = require('node:crypto');

// Separate occurrence identity lets historical ordinal IDs remain untouched.
// No reader or ordinary save allocates an identity; admission is explicit.
function validOccurrenceId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : '';
}

function actionEditableSignature(row = {}) {
  return JSON.stringify([
    String(row.action || ''), [...(row.owners || [])].map(String).sort(),
    row.timing?.kind || 'not_stated', row.timing?.wording || '', row.timing?.exactDate || ''
  ]);
}

function actionProvenanceSignature(row = {}) {
  const stable = value => {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined)
      .map(key => [key, stable(value[key])]));
  };
  const { id: _id, occurrenceId: _occurrenceId, ...content } = row;
  return JSON.stringify(stable(content));
}

function findActionOccurrenceIndex(rows = [], before = {}) {
  const occurrenceId = validOccurrenceId(before.occurrenceId);
  if (occurrenceId && rows.filter(row => validOccurrenceId(row?.occurrenceId) === occurrenceId).length !== 1) return -1;
  const candidates = (Array.isArray(rows) ? rows : []).map((row, index) => ({ row, index }))
    .filter(({ row }) => (occurrenceId ? validOccurrenceId(row.occurrenceId) === occurrenceId
      : String(row.id || '') === String(before.id || ''))
      && actionEditableSignature(row) === actionEditableSignature(before));
  if (occurrenceId) return candidates.length === 1 ? candidates[0].index : -1;
  // Pure in-process transformations can retain the actual object occurrence.
  // Serialized proposals lack this proof and must use full provenance below.
  const references = candidates.filter(({ row }) => row === before);
  if (references.length === 1) return references[0].index;
  const exact = candidates.filter(({ row }) => actionProvenanceSignature(row) === actionProvenanceSignature(before));
  return exact.length === 1 ? exact[0].index : -1;
}

function preserveActionIdentity(target = {}, replacement = {}) {
  const next = { ...replacement, id: target.id };
  const occurrenceId = validOccurrenceId(target.occurrenceId);
  if (occurrenceId) next.occurrenceId = occurrenceId;
  else delete next.occurrenceId;
  return next;
}

function assignGeneratedActionIdentities(actions = [], options = {}) {
  const rows = Array.isArray(actions) ? actions : [];
  const existing = Array.isArray(options.existingActions) ? options.existingActions : [];
  const extraReserved = Array.isArray(options.reservedActions) ? options.reservedActions : [];
  // Routes may reserve the same active objects again alongside removed rows.
  // Count each actual slot once across the two lists, retaining multiplicity
  // within either list so repeated legacy tokens remain ambiguous.
  const activeReferences = new Map();
  existing.forEach(row => activeReferences.set(row, (activeReferences.get(row) || 0) + 1));
  const reserved = [...existing, ...extraReserved.filter(row => {
    const overlap = activeReferences.get(row) || 0;
    if (!overlap) return true;
    activeReferences.set(row, overlap - 1);
    return false;
  })];
  const ambiguousOccurrences = new Set();
  for (const group of [rows, reserved]) {
    const counts = new Map();
    group.forEach(row => {
      const occurrenceId = validOccurrenceId(row?.occurrenceId);
      if (occurrenceId) counts.set(occurrenceId, (counts.get(occurrenceId) || 0) + 1);
    });
    for (const [occurrenceId, count] of counts) if (count > 1) ambiguousOccurrences.add(occurrenceId);
  }
  const reservedIds = new Set(reserved.map(row => String(row?.id || '')).filter(Boolean));
  const reservedOccurrences = new Set(reserved.map(row => validOccurrenceId(row?.occurrenceId)).filter(Boolean));
  const assignedIds = new Set();
  const assignedOccurrences = new Set();
  const claimedExisting = new Set();
  const counters = new Map();
  const assignments = [];
  const preferredIdIndex = new Map();
  rows.forEach((row, index) => {
    const id = String(row?.id || '');
    const priorIndex = preferredIdIndex.get(id);
    if (priorIndex === undefined || actionProvenanceSignature(row) < actionProvenanceSignature(rows[priorIndex])) {
      preferredIdIndex.set(id, index);
    }
  });
  const hash = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 24);
  const sameExisting = row => {
    const occurrenceId = validOccurrenceId(row?.occurrenceId);
    const candidates = existing.map((old, index) => ({ old, index })).filter(({ old, index }) =>
      !claimedExisting.has(index) && actionProvenanceSignature(old) === actionProvenanceSignature(row)
      && (occurrenceId ? validOccurrenceId(old?.occurrenceId) === occurrenceId : String(old?.id || '') === String(row?.id || '')));
    // A missing occurrence on a returned copy may still match one uniquely
    // identified existing row, but an ambiguous historic ID is never guessed.
    return candidates.length === 1 ? candidates[0] : null;
  };
  const result = rows.map((row, index) => {
    const beforeId = String(row?.id || '');
    const beforeOccurrenceId = validOccurrenceId(row?.occurrenceId);
    const prior = sameExisting(row);
    let id; let occurrenceId;
    if (prior) {
      claimedExisting.add(prior.index);
      id = prior.old.id;
      const priorOccurrenceId = validOccurrenceId(prior.old.occurrenceId);
      if (!ambiguousOccurrences.has(priorOccurrenceId)) occurrenceId = priorOccurrenceId;
    }
    // Already admitted rows are stable through repeated assembly and reorder.
    // A reserved active/removed identity still wins over an unassociated copy.
    if (!prior && /^action-app-[a-f0-9]{24}$/.test(beforeId)
      && beforeOccurrenceId && !ambiguousOccurrences.has(beforeOccurrenceId)
      && !reservedIds.has(beforeId) && !reservedOccurrences.has(beforeOccurrenceId)
      && !assignedIds.has(beforeId) && !assignedOccurrences.has(beforeOccurrenceId)) {
      id = beforeId;
      occurrenceId = beforeOccurrenceId;
    }
    // Keep an otherwise safe supplied ID when it cannot collide. For a set
    // of repeated ordinal IDs, a deterministic content order chooses its one
    // keeper without reordering the displayed rows.
    if (!prior && !id && /^[A-Za-z0-9_-]{1,80}$/.test(beforeId)
      && preferredIdIndex.get(beforeId) === index && !reservedIds.has(beforeId) && !assignedIds.has(beforeId)) id = beforeId;
    if (!occurrenceId && beforeOccurrenceId && !ambiguousOccurrences.has(beforeOccurrenceId)
      && !reservedOccurrences.has(beforeOccurrenceId)
      && !assignedOccurrences.has(beforeOccurrenceId)) occurrenceId = beforeOccurrenceId;
    const seed = JSON.stringify([String(options.generationKey || ''), beforeId, actionProvenanceSignature(row)]);
    let serial = counters.get(seed) || 0;
    const minted = () => {
      let digest;
      do {
        digest = hash(`${seed}|${serial++}`);
      } while (reservedIds.has(`action-app-${digest}`) || assignedIds.has(`action-app-${digest}`)
        || reservedOccurrences.has(`action-occurrence-${digest}`) || assignedOccurrences.has(`action-occurrence-${digest}`));
      counters.set(seed, serial);
      return digest;
    };
    if (!id) {
      const digest = minted();
      id = `action-app-${digest}`;
      occurrenceId = occurrenceId || `action-occurrence-${digest}`;
    } else if (!occurrenceId || assignedOccurrences.has(occurrenceId)) {
      occurrenceId = `action-occurrence-${minted()}`;
    }
    assignedIds.add(String(id));
    assignedOccurrences.add(occurrenceId);
    assignments.push({ index, beforeId, afterId: String(id), beforeOccurrenceId,
      afterOccurrenceId: occurrenceId, preservedExisting: Boolean(prior) });
    return id === row.id && occurrenceId === row.occurrenceId ? row : { ...row, id, occurrenceId };
  });
  return { actions: result, assignments };
}

module.exports = {
  validOccurrenceId, normaliseOccurrenceId: validOccurrenceId, actionEditableSignature, actionProvenanceSignature,
  findActionOccurrenceIndex, preserveActionIdentity, assignGeneratedActionIdentities
};
