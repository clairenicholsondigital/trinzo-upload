'use strict';

// Shared publication policy; no generation, recovery or source-inference pipeline.
const TimingIntegrity = require('./meetingMinutesTiming');
const { text } = require('./meetingMinutesText');

// A timing column must contain timing. Models occasionally copy a nearby
// status clause into it ("there are some further updates that need to happen")
// simply because the clause appeared beside a commitment. Evidence support is
// not enough in that case: the words are in the transcript, but they do not say
// when the work is due or what it depends on.
const CALENDAR_TIMING = /\b(?:today|tonight|tomorrow|morning|afternoon|evening|day|days|week|weeks|month|months|quarter|quarters|year|years|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth|asap|immediately|shortly|soon|later|next|this|end of|by|before|within|no later than|due|deadline|target|\d{1,4})\b/i;
const DEPENDENCY_TIMING = /\b(?:if|after|before|once|when|whenever|following|upon|subject to|dependent on|depends on|pending|until|unless|provided that|based on|contingent on|as soon as|where .* (?:identified|found)|on completion|on approval|on receipt)\b/i;
const DEPENDENCY_LEAD_IN = /^(?:(?:and\s+)?(?:in parallel|then|separately|at the same time|in tandem)[,;:]?\s+)+(?=(?:if|after|before|once|when|whenever|following|upon|subject to|dependent on|pending|until|unless|provided that|based on|contingent on|as soon as|on completion|on approval|on receipt)\b)/i;
const DURATION_TASK_NOUN = /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)[ -](?:business[ -])?(?:day|week|month|quarter|year)s?[ -](?:pilot|trial|test|review|programme|program|project|phase|study|workshop|exercise|engagement|contract|period|cycle|sprint)\b/i;
const EXPLICIT_DUE_CUE = /\b(?:by|before|within|no later than|due|deadline|target|today|tonight|tomorrow|this\s+(?:week|month|quarter|year)|next\s+(?:week|month|quarter|year)|end of|on\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2})|at\s+\d{1,2})\b/i;
// The pronoun may be contracted: "I'll draft that." (draft 1055) came through
// the space-separated form untouched and was published as a deadline.
const RAW_TIMING_CLAUSE_START = /^(?:(?:i|we|you|he|she|they|it|there|here)(?:\s+(?:['’]?ll|will|shall|can|could|would|should|do|does|did|am|is|are|was|were|have|has|had|need|needs|want|wants|plan|plans|start|starts)|['’](?:ll|ve|re|d|m)\b)|(?:the|a|an|this|that)\s+[\p{L}\p{N}'’-]+\s+(?:will|shall|can|could|would|should|is|are|was|were|has|had|needs|starts)|[\p{Lu}][\p{L}'’-]+\s+(?:will|shall|can|could|would|should|is|was|has|needs|starts))\b/iu;
// Time words the two lists above do not carry but real timings use: "in a
// fortnight", "straight away", "during the live webinar", "by close of play".
const TIMING_SIGNAL_EXTRA = /\b(?:fortnight|now|straight away|right away|at once|first thing|close of play|end of play|end of the day|eod|cop|eom|eoy|lunchtime|noon|midday|midnight|o['’]clock|half past|quarter (?:past|to)|hours?|minutes?|[ap]\.?m\.?|q[1-4]|h[12]|sprint|release|launch|go-live|christmas|easter|new year|summer|autumn|winter|spring|during|throughout|while|whilst|ahead of|prior to|in time|ready for|depending on|dependent|depends|decision|outcome|start of|beginning of|middle of|mid-\w+|fortnightly|weekly|monthly|daily)\b/i;
function hasTimingSignal(wording = '') {
  const value = String(wording || '');
  return CALENDAR_TIMING.test(value) || DEPENDENCY_TIMING.test(value) || TIMING_SIGNAL_EXTRA.test(value)
    || /\b\d{1,2}(?:st|nd|rd|th)\b/i.test(value);
}

function normaliseTimingWording(timing = {}) {
  const kind = text(timing?.kind, 30);
  let wording = text(timing?.wording, 220);
  // Timing fields are labels rather than transcript quotations. Remove only
  // hedges immediately before an unmistakable time expression; a wider
  // removal could change substantive phrases such as "a kind of review".
  wording = wording.replace(/\b(?:kind|sort)\s+of\s+(?=(?:next|this|coming|following|today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|by|before|after|within|until|on)\b)/gi, '');
  // Targets are labels, not sentence fragments. "from now till race day"
  // carries the same target as "race day", but the latter is what belongs in
  // a compact timing field and is what the reviewer can scan quickly.
  if (kind === 'target') {
    wording = wording.replace(/^from\s+now\s+(?:until|till|to|through)\s+/i, '');
    wording = wording.replace(/^(?:until|till|through)\s+/i, '');
  }
  if (kind === 'dependency') {
    const trimmed = wording.replace(DEPENDENCY_LEAD_IN, '');
    if (trimmed !== wording) wording = trimmed.replace(/^([a-z])/, (letter) => letter.toUpperCase());
  }
  return { ...timing, kind, wording };
}

// A timing field must remain useful when it is read outside the conversation. Relative
// wording with an unresolved speaker perspective is not a date or a dependable
// dependency: "before you arrive" leaves the reader asking who "you" is and where they
// are arriving. Keep named-person references such as "before she arrives" for now; those
// can be resolved from the cited evidence, whereas second-person/collective deixis cannot
// safely be guessed at publication time.
const UNRESOLVED_DEICTIC_TIMING = /\b(?:before|after|when|once|until|by)\s+(?:(?:you|we|they)\b[^,.!?;]*\b(?:arrive|arrival|return|leave|get there|go there)\b|(?:your|our|their)\s+(?:arrival|return|visit)\b)/i;

// Timing is a compact date/target/dependency field, not a second copy of the action.
// Fail closed when a generated value is shaped like spoken action prose or when its only
// apparent calendar signal is the duration of the work itself ("four-week pilot").
function timingPublicationIssue(timing = {}) {
  const cleanTiming = normaliseTimingWording(timing);
  const wording = cleanTiming.wording;
  if (cleanTiming.kind === 'not_stated' || !wording) return '';
  if (RAW_TIMING_CLAUSE_START.test(wording)) return 'sentence_shaped_timing';
  if (UNRESOLVED_DEICTIC_TIMING.test(wording)) return 'unresolved_deictic_timing';
  if (cleanTiming.kind !== 'dependency' && DURATION_TASK_NOUN.test(wording) && !EXPLICIT_DUE_CUE.test(wording)) {
    return 'task_duration_not_due_date';
  }
  // Fail closed on wording with no time in it at all. "create those two
  // language characterization situations" was published as a deadline; it is
  // a copied clause, not a time. Of 1,554 stored timings only the copied
  // clauses lack every signal word above.
  if (!hasTimingSignal(wording)) return 'no_timing_signal';
  return '';
}

function timingForPublication(timing = {}) {
  const cleanTiming = normaliseTimingWording(timing);
  if (cleanTiming.exactDate && !TimingIntegrity.isValidCalendarDate(cleanTiming.exactDate)) cleanTiming.exactDate = '';
  if (!timingPublicationIssue(cleanTiming)) return cleanTiming;
  if (TimingIntegrity.isValidCalendarDate(cleanTiming.exactDate)) return { ...cleanTiming, wording: '' };
  return { kind: 'not_stated', wording: '', exactDate: '' };
}

function timingWordingHasMeaning(timing = {}) {
  const cleanTiming = normaliseTimingWording(timing);
  const kind = cleanTiming.kind;
  const wording = cleanTiming.wording;
  if (kind === 'not_stated') return !wording;
  if (!wording && TimingIntegrity.isValidCalendarDate(timing?.exactDate)) return true;
  if (!wording) return false;
  if (timingPublicationIssue(cleanTiming)) return false;
  // "if gaps are found during traceability review" arrived labelled a
  // deadline; the label is wrong, the timing is real. Any time signal counts,
  // whichever kind the model chose.
  return hasTimingSignal(wording);
}

module.exports = { CALENDAR_TIMING, DEPENDENCY_TIMING, hasTimingSignal, normaliseTimingWording, timingPublicationIssue, timingForPublication, timingWordingHasMeaning };
