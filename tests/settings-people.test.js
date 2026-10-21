'use strict';

// The People list on the Settings page drives who the agent treats as internal
// or client, and which other spellings resolve to whom.

const test = require('node:test');
const assert = require('node:assert/strict');

const settingsStore = require('../utils/settingsStore');
const { DEFAULT_PEOPLE } = require('../utils/settingsDefaults');
const {
  alwaysInternalAttendeeName,
  knownPerson,
  knownPersonName,
  normaliseFixedPersonAliases,
  normaliseDirectoryNameSpellings
} = require('../utils/entityNormalization');
const { sanitiseDetails } = require('../utils/meetingMinutesAgentV2');
const { extractStagedDetailsFromTranscript } = require('../routes/api').stagedEvaluation;
const { validatePerson } = require('../utils/settingsDb');

test.afterEach(() => settingsStore.resetToDefaults());

function withPeople(extra, { without = [] } = {}) {
  settingsStore.setSettings({
    people: [...DEFAULT_PEOPLE.filter((person) => !without.includes(person.name)), ...extra]
  });
}

test('the built-in list keeps everyone who was hardcoded, on the same side', () => {
  for (const name of ['Jacqui Fox', 'Conor Flynn', 'Claire Nicholson', 'Stuart Smith', 'Advait Dharmadhikari', 'Saki Arimoto']) {
    assert.equal(alwaysInternalAttendeeName(name), name, name);
  }
  for (const name of ['Rebecca Gill', 'Ciaran Ryan', 'Claire Doherty']) {
    assert.equal(knownPersonName(name), name, name);
    assert.equal(alwaysInternalAttendeeName(name), '', name);
  }
  assert.equal(knownPersonName('Smith, Stuart M'), 'Stuart Smith');
  assert.equal(knownPersonName('Rebecca Cuckoo'), 'Rebecca Gill');
});

test('a person added on the page is internal straight away, misspellings included', () => {
  assert.equal(alwaysInternalAttendeeName('Niamh Brennan'), '');
  withPeople([{ name: 'Niamh Brennan', side: 'internal', spellings: ['Neve Brennan'] }]);
  assert.equal(alwaysInternalAttendeeName('Niamh Brennan'), 'Niamh Brennan');
  assert.equal(alwaysInternalAttendeeName('Neve Brennan'), 'Niamh Brennan');
  assert.equal(alwaysInternalAttendeeName('Brennan, Niamh'), 'Niamh Brennan');
  assert.equal(alwaysInternalAttendeeName('Niamh Brenan'), 'Niamh Brennan');
  const details = sanitiseDetails({ internalAttendees: ['Jacqui Fox'], clientAttendees: ['Neve Brennan', 'Rebecca Gill'] });
  assert.deepEqual(details.internalAttendees, ['Jacqui Fox', 'Niamh Brennan']);
  assert.deepEqual(details.clientAttendees, ['Rebecca Gill']);
});

test('moving someone to Client on the page stops them being forced internal', () => {
  withPeople([{ name: 'Saki Arimoto', side: 'client', spellings: [] }], { without: ['Saki Arimoto'] });
  assert.equal(alwaysInternalAttendeeName('Saki Arimoto'), '');
  const details = sanitiseDetails({ internalAttendees: ['Jacqui Fox'], clientAttendees: ['Saki Arimoto'] });
  assert.deepEqual(details.clientAttendees, ['Saki Arimoto']);
});

test('removing someone from the page means they are no longer known', () => {
  withPeople([], { without: ['Advait Dharmadhikari'] });
  assert.equal(knownPersonName('Advait Dharmadhikari'), '');
  assert.equal(alwaysInternalAttendeeName('Adwait Dharmadikari'), '');
});

test('a first name shared by two listed people matches neither', () => {
  assert.equal(knownPersonName('Claire'), '');
  withPeople([{ name: 'Jacqui Byrne', side: 'client', spellings: [] }]);
  assert.equal(knownPersonName('Jacqui'), '');
  assert.equal(knownPersonName('Jacqui Fox'), 'Jacqui Fox');
});

const SYNTHETIC_SHARED_FIRST_NAME_PEOPLE = [
  { name: 'Mira Alden', side: 'internal', spellings: ['Miri Alden'] },
  { name: 'Mira Bennett', side: 'client', spellings: ['Miranda Bennett'] },
  { name: 'Mira Colton', side: 'internal', spellings: ['Miriam Colton'] },
  { name: 'Mira Dawson', side: 'client', spellings: ['Mirabel Dawson'] }
];

for (const count of [2, 3, 4]) {
  test(`staged lookup keeps a shared first name ambiguous with ${count} listed people`, () => {
    const people = SYNTHETIC_SHARED_FIRST_NAME_PEOPLE.slice(0, count);
    settingsStore.setSettings({ people });
    assert.equal(knownPerson('Mira'), null);
    for (const name of ['Mira Unknown', 'Mina Unknown']) {
      const result = extractStagedDetailsFromTranscript(`Attendees: ${name}`, 'synthetic.txt');
      assert.deepEqual(result.screens.details.internalAttendees, [], name);
      assert.deepEqual(result.screens.details.clientAttendees, [], name);
      assert.deepEqual(result.screens.details.allAttendees, [name], name);
      assert.equal(result.telemetryPreview.attendeeExtraction.unresolvedAffiliationCount, 1, name);
    }
    for (const person of people) {
      for (const form of [person.name, ...person.spellings]) {
        assert.equal(knownPersonName(form), person.name, form);
        const details = extractStagedDetailsFromTranscript(`Attendees: ${form}`, 'synthetic.txt').screens.details;
        assert.deepEqual(details.internalAttendees, person.side === 'internal' ? [person.name] : [], form);
        assert.deepEqual(details.clientAttendees, person.side === 'client' ? [person.name] : [], form);
        assert.deepEqual(details.allAttendees, [person.name], form);
      }
    }
  });
}

test('registered names and other spellings longer than three tokens resolve exactly', () => {
  const people = [
    { name: 'Mara Elise Van Linden', side: 'internal', spellings: ['Maria Elise De Linden', 'Marissa Elise Anne Van Linden'] },
    { name: 'Tessa Marie Anne De Vries', side: 'client', spellings: ['Theresa Marie De Vries'] }
  ];
  settingsStore.setSettings({ people });
  for (const person of people) {
    for (const form of [person.name, ...person.spellings]) {
      assert.equal(knownPersonName(form), person.name, form);
      assert.equal(knownPersonName(`  ${form.toUpperCase().replace(/ /g, '  ')}  `), person.name, form);
      assert.equal(alwaysInternalAttendeeName(form), person.side === 'internal' ? person.name : '', form);
    }
  }
});

test('unregistered names longer than three tokens do not gain fuzzy matching', () => {
  settingsStore.setSettings({ people: [
    { name: 'Mara Elise Van Linden', side: 'internal', spellings: ['Maria Elise De Linden'] }
  ] });
  for (const name of ['Mara Elise Van Lindon', 'Mara Other Van Linden', 'Maria Elise De Lindon', 'Mara Elise Anne Van Linden']) {
    assert.equal(knownPerson(name), null, name);
    assert.equal(alwaysInternalAttendeeName(name), '', name);
  }
});

test('colliding exact long names and aliases stay ambiguous', () => {
  for (const count of [2, 3, 4]) {
    settingsStore.setSettings({ people: [
      { name: 'Mara Elise Van Linden', side: 'internal', spellings: ['Shared Long Alias Name'] },
      ...SYNTHETIC_SHARED_FIRST_NAME_PEOPLE.slice(0, count - 1).map((person) => ({
        ...person, spellings: ['Mara Elise Van Linden', 'Shared Long Alias Name']
      }))
    ] });
    assert.equal(knownPerson('Mara Elise Van Linden'), null, `${count} colliding people`);
    assert.equal(knownPerson('Shared Long Alias Name'), null, `${count} colliding aliases`);
  }
});

test('a short, common surname alone is not taken as a listed person', () => {
  for (const name of ['Thomas', 'Ryan', 'Gill', 'Kane']) assert.equal(knownPersonName(name), '', name);
});

test('a shared surname does not bypass short first-name matching for added people', () => {
  withPeople([{ name: 'Lena Brennan', side: 'internal', spellings: ['Leena Brennan'] }]);
  for (const name of ['Lina Brennan', 'Nina Brennan', 'Lena Bronson']) {
    assert.equal(knownPersonName(name), '', name);
  }
  assert.equal(knownPersonName('Leena Brennan'), 'Lena Brennan');
  assert.equal(knownPersonName('Lena Brenan'), 'Lena Brennan');
});

test('full-name other spellings are corrected in printed text; directory forms also in the transcript', () => {
  withPeople([{ name: 'Niamh Brennan', side: 'internal', spellings: ['Neve Brennan', 'Brennan, Niamh A'] }]);
  assert.equal(normaliseFixedPersonAliases('Neve Brennan will send it.'), 'Niamh Brennan will send it.');
  assert.equal(normaliseFixedPersonAliases('Neve Brennanson will send it.'), 'Neve Brennanson will send it.');
  assert.equal(normaliseDirectoryNameSpellings('Brennan, Niamh A   0:05'), 'Niamh Brennan   0:05');
  assert.equal(normaliseDirectoryNameSpellings('Neve Brennan   0:05'), 'Neve Brennan   0:05');
  assert.equal(normaliseDirectoryNameSpellings('Smith, Stuart M   0:05'), 'Stuart Smith   0:05');
});

test('Teams speakers are bucketed from the People list as it stands', () => {
  const transcript = [
    'Project review transcript', '',
    'Jacqui Fox   0:05', 'Morning everyone.', '',
    'Niamh Brennan   0:12', 'I have the test results.', '',
    'Rebecca Gill   0:31', 'Thanks, that works for us.'
  ].join('\n');
  const before = sanitiseDetails(extractStagedDetailsFromTranscript(transcript, 'review.vtt').screens.details);
  assert.ok(before.clientAttendees.includes('Niamh Brennan'), JSON.stringify(before));
  withPeople([{ name: 'Niamh Brennan', side: 'internal', spellings: [] }]);
  const after = sanitiseDetails(extractStagedDetailsFromTranscript(transcript, 'review.vtt').screens.details);
  assert.ok(after.internalAttendees.includes('Niamh Brennan'), JSON.stringify(after));
  assert.ok(!after.clientAttendees.includes('Niamh Brennan'), JSON.stringify(after));
});

test('the People form rejects missing, duplicate and clashing entries', () => {
  const others = [{ name: 'Jacqui Fox', spellings: ['J Fox'] }];
  assert.throws(() => validatePerson({ name: '', side: 'internal' }, others), /Add the person’s name/);
  assert.throws(() => validatePerson({ name: 'Niamh', side: '' }, others), /Choose Internal or Client/);
  assert.throws(() => validatePerson({ name: 'jacqui fox', side: 'client' }, others), /already on the list/);
  assert.throws(() => validatePerson({ name: 'Niamh', side: 'client', spellings: ['J Fox'] }, others), /already used for Jacqui Fox/);
  assert.deepEqual(
    validatePerson({ name: '  Niamh  Brennan ', side: 'client', spellings: 'Neve Brennan\n\nneve brennan\nNiamh Brennan' }, others),
    { name: 'Niamh Brennan', side: 'client', spellings: ['Neve Brennan'] }
  );
});
