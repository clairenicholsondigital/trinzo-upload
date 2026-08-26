'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { personErrorAssertion } = require('../utils/canonicalMinutes/claimCheck');

// A named person's cognitive error is not minutes content.
//
// "David Didsbury misinterpreted the software." came from "Or I misinterpreted the
// software" - a speaker walking back their own guess mid-conversation. Published as an
// assertion it is inaccurate (he said he MIGHT have), unkind (it records a named person's
// mistake in a client document), and pointless (no decision, action or fact about the
// work). Deterministic because it needs no judgement.

test('an assertion that a named person erred is refused', () => {
  assert.equal(personErrorAssertion('David Didsbury misinterpreted the software.'), true);
  assert.equal(personErrorAssertion('Andrew Kane misunderstood the change request.'), true);
  assert.equal(personErrorAssertion('Rebecca was wrong about the deadline.'), true);
});

test('uncertainty about the WORK is real minutes content and survives', () => {
  // The rule needs a person as its subject. A meeting recording that something is unclear
  // is exactly what minutes are for.
  assert.equal(personErrorAssertion('There was uncertainty regarding the behaviour of the alarm LED when the mute button is pressed.'), false);
  assert.equal(personErrorAssertion('The risk assessment was incorrect and needs revision.'), false);
  assert.equal(personErrorAssertion('The team discussed whether the documentation was misread by the auditor.'), false);
});

test('ordinary records naming a person are untouched', () => {
  assert.equal(personErrorAssertion('David Didsbury reviewed the software versioning.'), false);
  assert.equal(personErrorAssertion('Andrew Kane confirmed the mute button behaviour.'), false);
});

test('empty input is safe', () => {
  assert.equal(personErrorAssertion(''), false);
  assert.equal(personErrorAssertion(null), false);
});
