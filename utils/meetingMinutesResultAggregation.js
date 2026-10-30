'use strict';

const { dedupeHybridActionRecords, dedupeHybridActionProposals } = require('./meetingMinutesActionDuplicatePolicy');
const { meetingMinutesAgentText } = require('./meetingMinutesPlainText');
const { mergeMeetingAgentFlags } = require('./meetingMinutesReviewFlags');
const { SCHEMA_VERSION: MEETING_AGENT_SCHEMA_VERSION } = require('./meetingMinutesResponseContracts');

// Union of two action-discovery replies. The first reply keeps every field it
// owns; the second only contributes actions, proposals, dispositions and flags,
// each deduplicated the way the pipeline already dedupes across passes. A
// missing leg (an optional call that failed) leaves the other untouched.
function unionActionDiscoveryResults(first, second) {
  if (!first || typeof first !== 'object') return second || null;
  if (!second || typeof second !== 'object') return first;
  const list = (value) => (Array.isArray(value) ? value : []);
  return {
    ...first,
    actions: dedupeHybridActionRecords([...list(first.actions), ...list(second.actions)], { independentDiscovery: true }),
    actionProposals: dedupeHybridActionProposals([...list(first.actionProposals), ...list(second.actionProposals)]),
    candidateDispositions: [...list(first.candidateDispositions), ...list(second.candidateDispositions)],
    reviewFlags: mergeMeetingAgentFlags(list(first.reviewFlags), list(second.reviewFlags))
  };
}

function mergeMeetingAgentRefereeResults(previous = {}, repair = {}, contract = {}) {
  const dispositions = new Map();
  for (const item of [
    ...(Array.isArray(previous?.candidateDispositions) ? previous.candidateDispositions : []),
    ...(Array.isArray(repair?.candidateDispositions) ? repair.candidateDispositions : [])
  ]) {
    const candidateId = meetingMinutesAgentText(item?.candidateId, 160);
    if (candidateId) dispositions.set(candidateId, item);
  }
  const expectedCount = Array.isArray(contract?.expectedCandidateIds)
    ? contract.expectedCandidateIds.length
    : dispositions.size;
  return {
    ...previous,
    ...repair,
    requestId: contract.requestId || previous?.requestId || repair?.requestId || '',
    stage: contract.stage || previous?.stage || repair?.stage || '',
    expectedCandidateCount: expectedCount,
    returnedDispositionCount: dispositions.size,
    repairAttempted: true,
    candidateDispositions: [...dispositions.values()],
    discussion: [
      ...(Array.isArray(previous?.discussion) ? previous.discussion : []),
      ...(Array.isArray(repair?.discussion) ? repair.discussion : [])
    ],
    actions: dedupeHybridActionRecords([
      ...(Array.isArray(previous?.actions) ? previous.actions : []),
      ...(Array.isArray(repair?.actions) ? repair.actions : [])
    ]),
    actionProposals: dedupeHybridActionProposals([
      ...(Array.isArray(previous?.actionProposals) ? previous.actionProposals : []),
      ...(Array.isArray(repair?.actionProposals) ? repair.actionProposals : [])
    ]),
    reviewFlags: mergeMeetingAgentFlags(previous?.reviewFlags || [], repair?.reviewFlags || [])
  };
}

function mergeBatchedMeetingAgentRefereeResults(results = [], contract = {}) {
  const expectedIds = Array.isArray(contract.expectedCandidateIds) ? contract.expectedCandidateIds : [];
  const expected = new Set(expectedIds);
  const dispositions = new Map();
  const discussion = [];
  const actions = [];
  const actionProposals = [];
  const reviewFlags = [];
  let repairAttempted = false;
  for (const result of Array.isArray(results) ? results : []) {
    if (!result || typeof result !== 'object') continue;
    repairAttempted = repairAttempted || Boolean(result.repairAttempted);
    for (const item of Array.isArray(result.candidateDispositions) ? result.candidateDispositions : []) {
      const candidateId = meetingMinutesAgentText(item?.candidateId, 160);
      if (candidateId && expected.has(candidateId) && !dispositions.has(candidateId)) dispositions.set(candidateId, item);
    }
    discussion.push(...(Array.isArray(result.discussion) ? result.discussion : []));
    actions.push(...(Array.isArray(result.actions) ? result.actions : []));
    actionProposals.push(...(Array.isArray(result.actionProposals) ? result.actionProposals : []));
    reviewFlags.push(...(Array.isArray(result.reviewFlags) ? result.reviewFlags : []));
  }
  const ordered = expectedIds.map((candidateId) => dispositions.get(candidateId)).filter(Boolean);
  return {
    schemaVersion: MEETING_AGENT_SCHEMA_VERSION,
    requestId: contract.requestId || '',
    stage: contract.stage || '',
    expectedCandidateCount: expectedIds.length,
    returnedDispositionCount: ordered.length,
    repairAttempted,
    candidateDispositions: ordered,
    discussion,
    actions: dedupeHybridActionRecords(actions),
    actionProposals: dedupeHybridActionProposals(actionProposals),
    meetingObjectives: [],
    reviewFlags: mergeMeetingAgentFlags([], reviewFlags)
  };
}

module.exports = {
  unionActionDiscoveryResults,
  mergeMeetingAgentRefereeResults,
  mergeBatchedMeetingAgentRefereeResults,
};
