'use strict';

// Spoken forms that no minute should carry.
//
// Two classes, both closed and both general English rather than anything to do with a
// particular transcript:
//
//  1. Colloquial contractions. "Andrew is gonna try and include sound" is not broken
//     enough for any detector to flag, so it published as spoken. There is no context in
//     which written minutes want "gonna", "wanna" or "kinda", so the expansion needs no
//     judgement and no reviewer involvement - it is spelling, not editing.
//
//  2. Date shapes. Transcripts say "the 23rd of July"; minutes write "23rd July". The
//     ordinal is kept because that is how these minutes read elsewhere; only the "of"
//     joiner and any stray article are removed.
//
// Deliberately NOT here: contractions that are ordinary written English ("don't", "it's",
// "we'll"). Those are handled - or deliberately left - by the voice detectors, and
// expanding them would make minutes read like a legal notice.

const CONTRACTIONS = [
  [/\bgonna\b/gi, 'going to'],
  [/\bgotta\b/gi, 'have to'],
  [/\bwanna\b/gi, 'want to'],
  [/\bgimme\b/gi, 'give me'],
  [/\blemme\b/gi, 'let me'],
  [/\bkinda\b/gi, 'kind of'],
  [/\bsorta\b/gi, 'sort of'],
  [/\boughta\b/gi, 'ought to'],
  [/\bdunno\b/gi, 'do not know'],
  [/\bcuppa\b/gi, 'cup of'],
  [/\bd'you\b/gi, 'do you'],
  [/\by'know\b/gi, 'you know'],
  [/\bcos\b/gi, 'because'],
  [/\bcoz\b/gi, 'because'],
  [/\bcuz\b/gi, 'because']
];

// Case is preserved for a sentence-initial hit: "Gonna send it" -> "Going to send it".
function applyPreservingCase(text, pattern, replacement) {
  return text.replace(pattern, (match) => (/^[A-Z]/.test(match)
    ? replacement.charAt(0).toUpperCase() + replacement.slice(1)
    : replacement));
}

function expandSpokenContractions(value) {
  let text = String(value || '');
  const applied = [];
  for (const [pattern, replacement] of CONTRACTIONS) {
    if (!pattern.test(text)) continue;
    pattern.lastIndex = 0;
    text = applyPreservingCase(text, pattern, replacement);
    applied.push(replacement);
  }
  return { text, applied };
}

const MONTH = '(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)';
const CALENDAR_ORDINALS = {
  first: '1st', second: '2nd', third: '3rd', fourth: '4th', fifth: '5th', sixth: '6th', seventh: '7th', eighth: '8th', ninth: '9th', tenth: '10th',
  eleventh: '11th', twelfth: '12th', thirteenth: '13th', fourteenth: '14th', fifteenth: '15th', sixteenth: '16th', seventeenth: '17th', eighteenth: '18th', nineteenth: '19th', twentieth: '20th',
  'twenty-first': '21st', 'twenty-second': '22nd', 'twenty-third': '23rd', 'twenty-fourth': '24th', 'twenty-fifth': '25th', 'twenty-sixth': '26th', 'twenty-seventh': '27th', 'twenty-eighth': '28th', 'twenty-ninth': '29th', thirtieth: '30th', 'thirty-first': '31st'
};
const CALENDAR_ORDINAL = Object.keys(CALENDAR_ORDINALS).sort((left, right) => right.length - left.length)
  .map((value) => value.replace('-', '[- ]')).join('|');

function calendarOrdinal(value) {
  return CALENDAR_ORDINALS[String(value || '').toLowerCase().replace(/\s+/g, '-')];
}

// Day and month names are proper nouns wherever they appear, so "09:30 thursday" is wrong
// independently of where it sits in the string. This used to be fixed by accident: the
// unanchored capitaliser reached past "09:30" and capitalised the first letter it found.
// That same reach turned "23rd of July" into "23Rd of July", so the casing is done here,
// by name, and the capitaliser is anchored.
// "may" is deliberately absent: it is a modal far more often than a month, and blind
// casing turned "languages that may present a problem" into "that May present a problem".
// A date containing May is still normalised by the phrase rules above, which see the
// day-number context; only the bare-word casing skips it. "march" stays because the verb
// reading is rare in minutes and the month reading is common.
const DAY_OR_MONTH = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|june|july|august|september|october|november|december)\b/gi;

function normaliseDatePhrases(value) {
  let text = String(value || '');
  const before = text;
  text = text
    // A week reference keeps its natural article: "week of the twentieth" ->
    // "week of the 20th". This is a date, unlike "the first option".
    .replace(new RegExp(`\\b(week\\s+of)\\s+(the\\s+)?(${CALENDAR_ORDINAL})\\b`, 'gi'),
      (match, prefix, article, ordinal) => `${prefix} ${article || ''}${calendarOrdinal(ordinal)}`)
    // Other explicit calendar joins do not need the spoken article.
    .replace(new RegExp(`\\b(on|by|from|until|before|after|since|through|to|starting\\s+on|starts?\\s+on|due\\s+on)\\s+(?:the\\s+)?(${CALENDAR_ORDINAL})\\b`, 'gi'),
      (match, prefix, ordinal) => `${prefix} ${calendarOrdinal(ordinal)}`)
    // "the twenty-fifth of August" / "twenty-fifth of August" -> "25th August".
    .replace(new RegExp(`\\b(?:the\\s+)?(${CALENDAR_ORDINAL})\\s+of\\s+(${MONTH})\\b`, 'gi'),
      (match, ordinal, month) => `${calendarOrdinal(ordinal)} ${month}`)
    // "August the twenty-fifth" -> "25th August".
    .replace(new RegExp(`\\b(${MONTH})\\s+(?:the\\s+)?(${CALENDAR_ORDINAL})\\b`, 'gi'),
      (match, month, ordinal) => `${calendarOrdinal(ordinal)} ${month}`)
    // "the 23rd of July" / "23rd of July" -> "23rd July"
    .replace(new RegExp(`\\b(?:the\\s+)?(\\d{1,2})(st|nd|rd|th)\\s+of\\s+(${MONTH})\\b`, 'gi'),
      (match, day, suffix, month) => `${day}${suffix.toLowerCase()} ${month}`)
    // "the 23rd July" -> "23rd July" (article adds nothing in a deadline column)
    .replace(new RegExp(`\\bthe\\s+(\\d{1,2})(st|nd|rd|th)\\s+(${MONTH})\\b`, 'gi'),
      (match, day, suffix, month) => `${day}${suffix.toLowerCase()} ${month}`)
    // "July the 23rd" -> "23rd July"
    .replace(new RegExp(`\\b(${MONTH})\\s+the\\s+(\\d{1,2})(st|nd|rd|th)\\b`, 'gi'),
      (match, month, day, suffix) => `${day}${suffix.toLowerCase()} ${month}`)
    // Ordinal suffix casing on its own: "23Rd" -> "23rd". Cheap belt-and-braces for text
    // that reached us from anywhere that title-cased it.
    .replace(/\b(\d{1,2})(ST|ND|RD|TH|St|Nd|Rd|Th)\b/g, (match, day, suffix) => `${day}${suffix.toLowerCase()}`)
    .replace(DAY_OR_MONTH, (name) => name.charAt(0).toUpperCase() + name.slice(1).toLowerCase());
  return { text, changed: text !== before };
}

module.exports = { expandSpokenContractions, normaliseDatePhrases, CONTRACTIONS };
