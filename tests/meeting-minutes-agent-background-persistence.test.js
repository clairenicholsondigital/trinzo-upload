'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { baseDraft, results } = require('./fixtures/meeting-minutes-stage-persistence');

const {
  meetingAgentSerialDraftWrite,
  persistMeetingAgentBackgroundStage,
  meetingAgentActionPrimaryPromptForDraft,
  publicMeetingAgentDraft,
  normaliseMeetingAgentGeneration,
  normaliseMeetingAgentDraftChanges
} = require('../routes/api').stagedEvaluation;

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

test('persisted stage completion supersedes a stale generation marker', () => {
  const draft = baseDraft();
  draft.generation = {
    stage: 'discussion', status: 'failed', startedAt: '2026-09-16T10:00:00.000Z',
    error: 'timeout exceeded when trying to connect'
  };
  draft.qualityState = { discussion: { completedAt: '2026-09-16T10:05:00.000Z' } };
  assert.equal(publicMeetingAgentDraft(draft).generation, null);

  draft.generation.startedAt = '2026-09-16T10:10:00.000Z';
  assert.equal(publicMeetingAgentDraft(draft).generation.status, 'failed', 'a newer failure remains visible');
});

test('existing drafts cannot expose raw action prose as a timing value', () => {
  const draft = baseDraft();
  draft.actions = [{
    id: 'A1', action: 'Run the pilot.', owners: ['Alex Reed'],
    timing: { kind: 'deadline', wording: "We do a four-week pilot where we'd test the process", exactDate: '' }
  }, {
    id: 'A2', action: 'Start the manual process.', owners: ['Priya Shah'],
    timing: { kind: 'dependency', wording: 'In parallel once approval is received', exactDate: '' }
  }];
  const publicDraft = publicMeetingAgentDraft(draft);
  assert.deepEqual(publicDraft.actions[0].timing, { kind: 'not_stated', wording: '', exactDate: '' });
  assert.deepEqual(publicDraft.actions[1].timing, {
    kind: 'dependency', wording: 'Once approval is received', exactDate: ''
  });
});

test('published minute fields use figures while transcript evidence stays verbatim', () => {
  const draft = baseDraft();
  draft.executiveSummary = 'Eleven out of ninety checks were complete.';
  draft.meetingObjectives = [{ id: 'O1', text: 'Review thirty items.' }];
  draft.discussion = [{
    topic: 'Thirty item review',
    points: [{
      text: 'Eleven out of ninety checks were complete at a cost of about ££25-£30.',
      supportingDetails: [{ text: 'Thirty items remained.' }]
    }],
    decisions: [{ text: 'Order twenty replacement labels.' }],
    openQuestions: [{ text: 'Whether ninety checks are sufficient.' }]
  }];
  draft.actions = [{
    id: 'A1', action: 'Review thirty items.', owners: ['Alex Reed'],
    timing: { kind: 'target', wording: 'within twenty days', exactDate: '' }
  }];
  draft.sourceUnits = [{ id: 'T0001', speaker: 'Alex Reed', text: 'Eleven out of ninety checks were complete.' }];

  const published = publicMeetingAgentDraft(draft);
  assert.equal(published.executiveSummary, '11 out of 90 checks were complete.');
  assert.equal(published.meetingObjectives[0].text, 'Review 30 items.');
  assert.equal(published.discussion[0].topic, '30 item review');
  assert.equal(published.discussion[0].points[0].text, '11 out of 90 checks were complete at a cost of about £25-£30.');
  assert.equal(published.discussion[0].points[0].supportingDetails[0].text, '30 items remained.');
  assert.equal(published.discussion[0].decisions[0].text, 'Order 20 replacement labels.');
  assert.equal(published.discussion[0].openQuestions[0].text, 'Whether 90 checks are sufficient.');
  assert.equal(published.actions[0].action, 'Review 30 items.');
  assert.equal(published.actions[0].timing.wording, 'within 20 days');
  assert.equal(published.sourceUnits[0].text, 'Eleven out of ninety checks were complete.');
});

test('existing Library drafts hide generated assignment recaps but retain manual cards', () => {
  const draft = baseDraft();
  const recap = {
    topic: 'Summary of individual action assignments',
    points: [{ text: 'Plans include completing the review, checking the specification and updating the risk file.' }],
    decisions: [], openQuestions: []
  };
  draft.discussion = [
    { id: 'generated-recap', ...recap },
    { id: 'manual-topic-1', ...recap },
    { id: 'substantive', topic: 'Risk documentation', points: [{ text: 'The risk file lacks a frequency rationale.' }] }
  ];

  const published = publicMeetingAgentDraft(draft);
  assert.deepEqual(published.discussion.map((topic) => topic.id), ['manual-topic-1', 'substantive']);
});

test('existing Library drafts hide reported-speech action recaps but retain reviewer-authored cards', () => {
  const draft = baseDraft();
  const recap = {
    topic: 'Summary of individual action assignments and next steps',
    points: [{
      text: 'Jacqui Fox stated that David Didsbury would send the debug command letters for review.'
    }],
    decisions: [], openQuestions: []
  };
  draft.discussion = [
    { id: 'generated-reported-recap', ...recap },
    { id: 'reviewer-reported-recap', ...recap, reviewerAuthored: true },
    { id: 'substantive', topic: 'Debug command documentation', points: [{ text: 'The command letters were not yet documented.' }] }
  ];

  const published = publicMeetingAgentDraft(draft);
  assert.deepEqual(published.discussion.map((topic) => topic.id), ['reviewer-reported-recap', 'substantive']);
});

test('published date ranges expand an omitted month without rewriting transcript evidence', () => {
  const draft = baseDraft();
  draft.executiveSummary = 'The review runs from 27th through to 7th August.';
  draft.discussion = [{
    topic: 'Review schedule',
    points: [{ text: 'Testing runs from 27th through to the 7th of August.' }],
    decisions: [], openQuestions: []
  }];
  draft.actions = [{
    id: 'A1', action: 'Cover the review window.', owners: ['Alex Reed'],
    timing: { kind: 'target', wording: '27th through to 7th August', exactDate: '' }
  }];
  draft.sourceUnits = [{ id: 'T0001', speaker: 'Alex Reed', text: 'It is the 27th through to 7th August.' }];

  const published = publicMeetingAgentDraft(draft);
  assert.equal(published.executiveSummary, 'The review runs from 27th July–7th August.');
  assert.equal(published.discussion[0].points[0].text, 'Testing runs from 27th July–7th August.');
  assert.equal(published.actions[0].timing.wording, '27th July–7th August');
  assert.equal(published.sourceUnits[0].text, 'It is the 27th through to 7th August.');
});

test('saved Library draft changes normalise currency before persistence', () => {
  const changes = normaliseMeetingAgentDraftChanges({
    discussion: [{ topic: 'Repairs', points: [{ text: 'The tap will cost eight pounds, and the fee will rise from 25 to £30.' }] }],
    actions: [{ action: 'Approve twenty five pounds for materials.' }],
    executiveSummary: 'The total budget is 50 pounds.',
    sourceUnits: [{ text: 'The tap will cost eight pounds.' }]
  });
  assert.equal(changes.discussion[0].points[0].text, 'The tap will cost £8, and the fee will rise from £25 to £30.');
  assert.equal(changes.actions[0].action, 'Approve £25 for materials.');
  assert.equal(changes.executiveSummary, 'The total budget is £50.');
  assert.equal(changes.sourceUnits[0].text, 'The tap will cost eight pounds.');
});

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
