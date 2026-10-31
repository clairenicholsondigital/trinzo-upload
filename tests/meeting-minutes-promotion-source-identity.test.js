'use strict';

// Generic identity cases for the two source-promise promotion shortcuts only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { explicitFutureDocumentationCommitment, repeatedOwnerCommitment, safeAgentProposalPromotion } = require('../utils/meetingMinutesActionPromotion');

const DOCUMENT_ACTION = 'Write down the delivery readiness risks.';
const DOCUMENT_PROMISE = "I will write down the delivery readiness risks.";
const REPEATED_ACTION = 'Prepare the delivery readiness report.';
const REPEATED_PROMISE = 'I will prepare the delivery readiness report.';
const unit = (id, speaker, text = 'The agenda is available.') => ({ id, speaker, text });
const documentation = owner => ({
  action: DOCUMENT_ACTION, owners: [owner], evidenceIds: ['T0001'],
  reviewFlagIds: ['ownership-needs-review']
});
const repeated = owners => ({
  action: REPEATED_ACTION, owners: Array.isArray(owners) ? owners : [owners],
  evidenceIds: ['T0001', 'T0005'], reviewFlagIds: []
});

function unchangedCall(fn, action, sources) {
  const before = structuredClone({ action, sources });
  const result = fn(action, sources);
  assert.deepEqual({ action, sources }, before, 'promotion must not rewrite owners, evidence or uncertainty');
  return result;
}

test('documentation shortcut cannot use a conflicting full-name speaker promise', () => {
  const action = documentation('Morgan Lee');
  const sources = [unit('T0001', 'Morgan Shaw', DOCUMENT_PROMISE), unit('T0099', 'Morgan Lee')];
  assert.equal(unchangedCall(explicitFutureDocumentationCommitment, action, sources), false);
});

test('another person promise cannot bypass proposal review flags', () => {
  const action = documentation('Morgan Lee');
  const sources = [unit('T0001', 'Morgan Shaw', DOCUMENT_PROMISE), unit('T0099', 'Morgan Lee')];
  assert.equal(unchangedCall((row, units) => safeAgentProposalPromotion(row, [], units), action, sources), false);
  assert.deepEqual(action.reviewFlagIds, ['ownership-needs-review']);
});

test('an uncited namesake makes a short documentation owner ambiguous across the whole meeting', () => {
  const sources = [unit('T0001', 'Morgan Lee', DOCUMENT_PROMISE), unit('T0099', 'Morgan Shaw')];
  assert.equal(unchangedCall(explicitFutureDocumentationCommitment, documentation('Morgan'), sources), false);
  assert.equal(unchangedCall((row, units) => safeAgentProposalPromotion(row, [], units), documentation('Morgan'), sources), false);
});

test('a short cited speaker remains ambiguous even when the requested owner is a full name', () => {
  const sources = [unit('T0001', 'Morgan', DOCUMENT_PROMISE),
    unit('T0098', 'Morgan Lee'), unit('T0099', 'Morgan Shaw')];
  assert.equal(unchangedCall(explicitFutureDocumentationCommitment, documentation('Morgan Lee'), sources), false);
});

test('a short source label cannot establish an invented full owner identity', () => {
  const sources = [unit('T0001', 'Morgan', DOCUMENT_PROMISE)];
  assert.equal(unchangedCall(explicitFutureDocumentationCommitment, documentation('Morgan Lee'), sources), false);
});

test('exact full-name documentation promises remain valid with a namesake elsewhere', () => {
  const sources = [unit('T0001', 'Morgan Lee', DOCUMENT_PROMISE), unit('T0099', 'Morgan Shaw')];
  assert.equal(unchangedCall(explicitFutureDocumentationCommitment, documentation('Morgan Lee'), sources), true);
  assert.equal(unchangedCall((row, units) => safeAgentProposalPromotion(row, [], units), documentation('Morgan Lee'), sources), false,
    'an exact source identity does not settle the separate ownership review concern');
  assert.equal(unchangedCall((row, units) => safeAgentProposalPromotion(row, [], units),
    { ...documentation('Morgan Lee'), reviewFlagIds: [] }, sources), true,
    'the supported unflagged identity remains eligible');
});

test('unique short documentation labels may use a complete identity established outside the cited turn', () => {
  const sources = [unit('T0001', 'Morgan', DOCUMENT_PROMISE), unit('T0099', 'Morgan Lee')];
  for (const owner of ['Morgan', 'Morgan Lee']) {
    assert.equal(unchangedCall(explicitFutureDocumentationCommitment, documentation(owner), sources), true, owner);
  }
});

test('documentation identity tolerates case, spacing and actual Teams surname-first forms', () => {
  for (const speaker of ['  MORGAN   Lee  ', 'Lee, Morgan', 'Lee, Morgan J']) {
    const sources = [unit('T0001', speaker, DOCUMENT_PROMISE)];
    assert.equal(unchangedCall(explicitFutureDocumentationCommitment, documentation('  Morgan   Lee  '), sources), true, speaker);
  }
});

test('separately established full and initialled source names make a short label ambiguous', () => {
  const sources = [unit('T0001', 'Morgan', DOCUMENT_PROMISE),
    unit('T0098', 'Lee, Morgan J'), unit('T0099', 'Morgan Lee')];
  assert.equal(unchangedCall(explicitFutureDocumentationCommitment, documentation('Morgan'), sources), false);
});

test('an initialled Teams speaker cannot supply a separately established full-name owner promise', () => {
  const sources = [unit('T0001', 'Lee, Morgan J', DOCUMENT_PROMISE), unit('T0099', 'Morgan Lee')];
  assert.equal(unchangedCall(explicitFutureDocumentationCommitment, documentation('Morgan Lee'), sources), false);
  assert.equal(unchangedCall((row, units) => safeAgentProposalPromotion(row, [], units), documentation('Morgan Lee'), sources), false);
  assert.equal(unchangedCall(explicitFutureDocumentationCommitment, documentation('Morgan J Lee'), sources), true,
    'the exact initialled owner still matches their own Teams speaker label');
});

test('an initialled Teams promise cannot be pooled with a different established full source identity', () => {
  const sources = [unit('T0001', 'Morgan Lee', REPEATED_PROMISE),
    unit('T0005', 'Lee, Morgan J', REPEATED_PROMISE)];
  for (const owners of ['Morgan Lee', ['Morgan Lee', 'Morgan J Lee']]) {
    assert.equal(unchangedCall(repeatedOwnerCommitment, repeated(owners), sources), false);
  }
});

test('malformed comma labels do not create short-name speaker aliases', () => {
  for (const speaker of [', Morgan', 'Morgan,']) {
    const sources = [unit('T0001', speaker, DOCUMENT_PROMISE), unit('T0099', 'Morgan Lee')];
    assert.equal(unchangedCall(explicitFutureDocumentationCommitment, documentation('Morgan Lee'), sources), false, speaker);
  }
});

test('different Teams middle initials do not prove one short speaker identity', () => {
  const sources = [unit('T0001', 'Morgan', DOCUMENT_PROMISE),
    unit('T0098', 'Lee, Morgan J'), unit('T0099', 'Lee, Morgan K')];
  assert.equal(unchangedCall(explicitFutureDocumentationCommitment, documentation('Morgan'), sources), false);
});

test('two different full-name speakers cannot supply a repeated-owner promise together', () => {
  const sources = [unit('T0001', 'Morgan Lee', REPEATED_PROMISE),
    unit('T0005', 'Morgan Shaw', REPEATED_PROMISE)];
  assert.equal(unchangedCall(repeatedOwnerCommitment, repeated('Morgan Lee'), sources), false);
  assert.equal(unchangedCall((row, units) => safeAgentProposalPromotion(row, [], units), repeated('Morgan Lee'), sources), false);
});

test('listing both owners does not combine one promise from each into a same-person recap', () => {
  const sources = [unit('T0001', 'Morgan Lee', REPEATED_PROMISE),
    unit('T0005', 'Morgan Shaw', REPEATED_PROMISE)];
  assert.equal(unchangedCall(repeatedOwnerCommitment, repeated(['Morgan Lee', 'Morgan Shaw']), sources), false);
});

test('repeated promises by a short owner remain ambiguous when another full namesake is uncited', () => {
  const sources = [unit('T0001', 'Morgan Lee', REPEATED_PROMISE),
    unit('T0005', 'Morgan Lee', REPEATED_PROMISE), unit('T0099', 'Morgan Shaw')];
  assert.equal(unchangedCall(repeatedOwnerCommitment, repeated('Morgan'), sources), false);
});

test('ambiguous short speaker recaps cannot establish a particular full-name owner', () => {
  const sources = [unit('T0001', 'Morgan', REPEATED_PROMISE),
    unit('T0005', 'Morgan', REPEATED_PROMISE), unit('T0098', 'Morgan Lee'), unit('T0099', 'Morgan Shaw')];
  assert.equal(unchangedCall(repeatedOwnerCommitment, repeated('Morgan Lee'), sources), false);
});

test('the same exact full-name owner may repeat a promise despite a namesake elsewhere', () => {
  const sources = [unit('T0001', 'Morgan Lee', REPEATED_PROMISE),
    unit('T0005', 'Morgan Lee', REPEATED_PROMISE), unit('T0099', 'Morgan Shaw')];
  assert.equal(unchangedCall(repeatedOwnerCommitment, repeated('Morgan Lee'), sources), true);
  assert.equal(unchangedCall((row, units) => safeAgentProposalPromotion(row, [], units), repeated('Morgan Lee'), sources), true);
});

test('a uniquely resolved person can repeat promises across full, short and Teams labels', () => {
  for (const speakers of [['Morgan Lee', 'Morgan'], ['Lee, Morgan', 'Morgan Lee'],
    ['  MORGAN   Lee ', 'morgan lee']]) {
    const sources = [unit('T0001', speakers[0], REPEATED_PROMISE),
      unit('T0005', speakers[1], REPEATED_PROMISE)];
    assert.equal(unchangedCall(repeatedOwnerCommitment, repeated('Morgan Lee'), sources), true, speakers.join(' / '));
  }
});

test('single-name meetings keep exact short-label promises without inventing a surname', () => {
  const sources = [unit('T0001', 'Morgan', REPEATED_PROMISE), unit('T0005', 'Morgan', REPEATED_PROMISE)];
  assert.equal(unchangedCall(repeatedOwnerCommitment, repeated('Morgan'), sources), true);
  assert.equal(unchangedCall(repeatedOwnerCommitment, repeated('Morgan Lee'), sources), false);
});

test('identity proof does not remove existing commitment, citation or recap-separation requirements', () => {
  const good = [unit('T0001', 'Morgan Lee', REPEATED_PROMISE), unit('T0005', 'Morgan Lee', REPEATED_PROMISE)];
  assert.equal(repeatedOwnerCommitment({ ...repeated('Morgan Lee'), evidenceIds: ['T0001'] }, good), false);
  assert.equal(repeatedOwnerCommitment(repeated('Morgan Lee'), [good[0],
    unit('T0005', 'Morgan Lee', 'The delivery readiness report was prepared last week.')]), false);
  assert.equal(repeatedOwnerCommitment(repeated('Morgan Lee'), [good[0],
    unit('T0005', 'Morgan Lee', 'I will reserve the training venue.')]), false);
  assert.equal(repeatedOwnerCommitment({ ...repeated('Morgan Lee'), evidenceIds: ['T0001', 'T0002'] },
    [good[0], unit('T0002', 'Morgan Lee', REPEATED_PROMISE)]), false);
  assert.equal(explicitFutureDocumentationCommitment(documentation('Morgan Lee'),
    [unit('T0001', 'Morgan Lee', 'The delivery readiness risks were documented last week.')]), false);
});
