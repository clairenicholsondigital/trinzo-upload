'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../routes/api').stagedEvaluation;
const action = (id, text, extra = {}) => ({
  id, action: text, owners: ['Alex Green'], evidenceIds: ['T0001'],
  reviewFlagIds: [], timing: { kind: 'not_stated', wording: '', exactDate: '' }, ...extra
});

// These are formatting refusals, not semantic deduplication permissions.
// Preserve both actions and all their metadata when the objects overlap.
for (const separator of ['-', '‐', '‑', '‒', '–', '—']) {
  for (const reverse of [false, true]) {
    test('overlapping delivery objects retain their original rows: ' + JSON.stringify({ separator, reverse }), () => {
      const rows = [
        action('one', 'Provide the service access codes to Priya Shah for review and documentation of their behaviour.'),
        action('two', 'Send the service' + separator + 'access codes and usage queries to Priya Shah for clarification and documentation.', {
          timing: { kind: 'target', wording: "This week's priority action.", exactDate: '' },
          evidenceIds: ['T0001', 'T0002'], reviewFlagIds: ['flag-usage'],
          timingDecision: { status: 'unverified', reason: 'fixture' }
        })
      ];
      if (reverse) rows.reverse();
      const before = structuredClone(rows);
      assert.deepEqual(api.bundleSameRecipientDeliveries(rows), before);
      const assembled = api.dedupeHybridActionRecords(rows);
      assert.equal(assembled.length, 2);
      for (const row of before) {
        assert.deepEqual(assembled.find(item => item.id === row.id), row);
      }
      assert.deepEqual(rows, before);
      assert.deepEqual(api.dedupeHybridActionRecords(assembled), assembled);
      const draft = { details: {}, sourceUnits: [], discussion: [], actions: assembled, reviewFlags: [] };
      for (const publish of [api.publicMeetingAgentDraft, api.meetingAgentDraftForPdf, api.meetingAgentDraftForDocx]) {
        assert.deepEqual(publish(structuredClone(draft)).actions.map(row => row.action), assembled.map(row => row.action));
      }
    });
  }
}

test('exact Unicode instructions still deduplicate through preserved-wording proof', () => {
  const first = action('one', 'Send the service‑access codes to Priya Shah.');
  const second = { ...structuredClone(first), id: 'two', evidenceIds: ['T0001', 'T0002'] };
  const rows = api.dedupeHybridActionRecords([first, second]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, first.action);
  assert.deepEqual(rows[0].evidenceIds, ['T0001', 'T0002']);
});

test('distinct hyphenated documents can still form a delivery bundle with their own conditions', () => {
  const rows = [
    action('one', 'Send the equipment-checklist to Priya Shah after approval.'),
    action('two', 'Send the visitor-register to Priya Shah.', {
      timing: { kind: 'target', wording: 'next week', exactDate: '' }, evidenceIds: ['T0002']
    })
  ];
  const result = api.bundleSameRecipientDeliveries(rows);
  assert.equal(result.length, 1);
  assert.equal(result[0].action, 'Provide Priya Shah with the equipment-checklist after approval and the visitor-register next week.');
  assert.deepEqual(result[0].evidenceIds, ['T0001', 'T0002']);
  assert.deepEqual(api.bundleSameRecipientDeliveries(result), result);
});

test('overlap refusal applies to recipient-first wording without dropping a distinct third delivery', () => {
  const rows = [
    action('one', 'Provide Priya Shah with the service access codes.'),
    action('two', 'Provide Priya Shah with the service-access codes and usage queries.'),
    action('three', 'Send the inspection checklist to Priya Shah.', { evidenceIds: ['T0003'] })
  ];
  assert.deepEqual(api.bundleSameRecipientDeliveries(rows), rows);
});
