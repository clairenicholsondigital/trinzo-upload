'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../utils/meetingMinutesTiming');
const V = require('../utils/meetingMinutesAgentV2');
const { resolveEvidence } = require('../utils/meetingMinutesEvidenceResolution');
const anchor = '2026-08-05';
const record = (timing, extra = {}) => ({ id: 'work', action: 'Send the supplier questionnaire.', owners: ['Morgan Taylor'], evidenceIds: ['T0001'], reviewFlagIds: [], timing, ...extra });

test('calendar validation rejects rollover dates and accepts real leap days', () => {
  for (const value of ['2026-02-29', '2026-02-31', '2026-04-31', '2026-13-01', '2026-00-15', '0000-01-01', '2026-1-01']) assert.equal(T.isValidCalendarDate(value), false, value);
  for (const value of ['2024-02-29', '2000-02-29', '2026-12-31']) assert.equal(T.isValidCalendarDate(value), true, value);
  assert.equal(T.isValidCalendarDate('1900-02-29'), false);
  assert.equal(T.formatCalendarDate('2026-02-31'), '');
  assert.equal(V.sanitiseDetails({ meetingDate: '2026-02-31' }).meetingDate, '');
});

test('specific relative days use a valid anchor through month and year boundaries', () => {
  assert.equal(T.resolveExactDate('tomorrow', '2026-12-31'), '2027-01-01');
  assert.equal(T.resolveExactDate('tomorrow', '2024-02-28'), '2024-02-29');
  assert.equal(T.resolveExactDate('today', '2026-02-31'), '');
  assert.equal(T.resolveExactDate('within ten days', anchor), '2026-08-15');
});

test('periods, ambiguity, ranges and dependencies do not become precise days', () => {
  for (const wording of ['this week', 'next week', 'presumably early next week', 'three to four weeks', '27 July to 7 August', 'the ninth or the tenth', 'once the draft arrives; a week to review it', 'within two weeks after approval', 'before the first on-site week', 'by the second in-person training day', 'the first month', 'next Tuesday', 'two weeks', 'for five days', 'in five business days', 'Preferred: before Thursday; fallback: Friday', 'last Friday', 'previous Friday', 'Friday last week', 'tomorrow or Friday', 'not Friday', 'no earlier than Friday', 'not before Friday', 'at the earliest Friday']) {
    assert.equal(T.resolveExactDate(wording, anchor), '', wording);
  }
  assert.equal(T.resolveExactDate('the 17th', anchor), '', 'no unsupported month inference');
  assert.equal(T.resolveExactDate('within two weeks', anchor), '2026-08-19', 'an explicit inclusive due interval has an anchored last allowed day');
  assert.match(T.formatTimingLabel({ kind: 'deadline', wording: 'within two weeks', exactDate: '2026-08-19' }), /within two weeks.*19 Aug 2026/);
  assert.equal(T.resolveExactDate('not later than Friday', anchor), '2026-08-07', 'an explicit inclusive upper bound remains useful');
});

test('a qualified named day still has a real calendar day and retains the qualifier', () => {
  assert.equal(T.resolveExactDate('this weekend, Saturday morning probably', anchor), '2026-08-08');
  const value = T.normaliseTimingValue({ kind: 'deadline', wording: 'probably Saturday morning', exactDate: '' }, { meetingDate: anchor, mode: 'derive' });
  assert.equal(value.kind, 'target');
  assert.equal(value.wording, 'probably Saturday morning');
  assert.equal(value.exactDate, '2026-08-08');
  assert.match(T.formatTimingLabel(value), /probably Saturday morning.*8 Aug 2026/);
  const source = [{ id: 'T0001', speaker: 'Morgan Taylor', text: 'I will send the supplier questionnaire preferably Friday.' }];
  const preferred = V.finaliseActionTimings([record({ kind: 'deadline', wording: 'preferably Friday', exactDate: '2026-08-07' })], source, { meetingDate: anchor });
  assert.equal(preferred.actions[0].timing.kind, 'target', 'a preference is not a firm generated deadline');
  assert.equal(preferred.actions[0].timing.exactDate, '2026-08-07');
});

test('explicit dates are calendar checked without automatic future-year rollover', () => {
  assert.equal(T.explicitCalendarDate('31 February 2026', anchor), '');
  assert.equal(T.resolveExactDate('29 February 2026', anchor), '');
  assert.equal(T.explicitCalendarDate('17 March', anchor), '2026-03-17');
  assert.equal(T.explicitCalendarDate('17 March next year', anchor), '2027-03-17');
  assert.equal(T.explicitCalendarDate('3 November 2026', ''), '2026-11-03');
});

test('initial derivation and preservation are explicit different operations', () => {
  const timing = { kind: 'target', wording: 'tomorrow', exactDate: '' };
  assert.equal(T.normaliseTimingValue(timing, { meetingDate: anchor, mode: 'derive' }).exactDate, '2026-08-06');
  assert.equal(T.normaliseTimingValue(timing, { meetingDate: anchor, mode: 'preserve' }).exactDate, '');
  assert.equal(T.normaliseTimingValue(timing, { meetingDate: anchor }).exactDate, '');
});

test('an unrelated cited date cannot support an action with an invented exact date', () => {
  const action = record({ kind: 'target', wording: '', exactDate: '2026-11-03' });
  const source = [{ id: 'T0001', speaker: 'Morgan Taylor', text: 'The equipment calibration is scheduled for 3 November 2026.' }];
  const result = V.finaliseActionTimings([action], source, { meetingDate: anchor });
  assert.equal(result.actions[0].timing.exactDate, '');
  assert.equal(result.flags.length, 1);
  assert.equal(result.assessments[0].status, 'rejected');
});

test('the source-bound date survives while an invalid date produces a precise review flag', () => {
  const source = [{ id: 'T0001', speaker: 'Morgan Taylor', text: 'I will send the supplier questionnaire on 3 November 2026.' }];
  const good = V.finaliseActionTimings([record({ kind: 'deadline', wording: '3 November 2026', exactDate: '2026-11-03' })], source, { meetingDate: anchor });
  assert.equal(good.actions[0].timing.exactDate, '2026-11-03');
  assert.equal(good.flags.length, 0);
  const bad = V.finaliseActionTimings([record({ kind: 'deadline', wording: '31 February 2026', exactDate: '2026-02-31' })], source, { meetingDate: anchor });
  assert.equal(bad.actions[0].timing.exactDate, '');
  assert.match(bad.flags[0].message, /not a real calendar date/);
});

test('a genuine source-stated past due date stays visible as potentially overdue', () => {
  const action = record({ kind: 'deadline', wording: '3 July 2026', exactDate: '2026-07-03' });
  const source = [{ id: 'T0001', speaker: 'Morgan Taylor', text: 'The supplier questionnaire was due on 3 July 2026 and I still need to send it.' }];
  const result = V.finaliseActionTimings([action], source, { meetingDate: anchor });
  assert.equal(result.actions[0].timing.exactDate, '2026-07-03');
  assert.match(result.flags[0].message, /overdue/);
});

test('a source weekday/date contradiction is retained for review without date rollover', () => {
  const source = [{ id: 'T0001', speaker: 'Morgan Taylor', text: 'I will send the supplier questionnaire on Friday 3 November 2026.' }];
  const result = V.finaliseActionTimings([record({ kind: 'deadline', wording: 'Friday 3 November 2026', exactDate: '2026-11-03' })], source, { meetingDate: anchor });
  assert.equal(result.actions[0].timing.exactDate, '2026-11-03');
  assert.match(result.flags[0].message, /weekday.*does not match/);
});

test('a source-bound rejection survives backfill and renormalisation without revival', () => {
  const source = [{ id: 'T0001', speaker: 'Morgan Taylor', text: 'I will send the supplier questionnaire tomorrow.' }];
  const original = record({ kind: 'target', wording: 'tomorrow', exactDate: '2026-08-06' });
  const rejected = T.rejectActionTiming(original, source, { meetingDate: anchor, field: 'exactDate', reason: 'checker_rejected_exact_date' });
  const normalised = V.normaliseAgentResult({ actions: [rejected] }, source, 'actions', { meetingDate: anchor });
  const backfill = V.backfillActionCommitmentEvidence(normalised.actions, source, { meetingDate: anchor });
  const final = V.finaliseActionTimings(backfill, source, { meetingDate: anchor });
  assert.equal(final.actions[0].timing.wording, 'tomorrow');
  assert.equal(final.actions[0].timing.exactDate, '');
  assert.deepEqual(final.actions[0].timingDecision.rejectedExactDates, ['2026-08-06']);
  assert.deepEqual(original.timing.exactDate, '2026-08-06', 'original candidate remains unchanged');
});

test('source assessments cannot attach to an unrelated reused action id', () => {
  const source = [{ id: 'T0001', speaker: 'Morgan Taylor', text: 'I will send the supplier questionnaire tomorrow.' }, { id: 'T0002', speaker: 'Morgan Taylor', text: 'I will review the inspection checklist tomorrow.' }];
  const rejected = T.rejectActionTiming(record({ kind: 'target', wording: 'tomorrow', exactDate: '2026-08-06' }), source, { meetingDate: anchor, field: 'exactDate' });
  const other = record({ kind: 'target', wording: 'tomorrow', exactDate: '2026-08-06' }, { action: 'Review the inspection checklist.', evidenceIds: ['T0002'] });
  const result = V.finaliseActionTimings([other], source, { meetingDate: anchor, assessments: [rejected.timingDecision] });
  assert.equal(result.actions[0].timing.exactDate, '2026-08-06');
});

test('a previous timing-policy rejection cannot block valid source under the current policy', () => {
  const source = [{ id: 'T0001', speaker: 'Morgan Taylor', text: 'I will send the supplier questionnaire tomorrow.' }];
  const original = record({ kind: 'target', wording: 'tomorrow', exactDate: '2026-08-06' });
  const rejected = T.rejectActionTiming(original, source, { meetingDate: anchor, field: 'all' });
  const restored = { ...original, timingDecision: { ...rejected.timingDecision, version: T.TIMING_POLICY_VERSION - 1 } };
  assert.equal(T.assessmentMatches(restored, source, anchor, restored.timingDecision), false);
  assert.equal(V.finaliseActionTimings([restored], source, { meetingDate: anchor }).actions[0].timing.exactDate, '2026-08-06');
});

test('the same wording for different owners cannot inherit another person’s rejection', () => {
  const source = [{ id: 'T0001', speaker: 'Chair', text: 'Morgan Taylor and Casey Patel will each send the supplier questionnaire tomorrow.' }];
  const rejected = T.rejectActionTiming(record({ kind: 'target', wording: 'tomorrow', exactDate: '2026-08-06' }), source, { meetingDate: anchor, field: 'exactDate' });
  const other = record({ kind: 'target', wording: 'tomorrow', exactDate: '2026-08-06' }, { owners: ['Casey Patel'] });
  assert.equal(T.assessmentMatches(other, source, anchor, rejected.timingDecision), false);
  assert.equal(V.finaliseActionTimings([other], source, { meetingDate: anchor, assessments: [rejected.timingDecision] }).actions[0].timing.exactDate, '2026-08-06');
});

test('two dated operations in one turn retain their own source-bound dates', () => {
  const source = [{ id: 'T0001', speaker: 'Chair', text: 'Morgan Taylor to review the inspection report Friday, Casey Patel to write the supplier letter Monday.' }];
  const rows = [record({ kind: 'deadline', wording: 'Friday', exactDate: '2026-08-07' }, { action: 'Review the inspection report.' }), record({ kind: 'deadline', wording: 'Monday', exactDate: '2026-08-10' }, { action: 'Write the supplier letter.', owners: ['Casey Patel'] })];
  assert.deepEqual(V.finaliseActionTimings(rows, source, { meetingDate: anchor }).actions.map(row => row.timing.exactDate), ['2026-08-07', '2026-08-10']);
});

test('an exact source-matched imperative need not appear in a verb allowlist', () => {
  const source = [{ id: 'T0001', speaker: 'Morgan Taylor', text: 'I will ship the replacement sensor Saturday.' }];
  const value = record({ kind: 'deadline', wording: 'Saturday', exactDate: '2026-08-08' }, { action: 'Ship the replacement sensor.' });
  assert.equal(V.finaliseActionTimings([value], source, { meetingDate: anchor }).actions[0].timing.exactDate, '2026-08-08');
});

test('a short timing clause cannot skip a nearer different work object in the same turn', () => {
  const source = [
    { id: 'T0001', speaker: 'Morgan Taylor', text: 'I will send the inspection report Friday.' },
    { id: 'T0002', speaker: 'Morgan Taylor', text: 'For the training pack, ideally Monday, but Wednesday is the hard stop.' }
  ];
  const value = record({ kind: 'target', wording: 'Monday', exactDate: '2026-08-10' }, {
    action: 'Send the inspection report.', evidenceIds: ['T0001', 'T0002']
  });
  const result = V.finaliseActionTimings([value], source, { meetingDate: anchor });
  assert.equal(result.actions[0].timing.exactDate, '');
  assert.equal(result.actions[0].timingDecision.status, 'rejected');
  assert.ok(result.flags.length, 'retain a reviewable account of the unsupported timing');
});

test('same-task and temporal-only short answers still use their real antecedent', () => {
  const opening = { id: 'T0001', speaker: 'Morgan Taylor', text: 'I will send the inspection report Friday.' };
  for (const text of ['For the inspection report, ideally Monday.', 'Ideally Monday.']) {
    const source = [opening, { id: 'T0002', speaker: 'Morgan Taylor', text }];
    const value = record({ kind: 'target', wording: 'ideally Monday', exactDate: '2026-08-10' }, { action: 'Send the inspection report.', evidenceIds: ['T0001', 'T0002'] });
    const result = V.finaliseActionTimings([value], source, { meetingDate: anchor });
    assert.equal(result.actions[0].timing.exactDate, '2026-08-10', text);
  }
  const source = [{ id: 'T0001', speaker: 'Morgan Taylor', text: 'I will send the inspection report, ideally Monday.' }];
  const value = record({ kind: 'target', wording: 'ideally Monday', exactDate: '2026-08-10' }, { action: 'Send the inspection report.' });
  assert.equal(V.finaliseActionTimings([value], source, { meetingDate: anchor }).actions[0].timing.exactDate, '2026-08-10');
});

test('a date on another operation, owner or recipient is not donated to this task', () => {
  const examples = [
    { action: 'Review the inspection report.', owners: ['Morgan Taylor'], text: 'I will draft the inspection report Friday.' },
    { action: 'Review the inspection report.', owners: ['Casey Patel'], text: 'Morgan Taylor will review the inspection report Friday; Casey Patel will review the inspection report Monday.' },
    { action: 'Send the inspection report to Casey Patel.', owners: ['Morgan Taylor'], text: 'I will send the inspection report to Jamie Reed Friday; I will send the inspection report to Casey Patel Monday.' }
  ];
  for (const item of examples) {
    const source = [{ id: 'T0001', speaker: 'Morgan Taylor', text: item.text }];
    const value = record({ kind: 'target', wording: 'Friday', exactDate: '2026-08-07' }, { action: item.action, owners: item.owners });
    assert.equal(V.finaliseActionTimings([value], source, { meetingDate: anchor }).actions[0].timing.exactDate, '', item.text);
  }
});

test('a same-turn referential send promise keeps its date and shortened addressed recipient', () => {
  const value = record({ kind: 'deadline', wording: 'Today', exactDate: anchor }, { action: 'Send the supplier questionnaire to Casey Patel.' });
  const source = [
    { id: 'T0001', speaker: 'Morgan Taylor', text: "I have the supplier questionnaire, so I'll get that over to you today as well, Casey." },
    { id: 'T0002', speaker: 'Casey Patel', text: 'Thank you.' }
  ];
  const result = V.finaliseActionTimings([value], source, { meetingDate: anchor });
  assert.equal(result.actions[0].timing.exactDate, anchor);
  assert.equal(result.flags.length, 0);
  const explicit = [{ ...source[0], text: 'I will send the supplier questionnaire to Casey today.' }, source[1]];
  assert.equal(V.finaliseActionTimings([value], explicit, { meetingDate: anchor }).actions[0].timing.exactDate, anchor);
});

test('activity-shaped nouns remain part of the source-bound work object', () => {
  const value = record({ kind: 'deadline', wording: 'Friday', exactDate: '2026-08-07' }, { action: 'Review the quality of finish.' });
  const source = [{ id: 'T0001', speaker: 'Morgan Taylor', text: 'I will check the quality of finish Friday.' }];
  assert.equal(V.finaliseActionTimings([value], source, { meetingDate: anchor }).actions[0].timing.exactDate, '2026-08-07');
  const otherObject = [{ ...source[0], text: 'I will check the quality of installation Friday.' }];
  assert.equal(V.finaliseActionTimings([value], otherObject, { meetingDate: anchor }).actions[0].timing.exactDate, '');
});

test('coordinated nominal activities are not parsed as an extra imperative', () => {
  const value = record({ kind: 'deadline', wording: 'Friday', exactDate: '2026-08-07' }, { action: 'Review the inspection and maintenance records.' });
  const source = [{ id: 'T0001', speaker: 'Morgan Taylor', text: 'I will check the inspection and maint records Friday.' }];
  assert.equal(V.finaliseActionTimings([value], source, { meetingDate: anchor }).actions[0].timing.exactDate, '2026-08-07');
  for (const action of ['Review the inspection records and archive the maintenance file.', 'Review the inspection and position sensors.']) {
    const wrongScope = record({ kind: 'deadline', wording: 'Friday', exactDate: '2026-08-07' }, { action });
    assert.equal(V.finaliseActionTimings([wrongScope], source, { meetingDate: anchor }).actions[0].timing.exactDate, '', action);
  }
});

test('referential send timing cannot cross a nearer object, different owner or recipient, or ambiguous name', () => {
  const value = record({ kind: 'deadline', wording: 'Today', exactDate: anchor }, { action: 'Send the supplier questionnaire to Casey Patel.' });
  for (const source of [
    [{ id: 'T0001', speaker: 'Morgan Taylor', text: "I have the supplier questionnaire, but the inspection report is ready, so I'll get that over to you today, Casey." }],
    [{ id: 'T0001', speaker: 'Jamie Reed', text: "I have the supplier questionnaire, so I'll get that over to you today, Casey." }],
    [{ id: 'T0001', speaker: 'Morgan Taylor', text: "I have the supplier questionnaire, so I'll get that over to you today, Jamie." }],
    [{ id: 'T0001', speaker: 'Morgan Taylor', text: 'I will send the supplier questionnaire to Casey Lee today.' }],
    [{ id: 'T0001', speaker: 'Morgan Taylor', text: "I have the supplier questionnaire, so I'll get that over to you today, Casey." }, { id: 'T0002', speaker: 'Casey Patel', text: 'Okay.' }, { id: 'T0003', speaker: 'Casey Lee', text: 'Okay.' }]
  ]) {
    const result = V.finaliseActionTimings([value], source, { meetingDate: anchor });
    assert.equal(result.actions[0].timing.exactDate, '', source[0].text);
    assert.ok(result.flags.length);
  }
});

test('generated JSON cannot grant itself reviewer authority over an invalid date', () => {
  const source = [{ id: 'T0001', speaker: 'Morgan Taylor', text: 'I will send the supplier questionnaire tomorrow.' }];
  const result = V.normaliseAgentResult({ actions: [record({ kind: 'target', wording: 'tomorrow', exactDate: '2026-02-31' }, { reviewerAuthored: true })] }, source, 'actions', { meetingDate: anchor });
  assert.equal(result.actions[0].timing.exactDate, '');
  assert.equal(result.actions[0].reviewerAuthored, undefined);
  assert.ok(result.reviewFlags.some(flag => /not a real calendar date/.test(flag.message)));
});

test('an explicit this-year date supports its year without licensing unrelated numeric claims', () => {
  const source = V.normaliseSourceUnits([{ id: 'T0001', speaker: 'Morgan Taylor', text: 'The supplier registration deadline is 28 November this year.' }]);
  const result = resolveEvidence('The supplier registration deadline is 28 November 2026.', source, ['T0001'], { meetingDate: anchor });
  assert.ok(result.evidenceIds.includes('T0001'));
  assert.deepEqual(resolveEvidence('There are 2026 supplier registrations.', source, [], { meetingDate: anchor }).evidenceIds, []);
  assert.deepEqual(resolveEvidence('The supplier registration deadline is 28 November 2027.', source, [], { meetingDate: anchor }).evidenceIds, []);
});

test('a later this-year date is supported without borrowing another date’s year or unrelated quantities', () => {
  const source = V.normaliseSourceUnits([{ id: 'T0001', speaker: 'Morgan Taylor', text: 'We passed 28 May, but the supplier registration deadline is 28 November this year.' }]);
  const claim = 'The supplier registration deadline is 28 November 2026.';
  assert.ok(resolveEvidence(claim, source, ['T0001'], { meetingDate: anchor }).evidenceIds.includes('T0001'));
  assert.ok(V.normaliseAgentResult({ discussion: [{ topic: 'Supplier registration', points: [{ text: claim, evidenceIds: ['T0001'] }] }] }, source, 'discussion', { meetingDate: anchor }).discussion[0].points[0].evidenceIds.includes('T0001'));
  assert.deepEqual(resolveEvidence('There are 2026 supplier registrations.', source, [], { meetingDate: anchor }).evidenceIds, []);
  assert.deepEqual(resolveEvidence('The supplier registration deadline is 28 November 2027.', source, [], { meetingDate: anchor }).evidenceIds, []);
  const mixed = V.normaliseSourceUnits([{ id: 'T0001', speaker: 'Morgan Taylor', text: 'The inspection is 28 May next year, but the supplier registration deadline is 28 November this year.' }]);
  assert.deepEqual(T.explicitCalendarDates(mixed[0].text, anchor), ['2027-05-28', '2026-11-28']);
  assert.deepEqual(resolveEvidence('The supplier registration deadline is 28 November 2027.', mixed, [], { meetingDate: anchor }).evidenceIds, []);
});

test('citation limits retain the supplied defining date and its nearby qualification', () => {
  const source = V.normaliseSourceUnits([
    ...Array.from({ length: 9 }, (_, index) => ({ id: `T${String(index + 1).padStart(4, '0')}`, speaker: 'Chair', text: 'The supplier registration deadline remains a planning concern.' })),
    { id: 'T0010', speaker: 'Chair', text: 'The supplier registration deadline is 28 November 2026.' },
    { id: 'T0011', speaker: 'Chair', text: 'Preferably complete the preparation a week earlier.' }
  ]);
  const result = resolveEvidence('The supplier registration deadline is 28 November 2026.', source, source.map(row => row.id), { meetingDate: anchor });
  assert.ok(result.evidenceIds.includes('T0010'));
  assert.ok(result.evidenceIds.includes('T0011'));
  assert.ok(result.evidenceIds.length <= 8);
});

test('action normalisation retains the supplied direct timing line before the citation cap', () => {
  const source = V.normaliseSourceUnits([
    { id: 'T0001', speaker: 'Morgan Taylor', text: 'I will start the vibration endurance testing.' },
    ...Array.from({ length: 10 }, (_, index) => ({ id: `T${String(index + 2).padStart(4, '0')}`, speaker: 'Chair', text: 'The vibration endurance testing remains the next engineering activity.' })),
    { id: 'T0012', speaker: 'Chair', text: 'Your main focus is the assembly review and the testing, presumably early next week to start the testing at least.' }
  ]);
  const value = record({ kind: 'target', wording: 'presumably early next week', exactDate: '' }, { action: 'Start the vibration endurance testing.', evidenceIds: source.map(unit => unit.id) });
  const result = V.normaliseActions({ actions: [value] }, source, { meetingDate: anchor });
  assert.equal(result.length, 1);
  assert.ok(result[0].evidenceIds.includes('T0012'), 'the direct supplied field source is not lost to noun-heavy anchors or the cap');
  assert.ok(result[0].evidenceIds.length <= 8);
  assert.equal(result[0].timing.wording, 'presumably early next week');
  assert.equal(result[0].timing.exactDate, '');
});

test('retaining a direct timing citation cannot turn a wrong-operation or wrong-owner date into authority', () => {
  for (const sourceText of ['I will draft the inspection report Friday.', 'Casey Patel will review the inspection report Friday.']) {
    const source = V.normaliseSourceUnits([{ id: 'T0001', speaker: 'Morgan Taylor', text: sourceText }]);
    const value = record({ kind: 'deadline', wording: 'Friday', exactDate: '2026-08-07' }, { action: 'Review the inspection report.' });
    const result = V.normaliseActions({ actions: [value] }, source, { meetingDate: anchor, enforceEvidence: false });
    assert.equal(result.length, 1);
    assert.equal(result[0].timing.exactDate, '', sourceText);
  }
});

test('reviewer timing remains literal while invalid input is flagged', () => {
  const action = record({ kind: 'target', wording: 'Reviewer target', exactDate: '2026-02-31' }, { reviewerAuthored: true });
  const result = V.finaliseActionTimings([action], [], { meetingDate: anchor });
  assert.equal(result.actions[0].timing.exactDate, '2026-02-31');
  assert.match(result.flags[0].message, /reviewer-entered/);
  assert.equal(T.formatCalendarDate(action.timing.exactDate), '');
});

test('wording-only retention does not claim source binding was verified', () => {
  const result = V.finaliseActionTimings([record({ kind: 'target', wording: 'early next week', exactDate: '' })], [], { meetingDate: anchor });
  assert.notEqual(result.assessments[0].status, 'verified');
  assert.equal(result.actions[0].timing.wording, 'early next week');
});
