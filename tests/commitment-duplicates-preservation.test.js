'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { commitmentDuplicate, mergeCommitmentDuplicates, commitmentCanBeRepresented, commitmentScopeConflict } = require('../utils/canonicalMinutes/commitmentDuplicates');
const { actionIsSafelyCovered } = require('../utils/canonicalMinutes/actionDuplicateCoverage');

const action = (id, wording, extra = {}) => ({
  id, action: wording, owners: ['Alex Green'], evidenceIds: ['T0001', 'T0002'], reviewFlagIds: [],
  timing: { kind: 'not_stated', wording: '', exactDate: '' }, ...extra
});

function assertSeparate(left, right) {
  for (const records of [[left, right], [right, left]]) {
    assert.equal(commitmentDuplicate(records[0], records[1], { cosine: 1 }).duplicate, false);
    const out = mergeCommitmentDuplicates(structuredClone(records), { cosines: new Map([['0|1', 1]]) });
    assert.deepEqual(out.actions, records);
    assert.deepEqual(out.merged, []);
  }
}

test('shared nouns, citations and embedding agreement cannot discard a different operation', () => {
  for (const [left, right] of [
    ['Review the completed safety report.', 'Send the completed safety report.'],
    ['Review the completed safety report.', 'Test the completed safety report.'],
    ['Start the required electrical testing.', 'Define the required electrical testing.'],
    ['Review the report and send the receipt.', 'Review the report and archive the receipt.']
  ]) assertSeparate(action('one', left), action('two', right));
});

test('numeric and word quantities remain distinct, including small counts and partially shared figures', () => {
  for (const [left, right] of [
    ['Install 3 replacement filters.', 'Install 4 replacement filters.'],
    ['Install three replacement filters.', 'Install four replacement filters.'],
    ['Send 3 reports and 4 checklists.', 'Send 3 reports and 5 checklists.'],
    ['Send 3 reports to Morgan and 4 reports to Casey.', 'Send 4 reports to Morgan and 3 reports to Casey.'],
    ['Send one report.', 'Send two reports.']
  ]) assertSeparate(action('one', left), action('two', right));
});

test('polarity, recipients, conditions and inline dates cannot be exchanged', () => {
  for (const [left, right] of [
    ['Send the completed safety report.', 'Do not send the completed safety report.'],
    ['Send the report to Morgan Lee.', 'Send the report to Morgan Smith.'],
    ['Send the report to Morgan and send the checklist to Casey.', 'Send the report to Casey and send the checklist to Morgan.'],
    ['Send the report if approval arrives.', 'Send the report.'],
    ['Send the report after approval.', 'Send the report before approval.'],
    ['Send the report on 3 November.', 'Send the report on 10 November.']
  ]) assertSeparate(action('one', left), action('two', right));
  const broad = action('one', 'Send the report to Morgan.');
  const specific = action('two', 'Send the report to Morgan for a signature.');
  const out = mergeCommitmentDuplicates([broad, specific]);
  assert.equal(out.actions.length, 1);
  assert.equal(out.actions[0].action, specific.action, 'an added purpose must survive when related variants consolidate');
});

test('a compound cannot inherit the date or owner of a differently worded fragment', () => {
  const part = action('part', 'Send the report to Morgan.', {
    timing: { kind: 'deadline', wording: 'Monday', exactDate: '2026-11-02' }
  });
  const whole = action('whole', 'Review the report and send the report to Morgan.');
  assertSeparate(part, whole);
  assertSeparate(action('part', 'Send the report to Morgan.', { owners: [] }), whole);
});

test('the winner must preserve the complete instruction rather than the highest evidence count', () => {
  const part = action('part', 'Send the attendance list to Morgan.', {
    evidenceIds: Array.from({ length: 15 }, (_, i) => `T${String(i + 1).padStart(4, '0')}`), reviewFlagIds: ['part-check']
  });
  const whole = action('whole', 'Notify Casey about the room change and send the attendance list to Morgan.', {
    reviewFlagIds: ['whole-check']
  });
  for (const records of [[part, whole], [whole, part]]) {
    const out = mergeCommitmentDuplicates(structuredClone(records));
    assert.equal(out.actions.length, 1);
    assert.equal(out.actions[0].action, whole.action);
    assert.deepEqual(new Set(out.actions[0].evidenceIds), new Set([...part.evidenceIds, ...whole.evidenceIds]));
    assert.deepEqual(new Set(out.actions[0].reviewFlagIds), new Set(['part-check', 'whole-check']));
  }
});

test('bounded existing editing alternatives retain the entire object and its qualifiers', () => {
  const left = action('one', 'Revise the safety report after approval and send it to Morgan.');
  const right = action('two', 'Update the safety report after approval and send it to Morgan.');
  assert.equal(commitmentDuplicate(left, right).duplicate, true);
  assert.equal(mergeCommitmentDuplicates([left, right]).actions.length, 1);
  assertSeparate(left, { ...right, action: 'Update the safety report before approval and send it to Morgan.' });
  assertSeparate(left, { ...right, action: 'Update the safety report after approval.' });
  assert.equal(actionIsSafelyCovered(left, { ...right, evidenceIds: ['T0099'] }), false);
  assert.equal(commitmentDuplicate(left, { ...right, evidenceIds: ['T0099'] }).duplicate, false,
    'the no-embedding lexical relation still needs shared evidence');
});

test('known timing survives an otherwise identical editing instruction without changing its kind', () => {
  const untimed = action('one', 'Revise the safety report.');
  const dated = action('two', 'Update the safety report.', {
    timing: { kind: 'target', wording: 'This week', exactDate: '2026-11-06' }
  });
  assert.equal(actionIsSafelyCovered(untimed, dated), true);
  assert.equal(actionIsSafelyCovered(dated, untimed), false);
  for (const rows of [[untimed, dated], [dated, untimed]]) {
    const out = mergeCommitmentDuplicates(rows);
    assert.equal(out.actions.length, 1);
    assert.deepEqual(out.actions[0].timing, dated.timing);
  }
  assertSeparate(dated, { ...dated, id: 'three', timing: { ...dated.timing, kind: 'deadline' } });
});

test('the exact helper adds no operation aliases; existing related review wording retains all detail', () => {
  const review = action('one', 'Review the safety report.'); const check = action('two', 'Check the safety report.');
  assert.equal(actionIsSafelyCovered(review, check), false);
  assert.equal(commitmentDuplicate(review, check).duplicate, true);
  assert.equal(actionIsSafelyCovered(action('one', 'Update Morgan about the safety report.'), action('two', 'Revise Morgan about the safety report.')), false);
});

test('an editing alias never erases different responsibility or reviewer wording', () => {
  const first = action('one', 'Revise the safety report.');
  for (const extra of [
    { owners: ['Alex Smith'] }, { owners: ['Alex Green', 'Casey Lee'] }, { owners: [] },
    { reviewerAuthored: true }, { confirmedTopic: true }, { source: 'stage_3_human_confirmation' }
  ]) assertSeparate(first, action('two', 'Update the safety report.', extra));
});

test('an explicit inline by-deadline survives consolidation directionally', () => {
  const bare = action('bare', 'Send the signed contract to the landlord.');
  for (const deadline of ['Friday', 'the tenth', '3 November']) {
    const dated = action('dated', `Send the landlord the signed contract by ${deadline}.`);
    assert.equal(commitmentScopeConflict(bare, dated), false, deadline);
    assert.equal(commitmentCanBeRepresented(bare, dated), true, deadline);
    assert.equal(commitmentCanBeRepresented(dated, bare), false, deadline);
    for (const rows of [[bare, dated], [dated, bare]]) {
      const out = mergeCommitmentDuplicates(rows);
      assert.equal(out.actions.length, 1, deadline);
      assert.equal(out.actions[0].action, dated.action, 'the inline deadline remains in the survivor');
    }
  }
  assertSeparate(action('one', 'Send the report by Friday.'), action('two', 'Send the report by Monday.'));
  assertSeparate(action('one', 'Send the report by Morgan.'), action('two', 'Send the report.'));
});

test('additional gate scope is allowed only for an explicit constructor; conflicts and quantity/polarity remain blocked', () => {
  const bare = action('bare', 'Send the report.');
  const gated = action('gated', 'Send the report if approval arrives.');
  assert.equal(commitmentScopeConflict(bare, gated), true);
  assert.equal(commitmentScopeConflict(bare, gated, { allowAdditionalScope: true }), false);
  assert.equal(commitmentCanBeRepresented(bare, gated), false);
  for (const [left, right] of [
    ['Send the report if approval arrives.', 'Send the report unless approval arrives.'],
    ['Send the report before approval.', 'Send the report after approval.'],
    ['Send three reports.', 'Send four reports if approval arrives.'],
    ['Send the report.', 'Do not send the report if approval arrives.']
  ]) assert.equal(commitmentScopeConflict(action('one', left), action('two', right), { allowAdditionalScope: true }), true);
});

test('normalising an instruction once never strips a leading document modifier from its body', () => {
  for (const [specificText, broadText] of [
    ['Send the draft report.', 'Send the report.'],
    ['Send the update instructions.', 'Send the instructions.']
  ]) {
    const specific = action('specific', specificText); const broad = action('broad', broadText);
    assert.equal(commitmentCanBeRepresented(specific, broad), false, specificText);
    for (const rows of [[specific, broad], [broad, specific]]) {
      const out = mergeCommitmentDuplicates(rows);
      assert.ok(out.actions.some(record => record.action === specificText), 'the qualifier must survive any related consolidation');
      assert.equal(out.actions.length, 1);
    }
  }
});

test('recency and version qualifiers cannot disappear or choose an incompatible variant', () => {
  for (const [left, right] of [
    ['Send the new safety report.', 'Send the old safety report.'],
    ['Send the current inventory report.', 'Send the existing inventory report.'],
    ['Send the additional checklist.', 'Send the remaining checklist.'],
    ['Send the required checklist.', 'Send the relevant checklist.']
  ]) assertSeparate(action('one', left), action('two', right));
  const specific = action('specific', 'Send the new safety report.');
  const broad = action('broad', 'Send the safety report.');
  assert.equal(commitmentCanBeRepresented(specific, broad), false);
  assert.equal(commitmentCanBeRepresented(broad, specific), true);
  assert.equal(mergeCommitmentDuplicates([specific, broad]).actions[0].action, specific.action);
});

test('existing recipient and destination guards also protect directional representation', () => {
  const one = action('one', 'Send the inventory report from Morgan to Casey.');
  const two = action('two', 'Send the inventory report from Casey to Morgan.');
  assert.equal(commitmentCanBeRepresented(one, two), false);
  assert.equal(commitmentCanBeRepresented(two, one), false);
  assertSeparate(one, two);
});
