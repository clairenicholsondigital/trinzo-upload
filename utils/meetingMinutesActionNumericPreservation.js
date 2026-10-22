'use strict';

const { convertSpokenNumbers } = require('./spokenNumbers');
const { normaliseUkCurrency } = require('./canonicalMinutes/textNormalisation');
const { numberedIdentifiers, quantityTokens, unitTokens } = require('./meetingMinutesNumericTokens');

const SMALL = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, hundred: 100, thousand: 1000 };
const NUM = '[£€$]?\\s*[+−-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:e[+−-]?\\d+)?';

function comparisonText(row) {
  let text = String(typeof row === 'string' ? row : row?.action || '').normalize('NFKC');
  // These are comparison-only transformations: never rewrite the action or
  // change the semantic reconciliation policy that uses the shared tokenizer.
  text = text.replace(/(?<=\d),(?=\d{3}(?:\D|$))/g, '')
    .replace(/(?<=\d)[–—](?=\d)/g, '-');
  text = normaliseUkCurrency(convertSpokenNumbers(text).text);
  return text;
}

function numberKey(token) {
  let value = String(token).trim().toLowerCase().replace(/^[£€$]\s*/, '').replace(/−/g, '-');
  if (Object.hasOwn(SMALL, value)) value = String(SMALL[value]);
  const match = /^([+-]?)(\d*(?:\.\d*)?)(?:e([+-]?\d+))?$/.exec(value);
  if (!match || !/\d/.test(match[2])) return value;
  const [whole, fraction = ''] = match[2].split('.');
  let digits = `${whole}${fraction}`.replace(/^0+/, '');
  if (!digits) return '0';
  let exponent = BigInt(match[3] || 0) - BigInt(fraction.length);
  const trailing = /0+$/.exec(digits)?.[0].length || 0;
  if (trailing) { digits = digits.slice(0, -trailing); exponent += BigInt(trailing); }
  return `${match[1] === '-' ? '-' : ''}${digits}e${exponent}`;
}

function missing(before, after) {
  const remaining = new Map();
  for (const value of after) remaining.set(value, (remaining.get(value) || 0) + 1);
  for (const value of before) {
    if (!remaining.get(value)) return true;
    remaining.set(value, remaining.get(value) - 1);
  }
  return false;
}

function units(text) {
  const extra = [];
  // Common written forms share the exact same comparison unit. SI prefix
  // case remains significant: mL and ML differ by a factor of one billion.
  const normalized = text.replace(/\bmillilit(?:re|er)s?\b/gi, 'mL')
    .replace(/(?<![\p{L}])ml(?![\p{L}])/gu, 'mL')
    .replace(/\bmicrolit(?:re|er)s?\b/gi, 'µL')
    .replace(/\blit(?:re|er)s?\b/gi, 'L')
    .replace(/\bmicrograms?\b/gi, 'µg')
    .replace(/\bmilligrams?\b/gi, 'mg').replace(/\bkilograms?\b/gi, 'kg')
    .replace(/\bgrams?\b/gi, 'g').replace(/\bmillimet(?:re|er)s?\b/gi, 'mm')
    .replace(/\bcentimet(?:re|er)s?\b/gi, 'cm').replace(/\bmet(?:re|er)s?\b/gi, 'm')
    .replace(/\b(?:percent|per cent)\b/gi, '%')
    .replace(/\b(?:dollars?|usd)\b/gi, '$').replace(/\b(?:euros?|eur)\b/gi, '€')
    .replace(/\bdegrees?\s+(celsius|fahrenheit)\b/gi,
      (_match, scale) => scale.toLowerCase() === 'celsius' ? '°C' : '°F')
    .replace(/°\s*([CF])\b/g, (_match, scale) => { extra.push(`temperature:${scale}`); return ' '; })
    .replace(/\bdegrees?\b/gi, () => { extra.push('degree'); return ' '; })
    .replace(/\b(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\b/gi,
      word => { const key = word.toLowerCase();
        extra.push(/^(?:second|sec)/.test(key) ? 's' : /^(?:minute|min)/.test(key) ? 'minute'
          : /^(?:hour|hr)/.test(key) ? 'hour' : key.replace(/s$/, '')); return ' '; });
  return [...unitTokens(normalized).map(unit => unit === 'l' ? 'L' : unit), ...extra];
}

function relations(text) {
  const normalized = text.toLowerCase().replace(/\b(?:zero|one|two|three|four|five|six|seven|eight|nine)\b/g,
    word => String(SMALL[word]));
  const result = [];
  const bound = new RegExp('\\b(at least|no fewer than|at most|no more than|up to|more than|less than|fewer than|under|over|above|below|approximately|around|about|roughly)\\s*(' + NUM + ')|([<>]=?|[≤≥])\\s*(' + NUM + ')', 'g');
  const aliases = { 'at least': '>=', 'no fewer than': '>=', 'at most': '<=', 'no more than': '<=',
    'up to': '<=', 'more than': '>', over: '>', above: '>', 'less than': '<', 'fewer than': '<',
    under: '<', below: '<', approximately: '~', around: '~', about: '~', roughly: '~', '≥': '>=', '≤': '<=' };
  for (const match of normalized.matchAll(bound)) {
    result.push(`bound:${aliases[match[1] || match[3]] || match[1] || match[3]}:${numberKey(match[2] || match[4])}`);
  }
  // Preserve range relationships as well as their endpoint numbers. A rewrite
  // from "12 to 15" to "12 and 15" must not pass solely on the inventory.
  const range = new RegExp('\\bbetween\\s+(' + NUM + ')\\s+and\\s+(' + NUM + ')|(?<![\\p{L}\\p{N}_.])(' + NUM + ')\\s*(?:to|[–—-])\\s*(' + NUM + ')', 'gu');
  for (const match of normalized.matchAll(range)) {
    result.push(`range:${numberKey(match[1] || match[3])}:${numberKey(match[2] || match[4])}`);
  }
  return result;
}

/** Protect numerical detail already present in an action during automatic edits.
 * Directional only: this does not establish source truth or bind values to objects.
 * Ambiguous rewrites remain available for explicit human acceptance.
 */
function numericActionEditIssue(before, after) {
  const left = comparisonText(before); const right = comparisonText(after);
  if (missing(numberedIdentifiers(left).map(value => value.toLowerCase()),
    numberedIdentifiers(right).map(value => value.toLowerCase()))) return 'it removes or changes a numbered identifier';
  if (missing(quantityTokens(left.toLowerCase()).map(numberKey),
    quantityTokens(right.toLowerCase()).map(numberKey))) return 'it removes or changes a quantity';
  if (missing(units(left), units(right))) return 'it removes or changes a unit or currency';
  if (missing(relations(left), relations(right))) return 'it removes or changes a numerical bound or range';
  return '';
}

module.exports = { numericActionEditIssue };
