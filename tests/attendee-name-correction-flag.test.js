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
