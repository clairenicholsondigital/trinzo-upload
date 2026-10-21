'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewDiscussionCalendarDates, reviewMeetingCalendarDates } = require('../utils/meetingMinutesDateReview');

const units = [{ id: 'T0001', text: 'The equipment inspection is Saturday 13 September 2026.' },
  { id: 'T0002', text: 'The supplier conference is Sunday 13 September 2026.' }];
const row = (text, extra = {}) => ({ id: 'inspection', text, evidenceIds: ['T0001'], ...extra });

test('calendar conflicts are reviewed in supporting children without changing parent or reviewer wording', () => {
  const parent = row('Equipment inspection preparations were discussed.', { supportingDetails: [
    row('The equipment inspection is Saturday 13 September 2026.', { reviewerAuthored: true })
  ] });
  const result = reviewDiscussionCalendarDates([{ points: [parent] }], units, { meetingDate: '2026-08-12' });
  assert.equal(result.flags.length, 1);
  assert.equal(result.discussion[0].points[0].reviewFlagIds, undefined);
  const detail = result.discussion[0].points[0].supportingDetails[0];
  assert.equal(detail.text, parent.supportingDetails[0].text);
  assert.deepEqual(detail.reviewFlagIds, [result.flags[0].id]);
});

test('one source warning follows actions, objectives and related summary prose using one stable identity', () => {
  const content = {
    discussion: [{ points: [row('The equipment inspection is Saturday 13 September 2026.')] }],
    actions: [{ id: 'book', action: 'Book the equipment inspection.', evidenceIds: ['T0001'],
      timing: { kind: 'target', wording: 'Saturday 13 September 2026', exactDate: '' } }],
    meetingObjectives: [row('Prepare for the equipment inspection on Saturday 13 September 2026.')],
    executiveSummary: 'The equipment inspection is planned for Saturday 13 September 2026.'
  };
  const result = reviewMeetingCalendarDates(content, units, { meetingDate: '2026-08-12' });
  assert.equal(result.flags.length, 1);
  assert.equal(result.executiveSummary, content.executiveSummary);
  assert.equal(result.actions[0].timing.wording, content.actions[0].timing.wording);
  assert.deepEqual(result.actions[0].reviewFlagIds, [result.flags[0].id]);
  assert.deepEqual(result.meetingObjectives[0].reviewFlagIds, [result.flags[0].id]);
});

test('an unrelated date in confirmed context cannot attach a source conflict to an uncited summary', () => {
  const result = reviewMeetingCalendarDates({ discussion: [], actions: [], meetingObjectives: [],
    executiveSummary: 'The supplier conference is Sunday 13 September 2026.' }, units, { meetingDate: '2026-08-12' });
  assert.deepEqual(result.flags, []);
});

function reviewAppositive(source, meetingDate = '', text = 'The equipment inspection is planned for 13 September.') {
  return reviewDiscussionCalendarDates([{ points: [row(text)] }], [{ id: 'T0001', text: source }], { meetingDate });
}

test('a source nth-weekday date apposition raises a linked conflict without correcting the minutes', () => {
  const text = 'The equipment inspection is planned for the second Saturday in September, specifically 13 September.';
  const result = reviewAppositive('The equipment inspection is on the second Saturday in September, which is the thirteenth this year.', '2026-08-05', text);
  assert.equal(result.flags.length, 1);
  assert.match(result.flags[0].message, /not the second Saturday of September in 2026/);
  assert.equal(result.discussion[0].points[0].text, text);
  assert.deepEqual(result.discussion[0].points[0].reviewFlagIds, [result.flags[0].id]);
});

test('a valid nth-weekday apposition and a correctly bound relative year remain unflagged', () => {
  const source = 'The equipment inspection is on the second Saturday in September, which is the thirteenth this year.';
  assert.equal(reviewAppositive(source, '2025-08-05').flags.length, 0);
  assert.equal(reviewAppositive(source.replace('this year', 'next year'), '2024-08-05').flags.length, 0);
  assert.equal(reviewAppositive('The equipment inspection is on the last Friday of February, namely the twenty-eighth 2025.', '',
    'The equipment inspection is on 28 February 2025.').flags.length, 0);
});

test('an asserted date on the right weekday still conflicts with the wrong nth occurrence', () => {
  const result = reviewAppositive('The equipment inspection is on the first Saturday in September, which is the thirteenth 2025.');
  assert.equal(result.flags.length, 1);
  assert.match(result.flags[0].message, /not the first Saturday/);
});

test('yearless appositions remain unresolved without an anchor, while an explicit year is checked', () => {
  const source = 'The equipment inspection is on the second Saturday in September, which is the thirteenth this year.';
  assert.equal(reviewAppositive(source).flags.length, 0);
  assert.equal(reviewAppositive(source.replace('this year', '2026')).flags.length, 1);
});

test('a nearby different event or month cannot donate a day to an nth-weekday source statement', () => {
  for (const source of [
    'The equipment inspection is on the second Saturday in September. The supplier delivery is on the thirteenth this year.',
    'The equipment inspection is on the second Saturday in September; the supplier delivery is on 13 September.',
    'The equipment inspection is on the second Saturday in September, and the supplier delivery is on the thirteenth this year.',
    'The equipment inspection is on the second Saturday in September, which is the thirteenth of October this year.'
  ]) assert.equal(reviewAppositive(source, '2026-08-05').flags.length, 0, source);
});

test('a source calendar apposition does not flag unrelated retained material or invent an uncited day', () => {
  const source = 'The equipment inspection is on the second Saturday in September, which is the thirteenth this year.';
  assert.equal(reviewAppositive(source, '2026-08-05', 'The supplier delivery is planned for 14 September.').flags.length, 0);
  assert.equal(reviewAppositive('The equipment inspection is on the second Saturday in September.', '2026-08-05').flags.length, 0);
});
