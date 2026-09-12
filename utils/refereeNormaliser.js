'use strict';

function text(value) {
  return String(value == null ? '' : value).trim();
}

function tokens(value) {
  return new Set(text(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter((item) => item.length > 2));
}

function similarity(left, right) {
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap += 1;
  return overlap / Math.max(a.size, b.size);
}

/**
 * Preserve a disposition-only Referee result as a valid result. Core rows are
 * their own propositions; supporting rows point to the nearest evidenced core.
 */
function normaliseRefereeDispositions(dispositions = [], candidates = []) {
  const rows = Array.isArray(dispositions) ? dispositions : [];
  const candidatesById = new Map((Array.isArray(candidates) ? candidates : [])
    .map((candidate) => [text(candidate?.candidateId), candidate]).filter(([candidateId]) => candidateId));
  const cores = rows.filter((row) => text(row?.disposition).toLowerCase() === 'core');
  return rows.map((row, index) => {
    const disposition = text(row?.disposition).toLowerCase();
    const candidateId = text(row?.candidateId);
    const explicitTargetId = text(row?.targetId);
    if (disposition === 'core') return { ...row, candidateId, targetId: explicitTargetId || candidateId };
    if (disposition !== 'supporting' || !cores.length) return { ...row, candidateId };
    if (explicitTargetId) return { ...row, candidateId, targetId: explicitTargetId };
    const candidate = candidatesById.get(candidateId);
    const best = cores
      .map((core, coreIndex) => {
        const coreCandidate = candidatesById.get(text(core?.candidateId));
        return {
          core, coreIndex,
          score: similarity(candidate?.text || row?.text || row?.reason,
            coreCandidate?.text || core?.text || core?.reason)
        };
      })
      .sort((a, b) => b.score - a.score || Math.abs(index - a.coreIndex) - Math.abs(index - b.coreIndex))[0];
    return { ...row, candidateId, targetId: text(best?.core?.candidateId) };
  });
}

/** Split all candidates into fixed-size calls without imposing a global cap. */
function batchRefereeCandidates(candidates = [], batchSize = 5) {
  const source = Array.isArray(candidates) ? candidates : [];
  const size = Math.max(1, Number(batchSize) || 5);
  const batches = [];
  for (let index = 0; index < source.length; index += size) batches.push(source.slice(index, index + size));
  return batches;
}

function normaliseRefereeOutput(source = {}, candidates = []) {
  if (!source || typeof source !== 'object' || !Array.isArray(source.candidateDispositions)) return null;
  return {
    ...source,
    candidateDispositions: normaliseRefereeDispositions(source.candidateDispositions, candidates)
  };
}

function stringSet(values = []) {
  return new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === 'string' || typeof value === 'number')
    .map(text).filter(Boolean));
}

function referenceValues(value, property) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => item && typeof item === 'object' ? text(item[property]) : '').filter(Boolean);
}

function normaliseReferenceList(strings, refs, property, allowed) {
  const supplied = [
    ...(Array.isArray(strings) ? strings.filter((value) => typeof value === 'string' || typeof value === 'number').map(text) : []),
    ...referenceValues(refs, property)
  ];
  const values = [...new Set(supplied.filter(Boolean))];
  const filtered = allowed.size ? values.filter((value) => allowed.has(value)) : values;
  return { values: filtered, allInvalid: Boolean(allowed.size && values.length && filtered.length === 0) };
}

/** Convert typed AI Builder reference objects to the established string arrays. */
function normaliseReferenceArrays(source = {}, { validEvidenceIds = [], validOwners = [] } = {}) {
  const evidenceAllowList = stringSet(validEvidenceIds);
  const ownerAllowList = stringSet(validOwners);
  const invalidEvidencePaths = [];
  function visit(value, path = '') {
    if (Array.isArray(value)) return value.map((item, index) => visit(item, `${path}[${index}]`));
    if (!value || typeof value !== 'object') return value;
    const output = {};
    for (const [key, item] of Object.entries(value)) output[key] = visit(item, path ? `${path}.${key}` : key);
    if (Object.prototype.hasOwnProperty.call(value, 'evidenceIds') || Object.prototype.hasOwnProperty.call(value, 'evidenceRefs')) {
      const result = normaliseReferenceList(value.evidenceIds, value.evidenceRefs, 'id', evidenceAllowList);
      output.evidenceIds = result.values;
      delete output.evidenceRefs;
      if (result.allInvalid) invalidEvidencePaths.push(path || 'evidenceIds');
    }
    if (Object.prototype.hasOwnProperty.call(value, 'owners') || Object.prototype.hasOwnProperty.call(value, 'ownerRefs')) {
      const result = normaliseReferenceList(value.owners, value.ownerRefs, 'name', ownerAllowList);
      output.owners = result.values;
      delete output.ownerRefs;
    }
    if (Object.prototype.hasOwnProperty.call(value, 'reviewFlagIds') || Object.prototype.hasOwnProperty.call(value, 'reviewFlagRefs')) {
      const result = normaliseReferenceList(value.reviewFlagIds, value.reviewFlagRefs, 'id', stringSet());
      output.reviewFlagIds = result.values;
      delete output.reviewFlagRefs;
    }
    return output;
  }
  const normalised = visit(source);
  if (normalised && typeof normalised === 'object' && invalidEvidencePaths.length) {
    const flags = Array.isArray(normalised.reviewFlags) ? normalised.reviewFlags.slice() : [];
    flags.push({ type: 'invalid_evidence_references', severity: 'warning', message: 'All supplied evidence references for at least one record were invalid and were removed.', fieldPaths: [...new Set(invalidEvidencePaths)] });
    normalised.reviewFlags = flags;
  }
  return normalised;
}

module.exports = { batchRefereeCandidates, normaliseRefereeDispositions, normaliseRefereeOutput, normaliseReferenceArrays };
