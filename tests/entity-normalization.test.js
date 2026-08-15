'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  damerauLevenshtein,
  extractMentionedPeople,
  findAttendeeTextCorrections,
  normaliseAttendeeReferences
} = require('../utils/entityNormalization');

test('Damerau distance treats Oral and Orla as one adjacent transposition', () => {
  assert.equal(damerauLevenshtein('Oral', 'Orla'), 1);
});

test('same-transcript person mentions can extend the known entity vocabulary safely', () => {
  const transcript = [
    'Orla, we need more engagement on this.',
    'Should we get that in writing from Orla?',
    'The oral medication requirement is separate.'
  ].join(' ');
  assert.deepEqual(extractMentionedPeople(transcript, ['Jacqui Fox']), ['Orla']);
});

test('person-shaped context repairs a close entity transcription variant', () => {
  const result = normaliseAttendeeReferences(
    'Schedule a weekly recurrence call with Oral to check in.',
    ['Jacqui Fox', 'Orla']
  );
  assert.equal(result.text, 'Schedule a weekly recurrence call with Orla to check in.');
  assert.equal(result.corrections.length, 1);
  assert.equal(result.corrections[0].replacement, 'Orla');
});

test('ordinary domain wording is not rewritten as an attendee name', () => {
  assert.deepEqual(findAttendeeTextCorrections('The device may be used with oral medication.', ['Orla']), []);
});
