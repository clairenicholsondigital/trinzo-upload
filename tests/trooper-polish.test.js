'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { polishCanonicalStage, promptFor, unresolvedReference, nonActionState, nearDuplicate, addRecoveredActionCandidates, clientReadyPresentation, normaliseActionPresentation } = require('../utils/canonicalMinutes/trooperPolish');

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
  assert.match(prompt, /never guess an acronym expansion/i);
});

test('large action packs are reviewed in bounded batches', async () => {
  const payload = actionPayload();
  const subjects = ['quality', 'clinical', 'electrical', 'software', 'labelling', 'supplier', 'warehouse', 'complaints', 'training'];
  payload._canonicalEvidencePack = Array.from({ length: 9 }, (_unused, index) => ({
    itemIndex: index,
    owner: 'Jacqui Fox',
    action: `Review the ${subjects[index]} regulatory document`,
    deadline: 'Not stated',
    selectionMode: 'canonical_selected_action',
    evidence: [{ id: `evt_${index + 1}`, speaker: 'Jacqui Fox', current: `I will review the ${subjects[index]} regulatory document.`, contextWindow: [] }]
  }));
  let calls = 0;
  const result = await polishCanonicalStage(payload, {
    apiKey: 'test-key',
    fetchImpl: async (_url, request) => {
      calls += 1;
      const body = JSON.parse(request.body);
      const supplied = JSON.parse(body.messages[1].content.split('BOUNDED_MINILM_EVIDENCE:\n')[1].split('\n\nRETURN_SCHEMA:')[0]);
      const first = supplied[0];
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ actions: [{ itemIndex: 0, owner: first.owner, action: first.action, deadline: first.deadline, evidenceIds: [first.evidence[0].id] }] }) } }] })
      };
    }
  });
  assert.equal(calls, 2);
  assert.equal(result.payload.screens.actions.length, 1);
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

test('unsupported slot changes fall back without discarding a supported action', async () => {
  const payload = actionPayload();
  const result = await polishCanonicalStage(payload, {
    apiKey: 'test-key',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ actions: [{ itemIndex: 0, owner: 'Orla', action: 'Send the QMS manual to Orla for review', deadline: 'Friday', evidenceIds: ['evt_2'] }] }) } }] })
    })
  });
  assert.deepEqual(result.payload.screens.actions[0], {
    owner: 'Jacqui Fox', action: 'Send the QMS manual to Orla for review', deadline: 'Not stated', evidenceIds: ['evt_2']
  });
});

test('an incorrectly supplied owner may be corrected only by explicit cited assignment evidence', async () => {
  const payload = actionPayload();
  payload._canonicalEvidencePack[0].evidence[0] = {
    id: 'evt_2', speaker: 'Jacqui Fox', current: 'Orla, can you review the QMS manual?', contextWindow: []
  };
  const result = await polishCanonicalStage(payload, {
    apiKey: 'test-key',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ actions: [{ itemIndex: 0, owner: 'Orla Skally', action: 'Review the QMS manual and importer procedures', deadline: 'Not stated', evidenceIds: ['evt_2'] }] }) } }] })
    })
  });
  assert.equal(result.payload.screens.actions[0].owner, 'Orla Skally');
});

test('Trooper may fill only owner and deadline slots explicitly supported by cited evidence', async () => {
  const payload = actionPayload();
  payload._canonicalEvidencePack[0].owner = 'Not stated';
  payload._canonicalEvidencePack[0].deadline = 'Not stated';
  payload._canonicalEvidencePack[0].evidence[0] = {
    id: 'evt_2', speaker: 'Jacqui Fox', current: 'I will send the QMS manual to Orla by Friday.', contextWindow: []
  };
  const result = await polishCanonicalStage(payload, {
    apiKey: 'test-key',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ actions: [{ itemIndex: 0, owner: 'Jacqui Fox', action: 'Send the QMS manual to Orla for review', deadline: 'Friday', evidenceIds: ['evt_2'] }] }) } }] })
    })
  });
  assert.deepEqual(result.payload.screens.actions[0], {
    owner: 'Jacqui Fox', action: 'Send the QMS manual to Orla for review', deadline: 'Friday', evidenceIds: ['evt_2']
  });
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

test('an evidence-bound candidate survives model omission and unavailable rewriting', async () => {
  const enriched = addRecoveredActionCandidates(actionPayload(), [{
    owner: 'Not stated',
    action: 'Review the supplier quality agreement',
    deadline: 'Not stated',
    evidence: 'The supplier quality agreement needs to be reviewed.'
  }]);
  const rewritten = await polishCanonicalStage(enriched, {
    apiKey: 'test-key',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ actions: [] }) } }] })
    })
  });
  assert.ok(rewritten.payload.screens.actions.some((item) => item.action === 'Review the supplier quality agreement'));
  const fallback = await polishCanonicalStage(enriched, { apiKey: '' });
  assert.ok(fallback.payload.screens.actions.some((item) => item.action === 'Review the supplier quality agreement'));
});

test('final presentation removes reporting wrappers without changing canonical facts', () => {
  const discussion = clientReadyPresentation({
    stagedStage: 'discussion', validationFlags: [],
    screens: { discussion: [{ topic: 'Labelling', points: ['Orla explained that the updated label includes importer information.'] }] }
  });
  assert.deepEqual(discussion.screens.discussion[0].points, ['The updated label includes importer information.']);
  assert.equal(discussion.editorialStatus, 'language_polished');
  assert.equal(normaliseActionPresentation('Give the QMS Manual to Orla Skally'), 'Send the QMS Manual to Orla Skally');
});

test('unsafe wording is retained as evidence-backed draft and explicitly flagged', () => {
  const result = clientReadyPresentation({
    stagedStage: 'discussion', validationFlags: [],
    screens: { discussion: [{ topic: 'Review', points: ['The speaker said this was kind of okay.'] }] }
  });
  assert.deepEqual(result.screens.discussion[0].points, ['The speaker said this was kind of okay.']);
  assert.equal(result.editorialStatus, 'wording_needs_review');
  assert.ok(result.validationFlags.some((flag) => flag.type === 'wording_needs_review'));
});
