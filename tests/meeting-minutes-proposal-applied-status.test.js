'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
// These are pure transaction tests: any accidental persistence or provider call
// is a failure, rather than an integration dependency.
const db = require('../utils/db');
for (const name of ['query', 'queryOne', 'execute']) {
  if (typeof db[name] === 'function') db[name] = () => { throw new Error('Database access forbidden in proposal transaction tests'); };
}
const noNetwork = async () => { throw new Error('Provider access forbidden in proposal transaction tests'); };
global.fetch = noNetwork;
const fetchPath = require.resolve('node-fetch');
require.cache[fetchPath] = { id: fetchPath, filename: fetchPath, loaded: true, exports: noNetwork };
const A = require('../routes/api').stagedEvaluation;
const V = require('../utils/meetingMinutesAgentV2');

const row = (id, action = 'Send the inspection report.', extra = {}) => ({
  id, occurrenceId: `occ-${id}`, action, owners: ['Morgan Reed'],
  timing: { kind: 'not_stated', wording: '', exactDate: '' },
  evidenceIds: ['T0001'], reviewFlagIds: [], ...extra
});
const change = (id, type, before, after = null) => ({
  id, type, before: structuredClone(before), after: after && structuredClone(after), selected: true
});
const proposal = changes => ({ id: 'proposal', stage: 'actions', changes });
const automaticFlag = (review, id) => review.reviewFlags.find(flag => flag.id === `automatic-review-${id}`);
function reviewAndApply(current, p, flags = []) {
  const original = structuredClone({ current, p, flags });
  const review = A.automaticMeetingAgentProposalReview(p, flags, current);
  const after = V.applyProposal(current, p, review.acceptedIds);
  assert.deepEqual({ current, p, flags }, original, 'review must not mutate its inputs');
  return { ...review, after };
}

test('a stale remove cannot claim success merely because a same-worded current occurrence survives', () => {
  const before = row('A1', undefined, { occurrenceId: 'old-occurrence' });
  const current = [row('A1', before.action, { occurrenceId: 'new-occurrence' })];
  const p = proposal([change('stale-remove', 'remove', before)]);
  const review = reviewAndApply(current, p, [{ id: 'unrelated', kind: 'ownership', status: 'open', message: 'The recipient for the inspection report is not established by the cited passage.', evidenceIds: ['T0001'] }]);
  assert.deepEqual(review.acceptedIds, []);
  assert.deepEqual(review.after, current);
  assert.equal(automaticFlag(review, 'stale-remove')?.status, 'open');
  assert.equal(review.reviewFlags.find(flag => flag.id === 'unrelated')?.status, 'open');
  assert.ok(!review.reviewFlags.some(flag => flag.status === 'confirmed'));
});

test('a stale selected modification leaves the current action and source check open', () => {
  const before = row('A1');
  const current = [row('A1', 'Send the approved inspection report.')];
  const p = proposal([change('stale-edit', 'modify', before, { ...before, action: 'Email the inspection report.' })]);
  const review = reviewAndApply(current, p, [{ id: 'proposal-review-stale-edit', kind: 'possible_missed_follow_up', status: 'open', message: 'Check the edit.', evidenceIds: ['T0001'] }]);
  assert.deepEqual(review.acceptedIds, []);
  assert.deepEqual(review.after, current);
  assert.equal(automaticFlag(review, 'stale-edit')?.status, 'open');
  assert.ok(!review.reviewFlags.some(flag => flag.status === 'confirmed'));
});

test('ambiguous occurrence tokens and indistinguishable serialized legacy targets are never accepted', () => {
  const tokenRow = row('A1');
  const legacy = row('A2');
  delete legacy.occurrenceId;
  for (const [current, before] of [
    [[tokenRow, { ...tokenRow, id: 'A3' }], tokenRow],
    [[legacy, structuredClone(legacy)], legacy]
  ]) {
    for (const type of ['modify', 'remove']) {
      const p = proposal([change('ambiguous', type, before, { ...before, action: 'Email the inspection report.' })]);
      const review = reviewAndApply(current, p);
      assert.deepEqual(review.acceptedIds, []);
      assert.deepEqual(review.after, current);
      assert.equal(automaticFlag(review, 'ambiguous')?.status, 'open');
    }
  }
});

test('valid edits and lossless duplicate removals retain occurrence identity after reorder', () => {
  const target = row('A1');
  const other = row('A2', 'Review the safety register.');
  const edit = proposal([change('edit', 'modify', target, { ...target, id: 'MODEL', occurrenceId: 'wrong', action: 'Email the inspection report.' })]);
  const edited = reviewAndApply([other, target], edit);
  assert.deepEqual(edited.acceptedIds, ['edit']);
  assert.equal(edited.after[1].occurrenceId, target.occurrenceId);
  assert.equal(edited.after[1].id, target.id);
  assert.equal(edited.after[1].action, 'Email the inspection report.');
  const duplicate = row('A3', target.action);
  const removed = reviewAndApply([duplicate, other, target], proposal([change('remove', 'remove', target)]));
  assert.deepEqual(removed.acceptedIds, ['remove']);
  assert.deepEqual(removed.after, [duplicate, other]);
});

test('two selected modifications of one occurrence only credit the modification actually applied', () => {
  const target = row('A1');
  const p = proposal([
    change('first', 'modify', target, { ...target, action: 'Email the inspection report.' }),
    change('second', 'modify', target, { ...target, action: 'Send the final inspection report.' })
  ]);
  const review = reviewAndApply([target], p);
  assert.deepEqual(review.acceptedIds, ['first']);
  assert.equal(review.after[0].action, 'Email the inspection report.');
  assert.equal(automaticFlag(review, 'second')?.status, 'open');
});

test('a valid removal wins its occurrence while a competing modification stays a source check', () => {
  const target = row('A1');
  const survivor = row('A2', target.action);
  const p = proposal([
    change('remove', 'remove', target),
    change('edit', 'modify', target, { ...target, action: 'Email the inspection report.' })
  ]);
  const review = reviewAndApply([target, survivor], p);
  assert.deepEqual(review.acceptedIds, ['remove']);
  assert.deepEqual(review.after, [survivor]);
  assert.equal(automaticFlag(review, 'edit')?.status, 'open');
});

test('rejecting an unsafe removal does not suppress a valid competing edit', () => {
  const target = row('A1');
  const p = proposal([
    change('remove', 'remove', target),
    change('edit', 'modify', target, { ...target, action: 'Email the inspection report.' })
  ]);
  const review = reviewAndApply([target], p);
  assert.deepEqual(review.acceptedIds, ['edit']);
  assert.equal(review.after[0].action, 'Email the inspection report.');
  assert.equal(automaticFlag(review, 'remove')?.status, 'open');
});

test('an addition already present is not credited as an applied change or used to resolve its warning', () => {
  const current = [row('A1')];
  const p = proposal([change('add', 'add', null, current[0])]);
  const review = reviewAndApply(current, p);
  assert.deepEqual(review.acceptedIds, []);
  assert.deepEqual(review.after, current);
  assert.equal(automaticFlag(review, 'add')?.status, 'open');
});

test('an already-applied edit and a literal no-op edit do not produce false acceptance', () => {
  const before = row('A1');
  const after = { ...before, action: 'Email the inspection report.' };
  const p = proposal([change('edit', 'modify', before, after)]);
  const once = reviewAndApply([before], p);
  assert.deepEqual(once.acceptedIds, ['edit']);
  const repeated = reviewAndApply(once.after, p);
  assert.deepEqual(repeated.acceptedIds, []);
  assert.deepEqual(repeated.after, once.after);
  assert.equal(automaticFlag(repeated, 'edit')?.status, 'open');
  const noop = reviewAndApply([before], proposal([change('noop', 'modify', before, before)]));
  assert.deepEqual(noop.acceptedIds, []);
  assert.deepEqual(noop.after, [before]);
  assert.equal(automaticFlag(noop, 'noop')?.status, 'open');
});

test('a literal no-op suggestion cannot consume the target of a later valid edit', () => {
  const before = row('A1');
  const p = proposal([
    change('noop', 'modify', before, before),
    change('edit', 'modify', before, { ...before, action: 'Email the inspection report.' })
  ]);
  const review = reviewAndApply([before], p);
  assert.deepEqual(review.acceptedIds, ['edit']);
  assert.equal(review.after[0].action, 'Email the inspection report.');
});

test('an old composite removal cannot be retargeted to either current split action', () => {
  const old = row('A1', 'Update the inspection register, and circulate the revised report.');
  const documentation = row('A1', 'Update the inspection register.');
  const circulation = row('A1-part2', 'Circulate the revised report.');
  const other = row('A2', old.action);
  const p = proposal([change('remove-unsplit', 'remove', old)]);
  const review = reviewAndApply([documentation, circulation, other], p);
  assert.deepEqual(review.acceptedIds, []);
  assert.deepEqual(review.after, [documentation, circulation, other]);
  assert.equal(automaticFlag(review, 'remove-unsplit')?.status, 'open');
});

test('explicit manual selection retains literal transaction behavior', () => {
  const target = row('A1');
  const p = proposal([change('manual', 'modify', target, { ...target, action: 'Email the inspection report.' })]);
  assert.equal(V.applyProposal([target], p, ['manual'])[0].action, 'Email the inspection report.');
  const stale = { ...p, changes: [{ ...p.changes[0], before: { ...target, occurrenceId: 'old' } }] };
  assert.deepEqual(V.applyProposal([target], stale, ['manual']), [target]);
});
