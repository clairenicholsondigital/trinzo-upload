'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  meetingAgentRegenerationChanges,
  meetingAgentActionsFingerprint,
  meetingAgentDiscussionFingerprint,
  rebaseMeetingAgentProposal,
  resolveMeetingAgentProposalFlags,
  reconcileMeetingAgentOrphanFlags
} = require('../routes/api').stagedEvaluation;
const { normaliseAgentResult, reconcileRecordFlags } = require('../utils/meetingMinutesAgentV2');

const units = [
  { id: 'T0001', speaker: 'Alex Reed', text: 'I will send the revised report to the client.' },
  { id: 'T0002', speaker: 'Sam Lee', text: 'I will book the site visit for next month.' },
  { id: 'T0003', speaker: 'Alex Reed', text: 'I will update the risk file as well.' }
];
const generatedFirst = [
  { id: 'a1', action: 'Send the revised report to the client.', owners: ['Alex Reed'], timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds: ['T0001'], reviewFlagIds: ['flag-old'] },
  { id: 'a2', action: 'Book the site visit.', owners: ['Sam Lee'], timing: { kind: 'target', wording: 'next month', exactDate: '' }, evidenceIds: ['T0002'], reviewFlagIds: [] }
];
const fingerprintAsSaved = (actions) => meetingAgentActionsFingerprint(
  normaliseAgentResult({ actions }, units, '', { enforceEvidence: false }).actions);

function draftWith(actions, flags = []) {
  return {
    sourceUnits: units, actions, reviewFlags: flags, pendingProposal: null,
    qualityState: { actions: { generatedFingerprint: fingerprintAsSaved(generatedFirst) } }
  };
}
const regenerated = [
  { id: 'b1', action: 'Send the revised report to the client.', owners: ['Alex Reed'], timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds: ['T0001'], reviewFlagIds: ['flag-new'] },
  { id: 'b3', action: 'Update the risk file.', owners: ['Alex Reed'], timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds: ['T0003'], reviewFlagIds: [] }
];
const oldFlag = { id: 'flag-old', kind: 'timing', message: 'Old flag on a replaced action.', status: 'open', evidenceIds: [] };
const newFlag = { id: 'flag-new', kind: 'timing', message: 'New flag on the regenerated action.', status: 'open', evidenceIds: [] };

test('unedited Actions are replaced and flags of replaced rows go with them', () => {
  const fresh = draftWith(generatedFirst, [oldFlag]);
  const out = meetingAgentRegenerationChanges(fresh, 'actions', { actions: regenerated, pendingProposal: null, qualityState: { actions: {} } }, { reviewFlags: [newFlag] });
  assert.equal(out.keptReviewerActions, false);
  assert.deepEqual(out.changes.actions.map((a) => a.id), ['b1', 'b3']);
  assert.deepEqual(out.reviewFlags.map((f) => f.id), ['flag-new']);
  assert.ok(out.changes.qualityState.actions.generatedFingerprint);
});

test('edited Actions are kept and the regeneration becomes proposed changes', () => {
  const edited = [{ ...generatedFirst[0], owners: ['Kevin'] }, generatedFirst[1]];
  const fresh = draftWith(edited, [oldFlag]);
  const stageProposal = { id: 'p', stage: 'actions', changes: [{ id: 'change-x', type: 'add', after: { id: 'P1', action: 'Chase the lab results.', owners: [], evidenceIds: ['T0002'] }, beforeIndex: 1, index: 1 }] };
  const out = meetingAgentRegenerationChanges(fresh, 'actions', { actions: regenerated, pendingProposal: stageProposal, qualityState: { actions: {} } }, { reviewFlags: [newFlag] });
  assert.equal(out.keptReviewerActions, true);
  assert.ok(!('actions' in out.changes));
  assert.equal(out.changes.pendingProposal.source, 'regeneration');
  const types = out.changes.pendingProposal.changes.map((c) => c.type);
  assert.ok(types.includes('add'));
  assert.ok(out.changes.pendingProposal.changes.some((c) => c.after && c.after.action === 'Chase the lab results.' && c.beforeIndex === 2));
  // The kept rows' flag stays; the unapplied rows' flag is not added.
  assert.deepEqual(out.reviewFlags.map((f) => f.id), ['flag-old']);
});

test('drafts without a generation fingerprint keep the old replace behaviour', () => {
  const fresh = { ...draftWith(generatedFirst), qualityState: {} };
  const out = meetingAgentRegenerationChanges(fresh, 'actions', { actions: regenerated, qualityState: { actions: {} } }, { reviewFlags: [] });
  assert.equal(out.keptReviewerActions, false);
  assert.deepEqual(out.changes.actions.map((a) => a.id), ['b1', 'b3']);
});

test('edited Discussion is kept and regenerated topics become suggestions', () => {
  const generated = [{ id: 't1', topic: 'Training', points: [{ id: 'p1', text: 'Training is required.', evidenceIds: ['T0001'] }], decisions: [], openQuestions: [] }];
  const edited = [{ ...generated[0], points: [{ ...generated[0].points[0], text: 'Training and signed attestation are required.' }] }];
  const refreshed = [{ ...generated[0], points: [{ ...generated[0].points[0], text: 'Training must be complete by Friday.' }] }];
  const fresh = {
    discussion: edited, reviewFlags: [], qualityState: { discussion: { generatedFingerprint: meetingAgentDiscussionFingerprint(generated) } }
  };
  const out = meetingAgentRegenerationChanges(fresh, 'discussion', {
    discussion: refreshed, qualityState: { discussion: {} }
  }, { reviewFlags: [] });
  assert.ok(!('discussion' in out.changes));
  assert.equal(out.changes.pendingProposal.stage, 'discussion');
  assert.ok(out.changes.pendingProposal.changes.length > 0);
  assert.ok(out.changes.qualityState.discussion.generatedFingerprint);
});

test('applying selected suggestions leaves unchecked suggestions and warnings unresolved', () => {
  const before = [{ id: 'a1', action: 'First.' }, { id: 'a2', action: 'Second.' }];
  const proposal = { stage: 'actions', changes: [
    { id: 'c1', type: 'add', before: null, after: { id: 'new', action: 'Inserted.' }, beforeIndex: 1, index: 1 },
    { id: 'c2', type: 'modify', before: before[1], after: { id: 'a2', action: 'Second revised.' }, beforeIndex: 1, index: 1 }
  ] };
  const current = [before[0], proposal.changes[0].after, before[1]];
  const remaining = rebaseMeetingAgentProposal(proposal, before, current, ['c1']);
  assert.deepEqual(remaining.changes.map((change) => change.id), ['c2']);
  assert.equal(remaining.changes[0].beforeIndex, 2);
  assert.equal(remaining.changes[0].selected, false, 'the unchecked choice persists with the remaining proposal');
  const flags = [
    { id: 'proposal-review-c1', kind: 'possible_missed_follow_up', status: 'open' },
    { id: 'proposal-review-c2', kind: 'possible_missed_follow_up', status: 'open' }
  ];
  const resolved = resolveMeetingAgentProposalFlags(flags, proposal, ['c1'], []);
  assert.equal(resolved[0].status, 'confirmed');
  assert.equal(resolved[1].status, 'open');
});

test('warning cleanup survives persistence while genuine missing-content issues stay open', () => {
  const removed = { id: 'removed', action: 'Sign the training attestation.', owners: ['Sam'], timing: { kind: 'deadline', wording: 'Friday' }, evidenceIds: ['T0002'], reviewFlagIds: ['flag-removed'] };
  const surviving = { id: 'kept', action: 'Send the report.', owners: ['Alex'], timing: { kind: 'not_stated' }, evidenceIds: ['T0001'], reviewFlagIds: ['flag-shared'] };
  const proposal = { stage: 'actions', changes: [{
    id: 'change-pending', type: 'add', before: null,
    after: { id: 'proposed', action: 'Confirm folder access.', evidenceIds: ['T0003'] }
  }] };
  const flags = [
    { id: 'flag-removed', kind: 'timing', message: 'Confirm timing for the training attestation.', evidenceIds: ['T0002'], status: 'open' },
    { id: 'flag-shared', kind: 'ownership', message: 'Check the report owner.', evidenceIds: ['T0001'], status: 'open' },
    { id: 'proposal-review-change-pending', kind: 'possible_missed_follow_up', message: 'Possible missed action: Confirm folder access.', evidenceIds: ['T0003'], status: 'open' },
    { id: 'proposal-review-gone', kind: 'possible_missed_follow_up', message: 'Possible missed action which is no longer proposed.', evidenceIds: ['T0002'], status: 'open' },
    { id: 'genuine-gap', kind: 'possible_missed_follow_up', message: 'The transcript contains an unresolved request with no owner.', evidenceIds: ['T0002'], status: 'open' }
  ];
  const reconciled = reconcileMeetingAgentOrphanFlags(flags, [surviving], proposal, [removed, surviving]);
  const status = Object.fromEntries(reconciled.map((flag) => [flag.id, flag.status]));
  assert.equal(status['flag-removed'], 'dismissed', 'the warning whose only saved target was deleted closes');
  assert.equal(status['flag-shared'], 'open', 'a warning still linked to saved content stays open');
  assert.equal(status['proposal-review-change-pending'], 'open', 'a warning linked to an unchecked suggestion stays open');
  assert.equal(status['proposal-review-gone'], 'dismissed', 'a warning for a vanished suggestion closes');
  assert.equal(status['genuine-gap'], 'open', 'a genuine missing-content issue stays actionable');

  const afterRefresh = reconcileMeetingAgentOrphanFlags(reconciled, [surviving], proposal);
  assert.deepEqual(afterRefresh.map((flag) => flag.status), reconciled.map((flag) => flag.status));
});

test('legacy unlinked field warnings are retained only when a current item is a clear match', () => {
  const action = {
    id: 'training', action: 'Complete and sign the training attestation.', owners: ['Sam Okoro'],
    timing: { kind: 'deadline', wording: 'by Friday', exactDate: '' }, evidenceIds: ['T0002'], reviewFlagIds: []
  };
  const matched = { id: 'legacy-timing', kind: 'timing', message: 'Confirm the Action timing “by Friday”.', evidenceIds: ['T0002'], status: 'open' };
  const orphan = { id: 'legacy-orphan', kind: 'missing_evidence', message: 'Check a sentence that was removed.', evidenceIds: ['T0099'], status: 'open' };
  const out = reconcileMeetingAgentOrphanFlags([matched, orphan], [action], null);
  assert.equal(out[0].status, 'open');
  assert.equal(out[1].status, 'dismissed');
});

test('identical open flags are shown once; handled flags are kept', () => {
  const fresh = draftWith(generatedFirst, [
    { id: 'f1', kind: 'timing', message: 'Same message.', status: 'open' },
    { id: 'f3', kind: 'timing', message: 'Same message.', status: 'dismissed' }
  ]);
  const out = meetingAgentRegenerationChanges(fresh, 'summary', {}, { reviewFlags: [{ id: 'f2', kind: 'timing', message: 'Same message.', status: 'open' }] });
  assert.deepEqual(out.reviewFlags.map((f) => f.id).sort(), ['f1', 'f3']);
});

test('flags created mid-pipeline are recovered and dead references dropped', () => {
  const made = normaliseAgentResult({ discussion: [{ topic: 'T', points: [{ text: 'A claim nobody made about Mars.', evidenceIds: [] }] }] }, units, 'discussion', {});
  const row = made.discussion[0].points[0];
  assert.ok(row.reviewFlagIds.length);
  const content = { discussion: [{ topic: 'T', points: [{ ...row, reviewFlagIds: [...row.reviewFlagIds, 'flag-gone'] }] }] };
  const out = reconcileRecordFlags(content, [], () => true);
  assert.deepEqual(out.content.discussion[0].points[0].reviewFlagIds, row.reviewFlagIds);
  assert.deepEqual(out.flags.map((f) => f.id), row.reviewFlagIds);
});

test('regeneration never proposes an edit that changes nothing a reviewer sees', () => {
  const edited = [{ ...generatedFirst[0], owners: ['Kevin'] }, generatedFirst[1]];
  const fresh = draftWith(edited, []);
  const sameWording = [
    { ...generatedFirst[0], id: 'z1', owners: ['Kevin'], evidenceIds: ['T0001', 'T0003'], reviewFlagIds: [] },
    { ...generatedFirst[1], id: 'z2', reviewFlagIds: [] }
  ];
  const out = meetingAgentRegenerationChanges(fresh, 'actions', { actions: sameWording, pendingProposal: null, qualityState: { actions: {} } }, { reviewFlags: [] });
  assert.equal(out.keptReviewerActions, true);
  assert.equal(out.changes.pendingProposal, null);
});

test('regeneration never proposes undoing the reviewer: no re-adds, no edits of their rows', () => {
  const generatedTexts = generatedFirst.map((a) => a.action);
  const current = [{ ...generatedFirst[0], action: 'Send the revised report to the client by Friday (reviewer wording).' }];
  const fresh = { ...draftWith(current), qualityState: { actions: { generatedFingerprint: fingerprintAsSaved(generatedFirst), generatedTexts } } };
  const out = meetingAgentRegenerationChanges(fresh, 'actions', { actions: [...generatedFirst], pendingProposal: null, qualityState: { actions: {} } }, { reviewFlags: [] });
  assert.equal(out.keptReviewerActions, true);
  const changes = (out.changes.pendingProposal && out.changes.pendingProposal.changes) || [];
  assert.ok(!changes.some((c) => c.type === 'add' && /Book the site visit/.test(c.after.action)), 'deleted row re-added');
  assert.ok(!changes.some((c) => c.type === 'modify'), 'edited row changed back');
  assert.deepEqual(out.changes.qualityState.actions.generatedTexts, generatedFirst.map((a) => a.action));
});
