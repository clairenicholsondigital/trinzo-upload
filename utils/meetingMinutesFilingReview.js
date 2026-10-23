'use strict';

const { selectSupportingDetailParent } = require('./canonicalMinutes/supportingDetailPlacement');
const { isReviewerAuthored } = require('./canonicalMinutes/state');
const { suggestionBasis } = require('../public/meeting-minutes-filing-order');

// Suggestions are a read-only projection, never a placement or coverage proof.
function filingSuggestions(draft = {}) {
  const discussion = draft.discussion || [], pool = draft.unassignedSupportingDetails || [];
  const candidates = discussion.flatMap((topic, topicIndex) =>
    ['points', 'decisions', 'openQuestions'].flatMap(field =>
      (topic[field] || []).map((record, itemIndex) => ({ topic, record, topicIndex, field, itemIndex }))));
  const validSources = new Set((draft.sourceUnits || []).map(unit => unit.id));
  const suggestions = [];
  pool.forEach((detail, index) => {
    if (isReviewerAuthored(detail) || /^(manual-|reviewer-)/.test(String(detail.id || ''))
      || (detail.reviewFlagIds || []).length || !(detail.evidenceIds || []).length
      || !detail.evidenceIds.every(id => validSources.has(id))) return;
    const selected = selectSupportingDetailParent(detail, candidates, { sourceUnits: draft.sourceUnits });
    const target = selected.target;
    if (!target || isReviewerAuthored(target.record) || isReviewerAuthored(target.topic)
      || (target.record.reviewFlagIds || []).length || (target.record.supportingDetails || []).length >= 50) return;
    suggestions.push({ index, topicIndex: target.topicIndex, field: target.field, itemIndex: target.itemIndex });
  });
  return { basis: suggestionBasis(draft), suggestions };
}

// Recover only definitions belonging to linked retained records, from durable
// flag collections. Existing current definitions (including resolutions) win.
function filingReviewFlags(draft = {}, current = draft.reviewFlags || []) {
  const flags = [...current], known = new Map(flags.map(flag => [flag.id, flag]));
  const linked = new Map();
  const visit = record => {
    for (const id of record?.reviewFlagIds || []) {
      if (!linked.has(id)) linked.set(id, new Set());
      for (const source of record.evidenceIds || []) linked.get(id).add(source);
    }
    (record?.supportingDetails || []).forEach(visit);
  };
  (draft.unassignedSupportingDetails || []).forEach(visit);
  // Also retain diagnostics after a reviewer moves an unfiled record.
  for (const topic of draft.discussion || []) for (const kind of ['points', 'decisions', 'openQuestions']) {
    for (const record of topic[kind] || []) if (record.filingOrigins?.length || record.originalTopic) visit(record);
  }
  const saved = new Map();
  const remember = collection => {
    for (const flag of Array.isArray(collection) ? collection : []) {
      if (flag && typeof flag.id === 'string' && typeof flag.message === 'string'
        && flag.message.trim() && linked.has(flag.id) && !saved.has(flag.id)) saved.set(flag.id, flag);
    }
  };
  // Newest durable definitions take precedence over older snapshots.
  for (const pass of [...(draft.passCache || [])].reverse()) remember(pass?.result?.reviewFlags);
  for (const change of [...(draft.changeHistory || [])].reverse()) {
    remember(change?.after?.reviewFlags); remember(change?.before?.reviewFlags);
  }
  for (const [id, evidence] of linked) {
    if (known.has(id)) continue;
    const recovered = saved.get(id);
    flags.push(recovered ? structuredClone(recovered) : {
      id, kind: 'missing_evidence', status: 'open', correctionNote: '',
      message: 'The explanation for this retained warning is unavailable. Check this detail against its source before including it.',
      evidenceIds: [...evidence]
    });
  }
  return flags;
}

module.exports = { filingSuggestions, filingReviewFlags };
