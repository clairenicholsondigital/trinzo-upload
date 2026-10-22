'use strict';

const crypto = require('node:crypto');

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
    const item = {
      id, text: record.text, evidenceIds,
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
  return rows;
}

function collectUnassignedSupportingDetails(record, context = {}) {
  const retained = [];
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    retained.push(...normalizeUnassignedSupportingDetails([{ ...value,
      originalTopic: context.originalTopic || value.originalTopic,
      placementReason: context.placementReason || value.placementReason }]));
    for (const child of Array.isArray(value.supportingDetails) ? value.supportingDetails : []) visit(child);
  };
  visit(record);
  for (const child of Array.isArray(context.supportingDetails) ? context.supportingDetails : []) visit(child);
  return normalizeUnassignedSupportingDetails(retained);
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
    return detail.evidenceIds.every(id => evidence.has(id))
      && (detail.evidenceIds.length > 0 || record.id === detail.id)
      && (detail.reviewFlagIds || []).every(id => flags.has(id))
      && (detail.mergedFromIds || []).every(id => history.has(id))
      && (!detail.reviewerAuthored || record.reviewerAuthored === true);
  }));
}

module.exports = {
  normalizeUnassignedSupportingDetails,
  collectUnassignedSupportingDetails,
  mergeUnassignedSupportingDetails,
  withoutRepresentedUnassignedDetails,
  foldLiteralParentSupportingRepeats
};
