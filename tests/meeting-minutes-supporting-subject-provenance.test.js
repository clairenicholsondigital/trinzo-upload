'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const MinutesDiscussionSelection = require('../utils/meetingMinutesDiscussionSelection');
const MinutesRefereeDiscussion = require('../utils/meetingMinutesRefereeDiscussion');
const MinutesResultNormalization = require('../utils/meetingMinutesResultNormalization');
const S = require('../utils/meetingMinutesSupportingDetails');
const { rehomeSupportingDetails, unitIndex } = require('../utils/canonicalMinutes/discussionOrganiser');
const units = [
  { id: 'T0001', speaker: 'Morgan Lee', text: 'The coolant pressure inspection is complete.' },
  { id: 'T0002', speaker: 'Priya Shah', text: 'Supplier insurance confirmation remains outstanding.' }
];
const parent = { id: 'pressure', text: units[0].text, evidenceIds: ['T0001'], supportingDetails: [] };
const support = { candidateId: 'insurance-candidate', sourcePass: 'primary', recordType: 'discussion_point',
  topic: 'Supplier insurance', text: units[1].text, evidenceIds: ['T0002'],
  record: { id: 'insurance', text: units[1].text, evidenceIds: ['T0002'], reviewFlagIds: ['insurance-warning'] } };
const discussion = () => [{ topic: 'Coolant inspection', points: [structuredClone(parent)], decisions: [], openQuestions: [] }];
function rehome(topics) {
  const pool = [];
  rehomeSupportingDetails(topics, unitIndex(units), { onUnassignedSupportingDetail: (detail, context) => {
    pool.push(...S.collectUnassignedSupportingDetails(detail, context)); return true;
  } });
  return pool;
}

test('a valid but unrelated referee target cannot overwrite the original supporting subject', () => {
  const compact = MinutesDiscussionSelection.compactDiscussionPropositions(discussion(), [], units, {
    promoteMaterialSupporting: false, supportingCandidates: [{ candidate: support, mergeTarget: 'pressure' }]
  });
  assert.equal(compact[0].points[0].supportingDetails.length, 1, 'exercise the existing explicit-target handoff');
  const normalised = MinutesResultNormalization.normaliseAgentResult({ discussion: compact }, units, 'discussion').discussion;
  const pool = rehome(normalised);
  assert.equal(pool.length, 1);
  assert.equal(pool[0].originalTopic, 'Supplier insurance');
  assert.equal(pool[0].placementReason, 'no_subject_match');
  assert.equal(pool[0].text, support.text);
  assert.deepEqual(pool[0].evidenceIds, ['T0002']);
  assert.deepEqual(pool[0].reviewFlagIds, ['insurance-warning']);
  assert.equal(normalised[0].points[0].text, parent.text);
  assert.deepEqual(normalised[0].points[0].supportingDetails, []);
});

test('reconstructed referee support retains its own subject before and after failed filing', () => {
  const core = { candidateId: 'pressure', sourcePass: 'primary', recordType: 'discussion_point',
    topic: 'Coolant inspection', text: parent.text, evidenceIds: parent.evidenceIds, record: parent };
  const verdicts = [
    { candidateId: 'pressure', disposition: 'core', targetId: 'pressure', evidenceIds: ['T0001'] },
    { candidateId: support.candidateId, disposition: 'supporting', targetId: 'pressure', evidenceIds: ['T0002'] }
  ];
  const rebuilt = MinutesRefereeDiscussion.reconstructMissingRefereeDiscussion([], verdicts, [core, support], units);
  const pool = rehome(rebuilt.discussion);
  assert.equal(pool[0].originalTopic, support.topic);
  assert.deepEqual(pool[0].reviewFlagIds, ['insurance-warning']);
});

test('a rejected raw parent retains its child subject, while legacy children still use their parent topic', () => {
  for (const ownTopic of ['Supplier insurance', undefined]) {
    const child = { id: 'context', text: support.text, evidenceIds: ['T0002'],
      ...(ownTopic ? { originalTopic: ownTopic } : {}) };
    const raw = [{ topic: 'Coolant inspection', points: [{ id: 'raw', text: 'Could you check that?',
      evidenceIds: ['T0001'], supportingDetails: [child] }], decisions: [], openQuestions: [] }];
    const pool = [];
    MinutesDiscussionSelection.compactDiscussionPropositions(raw, [], units, { promoteMaterialSupporting: false,
      onUnassignedSupportingDetail: (detail, context) => {
        pool.push(...S.collectUnassignedSupportingDetails(detail, context)); return true;
      } });
    assert.equal(pool[0].originalTopic, ownTopic || 'Coolant inspection');
    assert.equal(pool[0].placementReason, 'parent_not_publishable');
  }
});

test('nested filing details prefer their own origin, then the nearest inherited subject', () => {
  const root = { id: 'root', text: 'Background retained.', evidenceIds: ['T0001'], originalTopic: 'Supply chain',
    supportingDetails: [{ id: 'own', text: 'Insurance retained.', evidenceIds: ['T0002'], originalTopic: 'Insurance' },
      { id: 'inherited', text: 'Supply context retained.', evidenceIds: ['T0001'] }] };
  const rows = S.collectUnassignedSupportingDetails(root, { originalTopic: 'Wrong current parent', placementReason: 'no_subject_match' });
  assert.deepEqual(rows.map(r => r.originalTopic), ['Supply chain', 'Insurance', 'Supply chain']);
});

test('subject metadata is not evidence, authorship or a waiver of subject placement', () => {
  const topics = discussion();
  topics[0].points[0].supportingDetails = [{ id: 'unsupported', text: support.text, evidenceIds: ['T0002'],
    originalTopic: 'Coolant inspection' }];
  assert.equal(rehome(topics)[0].placementReason, 'no_subject_match');
  const row = MinutesResultNormalization.normaliseAgentResult({ discussion: [{ topic: 'Insurance', points: [{ ...parent,
    originalTopic: 'Supplier insurance', reviewerAuthored: true }], decisions: [], openQuestions: [] }] }, units, 'discussion').discussion[0].points[0];
  assert.equal(row.originalTopic, 'Supplier insurance');
  assert.equal(row.reviewerAuthored, undefined);
});

test('known generated archives preserve bounded subject metadata without accepting unknown fields', () => {
  const { generatedFilingRecord } = require('../utils/meetingMinutesFilingProvenance');
  const record = { ...support.record, discoveryDisposition: 'supporting', originalTopic: support.topic };
  assert.equal(generatedFilingRecord(record), true);
  const [filed] = S.collectUnassignedSupportingDetails(record, { originalTopic: 'Wrong parent', placementReason: 'no_subject_match' });
  assert.equal(filed.filingMergeProtected, undefined);
  assert.equal(filed.originalTopic, support.topic);
  assert.deepEqual(filed.filingOrigins[0].generatedRecord, record);
  for (const change of [{ originalTopic: 'x'.repeat(221) }, { originalTopic: 42 },
    { originalTopic: 'Insurance\u0000' }, { unexpectedMetadata: true }]) {
    assert.equal(generatedFilingRecord({ ...record, ...change }), false);
  }
});

test('direct and overlong filing retain an existing origin rather than a later topic label', () => {
  for (const long of [false, true]) {
    const text = long ? (support.text + ' ').repeat(40).trim() : support.text;
    const candidate = { ...support, topic: 'Later proposed topic', text,
      record: { ...support.record, text, originalTopic: 'Supplier insurance' } };
    const pool = [];
    MinutesDiscussionSelection.compactDiscussionPropositions(discussion(), [], units, {
      promoteMaterialSupporting: false, supportingCandidates: [{ candidate, mergeTarget: 'missing-target' }],
      onUnassignedSupportingDetail: (detail, context) => {
        pool.push(...S.collectUnassignedSupportingDetails(detail, context)); return true;
      }
    });
    assert.equal(pool[0].originalTopic, 'Supplier insurance');
    assert.equal(pool[0].text, text);
    assert.equal(pool[0].placementReason, long ? 'long_supporting_detail' : 'explicit_target_missing');
  }
});
