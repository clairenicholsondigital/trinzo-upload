'use strict';

const { isReviewerAuthored } = require('./state');
const FIELDS = new Set(['id', 'text', 'evidenceIds', 'reviewFlagIds', 'mergedFromIds',
  'supportingDetails', 'primaryEvidenceIds', 'discoveryDisposition', 'simulationSource', 'simulationParentId']);
const SCALARS = ['discoveryDisposition', 'simulationSource', 'simulationParentId'];
const clean = value => String(value || '').toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, ' ').trim();
const unique = values => [...new Set(values)];
const same = (a, b) => a.length === b.length && a.every((value, at) => value === b[at]);
const set = values => unique(values).sort();
const NEGATIVE = /\b(?:no|not|never|cannot|without|[a-z]+n't|declin(?:e|ed)|reject(?:ed)?|refus(?:e|ed))\b/;
const MODAL = /\b(?:possible|possibly|potential|potentially|perhaps|maybe|may|might|could|probably|likely|apparently|allegedly|presumably|approximately|roughly|around|about|estimated|expected|tentative|tentatively|proposed|proposes|proposal|proposals|suggested|suggestion|suggestions|considering|ideally|hopefully|uncertain|unsure|unclear|unconfirmed|unverified|i think|we think|i believe|we believe)\b/g;
const CONDITION = /\b(?:only if|only when|only after|only before|subject to|provided(?: that)?|providing|as long as|conditional on|dependent on|depending on|if|unless|without|until|before|after|upon|following|once|when|pending)\b[^.;!?]*/g;
const BOUND = /\b(?:at least|at most|up to|less than|more than|under|over|below|above)\b/g;
const IGNORE_NAMES = new Set(['A', 'An', 'The', 'It', 'This', 'That', 'These', 'Those', 'There',
  'We', 'They', 'He', 'She', 'If', 'After', 'Before', 'Once', 'When', 'For', 'In', 'On', 'At', 'As']);
const question = value => /\?|\b(?:asks?|asked|asking|queries|queried|questioning|questions?\s+(?:whether|how|why|what|if)|inquires?|enquires?|wonders?|wondered)\b/i.test(value);

function names(value) {
  return (String(value || '').match(/\b[A-Z][A-Za-z0-9'’-]*\b/g) || [])
    .filter(word => !IGNORE_NAMES.has(word)).map(word => word.replace(/[’']s$/, ''));
}
function qualifiers(value) {
  const body = clean(value);
  return set((body.match(MODAL) || []).filter(word => word !== 'proposed' || !/\b(?:under review|being reviewed)\b/.test(body)).map(word =>
    /^(?:possible|possibly|potential|potentially)$/.test(word) ? 'possibility'
      : /^(?:propos(?:ed|es|al|als)|suggest(?:ed|ion|ions))$/.test(word) ? 'proposal' : word));
}
function conditions(value) {
  return set((clean(value).match(CONDITION) || []).map(clause =>
    clause.replace(/^(?:unless|without)\s+/, 'requires ')
      .replace(/\s+(?:is|are)\s+provided\b/g, '').replace(/\b(?:the|a|an)\b/g, '')
      .replace(/[^a-z0-9' ]/g, ' ').replace(/\s+/g, ' ').trim()));
}
function bounds(value) {
  const numeric = /^(?:\d|zero\b|one\b|two\b|three\b|four\b|five\b|six\b|seven\b|eight\b|nine\b|ten\b|eleven\b|twelve\b|twenty\b|thirty\b|forty\b|fifty\b|hundred\b|thousand\b)/;
  const body = clean(value);
  return set([...body.matchAll(BOUND)].filter(match => numeric.test(body.slice(match.index + match[0].length).trim().replace(/^[£€$]\s*/, ''))).map(match => match[0]).map(word =>
    /^(?:over|above|more than)$/.test(word) ? 'above'
      : /^(?:under|below|less than)$/.test(word) ? 'below'
        : /^(?:at most|up to)$/.test(word) ? 'maximum' : 'minimum'));
}
function phases(value) {
  const body = clean(value), found = [];
  if (/\b(?:plans?|planned|planning|aims?|trying|scheduled|anticipated|expected|will|shall|going to)\b/.test(body)) found.push('future');
  if (/\b(?:completed?|finished?|done)\b/.test(body)) found.push('completed');
  return found;
}
// Rejection guards only. Matching signatures never prove equivalence.
function claimsCompatible(left, right, options = {}) {
  const a = clean(left), b = clean(right);
  const polarity = value => NEGATIVE.test(value.replace(CONDITION, ''));
  if (polarity(a) !== polarity(b) || question(left) !== question(right)) return false;
  if (!same(qualifiers(left), qualifiers(right)) || !same(conditions(left), conditions(right))
    || !(same(bounds(left), bounds(right)) || options.allowAdditionalBounds === true && !bounds(left).length)
    || !same(phases(left), phases(right))) return false;
  const leftNames = names(left), rightNames = names(right);
  const shared = new Set(leftNames.filter(name => rightNames.includes(name)));
  if (shared.size >= 2 && !same(leftNames.filter(name => shared.has(name)), rightNames.filter(name => shared.has(name)))) return false;
  return true;
}
function validIds(values, limit) {
  return Array.isArray(values) && values.length <= limit && values.every(id =>
    typeof id === 'string' && id && id.trim() === id && id.length <= 220 && !/[\u0000-\u001f\u007f]/.test(id));
}
function reviewer(record) {
  return isReviewerAuthored(record) || /^(?:manual-|reviewer-)/.test(String(record?.id || ''))
    || (Array.isArray(record?.supportingDetails) && record.supportingDetails.some(reviewer));
}
function mergeableRecord(record) {
  if (!record || typeof record.text !== 'string' || !record.text.trim() || reviewer(record)
    || !validIds([record.id], 1) || !Object.keys(record).every(key => FIELDS.has(key))
    || !validIds(record.evidenceIds, 12) || !record.evidenceIds.length) return false;
  for (const key of ['reviewFlagIds', 'mergedFromIds', 'primaryEvidenceIds']) {
    if (record[key] !== undefined && !validIds(record[key], key === 'mergedFromIds' ? 1000 : key === 'primaryEvidenceIds' ? 12 : 1000)) return false;
  }
  if ((record.primaryEvidenceIds || []).some(id => !record.evidenceIds.includes(id))) return false;
  if (record.supportingDetails !== undefined && !Array.isArray(record.supportingDetails)) return false;
  return SCALARS.every(key => record[key] === undefined
    || typeof record[key] === 'string' && record[key].length <= 220 && !/[\u0000-\u001f\u007f]/.test(record[key]));
}
function exactClaim(left, right) {
  return String(left || '').replace(/\s+/g, ' ').trim().replace(/[.]$/, '')
    === String(right || '').replace(/\s+/g, ' ').trim().replace(/[.]$/, '');
}
// Metadata reconciliation can veto a perfectly similar pair. Never truncate
// evidence/history or guess how an unfamiliar field should be combined.
function reconcileMetadata(records, survivor, options = {}) {
  if (!records.length || records.some(record => !mergeableRecord(record))) return null;
  if (!records.every(record => exactClaim(record.text, survivor.text))
    && records.some(record => (record.reviewFlagIds || []).length)) return null;
  for (const key of SCALARS) {
    if (!options.completeArchive && set(records.map(record => record[key] === undefined ? null : record[key])).length > 1) return null;
  }
  const ordered = [survivor, ...records.filter(record => record !== survivor)];
  const evidenceIds = unique(ordered.flatMap(record => record.evidenceIds));
  const mergedFromIds = unique(records.flatMap(record => [
    ...(record.mergedFromIds || []), ...(record.id === survivor.id || (options.survivingIds || []).includes(record.id) ? [] : [record.id])
  ])).filter(id => id !== survivor.id);
  if (evidenceIds.length > 12 || mergedFromIds.length > 1000) return null;
  const primaryEvidenceIds = unique(ordered.flatMap(record => record.primaryEvidenceIds || []));
  const metadata = { evidenceIds, reviewFlagIds: unique(ordered.flatMap(record => record.reviewFlagIds || [])),
    ...(mergedFromIds.length ? { mergedFromIds } : {}),
    ...(records.some(record => record.primaryEvidenceIds !== undefined) ? { primaryEvidenceIds } : {}) };
  for (const key of SCALARS) {
    const value = ordered.find(record => record[key] !== undefined)?.[key];
    if (value !== undefined) metadata[key] = value;
  }
  return metadata;
}
function rewriteRetainsProtected(originals, rewritten) {
  const output = rewritten.join(' ');
  const includesAll = (need, have) => need.every(value => have.includes(value));
  for (const original of originals) {
    if (!includesAll(qualifiers(original), qualifiers(output)) || !includesAll(conditions(original), conditions(output))
      || !includesAll(bounds(original), bounds(output)) || !includesAll(phases(original), phases(output))) return false;
    const required = names(original), present = names(output), shared = new Set(required.filter(name => present.includes(name)));
    if (shared.size >= 2) {
      let at = 0;
      for (const name of present) if (name === required[at]) at += 1;
      if (at !== required.length) return false;
    }
  }
  return true;
}
function protectedTopic(topic) {
  return reviewer(topic) || ['points', 'decisions', 'openQuestions'].some(kind =>
    (Array.isArray(topic?.[kind]) ? topic[kind] : []).some(reviewer));
}
function identityCounts(discussion) {
  const counts = new Map();
  const visit = record => {
    if (!record || typeof record !== 'object') return;
    if (typeof record.id === 'string') counts.set(record.id, (counts.get(record.id) || 0) + 1);
    for (const child of Array.isArray(record.supportingDetails) ? record.supportingDetails : []) visit(child);
  };
  for (const topic of discussion || []) for (const kind of ['points', 'decisions', 'openQuestions']) {
    for (const record of Array.isArray(topic?.[kind]) ? topic[kind] : []) visit(record);
  }
  return counts;
}
module.exports = { claimsCompatible, mergeableRecord, reconcileMetadata, rewriteRetainsProtected,
  qualifiers, conditions, bounds, phases, names, exactClaim, validIds, protectedTopic, identityCounts };
