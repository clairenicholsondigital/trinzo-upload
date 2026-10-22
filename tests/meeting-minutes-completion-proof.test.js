'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const V = require('../utils/meetingMinutesAgentV2');
const { generateMeetingMinutesAgentDocx } = require('../utils/meetingMinutesAgentDocx');

process.env.MEETING_MINUTES_AGENT_SPECULATIVE_PIPELINE_V1 = '0';
const fetchPath = require.resolve('node-fetch');
require(fetchPath);
const originalFetch = require.cache[fetchPath].exports;
let providerCalls = 0;
require.cache[fetchPath].exports = async () => {
  providerCalls += 1;
  throw new Error('Provider calls are forbidden in completion-proof tests');
};
const db = require('../utils/db');
const originalGet = db.getMeetingMinutesAgentDraft;
const originalUpdate = db.updateMeetingMinutesAgentDraft;
const copy = value => JSON.parse(JSON.stringify(value));
let saved;
db.getMeetingMinutesAgentDraft = async () => copy(saved);
db.updateMeetingMinutesAgentDraft = async (_id, _userId, revision, updates) => {
  assert.equal(revision, saved.revision);
  saved = copy({ ...V.migrateDraftPayload(updates.payload), draftId: saved.draftId, revision: revision + 1 });
  return copy(saved);
};
const router = require('../routes/api');
const api = router.stagedEvaluation;
db.getMeetingMinutesAgentDraft = originalGet;
db.updateMeetingMinutesAgentDraft = originalUpdate;
require.cache[fetchPath].exports = originalFetch;

function action(wording = 'Explain the calibration procedure.') {
  return { id: 'calibration-action', action: wording, owners: ['Morgan Lee'],
    timing: { kind: 'not_stated', wording: '', exactDate: '' },
    evidenceIds: ['T0001', 'T0002'], reviewFlagIds: [] };
}
function completionCase(quote) {
  const actions = [action()];
  const units = [
    { id: 'T0001', speaker: 'Chair', text: 'Could you explain the calibration procedure?' },
    { id: 'T0002', speaker: 'Morgan Lee', text: quote }
  ];
  const items = V.completedInMeetingCheckItems(actions, units);
  assert.equal(items.length, 1);
  const before = copy({ actions, units, items });
  const result = V.applyCompletedInMeetingCheckResults(actions, items,
    [{ id: items[0].id, verdict: 'completed', completionQuote: quote }]);
  assert.deepEqual({ actions, units, items }, before);
  return { actions, units, result };
}

for (const quote of [
  'I will explain the calibration procedure after the meeting.',
  "I'll explain the calibration procedure tomorrow.",
  'I’ll explain the calibration procedure tomorrow.',
  "I'm going to explain the calibration procedure later.",
  'I’m going to explain the calibration procedure later.',
  'I am going to explain the calibration procedure later.',
  'Let me explain the calibration procedure after lunch.',
  'I can explain the calibration procedure tomorrow.'
]) {
  test('a promise alone cannot prove in-meeting completion: ' + quote, () => {
    assert.equal(V.quoteIsOnlyAPromise(quote), true);
    const { actions, result } = completionCase(quote);
    assert.deepEqual(result.actions, actions);
    assert.deepEqual(result.completed, []);
    assert.deepEqual(result.rejected.map(row => row.reason), ['quote_is_a_promise']);
  });
}

for (const quote of [
  'The operator records the calibration measurement and compares it with the reference.',
  'I have already explained the calibration procedure to the review team.',
  'I explained the calibration procedure during this meeting.'
]) {
  test('genuine delivery evidence still establishes completion: ' + quote, () => {
    const { result } = completionCase(quote);
    assert.equal(result.actions.length, 0);
    assert.equal(result.completed.length, 1);
    assert.deepEqual(result.rejected, []);
  });
}

test('a later actual explanation still proves completion after an earlier promise in the same packet', () => {
  const actions = [action()];
  const promise = 'I will explain the calibration procedure shortly.';
  const delivered = 'The operator records the calibration measurement and compares it with the reference.';
  // Evidence contexts index immutable source arrays; construct the full packet
  // before its first lookup rather than appending to an already-indexed array.
  const units = [
    { id: 'T0001', speaker: 'Chair', text: 'Could you explain the calibration procedure?' },
    { id: 'T0002', speaker: 'Morgan Lee', text: promise },
    { id: 'T0003', speaker: 'Morgan Lee', text: delivered }
  ];
  const items = V.completedInMeetingCheckItems(actions, units);
  assert.ok(items[0].passage.includes(promise));
  assert.ok(items[0].passage.includes(delivered));
  const result = V.applyCompletedInMeetingCheckResults(actions, items,
    [{ id: items[0].id, verdict: 'completed', completionQuote: delivered }]);
  assert.equal(result.actions.length, 0);
  assert.equal(result.completed.length, 1);
  assert.deepEqual(result.rejected, []);
});

const answer = 'The calibration review is on Friday.';
const acceptance = 'Thanks, that answers it.';
function answeredCase(lines, quotes = {}) {
  const actions = [action('Confirm the calibration review date.')];
  const units = lines.map((text, index) => ({
    id: 'T' + String(index + 1).padStart(4, '0'),
    speaker: index === 0 ? 'Chair' : 'Morgan Lee', text
  }));
  const items = V.answeredCheckItems(actions, units);
  assert.equal(items.length, 1);
  const before = copy({ actions, units, items });
  const result = V.applyAnsweredCheckResults(actions, items,
    [{ id: items[0].id, verdict: 'answered', answerQuote: answer, acceptanceQuote: acceptance, ...quotes }]);
  assert.deepEqual({ actions, units, items }, before);
  return { actions, units, result };
}

test('an earlier acknowledgement cannot accept a later question and answer', () => {
  const { actions, result } = answeredCase([acceptance, 'Could you confirm the calibration review date?', answer]);
  assert.deepEqual(result.actions, actions);
  assert.deepEqual(result.answered, []);
});

test('all repeated acknowledgements before the answer remain insufficient', () => {
  const { actions, result } = answeredCase([acceptance, acceptance, answer]);
  assert.deepEqual(result.actions, actions);
  assert.deepEqual(result.answered, []);
});

test('a later acknowledgement works even when the same phrase also appeared earlier', () => {
  const { result } = answeredCase([acceptance, 'Could you confirm the calibration review date?', answer, acceptance]);
  assert.equal(result.actions.length, 0);
  assert.equal(result.answered.length, 1);
});

test('a partial-word occurrence before acceptance cannot stand in for the later complete answer', () => {
  const { actions, result } = answeredCase(['The calibration review is on Fridays.', acceptance, answer]);
  assert.deepEqual(result.actions, actions);
  assert.deepEqual(result.answered, []);
});

test('an acknowledgement following the answer still resolves the action', () => {
  const { result } = answeredCase(['Could you confirm the calibration review date?', answer, acceptance]);
  assert.equal(result.actions.length, 0);
  assert.equal(result.answered.length, 1);
});

test('an answer and its subsequent acceptance may occur in the same turn', () => {
  const { result } = answeredCase(['Could you confirm the calibration review date?', answer + ' ' + acceptance]);
  assert.equal(result.actions.length, 0);
  assert.equal(result.answered.length, 1);
});

test('every complete answer occurrence is considered rather than just the final one', () => {
  const { result } = answeredCase([answer, acceptance, answer]);
  assert.equal(result.actions.length, 0);
  assert.equal(result.answered.length, 1);
});

test('same or overlapping quotation spans cannot supply a separate later acceptance', () => {
  for (const quotes of [
    { acceptanceQuote: answer },
    { acceptanceQuote: 'review is on Friday' },
    { answerQuote: answer + ' ' + acceptance }
  ]) {
    const { actions, result } = answeredCase([answer + ' ' + acceptance], quotes);
    assert.deepEqual(result.actions, actions, JSON.stringify(quotes));
    assert.deepEqual(result.answered, []);
  }
});

test('ordered quote checks keep existing case, punctuation, speaker and adjacent-turn normalization', () => {
  const { result } = answeredCase([
    'Could you confirm the calibration review date?',
    'The calibration review',
    'is on Friday! THANKS, THAT ANSWERS IT.'
  ], { answerQuote: 'Morgan Lee: ' + answer, acceptanceQuote: '“Thanks, that answers it.”' });
  assert.equal(result.actions.length, 0);
  assert.equal(result.answered.length, 1);
});

test('ordering does not relax exact quotation or minimum length requirements', () => {
  for (const quotes of [
    { answerQuote: 'The calibration review is on Thursday.' },
    { acceptanceQuote: 'that answers' },
    { acceptanceQuote: 'Thanks, that answer' },
    { answerQuote: Array(46).fill('review').join(' ') }
  ]) {
    const { actions, result } = answeredCase([answer, acceptance], quotes);
    assert.deepEqual(result.actions, actions, JSON.stringify(quotes));
    assert.deepEqual(result.answered, []);
  }
});

function baseDraft(actions, sourceUnits) {
  return { draftId: 'completion-proof', revision: 1, status: 'draft', payloadVersion: V.PAYLOAD_VERSION,
    details: { meetingTitle: 'Calibration review', meetingType: 'General', meetingDate: '2026-10-21',
      internalAttendees: ['Morgan Lee'], clientAttendees: [] },
    sourceUnits, preparedTranscript: V.preparedTranscriptFromUnits(sourceUnits),
    discussion: [], actions: copy(actions), pendingProposal: null, reviewFlags: [],
    executiveSummary: '', meetingObjectives: [], changeHistory: [], redoHistory: [], staleStages: [],
    currentStep: 5, selectedStep: 5,
    qualityState: { preparation: { dateContext: { source: 'reviewer', meetingDate: '2026-10-21' } } } };
}
async function request(method, suffix = '', body = {}) {
  const route = router.stack.find(layer => layer.route?.path === '/meeting-minutes-agent/drafts/:draftId' + suffix
    && layer.route.methods[method])?.route;
  assert.ok(route);
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; } };
  await route.stack.at(-1).handle({ params: { draftId: saved.draftId }, authUser: { userId: 'proof-reviewer' },
    body: { revision: saved.revision, ...body } }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(providerCalls, 0);
  return res.body.draft;
}

for (const kind of ['promise', 'earlier-acceptance']) {
  test(kind + ' rejection retains action fields through serialization, real save/reload, undo/redo and ordinary exports', async () => {
    const fixture = kind === 'promise'
      ? completionCase('I will explain the calibration procedure after the meeting.')
      : answeredCase([acceptance, 'Could you confirm the calibration review date?', answer]);
    assert.deepEqual(fixture.result.actions, fixture.actions);
    saved = baseDraft(fixture.result.actions, fixture.units);
    const fields = row => ({ id: row.id, action: row.action, owners: row.owners,
      // Existing save normalization may rank citations; membership must remain exact.
      timing: row.timing, evidenceIds: [...row.evidenceIds].sort() });
    const assertKept = draft => {
      assert.equal(draft.actions.length, 1);
      assert.deepEqual(fields(draft.actions[0]), fields(fixture.actions[0]));
      assert.equal(draft.pendingProposal, null);
    };
    assertKept(api.meetingAgentDraftPayload(saved));
    assertKept(await request('patch', '', { actions: copy(saved.actions), reviewDecisionLabel: 'Retain source-unresolved follow-up' }));
    assertKept(await request('get'));
    assertKept(await request('post', '/undo'));
    assertKept(await request('post', '/redo'));
    const pdf = api.meetingAgentDraftForPdf(saved, false);
    assert.equal(pdf.actions.length, 1);
    assert.equal(pdf.actions[0].action, fixture.actions[0].action);
    const zip = await JSZip.loadAsync(await generateMeetingMinutesAgentDocx(api.meetingAgentDraftForDocx(saved), false));
    assert.ok((await zip.file('word/document.xml').async('string')).includes(fixture.actions[0].action));
    assert.equal(providerCalls, 0);
  });
}
