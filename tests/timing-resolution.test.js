'use strict';

// Generic cases only: none of these sentences come from the evaluation corpus.
const test = require('node:test');
const assert = require('node:assert/strict');
const { relativeExactDate, backfillAskedTiming, normaliseSourceUnits } = require('../utils/meetingMinutesAgentV2');

const TUESDAY = '2026-03-10';

test('relative timing resolves from the meeting date', () => {
  assert.equal(relativeExactDate('this week', TUESDAY), '2026-03-13');
  assert.equal(relativeExactDate('for the remainder of this week', TUESDAY), '2026-03-13');
  assert.equal(relativeExactDate('end of the week', TUESDAY), '2026-03-13');
  assert.equal(relativeExactDate('next week', TUESDAY), '2026-03-20');
  assert.equal(relativeExactDate('two weeks', TUESDAY), '2026-03-24');
  assert.equal(relativeExactDate('a fortnight', TUESDAY), '2026-03-24');
  assert.equal(relativeExactDate('in 10 days', TUESDAY), '2026-03-20');
  assert.equal(relativeExactDate('by the 17th', TUESDAY), '2026-03-17');
  assert.equal(relativeExactDate('before the next meeting; the seventh', TUESDAY), '2026-04-07', 'earlier day of month means next month');
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
  const timing = backfillAskedTiming({ kind: 'not_stated', wording: '', exactDate: '' }, units, ['T0001', 'T0002'], { meetingDate: TUESDAY });
  assert.equal(timing.wording, 'ten days');
  assert.equal(timing.exactDate, '2026-03-20');
});

test('the answer is read from the rows after the question even past the cited window', () => {
  const units = normaliseSourceUnits([
    { id: 'T0001', speaker: 'Robin', text: "That'd be me, I have the old contracts.", classification: 'keep' },
    { id: 'T0002', speaker: 'Chair', text: 'Good.', classification: 'keep' },
    { id: 'T0003', speaker: 'Robin', text: 'Ha, yes.', classification: 'keep' },
    { id: 'T0004', speaker: 'Chair', text: 'By when?', classification: 'keep' },
    { id: 'T0005', speaker: 'Robin', text: 'A fortnight.', classification: 'keep' }
  ]);
  const timing = backfillAskedTiming({ kind: 'not_stated', wording: '', exactDate: '' }, units, ['T0001'], { meetingDate: TUESDAY });
  assert.equal(timing.exactDate, '2026-03-24');
});
