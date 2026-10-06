'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareEvidence } = require('../utils/canonicalMinutes/evidence');
const {
  editorialTopicLabel, editorialTopics, isStructuralTopicLabel, isPublishableTopicLabel,
  isActionCategoryTopicCard, normaliseMetaTopicLabel, normaliseMetaTopicHeadings,
  publishableTopicCards
} = require('../utils/canonicalMinutes/topicEditorial');

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

test('generated meta headings become neutral subjects without changing reviewer headings', () => {
  assert.equal(normaliseMetaTopicLabel('Summary of parking control options'), 'Parking control options');
  assert.equal(normaliseMetaTopicLabel('Summary of current software review and testing priorities'), 'Software review and testing');
  assert.equal(normaliseMetaTopicLabel('Project priorities'), 'Project priorities');
  const cards = normaliseMetaTopicHeadings([
    { topic: 'Overview of the supplier audit evidence' },
    { topic: 'Summary of current launch priorities', reviewerAuthored: true }
  ]);
  assert.equal(cards[0].topic, 'Supplier audit evidence');
  assert.equal(cards[1].topic, 'Summary of current launch priorities');
});

test('editorial labels treat alarm bells as warning-sign language, not literal device alarms', () => {
  const idiom = topicFor('What are the alarm bells for them to bring somebody in before a quality system problem becomes serious?');
  assert.equal(editorialTopicLabel(idiom.topic, idiom.evidence), 'Quality and risk indicators');

  const literal = topicFor('The mute button changes the LED flash behaviour for the high priority alarm.');
  assert.equal(editorialTopicLabel(literal.topic, literal.evidence), 'Alarm behaviour and controls');
});

test('extractive topic fallback rejects transcript-shaped fragments', () => {
  const fragments = [
    'Absolutely address follow',
    'Like, as the team is developing big',
    'That might be deemed for translation by views it',
    'Just to, just to know'
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

// --- concept anchors: one everyday token must not name a cluster.
//
// Each anchor below was added for a measured live mislabel, and the broad
// alternatives (anchor everything; global two-hit floor) were measured and
// rejected - 61 and 44 corpus sections changed respectively, with emptied
// screens, because broad labels do real rescue work in-domain.

const { CONCEPTS } = require('../utils/canonicalMinutes/topicEditorial');
const conceptFor = (text) => CONCEPTS.find((c) => c.pattern.test(text) && (!c.anchor || c.anchor.test(text)))?.label || '';

test('one mention of "cost" does not make a parking dispute commercial', () => {
  assert.equal(conceptFor('the permit cost is about forty pounds a year and residents object'), '');
});

test('a real budget discussion keeps its label', () => {
  assert.equal(conceptFor('the budget is tight with the hall, rights and costume costs'), 'Budget and commercial matters');
});

test('a road-closure application is not a software change', () => {
  assert.equal(conceptFor('get the road-closure application submitted to the council'), '');
  assert.equal(conceptFor('the software application needs a new release'), 'Software changes');
});

test('a solar shed alarm is not medtech alarm behaviour, a mute-button discussion is', () => {
  // Fourth measured case of the class: an allotment society bought a fifteen-quid solar
  // alarm for the shed, and bare "alarm" named the cluster "Alarm behaviour and controls" -
  // which then minted the objective and the meeting-purpose sentence mechanically.
  assert.equal(conceptFor('a proper hasp and a decent padlock, and maybe one of those solar alarm things for the shed'), '');
  assert.equal(conceptFor('the mute button LED flash sequence and the low priority alarm chirp were reviewed'), 'Alarm behaviour and controls');
});

test('confirming venue access is not technical setup, screen sharing is', () => {
  assert.equal(conceptFor('Dan can update the run sheet after access is confirmed with the venue'), '');
  assert.equal(conceptFor('check screen sharing and camera access before the session'), 'Technical setup');
});

test('action-category headings do not become discussion topics', () => {
  assert.equal(isPublishableTopicLabel('Action items and priorities'), false);
  const card = {
    topic: 'Action items and priorities',
    points: [{ text: 'Priya will review the validation report.' }],
    decisions: [],
    openQuestions: []
  };
  assert.equal(isActionCategoryTopicCard(card), true);
  assert.deepEqual(publishableTopicCards([card]), []);
});

test('generic meeting-closing labels are structural, but substantive closing subjects are not', () => {
  for (const heading of [
    'Meeting closing remarks', 'Closing remarks', 'Closing comments', 'Meeting close',
    'Final remarks', 'Closing wrap-up', 'Wrap-up discussion'
  ]) assert.equal(isStructuralTopicLabel(heading), true, heading);
  assert.equal(isStructuralTopicLabel('Closing remarks on the audit findings'), false);
  assert.equal(isStructuralTopicLabel('Closing the supplier contract'), false);
});

test('compound action-summary headings are removed only when every row is action-shaped', () => {
  const actionSummary = {
    topic: 'Prioritised software review and testing actions',
    points: [
      { text: 'Review the software changes against the test evidence.' },
      { text: 'Confirm the remaining validation tests.' }
    ],
    decisions: [],
    openQuestions: []
  };
  assert.equal(isActionCategoryTopicCard(actionSummary), true);
  assert.deepEqual(publishableTopicCards([actionSummary]), []);

  const factualDiscussion = {
    ...actionSummary,
    points: [{ text: 'Software testing evidence included unresolved design risks.' }]
  };
  assert.equal(isActionCategoryTopicCard(factualDiscussion), false);
  assert.deepEqual(publishableTopicCards([factualDiscussion]), [factualDiscussion]);
});

test('assignment summaries expressed as planned-work lists are action categories', () => {
  const assignmentSummary = {
    topic: 'Summary of individual assignments',
    points: [{
      text: 'Plans include completing the review, checking the specification and updating the risk file.'
    }],
    decisions: [],
    openQuestions: []
  };
  assert.equal(isActionCategoryTopicCard(assignmentSummary), true);
  assert.deepEqual(publishableTopicCards([assignmentSummary]), []);

  const factualDiscussion = {
    ...assignmentSummary,
    points: [{ text: 'The assignment process includes a documented independent approval step.' }]
  };
  assert.equal(isActionCategoryTopicCard(factualDiscussion), false);
  assert.deepEqual(publishableTopicCards([factualDiscussion]), [factualDiscussion]);
});

test('reported-speech assignment recaps remain action categories', () => {
  const recap = {
    topic: 'Summary of individual action assignments and next steps',
    points: [
      { text: 'Jacqui Fox stated that David Didsbury would send the debug command letters for review.' },
      { text: "Jacqui Fox reported that Andrew Kane's main focus was to complete the language review and start testing." }
    ],
    decisions: [],
    openQuestions: []
  };
  assert.equal(isActionCategoryTopicCard(recap), true);
  assert.deepEqual(publishableTopicCards([recap]), []);

  const factualReport = {
    ...recap,
    topic: 'Language support limitations',
    points: [{ text: 'Jacqui Fox reported that five languages had already been added to the code.' }]
  };
  assert.equal(isActionCategoryTopicCard(factualReport), false);
  assert.deepEqual(publishableTopicCards([factualReport]), [factualReport]);
});

test('mixed action-category cards retain factual discussion rather than dropping it wholesale', () => {
  const card = {
    topic: 'Action items and priorities',
    points: [
      { text: 'Priya will review the validation report.' },
      { text: 'The device does not retain the previous software setting.' }
    ]
  };
  assert.equal(isActionCategoryTopicCard(card), false);
  // Mixed cards are not classified as action-only; the current V2 normaliser
  // preserves their factual discussion while the action stage handles commitments.
});
