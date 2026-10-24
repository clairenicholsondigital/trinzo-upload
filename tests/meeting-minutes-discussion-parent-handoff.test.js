'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../routes/api').stagedEvaluation;
const { normaliseRefereeOutput } = require('../utils/refereeNormaliser');
const { collectUnassignedSupportingDetails } = require('../utils/meetingMinutesSupportingDetails');

test('untargeted support survives batch merge, normalisation, reconstruction and compact filing without donating citations', () => {
  const units = [
    { id: 'T0001', speaker: 'Morgan', text: 'Cooling pressure inspection is complete.' },
    { id: 'T0002', speaker: 'Morgan', text: 'Supplier insurance is outstanding and requires broker confirmation.' }
  ];
  const candidates = units.map((u, i) => ({ candidateId: i ? 'insurance' : 'cooling', sourcePass: 'primary',
    recordType: 'discussion_point', topic: i ? 'Supplier insurance' : 'Cooling pressure', text: u.text,
    evidenceIds: [u.id], record: { id: i ? 'insurance' : 'cooling', text: u.text, evidenceIds: [u.id],
      reviewFlagIds: i ? ['insurance-warning'] : [], supportingDetails: [] } }));
  const dispositions = candidates.map((c, i) => ({ candidateId: c.candidateId, disposition: i ? 'supporting' : 'core',
    targetId: i ? '' : c.candidateId, evidenceIds: c.evidenceIds, reason: 'Reviewed against source.' }));
  const contract = A.meetingMinutesAgentRefereeContract('discussion', candidates, 'handoff', { selected: true });
  const batches = dispositions.map(row => ({ schemaVersion: 4, stage: 'DISCUSSION_REFEREE', candidateDispositions: [row] }));
  const merged = A.mergeBatchedMeetingAgentRefereeResults(batches, contract);
  const result = normaliseRefereeOutput(merged, candidates, { preserveUntargetedSupporting: true });
  assert.equal(A.meetingAgentDispositionError(result, candidates, contract), null);
  assert.equal(result.candidateDispositions[1].targetId, '');
  const rebuilt = A.reconstructMissingRefereeDiscussion([], result.candidateDispositions, candidates, units);
  const pool = [];
  const compact = A.compactDiscussionPropositions(rebuilt.discussion, [], units, {
    promoteMaterialSupporting: false,
    supportingCandidates: [{ candidate: candidates[1], mergeTarget: '' }],
    onUnassignedSupportingDetail: (detail, context) => { pool.push(...collectUnassignedSupportingDetails(detail, context)); return true; }
  });
  const main = compact.flatMap(t => t.points);
  assert.equal(main.length, 1);
  assert.deepEqual(main[0].evidenceIds, ['T0001']);
  assert.equal(main[0].supportingDetails.length, 0);
  assert.equal(pool.length, 1);
  assert.equal(pool[0].text, candidates[1].text);
  assert.equal(pool[0].originalTopic, 'Supplier insurance');
  assert.deepEqual(pool[0].evidenceIds, ['T0002']);
  assert.deepEqual(pool[0].reviewFlagIds, ['insurance-warning']);
  const invalid = structuredClone(result); invalid.candidateDispositions[1].disposition = 'merge';
  assert.ok(A.meetingAgentDispositionError(invalid, candidates, contract), 'untargeted merge must still fail validation');
});

test('reconstruction keeps a supporting explanation citations separate from its primary claim', () => {
  const units = [
    { id: 'T0001', speaker: 'Morgan', text: 'Validation testing is paused because the fixture is unavailable.' },
    { id: 'T0002', speaker: 'Priya', text: 'The validation fixture is unavailable because its certificate expired.' }
  ];
  const candidates = units.map((unit, i) => ({ candidateId: i ? 'why' : 'state', sourcePass: 'primary',
    recordType: 'discussion_point', topic: 'Validation fixture', text: unit.text, evidenceIds: [unit.id] }));
  const verdicts = candidates.map((c, i) => ({ candidateId: c.candidateId, disposition: i ? 'supporting' : 'core',
    targetId: 'state', reason: 'Source reviewed.', evidenceIds: c.evidenceIds }));
  const result = A.reconstructMissingRefereeDiscussion([], verdicts, candidates, units);
  const record = result.discussion.flatMap(t => t.points)[0];
  assert.deepEqual(record.evidenceIds, ['T0001']);
  assert.deepEqual(record.primaryEvidenceIds, ['T0001']);
  assert.equal(record.supportingDetails.length, 1);
  assert.deepEqual(record.supportingDetails[0].evidenceIds, ['T0002']);
});

for (const builder of ['meetingMinutesAgentRefereePrompt', 'meetingMinutesAgentRefereeRepairPrompt']) {
  test(`${builder} reassesses discussion without exposing previous classifications, while preserving action inputs`, () => {
    const sourceUnits = [{ id: 'T0001', speaker: 'Morgan', text: 'Testing is paused until the calibration fixture is recertified.' }];
    const candidates = [{ candidateId: 'test-state', sourcePass: 'primary', recordType: 'discussion_point',
      topic: 'Calibration fixture', text: sourceUnits[0].text, evidenceIds: ['T0001'], dispositionHint: 'supporting', priority: 3 }];
    const before = structuredClone(candidates);
    const payload = stage => JSON.parse(A[builder]({ stage, transcript: '', sourceUnits,
      candidates: stage === 'actions' ? candidates.map(c => ({ ...c, recordType: 'action' })) : candidates,
      details: { meetingDate: '2026-06-23' }, requestId: 'independence' }).split('refereePayload:\n')[1]);
    const discussion = payload('discussion');
    assert.equal(discussion.candidateEnsemble[0].dispositionHint, undefined);
    assert.equal(discussion.candidateEnsemble[0].priority, undefined);
    assert.equal(discussion.candidateEnsemble[0].text, candidates[0].text);
    assert.deepEqual(discussion.candidateEnsemble[0].evidenceIds, ['T0001']);
    assert.ok(discussion.preparedTranscript.includes(sourceUnits[0].text));
    const actions = payload('actions');
    assert.equal(actions.candidateEnsemble[0].dispositionHint, 'supporting');
    assert.equal(actions.candidateEnsemble[0].priority, 3);
    assert.deepEqual(candidates, before, 'private selection priorities and original discovery hints remain intact');
  });
}
