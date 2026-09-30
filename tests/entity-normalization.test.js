'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  damerauLevenshtein,
  extractMentionedPeople,
  findAttendeeTextCorrections,
  normaliseAttendeeReferences,
  normalisePublishedParticipantReference
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

test('publication removes a generic role only when it prefixes a known person', () => {
  assert.equal(
    normalisePublishedParticipantReference('Participant Jenny Gough is available on Thursday.', ['Jenny Gough']),
    'Jenny Gough is available on Thursday.'
  );
  assert.equal(
    normalisePublishedParticipantReference('Participants should prepare questions.', ['Jenny Gough']),
    'Participants should prepare questions.'
  );
  assert.equal(
    normalisePublishedParticipantReference('Participant allocation remains under review.', ['Jenny Gough']),
    'Participant allocation remains under review.'
  );
});

test('publication uses meeting context to repair a close name without changing ordinary oral wording', () => {
  assert.equal(
    normalisePublishedParticipantReference(
      'A weekly recurrence call will be established for Oral alongside the working sessions.',
      ['Orla Skally']
    ),
    'A weekly recurrence call will be established for Orla alongside the working sessions.'
  );
  assert.equal(
    normalisePublishedParticipantReference('Training covers oral administration requirements.', ['Orla Skally']),
    'Training covers oral administration requirements.'
  );
});
