'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { stagedEvaluation: api } = require('../routes/api');

function fileCandidate(parentText, candidateText) {
  const collected = [];
  const sourceUnits = [{ id: 'T0001', speaker: 'Morgan Lee', text: `${parentText} ${candidateText}` }];
  const discussion = api.compactDiscussionPropositions([{
    id: 'controller', topic: 'Calibration controller',
    points: [{ id: 'controller-point', text: parentText, evidenceIds: ['T0001'], supportingDetails: [] }],
    decisions: [], openQuestions: []
  }], [], sourceUnits, {
    supportingCandidates: [{ mergeTarget: 'controller-point', candidate: {
      candidateId: 'supporting-controller', text: candidateText, evidenceIds: ['T0001']
    } }],
    promoteMaterialSupporting: false,
    onUnassignedSupportingDetail(detail, context) { collected.push({ ...detail, ...context }); return true; }
  });
  return { discussion, collected, details: discussion.flatMap(topic => topic.points.flatMap(point => point.supportingDetails || [])) };
}

test('one shared count cannot erase a different second count while filing supporting context', () => {
  const parent = 'The calibration controller supports 12 channels and 5 sensors.';
  const candidate = 'The calibration controller supports 12 channels and 3 sensors.';
  const result = fileCandidate(parent, candidate);
  assert.equal(result.discussion[0].points.length, 1);
  assert.equal(result.discussion[0].points[0].text, parent);
  assert.equal([...result.details, ...result.collected].filter(detail => detail.text === candidate).length, 1);
});

for (const [kind, parent, candidate] of [
  ['unit', 'The calibration sample requires 5 L of solution.', 'The calibration sample requires 5 mL of solution.'],
  ['bound', 'The calibration controller supports at most 12 channels.', 'The calibration controller supports at least 12 channels.'],
  ['range', 'The calibration controller supports 12 and 15 channels.', 'The calibration controller supports 12 to 15 channels.']
]) {
  test(`a differing numerical ${kind} remains independently reviewable while filing`, () => {
    const result = fileCandidate(parent, candidate);
    assert.equal(result.discussion[0].points.length, 1);
    assert.equal([...result.details, ...result.collected].filter(detail => detail.text === candidate).length, 1);
  });
}

test('identical numerical context already present does not create another reviewer detail', () => {
  const text = 'The calibration controller supports 12 channels and 5 sensors.';
  const result = fileCandidate(text, text);
  assert.equal(result.discussion[0].points.length, 1);
  assert.deepEqual(result.details, []);
  assert.deepEqual(result.collected, []);
});

test('compaction preserves an explicit supporting target through a merged primary alias', () => {
  const shorter = 'The cooling pressure validation is complete.';
  const longer = 'The cooling pressure validation is complete and the full comparison results are recorded.';
  const detailText = 'Cooling pressure calibration needs an independent overnight endurance run.';
  const collected = [];
  const sourceUnits = [{ id: 'T0001', speaker: 'Morgan Lee', text: `${shorter} ${longer} ${detailText}` }];
  const output = api.compactDiscussionPropositions([{
    id: 'pressure', topic: 'Cooling pressure validation', points: [
      { id: 'former-target', text: shorter, evidenceIds: ['T0001'], supportingDetails: [] },
      { id: 'retained-target', text: longer, evidenceIds: ['T0001'], supportingDetails: [] }
    ], decisions: [], openQuestions: []
  }], [], sourceUnits, {
    supportingCandidates: [{ mergeTarget: 'former-target', candidate: {
      candidateId: 'endurance-detail', text: detailText, evidenceIds: ['T0001']
    } }],
    promoteMaterialSupporting: false,
    onUnassignedSupportingDetail(detail) { collected.push(detail); return true; }
  });
  assert.equal(output.length, 1);
  assert.equal(output[0].points.length, 1);
  assert.equal(output[0].points[0].id, 'retained-target');
  assert.equal(output[0].points[0].supportingDetails.filter(detail => detail.text === detailText).length, 1);
  assert.deepEqual(collected, []);
});
