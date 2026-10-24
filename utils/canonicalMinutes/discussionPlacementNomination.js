'use strict';

const { selectSupportingDetailParent } = require('./supportingDetailPlacement');
const safety = require('./discussionMergeSafety');
const { hash } = require('./discussionClaimConsolidation');
const { isReviewerAuthored } = require('./state');

// A diagnostic packet, never a filing decision. Sentence matches nominate a
// relationship for source-aware assessment; they cannot remove or attach text.
function nominateDiscussionPlacement(draft = {}, options = {}) {
  const limit = Math.min(12, Math.max(0, options.limit ?? 12));
  const discussion = draft.discussion || [], sourceUnits = draft.sourceUnits || [];
  const counts = safety.identityCounts(discussion), known = new Set(), duplicate = new Set();
  sourceUnits.forEach(unit => { if (known.has(unit.id)) duplicate.add(unit.id); known.add(unit.id); });
  const validEvidence = record => Array.isArray(record.evidenceIds) && record.evidenceIds.length
    && record.evidenceIds.every(id => known.has(id) && !duplicate.has(id));
  const rows = discussion.flatMap(topic => safety.protectedTopic(topic) ? []
    : ['points','decisions','openQuestions'].flatMap(kind => (topic[kind] || [])
      .filter(record => safety.mergeableRecord(record) && counts.get(record.id) === 1 && validEvidence(record))
      .map(record => ({ topic, kind, record }))));
  const clauses = rows.flatMap(row => [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(row.record.text)]
    .flatMap(part => part.segment.split(';')).filter(text => text.trim())
    .map(text => ({ ...row, record: { ...row.record, text } })));
  const pool = draft.unassignedSupportingDetails || [], nominations = [];
  const ids = new Map(); pool.forEach(record => ids.set(record.id, (ids.get(record.id) || 0) + 1));
  const explicit = value => /^(?:explicit_target|ambiguous_explicit_target)/.test(String(value || ''));
  for (const detail of pool) {
    if (nominations.length >= limit) break;
    if (!detail || typeof detail.text !== 'string' || !detail.text.trim() || detail.text.length > 1600
      || isReviewerAuthored(detail) || /^(?:manual-|reviewer-)/.test(String(detail.id || ''))
      || detail.supportingDetails?.length || ids.get(detail.id) !== 1 || !validEvidence(detail)
      || explicit(detail.placementReason) || (detail.filingOrigins || []).some(origin => explicit(origin.placementReason))) continue;
    const current = selectSupportingDetailParent(detail, rows, { sourceUnits });
    if (current.target) continue;
    const proposed = selectSupportingDetailParent(detail, clauses, { sourceUnits });
    if (!proposed.target) continue;
    const parent = rows.find(row => row.record.id === proposed.target.record.id);
    const anchors = new Set([...detail.evidenceIds, ...parent.record.evidenceIds]);
    const supplied = sourceUnits.filter((unit, index) => anchors.has(unit.id)
      || anchors.has(sourceUnits[index - 1]?.id) || anchors.has(sourceUnits[index + 1]?.id));
    if (supplied.length > 24 || supplied.some(unit => typeof unit.text !== 'string' || !unit.text.trim()
      || unit.text.length > 12000) || JSON.stringify(supplied).length > 48000) continue;
    nominations.push({ id: 'placement-' + hash([detail, parent.record]).slice(0, 24),
      detail: structuredClone(detail), parent: structuredClone(parent.record), kind: parent.kind,
      matchedClause: proposed.target.record.text, sourceUnits: structuredClone(supplied),
      automaticPlacementAllowed: false,
      warningProtected: Boolean(detail.reviewFlagIds?.length || parent.record.reviewFlagIds?.length) });
  }
  const packet = { version: 'discussion-placement-nomination-v1', mode: 'shadow_only',
    inputHash: hash([discussion, pool]), sourceHash: hash(sourceUnits), nominations };
  return { ...packet, packetHash: hash(packet) };
}

module.exports = { nominateDiscussionPlacement };
