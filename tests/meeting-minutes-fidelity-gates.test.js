'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../utils/meetingMinutesAgentV2');
const { isVagueReconstructedAction } = require('../routes/api').stagedEvaluation;

test('a contact-only farewell in the closing pleasantries is not an action', () => {
  const units = Array.from({ length: 20 }, (_, index) => ({
    id: `T${String(index + 1).padStart(4, '0')}`, speaker: 'Alex', text: 'The project plan and evidence were reviewed.'
  }));
  units[17] = { id: 'T0018', speaker: 'Alex', text: 'Thank you everyone.' };
  units[18] = { id: 'T0019', speaker: 'Sam', text: 'Yes, I will speak to you next week.' };
  units[19] = { id: 'T0020', speaker: 'Alex', text: 'Thanks a lot for your help. Goodbye.' };
  assert.equal(V.isFarewellAction({ action: 'Speak to Alex next week.', evidenceIds: ['T0019'] }, units), true);
  assert.equal(V.isFarewellAction({ action: 'Speak to Alex about the risk register next week.', evidenceIds: ['T0019'] }, units), false);
});

test('a disconnected acknowledgement cannot make its speaker the owner', () => {
  const lines = [
    { speaker: 'Pat', text: 'The warehouse becomes responsible for the changed process.' },
    { speaker: 'Sam', text: 'Yeah. Right. Yes, yeah.' },
    { speaker: 'Jordan', text: 'Someone else is updating the supplier records.' }
  ];
  assert.equal(V.ownerTakesItOn('Sam', lines, 'Update the supplier records.', []), false);
});

test('a first-person concrete offer still establishes ownership', () => {
  const lines = [
    { speaker: 'Christina', text: 'Should I just pop that procedure into a folder for review?' },
    { speaker: 'Jacqui', text: 'Yes, absolutely.' }
  ];
  assert.equal(V.ownerTakesItOn('Christina', lines, 'Place the procedure in a folder for review.', []), true);
});

test('two variants of the same scheduled event merge with one shared agreement line', () => {
  const result = V.mergeDuplicateCommitments([
    { action: 'Schedule another call with the client to continue the review.', owners: ['Jacqui'], timing: { kind: 'target', wording: 'next week' }, evidenceIds: ['T0010', 'T0011'], reviewFlagIds: [] },
    { action: 'Continue the work and look at scheduling another call in the diary.', owners: [], timing: { kind: 'deadline', wording: 'next week' }, evidenceIds: ['T0011', 'T0012'], reviewFlagIds: [] }
  ]);
  assert.equal(result.actions.length, 1);
  assert.equal(result.merged, 1);
});

test('a weekday attached to an earlier review is not the follow-up deadline', () => {
  const units = [{
    id: 'T0001', speaker: 'Chair',
    text: 'We reviewed the ratings on Monday and there are further updates that need to happen to the risk plan.'
  }];
  const action = { action: 'Make further updates to the risk plan.', owners: ['Alex'], timing: { kind: 'deadline', wording: 'monday', exactDate: '2026-06-29' }, evidenceIds: ['T0001'], reviewFlagIds: [] };
  assert.match(V.timingAttachedToEarlierStep(action, units), /reviewed the ratings on Monday/i);
  const result = V.applyChainedTimingRule([action], units);
  assert.deepEqual(result.actions[0].timing, { kind: 'not_stated', wording: '', exactDate: '' });
  assert.match(result.flags[0].message, /earlier step/i);
});

test("another person's reported estimate is not attached to the reporter as a deadline", () => {
  const units = [{
    id: 'T0001', speaker: 'Sam Jones',
    text: 'He says it would take three to four weeks, and the update is already in process.'
  }];
  const action = {
    action: 'Update the supplier records.', owners: ['Sam Jones'],
    timing: { kind: 'deadline', wording: 'within three to four weeks', exactDate: '' },
    evidenceIds: ['T0001'], reviewFlagIds: []
  };
  assert.match(V.timingReportedForDifferentActor(action, units), /He says/i);
  const result = V.applyChainedTimingRule([action], units);
  assert.deepEqual(result.actions[0].timing, { kind: 'not_stated', wording: '', exactDate: '' });
  assert.match(result.flags[0].message, /another person's estimate/i);
});

test('best-efforts progress is not rewritten as a completion promise', () => {
  const units = [{ id: 'T0001', speaker: 'Alex', text: 'I am trying to get as much as I can done this week.' }];
  const result = V.softenBestEffortCompletion([{
    action: 'Complete the study protocol work this week.', owners: ['Alex'],
    timing: { kind: 'target', wording: 'this week' }, evidenceIds: ['T0001'], reviewFlagIds: []
  }], units);
  assert.equal(result.actions[0].action, 'Progress the study protocol work this week.');
  assert.equal(result.flags.length, 1);
});

test('repeated implement scaffolding is made concise without dropping work', () => {
  assert.equal(
    V.cleanActionWording('Implement a proper system to implement lot numbering and add it to the label.'),
    'Implement a proper system for lot numbering and add it to the label.'
  );
});

test('a multi-placeholder follow-up is withheld as too vague', () => {
  assert.equal(isVagueReconstructedAction('Follow up to clarify what can be done regarding the plan to give a better picture of the crossover.'), true);
  assert.equal(isVagueReconstructedAction('Follow up with the supplier to confirm the declaration submission date.'), false);
});

test('fidelity candidates include later lines needed to preserve milestone sequence', () => {
  const discussion = [{ topic: 'Implementation', points: [{
    id: 'p1', text: 'The system is aiming for an early July rollout.', evidenceIds: ['T0001']
  }], decisions: [], openQuestions: [] }];
  const units = [
    { id: 'T0001', speaker: 'Alex', text: 'We are working on the system now.' },
    { id: 'T0002', speaker: 'Alex', text: 'We hope to have the process figured out by early July.' },
    { id: 'T0003', speaker: 'Alex', text: 'After that, we will have to implement it.' }
  ];
  const items = V.discussionFidelityCheckItems(discussion, units);
  assert.equal(items.length, 1);
  assert.match(items[0].passage, /After that, we will have to implement it/i);
});

test('a quote-verified direction correction replaces the row and raises a review flag', () => {
  const discussion = [{ topic: 'Procedure', points: [{
    id: 'p1', text: "The procedure update informed Louise's feedback.", evidenceIds: ['T0001'], reviewFlagIds: []
  }], decisions: [], openQuestions: [] }];
  const units = [{ id: 'T0001', speaker: 'Christina', text: "Louise's comments were embedded into the updated procedure." }];
  const items = V.discussionFidelityCheckItems(discussion, units);
  const result = V.applyDiscussionFidelityResults(discussion, items, [{
    id: items[0].id, verdict: 'corrected',
    problemQuote: "procedure update informed Louise's feedback",
    evidenceQuote: "Louise's comments were embedded into the updated procedure",
    correctedText: "Louise's feedback informed the procedure update."
  }]);
  assert.equal(result.corrected, 1);
  assert.equal(result.discussion[0].points[0].text, "Louise's feedback informed the procedure update.");
  assert.equal(result.flags.length, 1);
});

test('a fidelity correction accepts an exact evidence quote longer than 25 words', () => {
  const original = 'The timeline was considered on track despite the remaining documentation work and the planned holidays at the end of the month.';
  const evidence = 'We are at the end of June now, there are only two weeks before the holidays, and I am concerned because time is becoming very tight for the remaining documentation work.';
  const discussion = [{ topic: 'Timing', points: [{ id: 'p1', text: original, evidenceIds: ['T0001'], reviewFlagIds: [] }], decisions: [], openQuestions: [] }];
  const units = [{ id: 'T0001', speaker: 'Jacqui', text: evidence }];
  const items = V.discussionFidelityCheckItems(discussion, units);
  const result = V.applyDiscussionFidelityResults(discussion, items, [{
    id: items[0].id, verdict: 'corrected', problemQuote: original, evidenceQuote: evidence,
    correctedText: 'With only two weeks before the holidays, the remaining documentation timeline was becoming tight.'
  }]);
  assert.ok(evidence.split(' ').length > 25);
  assert.equal(result.corrected, 1);
  assert.deepEqual(result.rejected, []);
});

test('an unquoted fidelity correction changes nothing', () => {
  const discussion = [{ topic: 'Counts', points: [{
    id: 'p1', text: 'Four items require minor updates.', evidenceIds: ['T0001'], reviewFlagIds: []
  }], decisions: [], openQuestions: [] }];
  const units = [{ id: 'T0001', speaker: 'Alex', text: 'Three items need minor updates.' }];
  const items = V.discussionFidelityCheckItems(discussion, units);
  const result = V.applyDiscussionFidelityResults(discussion, items, [{
    id: items[0].id, verdict: 'corrected', problemQuote: 'Four items require minor updates',
    evidenceQuote: 'Five items need minor updates', correctedText: 'Five items require minor updates.'
  }]);
  assert.equal(result.corrected, 0);
  assert.equal(result.discussion[0].points[0].text, 'Four items require minor updates.');
});
