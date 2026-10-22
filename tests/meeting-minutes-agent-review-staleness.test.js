'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../utils/db');

// Keep the complete handler/payload path, substituting only storage. No live
// drafts, authentication service or model calls are needed for review edits.
let savedDraft;
const originals = {
  getMeetingMinutesAgentDraft: db.getMeetingMinutesAgentDraft,
  updateMeetingMinutesAgentDraft: db.updateMeetingMinutesAgentDraft
};
db.getMeetingMinutesAgentDraft = async () => structuredClone(savedDraft);
db.updateMeetingMinutesAgentDraft = async (draftId, userId, revision, updates) => {
  assert.equal(revision, savedDraft.revision);
  savedDraft = { ...savedDraft, ...updates.payload, title: updates.title,
    status: updates.status, revision: revision + 1 };
  return structuredClone(savedDraft);
};
const fetchPath = require.resolve('node-fetch');
const originalFetch = require('node-fetch');
let flowReplies = [];
require.cache[fetchPath].exports = async (url) => {
  assert.equal(url, 'https://example.invalid/meeting-audit');
  assert.ok(flowReplies.length, 'unexpected model request');
  const reply = flowReplies.shift();
  return { ok: true, status: 200, text: async () => JSON.stringify(reply) };
};
let router;
try {
  router = require('../routes/api');
} finally {
  Object.assign(db, originals);
  require.cache[fetchPath].exports = originalFetch;
}

function baseDraft() {
  return {
    draftId: 'review-draft', revision: 1, status: 'draft', currentStep: 5,
    details: { meetingTitle: 'Report review' }, steer: '',
    discussion: [{ id: 'topic', topic: 'Report', points: [{ id: 'point', text: 'The report is ready.' }], decisions: [], openQuestions: [] }],
    actions: [{ id: 'action', action: 'Send the report.', owners: ['Alex'],
      timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds: [], reviewFlagIds: [] }],
    executiveSummary: 'The report is ready for Alex to send.',
    sourceUnits: [], staleStages: [], reviewFlags: [], changeHistory: [], redoHistory: []
  };
}

async function invoke(endpoint, body = {}, expectedStatus = 200) {
  const route = router.stack.find((layer) => layer.route?.path === `/meeting-minutes-agent/drafts/:draftId/${endpoint}`).route;
  const response = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
  await route.stack.at(-1).handle({
    params: { draftId: savedDraft.draftId }, authUser: { userId: 'reviewer' },
    body: { revision: savedDraft.revision, ...body }
  }, response);
  assert.equal(response.statusCode, expectedStatus, JSON.stringify(response.body));
  return response.body;
}

for (const stage of ['actions', 'discussion']) {
  function editedRows(rows) {
    return stage === 'actions'
      ? [{ ...rows[0], action: 'Check the report.' }]
      : [{ ...rows[0], points: [{ ...rows[0].points[0], text: 'The report needs another check.' }] }];
  }

  test(`accepting ${stage} suggestions marks dependent stages stale in the saved draft`, async () => {
    savedDraft = baseDraft();
    const before = savedDraft[stage];
    const after = editedRows(before);
    savedDraft.pendingProposal = { stage, changes: [{ id: 'change', type: 'modify',
      before: before[0], after: after[0], beforeIndex: 0, index: 0 }] };
    const response = await invoke('proposal', { decision: 'accept', acceptAll: true });
    assert.deepEqual(savedDraft[stage], after);
    assert.deepEqual(savedDraft.staleStages, stage === 'actions' ? ['summary'] : ['actions', 'summary']);
    assert.deepEqual(response.draft.staleStages, savedDraft.staleStages);
  });

  test(`rejecting ${stage} suggestions preserves current content and freshness`, async () => {
    savedDraft = baseDraft();
    const before = structuredClone(savedDraft[stage]);
    savedDraft.pendingProposal = { stage, changes: [{ id: 'change', type: 'modify',
      before: before[0], after: editedRows(before)[0], beforeIndex: 0, index: 0 }] };
    await invoke('proposal', { decision: 'reject' });
    assert.deepEqual(savedDraft[stage], before);
    assert.deepEqual(savedDraft.staleStages, []);
  });

  test(`undoing a legacy ${stage} edit invalidates dependent output`, async () => {
    savedDraft = baseDraft();
    const before = editedRows(savedDraft[stage]);
    savedDraft.changeHistory = [{ stage, before }];
    await invoke('undo');
    assert.deepEqual(savedDraft[stage], before);
    assert.deepEqual(savedDraft.staleStages, stage === 'actions' ? ['summary'] : ['actions', 'summary']);
  });

  for (const review of [
    { label: 'accepting the remaining suggestion', decision: 'accept', applies: true },
    { label: 'rejecting the remaining suggestion', decision: 'reject', applies: false },
    { label: 'automatically accepting the remaining suggestion', decision: 'accept', automatic: true, applies: true },
    { label: 'automatically reviewing an uncertain remaining suggestion', decision: 'accept', automatic: true, applies: false }
  ]) {
    test(`${review.label} after undo discards the old ${stage} redo branch`, async () => {
      savedDraft = baseDraft();
      savedDraft[stage].push(stage === 'actions'
        ? { ...savedDraft.actions[0], id: 'supplier-action', action: 'Review the supplier agreement.' }
        : { ...savedDraft.discussion[0], id: 'supplier-topic', topic: 'Supplier agreement',
          points: [{ id: 'supplier-point', text: 'The supplier agreement needs review.' }] });
      const original = structuredClone(savedDraft[stage]);
      const remainingEdit = stage === 'actions'
        ? { ...original[1], action: 'Review the updated supplier agreement.' }
        : { ...original[1], points: [{ ...original[1].points[0], text: 'The updated supplier agreement needs review.' }] };
      savedDraft.pendingProposal = { stage, changes: [
        { id: 'first', type: 'modify', before: original[0], after: editedRows(original)[0],
          beforeIndex: 0, index: 0, selected: true },
        { id: 'remaining', type: 'modify', before: original[1], after: remainingEdit,
          beforeIndex: 1, index: 1, selected: review.applies }
      ] };
      savedDraft.reviewFlags = [{ id: 'proposal-review-remaining', kind: 'uncertain_fact',
        status: 'open', message: 'Check the supplier agreement wording.', evidenceIds: [] }];

      await invoke('proposal', { decision: 'accept', changeIds: ['first'] });
      const undone = await invoke('undo');
      assert.deepEqual(savedDraft[stage], original);
      assert.deepEqual(savedDraft.pendingProposal.changes.map(change => change.id), ['remaining']);
      assert.equal(savedDraft.redoHistory.length, 1);
      assert.ok(undone.draft.lastRedo, 'undo must expose the original redo before the new decision');

      const reviewed = await invoke('proposal', {
        decision: review.decision, acceptAll: true, automatic: review.automatic
      });
      assert.deepEqual(savedDraft[stage].map(({ timingDecision, ...row }) => row),
        review.applies ? [original[0], remainingEdit] : original);
      assert.equal(savedDraft.pendingProposal, null);
      assert.deepEqual(savedDraft.redoHistory, [], 'a new review decision must discard the old future');
      assert.equal(reviewed.draft.lastRedo, null, 'the response must clear the client redo control');
      const decided = structuredClone(savedDraft);
      const redo = await invoke('redo', {}, 409);
      assert.equal(redo.error, 'There is nothing to redo.');
      assert.deepEqual(savedDraft, decided, 'a stale redo request must preserve the new decision and revision');

      const decidedSnapshot = router.stagedEvaluation.meetingAgentReviewSnapshot(savedDraft);
      await invoke('undo');
      assert.deepEqual(savedDraft[stage], original);
      await invoke('redo');
      assert.deepEqual(router.stagedEvaluation.meetingAgentReviewSnapshot(savedDraft), decidedSnapshot,
        'the new review decision must retain its own normal undo/redo history');
    });
  }
}

test('undoing a complete review snapshot restores its coherent content and freshness', async () => {
  savedDraft = baseDraft();
  const original = structuredClone(savedDraft);
  const beforeState = router.stagedEvaluation.meetingAgentReviewSnapshot(savedDraft);
  savedDraft.actions[0].action = 'Check the report.';
  savedDraft.staleStages = ['summary'];
  savedDraft.changeHistory = [{ stage: 'actions', beforeState }];
  await invoke('undo');
  assert.deepEqual(savedDraft.actions, original.actions);
  assert.equal(savedDraft.executiveSummary, original.executiveSummary);
  assert.deepEqual(savedDraft.staleStages, []);
});

test('undoing applied suggestions does not requeue them and redo still restores the changes', async () => {
  savedDraft = baseDraft();
  const original = structuredClone(savedDraft.actions);
  const edited = { ...original[0], action: 'Check the report.' };
  savedDraft.pendingProposal = { stage: 'actions', changes: [{ id: 'consumed', type: 'modify',
    before: original[0], after: edited, beforeIndex: 0, index: 0 }] };
  await invoke('proposal', { decision: 'accept', acceptAll: true });
  assert.equal(savedDraft.changeHistory.at(-1).beforeState.pendingProposal, null,
    'the undo snapshot must not queue the accepted suggestion again');
  const undone = await invoke('undo');
  assert.deepEqual(savedDraft.actions, original);
  assert.equal(undone.draft.pendingProposal, null, 'adopting this response must not automatically reapply the proposal');
  await invoke('redo');
  assert.deepEqual(savedDraft.actions, [edited]);
  assert.equal(savedDraft.pendingProposal, null);
});

test('old proposal undo snapshots discard consumed changes while retaining unaccepted suggestions', async () => {
  savedDraft = baseDraft();
  const original = structuredClone(savedDraft.actions);
  const pending = { id: 'pending', type: 'add', before: null,
    after: { ...original[0], id: 'pending-action', action: 'Review the supplier agreement.' }, index: 1, beforeIndex: 1 };
  savedDraft.pendingProposal = { stage: 'actions', changes: [
    { id: 'consumed', type: 'modify', before: original[0],
      after: { ...original[0], action: 'Check the report.' }, index: 0, beforeIndex: 0 }, pending
  ] };
  const beforeState = router.stagedEvaluation.meetingAgentReviewSnapshot(savedDraft);
  savedDraft.actions[0].action = 'Check the report.';
  savedDraft.pendingProposal = { stage: 'actions', changes: [pending] };
  savedDraft.changeHistory = [{ type: 'ai_proposal', stage: 'actions',
    acceptedChangeIds: ['consumed'], beforeState }];
  const undone = await invoke('undo');
  assert.deepEqual(savedDraft.actions, original);
  assert.deepEqual(undone.draft.pendingProposal.changes.map((change) => change.id), ['pending']);
});

for (const publish of [false, true]) {
  test(`a completeness audit ${publish ? 'invalidates the summary when verified actions are published' : 'keeps the summary current when it only offers suggestions'}`, async () => {
    const environment = {
      POWER_AUTOMATE_AGENT_WEBHOOK_URL: 'https://example.invalid/meeting-audit',
      MEETING_MINUTES_AGENT_HYBRID_V4: '0',
      MEETING_MINUTES_AGENT_AUDIT_PUBLISH_V1: publish ? '1' : '0',
      MEETING_MINUTES_AGENT_COMMITMENT_CHECK_V1: '1'
    };
    const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
    Object.assign(process.env, environment);
    try {
      savedDraft = baseDraft();
      savedDraft.sourceUnits = [
        { id: 'T0001', speaker: 'Alex', text: 'I will send the report.' },
        { id: 'T0002', speaker: 'Sam', text: 'I will review the supplier agreement.' }
      ];
      const rescued = { id: 'rescued', action: 'Review the supplier agreement.', owners: ['Sam'],
        timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds: ['T0002'] };
      flowReplies = [{ discussion: [], actions: [rescued] }];
      if (publish) flowReplies.push({ results: [{ id: 'c1', verdict: 'commitment',
        commitmentQuote: 'I will review the supplier agreement.', ownerSupported: true }] });
      await invoke('audit-actions');
      assert.equal(flowReplies.length, 0, 'the configured model replies must all be consumed');
      assert.equal(savedDraft.actions.some((row) => row.action === rescued.action), publish);
      assert.deepEqual(savedDraft.staleStages, publish ? ['summary'] : []);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
}

test('automatic proposal application preserves unconfirmed work and exposes source checks across undo and redo', async () => {
  savedDraft = baseDraft();
  const original = structuredClone(savedDraft.actions[0]);
  const addition = { ...original, id: 'possible', action: 'Consider a wider building survey.', owners: [], evidenceIds: ['T0001'] };
  savedDraft.sourceUnits = [{ id: 'T0001', speaker: 'Alex', text: 'We might consider a wider building survey someday.' }];
  savedDraft.pendingProposal = { stage: 'actions', changes: [
    { id: 'uncertain-remove', type: 'remove', before: original, beforeIndex: 0, selected: false },
    { id: 'uncertain-add', type: 'add', after: addition, index: 1, selected: false },
    { id: 'vetted-edit', type: 'modify', before: original, after: { ...original, action: 'Send the revised report.' }, beforeIndex: 0, selected: true }
  ] };
  await invoke('proposal', { decision: 'accept', automatic: true, acceptAll: true });
  assert.deepEqual(savedDraft.actions.map(row => row.action), ['Send the revised report.']);
  assert.equal(savedDraft.pendingProposal, null);
  assert.equal(savedDraft.reviewFlags.filter(flag => flag.status === 'open').length, 2);
  assert.ok(savedDraft.reviewFlags.every(flag => flag.evidenceIds.length || flag.kind === 'uncertain_fact'));
  await invoke('undo');
  assert.deepEqual(savedDraft.actions, [original]);
  assert.equal(savedDraft.pendingProposal, null, 'undo must not restart automatic adoption');
  await invoke('redo');
  assert.equal(savedDraft.pendingProposal, null);
  assert.equal(savedDraft.actions[0].action, 'Send the revised report.');
  assert.equal(savedDraft.reviewFlags.filter(flag => flag.status === 'open').length, 2);
});

test('an entirely uncertain automatic proposal leaves content and dependent stages unchanged', async () => {
  savedDraft = baseDraft();
  const original = structuredClone(savedDraft.actions);
  savedDraft.pendingProposal = { stage: 'actions', changes: [
    { id: 'uncertain', type: 'remove', before: original[0], beforeIndex: 0, selected: false }
  ] };
  await invoke('proposal', { decision: 'accept', automatic: true });
  assert.deepEqual(savedDraft.actions, original);
  assert.deepEqual(savedDraft.staleStages, []);
  assert.equal(savedDraft.pendingProposal, null);
  assert.equal(savedDraft.reviewFlags[0].status, 'open');
});
