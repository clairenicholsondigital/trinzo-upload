'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const P = require('../utils/canonicalMinutes/discussionPartialConsolidationPrototype');
const sourceUnits = [{ id: 'T1', text: 'The report may be ready. Maya will circulate the report. The label is approved.' }];
const input = () => [{ id: 'topic', topic: 'Equipment', points: [
  { id: 'a', text: 'The report may be ready. Maya will circulate the report.', evidenceIds: ['T1'] },
  { id: 'b', text: 'The report may be ready. The label is approved.', evidenceIds: ['T1'] }
], decisions: [], openQuestions: [] }];
// Only the repeated report sentence is similar; unique sentences must not
// create artificial within-row proposals in the service-failure fixtures.
const options = extra => ({ encode: async texts => texts.map(text =>
  text.startsWith('The report') ? [1, 0, 0] : text.startsWith('Maya') ? [0, 1, 0] : [0, 0, 1]),
  propose: async (_, packet) => ({ version: P.VERSION, packetHash: packet.packetHash,
    results: packet.candidates.map(c => ({ id: c.id, decision: 'propose', text: sourceUnits[0].text })) }),
  verify: async (_, packet, proposed) => ({ version: P.VERSION, packetHash: packet.packetHash,
    results: proposed.map(c => ({ id: c.id, originalChecks: c.rows.flatMap(row => row.clauses.map((_, clauseIndex) => ({
      recordId: row.record.id, clauseIndex, supported: true, retained: true, sourceIds: ['T1']
    }))), outputChecks: c.outputClauses.map((_, clauseIndex) => ({ clauseIndex, supported: true, sourceIds: ['T1'] })) })) }), ...extra });
test('private diagnostics identify protected wording loss without publishing a rewrite', async () => {
  const original = input(), result = await P.assess(original, sourceUnits, options({
    propose: async (_, packet) => ({ version: P.VERSION, packetHash: packet.packetHash,
      results: packet.candidates.map(c => ({ id: c.id, decision: 'propose',
        text: 'The report is ready. Maya will circulate the report. The label is approved.' })) })
  }));
  assert.ok(result.audit.diagnostics.some(d => d.reason === 'protected_meaning_changed'));
  assert.equal(result.audit.validatedProposals.length, 0); assert.deepEqual(result.discussion, original);
});
for (const [name, field, reason] of [
  ['unsupported original', 'supported', 'original_source_support_rejected'],
  ['unique fact omitted', 'retained', 'original_coverage_rejected']
]) test(name + ' identifies the rejected original clause', async () => {
  const original = input(), defaults = options();
  const result = await P.assess(original, sourceUnits, options({
    verify: async (...args) => { const r = await defaults.verify(...args); r.results.forEach(row => { row.originalChecks[0][field] = false; }); return r; }
  }));
  const diagnostic = result.audit.diagnostics.find(d => d.reason === reason);
  assert.equal(diagnostic.recordId, 'a'); assert.equal(diagnostic.clauseIndex, 0);
  assert.equal(result.audit.validatedProposals.length, 0); assert.deepEqual(result.discussion, original);
});
test('output support rejection is distinct from loss of original coverage', async () => {
  const defaults = options(), result = await P.assess(input(), sourceUnits, options({
    verify: async (...args) => { const r = await defaults.verify(...args); r.results.forEach(row => { row.outputChecks[0].supported = false; }); return r; }
  }));
  assert.ok(result.audit.diagnostics.some(d => d.reason === 'output_source_support_rejected'));
  assert.ok(!result.audit.diagnostics.some(d => d.reason === 'original_coverage_rejected'));
});
for (const [stage, overrides] of [
  ['proposal', { propose: async () => { throw Error('private endpoint credentials'); } }],
  ['verification', { verify: async () => { throw Error('private endpoint credentials'); } }]
]) test(stage + ' failure records its stage without leaking provider errors', async () => {
  const original = input(), result = await P.assess(original, sourceUnits, options(overrides));
  assert.equal(result.audit.reason, 'assessment_failed');
  assert.deepEqual(result.audit.diagnostics, [{ stage, reason: 'assessment_error' }]);
  assert.ok(!JSON.stringify(result.audit).includes('credentials')); assert.deepEqual(result.discussion, original);
});
for (const malformed of [null, {}, { results: {} }, { results: [null] }]) test('malformed proposal remains a contract failure: ' + JSON.stringify(malformed), async () => {
  const original = input(), result = await P.assess(original, sourceUnits, options({ propose: async () => malformed }));
  assert.equal(result.audit.reason, 'invalid_proposals'); assert.deepEqual(result.discussion, original);
});
test('malformed verification clauses are contract failures, not provider exceptions', async () => {
  for (const field of ['originalChecks', 'outputChecks']) {
    const original = input(), defaults = options();
    const result = await P.assess(original, sourceUnits, options({
      verify: async (...args) => { const r = await defaults.verify(...args); r.results[0][field][0] = null; return r; }
    }));
    assert.equal(result.audit.reason, 'invalid_verification');
    assert.ok(result.audit.diagnostics.some(d => d.reason === 'invalid_response_contract'));
    assert.deepEqual(result.discussion, original);
  }
});
test('callbacks cannot mutate the verification packet or selected evidence plan', async () => {
  const original = input(), defaults = options();
  const result = await P.assess(original, sourceUnits, options({
    verify: async (prompt, packet, selected) => {
      const response = await defaults.verify(prompt, packet, selected);
      selected[0].rows[0].record.text = 'Mutated text';
      packet.sourceUnits = [];
      return response;
    }
  }));
  assert.ok(result.audit.validatedProposals.length);
  assert.equal(result.audit.validatedProposals[0].rows[0].record.text, original[0].points[0].text);
  assert.deepEqual(result.discussion, original);
});
test('originals changing while the service runs invalidate the assessment', async () => {
  const original = input(), defaults = options();
  const result = await P.assess(original, sourceUnits, options({
    verify: async (...args) => { const response = await defaults.verify(...args); original[0].points[0].text += ' Reviewer change.'; return response; }
  }));
  assert.equal(result.audit.reason, 'stale_input'); assert.equal(result.audit.validatedProposals.length, 0);
  assert.ok(result.audit.diagnostics.some(d => d.reason === 'stale_input'));
});
