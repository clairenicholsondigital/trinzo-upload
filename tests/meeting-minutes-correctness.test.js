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

test('a timing spoken for a different step is removed when the action has none of its own', () => {
  const issue = V.timingClauseIssue('Upload the response documents for Grace to review and approve, then direct the auditor to them.',
    timing('today', 'deadline'), units, ['T0181', 'T0182']);
  assert.deepEqual(issue, { type: 'remove', from: 'today' });
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

test('agent actions are corrected and flagged; the correction is stable when normalised again', () => withChecks(() => {
  const first = V.normaliseAgentResult({ actions: [{
    id: 'a1', action: 'Finalize the two code changes to produce a new software version.', owners: [],
    timing: { kind: 'target', wording: 'end of the week' }, evidenceIds: ['T0067', 'T0068']
  }] }, units, 'actions', { meetingDate: '2026-06-17' });
  assert.equal(first.actions[0].timing.wording, 'end of next week');
  assert.ok(first.reviewFlags.some((flag) => flag.kind === 'timing' && /changed from "end of the week" to "end of next week"/.test(flag.message)));
  const second = V.normaliseAgentResult({ actions: first.actions }, units, 'actions', { meetingDate: '2026-06-17' });
  assert.equal(second.actions[0].timing.wording, 'end of next week');
  assert.ok(!second.reviewFlags.some((flag) => /changed from/.test(flag.message)), 'no repeat flag once corrected');
}));

test('a reviewer\'s own timing is never rewritten, only flagged', () => withChecks(() => {
  const saved = V.normaliseAgentResult({ actions: [{
    id: 'a1', action: 'Upload the response documents for Grace to review and approve, then direct the auditor to them.',
    owners: [], timing: { kind: 'deadline', wording: 'today' }, evidenceIds: ['T0181', 'T0182']
  }] }, units, 'actions', { meetingDate: '2026-06-17', enforceEvidence: false });
  assert.equal(saved.actions[0].timing.wording, 'today');
  assert.ok(saved.reviewFlags.some((flag) => flag.kind === 'timing' && /belongs to a different step/.test(flag.message)));
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

test('a name the cited passage never mentions is flagged; speakers and topic words are not', () => withChecks(() => {
  assert.deepEqual(V.unverifiedProperNouns('Jacqui to send the software files to Hartley for sign-off.', units, ['T0068']), ['Hartley']);
  assert.deepEqual(V.unverifiedProperNouns('Rebecca will walk Grace through the response to the cars.', units, ['T0181', 'T0182']), []);
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
    { id: 'p1', text: 'Agreed to keep the weekend cover internal for the rollout.', evidenceIds: ['T0210', 'T0211'] },
    { id: 'p2', text: 'The rollout team will be briefed next week by the service desk.', evidenceIds: ['T0212'] },
    { id: 'p3', text: 'Agreed to keep the weekend cover internal.', evidenceIds: ['T0210'], reviewFlagIds: ['f1'] }
  ], decisions: [], openQuestions: [] }, index);
  assert.deepEqual(topic.decisions.map((row) => row.id), ['p1']);
  assert.deepEqual(topic.points.map((row) => row.id), ['p2', 'p3'], 'a flagged row is never promoted');
}));
