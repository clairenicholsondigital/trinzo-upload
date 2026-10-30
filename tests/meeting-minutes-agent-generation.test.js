'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  meetingAgentGenerationState,
  meetingAgentPassTimingPolicy,
  normaliseMeetingAgentGeneration,
  normaliseMeetingAgentExecutionTelemetry,
  meetingAgentFailureClass,
  meetingAgentResultCounts,
  meetingAgentMaterialPassImpact,
  annotateMeetingAgentPassImpact,
  meetingAgentCallPerformance,
  meetingAgentExecutionTelemetry
} = require('../utils/meetingMinutesAgentGeneration');
const { meetingMinutesAgentText, firstString } = require('../utils/meetingMinutesPlainText');
const { normaliseSemanticPolicy } = require('../utils/meetingMinutesSemanticPolicy');
const { normaliseDiscussionCoveragePolicy } = require('../utils/meetingMinutesDiscussionCoveragePolicy');

function setEnvironment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('generation state keeps active work and fails interrupted work without changing stored records', (t) => {
  const now = Date.UTC(2026, 9, 30, 12);
  t.mock.method(Date, 'now', () => now);
  setEnvironment(t, { POWER_AUTOMATE_AGENT_TIMEOUT_MS: '120000' });
  const context = { bootId: 'current-boot', hybridEnabled: false };
  const generation = {
    status: 'running', bootId: 'current-boot',
    startedAt: new Date(now - 180000).toISOString(), pass: 'primary'
  };
  assert.equal(meetingAgentGenerationState(generation, context), generation);
  const interrupted = meetingAgentGenerationState({ ...generation, bootId: 'previous-boot' }, context);
  assert.equal(interrupted.status, 'failed');
  assert.equal(interrupted.error, 'Generation was interrupted. Generate it again.');
  assert.equal(interrupted.pass, 'primary');
  t.mock.method(Date, 'now', () => now + 1);
  assert.equal(meetingAgentGenerationState(generation, context).status, 'failed');
  assert.equal(generation.status, 'running');
  const failed = { ...generation, status: 'failed' };
  assert.equal(meetingAgentGenerationState(failed, context), failed);
  assert.equal(meetingAgentGenerationState(undefined, context), null);
});

test('hybrid generation reads the current workflow allowance and retains the arranger minimum', (t) => {
  const now = Date.UTC(2026, 9, 30, 12);
  t.mock.method(Date, 'now', () => now);
  setEnvironment(t, { MEETING_MINUTES_AGENT_WORKFLOW_TIMEOUT_MS: '720000' });
  const context = { bootId: 'boot', hybridEnabled: true };
  const generation = { status: 'running', bootId: 'boot', startedAt: new Date(now - 600000).toISOString() };
  assert.equal(meetingAgentGenerationState(generation, context), generation);
  process.env.MEETING_MINUTES_AGENT_WORKFLOW_TIMEOUT_MS = '1000';
  assert.equal(meetingAgentGenerationState(generation, context).status, 'failed');
  const arranger = { ...generation, startedAt: new Date(now - 300000).toISOString() };
  assert.equal(meetingAgentGenerationState(arranger, context), arranger);
});

test('generation normalization retains bounded previews, policy snapshots and execution history', () => {
  const stageSteps = Object.assign(Object.create({ inherited: 1 }), { discussion: 2, actions: 3, summary: 4 });
  const preview = {
    action: '  Send\n the report. ', owners: [' Alex\n Reed '],
    evidenceIds: [' T0001 '], reviewFlagIds: ['private-flag'],
    timing: { kind: 'unsupported', wording: ' next\n week ', exactDate: '' }
  };
  const source = {
    stage: 'actions', status: 'running', bootId: ' boot\n id ',
    completedPasses: Array.from({ length: 15 }, (_, index) => `pass-${index}`),
    callTimings: Array.from({ length: 65 }, (_, index) => ({ attempt: index })),
    previewActions: Array.from({ length: 65 }, () => preview),
    previewSavedActions: [{ ...preview, action: 'Existing saved action.' }],
    telemetry: { externalCallCount: 2, retryCount: -1 },
    discussionCoveragePolicy: { version: 1, mainPoint: true },
    previewUpdatedAt: ' 2026-10-30T12:00:00.000Z '
  };
  const before = structuredClone(source);
  const generation = normaliseMeetingAgentGeneration(source, stageSteps);
  assert.equal(generation.stage, 'actions');
  assert.equal(generation.bootId, 'boot id');
  assert.equal(generation.completedPasses[0], 'pass-3');
  assert.equal(generation.callTimings[0], source.callTimings[5]);
  assert.equal(generation.callTimings.length, 60);
  assert.equal(generation.previewActions.length, 60);
  assert.deepEqual(generation.previewActions[0], {
    id: 'preview-action-1', action: 'Send the report.', owners: ['Alex Reed'],
    timing: { kind: 'not_stated', wording: 'next week', exactDate: '' },
    evidenceIds: ['T0001'], reviewFlagIds: []
  });
  assert.equal(generation.previewSavedActions[0].id, 'saved-action-1');
  assert.equal(generation.previewUpdatedAt, '2026-10-30T12:00:00.000Z');
  assert.deepEqual(generation.semanticPolicy, normaliseSemanticPolicy(undefined));
  assert.deepEqual(generation.discussionCoveragePolicy, normaliseDiscussionCoveragePolicy(source.discussionCoveragePolicy));
  assert.deepEqual(generation.telemetry, normaliseMeetingAgentExecutionTelemetry(source.telemetry));
  assert.equal(generation.telemetry.retryCount, 0);
  assert.deepEqual(source, before);
  assert.equal(normaliseMeetingAgentGeneration({ ...source, stage: 'inherited' }, stageSteps).stage, 'discussion');
  assert.equal(normaliseMeetingAgentGeneration({ status: 'complete' }, stageSteps), null);
  assert.equal(normaliseMeetingAgentGeneration(null, stageSteps), null);
});

test('call performance exposes existing contribution and bounded numeric totals', () => {
  const source = [{
    stage: 'discussion', pass: 'referee', requestId: ' request\n id ', cached: true,
    candidateCount: 3, outputRecordCount: 2, outputChars: 120, timings: [{}, {}],
    elapsedMs: -10, materialContributionCount: 1, materiallyChangedFinalMinutes: true
  }];
  assert.deepEqual(meetingAgentCallPerformance(source), [{
    stage: 'discussion', pass: 'referee', requestId: 'request id', cached: true, failed: false,
    candidateCount: 3, outputRecordCount: 2, outputChars: 120, attemptCount: 2,
    elapsedMs: 0, materialContributionCount: 1, materiallyChangedFinalMinutes: true
  }]);
});

test('plain text helpers preserve source terminology and select only nonempty strings', () => {
  assert.equal(meetingMinutesAgentText('  meds app\n half past two  '), 'meds app half past two');
  assert.equal(meetingMinutesAgentText(' abc def ', 3), 'abc');
  assert.equal(meetingMinutesAgentText(null), '');
  assert.equal(firstString(null, 12, '  ', ' first\nvalue ', 'second'), 'first\nvalue');
  assert.equal(firstString(null, undefined, '  '), '');
});

test('execution telemetry distinguishes quality calls, retries, repairs and failures', () => {
  const telemetry = meetingAgentExecutionTelemetry([
    { stage: 'discussion', pass: 'primary', candidateCount: 12, outputRecordCount: 3,
      materialContributionCount: 2, timings: [
      { pass: 'discussion:primary', attempt: 1, ok: false, promptChars: 1000,
        elapsedMs: 500, errorCode: 'invalid_response_structure' },
      { pass: 'discussion:primary', attempt: 2, ok: true, promptChars: 200,
        elapsedMs: 250, repair: true }
    ] },
    { stage: 'discussion', pass: 'referee-repair-1', timings: [
      { pass: 'discussion:referee-repair-1', attempt: 1, ok: true,
        promptChars: 300, elapsedMs: 100 }
    ] }
  ]);
  assert.deepEqual(telemetry, {
    qualityPassCount: 2,
    externalCallCount: 3,
    firstAttemptSuccessCount: 1,
    retryCount: 1,
    repairCallCount: 2,
    failedCallCount: 1,
    validationFailureCount: 1,
    transportFailureCount: 0,
    totalPromptChars: 1500,
    retryPromptChars: 200,
    externalCallElapsedMs: 850,
    candidateCount: 12,
    outputRecordCount: 3,
    outputChars: 0,
    materialContributionCount: 2
  });
});

test('performance telemetry classifies failures and counts model records without inventing content', () => {
  assert.equal(meetingAgentFailureClass({ code: 'incomplete_candidate_dispositions' }), 'response_contract');
  assert.equal(meetingAgentFailureClass({ statusCode: 429 }), 'rate_limit');
  assert.equal(meetingAgentFailureClass({ upstreamStatus: 502 }), 'transport');
  const result = {
    discussion: [{ points: [{}], decisions: [{}, {}], openQuestions: [] }],
    actions: [{}, {}], actionProposals: [{}], candidateDispositions: [{}, {}, {}], reviewFlags: [{}]
  };
  assert.deepEqual(meetingAgentResultCounts(result), {
    discussionRecordCount: 3, actionCount: 2, proposalCount: 1,
    dispositionCount: 3, reviewFlagCount: 1, outputRecordCount: 6,
    outputChars: JSON.stringify(result).length
  });
});

test('material pass impact attributes final contribution to the exact referee call', () => {
  const impact = meetingAgentMaterialPassImpact([
    { candidateId: 'p1', sourcePass: 'primary', disposition: 'publish' },
    { candidateId: 'p2', sourcePass: 'primary', disposition: 'reject' },
    { candidateId: 'r1', sourcePass: 'recovery', disposition: 'proposal' }
  ], { referee: { materialContributionCount: 2, materialCandidateIds: ['p1', 'r1'] } });
  const provenance = annotateMeetingAgentPassImpact([
    { pass: 'primary' }, { pass: 'recovery' },
    { pass: 'referee-batch-1', candidateIds: ['p1', 'p2'] },
    { pass: 'referee-batch-2', candidateIds: ['r1'] },
    { pass: 'referee-repair-2', candidateIds: ['r1'], failed: true }
  ], impact);
  assert.deepEqual(provenance.map((item) => item.materialContributionCount), [1, 1, 1, 1, 0]);
  assert.equal(provenance[2].materiallyChangedFinalMinutes, true);
  assert.equal(provenance[3].materiallyChangedFinalMinutes, true);
  assert.equal(provenance[4].materiallyChangedFinalMinutes, false);
});

test('topic arranger can receive fresh bounded time after the shared stage budget is exhausted', () => {
  const stageDeadlineAt = 1_000_000;
  const now = 1_100_000;
  const policy = meetingAgentPassTimingPolicy({
    independentBudgetMs: 300_000,
    attemptTimeoutMs: 180_000
  }, false, stageDeadlineAt, now);

  assert.deepEqual(policy, {
    deadlineAt: 1_400_000,
    attemptTimeoutMs: 180_000
  });
});

test('ordinary passes continue to use the shared stage deadline', () => {
  const policy = meetingAgentPassTimingPolicy({}, false, 1_000_000, 1_100_000);
  assert.deepEqual(policy, {
    deadlineAt: 1_000_000,
    attemptTimeoutMs: undefined
  });
});
