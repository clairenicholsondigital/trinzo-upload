'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isPureFutureAssignment, retainPureFutureAssignments } = require('../utils/meetingMinutesDiscussionTaskBoundary');
const { collectUnassignedSupportingDetails } = require('../utils/meetingMinutesSupportingDetails');
const { discussionPublicationCoverage } = require('../utils/meetingMinutesDiscussionCoverage');
const people = ['Morgan Taylor', 'Priya Shah'];

test('a pure executable future assignment is retained for filing rather than minuted as a factual update', () => {
  const record = { id: 'task', text: 'Morgan will prepare the inspection checklist and send it before the next visit.',
    evidenceIds: ['T0001'], primaryEvidenceIds: ['T0001'], reviewFlagIds: ['warning'], supportingDetails: [] };
  const input = [{ topic: 'Inspection readiness', points: [record], decisions: [], openQuestions: [] }];
  const before = structuredClone(input), pool = [];
  const result = retainPureFutureAssignments(input, people, (detail, context) => {
    pool.push(...collectUnassignedSupportingDetails(detail, context)); return true;
  });
  assert.equal(result.discussion.length, 0);
  assert.equal(pool.length, 1);
  assert.equal(pool[0].text, record.text);
  assert.deepEqual(pool[0].evidenceIds, record.evidenceIds);
  assert.deepEqual(pool[0].reviewFlagIds, record.reviewFlagIds);
  assert.equal(pool[0].originalTopic, 'Inspection readiness');
  assert.equal(pool[0].placementReason, 'action_only_discussion');
  const coverage = discussionPublicationCoverage(result.discussion,
    [{ candidateId: 'task', disposition: 'core', targetId: 'task' }],
    [{ candidateId: 'task', text: record.text, evidenceIds: record.evidenceIds }], { unassignedSupportingDetails: pool });
  assert.equal(coverage.complete, false, 'the model core verdict is not falsely certified published');
  assert.equal(coverage.targets[0].status, 'needs_filing');
  assert.deepEqual(input, before);
});

for (const value of [
  'Morgan reports that inspection preparation is blocked by unavailable fixtures.',
  'Morgan will prepare the checklist, but validation is currently paused.',
  'Morgan will prepare the checklist and the firmware now supports additional languages.',
  'Morgan will prepare the checklist. Validation has not started.',
  'Morgan will prepare the checklist once the supplier has confirmed the requirements.',
  'Morgan will prepare the checklist because the original was incomplete.',
  'The committee approved a £50 spending limit, and Morgan will order the equipment.',
  'Morgan will be responsible for the compliance strategy.',
  'An unknown person will prepare the checklist.'
]) test(`uncertain or independently factual content remains untouched: ${value}`, () => {
  assert.equal(isPureFutureAssignment(value, people), false);
});

test('reviewer trees, decisions, questions, and failed handoffs stay intact', () => {
  const text = 'Morgan will prepare the checklist.';
  for (const record of [
    { id: 'a', text, reviewerAuthored: true },
    { id: 'a', text, supportingDetails: [{ text: 'Keep my qualification.', reviewerAuthored: true }] }
  ]) {
    const input = [{ topic: 'Inspection', points: [record], decisions: [], openQuestions: [] }];
    assert.deepEqual(retainPureFutureAssignments(input, people, () => true).discussion, input);
  }
  const input = [{ topic: 'Inspection', points: [{ id: 'p', text }], decisions: [{ id: 'd', text }], openQuestions: [{ id: 'q', text }] }];
  assert.deepEqual(retainPureFutureAssignments(input, people, () => false).discussion, input);
  const result = retainPureFutureAssignments(input, people, () => true);
  assert.equal(result.discussion[0].decisions.length, 1);
  assert.equal(result.discussion[0].openQuestions.length, 1);
});

test('a reported task-only recap is filed only when every clause is future work by known participants', () => {
  assert.equal(isPureFutureAssignment('Morgan and Priya discuss plans to complete the inspection checklist; Priya will update the maintenance register.', people), true);
  assert.equal(isPureFutureAssignment('Morgan and Priya discuss plans to complete the checklist; the machine has failed inspection.', people), false);
  assert.equal(isPureFutureAssignment('Morgan will prepare the checklist. Priya will update the register.', people), true);
  assert.equal(isPureFutureAssignment('Morgan discusses the inspection results and the supplier dependency.', people), false);
});

test('reported planning with a known participant possessive work phrase stays task-only', () => {
  assert.equal(isPureFutureAssignment("Morgan and Priya discuss plans to complete the checklist and Priya's review of the worksheet; Priya will update the register.", people), true);
  assert.equal(isPureFutureAssignment("Morgan and Priya discuss plans to complete the checklist and Priya's review has identified a safety defect.", people), false);
});
