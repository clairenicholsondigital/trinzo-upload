'use strict';

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

module.exports = { normaliseColloquialTimes, normaliseKnownTerms, normaliseKnownTermsDeep, isAutomaticTerminologyFlag, text };
