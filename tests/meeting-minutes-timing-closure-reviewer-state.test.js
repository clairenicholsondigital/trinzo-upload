'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../utils/meetingMinutesAgentV2');

// Real handlers and the real payload serializer, with a JSON-only in-memory
// store. A provider request is forbidden and never used by these checks.
process.env.MEETING_MINUTES_AGENT_SPECULATIVE_PIPELINE_V1 = '0';
const fetchModule = require.resolve('node-fetch');
require(fetchModule);
const originalFetch = require.cache[fetchModule].exports;
let providerCalls = 0;
require.cache[fetchModule].exports = async () => {
  providerCalls += 1;
  throw new Error('Provider calls are forbidden in reviewer-state regressions');
};
const db = require('../utils/db');
const originalGet = db.getMeetingMinutesAgentDraft;
const originalUpdate = db.updateMeetingMinutesAgentDraft;
const copy = value => JSON.parse(JSON.stringify(value));
let saved, writes;
db.getMeetingMinutesAgentDraft = async () => copy(saved);
db.updateMeetingMinutesAgentDraft = async (id, userId, revision, updates) => {
  assert.equal(id, saved.draftId);
  assert.equal(userId, 'provenance-reviewer');
  assert.equal(revision, saved.revision);
  saved = copy({ ...saved, ...V.migrateDraftPayload(updates.payload),
    revision: revision + 1, status: updates.status || saved.status });
  writes += 1;
  return copy(saved);
};
const router = require('../routes/api');
const api = router.stagedEvaluation;
db.getMeetingMinutesAgentDraft = originalGet;
db.updateMeetingMinutesAgentDraft = originalUpdate;
require.cache[fetchModule].exports = originalFetch;

const generated = 'The inspection report will be reviewed next week.';
const approved = 'The inspection report will be reviewed next month.';
function reset(options = {}) {
  const statement = options.approved || approved;
  const sourceUnits = [{ id: 'T0001', speaker: 'Morgan Taylor', text: statement }];
  saved = { draftId: 'reviewer-provenance', revision: 1, status: 'draft', payloadVersion: V.PAYLOAD_VERSION,
    details: { meetingTitle: 'Equipment review', meetingType: 'General', meetingDate: '2026-10-21' },
    sourceUnits, preparedTranscript: V.preparedTranscriptFromUnits(sourceUnits),
    discussion: [{ id: 'inspection', topic: 'Inspection', points: [{ id: 'p1', text: statement, evidenceIds: ['T0001'], reviewFlagIds: [] }], decisions: [], openQuestions: [] }],
    actions: [], executiveSummary: options.generated || generated,
    meetingObjectives: options.objectives || [{ id: 'o1', text: 'Review the inspection report next week.', evidenceIds: ['T0001'] },
      { id: 'o2', text: 'Confirm the equipment inventory.', evidenceIds: ['T0001'] }],
    reviewFlags: [], changeHistory: [], redoHistory: [], staleStages: [],
    currentStep: 5, selectedStep: 5,
    qualityState: { preparation: { dateContext: { source: 'reviewer', meetingDate: '2026-10-21' } },
      summary: { completedAt: '2026-10-21T09:00:00.000Z', generated: true } } };
  writes = 0;
}
async function request(method, suffix = '', body = {}) {
  const path = `/meeting-minutes-agent/drafts/:draftId${suffix}`;
  const route = router.stack.find(layer => layer.route?.path === path && layer.route.methods[method])?.route;
  assert.ok(route, `missing ${method} ${path}`);
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  await route.stack.at(-1).handle({ params: { draftId: saved.draftId }, authUser: { userId: 'provenance-reviewer' },
    body: { revision: saved.revision, ...body } }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(providerCalls, 0);
  return res.body.draft;
}
async function correctTiming(draft, values, correction = approved) {
  let checks = 0;
  const result = await api.verifyMeetingAgentSummaryTiming(draft, values, async (_pass, prompt) => {
    const items = JSON.parse(prompt.slice(prompt.indexOf('ITEMS:\n') + 'ITEMS:\n'.length));
    checks += items.length;
    return { results: items.map(item => ({ id: item.id, verdict: 'corrected', problemQuote: item.row,
      evidenceQuote: correction, correctedText: correction, reason: 'Keep the confirmed review period.' })) };
  });
  assert.ok(checks > 0, 'the real temporal review builder must submit the proposed timing');
  return result;
}

test('an unchanged generated summary stays generated after actual autosave and remains correctable', async () => {
  reset();
  const loaded = await request('get');
  await request('patch', '', { executiveSummary: loaded.executiveSummary, meetingObjectives: loaded.meetingObjectives });
  assert.equal(saved.qualityState.summary.reviewerSummaryHash || '', '');
  assert.equal(api.meetingAgentReviewerSummaryHash(saved, saved.executiveSummary), '');
  assert.ok(saved.meetingObjectives.every(row => row.reviewerAuthored !== true));
  const result = await correctTiming(copy(saved), { executiveSummary: saved.executiveSummary, meetingObjectives: [] });
  assert.equal(result.values.executiveSummary, approved);
  assert.equal(result.accounting.complete, true);
  assert.equal(result.accounting.counts.corrected, 1);
  const objective = await correctTiming(copy(saved), { executiveSummary: '', meetingObjectives: [saved.meetingObjectives.find(row => row.id === 'o1')] });
  assert.equal(objective.values.meetingObjectives[0].text, approved);
  assert.equal(objective.accounting.counts.corrected, 1);
  assert.equal(writes, 1);
});

test('a real summary edit survives JSON serialization, currency presentation and unchanged saves', async () => {
  reset({ approved: 'The inspection report will be reviewed next month with a £40 allocation.' });
  const manual = 'The inspection report will be reviewed next Friday with a GBP40 allocation.';
  const edited = await request('patch', '', { executiveSummary: manual, reviewDecisionLabel: 'Edit review timing' });
  const hash = saved.qualityState.summary.reviewerSummaryHash;
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.match(saved.executiveSummary, /£40/);
  assert.equal(api.meetingAgentReviewerSummaryHash(copy(saved), edited.executiveSummary), hash);
  assert.equal(api.meetingAgentReviewerSummaryHash(saved, manual), hash, 'equivalent raw and published currency preserve authority');
  assert.equal(api.meetingAgentReviewerSummaryHash(saved, 'The inspection report will be reviewed next month with a £40 allocation.'), '',
    'new generated wording cannot inherit a different saved human summary hash');
  await request('patch', '', { executiveSummary: edited.executiveSummary });
  assert.equal(saved.qualityState.summary.reviewerSummaryHash, hash);
  const result = await correctTiming(copy(saved), { executiveSummary: edited.executiveSummary, meetingObjectives: [] },
    'The inspection report will be reviewed next month with a £40 allocation.');
  assert.equal(result.values.executiveSummary, edited.executiveSummary);
  assert.equal(result.accounting.counts.uncertain, 1);
  assert.ok(result.flags.some(flag => /reviewer temporal wording preserved/.test(flag.message)));
  assert.equal(writes, 2);
});

test('presentation-only currency changes cannot give generated summaries reviewer authority', async () => {
  reset({ generated: 'The inspection report will be reviewed next week with a GBP40 allocation.',
    approved: 'The inspection report will be reviewed next month with a £40 allocation.' });
  const loaded = await request('get');
  assert.match(loaded.executiveSummary, /£40/);
  await request('patch', '', { executiveSummary: loaded.executiveSummary });
  assert.equal(saved.qualityState.summary.reviewerSummaryHash || '', '');
  const result = await correctTiming(copy(saved), { executiveSummary: saved.executiveSummary, meetingObjectives: [] },
    'The inspection report will be reviewed next month with a £40 allocation.');
  assert.match(result.values.executiveSummary, /next month/);
  assert.equal(result.accounting.complete, true);
});

test('actual objective edits gain authority while untouched generated objectives do not', async () => {
  reset();
  const loaded = await request('get');
  const edited = loaded.meetingObjectives.map(row => row.id === 'o1' ? { ...row, text: 'Review the inspection report next Friday.' } : row);
  const after = await request('patch', '', { meetingObjectives: edited, reviewDecisionLabel: 'Edit objective timing' });
  assert.equal(saved.meetingObjectives.find(row => row.id === 'o1').reviewerAuthored, true);
  assert.notEqual(saved.meetingObjectives.find(row => row.id === 'o2').reviewerAuthored, true);
  assert.equal(saved.qualityState.summary.reviewerSummaryHash || '', '');
  const result = await correctTiming(copy(saved), { executiveSummary: '', meetingObjectives: [after.meetingObjectives.find(row => row.id === 'o1')] });
  assert.equal(result.values.meetingObjectives[0].text, 'Review the inspection report next Friday.');
  assert.equal(result.accounting.counts.uncertain, 1);
  await request('patch', '', { meetingObjectives: after.meetingObjectives });
  assert.equal(saved.meetingObjectives.find(row => row.id === 'o1').reviewerAuthored, true);
  assert.notEqual(saved.meetingObjectives.find(row => row.id === 'o2').reviewerAuthored, true);
});

test('undo and redo restore the summary hash together with its matching content and objective provenance', async () => {
  reset();
  const initial = await request('get');
  const manual = 'The inspection report will be reviewed next Friday.';
  await request('patch', '', { executiveSummary: manual,
    meetingObjectives: initial.meetingObjectives.map(row => row.id === 'o1' ? { ...row, text: 'Review the inspection report next Friday.' } : row),
    reviewDecisionLabel: 'Change review timing' });
  const hash = saved.qualityState.summary.reviewerSummaryHash;
  assert.equal(saved.changeHistory.at(-1).beforeState.reviewerSummaryHash, '');
  assert.equal(api.meetingAgentReviewerSummaryHash(saved), hash);
  await request('post', '/undo');
  assert.equal(saved.executiveSummary, generated);
  assert.equal(saved.qualityState.summary.reviewerSummaryHash || '', '');
  assert.notEqual(saved.meetingObjectives.find(row => row.id === 'o1').reviewerAuthored, true);
  const generatedAgain = await correctTiming(copy(saved), { executiveSummary: saved.executiveSummary, meetingObjectives: [] });
  assert.equal(generatedAgain.values.executiveSummary, approved);
  assert.equal(saved.redoHistory.at(-1).beforeState.reviewerSummaryHash, hash);
  await request('post', '/redo');
  assert.equal(saved.executiveSummary, manual);
  assert.equal(saved.qualityState.summary.reviewerSummaryHash, hash);
  assert.equal(api.meetingAgentReviewerSummaryHash(copy(saved)), hash);
  assert.equal(saved.meetingObjectives.find(row => row.id === 'o1').reviewerAuthored, true);
  const manualAgain = await correctTiming(copy(saved), { executiveSummary: saved.executiveSummary, meetingObjectives: [] });
  assert.equal(manualAgain.values.executiveSummary, manual);
  assert.equal(manualAgain.accounting.counts.uncertain, 1);
  assert.equal(writes, 3);
});

test('reviewer summary authority survives ordinary spoken-number presentation normalization', async () => {
  reset({ approved: 'The inspection report will be reviewed next month for 20 devices.' });
  const manual = 'The inspection report will be reviewed next Friday for twenty devices.';
  const published = await request('patch', '', { executiveSummary: manual });
  assert.match(published.executiveSummary, /20 devices/);
  const hash = saved.qualityState.summary.reviewerSummaryHash;
  assert.equal(api.meetingAgentReviewerSummaryHash(saved, published.executiveSummary), hash,
    'save/publication number formatting must not silently remove genuine reviewer authority');
  const result = await correctTiming(copy(saved), { executiveSummary: published.executiveSummary, meetingObjectives: [] },
    'The inspection report will be reviewed next month for 20 devices.');
  assert.equal(result.values.executiveSummary, published.executiveSummary);
  assert.equal(result.accounting.counts.uncertain, 1);
});

test('date and number presentation autosaves stay generated while an actual date edit stays manual', async () => {
  reset({ generated: 'The inspection report will be reviewed on the third of November 2026 for twenty devices.',
    approved: 'The inspection report will be reviewed next month for 20 devices.' });
  const published = await request('get');
  assert.match(published.executiveSummary, /20 devices/);
  await request('patch', '', { executiveSummary: published.executiveSummary });
  assert.equal(saved.qualityState.summary.reviewerSummaryHash || '', '');
  const edited = await request('patch', '', { executiveSummary: 'The inspection report will be reviewed on the fourth of November 2026 for twenty devices.' });
  const hash = saved.qualityState.summary.reviewerSummaryHash;
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(api.meetingAgentReviewerSummaryHash(copy(saved), edited.executiveSummary), hash);
  const result = await correctTiming(copy(saved), { executiveSummary: edited.executiveSummary, meetingObjectives: [] },
    'The inspection report will be reviewed next month for 20 devices.');
  assert.equal(result.values.executiveSummary, edited.executiveSummary);
  assert.equal(result.accounting.counts.uncertain, 1);
});

test('a real summary timing review warning survives save and reload with its summary still present', async () => {
  reset();
  const edited = await request('patch', '', { executiveSummary: 'The inspection report will be reviewed next Friday.' });
  const review = await correctTiming(copy(saved), { executiveSummary: edited.executiveSummary, meetingObjectives: [] });
  assert.equal(review.flags.length, 1);
  assert.equal(review.flags[0].status, 'open');
  await request('patch', '', { executiveSummary: edited.executiveSummary, reviewFlags: review.flags });
  const loaded = await request('get');
  assert.equal(saved.reviewFlags.find(flag => flag.id === review.flags[0].id)?.status, 'open',
    'a summary warning does not belong to a removed action');
  assert.equal(loaded.reviewFlags.find(flag => flag.id === review.flags[0].id)?.status, 'open');
});

test('an omitted timed-step warning stays open without an action row through save and reload', async () => {
  reset();
  saved.sourceUnits.push({ id: 'T0002', speaker: 'Morgan Taylor', text: 'I will replace the actuator tomorrow.' });
  saved.preparedTranscript = V.preparedTranscriptFromUnits(saved.sourceUnits);
  const flag = { id: 'unrepresented-timed-step', kind: 'timing', status: 'open', correctionNote: '',
    message: 'A source-stated timed step still needs review: replace the actuator tomorrow. Confirm that this work and its own timing are represented.',
    evidenceIds: ['T0002'], temporalField: 'timedStepCoverage' };
  await request('patch', '', { reviewFlags: [flag] });
  const loaded = await request('get');
  assert.equal(saved.reviewFlags.find(row => row.id === flag.id)?.status, 'open');
  assert.equal(saved.reviewFlags.find(row => row.id === flag.id)?.temporalField, 'timedStepCoverage');
  assert.equal(loaded.reviewFlags.find(row => row.id === flag.id)?.status, 'open');
  assert.equal(saved.actions.length, 0, 'missing work does not require a fabricated action merely to retain its warning');
});

test('deleting an ordinary action still dismisses its own timing warning', async () => {
  reset();
  const flag = { id: 'ordinary-action-timing', kind: 'timing', status: 'open', correctionNote: '',
    message: 'Confirm the inspection report review timing next month.', evidenceIds: ['T0001'] };
  saved.actions = [{ id: 'review', action: 'Review the inspection report.', owners: ['Morgan Taylor'],
    evidenceIds: ['T0001'], reviewFlagIds: [flag.id], timing: { kind: 'target', wording: 'next month', exactDate: '' } }];
  saved.reviewFlags = [flag];
  const before = await request('get');
  assert.equal(before.reviewFlags.find(row => row.id === flag.id)?.status, 'open');
  await request('patch', '', { actions: [], reviewFlags: before.reviewFlags });
  const after = await request('get');
  assert.equal(saved.reviewFlags.find(row => row.id === flag.id)?.status, 'dismissed');
  assert.equal(after.reviewFlags.find(row => row.id === flag.id)?.status, 'dismissed');
  assert.equal(saved.reviewFlags.find(row => row.id === flag.id)?.correctionNote, 'The item was removed.');
});
