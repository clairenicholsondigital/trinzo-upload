'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  commitmentDuplicate, mergeCommitmentDuplicates, commitmentVariantCovered, commitmentCanBeRepresented,
  reconcileCommitmentVariants
} = require('../utils/canonicalMinutes/commitmentDuplicates');

const row = (id, action, extra = {}) => ({
  id, action, owners: ['Sam Blake'], evidenceIds: ['T0001', 'T0002'], reviewFlagIds: [],
  timing: { kind: 'not_stated', wording: '', exactDate: '' }, ...extra
});

function separate(left, right) {
  for (const pair of [[left, right], [right, left]]) {
    assert.equal(commitmentVariantCovered(pair[0], pair[1]), false);
    assert.equal(reconcileCommitmentVariants(...pair), null);
    assert.deepEqual(mergeCommitmentDuplicates(pair, { cosines: new Map([['0|1', 1]]) }).actions, pair);
  }
}

test('document/content variants preserve the explicit old-to-new value and provenance', () => {
  const bare = row('bare', 'Draft the renewal notice explaining the increase of the subscription charge to £42.', {
    evidenceIds: ['T0001'], reviewFlagIds: ['check-one'], _weakEvidenceIds: ['T0001'], _timingClauseNote: 'verify target'
  });
  const rich = row('rich', 'Explain the increase of the subscription charge from £35 to £42 in the annual renewal notice.', {
    evidenceIds: ['T0001', 'T0003'], reviewFlagIds: ['check-two']
  });
  assert.equal(commitmentVariantCovered(bare, rich), true);
  assert.equal(commitmentVariantCovered(rich, bare), false);
  for (const pair of [[bare, rich], [rich, bare]]) {
    const out = mergeCommitmentDuplicates(pair);
    assert.equal(out.actions.length, 1);
    assert.equal(out.actions[0].action, rich.action);
    assert.deepEqual(new Set(out.actions[0].evidenceIds), new Set(['T0001', 'T0003']));
    assert.deepEqual(new Set(out.actions[0].reviewFlagIds), new Set(['check-one', 'check-two']));
    assert.deepEqual(out.actions[0]._weakEvidenceIds, ['T0001']);
    assert.equal(out.actions[0]._timingClauseNote, 'verify target');
    const reconciled = reconcileCommitmentVariants(...pair);
    assert.equal(reconciled.record.action, rich.action);
    assert.deepEqual(reconciled.absorbedIds, ['bare']);
  }
});

test('an explanatory passive qualifier stays with the richer parameter instruction', () => {
  const bare = row('bare', 'Confirm the specification of the compressor pressure limit.');
  const rich = row('rich', 'Confirm the compressor pressure-limit specification used by the controller.');
  assert.equal(commitmentVariantCovered(bare, rich), true);
  assert.equal(commitmentVariantCovered(rich, bare), false);
  const out = mergeCommitmentDuplicates([rich, bare]);
  assert.equal(out.actions.length, 1);
  assert.equal(out.actions[0].action, rich.action);
});

test('communication variants retain repeat intent and complementary letter requirements', () => {
  const timing = { kind: 'target', wording: 'this month', exactDate: '' };
  const short = row('short', 'Write to the housing office again, correctly, copying the adviser and using the reference number to identify the application.', { timing });
  const rich = row('rich', 'Write to the housing office about the submitted application, copying the adviser, including a copy of the plan, and using the reference number to identify the application.', { timing });
  for (const pair of [[short, rich], [rich, short]]) {
    const merged = mergeCommitmentDuplicates(pair);
    assert.equal(merged.actions.length, 1);
    assert.match(merged.actions[0].action, /^Write again to the housing office/);
    assert.match(merged.actions[0].action, /copying the adviser/);
    assert.match(merged.actions[0].action, /including a copy of the plan/);
    assert.match(merged.actions[0].action, /using the reference number/);
    assert.deepEqual(merged.actions[0].timing, timing);
    assert.equal(commitmentVariantCovered(short, merged.actions[0]), true);
    assert.equal(commitmentVariantCovered(rich, merged.actions[0]), true);
  }
  assert.equal(commitmentVariantCovered(short, rich), false, 'repeat intent cannot simply disappear');
  assert.equal(reconcileCommitmentVariants(short, { ...rich, action: rich.action.replace('housing office', 'licensing office') }), null);
  const qualified = row('qualified', 'Send the properly calibrated sensor report.');
  assert.equal(commitmentVariantCovered(qualified, row('bare', 'Send the calibrated sensor report.')), false,
    'a quality qualifier inside the requested object is not an isolated manner aside');
  assert.equal(reconcileCommitmentVariants(row('quoted', "Send the notice with the phrase 'try again, soon'."),
    row('other', "Send the notice with the phrase 'try soon'.")), null,
    'repeat wording inside quoted content is not an instruction to repeat the send');
});

test('timed single-operation paraphrases preserve the full existing timing', () => {
  const timing = { kind: 'dependency', wording: 'during the scheduled maintenance visit', exactDate: '' };
  const bare = row('bare', 'Install the replacement intake filter.', { timing });
  const rich = row('rich', 'Fit the new replacement intake filter.', { timing: { ...timing } });
  assert.equal(commitmentVariantCovered(bare, rich), true);
  const out = mergeCommitmentDuplicates([bare, rich]);
  assert.equal(out.actions.length, 1);
  assert.equal(out.actions[0].action, rich.action);
  assert.deepEqual(out.actions[0].timing, timing);
});

test('a richer narrative cannot erase a genuinely different operation or an extra step', () => {
  for (const [a, b] of [
    ['Install the replacement filter.', 'Repair the replacement filter.'],
    ['Review the safety report.', 'Send the safety report.'],
    ['Verify the safety report.', 'Test the safety report.'],
    ['Start the compliance checks.', 'Complete the compliance checks.'],
    ['Draft the notice describing the fee.', 'Approve the notice describing the fee.'],
    ['Review the report and send the receipt.', 'Review the report and archive the receipt.']
  ]) separate(row('a', a), row('b', b));
});

test('quantity binding and competing amount transitions remain separate', () => {
  for (const [a, b] of [
    ['Send 3 reports to Morgan and 4 reports to Casey.', 'Send 4 reports to Morgan and 3 reports to Casey.'],
    ['Install three replacement filters.', 'Install four replacement filters.'],
    ['Explain the increase from £35 to £42 in the renewal notice.', 'Explain the increase from £36 to £42 in the renewal notice.'],
    ['Explain the increase from £35 to £42 in the renewal notice.', 'Explain the increase to £45 in the renewal notice.']
  ]) separate(row('a', a), row('b', b));
});

test('an explanatory by-clause never swallows a later gate or a different recipient', () => {
  for (const [a, b] of [
    ['Confirm the pressure specification.', 'Confirm the pressure specification used by the controller after approval.'],
    ['Send the report to Morgan.', 'Send the report to Casey.'],
    ['Send the report from Morgan to Casey.', 'Send the report from Casey to Morgan.'],
    ['Send the report if approval arrives.', 'Send the report.'],
    ['Send the report.', 'Do not send the report.']
  ]) separate(row('a', a), row('b', b));
});

test('ownership, evidence, reviewer locks and occurrence timing remain required', () => {
  const base = row('one', 'Confirm the pressure specification.');
  const fuller = row('two', 'Confirm the pressure specification used by the controller.');
  for (const extra of [
    { owners: [] }, { owners: ['Sam Green'] }, { owners: ['Sam Blake', 'Casey Lee'] },
    { evidenceIds: ['T0099'] }, { reviewerAuthored: true }, { confirmedTopic: true },
    { source: 'stage_3_human_confirmation' }
  ]) assert.equal(reconcileCommitmentVariants(base, { ...fuller, ...extra }), null);
  const timed = row('dated', base.action, { timing: { kind: 'target', wording: 'Monday', exactDate: '2026-11-02' } });
  const other = row('other', fuller.action, { timing: { kind: 'target', wording: 'Tuesday', exactDate: '2026-11-03' } });
  separate(timed, other);
  assert.equal(commitmentVariantCovered(timed, fuller), false, 'a dated instruction cannot be covered by an undated description');
});

test('currencies, unit notation, percentages and short target identifiers are never erased', () => {
  for (const [a, b] of [
    ['Confirm the approved budget is £30.', 'Confirm the approved budget is $30.'],
    ['Explain the price increase from £25 to £30 in the renewal letter.', 'Draft the renewal letter explaining the price increase to $30.'],
    ['Confirm the L flow rate is 30.', 'Confirm the mL flow rate is 30.'],
    ['Confirm the flow rate is 30 L per minute.', 'Confirm the flow rate is 30 mL per minute.'],
    ['Confirm the flow rate is 30 mL.', 'Confirm the flow rate is 30 ML.'],
    ['Confirm the l flow rate is 30.', 'Confirm the ml flow rate is 30.'],
    ['Confirm the g load limit is 30.', 'Confirm the kg load limit is 30.'],
    ['Confirm the error limit is 10.', 'Confirm the error limit is 10%.'],
    ['Confirm the °C temperature is 30.', 'Confirm the °F temperature is 30.'],
    ['Confirm model A is ready.', 'Confirm model B is ready.'],
    ['Write the control command A.', 'Write the control command B.'],
    ['Review the q report.', 'Review the r report.'],
    ['Review the Class I device.', 'Review the Class II device.']
  ]) separate(row('a', a), row('b', b));
});

test('scope exclusions, bounds, alternatives and recurrence cannot become mere extra detail', () => {
  for (const [a, b] of [
    ['Review all equipment reports.', 'Review all equipment reports except the Orion report.'],
    ['Review each report.', 'Review each report other than Orion.'],
    ['Review reports excluding Orion.', 'Review reports.'],
    ['Review ten equipment reports.', 'Review up to ten equipment reports.'],
    ['Review ten equipment reports.', 'Review approximately ten equipment reports.'],
    ['Review ten equipment reports.', 'Review fewer than ten equipment reports.'],
    ['Review ten equipment reports.', 'Review under ten equipment reports.'],
    ['Inspect the pump and valve.', 'Inspect the pump or valve.'],
    ['Schedule the inspection every ten days.', 'Schedule the inspection in ten days.'],
    ['Confirm the refundable deposit is £30.', 'Confirm the non-refundable deposit is £30.'],
    ['Review the compliant equipment reports.', 'Review the non-compliant equipment reports.'],
    ['Confirm the report is safe.', 'Confirm the report is unsafe.']
  ]) separate(row('a', a), row('b', b));
});

test('equal nouns do not cover reversed role, source, destination or comparison bindings', () => {
  for (const [a, b] of [
    ['Record Morgan as owner of Orion and Dana as owner of Vega.', 'Record Morgan as owner of Vega and Dana as owner of Orion.'],
    ['Record Dana as reviewer and Morgan as approver.', 'Record Morgan as reviewer and Dana as approver.'],
    ['Send equipment from warehouse Delta to warehouse Echo.', 'Send equipment from warehouse Echo to warehouse Delta.'],
    ['Send the report from the archive.', 'Send the report to the archive.'],
    ['Confirm the status of Orion against Vega.', 'Confirm the status of Vega against Orion.'],
    ['Fit the bracket over the panel.', 'Fit the panel over the bracket.'],
    ['Fit the bracket inside the large panel.', 'Fit the panel inside the bracket.'],
    ['Record Morgan owns Orion and Dana owns Vega.', 'Record Morgan owns Vega and Dana owns Orion.'],
    ['Review the Orion matrix for project Vega.', 'Review the Vega matrix for project Orion.'],
    ['Confirm the pass rate is 1 in 100.', 'Confirm the pass rate is 100 in 1.']
  ]) separate(row('a', a), row('b', b));
});

test('repeat wording in the report subject cannot be relocated to the writing operation', () => {
  const bare = row('bare', 'Write a report about the pump failing, including the photos.');
  const repeatedFailure = row('rich', 'Write a report about the pump failing again, including the photos.');
  for (const pair of [[bare, repeatedFailure], [repeatedFailure, bare]]) {
    const result = reconcileCommitmentVariants(...pair);
    if (result) {
      assert.equal(result.record.action, repeatedFailure.action);
      assert.doesNotMatch(result.record.action, /^Write again/i);
    }
    const merged = mergeCommitmentDuplicates(pair, { cosines: new Map([['0|1', 1]]) });
    assert.ok(merged.actions.some(record => record.action === repeatedFailure.action));
    assert.ok(merged.actions.every(record => !/^Write again/i.test(record.action)));
  }
});

test('a comma followed by then retains the next operation in a complete compound', () => {
  const part = row('part', 'Document the inspection findings and circulate the report to Casey.');
  const whole = row('whole', 'Update the inspection plan and document the inspection findings, then circulate the report to Casey.');
  assert.equal(commitmentCanBeRepresented(part, whole), true);
  assert.equal(commitmentCanBeRepresented(whole, part), false);
  for (const pair of [[part, whole], [whole, part]]) {
    const result = mergeCommitmentDuplicates(pair);
    assert.equal(result.actions.length, 1);
    assert.equal(result.actions[0].action, whole.action);
  }
  separate(part, { ...whole, action: whole.action.replace('to Casey', 'to Morgan') });
});
