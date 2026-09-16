'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  meetingAgentSerialDraftWrite,
  meetingAgentStagePersistenceChanges,
  persistMeetingAgentBackgroundStage,
  meetingAgentActionPrimaryPromptForDraft,
  publicMeetingAgentDraft,
  normaliseMeetingAgentGeneration
} = require('../routes/api').stagedEvaluation;

function baseDraft() {
  return {
    draftId: 'persistence-test', revision: 1,
    details: { meetingTitle: 'Original title' },
    discussion: [{ topic: 'Existing', points: [] }],
    actions: [{ id: 'A0', action: 'Existing action' }], pendingProposal: null,
    executiveSummary: 'Existing summary',
    meetingObjectives: [{ id: 'O0', text: 'Existing objective' }],
    candidateLedger: [], passProvenance: [], passCache: [], qualityState: {},
    reviewFlags: [], staleStages: [], currentStep: 1,
    generation: { stage: 'discussion', status: 'running', startedAt: '2026-09-16T10:00:00.000Z' }
  };
}

test('action Primary prewarm is independent of editable Discussion content', () => {
  const draft = {
    preparedTranscript: 'Alex: I will send the report tomorrow.',
    details: { meetingTitle: 'Report review', meetingDate: '2026-09-16' },
    steer: 'Focus on commitments.', salientDetails: [], discussion: []
  };
  const before = meetingAgentActionPrimaryPromptForDraft(draft);
  const after = meetingAgentActionPrimaryPromptForDraft({
    ...draft,
    discussion: [{ topic: 'Changed during review', points: [{ text: 'New wording' }] }]
  });
  assert.equal(after, before);
  assert.notEqual(meetingAgentActionPrimaryPromptForDraft({ ...draft, steer: 'Focus on deadlines.' }), before);
});

test('running generation safely exposes bounded read-only action previews', () => {
  const generation = normaliseMeetingAgentGeneration({
    stage: 'actions', status: 'running', startedAt: '2026-09-16T10:00:00.000Z',
    pass: 'critic', completedPasses: ['primary', 'recovery', 'referee'],
    previewUpdatedAt: '2026-09-16T10:01:00.000Z',
    previewActions: [{
      id: 'preview-1', action: 'Send the revised report.', owners: ['Alex Reed'],
      timing: { kind: 'deadline', wording: 'tomorrow', exactDate: '2026-09-17' },
      evidenceIds: ['T0001'], reviewFlagIds: ['private-flag']
    }]
  });
  assert.equal(generation.previewActions.length, 1);
  assert.equal(generation.previewActions[0].action, 'Send the revised report.');
  assert.deepEqual(generation.previewActions[0].reviewFlagIds, []);
  assert.equal(generation.previewUpdatedAt, '2026-09-16T10:01:00.000Z');
});

test('successful recovered stages do not expose internal degradation warnings', () => {
  const draft = baseDraft();
  draft.currentStep = 3;
  draft.generation = null;
  draft.qualityState = {
    discussion: {
      completedAt: '2026-09-16T15:26:43.806Z',
      completedPasses: ['recovery', 'referee'],
      degradedSources: ['The optional primary quality pass did not complete: invalid structure.']
    }
  };
  const publicDraft = publicMeetingAgentDraft(draft);
  assert.equal(publicDraft.qualityNotice, '');
  assert.equal(Object.prototype.hasOwnProperty.call(publicDraft, 'qualityState'), false);
});

const results = {
  discussion: { changes: {
    discussion: [{ topic: 'Generated discussion', points: [] }],
    meetingObjectives: [{ id: 'OD', text: 'Discussion objective' }],
    candidateLedger: [{ candidateId: 'D1', recordType: 'discussion_point' }],
    passProvenance: [{ stage: 'discussion', pass: 'primary' }],
    passCache: [{ stage: 'discussion', pass: 'primary', promptSha256: 'd'.repeat(64), result: {} }],
    qualityState: { discussion: { completedPasses: ['primary'] } }
  }, reviewFlags: [], replaceCoverageFlags: false },
  actions: { changes: {
    actions: [{ id: 'A1', action: 'Generated action' }], pendingProposal: null,
    candidateLedger: [{ candidateId: 'A1', recordType: 'action' }],
    passProvenance: [{ stage: 'actions', pass: 'primary' }],
    passCache: [{ stage: 'actions', pass: 'primary', promptSha256: 'a'.repeat(64), result: {} }],
    qualityState: { actions: { completedPasses: ['primary'] } }
  }, reviewFlags: [], replaceCoverageFlags: false },
  summary: { changes: {
    executiveSummary: 'Generated summary',
    meetingObjectives: [{ id: 'OS', text: 'Summary objective' }],
    passProvenance: [{ stage: 'summary', pass: 'summary' }],
    passCache: [{ stage: 'summary', pass: 'summary', promptSha256: 's'.repeat(64), result: {} }],
    qualityState: { summary: { completedPasses: ['summary'] } }
  }, reviewFlags: [], replaceCoverageFlags: false }
};

function applyStage(state, source, stage) {
  const scoped = meetingAgentStagePersistenceChanges(source, state, stage, results[stage].changes);
  assert.deepEqual(scoped.conflictFields, []);
  return { ...state, ...scoped.changes, revision: state.revision + 1 };
}

test('old unqueued optimistic writes deterministically reproduce revision conflicts', async () => {
  let revision = 1;
  let readers = 0;
  let release;
  const allRead = new Promise((resolve) => { release = resolve; });
  const unqueued = async () => {
    const expected = revision;
    readers += 1;
    if (readers === 3) release();
    await allRead;
    if (expected !== revision) {
      const error = new Error('revision conflict'); error.statusCode = 409; throw error;
    }
    revision += 1;
  };
  const settled = await Promise.allSettled([unqueued(), unqueued(), unqueued()]);
  assert.equal(settled.filter((item) => item.status === 'rejected').length, 2);
});

test('per-draft writes serialize without serializing model-call work', async () => {
  let revision = 1;
  let activeWrites = 0;
  let maximumWrites = 0;
  let activeModels = 0;
  let maximumModels = 0;
  const run = async (index) => {
    activeModels += 1;
    maximumModels = Math.max(maximumModels, activeModels);
    await new Promise((resolve) => setTimeout(resolve, 8 - index));
    activeModels -= 1;
    return meetingAgentSerialDraftWrite('queued-progress', async () => {
      activeWrites += 1;
      maximumWrites = Math.max(maximumWrites, activeWrites);
      const expected = revision;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(expected, revision);
      revision += 1;
      activeWrites -= 1;
    });
  };
  await Promise.all([run(0), run(1), run(2), run(3)]);
  assert.equal(maximumModels, 4);
  assert.equal(maximumWrites, 1);
  assert.equal(revision, 5);
});

for (const order of [
  ['summary', 'discussion', 'actions'],
  ['discussion', 'summary', 'actions'],
  ['actions', 'discussion', 'summary']
]) {
  test(`stage-owned results survive ${order.join(' -> ')} completion`, () => {
    const source = baseDraft();
    let state = structuredClone(source);
    for (const stage of order) state = applyStage(state, source, stage);
    assert.equal(state.discussion[0].topic, 'Generated discussion');
    assert.equal(state.actions[0].action, 'Generated action');
    assert.equal(state.executiveSummary, 'Generated summary');
    assert.equal(state.meetingObjectives[0].text, 'Summary objective');
    assert.deepEqual(new Set(Object.keys(state.qualityState)), new Set(['discussion', 'actions', 'summary']));
  });
}

test('unrelated newer reviewer edits survive a generated stage save', () => {
  const source = baseDraft();
  const fresh = { ...structuredClone(source), revision: 2, details: { meetingTitle: 'Reviewer title' } };
  const scoped = meetingAgentStagePersistenceChanges(source, fresh, 'actions', results.actions.changes);
  const saved = { ...fresh, ...scoped.changes };
  assert.deepEqual(scoped.conflictFields, []);
  assert.equal(saved.details.meetingTitle, 'Reviewer title');
  assert.equal(saved.actions[0].action, 'Generated action');
});

test('same-stage newer reviewer edits are protected and reported', async () => {
  const source = baseDraft();
  let state = { ...structuredClone(source), revision: 2, discussion: [{ topic: 'Reviewer discussion' }] };
  const outcome = await persistMeetingAgentBackgroundStage({
    draftId: state.draftId, userId: 1, stage: 'discussion', sourceDraft: source,
    result: results.discussion, wait: async () => {},
    getDraft: async () => structuredClone(state),
    saveDraft: async (fresh, changes) => {
      state = { ...fresh, ...changes, revision: fresh.revision + 1 };
      return structuredClone(state);
    }
  });
  assert.deepEqual(outcome.conflictFields, ['discussion']);
  assert.equal(state.discussion[0].topic, 'Reviewer discussion');
  assert.equal(state.generation.status, 'failed');
  assert.match(state.generation.error, /newer edits were kept/i);
});

test('one optimistic conflict reloads and merges only stage-owned fields', async () => {
  const source = baseDraft();
  let state = structuredClone(source);
  let saves = 0;
  const outcome = await persistMeetingAgentBackgroundStage({
    draftId: state.draftId, userId: 1, stage: 'actions', sourceDraft: source,
    result: results.actions, wait: async () => {},
    getDraft: async () => structuredClone(state),
    saveDraft: async (fresh, changes) => {
      saves += 1;
      if (saves === 1) {
        state = { ...state, revision: state.revision + 1, details: { meetingTitle: 'Concurrent edit' } };
        const error = new Error('conflict'); error.statusCode = 409; throw error;
      }
      state = { ...fresh, ...changes, revision: fresh.revision + 1 };
      return structuredClone(state);
    }
  });
  assert.equal(saves, 2);
  assert.equal(outcome.saved.details.meetingTitle, 'Concurrent edit');
  assert.equal(outcome.saved.actions[0].action, 'Generated action');
});

test('optimistic conflict retry count is bounded', async () => {
  const source = baseDraft();
  let saves = 0;
  await assert.rejects(() => persistMeetingAgentBackgroundStage({
    draftId: source.draftId, userId: 1, stage: 'summary', sourceDraft: source,
    result: results.summary, wait: async () => {}, maxAttempts: 3,
    getDraft: async () => structuredClone(source),
    saveDraft: async () => {
      saves += 1;
      const error = new Error('persistent conflict'); error.statusCode = 409; throw error;
    }
  }), /persistent conflict/);
  assert.equal(saves, 3);
});
