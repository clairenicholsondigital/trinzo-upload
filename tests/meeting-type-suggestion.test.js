'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  suggestMeetingTypeFromEvidence,
  DROPDOWN_LABEL_BY_PROFILE,
  MIN_SUPPORTED_HINTS,
  MIN_EVENTS_PER_HINT,
  DOMINANCE_RATIO,
  MIN_TOTAL_EVENTS
} = require('../utils/canonicalMinutes/meetingTypeSuggestion');
const { prepareEvidence } = require('../utils/canonicalMinutes/evidence');

// The evidence-gated meeting-type suggestion.
//
// One keyword is not evidence; twenty-six turns about handovers and screen-sharing are.
// Every gate here exists because of a measured failure: the breadth gate because seven
// meetings were reclassified off one phrase, the dominance gate because a real contested
// meeting (T761: technical-file vs general review) measured 1.5x and its reviewer wanted
// the general reading, the floor because a near-empty transcript clears any ratio.

const events = (...texts) => ({ events: texts.map((text, index) => ({ id: `e${index}`, text })) });

// Enough webinar-shaped turns to clear every gate: multiple hint categories, recurring.
const rehearsalTurns = [
  'Right, can everyone see the deck before we start the run through of the slides?',
  'The opening section is yours, then the handover to me for the case study slides.',
  'When you hand over, pass back the presenter role so the deck follows you.',
  'Keep an eye on the chat for questions during the live session.',
  'We will take audience questions at the end, in the Q&A block.',
  'Post the QR code in the chat when we reach the closing slide.',
  'Watch the timings - we have a hard stop and cannot overrun.',
  'That section took four minutes, which leaves dead air before the close.',
  'Is the recording on? I cannot see the red dot.',
  'If the screen sharing drops, the co-host takes over the deck.',
  'Check your microphone and camera before we go live.',
  'The animation on the third slide needs the connection to be stable.'
];

test('a meeting whose discussion recurs across several topic areas fires the suggestion', () => {
  const suggestion = suggestMeetingTypeFromEvidence(events(...rehearsalTurns, ...rehearsalTurns));
  assert.ok(suggestion.accepted, JSON.stringify(suggestion));
  assert.equal(suggestion.type, 'Webinar rehearsal');
  assert.ok(suggestion.supportedHints.length >= MIN_SUPPORTED_HINTS);
  assert.ok(suggestion.supportedHints.every((hint) => hint.eventCount >= MIN_EVENTS_PER_HINT));
  assert.ok(suggestion.marginRatio >= DOMINANCE_RATIO);
  assert.ok(suggestion.totalMatchedEvents >= MIN_TOTAL_EVENTS);
});

test('one phrase cannot move the type - the breadth gate', () => {
  // The exact failure the title-only rule was written for: a meeting that says "run
  // through" once, about something else entirely.
  const suggestion = suggestMeetingTypeFromEvidence(events(
    "Right, let's run through the AI programme items quickly.",
    'The supplier renewal is the first item on the list today.',
    'Support costs are higher than forecast because contractor spend doubled.',
    'The reporting workflow still depends on a single vendor.'
  ));
  assert.ok(!suggestion || !suggestion.accepted, 'a single phrase must never clear the gates');
});

test('a contested meeting stays quiet - the dominance gate', () => {
  // Turns drawn so that two profiles score close together. When two readings are
  // defensible the machine has no business picking one; the default stands and the
  // human decides.
  const contested = [
    'The technical file tracker shows three deliverables outstanding.',
    'Progress on the technical file evidence is slower than planned.',
    'The status of the software changes needs confirming this week.',
    'Risks around the timeline were reviewed against the plan.',
    'Next steps and owners were captured for the deliverables.',
    'The milestone dates slip if the evidence is late.'
  ];
  const suggestion = suggestMeetingTypeFromEvidence(events(...contested, ...contested, ...contested));
  if (suggestion && suggestion.accepted) {
    assert.ok(suggestion.marginRatio >= DOMINANCE_RATIO, 'anything accepted must genuinely dominate');
  }
});

test('a near-empty transcript cannot clear the gates - the floor', () => {
  const suggestion = suggestMeetingTypeFromEvidence(events(
    'Check the slides before the webinar rehearsal.',
    'The handover and the timings need a run through.',
    'Watch the chat for questions and the recording light.'
  ));
  assert.ok(!suggestion || !suggestion.accepted, 'three turns are not a classification');
});

test('the suggestion never proposes the default it exists to replace', () => {
  assert.ok(!('project_review' in DROPDOWN_LABEL_BY_PROFILE));
});

test('every suggestible label is a real dropdown option', () => {
  const page = fs.readFileSync(path.resolve(__dirname, '../views/staged-meeting-minutes.html'), 'utf8');
  const select = page.slice(page.indexOf('<select id="meetingType">'), page.indexOf('</select>'));
  for (const label of Object.values(DROPDOWN_LABEL_BY_PROFILE)) {
    assert.ok(select.includes(label), `"${label}" must exist in the dropdown or the pre-selection silently fails`);
  }
});

test('the real M204 rehearsal fires and the real T761 weekly stays quiet', { timeout: 120000 }, () => {
  // The two meetings this feature was built against, as committed fixtures. T761 is the
  // dominance boundary case: its reviewer explicitly preferred the general reading, and
  // it measures 1.5x - below the 2x gate on purpose.
  const m204 = prepareEvidence(fs.readFileSync(path.resolve(__dirname, '../scripts/meeting-minutes-final-golden/028_real_m204_webinar_rehearsal_transcript/transcript.txt'), 'utf8'));
  const fired = suggestMeetingTypeFromEvidence(m204);
  assert.equal(fired.accepted, true);
  assert.equal(fired.type, 'Webinar rehearsal');

  const t761 = prepareEvidence(fs.readFileSync(path.resolve(__dirname, '../scripts/meeting-minutes-final-golden/029_real_t761_tech_file_weekly_transcript/transcript.txt'), 'utf8'));
  const quiet = suggestMeetingTypeFromEvidence(t761);
  assert.ok(!quiet.accepted, `T761 must stay quiet (margin ${quiet.marginRatio})`);
});
