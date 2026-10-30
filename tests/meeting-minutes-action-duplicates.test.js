'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { dedupeHybridActionRecords, dedupeHybridActionProposals } = require('../utils/meetingMinutesActionDuplicatePolicy');

test('action dedupe deterministically keeps the strongest wording and combines metadata', () => {
  const records = [
    {
      id: 'short', action: 'Share the documents.', owners: ['Alex Green'],
      timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds: ['T0011']
    },
    {
      id: 'complete', action: 'Share the revised validation documents with the client for approval.',
      owners: ['Alex Green', 'Priya Shah'], timing: { kind: 'deadline', wording: 'by Friday', exactDate: '' },
      evidenceIds: ['T0010', 'T0012']
    }
  ];
  const forward = dedupeHybridActionRecords(structuredClone(records));
  const reverse = dedupeHybridActionRecords(structuredClone(records).reverse());
  assert.deepEqual(forward, reverse);
  assert.equal(forward.length, 1);
  assert.equal(forward[0].id, 'complete');
  assert.deepEqual(forward[0].owners, ['Alex Green', 'Priya Shah']);
  assert.deepEqual(forward[0].evidenceIds, ['T0010', 'T0011', 'T0012']);
  assert.equal(forward[0].timing.kind, 'deadline');
});

test('a related but non-identical action cannot donate its deadline during dedupe', () => {
  const rows = [
    { id: 'purpose', action: 'Obtain the supplier implementation plan and task list from Morgan.', owners: ['Alex Green'],
      timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds: ['T0010', 'T0011'] },
    { id: 'contact', action: 'Talk to Morgan.', owners: ['Alex Green'],
      timing: { kind: 'deadline', wording: 'by the tenth', exactDate: '' }, evidenceIds: ['T0012'] }
  ];
  const merged = dedupeHybridActionRecords(rows);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, 'purpose');
  assert.equal(merged[0].timing.kind, 'not_stated');
});

test('action dedupe preserves conditional document delivery while recognising a compatible nested task', () => {
  const base = (id, action, evidenceId) => ({
    id, action, owners: ['Alex Green'], timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds: [evidenceId]
  });
  const records = [
    base('contract-only', 'Send the authorised representative contract.', 'T0010'),
    base('contract-pack', 'Send the AR contract and the two supply contracts if they can be found.', 'T0011'),
    base('towpath-only', 'Confirm that the resurfaced towpath section has reopened.', 'T0020'),
    base('road-and-towpath', 'Apply for the road closure and confirm the towpath’s reopened.', 'T0021')
  ];
  const forward = dedupeHybridActionRecords(structuredClone(records));
  const reverse = dedupeHybridActionRecords(structuredClone(records).reverse());
  assert.deepEqual(forward, reverse);
  assert.deepEqual(forward.map((record) => record.id), ['contract-only', 'contract-pack', 'road-and-towpath']);
  assert.match(forward[1].action, /if they can be found/);
  assert.deepEqual(forward[0].evidenceIds, ['T0010']);
  assert.deepEqual(forward[1].evidenceIds, ['T0011'], 'unconditional delivery must not be folded into an uncertain condition');
  assert.deepEqual(forward[2].evidenceIds, ['T0020', 'T0021']);
});

test('reciprocal descriptions of one check-in merge, with the owner settled by who accepted it', () => {
  const rows = [
    { id: 'from-alex', action: 'Touch base with Morgan to establish the current audit position.', owners: ['Alex Green'],
      timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds: ['T0020'] },
    { id: 'from-morgan', action: 'Check in with Alex about anything else that may be missing.', owners: ['Morgan Lee'],
      timing: { kind: 'deadline', wording: 'by Friday', exactDate: '' }, evidenceIds: ['T0022'] }
  ];
  const sourceUnits = [
    { id: 'T0020', speaker: 'Chair', text: 'Alex was going to touch base with Morgan about the current audit position.' },
    { id: 'T0022', speaker: 'Morgan Lee', text: "I'll check in with Alex by Friday about anything else that may be missing." }
  ];
  const merged = dedupeHybridActionRecords(structuredClone(rows), { sourceUnits });
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].owners, ['Morgan Lee']);
  assert.equal(merged[0].timing.kind, 'deadline');
  assert.deepEqual(merged[0].evidenceIds, ['T0020', 'T0022']);
  const unproven = dedupeHybridActionRecords(structuredClone(rows));
  assert.equal(unproven.length, 1, 'one conversation is one action');
  assert.deepEqual([...unproven[0].owners].sort(), ['Alex Green', 'Morgan Lee'],
    'without evidence of acceptance, both participants stay as owners');
});

test('delivery bundling handles recipient-first access wording and is idempotent', () => {
  const records = [{
    id: 'access', action: 'Provide Morgan Lee access to audit documents securely, including upload arrangements.', owners: ['Alex Green'],
    timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds: ['T0010']
  }, {
    id: 'tracker', action: 'Share the audit findings tracker with Morgan Lee.', owners: ['Alex Green'],
    timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds: ['T0020']
  }];
  const once = dedupeHybridActionRecords(structuredClone(records));
  assert.equal(once.length, 1);
  assert.equal(once[0].action,
    'Provide Morgan Lee with secure access to audit documents, including upload arrangements and the audit findings tracker.');
  assert.deepEqual(dedupeHybridActionRecords(structuredClone(once)), once);
});

test('delivery bundling never crosses owner or recipient boundaries', () => {
  const base = (id, action, owner) => ({
    id, action, owners: [owner], timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds: [`T00${id.length}`]
  });
  const rows = dedupeHybridActionRecords([
    base('one', 'Send the audit plan to Morgan Lee.', 'Alex Green'),
    base('two', 'Share the findings tracker with Priya Shah.', 'Alex Green'),
    base('three', 'Provide the risk analysis to Morgan Lee.', 'Taylor Reed')
  ]);
  assert.equal(rows.length, 3);
});

test('document work followed by delivery becomes one ordered workflow', () => {
  const rows = dedupeHybridActionRecords([{
    id: 'update', action: 'Review and update the risk matrix to justify the probability values.', owners: ['Rebecca Gill'],
    timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds: ['T0010']
  }, {
    id: 'circulate', action: 'Circulate the updated risk matrix to Andrew Kane for review.', owners: ['Rebecca Gill'],
    timing: { kind: 'deadline', wording: 'by Friday', exactDate: '2026-06-26' }, evidenceIds: ['T0080']
  }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action,
    'Review and update the risk matrix to justify the probability values, then circulate the updated risk matrix to Andrew Kane for review.');
  assert.deepEqual(rows[0].timing, { kind: 'deadline', wording: 'by Friday', exactDate: '2026-06-26' });
  assert.deepEqual(rows[0].evidenceIds, ['T0010', 'T0080']);
});

test('proposal dedupe is stable across input order and adjacent evidence windows', () => {
  const records = [
    {
      id: 'one', action: 'Arrange secure access to the client document portal.', owners: ['Alex Green'],
      timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds: ['T0077']
    },
    {
      id: 'two', action: 'Arrange a secure method for Alex to access the client document portal.', owners: ['Alex Green'],
      timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds: ['T0081']
    }
  ];
  assert.deepEqual(dedupeHybridActionProposals(structuredClone(records)), dedupeHybridActionProposals(structuredClone(records).reverse()));
  assert.equal(dedupeHybridActionProposals(structuredClone(records)).length, 1);
});

test('proposal deduplication preserves a conditional alternative beside a firm implementation', () => {
  const records = dedupeHybridActionProposals([
    {
      id: 'A1', action: 'Determine and implement a secure method for document access and external SharePoint access.',
      owners: ['Alex'], timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds: ['T2100']
    },
    {
      id: 'A2', action: 'Work out a secure method to provide access to the documents using external SharePoint if needed.',
      owners: ['Alex'], timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds: ['T2101']
    }
  ]);
  assert.equal(records.length, 2);
  assert.match(records.find(record => record.id === 'A1').action, /Determine and implement/);
  assert.match(records.find(record => record.id === 'A2').action, /if needed/);
  assert.deepEqual(records.map(record => record.evidenceIds), [['T2100'], ['T2101']],
    'a firm implementation must not inherit evidence for a conditional alternative');
});

test('proposal deduplication preserves distinct predicates from one evidence window', () => {
  const records = dedupeHybridActionProposals([
    { id: 'A1', action: 'Send the validation report.', owners: ['Alex'], evidenceIds: ['T2200'] },
    { id: 'A2', action: 'Review the validation report.', owners: ['Alex'], evidenceIds: ['T2200'] }
  ]);
  assert.equal(records.length, 2);
});
