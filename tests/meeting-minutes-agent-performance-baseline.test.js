'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CASES,
  parseArgs,
  reviewerOutput,
  privatePerformance
} = require('../scripts/run_meeting_minutes_agent_performance_baseline');

test('performance baseline runner accepts only the controlled corpus and bounded runs', () => {
  const options = parseArgs(['--cases', 't733,parking', '--runs', '5', '--poll-ms', '500']);
  assert.deepEqual(options.cases, ['t733', 'parking']);
  assert.equal(options.runs, 5);
  assert.equal(options.pollMs, 500);
  assert.match(CASES.t733, /t733_tech_file_weekly/);
  assert.throws(() => parseArgs(['--cases', 'unknown']), /must contain/);
  assert.throws(() => parseArgs(['--runs', '21']), /1 to 20/);
});

test('performance baseline artefacts keep reviewer output and private timing separate', () => {
  const draft = {
    details: { meetingTitle: 'Test' },
    discussion: [{ topic: 'One' }], actions: [{ action: 'Do one' }],
    pendingProposal: { changes: [{ id: 'proposal-1' }] },
    qualityState: {
      actions: {
        stageElapsedMs: 20,
        telemetry: { externalCallCount: 2 },
        callPerformance: [{ pass: 'primary' }],
        passImpact: { primary: { materialContributionCount: 1 } }
      }
    },
    rawTranscript: 'must not be copied'
  };
  const visible = reviewerOutput(draft);
  assert.equal(visible.actions.length, 1);
  assert.equal(visible.proposals.length, 1);
  assert.equal(Object.hasOwn(visible, 'rawTranscript'), false);
  const performance = privatePerformance(draft);
  assert.equal(performance.actions.stageElapsedMs, 20);
  assert.equal(performance.actions.callPerformance[0].pass, 'primary');
});
