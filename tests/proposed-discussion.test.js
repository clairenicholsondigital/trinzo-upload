'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { groundDiscussionProposals, promptFor } = require('../utils/canonicalMinutes/proposedDiscussion');
const { bestQuoteSupport } = require('../utils/canonicalMinutes/proposedActions');

// Discussion by proposal, restraint by validation. The deterministic path fragments a
// narrated story across MiniLM micro-clusters - Andrew's alarm demonstration split into
// five, so the card surfaced screen-share mechanics while the demonstration scattered.
// The model keeps the story together; these tests pin the deterministic vetoes.

const evidence = {
  events: [
    { id: 'e1', turnId: 't1', turnIndex: 0, text: "So that's our existing alarm, so every alarm is out signed." },
    { id: 'e2', turnId: 't1', turnIndex: 0, text: "So I've got these three alarms now." },
    { id: 'e3', turnId: 't1', turnIndex: 0, text: "I've tested them on the scope and they look, they're a great thing." },
    { id: 'e4', turnId: 't2', turnIndex: 1, text: 'Arabic, Vietnamese and Greek are the difficult languages.' }
  ]
};

test('a quote spanning several sentences of one turn still grounds', () => {
  // prepareEvidence splits turns into per-sentence events, so the demonstration quote
  // scored 0.41 against its best single sentence and was refused - while the whole turn
  // contains it entirely. Support is measured against turns too; the threshold never moves.
  const quote = "that's our existing alarm, so every alarm is out signed. So I've got these three alarms now. I've tested them on the scope";
  const best = bestQuoteSupport(quote, evidence);
  assert.ok(best.score >= 0.9, `whole-turn support should be near-perfect, got ${best.score}`);
  assert.ok(best.evidenceIds.length >= 2, 'the grounding cites the sentences of that turn');
});

test('a grounded point survives with the turn evidence attached', () => {
  const { grounded, refused } = groundDiscussionProposals([{
    topic: 'Alarm demonstration',
    point: 'Andrew demonstrated the three alarm priorities and confirmed all were working.',
    quote: "I've got these three alarms now. I've tested them on the scope"
  }], evidence);
  assert.equal(refused.length, 0);
  assert.equal(grounded.length, 1);
  assert.ok(grounded[0].evidenceIds.length >= 1);
});

test('an unsupported point is refused, never rewritten to fit', () => {
  const { grounded, refused } = groundDiscussionProposals([{
    topic: 'Budget', point: 'The team agreed a budget of nine million pounds.', quote: 'we agreed nine million pounds for the budget'
  }], evidence);
  assert.equal(grounded.length, 0);
  assert.equal(refused[0].reason, 'quote_not_found_in_transcript');
});

test('a point that duplicates the screen is dropped', () => {
  const { refused } = groundDiscussionProposals([{
    topic: 'Languages', point: 'Arabic, Vietnamese and Greek are the difficult languages.', quote: 'Arabic, Vietnamese and Greek are the difficult languages.'
  }], evidence, ['Arabic, Vietnamese and Greek are identified as the difficult languages.']);
  assert.equal(refused[0].reason, 'duplicate');
});

test('a point with a wording fault is refused - extra coverage is not worth repairing', () => {
  const { refused } = groundDiscussionProposals([{
    topic: 'Alarms', point: "I'll test the alarms on the scope myself.", quote: "I've tested them on the scope"
  }], evidence);
  assert.equal(refused[0].reason, 'wording_fault');
});

test('the prompt forbids meeting mechanics and demands verbatim quotes', () => {
  const prompt = promptFor('Some transcript');
  assert.match(prompt, /meeting mechanics are not minutes content/i);
  assert.match(prompt, /VERBATIM/);
  assert.match(prompt, /Invent nothing/i);
});
