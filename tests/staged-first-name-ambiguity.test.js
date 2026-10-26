'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const entityNormalization = require('../utils/entityNormalization');

const firstNames = ['Alden', 'Briar', 'Cassian', 'Dorian', 'Emrys', 'Felix'];
const surnames = ['Bennett', 'Cooper', 'Foster', 'Harper', 'Mason', 'Parker'];
const syntheticPeople = firstNames.flatMap((firstName, index) =>
  surnames.slice(0, index + 1).map((surname) => ({
    name: `${firstName} ${surname}`,
    firstNames: [firstName.toLowerCase()],
    surnames: [surname.toLowerCase()]
  }))
);

// Exercise the actual route extraction with a larger directory. Only the route's
// directory data changes; the real normalization functions and source stay intact.
const settingsStore = require('../utils/settingsStore');
const { DEFAULT_PEOPLE } = require('../utils/settingsDefaults');
const { extractStagedDetailsFromTranscript } = require('../routes/api').stagedEvaluation;
test.beforeEach(() => settingsStore.setSettings({ people: [...DEFAULT_PEOPLE, ...syntheticPeople.map(person => ({ name: person.name, side: 'internal', spellings: [] }))] }));
test.afterEach(() => settingsStore.resetToDefaults());

function extract(speakerNames) {
  const transcript = [
    'Project review transcript',
    ...speakerNames.flatMap((name, index) => [
      '',
      `${name}   0:${String(index + 10).padStart(2, '0')}`,
      'We reviewed the current schedule.'
    ])
  ].join('\n');
  return extractStagedDetailsFromTranscript(transcript, 'review.vtt');
}

test('a unique first name still repairs an unrecognized surname', () => {
  const result = extract(['Alden Unlisted']);
  assert.deepEqual(result.screens.details.internalAttendees, ['Alden Bennett']);
  assert.deepEqual(result.screens.details.clientAttendees, []);
  assert.deepEqual(result.screens.details.allAttendees, ['Alden Bennett']);
  assert.equal(result.telemetryPreview.attendeeExtraction.unresolvedAffiliationCount, 0);
  assert.ok(result.validationFlags.some((flag) => flag.type === 'attendee_name_corrected'));
});

for (let count = 2; count <= firstNames.length; count += 1) {
  const firstName = firstNames[count - 1];
  test(`${count} people sharing a first name leave an unrecognized surname unresolved`, () => {
    const transcriptName = `${firstName} Unlisted`;
    const result = extract([transcriptName]);
    assert.deepEqual(result.screens.details.internalAttendees, []);
    assert.deepEqual(result.screens.details.clientAttendees, []);
    assert.deepEqual(result.screens.details.allAttendees, [transcriptName]);
    assert.equal(result.telemetryPreview.attendeeExtraction.unresolvedAffiliationCount, 1);
    assert.ok(result.validationFlags.some((flag) => flag.type === 'attendee_affiliation_unconfirmed'));
    assert.ok(!result.validationFlags.some((flag) =>
      ['attendee_name_corrected', 'possible_attendee_name_mismatch'].includes(flag.type)
    ));
  });
}

test('exact full names still identify every person in an ambiguous directory', () => {
  const names = syntheticPeople.map((person) => person.name);
  const result = extract(names);
  assert.deepEqual(result.screens.details.internalAttendees, names);
  assert.deepEqual(result.screens.details.clientAttendees, []);
  assert.deepEqual(result.screens.details.allAttendees, names);
  assert.equal(result.telemetryPreview.attendeeExtraction.unresolvedAffiliationCount, 0);
  assert.ok(!result.validationFlags.some((flag) => flag.type === 'attendee_name_corrected'));
});

test('existing directory aliases and an unknown person retain their behavior', () => {
  const result = extract(['Smith, Stuart M', 'Sakki Arimotto', 'Rebecca Gill', 'Zephyr Unknown']);
  assert.deepEqual(result.screens.details.internalAttendees, ['Stuart Smith', 'Saki Arimoto']);
  assert.deepEqual(result.screens.details.clientAttendees, ['Rebecca Gill']);
  assert.deepEqual(result.screens.details.allAttendees, [
    'Stuart Smith', 'Saki Arimoto', 'Rebecca Gill', 'Zephyr Unknown'
  ]);
  assert.equal(result.telemetryPreview.attendeeExtraction.unresolvedAffiliationCount, 1);
  assert.ok(result.validationFlags.some((flag) =>
    flag.type === 'attendee_affiliation_unconfirmed' && flag.message.includes('Zephyr Unknown')
  ));
});
