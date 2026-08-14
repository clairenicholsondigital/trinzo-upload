'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareEvidence } = require('../utils/canonicalMinutes/evidence');
const { editorialTopicLabel, editorialTopics } = require('../utils/canonicalMinutes/topicEditorial');

function topicFor(text, id = 'topic_1') {
  const evidence = prepareEvidence(`Amina Khan  00:01\n${text}`);
  return {
    evidence,
    topic: { id, representativeText: text, evidenceIds: [evidence.events[0].id], cohesion: 1 }
  };
}

test('editorial labels convert conversational representatives into reusable business headings', () => {
  const software = topicFor('So we need to review the software change and complete the validation testing.');
  assert.equal(editorialTopicLabel(software.topic, software.evidence), 'Software changes');

  const arbitrary = topicFor('We discussed orchard irrigation pressure during the dry season.');
  assert.equal(editorialTopicLabel(arbitrary.topic, arbitrary.evidence), 'Orchard irrigation pressure during the dry season');
});

test('editorial topics consolidate duplicate generic concepts without losing evidence', () => {
  const evidence = prepareEvidence([
    'Amina Khan  00:01', 'The software change is ready for review.',
    'Ben Stone  00:08', 'The software release needs another code change.'
  ].join('\n'));
  const topics = editorialTopics([
    { id: 'a', representativeText: evidence.events[0].text, evidenceIds: [evidence.events[0].id] },
    { id: 'b', representativeText: evidence.events[1].text, evidenceIds: [evidence.events[1].id] }
  ], evidence);
  assert.equal(topics.length, 1);
  assert.equal(topics[0].editorialText, 'Software changes');
  assert.deepEqual(topics[0].evidenceIds, [evidence.events[0].id, evidence.events[1].id]);
});
