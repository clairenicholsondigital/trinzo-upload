'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normaliseAgentResult, applyProposal } = require('../utils/meetingMinutesAgentV2');
const { preserveCopiedReviewerContent } = require('../utils/meetingMinutesReviewedAiEdits');
const { cleanGeneratedMeetingAgentResult } = require('../utils/meetingMinutesGeneratedHygiene');

// Exercise the real route with local doubles at its I/O boundaries. No external
// provider or database is used, and their exports are restored after loading it.
const db = require('../utils/db');
const originalGet = db.getMeetingMinutesAgentDraft;
const originalUpdate = db.updateMeetingMinutesAgentDraft;
const fetchPath = require.resolve('node-fetch');
require('node-fetch');
const originalFetch = require.cache[fetchPath].exports;
let saved; let modelReply; let calls = 0;
db.getMeetingMinutesAgentDraft = async () => structuredClone(saved);
db.updateMeetingMinutesAgentDraft = async (_id, _user, revision, updates) => {
  assert.equal(revision, saved.revision);
  saved = { ...saved, ...updates.payload, revision: revision + 1, status: updates.status };
  return structuredClone(saved);
};
require.cache[fetchPath].exports = async (url) => {
  assert.equal(url, 'https://example.invalid/reviewer-ai-edit');
  calls += 1;
  return { ok: true, status: 200, text: async () => JSON.stringify(modelReply) };
};
const router = require('../routes/api');
db.getMeetingMinutesAgentDraft = originalGet;
db.updateMeetingMinutesAgentDraft = originalUpdate;
require.cache[fetchPath].exports = originalFetch;

const point = (id, text, extra = {}) => ({ id, text, evidenceIds: ['T1'], supportingDetails: [], ...extra });
const topic = (points, extra = {}) => ({ id: 'topic', topic: 'Delivery planning', points, decisions: [], openQuestions: [], ...extra });
const base = () => ({ draftId: 'review', revision: 1, status: 'draft',
  details: { meetingTitle: 'Planning', meetingDate: '2026-10-19', meetingType: 'General' },
  preparedTranscript: 'Alex: The pack is ready for review. There were some lighthearted remarks. Alex will send the form after approval. '.repeat(2),
  sourceUnits: [{ id: 'T1', speaker: 'Alex', text: 'The pack is ready for review. There were some lighthearted remarks. Alex will send the form after approval.' }],
  qualityState: { discussion: { topicArrangementVersion: 1 } },
  discussion: [topic([point('p1', 'There were some lighthearted remarks.', { reviewerAuthored: true }), point('p2', 'The pack is ready.')])],
  actions: [], salientDetails: [], reviewFlags: [], changeHistory: [], redoHistory: [], staleStages: [] });

function edited(previous, raw, stage = 'discussion') {
  const ordinary = normaliseAgentResult(raw, previous.sourceUnits, stage);
  const protectedResult = preserveCopiedReviewerContent(previous, raw, ordinary, stage);
  return cleanGeneratedMeetingAgentResult({ normalised: protectedResult }, stage).normalised;
}

test('copied human wording survives an AI edit while requested changes still apply', () => {
  const prior = base();
  const raw = { discussion: [topic([point('p1', 'There were some lighthearted remarks.'), point('p2', 'The pack is ready for review.')])] };
  const snapshot = structuredClone({ prior, raw });
  const result = edited(prior, raw);
  assert.deepEqual(result.discussion[0].points.map((p) => p.text), ['There were some lighthearted remarks.', 'The pack is ready for review.']);
  assert.equal(result.discussion[0].points[0].reviewerAuthored, true);
  assert.equal(result.discussion[0].points[1].reviewerAuthored, undefined);
  assert.deepEqual({ prior, raw }, snapshot, 'reconciliation must not mutate either source');
});

test('changed and omitted human rows remain changed and omitted', () => {
  const prior = base();
  const changed = edited(prior, { discussion: [topic([point('p1', 'The pack is ready for review.')])] });
  assert.equal(changed.discussion[0].points[0].text, 'The pack is ready for review.');
  assert.equal(changed.discussion[0].points[0].reviewerAuthored, undefined);
  const omitted = edited(prior, { discussion: [topic([point('p2', 'The pack is ready for review.')])] });
  assert.deepEqual(omitted.discussion[0].points.map((p) => p.id), ['p2']);
});

test('copied manual-topic children survive ordinary category filtering', () => {
  const prior = base();
  prior.discussion = [topic([point('manual-point', 'Send the form after approval.')], { id: 'manual-topic-1', topic: 'Action items' })];
  const raw = { discussion: structuredClone(prior.discussion) };
  assert.equal(normaliseAgentResult(raw, prior.sourceUnits, 'discussion').discussion.length, 0, 'regression crosses the ordinary eligibility gate');
  const result = edited(prior, raw);
  assert.equal(result.discussion[0].points[0].text, 'Send the form after approval.');
  assert.equal(result.discussion[0].points[0].reviewerAuthored, true);
});

test('merged generated rows never inherit a copied manual topic exemption', () => {
  const prior = base();
  prior.discussion = [topic([point('p1', 'The pack is ready for review.')], { id: 'manual-topic-1' })];
  const raw = { discussion: [...structuredClone(prior.discussion), topic([point('p3', 'There were some lighthearted remarks.')], { id: 'new-topic' })] };
  const ordinary = normaliseAgentResult(raw, prior.sourceUnits, 'discussion');
  assert.equal(ordinary.discussion.length, 1, 'same-label topics merge before reconciliation');
  const reconciled = preserveCopiedReviewerContent(prior, raw, ordinary, 'discussion');
  assert.deepEqual(reconciled.discussion[0].points.map((p) => p.id), ['p1', 'p3']);
  assert.equal(reconciled.discussion[0].reviewerAuthored, undefined);
  const result = cleanGeneratedMeetingAgentResult({ normalised: reconciled }, 'discussion').normalised;
  assert.deepEqual(result.discussion[0].points.map((p) => p.id), ['p1']);
});

test('AI-claimed provenance grants no new protection', () => {
  const prior = base();
  prior.discussion[0].points[0].reviewerAuthored = false;
  const forged = { discussion: [topic([point('p1', 'There were some lighthearted remarks.', {
    reviewerAuthored: true, confirmedTopic: true, source: 'model_human_confirmation'
  })], { reviewerAuthored: true })] };
  assert.deepEqual(edited(prior, forged).discussion, []);
});

test('duplicate returned copies retain one proven unchanged reviewer sentence', () => {
  const prior = base();
  const duplicate = { discussion: [topic([point('p1', 'There were some lighthearted remarks.'), point('p1', 'There were some lighthearted remarks.')])] };
  const result = edited(prior, duplicate);
  assert.equal(result.discussion[0].points.length, 1);
  assert.equal(result.discussion[0].points[0].text, 'There were some lighthearted remarks.');
  assert.equal(result.discussion[0].points[0].reviewerAuthored, true);
});

test('different returned rows sharing an ID preserve only the matching human occurrence in either order', () => {
  const human = point('p1', 'There were some lighthearted remarks.');
  const generated = point('p1', 'Prepare the schedule for review for review.');
  for (const points of [[human, generated], [generated, human]]) {
    const result = edited(base(), { discussion: [topic(points)] });
    assert.deepEqual(result.discussion[0].points.map((p) => p.text), points.map((p) => p === human ? p.text : 'Prepare the schedule for review.'));
    assert.equal(result.discussion[0].points.find((p) => p.text === human.text).reviewerAuthored, true);
    assert.equal(result.discussion[0].points.find((p) => p.text !== human.text).reviewerAuthored, undefined);
  }
});

test('distinct saved rows sharing an ID are disambiguated by exact content', () => {
  const prior = base();
  prior.discussion[0].points[1].id = 'p1';
  const raw = { discussion: [topic([point('p1', 'There were some lighthearted remarks.'), point('p1', 'The pack is ready.')])] };
  const result = edited(prior, raw);
  assert.deepEqual(result.discussion[0].points.map((p) => p.text), ['There were some lighthearted remarks.', 'The pack is ready.']);
  assert.equal(result.discussion[0].points[0].reviewerAuthored, true);
  assert.equal(result.discussion[0].points[1].reviewerAuthored, undefined);
});

test('identical saved occurrences remain ambiguous and cannot transfer one occurrence authorship to another', () => {
  const prior = base();
  prior.discussion[0].points = [point('p1', 'There were some lighthearted remarks.', { reviewerAuthored: true }), point('p1', 'There were some lighthearted remarks.')];
  assert.deepEqual(edited(prior, { discussion: [topic([point('p1', 'There were some lighthearted remarks.')])] }).discussion, []);
});

test('duplicate returned topic containers do not erase a copied human sentence', () => {
  const rawTopic = topic([point('p1', 'There were some lighthearted remarks.')]);
  const result = edited(base(), { discussion: [rawTopic, structuredClone(rawTopic)] });
  assert.equal(result.discussion.length, 1);
  assert.equal(result.discussion[0].points.length, 1);
  assert.equal(result.discussion[0].points[0].reviewerAuthored, true);
});

test('malformed returned containers remain as tolerant as ordinary normalisation', () => {
  const prior = base();
  const raw = { discussion: [null, { id: 'topic', topic: 'Delivery planning', points: 'invalid' }] };
  assert.deepEqual(edited(prior, raw).discussion, []);
});

test('copied human supporting details retain their context without restoring omitted detail', () => {
  const prior = base();
  prior.discussion = [topic([point('p1', 'There were some lighthearted remarks.', {
    supportingDetails: [point('s1', 'This explanation was written by the reviewer.', { reviewerAuthored: true }), point('s2', 'This detail should be removed.')]
  })])];
  const raw = { discussion: [topic([point('p1', 'There were some lighthearted remarks.', {
    supportingDetails: [point('s1', 'This explanation was written by the reviewer.')]
  })])] };
  const result = edited(prior, raw);
  assert.equal(result.discussion[0].points[0].text, 'There were some lighthearted remarks.');
  assert.deepEqual(result.discussion[0].points[0].supportingDetails.map((p) => p.id), ['s1']);
  assert.equal(result.discussion[0].points[0].supportingDetails[0].reviewerAuthored, true);
});

test('copied human actions retain exact wording, but AI changes to wording or owners are not reverted', () => {
  const prior = base();
  prior.actions = [{ id: 'a1', action: 'Send the form for completion for completion.', owners: ['Alex'], timing: { kind: 'not_stated' }, evidenceIds: ['T1'], reviewerAuthored: true }];
  const raw = { actions: prior.actions.map(({ reviewerAuthored, ...action }) => action) };
  const copied = edited(prior, raw, 'actions');
  assert.equal(copied.actions[0].action, prior.actions[0].action);
  assert.equal(copied.actions[0].reviewerAuthored, true);
  const changed = edited(prior, { actions: [{ ...raw.actions[0], action: 'Send the form after approval.', owners: [] }] }, 'actions');
  assert.equal(changed.actions[0].action, 'Send the form after approval.');
  assert.deepEqual(changed.actions[0].owners, []);
  assert.equal(changed.actions[0].reviewerAuthored, undefined);
  assert.deepEqual(edited(prior, { actions: [] }, 'actions').actions, []);
});

test('duplicate action IDs in saved and returned lists protect only the matching copied occurrence', () => {
  const prior = base();
  const human = { id: 'a1', action: 'Send the form for completion for completion.', owners: ['Alex'], timing: { kind: 'not_stated' }, evidenceIds: ['T1'] };
  const generated = { ...human, action: 'Arrange the inspection.' };
  prior.actions = [{ ...human, reviewerAuthored: true }, generated];
  for (const actions of [[human, human, generated], [generated, human, human]]) {
    const result = edited(prior, { actions }, 'actions');
    assert.equal(result.actions.length, 2);
    assert.equal(result.actions.filter((a) => a.reviewerAuthored).length, 1);
    assert.equal(result.actions.find((a) => a.reviewerAuthored).action, human.action);
    assert.equal(result.actions.find((a) => a.action === generated.action).reviewerAuthored, undefined);
  }
  prior.actions = [{ ...human, reviewerAuthored: true }, human];
  const ambiguous = edited(prior, { actions: [human] }, 'actions');
  assert.equal(ambiguous.actions[0].reviewerAuthored, undefined);
  assert.equal(ambiguous.actions[0].action, 'Send the form for completion.');
});

test('a unique copied action replaces its normalised rewrite instead of creating a duplicate', () => {
  const prior = base();
  const human = { id: 'a1', action: 'Arrange the inspection.', owners: ['Morgan'], timing: { kind: 'not_stated' }, evidenceIds: ['T1'] };
  prior.actions = [{ ...human, reviewerAuthored: true }];
  const raw = { actions: [human] };
  const ordinary = normaliseAgentResult(raw, prior.sourceUnits, 'actions');
  assert.deepEqual(ordinary.actions[0].owners, [], 'ordinary generation cannot confirm this reviewer-supplied owner');
  const result = edited(prior, raw, 'actions');
  assert.equal(result.actions.length, 1);
  assert.deepEqual(result.actions[0].owners, ['Morgan']);
  assert.equal(result.actions[0].reviewerAuthored, true);
});

test('actual AI-edit route proposes the requested edit without deleting copied reviewer wording', async () => {
  saved = base(); calls = 0;
  modelReply = { discussion: [topic([point('p1', 'There were some lighthearted remarks.'), point('p1', 'There were some lighthearted remarks.'), point('p2', 'The pack is ready for review.')])], actions: [] };
  const previousUrl = process.env.POWER_AUTOMATE_AGENT_WEBHOOK_URL;
  process.env.POWER_AUTOMATE_AGENT_WEBHOOK_URL = 'https://example.invalid/reviewer-ai-edit';
  try {
    const route = router.stack.find((layer) => layer.route?.path === '/meeting-minutes-agent/generate' && layer.route.methods.post).route;
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await route.stack.at(-1).handle({ authUser: { userId: 'reviewer' }, body: {
      stage: 'discussion', draftId: saved.draftId, revision: 1, instruction: 'Clarify the review status only.'
    } }, response);
    assert.equal(response.statusCode, 200, JSON.stringify(response.body));
    assert.equal(calls, 1);
    const proposal = saved.pendingProposal;
    assert.ok(proposal.changes.length, 'the requested change is proposed');
    const accepted = applyProposal(saved.discussion, proposal, proposal.changes.map((change) => change.id));
    assert.deepEqual(accepted[0].points.map((p) => p.text), ['There were some lighthearted remarks.', 'The pack is ready for review.']);
    assert.equal(accepted[0].points[0].reviewerAuthored, true);
    assert.equal(saved.discussion[0].points[1].text, 'The pack is ready.', 'proposals do not overwrite the saved draft before acceptance');
  } finally {
    if (previousUrl === undefined) delete process.env.POWER_AUTOMATE_AGENT_WEBHOOK_URL;
    else process.env.POWER_AUTOMATE_AGENT_WEBHOOK_URL = previousUrl;
  }
});
