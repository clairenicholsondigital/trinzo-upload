'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../utils/meetingMinutesSemanticPolicy');
const { reconcileGeneratedSemanticStage } = require('../utils/meetingMinutesSemanticStage');
const { validateReconciliationReceipt } = require('../utils/canonicalMinutes/actionSemanticReconciliation');
const api = require('../routes/api').stagedEvaluation;

const mode = value => policy.captureSemanticPolicy({
  MEETING_MINUTES_AGENT_SEMANTIC_RECONCILIATION_V1: value
});
const source = text => [{ id: 'T0001', speaker: 'Alex Reed', text }];
const row = (id, occurrenceId) => ({
  id, ...(occurrenceId ? { occurrenceId } : {}),
  action: 'Send the draft report.', owners: ['Alex Reed'],
  timing: { kind: 'not_stated', wording: '', exactDate: '' },
  evidenceIds: ['T0001'], reviewFlagIds: []
});
const baseResult = actions => ({
  changes: {
    actions, discussion: [], reviewFlags: [], pendingProposal: null,
    qualityState: { actions: {} }, passProvenance: []
  },
  reviewFlags: []
});

test('semantic safety: an explicitly captured new synchronous run outranks an inactive old generation policy', () => {
  const draft = { generation: { status: 'failed', semanticPolicy: mode('off') },
    _semanticPolicy: mode('on') };
  assert.equal(policy.semanticPolicyForRun(draft).mode, 'on');
  assert.equal(policy.semanticPolicyForFingerprint(draft).mode, 'on');
});

test('semantic safety: off mode performs no assessment and preserves the exact incoming result', async () => {
  const incoming = baseResult([row('A1'), row('A2')]);
  let calls = 0;
  const output = await reconcileGeneratedSemanticStage(incoming, {
    sourceUnits: source('I will send the draft report.')
  }, 'actions', { policy: mode('off'), ask: async () => { calls += 1; throw Error('unexpected provider'); } });
  assert.equal(output, incoming);
  assert.equal(calls, 0);
});

test('semantic safety: switching off a prior semantic run cannot restore stale originals over new legacy generation', async () => {
  const sourceUnits = source('I will send the draft report and provide the inventory.');
  const old = await api.finishMeetingAgentGeneratedStage(baseResult([row('old-one'), row('old-two')]), {
    sourceUnits, _semanticPolicy: mode('on')
  }, 'actions', { semanticAsk: async () => { throw Error('The deterministic setup must not call providers'); } });
  const admittedOld = api.admitMeetingAgentGeneratedActionChanges({ sourceUnits }, old.changes, 'old-semantic-run');
  const fresh = { sourceUnits, ...admittedOld, _semanticPolicy: mode('off') };
  const oldSemantic = structuredClone(fresh.qualityState.actions.semanticReconciliation);
  assert.equal(oldSemantic.applied, true);
  assert.equal(oldSemantic.receipts.length, 1);
  const newAction = { ...row('new-inventory'), action: 'Provide the inventory.' };
  const legacy = await api.finishMeetingAgentGeneratedStage({ changes: { actions: [newAction] }, reviewFlags: [] },
    fresh, 'actions', { semanticAsk: async () => { throw Error('Off mode must not call providers'); } });
  const regeneration = api.meetingAgentRegenerationChanges(fresh, 'actions', legacy.changes, legacy);
  assert.deepEqual(regeneration.changes.actions.map(item => item.action), ['Provide the inventory.'],
    'old reconciliation receipts cannot cause admission to replace new generated work with prior originals');
  const semantic = regeneration.changes.qualityState.actions.semanticReconciliation;
  assert.equal(semantic.applied, false);
  assert.equal(semantic.publishedApplied, false);
  assert.equal(semantic.mode, 'off');
  assert.equal(semantic.supersededByPolicyOff, true);
  assert.deepEqual(semantic.original, oldSemantic.original);
  assert.deepEqual(semantic.receipts, oldSemantic.receipts, 'inactive proof remains recoverable without authorizing new work');
  assert.deepEqual(fresh.qualityState.actions.semanticReconciliation, oldSemantic, 'historical saved metadata stays untouched');
});

test('semantic safety: shadow reports its projection without changing content, flags or proposal state', async () => {
  const incoming = baseResult([row('A1'), row('A2')]);
  const before = structuredClone(incoming);
  const output = await reconcileGeneratedSemanticStage(incoming, {
    sourceUnits: source('I will send the draft report.')
  }, 'actions', { policy: mode('shadow') });
  assert.deepEqual(incoming, before);
  assert.deepEqual(output.changes.actions, before.changes.actions);
  assert.deepEqual(output.changes.discussion, before.changes.discussion);
  assert.deepEqual(output.changes.reviewFlags, before.changes.reviewFlags);
  assert.deepEqual(output.changes.pendingProposal, before.changes.pendingProposal);
  const quality = output.changes.qualityState.actions.semanticReconciliation;
  assert.equal(quality.applied, false);
  assert.equal(quality.stats.merged, 1);
});

test('semantic safety: a copied explicitly kept occurrence is protected at the generated reconciliation boundary', async () => {
  const actions = [row('A1', 'one'), row('A2', 'two')];
  const output = await reconcileGeneratedSemanticStage(baseResult(actions), {
    sourceUnits: source('I will send the draft report.'),
    keptActionOccurrenceIds: ['two']
  }, 'actions', { policy: mode('on') });
  assert.deepEqual(output.changes.actions, actions);
  assert.equal(output.changes.qualityState.actions.semanticReconciliation.stats.merged, 0);
});

test('semantic safety: an applied proof remains valid for its actual survivor after mandatory identity admission', async () => {
  const sourceUnits = source('I will send the draft report.');
  const output = await api.finishMeetingAgentGeneratedStage(baseResult([row('A1'), row('A2')]), {
    sourceUnits, details: { meetingDate: '2026-10-22' }, _semanticPolicy: mode('on')
  }, 'actions', { semanticAsk: async () => { throw Object.assign(Error('offline test blocks providers'), { code: 'offline_test_provider_blocked' }); } });
  const quality = output.changes.qualityState.actions.semanticReconciliation;
  assert.equal(output.changes.actions.length, 1);
  assert.equal(quality.receipts.length, 1);
  const admitted = api.admitMeetingAgentGeneratedActionChanges({ sourceUnits }, output.changes, 'semantic-test');
  const persistedReceipt = admitted.qualityState.actions.semanticReconciliation.receipts[0];
  assert.ok(validateReconciliationReceipt(persistedReceipt, persistedReceipt.original,
    admitted.actions[0], api.meetingAgentDraftPayload({ sourceUnits }).sourceUnits), 'identity admission must retain a valid original-to-actual-survivor proof');
});

test('semantic safety: speculative persistence admits unique occurrences and current receipts without moving the reviewer', async () => {
  const sourceUnits = source('I will send the draft report and provide the inventory.');
  const actions = [row('A1'), row('A1'), { ...row('A1'), action: 'Provide the inventory.' }];
  const generated = await api.finishMeetingAgentGeneratedStage(baseResult(actions), {
    sourceUnits, _semanticPolicy: mode('on')
  }, 'actions', { semanticAsk: async () => { throw Error('The deterministic setup must not call providers'); } });
  assert.equal(generated.changes.actions.length, 2);
  const fresh = { draftId: 'speculative-proof-test', sourceUnits, actions: [], currentStep: 2, selectedStep: 2 };
  const input = { ...generated.changes, currentStep: 5, selectedStep: 5 };
  const before = structuredClone(input);
  const changes = api.meetingAgentUntouchedSpeculationChanges(fresh, 'actions', input);
  assert.equal(Object.hasOwn(changes, 'currentStep'), false);
  assert.equal(Object.hasOwn(changes, 'selectedStep'), false);
  assert.equal(new Set(changes.actions.map(item => item.id)).size, 2);
  assert.equal(new Set(changes.actions.map(item => item.occurrenceId)).size, 2);
  assert.ok(changes.actions.every(item => item.occurrenceId));
  const saved = api.meetingAgentDraftPayload({ ...fresh, ...changes });
  assert.equal(saved.currentStep, 2);
  assert.equal(saved.selectedStep, 2);
  const semantic = saved.qualityState.actions.semanticReconciliation;
  assert.equal(semantic.identityBinding.complete, true);
  assert.ok(semantic.receipts.every(receipt => saved.actions.some(survivor =>
    validateReconciliationReceipt(receipt, receipt.original, survivor, saved.sourceUnits))));
  assert.deepEqual(input, before);

  const corrupted = structuredClone(input);
  corrupted.qualityState.actions.semanticReconciliation.receipts[0].receiptHash = 'tampered';
  const recovered = api.meetingAgentUntouchedSpeculationChanges(fresh, 'actions', corrupted);
  assert.deepEqual(recovered.actions.map(item => item.action), actions.map(item => item.action),
    'failed speculative receipt binding restores every original instruction');
  assert.equal(new Set(recovered.actions.map(item => item.occurrenceId)).size, actions.length);
  const recovery = recovered.qualityState.actions.semanticReconciliation;
  assert.equal(recovery.applied, false);
  assert.deepEqual(recovery.receipts, []);
  assert.equal(recovery.identityBinding.complete, false);
  assert.ok(recovery.unresolved.some(item => item.reason === 'semantic_identity_binding_failed'));
  assert.equal(Object.hasOwn(recovered, 'currentStep'), false);
  assert.equal(Object.hasOwn(recovered, 'selectedStep'), false);
});

test('semantic safety: persisted quality-state normalization cannot rewrite immutable source witnesses or receipt bytes', async () => {
  const sourceUnits = source('I will send the draft report from meds app.');
  const output = await reconcileGeneratedSemanticStage(baseResult([row('A1'), row('A2')]), {
    sourceUnits
  }, 'actions', { policy: mode('on') });
  const quality = output.changes.qualityState.actions.semanticReconciliation;
  assert.equal(quality.receipts.length, 1);
  const before = structuredClone(quality);
  const payload = api.meetingAgentDraftPayload({ sourceUnits, ...output.changes });
  const savedQuality = payload.qualityState.actions.semanticReconciliation;
  assert.deepEqual(savedQuality, before, 'semantic proof/cache/original source data is immutable, separate from authored prose');
  const receipt = savedQuality.receipts[0];
  assert.ok(validateReconciliationReceipt(receipt, receipt.original, receipt.survivor, sourceUnits));
});


test('semantic safety: legacy-shaped generation retains preparation and other stages quality state', async () => {
  const prior = {
    preparation: { dateContext: { source: 'reviewer', meetingDate: '2026-10-22' } },
    discussion: { generatedFingerprint: 'discussion-proof' },
    summary: { temporalReview: { complete: false }, reviewerSummaryHash: 'reviewer-summary' }
  };
  const output = await reconcileGeneratedSemanticStage({ changes: { actions: [row('A1'), row('A2')] } }, {
    sourceUnits: source('I will send the draft report.'), qualityState: prior
  }, 'actions', { policy: mode('shadow') });
  assert.deepEqual(output.changes.qualityState.preparation, prior.preparation);
  assert.deepEqual(output.changes.qualityState.discussion, prior.discussion);
  assert.deepEqual(output.changes.qualityState.summary, prior.summary);
});

test('semantic safety: shadow and off have identical saved and published generated content', async () => {
  const sourceUnits = source('I will send 2 draft reports from meds app for GBP 40 on 22nd of October.');
  const actions = [row('A1'), row('A2')].map(item => ({ ...item,
    action: 'Send 2 draft reports from meds app for GBP 40 on 22nd of October.' }));
  const draft = { sourceUnits, details: { meetingDate: '2026-10-22' } };
  const off = await api.finishMeetingAgentGeneratedStage(baseResult(actions), {
    ...draft, _semanticPolicy: mode('off')
  }, 'actions');
  const shadow = await api.finishMeetingAgentGeneratedStage(baseResult(actions), {
    ...draft, _semanticPolicy: mode('shadow')
  }, 'actions');
  const offPayload = api.meetingAgentDraftPayload({ ...draft, ...api.normaliseMeetingAgentDraftChanges(off.changes) });
  const shadowPayload = api.meetingAgentDraftPayload({ ...draft, ...api.normaliseMeetingAgentDraftChanges(shadow.changes) });
  assert.deepEqual(shadowPayload.actions, offPayload.actions, 'shadow cannot alter persisted generated content');
  assert.deepEqual(api.meetingAgentPublicationContent(shadowPayload).actions,
    api.meetingAgentPublicationContent(offPayload).actions);
});

test('semantic safety: actual save and publication preserve applied proof with formatted prose and raw source', async () => {
  const sourceUnits = source('I will send the draft report from meds app for GBP 40.');
  const sourceBefore = structuredClone(sourceUnits);
  const actions = [row('A1'), row('A2')].map(item => ({ ...item,
    action: 'Send the draft report.' }));
  const draft = { sourceUnits, details: { meetingDate: '2026-10-22' }, _semanticPolicy: mode('on') };
  const output = await api.finishMeetingAgentGeneratedStage(baseResult(actions), draft, 'actions', { semanticAsk: async () => { throw Object.assign(Error('offline test blocks providers'), { code: 'offline_test_provider_blocked' }); } });
  assert.equal(output.changes.actions.length, 1, 'control exercises a real semantic merge');
  const admitted = api.admitMeetingAgentGeneratedActionChanges(draft, output.changes, 'semantic-boundary-test');
  const payload = api.meetingAgentDraftPayload({ ...draft, ...api.normaliseMeetingAgentDraftChanges(admitted) });
  const quality = payload.qualityState.actions.semanticReconciliation;
  assert.deepEqual(sourceUnits, sourceBefore, 'generation leaves the caller original source untouched');
  assert.equal(quality.receipts.length, 1);
  const receipt = quality.receipts[0];
  assert.ok(validateReconciliationReceipt(receipt, receipt.original, payload.actions[0], payload.sourceUnits),
    'the saved survivor must have a current source-bound proof');
  assert.ok(validateReconciliationReceipt(receipt, receipt.original,
    api.meetingAgentPublicationContent(payload).actions[0], payload.sourceUnits),
    'the actual visible survivor must retain the source-bound proof');
  assert.ok(receipt.coverage.some(item => item.sourceSpans.some(span => span.quote.includes('MDSAP') && span.quote.includes('GBP 40'))),
    'source witnesses retain verbatim wording from the immutable prepared source snapshot');
});

const semanticDiscussionFixture = () => [{
  id: 'topic-delivery', topic: 'Delivery',
  points: [
    { id: 'P1', text: 'The committee approved the extension.', evidenceIds: ['T0001'], reviewFlagIds: [], supportingDetails: [] },
    { id: 'P2', text: 'The extension was approved by the committee.', evidenceIds: ['T0001'], reviewFlagIds: [], supportingDetails: [] }
  ], decisions: [], openQuestions: []
}];
const accountedDistinctResponse = prompt => {
  const data = JSON.parse(prompt.slice(prompt.indexOf('\nDATA\n') + 6));
  return { version: data.version, packetHash: data.packetHash, sourceHash: data.sourceHash, inputHash: data.inputHash,
    decisions: data.candidates.map(item => ({ candidateId: item.candidateId, relation: 'distinct' })) };
};

test('semantic safety: exact source/context cache is reused and changed context requires a new assessment', async () => {
  const discussion = semanticDiscussionFixture(), sourceUnits = source('The committee approved the extension.');
  const incoming = { changes: { discussion, reviewFlags: [], qualityState: { discussion: {} } } };
  let calls = 0;
  const ask = async prompt => { calls += 1; return { result: accountedDistinctResponse(prompt), timings: [] }; };
  const first = await reconcileGeneratedSemanticStage(incoming, { sourceUnits }, 'discussion',
    { policy: mode('shadow'), context: { steer: 'Retain the agreed scope.' }, ask });
  assert.equal(calls, 1, 'fixture must exercise the provider/cache path');
  assert.equal(first.changes.qualityState.discussion.semanticReconciliation.cache.length, 1, 'synthetic response must validate and be cached');
  const second = await reconcileGeneratedSemanticStage(incoming, { sourceUnits, qualityState: first.changes.qualityState }, 'discussion',
    { policy: mode('shadow'), context: { steer: 'Retain the agreed scope.' }, ask });
  assert.equal(calls, 1);
  assert.equal(second.changes.qualityState.discussion.semanticReconciliation.calls[0].cached, true);
  await reconcileGeneratedSemanticStage(incoming, { sourceUnits, qualityState: first.changes.qualityState }, 'discussion',
    { policy: mode('shadow'), context: { steer: 'Retain the agreed scope and conditional wording.' }, ask });
  assert.equal(calls, 2, 'context change cannot adopt stale cached judgments');
  assert.deepEqual(second.changes.discussion, discussion);
});

test('semantic safety: failed or incorrectly accounted assessments preserve all rows and no applied receipt', async () => {
  for (const invalidAccounting of [false, true]) {
    const discussion = semanticDiscussionFixture(), sourceUnits = source('The committee approved the extension.');
    let calls = 0;
    const output = await reconcileGeneratedSemanticStage({ changes: { discussion, reviewFlags: [], qualityState: {} } },
      { sourceUnits }, 'discussion', { policy: mode('on'), ask: async prompt => {
        calls += 1;
        if (!invalidAccounting) throw Object.assign(Error('offline provider failure'), { code: 'offline_failure' });
        const result = accountedDistinctResponse(prompt);
        result.decisions[0].candidateId = 'unrequested-candidate';
        return { result, timings: [] };
      } });
    assert.equal(calls, 1);
    assert.deepEqual(output.changes.discussion, discussion);
    const quality = output.changes.qualityState.discussion.semanticReconciliation;
    assert.equal(quality.applied, false);
    assert.equal(quality.stats.complete, false);
    assert.deepEqual(quality.receipts, []);
    assert.deepEqual(quality.cache, []);
  }
});
