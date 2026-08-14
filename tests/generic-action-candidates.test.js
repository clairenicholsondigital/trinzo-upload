'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCommitmentThreads, semanticActionCandidate } = require('../utils/canonicalMinutes/semanticStages');

function profileFor(id, overrides = {}) {
  return { events: { [id]: {
    scores: { commitment: 0.58, request: 0.22, administrative: 0.04, hypothetical: 0.08 },
    actionProbabilities: { confirmed_action: 0.46, possible_action: 0.24, not_action: 0.18, completed_history: 0.02 },
    evidenceProbabilities: { action_commitment: 0.42, document_control_task: 0.28, regulatory_obligation: 0.12, low_value_noise: 0.04 },
    signalProbabilities: { explicit_commitment_verb: 0.72, deliverable_object: 0.68, document_or_record: 0.42 },
    lifecycleProbabilities: { active: 0.7, completed: 0.02, inactive: 0.02 },
    ...overrides
  } } };
}

test('multi-head evidence creates a commitment thread without narrow action grammar', () => {
  const event = { id: 'e1', speaker: 'Chair', turnIndex: 1, text: 'The training attestation will need to be ready before the audit.', roles: [] };
  const evidence = { participants: ['Chair'], events: [event] };
  const profile = profileFor('e1');
  assert.equal(semanticActionCandidate(event, profile), true);
  const threads = buildCommitmentThreads(evidence, profile);
  assert.equal(threads.length, 1);
  assert.deepEqual(threads[0].evidenceIds, ['e1']);
});

test('multi-head evidence rejects administrative chatter despite action-like scores', () => {
  const event = { id: 'e1', speaker: 'Chair', turnIndex: 1, text: "I'll make tea before we finish.", roles: [] };
  const profile = profileFor('e1', {
    scores: { commitment: 0.7, request: 0.05, administrative: 0.82, hypothetical: 0.02 },
    evidenceProbabilities: { action_commitment: 0.2, document_control_task: 0.02, regulatory_obligation: 0.01, low_value_noise: 0.74 }
  });
  assert.equal(semanticActionCandidate(event, profile), false);
});

test('completed work does not become a generic action candidate', () => {
  const event = { id: 'e1', speaker: 'Chair', turnIndex: 1, text: 'I already sent the signed report last week.', roles: [] };
  const profile = profileFor('e1', {
    actionProbabilities: { confirmed_action: 0.2, possible_action: 0.08, not_action: 0.1, completed_history: 0.78 },
    lifecycleProbabilities: { active: 0.05, completed: 0.82, inactive: 0.04 }
  });
  assert.equal(semanticActionCandidate(event, profile), false);
});

test('work that started previously remains eligible when concrete work is still in progress', () => {
  const event = { id: 'e1', speaker: 'Chair', turnIndex: 1, text: 'Megan and Kathryn started yesterday and are working on updating the twelve submission documents.', roles: [] };
  const profile = profileFor('e1', {
    actionProbabilities: { confirmed_action: 0.18, possible_action: 0.22, not_action: 0.16, completed_history: 0.62 },
    lifecycleProbabilities: { active: 0.48, completed: 0.58, inactive: 0.04 },
    evidenceProbabilities: { action_commitment: 0.22, document_control_task: 0.38, regulatory_obligation: 0.02, low_value_noise: 0.62 }
  });
  assert.equal(semanticActionCandidate(event, profile), true);
});

test('an explicit no-action instruction still blocks ongoing monitoring language', () => {
  const event = { id: 'e1', speaker: 'Chair', turnIndex: 1, text: 'This remains a watch item, but there is no action; continue monitoring as normal.', roles: [] };
  assert.equal(semanticActionCandidate(event, profileFor('e1')), false);
});
