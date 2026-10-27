'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../utils/meetingMinutesAgentV2');
const A = require('../routes/api').stagedEvaluation;
const units = V.normaliseSourceUnits([{ id: 'T0001', speaker: 'Maya Patel', text: 'And I can follow up with Jo as well.' }]);
const wording = "Obtain Jo's review of the standards for applicability.";
const row = { id: 'review', action: wording, owners: ['Maya Patel'], evidenceIds: ['T0001'], reviewFlagIds: [], timing: { kind: 'not_stated', wording: '', exactDate: '' } };

test('a new evidence check records exact wording, survives consolidation and serialisation without approving it', () => {
  const result = V.normaliseAgentResult({ actions: [row] }, units, 'actions', { enforceEvidence: false });
  const warning = result.reviewFlags.find(flag => flag.kind === 'missing_evidence');
  assert.ok(warning, 'fixture must exercise an actual generated evidence warning');
  assert.equal(warning.actionWordingAtCheck, wording);
  const current = { ...result.actions[0], id: 'followup', action: 'Follow up with Jo regarding review of the standards.', reviewFlagIds: [] };
  const actions = A.dedupeHybridActionRecords([current, result.actions[0]], { sourceUnits: units });
  assert.equal(actions.length, 1);
  assert.ok(actions[0].reviewFlagIds.includes(warning.id));
  const handled = { ...warning, status: 'corrected', correctionNote: 'Confirmed the follow-up with Maya.' };
  const loaded = V.normaliseFlag(JSON.parse(JSON.stringify(handled)));
  assert.deepEqual(loaded, handled);
  assert.equal(loaded.actionWordingAtCheck, wording);
});

test('incoming historical warnings are not assigned an invented origin from their current target', () => {
  const old = V.normaliseFlag({ id: 'historical', kind: 'missing_evidence', message: 'Check an earlier version.', evidenceIds: ['T0001'], status: 'dismissed', correctionNote: 'Already reviewed.' });
  const result = V.normaliseAgentResult({ actions: [{ ...row, reviewFlagIds: [old.id] }], reviewFlags: [old] }, units, 'actions', { enforceEvidence: false, preserveReviewerEdits: true });
  assert.deepEqual(result.reviewFlags.find(flag => flag.id === old.id), old);
  assert.equal(Object.hasOwn(old, 'actionWordingAtCheck'), false);
});

test('origin text is bounded and absent values do not change historical flags', () => {
  assert.equal(V.normaliseFlag({ actionWordingAtCheck: 'x'.repeat(2000) }).actionWordingAtCheck.length, 1600);
  assert.equal(Object.hasOwn(V.normaliseFlag({}), 'actionWordingAtCheck'), false);
});
