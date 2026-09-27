const test = require('node:test');
const assert = require('node:assert');
const { isMinuteInstruction } = require('../utils/meetingMinutesAgentV2');

test('a request to record a point is an instruction to the note-taker, not an action', () => {
  // Calderhaven, draft 1037 of the 2026-09-27 assessment.
  assert.ok(isMinuteInstruction('Write down that the end of July release date is at risk so that nobody is surprised in a fortnight.'));
  assert.ok(isMinuteInstruction('Note that the supplier audit slipped to Q4.'));
  assert.ok(isMinuteInstruction('Record in the minutes that the budget was approved.'));
  assert.ok(isMinuteInstruction('Capture this as a risk.'));
  assert.ok(isMinuteInstruction('Please make a note that the contract renews in March.'));
});

test('the minute-taker\'s own routine with no recipient is not published as an action', () => {
  assert.ok(isMinuteInstruction('Send the meeting minutes.'));
  assert.ok(isMinuteInstruction('Circulate the minutes'));
  assert.ok(isMinuteInstruction('Send out the notes.'));
});

test('real work that happens to mention notes or recording stays', () => {
  assert.ok(!isMinuteInstruction('Send the minutes to the client by Friday.'));
  assert.ok(!isMinuteInstruction('Write down the rationale for the unit test coverage exclusions, including the CVE script.'));
  assert.ok(!isMinuteInstruction('Record the flow-rate measurements for the three test units.'));
  assert.ok(!isMinuteInstruction('Note the serial numbers of the returned devices in the tracker.'));
  assert.ok(!isMinuteInstruction('Put the approved materials into the technical file.'));
  assert.ok(!isMinuteInstruction('Mark the affected batches as quarantined.'));
  assert.ok(!isMinuteInstruction('Log the defect in Jira and link it to the release.'));
});
