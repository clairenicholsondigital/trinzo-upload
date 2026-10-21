'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../utils/meetingMinutesAgentV2');
const record = value => ({ id: 'schedule', text: value, evidenceIds: ['T0001', 'T0002'], reviewFlagIds: [] });
const source = (first, second) => [
  { id: 'T0001', speaker: 'Chair', text: first },
  { id: 'T0002', speaker: 'Chair', text: second }
];
const filter = (row, units) => V.filterUnsupportedQuantifiedDiscussion([{ id: 'schedule-topic', points: [row], decisions: [], openQuestions: [] }], units);

test('each phase binds its own subject and quantity instead of borrowing the first phase subject', () => {
  const units = source('The document preparation is planned for two weeks.', 'The laboratory inspection is planned for three days.');
  const row = record('Document preparation is planned for two weeks. The laboratory inspection is planned for three days.');
  assert.equal(V.quantifiedClaimGroundingIssue(row, units), null);
  const result = filter(row, units);
  assert.equal(result.discussion[0].points[0].text, row.text);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.flags, []);
});

test('wrong quantities, swapped phase quantities and another work cannot borrow a valid phase duration', () => {
  const units = source('The document preparation is planned for two weeks.', 'The laboratory inspection is planned for three days.');
  for (const claim of [
    'Document preparation is planned for two weeks. The laboratory inspection is planned for four days.',
    'Document preparation is planned for three days. The laboratory inspection is planned for two weeks.',
    'Document preparation is planned for two weeks. The warehouse calibration is planned for three days.'
  ]) {
    const result = filter(record(claim), units);
    assert.equal(result.discussion.length, 0, claim);
    assert.equal(result.removed.length, 1, claim);
    assert.deepEqual(result.flags, []);
  }
});

test('direct anonymous location-duration evidence preserves an accepted multiphase row as unresolved', () => {
  const units = source('Document preparation starts next Tuesday.', 'We will be on premises for three days.');
  const row = record('Document preparation starts next Tuesday. The on-premises inspection is planned for three days.');
  const before = structuredClone({ row, units });
  const issue = V.quantifiedClaimGroundingIssue(row, units);
  assert.equal(issue.unresolved, true);
  assert.deepEqual(issue.signatures, ['3 days']);
  const result = filter(row, units);
  assert.equal(result.discussion[0].points[0].text, row.text);
  assert.deepEqual(result.removed, []);
  assert.equal(result.flags.length, 1);
  assert.equal(result.flags[0].status, 'open');
  assert.equal(result.flags[0].kind, 'uncertain_fact');
  assert.match(result.flags[0].message, /named work needs review/);
  assert.deepEqual(result.discussion[0].points[0].reviewFlagIds, [result.flags[0].id]);
  assert.deepEqual(result.flags[0].evidenceIds, row.evidenceIds);
  assert.deepEqual({ row, units }, before);
  const again = filter(result.discussion[0].points[0], units);
  assert.deepEqual(again.flags, result.flags);
  assert.equal(again.discussion[0].points[0].reviewFlagIds.length, 1);
});

test('unresolved locative preservation cannot erase named actors, different work, location or amount', () => {
  for (const [claim, second] of [
    ['The on-premises inspection is planned for four days.', 'We will be on premises for three days.'],
    ['The off-premises inspection is planned for three days.', 'We will be on premises for three days.'],
    ['Morgan on-premises inspection is planned for three days.', 'Jordan will spend three days on premises.'],
    ['The on-premises inspection is planned for three days.', 'The calibration team will spend three days on premises.'],
    ['The on-premises inspection is planned for three days.', 'The document review is planned for three days and on premises presence is another topic.'],
    ['The on-premises inspection is planned for three days.', 'We could spend three days on premises.'],
    ['The on-premises inspection is planned for three days.', 'We will not be on premises for three days.'],
    ['The on-premises inspection is planned for three days.', 'We spent three days on premises.'],
    ['The on-premises inspection is planned for three days.', 'We will be on premises for three days for calibration.'],
    ['The on-premises inspection is planned for three days.', 'We will spend three days on premises repairing the furnace.']
  ]) {
    const result = filter(record('Document preparation starts Tuesday. ' + claim), source('Document preparation starts Tuesday.', second));
    assert.equal(result.discussion.length, 0, claim + ' <- ' + second);
    assert.equal(result.removed.length, 1);
  }
});

test('an unresolved valid phase cannot hide a false quantity in another phase', () => {
  const units = source('Document preparation is planned for two weeks.', 'We will be on premises for three days.');
  const result = filter(record('Document preparation is planned for four weeks. The on-premises inspection is planned for three days.'), units);
  assert.equal(result.discussion.length, 0);
  assert.equal(result.removed.length, 1);
  assert.deepEqual(result.flags, []);
});

test('a later subject cannot lend its identity backwards to a duration in the same turn', () => {
  const units = source('The annual charges are the next item.', 'We have not increased them in six years, and the cooling-water bill has nearly doubled.');
  const falseClaim = record('Cooling-water bills have nearly doubled in six years.');
  assert.ok(V.quantifiedClaimGroundingIssue(falseClaim, units));
  assert.equal(filter(falseClaim, units).discussion.length, 0);
});

test('supporting phase rows receive the same linked unresolved protection', () => {
  const child = record('The in-office inspection is planned for three days.');
  const units = source('Preparation starts Tuesday.', 'We will spend three days in the office.');
  const result = V.filterUnsupportedQuantifiedDiscussion([{ id: 'topic', points: [{ id: 'parent', text: 'Preparation starts Tuesday.', supportingDetails: [child] }], decisions: [], openQuestions: [] }], units);
  assert.equal(result.discussion[0].points[0].supportingDetails[0].text, child.text);
  assert.equal(result.flags.length, 1);
  assert.deepEqual(result.discussion[0].points[0].supportingDetails[0].reviewFlagIds, [result.flags[0].id]);
});
