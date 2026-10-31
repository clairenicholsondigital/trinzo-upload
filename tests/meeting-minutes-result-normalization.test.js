'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normaliseAgentResult } = require('../utils/meetingMinutesResultNormalization');
const { cleanActionWording } = require('../utils/meetingMinutesText');
const { normaliseSourceUnits } = require('../utils/meetingMinutesSource');
const { timingForPublication, timingWordingHasMeaning } = require('../utils/meetingMinutesTimingPublication');

const sourceUnits = normaliseSourceUnits([
  { id: 'T0001', speaker: 'Alex', timestamp: '00:01:02', text: 'We need to test all three alarms before approval.', classification: 'keep', confidence: 0.98 },
  { id: 'T0002', speaker: 'Priya', timestamp: '00:01:12', text: 'I will send the report to Alex by Friday.', classification: 'keep', confidence: 0.97 },
  { id: 'T0003', speaker: 'Alex', timestamp: '00:01:30', text: 'Maybe it is standard 60601 something; I am not sure.', classification: 'keep', confidence: 0.72 },
  { id: 'T0004', speaker: 'System', timestamp: '00:01:45', text: 'Recording stopped.', classification: 'remove', confidence: 0.99 }
]);

test('owned planning wrappers collapse to the concrete deliverable only', () => {
  assert.equal(cleanActionWording('Stuart Smith will determine a way to provide secure document access.'), 'Provide secure document access.');
  assert.equal(cleanActionWording('Work out a way to share the report.'), 'Share the report.');
  assert.equal(cleanActionWording('Determine the audit scope.'), 'Determine the audit scope.');
  assert.equal(cleanActionWording('Determine whether access is appropriate.'), 'Determine whether access is appropriate.');
});

test('generated timing rejects raw action sentences and task durations but keeps the action', () => {
  const units = normaliseSourceUnits([{
    id: 'T0150', speaker: 'Conor Flynn', classification: 'keep', confidence: 0.99,
    text: "We do a four-week pilot where we'd have a mix of manual and AI in order to test lead volume and quality."
  }]);
  const result = normaliseAgentResult({ actions: [{
    action: 'Run a mixed manual and AI pilot to test lead volume and quality.',
    owners: ['Conor Flynn'],
    timing: { kind: 'deadline', wording: "We do a four-week pilot where we'd have a mix of manual and AI", exactDate: '' },
    evidenceIds: ['T0150']
  }] }, units, 'actions');
  assert.equal(result.actions.length, 1);
  assert.deepEqual(result.actions[0].timing, { kind: 'not_stated', wording: '', exactDate: '' });
  assert.ok(result.reviewFlags.some((flag) => flag.kind === 'timing' && /copied action sentence/i.test(flag.message)));
  assert.equal(timingWordingHasMeaning({ kind: 'deadline', wording: 'four-week pilot', exactDate: '' }), false);
  assert.deepEqual(timingForPublication({ kind: 'deadline', wording: 'four-week pilot', exactDate: '' }), {
    kind: 'not_stated', wording: '', exactDate: ''
  });
});

test('generated action text does not repeat a structured date in a different spoken form', () => {
  const units = normaliseSourceUnits([{
    id: 'T0151', speaker: 'Alex Carter', classification: 'keep', confidence: 0.99,
    // This positive tests date repetition, with both named operations sourced.
    // A different operation cannot borrow a date (timing-integrity negatives).
    text: 'Alex will complete and submit the training attestation by 17th of July before the review starts.'
  }]);
  const result = normaliseAgentResult({ actions: [{
    action: 'Complete and submit the training attestation by the 17th of July before the review starts.',
    owners: ['Alex Carter'],
    timing: { kind: 'deadline', wording: '17th July', exactDate: '2026-07-17' },
    evidenceIds: ['T0151']
  }] }, units, 'actions', { meetingDate: '2026-06-22' });
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].action, 'Complete and submit the training attestation before the review starts.');
  assert.equal(result.actions[0].timing.exactDate, '2026-07-17');
});

test('expanded result supports decisions, questions, joint owners, targets and evidence flags', () => {
  const result = normaliseAgentResult({
    discussion: [{
      topic: 'Alarm testing',
      points: [{ text: 'Three alarms require testing.', evidenceIds: ['T0001'] }],
      decisions: [{ text: 'Approval follows alarm testing.', evidenceIds: ['T0001'] }],
      openQuestions: [{ text: 'Confirm the standard reference.', evidenceIds: ['T0003'] }]
    }],
    actions: [{
      action: 'Send the report to Alex.', owners: ['Priya', 'Alex'],
      timing: { kind: 'target', wording: 'Friday', exactDate: '' }, evidenceIds: ['T0002']
    }]
  }, sourceUnits, 'discussion');
  assert.equal(result.schemaVersion, 4);
  assert.equal(result.discussion[0].decisions.length, 1);
  assert.equal(result.discussion[0].openQuestions.length, 1);
  assert.deepEqual(result.actions[0].owners, ['Priya', 'Alex']);
  assert.equal(result.actions[0].timing.kind, 'target');
  assert.ok(result.reviewFlags.some((flag) => flag.kind === 'unclear_reference'));
});

test('generated actions use digits, compact target labels and a separate deadline field', () => {
  const units = normaliseSourceUnits([
    { id: 'T0100', speaker: 'Alex', text: "I'll order three hundred and fifty labels by Saturday.", classification: 'keep', confidence: 0.98 },
    { id: 'T0101', speaker: 'Alex', text: "I'll prepare the exam materials from now till race day.", classification: 'keep', confidence: 0.98 },
    { id: 'T0102', speaker: 'Alex', text: "I'll repair the water butt by Saturday.", classification: 'keep', confidence: 0.98 }
  ]);
  const result = normaliseAgentResult({ actions: [
    { action: 'Order three hundred and fifty labels by Saturday.', owners: ['Alex'], timing: { kind: 'deadline', wording: 'Saturday' }, evidenceIds: ['T0100'] },
    { action: 'Prepare the exam materials.', owners: ['Alex'], timing: { kind: 'target', wording: 'from now till race day' }, evidenceIds: ['T0101'] },
    { action: 'Repair the water butt by Saturday.', owners: ['Alex'], timing: { kind: 'deadline', wording: 'Saturday' }, evidenceIds: ['T0102'] }
  ] }, units, 'actions');
  assert.equal(result.actions[0].action, 'Order 350 labels.');
  assert.equal(result.actions[0].timing.wording, 'Saturday');
  assert.equal(result.actions[1].timing.wording, 'race day');
  assert.equal(result.actions[2].action, 'Repair the water butt.');
  assert.equal(result.actions[2].timing.wording, 'Saturday');
});

test('unsupported evidence IDs are removed and visibly flagged', () => {
  const result = normaliseAgentResult({ actions: [{
    action: 'Send the report to Alex.', owner: 'Priya', deadline: 'Friday', evidenceIds: ['T9999']
  }] }, sourceUnits, 'actions');
  assert.ok(!result.actions[0].evidenceIds.includes('T9999'));
  assert.ok(result.reviewFlags.some((flag) => flag.kind === 'missing_evidence' && /do not exist \(T9999\)/.test(flag.message)));
  assert.ok(result.actions[0].reviewFlagIds.length);
});

test('unsupported owners and timing are blanked and flagged without requiring participant membership', () => {
  const result = normaliseAgentResult({ actions: [{
    action: 'Send the report to Alex.', owners: ['Priya', 'Morgan'],
    timing: { kind: 'deadline', wording: 'next Tuesday', exactDate: '' }, evidenceIds: ['T0002']
  }] }, sourceUnits, 'actions');
  assert.deepEqual(result.actions[0].owners, ['Priya']);
  assert.deepEqual(result.actions[0].timing, { kind: 'not_stated', wording: '', exactDate: '' });
  assert.ok(result.reviewFlags.some((flag) => flag.kind === 'ownership'));
  assert.ok(result.reviewFlags.some((flag) => flag.kind === 'timing'));
});

test('a first-name assignment can resolve to an established full transcript speaker identity', () => {
  const identityUnits = normaliseSourceUnits([
    { id: 'T0300', speaker: 'Smith, Stuart M', text: 'Earlier context.', classification: 'keep' },
    { id: 'T0301', speaker: 'Jacqui Fox', text: 'Stuart will determine the training calendar.', classification: 'keep' }
  ]);
  const supported = normaliseAgentResult({ actions: [{
    action: 'Determine the training calendar.', owners: ['Stuart Smith'], evidenceIds: ['T0301']
  }] }, identityUnits, 'actions');
  assert.deepEqual(supported.actions[0].owners, ['Stuart Smith']);
  assert.ok(!supported.reviewFlags.some((flag) => flag.kind === 'ownership'));

  const inventedSurname = normaliseAgentResult({ actions: [{
    action: 'Determine the training calendar.', owners: ['Stuart Jones'], evidenceIds: ['T0301']
  }] }, identityUnits, 'actions');
  assert.deepEqual(inventedSurname.actions[0].owners, []);
  assert.ok(inventedSurname.reviewFlags.some((flag) => flag.kind === 'ownership'));
});

test('Teams surname-first speaker labels canonicalise before action deduplication', () => {
  const units = normaliseSourceUnits([
    { id: 'T0310', speaker: 'Smith, Stuart M', text: 'I will send the audit code to Niamh today.', classification: 'keep' }
  ]);
  const result = normaliseAgentResult({ actions: [
    { action: 'Send the audit code to Niamh today.', owners: ['Smith, Stuart M'], evidenceIds: ['T0310'] },
    { action: 'Send the audit code to Niamh today.', owners: ['Stuart Smith'], evidenceIds: ['T0310'] }
  ] }, units, 'actions');
  assert.equal(result.actions.length, 1);
  assert.deepEqual(result.actions[0].owners, ['Stuart Smith']);
});

test('a first name is not expanded when multiple transcript speakers share it', () => {
  const units = normaliseSourceUnits([
    { id: 'T0320', speaker: 'Alex Smith', text: 'I will send the report tomorrow.', classification: 'keep' },
    { id: 'T0321', speaker: 'Alex Jones', text: 'I will review it after that.', classification: 'keep' }
  ]);
  const result = normaliseAgentResult({ actions: [
    { action: 'Send the report tomorrow.', owners: ['Alex'], evidenceIds: ['T0320'] }
  ] }, units, 'actions');
  assert.deepEqual(result.actions[0].owners, ['Alex']);
});

test('actions deduplicate only compatible owners and retain distinct deliverables', () => {
  const actionUnits = normaliseSourceUnits([
    { id: 'T0400', speaker: 'Priya', text: 'I will send the completed report to Alex.', classification: 'keep' },
    { id: 'T0401', speaker: 'Alex', text: 'I will review the completed report.', classification: 'keep' }
  ]);
  const result = normaliseAgentResult({ actions: [
    { action: 'Send the completed report to Alex', owner: 'Priya', evidenceIds: ['T0400'] },
    { action: 'Send completed report to Alex', owner: 'Priya', evidenceIds: ['T0400'] },
    { action: 'Review the completed report', owner: 'Alex', evidenceIds: ['T0401'] }
  ] }, actionUnits, 'actions');
  assert.equal(result.actions.length, 2);
});

test('valid but unrelated evidence IDs cannot launder an unsupported action', () => {
  const units = normaliseSourceUnits([
    { id: 'T0600', speaker: 'Alex', text: 'The report was discussed as background.', classification: 'keep' },
    { id: 'T0601', speaker: 'Priya', text: 'Maybe we could create a dashboard one day.', classification: 'keep' }
  ]);
  const result = normaliseAgentResult({ actions: [
    { action: 'Send the report to Priya.', owner: 'Alex', evidenceIds: ['T0600'] },
    { action: 'Create a dashboard.', owner: 'Priya', evidenceIds: ['T0601'] }
  ] }, units, 'actions');
  assert.deepEqual(result.actions, []);
});
