'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const benchmark = require('../scripts/staged-workflow-confidence/benchmark');

test('the benchmark can select one case without changing the three-run default', () => {
  const options = benchmark.parseArgs(['run', '--case', '01_abbott_audit_kickoff']);
  assert.equal(options.caseId, '01_abbott_audit_kickoff');
  assert.equal(options.runs, 3);
});

test('the confidence corpus contains 13 evidence-resolving v2 cases', () => {
  const corpus = benchmark.loadCorpus();
  const result = benchmark.validateCorpus(corpus, { verifyCloud: true });
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.caseCount, 13);
  assert.ok(corpus.cases.every((item) => item.expected.curation.productionOutputSeen === false));
});

test('one-to-one assignment cannot use one generated row twice', () => {
  const expected = [{ text: 'A' }, { text: 'B' }];
  const generated = [{ text: 'one' }];
  const result = benchmark.matchCollection(expected, generated, [[0.9], [0.85]], 0.6);
  assert.equal(result.matched, 1);
  assert.equal(result.missing.length, 1);
  assert.equal(result.precision, 1);
});

test('Hungarian assignment chooses the best global pairing instead of a greedy reuse', () => {
  const pairs = benchmark.oneToOneAssignment([[0.9, 0.8], [0.85, 0.1]]);
  const total = pairs.reduce((sum, pair) => sum + pair.similarity, 0);
  assert.equal(total, 1.65);
  assert.deepEqual(new Set(pairs.map((pair) => pair.right)).size, 2);
});

test('threshold calibration limits cross-meeting false matches to one percent', () => {
  const rows = [{ caseId: 'a' }, { caseId: 'b' }, { caseId: 'c' }];
  const result = benchmark.calibrateThreshold([
    [1, 0.22, 0.61],
    [0.30, 1, 0.25],
    [0.20, 0.28, 1]
  ], rows);
  assert.ok(result.threshold >= 0.6);
  assert.ok(result.observedCrossMeetingFalsePositiveRate <= 0.01);
});

test('action calibration can use its independent 0.50 floor without changing discussion calibration', () => {
  const rows = [{ caseId: 'a' }, { caseId: 'b' }, { caseId: 'c' }];
  const result = benchmark.calibrateThreshold([
    [1, 0.48, 0.21],
    [0.22, 1, 0.31],
    [0.20, 0.29, 1]
  ], rows, { minimum: 0.50 });
  assert.equal(result.threshold, 0.5);
  assert.equal(result.observedCrossMeetingFalsePositiveRate, 0);
});

test('deployed mirror validation rejects malformed payloads and revision drift', () => {
  assert.throws(() => benchmark.validateMirrorPayload({}, 200), /Malformed UI-mirror/);
  assert.throws(() => benchmark.validateMirrorPayload({ ok: true, contractVersion: 'staged-meeting-minutes-ui-mirror-v2', diagnostics: {} }, 200), /serving revision/);
  assert.throws(() => benchmark.validateMirrorPayload({
    ok: true,
    contractVersion: 'staged-meeting-minutes-ui-mirror-v2',
    diagnostics: { servingRevision: 'new' }
  }, 200, 'old'), /changed during benchmark/);
  assert.equal(benchmark.validateMirrorPayload({
    ok: true,
    contractVersion: 'staged-meeting-minutes-ui-mirror-v2',
    diagnostics: { trace: [{ pipelineHealth: { revision: '0af9f95f95c0' } }] }
  }, 200), '0af9f95f95c0');
});

test('benchmark identifies simplified fallback output as a reliability attempt', () => {
  const reasons = benchmark.simplifiedFallbackReasons({ diagnostics: { trace: [
    { stage: 'summary', telemetry: { simplifiedPipeline: { fallback: true, reason: 'ignored' } } },
    { stage: 'discussion', telemetry: { simplifiedPipeline: { fallback: true, reason: 'status 429' } } },
    { stage: 'actions', telemetry: { simplifiedPipeline: { fallback: false } } }
  ] } });
  assert.deepEqual(reasons, ['status 429']);
});

test('verdict bands keep critical false actions and low recall in major edit', () => {
  const base = {
    criticalFalseClaims: 0,
    negativeControlActions: 0,
    discussion: { criticalRecall: 1 },
    actions: { recall: 0.9, precision: 0.95 },
    reviewerEffort: { substantiveCorrections: 2 }
  };
  assert.equal(benchmark.classifyVerdict(base), 'Light review');
  assert.equal(benchmark.classifyVerdict({ ...base, actions: { recall: 0.7, precision: 0.95 } }), 'Guided review');
  assert.equal(benchmark.classifyVerdict({ ...base, negativeControlActions: 1 }), 'Major edit');
});

test('dashboard is standalone and tolerates an older report without comparable summary metrics', () => {
  const html = benchmark.renderDashboard({
    corpusVersion: 'v2', servingRevision: 'abc', runCount: 39,
    calibration: { threshold: 0.62 },
    summary: { discussionRecallMean: 0.9, actionRecallMean: 0.8, actionPrecisionMean: 0.9, totalFallbacks: 0, totalNegativeControlActions: 0, verdicts: {} },
    cases: []
  }, { schemaVersion: 1, servingRevision: 'older' });
  assert.match(html, /Thirteen-transcript workflow confidence/);
  assert.match(html, /No earlier compatible report/);
  assert.doesNotMatch(html, /\/staged-meeting-minutes/);
});
