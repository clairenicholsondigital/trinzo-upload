'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const C = require('../utils/canonicalMinutes/discussionClauseConsolidation');
const Recovery = require('../utils/canonicalMinutes/discussionClaimConsolidation');
const sourceUnits = [{ id: 'T1', text: 'The supplier approval remained unavailable without the final report.' }];
const input = () => [{ id: 'topic', topic: 'Equipment approval', points: [{
  id: 'a', text: 'The supplier approval remained unavailable without the final report, as supplier approval was unavailable without the final report.',
  evidenceIds: ['T1'], primaryEvidenceIds: ['T1'], reviewFlagIds: [], supportingDetails: [], mergedFromIds: ['previous']
}], decisions: [], openQuestions: [] }];
function proposal(packet) {
  return { version: C.VERSION, packetHash: packet.packetHash, results: packet.candidates.map(candidate => ({
    id: candidate.id, decision: 'delete', deletions: [{ unitId: 's0-suffix', coveredByUnitId: 's0-prefix' }]
  })) };
}
function verification(packet, selected) {
  return { version: C.VERSION, packetHash: packet.packetHash, results: selected.map(candidate => ({
    id: candidate.id, selectionHash: candidate.selectionHash,
    checks: candidate.units.map(unit => ({ unitId: unit.id,
      coveredByUnitId: candidate.deletions.find(d => d.unitId === unit.id)?.coveredByUnitId || unit.id,
      supported: true, retained: true, sourceIds: ['T1'] })),
    outputSupported: true, outputSourceIds: ['T1']
  })) };
}
const options = overrides => ({ assess: async (_, packet) => proposal(packet),
  verify: async (_, packet, selected) => verification(packet, selected), ...overrides });
test('a redundant trailing explanation is removed without changing any metadata or original input', async () => {
  const original = input(), before = structuredClone(original);
  const result = await C.consolidate(original, sourceUnits, options());
  assert.equal(result.audit.applied, true);
  assert.equal(result.discussion[0].points[0].text, 'The supplier approval remained unavailable without the final report.');
  assert.deepEqual({ ...result.discussion[0].points[0], text: '' }, { ...original[0].points[0], text: '' });
  assert.deepEqual(original, before);
  assert.deepEqual(Recovery.restore(result.discussion, sourceUnits, result.audit), original);
});
test('a repeated sentence within a record can be removed with its unique sentences retained unchanged', async () => {
  const original = input(); original[0].points[0].text = 'The register is ready. The register is ready. Maya will circulate the report.';
  const result = await C.consolidate(original, [{ id: 'T1', text: original[0].points[0].text }], options({
    assess: async (_, packet) => ({ version: C.VERSION, packetHash: packet.packetHash,
      results: packet.candidates.map(c => ({ id: c.id, decision: 'delete', deletions: [{ unitId: 's1', coveredByUnitId: 's0' }] })) })
  }));
  assert.equal(result.audit.applied, true);
  assert.equal(result.discussion[0].points[0].text, 'The register is ready. Maya will circulate the report.');
});
for (const [name, mutate] of [
  ['unsupported original', r => { r.results[0].checks[1].supported = false; }],
  ['distinct reason', r => { r.results[0].checks[1].retained = false; }],
  ['unsupported output', r => { r.results[0].outputSupported = false; }],
  ['missing coverage', r => { r.results[0].checks.pop(); }],
  ['duplicate coverage', r => { r.results[0].checks[1] = r.results[0].checks[0]; }],
  ['wrong covering unit', r => { r.results[0].checks[1].coveredByUnitId = 's0-suffix'; }],
  ['unknown source', r => { r.results[0].checks[1].sourceIds = ['missing']; }],
  ['missing output sources', r => { r.results[0].outputSourceIds = []; }],
  ['stale selection', r => { r.results[0].selectionHash = 'old'; }],
  ['stale packet', r => { r.packetHash = 'old'; }],
  ['null check', r => { r.results[0].checks[0] = null; }]
]) test(name + ' retains original wording and metadata', async () => {
  const original = input(), result = await C.consolidate(original, sourceUnits, options({
    verify: async (_, packet, selected) => { const r = verification(packet, selected); mutate(r); return r; }
  }));
  assert.equal(result.audit.applied, false); assert.deepEqual(result.discussion, original);
});
for (const [name, changes] of [
  ['warning', row => { row.reviewFlagIds = ['warning']; }],
  ['reviewer', row => { row.reviewerAuthored = true; }],
  ['unknown metadata', row => { row.customState = 'retain'; }],
  ['supporting context', row => { row.supportingDetails = [{ id: 'child', text: 'Unique context.', evidenceIds: ['T1'] }]; }],
  ['question', row => { row.text += ' Is the approval ready?'; }],
  ['quoted text', row => { row.text = '"' + row.text + '"'; }],
  ['simulation provenance', row => { row.simulationSource = 'other'; }],
  ['inconsistent citations', row => { row.primaryEvidenceIds = ['other']; }]
]) test(name + ' stays outside automatic clause editing', async () => {
  const original = input(); changes(original[0].points[0]);
  let calls = 0; const result = await C.consolidate(original, sourceUnits, options({ assess: async () => { calls++; } }));
  assert.equal(result.audit.candidates, 0); assert.equal(calls, 0); assert.deepEqual(result.discussion, original);
});
test('reviewer content elsewhere in the card protects all its records', async () => {
  const original = input(); original[0].decisions.push({ id: 'manual-other', text: 'Reviewer decision.', reviewerAuthored: true });
  assert.equal((await C.consolidate(original, sourceUnits, options())).audit.candidates, 0);
});
test('duplicate source or record identities cannot be edited', async () => {
  const original = input(), duplicate = structuredClone(original); duplicate[0].points.push(structuredClone(duplicate[0].points[0]));
  assert.equal((await C.consolidate(duplicate, sourceUnits, options())).audit.candidates, 0);
  assert.equal((await C.consolidate(original, [...sourceUnits, sourceUnits[0]], options())).audit.candidates, 0);
});
test('names, numeric values, uncertainty, condition direction and phase cannot disappear', () => {
  for (const text of [
    'The supplier approval remained unavailable without the final report, as Maya approved supplier approval without the final report.',
    'The supplier approval remained unavailable without the final report, as supplier approval costs 50 without the final report.',
    'The supplier approval remained unavailable without the final report, as supplier approval may remain unavailable without the final report.',
    'The supplier approval remained unavailable before the final report, as supplier approval was unavailable after the final report.',
    'The supplier approval remained unavailable without the final report, as supplier approval will remain unavailable without the final report.'
  ]) {
    const original = input(); original[0].points[0].text = text;
    const packet = C.prepare(original, sourceUnits);
    assert.ok(packet.candidates.length);
    assert.equal(C.proposals(packet, proposal(packet)).length, 0);
  }
});
test('prefix removal, nonexistent targets and dependency cycles cannot become a deletion', () => {
  const packet = C.prepare(input(), sourceUnits), base = proposal(packet);
  for (const deletions of [
    [{ unitId: 's0-prefix', coveredByUnitId: 's0-suffix' }],
    [{ unitId: 's0-suffix', coveredByUnitId: 'missing' }],
    [{ unitId: 's0-suffix', coveredByUnitId: 's0-suffix' }]
  ]) { const response = structuredClone(base); response.results[0].deletions = deletions; assert.equal(C.proposals(packet, response).length, 0); }
});
test('service failure, changed input and shadow mode preserve complete originals', async () => {
  const original = input();
  const failed = await C.consolidate(original, sourceUnits, options({ verify: async () => { throw Error('offline'); } }));
  assert.equal(failed.audit.reason, 'assessment_failed'); assert.deepEqual(failed.discussion, original);
  const shadow = await C.consolidate(original, sourceUnits, options({ shadow: true }));
  assert.equal(shadow.audit.applied, false); assert.deepEqual(shadow.discussion, original);
  assert.ok(shadow.audit.proposed[0].points[0].text.length < original[0].points[0].text.length);
  const stale = await C.consolidate(original, sourceUnits, options({
    verify: async (_, packet, selected) => { original[0].points[0].text += ' A reviewer change.'; return verification(packet, selected); }
  }));
  assert.equal(stale.audit.reason, 'stale_input'); assert.equal(stale.audit.applied, false);
});
test('recovery preserves unrelated edits but refuses edited topics and changed sources', async () => {
  const original = input(); original.push({ id: 'other', topic: 'Other', points: [{ id: 'b', text: 'Other context.', evidenceIds: ['T1'] }], decisions: [], openQuestions: [] });
  const result = await C.consolidate(original, sourceUnits, options());
  result.discussion[1].points[0].text = 'Unrelated reviewer edit.';
  const restored = Recovery.restore(result.discussion, sourceUnits, result.audit);
  assert.deepEqual(restored[0], original[0]); assert.equal(restored[1].points[0].text, 'Unrelated reviewer edit.');
  assert.equal(Recovery.restore(result.discussion, [{ id: 'T1', text: 'Changed source.' }], result.audit), null);
  result.discussion[0].points[0].text += ' Edited.';
  assert.equal(Recovery.restore(result.discussion, sourceUnits, result.audit), null);
});
