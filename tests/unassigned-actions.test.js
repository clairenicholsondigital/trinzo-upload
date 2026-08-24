'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildEvidenceBoundStagedActionInventory,
  unassignedActionsWorthPublishing,
  readsAsAnActionRecord
} = require('../utils/stagedActionRecovery');
const { clientReadyPresentation } = require('../utils/canonicalMinutes/trooperPolish');

// Actions the meeting agreed on but never gave a name to.
//
// A reviewer ran five transcripts and reported that the two Eakin technical-file meetings
// gave them descriptions rather than actions - one confirmed row each, with six to nine
// snippets underneath to sift through. The tool was not failing to find the actions.
// Compared against the minutes a person wrote for the same meeting, eight of the nine
// actions in the T761 human minutes were already being generated, several of them word for
// word, and every one was withheld because no owner could be resolved from the transcript:
//
//   human: "Complete Electrical compliance testing"        tool: identical, as a snippet
//   human: "Clinical review of code changes for sounds,    tool: "Complete clinical review of
//           colour and flash"                                     code changes for sounds,
//                                                                 colour and flash", as a snippet
//   human: "Review IEC60601-1 standard compare to MDD      tool: "Review IEC 60601-1 against the
//           documentation..."                                     MDD documentation...", as a snippet
//
// The owner gate is right for a half-heard aside and wrong for a regulatory review, where
// the work is real, agreed, and stated impersonally because nobody in the room says "I'll
// do the clinical review". The person writing the minutes assigned owners from knowing who
// runs which workstream - knowledge the transcript does not contain and this must not
// invent - so the row is published with the owner blank and the reviewer told how many
// need a name.

test('an impersonally stated requirement is publishable with no owner', () => {
  const promoted = unassignedActionsWorthPublishing([
    { reviewDisposition: 'requirement', action: 'Complete Electrical compliance testing', deadline: '23rd July' },
    { reviewDisposition: 'needs_assignment', action: 'Prepare the country and language list' }
  ], []);
  assert.equal(promoted.length, 2);
  assert.ok(promoted.every((item) => item.owner === 'Not stated' && item.ownerUnassigned === true));
  assert.equal(promoted[0].deadline, '23rd July', 'a deadline stated in the meeting is kept');
});

test('the doubtful dispositions are not made publishable by having no owner', () => {
  // review_required is the tentative and the half-formed; completed_history is work already
  // done. Neither becomes more publishable for being unattributed - that was never the
  // reason they were held back.
  const promoted = unassignedActionsWorthPublishing([
    { reviewDisposition: 'review_required', action: 'Complete and approve the change request covering the software changes' },
    { reviewDisposition: 'completed_history', action: 'Send the updated risk file to the client' }
  ], []);
  assert.deepEqual(promoted, []);
});

test('a fragment is not published just because it has a capital letter', () => {
  for (const fragment of ['All right', 'Be, especially the response to the cars', 'It needs doing', 'So we started yesterday', 'Update the']) {
    assert.equal(readsAsAnActionRecord(fragment), false, `${JSON.stringify(fragment)} is not an action record`);
  }
  for (const record of ['Complete Electrical compliance testing', 'Trace and document the software changes between versions 1.01 and 1.02', 'Prepare the country and language list']) {
    assert.equal(readsAsAnActionRecord(record), true, `${JSON.stringify(record)} is an action record`);
  }
});

test('an action already published under an owner is not repeated without one', () => {
  const promoted = unassignedActionsWorthPublishing(
    [{ reviewDisposition: 'requirement', action: 'Complete Electrical compliance testing' }],
    [{ owner: 'Andrew Kane', action: 'Complete the electrical compliance testing' }]
  );
  assert.deepEqual(promoted, []);
});

test('the publication gate lets a deliberately unassigned row through and still holds the rest', () => {
  // clientReadyPresentation is where the owner gate actually lives: an action whose owner is
  // 'Not stated' is pulled out of the published list and offered as a candidate. That still
  // happens to everything except a row that has been through readsAsAnActionRecord.
  const presented = clientReadyPresentation({
    stagedStage: 'actions',
    screens: {
      actions: [
        { owner: 'Not stated', action: 'Complete Electrical compliance testing', deadline: 'Not stated', evidenceIds: [], ownerUnassigned: true },
        { owner: 'Not stated', action: 'Have a look at that when you get a minute', deadline: 'Not stated', evidenceIds: [] }
      ]
    }
  });
  const published = presented.screens.actions.map((item) => item.action);
  assert.ok(published.some((item) => /Electrical compliance testing/i.test(item)), `the unassigned action is published: ${JSON.stringify(published)}`);
  assert.ok(!published.some((item) => /get a minute/i.test(item)), 'an ordinary owner-less action is still withheld');
});

const FIXTURE = (name) => fs.readFileSync(path.resolve(__dirname, '..', name, 'transcript.txt'), 'utf8');

test('the T761 technical file weekly recovers the actions its human minutes list', { timeout: 120000 }, () => {
  const promoted = unassignedActionsWorthPublishing(
    buildEvidenceBoundStagedActionInventory(FIXTURE('scripts/meeting-minutes-final-golden/029_real_t761_tech_file_weekly_transcript')), []
  );
  const text = promoted.map((item) => item.action).join(' | ').toLowerCase();
  for (const expected of ['clinical review', 'debug commands', 'iec 60601-1', 'fan logic']) {
    assert.ok(text.includes(expected), `the human minutes list this and so should we - "${expected}": ${text}`);
  }
});

test('a meeting that agreed nothing gains no unassigned actions either', { timeout: 120000 }, () => {
  // The counterweight. This group discusses parking for half an hour, assigns nobody and
  // agrees only to think about it. Publishing owner-less work must not become a route back
  // to inventing actions for a meeting that reached no decision - and it does not, because
  // nothing here is stated as work the meeting agreed to do.
  const promoted = unassignedActionsWorthPublishing(
    buildEvidenceBoundStagedActionInventory(FIXTURE('scripts/transcript-tests/078_parking_no_decision_reached')), []
  );
  assert.deepEqual(promoted, [], `no actions were agreed in this meeting: ${JSON.stringify(promoted.map((item) => item.action))}`);
});

test('the informal meetings are untouched by this path', { timeout: 300000 }, () => {
  // Measured across the corpus, this fires on five transcripts, all of them real regulatory
  // reviews. If it starts firing on a committee meeting about a water butt, something has
  // broadened that should not have.
  for (const fixture of [
    'scripts/transcript-tests/074_allotment_society_committee',
    'scripts/transcript-tests/075_pantomime_society_planning',
    'scripts/transcript-tests/076_brewery_production_numbers',
    'scripts/transcript-tests/077_race_committee_two_jos'
  ]) {
    const promoted = unassignedActionsWorthPublishing(buildEvidenceBoundStagedActionInventory(FIXTURE(fixture)), []);
    assert.deepEqual(promoted, [], `${fixture} should gain nothing: ${JSON.stringify(promoted.map((item) => item.action))}`);
  }
});
