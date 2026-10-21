'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../utils/meetingMinutesAgentV2');
const T = require('../utils/meetingMinutesTiming');
const S = require('../utils/meetingMinutesTemporalReview');
const options = { meetingDate: '2027-03-01' };
const units = [{ id: 'T0001', speaker: 'Sam Reed', text: 'I will send the inspection report next week.' }];
const work = () => ({ id: 'report', action: 'Send the inspection report.', owners: ['Sam Reed'], evidenceIds: ['T0001'],
  reviewFlagIds: [], timing: { kind: 'target', wording: 'next week', exactDate: '' } });
const correct = id => ({ id, verdict: 'correct', timingQuote: 'next week', stepQuote: 'send the inspection report' });

test('missing, uncertain, duplicate and invalid timing replies retain work and visibly account for every unchecked item', () => {
  for (const make of [() => [], id => [{ id, verdict: 'uncertain', reason: 'The task timing cannot be established.' }],
    id => [correct(id), correct(id)], id => [{ ...correct(id), stepQuote: 'invented quotation' }],
    id => [{ ...correct(id), timingQuote: { words: 'next week' } }]]) {
    const action = work(), items = V.timingCheckItems([action], units, options);
    const result = V.applyTimingCheckResults([action], items, make(items[0].id), options);
    assert.equal(result.actions.length, 1);
    assert.equal(result.actions[0].action, action.action);
    assert.deepEqual(result.actions[0].owners, action.owners);
    assert.deepEqual(result.actions[0].timing, action.timing);
    assert.ok(result.flags.some(flag => /Cannot verify the timing/.test(flag.message)));
    assert.equal(result.accounting.expected, 1);
    assert.equal(result.accounting.complete, false);
    assert.equal(result.actions[0].timingDecision.status, 'unresolved');
    assert.equal(T.assessActionTiming(result.actions[0], units, options).action.timingDecision.status, 'unresolved');
  }
});

test('one quoted reply per item succeeds; unrelated extra results are recorded rather than applied', () => {
  const action = work(), items = V.timingCheckItems([action], units, options);
  const valid = V.applyTimingCheckResults([action], items, [correct(items[0].id)], options);
  assert.equal(valid.accounting.complete, true);
  assert.equal(valid.accounting.counts.supported, 1);
  const extra = V.applyTimingCheckResults([action], items, [correct(items[0].id), correct('unknown')], options);
  assert.equal(extra.accounting.complete, false);
  assert.equal(extra.accounting.unknown.length, 1);
  assert.deepEqual(extra.actions[0].timing, action.timing);
});

test('real quotes alone cannot count an unresolved work assignment as independently verified timing', () => {
  const action = work();
  const source = [{ id: 'T0001', speaker: 'Chair', text: 'The inspection report will be sent next week.' }];
  const items = V.timingCheckItems([action], source, options);
  const result = V.applyTimingCheckResults([action], items, [{ id: items[0].id, verdict: 'correct',
    timingQuote: 'next week', stepQuote: 'inspection report will be sent' }], options);
  assert.equal(result.actions[0].action, action.action);
  assert.deepEqual(result.actions[0].owners, action.owners);
  assert.deepEqual(result.actions[0].timing, action.timing);
  assert.equal(result.actions[0].timingDecision.status, 'unresolved');
  assert.equal(result.actions[0].timingDecision.checkerStatus, 'uncertain');
  assert.equal(result.accounting.complete, false);
  assert.equal(result.accounting.counts.uncertain, 1);
  assert.ok(result.flags.length);
  assert.equal(T.assessActionTiming(result.actions[0], source, options).action.timingDecision.status, 'unresolved');
});

test('an owned explicit work reference retains genuine preference and fallback without borrowing another task', () => {
  const action = { id: 'review', action: 'Review the inspection report.', owners: ['Morgan'], evidenceIds: ['T0001', 'T0002'], reviewFlagIds: [],
    timing: { kind: 'deadline', wording: 'Friday', exactDate: '2026-10-23' } };
  const source = [{ id: 'T0001', speaker: 'Morgan', text: 'I will review the inspection report Friday.' },
    { id: 'T0002', speaker: 'Morgan', text: 'For that report review, ideally Thursday, but Friday is the hard stop if needed.' }];
  const settings = { meetingDate: '2026-10-21' };
  const verdict = { verdict: 'qualified', timingQuote: 'Friday', stepQuote: 'review the inspection report',
    qualificationQuote: 'ideally Thursday, but Friday is the hard stop', preferredTiming: 'ideally Thursday', fallbackTiming: 'Friday is the hard stop' };
  const apply = input => {
    const items = V.timingCheckItems([action], input, settings);
    return V.applyTimingCheckResults([action], items, [{ id: items[0].id, ...verdict }], settings);
  };
  const valid = apply(source);
  assert.equal(valid.actions[0].timing.wording, 'Preferred: ideally Thursday; fallback: Friday is the hard stop');
  assert.equal(valid.actions[0].timing.exactDate, '');
  assert.equal(valid.actions[0].timing.kind, 'target');
  assert.equal(valid.accounting.complete, true);
  for (const last of [
    { ...source[1], text: source[1].text.replace('that report review', 'that training report review') },
    { ...source[1], speaker: 'Jordan' },
    { ...source[1], text: source[1].text + ' I will send the training pack.' },
    { ...source[1], text: source[1].text + ' Jordan will review the inspection report.' }
  ]) {
    const result = apply([source[0], last]);
    assert.deepEqual(result.actions[0].timing, action.timing, last.text);
    assert.equal(result.accounting.complete, false);
    assert.ok(result.flags.length);
  }
});

test('a same-period replacement cannot silently remove a source timing hedge', () => {
  const action = { ...work(), timing: { kind: 'target', wording: 'next week hopefully', exactDate: '' } };
  const source = [{ id: 'T0001', speaker: 'Sam Reed', text: 'I will send the inspection report next week hopefully.' }];
  const items = V.timingCheckItems([action], source, options);
  const result = V.applyTimingCheckResults([action], items, [{ id: items[0].id, verdict: 'misread', timingQuote: 'next week hopefully', correctTiming: 'next week' }], options);
  assert.deepEqual(result.actions[0].timing, action.timing);
  assert.equal(result.accounting.complete, false);
  assert.ok(result.flags.length);
});

test('timing without a source passage is still an expected item and cannot disappear from coverage', () => {
  const action = { ...work(), evidenceIds: [] };
  const items = V.timingCheckItems([action], [], options);
  assert.equal(items.length, 1);
  const result = V.applyTimingCheckResults([action], items, [], options);
  assert.equal(result.accounting.counts.missing, 1);
  assert.equal(result.actions[0].action, action.action);
  assert.ok(result.flags.length);
});

test('bounded packets retain defining antecedents and distant actual anchors before background', () => {
  const source = V.normaliseSourceUnits(Array.from({ length: 100 }, (_, i) => ({ id: `T${String(i + 1).padStart(4, '0')}`, speaker: 'Chair', text: 'The general project discussion continued.' })));
  source[72].text = 'The component register is the software inventory used for this review.';
  source[79].text = 'The component register may be shared before the audit.';
  source[98].text = 'The delivery report will be sent Friday.';
  const row = { text: 'The component register may be shared before the audit.', evidenceIds: ['T0080', 'T0099'] };
  const packet = V.boundedReviewEvidence(row, source, { maxUnits: 12 });
  assert.ok(packet.units.some(unit => unit.id === 'T0073'));
  assert.ok(packet.units.some(unit => unit.id === 'T0080'));
  assert.ok(packet.units.some(unit => unit.id === 'T0099'));
  assert.deepEqual(packet.coverage.omittedAnchorIds, []);
  assert.ok(packet.units.length <= 12);
});

test('fidelity covers all generated rows including supporting details and open questions beyond48', () => {
  const discussion = [{ id: 'topic', topic: 'Inspection', points: Array.from({ length: 55 }, (_, i) => ({ id: `p${i}`, text: 'The inspection report is ready.', evidenceIds: ['T0001'] })), decisions: [],
    openQuestions: [{ id: 'q', text: 'Will the inspection report be sent next week?', evidenceIds: ['T0001'] }] }];
  discussion[0].points[0].supportingDetails = [{ id: 'detail', text: 'The inspection report will be sent next week.', evidenceIds: ['T0001'] }];
  const items = V.discussionFidelityCheckItems(discussion, units);
  assert.equal(items.length, 57);
  assert.ok(items.some(item => item.path.length === 5));
  assert.ok(items.some(item => item.kind === 'openQuestions'));
  const result = V.applyDiscussionFidelityResults(discussion, items, items.map(item => ({ id: item.id, verdict: 'supported', evidenceQuote: units[0].text })));
  assert.equal(result.accounting.expected, 57);
  assert.equal(result.accounting.complete, true);
  const missing = V.applyDiscussionFidelityResults(discussion, items, []);
  assert.equal(missing.accounting.counts.missing, 57);
  assert.ok(missing.discussion[0].points[0].supportingDetails[0].reviewFlagIds.length);
  assert.ok(missing.discussion[0].openQuestions[0].reviewFlagIds.length);
});

test('source-quoted corrections reach their own supporting row and open question without mutating inputs', () => {
  const source = [{ id: 'T0001', speaker: 'Chair', text: 'The prototype shipping deadline is 6 March 2027.' }];
  const discussion = [{ id: 'topic', topic: 'Prototype', points: [{ id: 'p', text: 'The prototype is ready.', evidenceIds: ['T0001'],
    supportingDetails: [{ id: 'd', text: 'The prototype shipping deadline is 4 March 2027.', evidenceIds: ['T0001'] }] }], decisions: [],
    openQuestions: [{ id: 'q', text: 'Is the prototype shipping deadline 4 March 2027?', evidenceIds: ['T0001'] }] }];
  const before = JSON.stringify(discussion), items = V.discussionFidelityCheckItems(discussion, source);
  const results = items.map(item => item.row.includes('4 March') ? { id: item.id, verdict: 'corrected', problemQuote: '4 March 2027',
    evidenceQuote: source[0].text, correctedText: item.kind === 'openQuestions' ? 'Is the prototype shipping deadline 6 March 2027?' : source[0].text } : { id: item.id, verdict: 'supported' });
  const result = V.applyDiscussionFidelityResults(discussion, items, results);
  assert.equal(result.discussion[0].points[0].text, discussion[0].points[0].text);
  assert.equal(result.discussion[0].points[0].supportingDetails[0].text, source[0].text);
  assert.match(result.discussion[0].openQuestions[0].text, /6 March 2027/);
  assert.equal(JSON.stringify(discussion), before);
});

test('validated discovery classification survives normalization; unknown labels do not grant priority', () => {
  for (const disposition of ['core', 'supporting', 'reject', 'invented']) {
    const result = V.normaliseAgentResult({ discussion: [{ topic: 'Inspection', points: [{ text: units[0].text, evidenceIds: ['T0001'], discoveryDisposition: disposition }] }] }, units, 'discussion');
    assert.equal(result.discussion[0].points[0].discoveryDisposition, disposition === 'invented' ? undefined : disposition);
  }
});

function summaryResult(summary, source, verdict = 'supported', extra = {}) {
  const values = { executiveSummary: summary, meetingObjectives: [] };
  const current = { discussion: [{ topic: 'Inspection', points: [{ text: source, evidenceIds: ['T0001'] }] }], actions: [] };
  const items = S.summaryTemporalCheckItems(values, current, [], options);
  const results = items.map(item => ({ id: item.id, verdict, evidenceQuote: source, ...extra }));
  return { items, result: S.applySummaryTemporalCheckResults(values, items, results, options) };
}

test('summary temporal approval rejects changed values, borrowed meetings, lost uncertainty and lost dependencies', () => {
  for (const [summary, source] of [
    ['The inspection report will be sent 6 March 2028.', 'The inspection report will be sent 6 March 2027.'],
    ['The inspection report will be sent 7 March 2027.', 'The inspection report will be sent 6 March 2027.'],
    ['The inspection report will be reviewed next week.', 'The planning call is next week; the inspection report will be reviewed later.'],
    ['The inspection report will be sent Friday.', 'The team will try to send the inspection report Friday.'],
    ['The inspection report will be reviewed.', 'The inspection report will be reviewed after approval.'],
    ['The inspection report will be sent Monday.', 'The inspection report will not be sent Monday.'],
    ['The inspection report will be sent Friday at 11:30.', 'The inspection report will be sent Friday at 10:30.'],
    ['The inspection review will last three weeks.', 'The inspection review will last two weeks.'],
    ['The inspection report will be reviewed Friday.', 'The inspection report will be sent Friday.'],
    ['Jordan will send the inspection report Friday.', 'Sam will send the inspection report Friday.'],
    ['Sam will review the inspection report Friday and Jordan will send the training pack Monday.',
      'Jordan will review the inspection report Friday and Sam will send the training pack Monday.'],
    ['Existing instruments must be entered in the equipment register by 28 November 2026.',
      'Existing instruments must be deleted in the equipment register by 28 November 2026.'],
    ['Review the inspection report Friday at10:30BST.', 'Review the inspection report Friday at11:30GMT.'],
    ['Review the inspection report Friday at10:30BST.', 'Review the inspection report Friday at10:30GMT.'],
    ['Review the inspection report Friday at10:30UTC+01:00.', 'Review the inspection report Friday at10:30UTC+02:00.']
  ]) {
    const { items, result } = summaryResult(summary, source);
    assert.equal(items.length, 1, summary);
    assert.equal(result.accounting.complete, false, summary);
    assert.ok(result.flags.length, summary);
    assert.equal(result.values.executiveSummary, summary);
  }
});

test('summary verification accepts a faithful paraphrase and a source-verbatim correction, with mandatory supporting quote', () => {
  const source = 'The inspection report will be sent Friday.';
  const valid = summaryResult('The inspection report will be circulated Friday.', source);
  assert.equal(valid.result.accounting.complete, true);
  const corrected = summaryResult('The inspection report will be sent Monday.', source, 'corrected', { problemQuote: 'The inspection report will be sent Monday.', correctedText: source });
  assert.equal(corrected.result.values.executiveSummary, source);
  assert.equal(corrected.result.accounting.counts.corrected, 1);
  const values = { executiveSummary: source, meetingObjectives: [] };
  const items = S.summaryTemporalCheckItems(values, { discussion: [{ points: [{ text: source }] }] });
  assert.ok(S.applySummaryTemporalCheckResults(values, items, [{ id: items[0].id, verdict: 'supported' }]).flags.length);
});

test('manual summary preservation does not exempt generated objectives and never normalizes unchanged manual prose', () => {
  const source = 'The inspection report will be sent Friday.';
  const values = { executiveSummary: 'The inspection report will be sent Monday.  This is reviewed prose.',
    meetingObjectives: [{ id: 'generated', text: 'The inspection report will be sent Monday.' },
      { id: 'manual', text: 'The inspection report will be sent Monday.', reviewerAuthored: true }] };
  const items = S.summaryTemporalCheckItems(values, { discussion: [{ points: [{ text: source }] }] }, [], { summaryReviewerAuthored: true });
  const results = items.map(item => ({ id: item.id, verdict: 'corrected', problemQuote: 'The inspection report will be sent Monday.', evidenceQuote: source, correctedText: source }));
  const result = S.applySummaryTemporalCheckResults(values, items, results, { summaryReviewerAuthored: true });
  assert.equal(result.values.executiveSummary, values.executiveSummary);
  assert.equal(result.values.meetingObjectives[0].text, source);
  assert.equal(result.values.meetingObjectives[1].text, values.meetingObjectives[1].text);
});
