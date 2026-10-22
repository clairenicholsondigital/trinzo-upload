'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  rehomeSupportingDetails, organiseDiscussionForReview, unitIndex
} = require('../utils/canonicalMinutes/discussionOrganiser');
const {
  collectUnassignedSupportingDetails, mergeUnassignedSupportingDetails,
  withoutRepresentedUnassignedDetails
} = require('../utils/meetingMinutesSupportingDetails');
const row = (id, text, supportingDetails = [], extra = {}) => ({
  id, text, evidenceIds: ['T0002'], reviewFlagIds: [], supportingDetails, ...extra
});
const fixture = () => [{
  id: 'cooling', topic: 'Cooling inspection',
  points: [row('inspection', 'The cooling assembly passed pressure qualification.', [
    row('insurance', 'Supplier liability insurance awaits confirmation.', [], {
      reviewFlagIds: ['supplier-check'], mergedFromIds: ['earlier-insurance']
    })
  ])], decisions: [], openQuestions: []
}];
const units = [
  { id: 'T0001', sequence: 1, speaker: 'Morgan Lee', text: 'Inspection results were accepted.' },
  { id: 'T0002', sequence: 2, speaker: 'Sam Okoro', text: 'The supplier policy is still being confirmed.' }
];
function collector(pool) {
  return (detail, context) => {
    pool.push(...collectUnassignedSupportingDetails(detail, context));
    return true;
  };
}
test('unresolved generated context leaves its unrelated parent only after a successful full handoff', () => {
  const topics = fixture(), pool = [], primary = structuredClone(topics[0].points[0]);
  const expected = primary.supportingDetails[0];
  rehomeSupportingDetails(topics, unitIndex(units), { onUnassignedSupportingDetail: collector(pool) });
  assert.deepEqual(topics[0].points[0], { ...primary, supportingDetails: [] });
  assert.equal(pool.length, 1);
  assert.equal(pool[0].text, expected.text);
  assert.deepEqual(pool[0].evidenceIds, expected.evidenceIds);
  assert.deepEqual(pool[0].reviewFlagIds, expected.reviewFlagIds);
  assert.deepEqual(pool[0].mergedFromIds, expected.mergedFromIds);
  assert.equal(pool[0].originalTopic, 'Cooling inspection');
  assert.equal(pool[0].placementReason, 'no_subject_match');
  assert.deepEqual(withoutRepresentedUnassignedDetails(pool, topics), pool);
  rehomeSupportingDetails(topics, unitIndex(units), { onUnassignedSupportingDetail: collector(pool) });
  assert.equal(pool.length, 1, 'repeated organisation cannot re-collect detached context');
});
test('missing or rejecting collectors retain unresolved context and its complete subtree', () => {
  for (const options of [{}, { onUnassignedSupportingDetail: () => false }]) {
    const topics = fixture();
    topics[0].points[0].supportingDetails[0].supportingDetails = [
      row('deep', 'The independent insurance schedule remains available.')
    ];
    const before = structuredClone(topics[0].points[0].supportingDetails[0]);
    rehomeSupportingDetails(topics, unitIndex(units), options);
    assert.deepEqual(topics[0].points[0].supportingDetails[0], {
      ...before, placementStatus: 'unresolved', placementReason: 'no_subject_match'
    });
  }
});
test('a throwing collector cannot detach the original context', () => {
  const topics = fixture(), before = structuredClone(topics);
  assert.throws(() => rehomeSupportingDetails(topics, unitIndex(units), {
    onUnassignedSupportingDetail() { throw Error('storage unavailable'); }
  }), /storage unavailable/);
  assert.deepEqual(topics, before);
});
test('handoff retains long descendants once, source warnings and predecessor history', () => {
  const topics = fixture(), pool = [];
  const child = row('deep', 'Independent qualification. '.repeat(120) + 'FINAL-QUALIFICATION', [], {
    evidenceIds: ['T0003'], reviewFlagIds: ['deep-check'], mergedFromIds: ['deep-predecessor']
  });
  topics[0].points[0].supportingDetails[0].supportingDetails = [child];
  rehomeSupportingDetails(topics, unitIndex(units), { onUnassignedSupportingDetail: collector(pool) });
  assert.deepEqual(pool.map(x => x.id), ['insurance', 'deep']);
  assert.equal(pool[1].text, child.text);
  assert.deepEqual(pool[1].reviewFlagIds, child.reviewFlagIds);
  assert.deepEqual(pool[1].mergedFromIds, child.mergedFromIds);
  assert.deepEqual(mergeUnassignedSupportingDetails(pool, pool), pool);
});
test('reviewer placements including a reviewer descendant are protected from automatic handoff', () => {
  for (const protect of [
    topics => { topics[0].reviewerAuthored = true; },
    topics => { topics[0].id = 'manual-topic-cooling'; },
    topics => { topics[0].points[0].reviewerAuthored = true; },
    topics => { topics[0].points[0].supportingDetails[0].reviewerAuthored = true; },
    topics => { topics[0].points[0].supportingDetails[0].supportingDetails = [
      row('manual-child', 'The reviewer retained this qualification.', [], { reviewerAuthored: true })
    ]; }
  ]) {
    const topics = fixture(), pool = [];
    protect(topics);
    const before = structuredClone(topics);
    rehomeSupportingDetails(topics, unitIndex(units), { onUnassignedSupportingDetail: collector(pool) });
    assert.deepEqual(topics, before);
    assert.deepEqual(pool, []);
  }
});
test('a unique subject match still files to its real parent instead of increasing Needs filing', () => {
  const topics = fixture(), pool = [];
  topics.push({ id: 'supplier', topic: 'Supplier assurance', points: [
    row('policy', 'Supplier liability insurance is under assessment.')
  ], decisions: [], openQuestions: [] });
  rehomeSupportingDetails(topics, unitIndex(units), { onUnassignedSupportingDetail: collector(pool) });
  assert.deepEqual(topics[0].points[0].supportingDetails, []);
  assert.equal(topics[1].points[0].supportingDetails[0].id, 'insurance');
  assert.deepEqual(pool, []);
});
test('ambiguous matches and reviewer-locked explicit targets use the same lossless handoff', () => {
  for (const reason of ['ambiguous_subject_match', 'reviewer_target_locked']) {
    const topics = fixture(), pool = [];
    const target = row('policy', 'Supplier liability insurance is under assessment.');
    topics.push({ id: 'supplier', topic: 'Supplier assurance', points: [target], decisions: [], openQuestions: [] });
    if (reason === 'ambiguous_subject_match') topics[1].points.push({ ...target, id: 'other-policy' });
    else {
      target.reviewerAuthored = true;
      topics[0].points[0].supportingDetails[0].targetId = 'policy';
    }
    rehomeSupportingDetails(topics, unitIndex(units), { onUnassignedSupportingDetail: collector(pool) });
    assert.deepEqual(topics[0].points[0].supportingDetails, []);
    assert.equal(pool[0].placementReason, reason);
    assert.deepEqual(target.supportingDetails, []);
  }
});
test('the full organiser forwards the existing Needs filing collector without changing main prose', async () => {
  const topics = fixture(), pool = [];
  topics[0].points[0].reviewFlagIds = ['retain-main'];
  const result = await organiseDiscussionForReview(topics, units, {
    encode: async () => null, mergeRestatements: false,
    onUnassignedSupportingDetail: collector(pool)
  });
  assert.equal(result.discussion[0].points[0].text, topics[0].points[0].text);
  assert.deepEqual(result.discussion[0].points[0].supportingDetails, []);
  assert.equal(pool.length, 1);
  assert.equal(topics[0].points[0].supportingDetails.length, 1, 'the full pass clones its caller input');
});
test('moved context and its warnings survive normal draft payloads and real Word evidence export', async () => {
  const { stagedEvaluation: api } = require('../routes/api');
  const { generateMeetingMinutesAgentDocx } = require('../utils/meetingMinutesAgentDocx');
  const JSZip = require('jszip');
  const topics = fixture(), pool = [];
  rehomeSupportingDetails(topics, unitIndex(units), { onUnassignedSupportingDetail: collector(pool) });
  const warning = { id: 'supplier-check', kind: 'unclear_reference', status: 'open',
    correctionNote: '', message: 'Confirm which supplier the insurance reference describes.', evidenceIds: ['T0002'] };
  const draft = { discussion: topics, unassignedSupportingDetails: pool, sourceUnits: units,
    actions: [], reviewFlags: [warning], details: { meetingTitle: 'Inspection review', meetingDate: '2026-10-22' } };
  const visible = api.publicMeetingAgentDraft({ ...draft, ...api.meetingAgentDraftPayload(draft) });
  assert.deepEqual(visible.unassignedSupportingDetails, pool);
  assert.equal(visible.reviewFlags.find(f => f.id === warning.id).status, 'open');
  const zip = await JSZip.loadAsync(await generateMeetingMinutesAgentDocx(visible, true));
  const xml = await zip.file('word/document.xml').async('string');
  assert.match(xml, /Needs filing/);
  assert.equal(xml.split(pool[0].text).length - 1, 1);
  assert.match(xml, /The supplier policy is still being confirmed/);
  assert.deepEqual(draft.discussion[0].points[0].supportingDetails, []);
});
