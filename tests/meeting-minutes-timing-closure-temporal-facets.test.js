'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../utils/meetingMinutesTemporalReview');
const { formatTimingLabel } = require('../utils/meetingMinutesTiming');
const sentence = wording => `Morgan will review the inspection report ${wording}.`;
const retained = (claim, source) => R.temporalMeaningRetained(sentence(claim), sentence(source));

test('recurring weekdays cannot become a single occurrence or acquire a new cadence', () => {
  for (const [claim, source] of [['Friday', 'every Friday'], ['this Friday', 'each Friday'], ['next Friday', 'weekly on Friday'],
    ['every Friday', 'every other Friday'], ['monthly on Friday', 'weekly on Friday'],
    ['Friday and every Monday', 'every Friday and Monday']]) assert.equal(retained(claim, source), false, `${source} -> ${claim}`);
  for (const [claim, source] of [['each Friday', 'every Friday'], ['weekly on Friday', 'every Friday'],
    ['Fridays', 'each Friday'], ['every two weeks on Friday', 'fortnightly on Friday']]) assert.equal(retained(claim, source), true, `${source} -> ${claim}`);
});

test('recurring ordinal weekdays retain their position within the recurring period', () => {
  assert.equal(retained('the second Monday of each month', 'the first Monday of every month'), false);
  assert.equal(retained('the first Monday of each month', 'the first Monday of every month'), true);
});

test('bounds cannot be exchanged, removed or attached to another date', () => {
  for (const [claim, source] of [['on Friday', 'by Friday'], ['by Friday', 'before Friday'], ['by Friday', 'after Friday'],
    ['in two weeks', 'within two weeks'], ['Friday', 'before Friday'],
    ['on Monday and by Friday', 'by Monday and on Friday']]) assert.equal(retained(claim, source), false, `${source} -> ${claim}`);
  for (const [claim, source] of [['by Friday', 'no later than Friday'], ['by Friday', 'on or before Friday'],
    ['Friday', 'on Friday'], ['within two weeks', 'within two weeks']]) assert.equal(retained(claim, source), true, `${source} -> ${claim}`);
});

test('dayparts retain both their meaning and the date they qualify', () => {
  for (const part of ['morning', 'afternoon', 'evening', 'noon', 'night', 'midnight']) {
    assert.equal(retained('Friday', `Friday ${part}`), false, part);
    assert.equal(retained(`Friday ${part}`, `Friday ${part}`), true, part);
  }
  assert.equal(retained('Friday evening', 'Friday morning'), false);
  assert.equal(retained('Friday and Monday morning', 'Friday morning and Monday'), false);
  assert.equal(retained('Friday noon', 'Friday midday'), true);
});

test('early, mid and late periods cannot disappear or move to another period', () => {
  for (const [claim, source] of [['next week', 'early next week'], ['August', 'mid-August'], ['next month', 'late next month'],
    ['next week and early next month', 'early next week and next month']]) assert.equal(retained(claim, source), false, `${source} -> ${claim}`);
  assert.equal(retained('early next week', 'early next week'), true);
  assert.equal(retained('mid-August', 'mid August'), true);
});

test('worded duration ranges retain both endpoints and their relationship', () => {
  for (const [claim, source] of [['within three weeks', 'within two to three weeks'], ['within two weeks', 'within two to three weeks'],
    ['in two to three weeks', 'within two to three weeks'], ['within two to four weeks', 'within two to three weeks']]) assert.equal(retained(claim, source), false, `${source} -> ${claim}`);
  assert.equal(retained('within 2-3 weeks', 'within two to three weeks'), true);
  assert.equal(retained('in two or three weeks', 'in two to three weeks'), true);
});

test('ordinary action timing labels preserve deadline semantics without upgrading a target', () => {
  const record = kind => ({ type: 'action', text: `Review the inspection report. Owners: Morgan. Timing: ${formatTimingLabel({ kind, wording: 'Friday', exactDate: '' })}.` });
  assert.equal(R.supportedByApprovedRecord(sentence('by Friday'), record('deadline')), true);
  assert.equal(R.supportedByApprovedRecord(sentence('by Friday'), record('target')), false);
  assert.equal(R.supportedByApprovedRecord(sentence('Friday'), record('target')), true);
});

test('false supported verdicts cannot validate lost temporal facets in either summary surface', () => {
  for (const [sourceTiming, claimTiming] of [['every Friday', 'Friday'], ['by Friday', 'on Friday'], ['Friday morning', 'Friday'], ['early next week', 'next week'], ['within two to three weeks', 'within three weeks']]) {
    const source = sentence(sourceTiming), claim = sentence(claimTiming);
    for (const field of ['executiveSummary', 'meetingObjectives']) {
      const values = { executiveSummary: field === 'executiveSummary' ? claim : '', meetingObjectives: field === 'meetingObjectives' ? [{ id: 'o1', text: claim }] : [] };
      const items = R.summaryTemporalCheckItems(values, { discussion: [{ points: [{ text: source, evidenceIds: ['T1'] }] }] });
      assert.equal(items.length, 1);
      const result = R.applySummaryTemporalCheckResults(values, items, [{ id: items[0].id, verdict: 'supported', evidenceQuote: source }]);
      assert.equal(result.accounting.complete, false, `${field}: ${sourceTiming} -> ${claimTiming}`);
      assert.deepEqual(result.values, values);
      assert.ok(result.flags.some(flag => flag.temporalField === field));
    }
  }
});

test('calendar and timezone constraints cannot disappear or be converted by the facet comparison', () => {
  assert.equal(retained('', 'Friday'), false);
  assert.equal(retained('Friday at 10:00 UTC', 'Friday at 11:00 BST'), false);
  assert.equal(retained('Friday at 09:00 UTC', 'Friday at 09:00 UTC'), true);
});
