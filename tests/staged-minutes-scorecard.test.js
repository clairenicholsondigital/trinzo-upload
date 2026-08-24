'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { overlap, coverage, actionMatch, wordingFaultsAcross, MATCH_THRESHOLD } = require('../scripts/staged_minutes_scorecard');

// The scorer's own logic, tested without a live model.
//
// The scorecard exists to answer a question none of the other harnesses can: not "did this
// change" but "is it right", against the thirteen expected.json files a person wrote by
// reading the real transcripts. These tests pin the matching logic on its own, because a
// scorer that is wrong about what counts as a match would misreport every fixture it
// touches - and because requiring the script for its exports must never trigger the live
// thirteen-fixture run that main() performs, which is exactly what happened once while
// building this and cost several live LLM calls before it was caught.

test('requiring the script does not start a live run', () => {
  // If main() ran at require time this process would hang waiting on a live Trooper call
  // with no API key configured for the test suite. Reaching this assertion at all is the
  // proof.
  assert.equal(typeof overlap, 'function');
});

test('identical text overlaps completely', () => {
  assert.equal(overlap('Confirm presenter handovers and roles.', 'Confirm presenter handovers and roles.'), 1);
});

test('a real paraphrase still overlaps, a different subject does not', () => {
  assert.ok(overlap('Confirm presenter handovers and roles', 'Confirm handover from Priya to Tom') > 0);
  assert.equal(overlap('Confirm presenter handovers and roles', 'Order six sacks of malt today'), 0);
});

test('coverage reports a fraction and the unmatched items, not a verdict', () => {
  const result = coverage(
    ['Order the hop bill', 'Ring the engineer', 'Confirm the delivery date'],
    ['Order the hop bill on Monday', 'Ring the refrigeration engineer'],
    overlap
  );
  assert.equal(result.matched, 2);
  assert.equal(result.total, 3);
  assert.deepEqual(result.unmatched, ['Confirm the delivery date']);
});

test('an action match respects the owner as well as the words', () => {
  const expected = { owner: 'Ravi', action: 'Order the full 13 kg hop bill on Monday morning.' };
  assert.ok(actionMatch(expected, { owner: 'Ravi', action: 'Order the full 13kg hop bill Monday morning' }) >= MATCH_THRESHOLD);
  // Same words, wrong person - scored down rather than treated as a hit, because a
  // reviewer cannot use an action attributed to the wrong owner without noticing and
  // fixing it, which is a real cost even when the wording is otherwise perfect.
  assert.ok(actionMatch(expected, { owner: 'Dan', action: 'Order the full 13kg hop bill Monday morning' }) < MATCH_THRESHOLD);
});

test('an owner-blank action can still match on content alone', () => {
  // The unassigned-actions work from earlier this session deliberately publishes real
  // work with the owner left blank rather than guessing. The scorer must not punish that
  // choice twice by also refusing to recognise the action.
  const expected = { owner: 'Andrew', action: 'Complete Electrical compliance testing' };
  assert.ok(actionMatch(expected, { owner: 'Not stated', action: 'Complete the electrical compliance testing' }) >= MATCH_THRESHOLD);
});

test('wording faults are counted per surface using the shared detectors, not a new definition', () => {
  const result = wordingFaultsAcross(['Find that little clock top right', 'Send the artwork proofs to Kettleby Print']);
  assert.equal(result.checked, 2);
  assert.equal(result.flagged, 1);
  assert.ok(result.counts.unresolved_deixis >= 1);
});

test('every committed fixture has a transcript and an expected.json the scorer can read', () => {
  const root = path.resolve(__dirname, '../scripts/staged-scorecard-fixtures');
  const fixtures = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  assert.ok(fixtures.length >= 13, `expected at least 13 fixtures, found ${fixtures.length}`);
  for (const fixture of fixtures) {
    const dir = path.join(root, fixture.name);
    assert.ok(fs.existsSync(path.join(dir, 'transcript.txt')), `${fixture.name} is missing transcript.txt`);
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8'));
    const expected = raw.expected || raw;
    for (const key of ['meetingType', 'meetingPurpose', 'meetingObjectives', 'overallTopicsDiscussed', 'discussion', 'actions']) {
      assert.ok(key in expected, `${fixture.name} expected.json is missing "${key}"`);
    }
  }
});
