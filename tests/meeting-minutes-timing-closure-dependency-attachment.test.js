'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../utils/meetingMinutesAgentV2');

const empty = () => ({ kind: 'not_stated', wording: '', exactDate: '' });
const beforeTrial = () => ({ kind: 'dependency', wording: 'before the trial', exactDate: '' });
const action = (id, wording, owners, evidenceIds, timing = empty()) =>
  ({ id, action: wording, owners, evidenceIds, timing, reviewFlagIds: [] });

test('a nearby different timed task survives attachment and final timing assessment', () => {
  const units = [
    { id: 'T0001', speaker: 'Morgan', text: 'I will review the pump inspection report.' },
    { id: 'T0002', speaker: 'Casey', text: 'I will check the motor pressure before the trial.' }
  ];
  const rows = [action('review', 'Review the pump inspection report.', ['Morgan'], ['T0001']),
    action('pressure', 'Check the motor pressure.', [], ['T0002'], beforeTrial())];
  const original = structuredClone(rows);
  const attached = V.attachNearbyDependencyConditions(rows, units);
  assert.deepEqual(attached, rows, 'proximity must neither donate timing nor delete the motor check');
  const final = V.finaliseActionTimings(attached, units, { meetingDate: '2026-06-17' });
  assert.deepEqual(final.actions.map(row => row.id), ['review', 'pressure']);
  assert.deepEqual(final.actions[0].timing, empty());
  assert.deepEqual(rows, original, 'the guard cannot rewrite its inputs');
});

test('a valid receiver condition does not authorize removing different work with the same condition', () => {
  const units = [
    { id: 'T0001', speaker: 'Morgan', text: 'I will review the pump inspection report before the trial.' },
    { id: 'T0002', speaker: 'Casey', text: 'I will check the motor pressure before the trial.' }
  ];
  const rows = [action('review', 'Review the pump inspection report.', ['Morgan'], ['T0001']),
    action('pressure', 'Check the motor pressure.', [], ['T0001', 'T0002'], beforeTrial())];
  assert.deepEqual(V.attachNearbyDependencyConditions(rows, units), rows);
});

test('explicit same-work same-owner source can reattach a duplicate condition', () => {
  const units = [{ id: 'T0001', speaker: 'Chair',
    text: 'Morgan will review the pump inspection report before the trial.' }];
  const rows = [action('review', 'Review the pump inspection report.', ['Morgan'], ['T0001']),
    action('check', 'Check the pump inspection report.', [], ['T0001'], beforeTrial())];
  const [attached] = V.attachNearbyDependencyConditions(rows, units);
  assert.equal(V.attachNearbyDependencyConditions(rows, units).length, 1);
  assert.equal(attached.id, 'review');
  assert.deepEqual(attached.timing, beforeTrial());
  assert.deepEqual(attached.evidenceIds, ['T0001']);
});

test('an explicit different owner keeps an apparently identical timed task separate', () => {
  const units = [
    { id: 'T0001', speaker: 'Morgan', text: 'I will review the pump inspection report.' },
    { id: 'T0002', speaker: 'Casey', text: 'I will review the pump inspection report before the trial.' }
  ];
  const rows = [action('review', 'Review the pump inspection report.', ['Morgan'], ['T0001']),
    action('check', 'Check the pump inspection report.', [], ['T0002'], beforeTrial())];
  assert.deepEqual(V.attachNearbyDependencyConditions(rows, units), rows);
});

test('mixed source assignments do not prove which owner owns an ownerless condition', () => {
  for (const second of [
    { id: 'T0002', speaker: 'Casey', text: 'I will review the pump inspection report before the trial.' },
    { id: 'T0002', speaker: 'Chair', text: 'Casey will review the pump inspection report before the trial.' }
  ]) {
    const units = [{ id: 'T0001', speaker: 'Morgan',
      text: 'I will review the pump inspection report before the trial.' }, second];
    const rows = [action('review', 'Review the pump inspection report.', ['Morgan'], ['T0001']),
      action('check', 'Check the pump inspection report.', [], ['T0001', 'T0002'], beforeTrial())];
    assert.deepEqual(V.attachNearbyDependencyConditions(rows, units), rows,
      'one supported owner quote cannot erase an independently sourced second owner');
  }
});

test('removed or qualified source is not permission to attach a stronger dependency', () => {
  for (const source of [
    { id: 'T0001', speaker: 'Morgan', classification: 'remove',
      text: 'I will review the pump inspection report before the trial.' },
    { id: 'T0001', speaker: 'Morgan',
      text: 'I will review the pump inspection report, ideally before the trial.' }
  ]) {
    const rows = [action('review', 'Review the pump inspection report.', ['Morgan'], ['T0001']),
      action('check', 'Check the pump inspection report.', [], ['T0001'], beforeTrial())];
    assert.deepEqual(V.attachNearbyDependencyConditions(rows, [source]), rows);
  }
});

test('a deictic condition attaches only to its immediately preceding owned work', () => {
  const units = [
    { id: 'T0001', speaker: 'Morgan', text: 'I will review the safety protocol.' },
    { id: 'T0002', speaker: 'Casey', text: 'Yes, just before we launch it.' }
  ];
  const rows = [action('review', 'Review the safety protocol.', ['Morgan'], ['T0001']),
    action('follow-up', 'Follow up on the safety protocol before launch.', [], ['T0002'],
      { kind: 'dependency', wording: 'before launch', exactDate: '' })];
  const attached = V.attachNearbyDependencyConditions(rows, units);
  assert.equal(attached.length, 1);
  assert.equal(attached[0].id, 'review');
  assert.equal(attached[0].timing.wording, 'before launch');
  assert.deepEqual(attached[0].evidenceIds, ['T0001', 'T0002']);
  const intervening = [units[0], { id: 'T0003', speaker: 'Casey',
    text: 'The motor pressure check is a separate task.' }, units[1]];
  assert.deepEqual(V.attachNearbyDependencyConditions(rows, intervening), rows,
    'the earlier report cannot reach across a substantive change of work');
});

test('unmatched condition meaning, extra work and reviewer-authored rows remain intact', () => {
  const units = [
    { id: 'T0001', speaker: 'Morgan', text: 'I will review the safety protocol.' },
    { id: 'T0002', speaker: 'Casey', text: 'Yes, just before we launch it.' }
  ];
  const review = action('review', 'Review the safety protocol.', ['Morgan'], ['T0001']);
  for (const orphan of [
    action('different-event', 'Follow up on the safety protocol before approval.', [], ['T0002'],
      { kind: 'dependency', wording: 'before approval', exactDate: '' }),
    action('different-work', 'Follow up on motor pressure before launch.', [], ['T0002'],
      { kind: 'dependency', wording: 'before launch', exactDate: '' }),
    { ...action('reviewer', 'Follow up on the safety protocol before launch.', [], ['T0002'],
      { kind: 'dependency', wording: 'before launch', exactDate: '' }), reviewerAuthored: true }
  ]) {
    const rows = [review, orphan];
    assert.deepEqual(V.attachNearbyDependencyConditions(rows, units), rows);
  }
  const manualReview = { ...review, reviewerAuthored: true };
  const duplicate = action('duplicate', 'Check the safety protocol.', [], ['T0002'],
    { kind: 'dependency', wording: 'before launch', exactDate: '' });
  assert.deepEqual(V.attachNearbyDependencyConditions([manualReview, duplicate], units), [manualReview, duplicate]);
});
