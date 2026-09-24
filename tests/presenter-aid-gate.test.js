'use strict';

// Generic cases only: none of these sentences come from the evaluation corpus.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isRehearsalMeetingType,
  isPresenterAidAction,
  applyPresenterAidGate
} = require('../utils/presenterAidGate');

const action = (text, extra = {}) => ({ id: 'a1', action: text, owners: [], timing: { kind: 'not_stated', wording: '', exactDate: '' }, ...extra });

test('the rehearsal meeting types are recognised, others are not', () => {
  assert.ok(isRehearsalMeetingType('Webinar rehearsal'));
  assert.ok(isRehearsalMeetingType('Presentation rehearsal'));
  assert.ok(isRehearsalMeetingType('Dry run'));
  assert.ok(!isRehearsalMeetingType('General'));
  assert.ok(!isRehearsalMeetingType('Audit kick-off'));
});

test('an aid the speaker keeps to hand is not an action', () => {
  assert.ok(isPresenterAidAction(action('Find and use the small clock at the top right while presenting.')));
  assert.ok(isPresenterAidAction(action('Keep your phone next to you to monitor messages.')));
  assert.ok(isPresenterAidAction(action('Have the slide deck open and ready on a second laptop.')));
  assert.ok(isPresenterAidAction(action('Keep the speaker notes in view during the talk.')));
});

test('work that produces, sends or changes something survives', () => {
  assert.ok(!isPresenterAidAction(action('Send the chair a five-minute warning during the session.')));
  assert.ok(!isPresenterAidAction(action('Restore the animation on the summary slide.')));
  assert.ok(!isPresenterAidAction(action('Start the recording when the first speaker begins.')));
  assert.ok(!isPresenterAidAction(action('Print twenty more handouts so there are spares.')));
  assert.ok(!isPresenterAidAction(action('Write three backup questions and circulate them.')));
});

test('an agreed, checkable limit is a commitment, not an aid', () => {
  // These read like delivery advice but are real commitments the minutes want.
  assert.ok(!isPresenterAidAction(action('Keep the personal introduction to thirty seconds.')));
  assert.ok(!isPresenterAidAction(action('Keep answers to no more than two minutes.')));
});

test('a dated commitment is scheduled work even when it names a device', () => {
  assert.ok(!isPresenterAidAction(action(
    'Have the laptop set up in the room and ready.',
    { timing: { kind: 'deadline', wording: 'before Friday', exactDate: '2026-08-14' } }
  )));
});

test('the gate only runs on a rehearsal, and reports what it dropped', () => {
  const rows = [
    action('Find and use the small clock at the top right while presenting.'),
    action('Restore the animation on the summary slide.')
  ];
  const off = applyPresenterAidGate(rows, 'General');
  assert.equal(off.actions.length, 2, 'a non-rehearsal meeting is untouched');
  assert.equal(off.dropped.length, 0);

  const on = applyPresenterAidGate(rows, 'Webinar rehearsal');
  assert.equal(on.actions.length, 1);
  assert.match(on.actions[0].action, /Restore the animation/);
  assert.equal(on.dropped.length, 1);
  assert.match(on.dropped[0].reason, /presenter aid/);
});

test('the input list is not mutated', () => {
  const rows = [action('Keep your phone next to you to monitor messages.')];
  applyPresenterAidGate(rows, 'Webinar rehearsal');
  assert.equal(rows.length, 1);
});
