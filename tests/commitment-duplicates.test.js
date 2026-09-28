'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { commitmentDuplicate, mergeCommitmentDuplicates, conflictingRecipients, conflictingDestinations, dependsOn } = require('../utils/canonicalMinutes/commitmentDuplicates');

// Pairs from the 2026-09-27 live runs, labelled against the transcripts.
const rec = (action, owners, evidenceIds, extra = {}) => ({ action, owners, evidenceIds, timing: { kind: 'not_stated' }, ...extra });

test('the same work in two wordings from the same lines is one commitment, whatever the lead verbs', () => {
  const a = rec('Complete implementation of the remaining language support requiring additional font-driver work.', ['Andrew Kane'], ['T0178', 'T0180', 'T0181']);
  const b = rec('Review and resolve the remaining language character-support issues by generating the required font drivers.', ['Andrew Kane'], ['T0178', 'T0181', 'T0182', 'T0180']);
  assert.equal(commitmentDuplicate(a, b, { cosine: 0.72 }).duplicate, true);
  assert.equal(commitmentDuplicate(a, b).duplicate, true, 'the nouns alone decide it when no embedding is available');
});

test('an unowned fragment of an owned compound is folded into it', () => {
  const a = rec('Check if the towpath is open', [], ['T0044']);
  const b = rec('Submit the road-closure application this week and confirm that the towpath has reopened.', ['Alan Pryce'], ['T0040', 'T0044']);
  assert.equal(commitmentDuplicate(a, b, { cosine: 0.63 }).duplicate, true);
  const out = mergeCommitmentDuplicates([a, b], { cosines: new Map([['0|1', 0.63]]) });
  assert.equal(out.actions.length, 1);
  assert.deepEqual(out.actions[0].owners, ['Alan Pryce']);
  assert.deepEqual(out.actions[0].evidenceIds.sort(), ['T0040', 'T0044']);
});

test('a clause of a compound that is itself the other action', () => {
  const a = rec('Restore the three chart colours from grey to the intended blue and orange scheme before Friday.', ['Callum Reid'], ['T0031', 'T0032', 'T0034']);
  const b = rec('Set the chart colours manually and put them back; go to the room on Thursday to check the wifi, lectern availability and handouts.', ['Callum Reid'], ['T0031', 'T0032', 'T0034', 'T0060']);
  assert.equal(commitmentDuplicate(a, b, { cosine: 0.56 }).duplicate, true);
});

test('both waiting on the same thing is one commitment stated twice', () => {
  const a = rec("Send an email to Colm O'Rourke and the review team when the document revisions and responses to comments are finished.", ['Kevin Beattie'], ['T0059', 'T0061']);
  const b = rec('Send the revised documents for review after completing responses and document rewrites arising from feedback.', [], ['T0055', 'T0059', 'T0061']);
  assert.equal(commitmentDuplicate(a, b, { cosine: 0.65 }).duplicate, true);
});

test('two named people are two commitments, however close the wording', () => {
  const a = rec('Send the logistics provider question list to the logistics provider and obtain answers.', ['Bernard Whitlock'], ['T0050']);
  const b = rec('Prepare and provide the question list for the logistics provider.', ['Jenny Gough'], ['T0050']);
  assert.equal(commitmentDuplicate(a, b, { cosine: 0.82 }).reason, 'different owners');
  const c = rec('Review the applicability of ISO 27427:2023 against the device once the nebulizer flow-rate specification is confirmed.', ['David Didsbury', 'Colm'], ['T0147']);
  const d = rec('Confirm the nebulizer flow-rate specification provided by the device.', ['Andrew Kane'], ['T0146']);
  assert.equal(commitmentDuplicate(c, d, { cosine: 0.80 }).duplicate, false);
});

test('the next step in a chain waits on the other\'s deliverable', () => {
  assert.ok(dependsOn('Review ISO 27427 again once the nebulizer flow-rate specification is confirmed.', 'Confirm the nebulizer flow-rate specification.'));
  assert.ok(!dependsOn('Send the revised documents for review after completing the rewrites.', 'Send an email to the review team when the revisions are finished.'), 'both waiting on the same thing is not a chain');
  const a = rec('Test all four microphones and the sound desk before October and either fix or replace the faulty microphone.', ['Nadeem Chaudhry'], ['T0090']);
  const b = rec('Provide Gerald Pemberton with the exact replacement cost figure after microphone testing if a new microphone is required.', ['Nadeem Chaudhry'], ['T0090']);
  assert.equal(commitmentDuplicate(a, b, { cosine: 0.47 }).duplicate, false);
});

test('a different person receiving it is a different errand; a different place only blocks the loose routes', () => {
  assert.ok(conflictingRecipients('Forward passport numbers and full names to Ingrid Solberg in one submission.', 'Send passport details and full name to Jacqui Fox.'));
  assert.ok(!conflictingRecipients('Restore the three chart colours from grey to the intended blue and orange scheme.', 'Set the chart colours manually and put them back.'));
  assert.ok(conflictingDestinations('Download the approved materials and place them into the technical file.', 'Load all required materials onto Cognidocs for Grace to review and approve.'));
  const a = rec('Download the approved materials and place them into the technical file.', [], ['T0127', 'T0128']);
  const b = rec('Load all required materials onto Cognidocs for Grace to review and approve.', [], ['T0126', 'T0127']);
  assert.equal(commitmentDuplicate(a, b, { cosine: 0.49 }).duplicate, false);
});

test('the same nouns under a different kind of work need the meaning to agree too', () => {
  const a = rec('Start the electrical compliance testing.', ['Andrew Kane'], ['T0196']);
  const b = rec('Complete the review of the MDD documentation against IEC 6061-1 and define the required electrical compliance testing.', ['Andrew Kane'], ['T0189', 'T0196']);
  assert.equal(commitmentDuplicate(a, b, { cosine: 0.48 }).duplicate, false);
  const c = rec('Obtain a quote from St John Ambulance for two first-aid crews for the event.', ['Priya'], ['T0012']);
  const d = rec('Confirm first-aid cover with St John Ambulance once the cost is approved.', ['Priya'], ['T0012', 'T0014']);
  assert.equal(commitmentDuplicate(c, d, { cosine: 0.55 }).duplicate, false);
});

test('two pieces of work on one file stay apart', () => {
  const a = rec('Complete tidying up the risk management file sheet and share it with the team for review, incorporating considerations for interference.', ['Rebecca Gill'], ['T0070', 'T0071', 'T0072']);
  const b = rec('Review comparable device approaches for controlling unwarranted interference and update the risk management file with the outcome.', ['Rebecca Gill'], ['T0070', 'T0071', 'T0072']);
  assert.equal(commitmentDuplicate(a, b, { cosine: 0.55 }).duplicate, false);
});

test('the merge keeps the fuller record and unions evidence and flags', () => {
  const a = rec('Get the glycol chiller serviced before pitching the IPA.', ['Mick Dolan'], ['T0030'], { timing: { kind: 'deadline', wording: 'before the fifteenth' }, reviewFlagIds: ['f1'] });
  const b = rec('Have the glycol chiller serviced before pitching the IPA.', ['Mick Dolan'], ['T0030', 'T0031'], { reviewFlagIds: ['f2'] });
  const out = mergeCommitmentDuplicates([a, b]);
  assert.equal(out.actions.length, 1);
  assert.equal(out.actions[0].timing.kind, 'deadline');
  assert.deepEqual(out.actions[0].evidenceIds.sort(), ['T0030', 'T0031']);
  assert.deepEqual(out.actions[0].reviewFlagIds.sort(), ['f1', 'f2']);
  assert.equal(out.merged.length, 1);
});

// Draft 1041: "Load the documents onto Cognidocs for Grace to review and
// approve" is the first step of "Load the responses ... then download and
// insert them into the tech file and point the auditor to them". The fuller
// looking single step (owner, timing, three cited lines) used to win the
// merge, and the second step vanished from the minutes.
test('when one action is a step of the other, the compound survives the merge', () => {
  const step = { id: 's', action: 'Load the documents onto Cognidocs for Grace to review and approve.', owners: ['Rebecca Gill'],
    timing: { kind: 'target', wording: 'today', exactDate: '' }, evidenceIds: ['T0126', 'T0127', 'T0128'], reviewFlagIds: [] };
  const compound = { id: 'c', action: 'Load the responses to the CARs into Cognidocs for Grace to review and approve, then download and insert them into the tech file and point the auditor to them.',
    owners: ['Rebecca Gill'], timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds: ['T0127'], reviewFlagIds: [] };
  const { actions, merged } = mergeCommitmentDuplicates([step, compound]);
  assert.equal(merged.length, 1, 'they are the same work');
  assert.equal(actions.length, 1);
  assert.match(actions[0].action, /then download/);
  assert.equal(actions[0].timing.wording, 'today', 'the step\'s timing is kept on the survivor');
  assert.deepEqual(actions[0].evidenceIds, ['T0127', 'T0126', 'T0128']);
});
