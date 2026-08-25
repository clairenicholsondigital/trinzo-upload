'use strict';

// Spoken numbers into digits, deterministically.
//
// Transcripts say "three hundred and fifty" and "seven point two"; minutes write 350 and
// 7.2. Nothing in the pipeline converted them, and the LLM passes could not be trusted to:
// the fact guard treats a digit that was not in the original as a suspected invention, so
// a rewrite that correctly converted a number was refused for doing so. Converting before
// any model sees the text resolves both halves.
//
// Deliberately conservative:
//  - only canonical compositions convert: units/teens/tens with hundred/thousand and an
//    optional "and", plus "point" decimals;
//  - a bare single word converts only from "ten" upwards - "one"-"nine" alone stay prose
//    ("one of the", "no one", and small counts are standard minutes style anyway);
//  - a capitalised number word that is not sentence-initial is treated as part of a name
//    ("Seven Sisters", "Ten Downing Street") and left alone;
//  - ordinals are not handled at all - "twenty-second of June" is a date, not a quantity.

const UNITS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const TEENS = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALES = { hundred: 100, thousand: 1000 };

const NUMBER_WORD = new Set([...Object.keys(UNITS), ...Object.keys(TEENS), ...Object.keys(TENS), ...Object.keys(SCALES)]);

function isSentenceStart(text, index) {
  const before = text.slice(0, index).replace(/["'‘’“”(\[]+$/, '');
  return !before.trim() || /[.!?]\s*$/.test(before);
}

// Parse one spoken-number phrase starting at tokens[start]. Returns { value, end, words }
// or null. `words` counts number words consumed (excluding "and"), which decides whether
// the phrase is substantial enough to convert.
function parsePhrase(tokens, start) {
  let index = start;
  let total = 0;
  let current = 0;
  let words = 0;
  let sawScale = false;
  let expectAnd = false;

  while (index < tokens.length) {
    const word = tokens[index].lower;
    if (word === 'and') {
      // "and" is only part of a number after a scale word: "three hundred AND fifty".
      // "two and three" is a list, not two hundred and three.
      if (!expectAnd) break;
      const next = tokens[index + 1] ? tokens[index + 1].lower : '';
      if (!(next in UNITS) && !(next in TEENS) && !(next in TENS)) break;
      index += 1;
      expectAnd = false;
      continue;
    }
    if (word in UNITS) {
      if (current % 10 !== 0 || (current % 100 >= 10 && current % 100 <= 19)) break;
      current += UNITS[word];
      words += 1;
      index += 1;
      expectAnd = false;
      continue;
    }
    if (word in TEENS) {
      if (current % 100 !== 0) break;
      current += TEENS[word];
      words += 1;
      index += 1;
      expectAnd = false;
      continue;
    }
    if (word in TENS) {
      if (current % 100 !== 0) break;
      current += TENS[word];
      words += 1;
      index += 1;
      expectAnd = false;
      continue;
    }
    if (word === 'hundred') {
      if (current === 0 || current >= 100) break;
      current *= 100;
      words += 1;
      index += 1;
      sawScale = true;
      expectAnd = true;
      continue;
    }
    if (word === 'thousand') {
      if (current === 0 || current >= 1000) break;
      total += current * 1000;
      current = 0;
      words += 1;
      index += 1;
      sawScale = true;
      expectAnd = true;
      continue;
    }
    break;
  }

  if (!words) return null;
  return { value: total + current, end: index, words, sawScale };
}

// "seven point two" -> "7.2". The whole part must itself be a convertible phrase; the
// decimal part is digit words read out one by one ("point two five" -> .25).
function parseDecimal(tokens, start) {
  const whole = parsePhrase(tokens, start);
  if (!whole) return null;
  if (!tokens[whole.end] || tokens[whole.end].lower !== 'point') return null;
  let index = whole.end + 1;
  let digits = '';
  while (index < tokens.length && tokens[index].lower in UNITS) {
    digits += String(UNITS[tokens[index].lower]);
    index += 1;
  }
  if (!digits) return null;
  return { text: `${whole.value}.${digits}`, end: index, words: whole.words + 1 + digits.length };
}

function convertSpokenNumbers(text) {
  const source = String(text || '');
  if (!source) return { text: source, conversions: [] };

  // Tokenise with positions, keeping hyphenated pairs as two tokens ("twenty-two").
  const tokens = [];
  const pattern = /[A-Za-z]+/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    tokens.push({ word: match[0], lower: match[0].toLowerCase(), start: match.index, end: match.index + match[0].length });
  }

  const conversions = [];
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (!NUMBER_WORD.has(token.lower) || token.lower === 'zero') { index += 1; continue; }
    // A capitalised number word mid-sentence is a name ("Seven Sisters"), not a quantity.
    if (/^[A-Z]/.test(token.word) && !isSentenceStart(source, token.start)) { index += 1; continue; }
    // Hyphen-attached to a preceding word: "two-eighty" reaches here at "eighty" after
    // "two" was skipped as a bare unit, and converting just the tail produces "two-80".
    // Colloquial forms are left whole for the model pass rather than half-converted.
    if (source[token.start - 1] === '-') { index += 1; continue; }

    const decimal = parseDecimal(tokens, index);
    const phrase = decimal ? null : parsePhrase(tokens, index);
    const parsed = decimal || phrase;
    if (!parsed) { index += 1; continue; }

    // Substantial enough to convert: any multi-word phrase, or a bare teen/ten ("fifteen
    // casks"). A bare unit stays prose.
    const bareUnit = parsed.words === 1 && token.lower in UNITS;
    if (bareUnit) { index += 1; continue; }

    // Tokens between phrase words must only be spaces, hyphens or commas that belong to
    // the phrase ("twenty-two", "three hundred, and fifty" is not supported - a comma
    // breaks the phrase, because "Order, seven point two" needs the comma kept).
    const endToken = tokens[parsed.end - 1];
    const between = source.slice(token.start, endToken.end);
    if (/[.,;:!?]/.test(between.replace(/,\s*$/, ''))) { index += 1; continue; }
    // A dangling hyphen after the phrase means it continues into a word the parser did
    // not consume - almost always an ordinal: "twenty-second of June" is a date, and
    // "20-second" is not an improvement on anything.
    if (source[endToken.end] === '-' && /[A-Za-z]/.test(source[endToken.end + 1] || '')) { index += 1; continue; }

    conversions.push({
      original: source.slice(token.start, endToken.end),
      replacement: decimal ? decimal.text : String(phrase.value),
      start: token.start,
      end: endToken.end
    });
    index = parsed.end;
  }

  if (!conversions.length) return { text: source, conversions: [] };
  let output = source;
  for (const conversion of [...conversions].sort((left, right) => right.start - left.start)) {
    output = `${output.slice(0, conversion.start)}${conversion.replacement}${output.slice(conversion.end)}`;
  }
  return { text: output, conversions };
}

// Fact-guard support: "three hundred and fifty" and "350" are the same fact. Returns the
// digit form of every number a string carries, spoken or written, so protectedFactsOf can
// compare the two representations as one.
function numericFactsOf(text) {
  const converted = convertSpokenNumbers(String(text || ''));
  const facts = new Set();
  for (const match of converted.text.match(/\d+(?:\.\d+)?/g) || []) facts.add(match);
  return facts;
}

module.exports = { convertSpokenNumbers, numericFactsOf };
