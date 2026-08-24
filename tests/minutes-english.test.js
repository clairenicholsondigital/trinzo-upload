'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { minutesEnglishFaults, repairMechanicalFaults } = require('../utils/minutesEnglish');

// The shared "reads as English somebody would write" detectors.
//
// A reviewer listed forty examples of broken wording across eleven transcripts and asked
// for one thing: "I'm not expecting the exact wording each and every time, just not broken
// wording." Every rule here is grammatical - it names no meetings, no domains and no
// phrases - because a rule made of phrases has to be extended once per transcript and the
// transcripts are all different.
//
// Each rule is therefore tested in both directions. The examples it must catch come from
// the reviewer's list; the sentences it must not touch are the ones that would make the
// rule useless if it were slightly too greedy, and several of them are here because an
// earlier draft of the rule DID reject them.

const codes = (text, options) => minutesEnglishFaults(text, options).map((fault) => fault.code);

test('a speaker restarting a phrase is not writing', () => {
  assert.deepEqual(codes('Get one from the, from the place on Mill Road'), ['phrase_restart']);
  assert.deepEqual(codes('Oh good, because that was, that was really dragging'), ['phrase_restart']);
});

test('deliberate repetition survives the restart rule', () => {
  // "had had" and "that that" are the single-token exceptions the discussion chain already
  // carries; this rule is the multi-token case and must not swallow them.
  for (const fine of ['He had had enough time', 'The team agreed that that approach was right', 'Row after row of stock']) {
    assert.deepEqual(codes(fine), [], fine);
  }
});

test('existential there followed by a second finite verb has no reading', () => {
  assert.deepEqual(codes('There is another person is also staying in the hotel'), ['existential_stacked_verb']);
});

test('a licensed second verb is an ordinary sentence', () => {
  // A complementiser, a relative or a coordinator makes the second verb grammatical. Only
  // the existential form is refused, because "The problem is the schedule is tight" is
  // legitimate English and a general stacked-copula rule would reject it.
  for (const fine of [
    'There is a risk that the chiller fails during the ferment',
    'There are three items that are still outstanding',
    'There is nothing that is blocking the release',
    'The plan is that testing is complete'
  ]) {
    assert.deepEqual(codes(fine), [], fine);
  }
});

test('a definition that defines nothing, and an adjunct that adds nothing', () => {
  assert.deepEqual(codes('The Ideal Client Profile (ICP) is defined as the ideal client profile.'), ['tautology']);
  assert.deepEqual(codes('Review the risk analysis whilst looking at the risk.'), ['empty_adjunct']);
});

test('a real definition and a real adjunct survive', () => {
  for (const fine of [
    'The ICP is defined as the set of accounts with more than fifty seats',
    'Escalation means contacting the account director within one day',
    'The risk register is the single source of truth',
    // The finite verb is why this is a real clause rather than a restatement.
    'Send the report once the report is signed',
    'Reduce cost by consolidating the supplier list',
    'Confirm the budget before the budget meeting'
  ]) {
    assert.deepEqual(codes(fine), [], fine);
  }
});

test('a sentence ending on a degree pre-modifier was cut off', () => {
  assert.deepEqual(codes('Barely enough last year and someone nearly'), ['truncated_premodifier']);
});

test('ordinary adverbs are not truncation', () => {
  // The rule is a closed function-word class, NOT "ends in an adverb". An -ly rule rejects
  // "properly", "annually", "immediately" - and "properly this time" is the reviewer's own
  // text. It also rejects every -ly noun: family, supply, July.
  for (const fine of [
    'Write to the council again, properly this time',
    'Submit the application quarterly',
    'Complete the testing early',
    'Circulate the note to the family'
  ]) {
    assert.deepEqual(codes(fine), [], fine);
  }
});

test('a demonstrative points at something the reader cannot see', () => {
  // A deictic points at something in the room. A published minute has no room.
  assert.deepEqual(codes('Find that little clock top right'), ['unresolved_deixis']);
  assert.deepEqual(codes('Flick this over to Orla'), ['unresolved_deixis']);
  assert.deepEqual(codes('Bring that to the US team'), ['unresolved_deixis']);
});

test('complementisers, relatives and dates are not deixis', () => {
  for (const fine of [
    'Confirm that the invoice was paid',
    'There are three items that are still outstanding',
    'The plan is that testing is complete',
    // A demonstrative on a temporal noun is resolved by the meeting's own date.
    'Send the updated floor plan this afternoon',
    'Sign only the marketing MOU this month',
    'Reconvene at the end of that quarter'
  ]) {
    assert.deepEqual(codes(fine), [], fine);
  }
});

test('an initialism is not a pronoun', () => {
  // "Bring that to the US team" was reported as first person because a case-insensitive
  // \bus\b matches the United States. Sentence-initial capitals must still count.
  assert.ok(!codes('Share the deck with the US team').includes('first_or_second_person'));
  assert.ok(codes('We agreed to share the deck').includes('first_or_second_person'));
  assert.ok(codes('Send both of you the latest attendee count').includes('first_or_second_person'));
});

test('the same person is not named twice in one breath', () => {
  // This fault is manufactured by our own code: the pipeline substitutes a speaker's name
  // for "I" and does it more than once in the same sentence.
  const people = ['Stuart Smith', 'Jacqui Fox'];
  assert.ok(codes('Stuart Smith knows when Stuart Smith was there last time', { people }).includes('repeated_person_name'));
  // Keyed on people, not on repeated strings, so a company sharing a name is untouched.
  assert.deepEqual(codes('Send the Abbott report to Abbott', { people }), []);
});

test('mechanical repair removes redundancy without changing the claim', () => {
  assert.equal(repairMechanicalFaults('Get one from the, from the place on Mill Road').text,
    'Get one from the place on Mill Road');
  assert.equal(repairMechanicalFaults('Karen.and Niamh will attend').text, 'Karen. and Niamh will attend');
  assert.equal(repairMechanicalFaults('Stuart Smith knows when Stuart Smith was there', { people: ['Stuart Smith'] }).text,
    'Stuart Smith knows when Smith was there');
});

test('a clean line is returned untouched', () => {
  const clean = 'Complete the electrical compliance testing before the 23rd of July.';
  assert.deepEqual(codes(clean), []);
  assert.equal(repairMechanicalFaults(clean).text, clean);
  assert.deepEqual(repairMechanicalFaults(clean).applied, []);
});
