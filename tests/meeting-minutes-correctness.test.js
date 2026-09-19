'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const V = require('../utils/meetingMinutesAgentV2');
const O = require('../utils/canonicalMinutes/discussionOrganiser');

// Real sentences from an evaluation transcript, as the live preparer splits them.
const units = [
  { id: 'T0066', speaker: 'Jacqui Fox', text: "Andrew is off at the moment, so we'll get the." },
  { id: 'T0067', speaker: 'Jacqui Fox', text: 'Bottomed out by the end of the week, hopefully, and that the GUIs for the full translation files of those 12 languages are available, and so therefore, once the symbol issue is resolved, we should be in a position to fully upload the true translations into the software.' },
  { id: 'T0068', speaker: 'Jacqui Fox', text: 'So in effect, the two code changes that were needed should be completed in total by the end of next week.' },
  { id: 'T0069', speaker: 'Jacqui Fox', text: 'And what that will give you as a final output is a new version of the software.' },
  { id: 'T0100', speaker: 'Rebecca Gill', text: 'I went back to Colm yesterday.' },
  { id: 'T0101', speaker: 'Rebecca Gill', text: 'Sorry, I had it was I think I had in an earlier call.' },
  { id: 'T0102', speaker: 'Rebecca Gill', text: 'I presumed that the formative would be ready for submission and then to follow up with the summative.' },
  { id: 'T0103', speaker: 'Rebecca Gill', text: 'But I think maybe that slightly changed with what could be achieved between now and then and that this the formula would be ready to be just shortly after, but still prior to.' },
  { id: 'T0180', speaker: 'Rebecca Gill', text: 'Yesterday, yeah.' },
  { id: 'T0181', speaker: 'Rebecca Gill', text: "We have a call today to walk kind of through that and make sure we've got everything where we need to be, especially the response to the cars." },
  { id: 'T0182', speaker: 'Rebecca Gill', text: 'And then hopefully get everything just loaded on the call me docs for Grace to kind of review and approve.' },
  { id: 'T0183', speaker: 'Jacqui Fox', text: 'Okay.' },
  { id: 'T0200', speaker: 'Dan Threlfall', text: "We need another, if it's twenty-one total and we've got eighteen, get another, say, six sacks to have a buffer." },
  { id: 'T0201', speaker: 'Mick Dolan', text: "I'll put the order in." },
  { id: 'T0202', speaker: 'Dan Threlfall', text: 'Actually, hang on, let me do that one, I get a better rate from the maltster than we do on the account.' },
  { id: 'T0210', speaker: 'Jacqui Fox', text: 'So we agreed to keep the weekend cover internal for the rollout.' },
  { id: 'T0211', speaker: 'Rebecca Gill', text: 'Yes, agreed, internal cover it is.' },
  { id: 'T0212', speaker: 'Jacqui Fox', text: 'The rollout team will be briefed next week by the service desk.' }
];

const withChecks = (fn) => {
  const previous = process.env.MEETING_MINUTES_AGENT_CORRECTNESS_V1;
  process.env.MEETING_MINUTES_AGENT_CORRECTNESS_V1 = '1';
  try { return fn(); } finally { process.env.MEETING_MINUTES_AGENT_CORRECTNESS_V1 = previous; }
};
const timing = (wording, kind = 'target') => ({ kind, wording, exactDate: '' });

test('a timing lifted from a neighbouring step is reassigned to the step that owns it', () => {
  const issue = V.timingClauseIssue('Finalize the two code changes to produce a new software version.',
    timing('end of the week'), units, ['T0067', 'T0068']);
  assert.deepEqual(issue, { type: 'reassign', from: 'end of the week', to: 'end of next week' });
});

test('a timing is not removed when the better-matching clause states no timing of its own', () => {
  // On live meetings removal guessed wrong more often than right, so only a
  // clear reassignment is acted on.
  assert.equal(V.timingClauseIssue('Upload the response documents for Grace to review and approve, then direct the auditor to them.',
    timing('today', 'deadline'), units, ['T0181', 'T0182']), null);
});

test('a timing spoken with its own step, a correct timing, and a condition are all left alone', () => {
  assert.equal(V.timingClauseIssue('Conduct a call to walk through the response to the CARs, then load the documents for Grace to review and approve.',
    timing('today', 'deadline'), units, ['T0181', 'T0182']), null);
  assert.equal(V.timingClauseIssue('Resolve the language symbol compatibility issue for Arabic, Vietnamese and Greek.',
    timing('end of the week'), units, ['T0067']), null);
  assert.equal(V.timingClauseIssue('Finalize the two code changes to produce a new software version.',
    timing('end of next week'), units, ['T0067', 'T0068']), null);
  assert.equal(V.timingClauseIssue('Upload the response documents for Grace to review and approve.',
    timing('once the call is done', 'dependency'), units, ['T0181', 'T0182']), null);
});

test('published agent actions are corrected once, each change flagged, and a second pass changes nothing', () => withChecks(() => {
  const actions = [{
    id: 'a1', action: 'Finalize the two code changes to produce a new software version.', owners: [],
    timing: { kind: 'target', wording: 'end of the week', exactDate: '' }, evidenceIds: ['T0067', 'T0068'], reviewFlagIds: []
  }, {
    id: 'a2', action: 'Upload the response documents for Grace to review and approve, then direct the auditor to them.', owners: [],
    timing: { kind: 'deadline', wording: 'today', exactDate: '' }, evidenceIds: ['T0181', 'T0182'], reviewFlagIds: []
  }];
  const first = V.applyTimingClauseChecks(actions, units, { meetingDate: '2026-06-17' });
  assert.equal(first.actions[0].timing.wording, 'end of next week');
  assert.equal(first.actions[1].timing.wording, 'today', 'no reassignment available, so left alone');
  assert.equal(first.flags.length, 1);
  assert.ok(first.actions[0].reviewFlagIds.some((id) => first.flags.some((flag) => flag.id === id)));
  const second = V.applyTimingClauseChecks(first.actions, units, { meetingDate: '2026-06-17' });
  assert.equal(second.flags.length, 0, 'stable once corrected');
}));

test('intermediate normalisation of agent output never touches a timing silently', () => withChecks(() => {
  const result = V.normaliseAgentResult({ actions: [{
    id: 'a1', action: 'Finalize the two code changes to produce a new software version.', owners: [],
    timing: { kind: 'target', wording: 'end of the week' }, evidenceIds: ['T0067', 'T0068']
  }] }, units, 'actions', { meetingDate: '2026-06-17' });
  assert.equal(result.actions[0].timing.wording, 'end of the week');
}));

test('a timing whose clause names the work only by pronoun keeps its timing', () => {
  const pronounUnits = [
    { id: 'T0300', speaker: 'Jacqui Fox', text: 'So the next steps are to load the fully translated language files.' },
    { id: 'T0301', speaker: 'Jacqui Fox', text: 'Okay, so again, should be able to get that done next week, presumably.' },
    { id: 'T0302', speaker: 'Andrew Kane', text: 'Arabic, Vietnamese and Greek might be a problem for the language symbols.' }
  ];
  assert.equal(V.timingClauseIssue('Load the translated language files and check the language symbols for Arabic, Vietnamese and Greek.',
    timing('next week'), pronounUnits, ['T0300', 'T0301', 'T0302']), null);
});

test('a reviewer\'s own timing is never rewritten, only flagged', () => withChecks(() => {
  process.env.MEETING_MINUTES_AGENT_TIMING_CLAUSE_V1 = '1';
  const saved = V.normaliseAgentResult({ actions: [{
    id: 'a1', action: 'Finalize the two code changes to produce a new software version.',
    owners: [], timing: { kind: 'target', wording: 'end of the week' }, evidenceIds: ['T0067', 'T0068']
  }] }, units, 'actions', { meetingDate: '2026-06-17', enforceEvidence: false });
  assert.equal(saved.actions[0].timing.wording, 'end of the week');
  assert.ok(saved.reviewFlags.some((flag) => flag.kind === 'timing' && /"end of next week" for this one/.test(flag.message)));
  process.env.MEETING_MINUTES_AGENT_TIMING_CLAUSE_V1 = '0';
}));

test('an uncited sentence the meeting never supports gets no citations and a missing-evidence flag', () => withChecks(() => {
  const saved = V.normaliseAgentResult({ discussion: [{ topic: 'Software', points: [
    { id: 'p1', text: 'The team agreed to relocate the factory to Mars next quarter.' },
    { id: 'p2', text: 'The two code changes should be completed by the end of next week.' }
  ], decisions: [], openQuestions: [] }] }, units, 'discussion', { enforceEvidence: false });
  const [mars, real] = saved.discussion[0].points;
  assert.deepEqual(mars.evidenceIds, []);
  assert.ok(saved.reviewFlags.some((flag) => mars.reviewFlagIds.includes(flag.id) && flag.kind === 'missing_evidence'));
  assert.ok(real.evidenceIds.includes('T0068'), 'a genuine uncited sentence still finds its passage');
}));

test('a statement its speaker revises shortly afterwards is flagged and cited with the revision', () => withChecks(() => {
  const saved = V.normaliseAgentResult({ discussion: [{ topic: 'Usability', points: [
    { id: 'p1', text: 'The formative study will be ready before the submission.', evidenceIds: ['T0102'] }
  ], decisions: [], openQuestions: [] }] }, units, 'discussion');
  const row = saved.discussion[0].points[0];
  assert.ok(row.evidenceIds.includes('T0103'));
  assert.ok(saved.reviewFlags.some((flag) => row.reviewFlagIds.includes(flag.id) && /revise this/.test(flag.message)));
}));

test('a conversational "actually" that only changes who does something is not a revision of the fact', () => {
  assert.equal(V.laterRevisionUnit(units, ['T0200']), null);
});

test('the timing-ownership rule is off unless its own flag is set', () => withChecks(() => {
  const saved = V.normaliseAgentResult({ actions: [{
    id: 'a1', action: 'Finalize the two code changes to produce a new software version.',
    owners: [], timing: { kind: 'target', wording: 'end of the week' }, evidenceIds: ['T0067', 'T0068']
  }] }, units, 'actions', { meetingDate: '2026-06-17', enforceEvidence: false });
  assert.ok(!saved.reviewFlags.some((flag) => flag.kind === 'timing'));
}));

test('"No," opening a reply is an answer, not a revision', () => {
  const answerUnits = [
    { id: 'T0400', speaker: 'Jenny Gough', text: 'Some large companies have submitted English-only declarations without pushback.' },
    { id: 'T0401', speaker: 'Jenny Gough', text: 'No, but the notified body has not picked up that there were no other language declarations.' }
  ];
  assert.equal(V.laterRevisionUnit(answerUnits, ['T0400']), null);
});

test('with the flag off nothing changes', () => {
  const previous = process.env.MEETING_MINUTES_AGENT_CORRECTNESS_V1;
  process.env.MEETING_MINUTES_AGENT_CORRECTNESS_V1 = '0';
  try {
    const result = V.normaliseAgentResult({ actions: [{
      id: 'a1', action: 'Finalize the two code changes to produce a new software version.', owners: [],
      timing: { kind: 'target', wording: 'end of the week' }, evidenceIds: ['T0067', 'T0068']
    }] }, units, 'actions', { meetingDate: '2026-06-17' });
    assert.equal(result.actions[0].timing.wording, 'end of the week');
  } finally { process.env.MEETING_MINUTES_AGENT_CORRECTNESS_V1 = previous; }
});

test('an explicitly agreed point with a recorded agreement becomes a decision; plans stay points', () => withChecks(() => {
  const index = O.unitIndex(units);
  const topic = O.retypeRows({ topic: 'Rollout', points: [
    { id: 'p1', text: 'The team agreed to keep the weekend cover internal for the rollout.', evidenceIds: ['T0210', 'T0211'] },
    { id: 'p4', text: 'Plan to load the approved documents into the tech file.', evidenceIds: ['T0211'] },
    { id: 'p2', text: 'The rollout team will be briefed next week by the service desk.', evidenceIds: ['T0212'] },
    { id: 'p3', text: 'Agreed to keep the weekend cover internal.', evidenceIds: ['T0210'], reviewFlagIds: ['f1'] }
  ], decisions: [], openQuestions: [] }, index);
  assert.deepEqual(topic.decisions.map((row) => row.id), ['p1']);
  assert.deepEqual(topic.points.map((row) => row.id), ['p4', 'p2', 'p3'], 'flagged rows and adjectival "approved" are never promoted');
}));

test('statedCalendarDate reads day and month wording relative to the meeting', () => {
  const { statedCalendarDate } = require('../utils/meetingMinutesAgentV2');
  assert.equal(statedCalendarDate('by 17th June', '2026-06-22'), '2026-06-17');
  assert.equal(statedCalendarDate('ideally before July 17th', '2026-06-22'), '2026-07-17');
  assert.equal(statedCalendarDate('by 10 January', '2026-12-05'), '2027-01-10');
  assert.equal(statedCalendarDate('by the 17th', '2026-06-22'), '');
  assert.equal(statedCalendarDate('may be done soon', '2026-06-22'), '');
});

test('a stated date before the meeting is removed from agent output and flagged', () => {
  const previous = process.env.MEETING_MINUTES_AGENT_CORRECTNESS_V1;
  process.env.MEETING_MINUTES_AGENT_CORRECTNESS_V1 = '1';
  try {
    const V = require('../utils/meetingMinutesAgentV2');
    const units = [
      { id: 'T0001', speaker: 'Stuart Smith', text: 'I will need the training attestation before the audit formally starts.' },
      { id: 'T0002', speaker: 'Jacqui Fox', text: 'The 20th, so by the 17th then.' }
    ];
    const result = V.normaliseAgentResult({ actions: [{ id: 'a', action: 'Provide the training attestation to Stuart Smith before the audit formally starts.', owners: ['Stuart Smith'], timing: { kind: 'deadline', wording: 'by 17th June' }, evidenceIds: ['T0001', 'T0002'] }] }, units, 'actions', { meetingDate: '2026-06-22' });
    assert.equal(result.actions[0].timing.kind, 'not_stated');
    assert.ok(result.reviewFlags.some((flag) => /before the meeting/.test(flag.message)));
    const later = V.normaliseAgentResult({ actions: [{ id: 'a', action: 'Provide the training attestation to Stuart Smith before the audit formally starts.', owners: ['Stuart Smith'], timing: { kind: 'deadline', wording: 'by 17th July' }, evidenceIds: ['T0001', 'T0002'] }] }, units, 'actions', { meetingDate: '2026-06-22' });
    assert.ok(!later.reviewFlags.some((flag) => /before the meeting/.test(flag.message)));
  } finally {
    if (previous === undefined) delete process.env.MEETING_MINUTES_AGENT_CORRECTNESS_V1; else process.env.MEETING_MINUTES_AGENT_CORRECTNESS_V1 = previous;
  }
});

test('a row citing both an assumption and its correction is flagged', () => {
  const previous = process.env.MEETING_MINUTES_AGENT_CORRECTNESS_V1;
  process.env.MEETING_MINUTES_AGENT_CORRECTNESS_V1 = '1';
  try {
    const V = require('../utils/meetingMinutesAgentV2');
    const units = [
      { id: 'T0001', speaker: 'Rebecca Gill', text: 'I presumed that the formative would be ready for submission and then to follow up with the summative.' },
      { id: 'T0002', speaker: 'Rebecca Gill', text: 'But I think maybe that slightly changed and the formative would be ready shortly after, but still prior to the tech file being lifted.' },
      { id: 'T0003', speaker: 'Adil Kauim', text: 'I finished the task analysis with Alan last week.' }
    ];
    const out = V.normaliseAgentResult({ discussion: [{ topic: 'Formative', points: [
      { text: 'The formative will be ready before the summative submission.', evidenceIds: ['T0001', 'T0002'] },
      { text: 'Adil finished the task analysis with Alan.', evidenceIds: ['T0003'] }
    ] }] }, units, 'discussion', {});
    assert.equal(out.discussion[0].points[0].reviewFlagIds.length, 1);
    assert.equal(out.discussion[0].points[1].reviewFlagIds.length, 0);
    assert.ok(out.reviewFlags.some((flag) => /Conflicting passage/.test(flag.message)));
  } finally {
    if (previous === undefined) delete process.env.MEETING_MINUTES_AGENT_CORRECTNESS_V1; else process.env.MEETING_MINUTES_AGENT_CORRECTNESS_V1 = previous;
  }
});

test('a person who only asks someone else to do the work is not its owner', () => {
  const V = require('../utils/meetingMinutesAgentV2');
  const units = [
    { id: 'T0001', speaker: 'Jacqui Fox', text: 'The devices need to be registered and that lies with MedEnvoy.' },
    { id: 'T0002', speaker: 'Jacqui Fox', text: "So if you're talking to Cody, could you just maybe mention it to him?" },
    { id: 'T0003', speaker: 'Orla Skally', text: 'Yes, I can do that.' },
    { id: 'T0010', speaker: 'Ciaran Ryan', text: "I'm going to focus on TF03 this week." }
  ];
  const out = V.applyRequesterOwnerRule([
    { action: 'Mention the registration alignment to Cody.', owners: ['Jacqui Fox'], evidenceIds: ['T0001', 'T0002'] },
    { action: 'Complete TF03.', owners: ['Ciaran Ryan'], evidenceIds: ['T0010'] }
  ], units);
  assert.deepEqual(out.actions[0].owners, []);
  assert.match(out.flags[0].message, /Owner unclear: Jacqui Fox asked someone else/);
  assert.deepEqual(out.actions[1].owners, ['Ciaran Ryan']);
});

test('a row restating a corrected assumption leaves the primary rows; one stating the correction stays', () => {
  const previous = process.env.MEETING_MINUTES_AGENT_CORRECTNESS_V1;
  process.env.MEETING_MINUTES_AGENT_CORRECTNESS_V1 = '1';
  try {
    const V = require('../utils/meetingMinutesAgentV2');
    const units = [
      { id: 'T0001', speaker: 'Rebecca Gill', text: 'I presumed that the formative would be ready for submission and then to follow up with the summative.' },
      { id: 'T0002', speaker: 'Rebecca Gill', text: 'But I think maybe that slightly changed and the formula would be ready to be just shortly after, but still prior to.' },
      { id: 'T0003', speaker: 'Rebecca Gill', text: 'Um, the protect file being lifted.' },
      { id: 'T0004', speaker: 'Adil Kauim', text: 'I finished the task analysis with Alan last week.' }
    ];
    const discussion = (row) => [{ topic: 'Formative', points: [
      { id: 'r1', text: row, evidenceIds: ['T0001', 'T0002'], reviewFlagIds: ['flag-x'] },
      { id: 'r2', text: 'Adil finished the task analysis with Alan.', evidenceIds: ['T0004'] }
    ] }];
    const wrong = discussion('Formative document readiness is anticipated shortly, prior to the summative submission.');
    const moved = V.demoteSupersededRows(wrong, units, V.supersededVerdicts(V.supersededCheckItems(wrong, units)));
    assert.equal(moved.demoted, 1);
    assert.deepEqual(moved.discussion[0].points.map((row) => row.id), ['r2']);
    assert.equal(moved.discussion[0].points[0].supportingDetails[0].text, 'Formative document readiness is anticipated shortly, prior to the summative submission.');
    const right = discussion('Formative expected shortly after submission but prior to the protect file being lifted.');
    const kept = V.demoteSupersededRows(right, units, V.supersededVerdicts(V.supersededCheckItems(right, units)));
    assert.equal(kept.demoted, 0);
  } finally {
    if (previous === undefined) delete process.env.MEETING_MINUTES_AGENT_CORRECTNESS_V1; else process.env.MEETING_MINUTES_AGENT_CORRECTNESS_V1 = previous;
  }
});
