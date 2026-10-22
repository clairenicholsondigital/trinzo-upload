'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const db = require('../utils/db');
const clone = value => JSON.parse(JSON.stringify(value));
let saved;
let writes = 0;
let providerCalls = 0;

// Exercise real handlers and publication with only storage substituted.
const originalGet = db.getMeetingMinutesAgentDraft;
const originalUpdate = db.updateMeetingMinutesAgentDraft;
db.getMeetingMinutesAgentDraft = async () => clone(saved);
db.updateMeetingMinutesAgentDraft = async (id, userId, revision, updates) => {
  assert.equal(id, saved.draftId);
  assert.equal(userId, 'detail-reviewer');
  assert.equal(revision, saved.revision);
  saved = clone({ ...saved, ...updates.payload, title: updates.title,
    status: updates.status, revision: revision + 1 });
  writes += 1;
  return clone(saved);
};
for (const name of ['query', 'queryOne', 'execute']) {
  if (typeof db[name] === 'function') db[name] = () => { throw new Error('Live database access forbidden'); };
}
const noProvider = async () => { providerCalls += 1; throw new Error('Provider access forbidden'); };
global.fetch = noProvider;
const fetchPath = require.resolve('node-fetch');
require(fetchPath);
const originalFetch = require.cache[fetchPath].exports;
require.cache[fetchPath].exports = noProvider;
const router = require('../routes/api');
const V = require('../utils/meetingMinutesAgentV2');
const { generateMeetingMinutesAgentDocx } = require('../utils/meetingMinutesAgentDocx');
db.getMeetingMinutesAgentDraft = originalGet;
db.updateMeetingMinutesAgentDraft = originalUpdate;
require.cache[fetchPath].exports = originalFetch;

function fixture() {
  const action = { id: 'order', occurrenceId: 'occ-order',
    action: 'Order 12 replacement cartridges.', owners: ['Morgan Reed', 'Alex Lane'],
    timing: { kind: 'deadline', wording: 'by Friday', exactDate: '2026-10-23' },
    evidenceIds: ['T0001'], reviewFlagIds: [] };
  return { draftId: 'detail-protection', revision: 1, status: 'draft',
    payloadVersion: V.PAYLOAD_VERSION, currentStep: 5,
    details: { meetingTitle: 'Equipment planning', meetingType: 'General', meetingDate: '2026-10-22' },
    sourceUnits: V.normaliseSourceUnits([{ id: 'T0001', speaker: 'Morgan Reed',
      text: 'Alex Lane and I will order 12 replacement cartridges by Friday.' }]),
    discussion: [], actions: [action], executiveSummary: 'Replacement cartridges are needed.',
    reviewFlags: [{ id: 'unrelated', kind: 'ownership', status: 'open',
      message: 'Confirm who will review the supplier agreement.', evidenceIds: ['T0001'] }],
    changeHistory: [], redoHistory: [], staleStages: [] };
}
function pending(after, source = 'requested') {
  const before = clone(saved.actions[0]);
  saved.pendingProposal = { id: 'saved-proposal', source, stage: 'actions', changes: [
    { id: 'edit', type: 'modify', before, after: clone(after), selected: true, beforeIndex: 0, index: 0 }
  ] };
}
async function request(method, endpoint, body = {}) {
  const path = '/meeting-minutes-agent/drafts/:draftId' + (endpoint ? '/' + endpoint : '');
  const route = router.stack.find(layer => layer.route?.path === path && layer.route.methods[method])?.route;
  assert.ok(route, 'missing real handler: ' + method + ' ' + path);
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; } };
  await route.stack.at(-1).handle({ params: { draftId: saved.draftId },
    authUser: { userId: 'detail-reviewer' }, body: { revision: saved.revision, ...body } }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return res.body;
}
const visible = rows => rows.map(({ action, owners, timing, occurrenceId }) => ({ action, owners, timing, occurrenceId }));
const edits = [
  ['quantity removed', row => ({ ...row, action: 'Order replacement cartridges.' })],
  ['quantity changed', row => ({ ...row, action: 'Order 10 replacement cartridges.' })],
  ['joint owner removed', row => ({ ...row, owners: ['Morgan Reed'] })],
  ['timing removed', row => ({ ...row, timing: { kind: 'not_stated', wording: '', exactDate: '' } })],
  ['date removed', row => ({ ...row, timing: { ...row.timing, exactDate: '' } })],
  ['wrong replacement date', row => ({ ...row, timing: { ...row.timing, exactDate: '2026-10-30' } })]
];

for (const [name, edit] of edits) {
  test('saved automatic ' + name + ' edit preserves content and an open check through save/reload/undo/redo', async () => {
    saved = fixture();
    const original = clone(saved);
    pending(edit(clone(saved.actions[0])));
    const response = await request('post', 'proposal', { decision: 'accept', automatic: true, acceptAll: true });
    assert.deepEqual(visible(saved.actions), visible(original.actions));
    assert.deepEqual(visible(response.draft.actions), visible(original.actions));
    assert.deepEqual(saved.sourceUnits, original.sourceUnits);
    assert.deepEqual(saved.staleStages, []);
    assert.equal(saved.pendingProposal, null);
    assert.deepEqual(saved.changeHistory.at(-1).acceptedChangeIds, []);
    const flag = saved.reviewFlags.find(row => row.id === 'automatic-review-edit');
    assert.equal(flag?.status, 'open');
    assert.deepEqual(flag.evidenceIds, ['T0001']);
    assert.equal(saved.reviewFlags.find(row => row.id === 'unrelated')?.status, 'open');
    let loaded = (await request('get', '')).draft;
    assert.deepEqual(visible(loaded.actions), visible(original.actions));
    assert.equal(loaded.reviewFlags.find(row => row.id === flag.id)?.status, 'open');
    await request('post', 'undo');
    assert.deepEqual(visible(saved.actions), visible(original.actions));
    assert.equal(saved.pendingProposal, null, 'undo must not requeue the consumed automatic suggestion');
    await request('post', 'redo');
    loaded = (await request('get', '')).draft;
    assert.deepEqual(visible(loaded.actions), visible(original.actions));
    assert.equal(loaded.reviewFlags.find(row => row.id === flag.id)?.status, 'open');
    assert.equal(loaded.pendingProposal, null);
    if (name === 'quantity removed') {
      const xml = await (await JSZip.loadAsync(await generateMeetingMinutesAgentDocx(
        router.stagedEvaluation.meetingAgentDraftForDocx(saved), false))).file('word/document.xml').async('string');
      assert.match(xml, /Order 12 replacement cartridges/);
    }
    assert.equal(providerCalls, 0);
  });
}

test('fresh numerical edits start unticked while equivalent quantities remain selectable', () => {
  saved = fixture();
  const before = clone(saved.actions[0]);
  for (const wording of ['Order replacement cartridges.', 'Order 10 replacement cartridges.']) {
    pending({ ...before, action: wording }, 'generated');
    const input = clone(saved.pendingProposal);
    const selected = router.stagedEvaluation.preselectActionProposal(input, saved.actions, saved.sourceUnits);
    assert.equal(selected.changes[0].selected, false);
    assert.equal(selected.changes[0].reviewContext.label, 'edit loses detail');
    assert.deepEqual(input, saved.pendingProposal, 'preselection must not mutate the proposed edit');
  }
  pending({ ...before, action: 'Purchase twelve replacement cartridges.' }, 'generated');
  assert.equal(router.stagedEvaluation.preselectActionProposal(saved.pendingProposal,
    saved.actions, saved.sourceUnits).changes[0].selected, true);
});

test('a quantity-losing edit cannot consume the occurrence before a safe competing rewrite', async () => {
  for (const reverse of [false, true]) {
    saved = fixture();
    const before = clone(saved.actions[0]);
    pending({ ...before, action: 'Order replacement cartridges.' });
    const unsafe = { ...saved.pendingProposal.changes[0], id: 'unsafe' };
    const safe = { ...clone(unsafe), id: 'safe', after: { ...before, action: 'Purchase 12 replacement cartridges.' } };
    saved.pendingProposal.changes = reverse ? [safe, unsafe] : [unsafe, safe];
    await request('post', 'proposal', { decision: 'accept', automatic: true });
    assert.equal(saved.actions.length, 1);
    assert.equal(saved.actions[0].action, safe.after.action);
    assert.deepEqual(saved.changeHistory.at(-1).acceptedChangeIds, ['safe']);
    assert.equal(saved.reviewFlags.find(flag => flag.id === 'automatic-review-unsafe')?.status, 'open');
  }
  assert.equal(providerCalls, 0);
});

test('a harmless automatic rewrite retains numerical details and applies once through the real handler', async () => {
  saved = fixture();
  const before = clone(saved.actions[0]);
  pending({ ...before, action: 'Purchase 12 replacement cartridges.' });
  await request('post', 'proposal', { decision: 'accept', automatic: true });
  assert.equal(saved.actions[0].action, 'Purchase 12 replacement cartridges.');
  assert.deepEqual(saved.actions[0].owners, before.owners);
  assert.deepEqual(saved.actions[0].timing, before.timing);
  assert.equal(saved.actions[0].occurrenceId, before.occurrenceId);
  assert.deepEqual(saved.changeHistory.at(-1).acceptedChangeIds, ['edit']);
  assert.deepEqual(saved.staleStages, ['summary']);
  await request('post', 'undo');
  assert.deepEqual(visible(saved.actions), visible([before]));
  await request('post', 'redo');
  assert.equal(saved.actions[0].action, 'Purchase 12 replacement cartridges.');
  assert.equal(providerCalls, 0);
});

for (const selection of [{ changeIds: ['edit'] }, { acceptAll: true }]) {
  test('explicit manual acceptance remains literal with ' + Object.keys(selection)[0], async () => {
    saved = fixture();
    const after = { ...clone(saved.actions[0]), action: 'Order replacement cartridges.', owners: ['Morgan Reed'] };
    pending(after);
    await request('post', 'proposal', { decision: 'accept', ...selection });
    assert.deepEqual(visible(saved.actions), visible([after]));
    assert.deepEqual(saved.changeHistory.at(-1).acceptedChangeIds, ['edit']);
    assert.equal(saved.pendingProposal, null);
    await request('post', 'undo');
    assert.equal(saved.actions[0].action, 'Order 12 replacement cartridges.');
    await request('post', 'redo');
    assert.deepEqual(visible(saved.actions), visible([after]));
    assert.equal(providerCalls, 0);
  });
}

test('offline handler coverage performed real JSON storage writes without a provider', () => {
  assert.ok(writes > 0);
  assert.equal(providerCalls, 0);
});
