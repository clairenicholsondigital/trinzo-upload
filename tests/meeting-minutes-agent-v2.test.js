'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const {
  sanitiseDetails,
  normaliseSourceUnits,
  preparedTranscriptFromUnits,
  salientDetailInventory,
  normaliseAgentResult,
  buildProposal,
  applyProposal,
  isIdeaOnlyContemplation
} = require('../utils/meetingMinutesAgentV2');
const { generateMeetingMinutesAgentDocx, timingLabel } = require('../utils/meetingMinutesAgentDocx');

const sourceUnits = normaliseSourceUnits([
  { id: 'T0001', speaker: 'Alex', timestamp: '00:01:02', text: 'We need to test all three alarms before approval.', classification: 'keep', confidence: 0.98 },
  { id: 'T0002', speaker: 'Priya', timestamp: '00:01:12', text: 'I will send the report to Alex by Friday.', classification: 'keep', confidence: 0.97 },
  { id: 'T0003', speaker: 'Alex', timestamp: '00:01:30', text: 'Maybe it is standard 60601 something; I am not sure.', classification: 'keep', confidence: 0.72 },
  { id: 'T0004', speaker: 'System', timestamp: '00:01:45', text: 'Recording stopped.', classification: 'remove', confidence: 0.99 }
]);

test('agent details omit organisation and prepared transcript has stable source references', () => {
  assert.deepEqual(sanitiseDetails({
    meetingTitle: 'Review', organisation: 'Must disappear', organization: 'Also disappear',
    meetingDate: '2026-06-23', allAttendees: ['Alex', 'Alex', 'Priya']
  }), {
    meetingTitle: 'Review', meetingDate: '2026-06-23', meetingLocation: '', meetingType: '', allAttendees: ['Alex', 'Priya']
  });
  const prepared = preparedTranscriptFromUnits(sourceUnits);
  assert.match(prepared, /^\[T0001\] Alex 00:01:02:/);
  assert.doesNotMatch(prepared, /Recording stopped/);
  assert.match(prepared, /\[T0003\]/);
});

test('restoring a removed source unit preserves order', () => {
  const restored = sourceUnits.map((unit) => unit.id === 'T0004' ? { ...unit, restored: true } : unit);
  const prepared = preparedTranscriptFromUnits(restored);
  assert.ok(prepared.indexOf('[T0003]') < prepared.indexOf('[T0004]'));
});

test('salient inventory catches quantities, alarms, approval and uncertain standards', () => {
  const inventory = salientDetailInventory(sourceUnits);
  assert.ok(inventory.some((item) => item.evidenceIds.includes('T0001')));
  assert.ok(inventory.some((item) => item.kind === 'standard_reference' && item.evidenceIds.includes('T0003')));
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
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.discussion[0].decisions.length, 1);
  assert.equal(result.discussion[0].openQuestions.length, 1);
  assert.deepEqual(result.actions[0].owners, ['Priya', 'Alex']);
  assert.equal(result.actions[0].timing.kind, 'target');
  assert.ok(result.reviewFlags.some((flag) => flag.kind === 'unclear_reference'));
});

test('unsupported evidence IDs are removed and visibly flagged', () => {
  const result = normaliseAgentResult({ actions: [{
    action: 'Send the report to Alex.', owner: 'Priya', deadline: 'Friday', evidenceIds: ['T9999']
  }] }, sourceUnits, 'actions');
  assert.ok(!result.actions[0].evidenceIds.includes('T9999'));
  assert.ok(result.reviewFlags.some((flag) => flag.kind === 'missing_evidence' && /unsupported source T9999/.test(flag.message)));
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

test('actions deduplicate only compatible owners and retain distinct deliverables', () => {
  const result = normaliseAgentResult({ actions: [
    { action: 'Send the completed report to Alex', owner: 'Priya', evidenceIds: ['T0002'] },
    { action: 'Send completed report to Alex', owner: 'Priya', evidenceIds: ['T0002'] },
    { action: 'Review the completed report', owner: 'Alex', evidenceIds: ['T0001'] }
  ] }, sourceUnits, 'actions');
  assert.equal(result.actions.length, 2);
});

test('idea-only contemplation is not promoted but a concrete recommendation remains', () => {
  assert.equal(isIdeaOnlyContemplation('Think about the parking issue and come back with a best idea.'), true);
  assert.equal(isIdeaOnlyContemplation('Consider the evidence and provide a written recommendation.'), false);
  const result = normaliseAgentResult({ actions: [
    { action: 'Think about the parking issue and come back with a best idea.', owner: 'Trevor', evidenceIds: ['T0001'] },
    { action: 'Consider the evidence and provide a written recommendation.', owner: 'Alex', evidenceIds: ['T0001'] }
  ] }, sourceUnits, 'actions');
  assert.equal(result.actions.length, 1);
  assert.match(result.actions[0].action, /written recommendation/);
});

test('proposal changes can be partially accepted without altering unselected records', () => {
  const before = [{ id: 'a', action: 'First' }, { id: 'b', action: 'Second' }];
  const after = [{ id: 'a', action: 'First revised' }, { id: 'b', action: 'Second' }, { id: 'c', action: 'Third' }];
  const proposal = buildProposal('actions', before, after);
  const addition = proposal.changes.find((change) => change.type === 'add');
  assert.deepEqual(applyProposal(before, proposal, [addition.id]), [...before, after[2]]);
});

test('Word export uses UK dates, timing labels and contains no organisation field', async () => {
  assert.equal(timingLabel({ kind: 'deadline', exactDate: '2026-06-23' }), 'Deadline: 23 Jun 2026');
  const buffer = await generateMeetingMinutesAgentDocx({
    title: 'Review', details: { meetingTitle: 'Review', meetingDate: '2026-06-23', organisation: 'Hidden' },
    discussion: [], actions: [], sourceUnits, reviewFlags: []
  }, true);
  const zip = await JSZip.loadAsync(buffer);
  const documentXml = await zip.file('word/document.xml').async('string');
  assert.match(documentXml, /23 Jun 2026/);
  assert.doesNotMatch(documentXml, /Organisation|Hidden/);
  assert.match(documentXml, /Evidence appendix/);
});
