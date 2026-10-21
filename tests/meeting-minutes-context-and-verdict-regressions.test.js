'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../utils/meetingMinutesAgentV2');

function units(rows) {
  return V.normaliseSourceUnits(rows.map(([speaker, text]) => ({ speaker, text })));
}
function topic(row, extra = {}) {
  return [{ id: 'topic-a', topic: 'Planning', points: [row], decisions: [], openQuestions: [], ...extra }];
}

test('a supplied owner timing answer survives a stronger distant noun recap', () => {
  const source = units([
    ['Chair', 'The valve snapped at the north trough.'],
    ['Morgan', 'I can check it.'],
    ['Morgan', 'Just a replacement unit; the supplier says about nine pounds.'],
    ['Morgan', "I'll fit a new unit."],
    ['Chair', 'When?'],
    ['Morgan', "I'll do it this weekend, probably Saturday morning, before it gets busy."],
    ...Array.from({ length: 12 }, () => ['Chair', 'The next item is attendance.']),
    ['Chair', 'Replace the broken valve at the north trough.']
  ]);
  const result = V.normaliseAgentResult({ actions: [{
    action: 'Replace the broken valve at the north trough.', owners: ['Morgan'],
    timing: { kind: 'target', wording: 'Saturday morning', exactDate: '' },
    evidenceIds: ['T0002', 'T0003', 'T0004', 'T0006']
  }] }, source, 'actions');
  assert.equal(result.actions.length, 1);
  assert.ok(result.actions[0].evidenceIds.includes('T0004'), 'retain the actual commitment');
  assert.ok(result.actions[0].evidenceIds.includes('T0006'), 'retain its owner’s timing answer');
  assert.match(result.actions[0].timing.wording, /Saturday morning/i);
  assert.deepEqual(result.actions[0].owners, ['Morgan']);
});

test('a supplied date for a different task is not retained as this action’s field anchor', () => {
  const source = units([
    ['Chair', 'The valve snapped at the north trough.'],
    ['Morgan', "I'll replace the broken valve at the north trough."],
    ['Chair', 'Now the financial statement needs checking.'],
    ['Morgan', "I'll check the financial statement."],
    ['Chair', 'When?'],
    ['Morgan', 'Friday morning.'],
    ...Array.from({ length: 12 }, () => ['Chair', 'The next item is attendance.']),
    ['Chair', 'Replace the broken valve at the north trough.']
  ]);
  const actions = V.normaliseActions({ actions: [{ action: 'Replace the broken valve at the north trough.', owners: ['Morgan'], evidenceIds: ['T0002', 'T0006'] }] }, source);
  assert.equal(actions.length, 1);
  assert.ok(!actions[0].evidenceIds.includes('T0006'), 'a different-work answer must not acquire a valve association');
});

test('an owner’s timing continuation needs no redundant when-question', () => {
  const source = units([
    ['Chair', 'The supplier manual needs review.'],
    ['Morgan', 'I will review the supplier manual.'],
    ['Chair', 'Thank you.'],
    ['Morgan', 'Thursday morning.'],
    ...Array.from({ length: 12 }, () => ['Chair', 'The next item is attendance.']),
    ['Chair', 'Review the supplier manual.']
  ]);
  const actions = V.normaliseActions({ actions: [{ action: 'Review the supplier manual.', owners: ['Morgan'], evidenceIds: ['T0002', 'T0004'] }] }, source);
  assert.equal(actions.length, 1);
  assert.ok(actions[0].evidenceIds.includes('T0004'));
});

test('lexical remapping cannot override the absence of a claimed number', () => {
  const source = units([
    ['Chair', 'The vendors send an order to the receiving warehouse.'],
    ['Sam', 'There is a query about the correct vendor details.'],
    ['Chair', 'The receiving warehouse gets documentation from the vendors.']
  ]);
  const result = V.resolveEvidence('The vendor fee is 73 pounds for 8 registrations.', source, []);
  assert.deepEqual(result.evidenceIds, []);
});

test('the same numeric gate still finds a genuine amount and count', () => {
  const source = units([
    ['Chair', 'The vendor fee is 73 pounds for 8 registrations.'],
    ['Sam', 'That is the charge we need to check.']
  ]);
  const result = V.resolveEvidence('The vendor fee is 73 pounds for 8 registrations.', source, []);
  assert.ok(result.evidenceIds.includes('T0001'));
});

test('primary evidence metadata retains known explicit anchors only', () => {
  const source = units([['Iris', 'The laboratory is based in Cork.'], ['Iris', 'The office is separate.']]);
  const result = V.normaliseAgentResult({ discussion: [{ topic: 'Locations', points: [{
    text: 'The laboratory is based in Cork.', evidenceIds: ['T0001'], primaryEvidenceIds: ['T0001', 'T9999', 'T0001']
  }] }] }, source, 'discussion');
  assert.deepEqual(result.discussion[0].points[0].primaryEvidenceIds, ['T0001']);
});

test('fidelity includes plain lead, location and resource claims without old risk keywords', () => {
  const source = units([
    ['Iris', 'Noah is the review chair.'],
    ['Iris', 'The cartons arrive at our Cork warehouse.'],
    ['Iris', 'We have 640 euros in the account and the equipment costs thousands.']
  ]);
  const discussion = [{ topic: 'Facts', points: [
    { text: 'The review chair is Iris.', evidenceIds: ['T0001'] },
    { text: 'The cartons arrive at the Toronto warehouse.', evidenceIds: ['T0002'] },
    { text: 'Funds are insufficient for the equipment.', evidenceIds: ['T0003'] }
  ], decisions: [] }];
  const items = V.discussionFidelityCheckItems(discussion, source);
  assert.equal(items.length, 3);
  assert.match(items[2].passage, /640 euros/);
  assert.match(V.discussionFidelityCheckPrompt(items), /same constraint/);
  assert.match(V.discussionFidelityCheckPrompt(items), /do not borrow a number/i);
});

test('fidelity accounts for every generated row with bounded context and excludes reviewer-authored entries', () => {
  const source = units([['Iris', 'The laboratory is based in Cork.']]);
  const discussion = [{ topic: 'Facts', points: [
    { text: 'The laboratory is based in Cork.', evidenceIds: ['T0001'], reviewerAuthored: true },
    ...Array.from({ length: 80 }, (_, index) => ({ text: `The laboratory record is ${index}.`, evidenceIds: ['T0001'] }))
  ], decisions: [] }];
  const items = V.discussionFidelityCheckItems(discussion, source);
  assert.equal(items.length, 80, 'batching must not silently omit rows after48');
  assert.equal(new Set(items.map(item => item.id)).size, 80);
  assert.ok(items.every(item => item.passageUnits.length <= 40));
  assert.ok(items.every(item => item.row !== discussion[0].points[0].text));
  assert.equal(V.applyDiscussionFidelityResults(discussion, items, []).accounting.expected, 80);
});

test('quote-validated conversational text is withheld with recoverable original and source', () => {
  const row = { id: 'aside', text: 'Alternative activities are planned if the local club wins.', evidenceIds: ['T0001'], reviewFlagIds: [] };
  const discussion = topic(row);
  const source = units([['Noah', 'We could all go shopping instead, only joking.']]);
  const items = V.discussionFidelityCheckItems(discussion, source);
  const result = V.applyDiscussionFidelityResults(discussion, items, [{
    id: items[0].id, verdict: 'uncertain', issue: 'small_talk', problemQuote: row.text,
    evidenceQuote: 'We could all go shopping instead, only joking', reason: 'This is a joke rather than an agreed plan.'
  }]);
  assert.deepEqual(result.discussion[0].points, []);
  assert.equal(result.withheld.length, 1);
  assert.equal(result.withheld[0].record.text, row.text);
  assert.deepEqual(result.withheld[0].evidenceIds, ['T0001']);
  assert.match(result.flags[0].message, /Alternative activities are planned/);
  assert.equal(V.isUsefulReviewFlag(result.flags[0]), true, 'the review-burden filter must retain the withheld-item check');
  assert.equal(discussion[0].points[0], row, 'do not mutate the caller’s source state');
});

test('uncited small-talk verdict cannot remove a published claim', () => {
  const row = { id: 'p', text: 'Alternative activities are planned if the local club wins.', evidenceIds: ['T0001'] };
  const discussion = topic(row);
  const source = units([['Noah', 'We could all go shopping instead, only joking.']]);
  const items = V.discussionFidelityCheckItems(discussion, source);
  const result = V.applyDiscussionFidelityResults(discussion, items, [{ id: items[0].id, verdict: 'uncertain', issue: 'small_talk', problemQuote: row.text, evidenceQuote: '' }]);
  assert.equal(result.discussion[0].points.length, 1);
  assert.deepEqual(result.withheld, []);
});

test('a joking exchange still retains a source-supported operational constraint', () => {
  const row = { id: 'travel', text: 'Transport availability may be reduced during the event.', evidenceIds: ['T0001'] };
  const discussion = topic(row);
  const source = units([['Noah', 'Transport availability will be reduced during the event, so allow extra time.']]);
  const items = V.discussionFidelityCheckItems(discussion, source);
  const result = V.applyDiscussionFidelityResults(discussion, items, [{
    id: items[0].id, verdict: 'uncertain', issue: 'small_talk', problemQuote: row.text,
    evidenceQuote: 'Transport availability will be reduced during the event', reason: 'This was said in a humorous exchange.'
  }]);
  assert.equal(result.discussion[0].points[0].text, row.text);
  assert.deepEqual(result.withheld, []);
});

test('a stale critic result cannot withhold a reviewer-authored row', () => {
  const row = { id: 'locked', text: 'Alternative activities are planned if the local club wins.', evidenceIds: ['T0001'], reviewerAuthored: true };
  const discussion = topic(row);
  const items = [{ id: 'df1', topicIndex: 0, kind: 'points', rowIndex: 0, row: row.text, passage: 'Noah: We could all go shopping instead, only joking.' }];
  const result = V.applyDiscussionFidelityResults(discussion, items, [{ id: 'df1', verdict: 'uncertain', issue: 'small_talk', problemQuote: row.text, evidenceQuote: 'We could all go shopping instead, only joking' }]);
  assert.equal(result.discussion[0].points[0].text, row.text);
  assert.deepEqual(result.withheld, []);
});

test('ownership correction preserves a reviewer-authored assignment unchanged', () => {
  const source = units([
    ['Priya Shah', 'I will review the supplier questionnaire.'],
    ['Morgan Lee', 'Thank you.']
  ]);
  const manual = { id: 'manual-action', action: 'Review the supplier questionnaire.', owners: ['Morgan Lee'],
    reviewerAuthored: true, evidenceIds: ['T0001'], reviewFlagIds: [] };
  const before = structuredClone(manual);
  const result = V.applyRequesterOwnerRule([manual], source);
  assert.equal(result.actions[0], manual, 'retain the reviewer’s full record');
  assert.deepEqual(result.actions[0], before);
  assert.deepEqual(result.flags, []);
});

test('the same owner misassignment is still corrected on generated work', () => {
  const source = units([
    ['Priya Shah', 'I will review the supplier questionnaire.'],
    ['Morgan Lee', 'Thank you.']
  ]);
  const generated = { id: 'generated-action', action: 'Review the supplier questionnaire.', owners: ['Morgan Lee'],
    evidenceIds: ['T0001'], reviewFlagIds: [] };
  const result = V.applyRequesterOwnerRule([generated], source);
  assert.deepEqual(result.actions[0].owners, []);
  assert.equal(result.flags[0].kind, 'ownership');
  assert.match(result.flags[0].message, /Priya Shah/);
  assert.deepEqual(generated.owners, ['Morgan Lee'], 'do not mutate the source record');
});

test('withholding a generated parent cannot discard a reviewer-authored supporting detail', () => {
  const manual = { id: 'manual-note', text: 'The reviewer requested a separate follow-up.', evidenceIds: ['T0002'], reviewerAuthored: true };
  const row = { id: 'parent', text: 'Alternative activities are planned if the local club wins.', evidenceIds: ['T0001'], supportingDetails: [manual] };
  const discussion = topic(row);
  const source = units([['Noah', 'We could all go shopping instead, only joking.'], ['Noah', 'A separate follow-up is needed.']]);
  const items = V.discussionFidelityCheckItems(discussion, source);
  const result = V.applyDiscussionFidelityResults(discussion, items, [{
    id: items[0].id, verdict: 'uncertain', issue: 'small_talk', problemQuote: row.text,
    evidenceQuote: source[0].text, reason: 'The parent sentence is joking.'
  }]);
  assert.equal(result.discussion[0].points[0].supportingDetails[0], manual);
  assert.deepEqual(result.withheld, []);
  assert.equal(result.flags.length, 1);
});

test('an unrelated operational cost in the passage cannot protect a joking alternative plan', () => {
  const row = { id: 'aside', text: 'Transport costs mean the committee will spend the afternoon sightseeing instead.', evidenceIds: ['T0001', 'T0002'] };
  const discussion = topic(row);
  const source = units([
    ['Noah', 'The equipment delivery has high transport costs.'],
    ['Iris', 'We could spend the afternoon sightseeing instead, only joking.']
  ]);
  const items = V.discussionFidelityCheckItems(discussion, source);
  const result = V.applyDiscussionFidelityResults(discussion, items, [{
    id: items[0].id, verdict: 'uncertain', issue: 'small_talk', problemQuote: row.text,
    evidenceQuote: source[1].text, reason: 'The claimed alternative activity is a joke, not an agreed plan.'
  }]);
  assert.deepEqual(result.discussion[0].points, []);
  assert.equal(result.withheld.length, 1);
});

test('a quoted correction can retain the real constraint while removing mixed banter', () => {
  const row = { id: 'mixed', text: 'Transport availability is reduced so the team will go shopping instead.', evidenceIds: ['T0001', 'T0002'] };
  const discussion = topic(row);
  const source = units([
    ['Noah', 'Transport availability is reduced during the event.'],
    ['Iris', 'We could all go shopping instead, only joking.']
  ]);
  const items = V.discussionFidelityCheckItems(discussion, source);
  const result = V.applyDiscussionFidelityResults(discussion, items, [{
    id: items[0].id, verdict: 'corrected', issue: 'small_talk', problemQuote: row.text,
    evidenceQuote: source[0].text, correctedText: source[0].text
  }]);
  assert.equal(result.discussion[0].points[0].text, source[0].text);
  assert.deepEqual(result.withheld, []);
  assert.match(V.discussionFidelityCheckPrompt(items), /retains the real constraint and removes the joke/);
});

for (const [text, evidence] of [
  ['Iris is the review chair.', 'Noah is the review chair.'],
  ['The cartons arrive at the Toronto warehouse.', 'The cartons arrive at our Cork warehouse.']
]) {
  test(`a validated unsupported assertion is withheld: ${text}`, () => {
    const row = { id: 'factual', text, evidenceIds: ['T0001'] };
    const discussion = topic(row);
    const source = units([['Noah', evidence]]);
    const items = V.discussionFidelityCheckItems(discussion, source);
    const result = V.applyDiscussionFidelityResults(discussion, items, [{
      id: items[0].id, verdict: 'uncertain', issue: 'added_detail', problemQuote: text,
      evidenceQuote: '', reason: 'The asserted role or location is not established by the passage.'
    }]);
    assert.deepEqual(result.discussion[0].points, []);
    assert.equal(result.withheld[0].record.text, text);
    assert.match(result.flags[0].message, /source review/i);
    assert.equal(V.isUsefulReviewFlag(result.flags[0]), true);
  });
}

test('explicit unresolved wording remains visible with its review flag', () => {
  const row = { id: 'cautious', text: 'The destination could be Toronto but is not confirmed.', evidenceIds: ['T0001'] };
  const discussion = topic(row);
  const source = units([['Noah', 'We still need to confirm the destination.']]);
  const items = V.discussionFidelityCheckItems(discussion, source);
  const result = V.applyDiscussionFidelityResults(discussion, items, [{ id: items[0].id, verdict: 'uncertain', issue: 'added_detail', problemQuote: row.text, evidenceQuote: '' }]);
  assert.equal(result.discussion[0].points[0].text, row.text);
  assert.deepEqual(result.withheld, []);
  assert.equal(result.flags.length, 1);
});

test('a source-quoted factual replacement is published instead of withheld', () => {
  const row = { id: 'chair', text: 'Iris is the review chair.', evidenceIds: ['T0001'] };
  const discussion = topic(row);
  const source = units([['Noah', 'Noah is the review chair.']]);
  const items = V.discussionFidelityCheckItems(discussion, source);
  const result = V.applyDiscussionFidelityResults(discussion, items, [{
    id: items[0].id, verdict: 'corrected', issue: 'added_detail', problemQuote: row.text,
    evidenceQuote: source[0].text, correctedText: source[0].text
  }]);
  assert.equal(result.discussion[0].points[0].text, source[0].text);
  assert.equal(result.corrected, 1);
  assert.deepEqual(result.withheld, []);
});

test('habitual first-person wording does not veto a source-verified non-outstanding verdict', () => {
  const source = units([['Iris', 'Access requirements are something I will always ask about.']]);
  const actions = [{ action: 'Ask about access requirements.', owners: ['Iris'], evidenceIds: ['T0001'] }];
  const items = V.finalActionLifecycleCheckItems(actions, source);
  const result = V.applyFinalActionLifecycleResults(actions, items, [{ id: items[0].id, verdict: 'not_outstanding', evidenceQuote: source[0].text, reason: 'This describes normal practice, not a new assignment.' }]);
  assert.equal(result.actions.length, 0);
  assert.equal(result.withheld.length, 1);
  assert.deepEqual(result.rejected, []);
});

for (const wording of ["I'll always", "I'll usually", 'I’ll normally', 'I’ll generally']) {
  test(`contracted habitual wording is not a new promise: ${wording}`, () => {
    const source = units([['Iris', `Access requirements are something ${wording} ask about.`]]);
    const actions = [{ action: 'Ask about access requirements.', owners: ['Iris'], evidenceIds: ['T0001'] }];
    const items = V.finalActionLifecycleCheckItems(actions, source);
    const result = V.applyFinalActionLifecycleResults(actions, items, [{
      id: items[0].id, verdict: 'not_outstanding', evidenceQuote: source[0].text,
      reason: 'This describes normal practice, not a new assignment.'
    }]);
    assert.equal(result.actions.length, 0);
    assert.equal(result.withheld.length, 1);
    assert.deepEqual(result.rejected, []);
  });
}

test('a contracted habit cannot erase an explicit future commitment for the same work', () => {
  const source = units([
    ['Iris', "Access requirements are something I'll always ask about."],
    ['Iris', 'I’ll confirm the access requirements tomorrow.']
  ]);
  const actions = [{ action: 'Confirm the access requirements.', owners: ['Iris'], evidenceIds: ['T0001', 'T0002'] }];
  const items = V.finalActionLifecycleCheckItems(actions, source);
  const result = V.applyFinalActionLifecycleResults(actions, items, [{
    id: items[0].id, verdict: 'not_outstanding', evidenceQuote: source[0].text
  }]);
  assert.equal(result.actions.length, 1);
  assert.equal(result.rejected[0].reason, 'explicit_outstanding_evidence');
});

test('contracted habitual wording with a specific future time is still protected', () => {
  for (const quote of ["I'll always confirm the access requirements tomorrow.", 'I’ll usually send the visitor guide next week.']) {
    assert.equal(V.quoteIsOnlyAPromise(quote), true);
  }
});

test('habitual wording cannot erase a separate real future commitment', () => {
  const source = units([
    ['Iris', 'Access requirements are something I will always ask about.'],
    ['Iris', 'I will confirm the access requirements tomorrow.']
  ]);
  const actions = [{ action: 'Confirm the access requirements.', owners: ['Iris'], evidenceIds: ['T0001', 'T0002'] }];
  const items = V.finalActionLifecycleCheckItems(actions, source);
  const result = V.applyFinalActionLifecycleResults(actions, items, [{ id: items[0].id, verdict: 'not_outstanding', evidenceQuote: source[0].text }]);
  assert.equal(result.actions.length, 1);
  assert.equal(result.rejected[0].reason, 'explicit_outstanding_evidence');
});

test('ordinary new first-person promises remain protected against mistaken completion', () => {
  const source = units([['Iris', 'I will send the visitor guide today.']]);
  const actions = [{ action: 'Send the visitor guide.', owners: ['Iris'], evidenceIds: ['T0001'] }];
  const items = V.finalActionLifecycleCheckItems(actions, source);
  const result = V.applyFinalActionLifecycleResults(actions, items, [{ id: items[0].id, verdict: 'not_outstanding', evidenceQuote: source[0].text }]);
  assert.equal(result.actions.length, 1);
});

test('completeness includes the earlier request and later same-owner outcome', () => {
  const source = units([
    ['Chair', 'The cooling pump needs replacing before the production trial.'],
    ['Casey', 'The contractor has the right tools.'],
    ['Casey', 'I will call the maintenance contractor.'],
    ['Chair', 'Thank you.'],
    ['Casey', 'We have spare seals available.'],
    ['Casey', 'I will arrange replacement of the cooling pump before the production trial.']
  ]);
  const actions = [{ action: 'Call the maintenance contractor about the cooling pump.', owners: ['Casey'], evidenceIds: ['T0003'] }];
  const items = V.actionCompletenessCheckItems(actions, source);
  assert.equal(items.length, 1);
  assert.match(items[0].passage, /cooling pump needs replacing/);
  assert.match(items[0].passage, /arrange replacement of the cooling pump/);
  const result = V.applyActionCompletenessResults(actions, items, [{
    id: items[0].id, verdict: 'corrected', problemQuote: actions[0].action,
    evidenceQuote: source[5].text, correctedAction: 'Call the maintenance contractor and arrange replacement of the cooling pump before the production trial.'
  }]);
  assert.equal(result.corrected, 1);
});
