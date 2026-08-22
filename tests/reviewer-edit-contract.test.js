'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const harness = require('../scripts/reviewer_edit_baseline');

// The reviewer-correction contract, asserted rather than reported.
//
// scripts/reviewer_edit_baseline.js sweeps the corpus and is read by a person. This runs
// in the suite, so a regression fails a build instead of waiting for someone to look. It
// is split deliberately:
//
//   - the committed baseline is checked without recomputing anything, which costs
//     milliseconds and catches "landed a change, forgot to recapture";
//   - a live subset actually runs the chain, on one transcript, so the assertions cannot
//     pass by reading a stale file.
//
// The live subset is one transcript on purpose. Cost is one MiniLM profile per transcript
// and the suite already runs for about four minutes.

const FIXTURES = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'fixtures/reviewer-edits.json'), 'utf8'));
const LIVE_TRANSCRIPT = '021_real_dita_importer_obligations_transcript';

const active = FIXTURES.scenarios.filter((scenario) => !scenario.pending);
const pending = FIXTURES.scenarios.filter((scenario) => scenario.pending);

test('every scripted correction records the finding it came from', () => {
  // A scenario without a finding is a preference, and a preference does not survive
  // someone deciding it is inconvenient. Each one has to name the bug it pins.
  for (const scenario of FIXTURES.scenarios) {
    assert.ok(scenario.finding, `${scenario.id} has no finding`);
    assert.ok(scenario.appliesTo?.length, `${scenario.id} names no transcript`);
    assert.ok(scenario.edits?.length, `${scenario.id} makes no edit`);
    for (const name of scenario.appliesTo) assert.doesNotThrow(() => harness.transcriptPath(name), `${scenario.id}: ${name}`);
  }
});

test('a pending scenario says what is missing, and pending is not a resting place', () => {
  for (const scenario of pending) {
    assert.ok(scenario.pending.length > 30, `${scenario.id} must say what is outstanding, not just that something is`);
  }
  // This number goes down. If it goes up, a correction stopped being honoured and the
  // scenario was marked pending rather than fixed.
  assert.ok(pending.length <= 2, `${pending.length} scenarios are pending; that number is meant to shrink`);
});

test('the committed baseline has no contract violation outside the pending set', () => {
  const baseline = JSON.parse(fs.readFileSync(harness.BASELINE_PATH, 'utf8'));
  const pendingIds = new Set(pending.map((scenario) => scenario.id));
  const offending = (baseline.rows || [])
    .filter((row) => !pendingIds.has(row.scenario))
    .filter((row) => (row.violations || []).length)
    .map((row) => `${row.scenario}/${row.transcript}: ${row.violations.map((item) => item.kind).join(', ')}`);
  assert.deepEqual(offending, [], `recapture with: node scripts/reviewer_edit_baseline.js --write\n${offending.join('\n')}`);

  const covered = new Set((baseline.rows || []).map((row) => `${row.scenario}|${row.transcript}`));
  for (const scenario of FIXTURES.scenarios) {
    for (const name of scenario.appliesTo) {
      assert.ok(covered.has(`${scenario.id}|${name}`), `baseline is missing ${scenario.id} on ${name}; recapture it`);
    }
  }
});

// One scenario, not the whole set. The corpus sweep is where breadth belongs; this exists
// so the cheap baseline check above cannot pass by reading a stale file. Running five
// chains here spawned MiniLM under contention with the rest of the suite and timed out at
// two minutes - a slow suite gets disabled, and then it guards nothing.
test('a correction on an early screen still reaches the later ones', { timeout: 300000 }, () => {
  const live = active.filter((scenario) => scenario.appliesTo.includes(LIVE_TRANSCRIPT)).slice(0, 1);
  assert.equal(live.length, 1, 'the live check needs exactly one scenario to run');

  const transcriptText = fs.readFileSync(harness.transcriptPath(LIVE_TRANSCRIPT), 'utf8');
  const cold = harness.runChain(transcriptText, `${LIVE_TRANSCRIPT}.txt`, []);

  for (const scenario of live) {
    const edited = harness.runChain(transcriptText, `${LIVE_TRANSCRIPT}.txt`, scenario.edits);
    const { violations } = harness.measure(scenario, edited);
    assert.deepEqual(violations, [], `${scenario.id}: ${scenario.finding}`);

    // Honouring a correction is not the same as acting on it. A correction that changed
    // nothing anywhere downstream is the complaint that started this work.
    const moved = harness.difference(cold, edited);
    assert.ok(
      moved.summaryChanged || moved.discussionChanged || moved.actionsChanged,
      `${scenario.id} changed no later stage, so the correction did nothing`
    );
  }
});
