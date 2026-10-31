'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { meetingAgentEmptyDiscoveryError, normaliseAgentDeclaredProposals, normaliseAnchoredActionDiscovery } = require('../utils/meetingMinutesDiscoveryValidation');
const { normaliseAgentCandidateDispositions } = require('../utils/meetingMinutesResponseContracts');

test('empty discussion discovery retries only when substantive evidence exists', () => {
  const error = meetingAgentEmptyDiscoveryError(
    { discussion: [], actions: [] },
    'discussion',
    [{ candidateId: 'D1', recordType: 'decision', priority: 9 }]
  );
  assert.equal(error?.code, 'empty_discussion_with_substantive_candidates');
  assert.equal(error?.retryable, true);
  assert.equal(meetingAgentEmptyDiscoveryError(
    { discussion: [], actions: [] }, 'discussion', [{ candidateId: 'D2', priority: 2 }]
  ), null);
  assert.equal(meetingAgentEmptyDiscoveryError(
    { discussion: [{ topic: 'Parking', points: [] }], actions: [] },
    'discussion',
    [{ candidateId: 'D3', recordType: 'open_question', priority: 8 }]
  ), null);
  assert.equal(meetingAgentEmptyDiscoveryError(
    { discussion: [], actions: [] }, 'actions', [{ candidateId: 'A1', recordType: 'action', priority: 10, owners: ['Bob'] }]
  )?.code, 'empty_action_with_substantive_candidates');
  assert.equal(meetingAgentEmptyDiscoveryError(
    { discussion: [], actions: [] }, 'actions', [{ candidateId: 'A2', recordType: 'action', priority: 10, owners: [] }]
  ), null);
  assert.equal(meetingAgentEmptyDiscoveryError(
    { discussion: [], actions: [] }, 'actions', [{
      candidateId: 'parking', recordType: 'action_chain', priority: 3, dispositionHint: 'suggestion',
      signals: { commitment: true }, ownerHints: []
    }]
  ), null, 'a suggestion-like chain must not make a correct zero-action response retry');
  assert.equal(meetingAgentEmptyDiscoveryError(
    { discussion: [], actions: [] }, 'actions', [{
      candidateId: 'accepted', recordType: 'action_chain', priority: 10, dispositionHint: 'accepted_request',
      signals: { acceptance: true }, ownerHints: ['Priya']
    }]
  )?.code, 'empty_action_with_substantive_candidates');
});

test('discovery validation rejects raw records that do not survive evidence normalisation', () => {
  const units = [{ id: 'T0001', speaker: 'Alice', text: 'The launch is blocked pending approval.', classification: 'keep' }];
  const candidates = [{ candidateId: 'D1', recordType: 'open_question', priority: 9 }];
  const error = meetingAgentEmptyDiscoveryError({
    discussion: [{ topic: 'Budget', points: [{ text: 'A £500 budget was approved.', evidenceIds: ['T9999'] }] }],
    actions: []
  }, 'discussion', candidates, units);
  assert.equal(error?.code, 'empty_discussion_with_substantive_candidates');
  assert.equal(meetingAgentEmptyDiscoveryError({
    discussion: [{ topic: 'Launch', points: [{ text: 'The launch is blocked pending approval.', evidenceIds: ['T0001'] }] }],
    actions: []
  }, 'discussion', candidates, units), null);
});

test('anchored action discovery never publishes an explicit refusal', () => {
  const result = normaliseAnchoredActionDiscovery({
    actionResults: [{
      resultId: 'R-refusal', disposition: 'publish',
      action: "I'm not doing clipboards, I'll get lynched.",
      ownersCsv: 'Sandra Wexford', timingKind: 'not_stated',
      timingWording: '', exactDate: '', evidenceCsv: 'T0001', confidence: 1
    }]
  }, [{
    id: 'T0001', sequence: 1, speaker: 'Sandra Wexford',
    text: "I'm not doing clipboards, I'll get lynched.", classification: 'keep'
  }]);
  assert.deepEqual(result.actions, []);
  assert.deepEqual(result.actionProposals, []);
});

test('schema-v4 Agent proposals remain review-only and dispositions retain only valid evidence', () => {
  const units = [{
    id: 'T0001', sequence: 1, speaker: 'Jenny Gough',
    text: 'I could review the proposed label if you wanted.', classification: 'keep'
  }];
  const result = {
    actionProposals: [{
      id: 'proposal-1', action: 'Review the proposed label if requested.', owners: ['Jenny Gough'],
      timing: { kind: 'dependency', wording: 'If requested', exactDate: '' }, evidenceIds: ['T0001']
    }],
    candidateDispositions: [
      { candidateId: 'chain-1', disposition: 'proposal', reason: 'The offer was not accepted.', action: 'Review the proposed label if requested.', owners: ['Jenny Gough'], timing: { kind: 'dependency', wording: 'If requested' }, evidenceIds: ['T0001', 'T9999'], uncertainties: ['acceptance'] },
      { candidateId: 'chain-2', disposition: 'invented-state', reason: 'Invalid.', evidenceIds: ['T0001'] }
    ]
  };
  const proposals = normaliseAgentDeclaredProposals(result, units);
  assert.equal(proposals.length, 1);
  assert.match(proposals[0].action, /proposed label/i);
  const dispositions = normaliseAgentCandidateDispositions(result, units);
  assert.deepEqual(dispositions[0].evidenceIds, ['T0001']);
  assert.equal(dispositions[0].disposition, 'proposal');
  // An unrecognised disposition used to be dropped here without a trace, which
  // silently muted the critic. It is kept and labelled now - but it is still
  // not a proposal, so nothing the reviewer sees changes because of it.
  assert.equal(dispositions.length, 2);
  assert.equal(dispositions[1].disposition, 'unclassified');
  assert.equal(dispositions[1].rawDisposition, 'invented-state');
  assert.equal(proposals.length, 1);
});

test('an empty action recovery result is accepted when the agent disposed of every candidate with a reason', () => {
  const candidates = [{
    candidateId: 'commitment-chain-de0fcbece5', recordType: 'action_chain', priority: 10,
    dispositionHint: 'committed', signals: { commitment: true }, ownerHints: ['Ravi Menon']
  }];
  const accounted = {
    schemaVersion: 4, discussion: [], actions: [], actionProposals: [],
    candidateDispositions: [{
      candidateId: 'commitment-chain-de0fcbece5', disposition: 'reject',
      reason: 'Hop ordering commitment is already represented in CURRENT DRAFT as the full 13 kilo hop order by Ravi Menon.',
      owners: ['Ravi Menon'], evidenceIds: ['T0001']
    }]
  };
  assert.equal(meetingAgentEmptyDiscoveryError(accounted, 'actions', candidates), null);

  // A disposition without a reason, or one that claims publish while returning nothing, still fails.
  const unexplained = { ...accounted, candidateDispositions: [{ candidateId: 'commitment-chain-de0fcbece5', disposition: 'reject', reason: '' }] };
  assert.equal(meetingAgentEmptyDiscoveryError(unexplained, 'actions', candidates)?.code, 'empty_action_with_substantive_candidates');
  const contradictory = { ...accounted, candidateDispositions: [{ candidateId: 'commitment-chain-de0fcbece5', disposition: 'publish', reason: 'Genuine commitment.' }] };
  assert.equal(meetingAgentEmptyDiscoveryError(contradictory, 'actions', candidates)?.code, 'empty_action_with_substantive_candidates');
  // Only some substantive candidates accounted for is still a gap, and the
  // error names the ones left unexplained.
  const partial = meetingAgentEmptyDiscoveryError(accounted, 'actions', [
    ...candidates,
    { candidateId: 'other', recordType: 'action', priority: 10, owners: ['Dan'] }
  ]);
  assert.equal(partial?.code, 'empty_action_with_substantive_candidates');
  assert.match(partial.message, /1 of 2 without a reasoned disposition: other/);
  // Low-priority windows the agent did not mention do not make a correct
  // empty answer fail: the recovery prompt carries dozens of them.
  assert.equal(meetingAgentEmptyDiscoveryError(accounted, 'actions', [
    ...candidates,
    { candidateId: 'window-1', recordType: 'action', priority: 3, owners: [] },
    { candidateId: 'window-2', recordType: 'action_chain', priority: 4, dispositionHint: 'suggestion', signals: {}, ownerHints: [] }
  ]), null);
});
