'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../utils/meetingMinutesAgentV2');
const unit = value => [{ id: 'T0001', speaker: 'Chair', text: value }];
const row = text => ({ id: 'duration', text, evidenceIds: ['T0001'], reviewFlagIds: [] });

test('spoken and hyphenated subjects retain directly bound durations across unrelated domains', () => {
  for (const [claim, source] of [
    ['After-hours maintenance is planned for two weeks.', 'After hours maintenance will continue for two weeks.'],
    ['On-premises presence is scheduled for three days.', 'We will spend three days on premises.'],
    ['In-office presence is scheduled for two weeks.', 'We expect to be in the office for two weeks.'],
    ['In-person presence is planned for four days.', 'We have four days in person.']
  ]) assert.equal(V.quantifiedClaimGroundingIssue(row(claim), unit(source)), null, claim);
});

test('anonymous presence does not erase actors, quantities, locations or additional identifying objects', () => {
  for (const [claim, source] of [
    ['On-premises presence is scheduled for four days.', 'We will spend three days on premises.'],
    ['On-premises presence is scheduled for three days.', 'We will spend three days off premises.'],
    ['Morgan on-premises presence is scheduled for three days.', 'Jordan will spend three days on premises.'],
    ['Replacement equipment on-premises presence is scheduled for three days.', 'The auditors will spend three days on premises.'],
    ['On-premises presence is scheduled for three days.', 'We have three days for report preparation and on premises work is a separate topic.']
  ]) assert.ok(V.quantifiedClaimGroundingIssue(row(claim), unit(source)), claim);
});

test('new presence equivalence does not decide negation, history or tentative availability', () => {
  for (const source of ['We will not be on premises for three days.', 'We spent three days on premises.',
    'We could spend three days on premises.', 'If approved, we will spend three days on premises.']) {
    assert.ok(V.quantifiedClaimGroundingIssue(row('On-premises presence is scheduled for three days.'), unit(source)), source);
  }
});

test('a later subject cannot donate an earlier duration with or without a comma', () => {
  for (const source of [
    'We have three days for report preparation, and on premises presence is a separate topic.',
    'We have three days for report preparation and on premises presence is a separate topic.'
  ]) assert.ok(V.quantifiedClaimGroundingIssue(row('On-premises presence is scheduled for three days.'), unit(source)), source);
  const units = [{ id: 'T0001', speaker: 'Chair', text: 'The next item is the annual fees.' },
    { id: 'T0002', speaker: 'Chair', text: 'We have not raised them in six years and the water bill alone has nearly doubled.' }];
  assert.ok(V.quantifiedClaimGroundingIssue({ text: 'Water bills have nearly doubled in six years.', evidenceIds: ['T0001', 'T0002'] }, units));
  assert.ok(V.quantifiedClaimGroundingIssue({ text: 'The storage tanks have not been increased in six years.', evidenceIds: ['T0001', 'T0002'] }, units));
  assert.equal(V.quantifiedClaimGroundingIssue({ text: 'The annual fees have not been increased in six years.', evidenceIds: ['T0001', 'T0002'] }, units), null);
});

test('publication filtering keeps the proven duration unchanged and removes mutated quantities without mutating inputs', () => {
  const good = row('On-premises presence is scheduled for three days.');
  const wrong = { ...row('On-premises presence is scheduled for four days.'), id: 'wrong' };
  const discussion = [{ id: 'topic', topic: 'Inspection logistics', points: [good, wrong], decisions: [], openQuestions: [] }];
  const before = structuredClone(discussion);
  const result = V.filterUnsupportedQuantifiedDiscussion(discussion, unit('We will spend three days on premises.'));
  assert.deepEqual(result.discussion[0].points, [{ ...good, supportingDetails: [] }]);
  assert.deepEqual(result.removed.map(item => item.id), ['wrong']);
  assert.deepEqual(discussion, before);
});
