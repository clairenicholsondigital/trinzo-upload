'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

Object.assign(process.env, {
  POWER_AUTOMATE_AGENT_WEBHOOK_URL: 'https://routine-minutes.fixture.invalid',
  MEETING_MINUTES_AGENT_CORRECTNESS_V1: '1',
  MEETING_MINUTES_AGENT_CALL_START_GAP_MS: '1000',
  MEETING_MINUTES_AGENT_MAX_ACTIVE_CALLS: '4',
  MEETING_MINUTES_AGENT_ACTION_REFEREE_BATCH_SIZE: '8',
  MEETING_MINUTES_AGENT_PRIMARY_UNION_V1: '0',
  MEETING_MINUTES_AGENT_COMMITMENT_DEDUPE_V1: '0',
  MEETING_MINUTES_AGENT_FAST_ACTION_PATH_V1: '1',
  MEETING_MINUTES_AGENT_TIMING_CHECK_V1: '0',
  MEETING_MINUTES_AGENT_COMMITMENT_CHECK_V1: '0',
  MEETING_MINUTES_AGENT_ANSWERED_CHECK_V1: '0',
  MEETING_MINUTES_AGENT_DECISION_CHECK_V1: '0',
  MEETING_MINUTES_AGENT_SPECULATIVE_PIPELINE_V1: '0',
  MEETING_MINUTES_AGENT_REPLAY_PASS_CACHE: '0',
  MEETING_MINUTES_AGENT_MINUTE_INSTRUCTION_V1: '1',
  MEETING_MINUTES_AGENT_SEMANTIC_RECONCILIATION_V1: 'off'
});
const forbidden = [];
const deny = label => () => { forbidden.push(label); throw new Error('Offline routine-minutes test forbids ' + label); };
for (const name of ['http', 'https', 'net', 'tls', 'dgram']) {
  const instance = require(name);
  for (const key of ['request', 'get', 'connect', 'createConnection', 'createServer', 'createSocket']) {
    if (typeof instance[key] === 'function') instance[key] = deny(name + '.' + key);
  }
}
global.fetch = deny('fetch');
let transport = deny('unexpected provider stub request');
const originalLoad = Module._load;
let router;
Module._load = function (name) {
  if (name === 'node-fetch') return (...args) => transport(...args);
  if (name === 'pg') return { Pool: class { constructor() { deny('pg.Pool')(); } } };
  if (name === 'child_process') return new Proxy({}, { get: (_, key) => deny('child_process.' + String(key)) });
  return originalLoad.apply(this, arguments);
};
try { router = require('../routes/api'); }
finally { Module._load = originalLoad; }
const A = router.stagedEvaluation;
const V = require('../utils/meetingMinutesAgentV2');
const copy = value => JSON.parse(JSON.stringify(value));
const action = (id, wording, evidenceIds, extra = {}) => ({
  id, action: wording, owners: ['Morgan Lee'], evidenceIds, reviewFlagIds: [],
  timing: { kind: 'not_stated', wording: '', exactDate: '' }, ...extra
});

test('bare current-call note-taking reaches the existing minute-instruction review path', () => {
  for (const wording of ['Take notes during the meeting.', 'Take notes during this call.', 'Keep notes for this meeting.']) {
    assert.equal(V.isMinuteInstruction(wording), true, wording);
    assert.equal(V.isMeetingAdminAction(wording), false, 'do not discard before the unticked proposal: ' + wording);
  }
});

test('later minute deliverables and mixed substantive work are not meeting administration', () => {
  for (const wording of [
    'Send the minutes to the client by Friday.',
    'Prepare the meeting minutes for the board review next week.',
    'Circulate the minutes to Jordan Cole after approval.',
    'Produce the minutes as the contractual formal record.',
    'Write up the meeting notes for the technical file.',
    'Take validation notes during the client audit next week.',
    'Take notes during the meeting and send the signed test results tomorrow.',
    'Send the meeting minutes and review the signed design record.'
  ]) {
    assert.equal(V.isMeetingAdminAction(wording), false, wording);
    assert.equal(V.isMinuteInstruction(wording), false, wording);
  }
});

test('bare minute routines keep explicit timing, source deliverables and reviewer intent', () => {
  const wording = 'Prepare the meeting minutes.';
  for (const context of [
    { action: action('timed', wording, ['T0001'], { timing: { kind: 'deadline', wording: 'Friday', exactDate: '' } }) },
    { action: action('manual', wording, ['T0001'], { reviewerAuthored: true }) },
    { action: action('formal', wording, ['T0001']), sourceUnits: [
      { id: 'T0001', speaker: 'Morgan Lee', text: 'I will prepare the meeting minutes as the formal record required by the contract.' }
    ] },
    { action: action('future', wording, ['T0001']), sourceUnits: [
      { id: 'T0001', speaker: 'Morgan Lee', text: "I will prepare the minutes for next week's board meeting." }
    ] },
    ...['later', 'in two weeks', 'on Friday', 'on 26 October', 'when the review is approved'].map(timing => ({
      action: action('source-timed-' + timing, wording, ['T0001']),
      sourceUnits: [{ id: 'T0001', speaker: 'Morgan Lee', text: 'I will prepare the meeting minutes ' + timing + '.' }]
    })),
    { action: action('recipient', wording, ['T0001']), sourceUnits: [
      { id: 'T0001', speaker: 'Morgan Lee', text: 'I will prepare the meeting minutes and send them to Jordan Cole.' }
    ] }
  ]) assert.equal(V.isMinuteInstruction(wording, context), false, JSON.stringify(context));
  const ordinary = action('routine', 'Take notes during this meeting.', ['T0001']);
  assert.equal(V.isMinuteInstruction(ordinary.action, { action: ordinary, sourceUnits: [
    { id: 'T0001', speaker: 'Morgan Lee', text: 'I will take notes during this meeting.' },
    { id: 'T0002', speaker: 'Jordan Cole', text: 'The next meeting has a formal contractual reporting requirement.' }
  ] }), true, 'an unrelated uncited future/formal statement cannot override this routine');
  for (const source of [
    'I may take notes during this meeting.',
    'I will first take notes during this meeting.',
    'The notes for this meeting will be taken by Morgan Lee.'
  ]) assert.equal(V.isMinuteInstruction(ordinary.action, { action: ordinary, sourceUnits: [
    { id: 'T0001', speaker: 'Morgan Lee', text: source }
  ] }), true, source);
  assert.equal(V.isMinuteInstruction('Send the meeting minutes.'), true, 'preserve the established bare routine contract');
  assert.equal(V.isMinuteInstruction('Record in the minutes that approval is outstanding.'), true);
});

test('the real generated pipeline defers note-taking and preserves later minute work through save, public view and survival', async () => {
  const units = [
    { id: 'T0001', sequence: 1, speaker: 'Morgan Lee', text: 'I will take notes during this meeting.' },
    { id: 'T0002', sequence: 2, speaker: 'Morgan Lee', text: 'I will send the meeting minutes to Jordan Cole by Friday.' },
    { id: 'T0003', sequence: 3, speaker: 'Morgan Lee', text: "I will prepare the minutes for next week's client review." },
    { id: 'T0004', sequence: 4, speaker: 'Morgan Lee', text: 'I will send the signed test results to Jordan Cole tomorrow.' },
    { id: 'T0005', sequence: 5, speaker: 'Jordan Cole', text: 'I will prepare the meeting minutes as the formal record required by the contract.' }
  ];
  const primary = [
    action('note', 'Take notes during the meeting.', ['T0001']),
    action('send', 'Send the meeting minutes to Jordan Cole by Friday.', ['T0002']),
    action('prepare', "Prepare the minutes for next week's client review.", ['T0003']),
    action('results', 'Send the signed test results to Jordan Cole tomorrow.', ['T0004']),
    action('formal', 'Prepare the meeting minutes.', ['T0005'], { owners: ['Jordan Cole'] })
  ];
  const sourceApproval = [];
  transport = async (url, options) => {
    assert.equal(url, process.env.POWER_AUTOMATE_AGENT_WEBHOOK_URL);
    const prompt = JSON.parse(options.body).input.prompt;
    let result;
    if (prompt.startsWith('[ACTION_REFEREE]')) {
      const payload = JSON.parse(prompt.split('refereePayload:\n')[1]);
      const dispositions = payload.candidateEnsemble.map(candidate => ({
        candidateId: candidate.candidateId,
        disposition: candidate.recordType === 'action' ? 'publish' : 'reject',
        reason: 'The source explicitly assigns this work to the named owner.',
        evidenceIds: candidate.evidenceIds
      }));
      sourceApproval.push(...dispositions);
      result = { requestId: payload.requestId, stage: payload.stage,
        expectedCandidateCount: payload.expectedCandidateCount,
        returnedDispositionCount: dispositions.length,
        candidateDispositions: dispositions, discussion: [], actions: [], actionProposals: [] };
    } else if (prompt.startsWith('ACTION_DISCOVERY')) result = { discussion: [], actions: primary };
    else result = { discussion: [], actions: [], actionProposals: [], candidateDispositions: [], results: [] };
    return { ok: true, status: 200, text: async () => JSON.stringify(result) };
  };
  const draft = { draftId: 'routine-minutes-offline', revision: 1, payloadVersion: V.PAYLOAD_VERSION,
    status: 'draft', currentStep: 2,
    details: { meetingTitle: 'Operational review', meetingType: 'General', meetingDate: '2026-10-21',
      internalAttendees: ['Morgan Lee'], clientAttendees: ['Jordan Cole'] },
    sourceUnits: units, preparedTranscript: V.preparedTranscriptFromUnits(units),
    discussion: [], actions: [], reviewFlags: [], qualityState: {}, passCache: [], candidateLedger: [], staleStages: [] };
  draft.candidateLedger = primary.map(row => ({
    candidateId: 'cached-' + row.id, sourcePass: 'staged', recordType: 'action', text: row.action,
    evidenceIds: row.evidenceIds, record: copy(row),
    timingInferenceVersion: V.TIMING_INFERENCE_POLICY_VERSION,
    timingInferenceInputKey: A.privateStagedCandidateCacheKey(draft, 'actions')
  }));
  const generated = await A.generateHybridMeetingAgentStage(copy(draft), 'actions');
  assert.ok(sourceApproval.length, 'the actual source-referee boundary runs');
  assert.equal(generated.changes.actions.some(row => /^Take notes during the meeting[.]?$/.test(row.action)), false);
  const retainedDeliverables = rows => {
    assert.ok(rows.some(row => /meeting minutes/i.test(row.action) && /Jordan Cole/i.test(row.action) && /Friday/i.test(row.action)),
      'later minute delivery retains its object, recipient and deadline');
    assert.ok(rows.some(row => /Prepare the minutes for next week/i.test(row.action) && /client review/i.test(row.action)),
      'future minute preparation survives');
    assert.ok(rows.some(row => /signed test results/i.test(row.action) && /Jordan Cole/i.test(row.action) && /tomorrow/i.test(row.action)),
      'substantive result delivery retains its recipient and timing');
    assert.ok(rows.some(row => /meeting minutes/i.test(row.action) && row.owners.includes('Jordan Cole')),
      'a shortened minute candidate retains directly cited formal deliverable context through the real filter');
  };
  retainedDeliverables(generated.changes.actions);
  const note = generated.changes.pendingProposal?.changes?.find(change => change.id.startsWith('change-minute-note-'));
  assert.ok(note, 'the full routine row remains recoverable in an unticked proposal');
  assert.equal(note.selected, false);
  assert.equal(note.after.action, primary[0].action);
  assert.deepEqual(note.after.owners, primary[0].owners);
  assert.deepEqual(note.after.evidenceIds, primary[0].evidenceIds);
  let saved = copy(draft);
  await A.persistMeetingAgentBackgroundStage({
    draftId: draft.draftId, userId: 'offline-reviewer', stage: 'actions', sourceDraft: draft, result: generated,
    getDraft: async () => copy(saved),
    saveDraft: async (_draft, changes) => { saved = copy({ ...saved, ...changes, revision: saved.revision + 1 }); return copy(saved); }
  });
  const visible = A.publicMeetingAgentDraft(copy(saved));
  assert.equal(visible.actions.some(row => /^Take notes during the meeting[.]?$/.test(row.action)), false);
  assert.ok(visible.pendingProposal.changes.some(change => change.id === note.id && change.selected === false));
  retainedDeliverables(visible.actions);
  const survival = A.reconcileFinalApprovedActions(visible.actions, generated.changes.actions);
  assert.equal(survival.actions.some(row => /^Take notes during the meeting[.]?$/.test(row.action)), false);
  assert.deepEqual(forbidden, []);
});

test('historical and explicitly reviewed note-taking remains literal at publication', () => {
  const row = action('manual-notes', 'Take notes during the meeting.', ['T0001'], { reviewerAuthored: true });
  const draft = { details: { meetingDate: '2026-10-21' }, sourceUnits: [
    { id: 'T0001', speaker: 'Morgan Lee', text: 'I will take notes.' }
  ], actions: [row], discussion: [], reviewFlags: [] };
  assert.equal(A.publicMeetingAgentDraft(copy(draft)).actions[0].action, row.action);
  delete row.reviewerAuthored;
  assert.equal(A.publicMeetingAgentDraft(copy(draft)).actions[0].action, row.action, 'this rule is fresh-generation only');
});
