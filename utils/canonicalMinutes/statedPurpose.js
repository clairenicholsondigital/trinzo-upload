'use strict';

const { clean } = require('./evidence');

// Why the meeting was held, taken from someone saying so.
//
// Nothing in the pipeline ever looked for this. buildPurpose asked the meeting-type
// profile for canned framing and, failing that, described the concept buckets the
// discussion touched - and the reviewer was then told "No purpose was stated in this
// meeting", which was asserted rather than tested. On a real transcript that opens
//
//   "What I want from you today on the call, Keon, is to sense check our academic
//    theory ... we need a way to be able to qualify her leads"
//
// the tool reported that nobody had said why they met.
//
// People do state a purpose, and they do it in a recognisable place and shape: in the
// first minute or two, in the first person, framing what they want out of the call. That
// is grammar, not subject matter, so this file contains no meeting vocabulary and cannot
// prefer one meeting's content to another's - the same guarantee meetingPurpose.js makes
// about profiles.

// Each cue captures the clause that follows it. They are deliberately few: a wider net
// catches "what I want from you is that spreadsheet" halfway through a meeting, which is
// a request, not a purpose.
const PURPOSE_CUES = [
  /\bwhat I (?:want|need|wanted|needed)(?: from (?:you|ye|everyone|you all))?(?:\s+(?:today|now|here|on (?:this|the) (?:call|meeting)))*(?:[^.?!]{0,40}?)\bis\b\s*(?:to\s+)?(.+)/i,
  /\bwhat (?:we(?:'re| are)|I(?:'m| am)) (?:trying|looking|hoping) to (?:do|get|achieve)(?:\s+today)?\s*(?:here\s*)?is\s*(?:to\s+)?(.+)/i,
  /\bthe (?:purpose|point|aim|goal|idea|objective|intention) of (?:this|the|today'?s?)\s+(?:call|meeting|session|chat|discussion)\b[^.?!]{0,30}?\bis\b\s*(?:to\s+)?(.+)/i,
  /\bwe(?:'re| are) here to\s+(.+)/i,
  /\bthe reason (?:for (?:this|today'?s?)|(?:we(?:'re| are)|I(?:'m| am)) (?:here|meeting|calling))\b[^.?!]{0,30}?\bis\b\s*(?:to\s+)?(.+)/i,
  /\b(?:this|today'?s?)\s+(?:call|meeting|session)\s+is\s+(?:to|about)\s+(.+)/i
];

// Trailing conversational tails. A purpose is over before these begin.
const TAIL = /\s*(?:,\s*)?\b(?:if you know what I mean|does that make sense|if that makes sense|you know|right|okay|yeah|isn'?t it|and (?:then|so)\b.*)\s*[.!?]*\s*$/i;

// Openings that mean the speaker is describing a request or a next step, not the reason
// for the meeting. "What I want from you is the updated deck" is an action.
const NOT_A_PURPOSE = /^(?:the\s+)?(?:updated?|latest|final|revised)?\s*(?:deck|file|document|spreadsheet|list|link|number|figure|copy|version|email|answer)\b/i;

const MIN_WORDS = 4;
const MAX_WORDS = 32;

// How far into the meeting a purpose statement is still a purpose statement. People say
// why they called a meeting while people are still arriving, not in the last five
// minutes. A quarter of the way in is generous and still excludes the body.
const OPENING_SHARE = 0.25;
const MIN_OPENING_EVENTS = 6;

function openingEvents(events) {
  const list = Array.isArray(events) ? events : [];
  if (!list.length) return [];
  return list.slice(0, Math.max(MIN_OPENING_EVENTS, Math.ceil(list.length * OPENING_SHARE)));
}

function tidyClause(value) {
  let text = clean(value);
  // Keep the first sentence only: the speaker usually carries straight on.
  text = text.split(/(?<=[.!?])\s+/)[0] || text;
  for (let pass = 0; pass < 3 && TAIL.test(text); pass += 1) text = text.replace(TAIL, '');
  text = text.replace(/[\s,;:]+$/, '');
  return text;
}

function usableClause(value) {
  const text = clean(value);
  if (!text) return false;
  if (/\?/.test(text)) return false;
  if (NOT_A_PURPOSE.test(text)) return false;
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < MIN_WORDS || words.length > MAX_WORDS) return false;
  // A clause that is still mid-thought reads as a fragment in the minutes.
  if (/\b(?:and|or|but|so|because|which|that)$/i.test(text)) return false;
  return true;
}

function asPurposeSentence(value) {
  const text = clean(value);
  if (!text) return '';
  const sentence = /[.!?]$/.test(text) ? text : `${text}.`;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

// Generic words carry no subject, so they cannot show that a purpose is about anything.
const EMPTY_WORDS = new Set([
  'about', 'actually', 'again', 'against', 'anything', 'around', 'because', 'been',
  'being', 'better', 'call', 'come', 'could', 'doing', 'else', 'everyone', 'from',
  'going', 'good', 'have', 'here', 'into', 'just', 'kind', 'know', 'like', 'looking',
  'made', 'make', 'meeting', 'mean', 'more', 'much', 'need', 'other', 'ours', 'over',
  'people', 'point', 'really', 'right', 'session', 'some', 'sort', 'stuff', 'sure',
  'take', 'talk', 'team', 'that', 'their', 'them', 'then', 'there', 'these', 'they',
  'thing', 'things', 'think', 'this', 'those', 'time', 'today', 'very', 'want', 'well',
  'what', 'when', 'where', 'which', 'while', 'with', 'work', 'would', 'your'
]);

// Does the purpose name something the meeting comes back to?
//
// "Sense check our academic theory" is a perfectly formed purpose sentence about nothing:
// "academic" and "theory" each appear exactly once in that transcript, in that sentence,
// while the meeting says "lead" ten times and "sales" eleven. It is a figure of speech
// standing where the subject should be, and it read in the minutes as - academic theory
// of what?
//
// A purpose that names its subject will use a word the meeting uses again. This tests
// that and nothing else: no vocabulary, no domain, no list of good subjects. The opening
// words are skipped because they are the verb - "sense check" recurs constantly in that
// meeting and says nothing about what was being sense checked.
const VERB_WORDS_SKIPPED = 2;
const SUBJECT_MUST_RECUR_IN_EVENTS = 2;

function namesARecurringSubject(clause, events, sourceId) {
  const words = clean(clause).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const subjectWords = [...new Set(words.slice(VERB_WORDS_SKIPPED))]
    .filter((word) => word.length >= 4 && !EMPTY_WORDS.has(word));
  if (!subjectWords.length) return false;
  const elsewhere = (Array.isArray(events) ? events : [])
    .filter((event) => event && event.id !== sourceId)
    .map((event) => clean(event.text).toLowerCase());
  return subjectWords.some((word) => {
    const pattern = new RegExp(`\\b${word}`, 'i');
    return elsewhere.filter((text) => pattern.test(text)).length >= SUBJECT_MUST_RECUR_IN_EVENTS;
  });
}

// The purpose somebody stated, or nothing. Returns the evidence id so the sentence is
// traceable to the moment it was said, like every other claim in the minutes.
function statedPurposeFromOpening(evidence) {
  for (const event of openingEvents(evidence && evidence.events)) {
    const text = clean(event && event.text);
    if (!text) continue;
    for (const cue of PURPOSE_CUES) {
      const match = cue.exec(text);
      if (!match) continue;
      const clause = tidyClause(match[1]);
      if (!usableClause(clause)) continue;
      // A purpose that names nothing the meeting returns to is worse than the meeting's
      // own title, which is what this then falls through to.
      if (!namesARecurringSubject(clause, evidence && evidence.events, event.id)) continue;
      return {
        text: asPurposeSentence(clause),
        evidenceIds: [event.id].filter(Boolean),
        speaker: clean(event.speaker) || '',
        source: 'stated_in_meeting'
      };
    }
  }
  return null;
}

// Failing that, the meeting's own title. It is the reviewer's own words - they typed or
// confirmed it on the first screen - so it is used exactly as given rather than being
// dressed into a sentence. Inventing "The meeting was called to..." around it would be
// our prose wrapped around their label, and the flag can say where it came from instead.
function purposeFromTitle(meeting = {}) {
  const title = clean(meeting.title || meeting.meetingTitle);
  if (!title) return null;
  const words = title.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 16) return null;
  // A title made only of an organisation name and a project code - "ACME T819" - names no
  // subject, so it says nothing about why anyone met. Ordinary words are what carry the
  // meaning, so require at least two of them: not a code, not an initialism.
  const ordinaryWords = words.filter((word) => /[a-z]/.test(word) && word.replace(/[^A-Za-z]/g, '').length >= 3);
  if (ordinaryWords.length < 2) return null;
  return { text: asPurposeSentence(title), evidenceIds: [], source: 'meeting_title' };
}

module.exports = { statedPurposeFromOpening, purposeFromTitle, namesARecurringSubject, PURPOSE_CUES };
