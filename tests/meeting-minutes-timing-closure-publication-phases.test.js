'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { promoteMaterialTimingDetails } = require('../utils/meetingMinutesTemporalPublication');
const options = { meetingDate: '2026-10-21' };
function example(text, source = text, detailChanges = {}, unitChanges = {}) {
  const detail = { id: 'phase', text, evidenceIds: ['T0001'], ...detailChanges };
  const discussion = [{ topic: 'Inspection schedule', points: [{ id: 'parent', text: 'The inspection arrangements were reviewed.',
    evidenceIds: ['T0001'], supportingDetails: [detail] }], decisions: [], openQuestions: [] }];
  const units = [{ id: 'T0001', speaker: 'Chair', text: source, ...unitChanges }];
  return { discussion, units, result: promoteMaterialTimingDetails(discussion, units, options) };
}

test('source-proved broad phases and availability reach ordinary main publication without date invention', () => {
  for (const value of [
    'The calibration exercise will start next week.',
    'The calibration room is expected to be available Friday morning, probably.',
    'The inspection workshop is scheduled for three days.',
    'The calibration exercise will start next week and last for two to three weeks.'
  ]) {
    const e = example(value), before = structuredClone(e.discussion);
    assert.equal(e.result.promoted, 1, value);
    assert.deepEqual(e.result.discussion[0].points[1].text, value);
    assert.deepEqual(e.result.discussion[0].points[1].evidenceIds, ['T0001']);
    assert.equal(e.result.discussion[0].points[0].text, e.discussion[0].points[0].text);
    assert.deepEqual(e.discussion, before);
    assert.equal(promoteMaterialTimingDetails(e.result.discussion, e.units, options).promoted, 0);
  }
});

test('only a same-source phase-verb equivalent can preserve a weekday and its duration', () => {
  const value = 'The inspection workshop is scheduled to begin Monday and last three days.';
  assert.equal(example(value, 'The inspection workshop is scheduled to start Monday and last three days.').result.promoted, 1);
  assert.equal(example(value, 'The inspection workshop is scheduled to finish Monday and last three days.').result.promoted, 0);
});

test('phase promotion rejects changed work, owner, object, dates and timing qualifications', () => {
  for (const [value, source] of [
    ['The calibration exercise will start next week.', 'The calibration exercise will finish next week.'],
    ['The calibration exercise will start next week.', 'The training exercise will start next week.'],
    ['Morgan will start the inspection review next week.', 'Jordan will start the inspection review next week.'],
    ['The calibration exercise will start Monday.', 'The calibration exercise will start Tuesday.'],
    ['The calibration exercise will start 26 October 2026.', 'The calibration exercise will start 26 October 2027.'],
    ['The calibration exercise will start Friday.', 'The calibration exercise will start Friday probably.'],
    ['The calibration exercise will start by Friday.', 'The calibration exercise will start after Friday.'],
    ['The calibration exercise will start Friday morning.', 'The calibration exercise will start Friday afternoon.'],
    ['The calibration exercise will start next week and last three days.', 'The calibration exercise will start next week and last four days.'],
    ['The calibration exercise will start next week.', 'The calibration exercise will start next week after approval.'],
    ['The calibration exercise will start next week.', 'The calibration exercise will not start next week.']
  ]) assert.equal(example(value, source).result.promoted, 0, value + ' / ' + source);
});

test('questions, unaccepted ideas and internally conflicting dates cannot become main schedule facts', () => {
  for (const value of ['Could the calibration exercise start next week?',
    'The calibration exercise could start next week.',
    'One option is that the calibration exercise will start next week.',
    'The calibration exercise is scheduled to start Saturday 25 October 2026.']) {
    assert.equal(example(value).result.promoted, 0, value);
  }
  assert.equal(example('The calibration exercise will start next week.', 'The calibration exercise will start next week?').result.promoted, 0);
});

test('reviewer-authored or uncited context stays untouched and unproved paraphrases remain collapsed', () => {
  const value = 'The calibration exercise will start next week.';
  assert.equal(example(value, value, { reviewerAuthored: true }).result.promoted, 0);
  assert.equal(example(value, value, { evidenceIds: [] }).result.promoted, 0);
  assert.equal(example(value, value, {}, { classification: 'remove' }).result.promoted, 0);
  assert.equal(example(value, 'The testing activity is due to get underway next week.').result.promoted, 0);
  const e = example(value);
  e.discussion[0].reviewerAuthored = true;
  assert.deepEqual(promoteMaterialTimingDetails(e.discussion, e.units, options).discussion, e.discussion);
});
