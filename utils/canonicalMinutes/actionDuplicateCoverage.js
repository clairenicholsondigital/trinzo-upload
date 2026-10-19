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
  return [timing.kind, actionText(timing.wording), String(timing.exactDate || '').trim()].join('|');
}

function conflictingTimings(left = {}, right = {}) {
  const a = timingKey(left); const b = timingKey(right);
  return Boolean(a && b && a !== b);
}

function sameActionText(left = {}, right = {}) {
  const a = actionText(left.action); const b = actionText(right.action);
  return Boolean(a && a === b);
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
  conflictingTimings, actionContainmentConflict
};
