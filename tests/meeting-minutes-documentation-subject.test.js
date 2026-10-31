'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { explicitFutureDocumentationCommitment, safeAgentProposalPromotion, isReviewableActionProposal } = require('../utils/meetingMinutesActionPromotion');

const action = (wording = 'Write down the delivery readiness risks.', overrides = {}) => ({
  id: 'A1',
  action: wording,
  owners: ['Morgan Lee'],
  evidenceIds: ['T0001'],
  reviewFlagIds: ['subject-needs-review'],
  timing: { kind: 'not_stated', wording: '', exactDate: '' },
  ...overrides
});
const source = (text, speaker = 'Morgan Lee', id = 'T0001') => ({ id, speaker, text });

function unchangedShortcut(record, units, expected) {
  const before = structuredClone({ record, units });
  assert.equal(explicitFutureDocumentationCommitment(record, units), expected);
  assert.deepEqual({ record, units }, before, 'subject proof must preserve the candidate and its review metadata');
}

test('shared documentation verbs cannot prove a different promised subject', () => {
  for (const [wording, promise] of [
    ['Write down the delivery readiness risks.', 'I will write down the catering options.'],
    ['Document the delivery readiness risks.', 'I will document the catering options.'],
    ['Record the delivery readiness risks.', 'I will record the catering options.'],
    ['Note the delivery readiness risks.', 'I will note the catering options.']
  ]) {
    const record = action(wording);
    const units = [source(promise)];
    unchangedShortcut(record, units, false);
    assert.equal(safeAgentProposalPromotion(record, [], units), false,
      'a different subject must leave an uncertain proposal available for ordinary review');
    assert.deepEqual(record.reviewFlagIds, ['subject-needs-review']);
    assert.equal(isReviewableActionProposal(record, units), true,
      'the unpromoted documentation candidate must remain eligible for ordinary proposal review');
  }
});

test('another sentence cannot supply the object of an unrelated documentation promise', () => {
  for (const promise of [
    'The delivery readiness risks remain open. I will write down the catering options.',
    'I will write down the catering options. The delivery readiness risks were discussed earlier.',
    'I will write down the catering options; the delivery readiness risks were discussed earlier.'
  ]) {
    unchangedShortcut(action(), [source(promise)], false);
  }
});

test('a separate coordinated operation cannot supply the documented object', () => {
  for (const promise of [
    'I will write down the catering options and review the delivery readiness risks.',
    'I will write down the catering options; review the delivery readiness risks.',
    'I will write down catering options and I already discussed delivery readiness risks.'
  ]) {
    const record = action();
    const units = [source(promise)];
    unchangedShortcut(record, units, false);
    assert.equal(safeAgentProposalPromotion(record, [], units), false);
  }
});

test('a documentation promise cannot approve a separate operation added to the candidate', () => {
  const units = [source('I will note the delivery readiness risks.')];
  for (const wording of [
    'Note the delivery readiness risks and send the regional site allocation schedule.',
    'Note the delivery readiness risks then review the regional site allocation schedule.',
    'Note the delivery readiness risks and I will send the regional site allocation schedule.'
  ]) {
    const record = action(wording);
    unchangedShortcut(record, units, false);
    assert.equal(safeAgentProposalPromotion(record, [], units), false);
    assert.equal(isReviewableActionProposal(record, units), true);
  }
});

test('subject proof only narrows the previously eligible documentation shortcuts', () => {
  // Baseline eligibility was recorded against e54fa0cb before adding subject
  // proof. A shorter sentence must never replace the original whole-turn gate.
  const longTurn = 'I will note risks. Catering menus venue booking staff uniforms budget approval invoices branding slides training equipment funding manuals are separate topics.';
  for (const { wording, promise, baselineEligible, expected } of [
    {
      wording: 'Note the delivery readiness risks and send the regional site allocation schedule.',
      promise: longTurn, baselineEligible: false, expected: false
    },
    {
      wording: 'Note the delivery readiness risks and the weekly regional site allocation schedule.',
      promise: longTurn, baselineEligible: false, expected: false
    },
    {
      wording: 'Write down the delivery readiness risks.',
      promise: 'I will write down the catering options.', baselineEligible: true, expected: false
    },
    {
      wording: 'Write down the delivery readiness risks.',
      promise: 'I will write down the catering options and review the delivery readiness risks.',
      baselineEligible: true, expected: false
    },
    {
      wording: 'Write down the delivery readiness risks.',
      promise: 'I will write down the delivery readiness risks.', baselineEligible: true, expected: true
    },
    {
      wording: 'Document review findings.',
      promise: 'I will document review findings.', baselineEligible: true, expected: true
    },
    {
      wording: 'Write down test results.',
      promise: 'I will write down test results.', baselineEligible: true, expected: true
    },
    {
      wording: 'Note the delivery readiness risks.',
      promise: 'I will reserve the catering venue.', baselineEligible: false, expected: false
    },
    {
      wording: 'Write down the delivery readiness risks.',
      promise: 'The delivery readiness risks were documented last week.', baselineEligible: false, expected: false
    }
  ]) {
    const record = action(wording);
    const units = [source(promise)];
    const eligible = explicitFutureDocumentationCommitment(record, units);
    assert.equal(eligible, expected, wording);
    assert.ok(!eligible || baselineEligible, 'subject proof must not create newly eligible shortcuts');
  }
});

test('documentation subjects keep exact wording and supported paraphrases', () => {
  for (const [wording, promise] of [
    ['Write down the delivery readiness risks.', 'I will write down the delivery readiness risks.'],
    ['Record the release risk.', "I'm going to write down that the release date is at risk."],
    ['Document the supplier requirements.', 'I will record the requirements for the suppliers.'],
    ['Note the budget.', 'I will document the budget.'],
    ['Write down the parking options.', 'I will note the options for parking.'],
    ['Write down the delivery readiness risks.', 'The catering options are agreed. I will record the delivery readiness risks.'],
    ['Write down the delivery readiness risks.', 'I will write down catering options and delivery readiness risks.'],
    ['Document the review findings.', 'I will document the review findings.'],
    ['Document review findings.', 'I will document review findings.'],
    ['Write down the test results.', 'I will write down the test results.'],
    ['Write down test results.', 'I will write down test results.'],
    ['Document the review findings.', 'I will document the catering options and the review findings.']
  ]) {
    unchangedShortcut(action(wording), [source(promise)], true);
  }
});

test('subject proof retains full, unique short and Teams speaker identities', () => {
  const promise = 'I will write down the delivery readiness risks.';
  for (const [owner, speaker, extra] of [
    ['Morgan Lee', 'Morgan Lee', []],
    ['Morgan Lee', 'Morgan', [source('The agenda is available.', 'Morgan Lee', 'T0099')]],
    ['Morgan', 'Morgan Lee', []],
    ['Morgan Lee', 'Lee, Morgan', []]
  ]) {
    unchangedShortcut(action(undefined, { owners: [owner] }), [source(promise, speaker), ...extra], true);
  }
});

test('matching subjects retain the owner, cited source and future commitment boundaries', () => {
  const promise = 'I will write down the delivery readiness risks.';
  unchangedShortcut(action(), [source(promise, 'Morgan Shaw')], false);
  unchangedShortcut(action(), [source(promise, 'Morgan Lee', 'T0002')], false);
  unchangedShortcut(action(), [source('The delivery readiness risks were documented last week.')], false);
  unchangedShortcut(action(undefined, { owners: ['Morgan Lee', 'Morgan Shaw'] }), [source(promise)], false);
  unchangedShortcut(action('Write down that.'), [source('I will write down that.')], false);
});

test('an unproved shortcut preserves all ordinary-review fields', () => {
  const record = action(undefined, {
    timing: { kind: 'target', wording: 'after approval', exactDate: '' },
    evidenceIds: ['T0001', 'T0002'],
    reviewFlagIds: ['subject-needs-review', 'timing-needs-review'],
    subjectDecision: { verdict: 'uncertain', reason: 'The subject needs checking.' }
  });
  const units = [source('I will write down the catering options.'),
    source('The delivery readiness risks need review.', 'Riley Stone', 'T0002')];
  const before = structuredClone({ record, units });
  assert.equal(safeAgentProposalPromotion(record, [], units), false);
  assert.deepEqual({ record, units }, before);
});
