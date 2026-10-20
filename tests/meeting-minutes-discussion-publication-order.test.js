'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  primaryEvidenceIdsForRecord, stampPrimaryDiscussionEvidence, isSourceSupportedMaterialDetail
} = require('../utils/canonicalMinutes/discussionPublication');
const {
  sortByEvidence, unitIndex, discussionTopicArrangementInput, applyDiscussionTopicArrangement
} = require('../utils/canonicalMinutes/discussionOrganiser');

const sources = [
  { id: 'S01', speaker: 'Morgan Lee', text: 'The loading bay is frequently blocked by deliveries.' },
  { id: 'S02', speaker: 'Jamie Patel', text: 'Install a booking kiosk to coordinate delivery slots in the loading bay.' },
  { id: 'S03', speaker: 'Morgan Lee', text: 'A booking kiosk would be expensive and access for occasional suppliers is unresolved.' }
];
const proposal = { id: 'proposal', text: 'A booking kiosk was proposed to coordinate delivery slots.', evidenceIds: ['S02'], supportingDetails: [] };
const objection = { id: 'objection', text: 'A booking kiosk would be expensive and access for occasional suppliers is unresolved.', evidenceIds: ['S01', 'S03'], reviewFlagIds: ['flag-one'], supportingDetails: [
  { id: 'background', text: 'The loading bay is frequently blocked.', evidenceIds: ['S01'] }
] };
const topic = points => ({ id: 'delivery', topic: 'Delivery coordination', points, decisions: [], openQuestions: [] });

test('publication order uses direct claim support instead of citations donated by background', () => {
  const input = [topic([structuredClone(objection), structuredClone(proposal)])];
  const result = sortByEvidence(input, unitIndex(sources));
  assert.deepEqual(result[0].points.map(row => row.id), ['proposal', 'objection']);
  const kept = result[0].points[1];
  assert.equal(kept.text, objection.text);
  assert.deepEqual(kept.evidenceIds, ['S01', 'S03']);
  assert.deepEqual(kept.reviewFlagIds, ['flag-one']);
  assert.deepEqual(kept.supportingDetails, objection.supportingDetails);
});

test('a stamped claim anchor survives later evidence union without deleting any citation', () => {
  const original = { ...objection, evidenceIds: ['S03'] };
  const stamped = stampPrimaryDiscussionEvidence([topic([original])], sources)[0].points[0];
  assert.deepEqual(stamped.primaryEvidenceIds, ['S03']);
  const enriched = { ...stamped, evidenceIds: ['S01', 'S02', 'S03'] };
  assert.deepEqual(primaryEvidenceIdsForRecord(enriched, sources), ['S03']);
  assert.deepEqual(enriched.evidenceIds, ['S01', 'S02', 'S03']);
  assert.equal(Object.hasOwn(original, 'primaryEvidenceIds'), false);
});

test('invalid or non-cited primary anchors do not replace the source evidence', () => {
  const row = { ...objection, primaryEvidenceIds: ['UNKNOWN', 'S02'] };
  assert.deepEqual(primaryEvidenceIdsForRecord(row, sources), ['S03']);
});

test('weak lexical evidence falls back to stable citation chronology', () => {
  const units = [{ id: 'E01', text: 'Items were checked.' }, { id: 'E02', text: 'Concerns remain.' }];
  const row = { text: 'More detail is unavailable.', evidenceIds: ['E02', 'E01'] };
  assert.deepEqual(primaryEvidenceIdsForRecord(row, units), ['E02', 'E01']);
});

test('final topic arrangement cannot put an objection ahead of its earlier evidenced proposal', () => {
  const input = [topic([structuredClone(proposal), structuredClone(objection)])];
  const prepared = discussionTopicArrangementInput(input, sources);
  assert.deepEqual(prepared.records.map(row => row.evidenceOrder), [2, 3]);
  const result = applyDiscussionTopicArrangement(input, {
    groups: [{ topic: 'Delivery system', recordIds: ['objection', 'proposal'] }]
  }, sources, { input: prepared });
  assert.equal(result.applied, true);
  assert.deepEqual(result.discussion[0].points.map(row => row.id), ['proposal', 'objection']);
});

test('reviewer topic positions and reviewer-owned row order remain authoritative', () => {
  const manual = { id: 'manual-topic-one', topic: 'Reviewer order', reviewerAuthored: true,
    points: [{ ...objection, reviewerAuthored: true }, { ...proposal, reviewerAuthored: true }], decisions: [], openQuestions: [] };
  const input = [topic([structuredClone(objection)]), manual, { ...topic([structuredClone(proposal)]), id: 'earlier-topic' }];
  const result = sortByEvidence(input, unitIndex(sources));
  assert.equal(result[1], manual);
  assert.deepEqual(result.map(item => item.id), ['earlier-topic', 'manual-topic-one', 'delivery']);
  assert.deepEqual(result[1].points.map(row => row.id), ['objection', 'proposal']);
});

test('an arranger preserves a locked reviewer topic in its original position', () => {
  const manual = { id: 'manual-topic-one', topic: 'Reviewer order', reviewerAuthored: true,
    points: [{ id: 'reviewer', text: 'Keep this here.', evidenceIds: ['S01'], reviewFlagIds: [], supportingDetails: [], reviewerAuthored: true }], decisions: [], openQuestions: [] };
  const input = [topic([structuredClone(objection)]), manual, { ...topic([structuredClone(proposal)]), id: 'earlier-topic' }];
  const prepared = discussionTopicArrangementInput(input, sources);
  const result = applyDiscussionTopicArrangement(input, { groups: [
    { topic: 'Delivery proposal', recordIds: ['proposal'] }, { topic: 'Delivery constraints', recordIds: ['objection'] }
  ] }, sources, { input: prepared });
  assert.equal(result.discussion[1].id, manual.id);
  assert.deepEqual(result.discussion[1].points, manual.points);
});

test('an accepted resource allocation is eligible for main publication with source-verified destination', () => {
  const units = [
    { id: 'R01', text: 'We earmark the surplus for accessibility upgrades.' },
    { id: 'R02', text: 'Are we agreed on the new admission charge?' },
    { id: 'R03', text: 'Yes, that is decided.' }
  ];
  const detail = { text: 'The surplus is earmarked for accessibility upgrades.', evidenceIds: ['R01'] };
  assert.equal(isSourceSupportedMaterialDetail(detail, units), true);
  assert.equal(isSourceSupportedMaterialDetail({ ...detail, text: 'The surplus is earmarked for catering.' }, units), false);
});

test('unaccepted, rejected and unrelated allocations cannot be promoted as settled facts', () => {
  const detail = { text: 'The surplus is earmarked for accessibility upgrades.', evidenceIds: ['R01'] };
  for (const text of [
    'Perhaps we could earmark the surplus for accessibility upgrades.',
    'We should earmark the surplus for accessibility upgrades.',
    'Can we earmark the surplus for accessibility upgrades?',
    'We agreed to consider earmarking the surplus for accessibility upgrades.'
  ]) assert.equal(isSourceSupportedMaterialDetail(detail, [{ id: 'R01', text }]), false);
  assert.equal(isSourceSupportedMaterialDetail(detail, [
    { id: 'R01', text: 'We earmark the surplus for accessibility upgrades.' },
    { id: 'R02', text: 'That is not agreed. We need more information.' }
  ]), false);
  assert.equal(isSourceSupportedMaterialDetail(detail, [
    { id: 'R01', text: 'We earmark the surplus for accessibility upgrades.' },
    { id: 'R02', text: 'Moving on to the next item.' }, { id: 'R03', text: 'That is agreed.' }
  ]), false);
  assert.equal(isSourceSupportedMaterialDetail(detail, [
    { id: 'R01', text: 'We earmark the surplus for accessibility upgrades.' },
    { id: 'R02', text: 'The catering estimate is approved.' }
  ]), false);
  assert.equal(isSourceSupportedMaterialDetail(detail, [
    { id: 'R01', text: 'We earmark the surplus for accessibility upgrades.' },
    { id: 'R02', text: 'Are we agreed on the catering estimate?' },
    { id: 'R03', text: 'Yes, that is decided.' }
  ]), false);
  assert.equal(isSourceSupportedMaterialDetail(detail, [
    { id: 'R01', text: 'We earmark the surplus for accessibility upgrades.' },
    { id: 'R02', text: 'The accessibility upgrades estimate is approved.' },
    { id: 'R03', text: 'That is decided.' }
  ]), false);
  for (const text of [
    'We earmark the surplus for accessibility upgrades. The catering estimate is approved.',
    'We earmark the surplus for accessibility upgrades and the catering estimate is approved.',
    'The catering estimate is approved and we earmark the surplus for accessibility upgrades.',
    'We earmark the surplus for accessibility upgrades and approved the catering estimate.',
    'We earmark the surplus for accessibility upgrades, the catering estimate is approved.',
    'We earmark the surplus for accessibility upgrades and Dana approved the catering estimate.'
  ]) assert.equal(isSourceSupportedMaterialDetail(detail, [{ id: 'R01', text }]), false,
    'acceptance in the same transcript turn must bind to the allocation claim');
  assert.equal(isSourceSupportedMaterialDetail(detail, [
    { id: 'R01', text: 'We agreed to earmark the surplus for accessibility upgrades.' }
  ]), true);
  assert.equal(isSourceSupportedMaterialDetail(detail, [
    { id: 'R01', text: 'We earmark the surplus for accessibility upgrades. That is agreed.' }
  ]), true);
  assert.equal(isSourceSupportedMaterialDetail({
    text: 'The surplus is earmarked for accessibility upgrades and the platform repairs.', evidenceIds: ['R01']
  }, [{ id: 'R01', text: 'We agreed to earmark the surplus for accessibility upgrades and the platform repairs.' }]), true,
  'a coordinated allocation destination is not a separate approval clause');
});

test('source-backed numerical constraints are material without inventing a different amount', () => {
  const units = [{ id: 'N01', text: 'The reserve account holds seven hundred and twenty pounds.' }];
  const detail = { text: 'The reserve account holds £720.', evidenceIds: ['N01'] };
  assert.equal(isSourceSupportedMaterialDetail(detail, units), true);
  assert.equal(isSourceSupportedMaterialDetail({ ...detail, text: 'The reserve account holds £900.' }, units), false);
  assert.equal(isSourceSupportedMaterialDetail(detail, [{ id: 'N01', text: 'Could the reserve account hold £720?' }]), false);
  assert.equal(isSourceSupportedMaterialDetail(detail, [{ id: 'N01', text: 'The reserve account does not hold £720.' }]), false);
  assert.equal(isSourceSupportedMaterialDetail(detail, [{ id: 'N01', text: 'The reserve account requested supplies costing £720.' }]), false);
  assert.equal(isSourceSupportedMaterialDetail(detail, [{ id: 'N01', text: 'The reserve account holds £95 but requests £720.' }]), false);
  assert.equal(isSourceSupportedMaterialDetail(detail, [{ id: 'N01', text: 'The catering budget holds £720.' }]), false);
  assert.equal(isSourceSupportedMaterialDetail({ text: 'The lift costs £720.', evidenceIds: ['N01'] }, [
    { id: 'N01', text: 'The chairs cost £720.' }
  ]), false);
});

test('jokes, raw speech, unsupported assertions and reviewer-owned detail are not auto-promoted', () => {
  const units = [{ id: 'J01', text: "I'll reserve the surplus for my holiday, only joking." },
    { id: 'J02', text: 'Ha, that would be nice.' }];
  assert.equal(isSourceSupportedMaterialDetail({ text: 'The surplus is reserved for a holiday.', evidenceIds: ['J01'] }, units), false);
  assert.equal(isSourceSupportedMaterialDetail({ text: "I'll reserve the surplus for my holiday, only joking.", evidenceIds: ['J01'] }, units), false);
  assert.equal(isSourceSupportedMaterialDetail({ text: 'The reserve account holds £720.', evidenceIds: [] }, []), false);
  assert.equal(isSourceSupportedMaterialDetail({ text: 'The reserve account holds £720.', evidenceIds: ['J01'], reviewerAuthored: true }, units), false);
});
