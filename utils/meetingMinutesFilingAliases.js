'use strict';

// Structural identity reconciliation only, at the generated agent handoff.
// Never use wording similarity or a shared warning as an identity proof.
const { isDeepStrictEqual } = require('node:util');
const { hash } = require('./canonicalMinutes/discussionClaimConsolidation');
const VERSION = 'generated-filing-alias-v1';
const clone = value => structuredClone(value);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const only = (value, keys) => plain(value) && Object.keys(value).every(key => keys.includes(key));
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 80
  && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value) && !/^(?:manual-|reviewer-)/.test(value);
const ids = value => Array.isArray(value) && value.length <= 1000 && value.every(id)
  && new Set(value).size === value.length;
const sameIds = (a, b) => ids(a) && ids(b) && isDeepStrictEqual([...a].sort(), [...b].sort());
const rowKeys = ['id', 'text', 'evidenceIds', 'reviewFlagIds', 'originalTopic', 'placementReason', 'filingMergeProtected'];
const leafKeys = ['id', 'text', 'evidenceIds', 'reviewFlagIds', 'supportingDetails'];
const candidateKeys = ['candidateId', 'sourcePass', 'recordType', 'topic', 'text', 'evidenceIds', 'priority', 'record'];
function emptyCandidate(candidate) {
  const record = candidate?.record;
  return only(candidate, candidateKeys) && id(candidate.candidateId) && candidate.sourcePass === 'staged'
    && ['discussion_point', 'decision', 'open_question'].includes(candidate.recordType)
    && typeof candidate.topic === 'string' && candidate.topic.trim() === candidate.topic
    && candidate.topic.length > 0 && candidate.topic.length <= 220 && !/[\u0000-\u001f\u007f]/.test(candidate.topic)
    && typeof candidate.text === 'string' && candidate.text.trim() === candidate.text
    && candidate.text.length > 0 && candidate.text.length <= 1600
    && Array.isArray(candidate.evidenceIds) && candidate.evidenceIds.length === 0
    && Number.isFinite(candidate.priority) && candidate.priority >= 0 && candidate.priority <= 1000
    && only(record, leafKeys) && id(record.id) && record.id !== candidate.candidateId
    && record.text === candidate.text && Array.isArray(record.evidenceIds) && record.evidenceIds.length === 0
    && ids(record.reviewFlagIds || [])
    && (record.supportingDetails === undefined || Array.isArray(record.supportingDetails) && record.supportingDetails.length === 0);
}
function rawCanonical(handoff, row) {
  if (!only(handoff, ['record', 'context']) || !only(handoff.record, [...leafKeys, 'originalTopic'])
    || !only(handoff.context, ['originalTopic', 'placementReason', 'supportingDetails'])) return false;
  const r = handoff.record, c = handoff.context;
  return r.id === row.id && r.text === row.text && sameIds(r.evidenceIds, row.evidenceIds)
    && sameIds(r.reviewFlagIds || [], row.reviewFlagIds || [])
    && (r.supportingDetails === undefined || Array.isArray(r.supportingDetails) && !r.supportingDetails.length)
    && (r.originalTopic || c.originalTopic) === row.originalTopic
    && typeof c.originalTopic === 'string' && c.originalTopic.length > 0 && c.originalTopic.length <= 220
    && !/[\u0000-\u001f\u007f]/.test(c.originalTopic) && c.placementReason === row.placementReason
    && (c.supportingDetails === undefined || Array.isArray(c.supportingDetails) && !c.supportingDetails.length);
}
function reconcile(rows, candidates, sourceUnits, options = {}) {
  const original = clone(rows), audit = { version: VERSION, applied: false, ledger: [] };
  const unchanged = reason => ({ rows: clone(original), audit: { ...audit, reason } });
  if (options.enabled !== true) return unchanged('disabled');
  if (!Array.isArray(rows) || rows.length > 500 || !Array.isArray(candidates) || candidates.length > 1200
    || !Array.isArray(sourceUnits) || !Array.isArray(options.handoffs) || options.handoffs.length > 2400
    || !Array.isArray(options.priorRows) || !Array.isArray(options.discussion)) return unchanged('invalid_context');
  const count = (items, get) => { const map = new Map(); for (const item of items) { const key = get(item); map.set(key, (map.get(key) || 0) + 1); } return map; };
  const rowCounts = count(rows, r => r?.id), candidateCounts = count(candidates, c => c?.candidateId);
  const recordCounts = count(candidates, c => c?.record?.id), sourceCounts = count(sourceUnits, s => s?.id);
  const sources = new Map(sourceUnits.map(s => [s?.id, s]));
  const handoffs = new Map(); for (const h of options.handoffs) { const key = h?.record?.id; handoffs.set(key, [...(handoffs.get(key) || []), h]); }
  const protectedIds = new Set(options.priorRows.map(r => r?.id));
  const visit = r => { if (!plain(r)) return; protectedIds.add(r.id); for (const d of Array.isArray(r.supportingDetails) ? r.supportingDetails : []) visit(d); };
  for (const topic of options.discussion) for (const key of ['points', 'decisions', 'openQuestions']) for (const r of Array.isArray(topic?.[key]) ? topic[key] : []) visit(r);
  const result = clone(rows), removed = new Set();
  for (const candidate of candidates) {
    if (audit.ledger.length === 3) break;
    if (!emptyCandidate(candidate) || candidateCounts.get(candidate.candidateId) !== 1 || recordCounts.get(candidate.record.id) !== 1) continue;
    const aliasId = candidate.candidateId, recordId = candidate.record.id;
    if (protectedIds.has(aliasId) || protectedIds.has(recordId) || rowCounts.get(aliasId) !== 1 || rowCounts.get(recordId) !== 1) continue;
    const alias = rows.find(r => r?.id === aliasId), target = rows.find(r => r?.id === recordId);
    if (!only(alias, rowKeys) || !only(target, rowKeys) || alias.filingMergeProtected !== true || target.filingMergeProtected !== undefined
      || alias.placementReason !== 'explicit_target_subject_mismatch' || target.placementReason !== 'no_subject_match'
      || alias.text !== candidate.text || target.text !== candidate.text
      || alias.originalTopic !== candidate.topic || target.originalTopic !== candidate.topic
      || !Array.isArray(alias.evidenceIds) || alias.evidenceIds.length || !ids(target.evidenceIds) || !target.evidenceIds.length || target.evidenceIds.length > 12
      || !sameIds(alias.reviewFlagIds || [], candidate.record.reviewFlagIds || [])
      || !sameIds(target.reviewFlagIds || [], alias.reviewFlagIds || [])
      || target.evidenceIds.some(key => sourceCounts.get(key) !== 1 || typeof sources.get(key)?.text !== 'string' || !sources.get(key).text.trim())) continue;
    const a = handoffs.get(aliasId), t = handoffs.get(recordId);
    const expected = { record: { ...clone(candidate), id: aliasId, text: candidate.text, evidenceIds: [], reviewFlagIds: clone(candidate.record.reviewFlagIds || []) },
      context: { originalTopic: candidate.topic, placementReason: alias.placementReason } };
    // Account for WHY the early envelope was protected; never unlock a row
    // after a normalizer has discarded unrecognized or reviewer metadata.
    if (a?.length !== 1 || t?.length !== 1 || !isDeepStrictEqual(a[0], expected) || !rawCanonical(t[0], target)) continue;
    const survivor = { ...clone(target), mergedFromIds: [aliasId], filingMergeProtected: true,
      filingOrigins: [target, alias].map(r => ({ id: r.id, originalTopic: r.originalTopic, placementReason: r.placementReason })) };
    result[rows.indexOf(target)] = survivor; removed.add(aliasId);
    audit.ledger.push({ aliasId, survivorId: recordId, aliasIndex: rows.indexOf(alias), survivorIndex: rows.indexOf(target),
      originalAlias: clone(alias), originalSurvivor: clone(target), candidate: clone(candidate),
      handoffs: clone([a[0], t[0]]), survivor: clone(survivor) });
  }
  if (!audit.ledger.length) return unchanged('no_proved_aliases');
  const output = result.filter(r => !removed.has(r.id));
  const complete = { ...audit, applied: true, reason: 'applied', original, originalHash: hash(original),
    sourceHash: hash(sourceUnits), finalHash: hash(output) };
  if (Buffer.byteLength(JSON.stringify(complete), 'utf8') > 128 * 1024) return unchanged('archive_capacity');
  return { rows: output, audit: complete };
}
function restore(rows, sourceUnits, audit) {
  if (audit?.version !== VERSION || audit.applied !== true || !Array.isArray(audit.original)
    || hash(audit.original) !== audit.originalHash || hash(rows) !== audit.finalHash || hash(sourceUnits) !== audit.sourceHash) return null;
  return clone(audit.original);
}
module.exports = { VERSION, reconcile, restore };
