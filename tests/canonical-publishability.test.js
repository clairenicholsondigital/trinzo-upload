'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { prepareEvidence } = require('../utils/canonicalMinutes/evidence');
const { purposePlan } = require('../utils/canonicalMinutes/meetingPurpose');
const semanticStages = require('../utils/canonicalMinutes/semanticStages');
const {
  isTranscriptMetaText,
  isCorrectionOrAcknowledgementFragment,
  isContextDependentText,
  isConditionalLead,
  isMalformedTranscriptText,
  canStandAloneAsMinutesEvidence,
  canHeadlineTopic
} = require('../utils/canonicalMinutes/publishability');

test('canonical publishability rejects correction chatter as standalone minutes evidence', () => {
  assert.equal(isCorrectionOrAcknowledgementFragment("No, sorry, that's not correct."), true);
  assert.equal(canStandAloneAsMinutesEvidence("No, sorry, that's not correct."), false);
});

test('canonical publishability rejects context-dependent question fragments as topic headings', () => {
  const text = 'And then as a consequence to that, does that mean the software change process';
  assert.equal(isContextDependentText(text), true);
  assert.equal(canHeadlineTopic(text), false);
});

test('conditional process detail can support a topic without becoming the topic heading', () => {
  const text = 'If the change is approved, the change request is signed off.';
  assert.equal(isConditionalLead(text), true);
  assert.equal(canStandAloneAsMinutesEvidence(text), false);
  assert.equal(canStandAloneAsMinutesEvidence(text, { allowConditional: true }), true);
  assert.equal(canHeadlineTopic(text), false);
});

test('transcription controls and malformed stitched text cannot become canonical evidence', () => {
  assert.equal(isTranscriptMetaText('Jacqui Fox stopped transcription during the software review.'), true);
  assert.equal(canStandAloneAsMinutesEvidence('Jacqui Fox stopped transcription during the software review.'), false);
  assert.equal(isMalformedTranscriptText("soYou're getting ties time"), true);
  assert.equal(canHeadlineTopic("soYou're getting ties time"), false);
});

test('meeting-purpose policy stays thin and cannot inject transcript content', () => {
  const plan = purposePlan({ title: 'Client Eakin Tech File Review Weekly', type: 'Technical file review' });
  assert.ok(plan);
  assert.equal(plan.profileId, 'technical_file_review');
  assert.ok(Array.isArray(plan.topicHints));
  assert.equal('topics' in plan, false);
  assert.equal('discussion' in plan, false);
});

test('publishability rejects transcript-control chatter independently of meeting-purpose classification', () => {
  const evidence = prepareEvidence('Jacqui Fox  00:01\nJacqui Fox stopped transcription during the software review.');
  assert.ok(evidence.events.length);
  assert.equal(canStandAloneAsMinutesEvidence(evidence.events[0].text), false);
});

test('discussion stage does not reintroduce a context-dependent topic representative', () => {
  const evidence = prepareEvidence([
    'Mark: And then as a consequence to that, does that mean the software change process?',
    'Jacqui: The software change request requires approval before it can be signed off.',
    'Mark: The electrical compliance testing is scheduled for Friday.'
  ].join('\n'));
  const badEvent = evidence.events.find((event) => event.text.includes('as a consequence'));
  const goodEvent = evidence.events.find((event) => event.text.includes('electrical compliance'));
  const profile = {
    events: {},
    topics: [
      { id: 'bad', representativeText: badEvent.text, evidenceIds: [badEvent.id], cohesion: 1, turnStart: badEvent.turnIndex },
      { id: 'good', representativeText: goodEvent.text, evidenceIds: [goodEvent.id], cohesion: 1, turnStart: goodEvent.turnIndex }
    ]
  };
  const state = { meeting: {}, topics: [], objectives: [], decisions: [], risks: [], discussion: [], actions: [] };
  const result = semanticStages.contentStage(evidence, state, profile);
  const headings = result.discussion.map((card) => card.topic.toLowerCase()).join('\n');
  assert.doesNotMatch(headings, /as a consequence|does that mean/);
  assert.match(headings, /electrical compliance/);
});
