'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../utils/meetingMinutesAgentV2');
const T = require('../utils/meetingMinutesTiming');
const { mergeCommitmentDuplicates } = require('../utils/canonicalMinutes/commitmentDuplicates');

const meetingDate = '2026-10-21';
const options = { meetingDate };
const row = (action, extra = {}) => ({ id: 'work', action, owners: ['Sam'], evidenceIds: ['T0001', 'T0002'],
  reviewFlagIds: [], timing: { kind: 'deadline', wording: 'Friday', exactDate: '2026-10-23' }, ...extra });

test('a source-rejected date cannot revive through normalization, backfill, merge and final assessment', () => {
  const units = [
    { id: 'T0001', speaker: 'Sam', text: 'The planning call is Friday.' },
    { id: 'T0002', speaker: 'Sam', text: 'I will file the inspection report after the planning call.' }
  ];
  const original = row('File the inspection report.');
  const items = V.timingCheckItems([original], units, options);
  const reviewed = V.applyTimingCheckResults([original], items, [{ id: items[0].id,
    verdict: 'belongs_to_other_step', timingQuote: 'Friday', stepQuote: 'The planning call is Friday', correctTiming: '' }], options);
  assert.equal(reviewed.actions[0].timing.kind, 'not_stated');
  assert.deepEqual(reviewed.actions[0].timingDecision.rejectedExactDates, ['2026-10-23']);
  const saved = V.normaliseAgentResult({ actions: reviewed.actions }, units, '', { ...options, enforceEvidence: false, dedupeActions: false });
  const recovered = V.backfillActionCommitmentEvidence(saved.actions, units, options);
  const merged = mergeCommitmentDuplicates([recovered[0], { ...recovered[0], id: 'copy' }]).actions;
  const final = merged.map(action => T.assessActionTiming(action, units, options).action);
  assert.ok(final.every(action => action.timing.kind === 'not_stated' && !action.timing.exactDate));
  assert.ok(final.every(action => action.timingDecision.rejectedWordings.includes('Friday')));
});

test('a rejected date applies to an equivalent editing variant, not another operation or another source', () => {
  const units = [
    { id: 'T0001', speaker: 'Sam', text: 'The training call is Friday.' },
    { id: 'T0002', speaker: 'Sam', text: 'I will update the access policy after the training call.' },
    { id: 'T0003', speaker: 'Sam', text: 'I will send the access policy Friday.' }
  ];
  const rejected = T.rejectActionTiming(row('Complete updates to the access policy.'), units, { ...options, reason: 'source_step_mismatch' });
  const equivalent = row('Update the access policy.', { id: 'equivalent' });
  const distinct = row('Send the access policy.', { id: 'send', evidenceIds: ['T0001', 'T0003'] });
  const result = V.reconcileSiblingTimingDecisions([rejected, equivalent, distinct], units, options);
  assert.equal(result.actions[1].timing.kind, 'not_stated');
  assert.deepEqual(result.actions[2].timing, distinct.timing);
  const changedSource = units.map(unit => unit.id === 'T0002' ? { ...unit, text: 'I will update the access policy Friday.' } : unit);
  assert.deepEqual(V.reconcileSiblingTimingDecisions([rejected, equivalent], changedSource, options).actions[1].timing, equivalent.timing);
});

test('timing verification includes exact-only values and rejects a stale action snapshot', () => {
  const units = [{ id: 'T0001', speaker: 'Sam', text: 'I will send the inspection report on 23 October 2026.' }];
  const original = row('Send the inspection report.', { evidenceIds: ['T0001'], timing: { kind: 'target', wording: '', exactDate: '2026-10-23' } });
  const items = V.timingCheckItems([original], units, options);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].timing, original.timing);
  assert.match(V.timingCheckPrompt(items, meetingDate), /"exactDate":"2026-10-23"/);
  assert.match(V.timingCheckPrompt(items, meetingDate), /deadline\/target\/dependency/);
  const changed = { ...original, action: 'Archive the inspection report.' };
  const result = V.applyTimingCheckResults([changed], items, [{ id: items[0].id, verdict: 'misread', timingQuote: '23 October 2026' }], options);
  assert.deepEqual(result.actions, [changed]);
  assert.equal(result.rejected[0].reason, 'stale_action_snapshot');
});

test('a correct wording verdict cannot validate a conflicting exact date', () => {
  const units = [{ id: 'T0001', speaker: 'Sam', text: 'I will send the inspection report on 23 October 2026.' }];
  const original = row('Send the inspection report.', { evidenceIds: ['T0001'],
    timing: { kind: 'deadline', wording: '23 October 2026', exactDate: '2026-10-24' } });
  const items = V.timingCheckItems([original], units, options);
  const result = V.applyTimingCheckResults([original], items, [{ id: items[0].id, verdict: 'correct',
    timingQuote: '23 October 2026', stepQuote: 'send the inspection report' }], options);
  assert.equal(result.actions[0].timing.exactDate, '');
  assert.equal(result.actions[0].timing.wording, original.timing.wording);
  assert.ok(result.flags.length);
  assert.ok(result.actions[0].timingDecision.rejectedExactDates.includes('2026-10-24'));
});

test('explicit multi-owner splitting binds each child to its own source timing', () => {
  const units = [{ id: 'T0001', speaker: 'Chair', text: 'Sam to review the inspection report Friday, Jordan to write the supplier letter Monday.' }];
  const original = row('Review the inspection report and write the supplier letter.', { owners: ['Sam', 'Jordan'], evidenceIds: ['T0001'] });
  const split = V.splitExplicitMultiOwnerActions([original], units, options);
  assert.equal(split.split, 1);
  assert.deepEqual(split.actions.map(action => action.owners), [['Sam'], ['Jordan']]);
  assert.equal(split.actions[0].timing.wording, 'Friday');
  assert.match(split.actions[1].timing.wording, /^monday$/i);
  assert.notEqual(split.actions[1].timing.exactDate, original.timing.exactDate);
  assert.ok(split.flags.length);
  const reprocessed = V.backfillActionCommitmentEvidence(split.actions, units, options);
  assert.notEqual(reprocessed[1].timing.exactDate, original.timing.exactDate);
  const final = V.finaliseActionTimings(reprocessed, units, options);
  assert.equal(final.actions[0].timing.exactDate, '2026-10-23');
  assert.equal(final.actions[1].timing.exactDate, '2026-10-26', 'the second owner retains the Monday stated for their own work');
});

test('completeness cannot donate the original deadline to added work', () => {
  const units = [
    { id: 'T0001', speaker: 'Sam', text: 'I will call the maintenance contractor Friday.' },
    { id: 'T0002', speaker: 'Sam', text: 'I will arrange replacement of the cooling pump after the production trial.' }
  ];
  const original = row('Call the maintenance contractor about the cooling pump.');
  const items = V.actionCompletenessCheckItems([original], units);
  const result = V.applyActionCompletenessResults([original], items, [{ id: items[0].id, verdict: 'corrected',
    problemQuote: original.action, evidenceQuote: units[1].text,
    correctedAction: 'Call the maintenance contractor and arrange replacement of the cooling pump.' }], options);
  assert.equal(result.corrected, 1);
  assert.equal(result.actions[0].timing.kind, 'not_stated');
  assert.ok(result.flags.length);
  assert.equal(result.actions[0].timingDecision.previousTiming.exactDate, '2026-10-23');
  assert.equal(V.backfillActionCommitmentEvidence(result.actions, units, options)[0].timing.kind, 'not_stated');
});

test('a source-bound completeness detail keeps the genuine timing', () => {
  const units = [{ id: 'T0001', speaker: 'Sam', text: 'I will send the inspection report with the supporting appendix and compliance checklist Friday.' }];
  const original = row('Send the inspection report.', { evidenceIds: ['T0001'] });
  const items = V.actionCompletenessCheckItems([original], units);
  const result = V.applyActionCompletenessResults([original], items, [{ id: items[0].id, verdict: 'corrected',
    problemQuote: original.action, evidenceQuote: units[0].text,
    correctedAction: 'Send the inspection report with the supporting appendix and compliance checklist.' }], options);
  assert.equal(result.corrected, 1);
  assert.deepEqual(result.actions[0].timing, original.timing);
});

test('reviewer timing and intentional compounds survive all automatic lifecycle transforms', () => {
  const units = [{ id: 'T0001', speaker: 'Chair', text: 'Sam to review the report, Jordan to write the letter.' }];
  const original = row('Review the report and write the letter.', { reviewerAuthored: true, owners: ['Sam', 'Jordan'], evidenceIds: ['T0001'] });
  assert.deepEqual(V.backfillActionCommitmentEvidence([original], units, options), [original]);
  assert.deepEqual(V.applyTimingClauseChecks([original], units, options).actions, [original]);
  assert.deepEqual(V.applyChainedTimingRule([original], units, options).actions, [original]);
  assert.deepEqual(V.splitExplicitMultiOwnerActions([original], units, options).actions, [original]);
  assert.deepEqual(V.timingCheckItems([original], units, options), []);
  assert.deepEqual(V.applyTimingCheckResults([original], [], [], options).actions, [original]);
});

test('a requester can qualify a read-back date and state a later linked contingency for the same work', () => {
  const units = [
    { id: 'T0001', speaker: 'Morgan', text: 'Then you will provide the inspection certificate, which I need before the trial starts.' },
    { id: 'T0002', speaker: 'Chair', text: 'The 24th, so by the 21st then.' },
    { id: 'T0003', speaker: 'Morgan', text: 'Twenty-first, I would say.' },
    { id: 'T0004', speaker: 'Chair', text: 'For the inspection certificate, if Sam waits till the 21st, can you access it before you leave?' },
    { id: 'T0005', speaker: 'Morgan', text: 'Ideally it would be good before I leave.' },
    { id: 'T0006', speaker: 'Morgan', text: 'I think ideally it might be worth thinking about instead of going to the 21st as the hard stop, it might be worth thinking about it the week before.' },
    { id: 'T0007', speaker: 'Sam', text: 'I will front load everything as much as possible.' },
    { id: 'T0008', speaker: 'Morgan', text: 'If not, then we do have that second week up to the 21st as contingency, just in case.' }
  ];
  const original = row('Complete and provide the inspection certificate.', { evidenceIds: ['T0001', 'T0002', 'T0003', 'T0005', 'T0006', 'T0008'],
    timing: { kind: 'deadline', wording: 'By the 21st before the trial starts', exactDate: '' } });
  const items = V.timingCheckItems([original], units, options);
  const verdict = { id: items[0].id, verdict: 'qualified', timingQuote: 'Twenty-first, I would say',
    stepQuote: 'inspection certificate, which I need before the trial starts',
    qualificationQuote: units[5].text.slice(0, -1), preferredTiming: 'the week before', fallbackTiming: 'up to the 21st as contingency' };
  const result = V.applyTimingCheckResults([original], items, [verdict], options);
  assert.equal(result.actions[0].timing.kind, 'target');
  assert.equal(result.actions[0].timing.wording, 'Preferred: the week before; fallback: up to the 21st as contingency');
  assert.equal(result.actions[0].timing.exactDate, '');
  assert.deepEqual(result.rejected, []);
  const switched = units.map(unit => unit.id === 'T0007'
    ? { ...unit, text: 'I will prepare the training pack.' } : unit);
  const switchedItems = V.timingCheckItems([original], switched, options);
  const blocked = V.applyTimingCheckResults([original], switchedItems, [{ ...verdict, id: switchedItems[0].id }], options);
  assert.deepEqual(blocked.actions, [original], 'a new work item before the contingency breaks the reference');
  const otherOwner = units.map(unit => unit.id === 'T0004'
    ? { ...unit, text: 'Dana will provide the inspection certificate by the 21st.' } : unit);
  const otherItems = V.timingCheckItems([original], otherOwner, options);
  assert.deepEqual(V.applyTimingCheckResults([original], otherItems, [{ ...verdict, id: otherItems[0].id }], options).actions,
    [original], 'a read-back for a named different assignee cannot qualify this owner task');
});

test('embedded timing removal cannot consume part of another word', () => {
  const source = [{ id: 'T0001', speaker: 'Sam', text: 'I will prepare the release checklist within the next two to three weeks.' }];
  const original = row('Prepare the release checklist within the next two to three weeks.', { evidenceIds: ['T0001'],
    timing: { kind: 'target', wording: 'in the next two to three weeks', exactDate: '' } });
  const normalised = V.normaliseAgentResult({ actions: [original] }, source, 'actions', options);
  assert.equal(normalised.actions[0].action, original.action, 'an unmatched preposition is retained without partial-word corruption');
  assert.deepEqual(normalised.actions[0].timing, original.timing);
  const exact = V.normaliseAgentResult({ actions: [{ ...original,
    action: 'Prepare the release checklist in the next two to three weeks.' }] },
  [{ ...source[0], text: 'I will prepare the release checklist in the next two to three weeks.' }], 'actions', options);
  assert.equal(exact.actions[0].action, 'Prepare the release checklist.');
  const name = V.normaliseAgentResult({ actions: [row('Review the Mayfield invoices in May.', { evidenceIds: ['T0001'],
    timing: { kind: 'target', wording: 'May', exactDate: '' } })] },
  [{ id: 'T0001', speaker: 'Sam', text: 'I will review the Mayfield invoices in May.' }], 'actions', options);
  assert.equal(name.actions[0].action, 'Review the Mayfield invoices.');
  for (const apostrophe of ["'", '’']) {
    for (const [wording, actionText] of [
      ['next month', `Bring proposed options to next month${apostrophe}s meeting.`],
      ['Friday', `Prepare the agenda for Friday${apostrophe}s review.`]
    ]) {
      const possessive = V.normaliseAgentResult({ actions: [row(actionText, { evidenceIds: ['T0001'],
        timing: { kind: 'target', wording, exactDate: '' } })] },
      [{ id: 'T0001', speaker: 'Sam', text: `I will ${actionText.charAt(0).toLowerCase()}${actionText.slice(1)}` }], 'actions', options);
      assert.equal(possessive.actions[0].action, actionText, 'possessive date modifiers remain a complete part of the instruction');
    }
  }
  const adverbial = V.normaliseAgentResult({ actions: [row('Prepare the release checklist by Friday.', { evidenceIds: ['T0001'],
    timing: { kind: 'deadline', wording: 'Friday', exactDate: '' } })] },
  [{ id: 'T0001', speaker: 'Sam', text: 'I will prepare the release checklist by Friday.' }], 'actions', options);
  assert.equal(adverbial.actions[0].action, 'Prepare the release checklist.');
  assert.equal(adverbial.actions[0].timing.wording, 'Friday');
  assert.equal(adverbial.actions[0].timing.exactDate, '2026-10-23');
});
