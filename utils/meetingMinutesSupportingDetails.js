'use strict';

const crypto = require('node:crypto');
const { filingProvenance, generatedFilingRecord, filingOriginsFit } = require('./meetingMinutesFilingProvenance');
const { orderedEntries } = require('../public/meeting-minutes-filing-order');

// This is application review state, not part of the Microsoft response schema.
// Keep the complete supporting text here; a review flag is only a short notice.
function strings(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(value => typeof value === 'string').map(value => value.trim()).filter(Boolean))];
}

// Match the editor-save merge-history limits for attached supporting rows.
// These predecessor IDs are review metadata; they never supply evidence or
// reviewer authorship, and their records need not exist in the current draft.
function mergeHistoryIds(values, survivorId) {
  return [...new Set((Array.isArray(values) ? values : []).slice(0, 1000)
    .filter(id => typeof id === 'string' && id.length <= 220)
    .map(id => id.trim())
    .filter(id => id && id !== survivorId && !/[\u0000-\u001f\u007f]/.test(id)))];
}

function normalizeUnassignedSupportingDetails(values = []) {
  const rows = [];
  const seen = new Map();
  for (const value of Array.isArray(values) ? values : []) {
    const record = typeof value === 'string' ? { text: value } : value;
    if (!record || typeof record !== 'object' || typeof record.text !== 'string' || !record.text.trim()) continue;
    const evidenceIds = strings(record.evidenceIds);
    const id = typeof record.id === 'string' && record.id.trim()
      ? record.id.trim().slice(0, 80)
      : 'unfiled-' + crypto.createHash('sha256').update(JSON.stringify([record.text, [...evidenceIds].sort()])).digest('hex').slice(0, 24);
    const mergedFromIds = mergeHistoryIds(record.mergedFromIds, id);
    const unsafe = (record.id !== undefined && (record.id !== id || /[\u0000-\u001f\u007f]/.test(id)))
      || ['evidenceIds', 'reviewFlagIds'].some(key => record[key] !== undefined
        && (!Array.isArray(record[key]) || record[key].some(value => typeof value !== 'string' || !value.trim())))
      || (record.mergedFromIds !== undefined && (!Array.isArray(record.mergedFromIds)
        || record.mergedFromIds.length > 1000 || record.mergedFromIds.some(value =>
          typeof value !== 'string' || value.length > 220 || /[\u0000-\u001f\u007f]/.test(value))))
      || ['originalTopic', 'placementReason'].some(key => record[key] !== undefined
        && (typeof record[key] !== 'string' || record[key].length > (key === 'originalTopic' ? 220 : 100)));
    const item = {
      id, text: record.text, evidenceIds,
      ...filingProvenance(record),
      ...(unsafe || Object.keys(record).some(key => !['id', 'text', 'evidenceIds', 'reviewFlagIds',
        'mergedFromIds', 'originalTopic', 'placementReason', 'reviewerAuthored', 'filingOrigins',
        'filingMergeProtected'].includes(key)
        // An empty generated child list carries no content to preserve. Real
        // descendants and malformed values must still prevent consolidation.
        && !(key === 'supportingDetails' && Array.isArray(record[key]) && record[key].length === 0))
        ? { filingMergeProtected: true } : {}),
      ...(mergedFromIds.length ? { mergedFromIds } : {}),
      ...(strings(record.reviewFlagIds).length ? { reviewFlagIds: strings(record.reviewFlagIds) } : {}),
      ...(typeof record.originalTopic === 'string' && record.originalTopic.trim() ? { originalTopic: record.originalTopic.trim().slice(0, 220) } : {}),
      ...(typeof record.placementReason === 'string' && record.placementReason ? { placementReason: record.placementReason.slice(0, 100) } : {}),
      ...(record.reviewerAuthored === true ? { reviewerAuthored: true } : {})
    };
    // The same id with different wording or provenance is not a duplicate.
    const key = JSON.stringify([id, item.text, [...evidenceIds].sort()]);
    if (seen.has(key)) {
      const old = seen.get(key);
      if (old.filingOrigins || item.filingOrigins
        || old.originalTopic !== item.originalTopic || old.placementReason !== item.placementReason) {
        const origin = row => ({ id: row.id,
          ...(row.originalTopic ? { originalTopic: row.originalTopic } : {}),
          ...(row.placementReason ? { placementReason: row.placementReason } : {}) });
        const origins = [...new Map([...(old.filingOrigins || [origin(old)]),
          ...(item.filingOrigins || [origin(item)])].map(value => [JSON.stringify(value), value])).values()];
        const completeHistory = new Set([...(old.mergedFromIds || []), ...(item.mergedFromIds || [])]);
        completeHistory.delete(id);
        if (!filingOriginsFit(origins) || completeHistory.size > 1000) { rows.push(item); continue; }
        old.filingOrigins = origins;
      }
      if (item.filingMergeProtected) old.filingMergeProtected = true;
      const flags = strings([...(old.reviewFlagIds || []), ...(item.reviewFlagIds || [])]);
      if (flags.length) old.reviewFlagIds = flags;
      const history = mergeHistoryIds([...(old.mergedFromIds || []), ...(item.mergedFromIds || [])], id);
      if (history.length) old.mergedFromIds = history;
      if (item.reviewerAuthored) old.reviewerAuthored = true;
      continue;
    }
    seen.set(key, item);
    rows.push(item);
  }
  return consolidateExactFilingDuplicates(rows);
}

// Exact generated leaves only. Keep the first position/identity, and retain
// every predecessor and placement origin. This is not semantic deduplication.
function consolidateExactFilingDuplicates(rows) {
  const candidates = new Map(), result = [];
  const origin = row => ({ id: row.id,
    ...(row.originalTopic ? { originalTopic: row.originalTopic } : {}),
    ...(row.placementReason ? { placementReason: row.placementReason } : {}) });
  const origins = row => row.filingOrigins || [origin(row)];
  const locked = row => row.reviewerAuthored === true || row.filingMergeProtected === true
    || /^(?:manual-|reviewer-)/.test(row.id);
  for (const row of rows) {
    const key = JSON.stringify([row.text, [...row.evidenceIds].sort(), [...(row.reviewFlagIds || [])].sort()]);
    const old = candidates.get(key);
    if (!locked(row) && row.evidenceIds.length && old && old.id !== row.id) {
      const history = [...new Set([...(old.mergedFromIds || []), row.id, ...(row.mergedFromIds || [])])]
        .filter(id => id !== old.id);
      const combined = [...new Map([...origins(old), ...origins(row)].map(value => [JSON.stringify(value), value])).values()];
      if (history.length <= 1000 && filingOriginsFit(combined)) {
        old.mergedFromIds = history;
        old.filingOrigins = combined;
        continue;
      }
    }
    result.push(row);
    if (!locked(row) && row.evidenceIds.length) candidates.set(key, row);
  }
  return result;
}

function collectUnassignedSupportingDetails(record, context = {}) {
  const retained = [];
  const visit = (value, inheritedTopic = context.originalTopic) => {
    if (!value || typeof value !== 'object') return;
    // A proposed/current parent is a fallback label, not the detail's origin.
    const originalTopic = value.originalTopic || inheritedTopic;
    const placementReason = context.placementReason || value.placementReason;
    let filingRecord = value;
    // Only the internal generated handoff can archive a recognized discovery
    // leaf/envelope and project its filing representation. Never unlock an
    // existing protected row or discard unknown/reviewer/nested metadata.
    if (generatedFilingRecord(value) && (value.primaryEvidenceIds !== undefined
      || value.discoveryDisposition !== undefined || value.candidateId !== undefined)) {
      const origin = { id: value.id, ...(originalTopic ? { originalTopic } : {}),
        ...(placementReason ? { placementReason } : {}), generatedRecord: JSON.parse(JSON.stringify(value)) };
      if (!filingProvenance({ filingOrigins: [origin] }).filingMergeProtected
        && filingOriginsFit([origin])) filingRecord = { id: value.id, text: value.text,
        evidenceIds: value.evidenceIds, ...(value.reviewFlagIds ? { reviewFlagIds: value.reviewFlagIds } : {}),
        filingOrigins: [origin] };
    }
    retained.push(...normalizeUnassignedSupportingDetails([{ ...filingRecord, originalTopic, placementReason }]));
    for (const child of Array.isArray(value.supportingDetails) ? value.supportingDetails : []) visit(child, originalTopic);
  };
  visit(record);
  for (const child of Array.isArray(context.supportingDetails) ? context.supportingDetails : []) visit(child);
  return normalizeUnassignedSupportingDetails(retained);
}

function orderedFilingSupportingDetails(values = [], sourceUnits = []) {
  return orderedEntries(normalizeUnassignedSupportingDetails(values), sourceUnits).map(entry => entry.detail);
}

function mergeUnassignedSupportingDetails(...collections) {
  return normalizeUnassignedSupportingDetails(collections.flatMap(rows => Array.isArray(rows) ? rows : []));
}

// Only fold a complete literal first claim into its own generated parent.
// Paraphrases, extra evidence, warnings, descendants and reviewer choices stay.
function foldLiteralParentSupportingRepeats(discussion = []) {
  const { isReviewerAuthored } = require('./canonicalMinutes/state');
  const locked = row => isReviewerAuthored(row) || row?.confirmedTopic === true
    || /^(?:manual-|reviewer-)/.test(String(row?.id || ''));
  const reviewerSubtree = row => locked(row) || (row?.supportingDetails || []).some(reviewerSubtree);
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  const protectedWords = value => (value.match(/\b(?:not|no|never|without|except|if|unless|until|before|after|once|pending|unconfirmed|alleged|reported|apparently|probably|possibly|maybe|perhaps|roughly|approximately|around|about|trying|expected|proposed|false|incorrect|wrong|disputed|uncertain|unclear|unverified|whether|however|only|may|might|could|would|should)\b/gi) || []).map(word => word.toLowerCase()).join('|');
  let foldedCount = 0;
  const topics = (Array.isArray(discussion) ? discussion : []).map(topic => {
    if (locked(topic)) return topic;
    const next = { ...topic };
    for (const kind of ['points', 'decisions', 'openQuestions']) {
      next[kind] = (topic[kind] || []).map(parent => {
        if (reviewerSubtree(parent) || kind === 'openQuestions' || (parent.reviewFlagIds || []).length) return parent;
        const parentText = clean(parent.text);
        const evidence = new Set(parent.evidenceIds || []);
        let history = mergeHistoryIds(parent.mergedFromIds, parent.id);
        const details = (parent.supportingDetails || []).filter(detail => {
          if (!detail || Object.keys(detail).some(key => !['id', 'text', 'evidenceIds', 'reviewFlagIds', 'mergedFromIds', 'supportingDetails'].includes(key))
            || locked(detail) || (detail.reviewFlagIds || []).length
            || (detail.supportingDetails || []).length || !detail.id
            || !(detail.evidenceIds || []).length
            || !(detail.evidenceIds || []).every(id => evidence.has(id))) return true;
          const claim = clean(detail.text).replace(/[.]$/, '');
          const tail = parentText.slice(claim.length);
          if (claim.split(' ').length < 8 || !parentText.startsWith(claim)
            || !(tail === '.' || tail === '' || /^\.\s+|^, and |^; and /.test(tail))
            || protectedWords(parentText) !== protectedWords(claim)) return true;
          const merged = mergeHistoryIds([...history, detail.id, ...(detail.mergedFromIds || [])], parent.id);
          // Do not truncate predecessor history in order to hide a repetition.
          if (history.length + 1 + (detail.mergedFromIds || []).length > 1000) return true;
          history = merged;
          foldedCount += 1;
          return false;
        });
        return details.length === (parent.supportingDetails || []).length ? parent
          : { ...parent, supportingDetails: details, ...(history.length ? { mergedFromIds: history } : {}) };
      });
    }
    return next;
  });
  return { discussion: topics, foldedCount };
}

function withoutRepresentedUnassignedDetails(values = [], discussion = []) {
  const records = [];
  const visit = record => {
    if (!record || typeof record !== 'object') return;
    records.push(record);
    (record.supportingDetails || []).forEach(visit);
  };
  for (const topic of discussion || []) {
    for (const kind of ['points', 'decisions', 'openQuestions']) (topic[kind] || []).forEach(visit);
  }
  return normalizeUnassignedSupportingDetails(values).filter(detail => !records.some(record => {
    if (record.text !== detail.text) return false;
    const evidence = new Set(record.evidenceIds || []);
    const flags = new Set(record.reviewFlagIds || []);
    const history = new Set(mergeHistoryIds(record.mergedFromIds, record.id));
    // Filing one occurrence is not permission to remove another identical entry.
    if (record.id !== detail.id && !history.has(detail.id)) return false;
    return detail.evidenceIds.every(id => evidence.has(id))
      && (detail.evidenceIds.length > 0 || record.id === detail.id)
      && (detail.reviewFlagIds || []).every(id => flags.has(id))
      && (detail.mergedFromIds || []).every(id => history.has(id))
      && (!detail.reviewerAuthored || record.reviewerAuthored === true)
      && (detail.filingOrigins || []).every(origin =>
        (record.filingOrigins || []).some(other => JSON.stringify(other) === JSON.stringify(origin)));
  }));
}

module.exports = {
  normalizeUnassignedSupportingDetails,
  orderedFilingSupportingDetails,
  collectUnassignedSupportingDetails,
  mergeUnassignedSupportingDetails,
  withoutRepresentedUnassignedDetails,
  foldLiteralParentSupportingRepeats
};
