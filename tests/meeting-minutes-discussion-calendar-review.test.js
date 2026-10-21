'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewDiscussionCalendarDates } = require('../utils/meetingMinutesDateReview');

const source = (text, extra = {}) => [{ id: 'T0001', text, speaker: 'Morgan Lee', classification: 'keep', ...extra }];
const discussion = (text, extra = {}) => [{ id: 'topic-one', topic: 'Museum maintenance',
  points: [{ id: 'point-one', text, evidenceIds: ['T0001'], reviewFlagIds: [], ...extra }], decisions: [], openQuestions: [] }];

test('an explicitly stated inconsistent weekday and full date receives a linked source warning only', () => {
  const input = discussion('The gallery inspection is scheduled for Monday, June 17th, 2026.');
  const original = JSON.parse(JSON.stringify(input));
  const result = reviewDiscussionCalendarDates(input, source('The gallery inspection is on Monday the seventeenth of June 2026.'));
  assert.equal(result.flags.length, 1);
  assert.match(result.flags[0].message, /falls on Wednesday/);
  assert.deepEqual(result.flags[0].evidenceIds, ['T0001']);
  assert.deepEqual(result.discussion[0].points[0].reviewFlagIds, [result.flags[0].id]);
  assert.equal(result.discussion[0].points[0].text, input[0].points[0].text);
  assert.deepEqual(input, original);
});

test('a matching weekday and date does not receive a warning, including an explicit year independent of the meeting year', () => {
  const input = discussion('The payroll review is on Wednesday, 17 June 2026.');
  assert.deepEqual(reviewDiscussionCalendarDates(input, source('Payroll review: Wednesday 17 June 2026.'), { meetingDate: '2027-01-10' }).flags, []);
});

test('an unstated year uses only a supplied trusted anchor and remains explicitly conditional', () => {
  const input = discussion('The maintenance inspection will be on Sunday, March 12th.');
  const units = source('The inspection will be on Sunday the twelfth of March.');
  const result = reviewDiscussionCalendarDates(input, units, { meetingDate: '2027-02-10' });
  assert.equal(result.flags.length, 1);
  assert.match(result.flags[0].message, /without a year/);
  assert.match(result.flags[0].message, /confirmed meeting year \(2027\)/);
  assert.equal(result.discussion[0].points[0].text, input[0].points[0].text);
  assert.deepEqual(reviewDiscussionCalendarDates(input, units).flags, []);
  assert.deepEqual(reviewDiscussionCalendarDates(input, units, { meetingDate: '2027-02-30' }).flags, []);
});

test('a matching date without a stated year is not flagged and a relative next year is not replaced by the meeting year', () => {
  const input = discussion('The equipment review is on Friday, March 12th.');
  assert.deepEqual(reviewDiscussionCalendarDates(input, source('The equipment review is on Friday the twelfth of March.'), { meetingDate: '2027-01-10' }).flags, []);
  assert.deepEqual(reviewDiscussionCalendarDates(input, source('The equipment review is on Friday the twelfth of March next year.'), { meetingDate: '2026-01-10' }).flags, []);
});

test('an incidental date in cited background does not attach to a record that never states that date', () => {
  const result = reviewDiscussionCalendarDates(discussion('The gallery ventilation requires an inspection.'),
    source('The inspection is needed. The unrelated training event is Monday 17 June 2026.'));
  assert.deepEqual(result.flags, []);
});

test('primary evidence prevents a borrowed background date from distorting a retained claim', () => {
  const input = discussion('The inspection is on 17 June 2026.', { primaryEvidenceIds: ['T0002'], evidenceIds: ['T0001', 'T0002'] });
  const units = [...source('The unrelated course is Monday 17 June 2026.'), { id: 'T0002', text: 'The inspection is on Wednesday 17 June 2026.', classification: 'keep' }];
  assert.deepEqual(reviewDiscussionCalendarDates(input, units).flags, []);
});

test('removed source evidence and dates with a different explicit year do not create a warning', () => {
  assert.deepEqual(reviewDiscussionCalendarDates(discussion('The inspection is on 17 June 2026.'),
    source('Monday 17 June 2026.', { classification: 'remove' })).flags, []);
  assert.deepEqual(reviewDiscussionCalendarDates(discussion('The inspection is on 17 June 2027.'),
    source('Monday 17 June 2026.')).flags, []);
});

test('calendar warning IDs are stable across record ordering, link repeated references once and preserve reviewer prose', () => {
  const input = discussion('The gallery inspection is on 17 June 2026.', { reviewerAuthored: true, reviewFlagIds: ['reviewer-existing'] });
  input[0].decisions.push({ id: 'decision-two', text: 'The access check is on 17 June 2026.', evidenceIds: ['T0001'], reviewFlagIds: [] });
  const units = source('Monday 17 June 2026 is the inspection and access check.');
  const result = reviewDiscussionCalendarDates(input, units);
  assert.equal(result.flags.length, 1);
  const id = result.flags[0].id;
  assert.deepEqual(result.discussion[0].points[0].reviewFlagIds, ['reviewer-existing', id]);
  assert.deepEqual(result.discussion[0].decisions[0].reviewFlagIds, [id]);
  assert.equal(result.discussion[0].points[0].reviewerAuthored, true);
  assert.equal(result.discussion[0].points[0].text, input[0].points[0].text);
  const repeated = reviewDiscussionCalendarDates(result.discussion, units);
  assert.deepEqual(repeated, result, 'repeated presentation must not duplicate warnings or links');
  const reordered = reviewDiscussionCalendarDates([{ ...input[0], points: [], decisions: [...input[0].decisions, input[0].points[0]] }], units);
  assert.equal(reordered.flags[0].id, id);
});

test('neighboring dates are not paired with each other and a parenthetical weekday is checked against its own date', () => {
  const input = discussion('Inspections are on 17 June 2026 and 19 June 2026.');
  assert.deepEqual(reviewDiscussionCalendarDates(input,
    source('Wednesday 17 June 2026, Friday 19 June 2026.')).flags, []);
  const result = reviewDiscussionCalendarDates(input, source('The first inspection is 17 June 2026 (Monday).'));
  assert.equal(result.flags.length, 1);
  assert.match(result.flags[0].message, /falls on Wednesday/);
});

test('repeated explicit and unstated-year references to one calendar conflict share one stable warning', () => {
  const input = discussion('The museum checks are on 17 June 2026.', { evidenceIds: ['T0001', 'T0002'] });
  const units = [...source('The museum checks are Monday 17 June.'), { id: 'T0002', text: 'That is Monday 17 June 2026.', classification: 'keep' }];
  const result = reviewDiscussionCalendarDates(input, units, { meetingDate: '2026-05-10' });
  assert.equal(result.flags.length, 1);
  assert.deepEqual(result.flags[0].evidenceIds, ['T0001', 'T0002']);
  assert.doesNotMatch(result.flags[0].message, /without a year/);
  assert.deepEqual(result.discussion[0].points[0].reviewFlagIds, [result.flags[0].id]);
});
