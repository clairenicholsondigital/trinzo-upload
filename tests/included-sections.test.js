'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { includedSections, summaryStageIsEmpty, applyIncludedSections, applyTopicHeadings } = require('../utils/includedSections');

test('both sections are included unless explicitly turned off', () => {
  // A draft saved before the checkboxes existed must behave as it always did.
  assert.deepEqual(includedSections({}), { meetingObjectives: true, executiveSummary: true, topicHeadings: true });
  assert.deepEqual(includedSections({ includeSections: {} }), { meetingObjectives: true, executiveSummary: true, topicHeadings: true });
  assert.deepEqual(includedSections({ includeSections: null }), { meetingObjectives: true, executiveSummary: true, topicHeadings: true });
});

test('only an explicit false excludes a section', () => {
  assert.deepEqual(includedSections({ includeSections: { executiveSummary: false } }),
    { meetingObjectives: true, executiveSummary: false, topicHeadings: true });
  // Anything that is not false is treated as wanted, rather than guessing.
  assert.equal(includedSections({ includeSections: { executiveSummary: 'no' } }).executiveSummary, true);
});

test('the summary stage is only skipped when neither section is wanted', () => {
  assert.equal(summaryStageIsEmpty({}), false);
  assert.equal(summaryStageIsEmpty({ includeSections: { executiveSummary: false } }), false);
  assert.equal(summaryStageIsEmpty({ includeSections: { meetingObjectives: false } }), false);
  assert.equal(summaryStageIsEmpty({ includeSections: { meetingObjectives: false, executiveSummary: false } }), true);
});

test('an excluded section is blanked whatever produced it', () => {
  const draft = { includeSections: { executiveSummary: false } };
  const result = applyIncludedSections(draft, {
    executiveSummary: 'A summary nobody asked for.',
    meetingObjectives: [{ id: 'o1', text: 'Agree the scope.' }]
  });
  assert.equal(result.executiveSummary, '');
  assert.equal(result.meetingObjectives.length, 1);
});

test('excluding objectives leaves the summary untouched', () => {
  const result = applyIncludedSections({ includeSections: { meetingObjectives: false } }, {
    executiveSummary: 'The team agreed the scope.',
    meetingObjectives: [{ id: 'o1', text: 'Agree the scope.' }]
  });
  assert.deepEqual(result.meetingObjectives, []);
  assert.match(result.executiveSummary, /agreed the scope/);
});

test('topic titles are shown unless hidden for one topic or for the whole discussion', () => {
  const discussion = [{ id: 't1', topic: 'Budget' }, { id: 't2', topic: 'Risks', hideHeading: true }];
  assert.deepEqual(applyTopicHeadings({}, discussion).map((topic) => topic.hideHeading), [false, true]);
  assert.deepEqual(applyTopicHeadings({ includeSections: { topicHeadings: false } }, discussion).map((topic) => topic.hideHeading), [true, true]);
});
