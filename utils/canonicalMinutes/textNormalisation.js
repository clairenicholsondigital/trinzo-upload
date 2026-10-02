'use strict';

const SMALL_NUMBER_WORDS = new Map([
  ['zero', 0], ['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5],
  ['six', 6], ['seven', 7], ['eight', 8], ['nine', 9], ['ten', 10],
  ['eleven', 11], ['twelve', 12], ['thirteen', 13], ['fourteen', 14],
  ['fifteen', 15], ['sixteen', 16], ['seventeen', 17], ['eighteen', 18],
  ['nineteen', 19], ['twenty', 20], ['thirty', 30], ['forty', 40],
  ['fifty', 50], ['sixty', 60], ['seventy', 70], ['eighty', 80], ['ninety', 90]
]);

const NUMBER_WORD = '(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)';

function numberWordsToValue(value) {
  const words = String(value || '').toLowerCase().replace(/-/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  let total = 0;
  let current = 0;
  for (const word of words) {
    if (word === 'hundred') {
      current = (current || 1) * 100;
      total += current;
      current = 0;
      continue;
    }
    const number = SMALL_NUMBER_WORDS.get(word);
    if (number == null) return null;
    current += number;
  }
  const result = total + current;
  return Number.isFinite(result) ? result : null;
}

function normaliseUkCurrency(value) {
  let text = String(value || '');
  const wordAmount = new RegExp(`\\b(${NUMBER_WORD}(?:[- ]+${NUMBER_WORD})?|${NUMBER_WORD}\\s+hundred(?:\\s+and\\s+${NUMBER_WORD})?)(?:[- ]+)pounds?\\b`, 'gi');
  text = text.replace(wordAmount, (_match, amount) => {
    const numeric = numberWordsToValue(amount);
    return numeric == null ? _match : `£${numeric}`;
  });
  text = text.replace(/(?:£\s*)?(\d+(?:\.\d{1,2})?)\s+pounds?\b/gi, '£$1');
  text = text.replace(/\b(?:GBP|gbp)\s*(\d+(?:\.\d{1,2})?)\b/g, '£$1');
  // A generated range can mix a bare first endpoint with a marked second endpoint
  // ("25 to £30"), or duplicate the symbol while applying a second normalisation pass
  // ("££25"). Repair only currency-marked ranges so ordinary numeric ranges are unchanged.
  text = text.replace(/£\s*£+/g, '£');
  const formatRange = (_match, first, separator, second) => separator.toLowerCase() === 'to'
    ? `£${first} to £${second}`
    : `£${first}${separator}£${second}`;
  // Consume an existing symbol on the first endpoint as well as adding one
  // when it is absent. Otherwise "££25-£30" is collapsed to "£25-£30" above,
  // then this range pass sees "25-£30" and prefixes a second symbol.
  text = text.replace(/(?:£\s*)?(\d+(?:\.\d{1,2})?)\s*(to|[-–—])\s*£\s*(\d+(?:\.\d{1,2})?)/g, formatRange);
  text = text.replace(/£\s*(\d+(?:\.\d{1,2})?)\s*(to|[-–—])\s*(\d+(?:\.\d{1,2})?)/g, formatRange);
  return text;
}

function normalisePresentationCurrency(value) {
  if (typeof value === 'string') return normaliseUkCurrency(value);
  if (Array.isArray(value)) return value.map(normalisePresentationCurrency);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalisePresentationCurrency(item)]));
  }
  return value;
}

module.exports = { normaliseUkCurrency, normalisePresentationCurrency, numberWordsToValue };
