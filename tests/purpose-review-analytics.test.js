'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildStagedReviewDiffs } = require('../routes/api').stagedEvaluation;

// Whether the reviewer kept the purpose we gave them, and which kind of purpose it was.
//
// The corpus cannot answer whether any of the purpose work helped: it is 115 mostly
// invented transcripts, and every purpose the title transform produces lands on one of
// them. The reviewer can answer it, on real meetings, and the analytics were already
// recording half of what is needed - whether the purpose was accepted, reworded or
// rewritten. What was missing was where the purpose came from, so the two could not be
// crossed.

const versions = (meetingPurpose) => ({ summary: { meetingPurpose, objectives: ['Agree the plan'] } });

function purposeDiff(before, after) {
  return buildStagedReviewDiffs(versions(before), versions(after))
    .find((diff) => diff.fieldPath === 'summary.meetingPurpose');
}

test('the meeting purpose is a field the review analytics grade', () => {
  // It was not in the registry at all until recently, so the field that steers most of
  // the later stages was invisible to the edit analytics.
  const diff = purposeDiff('Review the delivery status.', 'Review the delivery status.');
  assert.ok(diff, 'summary.meetingPurpose must be recorded');
  assert.equal(diff.editType, 'accepted_unchanged');
  assert.equal(diff.label, 'Meeting purpose');
});

test('a reviewer rewriting the purpose is graded differently from tidying it', () => {
  // The grades come from the existing classifier and are deliberately asserted against
  // what it actually does, not what reads nicely. It is stricter than it looks: dropping
  // "the" from a four-word sentence is a quarter of the tokens, so it grades as a rewrite.
  assert.equal(
    purposeDiff('Review the delivery status.', 'Review the delivery status').editType,
    'wording_or_formatting_edit'
  );
  assert.equal(
    purposeDiff('Review the delivery status ahead of the board meeting.', 'Review the delivery status ahead of the board meeting on Friday.').editType,
    'wording_or_formatting_edit'
  );
  assert.equal(
    purposeDiff('Review the delivery status.', 'Agree who owns the migration before the board meets.').editType,
    'structural_or_semantic_change'
  );
  assert.equal(purposeDiff('', 'Agree who owns the migration.').editType, 'added_by_reviewer');
});

test('the review event carries the purpose source alongside what was done to it', () => {
  // The pair is the point. Either alone answers nothing: an acceptance rate with no
  // source cannot say which kind of purpose is working, and a source with no outcome
  // cannot say whether it worked.
  const api = fs.readFileSync(path.resolve(__dirname, '../routes/api.js'), 'utf8');
  const handler = api.slice(api.indexOf("router.post('/staged-meeting-minutes/review-events'"));
  const editSummary = handler.slice(handler.indexOf('editSummary: {'), handler.indexOf('regenerationEvents:'));
  assert.match(editSummary, /purposeSource: firstString\(req\.body\?\.purposeSource\)/);
  assert.match(editSummary, /purposeEdit:.*summary\.meetingPurpose/);
});

test('the page sends the purpose source it was shown, and keeps it across a resume', () => {
  const page = fs.readFileSync(path.resolve(__dirname, '../views/staged-meeting-minutes.html'), 'utf8');
  // Captured from the payload the reviewer was actually shown, not recomputed later.
  assert.match(page, /generatedPurposeSource = \(summary\.initialUnderstanding/);
  assert.match(page, /purposeSource: generatedPurposeSource/);
  // A reviewer who comes back to a draft tomorrow must not have their purpose recorded
  // as coming from nowhere.
  assert.match(page, /existing\.purposeSource === 'string'/);
  assert.match(page, /purposeSource: generatedPurposeSource,/);
});
