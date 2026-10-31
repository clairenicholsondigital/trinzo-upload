'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  actionIsLosslesslyCovered, actionIsSafelyCovered, conflictingTimings, exactActionIdentityConflict
} = require('../utils/canonicalMinutes/actionDuplicateCoverage');
const {
  commitmentDuplicate, commitmentVariantCovered, mergeCommitmentDuplicates, reconcileCommitmentVariants
} = require('../utils/canonicalMinutes/commitmentDuplicates');
const { dedupeHybridActionRecords } = require('../utils/meetingMinutesActionDuplicatePolicy');
const { reconcileFinalApprovedActions } = require('../utils/meetingMinutesFinalActionPreservation');

const timing = (wording, extra = {}) => ({ kind: 'dependency', wording, exactDate: '', ...extra });
const row = (id, action, wording, extra = {}) => ({
  id, action, owners: ['Morgan Lee'], timing: timing(wording),
  evidenceIds: ['T0010'], reviewFlagIds: [], ...extra
});

function assertPreservedMerge(short, rich) {
  const originals = structuredClone([short, rich]);
  for (const pair of [[short, rich], [rich, short]]) {
    const commitment = mergeCommitmentDuplicates(structuredClone(pair)).actions;
    const hybrid = dedupeHybridActionRecords(structuredClone(pair));
    for (const result of [commitment, hybrid]) {
      assert.equal(result.length, 1);
      const retained = result[0];
      assert.equal(retained.action, rich.action);
      assert.deepEqual(retained.timing, rich.timing, 'keep the winner\'s original timing wording');
      assert.deepEqual(retained.timingDecision, rich.timingDecision);
      assert.deepEqual(new Set(retained.evidenceIds), new Set([...short.evidenceIds, ...rich.evidenceIds]));
      assert.deepEqual(new Set(retained.reviewFlagIds), new Set([...short.reviewFlagIds, ...rich.reviewFlagIds]));
      const final = reconcileFinalApprovedActions(result, structuredClone(pair));
      assert.equal(final.restored.length, 0, 'final survival must not restore an equivalent timing variant');
      assert.equal(final.actions.length, 1);
      assert.equal(final.actions[0].action, rich.action);
      assert.deepEqual(final.actions[0].timing, rich.timing);
      assert.deepEqual(final.actions[0].timingDecision, rich.timingDecision);
      assert.deepEqual(mergeCommitmentDuplicates(final.actions).actions, final.actions);
      assert.deepEqual(dedupeHybridActionRecords(final.actions), final.actions);
      assert.deepEqual(reconcileFinalApprovedActions(final.actions, structuredClone(pair)).actions, final.actions);
    }
  }
  assert.deepEqual([short, rich], originals, 'comparisons must not rewrite their input records');
}

test('optional on before each full weekday is comparison-only across duplicate and survival passes', () => {
  for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']) {
    const short = row('short', 'Install the replacement intake filter.', `when servicing the ventilation unit ${day}`, {
      evidenceIds: ['T0010', 'T0011'], reviewFlagIds: ['flag-short']
    });
    const rich = row('rich', 'Fit the new replacement intake filter.', `when servicing the ventilation unit on ${day}`, {
      evidenceIds: ['T0010', 'T0012'], reviewFlagIds: ['flag-rich']
    });
    assert.equal(conflictingTimings(short, rich), false);
    assert.equal(commitmentVariantCovered(short, rich), true);
    assert.equal(commitmentVariantCovered(rich, short), false);
    const identical = { ...rich, action: short.action };
    assert.equal(actionIsLosslesslyCovered(short, identical), true);
    assert.equal(actionIsSafelyCovered(short, identical), true);
    assert.equal(exactActionIdentityConflict(short, identical), false);
    assertPreservedMerge(short, rich);
  }
});

// Frozen from the two action rows in the fresh saved Allotment fixture on
// 2026-10-22. Keep this local to the regression: production has no meeting-
// specific vocabulary, row IDs, owners or evidence IDs.
const savedRows = [
  {
    id: 'e94795972109e369c6c1',
    action: 'Fit the alarm to the communal shed.',
    owners: ['Ken Ogden'],
    timing: timing('when carrying out the water butt work Saturday'),
    evidenceIds: ['T0087', 'T0085'],
    reviewFlagIds: ['flag-timing-8cd88b7deee09775', 'flag-4260976d9e', 'flag-timing-010d7896b3120678'],
    timingDecision: {
      reason: 'timing_source_unresolved', status: 'unresolved',
      binding: { reason: 'timing_binding_not_established', status: 'unresolved', matchedSourceIds: [], conflictingSourceIds: [] },
      version: 4, actionKey: 'fit the alarm to the communal shed', ownersKey: 'ken ogden', sourceKey: '2a05372',
      meetingDate: '2026-08-05', checkerReason: 'source_timing_binding_unresolved', checkerStatus: 'uncertain',
      rejectedWordings: [], sourceEvidenceIds: ['T0085', 'T0087'], rejectedExactDates: []
    }
  },
  {
    id: '1e8a8a01d683d91c1487',
    action: 'Fit the hasp, padlock and alarm to improve communal shed security.',
    owners: ['Ken Ogden'],
    timing: timing('when carrying out the water butt work on Saturday'),
    evidenceIds: ['T0087', 'T0085'],
    reviewFlagIds: ['flag-timing-2cb601b260487439', 'flag-26a66fb31e', 'flag-timing-1f4b12c836d17a19'],
    timingDecision: {
      reason: 'timing_source_unresolved', status: 'unresolved',
      binding: { reason: 'timing_binding_not_established', status: 'unresolved', matchedSourceIds: [], conflictingSourceIds: [] },
      version: 4, actionKey: 'fit the hasp padlock and alarm to improve communal shed security',
      ownersKey: 'ken ogden', sourceKey: '2a05372', meetingDate: '2026-08-05',
      checkerReason: 'source_timing_binding_unresolved', checkerStatus: 'uncertain',
      rejectedWordings: [], sourceEvidenceIds: ['T0085', 'T0087'], rejectedExactDates: []
    }
  }
];

test('fresh saved duplicate keeps the full security instruction and unresolved timing in either order', () => {
  const [short, rich] = structuredClone(savedRows);
  assert.equal(commitmentVariantCovered(short, rich), true);
  assert.equal(commitmentVariantCovered(rich, short), false);
  assertPreservedMerge(short, rich);
});

test('comparison preserves timing rejection history and publication annotations without verifying a date', () => {
  const short = row('short', 'Install the replacement intake filter.', 'during maintenance Monday', {
    _timingConflicts: ['short-conflict'], _timingPublicationIssue: 'source_not_verified'
  });
  const rich = row('rich', 'Fit the new replacement intake filter.', 'during maintenance on Monday', {
    timingDecision: {
      status: 'unresolved', checkerStatus: 'uncertain', rejectedWordings: ['Friday'],
      rejectedExactDates: ['2026-10-23']
    },
    _timingConflicts: ['rich-conflict'], _timingClauseNote: 'pending source review'
  });
  assertPreservedMerge(short, rich);
  for (const pair of [[short, rich], [rich, short]]) {
    const [merged] = mergeCommitmentDuplicates(pair).actions;
    assert.deepEqual(new Set(merged._timingConflicts), new Set(['short-conflict', 'rich-conflict']));
    assert.equal(merged._timingPublicationIssue, 'source_not_verified');
    assert.equal(merged._timingClauseNote, 'pending source review');
    assert.deepEqual(merged.timingDecision, rich.timingDecision);
    assert.equal(merged.timing.exactDate, '');
  }
});

test('a winner without a timing decision cannot inherit a removed variant\'s verification', () => {
  const short = row('short', 'Install the replacement intake filter.', 'Monday', {
    timingDecision: { status: 'verified', actionKey: 'install the replacement intake filter' }
  });
  const rich = row('rich', 'Fit the new replacement intake filter.', 'on Monday');
  assertPreservedMerge(short, rich);
});

test('weekdays, exact dates, timing kinds, operators and remaining timing wording remain distinct', () => {
  const base = row('base', 'Install the replacement intake filter.', 'Monday', {
    timing: timing('Monday', { kind: 'deadline', exactDate: '2026-11-02' })
  });
  const alternatives = [
    timing('on Tuesday', { kind: 'deadline', exactDate: '2026-11-02' }),
    timing('on Monday', { kind: 'target', exactDate: '2026-11-02' }),
    timing('on Monday', { kind: 'deadline', exactDate: '2026-11-09' }),
    timing('on Monday', { kind: 'deadline', exactDate: '' }),
    ...['by Monday', 'before Monday', 'after Monday', 'until Monday', 'during Monday',
      'Monday if approval arrives', 'Monday unless approval arrives', 'every Monday',
      'next Monday', 'on next Monday', 'on Mon', 'Monday morning', 'Monday evening'
    ].map(wording => timing(wording, { kind: 'deadline', exactDate: '2026-11-02' }))
  ];
  for (const otherTiming of alternatives) {
    const other = { ...base, id: 'other', timing: otherTiming };
    assert.equal(conflictingTimings(base, other), true, otherTiming.wording);
    assert.equal(commitmentDuplicate(base, other).duplicate, false, otherTiming.wording);
    for (const pair of [[base, other], [other, base]]) {
      assert.equal(mergeCommitmentDuplicates(pair, { cosines: new Map([['0|1', 1]]) }).actions.length, 2);
      assert.equal(dedupeHybridActionRecords(pair).length, 2);
      assert.deepEqual(reconcileFinalApprovedActions([pair[0]], pair).restored, [pair[1]]);
    }
  }
  for (const [left, right] of [
    ['before Monday', 'on Monday'], ['after Monday', 'by Monday'],
    ['when approval arrives Monday', 'if approval arrives on Monday'],
    ['when approval arrives Monday', 'unless approval arrives on Monday'],
    ['on Mondayish', 'Mondayish'], ['on Mon', 'Mon'], ['on next Monday', 'next Monday']
  ]) assert.equal(conflictingTimings(row('a', base.action, left), row('b', base.action, right)), true);
});

test('weekday words inside quoted names, introduced wording and possessive labels retain their identity', () => {
  for (const [left, right] of [
    ['after approval of the "On Monday" plan', 'after approval of the "Monday" plan'],
    ["after approval of the 'On Monday' plan", "after approval of the 'Monday' plan"],
    ['after approval of the “On Monday” plan', 'after approval of the “Monday” plan'],
    ['after approval of the ‘On Monday’ plan', 'after approval of the ‘Monday’ plan'],
    ['after approval of plan: On Monday', 'after approval of plan: Monday'],
    ['after approval of the (On Monday) plan', 'after approval of the (Monday) plan'],
    ["after approval of On Monday's report", "after approval of Monday's report"],
    ['after approval of On Monday’s report', 'after approval of Monday’s report']
  ]) {
    const first = row('first', 'Install the replacement intake filter.', left);
    const second = row('second', first.action, right);
    assert.equal(conflictingTimings(first, second), true, left);
    for (const pair of [[first, second], [second, first]]) {
      assert.equal(mergeCommitmentDuplicates(pair).actions.length, 2);
      assert.equal(dedupeHybridActionRecords(pair).length, 2);
      assert.deepEqual(reconcileFinalApprovedActions([pair[0]], pair).restored, [pair[1]]);
    }
  }
  const short = row('short', 'Install the replacement intake filter.', "when the supplier's crew arrives Monday");
  const rich = row('rich', 'Fit the new replacement intake filter.', "when the supplier's crew arrives on Monday");
  assertPreservedMerge(short, rich);
  assertPreservedMerge({ ...short, timing: timing('when the supplier’s crew arrives Monday') },
    { ...rich, timing: timing('when the supplier’s crew arrives on Monday') });
  for (const wording of ["when it's clear", 'when it’s clear']) {
    assertPreservedMerge({ ...short, timing: timing(`${wording} Monday`) },
      { ...rich, timing: timing(`${wording} on Monday`) });
  }
});

test('equivalent weekday wording does not relax operation, recipient, owner, evidence or reviewer safeguards', () => {
  const short = row('short', 'Install the replacement intake filter.', 'when servicing the unit Monday');
  const rich = row('rich', 'Fit the new replacement intake filter.', 'when servicing the unit on Monday');
  const separate = [
    { ...rich, owners: [] },
    { ...rich, owners: ['Morgan Shaw'] },
    { ...rich, owners: ['Morgan Lee', 'Casey Green'] },
    { ...rich, evidenceIds: ['T0099'] },
    { ...rich, action: 'Repair the replacement intake filter.' },
    { ...rich, action: 'Install the replacement intake filter if approval arrives.' },
    { ...rich, action: 'Install the replacement intake filter and test the airflow.' },
    { ...rich, reviewerAuthored: true },
    { ...rich, confirmedTopic: true },
    { ...rich, source: 'stage_3_human_confirmation' }
  ];
  for (const other of separate) {
    assert.equal(commitmentVariantCovered(short, other), false, JSON.stringify(other));
    assert.equal(reconcileCommitmentVariants(short, other), null);
    for (const pair of [[short, other], [other, short]]) {
      assert.equal(mergeCommitmentDuplicates(pair, { cosines: new Map([['0|1', 1]]) }).actions.length, 2);
      assert.equal(dedupeHybridActionRecords(pair).length, 2);
      assert.deepEqual(reconcileFinalApprovedActions([pair[0]], pair).restored, [pair[1]]);
    }
  }
  const unrelatedEvidence = { ...rich, evidenceIds: ['T0099'] };
  assert.equal(commitmentVariantCovered(short, unrelatedEvidence), false);
  assert.equal(reconcileCommitmentVariants(short, unrelatedEvidence), null);
  const send = row('send', 'Send the inspection report to Casey.', 'Monday');
  const otherRecipient = row('other', 'Send the inspection report to Taylor.', 'on Monday');
  assert.equal(reconcileCommitmentVariants(send, otherRecipient), null);
  assert.equal(mergeCommitmentDuplicates([send, otherRecipient], { cosines: new Map([['0|1', 1]]) }).actions.length, 2);
  assert.deepEqual(reconcileFinalApprovedActions([send], [send, otherRecipient]).restored, [otherRecipient]);
});

test('reviewer-authored weekday spellings and intentional repeated rows retain their separate occurrences', () => {
  const first = row('first', 'Send the inspection report to Casey.', 'Monday', { reviewerAuthored: true });
  const second = { ...first, id: 'second', timing: timing('on Monday') };
  for (const pair of [[first, second], [second, first]]) {
    assert.equal(mergeCommitmentDuplicates(pair).actions.length, 2);
    assert.equal(dedupeHybridActionRecords(pair).length, 2);
    assert.deepEqual(reconcileFinalApprovedActions([pair[0]], pair).restored, [pair[1]]);
    const final = reconcileFinalApprovedActions(structuredClone(pair), pair);
    assert.equal(final.actions.length, 2);
    assert.equal(final.restored.length, 0);
  }
  const deliberateCopy = { ...first, id: 'copy' };
  assert.equal(reconcileFinalApprovedActions([structuredClone(first)], [first, deliberateCopy]).actions.length, 2);
});

test('weekday equivalence does not donate timing to an undated extraction or a compound operation', () => {
  const timed = row('timed', 'Install the replacement intake filter.', 'on Monday');
  const untimed = { ...timed, id: 'untimed', timing: { kind: 'not_stated', wording: '', exactDate: '' } };
  assert.equal(actionIsLosslesslyCovered(timed, untimed), false);
  assert.deepEqual(reconcileFinalApprovedActions([untimed], [timed]).restored, [timed]);
  const compound = { ...timed, id: 'compound', action: 'Install the replacement intake filter and send the service report.' };
  assert.equal(actionIsLosslesslyCovered(timed, compound), false);
  assert.equal(commitmentVariantCovered(timed, compound), false);
});
