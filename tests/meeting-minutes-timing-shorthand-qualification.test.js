'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../utils/meetingMinutesTiming');
const MinutesProposalTiming = require('../utils/meetingMinutesProposalTiming');
const options = { meetingDate: '2026-10-22' };
const row = wording => ({ id: 'send-report', action: 'Send the report.', owners: ['Alex Reed'],
  evidenceIds: ['T0001'], reviewFlagIds: [], timing: { kind: 'deadline', wording, exactDate: '2026-10-23' } });
const source = text => [{ id: 'T0001', speaker: 'Alex Reed', text, classification: 'keep' }];
const assess = (text, wording = 'Friday') => T.assessActionTiming(row(wording), source(text), options);

for (const qualifier of ['about', 'around']) {
  test(qualifier + ' attached to a calendar day cannot silently become a firm deadline', () => {
    const result = assess('I will send the report ' + qualifier + ' Friday.');
    assert.equal(result.action.timing.kind, 'target');
    assert.equal(result.assessment.status, 'qualified');
    assert.ok(result.issues.some(issue => issue.code === 'source_timing_qualification' && issue.preserveValue));
    assert.ok(result.binding.qualifiers.includes(qualifier));
    assert.equal(result.action.timing.exactDate, '2026-10-23');
  });
  test(qualifier + ' qualification reaches the final action and its visible linked warning', () => {
    const result = MinutesProposalTiming.finaliseActionTimings([row('Friday')], source('I will send the report ' + qualifier + ' Friday.'), options);
    assert.equal(result.actions[0].timing.kind, 'target');
    assert.ok(result.flags.some(flag => flag.systemTimingIssue?.code === 'source_timing_qualification'
      && result.actions[0].reviewFlagIds.includes(flag.id)));
  });
}
for (const [text, wording] of [
  ['I will send the report around 23 October 2026.', 'Friday'],
  ['I will send the report about Friday.', '23 October 2026']
]) test('calendar-equivalent labels retain source approximation: ' + text, () => {
  const result = assess(text, wording);
  assert.equal(result.action.timing.kind, 'target');
  assert.equal(result.assessment.status, 'qualified');
  assert.ok(result.issues.some(issue => issue.code === 'source_timing_qualification'));
});
test('a neighbouring task cannot donate its approximation to the report deadline', () => {
  const result = assess('I will send the report on Friday; I will inspect the pump around Friday.');
  assert.equal(result.action.timing.kind, 'deadline');
  assert.equal(result.issues.length, 0);
});
test('equivalent calendar wording cannot borrow approximation from another cited task', () => {
  const input = { ...row('23 October 2026'), evidenceIds: ['T0001', 'T0002'] };
  const units = [...source('I will send the report on Friday.'),
    { id: 'T0002', speaker: 'Alex Reed', text: 'I will inspect the pump around Friday.', classification: 'keep' }];
  const result = T.assessActionTiming(input, units, options);
  assert.equal(result.action.timing.kind, 'deadline');
  assert.equal(result.assessment.status, 'verified');
  assert.deepEqual(result.binding.qualifiers, []);
});
for (const text of [
  'I will send the report about safety on Friday.',
  'I will send the report around the office on Friday.',
  'I will send the report about 3 pumps on Friday.',
  'I will send the report on Friday.'
]) test('non-temporal about/around does not weaken a definite deadline: ' + text, () => {
  const result = assess(text);
  assert.equal(result.action.timing.kind, 'deadline');
  assert.equal(result.assessment.status, 'verified');
  assert.equal(result.issues.length, 0);
});
for (const [spoken, drafted] of [
  ['3pm', '4pm'], ['3 pm', '4 pm'], ['3 p.m.', '4 p.m.'],
  ['3am', '3pm'], ['12am', '12pm'], ['15:00', '4pm'], ['3pm', '16:00']
]) test('short clock conflict is rejected: ' + spoken + ' versus ' + drafted, () => {
  const result = assess('I will send the report on Friday at ' + spoken + '.', 'Friday at ' + drafted);
  assert.equal(result.binding.status, 'unsupported');
  assert.equal(result.binding.reason, 'clock_zone_or_day_part_conflict');
  assert.equal(result.action.action, 'Send the report.');
  assert.equal(result.action.timing.wording, '');
  assert.ok(result.assessment.rejectedWordings.includes('Friday at ' + drafted));
});
for (const [spoken, drafted] of [
  ['3pm', '3pm'], ['3 pm', '15:00'], ['3 p.m.', '15:00'],
  ['15:00', '3pm'], ['12am', '00:00'], ['12pm', '12:00'], ['3:30pm', '15:30']
]) test('faithful clock equivalents remain supported: ' + spoken + ' versus ' + drafted, () => {
  const result = assess('I will send the report on Friday at ' + spoken + '.', 'Friday at ' + drafted);
  assert.equal(result.binding.status, 'supported');
  assert.equal(result.assessment.status, 'verified');
  assert.equal(result.action.timing.wording, 'Friday at ' + drafted);
});
for (const suffix of ['for 3 pumps', 'for £3', 'for 3pmotors']) {
  test('unrelated numbers cannot prove a 3pm deadline: ' + suffix, () => {
    const result = assess('I will send the report on Friday ' + suffix + '.', 'Friday at 3pm');
    assert.equal(result.binding.status, 'unresolved');
    assert.equal(result.action.timing.wording, 'Friday at 3pm');
    assert.ok(result.issues.some(issue => issue.code === 'timing_source_unresolved'));
  });
}
test('conflicting shorthand creates a visible warning at the final generation boundary', () => {
  const input = row('Friday at 4pm');
  const result = MinutesProposalTiming.finaliseActionTimings([input], source('I will send the report on Friday at 3pm.'), options);
  assert.equal(result.actions[0].timing.kind, 'not_stated');
  assert.ok(result.flags.some(flag => flag.systemTimingIssue?.code === 'timing_value_removed'
    && result.actions[0].reviewFlagIds.includes(flag.id)));
  assert.equal(input.timing.wording, 'Friday at 4pm', 'input is not mutated');
});
test('reviewer-authored timing and existing review links remain intact', () => {
  const input = { ...row('Friday at 4pm'), reviewerAuthored: true, reviewFlagIds: ['reviewer-note'] };
  const result = MinutesProposalTiming.finaliseActionTimings([input], source('I will send the report on Friday at 3pm.'), options);
  assert.equal(result.actions[0].timing.wording, 'Friday at 4pm');
  assert.equal(result.actions[0].timing.exactDate, '2026-10-23');
  assert.deepEqual(result.actions[0].reviewFlagIds, ['reviewer-note']);
  assert.equal(result.actions[0].reviewerAuthored, true);
});
