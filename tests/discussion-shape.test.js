'use strict';

// Generic cases only: none of these sentences come from the evaluation corpus.
const test = require('node:test');
const assert = require('node:assert/strict');
const { shapeDiscussion, isSinglePersonAssignment } = require('../utils/discussionShape');
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
