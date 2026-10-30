'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { actionEvidenceDisposition } = require('../utils/meetingMinutesActionEvidence');

test('an affirmative action is rejected when the same object is explicitly prohibited', () => {
  assert.equal(actionEvidenceDisposition(
    'Arrange Niamh Lynch’s airport transfer.',
    'Leave the transfer unconfirmed. Today we are not choosing or booking a transfer. Neither option is authorised as an extra booking.'
  ), 'rejected');
  assert.equal(actionEvidenceDisposition(
    'Send the ticket reference today.',
    "Please don't send two different addresses. I will send the ticket reference today."
  ), 'committed', 'a prohibition concerning a different object does not veto the commitment');
});

test('long availability evidence cannot cause pathological action-classifier backtracking', () => {
  const filler = 'The product classification and standards context were reviewed in detail. '.repeat(120);
  const evidence = `Morgan won't be available next week. ${filler} Alex agreed to provide the classifications and standards pack.`;
  const started = Date.now();
  assert.equal(actionEvidenceDisposition('Provide the classifications and standards pack.', evidence), 'committed');
  assert.ok(Date.now() - started < 1000);
});

test('concrete future intentions are commitments but aspirations to think are not', () => {
  assert.equal(actionEvidenceDisposition(
    'Run a four-week pilot if the manual test succeeds.',
    'What we want to do is take a small slice and test it, and then if that succeeds we plan to run a four-week pilot.'
  ), 'conditional_commitment');
  assert.equal(actionEvidenceDisposition(
    'Consider replacement ideas.',
    'We want to think about possible replacement ideas at some point.'
  ), 'suggestion');
});

test('brief first-person sharing used to run the meeting is meeting admin, not a follow-up action', () => {
  assert.equal(
    actionEvidenceDisposition('Share that briefly.', 'I will quickly share that and then move on.'),
    'meeting_admin'
  );
  assert.equal(
    actionEvidenceDisposition(
      'Share the completed validation report with the client by Friday.',
      'I will quickly share the completed validation report with the client by Friday.'
    ),
    'committed'
  );
});
