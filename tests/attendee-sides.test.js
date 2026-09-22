'use strict';

// Generic names only; none of these people are in the evaluation corpus.
const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitiseDetails } = require('../utils/meetingMinutesAgentV2');

test('with nobody recognised as internal, nobody is labelled a client', () => {
  const details = sanitiseDetails({ allAttendees: ['Harriet Vale', 'Owen Blake', 'Mira Chen'] });
  assert.deepEqual(details.clientAttendees, []);
  assert.deepEqual(details.internalAttendees, ['Harriet Vale', 'Owen Blake', 'Mira Chen']);
});

test('a reviewer who put everyone on the client side keeps that choice', () => {
  const details = sanitiseDetails({ internalAttendees: [], clientAttendees: ['Harriet Vale', 'Owen Blake'], allAttendees: ['Harriet Vale', 'Owen Blake'] });
  assert.deepEqual(details.clientAttendees, ['Harriet Vale', 'Owen Blake']);
  assert.deepEqual(details.internalAttendees, []);
});

test('with an internal participant present, unrecognised people still default to the client side', () => {
  const details = sanitiseDetails({ internalAttendees: ['Harriet Vale'], clientAttendees: [], allAttendees: ['Harriet Vale', 'Owen Blake'] });
  assert.deepEqual(details.internalAttendees, ['Harriet Vale']);
  assert.deepEqual(details.clientAttendees, ['Owen Blake']);
});
