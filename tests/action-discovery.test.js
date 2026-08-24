'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runCanonicalLiveStage } = require('../utils/canonicalMinutes/liveStages');

// Five meetings a reviewer read end to end, wrote down every action they could see, and
// then compared against what the tool published. Between them they cost the actions stage
// nine of the twenty commitments that were actually made - and the losses were not
// classification failures. Every missing action had been found: extracted, scored, and
// then thrown away by a downstream rule that was asking the wrong question.
//
//   Deepa promised two things a minute apart. Both were extracted. They were then merged
//   into one row because the two turns belonged to the same MiniLM topic, and the social
//   media push left the minutes entirely.
//
//   Fiona was asked to book the hall and said she would. "I'll sort that with Deborah"
//   outscored "Ring Deborah and book us in for Tuesday evenings" by 0.07 on a scale that
//   was measuring how firmly she committed, not how much the sentence said, so the
//   published row lost the venue, the evening and the months.
//
//   Dan was asked for one thing all meeting. "Order six sacks" was dropped for being
//   three words long, because he had also said "let you go" at the end of the call.
//
// The assertions below are about those three rules, expressed through the meetings that
// exposed them. They are deliberately about presence and specificity rather than exact
// wording: the wording will keep changing, and pinning it would make this file a burden
// rather than a guard. What must not change is that a commitment somebody made in the
// room reaches the reviewer's screen.

const CORPUS = path.resolve(__dirname, '../scripts/transcript-tests');

function actionsFor(fixture, title) {
  const text = fs.readFileSync(path.join(CORPUS, fixture, 'transcript.txt'), 'utf8');
  return runCanonicalLiveStage(text, {
    stage: 'actions',
    fileName: fixture,
    confirmed: { details: { meetingTitle: title } }
  }).screens.actions || [];
}

const saysAll = (actions, ...needles) => actions.some((item) => {
  const text = `${item.owner} ${item.action}`.toLowerCase();
  return needles.every((needle) => text.includes(needle.toLowerCase()));
});

test('two commitments a speaker makes in one topic stay two actions', { timeout: 300000 }, () => {
  // Deepa took the medals and the social media within a minute of each other. A topic is
  // a subject the meeting covered; it is not a count of what anyone promised.
  const actions = actionsFor('077_race_committee_two_jos', 'Race committee planning');
  assert.ok(saysAll(actions, 'Deepa', 'medals'), `the medals action is published: ${JSON.stringify(actions.map((a) => a.action))}`);
  assert.ok(saysAll(actions, 'Deepa', 'social media'), `the social media action is published: ${JSON.stringify(actions.map((a) => a.action))}`);
});

test('the published row is the sentence that says most, not the firmest promise', { timeout: 300000 }, () => {
  const actions = actionsFor('075_pantomime_society_planning', 'Pantomime society planning');
  // Nadeem's only row used to read "Need a bit of budget if it's a new mic, they're not
  // cheap" - the caveat, published in place of the job, because it was the sentence in
  // which he committed. The job itself was extracted and discarded.
  //
  // He still gets a second row for the budget caveat: requiring more than a shared topic
  // before merging is what stops two commitments collapsing into one, and the price is
  // that a commitment and its own caveat sometimes arrive as two rows. That is the right
  // way round. A reviewer can delete a row they can see; they cannot restore one that was
  // never published, which is the failure this whole file exists about.
  assert.ok(saysAll(actions, 'Nadeem', 'mics'), `the mic testing action names the mics: ${JSON.stringify(actions.map((a) => a.action))}`);
});

test('a reviewer correction is not needed to recover a short but specific action', { timeout: 300000 }, () => {
  const actions = actionsFor('076_brewery_production_numbers', 'Brewery production planning');
  assert.ok(saysAll(actions, 'Dan', 'sacks'), `the malt order survives: ${JSON.stringify(actions.map((a) => a.action))}`);
  // The rule it survives by is specificity, not length: three-word rows that name nothing
  // must still go.
  const emptyShortRows = actions.filter((item) => /^(?:let you go|look at that|chase it hard)$/i.test(String(item.action).trim()));
  assert.deepEqual(emptyShortRows, [], 'contentless short rows are still dropped');
});

test('the allotment meeting keeps the letter to the council and the waiting-list emails', { timeout: 300000 }, () => {
  const actions = actionsFor('074_allotment_society_committee', 'Allotment society committee');
  assert.ok(saysAll(actions, 'Barbara', 'council'), `Barbara's letter to the council: ${JSON.stringify(actions.map((a) => a.action))}`);
  assert.ok(saysAll(actions, 'Priyanka', 'email'), `Priyanka's waiting-list emails: ${JSON.stringify(actions.map((a) => a.action))}`);
  assert.ok(saysAll(actions, 'Wesley', 'schedule'), `Wesley's show schedule: ${JSON.stringify(actions.map((a) => a.action))}`);
});

test('a meeting that reaches no decision is given no actions to pretend otherwise', { timeout: 300000 }, () => {
  // The counterweight to everything else in this file. This group discusses parking for
  // half an hour, assigns nobody, and agrees only to think about it. "Someone could ask
  // the council" is a suggestion, and inventing an owner for it would be worse than
  // publishing nothing.
  const actions = actionsFor('078_parking_no_decision_reached', 'Parking discussion');
  assert.deepEqual(actions, [], `no actions were assigned in this meeting: ${JSON.stringify(actions.map((a) => `${a.owner}: ${a.action}`))}`);
});
