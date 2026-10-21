'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { alwaysInternalAttendeeName } = require('../utils/entityNormalization');
const { sanitiseDetails } = require('../utils/meetingMinutesAgentV2');
const { extractStagedDetailsFromTranscript } = require('../routes/api').stagedEvaluation;

// Advait Dharmadhikari and Saki Arimoto are always internal attendees, never client.

test('spelling variants resolve to the always-internal people', () => {
  for (const variant of [
    'Advait Dharmadhikari', 'advait', 'Adwait Dharmadhikari', 'Advaith Dharmadhikary',
    'Advait Dharmadikari', 'Dharmadhikari, Advait', 'Advait D', 'Dr. Advait Dharmadhikari'
  ]) assert.equal(alwaysInternalAttendeeName(variant), 'Advait Dharmadhikari', variant);
  for (const variant of ['Saki Arimoto', 'Saki', 'Sakki Arimotto', 'Arimoto, Saki', 'Saki-san']) {
    assert.equal(alwaysInternalAttendeeName(variant), 'Saki Arimoto', variant);
  }
});

test('different people with similar names are not matched', () => {
  for (const name of ['Sami', 'Suki', 'Saki Tanaka', 'Advait Kumar', 'Adam Dharma', 'Jacqui Fox', '']) {
    assert.equal(alwaysInternalAttendeeName(name), '', name);
  }
});

test('details move the always-internal people out of the client list', () => {
  const details = sanitiseDetails({
    internalAttendees: ['Jacqui Fox'],
    clientAttendees: ['Advait Dharmadikari', 'Rebecca Gill', 'Saki Arimoto']
  });
  assert.deepEqual(details.internalAttendees, ['Jacqui Fox', 'Advait Dharmadhikari', 'Saki Arimoto']);
  assert.deepEqual(details.clientAttendees, ['Rebecca Gill']);
});

test('unassigned always-internal people are not defaulted to client', () => {
  const details = sanitiseDetails({
    allAttendees: ['Jacqui Fox', 'Advait Dharmadhikari', 'Saki Arimoto', 'Rebecca Gill']
  });
  assert.deepEqual(details.internalAttendees, ['Jacqui Fox', 'Advait Dharmadhikari', 'Saki Arimoto']);
  assert.deepEqual(details.clientAttendees, ['Rebecca Gill']);
});

test('Teams speakers are bucketed as internal from the transcript', () => {
  const transcript = [
    'Project review transcript',
    '',
    'Jacqui Fox   0:05',
    'Morning everyone.',
    '',
    'Advait Dharmadikari   0:12',
    'Morning, I have the test results.',
    '',
    'Sakki Arimotto   0:20',
    'I can share the schedule.',
    '',
    'Rebecca Gill   0:31',
    'Thanks, that works for us.'
  ].join('\n');
  const details = extractStagedDetailsFromTranscript(transcript, 'review.vtt').screens.details;
  const cleaned = sanitiseDetails(details);
  assert.ok(cleaned.internalAttendees.includes('Advait Dharmadhikari'), JSON.stringify(cleaned));
  assert.ok(cleaned.internalAttendees.includes('Saki Arimoto'), JSON.stringify(cleaned));
  assert.ok(!cleaned.clientAttendees.some((name) => /advait|saki/i.test(name)), JSON.stringify(cleaned));
});
