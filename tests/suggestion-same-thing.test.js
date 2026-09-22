'use strict';

// Generic cases only: none of these sentences come from the evaluation corpus.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  removePublishedActionProposalDuplicates, publishedActionNamesSameThing, isPersonalErrandAction, foldUnownedNearCopies
} = require('../routes/api').stagedEvaluation;

const row = (action, owners = [], evidenceIds = ['T0010']) => ({ id: action.slice(0, 12), action, owners, evidenceIds, timing: { kind: 'not_stated' } });
const add = (after) => ({ id: `change-${after.id}`, type: 'add', before: null, after });

test('a suggestion naming the same specific thing as a published action is dropped', () => {
  const published = [row('Introduce a batch-coding process so stock can be traced by batch code.', [])];
  const proposal = { changes: [add(row('Set up a system to introduce batch coding and trace stock on the carton.', [], ['T0200']))] };
  assert.equal(removePublishedActionProposalDuplicates(proposal, published).changes.length, 0);
});

test('same thing but different owners, or unrelated work, is kept', () => {
  assert.ok(!publishedActionNamesSameThing(
    row('Send the insurance renewal quote to Dana and Lee.', ['Robin']),
    row('Review the insurance renewal quote with the broker before paying.', ['Dana'])));
  assert.ok(!publishedActionNamesSameThing(
    row('Book the venue for the next week of training.', []),
    row('Send the agenda for the next week of training.', [])));
});

test('personal errands are never offered as suggestions', () => {
  assert.ok(isPersonalErrandAction('Book a holiday.'));
  assert.ok(isPersonalErrandAction('Sort out a dentist appointment.'));
  assert.ok(!isPersonalErrandAction('Book the meeting room for the audit.'));
  const proposal = { changes: [add(row('Book a holiday.', ['Sam']))] };
  assert.equal(removePublishedActionProposalDuplicates(proposal, []).changes.length, 0);
});

test('an unowned copy with a different verb folds into the owned action', () => {
  const owned = row('Prepare the risk register summary for the board.', ['Sam']);
  const loose = row('Draft a short risk register summary for the board pack.', []);
  const kept = foldUnownedNearCopies([owned, loose], 'test');
  assert.equal(kept.length, 1);
  assert.equal(kept[0].owners[0], 'Sam');
});

test('two sides of one check-in become one action with both participants', () => {
  const { dedupeHybridActionRecords } = require('../routes/api').stagedEvaluation;
  const rows = dedupeHybridActionRecords([
    { id: 'a', action: 'Catch up with Morgan Lee about the audit findings.', owners: ['Alex Kent'], evidenceIds: ['T0020'], timing: { kind: 'not_stated' } },
    { id: 'b', action: 'Check in with Alex Kent next week on the findings.', owners: ['Morgan Lee'], evidenceIds: ['T0029'], timing: { kind: 'not_stated' } }
  ]);
  assert.equal(rows.length, 1);
  assert.deepEqual([...rows[0].owners].sort(), ['Alex Kent', 'Morgan Lee']);
});

test('a quantified supporting detail reaches the minutes unless its figures are already visible', () => {
  const { promoteNamedFactDetails } = require('../utils/meetingMinutesAgentV2');
  const discussion = [{
    topic: 'Test results',
    points: [{
      id: 'p1', text: 'The alarm timing test still fails intermittently.', evidenceIds: ['T0001'],
      supportingDetails: [
        { id: 'd1', text: 'The alarm fired late on 7 of 40 runs, against a 2 second limit.', evidenceIds: ['T0002'] },
        { id: 'd2', text: 'Coverage is steady at the level reported last time.', evidenceIds: ['T0003'] }
      ]
    }, { id: 'p2', text: 'Stock stands at 120 units.', evidenceIds: ['T0004'], supportingDetails: [
      { id: 'd3', text: 'Stock stands at about 120 units in the warehouse.', evidenceIds: ['T0005'] }
    ] }],
    decisions: [], openQuestions: []
  }];
  const result = promoteNamedFactDetails(discussion, [], []);
  const texts = result.discussion[0].points.map((point) => point.text);
  assert.ok(texts.some((value) => /7 of 40 runs/.test(value)));
  assert.ok(!texts.some((value) => /steady at the level/.test(value)));
  assert.ok(!texts.some((value) => /in the warehouse/.test(value)));
});

test('an unowned row folds into an owned action that says the same thing differently', () => {
  const { foldUnownedNearCopies } = require('../routes/api').stagedEvaluation;
  const owned = { id: 'a', action: 'Arrange secure external file-share access for the visiting auditor during the audit.', owners: ['Sam Carter'], evidenceIds: ['T0010'], timing: { kind: 'not_stated' } };
  const loose = { id: 'b', action: 'Figure out a way to provide the visiting auditor with access to the necessary documents, or share them securely.', owners: [], evidenceIds: ['T0031'], timing: { kind: 'not_stated' } };
  const kept = foldUnownedNearCopies([owned, loose], 'test');
  assert.equal(kept.length, 1);
  assert.equal(kept[0].id, 'a');
  // Unrelated unowned work is left alone.
  const other = { id: 'c', action: 'Book the meeting room for the closing session.', owners: [], evidenceIds: ['T0040'], timing: { kind: 'not_stated' } };
  assert.equal(foldUnownedNearCopies([{ ...owned, evidenceIds: ['T0010'] }, other], 'test').length, 2);
});
