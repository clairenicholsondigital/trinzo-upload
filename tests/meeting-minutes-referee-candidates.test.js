'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { meetingAgentRefereeCandidates, effectiveDiscussionRefereeDispositions } = require('../utils/meetingMinutesRefereeCandidates');

test('discussion referee batches cover topics before taking repeated rows from one topic', () => {
  const candidates = [
    ...Array.from({ length: 30 }, (_, index) => ({
      candidateId: `schedule-${index}`, sourcePass: 'primary', recordType: 'discussion_point',
      topic: 'Schedule', text: `Schedule detail ${index} for week ${index + 1}.`,
      evidenceIds: [`T${String(index + 1).padStart(4, '0')}`], priority: 5, sequence: index + 1
    })),
    ...['Scope', 'Security', 'Training', 'Logistics', 'Reporting'].map((topic, index) => ({
      candidateId: `topic-${index}`, sourcePass: 'primary', recordType: 'discussion_point',
      topic, text: `${topic} has a material dependency requiring review.`,
      evidenceIds: [`T${String(index + 100).padStart(4, '0')}`], priority: 5, sequence: index + 100
    }))
  ];
  const supplied = meetingAgentRefereeCandidates('discussion', candidates);
  assert.ok(supplied.length <= 24);
  for (const topic of ['Scope', 'Security', 'Training', 'Logistics', 'Reporting']) {
    assert.ok(supplied.some((candidate) => candidate.topic === topic), `${topic} was omitted`);
  }
  assert.ok(supplied.filter((candidate) => candidate.topic === 'Schedule').length < 30);
});

test('discussion referee clustering preserves genuine paraphrases as grounded context', () => {
  const candidates = [
    { candidateId: 'scope-primary', sourcePass: 'primary', recordType: 'discussion_point', topic: 'Scope', text: 'The audit scope includes software validation.', evidenceIds: ['T0001'], priority: 9, sequence: 1 },
    { candidateId: 'scope-recovery', sourcePass: 'recovery', recordType: 'discussion_point', topic: 'Scope', text: 'Software validation is included within the audit scope.', evidenceIds: ['T0001', 'T0002'], priority: 9, sequence: 2 },
    ...Array.from({ length: 30 }, (_, index) => ({
      candidateId: `schedule-${index}`, sourcePass: 'primary', recordType: 'discussion_point',
      topic: 'Schedule', text: `Distinct schedule consideration number ${index}.`,
      evidenceIds: [`T${String(index + 10).padStart(4, '0')}`], priority: 5, sequence: index + 10
    }))
  ];
  const supplied = meetingAgentRefereeCandidates('discussion', candidates);
  assert.ok(supplied.length <= 24);
  const scope = supplied.find((candidate) => candidate.topic === 'Scope');
  assert.ok(scope.clusterMembers.some((member) => member.candidateId === 'scope-primary'
    || member.candidateId === 'scope-recovery'));
  assert.ok(supplied.some((candidate) => candidate.clusterMembers.length > 0));
});

test('discussion referee accounts for distinct overflow without inheriting an unrelated facet verdict', () => {
  const candidates = Array.from({ length: 30 }, (_, index) => ({
    candidateId: `risk-${index}`,
    sourcePass: 'primary',
    recordType: 'discussion_point',
    topic: `Generated heading ${index}`,
    text: `Material risk ${index} concerns dependency ${index} and requires a distinct response.`,
    evidenceIds: [`T${String(index + 1).padStart(4, '0')}`],
    priority: 8,
    sequence: index + 1
  }));
  const supplied = meetingAgentRefereeCandidates('discussion', candidates);
  const coverage = require('../utils/meetingMinutesDiscussionCoverage').discussionSelectionCoverage(candidates, supplied);
  const represented = new Set(supplied.flatMap((candidate) => [
    candidate.candidateId,
    ...(candidate.clusterMembers || []).map((member) => member.candidateId)
  ]).concat(coverage.unassessedCandidateIds));
  assert.equal(supplied.length, 24);
  assert.equal(represented.size, 30, 'the Referee limit must not make later material disappear');
  assert.equal(coverage.unassessedCandidateIds.length, 6);
  assert.ok(supplied.every(candidate => (candidate.clusterMembers || []).every(member => member.clusterRelation !== 'overflow')));
});

test('discussion referee takes distinct propositions before a same-topic paraphrase', () => {
  const otherTopics = Array.from({ length: 12 }, (_, index) => ({
    candidateId: `other-${index}`, sourcePass: 'primary', recordType: 'discussion_point',
    topic: `Topic ${index}`, text: `A distinct material dependency ${index} requires resolution.`,
    evidenceIds: [`T${String(index + 20).padStart(4, '0')}`], priority: 5, sequence: index + 20
  }));
  const candidates = [
    { candidateId: 'risk-1', sourcePass: 'primary', recordType: 'discussion_point', topic: 'Software review', text: 'Cybersecurity rollout risk requires assessment.', evidenceIds: ['T0001'], priority: 9, sequence: 1 },
    { candidateId: 'risk-2', sourcePass: 'recovery', recordType: 'discussion_point', topic: 'Software review', text: 'The cybersecurity rollout risks require further assessment.', evidenceIds: ['T0001'], priority: 8, sequence: 2 },
    { candidateId: 'scope-1', sourcePass: 'primary', recordType: 'discussion_point', topic: 'Software review', text: 'The product scope includes embedded monitoring software.', evidenceIds: ['T0003'], priority: 7, sequence: 3 },
    ...otherTopics
  ];
  const supplied = meetingAgentRefereeCandidates('discussion', candidates);
  assert.equal(supplied.length, 14);
  assert.ok(supplied.some((candidate) => candidate.candidateId === 'risk-1'));
  assert.ok(supplied.some((candidate) => candidate.candidateId === 'scope-1'));
  assert.ok(!supplied.some((candidate) => candidate.candidateId === 'risk-2'));
});

test('orphaned supporting discussion gets a visible topic anchor and explicit targets', () => {
  const candidates = [
    { candidateId: 'background', recordType: 'discussion_point', topic: 'Context', text: 'Background information was reviewed.', evidenceIds: ['T1'] },
    { candidateId: 'prior-report', recordType: 'discussion_point', topic: 'Context', text: 'The prior report described the existing process.', evidenceIds: ['T2'] }
  ];
  const effective = effectiveDiscussionRefereeDispositions([
    { candidateId: 'background', disposition: 'supporting', reason: 'Background context.', evidenceIds: ['T1'] },
    { candidateId: 'prior-report', disposition: 'supporting', reason: 'Prior context.', evidenceIds: ['T2'] }
  ], candidates);
  assert.equal(effective.filter((item) => item.disposition === 'core').length, 1);
  assert.ok(effective.every((item) => item.targetId));
});

test('related supporting topics share one visible facet anchor', () => {
  const candidates = [
    { candidateId: 'product', recordType: 'discussion_point', topic: 'Product coverage', text: 'The product scope includes two monitored devices.', evidenceIds: ['T1'] },
    { candidateId: 'standards', recordType: 'discussion_point', topic: 'Applicable standards', text: 'The compliance standards follow the final scope.', evidenceIds: ['T2'] },
    { candidateId: 'requirements', recordType: 'discussion_point', topic: 'Regulatory requirements', text: 'Additional regulatory requirements were reviewed.', evidenceIds: ['T3'] }
  ];
  const effective = effectiveDiscussionRefereeDispositions(candidates.map((candidate) => ({
    candidateId: candidate.candidateId, disposition: 'supporting', reason: 'Context.', evidenceIds: candidate.evidenceIds
  })), candidates);
  assert.equal(effective.filter((item) => item.disposition === 'core').length, 1);
  assert.equal(new Set(effective.map((item) => item.targetId)).size, 1);
});

test('action referee batch retains polished records as well as lifecycle evidence', () => {
  const candidates = [
    ...Array.from({ length: 20 }, (_, index) => ({
      candidateId: `A${index}`, sourcePass: 'primary', recordType: 'action',
      text: `Complete distinct deliverable ${index}.`, evidenceIds: [`T${String(index).padStart(4, '0')}`],
      owners: ['Alex'], timing: { kind: 'not_stated', wording: '', exactDate: '' }, priority: 10, sequence: index
    })),
    ...Array.from({ length: 20 }, (_, index) => ({
      candidateId: `C${index}`, sourcePass: 'deterministic', recordType: 'action_chain',
      text: `Request and acceptance chain ${index}.`, context: `Long lifecycle context ${index}.`,
      evidenceIds: [`T${String(index + 100).padStart(4, '0')}`], priority: 12, sequence: index + 100
    }))
  ];
  const supplied = meetingAgentRefereeCandidates('actions', candidates);
  assert.ok(supplied.length <= 24);
  assert.ok(supplied.some((candidate) => candidate.recordType === 'action'));
  assert.ok(supplied.some((candidate) => candidate.recordType === 'action_chain'));
  assert.ok(supplied.filter((candidate) => candidate.recordType === 'action').length >= 10);
});
