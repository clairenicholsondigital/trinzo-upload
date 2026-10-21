'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../utils/meetingMinutesAgentV2');

const unit = (id, speaker, text) => ({ id, speaker, text });
function check(action, correctedAction, source, evidenceQuote = source.at(-1).text) {
  const item = { id: 'ac1', index: 0, action: action.action, owners: action.owners,
    passageUnits: source, passage: source.map(u => `[${u.id}] ${u.speaker}: ${u.text}`).join('\n') };
  return V.applyActionCompletenessResults([action], [item], [{ id: 'ac1', verdict: 'corrected',
    problemQuote: action.action, evidenceQuote, correctedAction }], { meetingDate: '2026-02-03' });
}
const action = (changes = {}) => ({ id: 'a', action: 'Send the induction pack to Casey for completion.', owners: ['Morgan'],
  timing: { kind: 'target', wording: 'next week', exactDate: '' }, evidenceIds: ['T0001'], reviewFlagIds: [], ...changes });

test('completeness cannot replace sending a pack with the recipient completing a form', () => {
  const input = action({ owners: ['Morgan', 'Casey'] });
  const source = [unit('T0001', 'Morgan', 'I will send the induction pack to Casey for completion next week.'),
    unit('T0002', 'Casey', 'I will complete the conduct form before receiving the induction pack.')];
  const before = structuredClone(input);
  const result = check(input, 'Complete the conduct form before receiving the induction pack.', source);
  assert.equal(result.corrected, 0);
  assert.equal(result.actions[0].action, input.action);
  assert.deepEqual(result.actions[0].owners, input.owners);
  assert.deepEqual(result.actions[0].timing, input.timing);
  assert.ok(result.rejected.some(row => row.reason === 'corrected_action_changes_original_work'));
  assert.ok(result.flags.some(flag => /not applied/i.test(flag.message)));
  assert.ok(result.actions[0].reviewFlagIds.some(id => result.flags.some(flag => flag.id === id)));
  assert.deepEqual(input, before);
});

test('completeness preserves the original deliverable and recipient direction', () => {
  const input = action({ action: 'Send the inspection report to Casey for review.' });
  for (const corrected of [
    'Send the induction guide to Casey for review and archive the inspection report.',
    'Send the inspection report to Robin for review and ask Casey for approval.',
    'Send the inspection report and ask Casey for review.'
  ]) {
    const source = [unit('T0001', 'Morgan', 'I will send the inspection report to Casey for review.'),
      unit('T0002', 'Morgan', `I will ${corrected[0].toLowerCase() + corrected.slice(1)}`)];
    const result = check(input, corrected, source);
    assert.equal(result.corrected, 0, corrected);
    assert.equal(result.actions[0].action, input.action, corrected);
    assert.ok(result.rejected.some(row => row.reason === 'corrected_action_changes_original_work'), corrected);
  }
});

test('every original compound operation must survive a completeness correction', () => {
  const input = action({ action: 'Review the inspection report and send it to Casey.', timing: { kind: 'not_stated', wording: '', exactDate: '' } });
  const corrected = 'Send the inspection report to Casey and archive it.';
  const source = [unit('T0001', 'Morgan', 'I will review the inspection report and send it to Casey.'),
    unit('T0002', 'Morgan', 'I will send the inspection report to Casey and archive it.')];
  const result = check(input, corrected, source);
  assert.equal(result.corrected, 0);
  assert.equal(result.actions[0].action, input.action);
});

test('another speaker’s real commitment cannot expand the original owner’s work', () => {
  const input = action();
  const assignments = ['will', 'can', 'could', 'should', 'needs to', 'has to', 'is going to', 'is responsible to'];
  for (const [speaker, quote] of [['Casey', 'I will archive the completed induction pack.'],
    ...assignments.map(form => ['Morgan', `Casey ${form} archive the completed induction pack.`]),
    ['Morgan', 'Casey, can you archive the completed induction pack.'],
    ['Morgan', 'Casey handles archiving of the completed induction pack.'],
    ['Morgan', 'Casey handles archiving of the completed induction pack; I will send the pack.']]) {
    const source = [unit('T0001', 'Morgan', 'I will send the induction pack to Casey for completion.'), unit('T0002', speaker, quote)];
    const result = check(input, 'Send the induction pack to Casey for completion and archive the completed induction pack.', source);
    assert.equal(result.corrected, 0, quote);
    assert.deepEqual(result.actions[0].owners, ['Morgan']);
    assert.ok(result.flags.length);
  }
});

test('a quoted same-owner outcome can enrich the retained contact workflow', () => {
  const input = action({ action: 'Call the maintenance contractor about the cooling pump.', owners: ['Jordan'], timing: { kind: 'not_stated', wording: '', exactDate: '' } });
  const source = [unit('T0001', 'Jordan', 'I will call the maintenance contractor about the cooling pump.'),
    unit('T0002', 'Jordan', 'I will arrange replacement of the cooling pump before the production trial.')];
  const corrected = 'Call the maintenance contractor and arrange replacement of the cooling pump before the production trial.';
  const result = check(input, corrected, source);
  assert.equal(result.corrected, 1);
  assert.equal(result.actions[0].action, corrected);
  assert.deepEqual(result.actions[0].owners, ['Jordan']);
});

test('a source-backed same-owner addition retains the original send recipient and work', () => {
  const input = action({ timing: { kind: 'not_stated', wording: '', exactDate: '' } });
  const source = [unit('T0001', 'Morgan', 'I will send the induction pack to Casey for completion.'),
    unit('T0002', 'Morgan', 'I will also record dispatch of the induction pack in the register.')];
  const corrected = 'Send the induction pack to Casey for completion and record dispatch of the induction pack in the register.';
  const result = check(input, corrected, source);
  assert.equal(result.corrected, 1);
  assert.equal(result.actions[0].action, corrected);
});

test('reviewer-authored actions remain outside automatic completeness rewriting', () => {
  const input = action({ reviewerAuthored: true });
  const source = [unit('T0001', 'Morgan', 'I will send the induction pack to Casey for completion.'),
    unit('T0002', 'Morgan', 'I will also record dispatch in the register.')];
  const result = check(input, 'Send the induction pack to Casey for completion and record dispatch in the register.', source);
  assert.equal(result.corrected, 0);
  assert.deepEqual(result.actions[0], input);
});
