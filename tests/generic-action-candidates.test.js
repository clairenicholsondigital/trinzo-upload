'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { actionsFromThread, buildCommitmentThreads, semanticActionCandidate } = require('../utils/canonicalMinutes/semanticStages');

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

test('collective plan, contextual acceptance and reaffirmation resolve into one grounded action', () => {
  const events = [
    { id: 'e1', speaker: 'Conor Flynn', turnIndex: 1, text: 'If the group agrees, what we want to do is take a really, really small slice and manually do it.', roles: [] },
    ...Array.from({ length: 9 }, (_, index) => ({ id: `f${index}`, speaker: 'Conor Flynn', turnIndex: 1, text: `Explanation ${index + 1} of the proposed operating model.`, roles: [] })),
    { id: 'e2', speaker: 'Keon Fox', turnIndex: 2, text: 'Yeah, I agree.', roles: [] },
    { id: 'e3', speaker: 'Conor Flynn', turnIndex: 3, text: "And then we're going to test it.", roles: [] }
  ];
  const evidence = { participants: ['Conor Flynn', 'Keon Fox'], events };
  const profile = { events: {
    e1: {
      scores: { commitment: 0.18, request: 0.18, administrative: 0.05, hypothetical: 0.62 },
      actionProbabilities: { confirmed_action: 0.05, possible_action: 0.3, not_action: 0.52, completed_history: 0.02 },
      evidenceProbabilities: { action_commitment: 0.08, document_control_task: 0.2, regulatory_obligation: 0.01, low_value_noise: 0.05 },
      signalProbabilities: { explicit_commitment_verb: 0.38, deliverable_object: 0.5, document_or_record: 0.2 },
      lifecycleProbabilities: { active: 0.24, completed: 0.02, inactive: 0.02 }
    },
    e2: {
      scores: { commitment: 0.05, request: 0.02, acceptance: 0.04, administrative: 0.05, hypothetical: 0.9 },
      discourseRoleProbabilities: { acceptance: 0.82 },
      contextDependencyProbabilities: { accepts_previous: 0.86 },
      actionProbabilities: { confirmed_action: 0.02, possible_action: 0.22, not_action: 0.7, completed_history: 0.01 },
      signalProbabilities: { explicit_commitment_verb: 0.05, deliverable_object: 0.05 },
      lifecycleProbabilities: { active: 0.1 }
    },
    e3: {
      scores: { commitment: 0.25, request: 0.05, administrative: 0.08, hypothetical: 0.5 },
      actionProbabilities: { confirmed_action: 0.08, possible_action: 0.35, not_action: 0.5, completed_history: 0.02 },
      evidenceProbabilities: { action_commitment: 0.1, document_control_task: 0.15, low_value_noise: 0.08 },
      signalProbabilities: { explicit_commitment_verb: 0.3, deliverable_object: 0.45 },
      lifecycleProbabilities: { active: 0.2 }
    }
  } };

  const threads = buildCommitmentThreads(evidence, profile);
  const matching = threads.find((thread) => thread.evidenceIds.includes('e1'));
  assert.deepEqual(matching.evidenceIds, ['e1', 'e2', 'e3']);
  const actions = actionsFromThread(matching, evidence, profile);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].action, 'Manually test a small slice');
  assert.equal(actions[0].owner, 'Not stated');
  assert.equal(actions[0].explicitFutureCommitment, true);
});

test('required but unassigned work becomes a bounded reviewable action without inventing an owner', () => {
  const event = {
    id: 'e1', speaker: 'Jack Cunningham', turnIndex: 1, roles: [],
    text: 'There is something that needs to be defined as a team is how we establish the acceptance criteria for supplier onboarding.'
  };
  const evidence = { participants: ['Jack Cunningham'], events: [event] };
  const profile = profileFor('e1', {
    scores: { commitment: 0.15, request: 0.15, administrative: 0.05, hypothetical: 0.35 },
    actionProbabilities: { confirmed_action: 0.04, possible_action: 0.28, not_action: 0.68, completed_history: 0.01 },
    lifecycleProbabilities: { active: 0.38, completed: 0.02, inactive: 0.02 }
  });
  const thread = buildCommitmentThreads(evidence, profile)[0];
  const actions = actionsFromThread(thread, evidence, profile);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].action, 'Define the acceptance criteria for supplier onboarding');
  assert.equal(actions[0].owner, 'Not stated');
  assert.equal(actions[0].speechAct, 'required_unassigned_work');
});

test('an unaccepted conditional plan is not promoted', () => {
  const event = { id: 'e1', speaker: 'Chair', turnIndex: 1, roles: [], text: 'If funding is approved, what we want to do is launch a four-week pilot.' };
  const evidence = { participants: ['Chair'], events: [event] };
  const profile = profileFor('e1', {
    scores: { commitment: 0.12, request: 0.08, administrative: 0.04, hypothetical: 0.86 },
    actionProbabilities: { confirmed_action: 0.04, possible_action: 0.3, not_action: 0.62, completed_history: 0.01 },
    lifecycleProbabilities: { active: 0.16, completed: 0.01, inactive: 0.02 }
  });
  const thread = buildCommitmentThreads(evidence, profile)[0];
  assert.deepEqual(actionsFromThread(thread, evidence, profile), []);
});

test('a proposed operating-process description does not become an action', () => {
  const event = { id: 'e1', speaker: 'Chair', turnIndex: 1, roles: [], text: 'The operator would then review the signal and prepare a pack.' };
  const profile = profileFor('e1', {
    scores: { commitment: 0.08, request: 0.06, administrative: 0.05, hypothetical: 0.82 },
    actionProbabilities: { confirmed_action: 0.04, possible_action: 0.3, not_action: 0.62, completed_history: 0.01 },
    evidenceProbabilities: { action_commitment: 0.08, document_control_task: 0.18, regulatory_obligation: 0.01, low_value_noise: 0.05 }
  });
  assert.equal(semanticActionCandidate(event, profile), false);
});
