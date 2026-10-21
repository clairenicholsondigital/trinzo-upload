'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../utils/meetingMinutesTiming');

const assess = (action, wording, text, owners = ['Casey Lee']) => T.assessActionTiming({
  action, owners, timing: { kind: 'target', wording, exactDate: '' }, evidenceIds: ['T1']
}, [{ id: 'T1', speaker: 'Morgan Patel', text, classification: 'keep' }], { meetingDate: '2026-06-22' });

test('a recipient needing a deliverable is not an alternative performer', () => {
  for (const receiver of ['which I will need', "which I'll need", 'which I’ll need', 'which I need', 'which Morgan Patel will need', 'that Morgan Patel needs']) {
    const result = assess('Provide the safety certificate.', 'By Friday',
      `Casey Lee will provide the safety certificate, ${receiver} by Friday.`);
    assert.notEqual(result.binding.status, 'unsupported', receiver);
    assert.equal(result.action.timing.wording, 'By Friday', receiver);
  }
});

test('a compound qualified requirement survives a recipient relative clause without false verification', () => {
  const wording = 'Before the inspection starts; ideally before Morgan Patel leaves, with contingency up to the 17th';
  const row = { action: 'Complete and provide the safety certificate before the inspection starts.', owners: ['Casey Lee'],
    timing: { kind: 'target', wording, exactDate: '' }, evidenceIds: ['T1', 'T2', 'T3'] };
  const units = [
    { id: 'T1', speaker: 'Morgan Patel', text: 'Then you will have the safety certificate, which I will need before the inspection starts.', classification: 'keep' },
    { id: 'T2', speaker: 'Morgan Patel', text: 'Ideally it would be good before I leave, but there is a later contingency.', classification: 'keep' },
    { id: 'T3', speaker: 'Morgan Patel', text: 'If not, we do have up to the 17th as contingency.', classification: 'keep' }
  ];
  const result = T.assessActionTiming(row, units, { meetingDate: '2026-06-22' });
  assert.equal(result.binding.status, 'unresolved');
  assert.equal(result.action.timing.wording, wording);
  assert.equal(result.action.timing.exactDate, '');
  assert.deepEqual(row.timing, { kind: 'target', wording, exactDate: '' }, 'assessment does not mutate the supplied model timing');
});

test('needing to perform work is still an explicit actor and cannot donate its date', () => {
  for (const text of [
    'Morgan Patel will provide the safety certificate by Friday.',
    'I will provide the safety certificate by Friday.',
    'Casey Lee has the safety certificate, which I will need to complete by Friday.',
    'Casey Lee has the safety certificate, which Morgan Patel will need to complete by Friday.'
  ]) {
    const result = assess('Complete and provide the safety certificate.', 'By Friday', text);
    assert.equal(result.binding.status, 'unsupported', text);
    assert.equal(result.action.timing.kind, 'not_stated', text);
  }
});

test('a receiver relative clause does not hide another explicit performer later in the clause', () => {
  const result = assess('Provide the safety certificate.', 'By Friday',
    'Casey Lee has the safety certificate, which I will need before Morgan Patel will provide the repair report by Friday.');
  assert.equal(result.binding.status, 'unsupported');
  assert.equal(result.action.timing.kind, 'not_stated');
});

test('different deliverables and operations remain distinct while own work stays supported', () => {
  const wrongObject = assess('Provide the safety certificate.', 'By Friday', 'Casey Lee will provide the repair report by Friday.');
  assert.equal(wrongObject.binding.status, 'unresolved', 'unchanged conservative calendar behavior must not certify another deliverable');
  const wrongOperation = assess('Review the safety certificate.', 'By Friday', 'Casey Lee will provide the safety certificate by Friday.');
  assert.equal(wrongOperation.binding.status, 'unsupported');
  assert.equal(wrongOperation.action.timing.kind, 'not_stated');
  const own = assess('Provide the safety certificate.', 'By Friday', 'Casey Lee will provide the safety certificate by Friday.');
  assert.equal(own.binding.status, 'supported');
  assert.equal(own.action.timing.wording, 'By Friday');
});

test('an obsolete version3 rejection cannot re-clear a recipient requirement on warm assessment', () => {
  assert.equal(T.TIMING_POLICY_VERSION, 4);
  const row = { action: 'Provide the safety certificate.', owners: ['Casey Lee'],
    timing: { kind: 'target', wording: 'By Friday', exactDate: '' }, evidenceIds: ['T1'] };
  const units = [{ id: 'T1', speaker: 'Morgan Patel', text: 'Casey Lee will provide the safety certificate, which I will need by Friday.', classification: 'keep' }];
  const rejected = T.rejectActionTiming(row, units, { meetingDate: '2026-06-22', reason: 'unsupported_timing_wording' });
  const warm = { ...row, timingDecision: { ...rejected.timingDecision, version: 3 } };
  const checked = T.assessActionTiming(warm, units, { meetingDate: '2026-06-22' });
  assert.notEqual(checked.binding.status, 'unsupported');
  assert.equal(checked.action.timing.wording, 'By Friday');
  assert.equal(checked.assessment.version, 4);
});
