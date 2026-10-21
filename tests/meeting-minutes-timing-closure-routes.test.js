'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../routes/api').stagedEvaluation;
const crypto = require('node:crypto');

test('the presentation gate retains ordinary acquisition and installation imperatives', () => {
  for (const action of ['Take an inspection photograph for the supplier report.',
    'Fit the replacement actuator to the ventilation unit.',
    'Install the replacement actuator to the ventilation unit.']) {
    assert.equal(api.isClientReadyActionWording(action), true, action);
  }
  for (const action of ["I'll take an inspection photograph tomorrow.",
    "We will fit the replacement actuator on Friday.",
    'And take the inspection photograph.', 'The replacement actuator.', '']) {
    assert.equal(api.isClientReadyActionWording(action), false, action);
  }
});

test('warm result caches cannot reuse a pre-policy Microsoft response', () => {
  const prompt = 'ACTION_DISCOVERY\nA source-bound timing example';
  const oldKey = crypto.createHash('sha256').update(prompt).digest('hex');
  const key = api.meetingAgentPassCacheKey(prompt);
  assert.notEqual(key, oldKey);
  assert.equal(key, api.meetingAgentPassCacheKey(prompt));
  assert.notEqual(key, api.meetingAgentPassCacheKey(prompt + ' changed'));
});

test('review packet validation retries missing, duplicate, unknown and malformed verdicts', () => {
  const items = [{ id: 'a1' }, { id: 'a2' }];
  const good = [{ id: 'a1', verdict: 'supported' }, { id: 'a2', verdict: 'uncertain' }];
  assert.equal(api.meetingAgentReviewPacketError(items, { results: good }, ['supported', 'uncertain']), null);
  for (const results of [undefined, good.slice(0, 1), [...good, good[0]], [...good, { id: 'outside', verdict: 'supported' }],
    [good[0], { id: 'a2', verdict: 'unexpected' }]]) {
    const error = api.meetingAgentReviewPacketError(items, { results }, ['supported', 'uncertain']);
    assert.equal(error.code, 'invalid_meeting_timing_review_accounting');
    assert.equal(error.retryable, true);
  }
});

test('summary timing uses approved publication authority and records an unavailable checker', async () => {
  const draft = { details: { meetingDate: '2026-06-17' }, sourceUnits: [{ id: 'T0001', text: 'The report is due Friday.' }],
    discussion: [{ points: [{ id: 'd1', text: 'The report is due Friday.', evidenceIds: ['T0001'] }] }], actions: [] };
  const values = { executiveSummary: 'The report is due Friday.', meetingObjectives: [] };
  const calls = [];
  const result = await api.verifyMeetingAgentSummaryTiming(draft, values, async (pass, prompt, options) => {
    calls.push({ pass, prompt, options }); return null;
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].prompt, /^DISCUSSION_CRITIC_EVIDENCE_FIDELITY/);
  assert.equal(calls[0].options.responseKind, 'correction_check');
  assert.equal(result.accounting.complete, false);
  assert.equal(result.accounting.counts.missing, 1);
  assert.equal(result.values.executiveSummary, values.executiveSummary);
  assert.ok(result.flags.length);
});

test('non-temporal summary content does not cause another provider call', async () => {
  const values = { executiveSummary: 'The team discussed supplier quality.', meetingObjectives: [] };
  const result = await api.verifyMeetingAgentSummaryTiming({ discussion: [], actions: [], sourceUnits: [] }, values,
    async () => { throw Error('Unexpected provider call'); });
  assert.deepEqual(result.values, values);
  assert.equal(result.accounting.expected, 0);
});

test('a complete applied temporal recheck retires stale generated warnings while preserving reviewer decisions', () => {
  const open = { id: 'old', kind: 'timing', temporalField: 'executiveSummary', status: 'open', message: 'Old summary timing.' };
  const reviewed = { ...open, id: 'reviewed', status: 'confirmed' };
  const noted = { ...open, id: 'noted', correctionNote: 'Check with Morgan.' };
  const fresh = { reviewFlags: [open, reviewed, noted], actions: [], discussion: [] };
  const complete = { executiveSummary: 'The review has concluded.', meetingObjectives: [],
    qualityState: { summary: { temporalReview: { complete: true, expected: 0 } } } };
  const applied = api.meetingAgentRegenerationChanges(fresh, 'summary', complete, { reviewFlags: [] });
  assert.deepEqual(applied.reviewFlags.map(flag => flag.id), ['reviewed', 'noted']);
  const partial = api.meetingAgentRegenerationChanges(fresh, 'summary', { ...complete,
    qualityState: { summary: { temporalReview: { complete: false } } } }, { reviewFlags: [] });
  assert.ok(partial.reviewFlags.some(flag => flag.id === 'old' && flag.status === 'open'));
});

test('covered timed-step warnings retire only when the checked register is actually applied', () => {
  const flag = { id: 'step', kind: 'timing', temporalField: 'timedStepCoverage', status: 'open', message: 'A source timed step was missing.' };
  const changes = { actions: [], qualityState: { actions: { timedStepCoverage: { final: { complete: true } } } } };
  const fresh = { actions: [], discussion: [], reviewFlags: [flag], sourceUnits: [] };
  const applied = api.meetingAgentRegenerationChanges(fresh, 'actions', changes, { reviewFlags: [] });
  assert.equal(applied.reviewFlags.length, 0);
  const manual = { ...fresh, actions: [{ id: 'manual', action: 'Retain the reviewer instruction.', owners: [],
    timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds: [], reviewerAuthored: true }] };
  const protectedResult = api.meetingAgentRegenerationChanges(manual, 'actions', changes, { reviewFlags: [] });
  assert.equal(protectedResult.keptReviewerActions, true);
  assert.ok(protectedResult.reviewFlags.some(flag => flag.id === 'step'));
});
