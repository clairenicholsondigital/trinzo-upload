'use strict';
const { isReviewerAuthored } = require('./canonicalMinutes/state');
const { protectedTopic, validIds } = require('./canonicalMinutes/discussionMergeSafety');
const clone = value => JSON.parse(JSON.stringify(value));
const sentences = value => [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(value)]
  .map(part => part.segment.trim()).filter(Boolean);

// Repair citation consistency after existing resolution, never certify prose.
// Every historical primary anchor must independently survive existing per-sentence
// resolution. Failure or overflow retains the entire original record.
function reconcileDiscussionClauseSources(discussion, sourceUnits, { resolve, meetingDate } = {}) {
  const result = clone(discussion), audit = [];
  if (typeof resolve !== 'function') return { discussion: result, audit };
  const sources = new Map(), duplicates = new Set();
  for (const source of sourceUnits || []) {
    if (sources.has(source.id)) duplicates.add(source.id);
    sources.set(source.id, source);
  }
  for (const [topicIndex, topic] of result.entries()) {
    if (protectedTopic(topic)) continue;
    for (const [rowIndex, record] of (topic.points || []).entries()) {
      if (isReviewerAuthored(record) || !validIds(record.evidenceIds, 12) || !record.evidenceIds.length
        || !validIds(record.primaryEvidenceIds, 12)) continue;
      const missing = record.primaryEvidenceIds.filter(id => !record.evidenceIds.includes(id));
      if (!missing.length) continue;
      const entry = { topicIndex, rowIndex, recordId: record.id, original: clone(record), applied: false };
      const supplied = [...new Set([...record.primaryEvidenceIds, ...record.evidenceIds])];
      if (supplied.some(id => duplicates.has(id) || typeof sources.get(id)?.text !== 'string' || !sources.get(id).text.trim())) {
        audit.push({ ...entry, reason: 'incomplete_sources' }); continue;
      }
      const clauses = sentences(record.text || '');
      if (clauses.length < 2) { audit.push({ ...entry, reason: 'not_multisentence' }); continue; }
      let checks;
      try { checks = clauses.map(text => ({ text, result: resolve(text, sourceUnits, supplied, { meetingDate }) })); }
      catch { audit.push({ ...entry, reason: 'resolution_failed' }); continue; }
      if (checks.some(check => !validIds(check.result?.evidenceIds, 12) || !check.result.evidenceIds.length
        || !(check.result.supportScore >= 0.2) || check.result.weakIds?.length
        || check.result.evidenceIds.some(id => duplicates.has(id) || typeof sources.get(id)?.text !== 'string' || !sources.get(id).text.trim()))) {
        audit.push({ ...entry, reason: 'incomplete_clause_resolution' }); continue;
      }
      const resolved = new Set(checks.flatMap(check => check.result.evidenceIds));
      if (record.primaryEvidenceIds.some(id => !resolved.has(id))) {
        audit.push({ ...entry, reason: 'primary_anchor_not_revalidated' }); continue;
      }
      // Global resolution may nominate another workstream. This repair only
      // reconciles anchors already present in this record's provenance.
      const evidenceIds = [...new Set([...record.evidenceIds, ...[...resolved].filter(id => supplied.includes(id))])];
      if (evidenceIds.length > 12) { audit.push({ ...entry, reason: 'citation_budget' }); continue; }
      record.evidenceIds = evidenceIds;
      audit.push({ ...entry, applied: true, evidenceIds, checks });
    }
  }
  return { discussion: result, audit };
}
module.exports = { reconcileDiscussionClauseSources };
