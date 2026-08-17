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
const apiRouter = require('../routes/api');
const {
  buildConfirmedUnderstanding,
  repairDiscussionForConfirmedUnderstanding,
  factIsPreserved
} = require('../utils/stagedSemanticAuthority');

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

test('confirmed Summary purpose and key facts become semantic authority', () => {
  const transcript = [
    'Amina Khan  00:01',
    'Goods are supplied from Japan and move through the Netherlands for fiscal clearance only.',
    'Ben Stone  00:08',
    'The goods are finally stored at Park West in Dublin.'
  ].join('\n');
  const state = buildConfirmedState(transcript, 'dita.txt', {
    details: { meetingTitle: 'DITA importer obligations' },
    summary: {
      meetingPurpose: 'The meeting was process discovery so importer-obligation procedures could reflect how the business works.',
      keyFacts: [
        'Goods originate from suppliers in Japan.',
        'Netherlands is used for fiscal clearance only, not substantive warehousing.',
        'Final storage is at DITA Park West in Dublin.'
      ],
      objectives: ['Confirm importer-obligation process evidence'],
      overallTopics: ['Importer process flow']
    }
  });
  assert.equal(state.meeting.purpose, 'The meeting was process discovery so importer-obligation procedures could reflect how the business works.');
  assert.equal(state.meetingUnderstanding.meetingPurpose, state.meeting.purpose);
  assert.deepEqual(state.meeting.criticalFacts, [
    'Goods originate from suppliers in Japan.',
    'Netherlands is used for fiscal clearance only, not substantive warehousing.',
    'Final storage is at DITA Park West in Dublin.'
  ]);
  assert.equal(state.meetingUnderstanding.criticalFacts.length, 3);
  assert.ok(state.meetingUnderstanding.criticalFacts.every((fact) => fact.authority === 'reviewer_confirmed'));
});

test('repair preserves transcript-supported reviewer-confirmed DITA facts in Discussion', () => {
  const ditaTranscript = fs.readFileSync(
    path.resolve(__dirname, '../../trinzo-ui-test-transcripts/extracted-text/Client DITA T819 - Importer Obligations - Client connect-6-.txt'),
    'utf8'
  );
  const understanding = buildConfirmedUnderstanding({
    meetingPurpose: "The meeting was process discovery to understand DITA's actual operational processes so practical importer-obligation procedures could be designed around how the business works.",
    keyFacts: [
      'Goods originate from suppliers in Japan.',
      'Netherlands is used for fiscal clearance only, not substantive warehousing.',
      'Final storage is at DITA Park West in Dublin.',
      "Importer procedures need to reflect DITA's actual ERP/order flow, warehouse checks, scanners, document control and manual processes."
    ]
  });
  const result = repairDiscussionForConfirmedUnderstanding({
    discussion: [{ topic: 'QMS manual', points: ['The QMS manual was reviewed as a reference for the importer procedures.'] }],
    understanding,
    transcriptText: ditaTranscript
  });
  const discussionText = result.discussion.map((card) => `${card.topic} ${(card.points || []).join(' ')}`).join(' ');
  assert.match(discussionText, /Japan/i);
  assert.match(discussionText, /Netherlands/i);
  assert.match(discussionText, /fiscal(?:ly)? clear/i);
  assert.match(discussionText, /Dublin|Park West/i);
  assert.match(discussionText, /ERP|NetSuite/i);
  assert.match(discussionText, /warehouse/i);
  assert.match(discussionText, /scanner|RF Smart|barcod/i);
  assert.match(discussionText, /document control|manual/i);
  assert.equal(result.validationFlags.length, 0);
  assert.equal(result.telemetry.unresolvedFactCount, 0);
  assert.ok(understanding.criticalFacts.every((fact) => factIsPreserved(fact.text, result.discussion)));
});

test('compound reviewer-confirmed facts require material component preservation', () => {
  const fact = "Importer procedures need to reflect DITA's actual ERP/order flow, warehouse checks, scanners, document control and manual processes.";
  assert.equal(factIsPreserved(fact, [{
    topic: 'Operational process requirements',
    points: [
      'The goal is to ensure minimal organisational impact and sustainability for the implemented procedures by aligning them with existing, robust processes.',
      "The meeting was process discovery to understand DITA's actual operational processes."
    ]
  }]), false);
  assert.equal(factIsPreserved(fact, [{
    topic: 'Operational process requirements',
    points: [
      'The procedures should be based on DITA NetSuite order workflow, warehouse verification, barcode scanning, document control and manual warehouse processes.'
    ]
  }]), true);
});

test('canonical Discussion generation preserves reviewer-confirmed DITA semantic anchors', () => {
  const ditaTranscript = fs.readFileSync(
    path.resolve(__dirname, '../../trinzo-ui-test-transcripts/extracted-text/Client DITA T819 - Importer Obligations - Client connect-6-.txt'),
    'utf8'
  );
  const evidence = prepareEvidence(ditaTranscript);
  const firstQmsEvent = evidence.events.find((event) => /QMS manual/i.test(event.text)) || evidence.events[0];
  const state = buildConfirmedState(ditaTranscript, 'dita.txt', {
    summary: {
      meetingPurpose: "The meeting was process discovery to understand DITA's actual operational processes so practical importer-obligation procedures could be designed around how the business works.",
      keyFacts: [
        'Goods originate from suppliers in Japan.',
        'Netherlands is used for fiscal clearance only, not substantive warehousing.',
        'Final storage is at DITA Park West in Dublin.',
        "Importer procedures need to reflect DITA's actual ERP/order flow, warehouse checks, scanners, document control and manual processes."
      ],
      objectives: ['Review QMS manual context'],
      overallTopics: ['QMS manual context']
    }
  });
  const result = semanticStages.contentStage(evidence, state, {
    topics: [{ id: 'qms', representativeText: firstQmsEvent.text, evidenceIds: [firstQmsEvent.id], cohesion: 1 }],
    events: {}
  });
  const discussionText = result.discussion.map((card) => `${card.topic} ${(card.points || []).map((point) => point.text || point).join(' ')}`).join(' ');
  assert.match(discussionText, /Japan/i);
  assert.match(discussionText, /Netherlands/i);
  assert.match(discussionText, /fiscal(?:ly)? clear/i);
  assert.match(discussionText, /Dublin|Park West/i);
  assert.match(discussionText, /ERP|NetSuite/i);
  assert.match(discussionText, /warehouse/i);
  assert.match(discussionText, /scanner|RF Smart|barcod/i);
  assert.match(discussionText, /document control|manual/i);
  assert.equal(result.semanticPreservation.unresolvedFactCount, 0);
});

test('canonical Discussion API response preserves reviewer-confirmed DITA facts after grounding and polish', async () => {
  const ditaTranscript = fs.readFileSync(
    path.resolve(__dirname, '../../trinzo-ui-test-transcripts/extracted-text/Client DITA T819 - Importer Obligations - Client connect-6-.txt'),
    'utf8'
  );
  const previousTrooperKey = process.env.TROOPER_API_KEY;
  delete process.env.TROOPER_API_KEY;
  let result;
  try {
    result = await apiRouter.stagedEvaluation.canonicalStagedResponse('discussion', {
      text: ditaTranscript,
      source: 'text',
      fileName: 'dita.txt',
      preparedTranscriptTelemetry: null
    }, {
      confirmedSummary: {
        meetingPurpose: "The meeting was process discovery to understand DITA's actual operational processes so practical importer-obligation procedures could be designed around how the business works.",
        keyFacts: [
          'Goods originate from suppliers in Japan.',
          'Netherlands is used for fiscal clearance only, not substantive warehousing.',
          'Final storage is at DITA Park West in Dublin.',
          "Importer procedures need to reflect DITA's actual ERP/order flow, warehouse checks, scanners, document control and manual processes."
        ],
        objectives: ['Understand DITA importer-obligation process evidence'],
        overallTopics: ['Goods flow and import clearance', 'Operational process requirements']
      }
    });
  } finally {
    if (previousTrooperKey) process.env.TROOPER_API_KEY = previousTrooperKey;
  }
  const discussionText = result.screens.discussion.map((card) => `${card.topic} ${(card.points || []).join(' ')}`).join(' ');
  assert.match(discussionText, /Japan/i);
  assert.match(discussionText, /Netherlands/i);
  assert.match(discussionText, /fiscal(?:ly)? clear/i);
  assert.match(discussionText, /Dublin|Park West/i);
  assert.match(discussionText, /ERP|NetSuite/i);
  assert.match(discussionText, /warehouse/i);
  assert.match(discussionText, /scanner|RF Smart|barcod/i);
  assert.match(discussionText, /document control|manual/i);
  assert.equal(
    result.validationFlags.some((flag) => flag.type === 'reviewer_confirmed_fact_not_preserved'),
    false
  );
});

test('canonical Discussion planner allocates DITA evidence to reviewer-confirmed workstreams before prose', () => {
  const ditaTranscript = fs.readFileSync(
    path.resolve(__dirname, '../../trinzo-ui-test-transcripts/extracted-text/Client DITA T819 - Importer Obligations - Client connect-6-.txt'),
    'utf8'
  );
  const evidence = prepareEvidence(ditaTranscript);
  const ids = (pattern) => evidence.events.filter((event) => pattern.test(event.text)).slice(0, 10).map((event) => event.id);
  const state = buildConfirmedState(ditaTranscript, 'dita.txt', {
    summary: {
      meetingPurpose: "Understand DITA's actual operational processes so importer-obligation procedures can be designed around how the business works.",
      keyFacts: [
        'Goods originate from suppliers in Japan.',
        'The Netherlands is used for fiscal clearance only, not substantive warehousing.',
        'Final storage is at DITA Park West in Dublin.',
        "Importer procedures need to reflect DITA's actual ERP/order flow, warehouse checks, scanners, document control and manual processes."
      ],
      overallTopics: [
        'Goods flow and storage',
        'Importer-obligation QMS procedure design',
        'Operational process detail',
        'MDR/PPE/sunglasses and declarations of conformity',
        'EUDAMED/HPRA',
        'Language/country requirements',
        'MedEnvoy/Cody alignment',
        'Further process discovery'
      ]
    }
  });
  const profile = {
    events: {},
    topics: [
      { id: 'goods', representativeText: 'Japan Netherlands fiscal clearance Dublin Park West storage', evidenceIds: ids(/japan|netherlands|fiscal|park west|dublin/i), cohesion: 1 },
      { id: 'operations', representativeText: 'ERP order flow warehouse scanners document control manual processes', evidenceIds: ids(/netsuite|erp|order|warehouse|scanner|rf smart|barcode|document control|manual/i), cohesion: 1 },
      { id: 'ppe', representativeText: 'PPE sunglasses declarations of conformity risk rationale', evidenceIds: ids(/sunglasses|ppe|declaration|conformity|risk rationale/i), cohesion: 1 },
      { id: 'language', representativeText: 'Language country requirements translations labels IFU manufacturer information', evidenceIds: ids(/language|translation|country|label|ifu|manufacturer/i), cohesion: 1 },
      { id: 'regulatory', representativeText: 'EUDAMED HPRA registration authorised representative', evidenceIds: ids(/eudamed|udemed|hpra|registration|authorized|authorised/i), cohesion: 1 },
      { id: 'medenvoy', representativeText: 'MedEnvoy Cody alignment scope', evidenceIds: ids(/med.?envoy|cody|scope/i), cohesion: 1 },
      { id: 'discovery', representativeText: 'Further process discovery working sessions', evidenceIds: ids(/working session|another call|go through|process/i), cohesion: 1 }
    ]
  };
  const result = semanticStages.contentStage(evidence, state, profile);
  const plan = result.discussionPlan;
  const byLabel = new Map(plan.workstreams.map((workstream) => [workstream.label, workstream]));
  [
    'Goods flow and storage',
    'Importer-obligation QMS procedure design',
    'Operational process detail',
    'MDR/PPE/sunglasses and declarations of conformity',
    'EUDAMED/HPRA',
    'Language/country requirements',
    'MedEnvoy/Cody alignment',
    'Further process discovery'
  ].forEach((label) => assert.ok(byLabel.get(label), `missing planned workstream: ${label}`));
  assert.ok(byLabel.get('Goods flow and storage').evidenceIds.some((id) => /japan|netherlands|fiscal|dublin|park west/i.test(evidence.events.find((event) => event.id === id)?.text || '')));
  assert.ok(byLabel.get('Operational process detail').evidenceIds.some((id) => /netsuite|erp|warehouse|scanner|rf smart|barcode|document control|manual/i.test(evidence.events.find((event) => event.id === id)?.text || '')));
  assert.ok(byLabel.get('MDR/PPE/sunglasses and declarations of conformity').evidenceIds.some((id) => /sunglasses|declarations? of conformity|risk rationale|ppe/i.test(evidence.events.find((event) => event.id === id)?.text || '')));
  const languageTexts = byLabel.get('Language/country requirements').evidenceIds.map((id) => evidence.events.find((event) => event.id === id)?.text || '').join(' ');
  assert.match(languageTexts, /language|country|translation|labels?|IFU|manufacturer information/i);
  assert.doesNotMatch(languageTexts, /risk rationale for the PPE category one/i);
  assert.ok(byLabel.get('EUDAMED/HPRA').evidenceIds.some((id) => /eudamed|udemed|hpra|registration|authori[sz]ed/i.test(evidence.events.find((event) => event.id === id)?.text || '')));
  assert.ok(byLabel.get('MedEnvoy/Cody alignment').evidenceIds.some((id) => /med.?envoy|cody/i.test(evidence.events.find((event) => event.id === id)?.text || '')));
  assert.ok(byLabel.get('Further process discovery').evidenceIds.some((id) => /follow up|go through|process|working session|another call/i.test(evidence.events.find((event) => event.id === id)?.text || '')));
  assert.equal(result.risks.length, 0);
  assert.deepEqual(result.discussion.map((card) => card.topic), [
    'Goods flow and storage',
    'Importer-obligation QMS procedure design',
    'Operational process detail',
    'MDR/PPE/sunglasses and declarations of conformity',
    'EUDAMED/HPRA',
    'Language/country requirements',
    'MedEnvoy/Cody alignment',
    'Further process discovery'
  ]);
  const discussionText = result.discussion.map((card) => `${card.topic} ${card.points.map((point) => point.text || point).join(' ')}`).join(' ');
  assert.match(discussionText, /Japan/i);
  assert.match(discussionText, /Netherlands/i);
  assert.match(discussionText, /fiscal(?:ly)? clear/i);
  assert.match(discussionText, /Dublin|Park West/i);
  assert.match(discussionText, /ERP|NetSuite|order flow/i);
  assert.match(discussionText, /warehouse/i);
  assert.match(discussionText, /scanner|RF Smart|barcod/i);
});

test('canonical Discussion planner still allows non-DITA emergent risk workstreams', () => {
  const transcript = fs.readFileSync(
    path.resolve(__dirname, '../scripts/meeting-minutes-final-golden/027_real_abbott_audit_kickoff_transcript/transcript.txt'),
    'utf8'
  );
  const evidence = prepareEvidence(transcript);
  const riskIds = evidence.events.filter((event) => /risk|audit|gap|issue|dependency|blocker|consequence/i.test(event.text)).slice(0, 10).map((event) => event.id);
  const profile = {
    events: {},
    topics: [
      { id: 'risk-topic', representativeText: 'Audit risks dependencies and gaps', evidenceIds: riskIds, cohesion: 1 },
      { id: 'planning-topic', representativeText: 'Audit kickoff planning scope and responsibilities', evidenceIds: evidence.events.slice(0, 12).map((event) => event.id), cohesion: 1 }
    ]
  };
  const result = semanticStages.contentStage(evidence, { objectives: [] }, profile);
  const planned = result.discussionPlan.workstreams;
  assert.ok(planned.some((workstream) => workstream.provenance === 'transcript_emergent' || workstream.provenance === 'generic'));
  assert.ok(planned.some((workstream) => /risk|audit|planning|scope|responsibilit/i.test(workstream.label)));
});

test('canonical Discussion planner allocates T761 alarm and debug evidence to confirmed technical workstreams', () => {
  const transcript = fs.readFileSync(
    path.resolve(__dirname, '../scripts/meeting-minutes-final-golden/025_real_t761_eakin_sw_weekly_transcript/transcript.txt'),
    'utf8'
  );
  const evidence = prepareEvidence(transcript);
  const ids = (pattern) => evidence.events.filter((event) => pattern.test(event.text)).slice(0, 12).map((event) => event.id);
  const state = buildConfirmedState(transcript, 't761.txt', {
    summary: {
      meetingPurpose: 'Coordinate progress, evidence gaps, blockers and next steps for the software-change and technical-file programme.',
      overallTopics: [
        'Language and country requirements',
        'Alarm-code and clinical confirmation',
        'Debug and test-script evidence',
        'Change control and version traceability',
        'Electrical compliance evidence',
        'Cybersecurity, USB and GUI controls',
        'Standards and risk-management work'
      ]
    }
  });
  const profile = {
    events: {},
    topics: [
      { id: 'alarm', representativeText: 'alarm sound chirps mute button LED flash priority colours clinical confirmation', evidenceIds: ids(/alarm|sound|chirp|mute button|flash|led|priority|clinical|clinician|colour|color/i), cohesion: 1 },
      { id: 'debug', representativeText: 'debug outputs test scripts retrospective test data validation evidence', evidenceIds: ids(/debug|test script|test data|retrospective|validation|verification/i), cohesion: 1 },
      { id: 'language', representativeText: 'language files translations fonts characters markets countries', evidenceIds: ids(/language|translation|font|characters?|country|countries/i), cohesion: 1 },
      { id: 'traceability', representativeText: 'change control software version traceability technical file', evidenceIds: ids(/change control|change request|version|traceability|technical file|device file history|17 changes/i), cohesion: 1 },
      { id: 'risk', representativeText: 'risk management standards mitigation USB port lock GUI', evidenceIds: ids(/risk management|standards?|81001|27427|usb|port lock|gui/i), cohesion: 1 }
    ]
  };

  const result = semanticStages.contentStage(evidence, state, profile);
  const byLabel = new Map(result.discussionPlan.workstreams.map((workstream) => [workstream.label, workstream]));
  const alarm = byLabel.get('Alarm-code and clinical confirmation');
  const debug = byLabel.get('Debug and test-script evidence');
  const language = byLabel.get('Language and country requirements');

  assert.ok(alarm, 'alarm workstream should not be suppressed');
  assert.ok(debug, 'debug/test workstream should not be suppressed');
  const alarmText = alarm.evidenceIds.map((id) => evidence.events.find((event) => event.id === id)?.text || '').join(' ');
  const debugText = debug.evidenceIds.map((id) => evidence.events.find((event) => event.id === id)?.text || '').join(' ');
  const languageText = language.evidenceIds.map((id) => evidence.events.find((event) => event.id === id)?.text || '').join(' ');

  assert.match(alarmText, /sound|chirp|mute button|flash|priority|clinical|clinician/i);
  assert.match(debugText, /debug|test data|retrospective|validation|verification/i);
  assert.doesNotMatch(languageText, /\b(?:chirps?|mute button|LED|flash|low priority|medium priority|high priority)\b/i);
  assert.deepEqual(result.discussion.map((card) => card.topic), [
    'Language and country requirements',
    'Alarm-code and clinical confirmation',
    'Debug and test-script evidence',
    'Change control and version traceability',
    'Electrical compliance evidence',
    'Cybersecurity, USB and GUI controls',
    'Standards and risk-management work'
  ]);
  assert.ok(result.discussion.some((card) => card.topic === 'Alarm-code and clinical confirmation'));
  assert.ok(result.discussion.some((card) => card.topic === 'Debug and test-script evidence'));
  assert.equal(result.discussion.some((card) => /Software change traceability|Testing and validation|Plans and timelines|Risks and dependencies|Confirmed meeting context/i.test(card.topic)), false);
});

test('canonical Discussion planner keeps Abbott logistics out of Risk unless risk-bearing evidence is present', () => {
  const transcript = fs.readFileSync(
    path.resolve(__dirname, '../scripts/meeting-minutes-final-golden/027_real_abbott_audit_kickoff_transcript/transcript.txt'),
    'utf8'
  );
  const evidence = prepareEvidence(transcript);
  const ids = (pattern) => evidence.events.filter((event) => pattern.test(event.text)).slice(0, 12).map((event) => event.id);
  const state = buildConfirmedState(transcript, 'abbott.txt', {
    summary: {
      meetingPurpose: 'Align the audit team on the surveillance-audit plan, preparation, access, timing, logistics and responsibilities.',
      overallTopics: [
        'Audit scope, timing and logistics',
        'Software deep-dive role and responsibilities',
        'Preparation, confidentiality and document access',
        'Risk analysis and audit-planning evidence'
      ]
    }
  });
  const profile = {
    events: {},
    topics: [
      { id: 'logistics', representativeText: 'audit site hotel travel timing logistics scope', evidenceIds: ids(/hotel|travel|site|on site|timing|schedule|scope/i), cohesion: 1 },
      { id: 'software', representativeText: 'software deep dive specialist coverage responsibilities cybersecurity validation', evidenceIds: ids(/software|cybersecurity|validation|specialist|deep dive|responsibilit/i), cohesion: 1 },
      { id: 'risk', representativeText: 'risk analysis audit plan SBOM threat model CVE cybersecurity software validation complaints CAPA deviations', evidenceIds: ids(/risk analysis|risk assessment|risk management|audit plan|sbom|threat model|cve|cybersecurity|software validation|complaints|capa|deviations/i), cohesion: 1 },
      { id: 'access', representativeText: 'code of conduct confidentiality training SharePoint document access tracker', evidenceIds: ids(/code of conduct|confidentiality|training|sharepoint|document access|tracker/i), cohesion: 1 }
    ]
  };

  const result = semanticStages.contentStage(evidence, state, profile);
  const risk = result.discussionPlan.workstreams.find((workstream) => workstream.label === 'Risk analysis and audit-planning evidence');
  assert.ok(risk);
  const riskText = risk.evidenceIds.map((id) => evidence.events.find((event) => event.id === id)?.text || '').join(' ');
  assert.match(riskText, /risk analysis|risk assessment|risk management|audit plan|sbom|threat model|cve|cybersecurity|software validation|complaints|capa|deviations/i);
  assert.doesNotMatch(riskText, /Costa Rica|hotel|dietary requirements|hire car/i);

  const genericLabels = result.discussion
    .filter((card) => !['Audit scope, timing and logistics', 'Software deep-dive role and responsibilities', 'Preparation, confidentiality and document access', 'Risk analysis and audit-planning evidence'].includes(card.topic))
    .map((card) => card.topic)
    .join('\n');
  assert.doesNotMatch(genericLabels, /Plans and timelines|Scope and requirements|Software changes|Roles and responsibilities/i);
  assert.deepEqual(result.discussion.map((card) => card.topic), [
    'Audit scope, timing and logistics',
    'Software deep-dive role and responsibilities',
    'Preparation, confidentiality and document access',
    'Risk analysis and audit-planning evidence'
  ]);
});

test('canonical Actions ranking separates reviewer usefulness from automatic publication confidence for DITA', async () => {
  const ditaTranscript = fs.readFileSync(
    path.resolve(__dirname, '../../trinzo-ui-test-transcripts/extracted-text/Client DITA T819 - Importer Obligations - Client connect-6-.txt'),
    'utf8'
  );
  const previousTrooperKey = process.env.TROOPER_API_KEY;
  delete process.env.TROOPER_API_KEY;
  let result;
  try {
    result = await apiRouter.stagedEvaluation.canonicalStagedResponse('actions', {
      text: ditaTranscript,
      source: 'text',
      fileName: 'dita.txt',
      preparedTranscriptTelemetry: null
    }, {
      confirmedSummary: {
        meetingPurpose: "Understand DITA's actual operational processes so importer-obligation procedures can be designed around how the business works.",
        keyFacts: [
          'Goods originate from suppliers in Japan.',
          'The Netherlands is used for fiscal clearance only, not substantive warehousing.',
          'Final storage is at DITA Park West in Dublin.',
          "Importer procedures need to reflect DITA's actual ERP/order flow, warehouse checks, scanners, document control and manual processes."
        ],
        overallTopics: [
          'Goods flow and storage',
          'Importer-obligation QMS procedure design',
          'Operational process detail',
          'MDR/PPE/sunglasses and declarations of conformity',
          'EUDAMED/HPRA',
          'Language/country requirements',
          'MedEnvoy/Cody alignment',
          'Further process discovery'
        ]
      },
      confirmedDiscussion: [
        { topic: 'Goods flow and storage', points: ['Goods originate from Japan, pass through the Netherlands for fiscal clearance only and are stored finally at DITA Park West in Dublin.'] },
        { topic: 'Importer-obligation QMS procedure design', points: ['Importer procedures need to fit DITA operational processes.'] },
        { topic: 'Operational process detail', points: ['ERP/order flow, warehouse checks, scanners, document control and manual processes need to be confirmed.'] },
        { topic: 'MDR/PPE/sunglasses and declarations of conformity', points: ['PPE/sunglasses and declarations of conformity need review.'] },
        { topic: 'EUDAMED/HPRA', points: ['EUDAMED and HPRA registration evidence were discussed.'] },
        { topic: 'Language/country requirements', points: ['Country and language information is required.'] },
        { topic: 'MedEnvoy/Cody alignment', points: ['MedEnvoy and Cody alignment needs checking.'] },
        { topic: 'Further process discovery', points: ['Further working sessions are needed.'] }
      ]
    });
  } finally {
    if (previousTrooperKey) process.env.TROOPER_API_KEY = previousTrooperKey;
  }

  const confirmedActions = result.screens.actions || [];
  const candidates = result.actionReviewCandidates || [];
  const high = candidates.filter((candidate) => candidate.reviewerUsefulnessTier === 'high');
  const highText = high.map((candidate) => candidate.suggestedAction || candidate.action).join('\n');
  const allText = candidates.map((candidate) => candidate.suggestedAction || candidate.action).join('\n');
  const clusterKeys = new Set(candidates.map((candidate) => candidate.clusterKey));

  assert.ok(confirmedActions.length <= 2, `automatic publication should stay conservative: ${confirmedActions.length}`);
  assert.ok(high.length >= 5 && high.length <= 8, `expected a small high-priority set, got ${high.length}`);
  assert.match(highText, /Med Envoy project plan|task list/i);
  assert.match(highText, /country and language information/i);
  assert.match(highText, /PPE\/sunglasses declarations of conformity|Category I risk rationale/i);
  assert.match(highText, /further process-discovery|working sessions/i);
  assert.match(highText, /QMS Manual/i);
  assert.ok([...clusterKeys].some((key) => /medenvoy|project_plan/i.test(key)));
  assert.ok([...clusterKeys].some((key) => /ppe_doc/i.test(key)));
  assert.ok([...clusterKeys].some((key) => /qms/i.test(key)));
  assert.doesNotMatch(highText, /\bdo or like\b|document document|review that document as well/i);
  assert.doesNotMatch(highText, /has to meet MDR requirements|will have lot numbering process/i);
  assert.doesNotMatch(highText, /10 units|box(?:\.| )?big enough|handheld devices|pick into that box/i);
  assert.match(allText, /updated label from the importer perspective/i);
  assert.equal(
    confirmedActions.some((action) => /Med Envoy|Cody|project plan|task list/i.test(action.action || action.meetingActionPoint || '')),
    false
  );
  assert.equal(
    confirmedActions.some((action) => /QMS Manual/i.test(action.action || action.meetingActionPoint || '') && /Orla Skally/i.test(action.owner || action.meetingActionPointOwner || '')),
    false
  );
  assert.ok(candidates.some((candidate) => /QMS Manual/i.test(candidate.suggestedAction || candidate.action) && candidate.owner === 'Not stated'));
  assert.ok(candidates.every((candidate) => !candidate.deadline || candidate.deadline === 'Not stated'));
});

test('canonical Actions ranking still keeps non-DITA explicit work visible', async () => {
  const transcript = fs.readFileSync(
    path.resolve(__dirname, '../scripts/meeting-minutes-final-golden/025_real_t761_eakin_sw_weekly_transcript/transcript.txt'),
    'utf8'
  );
  const previousTrooperKey = process.env.TROOPER_API_KEY;
  delete process.env.TROOPER_API_KEY;
  let result;
  try {
    result = await apiRouter.stagedEvaluation.canonicalStagedResponse('actions', {
      text: transcript,
      source: 'text',
      fileName: 't761.txt',
      preparedTranscriptTelemetry: null
    }, {
      confirmedSummary: {
        meetingPurpose: 'Review current software workstreams and agree next follow-up for the weekly check-in.',
        overallTopics: ['Mute button testing', 'Language updates', 'Electrical compliance testing', 'Risk-management controls']
      }
    });
  } finally {
    if (previousTrooperKey) process.env.TROOPER_API_KEY = previousTrooperKey;
  }
  const confirmedText = (result.screens.actions || []).map((item) => `${item.owner || item.meetingActionPointOwner || ''} ${item.action || item.meetingActionPoint || ''}`).join('\n');
  const candidateText = (result.actionReviewCandidates || []).map((item) => `${item.reviewerUsefulnessTier || ''} ${item.suggestedAction || item.action || ''}`).join('\n');
  const combined = `${confirmedText}\n${candidateText}`;
  assert.match(combined, /mute button|additional languages|electrical compliance|USB|risk management/i);
  assert.doesNotMatch(combined, /Med Envoy|HPRA|authorised-representative|PPE\/sunglasses/i);
  assert.ok((result.screens.actions || []).length >= 1 || (result.actionReviewCandidates || []).some((candidate) => candidate.reviewerUsefulnessTier === 'high'));
});

test('canonical Actions do not publish mixed compound T761 recap clauses as one confirmed action', async () => {
  const transcript = fs.readFileSync(
    path.resolve(__dirname, '../scripts/meeting-minutes-final-golden/025_real_t761_eakin_sw_weekly_transcript/transcript.txt'),
    'utf8'
  );
  const previousTrooperKey = process.env.TROOPER_API_KEY;
  delete process.env.TROOPER_API_KEY;
  let result;
  try {
    result = await apiRouter.stagedEvaluation.canonicalStagedResponse('actions', {
      text: transcript,
      source: 'text',
      fileName: 't761.txt',
      preparedTranscriptTelemetry: null
    }, {
      confirmedSummary: {
        meetingPurpose: 'Coordinate progress, evidence gaps, blockers and next steps for the software-change and technical-file programme.',
        overallTopics: [
          'Language and country requirements',
          'Alarm-code and clinical confirmation',
          'Debug and test-script evidence',
          'Change control and version traceability',
          'Electrical compliance evidence',
          'Cybersecurity, USB and GUI controls',
          'Standards and risk-management work'
        ]
      }
    });
  } finally {
    if (previousTrooperKey) process.env.TROOPER_API_KEY = previousTrooperKey;
  }

  const confirmed = result.screens.actions || [];
  const confirmedText = confirmed.map((item) => `${item.owner || ''} ${item.action || ''}`).join('\n');
  assert.doesNotMatch(confirmedText, /drivers needs/i);
  assert.ok(!confirmed.some((item) => /additional languages/i.test(item.action) && /electrical compliance/i.test(item.action)), confirmedText);

  const reviewText = (result.actionReviewCandidates || []).map((item) => `${item.suggestedAction || item.action || ''}`).join('\n');
  assert.match(`${confirmedText}\n${reviewText}`, /mute button|additional languages|electrical compliance|USB|risk management/i);
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

test('confirmed summary topics are the authoritative discussion agenda with Other last', () => {
  const evidence = prepareEvidence([
    'Amina Khan  00:01',
    'The supplier schedule needs review before Friday.',
    'Ben Stone  00:08',
    'The validation report is ready for approval.',
    'Cara Lee  00:15',
    'The team also discussed the separate support mailbox migration.'
  ].join('\n'));
  const profile = {
    topics: [
      { id: 'supplier', representativeText: 'Supplier schedule review', evidenceIds: [evidence.events[0].id], cohesion: 1 },
      { id: 'validation', representativeText: 'Validation report approval', evidenceIds: [evidence.events[1].id], cohesion: 1 },
      { id: 'mailbox', representativeText: 'Separate support mailbox migration', evidenceIds: [evidence.events[2].id], cohesion: 1 }
    ],
    events: {}
  };
  const state = { meeting: {}, objectives: [], decisions: [], risks: [], discussion: [], actions: [], topics: [
    { text: 'Approved validation agenda', humanFinal: 'Approved validation agenda' },
    { text: 'Approved supplier agenda', humanFinal: 'Approved supplier agenda' }
  ] };
  const result = semanticStages.contentStage(evidence, state, profile);
  assert.deepEqual(result.discussion.map((card) => card.topic), [
    'Approved validation agenda',
    'Approved supplier agenda',
    'Other'
  ]);
  const other = result.discussion.find((card) => card.topic === 'Other');
  assert.match(other.points.map((point) => point.text || point).join(' '), /support mailbox migration/i);
  assert.equal(result.discussion.some((card) => /Separate support mailbox migration/i.test(card.topic)), false);
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

test('live Discussion screen does not append extra Decisions or Risks rows when Summary topics are authoritative', () => {
  const transcript = [
    'Amina Khan  00:01',
    'The launch approval is blocked by the missing validation report.',
    'Ben Stone  00:08',
    'We decided to pause the launch until the report is approved.'
  ].join('\n');
  const result = runCanonicalLiveStage(transcript, {
    stage: 'discussion',
    fileName: 'authoritative-topics.txt',
    confirmed: {
      summary: {
        meetingPurpose: 'Review launch approval, validation evidence and the decision on release timing.',
        overallTopics: ['Launch approval and validation evidence']
      }
    }
  });
  const headings = result.screens.discussion.map((card) => card.topic);
  assert.ok(headings.includes('Launch approval and validation evidence'));
  assert.equal(headings.some((heading) => /^(?:Decisions|Risks)$/i.test(heading)), false);
});

test('staged details extracts unpunctuated meeting title before generic overview heading', () => {
  const transcript = [
    'Meeting Overview',
    'Meeting Title T761 Eakin Healthcare Tech File SW review - SW coding changes',
    'Meeting Date 15th June 2026',
    'Participants',
    'Jacqui Fox',
    'Rebecca Cuckoo'
  ].join('\n');
  const result = apiRouter.stagedEvaluation.extractStagedDetailsFromTranscript(transcript, 'fallback-transcript.txt');
  assert.equal(result.screens.details.meetingTitle, 'T761 Eakin Healthcare Tech File SW Review SW Coding Changes');
  assert.notEqual(result.screens.details.meetingTitle, 'Meeting Overview');
  assert.equal(result.screens.details.meetingType, 'Technical file review');
});

test('live Summary screen hides reported-speech topic labels from Overall topics', async () => {
  const previousApiKey = process.env.TROOPER_API_KEY;
  process.env.TROOPER_API_KEY = '';
  try {
    const transcript = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'meeting-minutes-final-golden', '022_real_eakin_sw_minutes_pdf', 'transcript.txt'), 'utf8');
    const result = await apiRouter.stagedEvaluation.canonicalStagedResponse('summary', {
      text: transcript,
      source: 'test',
      fileName: '022-real-eakin-sw-minutes-pdf.txt'
    }, {
      confirmedDetails: {
        meetingTitle: 'T761 Eakin Healthcare Tech File SW review - SW coding changes',
        meetingType: 'Technical file review'
      }
    });
    const topics = result.screens.summary.overallTopics;
    assert.ok(topics.some((topic) => /alarm-code|clinical confirmation/i.test(topic)), topics.join(' | '));
    assert.equal(topics.some((topic) => /David noted the current setup the flash/i.test(topic)), false, topics.join(' | '));
    assert.equal((result.screens.summary.topicRefs || []).length, topics.length);
  } finally {
    if (previousApiKey) process.env.TROOPER_API_KEY = previousApiKey;
    else delete process.env.TROOPER_API_KEY;
  }
});

test('live Summary screen does not turn QIP alarm-bells idiom into device-alarm workstreams', async () => {
  const previousApiKey = process.env.TROOPER_API_KEY;
  process.env.TROOPER_API_KEY = '';
  try {
    const transcript = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'meeting-minutes-final-golden', '026_real_qip_assessment_tool_case_study_transcript', 'transcript.txt'), 'utf8');
    const result = await apiRouter.stagedEvaluation.canonicalStagedResponse('summary', {
      text: transcript,
      source: 'test',
      fileName: '026-real-qip-assessment-tool-case-study-transcript.txt'
    }, {
      confirmedDetails: {
        meetingTitle: 'QIP assessment tool case study',
        meetingType: 'Project review'
      }
    });
    const text = [
      result.screens.summary.meetingPurpose,
      result.screens.summary.executiveSummary,
      ...(result.screens.summary.objectives || []),
      ...(result.screens.summary.overallTopics || [])
    ].join('\n');
    assert.doesNotMatch(text, /alarm-code|clinical confirmation|software-change package/i);
    assert.equal((result.screens.summary.overallTopics || []).some((topic) => /alarm behaviour|alarm controls/i.test(topic)), false, (result.screens.summary.overallTopics || []).join(' | '));
    assert.ok((result.screens.summary.overallTopics || []).some((topic) => /quality|risk indicators|assessment/i.test(topic)), (result.screens.summary.overallTopics || []).join(' | '));
  } finally {
    if (previousApiKey) process.env.TROOPER_API_KEY = previousApiKey;
    else delete process.env.TROOPER_API_KEY;
  }
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
