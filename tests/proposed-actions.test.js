'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { groundProposals, quoteSupport, resolveProposedOwner, promptFor, QUOTE_GROUNDING } = require('../utils/canonicalMinutes/proposedActions');

// Discovery by proposal, restraint by validation.
//
// The model finds far more actions than the regex whitelist did (39-40 of 102 against 29),
// and it is much worse at knowing when a meeting agreed nothing - it produced seven action
// rows for a residents' meeting whose correct answer is zero. Every veto therefore stays
// deterministic, and these tests pin the vetoes rather than the model.

const evidence = {
  events: [
    { id: 'e1', text: 'And we will share the risk analysis with you before you arrive so you can see the information.' },
    { id: 'e2', text: 'Consider painting the visitor bays a different colour so people can see them.' }
  ],
  participants: [{ name: 'Stuart Smith' }, { name: 'Niamh Lynch' }]
};

test('a proposal whose quote resolves to a turn is grounded to that turn', () => {
  const { grounded } = groundProposals([
    { owner: 'Stuart', action: 'Share the risk analysis before arrival', quote: 'we will share the risk analysis with you before you arrive', disposition: 'agreed' }
  ], evidence);
  assert.equal(grounded.length, 1);
  assert.deepEqual(grounded[0].evidenceIds, ['e1']);
  assert.equal(grounded[0].disposition, 'agreed');
});

test('a proposal the transcript does not support is refused, not rewritten', () => {
  // The shape a fabricated action takes: plausible sentence, no supporting turn.
  const { grounded, ungrounded } = groundProposals([
    { owner: 'Stuart', action: 'Fly to the moon', quote: 'we agreed to fly to the moon next Tuesday', disposition: 'agreed' }
  ], evidence);
  assert.equal(grounded.length, 0);
  assert.equal(ungrounded[0].reason, 'quote_not_found_in_transcript');
});

test('a proposal with no quote at all is refused', () => {
  const { grounded, ungrounded } = groundProposals([{ owner: 'Stuart', action: 'Do the thing', disposition: 'agreed' }], evidence);
  assert.equal(grounded.length, 0);
  assert.equal(ungrounded[0].reason, 'missing_action_or_quote');
});

test('an option the meeting never agreed keeps its own disposition', () => {
  // This is the parking failure: without the third bucket these become published actions.
  const { grounded } = groundProposals([
    { owner: 'Not stated', action: 'Paint the visitor bays', quote: 'Consider painting the visitor bays a different colour', disposition: 'considered' }
  ], evidence);
  assert.equal(grounded[0].disposition, 'considered');
});

test('an unrecognised disposition falls back to requirement, never to agreed', () => {
  // Defaulting to "agreed" would let a malformed response publish commitments nobody made.
  const { grounded } = groundProposals([
    { owner: 'Stuart', action: 'Share the risk analysis', quote: 'we will share the risk analysis with you before you arrive', disposition: 'probably' }
  ], evidence);
  assert.equal(grounded[0].disposition, 'requirement');
});

test('a first name resolves to the participant, an unknown owner does not', () => {
  assert.equal(resolveProposedOwner('Stuart', ['Stuart Smith', 'Niamh Lynch']), 'Stuart Smith');
  // Attributing work to somebody the meeting never mentioned is fabrication even when the
  // action itself is real.
  assert.equal(resolveProposedOwner('Gerald', ['Stuart Smith']), 'Not stated');
  assert.equal(resolveProposedOwner('', ['Stuart Smith']), 'Not stated');
});

test('quote support is measured against the quote, not the turn', () => {
  // Symmetric overlap would let a one-word turn ground anything - the same bug that made
  // the attribution harness report "0 actions need synthesis" on its first run.
  assert.ok(quoteSupport('share the risk analysis', 'we will share the risk analysis with you before you arrive') >= QUOTE_GROUNDING);
  assert.ok(quoteSupport('share the risk analysis before the audit begins on site', 'Yes.') < QUOTE_GROUNDING);
});

test('the prompt distinguishes agreed from considered and forbids invention', () => {
  const prompt = promptFor('Some transcript', ['Stuart Smith']);
  assert.match(prompt, /"considered"/);
  assert.match(prompt, /reached no decision has NO agreed items/i);
  assert.match(prompt, /Invent nothing/i);
  assert.match(prompt, /VERBATIM/);
});
