'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runCanonicalNoEditPass } = require('../utils/canonicalMinutes/runner');
const { createCanonicalState, acceptProposal } = require('../utils/canonicalMinutes/state');
const { finalMinutes } = require('../utils/canonicalMinutes/stages');
const { prepareEvidence } = require('../utils/canonicalMinutes/evidence');
const { assessEvidenceTopology } = require('../utils/canonicalMinutes/topology');
const { runCanonicalLiveStage, buildConfirmedState } = require('../utils/canonicalMinutes/liveStages');
const semanticStages = require('../utils/canonicalMinutes/semanticStages');

test('generic action gate rejects unresolved conversational references', () => {
  ['Send that out now', 'Copy her this time', 'Do it at the same time', 'Be there for really', 'Probably tomorrow?', 'Need before the audit starts', 'Be mid audit at that point', 'Run it through the site', 'Try and do is limit your stream', 'Quickly share so we can review it']
    .forEach((action) => assert.equal(semanticStages.isUnderspecifiedAction({ action }), true, action));
  ['Review the labels for regulatory compliance', 'Prepare a list of questions for the client', 'Schedule the weekly client call']
    .forEach((action) => assert.equal(semanticStages.isUnderspecifiedAction({ action }), false, action));
});

test('canonical record wording converts transcript speech into client-ready grammar', () => {
  assert.equal(
    semanticStages.canonicalActionText('Also give you the classifications need and an overall view of the products themselves'),
    'Provide the applicable classifications and an overview of the products'
  );
  assert.equal(
    semanticStages.canonicalActionText('Front end everything for the first week as much as possible'),
    'Complete as much preparation as possible during the first week'
  );
  assert.equal(
    semanticStages.canonicalRiskText("There is a risk that we don't realise something is missing or you need to do something and I'm not there to help"),
    'Required information or actions may be missed while the responsible team member is unavailable.'
  );
  assert.equal(semanticStages.canonicalRiskText("There's always a risk, so you always have to plan for it; Yeah"), '');
});

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

test('closing recap promotes only an independently corroborated earlier commitment', () => {
  const evidence = prepareEvidence([
    'Andrew Kane  00:01',
    'I need to check the mute button flash behaviour.',
    'Jacqui Fox  00:05',
    'We also discussed the general test programme.',
    'Rebecca Cuckoo  00:10',
    'The status is otherwise unchanged.',
    'Jacqui Fox  00:20',
    'Right, the key things moving forward are',
    'Jacqui Fox  00:21',
    'Andrew to confirm the mute button flash behaviour.',
    'Jacqui Fox  00:22',
    'Rebecca to prepare an unrelated supplier pack.',
    'Jacqui Fox  00:23',
    'Thanks everyone.'
  ].join('\n'));
  const promoted = semanticStages.corroboratedClosingRecapActions(evidence);
  assert.ok(promoted.some((item) => item.owner === 'Andrew Kane' && /mute button/i.test(item.action)));
  assert.equal(promoted.some((item) => /supplier pack/i.test(item.action)), false);
});

test('real T761 closing recap corroborates the concrete ongoing workstreams without promoting the unassigned clinical review', () => {
  const transcript = fs.readFileSync(path.join(__dirname, '../scripts/meeting-minutes-final-golden/025_real_t761_eakin_sw_weekly_transcript/transcript.txt'), 'utf8');
  const promoted = semanticStages.corroboratedClosingRecapActions(prepareEvidence(transcript));
  assert.ok(promoted.some((item) => item.owner === 'Andrew Kane' && /mute button/i.test(item.action)));
  assert.ok(promoted.some((item) => item.owner === 'Andrew Kane' && /additional languages/i.test(item.action)));
  assert.ok(promoted.some((item) => item.owner === 'Andrew Kane' && /electrical compliance testing/i.test(item.action)));
  assert.ok(promoted.some((item) => item.owner === 'Rebecca Cuckoo' && /USB port/i.test(item.action)));
  assert.equal(promoted.some((item) => /clinical review/i.test(item.action)), false);
  assert.equal(promoted.some((item) => /fan logic/i.test(item.action)), false);
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

test('explicit first-person future commitments publish as concrete actions', () => {
  const evidence = prepareEvidence([
    'Jacqui Fox  00:01',
    "I have that code of conduct, so I'll get that over to you today as well, Niamh.",
    'Smith, Stuart M  00:05',
    "Yes, so I'll share with you the tracker that we use that transmits."
  ].join('\n'));
  const result = semanticStages.actionsStage(evidence, {}, { events: {} }, { mode: 'standard' });
  const codeOfConduct = result.actions.find((item) => item.owner === 'Jacqui Fox' && /code of conduct/i.test(item.action));
  assert.ok(codeOfConduct && codeOfConduct.deadline === 'today');
  assert.doesNotMatch(codeOfConduct.action, /\band I have that\b/i);
  // Teams surname-first display names are normalised generically to "First Last",
  // so the owner resolves to "Stuart Smith" (not the raw "Smith, Stuart M").
  const tracker = result.actions.find((item) => item.owner === 'Stuart Smith' && /tracker/i.test(item.action));
  assert.ok(tracker);
  assert.doesNotMatch(tracker.action, /share (?:the )?share/i);
  assert.equal(result.warnings.some((warning) => warning.type === 'unresolved_commitment_threads'), false);
});

test('weak first-person future wording remains unpublished', () => {
  const maybeEvidence = prepareEvidence([
    'Jacqui Fox  00:01',
    "Maybe I'll send something over later.",
    'Niamh Byrne  00:05',
    'Okay.'
  ].join('\n'));
  const probablyEvidence = prepareEvidence([
    'Jacqui Fox  00:01',
    "I'll probably have a look at that.",
    'Niamh Byrne  00:05',
    'Okay.'
  ].join('\n'));
  assert.deepEqual(semanticStages.actionsStage(maybeEvidence, {}, { events: {} }, { mode: 'standard' }).actions, []);
  assert.deepEqual(semanticStages.actionsStage(probablyEvidence, {}, { events: {} }, { mode: 'standard' }).actions, []);
});

test('malformed fragments and unresolved pronouns stay out of published actions', () => {
  const evidence = prepareEvidence([
    'Rebecca Cole  00:01',
    "I'll get the file, I'm hoping done because I'm focusing on risk.",
    'Jacqui Fox  00:08',
    "I'll get Colm to review that as well."
  ].join('\n'));
  const result = semanticStages.actionsStage(evidence, {}, { events: {} }, { mode: 'standard' });
  assert.deepEqual(result.actions, []);
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
    summary: {
      objectives: ['Use reviewer-corrected option B'],
      overallTopics: ['Reviewer-approved option'],
      topicRefs: [{ topicId: 'topic_option', evidenceIds: ['evt_0001'] }]
    },
    discussion: [{ topic: 'Chosen option', points: ['The reviewer confirmed option B.'] }]
  });
  assert.equal(state.objectives[0].humanFinal, 'Use reviewer-corrected option B');
  assert.equal(state.objectives[0].locked, true);
  assert.equal(state.objectives[0].source, 'stage_1_human_confirmation');
  assert.equal(state.topics[0].humanFinal, 'Reviewer-approved option');
  assert.equal(state.topics[0].topicId, 'topic_option');
  assert.equal(state.topics[0].locked, true);
  assert.equal(state.discussion[0].points[0].text, 'The reviewer confirmed option B.');
  assert.equal(state.discussion[0].source, 'stage_2_human_confirmation');
});

test('summary reviewer guidance prioritises supported evidence without becoming evidence', () => {
  const evidence = prepareEvidence([
    'Amina Khan  00:01',
    'We reviewed the slide order and opening section.',
    'Ben Stone  00:08',
    'We checked the recording and screen sharing contingency.'
  ].join('\n'));
  // Topics are the transcript's own clusters (supplied here as the profile's
  // topics). Reviewer guidance may only reorder them — it must not become a
  // topic, and no canned template text may appear.
  const profile = {
    topics: [
      { id: 'slides', representativeText: 'We reviewed the slide order and opening section', evidenceIds: [evidence.events[0].id], cohesion: 1 },
      { id: 'recording', representativeText: 'We checked the recording and screen sharing contingency', evidenceIds: [evidence.events[1].id], cohesion: 1 }
    ],
    events: {}
  };
  const result = semanticStages.contextStage(evidence, profile, {
    meeting: { type: 'Webinar rehearsal', title: 'Product webinar' }
  }, 'Prioritise recording and technical readiness');
  // Guidance floats the recording/technical topic to the front.
  assert.match(result.topics[0].text, /technical setup/i);
  // Guidance text itself never leaks into the topic list as content.
  assert.equal(result.topics.some((item) => /prioritise/i.test(item.text)), false);
  // Every emitted topic is grounded in this transcript's evidence.
  assert.ok(result.topics.every((item) => (item.evidenceIds || []).length > 0));
});

test('confirmed summary topics become the preferred discussion agenda', () => {
  const evidence = prepareEvidence([
    'Amina Khan  00:01',
    'The supplier schedule needs review before Friday.',
    'Ben Stone  00:08',
    'The validation report is ready for approval.'
  ].join('\n'));
  const profile = {
    topics: [
      { id: 'supplier', representativeText: 'Supplier schedule review', evidenceIds: [evidence.events[0].id], cohesion: 1 },
      { id: 'validation', representativeText: 'Validation report approval', evidenceIds: [evidence.events[1].id], cohesion: 1 }
    ],
    events: {}
  };
  const state = { meeting: {}, objectives: [], decisions: [], risks: [], discussion: [], actions: [], topics: [
    { text: 'Approved validation agenda', humanFinal: 'Approved validation agenda' },
    { text: 'Approved supplier agenda', humanFinal: 'Approved supplier agenda' }
  ] };
  const result = semanticStages.contentStage(evidence, state, profile);
  assert.deepEqual(result.discussion.slice(0, 2).map((card) => card.topic), [
    'Approved validation agenda',
    'Approved supplier agenda'
  ]);
});

test('stable topic ids preserve a fully rewritten human heading in Discussion', () => {
  const evidence = prepareEvidence([
    'Amina Khan  00:01',
    'The supplier schedule needs review before Friday.',
    'Ben Stone  00:08',
    'The validation report is ready for approval.'
  ].join('\n'));
  const profile = {
    topics: [
      { id: 'supplier', representativeText: 'Supplier schedule review', evidenceIds: [evidence.events[0].id], cohesion: 1 },
      { id: 'validation', representativeText: 'Validation report approval', evidenceIds: [evidence.events[1].id], cohesion: 1 }
    ],
    events: {}
  };
  const state = { meeting: {}, objectives: [], decisions: [], risks: [], discussion: [], actions: [], topics: [
    { text: 'Completely rewritten heading', humanFinal: 'Completely rewritten heading', topicId: 'validation' }
  ] };
  const result = semanticStages.contentStage(evidence, state, profile);
  assert.equal(result.discussion[0].topic, 'Completely rewritten heading');
  assert.equal(result.discussion[0].topicId, 'validation');
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
