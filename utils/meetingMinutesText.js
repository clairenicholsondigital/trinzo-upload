'use strict';

const { convertSpokenNumbers } = require('./spokenNumbers');

// Shared presentation text helpers; kept independent of generation workflows.
const { normaliseFixedPersonAliases } = require('./entityNormalization');
const { normaliseDomainTerms } = require('./domainTerms');

const MDSAP_SPOKEN_FORM = /\b(?:medsap|meds[\s-]*app)\b/i;
const HALF_HOUR_SPOKEN_FORM = /\bhalf(?:[\s-]+past)?[\s-]+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d{1,2})\b/i;
const HOUR_VALUES = Object.freeze({
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12
});

function normaliseColloquialTimes(value) {
  return String(value == null ? '' : value).replace(new RegExp(HALF_HOUR_SPOKEN_FORM.source, 'gi'), (match, spokenHour) => {
    const hour = HOUR_VALUES[String(spokenHour).toLowerCase()] || Number(spokenHour);
    return hour >= 1 && hour <= 12 ? `${hour}:30` : match;
  });
}

function normaliseKnownTerms(value) {
  // Deterministic domain correction: this transcription variant must never reach a
  // reviewer-facing field, flag, export or persisted minutes payload.
  return normaliseDomainTerms(normaliseFixedPersonAliases(normaliseColloquialTimes(value)))
    .replace(/\bmeds[\s-]*app\b/gi, 'MDSAP');
}

function normaliseKnownTermsDeep(value) {
  if (typeof value === 'string') return normaliseKnownTerms(value);
  if (Array.isArray(value)) return value.map(normaliseKnownTermsDeep);
  if (value && typeof value === 'object') {
    if (value instanceof Date) return value;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return value;
    // Filing origins are historical records, never presentation prose.
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      key === 'occurrenceId' || key === 'keptActionOccurrenceIds' || key === 'filingOrigins' ? item : normaliseKnownTermsDeep(item)]));
  }
  return value;
}

function isAutomaticTerminologyFlag(flag = {}) {
  const message = String(flag.message || flag.text || '');
  const resolvedColloquialTime = HALF_HOUR_SPOKEN_FORM.test(message)
    && /\b(?:without (?:a )?(?:fully |completely )?specified timestamp|time (?:was|is) (?:not fully specified|unclear)|confirm (?:the )?time)\b/i.test(message);
  return MDSAP_SPOKEN_FORM.test(message) || resolvedColloquialTime;
}

function text(value, max = 2000) {
  return normaliseKnownTerms(value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function salientExcerpt(value, pattern) {
  const source = text(value, 5000);
  const sentences = source.split(/(?<=[.!?])\s+/).filter(Boolean);
  const sentence = sentences.find((part) => pattern.test(part)) || source;
  if (sentence.length <= 360) return sentence;
  const match = sentence.search(pattern);
  if (match < 0) return sentence.slice(0, 360);
  let start = Math.max(0, match - 140);
  if (start) {
    const nextBoundary = sentence.indexOf(' ', start);
    if (nextBoundary > start && nextBoundary < match) start = nextBoundary + 1;
  }
  const end = Math.min(sentence.length, match + 220);
  return `${start ? '…' : ''}${sentence.slice(start, end).trim()}${end < sentence.length ? '…' : ''}`;
}

function isIdeaOnlyContemplation(value) {
  const action = text(value, 2000).toLowerCase();
  const exploratory = /\b(?:think|thinking|consider|considering)\s+(?:about|through|of)\b/.test(action)
    || /\b(?:come back|return|bring)\b[^.]{0,90}\b(?:idea|ideas|thought|thoughts)\b/.test(action);
  if (!exploratory) return false;
  if (!/\b(?:idea|ideas|thought|thoughts|possibilit(?:y|ies)|options?)\b/.test(action)) return false;
  return !/\b(?:analysis|assessment|decision|document|draft|plan|recommendation|report|specification|test results?|written proposal)\b/.test(action);
}

function cleanActionWording(value = '') {
  let source = convertSpokenNumbers(text(value, 1600)).text;
  // Ownership is stored separately from the action. When a named owner says they will
  // "determine/work out a way to" perform a concrete deliverable, retain the deliverable
  // as the reviewer-facing action rather than publishing the planning wrapper and owner
  // twice. Do not simplify "determine the scope" or "determine whether...": those are
  // genuine resolution tasks, not wrappers around an already named deliverable.
  const concreteVerb = '(?:provide|share|send|arrange|prepare|review|update|complete|confirm|create|draft|submit|deliver|secure|obtain|compile|circulate|schedule|book|check|resolve|clarify|coordinate|discuss|organise|organize)';
  const ownedWrapper = new RegExp(`^(?:(?:I|we|you|he|she|they)\\b|(?:[A-Z][\\p{L}'’.-]+(?:\\s+[A-Z][\\p{L}'’.-]+){0,3}))\\s+(?:will|shall)\\s+(?:determine|work out|figure out|find)\\s+(?:a|the)\\s+(?:way|method|approach|route)\\s+to\\s+(${concreteVerb}\\b.+)$`, 'iu');
  const wrapped = source.match(ownedWrapper);
  if (wrapped) source = wrapped[1].charAt(0).toUpperCase() + wrapped[1].slice(1);
  else {
    const bareWrapper = new RegExp(`^(?:determine|work out|figure out|find)\\s+(?:a|the)\\s+(?:way|method|approach|route)\\s+to\\s+(${concreteVerb}\\b.+)$`, 'i');
    const bare = source.match(bareWrapper);
    if (bare) source = bare[1].charAt(0).toUpperCase() + bare[1].slice(1);
  }
  // Remove tautological scaffolding while retaining every deliverable:
  // "Implement a system to implement X and add Y" ->
  // "Implement a system for X and add Y".
  return source.replace(/^(Implement\s+(?:an?|the)\s+[^.;]{1,100}?)\s+to implement\s+(.+)$/i, '$1 for $2');
}

function normaliseExecutiveSummary(value) {
  return text(value, 3000);
}

// Evidence flags name their item, so flags for different items never merge (a
// new unsupported item always gets its own open flag, even when an earlier
// item with the same problem was resolved).
function recordLabel(record = {}) {
  const value = text(record.action || record.text, 400);
  return value.length > 90 ? `${value.slice(0, 87).replace(/\s+\S*$/, '')}…` : value;
}

module.exports = {
  normaliseColloquialTimes,
  normaliseKnownTerms,
  normaliseKnownTermsDeep,
  isAutomaticTerminologyFlag,
  text,
  cleanActionWording,
  isIdeaOnlyContemplation,
  normaliseExecutiveSummary,
  recordLabel,
  salientExcerpt
};
