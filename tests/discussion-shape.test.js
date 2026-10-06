'use strict';

// Generic cases only: none of these sentences come from the evaluation corpus.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  shapeDiscussion,
  isSinglePersonAssignment,
  isExplicitCollectiveCommitment,
  removeDiscussionActionDuplicates
} = require('../utils/discussionShape');
const api = require('../routes/api');
const { foldUnownedNearCopies } = api.stagedEvaluation;

const people = ['Priya Shah', 'Tom Ellis', 'Robin'];
const row = (id, text) => ({ id, text, evidenceIds: ['T0001'], supportingDetails: [], reviewFlagIds: [] });

test('one person taking on work is an assignment, not a decision; group choices stay decisions', () => {
  assert.equal(isSinglePersonAssignment('Priya Shah will book the venue for the spring launch.', people), true);
  assert.equal(isSinglePersonAssignment('Decision: Tom takes responsibility to order the banners today.', people), true);
  assert.equal(isSinglePersonAssignment('Action assigned: Robin to chase the caterer.', people), true);
  assert.equal(isSinglePersonAssignment('It was agreed that banners will be printed instead of flyers.', people), false);
  assert.equal(isSinglePersonAssignment('The budget increase was approved and signed off.', people), false);
  assert.equal(isSinglePersonAssignment('Need to order forty chairs for the hall.', people), false, 'not a person');
});

test('accepted actions remove only strict generated assignment duplicates from discussion', () => {
  const discussion = [{
    id: 'supplier', topic: 'Supplier evidence', decisions: [], openQuestions: [], points: [
      { id: 'generated', text: 'Priya Shah will send the supplier evidence package by Friday.', evidenceIds: ['T0040'] },
      { id: 'manual', text: 'Priya Shah will send the supplier evidence package by Friday.', evidenceIds: ['T0040'], reviewerAuthored: true },
      { id: 'rationale', text: 'The supplier evidence package is required before the audit can begin.', evidenceIds: ['T0041'] }
    ]
  }];
  const actions = [{ id: 'action-1', action: 'Send the supplier evidence package by Friday.', owners: ['Priya Shah'], evidenceIds: ['T0040'] }];
  const result = removeDiscussionActionDuplicates(discussion, actions, people);
  assert.deepEqual(result.discussion[0].points.map((item) => item.id), ['manual', 'rationale']);
  assert.deepEqual(result.dropped.map((item) => item.pointId), ['generated']);
});

test('same-owner assignments with the same evidence are removed across complementary action wording', () => {
  const discussion = [{
    id: 'calibration', topic: 'Calibration records', decisions: [], openQuestions: [], points: [{
      id: 'generated',
      text: 'Priya Shah will contact the supplier to understand the additional calibration codes for the equipment record.',
      evidenceIds: ['T0040']
    }]
  }];
  const actions = [{
    id: 'action-1',
    action: 'Send the calibration codes to the supplier for review and response.',
    owners: ['Priya Shah'],
    evidenceIds: ['T0040', 'T0041']
  }];
  const result = removeDiscussionActionDuplicates(discussion, actions, people);
  assert.equal(result.discussion.length, 0);
  assert.deepEqual(result.dropped.map((item) => item.actionId), ['action-1']);
});

test('passive prioritisation wording is treated as an assignment only when one action matches', () => {
  const discussion = [{
    id: 'diagnostics', topic: 'Diagnostic records', decisions: [], openQuestions: [], points: [{
      id: 'generated',
      text: 'Priya Shah is prioritised to provide the calibration codes to the supplier for documentation review.',
      evidenceIds: ['T0040']
    }]
  }];
  const actions = [{
    id: 'action-1', action: 'Provide the calibration codes to the supplier for documentation review.',
    owners: ['Priya Shah'], evidenceIds: ['T0040']
  }];
  const result = removeDiscussionActionDuplicates(discussion, actions, people);
  assert.equal(result.discussion.length, 0);
  assert.equal(result.dropped[0].actionId, 'action-1');
});

test('a provenance match stays in discussion when two accepted actions are plausible', () => {
  const discussion = [{
    id: 'calibration', topic: 'Calibration records', decisions: [], openQuestions: [], points: [{
      id: 'generated',
      text: 'Priya Shah will contact the supplier to understand the additional calibration codes for the equipment record.',
      evidenceIds: ['T0040']
    }]
  }];
  const actions = [
    { id: 'action-1', action: 'Send the calibration codes to the supplier for review and response.', owners: ['Priya Shah'], evidenceIds: ['T0040'] },
    { id: 'action-2', action: 'Document the calibration codes received from the supplier in the review file.', owners: ['Priya Shah'], evidenceIds: ['T0040'] }
  ];
  const result = removeDiscussionActionDuplicates(discussion, actions, people);
  assert.deepEqual(result.discussion[0].points.map((item) => item.id), ['generated']);
  assert.equal(result.dropped.length, 0);
});

test('a collective monitoring commitment leaves discussion only when the accepted Action matches it', () => {
  const point = row('collective', 'The committee agreed to monitor the theft risk as an ongoing issue.');
  const discussion = [{ id: 'risk', topic: 'Theft risk', points: [point], decisions: [], openQuestions: [] }];
  assert.equal(isExplicitCollectiveCommitment(point.text), true);
  assert.equal(removeDiscussionActionDuplicates(discussion, [], people).discussion[0].points.length, 1,
    'classification alone never removes the point');

  const matching = [{ id: 'action-1', action: 'Monitor the theft risk as an ongoing issue.', owners: [], evidenceIds: ['T0001'] }];
  const removed = removeDiscussionActionDuplicates(discussion, matching, people);
  assert.equal(removed.discussion.length, 0);
  assert.equal(removed.dropped.length, 1);

  const unrelated = [{ id: 'action-2', action: 'Monitor the supplier delivery risk.', owners: [], evidenceIds: ['T0001'] }];
  assert.equal(removeDiscussionActionDuplicates(discussion, unrelated, people).discussion[0].points.length, 1);
});

test('discussion assignments remain when owner, figures or evidence do not strictly match an action', () => {
  const discussion = [{
    id: 'orders', topic: 'Orders', decisions: [], openQuestions: [], points: [
      { id: 'different-owner', text: 'Priya Shah will order 30 chairs.', evidenceIds: ['T0100'] },
      { id: 'different-count', text: 'Tom Ellis will order 40 chairs.', evidenceIds: ['T0100'] },
      { id: 'distant-evidence', text: 'Tom Ellis will order 30 chairs.', evidenceIds: ['T0200'] }
    ]
  }];
  const actions = [{ id: 'action-1', action: 'Order 30 chairs.', owners: ['Tom Ellis'], evidenceIds: ['T0100'] }];
  const result = removeDiscussionActionDuplicates(discussion, actions, people);
  assert.deepEqual(result.discussion[0].points.map((item) => item.id), ['different-owner', 'different-count', 'distant-evidence']);
  assert.equal(result.dropped.length, 0);
});

test('assignment decisions become points and a pure recap topic is folded away', () => {
  const discussion = [
    { id: 't1', topic: 'Venue', points: [row('p1', 'The hall holds 120 people.')],
      decisions: [row('d1', 'Priya Shah will book the venue for the spring launch.'), row('d2', 'It was agreed that the launch moves to spring rather than winter.')],
      openQuestions: [] },
    { id: 't2', topic: 'Summary of key actions and next steps',
      points: [row('p2', 'Priya to book the venue; Tom to order banners.'), row('p3', 'Tom Ellis will order the banners this week.'), row('p4', 'The follow-up meeting was set for 3 March.')],
      decisions: [], openQuestions: [row('q1', 'Whether Robin can attend is unknown.')] }
  ];
  const result = shapeDiscussion(discussion, people);
  assert.equal(result.demoted, 1);
  assert.deepEqual(result.droppedTopics, ['Summary of key actions and next steps']);
  assert.equal(result.discussion.length, 1);
  const venue = result.discussion[0];
  assert.deepEqual(venue.decisions.map((item) => item.id), ['d2']);
  assert.ok(venue.points.some((item) => item.id === 'd1'), 'demoted assignment kept as a point');
  assert.ok(venue.points.some((item) => item.id === 'p4'), 'non-assignment content moved, not lost');
  assert.deepEqual(venue.openQuestions.map((item) => item.id), ['q1']);
});

test('a recap-titled topic with real discussion is kept', () => {
  const discussion = [
    { id: 't1', topic: 'Budget', points: [row('p1', 'Costs rose 8% on last year.')], decisions: [], openQuestions: [] },
    { id: 't2', topic: 'Next steps for the venue search', points: [row('p2', 'Two venues were compared on capacity and parking.'), row('p3', 'Parking at the second venue is limited to 40 cars.')], decisions: [], openQuestions: [] }
  ];
  assert.equal(shapeDiscussion(discussion, people).discussion.length, 2);
});

test('an unowned near-copy of an owned action is folded into it', () => {
  const actions = [
    { id: 'a1', action: 'Confirm the catering headcount and dietary requirements with the venue.', owners: ['Priya Shah'], evidenceIds: ['T0001'] },
    { id: 'a2', action: 'Confirm the catering headcount and dietary requirements.', owners: [], evidenceIds: ['T0002'] },
    { id: 'a3', action: 'Review the catering contract terms.', owners: [], evidenceIds: ['T0003'] }
  ];
  const kept = foldUnownedNearCopies(actions, 'test');
  assert.deepEqual(kept.map((item) => item.id), ['a1', 'a3']);
  assert.deepEqual(kept[0].evidenceIds, ['T0001', 'T0002']);
});
