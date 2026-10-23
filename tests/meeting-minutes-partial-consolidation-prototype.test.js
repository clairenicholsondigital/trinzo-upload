'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const P = require('../utils/canonicalMinutes/discussionPartialConsolidationPrototype');
const C = require('../utils/canonicalMinutes/discussionClaimConsolidation');
const sourceUnits = [{ id: 'T1', text: 'The calibration report is ready. Supplier approval is pending. Maya will circulate the equipment register.' }];
const input = () => [{ id: 'topic', topic: 'Equipment', points: [
  { id: 'a', text: 'The calibration report is ready. Supplier approval is pending.', evidenceIds: ['T1'] },
  { id: 'b', text: 'The calibration report is ready. Maya will circulate the equipment register.', evidenceIds: ['T1'] }
], decisions: [], openQuestions: [] }];
const replacement = sourceUnits[0].text;
function proposal(packet) {
  return { version: P.VERSION, packetHash: packet.packetHash, results: packet.candidates.map(candidate => ({
    id: candidate.id, decision: 'propose', text: replacement
  })) };
}
function checks(packet, proposed) {
  return { version: P.VERSION, packetHash: packet.packetHash, results: proposed.map(candidate => ({
    id: candidate.id,
    originalChecks: candidate.rows.flatMap(row => row.clauses.map((_, clauseIndex) => ({
      recordId: row.record.id, clauseIndex, supported: true, retained: true, sourceIds: ['T1']
    }))),
    outputChecks: candidate.outputClauses.map((_, clauseIndex) => ({ clauseIndex, supported: true, sourceIds: ['T1'] }))
  })) };
}
const opts = extra => ({ encode: async texts => texts.map(() => [1, 0]),
  propose: async (_, packet) => proposal(packet), verify: async (_, packet, proposed) => checks(packet, proposed), ...extra });
test('a validated partial-overlap proposal preserves every original and NEVER publishes a rewrite', async () => {
  const original = input(), before = structuredClone(original), result = await P.assess(original, sourceUnits, opts());
  assert.equal(result.audit.applied, false);
  assert.ok(result.audit.validatedProposals.length);
  assert.deepEqual(result.discussion, original); assert.deepEqual(original, before);
  assert.deepEqual(result.audit.original, original);
  assert.equal(C.hash(result.audit.original), result.audit.inputHash);
});
for (const [name, mutate] of [
  ['missing unique detail', response => { response.results[0].originalChecks.at(-1).retained = false; }],
  ['unsupported output', response => { response.results[0].outputChecks[0].supported = false; }],
  ['missing output check', response => { response.results[0].outputChecks.pop(); }],
  ['duplicate clause', response => { response.results[0].originalChecks[1] = response.results[0].originalChecks[0]; }],
  ['unbound source', response => { response.results[0].outputChecks[0].sourceIds = ['T404']; }],
  ['stale packet', response => { response.packetHash = 'stale'; }]
]) test(name + ' does not become an approved proposal', async () => {
  const original = input();
  const result = await P.assess(original, sourceUnits, opts({
    verify: async (_, packet, proposed) => { const value = checks(packet, proposed); mutate(value); return value; }
  }));
  // Several candidates can be independently nominated; none may bypass full checks.
  assert.equal(result.audit.applied, false); assert.deepEqual(result.discussion, original);
  assert.equal(result.audit.validatedProposals.length, 0);
});
for (const [name, mutate] of [
  ['warning', d => { d[0].points.forEach(row => { row.reviewFlagIds = ['warning']; }); }],
  ['reviewer topic', d => { d[0].confirmedTopic = true; }],
  ['reviewer descendant elsewhere in the card', d => { d[0].points.push({ id: 'other', text: 'Other context.', evidenceIds: ['T1'], supportingDetails: [{ id: 'manual-child', text: 'Reviewer wording.', reviewerAuthored: true }] }); }],
  ['reviewer rows', d => { d[0].points.forEach(row => { row.reviewerAuthored = true; }); }],
  ['unknown metadata', d => { d[0].points.forEach(row => { row.externalContext = 'retain'; }); }]
]) test(name + ' is excluded from prototype rewriting', async () => {
  const original = input(); mutate(original);
  const result = await P.assess(original, sourceUnits, opts());
  assert.equal(result.audit.candidates, 0); assert.deepEqual(result.discussion, original);
});
test('a failed service keeps the entire discussion unchanged', async () => {
  const original = input(), result = await P.assess(original, sourceUnits, opts({ propose: async () => { throw Error('offline'); } }));
  assert.equal(result.audit.reason, 'assessment_failed'); assert.deepEqual(result.discussion, original);
});
