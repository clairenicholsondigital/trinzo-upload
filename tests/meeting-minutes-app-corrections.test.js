'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../utils/meetingMinutesAgentV2');
const A = require('../routes/api').stagedEvaluation;
const { mergeCommitmentDuplicates, commitmentDetailsCovered } = require('../utils/canonicalMinutes/commitmentDuplicates');

const action = (id, wording, extra = {}) => ({
  id, action: wording, owners: ['Morgan Lee'], evidenceIds: ['T0001'],
  timing: { kind: 'not_stated', wording: '', exactDate: '' }, reviewFlagIds: [], ...extra
});
const payload = prompt => JSON.parse(prompt.split('refereePayload:\n')[1]);

test('an already selected referee batch keeps every identity through payload, validation and subset repair', () => {
  const candidates = Array.from({ length: 8 }, (_, i) => ({
    candidateId: `candidate-${i}`, sourcePass: 'primary', recordType: 'discussion_point',
    topic: 'Delivery', text: 'The supplier approval remains the delivery blocker.',
    evidenceIds: ['T0001'], sequence: i + 1
  }));
  const contract = A.meetingMinutesAgentRefereeContract('discussion', candidates, 'batch', { selected: true });
  assert.equal(contract.expectedCandidateIds.length, 8);
  assert.throws(() => { contract.candidates[0].candidateId = 'changed'; }, TypeError);
  candidates[0].text = 'Changed outside the contract.';
  const request = payload(A.meetingMinutesAgentRefereePrompt({ stage: 'discussion', candidates, contract }));
  assert.deepEqual(request.expectedCandidateIds, contract.expectedCandidateIds);
  assert.equal(request.candidateEnsemble.length, 8);
  assert.notEqual(request.candidateEnsemble[0].text, candidates[0].text);
  const rows = contract.candidates.map(c => ({ candidateId: c.candidateId, disposition: 'core',
    reason: 'Material blocker.', evidenceIds: ['T0001'] }));
  const response = { schemaVersion: 4, requestId: 'batch', stage: 'DISCUSSION_REFEREE',
    expectedCandidateCount: 8, returnedDispositionCount: 8, candidateDispositions: rows };
  assert.equal(A.meetingAgentDispositionError(response, contract.candidates, contract), null);
  const incomplete = { ...response, returnedDispositionCount: 7, candidateDispositions: rows.slice(0, 7) };
  const error = A.meetingAgentDispositionError(incomplete, contract.candidates, contract);
  assert.equal(error.code, 'incomplete_candidate_dispositions');
  const missing = A.meetingAgentRefereeRepairCandidates(contract.candidates, error.validCandidateDispositions);
  const repair = A.meetingMinutesAgentRefereeContract('discussion', missing, 'repair', { selected: true });
  const repairRequest = payload(A.meetingMinutesAgentRefereeRepairPrompt({ stage: 'discussion', contract: repair }));
  assert.deepEqual(repairRequest.expectedCandidateIds, ['candidate-7']);
  const merged = A.mergeMeetingAgentRefereeResults(incomplete, {
    ...response, requestId: 'repair', expectedCandidateCount: 1, returnedDispositionCount: 1,
    candidateDispositions: rows.slice(7)
  }, contract);
  assert.equal(A.meetingAgentDispositionError(merged, contract.candidates, contract), null);
});

test('a recipient needing a document does not displace its assigned preparer', () => {
  const units = [
    { id: 'T0001', speaker: 'Morgan Lee', text: 'The access checklist is still outstanding.' },
    { id: 'T0002', speaker: 'Priya Shah', text: 'I will need the access checklist.' }
  ];
  const record = action('one', 'Complete the access checklist.');
  assert.deepEqual(V.applyRequesterOwnerRule([record], units).actions[0].owners, ['Morgan Lee']);
  for (const wording of ['I will need the completed access checklist.', 'I am going to need the completed access checklist.']) {
    assert.deepEqual(V.applyRequesterOwnerRule([record], [units[0], { ...units[1], text: wording }]).actions[0].owners, ['Morgan Lee']);
  }
  assert.deepEqual(V.applyRequesterOwnerRule([record], [units[0], {
    ...units[1], text: 'I will need to complete the access checklist.'
  }]).actions[0].owners, [], 'a personal obligation to complete the work is still counter-evidence');
  for (const verb of ['complete', 'submit']) {
    const takingOver = structuredClone(units);
    takingOver[1].text = `I will ${verb} the access checklist.`;
    const result = V.applyRequesterOwnerRule([action('one', `${verb} the access checklist.`)], takingOver);
    assert.deepEqual(result.actions[0].owners, [], 'actual counter-evidence must still flag the wrong owner');
    assert.ok(result.flags.length);
  }
});

test('project words do not combine different documents or donate their deadline', () => {
  const checklist = action('check', 'Complete the access checklist for the site visit.', {
    timing: { kind: 'deadline', wording: 'Wednesday', exactDate: '2026-11-04' }
  });
  const pack = action('pack', 'Provide Alex Green with the travel itinerary and visitor pack for the site visit.', { evidenceIds: ['T0008'] });
  for (const rows of [[checklist, pack], [pack, checklist]]) {
    const result = A.dedupeHybridActionRecords(rows);
    assert.equal(result.length, 2);
    assert.deepEqual(result.find(r => r.id === 'pack').timing, pack.timing);
  }
  const review = action('report', 'Review the access report for the site visit.');
  const delivery = action('send', 'Send the safety report for the site visit to Alex Green.');
  assert.equal(A.sameDocumentDeliveryWorkflow(review, delivery), false);
  for (const preposition of ['for', 'on']) {
    assert.equal(A.sameDocumentDeliveryWorkflow(
      action('review', `Review the report ${preposition} access controls.`),
      action('send', `Send the report ${preposition} travel arrangements to Alex Green.`)
    ), false, 'qualifying subjects must not be discarded to manufacture document identity');
  }
});

test('shared ownership and citations do not suppress checking a different deliverable', () => {
  const existing = action('one', 'Review the product safety report.');
  for (const wording of ['Review the product translation report.', 'Confirm the product language requirements.']) {
    assert.equal(A.meetingAgentCommitmentRecheckNeeded(action('two', wording), [existing]), true);
  }
  assert.equal(A.meetingAgentCommitmentRecheckNeeded(structuredClone(existing), [existing]), false);
  assert.equal(A.meetingAgentCommitmentRecheckNeeded(action('two', existing.action, { owners: ['Priya Shah'] }), [existing]), true);
  assert.equal(A.meetingAgentCommitmentRecheckNeeded(action('two', existing.action, {
    timing: { kind: 'deadline', wording: 'Friday', exactDate: '2026-11-06' }
  }), [existing]), true, 'known timing must not disappear behind an undated task');
});

test('acknowledging someone else\'s assignment does not establish responsibility', () => {
  const units = [
    { id: 'T0001', speaker: 'Chair', text: 'Priya is reviewing the supplier report.' },
    { id: 'T0002', speaker: 'Morgan Lee', text: 'Okay.' },
    { id: 'T0003', speaker: 'Priya Shah', text: 'I will review the supplier report.' }
  ];
  const record = action('review', 'Review the supplier report.', { evidenceIds: ['T0001', 'T0002', 'T0003'] });
  assert.equal(V.ownerTakesItOn('Morgan Lee', units, record.action, []), false);
  assert.deepEqual(V.applyRequesterOwnerRule([record], units).actions[0].owners, []);
  const request = structuredClone(units);
  request[0].text = 'Morgan, could you review the supplier report?';
  assert.equal(V.ownerTakesItOn('Morgan Lee', request.slice(0, 2), record.action, []), true);
  assert.deepEqual(V.applyRequesterOwnerRule([record], request.slice(0, 2)).actions[0].owners, ['Morgan Lee']);
});

test('an orphan merge or supporting disposition stays unresolved instead of becoming a main point', () => {
  const units = [{ id: 'T0001', speaker: 'Chair', text: 'Supplier approval remains the delivery blocker.' }];
  const candidates = ['core', 'context'].map(candidateId => ({ candidateId, sourcePass: 'primary',
    recordType: 'discussion_point', topic: 'Delivery', text: units[0].text, evidenceIds: ['T0001'] }));
  for (const kind of ['merge', 'supporting']) {
    const dispositions = [
      { candidateId: 'core', disposition: 'core', targetId: 'approved-core', reason: 'Material.', evidenceIds: ['T0001'] },
      { candidateId: 'context', disposition: kind, targetId: 'approved-cor', reason: 'Context.', evidenceIds: ['T0001'] }
    ];
    const result = A.reconstructMissingRefereeDiscussion([], dispositions, candidates, units);
    assert.deepEqual(result.reconstructedTargetIds, ['approved-core']);
    assert.deepEqual(result.unresolvedTargetIds, ['approved-cor']);
    assert.equal(result.discussion[0].points.length, 1);
    const recovered = A.corroboratedOmittedDiscussionRecords(candidates, result.discussion, units);
    const fallback = A.compactDiscussionPropositions(result.discussion, recovered, units);
    assert.equal(fallback.flatMap(topic => topic.points).length, 1,
      'the existing omission fallback must not recreate the promoted duplicate');
    dispositions[1].targetId = 'approved-core';
    const valid = A.reconstructMissingRefereeDiscussion([], dispositions, candidates, units);
    assert.deepEqual(valid.unresolvedTargetIds, []);
    assert.equal(valid.discussion[0].points.length, 1);
    assert.equal(valid.discussion[0].points[0].supportingDetails.length, 1);
  }
});

test('duplicate reconciliation keeps the concrete rationale instead of the longer broad review', () => {
  const specific = action('specific', 'Add justification for the likelihood values and document the rationale used for occurrence categories in the reliability documentation.', { reviewFlagIds: ['specific-check'] });
  const broad = action('broad', 'Review and update the justification for likelihood and occurrence values in the reliability documentation.', { evidenceIds: ['T0001', 'T0002'], reviewFlagIds: ['broad-check'] });
  for (const rows of [[specific, broad], [broad, specific]]) {
    for (const merged of [A.dedupeHybridActionRecords(rows), mergeCommitmentDuplicates(rows).actions]) {
      assert.equal(merged.length, 1);
      assert.equal(merged[0].action, specific.action);
      const final = A.reconcileFinalApprovedActions(merged, rows);
      assert.equal(final.actions.length, 1);
      assert.equal(final.restored.length, 0);
      assert.deepEqual(new Set(final.actions[0].reviewFlagIds), new Set(['specific-check', 'broad-check']));
    }
  }
  assert.deepEqual(A.reconcileFinalApprovedActions([broad], [specific]).restored, [specific],
    'a broad review alone is not proof that the rationale requirement survived');
});

test('an invalid merge target is repaired without rechecking its valid core sibling', () => {
  const candidates = ['core', 'context'].map(candidateId => ({ candidateId, recordType: 'discussion_point',
    text: 'Supplier approval remains the delivery blocker.', evidenceIds: ['T0001'] }));
  const contract = A.meetingMinutesAgentRefereeContract('discussion', candidates, 'batch', { selected: true });
  const response = { schemaVersion: 4, requestId: 'batch', stage: 'DISCUSSION_REFEREE',
    expectedCandidateCount: 2, returnedDispositionCount: 2, candidateDispositions: [
      { candidateId: 'core', disposition: 'core', targetId: 'approved-core', reason: 'Material.', evidenceIds: ['T0001'] },
      { candidateId: 'context', disposition: 'merge', targetId: 'approved-cor', reason: 'Duplicate.', evidenceIds: ['T0001'] }
    ] };
  const error = A.meetingAgentDispositionError(response, candidates, contract);
  assert.equal(error.code, 'invalid_referee_target');
  assert.deepEqual(error.validCandidateDispositions.map(row => row.candidateId), ['core']);
  const subset = A.meetingAgentRefereeRepairCandidates(candidates, error.validCandidateDispositions);
  assert.deepEqual(subset.map(row => row.candidateId), ['context']);
  const repairContract = A.meetingMinutesAgentRefereeContract('discussion', subset, 'repair', {
    selected: true, retainedDiscussionTargets: [{ ...candidates[0], targetId: 'approved-core' }]
  });
  const repairPayload = payload(A.meetingMinutesAgentRefereeRepairPrompt({ stage: 'discussion', contract: repairContract }));
  assert.deepEqual(repairPayload.expectedCandidateIds, ['context']);
  assert.equal(repairPayload.candidateEnsemble.length, 1);
  assert.equal(repairPayload.expectedCandidateCount, 1);
  assert.equal(repairPayload.existingDiscussionTargets[0].targetId, 'approved-core');
  assert.equal(repairPayload.existingDiscussionTargets[0].text, candidates[0].text);
  assert.deepEqual(repairPayload.existingDiscussionTargets[0].evidenceIds, ['T0001']);
  const repair = { ...response, requestId: 'repair', expectedCandidateCount: 1, returnedDispositionCount: 1,
    candidateDispositions: [{ ...response.candidateDispositions[1], targetId: 'approved-core' }] };
  assert.equal(A.meetingAgentDispositionError(repair, subset, repairContract), null);
  const merged = A.mergeMeetingAgentRefereeResults({ ...response, candidateDispositions: error.validCandidateDispositions }, repair, contract);
  assert.equal(A.meetingAgentDispositionError(merged, candidates, contract), null);
  const rebuilt = A.reconstructMissingRefereeDiscussion([], merged.candidateDispositions, candidates,
    [{ id: 'T0001', speaker: 'Chair', text: candidates[0].text }]);
  assert.equal(rebuilt.discussion[0].points.length, 1);
  assert.deepEqual(rebuilt.unresolvedTargetIds, []);
});

test('recognising recording work in final reconciliation does not hide a separate document hand-off earlier', () => {
  const handoff = action('handoff', 'Document security risk considerations in the risk matrix and circulate the updated assessment to Priya Shah for review before wider circulation.');
  const update = action('update', 'Update the risk plan and risk matrix to document the agreed security and access control approach.', {
    evidenceIds: ['T0001', 'T0002', 'T0003', 'T0004', 'T0005', 'T0006']
  });
  for (const records of [[handoff, update], [update, handoff]]) {
    const merged = A.dedupeHybridActionRecords(records);
    assert.ok(merged.some(row => row.action.includes('circulate the updated assessment to Priya Shah for review before wider circulation')));
  }
});

test('detail coverage does not erase a negative instruction or change a condition', () => {
  assert.equal(commitmentDetailsCovered(
    action('one', 'Document the report and do not circulate it.'),
    action('two', 'Document the report and circulate it.')
  ), false);
  assert.equal(commitmentDetailsCovered(
    action('one', 'Update the report after approval.'),
    action('two', 'Update the report before approval.')
  ), false);
});

test('a verb-shaped document modifier is not stripped from the obligation being preserved', () => {
  for (const [specificText, broadText] of [
    ['Add the test report to the safety pack.', 'Update the safety report pack.'],
    ['Add the review checklist to the supplier report.', 'Update the supplier report checklist.']
  ]) {
    const specific = action('specific', specificText); const broad = action('broad', broadText);
    assert.equal(commitmentDetailsCovered(specific, broad), false);
    assert.deepEqual(A.reconcileFinalApprovedActions([broad], [specific]).restored, [specific]);
  }
});

test('editing the same named documents does not cover a separate delivery or testing step', () => {
  for (const operation of ['send', 'circulate', 'test', 'review']) {
    const specific = action('specific', `Add the product report and ${operation} the safety checklist.`);
    const broad = action('broad', 'Update the product report and the safety checklist.');
    assert.equal(commitmentDetailsCovered(specific, broad), false, operation);
    assert.deepEqual(A.reconcileFinalApprovedActions([broad], [specific]).restored, [specific], operation);
  }
});
