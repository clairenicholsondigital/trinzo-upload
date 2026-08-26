'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { minutesEnglishFaults } = require('../utils/minutesEnglish');
const { unresolvedReference } = require('../utils/canonicalMinutes/trooperPolish');

// The Abbott review named the rows this file pins: speech fragments that every existing
// gate passed. The new detectors are OPT-IN via spokenRegister - the deterministic
// corpus paths consult minutesEnglishFaults with no options, and a new default fault
// would silently change 122 baselines.

test('the spoken-register detectors are opt-in: no options, no new faults', () => {
  assert.deepEqual(minutesEnglishFaults('Limit the risk for them, yeah, okay.'), []);
  assert.deepEqual(minutesEnglishFaults("It's a deep dive into their software management system."), []);
});

test('trailing interjections are conversational filler under the flag', () => {
  const codes = minutesEnglishFaults('Limit the risk for them, yeah, okay.', { spokenRegister: true }).map((fault) => fault.code);
  assert.ok(codes.includes('conversational_filler'));
});

test('a contracted opener reads as speech under the flag', () => {
  const codes = minutesEnglishFaults("It's a deep dive into their software management system.", { spokenRegister: true }).map((fault) => fault.code);
  assert.ok(codes.includes('spoken_contraction_opener'));
});

test('ordinary minutes prose carries no spoken-register fault', () => {
  for (const text of [
    'The audit will be a deep dive into the software management system.',
    'Stuart Smith confirmed the scope, standards and software context.',
    'The team agreed to check whether the arrangement is okay with the site.',
    'It was agreed that the documents would be shared in advance.'
  ]) {
    assert.deepEqual(minutesEnglishFaults(text, { spokenRegister: true }), [], text);
  }
});

test('a bare "them" is an unresolved reference: the record names nobody', () => {
  assert.equal(unresolvedReference('Limit risk for them'), true);
  assert.equal(unresolvedReference('Send the agenda to them before the call'), true);
  assert.equal(unresolvedReference('Send the agenda to the auditors before the call'), false);
});

test('the repeated-name detector fires on the discussion failure once the roster arrives', () => {
  const text = 'Stuart Smith knows when Stuart Smith was there last time, Stuart Smith had concerns about the process.';
  const codes = minutesEnglishFaults(text, { people: ['Stuart Smith', 'Niamh Lynch'] }).map((fault) => fault.code);
  assert.ok(codes.includes('repeated_person_name'));
});
