'use strict';

const { ACTION_VERB_GROUPS } = require('./meetingMinutesActionEvidence');
const {
  actionSubjectWords, ownerIdentityKey, normaliseOwnerIdentity, OWNER_FIRST_PERSON
} = require('./meetingMinutesPeopleEvidence');
const { COMMON_SPEECH_WORDS } = require('./meetingMinutesRecordMatching');

const ACTION_PREDICATE_ALIASES = [
  [/(?:^|\s)(?:review|investigate|check|assess)(?:\s|$)/i, /\b(?:review|investigate|check|assess|have a look|look into)\b/i],
  [/(?:^|\s)(?:send|email|share|forward|circulate)(?:\s|$)/i, /\b(?:send|email|share|forward|circulate)\b/i],
  [/(?:^|\s)(?:contact|call|ring|message)(?:\s|$)/i, /\b(?:contact|call|ring|message|reach out)\b/i],
  [/(?:^|\s)(?:prepare|create|draft|write|build)(?:\s|$)/i, /\b(?:prepare|create|draft|write|build|put together)\b/i]
];

function predicateSupportsAction(action, source) {
  return ACTION_PREDICATE_ALIASES.some(([actionPattern, sourcePattern]) =>
    actionPattern.test(String(action || '')) && sourcePattern.test(String(source || '')));
}

function quoteText(value) {
  return String(value || '').toLowerCase().replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
}

const ABOUT_STOP = new Set(['with', 'that', 'this', 'then', 'from', 'into', 'their', 'about', 'will', 'have', 'been', 'just', 'kind', 'look', 'make', 'sure', 'what', 'when', 'where', 'which', 'also', 'there', 'they', 'your', 'need', 'needs', 'able', 'going', 'gonna', 'okay', 'yeah', 'week', 'next']);

function aboutWords(value) {
  return new Set((String(value || '').toLowerCase().match(/[a-z0-9][a-z0-9'-]{3,}/g) || [])
    .filter((word) => !ABOUT_STOP.has(word))
    .map((word) => word.replace(/'s$/, '').replace(/(?:ing|ed|es|s)$/, '').replace(/e$/, ''))
    .filter((word) => word.length >= 4));
}

function commitmentQuoteAboutAction(quote = '', action = '', passage = '') {
  const lines = String(passage || '').split('\n');
  const said = quoteText(quote);
  const carrying = lines.filter((line) => decisionQuoteFound(quote, line) || quoteText(line).includes(said.slice(0, 40)));
  const source = aboutWords([quote, ...carrying].join(' '));
  const target = aboutWords(action);
  let shared = 0;
  for (const word of target) if (source.has(word)) shared += 1;
  return shared >= 2;
}

const FUTURE_MARKER = /\b(?:today|tonight|tomorrow|this (?:morning|afternoon|evening|week)|next (?:week|month)|by (?:monday|tuesday|wednesday|thursday|friday|the end|end of|close of)|before|after|once|when|as soon as|later|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;

const HABITUAL_PROMISE = /\bi(?:['’]ll\s+(?:always|usually|normally|routinely|generally)|\s+(?:will\s+(?:always|usually|normally|routinely|generally)|(?:always|usually|normally|routinely|generally)\s+will))\b/i;

function isHabitualPromise(value = '') {
  return HABITUAL_PROMISE.test(String(value)) && !FUTURE_MARKER.test(String(value));
}

// A quote may run across adjacent lines; speaker labels are not spoken words.
// Prompts ask for short quotations, but a longer exact quotation is still
// stronger evidence than a truncated or paraphrased one. Keep the hard limit
// generous enough for a complete spoken sentence while still bounding input.
function decisionQuoteValidation(quote, passage, maxWords = 120, options = {}) {
  const flat = (value) => quoteText(value).replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
  // Keep the existing normalization, but a substring must cover complete
  // tokens. A standalone apostrophe can be a quotation mark; an apostrophe
  // inside can't, O'Brien or Ann's cannot bound a shorter quoted word.
  const boundary = (value, index, direction) => index < 0 || index >= value.length
    || value[index] === ' ' || (value[index] === "'" && (index + direction < 0
      || index + direction >= value.length || value[index + direction] === ' '));
  const containsCompleteQuote = (value, quotedText, onMatch) => {
    if (!quotedText) return false;
    let found = false;
    for (let index = value.indexOf(quotedText); index >= 0; index = value.indexOf(quotedText, index + 1)) {
      if (boundary(value, index - 1, -1) && boundary(value, index + quotedText.length, 1)) {
        if (!onMatch) return true;
        onMatch({ start: index, end: index + quotedText.length });
        found = true;
      }
    }
    return found;
  };
  const stripSpeakerPrefix = value => String(value || '').replace(/^[^:]{2,40}:\s*/, (prefix, _offset, source) => {
    const colon = prefix.indexOf(':');
    // A clock inside a short sentence is spoken content, not a speaker label.
    const clock = /(?:^|[^\d])\d{1,2}$/.test(prefix.slice(0, colon))
      && /^\d{2}(?!\d)/.test(source.slice(colon + 1));
    return clock && options.allowClockPrefix ? prefix : '';
  });
  const quoted = stripSpeakerPrefix(quote);
  const needle = flat(quoted);
  const words = needle ? needle.split(' ').length : 0;
  // Punctuation must not turn one spoken clock (or its zone offset) into
  // several words and satisfy the minimum evidence length by itself.
  const minimumText = flat(quoted.replace(/\b(?:UTC|GMT)\s*[+-]\s*\d{1,2}(?::?\d{2})?\b/gi, 'zone')
    .replace(/(?<!\d)\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:am|pm)\b)?(?!\d)/gi, 'clock'));
  const minimumWords = minimumText ? minimumText.split(' ').length : 0;
  if (minimumWords < 3) return { valid: false, reason: 'quote_too_short', words: minimumWords };
  if (words > maxWords) return { valid: false, reason: 'quote_too_long', words };
  const spoken = String(passage || '').split('\n').map(stripSpeakerPrefix).join(' ');
  // Positions use this same normalized spoken passage for both quotations.
  // Existing consumers keep their boolean matching and result shape.
  const positions = [];
  const valid = containsCompleteQuote(flat(spoken), needle,
    options.includePositions === true ? match => positions.push(match) : undefined);
  // Only temporal consumers opt in to the corrected clock parsing. A newly
  // accepted quote must then prove the complete source proposition, or supply
  // a validated structured temporal witness; quotation alone is insufficient.
  const legacyStrip = value => String(value || '').replace(/^[^:]{2,40}:\s*/, '');
  const legacyNeedle = flat(legacyStrip(quote));
  const legacyWords = legacyNeedle ? legacyNeedle.split(' ').length : 0;
  const legacyValid = legacyWords >= 3 && legacyWords <= maxWords
    && containsCompleteQuote(flat(String(passage || '').split('\n').map(legacyStrip).join(' ')), legacyNeedle);
  return { valid, reason: valid ? '' : 'quote_not_found', words,
    ...(options.includePositions === true ? { positions } : {}),
    ...(valid && !legacyValid ? { requiresLiteralSource: true } : {}) };
}

function decisionQuoteFound(quote, passage, maxWords = 120) {
  return decisionQuoteValidation(quote, passage, maxWords).valid;
}

const ACTION_SOURCE_GENERIC_WORDS = new Set(['required', 'remaining', 'outstanding', 'include', 'including', 'explain', 'resolve', 'complete',
  'annual', 'monthly', 'weekly', 'daily', 'final', 'current', 'previous', 'latest', 'original']);

const ACTION_SOURCE_TOPIC_CHANGE = /\b(?:moving on|next (?:item|topic)|while we['’]re on|turning to)\b/i;

const actionSourceStem = word => word.length > 4 ? word.replace(/(?:ing|ed|s)$/, '').replace(/e$/, '') : word;

const ACTION_SOURCE_OPERATIONS = new Set(ACTION_VERB_GROUPS.flat().map(actionSourceStem));

function actionSourceSubjects(value, objectsOnly = false) {
  return new Set(actionSubjectWords(String(value || '').replace(/-/g, ' '))
    .filter(word => !ACTION_SOURCE_GENERIC_WORDS.has(word) && !COMMON_SPEECH_WORDS.has(word))
    .map(actionSourceStem).filter(word => !objectsOnly || !ACTION_SOURCE_OPERATIONS.has(word)));
}

function sourceNamesActionWork(action, value, objectsOnly = false) {
  const subjects = actionSourceSubjects(action, objectsOnly);
  const source = actionSourceSubjects(value, objectsOnly);
  const shared = [...subjects].filter(word => source.has(word)).length;
  return shared >= 2 || subjects.size === 1 && shared === 1 && predicateSupportsAction(action, value);
}

// An identity match is not an acceptance of this work. In particular, a
// completed part of a workstream must not become the commitment anchor for
// its outstanding part merely because both mention the same subject.
function currentOwnerWork(unit, owners, units) {
  const key = ownerIdentityKey(unit?.speaker || '');
  if (!key || !owners.some(owner => ownerIdentityKey(normaliseOwnerIdentity(owner, units)) === key)) return false;
  const value = String(unit.text || '');
  if (!OWNER_FIRST_PERSON.test(value)
    || /^(?:(?:okay|so|right|well)[,. ]+)*(?:can|could|should|would|will)\s+i\b/i.test(value)
    || /\bi\s+(?:cannot|can't|won't|will not|shall not)|\bi['’]ll\s+(?:not|never)\b/i.test(value)) return false;
  const finishedPart = /\bi(?:['’]ve|\s+have)\s+(?:already\s+|just\s+|now\s+)?(?:added|drafted)\b/i.test(value);
  return !finishedPart;
}

const FIRST_PERSON_COMMITMENT = /\b(?:i|we)(?:'ll| will| shall| can| am going to|'m going to|'m gonna| am gonna|'re going to| are going to)\b|\bleave (?:it|that|this) with me\b|\bwill do\b|\bi'll\b|\bokay\b|\byes\b|\bsure\b/i;

function commitmentQuoteTiesOwner(quote = '', owners = [], passage = '') {
  const said = quoteText(quote);
  const names = (Array.isArray(owners) ? owners : []).map((owner) => String(owner || '').trim()).filter(Boolean);
  if (!names.length) return false;
  const firstNames = names.map((owner) => owner.split(/\s+/)[0].toLowerCase());
  const lines = String(passage || '').split('\n');
  // The line(s) carrying the quote: a quote may run across adjacent lines.
  const inLine = (index) => index >= 0 && index < lines.length
    && (decisionQuoteFound(quote, lines[index]) || quoteText(lines[index]).includes(said.slice(0, 40)));
  // A line carries the quote when the quote is in it, or starts in it and runs
  // into the next line (but not when it sits wholly in the next line).
  const carryingIndexes = lines.map((line, index) => (inLine(index)
    || (!inLine(index + 1) && decisionQuoteFound(quote, `${line}\n${lines[index + 1] || ''}`)) ? index : -1))
    .filter((index) => index >= 0);
  const carrying = carryingIndexes.map((index) => lines[index]);
  const spoken = (line) => quoteText(String(line || '').slice(String(line || '').indexOf(':') + 1));
  // "he's just looking into that" refers back to "there's Andrew who ..." a
  // few lines earlier, so the owner may be named up to three lines before.
  const nearby = [...new Set(carryingIndexes.flatMap((index) => [index - 3, index - 2, index - 1, index]).filter((index) => index >= 0))].map((index) => lines[index]);
  if (firstNames.some((name) => said.includes(name) || nearby.some((line) => new RegExp(`\\b${name}\\b`).test(spoken(line))))) return true;
  const speakers = carrying.map((line) => line.split(':')[0].trim().toLowerCase());
  const ownerSpoke = speakers.some((speaker) => names.some((owner) => speaker === owner.toLowerCase() || speaker.split(/\s+/)[0] === owner.toLowerCase().split(/\s+/)[0]));
  return ownerSpoke && FIRST_PERSON_COMMITMENT.test(quote);
}

module.exports = {
  ACTION_SOURCE_TOPIC_CHANGE,
  FUTURE_MARKER,
  aboutWords,
  actionSourceSubjects,
  commitmentQuoteAboutAction,
  currentOwnerWork,
  decisionQuoteFound,
  decisionQuoteValidation,
  isHabitualPromise,
  predicateSupportsAction,
  quoteText,
  sourceNamesActionWork,
  commitmentQuoteTiesOwner,
  FIRST_PERSON_COMMITMENT
};
