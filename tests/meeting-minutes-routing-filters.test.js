'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const O = require('../utils/canonicalMinutes/discussionOrganiser');
const { stagedEvaluation: A } = require('../routes/api');
const { collectUnassignedSupportingDetails, mergeUnassignedSupportingDetails } = require('../utils/meetingMinutesSupportingDetails');

const formal = [
  'Morgan asked Riley to confirm the inlet setting before the inspection.',
  'Morgan and Sam requested Riley to confirm the inlet setting.',
  'The committee agreed to review the supplier assessment.',
  'The committee decided to review the supplier assessment.',
  'Morgan confirmed the team agreed to update the inspection report.',
  'Morgan instructed Riley to check the inlet setting.',
  'The committee declined to review the supplier assessment.',
  'The committee refused to review the supplier assessment.'
];
for (const text of formal) test('finite reported clause is not a task-note fragment: ' + text, () => {
  assert.equal(O.isConversational(text), false);
});
for (const text of [
  'Morgan to confirm the inlet setting.', 'Morgan Lee to review the assessment.',
  'Morgan to confirm the inlet setting and asked Riley to review the report.',
  'Morgan to ask Riley to review the supplier assessment.',
  'Supplier request to review the assessment.',
  'Supplier offer to review the assessment.',
  'Need to confirm the inlet setting.', 'The committee to review the supplier assessment.',
  'So Morgan asked Riley to confirm the inlet setting.',
  'Morgan asked Riley to confirm the inlet setting, you know.',
  'The speaker asked Riley to confirm the inlet setting.'
]) test('real fragments, conversational filler and unresolved roles stay blocked: ' + text, () => {
  assert.equal(O.isConversational(text), true);
});

const units = [
  { id: 'T0001', sequence: 1, speaker: 'Morgan', text: 'Can you check the laboratory access?' },
  { id: 'T0002', sequence: 2, speaker: 'Sam', text: 'The supplier qualification remains pending approval.' },
  { id: 'T0003', sequence: 3, speaker: 'Riley', text: 'The safety induction is required before access.' }
];
const child = (extra = {}) => ({ id: 'child', text: units[1].text, evidenceIds: ['T0002'], ...extra });
const card = (parent, kind = 'points') => [{
  id: 'topic', topic: 'Laboratory access', points: [], decisions: [], openQuestions: [], [kind]: [parent]
}];
const rawParent = (children) => ({
  id: 'parent', text: units[0].text, evidenceIds: ['T0001'], supportingDetails: children
});
const mainRows = discussion => discussion.flatMap(t =>
  ['points', 'decisions', 'openQuestions'].flatMap(k => t[k] || []));
function compact(input, source = units, extra = {}) {
  const received = [], pool = [];
  const result = A.compactDiscussionPropositions(input, [], source, {
    promoteMaterialSupporting: false,
    onUnassignedSupportingDetail(detail, context) {
      received.push({ detail, context });
      pool.push(...collectUnassignedSupportingDetails(detail, context));
      return true;
    }, ...extra
  });
  return { result, received, pool: mergeUnassignedSupportingDetails(pool) };
}
for (const kind of ['points', 'decisions', 'openQuestions']) {
  test('rejecting a raw parent preserves its cited child from ' + kind, () => {
    const input = card(rawParent([child()]), kind), before = structuredClone(input);
    const out = compact(input);
    assert.equal(mainRows(out.result).length, 0);
    assert.deepEqual(out.pool.map(r => [r.id, r.text, r.evidenceIds]),
      [['child', units[1].text, ['T0002']]]);
    assert.equal(out.pool[0].placementReason, 'parent_not_publishable');
    assert.deepEqual(input, before);
  });
}
test('rejecting an uncited parent retains its cited child without publishing the parent', () => {
  const input = card({ id: 'unsupported', text: 'The inspection will take place on 19 February 2031.',
    evidenceIds: ['T9999'], supportingDetails: [child()] });
  const out = compact(input);
  assert.equal(mainRows(out.result).length, 0);
  assert.equal(out.pool.length, 1);
  assert.equal(out.pool[0].text, units[1].text);
  assert.deepEqual(out.pool[0].evidenceIds, ['T0002']);
});
test('handoff preserves full nested text, warnings, history and reviewer metadata', () => {
  const text = 'The supplier qualification remains pending approval. '.repeat(50) + 'FINAL QUALIFICATION';
  const nested = { id: 'nested', text: units[2].text, evidenceIds: ['T0003'],
    reviewFlagIds: ['nested-warning'], mergedFromIds: ['nested-predecessor'], reviewerAuthored: true };
  const input = card(rawParent([child({ text, reviewFlagIds: ['child-warning'],
    mergedFromIds: ['child-predecessor'], supportingDetails: [nested] })]));
  const before = structuredClone(input), out = compact(input);
  assert.equal(mainRows(out.result).length, 0);
  assert.equal(out.pool.length, 2);
  const kept = out.pool.find(r => r.id === 'child');
  assert.equal(kept.text, text);
  assert.deepEqual(kept.reviewFlagIds, ['child-warning']);
  assert.deepEqual(kept.mergedFromIds, ['child-predecessor']);
  const retainedNested = out.pool.find(r => r.id === 'nested');
  assert.equal(retainedNested.text, nested.text);
  assert.deepEqual(retainedNested.reviewFlagIds, nested.reviewFlagIds);
  assert.deepEqual(retainedNested.mergedFromIds, nested.mergedFromIds);
  assert.equal(retainedNested.reviewerAuthored, true);
  assert.deepEqual(input, before);
});
test('a malformed nested placeholder cannot discard a valid retained descendant', () => {
  const nested = { id: 'nested', text: units[2].text, evidenceIds: ['T0003'] };
  const out = compact(card(rawParent([child({ supportingDetails: [null, nested] })])));
  assert.equal(mainRows(out.result).length, 0);
  assert.ok(out.pool.some(r => r.id === 'nested' && r.text === nested.text));
});
test('parent rejection retains source children beyond the generated presentation cap', () => {
  const children = Array.from({ length: 55 }, (_, i) => child({ id: 'detail-' + i,
    text: 'The supplier qualification remains pending approval for lot ' + (i + 1) + '.' }));
  const out = compact(card(rawParent(children)));
  assert.equal(mainRows(out.result).length, 0);
  assert.equal(out.pool.length, 55);
  assert.deepEqual(new Set(out.pool.map(r => r.id)), new Set(children.map(r => r.id)));
});
test('a rejected parent cannot silently discard children without a collector', () => {
  assert.throws(() => A.compactDiscussionPropositions(card(rawParent([child()])), [], units, { promoteMaterialSupporting: false }),
    /lossless review collector/);
  assert.throws(() => compact(card(rawParent([child()])), units, {
    onUnassignedSupportingDetail: () => false
  }), /lossless review collector/);
  assert.throws(() => compact(card(rawParent([child()])), units, {
    onUnassignedSupportingDetail: () => { throw Error('collector unavailable'); }
  }), /collector unavailable/);
});
test('an unsuitable parent without descendants stays blocked without needing a collector', () => {
  assert.deepEqual(A.compactDiscussionPropositions(card(rawParent([])), [], units), []);
});
test('publishable parents keep ordinary supporting context instead of filing everything', () => {
  const text = 'The laboratory access remains dependent on supplier qualification.';
  const source = [...units, { id: 'T0004', sequence: 4, speaker: 'Morgan', text }];
  const out = compact(card({ id: 'ready', text, evidenceIds: ['T0004'], supportingDetails: [child()] }), source);
  assert.equal(mainRows(out.result).length, 1);
  assert.equal(out.pool.length, 0);
});
test('the organiser retains a formal reported request without changing its wording or evidence', async () => {
  const text = formal[0], source = [{ id: 'T0001', sequence: 1, speaker: 'Sam', text: 'Please confirm the inlet setting before the inspection.' }];
  const input = card({ id: 'formal', text, evidenceIds: ['T0001'], supportingDetails: [] });
  const pool = [];
  const out = await O.organiseDiscussionForReview(input, source, {
    encode: async () => null, mergeRestatements: false,
    onUnassignedSupportingDetail: r => { pool.push(r); return true; }
  });
  assert.equal(mainRows(out.discussion).length, 1);
  assert.equal(mainRows(out.discussion)[0].text, text);
  assert.deepEqual(mainRows(out.discussion)[0].evidenceIds, ['T0001']);
  assert.deepEqual(pool, []);
});
test('unrelated supporting material still needs a subject match', () => {
  const topics = card({ id: 'ready', text: 'The laboratory inlet pressure passed inspection.',
    evidenceIds: ['T0001'], supportingDetails: [child()] });
  const pool = [];
  O.rehomeSupportingDetails(topics, O.unitIndex(units), {
    onUnassignedSupportingDetail: (r, c) => { pool.push({ r, c }); return true; }
  });
  assert.equal(topics[0].points[0].supportingDetails.length, 0);
  assert.equal(pool[0].c.placementReason, 'no_subject_match');
});
