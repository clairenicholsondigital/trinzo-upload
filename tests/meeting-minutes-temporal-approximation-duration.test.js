'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../utils/meetingMinutesAgentV2');
const R = require('../utils/meetingMinutesTemporalReview');

const teens = ['eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const approximationPairs = [
  ['The inspection will last roughly five days.', 'The inspection will last five days.'],
  ['The inspection will last approximately eleven days.', 'The inspection will last eleven days.'],
  ['The inspection duration is estimated at twelve days.', 'The inspection duration is twelve days.'],
  ['The inspection is scheduled for roughly 10:30.', 'The inspection is scheduled for 10:30.'],
  ['The inspection start is estimated at 10:30.', 'The inspection start is at 10:30.'],
  ['The equipment inspection is scheduled for roughly 10:30.', 'The equipment inspection is scheduled for 10:30.'],
  ['The equipment inspection start is estimated at 10:30.', 'The equipment inspection start is at 10:30.'],
  ['The inspection will begin around 10:30.', 'The inspection will begin at 10:30.'],
  ['The inspection will begin around10:30.', 'The inspection will begin at10:30.'],
  ['The inspection will begin about 10:30.', 'The inspection will begin at 10:30.'],
  ['The inspection will begin about10:30.', 'The inspection will begin at10:30.'],
  ['The inspection start is 10:30, roughly.', 'The inspection start is 10:30.'],
  ['The inspection start is 10:30, approximately.', 'The inspection start is 10:30.'],
  ['The inspection start is 10:30, estimated.', 'The inspection start is 10:30.']
];

function discussion(claim) {
  return [{ id: 'schedule', topic: 'Inspection schedule', points: [{ id: 'inspection', text: claim,
    evidenceIds: ['T0001'], reviewFlagIds: [], supportingDetails: [] }], decisions: [], openQuestions: [] }];
}

function check(claim, source, supported, { authority = 'discussion' } = {}) {
  const record = { id: 'T0001', type: authority, text: source };
  assert.equal(R.supportedByApprovedRecord(claim, record), supported, `${source} -> ${claim}`);
  const units = [{ id: 'T0001', speaker: 'Chair', text: source }];
  const rows = discussion(claim), before = structuredClone({ rows, units });
  const items = V.discussionFidelityCheckItems(rows, units);
  assert.equal(items.length, 1);
  const checked = V.applyDiscussionFidelityResults(rows, items, [{ id: items[0].id, verdict: 'supported', evidenceQuote: source }]);
  assert.equal(checked.accounting.items[0].status, supported ? 'supported' : 'rejected', `discussion: ${claim}`);
  assert.equal(checked.flags.filter(flag => flag.kind === 'timing').length, supported ? 0 : 1);
  assert.equal(checked.discussion[0].points[0].text, claim, 'verification must not rewrite either number spelling');
  assert.deepEqual({ rows, units }, before);
  for (const field of ['executiveSummary', 'meetingObjectives']) {
    const values = { executiveSummary: field === 'executiveSummary' ? claim : '',
      meetingObjectives: field === 'meetingObjectives' ? [{ id: 'objective', text: claim }] : [] };
    const current = authority === 'action'
      ? { actions: [{ action: source, owners: [], timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds: ['T0001'] }] }
      : { discussion: discussion(source) };
    const previous = structuredClone({ values, current });
    const checks = R.summaryTemporalCheckItems(values, current);
    assert.equal(checks.length, 1);
    const summary = R.applySummaryTemporalCheckResults(values, checks, [{ id: checks[0].id, verdict: 'supported', evidenceQuote: source }]);
    assert.equal(summary.accounting.items[0].status, supported ? 'supported' : 'rejected', `${field}: ${claim}`);
    assert.equal(summary.flags.length, supported ? 0 : 1);
    if (!supported) assert.equal(summary.flags[0].temporalField, field);
    assert.deepEqual(summary.values, values, 'an unsupported supported-reply remains reviewable, not rewritten');
    assert.deepEqual({ values, current }, previous);
  }
  return { checked, units };
}

test('approximate durations and clock times cannot become exact in actual fidelity and summary gates', () => {
  for (const [source, exact] of approximationPairs) {
    check(exact, source, false);
    check(source, source, true);
  }
});

test('preserving an approximation does not authorize a changed duration, clock or approximation anchor', () => {
  check('The inspection will last roughly six days.', approximationPairs[0][0], false);
  check('The inspection start is estimated at 11:30.', approximationPairs[4][0], false);
  check('The inspection will last five days and start at roughly 10:30.',
    'The inspection will last roughly five days and start at 10:30.', false);
  check('The inspection will last five days and the report review will last roughly five days.',
    'The inspection will last roughly five days and the report review will last five days.', false);
});

test('eleven through nineteen duration words and digits verify faithfully in both directions', () => {
  for (const [index, word] of teens.entries()) {
    const spoken = `The inspection will last ${word} days starting Friday.`;
    const digits = `The inspection will last ${index + 11} days starting Friday.`;
    check(digits, spoken, true);
    check(spoken, digits, true);
    check(`The inspection will last ${index + 12} days starting Friday.`, spoken, false);
  }
});

test('previously recognized small duration words keep faithful digit equivalence too', () => {
  for (const [index, word] of ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'].entries()) {
    const unit = index === 0 ? 'day' : 'days';
    const spoken = `The inspection will last ${word} ${unit}.`;
    const digits = `The inspection will last ${index + 1} ${unit}.`;
    check(digits, spoken, true);
    check(spoken, digits, true);
  }
});

test('existing duration ranges, bounds and recurrence retain both their numbers and their meaning', () => {
  for (const [spoken, digits, changed] of [
    ['The inspection will last eleven to nineteen days.', 'The inspection will last 11 to 19 days.', 'The inspection will last 12 to 19 days.'],
    ['The inspection will last at least twelve days.', 'The inspection will last at least 12 days.', 'The inspection will last 12 days.'],
    ['The inspection will finish within thirteen days.', 'The inspection will finish within 13 days.', 'The inspection will finish within 14 days.'],
    ['The inspection repeats every fourteen days.', 'The inspection repeats every 14 days.', 'The inspection repeats every 15 days.'],
    ['The inspection will last roughly eleven to twelve days.', 'The inspection will last roughly 11 to 12 days.', 'The inspection will last 11 to 12 days.'],
    ['The inspection will last eleven working days.', 'The inspection will last 11 working days.', 'The inspection will last twelve working days.'],
    ['The inspection will last twelve business days.', 'The inspection will last 12 business days.', 'The inspection will last thirteen business days.']
  ]) {
    check(digits, spoken, true);
    check(spoken, digits, true);
    check(changed, spoken, false);
  }
  assert.equal(R.supportedByApprovedRecord('The inspection will last fifty days.',
    { type: 'discussion', text: 'The inspection will last fifteen days.' }), false);
});

test('existing spoken decimal durations retain exact values, scalar bounds and ranges', () => {
  for (const [spoken, digits, changed] of [
    ['The inspection will last eleven point five days.', 'The inspection will last 11.5 days.', 'The inspection will last 11.6 days.'],
    ['The inspection will last up to eleven point five days.', 'The inspection will last up to 11.5 days.', 'The inspection will last 11.5 days.'],
    ['The inspection will last at least twelve point five days.', 'The inspection will last at least 12.5 days.', 'The inspection will last 12.5 days.'],
    ['The inspection will last eleven point five to twelve point five days.', 'The inspection will last 11.5 to 12.5 days.', 'The inspection will last 11.5 to 13.5 days.'],
    ['The inspection repeats every eleven point five days.', 'The inspection repeats every 11.5 days.', 'The inspection repeats every 12.5 days.']
  ]) {
    check(digits, spoken, true);
    check(spoken, digits, true);
    check(changed, spoken, false);
  }
});

test('ordinary about-topic and cost-estimate wording does not become a temporal approximation', () => {
  assert.equal(R.temporalMeaningRetained('The briefing about logistics is Friday.', 'The briefing about logistics is Friday.'), true);
  assert.equal(R.temporalMeaningRetained('The inspection with estimated costs is Friday.', 'The inspection with estimated costs is Friday.'), true);
  assert.equal(R.temporalMeaningRetained('The inspection has approximately 400 pounds available Friday.',
    'The inspection has 400 pounds available Friday.'), true, 'a money quantity is outside temporal approximation matching');
  assert.equal(R.supportedByApprovedRecord('The briefing is scheduled for Friday.',
    { type: 'discussion', text: 'The briefing about logistics is scheduled for Friday.' }), true);
  assert.equal(R.supportedByApprovedRecord('The inspection is scheduled for Friday.',
    { type: 'discussion', text: 'The inspection with estimated costs is scheduled for Friday.' }), true);
  check('The briefing will begin at 10:30.', 'The briefing about site logistics will begin at 10:30.', true);
  check('The inspection begins at 10:30.', 'The inspection around the site begins at 10:30.', true);
});

test('duration comparison does not normalize work-subject names or unrelated quantities', () => {
  assert.equal(R.supportedByApprovedRecord('12 Oaks will review the inspection in 11 days.',
    { type: 'discussion', text: 'Twelve Oaks will review the inspection in eleven days.' }), false);
  assert.equal(R.supportedByApprovedRecord('11 Days will review the inspection in 12 days.',
    { type: 'discussion', text: 'Eleven Days will review the inspection in twelve days.' }), false);
  assert.equal(R.supportedByApprovedRecord('The inspection covers 11 documents and lasts 12 days.',
    { type: 'discussion', text: 'The inspection covers eleven documents and lasts twelve days.' }), false);
});

test('duration-looking company subjects with ordinary present-tense verbs are not renamed', () => {
  for (const [source, renamed, faithful] of [
    ['Eleven Days review the inspection for eleven days.', '11 Days review the inspection for 11 days.', 'Eleven Days review the inspection for 11 days.'],
    ['Twelve Weeks assess the risk report for twelve days.', '12 Weeks assess the risk report for 12 days.', 'Twelve Weeks assess the risk report for 12 days.'],
    ['“Eleven Days” review the inspection for eleven days.', '“11 Days” review the inspection for 11 days.', '“Eleven Days” review the inspection for 11 days.'],
    ['[Eleven Days] review the inspection for eleven days.', '[11 Days] review the inspection for 11 days.', '[Eleven Days] review the inspection for 11 days.']
  ]) {
    check(renamed, source, false);
    check(faithful, source, true);
    check(source, faithful, true);
  }
  const labelledSource = 'Chair: Eleven Days review the inspection for eleven days.';
  check('11 Days review the inspection for 11 days.', labelledSource, false);
  check('Eleven Days review the inspection for 11 days.', labelledSource, true);
  for (const preposition of ['For', 'Within', 'In', 'After']) {
    const spoken = `${preposition} eleven days, the equipment inspection continues.`;
    const digits = `${preposition} 11 days, the equipment inspection continues.`;
    check(digits, spoken, true);
    check(spoken, digits, true);
  }
  assert.equal(R.temporalMeaningRetained('11 days.', 'Eleven days.'), true);
  assert.equal(R.temporalMeaningRetained('Eleven days.', '11 days.'), true);
});

test('explicit evidence keeps literal raw quotes and UTF-16 source offsets despite numeric equivalence', () => {
  for (const [sourceQuantity, claimQuantity] of [['eleven', '11'], ['11', 'eleven'],
    ['eleven point five', '11.5'], ['11.5', 'eleven point five']]) {
    const phase = `The inspection will last ${sourceQuantity} days.`;
    const source = { id: 'T0001', type: 'discussion', text: `Background 🧭. ${phase}` };
    const claim = `The inspection will last ${claimQuantity} days.`;
    const evidence = { schemaVersion: 1, claimText: claim, sourceId: 'T0001', sourceQuote: phase,
      workSourceQuote: 'inspection', workClaimQuote: 'inspection', qualificationQuotes: [] };
    const before = structuredClone({ source, evidence });
    const checked = R.validateTemporalEvidence(claim, [source], evidence);
    assert.equal(checked.supported, true, JSON.stringify(checked));
    assert.equal(checked.binding.claimText, claim, 'persist the original claim spelling, not its comparison form');
    assert.equal(checked.binding.start, source.text.indexOf(phase));
    assert.equal(source.text.slice(checked.binding.start, checked.binding.end), phase);
    assert.deepEqual({ source, evidence }, before);
    assert.equal(R.validateTemporalEvidence(claim, [source], { ...evidence, sourceQuote: phase.replace(sourceQuantity, claimQuantity) }).supported,
      false, 'equivalent spelling cannot be substituted into a literal source quote');
    const wrong = claim.replace(claimQuantity, '12');
    assert.equal(R.validateTemporalEvidence(wrong, [source], { ...evidence, claimText: wrong }).supported, false);
    assert.deepEqual({ source, evidence }, before, 'invalid mappings must not rewrite source text or evidence either');
  }
});

test('literal clock quotations are not mistaken for speaker labels and real speaker prefixes still work', () => {
  const clock = 'The inspection start is estimated at 10:30.';
  for (const quotePrefix of ['', 'Chair: ', 'Speaker1: ']) for (const passagePrefix of ['', '[T0001] Chair: ', 'Speaker1: ']) {
    const checked = V.decisionQuoteValidation(`${quotePrefix}${clock}`, `${passagePrefix}${clock}`, 25, { allowClockPrefix: true });
    assert.equal(checked.valid, true, `${quotePrefix} / ${passagePrefix}: ${JSON.stringify(checked)}`);
  }
  assert.equal(V.decisionQuoteValidation('Morgan Hale: We agreed to send the inspection report Friday.',
    '[T0001] Morgan Hale: We agreed to send the inspection report Friday.', 25).valid, true);
  assert.equal(V.decisionQuoteValidation(clock, clock, 25).reason, 'quote_too_short', 'other consumers retain the legacy default');
  assert.equal(V.decisionQuoteValidation(clock.replace('10:30', '11:30'), clock, 25, { allowClockPrefix: true }).valid, false);
  for (const shortQuote of ['10:30', '10:30:15', '10:30 BST', '10:30:15 UTC', '10:30 UTC+01:00', 'At 10:30', 'At10:30']) {
    assert.equal(V.decisionQuoteValidation(shortQuote, shortQuote, 25).reason, 'quote_too_short', shortQuote);
  }
  for (const meaningful of ['Starts at 10:30', 'Estimated at 10:30']) {
    assert.equal(V.decisionQuoteValidation(meaningful, `Speaker1: ${meaningful}`, 25, { allowClockPrefix: true }).valid, true, meaningful);
  }
});

test('supported and corrected replies cannot turn clock lower bounds into an exact start', () => {
  for (const boundary of ['no earlier than', 'at least']) {
    // These short quotes were previously rejected as mistaken speaker prefixes;
    // newly allowing their faithful form must not unlock an altered bound.
    const source = `Audit begins ${boundary} 10:30.`;
    const exact = 'Audit begins at 10:30.';
    const supportedRows = discussion(exact), supportedUnits = [{ id: 'T0001', speaker: 'Chair', text: source }];
    const supportedItems = V.discussionFidelityCheckItems(supportedRows, supportedUnits);
    const supported = V.applyDiscussionFidelityResults(supportedRows, supportedItems, [{
      id: supportedItems[0].id, verdict: 'supported', evidenceQuote: source
    }]);
    assert.equal(supported.accounting.items[0].status, 'rejected');
    assert.equal(supported.flags.filter(flag => flag.kind === 'timing').length, 1);
    assert.equal(supported.discussion[0].points[0].text, exact);
    for (const field of ['executiveSummary', 'meetingObjectives']) {
      const values = { executiveSummary: field === 'executiveSummary' ? exact : '',
        meetingObjectives: field === 'meetingObjectives' ? [{ id: 'objective', text: exact }] : [] };
      const checks = R.summaryTemporalCheckItems(values, { discussion: discussion(source) });
      const checked = R.applySummaryTemporalCheckResults(values, checks, [{
        id: checks[0].id, verdict: 'supported', evidenceQuote: source
      }]);
      assert.equal(checked.accounting.items[0].status, 'rejected');
      assert.equal(checked.flags.length, 1);
      assert.deepEqual(checked.values, values);
    }
    check(source, source, true);
    const wrong = 'Audit begins at 11:30.';
    for (const correctedText of [exact, source]) {
      const units = [{ id: 'T0001', speaker: 'Chair', text: source }];
      const rows = discussion(wrong), items = V.discussionFidelityCheckItems(rows, units);
      const reply = { id: items[0].id, verdict: 'corrected', issue: 'timing', problemQuote: wrong,
        evidenceQuote: source, correctedText, reason: 'Check the source clock wording.' };
      const corrected = V.applyDiscussionFidelityResults(rows, items, [reply]);
      assert.equal(corrected.accounting.items[0].status, correctedText === source ? 'corrected' : 'rejected');
      assert.equal(corrected.discussion[0].points[0].text, correctedText === source ? source : wrong);
      for (const field of ['executiveSummary', 'meetingObjectives']) {
        const values = { executiveSummary: field === 'executiveSummary' ? wrong : '',
          meetingObjectives: field === 'meetingObjectives' ? [{ id: 'objective', text: wrong }] : [] };
        const checks = R.summaryTemporalCheckItems(values, { discussion: discussion(source) });
        const summary = R.applySummaryTemporalCheckResults(values, checks, [{ ...reply, id: checks[0].id }]);
        assert.equal(summary.accounting.items[0].status, correctedText === source ? 'corrected' : 'rejected');
        if (correctedText !== source) assert.deepEqual(summary.values, values);
      }
    }
  }
});

test('approved action authority uses the same approximation and duration-value safeguards', () => {
  check('The inspection will last five days.', approximationPairs[0][0], false, { authority: 'action' });
  check('The inspection will last 11 days.', 'The inspection will last eleven days.', true, { authority: 'action' });
});

test('reviewer-authored text and existing confirmed or dismissed warning notes remain intact', () => {
  const source = approximationPairs[0][0], claim = approximationPairs[0][1];
  const units = [{ id: 'T0001', speaker: 'Chair', text: source }];
  const rows = discussion(claim);
  rows[0].points[0].reviewerAuthored = true;
  rows[0].points[0].reviewFlagIds = ['reviewer-confirmed'];
  const before = structuredClone(rows);
  assert.deepEqual(V.discussionFidelityCheckItems(rows, units), []);
  assert.deepEqual(V.applyDiscussionFidelityResults(rows, [], []).discussion, before);
  const existing = [{ id: 'reviewer-confirmed', kind: 'timing', status: 'confirmed', message: 'Reviewer checked the original duration.',
    correctionNote: 'Checked against the source.', evidenceIds: ['T0001'] },
  { id: 'reviewer-dismissed', kind: 'timing', status: 'dismissed', message: 'A different timing issue was reviewed.',
    correctionNote: 'Separate review decision.', evidenceIds: ['T0001'] }];
  const { checked } = check(claim, source, false);
  const normalized = V.normaliseAgentResult({ discussion: checked.discussion, reviewFlags: [...existing, ...checked.flags] }, units, 'discussion');
  for (const flag of existing) assert.deepEqual(normalized.reviewFlags.find(item => item.id === flag.id), flag);
  for (const field of ['executiveSummary', 'meetingObjectives']) {
    const values = { executiveSummary: field === 'executiveSummary' ? claim : '',
      meetingObjectives: field === 'meetingObjectives' ? [{ id: 'objective', text: claim, reviewerAuthored: true }] : [] };
    const items = R.summaryTemporalCheckItems(values, { discussion: discussion(source) }, [], { summaryReviewerAuthored: true });
    const locked = R.applySummaryTemporalCheckResults(values, items, [{ id: items[0].id, verdict: 'corrected', problemQuote: claim,
      evidenceQuote: source, correctedText: source }]);
    assert.deepEqual(locked.values, values);
    assert.equal(locked.accounting.items[0].reason, 'reviewer_temporal_wording_preserved');
  }
});
