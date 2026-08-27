'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// A check earns a banner only when it tells the reviewer something the screen cannot
// already show them. The classifier lives in the view, so it is lifted out and exercised
// here rather than left to a browser rerun to catch.

const html = fs.readFileSync(path.join(__dirname, '..', 'views', 'staged-meeting-minutes.html'), 'utf8');

function loadClassifier() {
  const selfEvident = html.match(/var SELF_EVIDENT_FLAGS = \{[\s\S]*?\n {2}\};/);
  const tidied = html.match(/var ALREADY_TIDIED_FLAGS = \{[\s\S]*?\n {2}\};/);
  const fn = html.match(/function flagIsSelfEvident\(flag\) \{[\s\S]*?\n {2}\}/);
  assert.ok(selfEvident && tidied && fn, 'the flag classifier must remain extractable from the view');
  // eslint-disable-next-line no-new-func
  return new Function(`${selfEvident[0]}\n${tidied[0]}\n${fn[0]}\nreturn { flagIsSelfEvident, SELF_EVIDENT_FLAGS, ALREADY_TIDIED_FLAGS };`)();
}

test('a check the table already shows is not repeated as a banner', () => {
  const { flagIsSelfEvident } = loadClassifier();
  // The owner cell is a dropdown reading "Add owner"; the count adds nothing.
  assert.equal(flagIsSelfEvident({ type: 'actions_need_an_owner', severity: 'warning' }), true);
  assert.equal(flagIsSelfEvident({ type: 'uncertain_action_owner' }), true);
  // The row already carries an inline "rephrase before sharing" marker.
  assert.equal(flagIsSelfEvident({ type: 'action_wording_needs_review' }), true);
  assert.equal(flagIsSelfEvident({ type: 'discussion_wording_needs_review' }), true);
  // An empty actions table is its own announcement.
  assert.equal(flagIsSelfEvident({ type: 'no_actions_detected' }), true);
});

test('a check describing something absent from the screen always survives', () => {
  const { flagIsSelfEvident } = loadClassifier();
  // Points removed by the speech gate are not on screen to be seen.
  assert.equal(flagIsSelfEvident({ type: 'discussion_speech_removed', repairCandidates: [{ text: 'x' }] }), false);
  assert.equal(flagIsSelfEvident({ type: 'transcript_partially_parsed' }), false);
  assert.equal(flagIsSelfEvident({ type: 'generation_degraded' }), false);
});

test('anything the reviewer can act on from the banner is never suppressed', () => {
  const { flagIsSelfEvident } = loadClassifier();
  // One-click add/dismiss, jump-to-field, and blocking work all outrank the type list -
  // including for a type that would otherwise be suppressed.
  assert.equal(flagIsSelfEvident({ type: 'action_review_candidates', repairCandidates: [{ action: 'x' }] }), false);
  assert.equal(flagIsSelfEvident({ type: 'malformed_text', fieldPath: 'discussion.0.points.1' }), false);
  assert.equal(flagIsSelfEvident({ type: 'possible_omitted_workstream', discussionSuggestion: 'x' }), false);
  assert.equal(flagIsSelfEvident({ type: 'detected_actions_not_surfaced', blocking: true }), false);
  assert.equal(flagIsSelfEvident({ type: 'actions_need_an_owner', repairCandidates: [{ action: 'x' }] }), false);
});

test('an emptied discussion card is never filled with placeholder prose', () => {
  // The filler was written INTO the points textarea, harvested straight back out by
  // discussionRowsFromReview, and published into the client's minutes and the PDF.
  const live = html.slice(0, html.indexOf('function legacyRenderDiscussionCardsUnused'));
  assert.equal(/Review this section against the transcript/.test(live), false,
    'the live renderer must not inject placeholder points into an empty card');
  assert.match(html, /placeholder="No transcript evidence was allocated to this heading/,
    'the guidance belongs in the textarea placeholder, which nothing can harvest');
});
