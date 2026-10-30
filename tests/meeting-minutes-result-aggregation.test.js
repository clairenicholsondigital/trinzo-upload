'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { unionActionDiscoveryResults, mergeBatchedMeetingAgentRefereeResults } = require('../utils/meetingMinutesResultAggregation');
const { meetingAgentDispositionError } = require('../utils/meetingMinutesResponseContracts');

const action = (text, extra = {}) => ({ id: text.slice(0, 8), action: text, owners: ['Alex Reed'], timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds: ['T0001'], ...extra });
const reply = (actions, extra = {}) => ({ schemaVersion: 4, discussion: [], actions, actionProposals: [], candidateDispositions: [], reviewFlags: [], ...extra });

test('the union keeps what either leg found, once', () => {
  const first = reply([action('Send the revised report to the client.'), action('Book the audit room for Thursday.')]);
  const second = reply([action('Send the revised report to the client.'), action('Chase the supplier about the late delivery.')]);
  const union = unionActionDiscoveryResults(first, second);
  const texts = union.actions.map((a) => a.action).sort();
  assert.deepEqual(texts, ['Book the audit room for Thursday.', 'Chase the supplier about the late delivery.', 'Send the revised report to the client.']);
});

test('a leg that failed leaves the other exactly as it was', () => {
  const first = reply([action('Send the revised report to the client.')]);
  assert.equal(unionActionDiscoveryResults(first, null), first);
  assert.equal(unionActionDiscoveryResults(null, first), first);
  assert.equal(unionActionDiscoveryResults(null, null), null);
});

test('fields the second leg does not own are the first leg\'s', () => {
  const first = reply([], { discussion: [{ id: 't1', topic: 'Scope', points: [], decisions: [], openQuestions: [] }], meetingObjectives: [{ id: 'o1', text: 'Agree scope' }] });
  const second = reply([action('Do a thing.')], { discussion: [{ id: 't9', topic: 'Other', points: [], decisions: [], openQuestions: [] }] });
  const union = unionActionDiscoveryResults(first, second);
  assert.equal(union.discussion[0].topic, 'Scope');
  assert.equal(union.meetingObjectives[0].text, 'Agree scope');
  assert.equal(union.actions.length, 1);
});

test('review flags and dispositions from both legs are carried', () => {
  const first = reply([], { reviewFlags: [{ id: 'f1', kind: 'ownership', message: 'Check the owner.', evidenceIds: ['T0001'], status: 'open' }], candidateDispositions: [{ candidateId: 'c1', disposition: 'publish' }] });
  const second = reply([], { reviewFlags: [{ id: 'f2', kind: 'timing', message: 'Check the date.', evidenceIds: ['T0001'], status: 'open' }], candidateDispositions: [{ candidateId: 'c2', disposition: 'reject' }] });
  const union = unionActionDiscoveryResults(first, second);
  assert.equal(union.reviewFlags.length, 2);
  assert.deepEqual(union.candidateDispositions.map((d) => d.candidateId), ['c1', 'c2']);
});

test('batched referee results merge deterministically in the original candidate order', () => {
  const contract = {
    requestId: 'full-request', stage: 'ACTION_REFEREE',
    expectedCandidateIds: ['A1', 'A2', 'A3', 'A4']
  };
  const merged = mergeBatchedMeetingAgentRefereeResults([{
    repairAttempted: false,
    candidateDispositions: [
      { candidateId: 'A2', disposition: 'reject', reason: 'Not future work.', evidenceIds: ['T2'] },
      { candidateId: 'A1', disposition: 'publish', reason: 'Committed.', evidenceIds: ['T1'] }
    ], reviewFlags: []
  }, {
    repairAttempted: true,
    candidateDispositions: [
      { candidateId: 'A4', disposition: 'proposal', reason: 'Ambiguous acceptance.', evidenceIds: ['T4'] },
      { candidateId: 'A3', disposition: 'completed', reason: 'Already complete.', evidenceIds: ['T3'] },
      { candidateId: 'unexpected', disposition: 'publish', reason: 'Ignore.', evidenceIds: ['T9'] }
    ], reviewFlags: []
  }], contract);
  assert.deepEqual(merged.candidateDispositions.map((item) => item.candidateId), ['A1', 'A2', 'A3', 'A4']);
  assert.equal(merged.expectedCandidateCount, 4);
  assert.equal(merged.returnedDispositionCount, 4);
  assert.equal(merged.repairAttempted, true);
  assert.equal(meetingAgentDispositionError(merged, contract.expectedCandidateIds.map((candidateId) => ({ candidateId, recordType: 'action', text: 'Send the equipment report.' })), contract), null);
});
