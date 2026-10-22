'use strict';

// Independent R17 adversarial controls. These exercise row identity rather than
// generation quality: no provider, database, or mutable draft is involved.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assignGeneratedActionIdentities, findActionOccurrenceIndex
} = require('../utils/meetingMinutesActionIdentity');
const { applyProposal, normaliseAgentResult } = require('../utils/meetingMinutesAgentV2');
const {
  actionReviewCounts, normaliseRemovedActions, normaliseKeptActionOccurrenceIds
} = require('../utils/actionReviewState');
const {
  admitMeetingAgentGeneratedActionChanges, rebaseMeetingAgentProposal
} = require('../routes/api').stagedEvaluation;

const clone = value => JSON.parse(JSON.stringify(value));
const contentOnly = row => {
  const { id, occurrenceId, ...content } = row;
  return content;
};
const action = (id, label = 'Inspect the sensor', evidence = 'T100') => ({
  id, action: label, owners: ['Alex'],
  timing: { kind: 'dependency', wording: 'after approval', exactDate: '' },
  evidenceIds: [evidence], reviewFlagIds: ['flag-' + evidence],
  timingDecision: { state: 'keep', selectedAlternative: { evidenceId: evidence }, note: 'subject to approval' },
  reviewerAuthored: true,
  systemTimingIssue: { id: 'timing-' + evidence, origin: { id, evidenceIds: [evidence] } },
  customMetadata: { preserved: [false, 0, { note: 'do not flatten' }] }
});

test('R17 independent: fresh admission changes only row identity and never mutates source', () => {
  const input = [action('A6', 'Inspect the sensor', 'T100'), action('A6', 'Inspect the wiring', 'T200')];
  const before = clone(input);
  const result = assignGeneratedActionIdentities(input, { generationKey: 'run' }).actions;
  assert.deepEqual(input, before);
  assert.deepEqual(result.map(contentOnly), input.map(contentOnly));
  assert.equal(new Set(result.map(row => row.id)).size, input.length);
  assert.equal(new Set(result.map(row => row.occurrenceId)).size, input.length);
  assert.ok(result.every(row => row.occurrenceId));
});

test('R17 independent: admitted identities survive JSON, repeated assembly and reorder', () => {
  const raw = [action('A6', 'Inspect the sensor', 'T100'), action('A6', 'Inspect the wiring', 'T200')];
  const original = assignGeneratedActionIdentities(raw, { generationKey: 'run' }).actions;
  assert.deepEqual(assignGeneratedActionIdentities(clone(original), { generationKey: 'run' }).actions, original);
  const reversed = assignGeneratedActionIdentities(clone(original).reverse(), { generationKey: 'run' }).actions;
  assert.deepEqual(reversed, [...original].reverse());
  const rawReversed = assignGeneratedActionIdentities(clone(raw).reverse(), { generationKey: 'run' }).actions;
  assert.deepEqual(rawReversed, [...original].reverse());
});

test('R17 independent: active and removed IDs and occurrences are reserved for new admissions', () => {
  const old = assignGeneratedActionIdentities([action('A6')], { generationKey: 'old' }).actions[0];
  const removed = assignGeneratedActionIdentities([action('A7')], { generationKey: 'old' }).actions[0];
  const input = [clone(old), clone(removed), action('A6', 'Another task', 'T300')];
  const rows = assignGeneratedActionIdentities(input, { reservedActions: [old, removed], generationKey: 'new' }).actions;
  assert.equal(new Set(rows.map(row => row.id)).size, 3);
  assert.equal(new Set(rows.map(row => row.occurrenceId)).size, 3);
  for (const row of rows) {
    assert.ok(![old.id, removed.id].includes(row.id));
    assert.ok(![old.occurrenceId, removed.occurrenceId].includes(row.occurrenceId));
  }
  assert.deepEqual(rows.map(contentOnly), input.map(contentOnly));
});

test('R17 independent: explicit existing copies preserve historical IDs without rewriting the source', () => {
  const input = [action('A6', 'Inspect the sensor', 'T100'), action('A6', 'Inspect the wiring', 'T200')];
  const before = clone(input);
  const result = assignGeneratedActionIdentities(clone(input), { existingActions: input, generationKey: 'new' }).actions;
  assert.deepEqual(input, before);
  assert.deepEqual(result.map(row => row.id), ['A6', 'A6']);
  assert.deepEqual(result.map(contentOnly), before.map(contentOnly));
  assert.equal(new Set(result.map(row => row.occurrenceId)).size, 2);
});

test('R17 independent: ordinary normalization preserves historical IDs and does not allocate occurrences', () => {
  const rows = [action('A6', 'Inspect the sensor', 'T100'), action('A6', 'Inspect the wiring', 'T200')];
  const normalised = normaliseAgentResult({ actions: rows }, [], 'actions', {
    enforceEvidence: false, dedupeActions: false, preserveReviewerEdits: true
  }).actions;
  assert.equal(normalised.length, 2);
  assert.deepEqual(normalised.map(row => row.id), ['A6', 'A6']);
  assert.ok(normalised.every(row => !Object.hasOwn(row, 'occurrenceId')));
});

test('R17 independent: legacy duplicate target resolves by provenance after reorder, never ordinal position', () => {
  const first = action('A6', 'Inspect the sensor', 'T100');
  const second = action('A6', 'Inspect the sensor', 'T200');
  const proposal = { id: 'p', stage: 'actions', changes: [{
    id: 'c', type: 'modify', before: second, after: { ...second, action: 'Inspect the revised sensor' }, index: 1
  }] };
  const after = applyProposal([second, first], proposal, ['c']);
  assert.equal(after[0].action, 'Inspect the revised sensor');
  assert.deepEqual(after[1], first);
});

test('R17 independent: removed legacy target must not fall onto its same-text different-evidence sibling', () => {
  const first = action('A6', 'Inspect the sensor', 'T100');
  const second = action('A6', 'Inspect the sensor', 'T200');
  const proposal = { id: 'p', stage: 'actions', changes: [{
    id: 'c', type: 'modify', before: second, after: { ...second, action: 'Inspect the revised sensor' }, index: 1
  }] };
  assert.equal(findActionOccurrenceIndex([first], second), -1);
  assert.deepEqual(applyProposal([first], proposal, ['c']), [first]);
  assert.equal(rebaseMeetingAgentProposal(proposal, [first, second], [first], []), null);
});

test('R17 independent: indistinguishable historic duplicates are not guessed for destructive changes', () => {
  const first = action('A6');
  const proposal = { id: 'p', stage: 'actions', changes: [{
    id: 'c', type: 'remove', before: clone(first), after: null, index: 1
  }] };
  assert.equal(findActionOccurrenceIndex([first, clone(first)], clone(first)), -1);
  assert.deepEqual(applyProposal([first, clone(first)], proposal, ['c']), [first, first]);
});

test('R17 independent: modifications retain app occurrence even when AI supplies another identity', () => {
  const original = assignGeneratedActionIdentities([action('A6')], { generationKey: 'run' }).actions[0];
  const proposal = { id: 'p', stage: 'actions', changes: [{
    id: 'c', type: 'modify', before: clone(original),
    after: { ...original, id: 'A999', occurrenceId: 'invented-occurrence', action: 'Inspect the revised sensor' }, index: 0
  }] };
  const after = applyProposal([original], proposal, ['c']);
  assert.equal(after[0].id, original.id);
  assert.equal(after[0].occurrenceId, original.occurrenceId);
  assert.equal(after[0].action, 'Inspect the revised sensor');
});

test('R17 independent: partial acceptance rebases unchecked collision siblings without reticking', () => {
  const first = action('A6', 'Inspect the sensor', 'T100');
  const second = action('A6', 'Inspect the wiring', 'T200');
  const proposal = { id: 'p', stage: 'actions', changes: [
    { id: 'one', type: 'modify', before: first, after: { ...first, owners: ['Morgan'] }, index: 0, selected: true },
    { id: 'two', type: 'modify', before: second, after: { ...second, owners: ['Taylor'] }, index: 1, selected: true }
  ] };
  const after = applyProposal([second, first], proposal, ['one']);
  assert.deepEqual(after[0], second);
  assert.deepEqual(after[1].owners, ['Morgan']);
  const pending = rebaseMeetingAgentProposal(proposal, [first, second], after, ['one']);
  assert.equal(pending.changes.length, 1);
  assert.equal(pending.changes[0].id, 'two');
  assert.equal(pending.changes[0].beforeIndex, 0);
  assert.equal(pending.changes[0].selected, false);
  assert.deepEqual(applyProposal(after, pending, []), after);
});

test('R17 independent: exact checked state cannot leak to duplicate legacy sibling or removed row', () => {
  const rows = [
    { ...action('A6', 'Inspect the sensor', 'T100'), occurrenceId: 'occ-one' },
    { ...action('A6', 'Inspect the wiring', 'T200'), occurrenceId: 'occ-two' }
  ];
  assert.deepEqual(actionReviewCounts(rows, ['A6'], [], null, ['occ-two']), {
    inRegister: 2, kept: 1, undecided: 1, removed: 0, proposed: 0
  });
  assert.deepEqual(actionReviewCounts([rows[0]], ['A6'], [rows[1]], null, ['occ-two']), {
    inRegister: 1, kept: 0, undecided: 1, removed: 1, proposed: 0
  });
  assert.deepEqual(normaliseKeptActionOccurrenceIds(['occ-one'], [rows[0], { ...rows[1], occurrenceId: 'occ-one' }]), []);
});

test('R17 independent: removed exact occurrences preserve evidence, timing decisions and row distinction', () => {
  const rows = [
    { ...action('A6', 'Inspect the sensor', 'T100'), occurrenceId: 'occ-one', removedAt: '2026-10-22T12:00:00Z' },
    { ...action('A6', 'Inspect the sensor', 'T200'), occurrenceId: 'occ-two', removedAt: '2026-10-22T12:00:01Z' }
  ];
  const saved = normaliseRemovedActions(rows);
  assert.equal(saved.length, 2);
  for (let index = 0; index < rows.length; index += 1) {
    for (const key of ['id', 'occurrenceId', 'action', 'owners', 'timing', 'evidenceIds', 'reviewFlagIds', 'timingDecision', 'reviewerAuthored']) {
      assert.deepEqual(saved[index][key], rows[index][key], key);
    }
  }
});

test('R17 independent: route admission links proposals to allocated row occurrences without touching payload', () => {
  const rows = [action('A6', 'Inspect the sensor', 'T100'), action('A6', 'Inspect the wiring', 'T200')];
  const proposal = { id: 'p', stage: 'actions', changes: [
    { id: 'one', type: 'modify', before: rows[1], after: { ...rows[1], owners: ['Taylor'] }, index: 1 },
    { id: 'two', type: 'add', before: null, after: action('A6', 'Inspect the connector', 'T300'), index: 2 }
  ] };
  const input = { actions: rows, pendingProposal: proposal, executiveSummary: 'Leave this alone.' };
  const before = clone(input);
  const admitted = admitMeetingAgentGeneratedActionChanges({}, input, 'run');
  assert.deepEqual(input, before);
  assert.deepEqual(admitted.actions.map(contentOnly), rows.map(contentOnly));
  assert.equal(admitted.executiveSummary, input.executiveSummary);
  const modify = admitted.pendingProposal.changes[0];
  assert.equal(modify.before.occurrenceId, admitted.actions[1].occurrenceId);
  assert.equal(modify.after.occurrenceId, admitted.actions[1].occurrenceId);
  assert.deepEqual(contentOnly(modify.before), contentOnly(proposal.changes[0].before));
  assert.deepEqual(contentOnly(modify.after), contentOnly(proposal.changes[0].after));
  const all = admitted.actions.concat(admitted.pendingProposal.changes[1].after);
  assert.equal(new Set(all.map(row => row.id)).size, 3);
  assert.equal(new Set(all.map(row => row.occurrenceId)).size, 3);
});
