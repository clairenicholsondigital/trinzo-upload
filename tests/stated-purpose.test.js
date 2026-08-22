'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { statedPurposeFromOpening, purposeFromTitle } = require('../utils/canonicalMinutes/statedPurpose');

// Finding the purpose somebody actually stated.
//
// The pipeline never looked for one, and then told the reviewer "No purpose was stated in
// this meeting" - a claim nothing had tested. On a real transcript opening with "What I
// want from you today on the call is to sense check our academic theory" it was false.
//
// The shapes below are grammar, not subject matter. Nothing here names a client, a
// product or a domain, so a cue cannot prefer one meeting's content to another's.

const events = (...texts) => ({ events: texts.map((text, index) => ({ id: `evt_${index}`, speaker: 'Conor Flynn', text })) });

// A meeting body, so the opening window is a window rather than the whole transcript.
const body = Array.from({ length: 30 }, (unused, index) => `Ordinary discussion turn number ${index} about the work in hand.`);

test('a purpose stated in the opening is found and attributed', () => {
  const found = statedPurposeFromOpening(events(
    'Right, can everyone hear me.',
    'What I want from you today on the call, Keon, is to sense check our academic theory, if you know what I mean.',
    ...body
  ));
  assert.equal(found.text, 'Sense check our academic theory.');
  assert.equal(found.source, 'stated_in_meeting');
  assert.equal(found.speaker, 'Conor Flynn');
  assert.deepEqual(found.evidenceIds, ['evt_1'], 'the sentence must be traceable to the turn it was said in');
});

test('the other ways people say why they called a meeting', () => {
  const cases = [
    ['The purpose of this call is to agree who owns the migration plan.', 'Agree who owns the migration plan.'],
    ['So we are here to work out whether the pilot is worth extending.', 'Work out whether the pilot is worth extending.'],
    ['The reason for this meeting is to close out the outstanding audit findings.', 'Close out the outstanding audit findings.'],
    ['This session is about rebuilding the onboarding flow from scratch.', 'Rebuilding the onboarding flow from scratch.'],
    ['What we are trying to do today is get the pricing model in front of the board.', 'Get the pricing model in front of the board.']
  ];
  for (const [said, expected] of cases) {
    assert.equal(statedPurposeFromOpening(events('Morning all.', said, ...body))?.text, expected, said);
  }
});

test('a purpose is not read out of an ordinary mention of the word', () => {
  // Both of these appear in the committed corpus and neither is a purpose. "the purpose
  // of the file" is a noun; the other is someone thinking aloud, late, about logistics.
  const notPurposes = [
    'We should write down the version history and the purpose of the file.',
    'That is what I am trying to work out at the moment in terms of logistics.',
    'What I want from you is the updated deck before Thursday.',
    'What I want from you today is, is that going to be ready?'
  ];
  for (const text of notPurposes) {
    assert.equal(statedPurposeFromOpening(events('Morning.', text, ...body)), null, text);
  }
});

test('a purpose stated late in a meeting is a request, not the reason for meeting', () => {
  // Same sentence, different position. Past the opening it is somebody asking for
  // something, which belongs in the actions rather than at the top of the minutes.
  const said = 'What I want from you today is to sense check our academic theory.';
  assert.ok(statedPurposeFromOpening(events('Morning.', said, ...body)), 'found near the start');
  assert.equal(statedPurposeFromOpening(events(...body, said)), null, 'ignored near the end');
});

test('a fragment or a question is not published as the purpose', () => {
  const rejected = [
    'The purpose of this call is to and',
    'The purpose of this call is to go.',
    'What I want from you today is to know whether we are still on track?'
  ];
  for (const text of rejected) {
    assert.equal(statedPurposeFromOpening(events('Morning.', text, ...body)), null, text);
  }
});

test('the meeting title is used as written, not dressed into a sentence', () => {
  // The title is the reviewer's own words. Wrapping "The meeting was called to..." around
  // it would be our prose around their label; the flag says where it came from instead.
  assert.equal(purposeFromTitle({ title: 'Review Lean Generation Pipeline' }).text, 'Review Lean Generation Pipeline.');
  assert.equal(purposeFromTitle({ title: 'Weekly delivery status review' }).source, 'meeting_title');
  // An existing full stop is not doubled.
  assert.equal(purposeFromTitle({ title: 'Office relocation planning.' }).text, 'Office relocation planning.');
});

test('a title that names nothing is not offered as a purpose', () => {
  for (const title of ['', 'T819', 'ACME T819', 'Meeting']) {
    assert.equal(purposeFromTitle({ title }), null, JSON.stringify(title));
  }
});

test('the cues carry no meeting vocabulary', () => {
  // The structural guarantee: a cue that named a subject could pull one meeting's
  // wording towards another's. These match how a sentence is built, not what it is about.
  const { PURPOSE_CUES } = require('../utils/canonicalMinutes/statedPurpose');
  const source = PURPOSE_CUES.map((cue) => cue.source).join(' ');
  for (const word of ['audit', 'importer', 'webinar', 'software', 'client', 'invoice', 'lead', 'pipeline']) {
    assert.doesNotMatch(source, new RegExp(`\\b${word}`, 'i'), `cues must not mention "${word}"`);
  }
});
