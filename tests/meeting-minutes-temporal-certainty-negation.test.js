'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../utils/meetingMinutesAgentV2');
const R = require('../utils/meetingMinutesTemporalReview');

// Exercise the actual synchronous review gates, without provider or draft calls.
const certain = 'The equipment inspection is scheduled for Friday.';
const qualifiedSources = [
  'The equipment inspection is tentatively scheduled for Friday.',
  'The equipment inspection has a tentative schedule for Friday.',
  'The equipment inspection is scheduled for Friday, unconfirmed.'
];
const contractions = [
  ["isn't", 'is', 'scheduled for'], ["aren't", 'are', 'scheduled for'],
  ["wasn't", 'was', 'scheduled for'], ["weren't", 'were', 'scheduled for'],
  ["hasn't", 'has', 'started by'], ["haven't", 'have', 'started by'],
  ["hadn't", 'had', 'started by'], ["don't", 'do', 'start'],
  ["doesn't", 'does', 'start'], ["didn't", 'did', 'start'],
  ["wouldn't", 'would', 'start'], ["shouldn't", 'should', 'start'],
  ["mustn't", 'must', 'start'], ["couldn't", 'could', 'start'],
  ["can't", 'can', 'start'], ["won't", 'will', 'start']
];
const reversals = contractions.flatMap(([negative, positive, predicate]) =>
  ["'", '’'].map(apostrophe => ({
    label: negative.replace("'", apostrophe),
    source: `The equipment inspection team ${negative.replace("'", apostrophe)} ${predicate} Friday.`,
    claim: `The equipment inspection team ${positive} ${predicate} Friday.`
  })));

function discussionCheck(claim, source, recordExtra = {}) {
  const units = [{ id: 'T0001', speaker: 'Chair', text: source }];
  const discussion = [{ id: 'schedule', topic: 'Inspection schedule', points: [{
    id: 'inspection', text: claim, evidenceIds: ['T0001'], reviewFlagIds: [], supportingDetails: [], ...recordExtra
  }], decisions: [], openQuestions: [] }];
  const before = structuredClone({ discussion, units });
  const items = V.discussionFidelityCheckItems(discussion, units);
  assert.equal(items.length, 1);
  const result = V.applyDiscussionFidelityResults(discussion, items, [{
    id: items[0].id, verdict: 'supported', evidenceQuote: source
  }]);
  assert.deepEqual({ discussion, units }, before, 'review must not mutate the saved input');
  return { result, units, discussion };
}

function summaryCheck(claim, source, field, options = {}, authority = 'discussion', replyOverride = {}) {
  const values = { executiveSummary: field === 'executiveSummary' ? claim : '',
    meetingObjectives: field === 'meetingObjectives' ? [{ id: 'objective', text: claim,
      ...(options.reviewerAuthored ? { reviewerAuthored: true } : {}) }] : [] };
  const current = authority === 'action'
    ? { actions: [{ id: 'inspection', action: source, owners: [], timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds: ['T0001'] }] }
    : { discussion: [{ points: [{ id: 'inspection', text: source, evidenceIds: ['T0001'] }] }] };
  const before = structuredClone({ values, current });
  const items = R.summaryTemporalCheckItems(values, current, [], options);
  assert.equal(items.length, 1, `${field}: ${claim}`);
  const result = R.applySummaryTemporalCheckResults(values, items, [{
    id: items[0].id, verdict: 'supported', evidenceQuote: source, ...replyOverride
  }]);
  assert.deepEqual({ values, current }, before, 'review must not mutate approved authority or saved text');
  return { result, values };
}

function assertDiscussionWarning(result, claim, label) {
  assert.equal(result.accounting.items[0].status, 'rejected', label);
  assert.equal(result.accounting.items[0].reason, 'temporal_source_binding_not_proved', label);
  assert.equal(result.accounting.complete, false, label);
  assert.equal(result.discussion[0].points[0].text, claim, 'unsupported wording remains reviewable rather than silently rewritten');
  const flags = result.flags.filter(flag => flag.kind === 'timing');
  assert.equal(flags.length, 1, label);
  assert.equal(flags[0].status, 'open');
  assert.deepEqual(flags[0].evidenceIds, ['T0001']);
  assert.ok(result.discussion[0].points[0].reviewFlagIds.includes(flags[0].id));
}

function assertSummaryWarning(result, values, field, label) {
  assert.equal(result.accounting.items[0].status, 'rejected', label);
  assert.equal(result.accounting.items[0].reason, 'summary_temporal_binding_not_proved', label);
  assert.equal(result.accounting.complete, false, label);
  assert.deepEqual(result.values, values, 'a false supported response cannot rewrite summary/objective text');
  assert.equal(result.flags.length, 1, label);
  assert.equal(result.flags[0].kind, 'timing');
  assert.equal(result.flags[0].temporalField, field);
  assert.deepEqual(result.flags[0].evidenceIds, ['T0001']);
}

test('discussion fidelity flags lost tentative and unconfirmed qualifications despite a supported reply', () => {
  for (const source of qualifiedSources) {
    const { result } = discussionCheck(certain, source);
    assertDiscussionWarning(result, certain, source);
  }
});

test('summary and objective gates flag lost qualifications against the approved whole record', () => {
  for (const field of ['executiveSummary', 'meetingObjectives']) for (const source of qualifiedSources) {
    const { result, values } = summaryCheck(certain, source, field);
    assertSummaryWarning(result, values, field, source);
  }
});

test('ASCII and curly negative contractions cannot be approved as affirmative discussion', () => {
  for (const { source, claim, label } of reversals) {
    const { result } = discussionCheck(claim, source);
    assertDiscussionWarning(result, claim, label);
  }
});

test('summary and objective checks retain warnings for contracted negative-to-positive reversals', () => {
  for (const field of ['executiveSummary', 'meetingObjectives']) for (const { source, claim, label } of reversals) {
    const { result, values } = summaryCheck(claim, source, field);
    assertSummaryWarning(result, values, field, label);
  }
});

test('faithful certain, qualified and contracted-negative text remains supported without new warnings', () => {
  const controls = [certain, ...qualifiedSources, ...reversals.map(row => row.source)];
  for (const text of controls) {
    const { result } = discussionCheck(text, text);
    assert.equal(result.accounting.items[0].status, 'supported', text);
    assert.equal(result.accounting.complete, true, text);
    assert.deepEqual(result.flags, [], text);
    for (const field of ['executiveSummary', 'meetingObjectives']) {
      const checked = summaryCheck(text, text, field);
      assert.equal(checked.result.accounting.items[0].status, 'supported', `${field}: ${text}`);
      assert.equal(checked.result.accounting.complete, true);
      assert.deepEqual(checked.result.values, checked.values);
      assert.deepEqual(checked.result.flags, []);
    }
  }
});

test('an approved action record also cannot authorize stripping uncertainty or negation from a summary', () => {
  for (const [claim, source] of [[certain, qualifiedSources[0]], [reversals[0].claim, reversals[0].source]]) {
    const checked = summaryCheck(claim, source, 'executiveSummary', {}, 'action');
    assertSummaryWarning(checked.result, checked.values, 'executiveSummary', source);
    const faithful = summaryCheck(source, source, 'executiveSummary', {}, 'action');
    assert.equal(faithful.result.accounting.items[0].status, 'supported');
    assert.deepEqual(faithful.result.flags, []);
  }
});

test('existing timing decisions and reviewer notes survive normalization alongside a new warning', () => {
  const existing = [
    { id: 'confirmed', kind: 'timing', message: 'Reviewer checked the original scheduling issue.', status: 'confirmed', correctionNote: 'Checked against the original record.', evidenceIds: ['T0001'] },
    { id: 'dismissed', kind: 'timing', message: 'Reviewer dismissed a separate scheduling issue.', status: 'dismissed', correctionNote: 'A separate source statement was reviewed.', evidenceIds: ['T0001'] }
  ];
  const { result, units } = discussionCheck(certain, qualifiedSources[0], { reviewFlagIds: existing.map(flag => flag.id) });
  assertDiscussionWarning(result, certain, 'new loss of qualification');
  const input = { discussion: result.discussion, reviewFlags: [...existing, ...result.flags] };
  const before = structuredClone(input);
  const normalized = V.normaliseAgentResult(input, units, 'discussion');
  assert.deepEqual(input, before);
  for (const flag of existing) assert.deepEqual(normalized.reviewFlags.find(item => item.id === flag.id), flag);
  assert.ok(normalized.reviewFlags.some(flag => flag.status === 'open' && !existing.some(old => old.id === flag.id)));
});

test('reviewer-authored discussion wording and its existing decision links remain locked', () => {
  const units = [{ id: 'T0001', speaker: 'Chair', text: qualifiedSources[0] }];
  const discussion = [{ id: 'schedule', topic: 'Inspection schedule', points: [{
    id: 'inspection', text: certain, evidenceIds: ['T0001'], supportingDetails: [],
    reviewerAuthored: true, reviewFlagIds: ['reviewer-confirmed'], reviewerNote: 'Reviewer chose this wording.'
  }], decisions: [], openQuestions: [] }];
  const before = structuredClone(discussion);
  const items = V.discussionFidelityCheckItems(discussion, units);
  assert.deepEqual(items, [], 'reviewer-authored text is excluded from automatic fidelity rewriting');
  const result = V.applyDiscussionFidelityResults(discussion, items, []);
  assert.deepEqual(result.discussion, before);
  assert.deepEqual(discussion, before);
  assert.equal(result.accounting.expected, 0);
  assert.deepEqual(result.flags, []);
});

test('valid qualified corrections cannot overwrite reviewer-authored summary or objective wording', () => {
  for (const field of ['executiveSummary', 'meetingObjectives']) {
    const checked = summaryCheck(certain, qualifiedSources[0], field, { reviewerAuthored: true }, 'discussion', {
      verdict: 'corrected', problemQuote: certain, correctedText: qualifiedSources[0]
    });
    assert.deepEqual(checked.result.values, checked.values);
    assert.equal(checked.result.accounting.items[0].status, 'uncertain');
    assert.equal(checked.result.accounting.items[0].reason, 'reviewer_temporal_wording_preserved');
    assert.equal(checked.result.flags.length, 1);
  }
});

test('a validated correction may restore the exact approved qualification for generated summary text', () => {
  const checked = summaryCheck(certain, qualifiedSources[0], 'executiveSummary', {}, 'discussion', {
    verdict: 'corrected', problemQuote: certain, correctedText: qualifiedSources[0]
  });
  assert.equal(checked.result.accounting.items[0].status, 'corrected');
  assert.equal(checked.result.values.executiveSummary, qualifiedSources[0]);
  assert.deepEqual(checked.result.flags, []);
});
