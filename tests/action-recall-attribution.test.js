'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { presentIn, STAGES } = require('../scripts/action_recall_attribution');

// The attribution harness decides where every ground-truth action was lost, so its
// matching logic has to be pinned on its own. The first version of this harness reported
// "0 actions need synthesis" because `overlap` normalises by the shorter token set, so a
// one-word turn ("Before.") scored 1.00 against a document-sharing action and looked like
// perfect supporting evidence. A measurement bug in the tool that chooses the work is
// worse than no measurement, because it is believed.

test('requiring the harness does not start a run', () => {
  // A require-time run would spawn thirteen MiniLM profiles. Reaching this line is the proof.
  assert.equal(typeof presentIn, 'function');
});

test('the funnel stages are ordered from proposal to publication', () => {
  assert.deepEqual(STAGES.map((stage) => stage.key), ['generated', 'afterFloor', 'published']);
});

test('an action counts as present when a row in the population matches it', () => {
  assert.equal(presentIn('Stuart Share the risk analysis and audit tracker', [
    'Stuart Smith :: Share the risk analysis and the audit tracker'
  ]), true);
});

test('an unrelated population does not count as presence', () => {
  assert.equal(presentIn('Stuart Share the risk analysis and audit tracker', [
    'Deepa Sharma :: Reorder the medals for the race'
  ]), false);
});

test('a leading publishability score on a funnel row does not defeat matching', () => {
  // belowSurvivalFloor and candidateBand rows are recorded with their score prefixed so a
  // reader can see how far under the floor they sat; the matcher has to strip it.
  assert.equal(presentIn('Stuart Share the risk analysis and audit tracker', [
    '0.140 Stuart Smith :: Share the risk analysis and the audit tracker'
  ]), true);
});

test('an empty population is not a match', () => {
  assert.equal(presentIn('Anything at all here', []), false);
  assert.equal(presentIn('Anything at all here', undefined), false);
});
