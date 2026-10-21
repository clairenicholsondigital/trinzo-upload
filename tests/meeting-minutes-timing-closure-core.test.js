'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../utils/meetingMinutesTiming');
const anchor = '2026-10-21';
const source = (text, extra = {}) => ({ id: 'T1', speaker: 'Morgan Taylor', text, ...extra });
const action = (wording, extra = {}) => ({ id: 'work', action: 'Review the inspection report.', owners: ['Morgan Taylor'], evidenceIds: ['T1'], timing: { kind: 'target', wording, exactDate: '' }, ...extra });
const assess = (row, units) => T.assessActionTiming(row, units, { meetingDate: anchor });

test('a recurring obligation is not collapsed to its first calendar occurrence', () => {
  for (const wording of ['every Friday', 'each Friday', 'weekly on Friday', 'Fridays', 'the first Monday of each month', 'monthly on 17 March', 'annually on 17 March', 'every two weeks from Friday', 'every 2 days from Friday', 'every other Friday']) {
    assert.equal(T.classifyTimingWording(wording).kind, 'recurrence', wording);
    assert.equal(T.resolveExactDate(wording, anchor), '', wording);
    assert.equal(T.normaliseTimingValue({ kind: 'target', wording, exactDate: '' }, { meetingDate: anchor, mode: 'derive' }).exactDate, '', wording);
  }
  const row = action('every Friday', { timing: { kind: 'deadline', wording: 'every Friday', exactDate: '2026-10-23' } });
  const result = assess(row, [source('I will review the inspection report every Friday.')]);
  assert.equal(result.action.timing.wording, 'every Friday');
  assert.equal(result.action.timing.exactDate, '');
  assert.ok(result.issues.some(issue => issue.code === 'unsupported_precision'));
  assert.equal(T.resolveExactDate('this Friday', anchor), '2026-10-23', 'a single stated Friday remains usable');
});

test('historical relative years retain their direction and stay local to their date', () => {
  for (const wording of ['17 March last year', '17 March previous year', 'last year on 17 March', 'previous year in March 17', '17 March of the previous year', "last year's March 17"]) {
    assert.equal(T.resolveExactDate(wording, anchor), '2025-03-17', wording);
  }
  assert.deepEqual(T.explicitCalendarDates('17 March last year; 28 November this year; 12 January next year', anchor), ['2025-03-17', '2026-11-28', '2027-01-12']);
  assert.equal(T.explicitCalendarDate('17 March this year; 28 November next year', anchor), '2026-03-17');
  assert.equal(T.explicitCalendarDate('last year on 17 March; 28 November next year', anchor), '2025-03-17');
  assert.equal(T.resolveExactDate('Friday last year', anchor), '');
  assert.equal(T.resolveExactDate('last year', anchor), '');
  const past = assess(action('17 March last year', { timing: { kind: 'deadline', wording: '17 March last year', exactDate: '2025-03-17' } }), [source('I still need to review the inspection report; it was due on 17 March last year.')]);
  assert.equal(past.action.timing.exactDate, '2025-03-17');
  assert.ok(past.issues.some(issue => issue.code === 'past_action_date' && issue.preserveValue));
});

test('source-bound periods, ranges, dependencies and uncertainty are verified at their actual precision', () => {
  for (const wording of ['next week', 'presumably early next week', 'in two to three weeks', 'after the panel approval', 'once the draft arrives', 'every Friday']) {
    const result = assess(action(wording), [source(`I will review the inspection report ${wording}.`)]);
    assert.equal(result.binding.status, 'supported', wording);
    assert.equal(result.action.timing.wording, wording);
    assert.equal(result.action.timing.exactDate, '');
    assert.equal(result.assessment.status, 'qualified', wording);
    assert.equal(result.issues.length, 0, wording);
  }
  const numericRange = assess(action('in 2–3 weeks'), [source('I will review the inspection report in two or three weeks.')]);
  assert.equal(numericRange.binding.status, 'supported');
});

test('a neighbouring call period does not become the review deadline', () => {
  const units = [source('I will review the inspection report.'), source('I will arrange the training call next week.', { id: 'T2' })];
  const original = action('next week', { evidenceIds: ['T1', 'T2'] });
  const result = assess(original, units);
  assert.equal(result.binding.status, 'unsupported');
  assert.deepEqual(result.binding.conflictingSourceIds, ['T2']);
  assert.equal(result.action.action, original.action, 'the accepted work survives');
  assert.equal(result.action.timing.wording, '');
  assert.equal(result.assessment.status, 'rejected');
  assert.deepEqual(result.assessment.rejectedWordings, ['next week']);
  const replay = assess({ ...result.action, timing: original.timing }, units);
  assert.equal(replay.action.timing.wording, '', 'source-bound rejection prevents restoration');
});

test('broad timing is bound to its operation, owner, recipient and document', () => {
  const negatives = [
    { row: action('next week'), text: 'I will draft the inspection report next week.' },
    { row: action('next week', { owners: ['Casey Patel'] }), text: 'Morgan Taylor will review the inspection report next week; Casey Patel will review the inspection report next month.' },
    { row: action('next week', { action: 'Send the inspection report to Casey Patel.' }), text: 'I will send the inspection report to Jamie Reed next week; I will send the inspection report to Casey Patel next month.' },
    { row: action('next week', { action: 'Review the supplier declaration.' }), text: 'I will review the customer declaration next week.' }
  ];
  for (const { row, text } of negatives) {
    const result = assess(row, [source(text)]);
    assert.equal(result.binding.status, 'unsupported', text);
    assert.equal(result.action.timing.wording, '', text);
    assert.equal(result.action.action, row.action, text);
  }
});

test('short timing answers preserve their antecedent and cannot skip a nearer task', () => {
  const opening = source('I will review the inspection report.');
  for (const text of ['Presumably early next week.', 'For the inspection report, presumably early next week.']) {
    const units = [opening, source(text, { id: 'T2' })];
    const result = assess(action('presumably early next week', { evidenceIds: ['T1', 'T2'] }), units);
    assert.equal(result.binding.status, 'supported', text);
  }
  const wrong = assess(action('next week', { evidenceIds: ['T1', 'T2'] }), [opening, source('For the training pack, next week.', { id: 'T2' })]);
  assert.equal(wrong.binding.status, 'unsupported');
  assert.equal(wrong.action.timing.wording, '');
});

test('a referential timing promise cannot borrow an older task assigned to another owner', () => {
  const opening = source("I'll replace the projector lamp.");
  const question = source('When will you do that?', { id: 'T2', speaker: 'Chair' });
  for (const text of ["I'll do it Friday morning probably.", "I'll do it, Friday morning probably.", "I'll do it next week.", "I'll do it, next week."]) {
    const units = [opening, question, source(text, { id: 'T3', speaker: 'Jordan Blake' })];
    const wording = text.includes('Friday') ? 'Friday morning probably' : 'next week';
    const row = action(wording, { action: 'Replace the projector lamp.', evidenceIds: ['T1', 'T2', 'T3'] });
    const result = assess(row, units);
    assert.equal(result.binding.status, 'unsupported', text);
    assert.deepEqual(result.binding.conflictingSourceIds, ['T3'], text);
    assert.equal(result.action.action, row.action, 'accepted work is preserved');
    assert.equal(result.action.timing.wording, '', text);
  }
});

test('right-owner and unknown-owner referential promises retain their source timing', () => {
  for (const wording of ['Friday morning probably', 'next week']) {
    const units = [source('Morgan Taylor, will you replace the projector lamp?', { speaker: 'Chair' }),
      source('When will you do that?', { id: 'T2', speaker: 'Chair' }),
      source(`I'll do it, ${wording}.`, { id: 'T3' })];
    for (const owners of [['Morgan Taylor'], []]) {
      const row = action(wording, { action: 'Replace the projector lamp.', owners, evidenceIds: ['T1', 'T2', 'T3'] });
      const result = assess(row, units);
      assert.equal(result.binding.status, 'supported', `${wording}; owners: ${owners.join(',') || 'unknown'}`);
      assert.equal(result.action.timing.wording, wording);
    }
  }
});

test('a fronted dependency binds only to the same sentence’s actual work', () => {
  const positive = assess(action('after the panel approval'), [source('After the panel approval, I will review the inspection report.')]);
  assert.equal(positive.binding.status, 'supported');
  const wrong = assess(action('after the panel approval'), [source('After the panel approval, I will arrange the training call. I will review the inspection report separately.')]);
  assert.equal(wrong.binding.status, 'unsupported');
});

test('unknown ownership does not erase otherwise supported work timing', () => {
  for (const wording of ['next week', 'Friday']) {
    const date = T.resolveExactDate(wording, anchor);
    const row = action(wording, { owners: [], timing: { kind: 'target', wording, exactDate: date } });
    const result = assess(row, [source(`I will review the inspection report ${wording}.`)]);
    assert.equal(result.binding.status, 'supported', wording);
    assert.equal(result.action.timing.wording, wording);
    assert.equal(result.action.timing.exactDate, date);
  }
});

test('missing evidence or an unattached temporal answer remains visibly unresolved', () => {
  for (const units of [[], [source('Next week.')], [source('I will review the inspection report.')]]) {
    const row = action('next week');
    const result = assess(row, units);
    assert.equal(result.binding.status, 'unresolved');
    assert.equal(result.assessment.status, 'unresolved');
    assert.equal(result.action.timing.wording, 'next week');
    assert.ok(result.issues.some(issue => issue.code === 'timing_source_unresolved' && issue.preserveValue));
  }
  const uncited = assess(action('next week', { evidenceIds: ['T9'] }), [source('I will review the inspection report next week.')]);
  assert.equal(uncited.binding.status, 'unresolved', 'an uncited date cannot grant source authority');
});

test('incomplete colloquial paraphrases are retained for review rather than called contradicted', () => {
  const examples = [
    { row: action('by mid-December', { action: 'Prepare the winter maintenance schedule and publish it on the portal and noticeboard.' }), text: "Morgan's doing the maintenance schedule for mid-December." },
    { row: action('this week', { action: 'Provide the gateway access keys to Casey Patel so the controller can be configured.' }), text: 'Your remaining task this week, Morgan, is those access keys through to Casey.' },
    { row: action('in two to three weeks', { action: 'Implement a charging system and add the terminal labels.' }), text: "I would like to think in two to three weeks, we'll have a system to implement charging and add the terminal labels." }
  ];
  for (const { row, text } of examples) {
    const result = assess(row, [source(text)]);
    assert.equal(result.binding.status, 'unresolved', text);
    assert.equal(result.action.timing.wording, row.timing.wording, text);
    assert.ok(result.issues.some(issue => issue.preserveValue), text);
  }
});

test('an explicit timed infinitive cannot be contradicted by the preceding different operation', () => {
  const text = 'Prepare two inspection scenarios, complete the device procedure review and the testing, presumably early next week to start the testing at least.';
  for (const wording of ['Presumably early next week to start the testing at least.', 'presumably early next week']) {
    const row = action(wording, { action: 'Start the equipment compliance testing after completion of the device procedure review.' });
    const result = assess(row, [source(text)]);
    assert.equal(result.binding.status, 'unresolved');
    assert.equal(result.action.timing.wording, wording);
    assert.ok(result.issues.some(issue => issue.code === 'timing_source_unresolved' && issue.preserveValue));
  }
  const row = action('next week', { action: 'Start the software testing.' });
  for (const wrong of ['Complete the procedure review, next week to arrange the inspection call.',
    'Complete the procedure review, next week to start the equipment testing.']) {
    const result = assess(row, [source(wrong)]);
    assert.equal(result.binding.status, 'unsupported', wrong);
    assert.equal(result.action.timing.wording, '', wrong);
  }
});

test('source uncertainty cannot silently become a firm generated deadline', () => {
  const result = assess(action('next week', { timing: { kind: 'deadline', wording: 'next week', exactDate: '' } }), [source('I will review the inspection report presumably early next week.')]);
  assert.equal(result.binding.status, 'supported');
  assert.equal(result.action.timing.kind, 'target');
  assert.ok(result.issues.some(issue => issue.code === 'source_timing_qualification' && issue.preserveValue));
  assert.equal(result.assessment.status, 'qualified');
});

test('an explicitly excluded time cannot support a positive timing assertion', () => {
  for (const text of ['I will review the inspection report, but not next week.', 'I will review the inspection report instead of next week.', 'I will review the inspection report not before next week.']) {
    const result = assess(action('next week'), [source(text)]);
    assert.equal(result.binding.status, 'unsupported', text);
    assert.equal(result.action.timing.wording, '', text);
  }
  const statedBound = assess(action('not before next week'), [source('I will review the inspection report not before next week.')]);
  assert.equal(statedBound.binding.status, 'supported', 'the actual source bound remains available');
  assert.equal(statedBound.action.timing.wording, 'not before next week');
});

test('named owner attribution covers real operations outside a fixed verb list', () => {
  const original = action('next week', { action: 'Ship the replacement sensor.', owners: ['Casey Patel'] });
  const wrong = assess(original, [source('Morgan Taylor will ship the replacement sensor next week.', { speaker: 'Chair' })]);
  assert.equal(wrong.binding.status, 'unsupported');
  const right = assess(original, [source('Casey Patel will ship the replacement sensor next week.', { speaker: 'Chair' })]);
  assert.equal(right.binding.status, 'supported');
  for (const owner of ['Morgan Taylor', 'Casey Patel']) {
    const joint = assess(action('tomorrow', { owners: [owner], timing: { kind: 'target', wording: 'tomorrow', exactDate: '2026-10-22' } }), [source('Morgan Taylor and Casey Patel will each review the inspection report tomorrow.', { speaker: 'Chair' })]);
    assert.equal(joint.binding.status, 'supported', owner);
    assert.equal(joint.action.timing.exactDate, '2026-10-22');
  }
  for (const text of ["Morgan Taylor's reviewing the inspection report next week.", 'Morgan Taylor is reviewing the inspection report next week.']) {
    const wrongProgress = assess(action('next week', { owners: ['Casey Patel'] }), [source(text, { speaker: 'Chair' })]);
    assert.equal(wrongProgress.binding.status, 'unsupported', text);
    const ownProgress = assess(action('next week'), [source(text, { speaker: 'Chair' })]);
    assert.equal(ownProgress.binding.status, 'supported', text);
  }
});

test('temporal wrapper cleanup does not erase meaningful dependency objects', () => {
  const result = assess(action('after the fallback server approval'), [source('I will review the inspection report after the server approval.')]);
  assert.equal(result.binding.status, 'unresolved');
  assert.equal(result.action.timing.wording, 'after the fallback server approval');
  const wrongFallback = assess(action('Preferred: Friday; fallback: Monday'), [source('I will review the inspection report Friday; I will arrange the training call Monday.')]);
  assert.equal(wrongFallback.binding.status, 'unsupported');
  assert.equal(wrongFallback.action.timing.wording, '');
});

test('a passive obligation does not get verified from the same subject with an opposite operation', () => {
  const row = action('28 November 2026', { action: 'Existing instruments must be entered in the equipment register by 28 November 2026.', owners: [], timing: { kind: 'deadline', wording: '28 November 2026', exactDate: '2026-11-28' } });
  const wrong = assess(row, [source('Existing instruments must be deleted from the equipment register by 28 November this year.')]);
  assert.notEqual(wrong.binding.status, 'supported');
  assert.notEqual(wrong.assessment.status, 'verified');
  const right = assess(row, [source('Existing instruments must be entered in the equipment register by 28 November this year.')]);
  assert.equal(right.binding.status, 'supported');
  assert.equal(right.action.timing.exactDate, '2026-11-28');
});

test('a shared calendar day cannot prove a conflicting clock, zone or part of day', () => {
  const row = action('Friday at10:30BST', { timing: { kind: 'deadline', wording: 'Friday at10:30BST', exactDate: '2026-10-23' } });
  for (const text of ['I will review the inspection report Friday at11:30GMT.', 'I will review the inspection report Friday at10:30GMT.']) {
    const result = assess(row, [source(text)]);
    assert.equal(result.binding.status, 'unsupported', text);
    assert.equal(result.binding.reason, 'clock_zone_or_day_part_conflict');
    assert.equal(result.action.timing.wording, '', text);
  }
  const good = assess(row, [source('I will review the inspection report Friday at 10:30 BST.')]);
  assert.equal(good.binding.status, 'supported');
  assert.equal(good.action.timing.wording, row.timing.wording);
  const unknown = assess(row, [source('I will review the inspection report Friday.')]);
  assert.equal(unknown.binding.status, 'unresolved');
  assert.equal(unknown.action.timing.wording, row.timing.wording);
  const dayPart = assess(action('Friday morning', { timing: { kind: 'target', wording: 'Friday morning', exactDate: '2026-10-23' } }), [source('I will review the inspection report Friday afternoon.')]);
  assert.equal(dayPart.binding.status, 'unsupported');
  const midnight = assess(action('Friday at00:30GMT', { timing: { kind: 'deadline', wording: 'Friday at00:30GMT', exactDate: '2026-10-23' } }), [source('I will review the inspection report Friday at12:30AM GMT.')]);
  assert.equal(midnight.binding.status, 'supported', 'explicit AM/PM formatting is equivalent without any zone conversion');
});

test('a later delivery limit does not hide the same work’s real morning date', () => {
  const units = [source("I'll order the replacement filters Monday morning so they arrive before the nineteenth.")];
  for (const wording of ['Monday morning', '10 August 2026']) {
    const row = action(wording, { action: 'Order the replacement filters.', timing: { kind: 'deadline', wording, exactDate: '2026-08-10' } });
    const result = T.assessActionTiming(row, units, { meetingDate: '2026-08-10' });
    assert.equal(result.binding.status, 'supported', wording);
    assert.equal(result.action.timing.wording, wording);
    assert.equal(result.action.timing.exactDate, '2026-08-10');
    assert.equal(result.issues.length, 0, wording);
  }
  const wrong = T.assessActionTiming(action('Monday morning', { timing: { kind: 'deadline', wording: 'Monday morning', exactDate: '2026-08-10' } }),
    [source('I will review the inspection report Monday afternoon; I will write the supplier letter Monday morning so it arrives before the nineteenth.')],
    { meetingDate: '2026-08-10' });
  assert.equal(wrong.binding.status, 'unsupported', 'a different same-turn task cannot donate its morning qualifier');
  assert.equal(wrong.action.timing.kind, 'not_stated');
});

test('decimal fees and measurements cannot prove a clock while explicit UK dotted times still can', () => {
  const row = action('Friday at13:50', { timing: { kind: 'deadline', wording: 'Friday at13:50', exactDate: '2026-10-23' } });
  for (const suffix of ['for13.50 pounds', 'for £13.50', 'for GBP13.50', 'for13.50 metres of cable', 'for13.50kg of material', 'for13.50']) {
    const result = assess(row, [source(`I will review the inspection report Friday ${suffix}.`)]);
    assert.equal(result.binding.status, 'unresolved', suffix);
    assert.notEqual(result.assessment.status, 'verified', suffix);
    assert.ok(result.issues.some(issue => issue.code === 'timing_source_unresolved' && issue.preserveValue), suffix);
  }
  const dotted = assess(row, [source('I will review the inspection report Friday at13.50.')]);
  assert.equal(dotted.binding.status, 'supported');
  assert.equal(dotted.action.timing.wording, row.timing.wording);
  const zoned = assess(action('Friday at13:50UTC', { timing: { kind: 'deadline', wording: 'Friday at13:50UTC', exactDate: '2026-10-23' } }),
    [source('I will review the inspection report Friday 13.50 UTC.')]);
  assert.equal(zoned.binding.status, 'supported');
});

test('ambiguous numeric dates, working-day intervals and durations retain wording without false precision', () => {
  for (const wording of ['04/05/2026', 'Friday 04/05/2026', 'within five working days', 'for five days']) {
    assert.equal(T.resolveExactDate(wording, anchor), '', wording);
    const row = action(wording, { timing: { kind: 'target', wording, exactDate: '2026-10-23' } });
    const result = assess(row, [source(`I will review the inspection report ${wording}.`)]);
    assert.equal(result.action.timing.exactDate, '', wording);
    assert.equal(result.action.timing.wording, wording);
    assert.ok(result.issues.some(issue => issue.code === 'unsupported_precision'), wording);
  }
});

test('a task after a dated call does not inherit the call day', () => {
  const row = action('Friday', { action: 'Send the inspection report after the planning call.', evidenceIds: ['T1', 'T2'], timing: { kind: 'deadline', wording: 'Friday', exactDate: '' } });
  const result = assess(row, [source('The planning call is Friday.'), source('I will send the inspection report after the planning call.', { id: 'T2' })]);
  assert.equal(result.binding.status, 'unsupported');
  assert.equal(result.action.timing.wording, '');
  assert.equal(result.action.action, row.action);
});

test('a monthless ordinal cannot keep an invented explicit month through unresolved task binding', () => {
  const units = [source('I need the calibration certificate before the inspection begins.'),
    source('The launch is on the ninth; let us use the sixth.', { id: 'T2', speaker: 'Chair' })];
  for (const wording of ['by 6 October', 'by 6 November']) {
    const row = action(wording, { action: 'Provide the calibration certificate before the inspection begins.', evidenceIds: ['T1', 'T2'] });
    const result = assess(row, units);
    assert.equal(result.binding.status, 'unsupported', wording);
    assert.equal(result.binding.reason, 'calendar_date_not_stated_in_cited_source');
    assert.equal(result.action.action, row.action);
    assert.equal(result.action.timing.kind, 'not_stated');
    assert.ok(result.issues.some(issue => issue.code === 'unsupported_date_wording'));
  }
  const stated = assess(action('by 6 November', { action: 'Provide the calibration certificate before the inspection begins.', evidenceIds: ['T1', 'T2'] }),
    [units[0], { ...units[1], text: 'Use 6 November for that handover.' }]);
  assert.notEqual(stated.binding.status, 'unsupported', 'incomplete task paraphrase is distinct from an absent calendar date');
  assert.equal(stated.action.timing.wording, 'by 6 November');
  const explicitRelative = assess(action('by 23 October', { action: 'Provide the calibration certificate before the inspection begins.', evidenceIds: ['T1', 'T2'] }),
    [units[0], { ...units[1], text: 'Friday is the day for that handover.' }]);
  assert.notEqual(explicitRelative.binding.status, 'unsupported', 'a valid cited relative date may establish the stated calendar day');
  assert.equal(explicitRelative.action.timing.wording, 'by 23 October');
  const fullDate = action('3 November 2026', { timing: { kind: 'deadline', wording: '3 November 2026', exactDate: '2026-11-03' } });
  const noAnchor = T.assessActionTiming(fullDate, [source('I will review the inspection report.')], { meetingDate: '' });
  assert.equal(noAnchor.binding.status, 'unsupported', 'an absent meeting date does not excuse an invented complete date');
  assert.equal(noAnchor.action.timing.kind, 'not_stated');
  const sourceDated = T.assessActionTiming(fullDate, [source('I will review the inspection report on 3 November 2026.')], { meetingDate: '' });
  assert.equal(sourceDated.binding.status, 'supported');
  assert.equal(sourceDated.action.timing.exactDate, '2026-11-03', 'a literal complete date needs no meeting anchor');
});

test('a matching unresolved semantic check is not upgraded by lexical binding', () => {
  const units = [source('I will review the inspection report next week.')];
  for (const checkerStatus of ['uncertain', 'missing', 'duplicate', 'malformed', 'rejected']) {
    const original = action('next week');
    const row = { ...original, timingDecision: { version: T.TIMING_POLICY_VERSION, ...T.timingAssessmentKey(original, units, anchor), status: 'unresolved', checkerStatus, checkerReason: 'Review needed', rejectedExactDates: [], rejectedWordings: [] } };
    const result = assess(row, units);
    assert.equal(result.binding.status, 'supported');
    assert.equal(result.assessment.status, 'unresolved');
    assert.equal(result.assessment.checkerStatus, checkerStatus);
    assert.equal(result.action.timing.wording, 'next week');
    assert.ok(result.issues.some(issue => issue.code === 'timing_check_unresolved' && issue.preserveValue));
    const changed = assess(row, [source('I will review the inspection report next week after the safety workshop.')]);
    assert.equal(changed.assessment.status, 'qualified', 'changed source invalidates the old semantic decision');
    assert.equal(changed.assessment.checkerStatus, undefined);
  }
});

test('true reviewer authority is preserved and source decisions stay scoped', () => {
  const units = [source('I will arrange the training call next week.')];
  const manual = action('next week', { reviewerAuthored: true });
  assert.equal(assess(manual, units).action, manual);
  const original = action('next week');
  const rejected = assess(original, units).action;
  const changedSource = [source('I will review the inspection report next week.')];
  assert.equal(assess({ ...original, timingDecision: rejected.timingDecision }, changedSource).binding.status, 'supported');
  const oldPolicy = { ...original, timingDecision: { ...rejected.timingDecision, version: T.TIMING_POLICY_VERSION - 1 } };
  assert.equal(T.assessmentMatches(oldPolicy, changedSource, anchor, oldPolicy.timingDecision), false);
  const otherOwner = { ...original, owners: ['Casey Patel'] };
  assert.equal(T.assessmentMatches(otherOwner, units, anchor, rejected.timingDecision), false);
});
