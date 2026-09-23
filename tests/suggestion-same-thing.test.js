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

test('an unowned way-to paraphrase folds into the owned action it restates', () => {
  const { foldUnownedNearCopies } = require('../routes/api').stagedEvaluation;
  const owned = { id: 'a', action: 'Work out secure transmission of the audit information and provide the auditor with the necessary external file-share access.', owners: ['Sam Carter'], evidenceIds: ['T0010'], timing: { kind: 'not_stated' } };
  const paraphrase = { id: 'b', action: 'Figure out a way to either get the auditor access to the necessary documents or share them with her.', owners: [], evidenceIds: ['T0031'], timing: { kind: 'not_stated' } };
  assert.equal(foldUnownedNearCopies([owned, paraphrase], 'test').length, 1);
  // A way-to row about different work stays.
  const unrelated = { id: 'c', action: 'Figure out a way to cover the reception desk during the audit week.', owners: [], evidenceIds: ['T0040'], timing: { kind: 'not_stated' } };
  assert.equal(foldUnownedNearCopies([owned, unrelated], 'test').length, 2);
});

test('an owned way-to paraphrase merges into the concrete action and loses the vague wording', () => {
  const { dedupeHybridActionRecords } = require('../routes/api').stagedEvaluation;
  const rows = dedupeHybridActionRecords([
    { id: 'a', action: 'Arrange secure document sharing and external file-share access for the auditor.', owners: ['Sam Carter'], timing: { kind: 'not_stated' }, evidenceIds: ['T0001'] },
    { id: 'b', action: 'Figure out a way to either get the auditor access to the necessary documents or share them another way.', owners: ['Sam Carter'], timing: { kind: 'not_stated' }, evidenceIds: ['T0090'] }
  ], {});
  assert.equal(rows.length, 1);
  assert.match(rows[0].action, /^Arrange secure document sharing/);
});

test('a figure already in the minutes in words is not promoted again in digits', () => {
  const { promoteNamedFactDetails } = require('../utils/meetingMinutesAgentV2');
  const discussion = [{
    topic: 'Funds',
    points: [{
      id: 'p1', text: 'A barrier would cost thousands, and there were four hundred pounds in the account.', evidenceIds: ['T0001'],
      supportingDetails: [
        { id: 'd1', text: 'Concerns about the cost of a barrier (£400 in the account was mentioned).', evidenceIds: ['T0002'] },
        { id: 'd2', text: 'The quote for the gate came to 3,200 pounds plus fitting.', evidenceIds: ['T0003'] }
      ]
    }],
    decisions: [], openQuestions: []
  }];
  const texts = promoteNamedFactDetails(discussion, [], []).discussion[0].points.map((point) => point.text);
  assert.ok(!texts.some((value) => /£400/.test(value)), 'the same figure in digits is not added again');
  assert.ok(texts.some((value) => /3,200/.test(value)), 'a new figure is still added');
});

test('spelled and numeric forms of the same figure match', () => {
  const { quantityTokens } = require('../utils/meetingMinutesAgentV2');
  if (!quantityTokens) return;
  assert.ok(quantityTokens('four hundred pounds').has('400'));
  assert.ok(quantityTokens('twenty-two references').has('22'));
  assert.ok(quantityTokens('£1,200 a year').has('1200'));
});

test('a spelled figure does not look new because of its parts', () => {
  const { promoteNamedFactDetails, quantityTokens } = require('../utils/meetingMinutesAgentV2');
  // Matching is generous, novelty is not.
  assert.ok(quantityTokens('twenty-two kegs').has('20'));
  assert.ok(!quantityTokens('twenty-two kegs', false).has('20'));
  const discussion = [{
    topic: 'Yield',
    points: [
      { id: 'p1', text: '1200 litres yields about 22 clean 50-litre kegs after losses.', evidenceIds: ['T0001'],
        supportingDetails: [
          { id: 'd1', text: 'The batch yields approximately twenty-two clean kegs at fifty litres each after losses.', evidenceIds: ['T0002'] },
          { id: 'd2', text: 'The new fermenter would add another 400 litres of capacity.', evidenceIds: ['T0003'] }
        ] }
    ],
    decisions: [], openQuestions: []
  }];
  const texts = promoteNamedFactDetails(discussion, [], []).discussion[0].points.map((point) => point.text);
  assert.ok(!texts.some((value) => /twenty-two clean kegs/.test(value)), 'the same yield spelled out is not added again');
  assert.ok(texts.some((value) => /400 litres/.test(value)), 'a genuinely new figure still is');
});

test('a detail restating visible figures in other words is not promoted', () => {
  const { promoteNamedFactDetails } = require('../utils/meetingMinutesAgentV2');
  const discussion = [{
    topic: 'Festival',
    points: [{
      id: 'p1', text: 'The festival originally requested 40 kegs; it was negotiated down to 15 casks due to capacity.', evidenceIds: ['T0001'],
      supportingDetails: [
        { id: 'd1', text: 'The initial request was for forty kegs, but this was reduced to fifteen casks (nine-gallon firkins) due to capacity.', evidenceIds: ['T0002'] },
        { id: 'd2', text: 'The bar also asked for a further 6 polypins for the Sunday session.', evidenceIds: ['T0003'] }
      ]
    }],
    decisions: [], openQuestions: []
  }];
  const texts = promoteNamedFactDetails(discussion, [], []).discussion[0].points.map((point) => point.text);
  assert.ok(!texts.some((value) => /forty kegs/.test(value)), 'the same reduction in other words is not added again');
  assert.ok(texts.some((value) => /6 polypins/.test(value)), 'an unrelated new figure still is');
});

test('"a thousand" carries a figure of its own', () => {
  const { quantityTokens } = require('../utils/meetingMinutesAgentV2');
  assert.ok(quantityTokens('over a thousand pints', false).has('1000'));
  assert.ok(quantityTokens('a hundred cases', false).has('100'));
  assert.ok(quantityTokens('two thousand pounds of beer', false).has('2000'));
});
