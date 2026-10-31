'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RefereeBatches = require('../utils/meetingMinutesRefereeBatches'),
  ResultAggregation = require('../utils/meetingMinutesResultAggregation');
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function contract(stage, ids) {
  return { requestId: `${stage}-parallel-test`, stage, expectedCandidateIds: ids };
}

function disposition(candidateId, dispositionValue) {
  return {
    candidateId,
    disposition: dispositionValue,
    reason: `${candidateId} was independently assessed.`,
    evidenceIds: [`T${candidateId.replace(/\D/g, '').padStart(3, '0')}`]
  };
}

function result(stage, rows, extras = {}) {
  return {
    schemaVersion: 'meeting_minutes_agent_v2', requestId: extras.requestId || 'batch', stage,
    expectedCandidateCount: rows.length, returnedDispositionCount: rows.length,
    repairAttempted: Boolean(extras.repairAttempted), candidateDispositions: rows,
    discussion: extras.discussion || [], actions: extras.actions || [],
    actionProposals: extras.actionProposals || [], reviewFlags: extras.reviewFlags || []
  };
}

async function schedule(values, delays, limit) {
  return RefereeBatches.meetingAgentRunOrderedConcurrent(values, async (value, index) => {
    await wait(delays[index]);
    return value;
  }, limit);
}

for (const scenario of [
  { label: 'Action', stage: 'ACTION_REFEREE', concurrency: 3, dispositions: ['publish', 'reject', 'proposal'] },
  { label: 'Discussion', stage: 'DISCUSSION_REFEREE', concurrency: 4, dispositions: ['core', 'supporting', 'reject', 'core'] }
]) {
  test(`${scenario.label} Referee reverse completion is byte-identical to sequential merge`, async () => {
    const ids = scenario.dispositions.map((_, index) => `${scenario.label.toLowerCase()}-${index + 1}`);
    const batches = ids.map((id, index) => result(
      scenario.stage, [disposition(id, scenario.dispositions[index])]
    ));
    const sequential = ResultAggregation.mergeBatchedMeetingAgentRefereeResults(
      batches, contract(scenario.stage, ids)
    );
    const concurrent = await schedule(
      batches,
      batches.map((_, index) => (batches.length - index) * 5),
      scenario.concurrency
    );
    const parallel = ResultAggregation.mergeBatchedMeetingAgentRefereeResults(
      concurrent.values, contract(scenario.stage, ids)
    );

    assert.equal(JSON.stringify(parallel), JSON.stringify(sequential));
    assert.deepEqual(parallel.candidateDispositions.map((row) => row.candidateId), ids);
    assert.equal(concurrent.maximumConcurrent, scenario.concurrency);
  });
}



test('one repaired batch does not rerun or discard successful siblings', async () => {
  const ids = ['candidate-1', 'candidate-2', 'candidate-3'];
  const calls = [0, 0, 0];
  const concurrent = await RefereeBatches.meetingAgentRunOrderedConcurrent(ids, async (id, index) => {
    calls[index] += 1;
    await wait(index === 1 ? 10 : 2);
    return result('ACTION_REFEREE', [disposition(id, index === 2 ? 'reject' : 'publish')], {
      repairAttempted: index === 1
    });
  }, 3);
  const merged = ResultAggregation.mergeBatchedMeetingAgentRefereeResults(
    concurrent.values, contract('ACTION_REFEREE', ids)
  );
  assert.deepEqual(calls, [1, 1, 1]);
  assert.equal(merged.repairAttempted, true);
  assert.deepEqual(merged.candidateDispositions.map((row) => row.candidateId), ids);
});



for (const capture of [
  {
    label: 'T788 Action', stage: 'ACTION_REFEREE',
    relative: ['benchmark-results', 't788-clause-state-live-validation-20260915',
      'raw-model-passes', 'new_07_T788-sw', 'actions'], prefix: 'referee-batch-', count: 3
  },
  {
    label: 'M204 Discussion', stage: 'DISCUSSION_REFEREE',
    relative: ['benchmark-results', 'raw-ingestion-capture-m204-20260914',
      'raw-model-passes', '05_m204_webinar_rehearsal', 'discussion'],
    prefix: 'discussion-referee-batch-', count: 4
  }
]) {
  test(`${capture.label} captured responses remain byte-identical out of order`, async (t) => {
    const artifactRoot = process.env.MEETING_MINUTES_AGENT_CAPTURE_ROOT || path.join(__dirname, '..');
    const captureRoot = path.join(artifactRoot, ...capture.relative);
    const firstPath = path.join(captureRoot, `${capture.prefix}1`, 'attempt-01.json');
    if (!fs.existsSync(firstPath)) return t.skip('captured fixed responses are not available');
    const batches = Array.from({ length: capture.count }, (_, index) => JSON.parse(fs.readFileSync(
      path.join(captureRoot, `${capture.prefix}${index + 1}`, 'attempt-01.json'), 'utf8'
    )).preIngestionResponse);
    const ids = batches.flatMap((batch) => batch.candidateDispositions.map((row) => row.candidateId));
    const refereeContract = contract(capture.stage, ids);
    const sequential = ResultAggregation.mergeBatchedMeetingAgentRefereeResults(batches, refereeContract);
    const concurrent = await schedule(
      batches, batches.map((_, index) => (batches.length - index) * 5), capture.count
    );
    const parallel = ResultAggregation.mergeBatchedMeetingAgentRefereeResults(concurrent.values, refereeContract);
    assert.equal(JSON.stringify(parallel), JSON.stringify(sequential));
  });
}
