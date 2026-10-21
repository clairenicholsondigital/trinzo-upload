'use strict';

// Generic cases only: none of these sentences come from the evaluation corpus.
const test = require('node:test');
const assert = require('node:assert/strict');
const { relativeExactDate, backfillAskedTiming, normaliseSourceUnits } = require('../utils/meetingMinutesAgentV2');

const TUESDAY = '2026-03-10';

test('only precise anchored relative timing resolves from the meeting date', () => {
  // A week has several days; a duration has no due-date anchor by itself.
  for (const wording of ['this week', 'for the remainder of this week', 'end of the week', 'next week', 'two weeks', 'a fortnight']) assert.equal(relativeExactDate(wording, TUESDAY), '', wording);
  assert.equal(relativeExactDate('in two weeks', TUESDAY), '2026-03-24');
  assert.equal(relativeExactDate('in 10 days', TUESDAY), '2026-03-20');
  assert.equal(relativeExactDate('by the 17th', TUESDAY), '', 'the month is not established');
  assert.equal(relativeExactDate('before the next meeting; the seventh', TUESDAY), '', 'do not invent a next-month date');
});

test('an explicit day outranks an introductory weekday', () => {
  assert.equal(relativeExactDate('Tuesday the thirteenth, three pm', '2026-10-05'), '', 'do not infer a missing month from a possibly contradictory weekday');
  assert.equal(relativeExactDate('Tuesday 3rd November at noon', '2026-10-16'), '2026-11-03');
  assert.equal(relativeExactDate('Friday the sixth of November', '2026-10-16'), '2026-11-06');
  assert.equal(relativeExactDate('Tuesday', '2026-10-05'), '2026-10-06', 'a bare weekday remains relative');
});

test('things that are not dates stay unresolved', () => {
  assert.equal(relativeExactDate('the first batch', TUESDAY), '');
  assert.equal(relativeExactDate('a four-week pilot', TUESDAY), '');
  assert.equal(relativeExactDate('two weeks ago', TUESDAY), '');
});

test('the answer to "by when?" supplies an action its timing', () => {
  const units = normaliseSourceUnits([
    { id: 'T0001', speaker: 'Chair', text: 'Who is updating the supplier list?', classification: 'keep' },
    { id: 'T0002', speaker: 'Robin', text: "That'd be me, I have the old contracts.", classification: 'keep' },
    { id: 'T0003', speaker: 'Chair', text: 'By when?', classification: 'keep' },
    { id: 'T0004', speaker: 'Robin', text: 'Ten days, all being well.', classification: 'keep' }
  ]);
  const timing = backfillAskedTiming({ kind: 'not_stated', wording: '', exactDate: '' }, units, ['T0001', 'T0002'], { meetingDate: TUESDAY, action: 'Update the supplier list.', owners: ['Robin'] });
  assert.equal(timing.wording, 'ten days all being well');
  assert.equal(timing.exactDate, '', 'the qualified answer is useful wording, not a firm calendar day');
});

test('the answer is read from the rows after the question even past the cited window', () => {
  const units = normaliseSourceUnits([
    { id: 'T0001', speaker: 'Robin', text: "That'd be me, I will update the supplier list using the old contracts.", classification: 'keep' },
    { id: 'T0002', speaker: 'Chair', text: 'Good.', classification: 'keep' },
    { id: 'T0003', speaker: 'Robin', text: 'Ha, yes.', classification: 'keep' },
    { id: 'T0004', speaker: 'Chair', text: 'By when?', classification: 'keep' },
    { id: 'T0005', speaker: 'Robin', text: 'A fortnight.', classification: 'keep' }
  ]);
  const timing = backfillAskedTiming({ kind: 'not_stated', wording: '', exactDate: '' }, units, ['T0001'], { meetingDate: TUESDAY, action: 'Update the supplier list.', owners: ['Robin'] });
  assert.equal(timing.wording, 'a fortnight');
  assert.equal(timing.exactDate, '', 'a standalone span remains wording without a calendar-day anchor');
});

test('"how long" asks for a duration and never becomes a deadline', () => {
  const units = normaliseSourceUnits([
    { id: 'T0001', speaker: 'Sam', text: "I'll fix the loader and re-run the full regression.", classification: 'keep' },
    { id: 'T0002', speaker: 'Chair', text: 'How long is the full regression?', classification: 'keep' },
    { id: 'T0003', speaker: 'Sam', text: 'About two days of test time.', classification: 'keep' }
  ]);
  const timing = backfillAskedTiming({ kind: 'not_stated', wording: '', exactDate: '' }, units, ['T0001'], { meetingDate: TUESDAY });
  assert.equal(timing.kind, 'not_stated');
});

test('same-day wording resolves to the meeting date itself', () => {
  for (const wording of ['this afternoon', 'this morning', 'tonight', 'later today', 'by end of day', 'close of play']) {
    assert.equal(relativeExactDate(wording, TUESDAY), TUESDAY, wording);
  }
  assert.equal(relativeExactDate('tomorrow afternoon', TUESDAY), '2026-03-11');
});

test('"the second last week of July" is not the second of the month', () => {
  assert.equal(relativeExactDate('by the second last week of July', TUESDAY), '');
  assert.equal(relativeExactDate('the second-last week', TUESDAY), '');
  assert.equal(relativeExactDate('the 2nd last week', TUESDAY), '');
  assert.equal(relativeExactDate('the seventh', TUESDAY), '', 'the missing month remains unresolved');
});

test('a spelled-out ordinal mid-sentence, a duration or a month-named date is not read as a day of this month', () => {
  assert.equal(relativeExactDate('the second the chair starts talking I press record', TUESDAY), '');
  assert.equal(relativeExactDate('on site on the 20th for five days', TUESDAY), '', 'the day lacks its month and duration is not a due date');
  assert.equal(relativeExactDate('for five days', TUESDAY), '');
  assert.equal(relativeExactDate('about two days of test time', TUESDAY), '');
  // Explicit numeric and spoken dates are both authoritative here.
  assert.equal(relativeExactDate('the seventh of July', TUESDAY), '2026-07-07');
  assert.equal(relativeExactDate('the 10th of July', TUESDAY), '2026-07-10');
  assert.equal(relativeExactDate('by the tenth', TUESDAY), '', 'do not infer a month');
});

test('a span that counts from a condition has no fixed date', () => {
  const { relativeExactDate } = require('../utils/meetingMinutesAgentV2');
  assert.equal(relativeExactDate('once the draft arrives; a week to review it', '2026-06-17'), '');
  assert.equal(relativeExactDate('within two weeks', '2026-06-17'), '2026-07-01');
});

test('a spoken day with its month becomes a date', () => {
  const { relativeExactDate } = require('../utils/meetingMinutesAgentV2');
  assert.equal(relativeExactDate('for tenth of July', '2026-06-24'), '2026-07-10');
  assert.equal(relativeExactDate('the 10th of July', '2026-06-24'), '2026-07-10');
  assert.equal(relativeExactDate('the seventeenth of March', '2026-06-24'), '2026-03-17', 'a stated past date is not silently moved to next year');
  assert.equal(relativeExactDate('the seventeenth of March next year', '2026-06-24'), '2027-03-17');
  assert.equal(relativeExactDate('the thirty-second of July', '2026-06-24'), '');
});

test('an ordinal that goes on to name a period is not a day of the month', () => {
  assert.equal(relativeExactDate('before the first site week', TUESDAY), '');
  assert.equal(relativeExactDate('before the first site week, preferably the weekend before', TUESDAY), '');
  assert.equal(relativeExactDate('by the second project month', TUESDAY), '');
  assert.equal(relativeExactDate('before the third full working day', TUESDAY), '');
  assert.equal(relativeExactDate('until the fifth review year', TUESDAY), '');
  assert.equal(relativeExactDate('on the sixth training day', TUESDAY), '');
  assert.equal(relativeExactDate('by the 3rd working day', TUESDAY), '');
  assert.equal(relativeExactDate('on the 1st morning', TUESDAY), '');
  assert.equal(relativeExactDate('by the 2nd onboarding hour', TUESDAY), '');
});

test('a day of the month still stands when a connective separates it from a later period word', () => {
  assert.equal(relativeExactDate('by the 17th so the week after is free', TUESDAY), '');
  assert.equal(relativeExactDate('by the 17th, then the week after', TUESDAY), '');
  assert.equal(relativeExactDate('before the first', TUESDAY), '');
  assert.equal(relativeExactDate('by the 17th before the event starts', TUESDAY), '');
  assert.equal(relativeExactDate('by 17 March 2026', TUESDAY), '2026-03-17', 'an explicit complete date still resolves');
});
