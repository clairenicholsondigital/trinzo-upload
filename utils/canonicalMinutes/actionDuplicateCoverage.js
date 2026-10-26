'use strict';

const { isReviewerAuthored } = require('./state');

// This is a proof of preserved wording, not another similarity detector.
// Whole clauses must survive verbatim (apart from case, spacing and terminal
// punctuation), with the same responsibility and timing. In particular, IDs,
// shared nouns and a shared citation do not prove that one task contains another.
function actionText(value = '') {
  return String(value || '').normalize('NFKC').replace(/[’]/g, "'")
    .replace(/\s+/g, ' ').trim().replace(/[.!;]+$/, '').trim().toLowerCase();
}

function ownerKey(record = {}) {
  return [...new Set((record.owners || []).map(actionText).filter(Boolean))].sort().join('|');
}

function timingKey(record = {}) {
  const timing = record.timing || {};
  if (!timing.kind || timing.kind === 'not_stated') return '';
  // A weekday can take an optional "on" without changing this occurrence.
  // Compare that spelling only; preserve every other timing word, its kind and
  // exact date, and leave the retained record's wording/verification untouched.
  // Quoted/introduced wording may name a plan rather than a day, and a
  // weekday possessive may be part of that name. Do not reinterpret either.
  const literalWording = actionText(timing.wording);
  const wording = QUOTED_OR_INTRODUCED.test(literalWording.replace(/‘/g, "'")) ? literalWording
    : literalWording.replace(/\bon\s+(?=(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b(?!'))/g, '');
  return [timing.kind, wording, String(timing.exactDate || '').trim()].join('|');
}

// Identify exactly the newly equivalent timing spellings, so presentation
// dedupers still require a preserved-instruction proof before using them.
function timingsDifferOnlyByWeekdayPreposition(left = {}, right = {}) {
  const key = timingKey(left);
  return Boolean(key && key === timingKey(right)
    && actionText(left.timing?.wording) !== actionText(right.timing?.wording));
}

function conflictingTimings(left = {}, right = {}) {
  const a = timingKey(left); const b = timingKey(right);
  return Boolean(a && b && a !== b);
}

function sameActionText(left = {}, right = {}) {
  const a = actionText(left.action); const b = actionText(right.action);
  return Boolean(a && a === b);
}

// A review "on Wednesday" and the same review "Wednesday before the
// Thursday meeting" can be two descriptions of one occurrence. Admit the
// longer context only when a citation shared by both rows explicitly states
// both the review day and the later meeting day. No inferred calendar dates.
function sourceBoundReviewTimingContext(left = {}, right = {}, sourceUnits = []) {
  if (isReviewerAuthored(left) || isReviewerAuthored(right)
    || !sameActionText(left, right) || !ownerKey(left) || ownerKey(left) !== ownerKey(right)
    || !/^review\b/.test(actionText(left.action))) return null;
  const a = left.timing || {}; const b = right.timing || {};
  if (a.kind !== 'target' || b.kind !== 'target' || a.exactDate || b.exactDate) return null;
  const weekday = '(monday|tuesday|wednesday|thursday|friday|saturday|sunday)';
  const short = new RegExp(`^(?:on )?${weekday}$`);
  const long = new RegExp(`^(?:on )?${weekday} before the ${weekday} meeting$`);
  const parse = (shortRow, longRow) => {
    const day = actionText(shortRow.timing.wording).match(short);
    const context = actionText(longRow.timing.wording).match(long);
    if (!day || !context || day[1] !== context[1] || day[1] === context[2]) return null;
    const shared = new Set((shortRow.evidenceIds || []).map(String));
    return sourceUnits.some(unit => shared.has(String(unit.id))
      && (longRow.evidenceIds || []).some(id => String(id) === String(unit.id))
      && new RegExp(`\\breview\\b[^.!?]{0,100}\\b(?:on )?${day[1]}\\b[^.!?]{0,100}`
        + `\\b(?:then|before|by the time)\\b[^.!?]{0,100}\\bmeeting\\b[^.!?]{0,100}`
        + `\\b(?:on )?${context[2]}\\b`, 'i').test(unit.text || ''))
      ? longRow : null;
  };
  return parse(left, right) || parse(right, left);
}

// The same sentence can legitimately describe two people's work or two dated
// occurrences. Do not let an "identical text" shortcut discard that distinction.
function exactActionIdentityConflict(left = {}, right = {}) {
  return sameActionText(left, right) && (ownerKey(left) !== ownerKey(right)
    || conflictingTimings(left, right)
    || isReviewerAuthored(left) || isReviewerAuthored(right));
}

// Only independently phrased imperative clauses qualify. Requests, questions,
// intentions and clauses whose scope depends on an earlier condition stay with
// the ordinary conservative review path. No synonym or transcript vocabulary
// is introduced here.
const DIRECT_VERBS = 'add|archive|book|build|circulate|collect|compile|complete|copy|create|delete|deliver|draft|email|file|fix|install|notify|order|prepare|print|publish|record|remove|repair|replace|restore|review|revise|schedule|send|share|submit|test|update|upload|write';
const CLAUSE_START = new RegExp(`^(?:${DIRECT_VERBS})\\b`, 'i');
const CLAUSE_BREAK = new RegExp(`\\s*;\\s*(?:and\\s+)?|\\s*,\\s*(?:and\\s+)?(?=(?:${DIRECT_VERBS})\\b)|\\s+and\\s+(?=(?:${DIRECT_VERBS})\\b)`, 'i');
const SCOPING_LANGUAGE = /\b(?:if|unless|after|before|once|when|until|pending|following|then|otherwise|without|except|whether|provided|subject to|as soon as|in case|only|not|never|by|during|within|on|at|today|tomorrow|tonight|later|next|first|prior|earlier|subsequently|mornings?|afternoons?|evenings?|seconds?|minutes?|hours?|days?|weeks?|months?|years?|daily|weekly|monthly|quarterly|annually|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)\b/i;
const QUOTED_OR_INTRODUCED = /["“”:()[\]{}]|(?:^|\W)'[^']+'(?=\W|$)/;
const EMBEDDED_INSTRUCTION = new RegExp(`\\bto\\s+(?:${DIRECT_VERBS})\\b`, 'i');
// Conjunctions inside reported wording are not independent commitments, even
// when the transcript/model omitted quotation marks around the instruction.
const REPORTED_WORDING = /\b(?:that|which|says?|said|saying|states?|stated|stating|instructions?|wording|requests?|questions?)\b/i;

function directClauses(value = '') {
  const clauses = actionText(value).split(CLAUSE_BREAK).map(actionText).filter(Boolean);
  return clauses.length > 1 && clauses.every((clause) => CLAUSE_START.test(clause)) ? clauses : [];
}

function completeClauseContained(part = {}, whole = {}) {
  const value = actionText(part.action);
  return Boolean(value && value !== actionText(whole.action)
    && directClauses(whole.action).includes(value));
}

function actionIsLosslesslyCovered(part = {}, whole = {}) {
  if (isReviewerAuthored(part) || isReviewerAuthored(whole) || ownerKey(part) !== ownerKey(whole)) return false;
  const a = actionText(part.action); const b = actionText(whole.action);
  if (!a || !b) return false;
  const partTiming = timingKey(part); const wholeTiming = timingKey(whole);
  if (a === b) {
    // An identical untimed extraction can be represented by its dated version;
    // a dated extraction cannot be represented by an undated or conflicting one.
    return !partTiming || partTiming === wholeTiming;
  }
  // Dates attached to a whole compound must not be donated to one of its steps,
  // or vice versa. Untimed compounds only are eligible for this narrow proof.
  if (partTiming || wholeTiming || !ownerKey(part)) return false;
  if (QUOTED_OR_INTRODUCED.test(a) || QUOTED_OR_INTRODUCED.test(b)) return false;
  const evidence = new Set(part.evidenceIds || []);
  if (!(whole.evidenceIds || []).some((id) => evidence.has(id))) return false;
  const clauses = directClauses(b);
  if (!clauses.length || !CLAUSE_START.test(a)) return false;
  const index = clauses.indexOf(a);
  if (index < 0) return false;
  // A qualifier in an earlier/later clause may govern the entire instruction.
  // Keep both rows rather than guessing its scope. A qualifier in the matched
  // clause itself is retained exactly and is therefore safe.
  return clauses.every((clause, at) => at === index
    || (!SCOPING_LANGUAGE.test(clause) && !EMBEDDED_INSTRUCTION.test(clause)
      && !REPORTED_WORDING.test(clause)));
}

// A deliberately bounded extension for editing instructions already recognised
// by the duplicate passes. Only the lead editing predicate can vary; every word
// naming the object, recipient, quantity, condition or additional operation must
// survive in the same order. This is directional coverage, not similarity.
function actionIsSafelyCovered(part = {}, whole = {}) {
  if (actionIsLosslesslyCovered(part, whole)) return true;
  if (isReviewerAuthored(part) || isReviewerAuthored(whole)) return false;
  const owner = ownerKey(part);
  if (!owner || owner !== ownerKey(whole)) return false;
  const partTiming = timingKey(part); const wholeTiming = timingKey(whole);
  if (partTiming && partTiming !== wholeTiming) return false;
  const imperative = (record) => actionText(record.action).match(/^([a-z-]+)\s+(?:the\s+)?(.+)$/);
  const requiredInstruction = imperative(part); const retainedInstruction = imperative(whole);
  if (requiredInstruction && retainedInstruction
    && requiredInstruction[1] === retainedInstruction[1] && requiredInstruction[2] === retainedInstruction[2]) {
    const evidence = new Set(part.evidenceIds || []);
    return (whole.evidenceIds || []).some((id) => evidence.has(id));
  }
  const body = (record) => actionText(record.action)
    .match(/^(?:update|revise|amend|edit)\s+((?:the|a|an|this|that|these|those|our|your|their)\s+.+)$/)?.[1] || '';
  const required = body(part); const retained = body(whole);
  if (!required || required !== retained) return false;
  const evidence = new Set(part.evidenceIds || []);
  return (whole.evidenceIds || []).some((id) => evidence.has(id));
}

// A looser downstream comparison must not overturn a refused proof for an
// otherwise exact clause. It may have been refused because an owner, date,
// quotation or condition makes the apparent containment unsafe.
function actionContainmentConflict(left = {}, right = {}) {
  return (completeClauseContained(left, right) && !actionIsLosslesslyCovered(left, right))
    || (completeClauseContained(right, left) && !actionIsLosslesslyCovered(right, left));
}

module.exports = {
  actionIsLosslesslyCovered, actionIsSafelyCovered, exactActionIdentityConflict, sameActionText,
  conflictingTimings, timingsDifferOnlyByWeekdayPreposition, actionContainmentConflict,
  sourceBoundReviewTimingContext
};
