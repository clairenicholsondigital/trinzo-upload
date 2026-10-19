'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const { cleanGeneratedMeetingAgentResult } = require('../utils/meetingMinutesGeneratedHygiene');
const { markMeetingAgentReviewerEdits } = require('../utils/meetingMinutesReviewerEdits');
const db = require('../utils/db');
let saved;
const originalGet = db.getMeetingMinutesAgentDraft;
const originalUpdate = db.updateMeetingMinutesAgentDraft;
db.getMeetingMinutesAgentDraft = async () => structuredClone(saved);
db.updateMeetingMinutesAgentDraft = async (_id, _user, revision, updates) => {
  assert.equal(revision, saved.revision);
  saved = { ...saved, ...updates.payload, revision: revision + 1, status: updates.status };
  return structuredClone(saved);
};
const router = require('../routes/api');
db.getMeetingMinutesAgentDraft = originalGet;
db.updateMeetingMinutesAgentDraft = originalUpdate;
const { publicMeetingAgentDraft, meetingAgentDraftForDocx, meetingAgentDraftForPdf } = router.stagedEvaluation;
const { generateMeetingMinutesAgentDocx } = require('../utils/meetingMinutesAgentDocx');
const { normaliseMinutes, renderStagedMinutesPdfHtml } = require('../utils/stagedMinutesPdf');

const record = (id, text, extra = {}) => ({ id, text, evidenceIds: ['T1'], supportingDetails: [], ...extra });
const topic = (points) => ({ id: 'topic', topic: 'Planning', points, decisions: [], openQuestions: [] });
const base = () => ({ draftId: 'review', revision: 1, status: 'draft',
  details: { meetingTitle: 'Planning', meetingDate: '2026-10-19', meetingType: 'General' },
  sourceUnits: [{ id: 'T1', speaker: 'Alex', text: 'The schedule remains provisional.' }],
  qualityState: { discussion: { topicArrangementVersion: 1 } },
  discussion: [topic([record('p1', 'The schedule remains provisional.')])],
  actions: [], reviewFlags: [], changeHistory: [], redoHistory: [], staleStages: [] });

test('agent PDF renders reviewer summary paragraphs without changing the separate staged renderer default', () => {
  const draft = { ...base(), executiveSummary: 'The review remains provisional.\n\nApproval is still required.' };
  const minutes = meetingAgentDraftForPdf(draft);
  assert.equal(normaliseMinutes(minutes).executiveSummary, draft.executiveSummary);
  assert.match(renderStagedMinutesPdfHtml(minutes), /white-space:pre-line/);
  assert.equal(normaliseMinutes({ executiveSummary: draft.executiveSummary }).executiveSummary,
    'The review remains provisional. Approval is still required.');
  assert.doesNotMatch(renderStagedMinutesPdfHtml({ executiveSummary: draft.executiveSummary }), /white-space:pre-line/);
});

test('generated cleanup preserves evidence, human wording and unrelated stages', () => {
  const result = { changes: { discussion: [topic([
    record('p1', 'Submission may happen Friday, with some lighthearted remarks on timing.'),
    record('p2', 'There were some light-hearted remarks.'),
    record('p3', 'There were some light-hearted remarks.', { reviewerAuthored: true })
  ])], actions: [{ id: 'a', action: 'Send it for review for review.' }], sourceUnits: base().sourceUnits } };
  const before = structuredClone(result);
  const cleaned = cleanGeneratedMeetingAgentResult(result, 'discussion');
  assert.deepEqual(result, before, 'cleanup must not mutate source objects');
  assert.deepEqual(cleaned.changes.discussion[0].points.map((r) => r.id), ['p1', 'p3']);
  assert.equal(cleaned.changes.discussion[0].points[0].text, 'Submission may happen Friday.');
  assert.deepEqual(cleaned.changes.discussion[0].points[0].evidenceIds, ['T1']);
  assert.deepEqual(cleaned.changes.actions, before.changes.actions);
  assert.deepEqual(cleaned.changes.sourceUnits, before.changes.sourceUnits);
  assert.deepEqual(cleanGeneratedMeetingAgentResult(cleaned, 'discussion'), cleaned);
});

test('action cleanup preserves ownership, timing and qualifications; proposal before remains intact', () => {
  const action = { id: 'a', action: 'Send the form for completion for completion.', owners: ['Alex'],
    timing: { kind: 'dependency', wording: 'after approval' }, evidenceIds: ['T1'], reviewFlagIds: ['f1'] };
  const result = cleanGeneratedMeetingAgentResult({ changes: { actions: [action], pendingProposal: {
    stage: 'actions', changes: [{ id: 'c', type: 'modify', before: action, after: action }]
  } }, normalised: { actions: [action] } }, 'actions');
  assert.deepEqual(result.changes.actions[0], { ...action, action: 'Send the form for completion.' });
  assert.deepEqual(result.normalised.actions, result.changes.actions);
  assert.deepEqual(result.changes.pendingProposal.changes[0].before, action);
  assert.equal(result.changes.pendingProposal.changes[0].after.action, 'Send the form for completion.');
});

test('summaries and objectives receive generated cleanup without rewriting saved discussion', () => {
  const original = { changes: { executiveSummary: 'The review is due Friday. There were some lighthearted remarks.',
    meetingObjectives: [record('o', 'Prepare the file for review for review.')], discussion: base().discussion } };
  const result = cleanGeneratedMeetingAgentResult(original, 'summary');
  assert.equal(result.changes.executiveSummary, 'The review is due Friday.');
  assert.equal(result.changes.meetingObjectives[0].text, 'Prepare the file for review.');
  assert.deepEqual(result.changes.discussion, original.changes.discussion);
});

test('generated cleanup retains parent context for human-authored supporting detail', () => {
  const point = record('p', 'There were some lighthearted remarks.', {
    supportingDetails: [record('s', 'Keep this reviewer explanation.', { reviewerAuthored: true })]
  });
  const input = { changes: { discussion: [topic([point])] } };
  assert.deepEqual(cleanGeneratedMeetingAgentResult(input, 'discussion'), input);
});

test('publication retains summary paragraph boundaries across editor and exports', () => {
  const draft = { ...base(), executiveSummary: 'First paragraph.\n\nSecond paragraph.' };
  assert.equal(publicMeetingAgentDraft(draft).executiveSummary, draft.executiveSummary);
  assert.equal(meetingAgentDraftForDocx(draft).executiveSummary, draft.executiveSummary);
  assert.equal(meetingAgentDraftForPdf(draft).executiveSummary, draft.executiveSummary);
});

test('all publication formats keep a parent sentence that anchors a reviewer-written detail', () => {
  const detail = record('manual-detail', 'The delivery vehicle needs the accessible space.', { reviewerAuthored: true });
  const draft = { ...base(), sourceUnits: [{ id: 'T1', text: 'The visitor parking situation.' }],
    discussion: [{ ...topic([record('parking', 'The visitor parking situation.', { supportingDetails: [detail] })]),
      topic: 'Visitor parking' }] };
  assert.equal(publicMeetingAgentDraft(draft).discussion[0].points[0].supportingDetails[0].text, detail.text);
  assert.equal(meetingAgentDraftForDocx(draft).discussion[0].points[0].supportingDetails[0].text, detail.text);
  const pdf = meetingAgentDraftForPdf(draft, true);
  assert.equal(pdf.discussion[0].points[0], 'The visitor parking situation.');
  assert.equal(pdf.supportingDetails[0].text, detail.text);
});

test('autosaves do not confer authorship; actual row edits and added rows do', () => {
  const prior = base();
  const unchanged = markMeetingAgentReviewerEdits(prior, { discussion: prior.discussion });
  assert.equal(unchanged.discussion[0].reviewerAuthored, undefined);
  assert.equal(unchanged.discussion[0].points[0].reviewerAuthored, undefined);
  const incoming = structuredClone(prior);
  incoming.discussion[0].points[0].text = 'A deliberate replacement.';
  incoming.discussion[0].points.push(record('new', 'A new comment.'));
  const marked = markMeetingAgentReviewerEdits(prior, incoming);
  assert.equal(marked.discussion[0].reviewerAuthored, undefined);
  assert.ok(marked.discussion[0].points.every((r) => r.reviewerAuthored));
  assert.equal(prior.discussion[0].points[0].reviewerAuthored, undefined);
});

test('actual PATCH marks older-client edits and retains them through reload and exports', async () => {
  saved = base();
  const edited = structuredClone(publicMeetingAgentDraft(saved).discussion);
  edited[0].points[0].text = 'Alex needs a holiday.';
  const route = router.stack.find((layer) => layer.route?.path === '/meeting-minutes-agent/drafts/:draftId'
    && layer.route.methods.patch).route;
  const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await route.stack.at(-1).handle({ params: { draftId: saved.draftId }, authUser: { userId: 'reviewer' },
    body: { revision: 1, discussion: edited } }, response);
  assert.equal(response.statusCode, 200, JSON.stringify(response.body));
  assert.equal(saved.discussion[0].points[0].reviewerAuthored, true);
  assert.equal(response.body.draft.discussion[0].points[0].text, 'Alex needs a holiday.');
  assert.equal(publicMeetingAgentDraft(saved).discussion[0].points[0].text, 'Alex needs a holiday.');
  assert.equal(meetingAgentDraftForPdf(saved).discussion[0].points[0], 'Alex needs a holiday.');
  const buffer = await generateMeetingMinutesAgentDocx(meetingAgentDraftForDocx(saved), false);
  const xml = await (await JSZip.loadAsync(buffer)).file('word/document.xml').async('string');
  assert.match(xml, /Alex needs a holiday/);
});

test('editor, PDF and Word agree without applying new hygiene to historical drafts', async () => {
  const draft = base();
  draft.discussion[0].points.push(record('aside', 'Alex joked about the weather.'));
  draft.discussion[0].points.push(record('old', 'There were some lighthearted remarks.'));
  draft.actions = [{ id: 'a', action: 'Send the form for completion for completion.', owners: ['Alex'], timing: { kind: 'not_stated' } }];
  const original = structuredClone(draft);
  const display = publicMeetingAgentDraft(draft);
  const docx = meetingAgentDraftForDocx(draft);
  const pdf = meetingAgentDraftForPdf(draft);
  assert.deepEqual(docx.discussion, display.discussion.map((t) => ({ ...t, hideHeading: false })));
  assert.deepEqual(docx.actions, display.actions);
  assert.deepEqual(pdf.discussion[0].points, display.discussion[0].points.map((p) => p.text));
  assert.ok(display.discussion[0].points.some((p) => p.id === 'old'), 'new hygiene is not a read-time migration');
  assert.equal(display.actions[0].action, draft.actions[0].action);
  const xml = await (await JSZip.loadAsync(await generateMeetingMinutesAgentDocx(docx, false)))
    .file('word/document.xml').async('string');
  assert.doesNotMatch(xml, /joked about the weather/);
  assert.match(xml, /lighthearted remarks/);
  assert.deepEqual(draft, original);
});
