'use strict';

// Generic cases only: none of these sentences come from the evaluation corpus.
const test = require('node:test');
const assert = require('node:assert/strict');
const { dedupeDiscussionBody } = require('../utils/discussionShape');

const row = (id, text) => ({ id, text, evidenceIds: ['T0001'], reviewFlagIds: [], supportingDetails: [] });
const texts = (result) => result.discussion.flatMap((topic) => [...topic.points, ...topic.decisions, ...topic.openQuestions]).map((r) => r.text);

test('the same figure spelled out and in digits is kept once', () => {
  const result = dedupeDiscussionBody([{
    topic: 'Yield',
    points: [
      row('a', '1200 litres yields about 22 clean 50-litre kegs after losses.'),
      row('b', 'The batch size of twelve hundred litres at fifty-litre kegs yields twenty-two clean kegs after losses.')
    ],
    decisions: [], openQuestions: []
  }], []);
  assert.deepEqual(texts(result), ['1200 litres yields about 22 clean 50-litre kegs after losses.']);
  assert.ok(result.dropped[0].because, 'the drop is explained');
});

test('a point restating a decision goes, and the decision stays', () => {
  const result = dedupeDiscussionBody([{
    topic: 'Chiller',
    points: [row('p', 'The chiller must be serviced before the fifteenth or the brew waits.')],
    decisions: [row('d', 'The chiller must be serviced before the fifteenth or the brew waits.')],
    openQuestions: []
  }], []);
  assert.deepEqual(texts(result), ['The chiller must be serviced before the fifteenth or the brew waits.']);
  assert.equal(result.discussion[0].decisions.length, 1);
  assert.equal(result.discussion[0].points.length, 0);
});

test('a run-through of several people’s jobs is dropped when each is already minuted', () => {
  const people = ['Alan Pryce', 'Deepa Sharma'];
  const result = dedupeDiscussionBody([{
    topic: 'Roles',
    points: [
      row('a', 'Alan Pryce will submit the road-closure application and check the towpath.'),
      row('b', 'Deepa Sharma will reorder the medals and run the social media push.'),
      row('c', 'Alan to submit the road-closure application and check the towpath; Deepa to reorder the medals and manage social media.')
    ],
    decisions: [], openQuestions: []
  }], people);
  assert.equal(texts(result).length, 2);
  assert.ok(!texts(result).some((value) => /manage social media/.test(value)), 'the run-through goes');
});

test('a figure restated with different words, below the wording bar, is still caught', () => {
  const { dedupeDiscussionBody: dedupe } = require('../utils/discussionShape');
  const result = dedupe([{
    topic: 'Festival',
    points: [
      row('a', 'Fifteen firkins equal over a thousand pints, most of the batch.'),
      row('b', 'The fifteen casks amount to more than 1000 pints, consuming the batch.')
    ],
    decisions: [], openQuestions: []
  }], []);
  assert.equal(texts(result).length, 1);
});

test('open questions and genuinely different rows are left alone', () => {
  const result = dedupeDiscussionBody([{
    topic: 'Permit',
    points: [
      row('a', 'The council application takes four weeks.'),
      row('b', 'A plan B route is needed if the permit is not confirmed two weeks out.')
    ],
    decisions: [],
    openQuestions: [row('q', 'Who will chase the council for the permit?')]
  }], []);
  assert.equal(texts(result).length, 3);
  assert.equal(result.dropped.length, 0);
});

test('a line announcing the actions list is not meeting content', () => {
  const { dedupeDiscussionBody, announcesActions } = require('../utils/discussionShape');
  assert.ok(announcesActions('Action assigned to split the list and write the rationale before the next meeting.'));
  assert.ok(announcesActions('Next steps: Dana to split the list.'));
  assert.ok(!announcesActions('The team agreed to split the list before the next meeting.'));
  const result = dedupeDiscussionBody([{
    topic: 'List',
    points: [
      row('a', 'Action assigned to split the list into shipped and not shipped items.'),
      row('b', 'The list was generated from the lock file and includes dev dependencies.')
    ],
    decisions: [], openQuestions: []
  }], []);
  assert.equal(texts(result).length, 1);
  assert.match(result.dropped[0].because, /announces the actions list/);
});

test('one small number in common is not enough to call two rows the same', () => {
  const result = dedupeDiscussionBody([{
    topic: 'Requirement',
    points: [
      row('a', 'Dana questions the source of the three-second alarm requirement, whether standard, clinical or arbitrary.'),
      row('b', 'Lee advises finding the source of the three-second requirement before any test or requirement changes.')
    ],
    decisions: [], openQuestions: []
  }], []);
  assert.equal(texts(result).length, 2, 'a question and advice about the same thing are different rows');
});
