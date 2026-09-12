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

module.exports = { batchRefereeCandidates, normaliseRefereeDispositions, normaliseRefereeOutput };
