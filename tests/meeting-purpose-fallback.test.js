'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { describeDiscussedConcepts } = require('../utils/canonicalMinutes/initialUnderstanding');

const events = (...texts) => ({ events: texts.map((text, index) => ({ id: `evt_${index}`, text })) });

// The purpose sentence is the first thing a client reads. It previously fell
// back to "Establish the meeting context, material developments and next steps
// from the transcript evidence" — a sentence about our pipeline, which reads to
// the person holding the minutes as though the meeting had been about
// transcripts.
test('no purpose text describes our own pipeline to the client', () => {
  const described = describeDiscussedConcepts(events(
    'The validation testing results are back and the report is ready.',
    'We reviewed the testing evidence for the release.',
    'The verification results were circulated yesterday.'
  ));
  assert.doesNotMatch(described, /transcript evidence/i);
  assert.doesNotMatch(described, /material developments/i);
});

test('a described purpose says what was covered, grounded in the discussion', () => {
  const described = describeDiscussedConcepts(events(
    'The validation testing results are back and the report is ready.',
    'We reviewed the testing evidence for the release.',
    'The verification results were circulated yesterday.'
  ));
  assert.match(described, /^The meeting covered /);
  assert.match(described, /testing and validation/);
});

test('one stray mention cannot put a subject into the purpose', () => {
  // A single passing reference is not what a meeting was about.
  const described = describeDiscussedConcepts(events(
    'Morning everyone, thanks for joining.',
    'Someone mentioned the budget in passing.',
    'Right, see you next week.'
  ));
  assert.doesNotMatch(described, /budget/i);
});

test('nothing substantive yields nothing, rather than invented prose', () => {
  assert.equal(describeDiscussedConcepts(events('Hello.', 'Yes.', 'Okay.')), '');
  assert.equal(describeDiscussedConcepts({ events: [] }), '');
  assert.equal(describeDiscussedConcepts(null), '');
});

test('concept labels containing "and" are joined so the list stays readable', () => {
  const described = describeDiscussedConcepts(events(
    'The documentation and the technical file records need updating.',
    'We reviewed the document tracker and the evidence records.',
    'The slides and webinar content were discussed at length.',
    'The presentation content and the questions came up again.',
    'Screen sharing and the recording setup were tested.',
    'The camera and microphone connection were checked twice.'
  ));
  // "documentation and evidence, technical setup and content and
  // communications" would be unparseable; the serial comma disambiguates.
  if (described.split(', ').length > 2) {
    assert.match(described, /, and /, 'a three-item list needs the serial comma');
  }
  assert.match(described, /^The meeting covered .+\.$/);
});

test('the description is capped so a purpose stays a summary', () => {
  const many = describeDiscussedConcepts(events(
    ...Array.from({ length: 4 }, () => 'The testing, budget, training, alarm, cyber security and documentation were all reviewed.')
  ));
  // Labels contain "and" themselves, so items are counted by the separating
  // commas rather than by splitting on the conjunction.
  const separators = (many.match(/,\s/g) || []).length;
  assert.ok(separators <= 2, `expected at most three concepts, got: ${many}`);
  assert.match(many, /^The meeting covered .+\.$/);
});
