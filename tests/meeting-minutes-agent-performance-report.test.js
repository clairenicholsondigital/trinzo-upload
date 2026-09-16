'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseEvents,
  summariseEvents,
  evaluateReleaseGates
} = require('../scripts/meeting_minutes_agent_performance_report');

test('performance report summarises preparation, passes, persistence and polling', () => {
  const events = parseEvents([
    '18|trinzo | {"event":"meeting_agent_preparation","journeyId":"one","ok":true,"preparationMs":7000,"persistenceMs":100,"totalElapsedMs":7500}',
    '{"event":"meeting_agent_pass","journeyId":"one","stage":"actions","pass":"primary","ok":true,"elapsedMs":20000,"promptChars":10000,"candidateCount":12,"attempts":1}',
    '{"event":"meeting_agent_pass","journeyId":"one","stage":"actions","pass":"referee-batch-1","ok":false,"elapsedMs":5000,"promptChars":4000,"candidateCount":8,"attempts":2,"failureClass":"response_contract"}',
    '{"event":"meeting_agent_stage_performance","journeyId":"one","stage":"actions","ok":true,"processingElapsedMs":80000,"persistenceElapsedMs":120,"totalElapsedMs":80120,"persistenceAttemptCount":1,"conflictFieldCount":0,"calls":[{"pass":"primary","materiallyChangedFinalMinutes":true,"materialContributionCount":3},{"pass":"referee-batch-1","materiallyChangedFinalMinutes":false,"materialContributionCount":0}]}',
    '{"event":"meeting_agent_poll_observed","journeyId":"one","stage":"actions","pollingOverheadMs":900}'
  ].join('\n'));
  const report = summariseEvents(events);
  assert.equal(report.journeyCount, 1);
  assert.equal(report.preparation.totalElapsedMs.p50, 7500);
  assert.equal(report.stages.actions.totalElapsedMs.p50, 80120);
  assert.equal(report.stages.actions.modelCallCount, 2);
  assert.equal(report.stages.actions.materialModelCallCount, 1);
  assert.equal(report.stages.actions.materialContributionCount, 3);
  assert.equal(report.passes['actions:primary'].promptChars.p50, 10000);
  assert.equal(report.passes['actions:referee-batch-1'].failureClasses.response_contract, 1);
  assert.equal(report.pollingOverheadMs.p50, 900);
});

test('release gates require latency improvement and non-regressing quality', () => {
  const quality = {
    actionRecall: 0.9, actionPrecision: 0.9, evidenceReferenceCoverage: 1,
    supportedActionRate: 1, reviewerAcceptanceRate: 0.85
  };
  const baseline = {
    stages: { actions: { totalElapsedMs: { p50: 180000 } } }, quality
  };
  const candidate = {
    preparation: { totalElapsedMs: { p50: 8000 } },
    stages: {
      actions: { totalElapsedMs: { p50: 110000 } },
      summary: { totalElapsedMs: { p50: 4000 } }
    },
    quality
  };
  const result = evaluateReleaseGates(baseline, candidate, {
    minimumActionP50ImprovementRatio: 0.3,
    absoluteP50CeilingsMs: { actions: 120000, summary: 5000, preparation: 10000 },
    qualityMetricsNoRegression: Object.keys(quality)
  });
  assert.equal(result.passed, true);
  assert.ok(result.actionP50ImprovementRatio > 0.38);

  const regression = evaluateReleaseGates(baseline, {
    ...candidate, quality: { ...quality, actionRecall: 0.8 }
  }, {
    minimumActionP50ImprovementRatio: 0.3,
    absoluteP50CeilingsMs: { actions: 120000, summary: 5000, preparation: 10000 },
    qualityMetricsNoRegression: Object.keys(quality)
  });
  assert.equal(regression.passed, false);
  assert.match(regression.failures.join(' '), /actionRecall/);
});
