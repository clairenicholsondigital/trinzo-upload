'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { meetingAgentRegenerationChanges, meetingAgentActionsFingerprint } = require('../routes/api').stagedEvaluation;
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
