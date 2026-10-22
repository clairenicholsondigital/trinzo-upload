'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Exercise the actual acceptance/save/history handlers with an isolated JSON
// store. Neither provider access nor a real database is allowed in this test.
process.env.MEETING_MINUTES_AGENT_SPECULATIVE_PIPELINE_V1 = '0';
const noNetwork = async () => { throw new Error('Provider access forbidden in automatic edit protection tests'); };
global.fetch = noNetwork;
const fetchPath = require.resolve('node-fetch');
require.cache[fetchPath] = { id: fetchPath, filename: fetchPath, loaded: true, exports: noNetwork };
const V = require('../utils/meetingMinutesAgentV2');
const db = require('../utils/db');
let saved;
let writes = 0;
const copy = value => JSON.parse(JSON.stringify(value));
const originalGet = db.getMeetingMinutesAgentDraft;
const originalUpdate = db.updateMeetingMinutesAgentDraft;
db.getMeetingMinutesAgentDraft = async () => copy(saved);
db.updateMeetingMinutesAgentDraft = async (id, userId, revision, updates) => {
  assert.equal(id, saved.draftId);
  assert.equal(userId, 'edit-reviewer');
  assert.equal(revision, saved.revision);
  saved = copy({ ...saved, ...V.migrateDraftPayload(updates.payload),
    revision: revision + 1, status: updates.status || saved.status });
  writes += 1;
  return copy(saved);
};
const router = require('../routes/api');
const A = router.stagedEvaluation;
db.getMeetingMinutesAgentDraft = originalGet;
db.updateMeetingMinutesAgentDraft = originalUpdate;

const none = { kind: 'not_stated', wording: '', exactDate: '' };
const friday = { kind: 'deadline', wording: 'Friday', exactDate: '2026-10-23' };
const sourceUnits = [{ id: 'T0001', speaker: 'Morgan Reed',
  text: 'I will send the inspection report by Friday.' }];
const row = (extra = {}) => ({ id: 'A1', occurrenceId: 'occ-A1', action: 'Send the inspection report.',
  owners: ['Morgan Reed'], timing: { ...none }, evidenceIds: ['T0001'], reviewFlagIds: [], ...extra });
const edit = (id, before, after) => ({ id, type: 'modify', selected: true,
  before: copy(before), after: copy(after) });
const proposal = changes => ({ id: 'proposal', stage: 'actions', changes });
const draft = (actions, units = sourceUnits) => ({ draftId: 'edit-protection', revision: 1,
  status: 'draft', payloadVersion: V.PAYLOAD_VERSION,
  details: { meetingTitle: 'Equipment review', meetingType: 'General', meetingDate: '2026-10-21' },
  actions, sourceUnits: units, discussion: [], changeHistory: [], redoHistory: [], staleStages: [],
  reviewFlags: [{ id: 'unrelated', kind: 'ownership', status: 'open',
    message: 'Confirm the report recipient.', evidenceIds: ['T0001'] }],
  qualityState: {}, pendingProposal: null });
function reviewAndApply(current, p, units = sourceUnits) {
  const flags = [{ id: 'proposal-review-edit', kind: 'uncertain_fact', status: 'open',
    message: 'Check this edit.', evidenceIds: ['T0001'] }];
  const original = copy({ current, p, units, flags });
  const timing = A.finaliseMeetingAgentTimingProposal(p, draft(current, units));
  const review = A.automaticMeetingAgentProposalReview(timing.proposal,
    [...flags, ...timing.flags], current, units);
  const after = V.applyProposal(current, timing.proposal, review.acceptedIds);
  assert.deepEqual({ current, p, units, flags }, original, 'review must not mutate caller state');
  return { ...review, after, proposal: timing.proposal };
}
function assertBlocked(result, current, id = 'edit', reason) {
  assert.deepEqual(result.acceptedIds, []);
  assert.deepEqual(result.after, current);
  const flag = result.reviewFlags.find(item => item.id === `automatic-review-${id}`);
  assert.equal(flag?.status, 'open');
  assert.match(flag.message, reason);
  assert.ok(!result.reviewFlags.some(item => item.status === 'confirmed'));
}

for (const [name, before, patch, reason] of [
  ['the sole owner', row(), { owners: [] }, /removes an owner/],
  ['a joint owner', row({ owners: ['Morgan Reed', 'Jordan Shah'] }), { owners: ['Morgan Reed'] }, /removes an owner/],
  ['stated timing', row({ timing: { kind: 'deadline', wording: 'Friday', exactDate: '' } }),
    { timing: none }, /removes the timing/],
  ['an exact date', row({ timing: friday }), { timing: { kind: 'deadline', wording: 'Friday', exactDate: '' } }, /removes the date/]
]) {
  test(`saved selected modifications cannot automatically remove ${name}`, () => {
    const p = copy(proposal([edit('edit', before, { ...before, action: 'Email the inspection report.', ...patch })]));
    assertBlocked(reviewAndApply([before], p), [before], 'edit', reason);
  });
}

test('an explicit exact-date change is deferred when both dates survive validation', () => {
  const before = row({ timing: friday });
  const after = { ...before, action: 'Email the inspection report.', evidenceIds: ['T0002'],
    timing: { kind: 'deadline', wording: 'Monday', exactDate: '2026-10-26' } };
  const units = [...sourceUnits, { id: 'T0002', speaker: 'Morgan Reed',
    text: 'I will email the inspection report by Monday.' }];
  const result = reviewAndApply([before], proposal([edit('edit', before, after)]), units);
  assert.equal(result.proposal.changes[0].after.timing.exactDate, '2026-10-26');
  assertBlocked(result, [before], 'edit', /changes the date/);
});

test('timing finalisation clearing an invalid new date cannot erase the existing valid date', () => {
  const before = row({ timing: friday });
  const after = { ...before, action: 'Email the inspection report.', evidenceIds: [],
    timing: { kind: 'deadline', wording: 'the deadline', exactDate: '2026-13-77' } };
  const result = reviewAndApply([before], proposal([edit('edit', before, after)]));
  assert.equal(result.proposal.changes[0].after.timing.exactDate, '',
    'the actual timing finaliser must run before the destructive-edit check');
  assertBlocked(result, [before], 'edit', /removes the date/);
});

test('safe rewording preserves the actual current row identity and passes automatically', () => {
  const before = row({ timing: friday });
  const after = { ...before, id: 'model-id', occurrenceId: 'model-occurrence',
    action: 'Email the inspection report.' };
  const result = reviewAndApply([before], proposal([edit('edit', before, after)]));
  assert.deepEqual(result.acceptedIds, ['edit']);
  assert.equal(result.after[0].action, after.action);
  assert.deepEqual(result.after[0].owners, before.owners);
  assert.deepEqual(result.after[0].timing, before.timing);
  assert.equal(result.after[0].id, before.id);
  assert.equal(result.after[0].occurrenceId, before.occurrenceId);
});

test('unsafe competing edits never consume the occurrence ahead of a safe edit, in either order', () => {
  const before = row({ owners: ['Morgan Reed', 'Jordan Shah'] });
  const unsafe = edit('unsafe', before, { ...before, owners: ['Morgan Reed'] });
  const safe = edit('safe', before, { ...before, action: 'Email the inspection report.' });
  for (const changes of [[unsafe, safe], [safe, unsafe]]) {
    const result = reviewAndApply([before], proposal(changes));
    assert.deepEqual(result.acceptedIds, ['safe']);
    assert.equal(result.after[0].action, safe.after.action);
    assert.deepEqual(result.after[0].owners, before.owners);
    assert.equal(result.reviewFlags.find(flag => flag.id === 'automatic-review-unsafe')?.status, 'open');
  }
});

test('stale and ambiguous unsafe modifications cannot block a separate valid edit', () => {
  const target = row();
  const safe = edit('safe', target, { ...target, action: 'Email the inspection report.' });
  const other = row({ id: 'A2', occurrenceId: 'occ-A2', action: 'Review the safety register.' });
  const stale = edit('stale', { ...target, occurrenceId: 'old-occurrence' }, { ...target, owners: [] });
  const ambiguousBefore = row({ id: 'A3', occurrenceId: 'ambiguous', action: 'Update the calibration register.' });
  const ambiguous = edit('ambiguous', ambiguousBefore, { ...ambiguousBefore, owners: [] });
  const current = [other, target, ambiguousBefore, { ...ambiguousBefore, id: 'A4' }];
  for (const changes of [[stale, ambiguous, safe], [safe, ambiguous, stale]]) {
    const result = reviewAndApply(current, proposal(changes));
    assert.deepEqual(result.acceptedIds, ['safe']);
    assert.equal(result.after[1].action, safe.after.action);
    assert.deepEqual(result.after.filter((_, index) => index !== 1), current.filter((_, index) => index !== 1));
    for (const id of ['stale', 'ambiguous']) {
      assert.equal(result.reviewFlags.find(flag => flag.id === `automatic-review-${id}`)?.status, 'open');
    }
  }
});

test('source-dependent transcript text protection receives the transcript during final acceptance', () => {
  const before = row();
  const spoken = 'Create "those two language characterisation situations".';
  const units = [{ id: 'T0001', speaker: 'Morgan Reed',
    text: 'The description was those two language characterisation situations.' }];
  const p = proposal([edit('edit', before, { ...before, action: spoken })]);
  assert.deepEqual(reviewAndApply([before], p, []).acceptedIds, ['edit'],
    'this existing protection requires source context rather than wording alone');
  assertBlocked(reviewAndApply([before], p, units), [before], 'edit', /line of the conversation/);
});

test('discussion modifications retain their existing automatic acceptance policy', () => {
  const p = { id: 'discussion', stage: 'discussion', changes: [{ id: 'edit',
    type: 'modify', selected: true, before: { text: 'A draft is ready.' }, after: { text: 'The draft is ready.' } }] };
  assert.deepEqual(A.automaticMeetingAgentProposalReview(p, [], []).acceptedIds, ['edit']);
});

test('explicit manual acceptance retains literal edits despite automatic protection', () => {
  const before = row({ owners: ['Morgan Reed', 'Jordan Shah'], timing: friday });
  const after = { ...before, action: 'Email the inspection report.', owners: [], timing: none };
  const p = proposal([edit('edit', before, after)]);
  const result = V.applyProposal([before], p, ['edit']);
  assert.equal(result[0].action, after.action);
  assert.deepEqual(result[0].owners, []);
  assert.deepEqual(result[0].timing, none);
  assert.equal(result[0].occurrenceId, before.occurrenceId);
});

async function request(method, routePath, body = {}) {
  const route = router.stack.find(layer => layer.route?.path === routePath && layer.route.methods[method])?.route;
  assert.ok(route, `missing ${method} ${routePath}`);
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; } };
  await route.stack.at(-1).handle({ params: { draftId: saved.draftId },
    authUser: { userId: 'edit-reviewer' }, body }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return res.body;
}

test('real automatic save, public reload, undo and redo preserve rejected content and accurate history', async () => {
  const before = row({ owners: ['Morgan Reed', 'Jordan Shah'] });
  const unsafe = edit('unsafe', before, { ...before, owners: ['Morgan Reed'] });
  const safe = edit('safe', before, { ...before, action: 'Email the inspection report.' });
  saved = copy({ ...draft([before]), pendingProposal: proposal([unsafe, safe]) });
  writes = 0;
  await request('post', '/meeting-minutes-agent/drafts/:draftId/proposal',
    { revision: saved.revision, decision: 'accept', automatic: true });
  assert.equal(writes, 1);
  let loaded = (await request('get', '/meeting-minutes-agent/drafts/:draftId')).draft;
  assert.equal(loaded.pendingProposal, null);
  assert.equal(loaded.actions[0].action, safe.after.action);
  assert.deepEqual(loaded.actions[0].owners, before.owners);
  assert.deepEqual(saved.changeHistory.at(-1).acceptedChangeIds, ['safe']);
  assert.equal(saved.changeHistory.at(-1).label, '1 suggestion applied');
  assert.equal(loaded.reviewFlags.find(flag => flag.id === 'automatic-review-unsafe')?.status, 'open');
  assert.equal(loaded.reviewFlags.find(flag => flag.id === 'unrelated')?.status, 'open');
  await request('post', '/meeting-minutes-agent/drafts/:draftId/undo', { revision: saved.revision });
  assert.deepEqual(saved.actions, [before]);
  assert.equal(saved.pendingProposal, null, 'undo must not queue rejected edits for another automatic run');
  await request('post', '/meeting-minutes-agent/drafts/:draftId/redo', { revision: saved.revision });
  loaded = (await request('get', '/meeting-minutes-agent/drafts/:draftId')).draft;
  assert.equal(loaded.actions[0].action, safe.after.action);
  assert.deepEqual(loaded.actions[0].owners, before.owners);
  assert.equal(loaded.reviewFlags.find(flag => flag.id === 'automatic-review-unsafe')?.status, 'open');
});

test('the real automatic endpoint supplies source units while manual acceptance remains explicit', async () => {
  const before = row();
  const spoken = 'Create "those two language characterisation situations".';
  const units = [{ id: 'T0001', speaker: 'Morgan Reed',
    text: 'The description was those two language characterisation situations.' }];
  const p = proposal([edit('edit', before, { ...before, action: spoken })]);
  saved = copy({ ...draft([before], units), pendingProposal: p });
  await request('post', '/meeting-minutes-agent/drafts/:draftId/proposal',
    { revision: saved.revision, decision: 'accept', automatic: true });
  assert.deepEqual(saved.actions, [before]);
  assert.equal(saved.reviewFlags.find(flag => flag.id === 'automatic-review-edit')?.status, 'open');
  assert.deepEqual(saved.changeHistory.at(-1).acceptedChangeIds, []);
  saved = copy({ ...draft([before], units), pendingProposal: p });
  await request('post', '/meeting-minutes-agent/drafts/:draftId/proposal',
    { revision: saved.revision, decision: 'accept', changeIds: ['edit'] });
  assert.equal(saved.actions[0].action, spoken);
  assert.deepEqual(saved.changeHistory.at(-1).acceptedChangeIds, ['edit']);
});
