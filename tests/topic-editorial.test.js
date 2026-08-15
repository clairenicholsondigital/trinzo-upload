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

test('editorial labels prefer specific technical workstreams over generic timing labels', () => {
  const cyber = topicFor('The cyber security review covered the USB port lock and password controls.');
  assert.equal(editorialTopicLabel(cyber.topic, cyber.evidence), 'Cybersecurity and access controls');

  const languages = topicFor('Arabic, Vietnamese and Greek may require additional language characters and font support.');
  assert.equal(editorialTopicLabel(languages.topic, languages.evidence), 'Language support and localisation');

  const traceability = topicFor('The 17 changes between software versions need traceability to their location within the code.');
  assert.equal(editorialTopicLabel(traceability.topic, traceability.evidence), 'Software change traceability');
});

test('extractive topic fallback rejects transcript-shaped fragments', () => {
  const fragments = [
    'Absolutely address follow',
    'Like, as the team is developing big',
    'That might be deemed for translation by views it'
  ];
  for (const text of fragments) assert.equal(require('../utils/canonicalMinutes/topicEditorial').extractiveLabel(text), '', text);
  assert.equal(require('../utils/canonicalMinutes/topicEditorial').extractiveLabel('We discussed orchard irrigation pressure during the dry season.'), 'Orchard irrigation pressure during the dry season');
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
