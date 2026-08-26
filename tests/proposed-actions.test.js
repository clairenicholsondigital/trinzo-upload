'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { groundProposals, quoteSupport, resolveProposedOwner, stripOwnerPrefix, promptFor, QUOTE_GROUNDING } = require('../utils/canonicalMinutes/proposedActions');

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

// The owner has its own column. Repeating the name inside the action is redundancy the
// reviewer deletes on every row, and the model produces it despite being asked not to.

test('a leading owner name is stripped from the action text', () => {
  assert.equal(stripOwnerPrefix('Stuart Smith will share the risk analysis with Niamh', 'Stuart Smith'),
    'Share the risk analysis with Niamh');
  assert.equal(stripOwnerPrefix('Stuart will provide the audit plan on Wednesday', 'Stuart Smith'),
    'Provide the audit plan on Wednesday');
});

test('a different person named in the action is information, not repetition', () => {
  // Only THIS row's owner is stripped - "Rebecca will review David's comments" under owner
  // Rebecca loses "Rebecca", never "David".
  const stripped = stripOwnerPrefix('Rebecca will review David comments on the PMS file', 'Rebecca Gill');
  assert.equal(stripped, 'Review David comments on the PMS file');
  assert.match(stripped, /David/);
});

test('stripping never leaves a stub behind', () => {
  // "Stuart Smith will go" would become "Go", which reads as broken rather than terse.
  assert.equal(stripOwnerPrefix('Stuart Smith will go', 'Stuart Smith'), 'Stuart Smith will go');
});

test('an action that already starts with its verb is untouched', () => {
  assert.equal(stripOwnerPrefix('Share the risk analysis before she arrives', 'Stuart Smith'),
    'Share the risk analysis before she arrives');
  assert.equal(stripOwnerPrefix('Send the report to Colm', 'Not stated'), 'Send the report to Colm');
});

test('the grounding threshold sits between fabrication and a trimmed real quote', () => {
  // Measured: a fabricated quote scores 0.17 against the nearest turn; genuine proposals
  // the model trimmed scored 0.46-0.59. The threshold has to sit in that empty band.
  assert.ok(QUOTE_GROUNDING > 0.17 && QUOTE_GROUNDING <= 0.46);
});

// The completeness sweep: a second reading that may only name commitments NOT already
// captured. Same referee as the first pass - these tests pin the sweep-specific parts:
// the prompt carries the captured list and the empty permission, and everything returned
// still has to ground against this transcript.

const { proposeMissedActions, missedPromptFor } = require('../utils/canonicalMinutes/proposedActions');

function stubFetch(items) {
  return async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({ items }) } }] })
  });
}

test('the sweep prompt shows the model what is already captured and permits an empty answer', () => {
  const prompt = missedPromptFor('TRANSCRIPT TEXT', ['Stuart Smith'], [
    { owner: 'Stuart Smith', action: 'Share the risk analysis' },
    { owner: 'Not stated', action: 'Book the room' }
  ]);
  assert.match(prompt, /1\. Stuart Smith: Share the risk analysis/);
  assert.match(prompt, /2\. Book the room/, 'a Not stated owner is not printed as a name');
  assert.match(prompt, /return \{"items":\[\]\}/i);
  assert.match(prompt, /NOT covered/);
});

test('a swept item still has to ground against this transcript', async () => {
  const result = await proposeMissedActions('ignored', evidence, [], {
    apiKey: 'test',
    fetchImpl: stubFetch([
      { owner: 'Stuart Smith', action: 'Share the risk analysis before she arrives', quote: 'we will share the risk analysis with you before you arrive', disposition: 'agreed' },
      { owner: 'Stuart Smith', action: 'Fly to the moon', quote: 'we agreed to fly to the moon next Tuesday', disposition: 'agreed' }
    ])
  });
  assert.equal(result.agreed.length, 1);
  assert.match(result.agreed[0].action, /risk analysis/);
  assert.equal(result.ungrounded.length, 1);
  assert.match(result.ungrounded[0].action, /moon/);
});

test('an empty sweep answer is an empty result, not an error', async () => {
  const result = await proposeMissedActions('ignored', evidence, [{ owner: 'Stuart Smith', action: 'Everything' }], {
    apiKey: 'test',
    fetchImpl: stubFetch([])
  });
  assert.deepEqual(result.agreed, []);
  assert.deepEqual(result.requirements, []);
  assert.equal(result.reason, '');
});

test('a sweep with no API key reports unavailable rather than throwing', async () => {
  const previous = process.env.TROOPER_API_KEY;
  delete process.env.TROOPER_API_KEY;
  try {
    const result = await proposeMissedActions('ignored', evidence, [], { fetchImpl: async () => { throw new Error('must not be called'); } });
    assert.equal(result.reason, 'unavailable');
    assert.deepEqual(result.agreed, []);
  } finally {
    if (previous !== undefined) process.env.TROOPER_API_KEY = previous;
  }
});

// Delegation beats a first-person marker elsewhere in the same turn.
//
// "I'll pick that up - Niamh, can you send the invoice?" is the shape a chair produces
// every few turns, and the first-person test used to run first over the WHOLE turn: the
// chair owned the invoice, and the greedy capture swallowed the delegated clause into
// the action text. Measured on the ground-truth fixtures, that put one chair's name on
// three actions belonging to three different people.

const { explicitOwner } = require('../utils/canonicalMinutes/actionResolution');
const delegationEvidence = { participants: ['Niamh Lynch', 'Jacqui Fox', 'Rebecca Gill'] };

test('work delegated after a commitment belongs to the person it was delegated to', () => {
  assert.equal(
    explicitOwner({ text: "I'll pick that up - Niamh, can you send the invoice?", speaker: 'Jacqui Fox' }, delegationEvidence),
    'Niamh Lynch'
  );
  assert.equal(
    explicitOwner({ text: "I'll do the plan. Niamh, please review it", speaker: 'Jacqui Fox' }, delegationEvidence),
    'Niamh Lynch'
  );
});

test('a plain first-person commitment still belongs to the speaker', () => {
  assert.equal(
    explicitOwner({ text: "I'll send the invoice myself.", speaker: 'Jacqui Fox' }, delegationEvidence),
    'Jacqui Fox'
  );
  assert.equal(
    explicitOwner({ text: 'I will handle the risk file', speaker: 'Rebecca Gill' }, delegationEvidence),
    'Rebecca Gill'
  );
});

test('an unknown addressee does not silently become the speaker', () => {
  // participantByFirstName declines when the name is not a single known participant, and
  // the turn plainly delegated - so the row goes out ownerless rather than mis-owned.
  assert.equal(
    explicitOwner({ text: 'Malcolm, can you take the smaller role?', speaker: 'Jacqui Fox' }, delegationEvidence),
    ''
  );
});
