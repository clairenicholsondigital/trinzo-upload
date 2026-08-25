'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { expandSpokenContractions, normaliseDatePhrases } = require('../utils/spokenForms');
const { repairMechanicalFaults } = require('../utils/minutesEnglish');

// Spoken forms that no minute should carry. Both classes are spelling rather than editing:
// there is no minute that wants "gonna", and a date written "23rd of July" is written
// "23rd July". Neither needs the reviewer's involvement or a model round trip.

const expanded = (text) => expandSpokenContractions(text).text;
const dated = (text) => normaliseDatePhrases(text).text;

test('colloquial contractions expand', () => {
  assert.equal(expanded('Andrew Kane is gonna try and include sound'), 'Andrew Kane is going to try and include sound');
  assert.equal(expanded('We gotta finish the testing'), 'We have to finish the testing');
  assert.equal(expanded('Send it cos the deadline moved'), 'Send it because the deadline moved');
});

test('sentence-initial case is preserved', () => {
  assert.equal(expanded('Gonna send the report'), 'Going to send the report');
});

test('ordinary written contractions are left alone', () => {
  // Expanding these would make minutes read like a legal notice, and they are already
  // correct written English. The voice detectors decide about first person, not this.
  assert.equal(expanded("Don't send it yet"), "Don't send it yet");
  assert.equal(expanded("We'll confirm on Friday"), "We'll confirm on Friday");
  assert.equal(expanded("It's with the client"), "It's with the client");
});

test('a word that merely contains a contraction is untouched', () => {
  assert.equal(expanded('The Costa Rica office'), 'The Costa Rica office');
  assert.equal(expanded('cosmetic changes only'), 'cosmetic changes only');
});

test('spoken date shapes become minutes dates', () => {
  assert.equal(dated('23rd of July'), '23rd July');
  assert.equal(dated('the 23rd of July'), '23rd July');
  assert.equal(dated('July the 23rd'), '23rd July');
  assert.equal(dated('delivery on the 15th August'), 'delivery on 15th August');
});

test('a title-cased ordinal suffix is corrected', () => {
  // The real defect the reviewer saw: an unanchored /[a-z]/i capitaliser matched the first
  // letter ANYWHERE, so "23rd of July" became "23Rd of July". Both capitalisers are now
  // anchored; this handles text that reached us already damaged.
  assert.equal(dated('23Rd of July'), '23rd July');
  assert.equal(dated('22Nd June'), '22nd June');
  assert.equal(dated('30Th June'), '30th June');
});

test('dates already correct, and non-dates, are unchanged', () => {
  assert.equal(dated('23rd July'), '23rd July');
  assert.equal(dated('Not stated'), 'Not stated');
  assert.equal(dated('next Tuesday'), 'next Tuesday');
  assert.equal(dated(''), '');
});

test('both run inside the deterministic mechanical repair', () => {
  // So every published surface gets them before any model sees the text.
  assert.equal(repairMechanicalFaults('Andrew Kane is gonna try and include sound').text,
    'Andrew Kane is going to try and include sound');
  const dateRepair = repairMechanicalFaults('Change request sign off by 23Rd of July');
  assert.equal(dateRepair.text, 'Change request sign off by 23rd July');
  assert.ok(dateRepair.applied.includes('date_format'));
});
