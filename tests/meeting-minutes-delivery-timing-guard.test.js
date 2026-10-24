'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../routes/api').stagedEvaluation;
const row = (id, action, extra = {}) => ({ id, action, owners: ['Alex Green'],
  evidenceIds: ['T0001'], reviewFlagIds: [],
  timing: { kind: 'not_stated', wording: '', exactDate: '' }, ...extra });

for (const kind of ['dependency', 'deadline', 'target']) {
  for (const [clause, wording] of [
    ['before her arrival', 'before you arrive'],
    ['after the checks are complete', 'after the inspection checks have finished'],
    ['when the checks are complete', 'when the inspection checks have finished'],
    ['once approval is received', 'once approved'],
    ['following approval', 'after approval'],
    ['until the review is finished', 'until the review ends'],
    ['by the agreed handover', 'by the handover date'],
    ['as soon as approval arrives', 'as soon as approved']
  ]) for (const reverse of [false, true]) {
    test('preserve original delivery and timing: ' + JSON.stringify({ kind, clause, reverse }), () => {
      const rows = [row('one', `Share the supplier report with Priya Shah ${clause}.`, {
        timing: { kind, wording, exactDate: '' }, reviewFlagIds: ['review-condition'],
        timingDecision: { status: 'unresolved', reason: 'source_binding_unresolved' },
        mergedFromIds: ['earlier'], occurrenceId: 'delivery-one'
      }), row('two', 'Send the equipment inventory to Priya Shah.', { evidenceIds: ['T0002'] })];
      if (reverse) rows.reverse();
      const before = structuredClone(rows);
      assert.deepEqual(api.bundleSameRecipientDeliveries(rows), before);
      const assembled = api.dedupeHybridActionRecords(rows);
      assert.equal(assembled.length, before.length);
      for (const original of before) assert.deepEqual(assembled.find(r => r.id === original.id), original);
      assert.deepEqual(rows, before);
      assert.deepEqual(api.bundleSameRecipientDeliveries(api.bundleSameRecipientDeliveries(rows)), before);
    });
  }
}

test('an exact date without wording cannot be appended to an already conditional delivery', () => {
  const rows = [row('one', 'Share the supplier report with Priya Shah before her arrival.', {
    timing: { kind: 'deadline', wording: '', exactDate: '2027-03-04' }
  }), row('two', 'Send the equipment inventory to Priya Shah.')];
  assert.deepEqual(api.bundleSameRecipientDeliveries(rows), rows);
});

test('literal inline timing is not repeated, and safe distinct deliveries still bundle', () => {
  const rows = [row('one', 'Share the supplier report with Priya Shah before her arrival.', {
    timing: { kind: 'deadline', wording: 'Before her arrival.', exactDate: '' }
  }), row('two', 'Send the equipment inventory to Priya Shah.', {
    evidenceIds: ['T0002'], timing: { kind: 'target', wording: 'next week', exactDate: '' }
  })];
  const result = api.bundleSameRecipientDeliveries(rows);
  assert.equal(result.length, 1);
  assert.equal(result[0].action, 'Provide Priya Shah with the supplier report before her arrival and the equipment inventory next week.');
  assert.deepEqual(result[0].evidenceIds, ['T0001', 'T0002']);
  assert.deepEqual(api.bundleSameRecipientDeliveries(result), result);
});

test('an unsafe delivery stays intact while independent safe deliveries can still bundle', () => {
  const protectedRow = row('one', 'Share the supplier report with Priya Shah before her arrival.', {
    timing: { kind: 'deadline', wording: 'before you arrive', exactDate: '' }
  });
  const rows = [protectedRow, row('two', 'Send the equipment inventory to Priya Shah.'),
    row('three', 'Send the visitor register to Priya Shah.', { evidenceIds: ['T0003'] })];
  const result = api.bundleSameRecipientDeliveries(rows);
  assert.equal(result.length, 2);
  assert.deepEqual(result[0], protectedRow);
  assert.equal(result[1].action, 'Provide Priya Shah with the equipment inventory and the visitor register.');
});

test('the preserved rows keep wording, timing and metadata through public and export projections', () => {
  const rows = [row('one', 'Share the supplier report with Priya Shah before her arrival.', {
    timing: { kind: 'target', wording: 'before you arrive', exactDate: '' },
    reviewFlagIds: ['check-arrival'], timingDecision: { status: 'unresolved' }
  }), row('two', 'Send the equipment inventory to Priya Shah.')];
  const actions = api.dedupeHybridActionRecords(rows);
  const draft = { details: {}, sourceUnits: [], discussion: [], actions, reviewFlags: [] };
  for (const publish of [api.publicMeetingAgentDraft, api.meetingAgentDraftForPdf, api.meetingAgentDraftForDocx]) {
    const visible = publish(structuredClone(draft));
    // Publication still applies its existing source-validation rules. Compare
    // with publishing the same untouched rows, rather than certifying timing
    // against this intentionally empty source fixture.
    const original = publish(structuredClone({ ...draft, actions: rows }));
    const byAction = values => [...values].sort((a, b) => a.action.localeCompare(b.action));
    assert.deepEqual(byAction(visible.actions), byAction(original.actions));
    assert.deepEqual(visible.actions.map(r => r.action).sort(), rows.map(r => r.action).sort());
  }
  for (const original of rows) assert.deepEqual(actions.find(r => r.id === original.id), original);
});
