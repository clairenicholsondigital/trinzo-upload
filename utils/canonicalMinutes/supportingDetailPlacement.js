'use strict';

const { isReviewerAuthored } = require('./state');

// Filing is a positive claim about a detail's subject. Names, dates, generic
// editorial language and a shared source turn cannot establish that claim.
const GENERIC = new Set(('a an the and or but for from into that this those these then than their there with without to of on in at by as is are was were be been being have has had do does did will would could should can may might must need needs needed require requires required requirement requirements current additional extra further new same other next first last today tomorrow yesterday week month year monday tuesday wednesday thursday friday saturday sunday january february march april june july august september october november december morning afternoon evening am pm utc gmt bst cet cest meeting call session team people person attendee participant speaker update updates updated review reviews reviewed process processes project projects work working product products device devices system systems task tasks action actions plan plans planning report reports reported document documents documentation record records note notes detail details context information discussion discussed discuss decision agreed approve approved approval confirm confirmed confirmation check checked complete completed completion progress status provide provided include included available expected proposed requested request ensure outcome responsibility role owner day days hour hours minute minutes second seconds zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million billion budget risk risks audit audits purpose item items issue issues support supporting relevant related also only just now here it its our your his her them we you they he she i me us').split(' '));

function tokenKey(value) {
  const token = value.toLowerCase();
  if (token.length > 4 && /ies$/.test(token)) return token.slice(0, -3) + 'y';
  if (token.length > 4 && /(?:ches|shes|xes|zes|sses)$/.test(token)) return token.slice(0, -2);
  if (token.length > 3 && /s$/.test(token) && !/(?:ss|us|is)$/.test(token)) return token.slice(0, -1);
  return token;
}
const GENERIC_KEYS = new Set([...GENERIC].map(tokenKey));

function words(value) {
  return String(value || '').normalize('NFKD').replace(/\p{M}/gu, '')
    .toLowerCase().match(/[\p{L}][\p{L}\p{N}]+/gu) || [];
}

function sourceNames(options = {}) {
  return new Set([
    ...(Array.isArray(options.sourceUnits) ? options.sourceUnits.map(unit => unit?.speaker) : []),
    ...(Array.isArray(options.people) ? options.people : [])
  ].flatMap(words).map(tokenKey));
}

// Optional agent policy: incidental acquisition/location words cannot name a subject.
const INCIDENTAL = new Set('upon arrival arrive arrived arriving site onsite obtain obtained obtaining receive received receiving'.split(' '));
function subjectTokens(value, names, strict = false) {
  return new Set(words(value).map(tokenKey).filter(token => !GENERIC_KEYS.has(token)
    && !names.has(token) && (!strict || !INCIDENTAL.has(token)) && !/\d/.test(token)));
}

function acronymTokens(value) {
  return new Set((String(value || '').match(/\b[A-Z][A-Z0-9]{2,9}\b/g) || [])
    .map(tokenKey).filter(token => !GENERIC_KEYS.has(token) && !/\d/.test(token)));
}

function unresolved(reason) { return { target: null, status: 'unresolved', reason }; }
function matched(target, reason) { return { target, status: 'matched', reason }; }
const id = value => String(value || '').trim();
const sharedCount = (left, right) => [...left].filter(token => right.has(token)).length;

/** Select an existing parent without changing candidates, prose or evidence.
 * Explicit targets are authoritative only when uniquely resolvable. Fallback
 * requires a distinctive subject match; source citations never choose a host.
 * Unresolved material must be retained separately by the caller.
 */
function selectSupportingDetailParent(detail = {}, candidates = [], options = {}) {
  const rows = (Array.isArray(candidates) ? candidates : []).filter(candidate => candidate?.record);
  const strict = options.subjectPolicy === 'meeting_minutes_v2';
  const acceptExplicit = (target, reason) => {
    if (!strict) return matched(target, reason);
    const checked = selectSupportingDetailParent(detail, [target], { ...options, explicitTarget: '' });
    return checked.target ? matched(target, reason) : unresolved('explicit_target_subject_mismatch');
  };
  const explicitTarget = id(options.explicitTarget ?? detail.mergeTarget ?? detail.targetId ?? detail.primaryId);
  if (explicitTarget) {
    const exact = rows.filter(candidate => id(candidate.record.id) === explicitTarget);
    if (exact.length === 1) return acceptExplicit(exact[0], 'explicit_target');
    if (exact.length > 1) return unresolved('ambiguous_explicit_target');
    const aliases = rows.filter(candidate => (Array.isArray(candidate.record.mergedFromIds)
      ? candidate.record.mergedFromIds : []).some(alias => id(alias) === explicitTarget));
    if (aliases.length === 1) return acceptExplicit(aliases[0], 'explicit_target_alias');
    return unresolved(aliases.length ? 'ambiguous_explicit_target' : 'explicit_target_missing');
  }

  const names = sourceNames(options);
  const detailTokens = subjectTokens(detail.text || detail.action || '', names, strict);
  if (!detailTokens.size) return unresolved('no_subject_match');
  const detailText = detail.text || detail.action || '';
  const detailAcronyms = acronymTokens(detailText);
  const ranked = rows.filter(candidate => !isReviewerAuthored(candidate.record)
    && !(candidate.topic && typeof candidate.topic === 'object' && (isReviewerAuthored(candidate.topic)
      || /^manual-topic-/.test(String(candidate.topic.id || '')))))
    .map(target => {
      const recordText = target.record.text || target.record.action || '';
      const recordTokens = subjectTokens(recordText, names, strict);
      const recordShared = sharedCount(detailTokens, recordTokens);
      const bodyMatch = recordShared >= 2 && recordShared / detailTokens.size >= 0.5
        && recordShared / Math.max(1, recordTokens.size) >= 0.25;
      // A genuinely short technical identifier can be a complete subject.
      // Title words and shared ordinary nouns never receive this exception.
      const acronymMatch = detailTokens.size <= 2 && !/\d/.test(`${detailText} ${recordText}`)
        && [...acronymTokens(recordText)]
        .some(token => detailAcronyms.has(token) && detailTokens.has(token));
      return { target, recordShared, matches: bodyMatch || acronymMatch };
    }).filter(candidate => candidate.matches)
    .sort((left, right) => right.recordShared - left.recordShared);
  if (!ranked.length) return unresolved('no_subject_match');
  if (ranked.length > 1 && ranked[0].recordShared === ranked[1].recordShared) return unresolved('ambiguous_subject_match');
  return matched(ranked[0].target, 'subject_match');
}

module.exports = { selectSupportingDetailParent };
