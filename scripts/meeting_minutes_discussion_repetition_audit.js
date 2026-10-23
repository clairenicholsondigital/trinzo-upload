'use strict';

// Offline audit only: explicitly supplied snapshots, no database/providers/writes.
const fs = require('node:fs');
const crypto = require('node:crypto');
const safety = require('../utils/canonicalMinutes/discussionMergeSafety');
const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
function audit(value) {
  const draft = value?.payload || value;
  if (!Array.isArray(draft?.discussion) || !Array.isArray(draft?.sourceUnits))
    throw new TypeError('Expected a draft snapshot with discussion and sourceUnits arrays.');
  const sources = new Map(), duplicateSources = new Set();
  for (const source of draft.sourceUnits) {
    if (sources.has(source.id)) duplicateSources.add(source.id);
    sources.set(source.id, source);
  }
  const identities = safety.identityCounts(draft.discussion), exclusions = [], within = [], across = [];
  let pointCount = 0, eligiblePoints = 0;
  for (const [topicIndex, topic] of draft.discussion.entries()) {
    const seen = new Map(), protectedTopic = safety.protectedTopic(topic);
    for (const [recordIndex, row] of (topic.points || []).entries()) {
      pointCount++;
      const reasons = [];
      if (protectedTopic) reasons.push('reviewer_controlled_topic');
      if (!safety.mergeableRecord(row)) reasons.push('protected_or_invalid_record_metadata');
      if (Array.isArray(row.primaryEvidenceIds) && row.primaryEvidenceIds.some(id => !(row.evidenceIds || []).includes(id)))
        reasons.push('primary_evidence_outside_citations');
      if (row.reviewFlagIds?.length) reasons.push('warning_target');
      if (row.supportingDetails?.length) reasons.push('supporting_children');
      if (row.simulationSource !== undefined || row.simulationParentId !== undefined) reasons.push('simulation_placement');
      if (identities.get(row.id) !== 1) reasons.push('ambiguous_identity');
      if (!Array.isArray(row.evidenceIds) || !row.evidenceIds.length
        || row.evidenceIds.some(id => duplicateSources.has(id) || typeof sources.get(id)?.text !== 'string'
          || !sources.get(id).text.trim())) reasons.push('incomplete_or_ambiguous_sources');
      if (reasons.length) exclusions.push({ topicIndex, recordIndex, recordId: row.id, reasons });
      else eligiblePoints++;
      const sentences = [...segmenter.segment(String(row.text || ''))].map(s => s.segment.trim().replace(/\s+/g, ' '));
      for (const [clauseIndex, text] of sentences.entries()) {
        const ref = { recordId: row.id, recordIndex, clauseIndex, eligibleRecord: reasons.length === 0 };
        const prior = seen.get(text) || [];
        for (const original of prior) (original.recordIndex === recordIndex ? within : across).push({
          topicIndex, original, repeated: ref,
          sentenceHash: crypto.createHash('sha256').update(text).digest('hex')
        });
        prior.push(ref); seen.set(text, prior);
      }
    }
  }
  return { pointCount, eligiblePoints, exclusions, exactWithinRecord: within, exactAcrossRecords: across };
}
if (require.main === module) {
  try {
    if (process.argv.length < 3) throw new Error('Pass one or more saved draft JSON paths.');
    process.stdout.write(JSON.stringify({ version: 'discussion-repetition-audit-v1',
      inputs: process.argv.slice(2).map(file => ({ file, audit: audit(JSON.parse(fs.readFileSync(file, 'utf8'))) })) }, null, 2) + '\n');
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
module.exports = { audit };
