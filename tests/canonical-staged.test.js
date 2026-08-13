'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runCanonicalNoEditPass } = require('../utils/canonicalMinutes/runner');
const { createCanonicalState, acceptProposal } = require('../utils/canonicalMinutes/state');
const { finalMinutes } = require('../utils/canonicalMinutes/stages');
const { prepareEvidence } = require('../utils/canonicalMinutes/evidence');
const { assessEvidenceTopology } = require('../utils/canonicalMinutes/topology');
const { runCanonicalLiveStage, buildConfirmedState } = require('../utils/canonicalMinutes/liveStages');
const semanticStages = require('../utils/canonicalMinutes/semanticStages');

test('canonical no-edit pass preserves accepted semantics', () => {
  const transcript = [
    'Amina Khan  00:01',
    'We decided to use option B because it is simpler.',
    'Ben Stone  00:08',
    "I'll send the approved plan by Friday."
  ].join('\n');
  const result = runCanonicalNoEditPass(transcript);
  assert.equal(result.pipeline, 'canonical_staged_v2');
  assert.equal(result.canonicalState.version, 3);
  assert.equal(result.audits.semanticLock.passed, true);
  assert.equal(result.visibleOutput.actions[0].meetingActionPointOwner, 'Ben Stone');
  assert.equal(result.visibleOutput.actions[0].meetingActionPointDeadline, 'Friday');
});

test('no-action meeting remains empty', () => {
  const result = runCanonicalNoEditPass([
    'Amina Khan  00:01',
    'The report was completed yesterday. We agreed there is no action required.',
    'Ben Stone  00:08',
    'Confirmed.'
  ].join('\n'));
  assert.deepEqual(result.visibleOutput.actions, []);
  assert.ok(result.reviewExperience.warnings.some((warning) => warning.type === 'no_actions_detected'));
});

test('enriched resolution consolidates repeated decision and risk evidence', () => {
  const previousFlag = process.env.MEETING_MINUTES_ENRICHED_EVIDENCE;
  process.env.MEETING_MINUTES_ENRICHED_EVIDENCE = '1';
  try {
    const evidence = prepareEvidence([
      'Elaine Voss  00:01',
      'We approve the validation report for release.',
      'Martin Okoro  00:05',
      'Yeah, agreed, approve it.',
      'Elaine Voss  00:09',
      'So decision, we accept the residual risk on the temperature excursion.',
      'Martin Okoro  00:13',
      "The residual risk there is low and already accepted, so there's nothing to action.",
      'Elaine Voss  00:17',
      'We went with supplier B. That is confirmed and the paperwork is already signed.',
      'Martin Okoro  00:21',
      'The risk is that supplier variation could affect delivery; it remains open for monitoring.'
    ].join('\n'));
    const semanticProfile = {
      available: true,
      events: Object.fromEntries(evidence.events.map((event) => [event.id, {
        scores: { decision: 0.8, risk: 0.8 },
        evidenceProbabilities: /supplier B/i.test(event.text) ? { decision_agreement: 0.8 } : {},
        canonicalWorthinessProbabilities: { canonical_item: 0.85 },
        contextDependencyProbabilities: { standalone: 0.8 },
        lifecycleProbabilities: { none: 0.8 },
        discourseRoleProbabilities: /agreed, approve it/i.test(event.text)
          ? { acceptance: 0.9, canonical_assertion: 0.05 }
          : { canonical_assertion: 0.8, acceptance: 0.05 }
      }]))
    };

    const proposal = semanticStages.contentStage(evidence, { objectives: [] }, semanticProfile);

    assert.equal(proposal.decisions.filter((item) => /residual risk/i.test(item.text)).length, 1);
    assert.equal(proposal.decisions.filter((item) => /supplier B/i.test(item.text)).length, 1);
    assert.equal(proposal.risks.filter((item) => /temperature-excursion/i.test(item.text)).length, 1);
    assert.equal(proposal.risks.filter((item) => /supplier variation/i.test(item.text)).length, 1);
  } finally {
    if (previousFlag === undefined) delete process.env.MEETING_MINUTES_ENRICHED_EVIDENCE;
    else process.env.MEETING_MINUTES_ENRICHED_EVIDENCE = previousFlag;
  }
});

test('acceptance creates locked authoritative state', () => {
  const initial = createCanonicalState({ transcriptText: 'test' });
  const accepted = acceptProposal(initial, { decisions: [{ text: 'Use option B', evidenceIds: ['evt_1'] }] });
  assert.equal(accepted.decisions[0].status, 'human_approved');
  assert.equal(accepted.decisions[0].locked, true);
  assert.equal(accepted.decisions[0].aiOriginal, 'Use option B');
  assert.equal(accepted.decisions[0].humanFinal, 'Use option B');
});

test('a semantic human correction survives into final minutes', () => {
  let state = createCanonicalState({ transcriptText: 'Option A was discussed.' });
  state = acceptProposal(state, {
    decisions: [{ text: 'Use option B', aiOriginal: 'Use option A', humanFinal: 'Use option B', evidenceIds: ['evt_1'] }],
    rejections: [{ text: 'Use option A', prohibitedRole: 'decision', reason: 'human_semantic_correction', evidenceIds: ['evt_1'] }]
  });
  const minutes = finalMinutes(state);
  assert.deepEqual(minutes.decisions, ['Use option B']);
  assert.equal(minutes.decisions.includes('Use option A'), false);
  assert.equal(state.rejections[0].locked, true);
});

test('distributed action recap selects bounded cross-turn assembly', () => {
  const transcript = [
    'Priya Sethi  11:46',
    "Okay, so, actions. Callum, you're putting the animation back on the slide.",
    'Callum Reid  11:52',
    "Yep, and building the closing slide, and I'll re-share the deck.",
    'Priya Sethi  11:59',
    "Nadia, you're doing the planted questions and grouping the chat.",
    'Nadia Okonkwo  12:04',
    "Yeah, I'll write three backup questions tonight.",
    'Priya Sethi  12:10',
    'Thanks everyone.'
  ].join('\n');
  const evidence = prepareEvidence(transcript);
  const topology = assessEvidenceTopology(evidence);
  const result = runCanonicalNoEditPass(transcript);
  assert.equal(topology.mode, 'distributed_recap');
  assert.equal(result.metrics.extractionMode, 'minilm_commitment_threads');
  assert.equal(result.metrics.topologyObservation, 'distributed_recap');
  assert.ok(result.visibleOutput.actions.some((item) => /animation/i.test(item.meetingActionPoint)));
  assert.ok(result.visibleOutput.actions.some((item) => /closing slide/i.test(item.meetingActionPoint)));
});

test('ordinary commitments remain on the standard extractor', () => {
  const evidence = prepareEvidence([
    'Amina Khan  00:01',
    "I'll send the report tomorrow.",
    'Ben Stone  00:05',
    'Agreed.'
  ].join('\n'));
  assert.equal(assessEvidenceTopology(evidence).mode, 'standard');
});

test('unrelated planning recap generalises beyond the webinar fixture', () => {
  const transcript = [
    'Morgan Lee  14:00',
    'Quick action recap.',
    'Morgan Lee  14:01',
    "Sam, you're updating the supplier schedule.",
    'Sam Ortiz  14:02',
    "Yes, and I'll circulate the revised dates tomorrow.",
    'Morgan Lee  14:03',
    'Rina, you are reviewing the budget assumptions.',
    'Rina Das  14:04',
    "Agreed, and I'll send comments by Friday.",
    'Morgan Lee  14:05',
    'Thanks everyone.'
  ].join('\n');
  const result = runCanonicalNoEditPass(transcript);
  assert.equal(result.metrics.extractionMode, 'minilm_commitment_threads');
  assert.equal(result.metrics.topologyObservation, 'distributed_recap');
  assert.ok(result.visibleOutput.actions.some((item) => item.meetingActionPointOwner === 'Sam Ortiz' && /supplier schedule/i.test(item.meetingActionPoint)));
  assert.ok(result.visibleOutput.actions.some((item) => item.meetingActionPointOwner === 'Rina Das' && /budget assumptions/i.test(item.meetingActionPoint)));
});

test('an ordinary reference to previous actions does not activate recap mode', () => {
  const transcript = [
    'Morgan Lee  14:00',
    'The actions from last week are complete, so today is an information-only update.',
    'Sam Ortiz  14:02',
    'The supplier schedule was already circulated yesterday.'
  ].join('\n');
  const result = runCanonicalNoEditPass(transcript);
  assert.equal(result.metrics.topologyObservation, 'standard');
  assert.deepEqual(result.visibleOutput.actions, []);
});

test('a single assignment after an actions heading stays on the standard path', () => {
  const transcript = [
    'Morgan Lee  14:00',
    'Right, actions: Sam, please send the report tomorrow.',
    'Sam Ortiz  14:02',
    'Agreed.'
  ].join('\n');
  const result = runCanonicalNoEditPass(transcript);
  assert.equal(result.metrics.topologyObservation, 'standard');
});

test('evidence parsing supports single-name timestamps and glued colon turns', () => {
  const timestampEvidence = prepareEvidence('Maya 09:00 I will notify support.\nLiam 09:01 Agreed.');
  assert.deepEqual(timestampEvidence.participants, ['Maya', 'Liam']);
  const colonEvidence = prepareEvidence('James: Status update.Rachel: The work is complete.Mark: Agreed.');
  assert.deepEqual(colonEvidence.participants, ['James', 'Rachel', 'Mark']);
  assert.equal(timestampEvidence.events[0].previousText, '');
  assert.equal(timestampEvidence.events[0].nextText, 'Agreed.');
  assert.match(timestampEvidence.events[0].contextText, /\[CURRENT\]\nI will notify support/);
});


test('enriched lifecycle and worthiness suppress non-canonical actions behind the feature flag', () => {
  const evidence = prepareEvidence(['Amina Khan  00:01', "I'll send the report."].join('\n'));
  const event = evidence.events[0];
  const profile = { events: { [event.id]: { scores: { commitment: 0.9 }, actionProbabilities: { confirmed_action: 0.9 }, lifecycleProbabilities: { completed: 0.9, active: 0.05 }, canonicalWorthinessProbabilities: { canonical_item: 0.9 } } } };
  const previous = process.env.MEETING_MINUTES_ENRICHED_EVIDENCE;
  process.env.MEETING_MINUTES_ENRICHED_EVIDENCE = '1';
  try { assert.deepEqual(semanticStages.actionsStage(evidence, {}, profile, { mode: 'standard' }).actions, []); } finally {
    if (previous === undefined) delete process.env.MEETING_MINUTES_ENRICHED_EVIDENCE; else process.env.MEETING_MINUTES_ENRICHED_EVIDENCE = previous;
  }
});

test('live staged state locks reviewer-confirmed input for downstream stages', () => {
  const transcript = [
    'Amina Khan  00:01',
    'We discussed option A.',
    'Ben Stone  00:08',
    "I'll send the approved plan by Friday."
  ].join('\n');
  const state = buildConfirmedState(transcript, 'review.txt', {
    details: { meetingTitle: 'Reviewer title', participants: ['Amina Khan', 'Ben Stone'] },
    summary: { objectives: ['Use reviewer-corrected option B'] },
    discussion: [{ topic: 'Chosen option', points: ['The reviewer confirmed option B.'] }]
  });
  assert.equal(state.objectives[0].humanFinal, 'Use reviewer-corrected option B');
  assert.equal(state.objectives[0].locked, true);
  assert.equal(state.objectives[0].source, 'stage_1_human_confirmation');
  assert.equal(state.discussion[0].points[0].text, 'The reviewer confirmed option B.');
  assert.equal(state.discussion[0].source, 'stage_2_human_confirmation');
});

test('live actions stage uses confirmed state and returns the existing UI screen contract', () => {
  const transcript = [
    'Amina Khan  00:01',
    'We agreed to use option B.',
    'Ben Stone  00:08',
    "I'll send the approved plan by Friday."
  ].join('\n');
  const result = runCanonicalLiveStage(transcript, {
    stage: 'actions',
    fileName: 'review.txt',
    confirmed: {
      details: { participants: ['Amina Khan', 'Ben Stone'] },
      summary: { objectives: ['Confirm option B'] },
      discussion: [{ topic: 'Decision', points: ['Option B was confirmed.'] }]
    }
  });
  assert.equal(result.pipeline, 'canonical_staged_v2');
  assert.equal(result.stagedStage, 'actions');
  assert.equal(result.canonicalDiagnostics.humanConfirmedInputIsAuthoritative, true);
  assert.equal(result.canonicalDiagnostics.confirmedCollections.objectives, 1);
  assert.equal(result.canonicalDiagnostics.confirmedCollections.discussion, 1);
  assert.ok(Array.isArray(result.screens.actions));
  assert.ok(result.screens.actions.some((item) => item.owner === 'Ben Stone' && /approved plan/i.test(item.action)));
});
