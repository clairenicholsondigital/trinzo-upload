'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
process.env.MEETING_MINUTES_AGENT_SPECULATIVE_PIPELINE_V1 = '0';
const V = require('../utils/meetingMinutesAgentV2');
const review = require('../utils/actionReviewState');
const { markMeetingAgentReviewerEdits } = require('../utils/meetingMinutesReviewerEdits');
const copy = value => JSON.parse(JSON.stringify(value));
const db = require('../utils/db');
const originalGet = db.getMeetingMinutesAgentDraft;
const originalUpdate = db.updateMeetingMinutesAgentDraft;
let saved;
db.getMeetingMinutesAgentDraft = async () => copy(saved);
db.updateMeetingMinutesAgentDraft = async (id, userId, revision, update) => {
  assert.equal(id, saved.draftId);
  assert.equal(userId, 'identity-reviewer');
  assert.equal(revision, saved.revision);
  saved = { ...saved, ...V.migrateDraftPayload(copy(update.payload)),
    revision: revision + 1, status: update.status || saved.status };
  return copy(saved);
};
const router = require('../routes/api');
const api = router.stagedEvaluation;
db.getMeetingMinutesAgentDraft = originalGet;
db.updateMeetingMinutesAgentDraft = originalUpdate;
function row(action, occurrenceId, evidence = 'T0001') {
  return { id: 'A4', ...(occurrenceId ? { occurrenceId } : {}), action, owners: ['Morgan Taylor'],
    timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds: [evidence], reviewFlagIds: [] };
}
function reset() {
  saved = { draftId: 'identity-test', revision: 1, status: 'draft', payloadVersion: V.PAYLOAD_VERSION,
    details: { meetingTitle: 'Premises review', meetingType: 'General', meetingDate: '2026-10-22' },
    sourceUnits: [{ id: 'T0001', speaker: 'Morgan Taylor', text: 'I will check the roof.' },
      { id: 'T0002', speaker: 'Morgan Taylor', text: 'I will order replacement tiles.' }],
    actions: [row('Check the roof.'), row('Order replacement tiles.', '', 'T0002')],
    discussion: [], executiveSummary: '', meetingObjectives: [], reviewFlags: [],
    changeHistory: [], redoHistory: [], staleStages: [], keptActionIds: ['A4'],
    currentStep: 5, selectedStep: 5, qualityState: {} };
}
async function request(method, suffix = '', body = {}) {
  const route = router.stack.find(layer => layer.route?.path === '/meeting-minutes-agent/drafts/:draftId' + suffix
    && layer.route.methods[method])?.route;
  assert.ok(route, method + suffix);
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; } };
  await route.stack.at(-1).handle({ params: { draftId: saved.draftId }, authUser: { userId: 'identity-reviewer' },
    body: { revision: saved.revision, ...body } }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return res.body.draft;
}

test('legacy shared checked IDs remain history, not approval of either row', () => {
  const rows = [row('Check the roof.', 'roof'), row('Order tiles.', 'tiles')];
  assert.deepEqual(review.normaliseKeptActionIds(['A4'], rows), ['A4']);
  assert.equal(review.actionReviewCounts(rows, ['A4']).kept, 0);
  assert.equal(review.actionReviewCounts(rows, ['A4'], [], null, ['tiles']).kept, 1);
  assert.equal(review.actionReviewCounts(rows, ['A4'], [], null, ['roof', 'tiles']).kept, 2);
  assert.equal(review.actionReviewCounts([rows[0]], ['A4'], [rows[1]]).kept, 0,
    'a removed sibling cannot turn an ambiguous historic approval into a certain one');
  assert.deepEqual(review.normaliseKeptActionOccurrenceIds(['tiles', 'tiles', 'missing'], rows), ['tiles']);
});

test('identical removed wording with distinct occurrences preserves both rows and review metadata', () => {
  const first = { ...row('Check the roof.', 'roof'), reviewerAuthored: true, reviewFlagIds: ['review-roof'],
    timing: { kind: 'not_stated', wording: '', exactDate: '', rejectedWordings: ['Friday'] },
    timingDecision: { actionKey: 'source-proof', verdict: 'uncertain', evidenceIds: ['T0001'] } };
  const second = { ...copy(first), occurrenceId: 'roof-2', evidenceIds: ['T0002'] };
  const removed = review.normaliseRemovedActions([first, second, first]);
  assert.equal(removed.length, 2);
  assert.deepEqual(removed[0].timingDecision, first.timingDecision);
  assert.deepEqual(removed[0].timing.rejectedWordings, ['Friday']);
  assert.deepEqual(removed[0].reviewFlagIds, ['review-roof']);
  assert.equal(removed[0].reviewerAuthored, true);
});

test('legacy removed rows with different provenance cannot collapse before the editor assigns occurrences', () => {
  const first = { ...row('Check the roof.'), reviewFlagIds: ['roof-check'] };
  const second = { ...row('Check the roof.', '', 'T0002'), reviewFlagIds: ['second-check'] };
  const removed = review.normaliseRemovedActions([first, second, first]);
  assert.equal(removed.length, 2);
  assert.deepEqual(removed.map(item => item.evidenceIds), [['T0001'], ['T0002']]);
  assert.equal(review.normaliseRemovedActions([first, second].map(item => ({ ...item, occurrenceId: 'shared' }))).length, 2,
    'a malformed duplicate occurrence must retain distinct rows for safe identity repair');
});

test('an ambiguous old checked token cannot become valid for its surviving removed sibling', () => {
  const active = row('Check the roof.', 'shared');
  const removed = row('Order tiles.', 'shared', 'T0002');
  const admitted = api.admitMeetingAgentGeneratedActionChanges({
    actions: [active], removedActions: [removed], keptActionOccurrenceIds: ['shared']
  }, { actions: [copy(active)] }, 'duplicate-token');
  assert.deepEqual(admitted.keptActionOccurrenceIds, []);
  assert.deepEqual(review.normaliseKeptActionOccurrenceIds(['shared'], [{ ...removed }], [active, removed]), []);
});

test('duplicated occurrence tokens never acquire a destructive proposal target or transfer a checked mark', async () => {
  reset();
  saved.actions.forEach(item => { item.occurrenceId = 'shared'; });
  saved.keptActionOccurrenceIds = ['shared'];
  const before = copy(saved.actions);
  saved.pendingProposal = { stage: 'actions', changes: [
    { id: 'remove-second', type: 'remove', before: copy(saved.actions[1]), beforeIndex: 1 }
  ] };
  await request('post', '/proposal', { decision: 'accept', changeIds: ['remove-second'] });
  assert.deepEqual(saved.actions, before);
  assert.deepEqual(saved.keptActionOccurrenceIds, []);
});

test('ordinary historical GET and PATCH preserve IDs without silently allocating occurrences', async () => {
  reset();
  const ids = saved.actions.map(item => item.id);
  const loaded = await request('get');
  assert.ok(loaded.actions.every(item => !item.occurrenceId));
  await request('patch', '', { actions: loaded.actions });
  assert.deepEqual(saved.actions.map(item => item.id), ids);
  assert.ok(saved.actions.every(item => !item.occurrenceId));
  assert.deepEqual(saved.keptActionIds, ['A4']);
});

test('explicit occurrence edits and checked state survive real JSON persistence, reload, undo and redo', async () => {
  reset();
  const loaded = await request('get');
  const first = { ...loaded.actions[0], occurrenceId: 'roof' };
  const second = { ...loaded.actions[1], occurrenceId: 'tiles', owners: ['Alex Reed'] };
  const edited = await request('patch', '', { actions: [first, second],
    keptActionOccurrenceIds: ['tiles'], reviewDecisionLabel: 'Review tile owner' });
  assert.deepEqual(edited.actions.map(item => item.id), ['A4', 'A4']);
  assert.deepEqual(edited.keptActionOccurrenceIds, ['tiles']);
  assert.deepEqual(edited.actions[0].owners, ['Morgan Taylor']);
  assert.deepEqual(edited.actions[1].owners, ['Alex Reed']);
  assert.notEqual(saved.actions[0].reviewerAuthored, true);
  assert.equal(saved.actions[1].reviewerAuthored, true);
  const reloaded = await request('get');
  assert.deepEqual(reloaded.keptActionOccurrenceIds, ['tiles']);
  assert.deepEqual(reloaded.actions.map(item => item.occurrenceId), ['roof', 'tiles']);
  const undone = await request('post', '/undo');
  assert.deepEqual(undone.actions.map(item => item.id), ['A4', 'A4']);
  assert.deepEqual(undone.actions[1].owners, ['Morgan Taylor']);
  assert.ok(undone.actions.every(item => !item.occurrenceId));
  const redone = await request('post', '/redo');
  assert.deepEqual(redone.keptActionOccurrenceIds, ['tiles']);
  assert.deepEqual(redone.actions[1].owners, ['Alex Reed']);
  assert.deepEqual(redone.actions.map(item => item.occurrenceId), ['roof', 'tiles']);
});

test('opaque occurrence tokens survive real publication and saved checked references byte for byte', async () => {
  reset();
  saved.actions[0].occurrenceId = 'meds-app';
  saved.actions[1].occurrenceId = 'GBP40';
  saved.keptActionOccurrenceIds = ['meds-app', 'GBP40'];
  const loaded = await request('get');
  assert.deepEqual(loaded.actions.map(item => item.occurrenceId), ['meds-app', 'GBP40']);
  await request('patch', '', { actions: loaded.actions, keptActionOccurrenceIds: loaded.keptActionOccurrenceIds });
  assert.deepEqual(saved.actions.map(item => item.occurrenceId), ['meds-app', 'GBP40']);
  assert.deepEqual(saved.keptActionOccurrenceIds, ['meds-app', 'GBP40']);
});

test('save-time authorship follows occurrence after colliding rows reorder', () => {
  const roof = { ...row('Check the roof.', 'roof'), reviewerAuthored: true };
  const tiles = row('Order tiles.', 'tiles', 'T0002');
  const result = markMeetingAgentReviewerEdits({ actions: [roof, tiles] }, { actions: [
    { ...tiles, owners: ['Alex Reed'] }, roof
  ] }).actions;
  assert.deepEqual(result.map(item => item.occurrenceId), ['tiles', 'roof']);
  assert.equal(result[0].reviewerAuthored, true);
  assert.equal(result[1].reviewerAuthored, true);
  assert.deepEqual(result[1].evidenceIds, ['T0001']);
});

test('new-output admission changes identity only and updates proposal occurrences individually', () => {
  const before = [row('Check the roof.'), row('Order replacement tiles.', '', 'T0002')];
  const proposal = { id: 'p', stage: 'actions', changes: [
    { id: 'modify-tiles', type: 'modify', before: before[1], after: { ...before[1], action: 'Order spare tiles.' }, beforeIndex: 1 },
    { id: 'add-key', type: 'add', after: row('Collect the key.'), beforeIndex: 2 }
  ] };
  const input = { actions: copy(before), pendingProposal: copy(proposal) };
  const original = copy(input);
  const admitted = api.admitMeetingAgentGeneratedActionChanges({ actions: [], removedActions: [] }, input, 'generation-test');
  assert.deepEqual(input, original, 'admission must not mutate frozen inputs');
  assert.equal(new Set(admitted.actions.map(item => item.id)).size, 2);
  assert.equal(new Set(admitted.actions.map(item => item.occurrenceId)).size, 2);
  const strip = item => { const { id, occurrenceId, ...rest } = item; return rest; };
  assert.deepEqual(admitted.actions.map(strip), before.map(strip));
  const changed = admitted.pendingProposal.changes[0];
  assert.equal(changed.before.occurrenceId, admitted.actions[1].occurrenceId);
  assert.equal(changed.after.occurrenceId, admitted.actions[1].occurrenceId);
  assert.equal(changed.after.id, admitted.actions[1].id);
  assert.notEqual(admitted.pendingProposal.changes[1].after.id, admitted.actions[0].id);
  assert.equal(admitted.pendingProposal.changes[1].id, 'add-key', 'warning/change link stays unchanged');
});

test('partial proposal rebase follows exact occurrence across reorder and refuses a removed sibling', () => {
  const roof = row('Check the roof.', 'roof');
  const tiles = row('Order tiles.', 'tiles', 'T0002');
  const proposal = { id: 'p', stage: 'actions', changes: [
    { id: 'roof-change', type: 'modify', before: roof, after: { ...roof, action: 'Inspect the roof.' }, beforeIndex: 0 },
    { id: 'tiles-change', type: 'modify', before: tiles, after: { ...tiles, action: 'Order spare tiles.' }, beforeIndex: 1 }
  ] };
  const remaining = api.rebaseMeetingAgentProposal(proposal, [roof, tiles], [tiles, roof], ['roof-change']);
  assert.equal(remaining.changes[0].beforeIndex, 0);
  assert.equal(remaining.changes[0].selected, false);
  const applied = V.applyProposal([tiles, roof], remaining, ['tiles-change']);
  assert.equal(applied[0].action, 'Order spare tiles.');
  assert.equal(applied[0].occurrenceId, 'tiles');
  assert.deepEqual(applied[1], roof);
  assert.equal(api.rebaseMeetingAgentProposal(proposal, [roof, tiles], [roof], ['roof-change']), null);
});
