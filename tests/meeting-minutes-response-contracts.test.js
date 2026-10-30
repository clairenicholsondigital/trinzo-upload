'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { meetingAgentResultError, meetingAgentInfrastructureFailure, meetingAgentDispositionError, meetingAgentRefereeRoute, meetingAgentRefereeAccountedForAllCandidates } = require('../utils/meetingMinutesResponseContracts');
const { meetingAgentRefereeBatches, meetingAgentRefereeBatchPlan, meetingAgentRunOrderedConcurrent, shouldStopMeetingAgentRefereeBatches } = require('../utils/meetingMinutesRefereeBatches');
const { normaliseMeetingAgentPassCache, meetingAgentPassCacheKey } = require('../utils/meetingMinutesPassCache');
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test('connected-agent contract errors trigger retries instead of becoming empty drafts', () => {
  const malformedDiscussion = meetingAgentResultError({
    discussion: [], actions: [],
    error: { code: 'invalid_discussion_structure', message: 'The child returned flat records.' }
  });
  assert.equal(malformedDiscussion?.code, 'invalid_discussion_structure');
  assert.equal(malformedDiscussion?.retryable, true);

  const missingDispositions = meetingAgentResultError({
    discussion: [], actions: [],
    error: { code: 'missing_candidate_dispositions', message: 'No dispositions were returned.' }
  });
  assert.equal(missingDispositions?.retryable, true);
  assert.equal(meetingAgentResultError({ discussion: [], actions: [] }), null);
});

test('referee candidates are split into bounded batches without changing order', () => {
  const candidates = Array.from({ length: 14 }, (_, index) => ({ candidateId: `C${index + 1}` }));
  const batches = meetingAgentRefereeBatches(candidates, 5);
  assert.deepEqual(batches.map((batch) => batch.length), [5, 5, 4]);
  assert.deepEqual(batches.flat().map((candidate) => candidate.candidateId),
    candidates.map((candidate) => candidate.candidateId));
});

test('global discussion referee sees the complete ensemble while actions remain bounded', () => {
  const candidates = Array.from({ length: 24 }, (_, index) => ({ candidateId: `C${index + 1}` }));
  const globalDiscussion = meetingAgentRefereeBatchPlan('discussion', candidates, 6, true);
  assert.equal(globalDiscussion.mode, 'global');
  assert.deepEqual(globalDiscussion.batches.map((batch) => batch.length), [24]);
  assert.deepEqual(globalDiscussion.batches[0], candidates);

  const ordinaryDiscussion = meetingAgentRefereeBatchPlan('discussion', candidates, 6, false);
  assert.equal(ordinaryDiscussion.mode, 'batched');
  assert.deepEqual(ordinaryDiscussion.batches.map((batch) => batch.length), [6, 6, 6, 6]);

  const actions = meetingAgentRefereeBatchPlan('actions', candidates, 6, true);
  assert.equal(actions.mode, 'batched');
  assert.deepEqual(actions.batches.map((batch) => batch.length), [6, 6, 6, 6]);
});

test('repeated strict referee contract failures stop further batch calls', () => {
  assert.equal(shouldStopMeetingAgentRefereeBatches(
    { code: 'invalid_referee_output' }, { code: 'invalid_referee_output' }
  ), true);
  assert.equal(shouldStopMeetingAgentRefereeBatches(
    { code: 'power_automate_empty_response' }, { code: 'power_automate_empty_response' }
  ), true);
  assert.equal(shouldStopMeetingAgentRefereeBatches(
    { code: 'power_automate_empty_response' }, { code: 'power_automate_timeout' }
  ), false);
  assert.equal(shouldStopMeetingAgentRefereeBatches(
    { code: 'invalid_referee_output' }, { code: 'SystemError' }
  ), false);
});

test('strict referee errors retain invalid candidate diagnostics for targeted repair', () => {
  const error = meetingAgentResultError({
    error: {
      code: 'invalid_referee_output', message: 'Invalid candidates.',
      invalidCandidateIds: ['A2', 'A2', 'A3'],
      reasons: ['A2: missing reason', 'A3: invalid disposition'], retryable: false,
      validCandidateDispositions: [
        { candidateId: 'A1', disposition: 'publish', reason: 'Committed.', evidenceIds: ['T1'] }
      ]
    }
  });
  assert.equal(error.code, 'invalid_referee_output');
  assert.equal(error.retryable, false);
  assert.deepEqual(error.invalidCandidateIds, ['A2', 'A3']);
  assert.deepEqual(error.invalidReasons, ['A2: missing reason', 'A3: invalid disposition']);
  assert.equal(error.validCandidateDispositions[0].candidateId, 'A1');
});

test('successful pass cache is private, bounded and keyed by the exact prompt', () => {
  const key = meetingAgentPassCacheKey('ACTION_DISCOVERY\nExample');
  assert.equal(key.length, 64);
  assert.notEqual(key, meetingAgentPassCacheKey('ACTION_DISCOVERY\nDifferent'));
  const entries = Array.from({ length: 20 }, (_, index) => ({
    stage: 'actions', pass: 'primary', promptSha256: meetingAgentPassCacheKey(`prompt-${index}`),
    completedAt: `2026-09-11T00:00:${String(index).padStart(2, '0')}Z`,
    result: { discussion: [], actions: [{ action: `Action ${index}` }] }
  }));
  const normalised = normaliseMeetingAgentPassCache(entries);
  assert.equal(normalised.length, 16);
  assert.equal(normalised[0].result.actions[0].action, 'Action 4');
});

test('transport failures prevent a redundant salvage request', () => {
  assert.equal(meetingAgentInfrastructureFailure({ code: 'power_automate_empty_response' }), true);
  assert.equal(meetingAgentInfrastructureFailure({ code: 'power_automate_http_502' }), true);
  assert.equal(meetingAgentInfrastructureFailure({ upstreamStatus: 503 }), true);
  assert.equal(meetingAgentInfrastructureFailure({ code: 'invalid_agent_json', statusCode: 422 }), false);
});

test('bounded scheduling preserves input slots under uneven latency', async () => {
  const concurrent = await meetingAgentRunOrderedConcurrent(
    ['first', 'second', 'third', 'fourth'],
    async (value, index) => {
      await wait(index % 2 ? 2 : 12);
      return `${value}:${index}`;
    },
    2
  );
  assert.equal(concurrent.maximumConcurrent, 2);
  assert.deepEqual(concurrent.values, ['first:0', 'second:1', 'third:2', 'fourth:3']);
});

test('concurrent failures are reported deterministically by input order', async () => {
  await assert.rejects(
    meetingAgentRunOrderedConcurrent([0, 1, 2], async (value) => {
      await wait(value === 0 ? 12 : 1);
      if (value < 2) throw new Error(`failure-${value}`);
      return value;
    }, 3),
    (error) => error.message === 'failure-0' && error.orderedConcurrentTaskIndex === 0
  );
});

test('referee validation requires exactly one disposition per supplied candidate', () => {
  const candidates = [{ candidateId: 'D1' }, { candidateId: 'D2' }];
  const missing = meetingAgentDispositionError({ candidateDispositions: [{ candidateId: 'D1' }] }, candidates);
  assert.equal(missing?.code, 'incomplete_candidate_dispositions');
  assert.deepEqual(missing?.missingCandidateIds, ['D2']);
  const duplicate = meetingAgentDispositionError({
    candidateDispositions: [{ candidateId: 'D1' }, { candidateId: 'D1' }, { candidateId: 'D2' }]
  }, candidates);
  assert.deepEqual(duplicate?.missingCandidateIds, ['D1']);
  assert.equal(meetingAgentDispositionError({
    discussion: [], actions: [], candidateDispositions: [{ candidateId: 'D1' }, { candidateId: 'D2' }]
  }, candidates), null);
});

test('structured referee validation binds request, stage and declared accounting', () => {
  const candidates = [{ candidateId: 'D1' }, { candidateId: 'D2' }];
  const contract = { requestId: 'request-1', stage: 'DISCUSSION_REFEREE' };
  const valid = {
    schemaVersion: 4, requestId: 'request-1', stage: 'DISCUSSION_REFEREE',
    status: 'complete', expectedCandidateCount: 2, returnedDispositionCount: 2,
    candidateDispositions: [
      { candidateId: 'D1', disposition: 'core', reason: 'Material decision.', evidenceIds: ['T1'] },
      { candidateId: 'D2', disposition: 'reject', reason: 'Repeated context.', evidenceIds: ['T2'] }
    ]
  };
  assert.equal(meetingAgentDispositionError(valid, candidates, contract), null);
  assert.equal(meetingAgentRefereeRoute(valid, contract), 'structured_prompt');
  assert.equal(meetingAgentDispositionError({ ...valid, requestId: 'wrong' }, candidates, contract)?.code, 'invalid_referee_contract');
  assert.equal(meetingAgentDispositionError({ ...valid, expectedCandidateCount: 3 }, candidates, contract)?.code, 'invalid_referee_accounting');
  assert.equal(meetingAgentDispositionError({ ...valid,
    candidateDispositions: valid.candidateDispositions.map((item) => ({ ...item, reason: '' }))
  }, candidates, contract)?.code, 'invalid_referee_disposition');
  assert.equal(meetingAgentDispositionError({ ...valid,
    candidateDispositions: [...valid.candidateDispositions, { candidateId: 'D3' }], returnedDispositionCount: 3
  }, candidates, contract)?.code, 'unexpected_candidate_dispositions');
});

test('referee validation retains valid rows so repair targets only malformed candidates', () => {
  const candidates = [{ candidateId: 'A1', recordType: 'action', text: 'Send the equipment report.' },
    { candidateId: 'A2', recordType: 'action', text: 'Review the equipment report.' },
    { candidateId: 'A3', recordType: 'action', text: 'Prepare the equipment list.' }];
  const contract = { requestId: 'request-partial', stage: 'ACTION_REFEREE' };
  const result = {
    requestId: contract.requestId, stage: contract.stage,
    expectedCandidateCount: 3, returnedDispositionCount: 3,
    candidateDispositions: [
      { candidateId: 'A1', disposition: 'publish', reason: 'Supported.', evidenceIds: ['T1'] },
      { candidateId: 'A2', disposition: 'publish', reason: '', evidenceIds: ['T2'] },
      { candidateId: 'A3', disposition: 'reject', reason: 'Not future work.', evidenceIds: ['T3'] }
    ]
  };
  const error = meetingAgentDispositionError(result, candidates, contract);
  assert.equal(error.code, 'invalid_referee_disposition');
  assert.deepEqual(error.invalidCandidateIds, ['A2']);
  assert.deepEqual(error.validCandidateDispositions.map((item) => item.candidateId), ['A1', 'A3']);
});

test('referee validation retains complete rows when another candidate is missing', () => {
  const candidates = [{ candidateId: 'A1', recordType: 'action', text: 'Send the equipment report.' },
    { candidateId: 'A2', recordType: 'action', text: 'Review the equipment report.' },
    { candidateId: 'A3', recordType: 'action', text: 'Prepare the equipment list.' }];
  const contract = { requestId: 'request-missing', stage: 'ACTION_REFEREE' };
  const result = {
    requestId: contract.requestId, stage: contract.stage,
    expectedCandidateCount: 3, returnedDispositionCount: 2,
    candidateDispositions: [
      { candidateId: 'A1', disposition: 'publish', reason: 'Supported.', evidenceIds: ['T1'] },
      { candidateId: 'A3', disposition: 'reject', reason: 'Not future work.', evidenceIds: ['T3'] }
    ]
  };
  const error = meetingAgentDispositionError(result, candidates, contract);
  assert.equal(error.code, 'incomplete_candidate_dispositions');
  assert.deepEqual(error.missingCandidateIds, ['A2']);
  assert.deepEqual(error.validCandidateDispositions.map((item) => item.candidateId), ['A1', 'A3']);
});

test('the fast action path only trusts a structured referee that disposed of every candidate', () => {
  const contract = { expectedCandidateIds: ['a', 'b', 'c'] };
  const full = { candidateDispositions: [{ candidateId: 'a', disposition: 'publish' }, { candidateId: 'b', disposition: 'reject' }, { candidateId: 'c', disposition: 'completed' }] };
  assert.equal(meetingAgentRefereeAccountedForAllCandidates(full, contract, 'structured_prompt'), true);
  assert.equal(meetingAgentRefereeAccountedForAllCandidates(full, contract, 'legacy'), false, 'only the structured route counts');
  assert.equal(meetingAgentRefereeAccountedForAllCandidates({ candidateDispositions: full.candidateDispositions.slice(0, 2) }, contract, 'structured_prompt'), false, 'one missing disposition keeps the critic');
  assert.equal(meetingAgentRefereeAccountedForAllCandidates({ candidateDispositions: [...full.candidateDispositions, { candidateId: 'zzz', disposition: 'publish' }] }, contract, 'structured_prompt'), false, 'an unexpected id is not a complete accounting');
  assert.equal(meetingAgentRefereeAccountedForAllCandidates(full, { expectedCandidateIds: [] }, 'structured_prompt'), false);
});
