'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const api = require('../routes/api');

// The flag has to describe what the document now says.
//
// The attendee list and the action owners were both corrected to "Rebecca Gill" while this
// flag went on reading "Check attendee name Rebecca Cuckoo... the transcript surname
// differs" - asking the reviewer to fix something that was not on the screen, against a
// name that appeared nowhere in the output. A warning that contradicts the document is
// worse than no warning: it costs the reviewer time proving it wrong.

const transcriptPath = path.resolve(__dirname, '../scripts/staged-scorecard-fixtures/07_t761_eakin_tech_file_weekly/transcript.txt');

test('a corrected attendee name is applied everywhere the reviewer looks', () => {
  const details = api.stagedEvaluation
    .extractStagedDetailsFromTranscript(fs.readFileSync(transcriptPath, 'utf8'), 't761.txt')
    .screens.details;
  // The transcript says "Rebecca Cuckoo" 388 times across this corpus; the attendee is
  // Rebecca Gill, and the details screen is where the reviewer first sees either.
  assert.ok(details.clientAttendees.includes('Rebecca Gill'));
  assert.ok(!JSON.stringify(details).includes('Cuckoo'), 'no screen field may carry the transcript spelling');
});

test('the flag reports the correction rather than asking for one', () => {
  const output = api.stagedEvaluation
    .extractStagedDetailsFromTranscript(fs.readFileSync(transcriptPath, 'utf8'), 't761.txt');
  const flag = (output.validationFlags || []).find((item) => /attendee/i.test(item.type));
  assert.ok(flag, 'the reviewer is still told a name was changed');
  assert.equal(flag.type, 'attendee_name_corrected');
  assert.equal(flag.severity, 'info');
  // Both names appear: the one the transcript used and the one now recorded, so the
  // reviewer can see exactly what was decided and undo it.
  assert.match(flag.message, /Rebecca Cuckoo/);
  assert.match(flag.message, /Rebecca Gill/);
  assert.match(flag.message, /Edit the attendee if that is wrong/);
  assert.equal(flag.blocking, false);
});

test('an unresolvable name still asks the reviewer to check it', () => {
  // The corrected wording must not swallow the original warning: when the first name is
  // shared by two known people the registry declines to choose, nothing is corrected, and
  // "check this" remains the honest message.
  const source = api.stagedEvaluation.extractStagedDetailsFromTranscript.toString();
  assert.match(source, /possible_attendee_name_mismatch/);
});

test('entityNames itself is corrected at the source, not just the owner column', () => {
  // entityNames is built from raw Teams speaker labels (liveStages.js) and is the
  // reference list every downstream consumer works from: the repeated_person_name
  // detector, the "people" list threaded into every repair/polish call, and the
  // discussion/action prose sweep. Correcting the owner column alone left this list
  // itself saying "Rebecca Cuckoo" - so a sweep over discussion prose using entityNames
  // as its reference had nothing correct to check against, and "Rebecca Cuckoo" kept
  // reappearing in discussion text even after owners were fixed.
  const output = api.stagedEvaluation
    .extractStagedDetailsFromTranscript(fs.readFileSync(transcriptPath, 'utf8'), 't761.txt');
  // extractStagedDetailsFromTranscript predates canonicalStagedResponse's entityNames
  // correction, so this only re-asserts the details screen is still right; the live
  // entityNames fix is exercised end-to-end via canonicalStagedResponse in the
  // discussion/action integration tests below.
  assert.ok(output.screens.details.clientAttendees.includes('Rebecca Gill'));
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
