'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const api = require('../routes/api').stagedEvaluation;
const { TIMING_INFERENCE_POLICY_VERSION, sanitiseDetails } = require('../utils/meetingMinutesAgentV2');
const { TIMING_POLICY_VERSION } = require('../utils/meetingMinutesTiming');

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const draft = () => ({ draftId: 'cache-binding', preparedTranscript: '[T0001] Morgan: I will prepare the report.',
  transcriptSha256: 'source-hash', details: { meetingDate: '2026-06-17' },
  actions: [], discussion: [], salientDetails: [], steer: '' });
const stagedAction = (version) => ({ candidateId: 'staged-report', sourcePass: 'staged', recordType: 'action',
  timingInferenceVersion: version, timingInferenceInputKey: api.privateStagedCandidateCacheKey(draft(), 'actions'),
  record: { action: 'Prepare the report.', owners: ['Morgan'],
    timing: { kind: 'deadline', wording: 'tomorrow', exactDate: '' } } });

test('legacy or mixed processed staged actions force full regeneration without altering saved drafts', () => {
  for (const version of [undefined, 0, TIMING_INFERENCE_POLICY_VERSION + 1, String(TIMING_INFERENCE_POLICY_VERSION)]) {
    const value = { ...draft(), candidateLedger: [stagedAction(version)] };
    const before = structuredClone(value);
    assert.deepEqual(api.cachedStagedCandidatesForStage(value, 'actions'), []);
    assert.deepEqual(value, before);
    value.candidateLedger.push({ ...stagedAction(TIMING_INFERENCE_POLICY_VERSION), candidateId: 'current-other' });
    assert.deepEqual(api.cachedStagedCandidatesForStage(value, 'actions'), [], 'never reuse a partial action stage');
  }
});

test('current staged actions remain reusable while discussion and other extraction legs stay independent', () => {
  const action = stagedAction(TIMING_INFERENCE_POLICY_VERSION);
  const discussion = { candidateId: 'discussion', sourcePass: 'staged', recordType: 'discussion_point', text: 'Report discussed.' };
  const primary = { ...stagedAction(), sourcePass: 'primary' };
  const value = { ...draft(), candidateLedger: [action, discussion, primary] };
  assert.deepEqual(api.cachedStagedCandidatesForStage(value, 'actions'), [action]);
  assert.deepEqual(api.cachedStagedCandidatesForStage(value, 'discussion'), [discussion]);
  assert.deepEqual(api.cachedStagedCandidatesForStage({ ...value, candidateLedger: [stagedAction(), discussion] }, 'discussion'), [discussion]);
  assert.deepEqual(api.cachedStagedCandidatesForStage({ ...draft(), candidateLedger: [primary] }, 'actions'), []);
});

test('newly normalised staged actions receive inference provenance without changing action content', () => {
  const result = { actions: [{ id: 'a1', action: 'Prepare the report.', owners: ['Morgan'],
    timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds: ['T0001'] }],
    discussion: [{ topic: 'Reports', points: [{ id: 'p1', text: 'The report needs updating.', evidenceIds: ['T0001'] }] }] };
  const before = structuredClone(result);
  const value = draft();
  const ledger = api.stagedCandidateLedgerFromResult(result, value);
  const action = ledger.find(row => row.recordType === 'action');
  assert.equal(action.timingInferenceVersion, TIMING_INFERENCE_POLICY_VERSION);
  assert.deepEqual(action.record, result.actions[0]);
  assert.deepEqual(ledger.filter(row => row.recordType !== 'action'),
    api.hybridCandidateLedgerFromResult(result, 'staged').filter(row => row.recordType !== 'action'));
  assert.deepEqual(api.cachedStagedCandidatesForStage({ ...value, candidateLedger: ledger }, 'actions'), [action]);
  assert.deepEqual(result, before);
});

test('processed action timing is not reused after its meeting anchor or source input changes', () => {
  const value = { ...draft(), candidateLedger: [stagedAction(TIMING_INFERENCE_POLICY_VERSION)] };
  assert.equal(api.cachedStagedCandidatesForStage(value, 'actions').length, 1);
  for (const changed of [
    { ...value, details: { ...value.details, meetingDate: '2026-06-19' } },
    { ...value, preparedTranscript: value.preparedTranscript + '\n[T0002] Morgan: Friday instead.' },
    { ...value, transcriptSha256: 'different-source-hash' }
  ]) assert.deepEqual(api.cachedStagedCandidatesForStage(changed, 'actions'), []);
  const noContext = structuredClone(value);
  delete noContext.candidateLedger[0].timingInferenceInputKey;
  assert.deepEqual(api.cachedStagedCandidatesForStage(noContext, 'actions'), []);
  assert.equal(value.candidateLedger[0].timingInferenceInputKey, api.privateStagedCandidateCacheKey(draft(), 'actions'));
});

function legacyFingerprint(value, stage) {
  const input = { timingPolicyVersion: TIMING_POLICY_VERSION,
    timingContext: api.meetingAgentPromptDetails(value).timingContext, stage,
    transcript: value.transcriptSha256 || '', prepared: hash(value.preparedTranscript || ''),
    details: sanitiseDetails(value.details), steer: value.steer || '', salientDetails: value.salientDetails || [] };
  if (stage === 'actions' || stage === 'summary') input.upstream = api.meetingAgentUpstreamFingerprint(value, stage);
  return hash(JSON.stringify(input));
}

test('pre-inference-policy speculations cannot be adopted for actions or summaries', async () => {
  const value = draft();
  for (const stage of ['actions', 'summary']) {
    const old = legacyFingerprint(value, stage);
    assert.notEqual(api.meetingAgentStageInputFingerprint(value, stage), old);
    const key = `${value.draftId}:${stage}`;
    api.privateStageSpeculations.set(key, { draftId: value.draftId, stage, fingerprint: old, status: 'ready',
      result: { changes: { actions: [stagedAction().record] } }, expiresAt: Date.now() + 60000 });
    try {
      assert.equal(await api.adoptStageSpeculation(value, stage, value.draftId, 'u1'), null);
      assert.ok(api.privateStageSpeculations.has(key));
    } finally { api.privateStageSpeculations.delete(key); }
  }
  assert.equal(api.meetingAgentStageInputFingerprint(value, 'discussion'), legacyFingerprint(value, 'discussion'));
});

test('private processed-action keys change while raw Microsoft response keys retain their policy', () => {
  const value = draft();
  const prepared = hash(value.preparedTranscript);
  const details = sanitiseDetails(value.details);
  const legacy = (stage) => `${value.transcriptSha256}:${prepared}:${details.meetingType || ''}:${details.meetingDate}:${details.meetingDate}:${TIMING_POLICY_VERSION}:${stage}`;
  assert.notEqual(api.privateStagedCandidateCacheKey(value, 'actions'), legacy('actions'));
  assert.equal(api.privateStagedCandidateCacheKey(value, 'discussion'), legacy('discussion'));
  const prompt = 'ACTION_DISCOVERY\nPrepare a source-bound report.';
  assert.equal(api.meetingAgentPassCacheKey(prompt), hash(JSON.stringify({ timingPolicyVersion: TIMING_POLICY_VERSION, prompt })));
});
