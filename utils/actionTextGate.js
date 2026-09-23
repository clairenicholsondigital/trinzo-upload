'use strict';

// A minuted action is an instruction written for the record ("Send the question
// list to the logistics provider"), not a line of the conversation it came from
// ("Ines, can you and I look at that."). Several routes can carry a spoken
// sentence straight into Actions or the suggestion queue: a transcript-seeded
// candidate accepted by id without new wording, a proposal that skipped the
// commitment gate, or a promotion that scores a copied sentence as perfectly
// grounded because it *is* the source. This module decides, from the wording
// alone plus the transcript's own sentences, whether text is still in spoken
// form. It deliberately knows nothing about any particular meeting.

const { openingVerbIsActionable } = require('./stagedEditorial');

function gateEnabled() {
  return String(process.env.TRANSCRIPT_TEXT_GATE_V1 || '1') !== '0';
}

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

// Lower-case word sequence used to compare wording with transcript sentences.
function comparable(value) {
  return clean(value).toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Spoken openers: acknowledgements, fillers and greetings that begin a turn in
// conversation but never begin a written instruction.
const SPOKEN_OPENER = /^(?:no\s+(?:bother|problem|worries)|ok(?:ay)?|right|so|yeah|yep|yes|well|um+|uh+|er+|erm|oh|ah|hi|hello|hey|morning|afternoon|thanks|thank\s+you|cheers|sorry|great|perfect|lovely|brilliant|excellent|cool|fine|alright|all\s+right|anyway|actually|listen|look,|call\s+it)(?![\w-])/i;

// "Ines, can you ..." / "Dermot, ..." - a turn addressed to someone by name.
// A written action may name a person, but never opens by calling out to them.
const ADDRESSED_OPENER = /^[A-Z][a-z'’-]+(?:\s+[A-Z][a-z'’-]+)?,\s/;

// First- and second-person forms belong to the speaker and the listener. The
// minutes are written in the third person, so these mark conversational text.
const PERSONAL_FORM = /(?:^|[^a-z'])(?:i|i'm|i'll|i've|i'd|me|my|mine|we|we're|we'll|we've|we'd|us|our|ours|you|you're|you'll|you've|you'd|your|yours|let's)(?![a-z'])/i;

// Minimum length before a sentence match is treated as copying rather than a
// short phrase that happens to coincide ("Order the medals.").
const VERBATIM_MIN_WORDS = 5;

function sentencesOf(units = []) {
  const out = [];
  for (const unit of Array.isArray(units) ? units : []) {
    const textValue = typeof unit === 'string' ? unit : unit?.text;
    const whole = comparable(textValue);
    if (!whole) continue;
    out.push(whole);
    for (const part of String(textValue || '').split(/(?<=[.!?])\s+/)) {
      const sentence = comparable(part);
      if (sentence && sentence !== whole) out.push(sentence);
    }
  }
  return out;
}

// Cache per units array: the same transcript is checked for many actions.
const sentenceCache = new WeakMap();
function cachedSentences(units) {
  if (!units || typeof units !== 'object') return [];
  if (!sentenceCache.has(units)) sentenceCache.set(units, sentencesOf(units));
  return sentenceCache.get(units);
}

function isVerbatimTranscript(action, units) {
  const wording = comparable(action);
  const words = wording.split(' ').filter(Boolean);
  if (words.length < VERBATIM_MIN_WORDS) return false;
  return cachedSentences(units).some((sentence) => {
    if (sentence === wording) return true;
    // The action is the whole spoken sentence give or take a trailing word.
    // Dropping the speaker's subject ("We will work out a secure way..." ->
    // "Work out a secure way...") is what rewriting into an action looks
    // like, so a shorter clause of a sentence is not treated as a copy.
    if (sentence.includes(wording) && wording.length >= sentence.length * 0.95) return true;
    if (wording.includes(sentence) && sentence.length >= wording.length * 0.95) return true;
    return false;
  });
}

// 'Create "those two language characterisation situations".' keeps a spoken
// fragment inside quotation marks. A quoted run of four or more words that
// appears word for word in the transcript was lifted, not written.
function quotesTranscript(action, units) {
  const spans = String(action || '').match(/["“”]([^"“”]{6,})["“”]/g) || [];
  return spans.some((span) => {
    const wording = comparable(span);
    // Four words or more: a short quoted name ("call me docs") is a label.
    if (wording.split(' ').filter(Boolean).length < 4) return false;
    return cachedSentences(units).some((sentence) => sentence.includes(wording));
  });
}

// Returns the reason the text is still in spoken form, or '' when it reads as a
// written action. Order matters only for the reason reported.
// A published action is written about people, not spoken to or among them:
// "hand over to Tom now, and that's your cue", "ring round and get us up to
// fourteen". Either person marks the words as speech.
const SECOND_PERSON_REFERENCE = /\b(?:you|your|yours|you're|you'll|you've|us|our|ours|me|my|mine|we|we're|we'll|we've|i|i'm|i'll|i've|i'd)\b/i;

// The deliberate 95% rule above lets a rewritten clause through, which is
// right for "We will work out a secure way..." -> "Work out a secure way...".
// It also lets through a clause lifted unchanged from the middle of a turn:
// "I'll sort the marshals, I've got the list from last year, I'll just ring
// round and get us up to fourteen" yields the action "ring round and get us up
// to fourteen". What separates the two is the speaking: a rewritten clause
// drops the speaker, a lifted one keeps them talking.
function isSpokenFragment(action, units) {
  const wording = comparable(action);
  const words = wording.split(' ').filter(Boolean);
  if (words.length < 4 || !SECOND_PERSON_REFERENCE.test(action)) return false;
  return cachedSentences(units).some((sentence) => sentence.includes(wording));
}

function transcriptTextIssue(action, units = []) {
  const text = clean(action);
  if (!text) return '';
  if (/\?\s*["'”’)]*\s*$/.test(text)) return 'question';
  if (ADDRESSED_OPENER.test(text)) return 'addressed_to_someone';
  if (SPOKEN_OPENER.test(text)) return 'spoken_opener';
  const personalOpening = PERSONAL_FORM.test(openingWords(text));
  const imperative = openingVerbIsActionable(text) && !PERSONAL_FORM.test(text);
  // A spoken instruction can already be in written form ("Order six sacks of
  // Maris Otter" inside "I'll order six sacks..."); copying is only a fault when
  // the copied words are not themselves an instruction.
  // ... unless the copied words talk to somebody. "Hand over to Tom now, and
  // that's your cue" opens with a verb, so it reads as an instruction, but a
  // published action never addresses the reader as "you": owners go in their
  // own column.
  if ((!imperative || SECOND_PERSON_REFERENCE.test(text)) && isVerbatimTranscript(text, units)) return 'verbatim_transcript';
  if (isSpokenFragment(text, units)) return 'verbatim_transcript';
  if (quotesTranscript(text, units)) return 'quoted_transcript';
  // "we" late in "check whether we bring ours" is reported speech inside a
  // written action; "we need to" or "I'll" at the start is the speaker talking.
  if (personalOpening && !openingVerbIsActionable(text)) return 'conversational_person';
  return '';
}

// The subject of a spoken sentence sits in its first few words.
function openingWords(text, count = 4) {
  return clean(text).split(/\s+/).slice(0, count).join(' ');
}

function actionRecordText(record) {
  if (!record || typeof record !== 'object') return '';
  return record.action || record.text || '';
}

// Splits records into those fit to publish or propose and those still in spoken
// form, keeping the reason for logging.
function partitionTranscriptText(records = [], units = []) {
  const kept = [];
  const rejected = [];
  for (const record of Array.isArray(records) ? records : []) {
    const reason = gateEnabled() ? transcriptTextIssue(actionRecordText(record), units) : '';
    if (reason) rejected.push({ record, reason });
    else kept.push(record);
  }
  return { kept, rejected };
}

function rejectionSummary(rejected = []) {
  return rejected.map(({ record, reason }) => ({
    reason,
    action: clean(actionRecordText(record)).slice(0, 160)
  }));
}

module.exports = {
  gateEnabled,
  transcriptTextIssue,
  isVerbatimTranscript,
  quotesTranscript,
  partitionTranscriptText,
  rejectionSummary
};
