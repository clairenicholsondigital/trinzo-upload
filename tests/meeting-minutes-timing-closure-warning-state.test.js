'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../utils/meetingMinutesAgentV2');
const T = require('../utils/meetingMinutesTiming');
const { actionTimingIssueFlag, reconcileActionTimingWarnings } = require('../utils/meetingMinutesTimingFlags');
const options = { meetingDate: '2026-06-22' };
const units = [{ id: 'T0001', speaker: 'Morgan', text: 'I will review the inspection report this week.', classification: 'keep' }];
const action = (value = 'Review the inspection report.', wording = '') => ({ id: 'review', action: value, owners: ['Morgan'],
  timing: { kind: wording ? 'target' : 'not_stated', wording, exactDate: '' }, evidenceIds: ['T0001'], reviewFlagIds: [] });
const flag = (code, row, message = 'This timing needs review.') => V.normaliseFlag(actionTimingIssueFlag({ code }, row, message));
const supported = row => T.assessActionTiming(row, units, options).action;

test('automatic timing warnings retain their origin snapshot and distinct work identity through normalisation', () => {
  const first = flag('timing_inference_unresolved', action());
  const second = flag('timing_inference_unresolved', action('Send the inspection report.'));
  assert.notEqual(first.id, second.id, 'identical messages and evidence cannot merge different operations');
  assert.equal(first.systemTimingIssue.code, 'timing_inference_unresolved');
  assert.deepEqual(first.systemTimingIssue.origin, { id: 'review', action: 'Review the inspection report.', owners: ['Morgan'], timing: action().timing, evidenceIds: ['T0001'] });
  assert.deepEqual(V.normaliseFlag(first), first);
  assert.equal(V.normaliseFlag({ ...first, reviewerAuthored: true }).reviewerAuthored, true);
});

test('a resolved own source-supported timing retires only its untouched not-added warning and all stale links', () => {
  const old = flag('timing_inference_unresolved', action());
  const current = { ...supported(action(undefined, 'this week')), reviewFlagIds: [old.id] };
  assert.equal(current.timingDecision.binding.status, 'supported');
  const before = structuredClone({ current, old, units });
  const checked = reconcileActionTimingWarnings([current], [old], units, options);
  assert.equal(checked.retired.length, 1);
  assert.equal(checked.retired[0].reason, 'own_timing_now_source_supported');
  assert.deepEqual(checked.flags, []);
  assert.deepEqual(checked.actions[0].reviewFlagIds, []);
  assert.deepEqual({ current, old, units }, before);
  assert.deepEqual(V.reconcileRecordFlags({ actions: checked.actions }, checked.flags).flags, [], 'registry cannot resurrect an explicitly retired reference');
});

test('shared evidence, matching owner or a supported sibling do not prove the same work', () => {
  const old = flag('timing_inference_unresolved', action('Send the inspection report.'));
  const current = supported(action(undefined, 'this week'));
  assert.equal(reconcileActionTimingWarnings([current], [old], units, options).retired.length, 0);
  const wrongOwner = { ...current, owners: ['Casey'] };
  assert.equal(reconcileActionTimingWarnings([wrongOwner], [flag('timing_inference_unresolved', action())], units, options).retired.length, 0);
  const unresolved = { ...current, id: 'sibling', timingDecision: { ...current.timingDecision, status: 'unresolved', checkerStatus: 'missing' } };
  assert.equal(reconcileActionTimingWarnings([current, unresolved], [flag('timing_inference_unresolved', action())], units, options).retired.length, 0);
});

test('human decisions, notes, reviewer edits, changed warning text and live proposal references remain', () => {
  const old = flag('timing_inference_unresolved', action());
  const current = supported(action(undefined, 'this week'));
  for (const changed of [{ ...old, status: 'confirmed' }, { ...old, status: 'dismissed' }, { ...old, correctionNote: 'Check with the chair' },
    { ...old, reviewerAuthored: true }, { ...old, message: 'My own review note' }]) {
    assert.equal(reconcileActionTimingWarnings([current], [changed], units, options).retired.length, 0);
  }
  assert.equal(reconcileActionTimingWarnings([{ ...current, reviewerAuthored: true }], [old], units, options).retired.length, 0);
  assert.equal(reconcileActionTimingWarnings([current], [old], units, { ...options, proposals: [{ changes: [{ after: { reviewFlagIds: [old.id] } }] }] }).retired.length, 0);
});

test('ambiguous, unverified, missing-check and legacy orphan warnings are never inferred resolved', () => {
  const old = flag('timing_inference_unresolved', action());
  const current = supported(action(undefined, 'this week'));
  const checks = [
    { ...current, timingDecision: { ...current.timingDecision, status: 'unresolved', checkerStatus: 'missing' } },
    { ...current, timingDecision: { ...current.timingDecision, status: 'unresolved', checkerStatus: 'uncertain' } },
    { ...current, timingDecision: { ...current.timingDecision, status: 'rejected' } },
    { ...current, timingDecision: undefined }, action()
  ];
  for (const row of checks) assert.equal(reconcileActionTimingWarnings([row], [old], units, options).retired.length, 0);
  for (const code of ['timing_inference_ambiguous', 'timing_check_unresolved', 'source_timing_qualification']) {
    assert.equal(reconcileActionTimingWarnings([current], [flag(code, action())], units, options).retired.length, 0);
  }
  const legacy = { ...old }; delete legacy.systemTimingIssue;
  assert.equal(reconcileActionTimingWarnings([current], [legacy], units, options).retired.length, 0);
  assert.equal(reconcileActionTimingWarnings([current], [old], [], options).retired.length, 0, 'unavailable source cannot prove resolution');
});

test('retained-old-value warning retires only with explicit current rejection and linked live source removal notice', () => {
  const oldRow = action(undefined, 'tomorrow');
  const old = flag('timing_source_unresolved', oldRow, 'The timing was retained for source review.');
  const removal = flag('timing_value_removed', oldRow, 'The unsupported timing was removed; review the source.');
  const rejected = { ...T.rejectActionTiming(oldRow, units, { ...options, field: 'all', reason: 'source_step_mismatch' }), reviewFlagIds: [old.id, removal.id] };
  const checked = reconcileActionTimingWarnings([rejected], [old, removal], units, options);
  assert.deepEqual(checked.flags.map(row => row.id), [removal.id]);
  assert.deepEqual(checked.actions[0].reviewFlagIds, [removal.id]);
  assert.equal(checked.retired[0].reason, 'old_wording_removed_with_current_source_notice');
  for (const [row, flags] of [
    [rejected, [old]],
    [{ ...rejected, timingDecision: { ...rejected.timingDecision, rejectedWordings: [] } }, [old, removal]],
    [{ ...rejected, timing: oldRow.timing }, [old, removal]],
    [rejected, [old, { ...removal, status: 'dismissed' }]],
    [{ ...rejected, reviewFlagIds: [old.id] }, [old, removal]],
    [rejected, [old, { ...removal, systemTimingIssue: { ...removal.systemTimingIssue, origin: { ...removal.systemTimingIssue.origin, action: 'Send the inspection report.' } } }]]
  ]) assert.equal(reconcileActionTimingWarnings([row], flags, units, options).retired.length, 0);
});

test('actual normalisation inference warning receives provenance without manufacturing timing', () => {
  const source = [{ id: 'T0001', speaker: 'Morgan', text: 'I will review the inspection report.', classification: 'keep' },
    { id: 'T0002', speaker: 'Morgan', text: 'I will call the courier tomorrow.', classification: 'keep' }];
  const input = { ...action(), evidenceIds: ['T0001', 'T0002'] };
  const checked = V.normaliseAgentResult({ actions: [input] }, source, 'actions', options);
  assert.equal(checked.actions[0].timing.kind, 'not_stated');
  const generated = checked.reviewFlags.find(row => row.systemTimingIssue?.code === 'timing_inference_unresolved');
  assert.ok(generated);
  assert.equal(generated.systemTimingIssue.origin.action, input.action);
  assert.deepEqual(generated.systemTimingIssue.origin.owners, ['Morgan']);
  assert.ok(checked.actions[0].reviewFlagIds.includes(generated.id));
});

test('applied virtual and regeneration merges cannot resurrect a resolved persisted system warning', () => {
  const api = require('../routes/api').stagedEvaluation;
  const old = flag('timing_inference_unresolved', action());
  const current = supported(action(undefined, 'this week'));
  const draft = { draftId: 'warning-state', details: { meetingDate: options.meetingDate }, sourceUnits: units,
    actions: [], reviewFlags: [old], pendingProposal: null };
  const result = { changes: { actions: [current] }, reviewFlags: [] };
  const before = structuredClone({ draft, result });
  const virtual = api.applyStageResultVirtually(draft, 'actions', result);
  assert.deepEqual(virtual.reviewFlags, []);
  assert.deepEqual(virtual.actions[0].reviewFlagIds, []);
  const applied = api.meetingAgentRegenerationChanges(draft, 'actions', result.changes, result);
  assert.deepEqual(applied.reviewFlags, []);
  assert.deepEqual({ draft, result }, before, 'persistence reconciliation does not mutate prior state or the generated result');
});

test('generation merges preserve current live references, manual notes and unproved source states', () => {
  const api = require('../routes/api').stagedEvaluation;
  const old = flag('timing_inference_unresolved', action());
  const current = supported(action(undefined, 'this week'));
  const draft = { details: { meetingDate: options.meetingDate }, sourceUnits: units, actions: [], reviewFlags: [old] };
  for (const [row, previous] of [
    [{ ...current, reviewFlagIds: [old.id] }, old],
    [current, { ...old, correctionNote: 'Keep this source check visible' }],
    [current, { ...old, reviewerAuthored: true }],
    [{ ...current, timingDecision: { ...current.timingDecision, status: 'unresolved', checkerStatus: 'missing' } }, old]
  ]) {
    const result = api.applyStageResultVirtually({ ...draft, reviewFlags: [previous] }, 'actions', { changes: { actions: [row] }, reviewFlags: [] });
    assert.equal(result.reviewFlags.length, 1);
    assert.equal(result.reviewFlags[0].id, old.id);
  }
});

test('generation message deduplication cannot merge different work-specific timing warnings', () => {
  const api = require('../routes/api').stagedEvaluation;
  const first = flag('timing_check_unresolved', action());
  const second = flag('timing_check_unresolved', action('Send the inspection report.'));
  const result = api.meetingAgentRegenerationChanges({ actions: [], reviewFlags: [], sourceUnits: units }, 'summary', {}, { reviewFlags: [first, second] });
  assert.deepEqual(result.reviewFlags.map(row => row.id), [first.id, second.id]);
});


test('mixed reviewer siblings and other live content references protect a reused warning', () => {
  const api = require('../routes/api').stagedEvaluation;
  const old = flag('timing_inference_unresolved', action());
  const current = supported(action(undefined, 'this week'));
  const reviewer = { ...action(), id: 'reviewer-copy', reviewerAuthored: true, reviewFlagIds: [old.id] };
  const otherWork = { ...action('Send the inspection report.'), id: 'different-work', reviewFlagIds: [old.id] };
  for (const extra of [reviewer, otherWork]) {
    const result = reconcileActionTimingWarnings([current, extra], [old], units, options);
    assert.deepEqual(result.retired, []);
    assert.ok(result.actions[1].reviewFlagIds.includes(old.id));
  }
  const otherRecords = [{ id: 'discussion', text: 'This schedule needs review.', reviewFlagIds: [old.id] }];
  assert.deepEqual(reconcileActionTimingWarnings([current], [old], units, { ...options, otherRecords }).retired, []);
  const draft = { details: { meetingDate: options.meetingDate }, sourceUnits: units, actions: [], reviewFlags: [old], discussion: [{ points: otherRecords }] };
  const virtual = api.applyStageResultVirtually(draft, 'actions', { changes: { actions: [current] }, reviewFlags: [] });
  assert.equal(virtual.reviewFlags[0].id, old.id);
  const objective = { id: 'objective', text: 'Review the inspection.', reviewFlagIds: [old.id] };
  const withObjective = api.applyStageResultVirtually({ ...draft, discussion: [], meetingObjectives: [objective] }, 'actions', { changes: { actions: [current] }, reviewFlags: [] });
  assert.equal(withObjective.reviewFlags[0].id, old.id);
});
