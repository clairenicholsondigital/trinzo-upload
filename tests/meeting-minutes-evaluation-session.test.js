'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEvaluationSession } = require('../scripts/lib/meetingMinutesEvaluationSession');
const { semanticPolicyForRun } = require('../utils/meetingMinutesSemanticPolicy');

test('private stages match new job policy even when virtual saves omit generation state', async () => {
  const env = { MEETING_MINUTES_AGENT_CONTACT_ENQUIRY_DEDUPE_V1: '1' };
  const session = createEvaluationSession({ env });
  const legacy = { generation: null, actions: [] };
  assert.equal(semanticPolicyForRun(legacy).mode, 'off');
  env.MEETING_MINUTES_AGENT_CONTACT_ENQUIRY_DEDUPE_V1 = '0';
  let checkpoint = 0;
  for (const stage of ['discussion', 'actions', 'summary']) {
    await session.generateStage(async (draft, receivedStage, options) => {
      assert.equal(receivedStage, stage);
      const effective = semanticPolicyForRun(draft, options.semanticPolicy);
      assert.equal(effective.mode, 'on'); assert.equal(effective.scope, 'contact_enquiries');
      assert.equal(effective.maxCandidates, 2);
      options.onCheckpoint();
    }, JSON.parse(JSON.stringify(legacy)), stage, { onCheckpoint: () => checkpoint++ });
  }
  assert.equal(checkpoint, 3);assert.equal(legacy._semanticPolicy, undefined);
  assert.equal(semanticPolicyForRun(legacy).mode, 'off');
});

test('paired evaluations reuse the reference policy rather than new runtime flags', async () => {
  const reference = createEvaluationSession({ env: { MEETING_MINUTES_AGENT_CONTACT_ENQUIRY_DEDUPE_V1: '1' } });
  const paired = createEvaluationSession({ env: {}, referencePolicy: JSON.parse(JSON.stringify(reference.semanticPolicy)) });
  assert.deepEqual(paired.semanticPolicy, reference.semanticPolicy);
  assert.ok(Object.isFrozen(paired.semanticPolicy));
  assert.throws(() => paired.generateStage(() => assert.fail('must reject conflicting override'), {}, 'actions',
    { semanticPolicy: { mode: 'off' } }), /session policy/);
  const legacyPair = createEvaluationSession({ referencePolicy: null,
    env: { MEETING_MINUTES_AGENT_CONTACT_ENQUIRY_DEDUPE_V1: '1' } });
  assert.equal(legacyPair.semanticPolicy.mode, 'off');
});

test('the captured policy reaches the real finish pass instead of silently bypassing contact cleanup', async () => {
  const api = require('../routes/api').stagedEvaluation;
  const row = id => ({ id, action: 'Check with Sam regarding the inspection report.', owners: ['Maya'],
    timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds: ['T0001'], reviewFlagIds: [] });
  const draft = { details: {}, sourceUnits: [{ id: 'T0001', speaker: 'Maya',
    text: 'I will check with Sam regarding the inspection report.' }], generation: null };
  const finish = (d, stage, options) => api.finishMeetingAgentGeneratedStage(
    { changes: { actions: [row('one'), row('two')] }, reviewFlags: [] }, d, stage, options);
  const legacy = await finish(draft, 'actions', { semanticAsk: () => assert.fail('legacy must not call the provider') });
  assert.equal(legacy.changes.actions.length, 2);
  const session = createEvaluationSession({ env: { MEETING_MINUTES_AGENT_CONTACT_ENQUIRY_DEDUPE_V1: '1' } });
  const checked = await session.generateStage(finish, draft, 'actions', {
    semanticAsk: () => assert.fail('this exact instruction has a deterministic coverage proof') });
  const audit = checked.changes.qualityState.actions.semanticReconciliation;
  assert.equal(audit.policy.scope, 'contact_enquiries');
  assert.equal(checked.changes.actions.length, 1);
  assert.equal(audit.receipts.length, 1);
});
