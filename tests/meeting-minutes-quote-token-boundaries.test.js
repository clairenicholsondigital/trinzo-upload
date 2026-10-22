'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../utils/meetingMinutesAgentV2');

// Generic invented phrases: a quotation must cover complete normalized tokens,
// rather than a substring that changes a word, person, quantity or contraction.
const partialQuotes = [
  ['We have sent the plan', 'We have sent the planning assumptions.'],
  ['The volume is 60', 'The volume is 600 ml.'],
  ['The file was sent to Ann', 'The file was sent to Anna.'],
  ['port was delivered today', 'The report was delivered today.'],
  ['23 samples were checked', '123 samples were checked.'],
  ['Ann received the file', 'JoAnn received the file.'],
  ['The staff can', "The staff can't attend."],
  ["They will send the client", "They will send the client's copy."],
  ['The visit starts on 2026-10-2', 'The visit starts on 2026-10-22.'],
  ['Chair: The visit starts at 10:30', 'Chair: The visit starts at 10:300.'],
  ['Brien received the file', "O'Brien received the file."]
];

for (const [quote, passage] of partialQuotes) {
  test(`reject a partial token in ${JSON.stringify(quote)}`, () => {
    for (const options of [{}, { allowClockPrefix: true }]) {
      const checked = V.decisionQuoteValidation(quote, passage, 120, options);
      assert.equal(checked.valid, false, `${JSON.stringify(options)}: ${JSON.stringify(checked)}`);
      assert.equal(checked.reason, 'quote_not_found');
    }
  });
}

test('a later complete occurrence succeeds after earlier partial occurrences', () => {
  const cases = [
    ['We have sent the plan', 'We have sent the planning assumptions. We have sent the plan.'],
    ['Ann received the file', 'JoAnn received the file. Ann received the file.'],
    ['The volume is 60', 'The volume is 600 ml. The volume is 60 ml.']
  ];
  for (const [quote, passage] of cases) {
    assert.equal(V.decisionQuoteValidation(quote, passage).valid, true, quote);
  }
});

test('complete quotations retain existing case, punctuation, spacing and speaker handling', () => {
  const cases = [
    ['We have sent the plan', 'Sam: We have sent the plan.'],
    ['We have sent the plan', "Sam: 'We have sent the plan.'"],
    ["'We have sent the plan.'", "Sam: 'We have sent the plan.'"],
    ['We have sent the plan', "Sam: Before leaving, 'We have sent the plan' was the update."],
    ['The assigned workers', "Sam: The assigned workers' report is ready."],
    ["O'Brien received the file", "Sam: O’Brien received the file."],
    ["The assigned workers' report is ready", "Sam: The assigned workers' report is ready."],
    ['“We have sent the plan.”', '[T0001] Sam: WE HAVE SENT THE PLAN!'],
    ['We have sent the plan', 'Sam: We have sent\nChair: the plan.'],
    ['Sam: We have sent the plan', 'Sam: Background first; we have sent the plan, then the appendix.'],
    ["We can't attend today", 'Sam: We can’t attend today.'],
    ["They will send the client's copy", 'Sam: They will send the client’s copy.'],
    ['The visit starts on 2026-10-22', 'Sam: The visit starts on 2026-10-22.']
  ];
  for (const [quote, passage] of cases) {
    assert.equal(V.decisionQuoteValidation(quote, passage).valid, true, quote);
  }
});

test('boundary checks do not relax non-contiguous, substituted or out-of-packet quotes', () => {
  for (const [quote, passage] of [
    ['We have sent the plan', 'We have reviewed and sent the plan.'],
    ['We have sent the plan', 'We have sent the report.'],
    ['Ann received the file', 'Sam: Jo received the file.'],
    ['The file is ready now', 'Sam: The file was discussed.']
  ]) {
    assert.equal(V.decisionQuoteValidation(quote, passage).valid, false, quote);
  }
  assert.equal(V.decisionQuoteValidation('sent the', 'We have sent the plan.').reason, 'quote_too_short');
  assert.equal(V.decisionQuoteValidation('We have sent the plan', 'We have sent the plan.', 4).reason, 'quote_too_long');
});

test('clock opt-in retains its literal-source provenance and unchanged minimum-word safeguards', () => {
  const quote = 'Starts at 10:30';
  const checked = V.decisionQuoteValidation(quote, `Chair: ${quote}`, 25, { allowClockPrefix: true });
  assert.equal(checked.valid, true);
  assert.equal(checked.requiresLiteralSource, true, 'the legacy clock interpretation is still insufficient evidence');
  assert.equal(V.decisionQuoteValidation(quote, `Chair: ${quote}`, 25).reason, 'quote_too_short');
  for (const short of ['10:30', '10:30:15', '10:30 UTC+01:00', 'At 10:30']) {
    assert.equal(V.decisionQuoteValidation(short, short, 25, { allowClockPrefix: true }).reason, 'quote_too_short');
  }
  assert.equal(V.decisionQuoteValidation('Morgan: The visit starts at 10:30 UTC+01:00.',
    '[T0001] Morgan: The visit starts at 10:30 UTC+01:00.', 25, { allowClockPrefix: true }).valid, true);
});

function lifecycleResult(quote, passage) {
  const actions = [{ id: 'a1', action: 'Send the plan.', owners: ['Morgan'], evidenceIds: ['T0001'] }];
  const units = [{ id: 'T0001', speaker: 'Morgan', text: passage }];
  const before = structuredClone({ actions, units });
  const items = V.finalActionLifecycleCheckItems(actions, units);
  const checked = V.applyFinalActionLifecycleResults(actions, items,
    [{ id: items[0].id, verdict: 'not_outstanding', evidenceQuote: quote }]);
  assert.deepEqual({ actions, units }, before);
  return { actions, checked };
}

test('malformed completion quotes cannot withhold an action at the final lifecycle gate', () => {
  for (const [quote, passage] of partialQuotes.slice(0, 3)) {
    const { actions, checked } = lifecycleResult(quote, passage);
    assert.deepEqual(checked.actions, actions, quote);
    assert.deepEqual(checked.withheld, [], quote);
    assert.deepEqual(checked.rejected.map(row => row.reason), ['quote_not_found'], quote);
  }
  const { checked } = lifecycleResult('We have sent the plan', 'We have sent the plan.');
  assert.equal(checked.actions.length, 0, 'a genuinely quoted completed action still leaves the outstanding list');
  assert.equal(checked.withheld.length, 1);
});

test('the in-meeting completion gate also keeps work when the quote only matches a word prefix', () => {
  const actions = [{ action: 'Explain the plan.' }];
  const items = [{ id: 'c1', index: 0, passage: 'Morgan: We have explained the planning assumptions.' }];
  const invalid = V.applyCompletedInMeetingCheckResults(actions, items,
    [{ id: 'c1', verdict: 'completed', completionQuote: 'We have explained the plan' }]);
  assert.deepEqual(invalid.actions, actions);
  assert.deepEqual(invalid.rejected.map(row => row.reason), ['quote_not_found']);
  const valid = V.applyCompletedInMeetingCheckResults(actions, items,
    [{ id: 'c1', verdict: 'completed', completionQuote: 'We have explained the planning assumptions' }]);
  assert.equal(valid.actions.length, 0);
  assert.equal(valid.completed.length, 1);
});

test('the decision label requires a complete source quotation', () => {
  const record = { id: 'd1', text: 'The planning assumptions were approved.', evidenceIds: ['T0001'] };
  const discussion = [{ topic: 'Planning', points: [], decisions: [record], openQuestions: [] }];
  const items = V.decisionCheckItems(discussion,
    [{ id: 'T0001', speaker: 'Chair', text: 'We agreed the planning assumptions.' }]);
  const invalid = V.applyDecisionCheckResults(discussion, items,
    [{ id: items[0].id, verdict: 'decision', decisionQuote: 'We agreed the plan' }]);
  assert.equal(invalid.demoted, 1);
  assert.deepEqual(invalid.discussion[0].points, [record]);
  const valid = V.applyDecisionCheckResults(discussion, items,
    [{ id: items[0].id, verdict: 'decision', decisionQuote: 'We agreed the planning assumptions' }]);
  assert.equal(valid.demoted, 0);
  assert.deepEqual(valid.discussion[0].decisions, [record]);
});

test('discussion fidelity rejects partial problem and evidence quotes without rewriting the row', () => {
  const discussion = [{ id: 'topic', topic: 'Planning', points: [{ id: 'p1',
    text: 'We have sent the planning assumptions.', evidenceIds: ['T0001'], supportingDetails: [] }],
    decisions: [], openQuestions: [] }];
  const units = [{ id: 'T0001', speaker: 'Morgan', text: 'We have reviewed the planning assumptions.' }];
  const items = V.discussionFidelityCheckItems(discussion, units);
  for (const [problemQuote, evidenceQuote, expected] of [
    ['We have sent the plan', units[0].text, 'problem_quote_not_found'],
    [discussion[0].points[0].text, 'We have reviewed the plan', 'evidence_quote_not_found']
  ]) {
    const checked = V.applyDiscussionFidelityResults(discussion, items, [{ id: items[0].id,
      verdict: 'corrected', problemQuote, evidenceQuote, correctedText: units[0].text }]);
    assert.equal(checked.accounting.items[0].status, 'rejected');
    assert.equal(checked.accounting.items[0].reason, expected);
    assert.equal(checked.discussion[0].points[0].text, discussion[0].points[0].text);
  }
  const valid = V.applyDiscussionFidelityResults(discussion, items, [{ id: items[0].id,
    verdict: 'corrected', problemQuote: discussion[0].points[0].text,
    evidenceQuote: units[0].text, correctedText: units[0].text }]);
  assert.equal(valid.accounting.items[0].status, 'corrected');
  assert.equal(valid.discussion[0].points[0].text, units[0].text);
});
