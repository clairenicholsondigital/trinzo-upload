'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { actionIsLosslesslyCovered, exactActionIdentityConflict } = require('../utils/canonicalMinutes/actionDuplicateCoverage');
const { commitmentDuplicate, mergeCommitmentDuplicates } = require('../utils/canonicalMinutes/commitmentDuplicates');
const { dedupeHybridActionRecords } = require('../utils/meetingMinutesActionDuplicatePolicy');
const { reconcileFinalApprovedActions } = require('../utils/meetingMinutesFinalActionPreservation');

const action = (id, wording, extra = {}) => ({
  id, action: wording, owners: ['Morgan Lee'],
  timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds: ['T0010'], reviewFlagIds: [], ...extra
});

test('complete clauses inside a compound are preserved without confusing its separate recipients', () => {
  const part = action('part', 'Send the attendance list to Casey.');
  const whole = action('whole', 'Notify Alex about the room change and send the attendance list to Casey.');
  assert.equal(actionIsLosslesslyCovered(part, whole), true);
  assert.equal(actionIsLosslesslyCovered(whole, part), false);
  assert.equal(commitmentDuplicate(part, whole).duplicate, true);
  for (const records of [[part, whole], [whole, part]]) {
    const hybrid = dedupeHybridActionRecords(structuredClone(records));
    const commitment = mergeCommitmentDuplicates(structuredClone(records)).actions;
    for (const merged of [hybrid, commitment]) {
      assert.equal(merged.length, 1);
      assert.equal(merged[0].action, whole.action);
      const final = reconcileFinalApprovedActions(merged, records);
      assert.equal(final.actions.length, 1);
      assert.equal(final.restored.length, 0);
    }
  }
});

test('citation count cannot make a contained fragment displace the complete instruction', () => {
  const part = action('part', 'Send the attendance list to Casey.', {
    evidenceIds: Array.from({ length: 15 }, (_, i) => `T${String(i + 10).padStart(4, '0')}`),
    reviewFlagIds: Array.from({ length: 25 }, (_, i) => `flag-${i}`)
  });
  const whole = action('whole', 'Notify Alex about the room change and send the attendance list to Casey.', {
    evidenceIds: ['T0010', 'T0099'], reviewFlagIds: ['flag-whole']
  });
  for (const records of [[part, whole], [whole, part]]) {
    const hybrid = dedupeHybridActionRecords(structuredClone(records));
    const commitment = mergeCommitmentDuplicates(structuredClone(records)).actions;
    for (const [merged] of [hybrid, commitment]) {
      assert.equal(merged.action, whole.action);
      assert.deepEqual(new Set(merged.evidenceIds), new Set([...part.evidenceIds, ...whole.evidenceIds]));
      assert.deepEqual(new Set(merged.reviewFlagIds), new Set([...part.reviewFlagIds, ...whole.reviewFlagIds]));
    }
  }
});

test('coverage is rechecked against final wording instead of trusting a removed ID', () => {
  const part = action('repeated-id', 'Send the attendance list to Casey.');
  const whole = action('repeated-id', 'Notify Alex about the room change and send the attendance list to Casey.');
  const unrelated = action('repeated-id', 'Order the replacement display stand.', { evidenceIds: ['T0099'] });
  const merged = mergeCommitmentDuplicates([part, whole]).actions;
  assert.deepEqual(reconcileFinalApprovedActions(merged, [part, whole, unrelated]).restored, [unrelated]);
  const rewritten = [{ ...merged[0], action: 'Notify Alex about the room change.' }];
  assert.deepEqual(reconcileFinalApprovedActions(rewritten, [part]).restored, [part]);
});

test('identical text with different owners or conflicting dates remains separate', () => {
  const base = action('one', 'Review the recruitment report.');
  const variants = [
    { ...base, id: 'two', owners: ['Alex Green'] },
    { ...base, id: 'two', owners: ['Morgan Lee', 'Alex Green'] },
    { ...base, id: 'two', owners: ['Morgan Shaw'] }
  ];
  for (const other of variants) {
    assert.equal(exactActionIdentityConflict(base, other), true);
    assert.equal(commitmentDuplicate(base, other).duplicate, false);
    assert.equal(dedupeHybridActionRecords(structuredClone([base, other])).length, 2);
    assert.deepEqual(reconcileFinalApprovedActions([base], [base, other]).restored, [other]);
  }
  const monday = { ...base, timing: { kind: 'deadline', wording: 'Monday', exactDate: '2026-11-02' } };
  for (const timing of [
    { kind: 'deadline', wording: 'Friday', exactDate: '2026-11-06' },
    { kind: 'target', wording: 'Monday', exactDate: '2026-11-02' },
    { kind: 'deadline', wording: 'Monday', exactDate: '2026-11-09' }
  ]) {
    const other = { ...base, id: 'two', timing };
    assert.equal(commitmentDuplicate(monday, other).duplicate, false);
    assert.equal(dedupeHybridActionRecords(structuredClone([monday, other])).length, 2);
    assert.deepEqual(reconcileFinalApprovedActions([monday], [other]).restored, [other]);
  }
});

test('identical work may retain its known timing without inventing a deadline for a compound', () => {
  const part = action('part', 'Send the attendance list to Casey.');
  const dated = { ...part, id: 'dated', timing: { kind: 'deadline', wording: 'Monday', exactDate: '2026-11-02' } };
  assert.equal(actionIsLosslesslyCovered(part, dated), true);
  assert.equal(actionIsLosslesslyCovered(dated, part), false);
  assert.deepEqual(mergeCommitmentDuplicates([part, dated]).actions[0].timing, dated.timing);
  assert.deepEqual(reconcileFinalApprovedActions([part], [dated]).restored, [dated],
    'the same words without their known timing are not a complete representation');
  const whole = action('whole', 'Notify Alex about the room change and send the attendance list to Casey.');
  assert.equal(actionIsLosslesslyCovered(dated, whole), false);
  assert.equal(actionIsLosslesslyCovered(part, { ...whole, timing: dated.timing }), false);
});

test('containment proof preserves quantities, recipients, negation and conditional scope', () => {
  const part = action('part', 'Send three attendance lists to Casey.');
  const rejected = [
    'Notify Alex about the room change and send four attendance lists to Casey.',
    'Notify Alex about the room change and send three attendance lists to Taylor.',
    'Notify Alex about the room change and do not send three attendance lists to Casey.',
    'Notify Alex about the room change and send three attendance lists to Casey if approval arrives.',
    'Notify Alex if the room changes and send three attendance lists to Casey.',
    'Notify Alex after approval and send three attendance lists to Casey.',
    'Notify Alex about the room change, then send three attendance lists to Casey.',
    'Ask Alex to notify the visitors and send three attendance lists to Casey.'
  ];
  for (const wording of rejected) {
    assert.equal(actionIsLosslesslyCovered(part, action('whole', wording)), false, wording);
  }
  const qualified = action('qualified', 'Send three attendance lists to Casey if approval arrives.');
  const whole = action('whole', 'Notify Alex about the room change and send three attendance lists to Casey if approval arrives.');
  assert.equal(actionIsLosslesslyCovered(qualified, whole), true, 'the entire qualified clause survives unchanged');
});

test('uncertain paraphrases and unrelated evidence do not become new automatic containment matches', () => {
  const part = action('part', 'Discuss the outstanding document issues with Casey.');
  const paraphrase = action('other', 'Discuss the spreadsheet findings with Casey.');
  assert.equal(actionIsLosslesslyCovered(part, paraphrase), false);
  const exactPart = action('part', 'Send the attendance list to Casey.');
  const whole = action('whole', 'Notify Alex about the room change and send the attendance list to Casey.');
  assert.equal(actionIsLosslesslyCovered(exactPart, { ...whole, evidenceIds: ['T0090'] }), false);
  assert.equal(actionIsLosslesslyCovered({ ...exactPart, owners: [] }, { ...whole, owners: [] }), false);
});

test('a deadline or duration on another clause never silently qualifies an untimed instruction', () => {
  const part = action('part', 'Review the recruitment report.');
  for (const wording of [
    'Review the recruitment report and send the receipt by Friday.',
    'Review the recruitment report and send the receipt during the audit.',
    'Review the recruitment report and send the receipt within two days.',
    'Review the recruitment report and send the receipt Friday.',
    'Review the recruitment report and send the receipt two days later.',
    'Review the recruitment report and send the receipt if approved.',
    'Review the recruitment report and print "send the receipt".',
    'Review the recruitment report and record this instruction: send the receipt.'
  ]) {
    const whole = action('whole', wording);
    assert.equal(actionIsLosslesslyCovered(part, whole), false, wording);
    assert.equal(commitmentDuplicate(part, whole).duplicate, false, wording);
    assert.equal(dedupeHybridActionRecords(structuredClone([part, whole])).length, 2, wording);
    assert.deepEqual(reconcileFinalApprovedActions([whole], [part]).restored, [part], wording);
  }
  const embedded = action('whole', 'Review the instruction to archive files and delete backup copies.');
  assert.equal(actionIsLosslesslyCovered(action('part', 'Delete backup copies.'), embedded), false);
});

test('different structured timing cannot be smuggled through a broader containment matcher', () => {
  const part = action('part', 'Send the attendance list to Casey.', {
    timing: { kind: 'deadline', wording: 'Monday', exactDate: '2026-11-02' }
  });
  const whole = action('whole', 'Notify Alex about the room change and send the attendance list to Casey.');
  assert.equal(commitmentDuplicate(part, whole).duplicate, false);
  assert.equal(dedupeHybridActionRecords(structuredClone([part, whole])).length, 2);
  assert.deepEqual(reconcileFinalApprovedActions([whole], [part]).restored, [part]);
});

test('unquoted reported instructions and explicit prerequisite ordering are not independent clauses', () => {
  const part = action('part', 'Send the receipt.');
  for (const wording of [
    'Review the request that says review the report and send the receipt.',
    'Review the request saying review the report and send the receipt.',
    'Complete approval first and send the receipt.'
  ]) {
    const whole = action('whole', wording);
    assert.equal(actionIsLosslesslyCovered(part, whole), false, wording);
    assert.equal(commitmentDuplicate(part, whole).duplicate, false, wording);
    assert.equal(dedupeHybridActionRecords(structuredClone([part, whole])).length, 2, wording);
    assert.deepEqual(reconcileFinalApprovedActions([whole], [part]).restored, [part], wording);
  }
});

test('reviewer-authored wording is excluded from both duplicate passes', () => {
  const whole = action('whole', 'Notify Alex about the room change and send the attendance list to Casey.');
  for (const provenance of [
    { reviewerAuthored: true }, { confirmedTopic: true }, { source: 'stage_3_human_confirmation' }
  ]) {
    const part = action('part', 'Send the attendance list to Casey.', provenance);
    assert.equal(actionIsLosslesslyCovered(part, whole), false);
    assert.equal(mergeCommitmentDuplicates([part, whole]).actions.length, 2);
    assert.equal(dedupeHybridActionRecords(structuredClone([part, whole])).length, 2);
    assert.deepEqual(reconcileFinalApprovedActions([whole], [part]).restored, [part]);
    const identicalGenerated = { ...part, ...action('generated', part.action) };
    assert.equal(dedupeHybridActionRecords(structuredClone([part, identicalGenerated])).length, 2,
      'delivery bundling must not rewrite the preserved reviewer row');
  }
});

test('delivery bundling cannot undo the protection for separate dated occurrences', () => {
  const first = action('first', 'Send the attendance list to Casey.', {
    timing: { kind: 'deadline', wording: 'Monday', exactDate: '2026-11-02' }
  });
  const second = { ...first, id: 'second', timing: { ...first.timing, exactDate: '2026-11-09' } };
  assert.deepEqual(dedupeHybridActionRecords(structuredClone([first, second])), [first, second]);
});

test('final reconciliation recognises cloned reviewer rows by occurrence without collapsing intentional repeats', () => {
  const manual = action('shared-id', 'Send the attendance list to Casey.', { reviewerAuthored: true });
  const other = { ...manual, action: 'Prepare the revised room plan.' };
  const approved = [manual, structuredClone(manual), other];
  const complete = reconcileFinalApprovedActions(structuredClone(approved), approved);
  assert.equal(complete.actions.length, 3);
  assert.deepEqual(complete.restored, []);
  const missingOne = reconcileFinalApprovedActions(structuredClone([manual, other]), approved);
  assert.equal(missingOne.actions.length, 3);
  assert.equal(missingOne.restored.length, 1);
  assert.equal(missingOne.restored[0].action, manual.action);
  assert.equal(reconcileFinalApprovedActions(structuredClone([manual]), [other]).restored.length, 1,
    'a shared ID never represents different reviewer wording');
});

test('a completed lossless merge is idempotent', () => {
  const part = action('part', 'Send the attendance list to Casey.');
  const whole = action('whole', 'Notify Alex about the room change and send the attendance list to Casey.');
  const once = dedupeHybridActionRecords(structuredClone([part, whole]));
  assert.deepEqual(dedupeHybridActionRecords(structuredClone(once)), once);
  const final = reconcileFinalApprovedActions(once, [part, whole]);
  assert.deepEqual(reconcileFinalApprovedActions(final.actions, [part, whole]), final);
});
