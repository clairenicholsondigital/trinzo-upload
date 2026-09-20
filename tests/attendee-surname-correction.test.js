'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normaliseAttendeeReferences,
  findAttendeeSurnameCorrections,
  normaliseFixedPersonAliases,
  normaliseFixedPersonAliasesDeep
} = require('../utils/entityNormalization');

// A transcription that gets the first name right and invents the surname.
//
// Teams wrote "Rebecca Cuckoo" 388 times across this corpus where the attendee is Rebecca
// Gill. The existing check (possible_attendee_name_mismatch) detected exactly this and only
// WARNED, so the invented surname travelled into owners, prose and the final document.
// findAttendeeTextCorrections could not help: it compares FIRST names by edit distance, and
// "Rebecca" is already correct - no edit distance connects "Cuckoo" to "Gill".

const attendees = ['Rebecca Gill', 'Jacqui Fox', 'David Didsbury'];

test('an invented surname is corrected against the attendee list', () => {
  const { text } = normaliseAttendeeReferences('Rebecca Cuckoo is continuing to review the USB port side of things.', attendees);
  assert.match(text, /Rebecca Gill is continuing/);
  assert.doesNotMatch(text, /Cuckoo/);
});

test("an attendee's own name is left alone", () => {
  const text = 'Rebecca Gill will update the risk file.';
  assert.equal(normaliseAttendeeReferences(text, attendees).text, text);
});

test('a first name with no surname after it is not touched', () => {
  // "Rebecca had a look" is a first name followed by a verb, not a mangled full name.
  const text = 'Rebecca had a look at the tracker.';
  assert.equal(normaliseAttendeeReferences(text, attendees).text, text);
});

test('two attendees sharing a first name disable the correction entirely', () => {
  // The two-Jos meeting: renaming one into the other would be worse than leaving both as
  // the transcript spelled them. attendeeFirstNames drops first names shared by two people,
  // so an ambiguous first name resolves to nothing.
  const text = 'Jo Bennett and Jo Marsh will split the marshalling between them.';
  assert.equal(normaliseAttendeeReferences(text, ['Jo Bennett', 'Jo Marsh']).text, text);
});

test('an attendee recorded without a surname cannot supply one', () => {
  assert.deepEqual(findAttendeeSurnameCorrections('Rebecca Cuckoo will review it.', ['Rebecca']), []);
});

test('other people in the same sentence are unaffected', () => {
  const { text } = normaliseAttendeeReferences('Rebecca Cuckoo asked David Didsbury to review it.', attendees);
  assert.match(text, /Rebecca Gill asked David Didsbury/);
});

test('the confirmed Rebecca alias is corrected without needing an attendee list', () => {
  assert.equal(
    normaliseFixedPersonAliases('Owner: Rebecca Cuckoo; reviewer: REBECCA   CUCKOO.'),
    'Owner: Rebecca Gill; reviewer: Rebecca Gill.'
  );
});

test('the confirmed Rebecca alias is corrected throughout nested review data', () => {
  const corrected = normaliseFixedPersonAliasesDeep({
    attendees: ['Rebecca Cuckoo'],
    discussion: [{ text: 'Rebecca Cuckoo reviewed the file.' }],
    actions: [{ owners: ['Rebecca Cuckoo'], action: 'Send the update to Rebecca Cuckoo.' }],
    warning: 'Check Rebecca Cuckoo.'
  });
  assert.deepEqual(corrected, {
    attendees: ['Rebecca Gill'],
    discussion: [{ text: 'Rebecca Gill reviewed the file.' }],
    actions: [{ owners: ['Rebecca Gill'], action: 'Send the update to Rebecca Gill.' }],
    warning: 'Check Rebecca Gill.'
  });
});
