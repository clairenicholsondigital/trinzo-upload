'use strict';

// These functions do not decide whether text was generated. Callers must apply
// them only to fresh generated text, before a reviewer has edited or kept it.
// Leave unchanged text byte-for-byte intact: number/date/name normalisation and
// general rewriting are deliberately outside this boundary.
function result(text, changes = []) {
  return { text, changes };
}

function sourceText(value) {
  return typeof value === 'string' ? value : '';
}

// A quotation can intentionally demonstrate a repeated phrase or a remark. An
// entire quoted row is left alone rather than guessing where a damaged quote
// ends. Apostrophes inside ordinary words do not count as quotation marks.
function containsQuotation(text) {
  return /["“”]|(?:^|[\s([{])['‘]/u.test(text);
}

const PREPOSITION = '(?:for|from|to|with|without|in|on|at|by|of|under|over|between|through|into|onto|within|across|about)';
const DETERMINER = '(?:the|a|an|this|that|these|those)';
const LOWER_WORD = '[a-z]+(?:[’\'][a-z]+)?';
const FUNCTION_WORDS = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'and', 'or', 'but',
  'for', 'from', 'to', 'with', 'without', 'in', 'on', 'at', 'by', 'of',
  'under', 'over', 'between', 'through', 'into', 'onto', 'within', 'across', 'about'
]);
const NUMBER_OR_DATE_WORD = /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)\b/;

function removeAccidentalPhraseRepeats(value) {
  let text = sourceText(value);
  if (!text || containsQuotation(text)) return result(text);
  const changes = [];
  // An incomplete preposition/determiner restarted immediately cannot supply
  // two distinct objects: "from the, from the supplier". Match lowercase text
  // exactly, so names, initials and differing capitalisation are never folded.
  const restart = new RegExp(`\\b(${PREPOSITION}[ \\t]+${DETERMINER})[ \\t]*,?[ \\t]+\\1\\b`, 'g');
  let previous;
  do {
    previous = text;
    text = text.replace(restart, (before, phrase) => {
      changes.push({ kind: 'adjacent_phrase_repeat', before, after: phrase });
      return phrase;
    });
  } while (text !== previous);

  // A repeated short prepositional phrase is removed only at a clause end.
  // In the middle of a clause, identical words can introduce different objects
  // ("in place in place of the previous process"), so keep that ambiguity.
  const tail = new RegExp(`\\b(${PREPOSITION}(?:[ \\t]+${LOWER_WORD}){1,4})[ \\t]+\\1(?=[ \\t]*(?:[.,;!?]|$))`, 'g');
  do {
    previous = text;
    text = text.replace(tail, (before, phrase) => {
      const words = phrase.split(/[ \t]+/);
      if (words.every((word) => FUNCTION_WORDS.has(word)) || NUMBER_OR_DATE_WORD.test(phrase)
        || words.some((word, index) => words.indexOf(word) !== index)) return before;
      changes.push({ kind: 'adjacent_phrase_repeat', before, after: phrase });
      return phrase;
    });
  } while (text !== previous);
  return result(text, changes);
}

// This is a grammar for descriptions of conversational tone, not a list of
// subjects to suppress. A task involving a joke, a complaint about remarks or
// a workplace wellbeing concern is not such a description.
const TONE = '(?:(?:light[- ]?hearted|informal|casual|social|off[- ]topic|humorous)[ \\t]+(?:comments?|remarks?)|banter|small[ \\t]+talk|chit[- ]chat|jokes?)';
const QUANTITY = '(?:(?:some|brief|a few|a little|occasional)[ \\t]+)?';
const TONE_PHRASE = `${QUANTITY}${TONE}`;
const REPORTING_SUBJECT = '(?:(?:the[ \\t]+)?(?:meeting|discussion|conversation|session|call))';
const REPORTING_PREFIX = `(?:there[ \\t]+(?:was|were)[ \\t]+|${REPORTING_SUBJECT}[ \\t]+(?:included|contained|involved|featured)[ \\t]+|(?:participants|attendees|the team|team members)[ \\t]+(?:made|exchanged)[ \\t]+)?`;
const PURE_TONE = new RegExp(`^${REPORTING_PREFIX}${TONE_PHRASE}(?:[ \\t]+(?:was|were)[ \\t]+made)?(?<qualifier>(?:[ \\t]+(?:about|on|regarding|during|before|after)[ \\t]+${LOWER_WORD}(?:[ \\t]+${LOWER_WORD}){0,7})?)[.!]?$`, 'i');
const MATERIAL_REMARK_CONTEXT = /\b(?:complaints?|concerns?|harassment|discrimination|bullying|abuse|abusive|offensive|offended|inappropriate|unwelcome|distress|harm|harmful|hurt|threats?|unsafe|safety|risks?|fatigue|workload|wellbeing|well-being|grievance|investigat(?:e|ed|ion)|disciplinary|script|rehearsal|presentation|training|policy|policies|rules?|prohibit(?:ed)?|bann?(?:ed)?|must|should|required|agreed|decided|approved|rejected|deadline|deliverable|dependency|blocker|decision|approval|disability|race|religion|gender|ethnicity|nationality|colleague|coworker|employee)\b/i;
const QUALIFIER_PREDICATE = /\b(?:am|is|are|was|were|be|being|been|will|would|shall|should|may|might|can|could|must|has|have|had|do|does|did|caused?|causing|requires?|affects?|affected|changes?|changed|changing|led|resulted|prevented|delayed|blocked|sparked|remove|removed|include|included|add|added|stop|stopped)\b/i;

function toneOnly(text) {
  if (MATERIAL_REMARK_CONTEXT.test(text)) return false;
  const match = text.trim().match(PURE_TONE);
  const qualifier = match?.groups.qualifier || '';
  return Boolean(match && !QUALIFIER_PREDICATE.test(qualifier) && !/['’]s\b/.test(qualifier));
}

function cleanToneSentence(text) {
  if (MATERIAL_REMARK_CONTEXT.test(text)) return text;
  if (toneOnly(text)) return '';
  // Only a final, explicitly separated clause can be detached. Never discard a
  // whole mixed row: its dates, qualifications and operational meaning stay.
  const separators = [...text.matchAll(/[,;][ \t]+/g)].reverse();
  for (const separator of separators) {
    const suffix = text.slice(separator.index + separator[0].length);
    const candidate = suffix.replace(/^(?:with|alongside)[ \t]+/i, '');
    if (!toneOnly(candidate)) continue;
    const prefix = text.slice(0, separator.index).trimEnd();
    if ((prefix.match(/\b[\p{L}\p{N}]+\b/gu) || []).length < 3 || /[:,;]$/.test(prefix)) continue;
    const ending = text.match(/[.!?][ \t]*$/)?.[0] || '';
    const cleaned = /[.!?]$/.test(prefix) ? prefix : prefix + ending;
    return cleaned;
  }
  return text;
}

const ABBREVIATED_PERIOD_WORDS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc',
  'inc', 'ltd', 'plc', 'llc', 'co', 'corp', 'dept', 'fig', 'no',
  'approx', 'est', 'vol', 'rev'
]);

function isAbbreviatedPeriod(text, index) {
  const preceding = text.slice(0, index);
  if (preceding.endsWith('.') || /(?:\b[A-Za-z]\.)+[A-Za-z]$/.test(preceding)) return true;
  const word = preceding.match(/([A-Za-z]+)$/)?.[1] || '';
  return word.length === 1 || ABBREVIATED_PERIOD_WORDS.has(word.toLowerCase());
}

function removeToneOnlyCommentary(value) {
  const text = sourceText(value);
  if (!text || containsQuotation(text)) return result(text);
  // Inspect complete sentences without rewriting their neighbours. Do not
  // treat initials, dotted abbreviations, titles, ellipses or decimal points as
  // boundaries. If an abbreviation could also end a sentence, leaving the
  // following comment intact is safer than guessing.
  const spans = [];
  let start = 0;
  for (const boundary of text.matchAll(/[.!?](?=\s|$)/g)) {
    if (boundary[0] === '.' && isAbbreviatedPeriod(text, boundary.index)) continue;
    spans.push(text.slice(start, boundary.index + 1));
    start = boundary.index + 1;
  }
  if (start < text.length) spans.push(text.slice(start));
  let removedFirst = false;
  const cleaned = spans.map((span, index) => {
    const leading = span.match(/^\s*/)[0];
    const trailing = span.match(/\s*$/)[0];
    const body = span.slice(leading.length, span.length - trailing.length || undefined);
    if (!body) return span;
    const next = cleanToneSentence(body);
    if (!next) {
      if (index === 0) removedFirst = true;
      return '';
    }
    return leading + next + trailing;
  }).join('');
  // A surviving sentence carries the separator which originally preceded it.
  // Drop that separator when the first sentence went, preserving any original
  // paragraph indentation rather than globally trimming the text.
  const finalText = removedFirst ? (cleaned.trim() ? cleaned.replace(/^\s*/, text.match(/^\s*/)[0]) : '') : cleaned;
  return finalText === text ? result(text)
    : result(finalText, [{ kind: 'tone_only_commentary', before: text, after: finalText }]);
}

function cleanGeneratedMinutesText(value) {
  const repeated = removeAccidentalPhraseRepeats(value);
  const commentary = removeToneOnlyCommentary(repeated.text);
  return result(commentary.text, [...repeated.changes, ...commentary.changes]);
}

module.exports = {
  cleanGeneratedMinutesText,
  removeAccidentalPhraseRepeats,
  removeToneOnlyCommentary
};
