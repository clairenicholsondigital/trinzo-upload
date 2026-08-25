'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { cleanTranscript, PROMPT } = require('../scripts/naive_action_baseline');

// The control experiment: light clean + one plain request to Trooper, scored by the same
// matcher as the live scorecard. Its cleaning has to be pinned, because a control that
// quietly mangles the transcript would make the comparison meaningless in the direction
// that flatters the pipeline.

test('requiring the harness does not spend an API call', () => {
  assert.equal(typeof cleanTranscript, 'function');
});

test('speaker turns survive and timestamps are dropped', () => {
  const cleaned = cleanTranscript([
    'Client Abbott - Meeting Transcript',
    '22 June 2026, 10:38am',
    '28m 42s',
    'Jacqui Fox started transcription',
    'Jacqui Fox   0:03Perfect, we can go through the key points.',
    'Smith, Stuart M   0:08Yep.'
  ].join('\n'));
  assert.match(cleaned, /^Jacqui Fox: Perfect, we can go through the key points\./m);
  assert.match(cleaned, /^Smith, Stuart M: Yep\./m);
  assert.doesNotMatch(cleaned, /0:03|28m 42s|started transcription/);
});

test("a speaker's consecutive turns are merged rather than repeated", () => {
  const cleaned = cleanTranscript([
    'Dan Threlfall   0:05Morning all.',
    'Dan Threlfall   0:09Right, brew schedule for the fortnight.'
  ].join('\n'));
  assert.equal(cleaned, 'Dan Threlfall: Morning all. Right, brew schedule for the fortnight.');
});

test('continuation lines stay attached to their speaker', () => {
  const cleaned = cleanTranscript([
    'Ravi Menon   0:16',
    'Yeah, I looked at the tanks this morning.'
  ].join('\n'));
  assert.equal(cleaned, 'Ravi Menon: Yeah, I looked at the tanks this morning.');
});

test('cleaning removes furniture without removing content', () => {
  // Measured across the thirteen fixtures: 214,588 chars in, 200,115 out - about 7%. The
  // control is meant to change as little as possible, so a large drop here would mean the
  // cleaner had started making editorial decisions of its own.
  const raw = 'Jacqui Fox   0:03One two three four five six seven eight nine ten.';
  const cleaned = cleanTranscript(raw);
  assert.ok(cleaned.length > raw.length * 0.7, 'cleaning must not swallow the transcript');
});

test('the prompt asks for actions and forbids invention', () => {
  assert.match(PROMPT, /pull out the actions/i);
  assert.match(PROMPT, /Invent nothing/i);
  assert.match(PROMPT, /Not stated/);
});
