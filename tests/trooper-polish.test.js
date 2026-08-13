'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { polishCanonicalStage, promptFor, unresolvedReference, nonActionState, nearDuplicate, addRecoveredActionCandidates } = require('../utils/canonicalMinutes/trooperPolish');

function actionPayload() {
  return {
    stagedStage: 'actions',
    screens: { actions: [{ owner: 'Jacqui Fox', action: 'Flick this over to Orla', deadline: 'Not stated', evidenceIds: ['evt_2'] }] },
    decisions: [], risks: [],
    _canonicalEvidencePack: [{
      itemIndex: 0, owner: 'Jacqui Fox', action: 'Flick this over to Orla', deadline: 'Not stated',
      evidence: [{ id: 'evt_2', speaker: 'Jacqui Fox', previous: 'The QMS manual is ready for review.', current: 'I will flick this over to Orla.', next: 'She can review the importer procedures.' }]
    }]
  };
}

test('Trooper prompt contains bounded MiniLM context and no full transcript block', () => {
  const payload = actionPayload();
  const prompt = promptFor('actions', payload, payload._canonicalEvidencePack);
  assert.match(prompt, /BOUNDED_MINILM_EVIDENCE/);
  assert.match(prompt, /QMS manual is ready for review/);
  assert.doesNotMatch(prompt, /\[TRANSCRIPT\]/);
  assert.match(promptFor('actions', payload, payload._canonicalEvidencePack, { reviewerGuidance: 'Emphasise regulatory deadlines.' }), /Emphasise regulatory deadlines/);
});

test('Trooper action rewrite resolves a deictic action from cited context', async () => {
  let requestBody;
  const result = await polishCanonicalStage(actionPayload(), {
    apiKey: 'test-key',
    fetchImpl: async (_url, request) => {
      requestBody = JSON.parse(request.body);
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ actions: [{ itemIndex: 0, owner: 'Jacqui Fox', action: 'Send the QMS manual to Orla for review', deadline: 'Not stated', evidenceIds: ['evt_2'] }] }) } }], usage: { total_tokens: 123 } })
      };
    }
  });
  assert.equal(result.used, true);
  assert.equal(result.payload.screens.actions[0].action, 'Send the QMS manual to Orla for review');
  assert.equal(requestBody.messages[0].role, 'system');
  assert.equal(requestBody.temperature, 0.1);
  assert.equal(requestBody.messages[1].content.includes('[TRANSCRIPT]'), false);
});

test('Trooper action rewrite cannot change owner or retain unresolved references', async () => {
  const result = await polishCanonicalStage(actionPayload(), {
    apiKey: 'test-key',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ actions: [{ itemIndex: 0, owner: 'Orla', action: 'Flick this over to her', deadline: 'Friday', evidenceIds: ['evt_2'] }] }) } }] })
    })
  });
  assert.deepEqual(result.payload.screens.actions, []);
  assert.equal(unresolvedReference('Discuss it with Louise and see what she says'), true);
});

test('missing Trooper configuration safely suppresses unresolved actions without leaking the private pack', async () => {
  const result = await polishCanonicalStage(actionPayload(), { apiKey: '' });
  assert.equal(result.used, false);
  assert.deepEqual(result.payload.screens.actions, []);
  assert.equal('_canonicalEvidencePack' in result.payload, false);
});

test('post-Trooper checks reject availability states and repeated discussion prose', () => {
  assert.equal(nonActionState('Be out for the next couple of days'), true);
  assert.equal(nonActionState('Review the mute-button flash sequence'), false);
  assert.equal(nearDuplicate(
    'The team reviewed technical-file progress, current priorities and outstanding deliverables.',
    'Technical-file progress, current priorities and outstanding deliverables were reviewed.'
  ), true);
});

test('evidence-bound recovery candidates join the Trooper pack without entering the UI directly', () => {
  const payload = actionPayload();
  const enriched = addRecoveredActionCandidates(payload, [{ owner: 'Andrew Kane', action: 'Review the mute-button flash sequence', deadline: 'Friday', evidence: 'Andrew said he needed to review the mute-button LED behaviour.' }]);
  assert.equal(enriched.screens.actions.length, 1);
  assert.equal(enriched._canonicalEvidencePack.length, 2);
  assert.equal(enriched._canonicalEvidencePack[1].action, 'Review the mute-button flash sequence');
  assert.equal(enriched._canonicalEvidencePack[1].evidence[0].current.includes('mute-button LED'), true);
});
