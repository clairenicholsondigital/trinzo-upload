'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const P = require('../utils/canonicalMinutes/discussionPartialConsolidationPrototype');
const D = require('../utils/canonicalMinutes/discussionSentenceDeletion');
const sourceUnits = [{ id: 'T1', text: 'The register is ready. The supplier approved the label. Maya will circulate the report.' }];
const input = () => [{ id: 'topic', topic: 'Equipment', points: [
  { id: 'a', text: 'The register is ready. The supplier approved the label.', evidenceIds: ['T1'] },
  { id: 'b', text: 'The register is ready. Maya will circulate the report.', evidenceIds: ['T1'] }
], decisions: [], openQuestions: [] }];
const deletion = () => [{ recordId: 'b', clauseIndex: 0, coveredBy: { recordId: 'a', clauseIndex: 0 } }];
const response = (packet, deletions = deletion()) => ({ version: P.VERSION, packetHash: packet.packetHash,
  results: packet.candidates.map(c => c.rows.length === 2
    ? { id: c.id, decision: 'delete_sentences', deletions }
    : { id: c.id, decision: 'decline' }) });
function verification(packet, selected) {
  return { version: P.VERSION, packetHash: packet.packetHash, results: selected.map(c => ({
    id: c.id, originalChecks: c.rows.flatMap(row => row.clauses.map((_, clauseIndex) => ({
      recordId: row.record.id, clauseIndex, supported: true, retained: true, sourceIds: ['T1']
    }))), outputChecks: c.outputClauses.map((_, clauseIndex) => ({ clauseIndex, supported: true, sourceIds: ['T1'] })),
    deletionChecks: c.deletions.map(d => ({ ...d, equivalent: true, sourceIds: ['T1'] }))
  })) };
}
const opts = extra => ({ mode: 'delete_sentences', encode: async texts => texts.map(() => [1, 0]),
  propose: async (_, packet) => response(packet), verify: async (_, packet, selected) => verification(packet, selected), ...extra });
test('deletion-only proposals preserve unique sentences, row identity, metadata and ALL returned original discussion', async () => {
  const original = input(), before = structuredClone(original);
  const result = await P.assess(original, sourceUnits, opts());
  assert.equal(result.audit.mode, 'delete_sentences'); assert.equal(result.audit.applied, false);
  assert.equal(result.audit.validatedProposals.length, 1);
  const candidate = result.audit.validatedProposals[0];
  assert.deepEqual(candidate.proposedRows.map(r => r.text), ['The register is ready. The supplier approved the label.', 'Maya will circulate the report.']);
  assert.deepEqual(candidate.proposedRows.map(r => r.id), ['a', 'b']);
  assert.deepEqual(candidate.proposedRows.map(r => r.evidenceIds), [['T1'], ['T1']]);
  assert.deepEqual(result.discussion, before); assert.deepEqual(original, before);
});
test('a repeat within one paragraph can be assessed without inventing prose', async () => {
  const original = input(); original[0].points = [{ id: 'a', text: 'The register is ready. The register is ready. Maya will circulate the report.', evidenceIds: ['T1'] }];
  const result = await P.assess(original, sourceUnits, opts({
    propose: async (_, packet) => ({ version: P.VERSION, packetHash: packet.packetHash,
      results: packet.candidates.map(c => ({ id: c.id, decision: 'delete_sentences',
        deletions: [{ recordId: 'a', clauseIndex: 1, coveredBy: { recordId: 'a', clauseIndex: 0 } }] })) })
  }));
  assert.equal(result.audit.validatedProposals.length, 1);
  assert.equal(result.audit.validatedProposals[0].proposedRows[0].text, 'The register is ready. Maya will circulate the report.');
  assert.deepEqual(result.discussion, original);
});
for (const [name, deletions] of [
  ['self reference', [{ recordId: 'b', clauseIndex: 0, coveredBy: { recordId: 'b', clauseIndex: 0 } }]],
  ['missing anchor', [{ recordId: 'b', clauseIndex: 0, coveredBy: { recordId: 'absent', clauseIndex: 0 } }]],
  ['negative index', [{ recordId: 'b', clauseIndex: -1, coveredBy: { recordId: 'a', clauseIndex: 0 } }]],
  ['fractional index', [{ recordId: 'b', clauseIndex: 0.5, coveredBy: { recordId: 'a', clauseIndex: 0 } }]],
  ['cycle', [{ recordId: 'b', clauseIndex: 0, coveredBy: { recordId: 'a', clauseIndex: 0 } }, { recordId: 'a', clauseIndex: 0, coveredBy: { recordId: 'b', clauseIndex: 0 } }]],
  ['duplicate removal', [...deletion(), ...deletion()]],
  ['empty surviving row', [...deletion(), { recordId: 'b', clauseIndex: 1, coveredBy: { recordId: 'a', clauseIndex: 1 } }]]
]) test(name + ' retains originals and reports unsafe plan', async () => {
  const original = input(), result = await P.assess(original, sourceUnits, opts({ propose: async (_, packet) => response(packet, deletions) }));
  assert.equal(result.audit.validatedProposals.length, 0);
  assert.ok(result.audit.diagnostics.some(d => d.reason === 'unsafe_deletion_plan'));
  assert.deepEqual(result.discussion, original);
});
for (const [name, mutate] of [
  ['missing equivalence check', r => { delete r.results[0].deletionChecks; }],
  ['equivalence rejected', r => { r.results[0].deletionChecks[0].equivalent = false; }],
  ['wrong anchor', r => { r.results[0].deletionChecks[0].coveredBy.clauseIndex = 1; }],
  ['unknown source', r => { r.results[0].deletionChecks[0].sourceIds = ['missing']; }],
  ['unsupported original', r => { r.results[0].originalChecks[0].supported = false; }],
  ['lost unique claim', r => { r.results[0].originalChecks.at(-1).retained = false; }],
  ['unsupported output', r => { r.results[0].outputChecks.at(-1).supported = false; }]
]) test(name + ' blocks approval even when other checks approve', async () => {
  const original = input(), result = await P.assess(original, sourceUnits, opts({
    verify: async (_, packet, selected) => { const r = verification(packet, selected); mutate(r); return r; }
  }));
  assert.equal(result.audit.validatedProposals.length, 0);
  assert.ok(result.audit.diagnostics.length); assert.deepEqual(result.discussion, original);
});
for (const text of [
  'This register is ready. The supplier approved the label.',
  'The register is ready. Therefore Maya will circulate the report.',
  'The register is ready. Maya will circulate the report after approval.',
  'The register is ready. Maya said "ready".'
]) test('dependent/quoted wording remains outside deletion scope: ' + text, async () => {
  const original = input(); original[0].points.forEach(row => { row.text = text; });
  let calls = 0;
  const result = await P.assess(original, sourceUnits, opts({ propose: async () => { calls++; } }));
  assert.equal(calls, 0); assert.equal(result.audit.candidates, 0); assert.deepEqual(result.discussion, original);
});
test('deletion plans cannot change polarity, uncertainty or direction', async () => {
  const packet = await P.prepare(input(), sourceUnits, opts());
  const candidate = packet.candidates.find(c => c.rows.length === 2);
  for (const text of ['The register is not ready.', 'The register may be ready.']) {
    const modified = structuredClone(candidate); modified.rows[1].clauses[0] = text;
    assert.equal(D.plan(modified, deletion()), null);
  }
});
test('unrequested replacement prose is an invalid deletion contract', async () => {
  const original = input(), result = await P.assess(original, sourceUnits, opts({
    propose: async (_, packet) => { const r = response(packet); r.results[0].text = 'Invented replacement.'; return r; }
  }));
  assert.equal(result.audit.reason, 'invalid_proposals'); assert.deepEqual(result.discussion, original);
});
test('source citation budget excludes candidates rather than truncating evidence', () => {
  assert.equal(D.eligible({ rows: [{ clauses: ['The register is ready.', 'The label is ready.'] }],
    sourceUnits: Array.from({ length: 13 }, (_, i) => ({ id: 'T' + i })) }), false);
});
