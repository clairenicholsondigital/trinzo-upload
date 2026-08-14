'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareEvidence } = require('../utils/canonicalMinutes/evidence');
const semanticStages = require('../utils/canonicalMinutes/semanticStages');
const { groundProposal, isGrounded } = require('../utils/canonicalMinutes/grounding');

// These tests enforce the core guarantee the pipeline was rebuilt around:
// content for one transcript can only ever come from that transcript. They use
// injected fake MiniLM profiles (clusters + per-event scores) so they run
// without the embedding model, exercising the same contextStage/contentStage
// code paths the live flow uses.

function fakeProfile(evidence, clusters) {
  return {
    available: true,
    topics: clusters,
    events: Object.fromEntries(evidence.events.map((event) => [event.id, { scores: {}, evidenceProbabilities: {} }]))
  };
}

const T761_LINES = [
  'Andrew Kane  00:01',
  'I have the alarm software load here and the three alarms are working on the scope.',
  'David Didsbury  00:20',
  'The mute button LED should flash at two hertz for the high priority alarm.',
  'Andrew Kane  00:40',
  'I will complete the electrical compliance testing in house before the MDR submission.'
];

const ABBOTT_LINES = [
  'Jacqui Fox  00:01',
  'Stuart has done the hotel reservation under his name for the audit.',
  'Smith, Stuart M  00:20',
  'I will confirm the audit scope and the applicable standards for the surveillance audit.',
  'Niamh Lynch  00:40',
  'I will do a desktop review of the software bill of materials before we are on site.'
];

function topicsFor(lines) {
  const evidence = prepareEvidence(lines.join('\n'));
  const clusters = evidence.events.map((event, index) => ({
    id: `c${index}`,
    representativeText: event.text,
    evidenceIds: [event.id],
    cohesion: 1
  }));
  const profile = fakeProfile(evidence, clusters);
  const context = semanticStages.contextStage(evidence, profile, { meeting: {} });
  const state = { meeting: {}, objectives: [], decisions: [], risks: [], discussion: [], actions: [], topics: context.topics };
  const content = semanticStages.contentStage(evidence, state, profile);
  return { evidence, context, content };
}

test('an audit transcript never surfaces the other meeting\'s technical-file prose', () => {
  const { content } = topicsFor(ABBOTT_LINES);
  const text = JSON.stringify(content).toLowerCase();
  // None of the T761-specific vocabulary may appear in Abbott output.
  for (const foreign of ['alarm', 'mute button', 'two hertz', 'notified body']) {
    assert.equal(text.includes(foreign), false, `Abbott output leaked "${foreign}"`);
  }
});

test('a technical-file transcript never surfaces the audit meeting\'s prose', () => {
  const { content } = topicsFor(T761_LINES);
  const text = JSON.stringify(content).toLowerCase();
  for (const foreign of ['hotel reservation', 'surveillance audit', 'audit scope', 'software bill of materials']) {
    assert.equal(text.includes(foreign), false, `T761 output leaked "${foreign}"`);
  }
});

test('every emitted discussion point is grounded in the current transcript', () => {
  for (const lines of [T761_LINES, ABBOTT_LINES]) {
    const { evidence, content } = topicsFor(lines);
    const idSet = new Set(evidence.events.map((event) => event.id));
    for (const card of content.discussion) {
      assert.ok((card.evidenceIds || []).some((id) => idSet.has(id)), 'card cites current evidence');
      for (const point of card.points) {
        assert.ok(isGrounded(point.evidenceIds, idSet), 'point is grounded in this transcript');
      }
    }
  }
});

test('the grounding gate drops content that references a foreign transcript', () => {
  const evidence = prepareEvidence(T761_LINES.join('\n'));
  const currentId = evidence.events[0].id;
  const proposal = {
    discussion: [
      { topic: 'Genuine', points: [{ text: 'A real point.', evidenceIds: [currentId] }], evidenceIds: [currentId] },
      { topic: 'Foreign', points: [{ text: 'Leaked from another meeting.', evidenceIds: ['evt_9999'] }], evidenceIds: ['evt_9999'] }
    ],
    decisions: [{ text: 'Foreign decision', evidenceIds: ['evt_8888'] }],
    risks: [],
    warnings: []
  };
  const grounded = groundProposal(proposal, evidence);
  assert.equal(grounded.discussion.length, 1);
  assert.equal(grounded.discussion[0].topic, 'Genuine');
  assert.equal(grounded.decisions.length, 0);
  assert.ok(grounded.warnings.some((warning) => warning.type === 'ungrounded_content_dropped'));
});
