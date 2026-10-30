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
