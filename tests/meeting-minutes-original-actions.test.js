'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { createOriginalActionsStage } = require('../utils/meetingMinutesOriginalActions');
const V = require('../utils/meetingMinutesAgentV2');

Object.assign(process.env, {
  MEETING_MINUTES_AGENT_CORRECTNESS_V1: '0',
  MEETING_MINUTES_AGENT_COMMITMENT_DEDUPE_V1: '0',
  MEETING_MINUTES_AGENT_TIMING_CHECK_V1: '0',
  MEETING_MINUTES_AGENT_TIMING_CLAUSE_CHECKS_V1: '0',
  MEETING_MINUTES_AGENT_COMMITMENT_CHECK_V1: '0',
  MEETING_MINUTES_AGENT_ANSWERED_CHECK_V1: '0',
  MEETING_MINUTES_AGENT_PROPOSAL_RECHECK_V1: '0',
  MEETING_MINUTES_AGENT_DISCUSSION_BOUNDED_REWRITE_V1: '0',
  MEETING_MINUTES_AGENT_SPECULATIVE_PIPELINE_V1: '0',
  MEETING_MINUTES_AGENT_SEMANTIC_RECONCILIATION_V1: 'off'
});
const forbidden = [];
const deny = label => () => {
  forbidden.push(label);
  throw new Error('Direct Original Actions fixture forbids ' + label);
};
const originalLoad = Module._load;
let services;
Module._load = function (name) {
  if (name === 'node-fetch') return deny('provider transport');
  if (name === 'pg') return { Pool: class { constructor() { deny('pg.Pool')(); } } };
  if (name === 'child_process') return new Proxy({}, { get: (_target, key) => deny('child_process.' + String(key)) });
  return originalLoad.apply(this, arguments);
};
try { services = require('../routes/api').stagedEvaluation.originalMinutesStageServices; }
finally { Module._load = originalLoad; }
const run = createOriginalActionsStage(services);

const rawAction = (id, wording, evidenceId) => ({ id, action: wording,
  owners: ['Maya Patel'], evidenceIds: [evidenceId], reviewFlagIds: [],
  timing: { kind: 'not_stated', wording: '', exactDate: '' } });

function fixture() {
  const sourceUnits = V.normaliseSourceUnits([
    { id: 'T0001', speaker: 'Maya Patel', text: 'I will send the MDSAP report.' },
    { id: 'T0002', speaker: 'Maya Patel', text: 'I will prepare the validation record.' },
    { id: 'T0003', speaker: 'Maya Patel', text: 'I will update the test protocol.' },
    { id: 'T0004', speaker: 'Maya Patel', text: 'I will archive the signed results.' },
    { id: 'T0005', speaker: 'Maya Patel', text: 'I will review the calibration record.' }
  ]);
  const primary = V.normaliseAgentResult({ actions: [
    rawAction('send', 'Send the MDSAP report.', 'T0001'),
    rawAction('prepare', 'Prepare the validation record.', 'T0002'),
    rawAction('update', 'Update the test protocol.', 'T0003'),
    rawAction('archive', 'Archive the signed results.', 'T0004')
  ] }, sourceUnits, 'actions', { meetingDate: '2026-10-30' });
  const ensemble = ['primary', 'staged'].flatMap(pass =>
    services.hybridCandidateLedgerFromResult(primary, pass));
  const draft = { draftId: 'direct-original-actions', sourceUnits,
    preparedTranscript: V.preparedTranscriptFromUnits(sourceUnits),
    details: { meetingType: 'Review', meetingDate: '2026-10-30', internalAttendees: ['Maya Patel'] },
    discussion: [], actions: [], reviewFlags: [], meetingObjectives: [], qualityState: {} };
  const calls = [];
  const execution = { passCache: [], refereeFailureAudit: null, stageDeadlineAt: Date.now() + 360000 };
  const input = {
    draft, stage: 'actions', options: {}, transcript: draft.preparedTranscript,
    details: draft.details, timingAnchor: draft.details.meetingDate,
    primary, referee: { actions: [primary.actions[0]] }, primarySecondResult: null, recovery: null,
    ensemble, candidateLedger: [...ensemble], degradedSources: [],
    actionDiscoveryInventory: V.actionCandidateInventory(sourceUnits),
    sourceActionCandidates: V.actionCandidateInventory(sourceUnits),
    actionChains: [], actionThreads: [], agentCandidateDispositions: [], agentDeclaredProposals: [],
    vetoedModelActions: [], unresolvedActionMaterializations: [], settledRefereeActionDispositions: [],
    refereeFlags: [], refereeRoute: {}, fastRefereeAuthoritative: false,
    passProvenance: [], completedPasses: ['primary', 'referee'],
    cachedStaged: [], initialTimedStepCoverage: {}, stageStartedAt: Date.now(),
    stagedCandidateElapsedMs: 0, stagedCandidateJoin: {}, stagedCandidatesFromPrewarm: false,
    execution,
    call: async (pass, prompt, options) => {
      calls.push({ pass, prompt, options });
      const response = { discussion: [], actions: [], actionProposals: [], candidateDispositions: [], reviewFlags: [], results: [] };
      // The real shared executor replaces its cache binding after a call.
      // Exercise that boundary without invoking a provider or waiting for retries.
      execution.passCache = [...execution.passCache, { stage: 'actions', pass,
        promptSha256: 'a'.repeat(64), completedAt: '2026-10-30T12:00:00.000Z', result: response }];
      return response;
    }
  };
  return { input, calls };
}

test('direct Original Actions retains the sparse-referee fallback and returns the latest shared pass cache', async () => {
  const { input, calls } = fixture();
  const beforeCache = input.execution.passCache;
  const result = await run(input);

  for (const action of input.primary.actions) {
    assert.ok(result.changes.actions.some(row => row.action === action.action), action.action);
  }
  assert.equal(input.degradedSources.length, 1);
  assert.match(input.degradedSources[0], /implausibly sparse/);
  assert.equal(result.replaceCoverageFlags, false);
  assert.ok(calls.some(call => call.pass === 'critic'));
  assert.notEqual(input.execution.passCache, beforeCache);
  assert.equal(result.changes.passCache, input.execution.passCache);
  assert.equal(result.changes.qualityState.actions.automaticCount, result.changes.actions.length);
  assert.deepEqual(forbidden, []);
});

test('direct Original Actions normalizes the independent discovery leg while preserving the shared ensemble', async () => {
  const { input } = fixture();
  input.primarySecondResult = { actions: [rawAction('independent', 'Send the medsap report.', 'T0001')] };
  const ensemble = input.ensemble;
  const originalCount = ensemble.length;
  const result = await run(input);

  assert.equal(input.ensemble, ensemble);
  const secondLeg = ensemble.slice(originalCount).filter(candidate => candidate.sourcePass === 'primary-2');
  assert.equal(secondLeg.length, 1);
  assert.equal(secondLeg[0].record.action, 'Send the MDSAP report.');
  assert.deepEqual(secondLeg[0].record.evidenceIds, ['T0001']);
  assert.deepEqual(secondLeg[0].record.owners, ['Maya Patel']);
  assert.ok(result.changes.actions.some(row => row.action === 'Send the MDSAP report.'));
  assert.deepEqual(forbidden, []);
});

test('direct Original Actions waits for the preview handler before making a critic call', async () => {
  const { input, calls } = fixture();
  let previewStarted;
  let finishPreview;
  const started = new Promise(resolve => { previewStarted = resolve; });
  const pending = new Promise(resolve => { finishPreview = resolve; });
  input.options.onPreview = preview => {
    assert.equal(preview.previewActions.length, input.primary.actions.length);
    assert.ok(Number.isFinite(Date.parse(preview.previewUpdatedAt)));
    previewStarted();
    return pending;
  };
  const running = run(input);
  await started;
  assert.equal(calls.length, 0);
  finishPreview();
  const result = await running;
  assert.ok(calls.some(call => call.pass === 'critic'));
  assert.ok(result.changes.actions.length >= input.primary.actions.length);
  assert.deepEqual(forbidden, []);
});
