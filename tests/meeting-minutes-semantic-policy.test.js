'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { captureSemanticPolicy, normaliseSemanticPolicy, semanticPolicyForRun,
  semanticPolicyForFingerprint, SEMANTIC_TASK_VERSION } = require('../utils/meetingMinutesSemanticPolicy');

test('legacy queued and running work cannot opt into current semantic flags during recovery', () => {
  const before = process.env.MEETING_MINUTES_AGENT_SEMANTIC_RECONCILIATION_V1;
  process.env.MEETING_MINUTES_AGENT_SEMANTIC_RECONCILIATION_V1 = 'on';
  try {
    for (const draft of [{}, {generation:{status:'running'}}, {generation:{status:'failed'}}, {_semanticPolicy:{version:0,mode:'on'}}]) {
      assert.equal(semanticPolicyForRun(draft).mode, 'off');
    }
    assert.equal(semanticPolicyForFingerprint({generation:{status:'running'}}).mode,'off');
    assert.equal(semanticPolicyForFingerprint({}).mode,'on');
  } finally {
    if(before===undefined) delete process.env.MEETING_MINUTES_AGENT_SEMANTIC_RECONCILIATION_V1;
    else process.env.MEETING_MINUTES_AGENT_SEMANTIC_RECONCILIATION_V1=before;
  }
});

test('new jobs freeze mode and bounds through retries and changed process configuration', () => {
  const policy = captureSemanticPolicy({ MEETING_MINUTES_AGENT_SEMANTIC_RECONCILIATION_V1:'shadow',
    MEETING_MINUTES_AGENT_SEMANTIC_MAX_CANDIDATES:'32', MEETING_MINUTES_AGENT_SEMANTIC_BATCH_SIZE:'3' });
  const resumed = {generation:{status:'running',semanticPolicy:JSON.parse(JSON.stringify(policy))}};
  assert.equal(semanticPolicyForRun(resumed).mode,'shadow');
  assert.equal(semanticPolicyForRun(resumed).maxCandidates,32);
  assert.equal(semanticPolicyForRun(resumed).batchSize,3);
  assert.deepEqual(semanticPolicyForFingerprint(resumed),policy);
  assert.deepEqual(semanticPolicyForRun({_semanticPolicy:policy}),policy,'speculation uses its saved snapshot');
  assert.ok(Object.isFrozen(policy));
});

test('unknown or malformed semantic versions default off and finite resource limits are enforced', () => {
  for(const value of [null,{}, {version:99,taskVersion:'existing-survivor-v1',mode:'on'},
    {version:1,taskVersion:'unknown',mode:'on'}, {version:1,taskVersion:'existing-survivor-v1',mode:'on'}]) assert.equal(normaliseSemanticPolicy(value).mode,'off');
  const policy = normaliseSemanticPolicy({version:1,taskVersion:SEMANTIC_TASK_VERSION,mode:'unsafe',
    maxCandidates:Infinity,batchSize:999,budgetMs:-1,attemptTimeoutMs:999999});
  assert.equal(policy.mode,'off'); assert.equal(policy.maxCandidates,64);
  assert.equal(policy.batchSize,8); assert.equal(policy.budgetMs,90000); assert.equal(policy.attemptTimeoutMs,90000);
});

test('public progress hides private semantic execution policy and legacy normalisation remains off', () => {
  const api = require('../routes/api').stagedEvaluation;
  const legacy = api.normaliseMeetingAgentGeneration({stage:'actions',status:'running',startedAt:new Date().toISOString(),bootId:api.MEETING_AGENT_BOOT_ID});
  assert.equal(legacy.semanticPolicy.mode,'off');
  const policy = captureSemanticPolicy({ MEETING_MINUTES_AGENT_SEMANTIC_RECONCILIATION_V1:'on' });
  const draft = {draftId:'policy-test',details:{},actions:[],discussion:[],reviewFlags:[],
    generation:{...legacy,semanticPolicy:policy}, sourceUnits:[],qualityState:{}};
  const publicDraft = api.publicMeetingAgentDraft(draft);
  assert.ok(!Object.hasOwn(publicDraft.generation,'semanticPolicy'));
  assert.ok(!Object.hasOwn(publicDraft.generation,'bootId'));
});
