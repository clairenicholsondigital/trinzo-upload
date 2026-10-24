'use strict';

const MAX_ORIGIN_BYTES = 128 * 1024;
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 80
  && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
const ids = value => Array.isArray(value) && value.length <= 1000 && value.every(identity);
const sameIds = (a, b) => ids(a) && ids(b)
  && JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());
const LEAF_KEYS = ['id', 'text', 'evidenceIds', 'reviewFlagIds', 'primaryEvidenceIds',
  'discoveryDisposition', 'supportingDetails'];
const CANDIDATE_KEYS = ['id', 'candidateId', 'text', 'evidenceIds', 'reviewFlagIds',
  'priority', 'sourcePass', 'recordType', 'topic', 'dispositionHint', 'record'];

// Exact known generated shapes only. This archive is provenance, never a
// source of evidence, reviewer authorship, approval, or a new filing decision.
function generatedFilingRecord(value) {
  if (!plain(value) || !identity(value.id) || /^(?:manual-|reviewer-)/.test(value.id)
    || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 1600
    || !ids(value.evidenceIds) || !value.evidenceIds.length
    || value.reviewFlagIds !== undefined && !ids(value.reviewFlagIds)) return false;
  const envelope = value.candidateId !== undefined;
  if (Object.keys(value).some(key => !(envelope ? CANDIDATE_KEYS : LEAF_KEYS).includes(key))) return false;
  if (!envelope) return (value.primaryEvidenceIds === undefined
      || ids(value.primaryEvidenceIds) && value.primaryEvidenceIds.every(id => value.evidenceIds.includes(id)))
    && (value.discoveryDisposition === undefined || ['core', 'supporting'].includes(value.discoveryDisposition))
    && (value.supportingDetails === undefined || Array.isArray(value.supportingDetails) && !value.supportingDetails.length);
  return identity(value.candidateId) && value.id === value.candidateId
    && ['primary', 'recovery', 'staged'].includes(value.sourcePass)
    && ['discussion_point', 'decision', 'open_question'].includes(value.recordType)
    && Number.isFinite(value.priority) && value.priority >= 0 && value.priority <= 1000
    && typeof value.topic === 'string' && value.topic.length <= 220
    && (value.dispositionHint === undefined || ['core', 'supporting'].includes(value.dispositionHint))
    && (value.record === undefined || plain(value.record) && value.record.candidateId === undefined
      && generatedFilingRecord(value.record) && value.record.text === value.text
      && sameIds(value.record.evidenceIds, value.evidenceIds)
      && sameIds(value.record.reviewFlagIds || [], value.reviewFlagIds || []));
}
function filingOriginsFit(origins) {
  return origins.length <= 1000 && Buffer.byteLength(JSON.stringify(origins), 'utf8') <= MAX_ORIGIN_BYTES;
}

// Review metadata only: these origins never grant evidence or authorship.
function filingProvenance(record = {}) {
  const result = {};
  if (record.filingMergeProtected === true) result.filingMergeProtected = true;
  if (Array.isArray(record.filingOrigins)) {
    const origins = record.filingOrigins.slice(0, 1000).filter(origin =>
      origin && typeof origin === 'object' && !Array.isArray(origin)
      && Object.keys(origin).every(key => ['id', 'originalTopic', 'placementReason', 'generatedRecord'].includes(key))
      && typeof origin.id === 'string' && origin.id.length > 0 && origin.id.length <= 80
      && !/[\u0000-\u001f\u007f]/.test(origin.id)
      && (origin.generatedRecord === undefined || generatedFilingRecord(origin.generatedRecord)
        && origin.generatedRecord.id === origin.id)
      && ['originalTopic', 'placementReason'].every(key => origin[key] === undefined
        || (typeof origin[key] === 'string' && origin[key].length <= (key === 'originalTopic' ? 220 : 100))));
    if (origins.length) result.filingOrigins = origins.map(origin => JSON.parse(JSON.stringify(origin)));
    if (origins.length !== record.filingOrigins.length || !filingOriginsFit(origins)) result.filingMergeProtected = true;
  } else if (record.filingOrigins !== undefined) result.filingMergeProtected = true;
  return result;
}

module.exports = { filingProvenance, generatedFilingRecord, filingOriginsFit };
