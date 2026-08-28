'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const api = require('../routes/api');

// An unverifiable surname is the reviewer's decision, not ours.
//
// This file used to assert the opposite: that the known-people registry rewrote a surname
// whenever the first name matched, so "Rebecca Cuckoo" was recorded as "Rebecca Gill"
// everywhere. That rewrite cannot tell a mistranscribed surname from a real person who is
// simply not on the roster - it renamed Christina McLean, who chairs a workstream on the
// T733 weekly, to "Christina Cargan", while the actions stage went on calling her McLean.
// One person, two surnames, both in the same client PDF and both offered as separate
// people in the owner list.
//
// A wrong name that looks wrong ("Cuckoo") gets noticed and fixed in a second. A wrong
// name that looks right ("Cargan") does not get noticed at all. So the transcript's own
// spelling is what the screen shows, and the registry's candidate is offered beside it as
// a one-click swap.

const transcriptPath = path.resolve(__dirname, '../scripts/staged-scorecard-fixtures/07_t761_eakin_tech_file_weekly/transcript.txt');

test('the transcript spelling is what the reviewer is shown', () => {
  const details = api.stagedEvaluation
    .extractStagedDetailsFromTranscript(fs.readFileSync(transcriptPath, 'utf8'), 't761.txt')
    .screens.details;
  // The transcript says "Rebecca Cuckoo"; the roster knows a Rebecca Gill. Nothing is
  // renamed behind the reviewer's back, so the attendee list still reads as recorded.
  assert.ok(details.clientAttendees.includes('Rebecca Cuckoo'));
  assert.ok(!details.clientAttendees.includes('Rebecca Gill'), 'the roster does not overrule the transcript');
});

test('one person never appears under two surnames', () => {
  // The failure this replaces: the details screen said "Christina Cargan" while the
  // actions stage said "Christina McLean", and the owner dropdown offered both.
  const details = api.stagedEvaluation
    .extractStagedDetailsFromTranscript(fs.readFileSync(transcriptPath, 'utf8'), 't761.txt')
    .screens.details;
  const firstNames = [...details.internalAttendees, ...details.clientAttendees]
    .map((name) => String(name).trim().split(/\s+/)[0].toLowerCase());
  assert.equal(new Set(firstNames).size, firstNames.length, 'no first name is listed twice under different surnames');
});

test('the flag puts the choice to the reviewer and carries the alternative', () => {
  const output = api.stagedEvaluation
    .extractStagedDetailsFromTranscript(fs.readFileSync(transcriptPath, 'utf8'), 't761.txt');
  const flag = (output.validationFlags || []).find((item) => /attendee/i.test(item.type));
  assert.ok(flag, 'the reviewer is still told the surname could not be verified');
  assert.equal(flag.type, 'attendee_name_unverified');
  assert.equal(flag.severity, 'warning');
  assert.equal(flag.blocking, false);
  // Both names appear, so the reviewer can see what was found and what was kept.
  assert.match(flag.message, /Rebecca Cuckoo/);
  assert.match(flag.message, /Rebecca Gill/);
  assert.match(flag.message, /left exactly as the transcript spells it/);
  // The registry's candidate rides along so accepting it is one click, not a retype.
  assert.deepEqual(flag.nameSuggestion, { from: 'Rebecca Cuckoo', to: 'Rebecca Gill' });
});

test('a first name shared by two known people raises nothing at all', () => {
  // The registry stores null when two known people share a first name, so it declines to
  // suggest - and with nothing to suggest there is no doubt worth interrupting for.
  const output = api.stagedEvaluation
    .extractStagedDetailsFromTranscript(fs.readFileSync(transcriptPath, 'utf8'), 't761.txt');
  for (const flag of (output.validationFlags || []).filter((item) => /attendee/i.test(item.type))) {
    assert.ok(flag.nameSuggestion && flag.nameSuggestion.to, 'an attendee flag without a candidate is not worth raising');
  }
});

test('a residents meeting with two Jos keeps both spellings distinct in entityNames', async () => {
  const raceTranscriptPath = path.resolve(__dirname, '../scripts/staged-scorecard-fixtures/12_race_committee_two_jos/transcript.txt');
  const result = await api.stagedEvaluation.canonicalStagedResponse('discussion', {
    text: fs.readFileSync(raceTranscriptPath, 'utf8'), fileName: 'race.txt', source: 'file'
  }, {});
  const names = result.canonicalDiagnostics?.entityNames || [];
  assert.ok(names.includes('Jo Bennett'));
  assert.ok(names.includes('Jo Marsh'));
});
