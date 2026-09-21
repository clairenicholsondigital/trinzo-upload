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
  assert.match(out.flags[0].message, /Owner unclear: the cited evidence does not show Jacqui Fox taking this on/);
  assert.deepEqual(out.actions[1].owners, ['Ciaran Ryan']);
});

test('a collective we statement or a mere name mention does not prove individual ownership', () => {
  const V = require('../utils/meetingMinutesAgentV2');
  const units = [
    { id: 'T0200', speaker: 'Jacqui Fox', text: 'We will produce the report for Karl.' },
    { id: 'T0201', speaker: 'Gareth Long', text: 'Jacqui raised the report while we reviewed the findings.' }
  ];
  const out = V.applyRequesterOwnerRule([{
    action: 'Produce the report for Karl.', owners: ['Jacqui Fox'], evidenceIds: ['T0200', 'T0201']
  }], units);
  assert.deepEqual(out.actions[0].owners, []);
  assert.equal(out.flags[0].kind, 'ownership');
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
    assert.equal(moved.discussion[0].points[0].supportingDetails[0].text, 'Earlier position, revised later in the meeting: Formative document readiness is anticipated shortly, prior to the summative submission.');
    assert.deepEqual(moved.discussion[0].points[0].supportingDetails[0].reviewFlagIds, ['flag-x']);
    const right = discussion('Formative expected shortly after submission but prior to the protect file being lifted.');
    const kept = V.demoteSupersededRows(right, units, V.supersededVerdicts(V.supersededCheckItems(right, units)));
    assert.equal(kept.demoted, 0);
  } finally {
    if (previous === undefined) delete process.env.MEETING_MINUTES_AGENT_CORRECTNESS_V1; else process.env.MEETING_MINUTES_AGENT_CORRECTNESS_V1 = previous;
  }
});

test('records sharing an identical flag all keep a reference to the flag that is kept', () => {
  const V = require('../utils/meetingMinutesAgentV2');
  const units = [{ id: 'T0001', speaker: 'Jacqui Fox', text: 'We reviewed the risk management plan comments.' }];
  const out = V.normaliseAgentResult({
    discussion: [{ topic: 'X', points: [{ text: 'The team agreed to relocate the factory to Mars next quarter.', evidenceIds: [] }] }],
    actions: [{ action: 'Relocate the factory to Mars next quarter.', owners: [], timing: { kind: 'not_stated', wording: '' }, evidenceIds: [] }],
    reviewFlags: []
  }, units, '', { enforceEvidence: false });
  const ids = new Set(out.reviewFlags.map((flag) => flag.id));
  assert.ok(out.actions[0].reviewFlagIds.length);
  assert.ok(out.actions[0].reviewFlagIds.every((id) => ids.has(id)));
  assert.ok(out.discussion[0].points[0].reviewFlagIds.every((id) => ids.has(id)));
});

test('evidence flags name their item, so a new unsupported item never merges into an old flag', () => {
  const V = require('../utils/meetingMinutesAgentV2');
  const units = [{ id: 'T0001', speaker: 'Jacqui Fox', text: 'We reviewed the risk management plan comments.' }];
  const out = V.normaliseAgentResult({
    discussion: [{ topic: 'X', points: [{ text: 'The team agreed to relocate the factory to Mars next quarter.', evidenceIds: [] }] }],
    actions: [{ action: 'Relocate the factory to Mars next quarter.', owners: [], timing: { kind: 'not_stated', wording: '' }, evidenceIds: [] }]
  }, units, '', { enforceEvidence: false });
  const missing = out.reviewFlags.filter((flag) => flag.kind === 'missing_evidence');
  assert.equal(missing.length, 2);
  assert.ok(missing.some((flag) => /"Relocate the factory to Mars next quarter\."/.test(flag.message)));
});

test('a row whose citations were enriched with an unrelated correction is neither flagged nor demoted', () => {
  const previous = process.env.MEETING_MINUTES_AGENT_CORRECTNESS_V1;
  process.env.MEETING_MINUTES_AGENT_CORRECTNESS_V1 = '1';
  try {
    const V = require('../utils/meetingMinutesAgentV2');
    const units = [
      { id: 'T0001', speaker: 'Rebecca Gill', text: 'I presumed that the formative would be ready for submission and then to follow up with the summative.' },
      { id: 'T0002', speaker: 'Rebecca Gill', text: 'But I think maybe that slightly changed and it would be ready just shortly after.' },
      { id: 'T0003', speaker: 'Rebecca Gill', text: 'We have a call today to walk through the CAR responses and load the documents for Grace.' }
    ];
    const row = { text: 'Call planned to review responses to CARs and load documents for Grace to review and approve.', evidenceIds: ['T0003', 'T0001', 'T0002'] };
    const out = V.normaliseAgentResult({ discussion: [{ topic: 'CARs', points: [row] }] }, units, 'discussion', {});
    assert.ok(!out.reviewFlags.some((flag) => /Conflicting passage/.test(flag.message)));
    assert.equal(V.supersededCheckItems([{ topic: 'CARs', points: [row] }], units).length, 0);
  } finally {
    if (previous === undefined) delete process.env.MEETING_MINUTES_AGENT_CORRECTNESS_V1; else process.env.MEETING_MINUTES_AGENT_CORRECTNESS_V1 = previous;
  }
});

test('an action drawn only from a description of usual practice is recognised', () => {
  const V = require('../utils/meetingMinutesAgentV2');
  const units = [
    { id: 'T0001', speaker: 'Steve Martin', text: 'First thing I go in when I look around, are there posters on the wall about the products?' },
    { id: 'T0002', speaker: 'Steve Martin', text: 'In most cases, the education comes from, you know, you really need a better connection with the product.' },
    { id: 'T0003', speaker: 'Hannah Quinn', text: "I'll draft the material and send it to you over the next couple of weeks." }
  ];
  assert.ok(V.describesUsualPractice({ action: 'Create more posters and video training.', evidenceIds: ['T0001', 'T0002'] }, units));
  assert.ok(!V.describesUsualPractice({ action: 'Draft the material and send it to Steve.', evidenceIds: ['T0003'] }, units));
  assert.ok(!V.describesUsualPractice({ action: 'Draft material on posters.', evidenceIds: ['T0001', 'T0003'] }, units));
});

test('a superseded statement already in supporting context is labelled and flagged there', () => {
  const previous = process.env.MEETING_MINUTES_AGENT_CORRECTNESS_V1;
  process.env.MEETING_MINUTES_AGENT_CORRECTNESS_V1 = '1';
  try {
    const V = require('../utils/meetingMinutesAgentV2');
    const units = [
      { id: 'T0001', speaker: 'Rebecca Gill', text: 'I presumed that the formative would be ready for submission and then to follow up with the summative.' },
      { id: 'T0002', speaker: 'Rebecca Gill', text: 'But I think maybe that slightly changed and it would be ready just shortly after, still prior to the protect file being lifted.' },
      { id: 'T0003', speaker: 'Adil Kauim', text: 'I finished the task analysis with Alan last week.' }
    ];
    const discussion = [{ topic: 'Formative', points: [{ id: 'r1', text: 'Adil finished the task analysis.', evidenceIds: ['T0003'], supportingDetails: [
      { id: 's1', text: 'Formative document readiness is anticipated shortly, prior to the summative submission.', evidenceIds: ['T0001', 'T0002'] },
      { id: 's2', text: 'Formative expected shortly after, but prior to the protect file being lifted.', evidenceIds: ['T0001', 'T0002'] }
    ] }] }];
    const out = V.labelSupersededContext(discussion, units);
    assert.equal(out.labelled, 1);
    const details = out.discussion[0].points[0].supportingDetails;
    assert.match(details[0].text, /^Earlier position, revised later in the meeting: /);
    assert.equal(details[0].reviewFlagIds.length, 1);
    assert.equal(details[1].text, 'Formative expected shortly after, but prior to the protect file being lifted.');
    // Running it twice does not label the same line again.
    assert.equal(V.labelSupersededContext(out.discussion, units).labelled, 0);
  } finally {
    if (previous === undefined) delete process.env.MEETING_MINUTES_AGENT_CORRECTNESS_V1; else process.env.MEETING_MINUTES_AGENT_CORRECTNESS_V1 = previous;
  }
});

test('named or dated facts are promoted out of context; raw speech and repeats are not', () => {
  const V = require('../utils/meetingMinutesAgentV2');
  const units = [
    { id: 'T0001', speaker: 'Jacqui Fox', text: 'Rebecca is managing the cybersecurity hazard update with Andrew.' },
    { id: 'T0002', speaker: 'Jacqui Fox', text: 'So we will get the.Bottomed out by the end of the week, hopefully.' },
    { id: 'T0003', speaker: 'Adil Kauim', text: 'I finished the task analysis with Alan last week.' },
    { id: 'T0004', speaker: 'Jacqui Fox', text: 'Rebecca will send the updated file to Andrew.' }
  ];
  const out = V.promoteNamedFactDetails([{ topic: 'T', points: [{ id: 'r1', text: 'Adil finished the task analysis.', evidenceIds: ['T0003'], supportingDetails: [
    { id: 's1', text: 'Hazard analysis needs updates for USB cybersecurity; Rebecca is managing it.', evidenceIds: ['T0001'] },
    { id: 's2', text: 'So we will get the.Bottomed out by the end of the week, hopefully.', evidenceIds: ['T0002'] },
    { id: 's3', text: 'Adil finished the task analysis with Alan.', evidenceIds: ['T0003'] }
  ] }] }], units, ['Adil Kauim']);
  assert.equal(out.promoted, 1);
  assert.equal(out.discussion[0].points[1].text, 'Hazard analysis needs updates for USB cybersecurity; Rebecca is managing it.');
  assert.deepEqual(out.discussion[0].points[0].supportingDetails.map((detail) => detail.id), ['s2', 's3']);
});

test('material refusals and objections are promoted out of collapsed context', () => {
  const V = require('../utils/meetingMinutesAgentV2');
  const discussion = [{ topic: 'Audit approach', points: [{
    id: 'p1', text: 'The brochure wording was reviewed.', evidenceIds: ['T0001'], supportingDetails: [
      { id: 's1', text: 'Gareth will not write findings to order.', evidenceIds: ['T0002'] },
      { id: 's2', text: 'Recognition that the same plan was made last month but not acted upon.', evidenceIds: ['T0003'] },
      { id: 's3', text: 'The team also discussed the bins.', evidenceIds: ['T0004'] }
    ]
  }] }];
  const out = V.promoteMaterialObjectionDetails(discussion);
  assert.equal(out.promoted, 2);
  assert.deepEqual(out.discussion[0].points.map((row) => row.id), ['p1', 's1', 's2']);
  assert.deepEqual(out.discussion[0].points[0].supportingDetails.map((row) => row.id), ['s3']);
});

test('a row naming someone absent from its citation is repaired when a nearby line supplies them', () => {
  const V = require('../utils/meetingMinutesAgentV2');
  const units = [
    { id: 'T0031', speaker: 'Rebecca Gill', text: "I can't remember the first one, but it was a quick amend." },
    { id: 'T0032', speaker: 'Rebecca Gill', text: 'And then the second one, I just kind of put a bit more detail into the use of kind of FMEAs to, as a way of measuring risk across software, hardware and various different things.' },
    { id: 'T0033', speaker: 'Rebecca Gill', text: "So I've kind of put the detail a wee bit more in there.I don't know, David, if you want to maybe have a pop in, have an RV look at that, just make sure I'm along the right lines." },
    { id: 'T0034', speaker: 'David Didsbury', text: 'Yes, I will take a look at that this week.' }
  ];
  const out = V.groundRowAttributions([{
    topic: 'Risk', points: [{ text: 'David may require an RV to review the updated FMEA detail.', evidenceIds: ['T0032'] }]
  }], units);
  // T0033 is the line that actually names David and shares the row's content,
  // so it joins the citation and the reviewer can see the words that were said.
  assert.deepEqual(out.discussion[0].points[0].evidenceIds, ['T0032', 'T0033']);
  assert.equal(out.widened, 1);
  assert.equal(out.flags.length, 0);
});

test('a row naming someone no cited or nearby line mentions keeps its wording and is flagged', () => {
  const V = require('../utils/meetingMinutesAgentV2');
  const units = [
    { id: 'T0063', speaker: 'Smith, Stuart M', text: "So it's a deep dive into their software management system." },
    { id: 'T0064', speaker: 'Smith, Stuart M', text: 'I think your expertise looking at the specifics associated with software and the dedicated time is what we need.' },
    { id: 'T0065', speaker: 'Smith, Stuart M', text: 'That is the shape of it.' },
    { id: 'T0200', speaker: 'Niamh Lynch', text: 'Understood, thanks.' }
  ];
  const text = 'Niamh will be the lead for the software deep dive.';
  const out = V.groundRowAttributions([{ topic: 'Audit', points: [{ text, evidenceIds: ['T0063', 'T0064'] }] }], units);
  assert.equal(out.discussion[0].points[0].text, text, 'the row is flagged, never reworded');
  assert.equal(out.flags.length, 1);
  assert.equal(out.flags[0].kind, 'attribution');
  assert.match(out.flags[0].message, /does not mention Niamh Lynch/);
  assert.ok(out.discussion[0].points[0].reviewFlagIds.includes(out.flags[0].id));
});

test('a row whose cited lines already name the person is left untouched', () => {
  const V = require('../utils/meetingMinutesAgentV2');
  const units = [
    { id: 'T0027', speaker: 'Jacqui Fox', text: 'And David, you obviously had reviewed their risk management plan.' },
    { id: 'T0028', speaker: 'Jacqui Fox', text: "Rebecca, you've reviewed David feedback on that." }
  ];
  const out = V.groundRowAttributions([{
    topic: 'Risk', points: [{ text: 'Rebecca has reviewed David feedback on the risk management plan.', evidenceIds: ['T0027', 'T0028'] }]
  }], units);
  assert.equal(out.widened, 0);
  assert.equal(out.flags.length, 0);
});

test('a speaker named only by their surname in the row still counts as supported', () => {
  const V = require('../utils/meetingMinutesAgentV2');
  const units = [
    { id: 'T0110', speaker: 'Ciaran Ryan', text: 'My submission is scheduled for Friday.' }
  ];
  const out = V.groundRowAttributions([{
    topic: 'Submission', points: [{ text: "Ciaran Ryan's submission is scheduled for Friday.", evidenceIds: ['T0110'] }]
  }], units);
  assert.equal(out.flags.length, 0, 'the speaker label supplies the person');
});

test('a commitment about other work does not make the speaker an owner', () => {
  const V = require('../utils/meetingMinutesAgentV2');
  const units = [
    { id: 'T0013', speaker: 'Jacqui Fox', text: 'I know what to do.' },
    { id: 'T0014', speaker: 'Jacqui Fox', text: "Okay, so just if I step down through each of the core areas, I'll update that table for the new set of minutes." },
    { id: 'T0015', speaker: 'Jacqui Fox', text: 'The focus still remains on risk and software.' },
    { id: 'T0018', speaker: 'Jacqui Fox', text: 'some cybersecurity stuff as a result of the USB ports that is on the back of the CPAP machine.' },
    { id: 'T0019', speaker: 'Jacqui Fox', text: 'So Rebecca is kind of managing that through with Andrew.' },
    // Rebecca and Andrew speak in this meeting, so they are rival claimants for
    // the work Jacqui is narrating.
    { id: 'T0020', speaker: 'Rebecca Gill', text: 'Yes, I have the cybersecurity risk updates in hand with Andrew.' },
    { id: 'T0021', speaker: 'Andrew', text: 'I am working through the USB port changes now.' }
  ];
  const out = V.applyRequesterOwnerRule([{
    action: 'Update the risk table and incorporate cybersecurity considerations related to USB ports, ensuring mitigation measures are documented.',
    owners: ['Jacqui Fox'], evidenceIds: ['T0014', 'T0018']
  }], units);
  // "I'll update that table for the new set of minutes" is the minutes tracker,
  // not the risk table: the words shared are the act of meeting-work, not its
  // subject. The neighbouring "The focus still remains on risk" is a complete
  // sentence of its own and may not lend its subject to the commitment.
  assert.deepEqual(out.actions[0].owners, []);
  assert.equal(out.flags.length, 1);
  assert.equal(out.flags[0].kind, 'ownership');
});

test('a commitment split across an unfinished line keeps its owner', () => {
  const V = require('../utils/meetingMinutesAgentV2');
  const units = [
    { id: 'T0103', speaker: 'Rebecca Gill', text: 'summary documents, so once they are finalized, they...' },
    { id: 'T0104', speaker: 'Ciaran Ryan', text: "That document, but I'm gonna..." },
    { id: 'T0105', speaker: 'Ciaran Ryan', text: 'focus on TFO3 this week.' },
    { id: 'T0106', speaker: 'Ciaran Ryan', text: "Once that's done, then I can start." }
  ];
  const out = V.applyRequesterOwnerRule([{
    action: 'Focus on TFO3 this week.', owners: ['Ciaran Ryan'], evidenceIds: ['T0105']
  }], units);
  // The preparer splits speech into sentences: "I'm gonna..." trails off into
  // "focus on TFO3 this week.", so the subject sits in the following line.
  assert.deepEqual(out.actions[0].owners, ['Ciaran Ryan']);
  assert.equal(out.flags.length, 0);
});

test('a "follow up on" action is checked for having been answered in the meeting', () => {
  const V = require('../utils/meetingMinutesAgentV2');
  const units = [
    { id: 'T0063', speaker: 'Jacqui Fox', text: 'One thing I did want to follow up on was around that date in relation to the formative studies and how that aligns with your MDR submission.' },
    { id: 'T0069', speaker: 'Rebecca Gill', text: 'I presumed that the formative would be ready for submission and then to follow up with the summative.' },
    { id: 'T0070', speaker: 'Rebecca Gill', text: 'But the formula would be ready to be just shortly after, but still prior to the protect file being lifted.' },
    { id: 'T0072', speaker: 'Jacqui Fox', text: "Okay, so that's fine." }
  ];
  const actions = [{
    action: 'Follow up on the dates for the formative studies to align with the MDR submission and review dates.',
    owners: ['Rebecca Gill'], evidenceIds: ['T0063']
  }];
  // The meeting settled these dates, so the action must at least reach the
  // check; whether it is retired still depends on verified answer and
  // acceptance quotes.
  const items = V.answeredCheckItems(actions, units);
  assert.equal(items.length, 1);
  assert.match(items[0].passage, /that's fine/);

  // A composite whose answerable clause is buried must NOT be checked: retiring
  // it would take its genuine half with it.
  const composite = [{
    action: 'Fill gaps in documentation with justifications and follow up on the dates for the formative studies.',
    owners: ['Rebecca Gill'], evidenceIds: ['T0063']
  }];
  assert.equal(V.answeredCheckItems(composite, units).length, 0);
});

test('a plain commitment owns the work when no one else is in the frame', () => {
  const V = require('../utils/meetingMinutesAgentV2');
  const units = [
    { id: 'T0105', speaker: 'Ciaran Ryan', text: 'focus on TFO3 this week.' },
    { id: 'T0106', speaker: 'Ciaran Ryan', text: "Once that's done, then I can start." },
    { id: 'T0107', speaker: 'Ciaran Ryan', text: "Because there's quite a lot of stuff that needs to go into the documents so that they're all in the same level as well." },
    { id: 'T0108', speaker: 'Ciaran Ryan', text: 'Once I get that over with this week, I should have a lot more.' }
  ];
  const out = V.applyRequesterOwnerRule([{
    action: 'Complete TFO3 and then begin updating the associated documents so they are aligned to the same level.',
    owners: ['Ciaran Ryan'], evidenceIds: ['T0107']
  }], units);
  // Run 10 stripped Ciaran here: "Once that's done, then I can start." shares no
  // subject word with the action. But no one else is named anywhere in the
  // cited window, so there is no rival claim the subject test exists to settle.
  assert.deepEqual(out.actions[0].owners, ['Ciaran Ryan']);
  assert.equal(out.flags.length, 0);
});
