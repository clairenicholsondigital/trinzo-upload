'use strict';

const { text, isAutomaticTerminologyFlag } = require('./meetingMinutesText');
const { stableId } = require('./meetingMinutesRecordMatching');
const { normaliseSystemTimingIssue } = require('./meetingMinutesTimingFlags');
const { isReviewerAuthored } = require('./canonicalMinutes/state');


const FLAG_KINDS = new Set([
  'uncertain_fact', 'unclear_reference', 'ownership', 'attribution', 'timing',
  'unresolved_decision', 'missing_evidence', 'possible_missed_follow_up'
]);
const FLAG_KIND_ALIASES = Object.freeze({
  ownership_uncertain: 'ownership',
  timing_uncertain: 'timing',
  unresolved_question: 'unresolved_decision',
  uncertain_reference: 'unclear_reference'
});
const COVERAGE_FLAG_MESSAGE = 'Check whether this important transcript detail should appear in the minutes:';
const MATERIAL_UNCERTAINTY_PATTERN = /\b(?:ambiguous|ambiguity|unclear wording|conflict(?:ing)?|inconsisten|inaudible|cannot (?:determine|identify|verify)|could not (?:determine|identify|verify)|uncertain (?:wording|reference|identity|value)|multiple (?:possible|plausible)|not (?:clear|clarified) (?:which|whether|who|what))\b/i;

function normaliseDocumentReferenceContext(value) {
  if (!value || value.kind !== 'adjacent_identity_context') return null;
  const ids = key => [...new Set((Array.isArray(value[key]) ? value[key] : [])
    .filter(id => typeof id === 'string' && /^T\d{4,}$/.test(id)))].slice(0, 8);
  const originalEvidenceIds = ids('originalEvidenceIds'), addedEvidenceIds = ids('addedEvidenceIds'), workEvidenceIds = ids('workEvidenceIds');
  if (!originalEvidenceIds.length || addedEvidenceIds.length !== 1 || workEvidenceIds.length !== 1
    || addedEvidenceIds.some(id => originalEvidenceIds.includes(id)) || !originalEvidenceIds.includes(workEvidenceIds[0])) return null;
  return { kind: 'adjacent_identity_context', originalEvidenceIds, addedEvidenceIds, workEvidenceIds,
    ...(/^(?:ISO|IEC|ASTM|EN|BS)$/.test(value.unstatedPrefix || '') ? { unstatedPrefix: value.unstatedPrefix } : {}) };
}

function normaliseSourceReviewContext(value) {
  if (value?.kind !== 'assessment_ownership_notice'
    || !['unsupported_ownership', 'unsupported_owner'].includes(value.originalType)) return null;
  const originalMessage = text(value.originalMessage, 500);
  const originalEvidenceIds = [...new Set((Array.isArray(value.originalEvidenceIds) ? value.originalEvidenceIds : [])
    .filter(id => typeof id === 'string' && /^T\d{4,}$/.test(id)))].slice(0, 8);
  return originalMessage && originalEvidenceIds.length
    ? { kind: 'assessment_ownership_notice', originalType: value.originalType, originalMessage, originalEvidenceIds } : null;
}

function normaliseFlag(flag = {}, index = 0) {
  const suppliedKind = text(flag.kind || flag.type, 80).toLowerCase();
  const aliasedKind = FLAG_KIND_ALIASES[suppliedKind] || suppliedKind;
  const kind = FLAG_KINDS.has(aliasedKind) ? aliasedKind : 'uncertain_fact';
  const message = text(flag.message || flag.text || 'Review this item against the transcript.', 500);
  const systemTimingIssue = normaliseSystemTimingIssue(flag.systemTimingIssue);
  const documentReferenceContext = normaliseDocumentReferenceContext(flag.documentReferenceContext);
  const sourceReviewContext = normaliseSourceReviewContext(flag.sourceReviewContext);
  return rememberFlag({
    id: text(flag.id, 80) || (systemTimingIssue ? stableId('flag-timing', JSON.stringify(systemTimingIssue), 0) : stableId('flag', `${kind}|${message}`, index)),
    kind,
    message,
    ...(text(flag.actionWordingAtCheck, 1600) ? { actionWordingAtCheck: text(flag.actionWordingAtCheck, 1600) } : {}),
    // Group materialization notices already carry up to twenty source anchors.
    // Keep that bounded passage intact through save/reload; ordinary flags keep
    // their existing citation budget. This does not certify action coverage.
    evidenceIds: [...new Set((Array.isArray(flag.evidenceIds) ? flag.evidenceIds : []).map((id) => text(id, 30)).filter(Boolean))]
      .slice(0, flag.reviewDisposition === 'coverage_unresolved' ? 20 : 8),
    status: ['open', 'confirmed', 'corrected', 'dismissed'].includes(flag.status) ? flag.status : 'open',
    correctionNote: text(flag.correctionNote, 500),
    ...(isReviewerAuthored(flag) ? { reviewerAuthored: true } : {}),
    ...(systemTimingIssue ? { systemTimingIssue } : {}),
    ...(documentReferenceContext ? { documentReferenceContext } : {}),
    ...(sourceReviewContext ? { sourceReviewContext } : {}),
    ...(['not_applied_addition','not_applied_noop','not_applied_duplicate','not_outstanding','coverage_unresolved'].includes(flag.reviewDisposition) ? {reviewDisposition:flag.reviewDisposition} : {}),
    ...(['executiveSummary', 'meetingObjectives', 'timedStepCoverage'].includes(flag.temporalField)
      ? { temporalField: flag.temporalField } : {})
  });
}

// Many pipeline steps re-normalise records and keep only the records, so a
// flag created on the way (and referenced by the record's reviewFlagIds) was
// dropped while the reference survived. Every flag is remembered here by id so
// a stage can recover what its records point at. Bounded; oldest go first.
const FLAG_REGISTRY = new Map();
const FLAG_REGISTRY_LIMIT = 20000;
function rememberFlag(flag) {
  FLAG_REGISTRY.delete(flag.id);
  FLAG_REGISTRY.set(flag.id, flag);
  if (FLAG_REGISTRY.size > FLAG_REGISTRY_LIMIT) FLAG_REGISTRY.delete(FLAG_REGISTRY.keys().next().value);
  return flag;
}

function flagRecordsIn(value, out = []) {
  if (Array.isArray(value)) { for (const item of value) flagRecordsIn(item, out); return out; }
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value.reviewFlagIds)) out.push(value);
  for (const key of ['points', 'decisions', 'openQuestions', 'supportingDetails', 'actions', 'discussion']) {
    if (Array.isArray(value[key])) flagRecordsIn(value[key], out);
  }
  return out;
}

// Returns the flags the records point at (recovered where they were dropped)
// and strips references that cannot be resolved. Mutates only copies.
// Owners a removal/change warning says were taken off. Later merges can put an
// owner back, which left "…so it was removed" beside the very name it named.
function ownersNamedAsRemoved(message = '') {
  const text = String(message || '');
  const match = text.match(/does not show (.+?) taking this on, so it was removed/i)
    || text.match(/\bnot (.+?)\. Confirm the owner\./i)
    || text.match(/^Owner removed: (.+?) only asked/i);
  return match ? match[1].split(/\s+or\s+/).map((name) => name.trim().toLowerCase()).filter(Boolean) : [];
}

function reconcileRecordFlags(content = {}, flags = [], isUseful = () => true) {
  const copy = JSON.parse(JSON.stringify(content || {}));
  const byId = new Map((Array.isArray(flags) ? flags : []).map((flag) => [flag.id, flag]));
  const recovered = [];
  const contradicted = new Set();
  for (const record of flagRecordsIn(copy)) {
    const owners = (Array.isArray(record.owners) ? record.owners : []).map((owner) => String(owner).trim().toLowerCase());
    if (!owners.length || !Array.isArray(record.reviewFlagIds)) continue;
    record.reviewFlagIds = record.reviewFlagIds.filter((id) => {
      const flag = byId.get(id) || FLAG_REGISTRY.get(id);
      const named = flag && flag.kind === 'ownership' ? ownersNamedAsRemoved(flag.message) : [];
      if (named.length && named.every((name) => owners.includes(name))) { contradicted.add(id); return false; }
      return true;
    });
  }
  for (const id of contradicted) {
    const stillUsed = flagRecordsIn(copy).some((record) => (record.reviewFlagIds || []).includes(id));
    if (!stillUsed) byId.delete(id);
  }
  flags = (Array.isArray(flags) ? flags : []).filter((flag) => byId.has(flag.id));
  for (const record of flagRecordsIn(copy)) {
    record.reviewFlagIds = [...new Set(record.reviewFlagIds)].filter((id) => {
      if (byId.has(id)) return true;
      const remembered = FLAG_REGISTRY.get(id);
      if (!remembered || !isUseful(remembered)) return false;
      byId.set(id, remembered);
      recovered.push(remembered);
      return true;
    });
  }
  return { content: copy, flags: [...(Array.isArray(flags) ? flags : []), ...recovered], recovered: recovered.length };
}

// Agent cleanup must see the same actionable warning state as publication.
// Leave the shared reconciler's default treatment of supplied flags unchanged.
function reconcileUsefulRecordFlags(content = {}, flags = [], isUseful = isUsefulReviewFlag) {
  return reconcileRecordFlags(content, (Array.isArray(flags) ? flags : []).filter(isUseful), isUseful);
}

function isSalientCoverageFlag(flag = {}) {
  return /^coverage-detail-/i.test(String(flag.id || ''))
    || String(flag.message || flag.text || '').startsWith(COVERAGE_FLAG_MESSAGE);
}

// A supported statement can itself say that something is pending, conditional or
// undecided. That is meeting content, not uncertainty about the extraction. Keep
// `uncertain_fact` for genuinely ambiguous/conflicting source wording; the other
// flag kinds already cover owners, timing, references and missing evidence.
function isUsefulReviewFlag(flag = {}) {
  if (isAutomaticTerminologyFlag(flag)) return false;
  const normalised = normaliseFlag(flag);
  if (isSalientCoverageFlag(flag)) {
    return /^coverage-detail-/i.test(String(flag.id || ''))
      || normalised.status !== 'open' || Boolean(normalised.correctionNote);
  }
  // Unsupported owner/timing fields are removed before the draft reaches the
  // reviewer. Asking somebody to confirm a value which is no longer present is
  // duplicate work, not a useful warning. Genuine ambiguity/conflict flags use
  // different wording and remain visible.
  if (['ownership', 'timing'].includes(normalised.kind)
    && /^(?:confirm or correct unsupported action|the exact date .+ was not supported .+ and has been removed)/i.test(normalised.message)
    && normalised.status === 'open' && !normalised.correctionNote) return false;
  if (normalised.kind !== 'uncertain_fact') return true;
  if (normalised.status !== 'open' || normalised.correctionNote) return true;
  // The quantified-claim gate creates these only when the source does not bind
  // a stated location/duration to the named work. Its typed uncertainty must
  // survive save/publication regardless of the warning's prose wording.
  if (/^flag-quantity-binding-/.test(String(normalised.id || ''))) return true;
  // A fidelity checker could not establish a safe replacement. Its typed
  // warning must survive independently of the provider's choice of prose.
  if (/^flag-fidelity-meaning-/.test(String(normalised.id || ''))) return true;
  return MATERIAL_UNCERTAINTY_PATTERN.test(normalised.message);
}

function reviewFlagContentKey(flag) {
  return JSON.stringify([
    flag.kind.toLowerCase(), flag.message.toLowerCase(), flag.evidenceIds.map(id => id.toLowerCase()).sort(),
    flag.reviewerAuthored === true, flag.systemTimingIssue || null, flag.temporalField || '', flag.documentReferenceContext || null, flag.sourceReviewContext || null
  ]);
}

function reviewFlagIdentityKey(flag) {
  // Handled or annotated warnings keep their own identities even if two
  // reviewers happened to choose the same status and note for separate rows.
  const untouched = flag.status === 'open' && !flag.correctionNote && !flag.reviewerAuthored;
  return JSON.stringify([reviewFlagContentKey(flag), flag.status, flag.correctionNote, untouched ? '' : flag.id, flag.actionWordingAtCheck || '']);
}

function uniqueFlags(flags = [], suppliedCount = flags.length, records = [], originalReferences = new Map()) {
  const supplied = flags.slice(0, suppliedCount);
  const suppliedIds = new Set(supplied.map(flag => flag.id));
  const alias = new Map();
  const retained = flags.filter((flag, index) => {
    if (index < suppliedCount) return true;
    const targets = records.filter(record => record.reviewFlagIds.includes(flag.id));
    const matching = supplied.filter(prior => reviewFlagContentKey(prior) === reviewFlagContentKey(flag)
      && (!prior.actionWordingAtCheck || !flag.actionWordingAtCheck || prior.actionWordingAtCheck === flag.actionWordingAtCheck)
      && (!suppliedIds.has(flag.id) || prior.id === flag.id)
      && targets.length && targets.every(record => originalReferences.get(record)?.has(prior.id)));
    // Content alone is insufficient: another incoming row may still need the
    // same warning. Reuse a decision only when its existing target is known.
    if (matching.length !== 1) return true;
    if (flag.id !== matching[0].id) alias.set(flag.id, matching[0].id);
    return false;
  });
  const kept = new Map();
  const reviewFlags = retained.filter(flag => {
    const key = reviewFlagIdentityKey(flag);
    if (kept.has(key)) {
      if (flag.id !== kept.get(key)) alias.set(flag.id, kept.get(key));
      return false;
    }
    kept.set(key, flag.id);
    return true;
  });
  // normaliseFlag remembers generated copies too; restore the persisted
  // review state if such a copy reused an existing warning's deterministic id.
  reviewFlags.forEach(rememberFlag);
  return { reviewFlags, alias };
}

module.exports = {
  normaliseFlag,
  reconcileRecordFlags,
  reconcileUsefulRecordFlags,
  isSalientCoverageFlag,
  isUsefulReviewFlag,
  flagRecordsIn,
  uniqueFlags,
  COVERAGE_FLAG_MESSAGE
};
