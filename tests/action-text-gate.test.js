'use strict';

// Generic cases only: none of these sentences come from the evaluation corpus.
const test = require('node:test');
const assert = require('node:assert/strict');
const { transcriptTextIssue, partitionTranscriptText } = require('../utils/actionTextGate');
const api = require('../routes/api');
const {
  reconstructRefereeActions,
  normaliseAgentDeclaredProposals,
  safeAgentProposalPromotion
} = api.stagedEvaluation;

const units = [
  { id: 'T0001', sequence: 1, speaker: 'Chair', text: 'Sam, can you and I go over that later.', classification: 'keep' },
  { id: 'T0002', sequence: 2, speaker: 'Sam', text: "Yes, I'll send the revised floor plan to the landlord on Friday.", classification: 'keep' },
  { id: 'T0003', sequence: 3, speaker: 'Alex', text: 'Do we need to hire extra security?', classification: 'keep' },
  { id: 'T0004', sequence: 4, speaker: 'Chair', text: "No worries Robin, we're on budget, we'll get to you shortly.", classification: 'keep' },
  { id: 'T0005', sequence: 5, speaker: 'Alex', text: 'Round it down to ninety, realistically, after the no-shows.', classification: 'keep' },
  { id: 'T0006', sequence: 6, speaker: 'Robin', text: 'Order forty chairs for the hall.', classification: 'keep' }
];

test('spoken forms are recognised from wording alone', () => {
  assert.equal(transcriptTextIssue('Do we need to hire extra security?', units), 'question');
  assert.equal(transcriptTextIssue('Sam, can you and I go over that later.', units), 'addressed_to_someone');
  assert.equal(transcriptTextIssue("No worries Robin, we're on budget, we'll get to you shortly.", units), 'spoken_opener');
  assert.equal(transcriptTextIssue('Okay so the caterer is confirmed.', units), 'spoken_opener');
  assert.equal(transcriptTextIssue("We'll need to think about the parking at some point.", units), 'conversational_person');
});

test('a copied sentence is rejected unless it is already a written instruction', () => {
  assert.equal(transcriptTextIssue('Round it down to ninety, realistically, after the no-shows.', units), 'verbatim_transcript');
  // Spoken as an instruction, copied as an instruction: fine as an action.
  assert.equal(transcriptTextIssue('Order forty chairs for the hall.', units), '');
});

test('written actions pass, including personal words late in the sentence', () => {
  for (const action of [
    'Send the revised floor plan to the landlord on Friday.',
    'Check whether the venue projector works or whether we bring our own.',
    'Fine-tune the seating plan once numbers are confirmed.',
    'Right-size the catering order after registrations close.',
    'Updating the risk register with the new supplier.',
    'Confirm the booking reference with the hotel.'
  ]) {
    assert.equal(transcriptTextIssue(action, units), '', action);
  }
});

test('the gate can be switched off without a code change', () => {
  const previous = process.env.TRANSCRIPT_TEXT_GATE_V1;
  process.env.TRANSCRIPT_TEXT_GATE_V1 = '0';
  try {
    const { kept } = partitionTranscriptText([{ action: 'Do we need to hire extra security?' }], units);
    assert.equal(kept.length, 1);
  } finally {
    if (previous === undefined) delete process.env.TRANSCRIPT_TEXT_GATE_V1;
    else process.env.TRANSCRIPT_TEXT_GATE_V1 = previous;
  }
});

test('a transcript-seeded candidate accepted by id is not published as the spoken line', () => {
  const candidates = [
    {
      candidateId: 'raw', recordType: 'action', sourcePass: 'deterministic',
      text: 'Sam, can you and I go over that later.', owners: [],
      record: { action: 'Sam, can you and I go over that later.', owners: [], evidenceIds: ['T0001'] },
      evidenceIds: ['T0001']
    },
    {
      candidateId: 'written', recordType: 'action', sourcePass: 'primary',
      text: 'Send the revised floor plan to the landlord.', owners: ['Sam'],
      timing: { kind: 'target', wording: 'Friday', exactDate: '' }, evidenceIds: ['T0002']
    }
  ];
  const rebuilt = reconstructRefereeActions([
    { candidateId: 'raw', disposition: 'publish', reason: 'Seeded.', evidenceIds: ['T0001'] },
    { candidateId: 'written', disposition: 'publish', reason: 'Commitment.', evidenceIds: ['T0002'] }
  ], candidates, units);
  const texts = [...rebuilt.actions, ...(rebuilt.actionProposals || [])].map((item) => item.action);
  assert.ok(!texts.some((textValue) => /can you and I/i.test(textValue)), texts.join(' | '));
  assert.ok(texts.some((textValue) => /floor plan/i.test(textValue)), texts.join(' | '));
});

test('declared proposals drop spoken lines and meeting administration', () => {
  const proposals = normaliseAgentDeclaredProposals({
    actionProposals: [
      { id: 'q', action: 'Do we need to hire extra security?', owners: [], evidenceIds: ['T0003'] },
      { id: 'admin', action: "No worries Robin, we're on budget, we'll get to you shortly.", owners: [], evidenceIds: ['T0004'] },
      { id: 'real', action: 'Send the revised floor plan to the landlord.', owners: ['Sam'], evidenceIds: ['T0002'] }
    ]
  }, units);
  assert.deepEqual(proposals.map((item) => item.action), ['Send the revised floor plan to the landlord.']);
});

test('grounding alone cannot promote a copied sentence', () => {
  const raw = { action: 'Round it down to ninety, realistically, after the no-shows.', owners: [], evidenceIds: ['T0005'] };
  assert.equal(safeAgentProposalPromotion(raw, [], units), false);
});

test('a quoted fragment lifted from the transcript is spoken text; an ordinary quoted name is not', () => {
  const quotedUnits = [{ id: 'T0100', speaker: 'Chair', text: 'Then sort out those three awkward seating situations and finish the plan.' }];
  assert.equal(transcriptTextIssue('Resolve "those three awkward seating situations".', quotedUnits), 'quoted_transcript');
  assert.equal(transcriptTextIssue('Rename the shared folder to "Venue plans 2026".', quotedUnits), '');
});

test('a copied instruction that talks to someone is still spoken text', () => {
  const { transcriptTextIssue } = require('../utils/actionTextGate');
  const units = [
    { id: 'T0001', speaker: 'Dana Moss', text: "Hand over to Lee now, and that's your cue.", classification: 'keep' },
    { id: 'T0002', speaker: 'Sam Carter', text: 'Send the risk register to the auditor before Friday.', classification: 'keep' }
  ];
  assert.equal(transcriptTextIssue("Hand over to Lee now, and that's your cue.", units), 'verbatim_transcript');
  // First person marks speech just as clearly as second.
  assert.equal(transcriptTextIssue('Ring round and get us up to fourteen.',
    [{ id: 'T0003', speaker: 'Dana Moss', text: 'Ring round and get us up to fourteen.', classification: 'keep' }]), 'verbatim_transcript');
  assert.equal(transcriptTextIssue('Ring the refrigeration engineer and book the service.',
    [{ id: 'T0004', speaker: 'Dana Moss', text: 'Ring the refrigeration engineer and book the service.', classification: 'keep' }]), '');
  // A written instruction copied word for word is still a usable action.
  assert.equal(transcriptTextIssue('Send the risk register to the auditor before Friday.', units), '');
});
