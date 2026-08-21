'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractiveLabel, isPublishableTopicLabel, publishableTopicCards } = require('../utils/canonicalMinutes/topicEditorial');

// A topic names what was discussed. These are things people said about it, and
// putting them at the head of a client-facing minute is embarrassing.
const SPEECH_SHAPED = [
  'Please do, belt and braces.',
  "Let's just nail the joins and the questions bit",
  'Can you send that over before Friday',
  'Sure, go ahead and book it',
  'Thanks everyone, that covers it',
  'Just double checking the numbers here'
];

// Subject labels. These must survive: the gate is worthless if it also removes
// the headings the minutes are built from.
const SUBJECT_LABELS = [
  'Content and communications',
  'Regulatory and compliance',
  'Electrical compliance testing: IEC 60601',
  'Software change traceability',
  'Risks and dependencies',
  'Decisions'
];

test('the auxiliary guard catches "do", which it was written to catch', () => {
  // /does?/ means "doe" plus an optional s: it matched "doe" and "does" but not
  // "do", so "Please do, belt and braces." passed a guard aimed squarely at it.
  assert.equal(extractiveLabel('Please do, belt and braces.'), '');
  assert.equal(extractiveLabel('We do the testing on Friday'), '');
});

test('speech-shaped phrases are refused as topic labels', () => {
  for (const phrase of SPEECH_SHAPED) {
    assert.equal(isPublishableTopicLabel(phrase), false, `should have been refused: ${phrase}`);
  }
});

test('subject labels are kept', () => {
  for (const label of SUBJECT_LABELS) {
    assert.equal(isPublishableTopicLabel(label), true, `should have been kept: ${label}`);
  }
});

test('the placeholder label never reaches a reviewer', () => {
  assert.equal(isPublishableTopicLabel('Substantive discussion'), false);
  assert.equal(isPublishableTopicLabel(''), false);
  assert.equal(isPublishableTopicLabel(null), false);
});

test('the gate covers every card regardless of which function named it', () => {
  const cards = [
    { topic: 'Regulatory and compliance', topicId: 'topic_01' },
    { topic: 'Please belt and braces', topicId: 'topic_85' },
    { topic: "Let's just nail the joins and the questions bit", topicId: 'decision_context_evt_0148' }
  ];
  assert.deepEqual(publishableTopicCards(cards).map((card) => card.topicId), ['topic_01'],
    'a label minted by decision-context recovery meets the same bar as an extractive one');
});

test('a topic the reviewer confirmed is never second-guessed', () => {
  const cards = [{ topic: "Let's just nail the joins", topicId: 't1', confirmedTopic: true }];
  assert.equal(publishableTopicCards(cards).length, 1,
    'a human chose this wording; it is theirs to write however they like');
});

test('the gate tests phrase shape, not specific wordings', () => {
  // The corpus discipline is that no transcript-specific phrase appears in
  // rules. "belt and braces" must never be named; it is refused because of
  // "Please", and the same phrase in a subject position is fine.
  const source = require('fs').readFileSync(require.resolve('../utils/canonicalMinutes/topicEditorial'), 'utf8');
  assert.ok(!/belt and braces/i.test(source), 'no transcript-specific phrase belongs in the rules');
  assert.equal(isPublishableTopicLabel('Belt and braces validation approach'), true);
});

test('technical subjects that read like modals are not refused', () => {
  // A guard on modal openers would refuse these; the pronoun rule already
  // catches the utterances that motivated one, so the modals stay out.
  for (const label of ['CAN bus integration testing', 'Do not resuscitate documentation', 'Will Anderson handover notes']) {
    assert.equal(isPublishableTopicLabel(label), true, `should have been kept: ${label}`);
  }
  assert.equal(isPublishableTopicLabel('Can you send that over before Friday'), false,
    'still refused, for its pronoun rather than its opener');
});
