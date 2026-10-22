'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const I = require('../utils/meetingMinutesActionIdentity');
const V = require('../utils/meetingMinutesAgentV2');

const row = (id, action, extra = {}) => ({
  id, action, owners: ['Morgan Lee'], timing: { kind: 'not_stated', wording: '', exactDate: '' },
  evidenceIds: ['T0010'], reviewFlagIds: ['flag-original'], ...extra
});
const withoutIdentity = ({ id: _id, occurrenceId: _occurrenceId, ...content }) => content;
const proposal = changes => ({ id: 'proposal-one', stage: 'actions', changes });
const change = (id, type, before, after, index = 0) => ({ id, type, before, after, index, beforeIndex: index });

test('generated collisions receive distinct stable identities without changing any content or provenance', () => {
  const input = [row('A4', 'Send the inspection report.'), row('A4', 'Review the inspection report.', {
    evidenceIds: ['T0020'], reviewFlagIds: ['other'], timingDecision: { status: 'rejected' }
  })];
  const original = structuredClone(input);
  const out = I.assignGeneratedActionIdentities(input, { generationKey: 'run-one' });
  assert.equal(new Set(out.actions.map(r => r.id)).size, 2);
  assert.equal(new Set(out.actions.map(r => r.occurrenceId)).size, 2);
  assert.deepEqual(out.actions.map(withoutIdentity), input.map(withoutIdentity));
  assert.deepEqual(input, original);
  assert.deepEqual(I.assignGeneratedActionIdentities(out.actions, { generationKey: 'run-one' }).actions, out.actions);
  assert.deepEqual(I.assignGeneratedActionIdentities([...out.actions].reverse()).actions, [...out.actions].reverse());
  const reversedRaw = I.assignGeneratedActionIdentities([...input].reverse(), { generationKey: 'run-one' }).actions;
  assert.deepEqual(new Map(reversedRaw.map(r => [r.action, r.id])), new Map(out.actions.map(r => [r.action, r.id])));
});

test('admission reserves active and removed identities while preserving exact existing copies', () => {
  const existing = row('A4', 'Send the inspection report.', { occurrenceId: 'existing-occurrence', reviewerAuthored: true });
  const removed = row('A6', 'Archive the inspection report.', { occurrenceId: 'removed-occurrence' });
  const different = row('A4', 'Send the inspection report.', { evidenceIds: ['T0020'], occurrenceId: 'existing-occurrence' });
  const copied = structuredClone(existing);
  const out = I.assignGeneratedActionIdentities([copied, different, row('A6', 'Review the safety report.')], {
    existingActions: [existing], reservedActions: [removed], generationKey: 'run'
  });
  assert.equal(out.actions[0].id, existing.id);
  assert.notEqual(out.actions[0].occurrenceId, existing.occurrenceId, 'a copied ambiguous token is retired for every incoming occurrence');
  assert.deepEqual(withoutIdentity(out.actions[0]), withoutIdentity(existing));
  assert.notEqual(out.actions[1].id, existing.id);
  assert.notEqual(out.actions[1].occurrenceId, existing.occurrenceId);
  assert.notEqual(out.actions[2].id, removed.id);
  assert.notEqual(out.actions[2].occurrenceId, removed.occurrenceId);
  assert.deepEqual(out.actions.map(withoutIdentity), [copied, different, row('A6', 'Review the safety report.')].map(withoutIdentity));
});

test('ambiguous incoming and existing occurrence tokens cannot transfer an old kept decision', () => {
  const first = row('A4', 'Inspect the roof.', { occurrenceId: 'shared' });
  const second = row('A4', 'Order the tiles.', { occurrenceId: 'shared' });
  for (const options of [{}, { existingActions: [first, second] },
    { existingActions: [first, second], reservedActions: [first, second] }]) {
    const input = structuredClone([first, second]);
    const out = I.assignGeneratedActionIdentities(input, options).actions;
    assert.equal(new Set(out.map(action => action.occurrenceId)).size, 2);
    assert.ok(out.every(action => action.occurrenceId !== 'shared'));
    assert.deepEqual(out.map(withoutIdentity), input.map(withoutIdentity));
    assert.deepEqual(input, [first, second]);
    const legacyKept = ['shared'];
    assert.deepEqual(out.filter(action => legacyKept.includes(action.occurrenceId)), []);
    assert.deepEqual(I.assignGeneratedActionIdentities(out, { existingActions: out }).actions, out);
  }
});

test('reservation overlap keeps a unique active token but an active and removed collision retires it', () => {
  const active = row('A4', 'Inspect the roof.', { occurrenceId: 'shared' });
  const removed = row('A6', 'Order the tiles.', { occurrenceId: 'shared' });
  assert.deepEqual(I.assignGeneratedActionIdentities([structuredClone(active)], {
    existingActions: [active], reservedActions: [active]
  }).actions, [active], 'the same active object reserved twice is one actual occurrence');
  const out = I.assignGeneratedActionIdentities([structuredClone(active)], {
    existingActions: [active], reservedActions: [active, removed]
  }).actions;
  assert.equal(out[0].id, active.id);
  assert.notEqual(out[0].occurrenceId, 'shared');
  assert.deepEqual(withoutIdentity(out[0]), withoutIdentity(active));
  assert.equal(removed.occurrenceId, 'shared', 'reserved history is immutable; callers must discard ambiguous kept references');
  const repeatedReference = I.assignGeneratedActionIdentities([active, active], {
    existingActions: [active, active], reservedActions: [active, active]
  }).actions;
  assert.ok(repeatedReference.every(action => action.occurrenceId !== 'shared'));
  assert.equal(new Set(repeatedReference.map(action => action.occurrenceId)).size, 2);
});

test('identical editable rows with different provenance remain distinct occurrences', () => {
  const first = row('A6', 'Provide the command documentation.', { evidenceIds: ['T0100'] });
  const second = { ...first, evidenceIds: ['T0200'], reviewFlagIds: ['flag-second'], timingDecision: { status: 'unresolved' } };
  const out = I.assignGeneratedActionIdentities([first, second], { existingActions: [first] }).actions;
  assert.equal(out[0].id, first.id);
  assert.notEqual(out[1].id, first.id);
  assert.notEqual(out[1].occurrenceId, out[0].occurrenceId);
  assert.deepEqual(out.map(withoutIdentity), [first, second].map(withoutIdentity));
});

test('ordinary reviewer normalization carries valid occurrence IDs without minting or renumbering', () => {
  const input = [row('A4', 'Send the inspection report.', { occurrenceId: 'action-occurrence_123' }),
    row('A4', 'Review the inspection report.')];
  const out = V.normaliseActions({ actions: input }, [], { enforceEvidence: false, dedupeActions: false, preserveReviewerEdits: true });
  assert.deepEqual(out.map(r => r.id), ['A4', 'A4']);
  assert.equal(out[0].occurrenceId, input[0].occurrenceId);
  assert.equal(Object.hasOwn(out[1], 'occurrenceId'), false);
  assert.equal(I.validOccurrenceId('x'.repeat(128)), 'x'.repeat(128));
  for (const invalid of ['x'.repeat(129), 'bad space', '<bad>', null]) assert.equal(I.validOccurrenceId(invalid), '');
});

test('deep terminology normalization preserves opaque occurrence keys throughout draft payloads', () => {
  const input = {
    actions: [row('A1', 'Review meds app.', { occurrenceId: 'meds-app' })],
    removedActions: [row('A2', 'Archive meds app.', { occurrenceId: 'Meds-App' })],
    keptActionOccurrenceIds: ['meds-app', 'Meds-App'],
    pendingProposal: { changes: [{ before: { occurrenceId: 'meds-app' }, after: { occurrenceId: 'Meds-App' } }] }
  };
  const original = structuredClone(input);
  const out = V.normaliseKnownTermsDeep(input);
  assert.equal(out.actions[0].occurrenceId, 'meds-app');
  assert.equal(out.removedActions[0].occurrenceId, 'Meds-App');
  assert.deepEqual(out.keptActionOccurrenceIds, input.keptActionOccurrenceIds);
  assert.deepEqual(out.pendingProposal, input.pendingProposal);
  assert.equal(out.actions[0].action, 'Review MDSAP.');
  assert.equal(out.removedActions[0].action, 'Archive MDSAP.');
  assert.deepEqual(input, original);
  assert.deepEqual(V.normaliseKnownTermsDeep(out), out);
});

test('proposal modifications preserve the target identity and use its exact occurrence after reorder', () => {
  const first = row('A4', 'Send the inspection report.', { occurrenceId: 'first' });
  const second = row('A4', 'Send the inspection report.', { occurrenceId: 'second', evidenceIds: ['T0020'] });
  const p = proposal([change('modify-second', 'modify', second,
    { ...second, id: 'MODEL_REPLACEMENT', occurrenceId: 'wrong', action: 'Send the final inspection report.' }, 1)]);
  const out = V.applyProposal([second, first], p, ['modify-second']);
  assert.equal(out[0].id, second.id);
  assert.equal(out[0].occurrenceId, second.occurrenceId);
  assert.equal(out[0].action, 'Send the final inspection report.');
  assert.equal(out[1], first);
});

test('legacy proposal targeting distinguishes provenance and refuses a missing or ambiguous occurrence', () => {
  const first = row('A6', 'Provide command details.', { evidenceIds: ['T0100'], reviewFlagIds: ['first'] });
  const second = row('A6', first.action, { evidenceIds: ['T0200'], reviewFlagIds: ['second'] });
  const p = proposal([change('modify', 'modify', second, { ...second, action: 'Provide full command details.' }, 1)]);
  assert.equal(I.findActionOccurrenceIndex([second, first], second), 0);
  assert.equal(I.findActionOccurrenceIndex([first], second), -1);
  assert.deepEqual(V.applyProposal([first], p, ['modify']), [first]);
  const out = V.applyProposal([second, first], p, ['modify']);
  assert.equal(out[0].action, 'Provide full command details.');
  assert.equal(out[1], first);
  assert.equal(I.findActionOccurrenceIndex([first, structuredClone(first)], structuredClone(first)), -1);
  const staleOccurrence = { ...second, occurrenceId: 'missing' };
  assert.equal(I.findActionOccurrenceIndex([first, second], staleOccurrence), -1);
});

test('partial proposal additions reserve active and removed IDs and repeat acceptance is idempotent', () => {
  const existing = row('A4', 'Send the inspection report.', { occurrenceId: 'existing' });
  const removed = row('A6', 'Archive the inspection report.', { occurrenceId: 'removed' });
  const first = row('A4', 'Review the safety report.');
  const second = row('A6', 'Prepare the safety report.');
  const p = proposal([change('add-one', 'add', null, first, 1), change('add-two', 'add', null, second, 1)]);
  const once = V.applyProposal([existing], p, ['add-one'], { reservedActions: [removed] });
  assert.equal(once.length, 2);
  assert.equal(once[0], existing);
  assert.notEqual(once[1].id, existing.id);
  assert.deepEqual(withoutIdentity(once[1]), withoutIdentity(first));
  const repeated = V.applyProposal(once, p, ['add-one'], { reservedActions: [removed] });
  assert.deepEqual(repeated, once);
  const both = V.applyProposal(once, p, ['add-two'], { reservedActions: [removed] });
  assert.equal(both.length, 3);
  assert.equal(new Set(both.map(r => r.id)).size, 3);
  assert.ok(both.every(r => r.id !== removed.id));
  assert.equal(new Set(both.map(r => r.occurrenceId)).size, 3);
});

test('a copied occurrence on a distinct addition is reminted instead of silently dropping the work', () => {
  const existing = row('A4', 'Send the inspection report.', { occurrenceId: 'shared' });
  const addition = { ...existing, evidenceIds: ['T0020'], reviewFlagIds: ['different'], timingDecision: { status: 'unresolved' } };
  const p = proposal([change('add', 'add', null, addition, 1)]);
  const out = V.applyProposal([existing], p, ['add']);
  assert.equal(out.length, 2);
  assert.equal(out[0], existing);
  assert.notEqual(out[1].id, existing.id);
  assert.notEqual(out[1].occurrenceId, existing.occurrenceId);
  assert.deepEqual(withoutIdentity(out[1]), withoutIdentity(addition));
  assert.deepEqual(V.applyProposal(out, p, ['add']), out, 'reminted additions are stable on repeat acceptance');
});

test('captured identical legacy targets cannot consume a remaining indistinguishable sibling', () => {
  const first = row('A4', 'Send the inspection report.');
  const copy = structuredClone(first);
  const p = JSON.parse(JSON.stringify(proposal([
    change('modify', 'modify', first, { ...first, action: 'Send the final report.' }, 0),
    change('remove', 'remove', copy, null, 1)
  ])));
  assert.deepEqual(V.applyProposal([first], p, ['modify', 'remove']), [first]);
});

test('a newly restored generated row cannot reuse the ID of another admitted occurrence', () => {
  const first = row('A6', 'Provide command details.');
  const admitted = I.assignGeneratedActionIdentities([first]).actions;
  const restored = row('A6', 'Provide additional command letters.', { evidenceIds: ['T0020'], timingDecision: { status: 'unresolved' } });
  const out = I.assignGeneratedActionIdentities([...admitted, restored], { existingActions: admitted }).actions;
  assert.deepEqual(out[0], admitted[0]);
  assert.notEqual(out[1].id, admitted[0].id);
  assert.deepEqual(withoutIdentity(out[1]), withoutIdentity(restored));
});
