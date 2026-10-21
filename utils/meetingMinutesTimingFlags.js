'use strict';

const crypto = require('crypto');
const Timing = require('./meetingMinutesTiming');
const { commitmentCanBeRepresented } = require('./canonicalMinutes/commitmentDuplicates');
const { isReviewerAuthored } = require('./canonicalMinutes/state');
const clean = (value, limit = 1600) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const canonical = value => clean(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const ownerKey = row => [...new Set((row.owners || []).map(canonical))].sort().join('|');
const timingValue = value => ({ kind: clean(value?.kind, 30) || 'not_stated', wording: clean(value?.wording, 220), exactDate: clean(value?.exactDate, 20) });
const originSnapshot = row => ({ id: clean(row?.id, 80), action: clean(row?.action), owners: (row?.owners || []).map(value => clean(value, 180)).filter(Boolean).slice(0, 12),
  timing: timingValue(row?.timing), evidenceIds: [...new Set((row?.evidenceIds || []).map(value => clean(value, 30)).filter(Boolean))].slice(0, 12) });

function normaliseSystemTimingIssue(value) {
  if (!value || value.version !== 1 || !/^(?:timing_[a-z_]+|unsupported_(?:date|timing)_wording|source_timing_qualification)$/.test(value.code || '')
    || !value.origin || typeof value.origin.action !== 'string' || !Array.isArray(value.origin.owners)
    || !value.origin.timing || !Array.isArray(value.origin.evidenceIds) || typeof value.originalMessage !== 'string') return null;
  const origin = originSnapshot(value.origin);
  if (!origin.action || !origin.owners.length || !origin.evidenceIds.length) return null;
  return { version: 1, code: value.code, origin, originalMessage: clean(value.originalMessage, 500) };
}

function actionTimingIssueFlag(issue, row, message, options = {}) {
  const before = options.previousTiming ? { ...row, timing: options.previousTiming } : row;
  const origin = originSnapshot(before);
  const value = { version: 1, code: issue.code, origin, originalMessage: clean(message, 500) };
  const systemTimingIssue = normaliseSystemTimingIssue(value);
  return { kind: 'timing', message, evidenceIds: row?.evidenceIds || [],
    ...(systemTimingIssue ? {
      id: `flag-timing-${crypto.createHash('sha256').update(JSON.stringify(systemTimingIssue)).digest('hex').slice(0, 16)}`,
      systemTimingIssue
    } : {}) };
}

function sameWork(left, right) {
  if (!ownerKey(left) || ownerKey(left) !== ownerKey(right)) return false;
  if (!(left.evidenceIds || []).some(id => (right.evidenceIds || []).includes(id))) return false;
  if (canonical(left.action) === canonical(right.action)) return true;
  const untimed = row => ({ ...row, timing: { kind: 'not_stated', wording: '', exactDate: '' } });
  return commitmentCanBeRepresented(untimed(left), untimed(right)) && commitmentCanBeRepresented(untimed(right), untimed(left));
}

function referencedIds(value, found = new Set()) {
  if (!value || typeof value !== 'object') return found;
  if (Array.isArray(value)) { value.forEach(row => referencedIds(row, found)); return found; }
  for (const id of value.reviewFlagIds || []) found.add(id);
  for (const [key, child] of Object.entries(value)) if (key !== 'reviewFlagIds') referencedIds(child, found);
  return found;
}

function reconcileActionTimingWarnings(actions = [], flags = [], units = [], options = {}) {
  const list = Array.isArray(actions) ? actions : [], allFlags = Array.isArray(flags) ? flags : [];
  const protectedReferences = referencedIds([options.proposals || [], options.otherRecords || []]);
  const knownEvidence = new Set((units || []).filter(unit => unit.classification !== 'remove' || unit.restored).map(unit => unit.id));
  const retired = [];
  const untouched = flag => flag.status === 'open' && !clean(flag.correctionNote, 500)
    && !isReviewerAuthored(flag) && flag.message === flag.systemTimingIssue?.originalMessage;
  for (const flag of allFlags) {
    const issue = normaliseSystemTimingIssue(flag.systemTimingIssue);
    if (!issue || !untouched(flag) || protectedReferences.has(flag.id)
      || !['timing_inference_unresolved', 'timing_source_unresolved'].includes(issue.code)) continue;
    if (list.some(row => (row.reviewFlagIds || []).includes(flag.id)
      && (isReviewerAuthored(row) || !sameWork(issue.origin, row)))) continue;
    const candidates = list.filter(row => !isReviewerAuthored(row) && sameWork(issue.origin, row));
    if (!candidates.length) continue;
    // If one equivalent live record remains unresolved, its warning is still
    // useful. A supported sibling is never sufficient to clear that warning.
    const reasons = candidates.map(row => {
      const decision = row.timingDecision;
      if (!Timing.assessmentMatches(row, units, options.meetingDate, decision)) return '';
      if (issue.code === 'timing_inference_unresolved') {
        if (!['verified', 'qualified'].includes(decision.status) || !row.timing?.wording && !row.timing?.exactDate) return '';
        const binding = Timing.assessTimingSourceBinding(row, units, { meetingDate: options.meetingDate });
        return binding.status === 'supported' ? 'own_timing_now_source_supported' : '';
      }
      const oldWording = issue.origin.timing.wording;
      if (!oldWording || row.timing?.wording || row.timing?.exactDate || row.timing?.kind !== 'not_stated'
        || decision.status !== 'rejected' || !(decision.rejectedWordings || []).some(value => canonical(value) === canonical(oldWording))) return '';
      const removal = allFlags.find(notice => notice.id !== flag.id && notice.status === 'open'
        && notice.kind === 'timing' && normaliseSystemTimingIssue(notice.systemTimingIssue)?.code === 'timing_value_removed'
        && (row.reviewFlagIds || []).includes(notice.id) && (notice.evidenceIds || []).some(id => knownEvidence.has(id))
        && sameWork(issue.origin, notice.systemTimingIssue.origin)
        && canonical(notice.systemTimingIssue.origin.timing.wording) === canonical(oldWording));
      return removal ? 'old_wording_removed_with_current_source_notice' : '';
    });
    if (reasons.every(Boolean)) retired.push({ id: flag.id, code: issue.code, reason: reasons[0], actionIds: candidates.map(row => row.id || '') });
  }
  const ids = new Set(retired.map(row => row.id));
  const cleanRefs = value => {
    if (Array.isArray(value)) return value.map(cleanRefs);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, key === 'reviewFlagIds' && Array.isArray(child) ? child.filter(id => !ids.has(id)) : cleanRefs(child)]));
  };
  return { actions: cleanRefs(list), flags: allFlags.filter(flag => !ids.has(flag.id)), retired };
}

module.exports = { normaliseSystemTimingIssue, actionTimingIssueFlag, reconcileActionTimingWarnings };
