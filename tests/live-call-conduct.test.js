'use strict';

// Running the call is not an action. Shapes seen on draft 1055 (the chair's
// opening line) and 1051 (a parcel at the door), against real planned work
// from the webinar and alarm meetings that mentions the same equipment.
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../utils/meetingMinutesAgentV2');

const opening = 'I\'ll give it thirty seconds for Dermot and then we\'ll just crack on, because I know Ffion has to drop at half past.';

test('the chair running the call is meeting admin, whole or in pieces', () => {
  assert.equal(V.isLiveCallConduct(opening), true);
  assert.equal(V.isLiveCallConduct('give it thirty seconds for Dermot and then'), true);
  assert.equal(V.isLiveCallConduct('just crack on, because I know Ffion has to drop at half past.'), true);
  assert.equal(V.isLiveCallConduct('Hang on, sorry, someone\'s at my door.'), true);
  assert.equal(V.isLiveCallConduct('You\'re on mute, Sandra.'), true);
  assert.equal(V.isLiveCallConduct('Let me just share my screen.'), true);
  assert.equal(V.isLiveCallConduct('We\'ll wait for Priya to join and then make a start.'), true);
  assert.equal(V.isMeetingAdminAction('give it thirty seconds for Dermot and then'), true);
  assert.equal(V.isMeetingAdminAction('Put away the PDF copy of the tracker from Friday.'), true);
  assert.equal(V.isMeetingAdminAction('Close the browser tab for now.'), true);
});

test('a turn that runs the call and still promises something keeps the promise', () => {
  assert.equal(V.isLiveCallConduct('Sorry, you\'re on mute. Right, so I\'ll send the deck tomorrow.'), false);
  assert.equal(V.isLiveCallConduct('I\'ll wait for Marcus to send the figures and then update the plan.'), false);
});

test('planned work that mentions recordings, mutes, cameras and minutes is not conduct', () => {
  for (const action of [
    'Send Tom a five-minute warning message when he reaches the agreed timing point during the webinar.',
    'Start the recording as soon as Priya begins speaking, verify recording is active with a screenshot, and monitor that recording continues throughout.',
    'Drop and rejoin the meeting as an attendee with camera and mic off to simulate a participant experience.',
    'Confirm how the alarm LED behaves when the mute button is pressed.',
    'Keep the personal introduction to thirty seconds and answers to approximately thirty seconds during Q&A.',
    'Give the supplier two weeks to respond before escalating.',
    'Close the quality file after approval.'
  ]) {
    assert.equal(V.isLiveCallConduct(action), false, action);
    assert.equal(V.isMeetingAdminAction(action), false, action);
  }
});

test('the opening line yields no deterministic candidates, and a mixed turn keeps its real clause', () => {
  const units = [
    { id: 'T0001', speaker: 'Jacqui Fox', text: opening },
    { id: 'T0002', speaker: 'Ffion Hargreaves', text: 'Twenty five past actually, sorry.' },
    { id: 'T0003', speaker: 'Jacqui Fox', text: 'Twenty five past.' }
  ];
  assert.deepEqual(V.actionCandidateInventory(units), []);

  const mixed = [
    { id: 'T0010', speaker: 'Priya Shah', text: 'I\'ll wait for Dermot to join and then I\'ll send the risk register to Marcus.' },
    { id: 'T0011', speaker: 'Marcus Lee', text: 'Thanks.' }
  ];
  const candidates = V.actionCandidateInventory(mixed);
  assert.ok(candidates.length >= 1, 'the promise survives');
  const clauses = candidates.filter((candidate) => /^candidate-clause/.test(candidate.candidateId)).map((candidate) => candidate.focusText);
  assert.deepEqual(clauses, ['send the risk register to Marcus.']);
  assert.ok(candidates.every((candidate) => !/thirty seconds|wait for Dermot to join and then$/.test(candidate.focusText)));
});

test('a clause cut off at its joint is not an action', () => {
  assert.equal(V.endsOnDanglingTail('give it thirty seconds for Dermot and then'), true);
  assert.equal(V.endsOnDanglingTail('Check the LED and'), true);
  assert.equal(V.endsOnDanglingTail('Review the file, then.'), true);
  assert.equal(V.isNotAnAction('give it thirty seconds for Dermot and then'), true);
  assert.equal(V.trimDanglingTail('give it thirty seconds for Dermot and then'), 'give it thirty seconds for Dermot');
  // "so" as the object of the verb is not a joint.
  assert.equal(V.endsOnDanglingTail('Pick which Thursday interview Aoife can take on her own if she is comfortable doing so.'), false);
  assert.equal(V.isNotAnAction('Pick which Thursday interview Aoife can take on her own if she is comfortable doing so.'), false);
  assert.equal(V.endsOnDanglingTail('Decide whether to ship A or B.'), false);
});
