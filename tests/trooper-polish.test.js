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
    owner: 'Jacqui Fox', action: 'Send the QMS manual to Orla for review', deadline: 'Not stated', evidenceIds: ['evt_2'],
    provenance: { actionEvidenceIds: ['evt_2'], ownerEvidenceIds: ['evt_2'], deadlineEvidenceIds: [] }
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
    owner: 'Jacqui Fox', action: 'Send the QMS manual to Orla for review', deadline: 'Friday', evidenceIds: ['evt_2'],
    provenance: { actionEvidenceIds: ['evt_2'], ownerEvidenceIds: ['evt_2'], deadlineEvidenceIds: ['evt_2'] }
  });
});

test('missing Trooper configuration safely suppresses unresolved actions without leaking the private pack', async () => {
  const result = await polishCanonicalStage(actionPayload(), { apiKey: '' });
  assert.equal(result.used, false);
  assert.deepEqual(result.payload.screens.actions, []);
  assert.equal('_canonicalEvidencePack' in result.payload, false);
});

test('discussion grounding rejects unsupported technical specifics even when a rewrite cites valid evidence', () => {
  const { discussionPointGrounded } = require('../utils/canonicalMinutes/trooperPolish');
  const pack = { evidence: [{ id: 'evt_1', speaker: 'Jacqui Fox', current: 'We need to confirm the audit scope and software review track.', contextWindow: [] }] };
  const candidate = { evidenceIds: ['evt_1'] };
  assert.equal(discussionPointGrounded('The audit pack avoids clean room and sterilisation standards.', candidate, pack), false);
  assert.equal(discussionPointGrounded('The audit scope and software review track were discussed.', candidate, pack), true);
});

test('post-Trooper checks reject availability states and repeated discussion prose', () => {
  assert.equal(nonActionState('Be out for the next couple of days'), true);
  assert.equal(nonActionState('Review the mute-button flash sequence'), false);
  assert.equal(unresolvedReference('Send the pack to the recipient'), true);
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

test('ownerless recovery candidates stay out of final actions until ownership is resolved', async () => {
  const enriched = addRecoveredActionCandidates(actionPayload(), [{
    owner: 'Not stated',
    action: 'Review the supplier quality agreement',
    deadline: 'Not stated',
    reviewDisposition: 'needs_assignment',
    evidence: 'The supplier quality agreement needs to be reviewed.'
  }]);
  const rewritten = await polishCanonicalStage(enriched, {
    apiKey: 'test-key',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ actions: [] }) } }] })
    })
  });
  assert.ok(!rewritten.payload.screens.actions.some((item) => item.action === 'Review the supplier quality agreement'));
  const fallback = await polishCanonicalStage(enriched, { apiKey: '' });
  assert.ok(!fallback.payload.screens.actions.some((item) => item.action === 'Review the supplier quality agreement'));
});

test('a named recipient introduced without cited support is rejected', async () => {
  const payload = actionPayload();
  payload._canonicalEvidencePack[0].evidence[0] = {
    id: 'evt_2', speaker: 'Jacqui Fox', current: 'I will send the code of conduct to Niamh today.',
    contextWindow: [{ id: 'evt_1', speaker: 'Stuart Smith', text: 'The code of conduct is required.' }]
  };
  const result = await polishCanonicalStage(payload, {
    apiKey: 'test-key',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ actions: [{ itemIndex: 0, owner: 'Jacqui Fox', action: 'Send the code of conduct to Stuart Smith today', deadline: 'today', evidenceIds: ['evt_2'] }] }) } }] })
    })
  });
  assert.deepEqual(result.payload.screens.actions, []);
});

test('recap-corroborated actions stay one-record-per-workstream even if Trooper tries to merge them', async () => {
  const payload = actionPayload();
  payload.screens.actions = [
    { owner: 'Andrew Kane', action: 'Confirm the mute button behaviour and its effect on the flash', deadline: 'Not stated', evidenceIds: ['evt_1'] },
    { owner: 'Andrew Kane', action: 'Continue the update to the 12 additional languages', deadline: 'Not stated', evidenceIds: ['evt_2'] }
  ];
  payload._canonicalEvidencePack = [
    {
      itemIndex: 0, owner: 'Andrew Kane', action: payload.screens.actions[0].action, deadline: 'Not stated',
      selectionMode: 'canonical_selected_action', recapCorroborated: true,
      evidence: [{ id: 'evt_1', speaker: 'Andrew Kane', current: "I need to look at the mute button behaviour.", contextWindow: [] }, { id: 'evt_3', speaker: 'Jacqui Fox', current: 'Andrew to confirm the mute button flash behaviour.', contextWindow: [] }]
    },
    {
      itemIndex: 1, owner: 'Andrew Kane', action: payload.screens.actions[1].action, deadline: 'Not stated',
      selectionMode: 'canonical_selected_action', recapCorroborated: true,
      evidence: [{ id: 'evt_2', speaker: 'Andrew Kane', current: "I've started the language update.", contextWindow: [] }, { id: 'evt_4', speaker: 'Jacqui Fox', current: 'Continue the update to the additional languages.', contextWindow: [] }]
    }
  ];
  const result = await polishCanonicalStage(payload, {
    apiKey: 'test-key',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ actions: [{ itemIndex: 0, owner: 'Andrew Kane', action: 'Confirm the mute button and continue the language update', deadline: 'Not stated', evidenceIds: ['evt_1', 'evt_3'] }] }) } }] })
    })
  });
  assert.deepEqual(result.payload.screens.actions.map((item) => item.action), [
    'Confirm the mute button behaviour and its effect on the flash',
    'Continue the update to the 12 additional languages'
  ]);
});

test('a deadline must be present in the evidence cited for that action', async () => {
  const payload = actionPayload();
  payload._canonicalEvidencePack[0].deadline = 'Wednesday';
  payload._canonicalEvidencePack[0].evidence[0] = {
    id: 'evt_2', speaker: 'Jacqui Fox', current: 'I will send the QMS manual to Orla.',
    contextWindow: [{ id: 'evt_3', speaker: 'Other Person', text: 'A separate meeting is on Wednesday.' }]
  };
  const result = await polishCanonicalStage(payload, {
    apiKey: 'test-key',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ actions: [{ itemIndex: 0, owner: 'Jacqui Fox', action: 'Send the QMS manual to Orla for review', deadline: 'Wednesday', evidenceIds: ['evt_2'] }] }) } }] })
    })
  });
  assert.equal(result.payload.screens.actions[0].deadline, 'Not stated');
  assert.deepEqual(result.payload.screens.actions[0].provenance.deadlineEvidenceIds, []);
});

test('final presentation withholds ownerless or invalid actions for reviewer confirmation', () => {
  const result = clientReadyPresentation({
    stagedStage: 'actions', validationFlags: [],
    screens: { actions: [
      { owner: 'Not stated', action: 'Complete Electrical compliance testing', deadline: '23rd July' },
      { owner: 'David', action: 'IF SW change cannot be seem generate retrospective test data', deadline: 'Not stated' },
      { owner: 'Rebecca Cuckoo', action: 'Share standards 81001-5-1 and 27427 for review', deadline: '16th June' }
    ] }
  });
  assert.deepEqual(result.screens.actions, [
    { owner: 'Rebecca Cuckoo', action: 'Share standards 81001-5-1 and 27427 for review', deadline: '16th June' }
  ]);
  const flag = result.validationFlags.find((item) => item.type === 'action_publication_review');
  assert.equal(flag.repairCandidates.length, 2);
  assert.equal(result.actionReviewCandidates.length, 2);
  assert.equal(result.candidateAccounting.confirmedActions, 1);
  assert.equal(result.candidateAccounting.reviewerCandidates, 2);
  assert.ok(result.actionReviewCandidates.every((candidate) => candidate.id.startsWith('candidate::')));
  assert.deepEqual(result.actionReviewCandidates.map((candidate) => candidate.action), flag.repairCandidates.map((candidate) => candidate.action));
});

test('final presentation preserves action candidate arrays across API serialisation', () => {
  const candidate = {
    id: 'action-candidate-fixed',
    owner: 'Not stated',
    action: 'Prepare the country and language list',
    suggestedAction: 'Prepare the country and language list',
    deadline: 'Not stated',
    reviewDisposition: 'needs_assignment',
    evidenceIds: ['evt_1', 'evt_2']
  };
  const result = clientReadyPresentation({
    stagedStage: 'actions',
    validationFlags: [{
      type: 'action_review_candidates',
      severity: 'warning',
      resolutionKey: 'action-review-candidates:fixture',
      message: '1 transcript-supported follow-up candidate needs review.',
      repairCandidates: [candidate]
    }],
    screens: { actions: [{ owner: 'Orla Skally', action: 'Review the HPRA authorised-representative bill', deadline: 'Not stated' }] }
  });

  const roundTrip = JSON.parse(JSON.stringify(result));
  assert.equal(roundTrip.actionReviewCandidates.length, 1);
  assert.equal(roundTrip.actionReviewCandidates[0].id, 'action-candidate-fixed');
  assert.equal(roundTrip.actionReviewCandidates[0].reviewDisposition, 'needs_assignment');
  assert.equal(roundTrip.validationFlags[0].repairCandidates[0].id, 'action-candidate-fixed');
  assert.equal(roundTrip.candidateAccounting.confirmedActions, 1);
  assert.equal(roundTrip.candidateAccounting.reviewerCandidates, 1);
});

test('final discussion presentation strips internal evidence ids and keeps distinctive topics aligned', () => {
  const result = clientReadyPresentation({
    stagedStage: 'discussion', validationFlags: [],
    screens: { discussion: [
      { topic: 'Language support and localisation', points: [
        'The alarm work will finish before the language support work. (evt_0374).',
        'Potential issues exist with Arabic, Vietnamese and Greek. (evt_0391).'
      ] },
      { topic: 'Cybersecurity and access controls', points: [
        'And the team were talking about a USB port lock and unwarranted interference. (evt_0456).'
      ] }
    ] }
  });
  assert.deepEqual(result.screens.discussion[0].points, ['Potential issues exist with Arabic, Vietnamese and Greek.']);
  assert.deepEqual(result.screens.discussion[1].points, ['The cybersecurity review considered USB-port controls and the risk of unauthorised or unintended device interference.']);
  assert.doesNotMatch(JSON.stringify(result.screens.discussion), /evt_/i);
});

test('final presentation drops discussion text positively identified as raw transcript debris', () => {
  const result = clientReadyPresentation({
    stagedStage: 'discussion', validationFlags: [],
    screens: { discussion: [{ topic: 'Risks and dependencies', points: ["There's one to, obviously, as you say, Rebecca, you're updating the risk at the moment, so you're considering that; Yeah", 'The team confirmed the risk management file is being updated.'] }] }
  });
  assert.deepEqual(result.screens.discussion[0].points, ['The team confirmed the risk management file is being updated.']);
});

test('rhetorical cybersecurity remarks are neutralised rather than published as transcript prose', () => {
  const result = clientReadyPresentation({
    stagedStage: 'discussion', validationFlags: [],
    screens: { discussion: [{ topic: 'Cybersecurity and access controls', points: ["Let's hope it's not a password on the screen, because Jacqui Fox would imagine that that's another software change, isn't it?"] }] }
  });
  assert.deepEqual(result.screens.discussion[0].points, ['Password protection was considered as a potential access control alongside the need for rapid clinical intervention.']);
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
