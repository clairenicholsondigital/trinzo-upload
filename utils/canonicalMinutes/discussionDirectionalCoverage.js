'use strict';

// Nomination is deliberately directional. Only independent source/coverage
// verification in discussionClaimConsolidation can authorise a removal.
const C = require('./discussionClaimConsolidationState');
const safety = require('./discussionMergeSafety');
const { numberWordsToValue } = require('./textNormalisation');
const { temporalMeaningRetained } = require('../meetingMinutesTemporalReview');
const VERSION = 'discussion-directional-coverage-v1';
const copy = value => JSON.parse(JSON.stringify(value));
const unique = values => [...new Set(values)];
const question = text => /[?"“”«»]|\b(?:asks?|asked|asking|queries|queried|unresolved|undecided)\b/i.test(text);
const words = text => new Set((text.toLowerCase().match(/[a-z]{4,}/g) || [])
  .filter(word => !['this', 'that', 'with', 'from', 'there', 'were', 'have', 'been', 'will', 'would'].includes(word))
  .map(word => word.length > 4 ? word.replace(/s$/, '') : word));
const figures = text => unique([...(text.match(/\d+(?:[.,]\d+)?/g) || []),
  ...(text.toLowerCase().match(/\b[a-z]+\b/g) || []).map(numberWordsToValue)
    .filter(value => value !== null).map(String)]);
function recognised(record, counts, sources, depth = 0) {
  const { originalTopic, ...shape } = record || {};
  if (depth > 4 || !safety.mergeableRecord(shape) || counts.get(record.id) !== 1
    || record.text.length > 1600 || record.simulationSource !== undefined || record.simulationParentId !== undefined
    || originalTopic !== undefined && (typeof originalTopic !== 'string' || !originalTopic.trim()
      || originalTopic.length > 220 || /[\u0000-\u001f\u007f]/.test(originalTopic))
    || record.evidenceIds.some(id => !sources.has(id))) return false;
  return (record.supportingDetails || []).every(child => recognised(child, counts, sources, depth + 1));
}
function prepare(discussion, sourceUnits, options = {}) {
  const counts = safety.identityCounts(discussion), sources = new Map(), duplicates = new Set(), seen = new Set();
  for (const [index, source] of (sourceUnits || []).entries()) {
    if (seen.has(source.id)) duplicates.add(source.id);
    seen.add(source.id);
    if (typeof source.text === 'string' && source.text.trim()) sources.set(source.id, { source, index });
  }
  for (const id of duplicates) sources.delete(id);
  const candidates = [];
  (discussion || []).forEach((topic, ti) => {
    if (safety.protectedTopic(topic)) return;
    const points = topic.points || [];
    points.forEach((survivor, si) => points.forEach((leaf, li) => {
      if (si === li || !recognised(survivor, counts, sources) || !recognised(leaf, counts, sources)
        || survivor.reviewFlagIds?.length || leaf.reviewFlagIds?.length || leaf.supportingDetails?.length
        || question(survivor.text) || question(leaf.text) || leaf.text.length > 300
        || leaf.text.length > survivor.text.length * 0.65
        || !safety.rewriteRetainsProtected([leaf.text], [survivor.text])
        || !temporalMeaningRetained(leaf.text, survivor.text)
        || figures(leaf.text).some(value => !figures(survivor.text).includes(value))) return;
      const a = words(leaf.text), b = words(survivor.text);
      const overlap = a.size ? [...a].filter(word => b.has(word)).length / a.size : 0;
      if (a.size < 3 || overlap < 0.3) return;
      // Metadata must be reconcilable without truncation, even before a call.
      if (!safety.reconcileMetadata([survivor, leaf], survivor, { completeArchive: true })) return;
      const anchors = unique([...survivor.evidenceIds, ...leaf.evidenceIds]);
      const indices = anchors.map(id => sources.get(id).index), low = Math.min(...indices), high = Math.max(...indices);
      // Supply the entire bounded exchange, not just two disjoint citation sets.
      // Context is NOT promoted to published evidence by the mutator.
      if (high - low > 17) return;
      const supplied = sourceUnits.slice(Math.max(0, low - 3), high + 4);
      if (supplied.length > 24 || supplied.some(source => !sources.has(source.id)
        || source.text.length > 12000) || JSON.stringify(supplied).length > 48000) return;
      const rows = [[survivor, si], [leaf, li]].map(([record, ri]) => ({ path: [ti, 'points', ri], kind: 'points',
        record: copy(record), clauses: [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(record.text)]
          .map(part => part.segment.trim()).filter(Boolean) }));
      candidates.push({ id: 'directional-' + C.hash(rows).slice(0, 24), rows, allowedSurvivors: [survivor.id],
        sourceUnits: copy(supplied), priority: overlap });
    }));
  });
  candidates.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  const packet = { version: C.VERSION, inputHash: C.hash(discussion), sourceHash: C.hash(sourceUnits),
    candidates: candidates.slice(0, Math.min(1, Math.max(0, options.maxCandidates ?? 1))) };
  return { ...packet, packetHash: C.hash(packet) };
}
function responseShape(response, stage) {
  const only = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => keys.includes(key));
  return only(response, ['version', 'packetHash', 'results']) && Array.isArray(response.results)
    && response.results.every(row => stage === 'proposal'
      ? only(row, ['id', 'relation', 'survivorId'])
      : only(row, ['id', 'survivorId', 'checks']) && Array.isArray(row.checks)
        && row.checks.every(check => only(check, ['recordId', 'clauseIndex', 'supported', 'retained', 'sourceIds'])));
}
function combine(previous, next, sourceUnits) {
  if (!next.audit.applied) return { ...previous, audit: { ...previous.audit,
    directionalAssessment: { method: VERSION, candidates: next.audit.candidates,
      reason: next.audit.reason, packetHash: next.audit.packetHash } } };
  if (!previous.audit.applied) return next;
  if (!C.canRestore(previous.discussion, sourceUnits, previous.audit)
    || !C.canRestore(next.discussion, sourceUnits, next.audit)
    || next.audit.inputHash !== C.hash(previous.discussion)) return previous;
  return { discussion: next.discussion, audit: { ...next.audit,
    original: copy(previous.audit.original), originalHash: previous.audit.originalHash,
    priorAudit: copy(previous.audit), ledger: [...copy(previous.audit.ledger), ...copy(next.audit.ledger)],
    affectedTopics: unique([...previous.audit.affectedTopics, ...next.audit.affectedTopics].map(t => t.index))
      .map(index => ({ index, finalHash: C.hash(next.discussion[index]) })) } };
}
module.exports = { VERSION, prepare, responseShape, combine };
