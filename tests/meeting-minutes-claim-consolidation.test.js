'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const C = require('../utils/canonicalMinutes/discussionClaimConsolidation');
const row = (id, text, extra = {}) => ({ id, text, evidenceIds: ['T1'], reviewFlagIds: [], supportingDetails: [], ...extra });
const topic = (a, b, kind = 'points') => [{ id: 'topic', topic: 'Equipment', points: [a],
  decisions: [], openQuestions: [], [kind]: kind === 'points' ? [a, b] : [b] }];
const sources = [{ id: 'T1', speaker: 'Maya', text: 'The existing lock is poor. We propose a hasp, padlock and possibly an alarm.' }];
const fixtures = () => topic(
  row('a', 'A hasp, padlock and potentially a solar alarm were proposed.', { primaryEvidenceIds: ['T1'] }),
  row('b', 'Maya proposed a hasp, padlock and possibly a solar alarm.'));
const encode = async texts => texts.map(() => [1, 0]);
function response(packet) {
  return { version: C.VERSION, packetHash: packet.packetHash, results: packet.candidates.map(candidate => ({
    id: candidate.id, relation: 'covered', survivorId: candidate.allowedSurvivors.at(-1)
  })) };
}
function proof(packet, selected) {
  return { version: C.VERSION, packetHash: packet.packetHash, results: selected.map(candidate => ({
    id: candidate.id, survivorId: candidate.survivorId, checks: candidate.rows.flatMap(row => row.clauses.map((_, clauseIndex) => ({
      recordId: row.record.id, clauseIndex, supported: true, retained: true, sourceIds: ['T1']
    })))
  })) };
}
const options = (extra = {}) => ({ encode, assess: async (_, packet) => response(packet),
  verify: async (_, packet, selected) => proof(packet, selected), ...extra });
test('source-checked matching tentative proposals preserve complete originals and primary evidence', async () => {
  const input = fixtures(), before = structuredClone(input);
  const result = await C.consolidate(input, sources, options());
  assert.equal(result.discussion[0].points.length, 1);
  assert.equal(result.discussion[0].points[0].text, input[0].points[1].text);
  assert.deepEqual(result.discussion[0].points[0].primaryEvidenceIds, ['T1']);
  assert.deepEqual(result.discussion[0].points[0].mergedFromIds, ['a']);
  assert.deepEqual(result.audit.original, input);
  assert.deepEqual(result.audit.ledger[0].originalRows.map(row => row.record), input[0].points);
  assert.deepEqual(input, before);
  assert.deepEqual(C.restore(result.discussion, sources, result.audit), input);
  assert.equal((await C.consolidate(result.discussion, sources, options())).audit.applied, false);
});
test('an unquantified point can be covered by its source-proved decision, without relaxing ordinary numeric equality', async () => {
  const input = topic(row('a', 'Reimbursement for prizes requires retaining receipts.'),
    row('b', 'Maya approved up to £40 for prizes, with reimbursement after retaining receipts.'), 'decisions');
  // The conditional witness must agree too; this is not permission to erase a different dependency.
  input[0].decisions[0].text = 'Maya approved up to £40 for prizes, with reimbursement requiring retaining receipts.';
  const result = await C.consolidate(input, [{ id: 'T1', text: 'We approve up to forty pounds for prizes. Keep receipts for reimbursement.' }], options());
  assert.equal(result.discussion[0].points.length, 0);
  assert.equal(result.discussion[0].decisions[0].id, 'b');
  assert.match(result.discussion[0].decisions[0].text, /up to £40/);
  assert.equal(result.audit.ledger.length, 1);
});
for (const [name, change] of [
  ['reviewer row', d => { d[0].points[0].reviewerAuthored = true; }],
  ['reviewer topic', d => { d[0].confirmedTopic = true; }],
  ['reviewer descendant elsewhere in the card', d => { d[0].points.push(row('reviewer-row', 'Reviewer context.', { supportingDetails: [row('reviewer-child', 'Reviewer wording.', { reviewerAuthored: true })] })); }],
  ['ambiguous record identity', d => { d[0].openQuestions.push(row('a', 'A different retained question.')); }],
  ['warning', d => { d[0].points[0].reviewFlagIds = ['warning']; }],
  ['supporting context', d => { d[0].points[0].supportingDetails = [row('child', 'A distinct qualification.')]; }],
  ['unknown metadata', d => { d[0].points[0].extraContext = 'keep'; }],
  ['simulation placement', d => { d[0].points[0].simulationParentId = 'parent'; }],
  ['different heading', d => { d.push({ ...d[0], id: 'other', points: [d[0].points.pop()] }); }],
  ['different source', d => { d[0].points[1].evidenceIds = ['T2']; }],
  ['unmatched quantity', d => { d[0].points[1].text += ' Three batteries are required.'; }],
  ['before/after', d => { d[0].points[0].text += ' Before approval.'; d[0].points[1].text += ' After approval.'; }],
  ['actor reversal', d => { d[0].points[0].text = 'Alex sent the revised certificate to Priya.'; d[0].points[1].text = 'Priya sent the revised certificate to Alex.'; }]
]) test('protected ' + name + ' never reaches the assessor', async () => {
  const input = fixtures(); change(input);
  let calls = 0;
  const result = await C.consolidate(input, [...sources, { id: 'T2', text: 'Different work.' }], options({
    assess: async () => { calls += 1; throw Error('must not call'); }
  }));
  assert.equal(calls, 0); assert.deepEqual(result.discussion, input); assert.equal(result.audit.applied, false);
});
for (const [name, corrupt] of [
  ['stale hash', response => { response.packetHash = 'wrong'; }],
  ['missing check', response => { response.results[0].checks.pop(); }],
  ['duplicate check', response => { response.results[0].checks[1] = response.results[0].checks[0]; }],
  ['unknown source', response => { response.results[0].checks[0].sourceIds = ['not-supplied']; }],
  ['unsupported clause', response => { response.results[0].checks[0].supported = false; }],
  ['lost clause', response => { response.results[0].checks[0].retained = false; }],
  ['wrong survivor', response => { response.results[0].survivorId = 'not-supplied'; }]
]) test(name + ' preserves both original records', async () => {
  const input = fixtures();
  const result = await C.consolidate(input, sources, options({
    verify: async (_, packet, selected) => { const value = proof(packet, selected); corrupt(value); return value; }
  }));
  assert.deepEqual(result.discussion, input); assert.equal(result.audit.applied, false);
});
test('malformed proposal, absent assessor and provider failure preserve the input', async () => {
  for (const extra of [{ assess: undefined }, { assess: async () => ({}) }, { assess: async () => { throw Error('service unavailable'); } }]) {
    const input = fixtures(), result = await C.consolidate(input, sources, options(extra));
    assert.deepEqual(result.discussion, input); assert.equal(result.audit.applied, false);
  }
});
test('shadow assessment records a recoverable proposal but never changes discussion', async () => {
  const input = fixtures(), result = await C.consolidate(input, sources, options({ shadow: true }));
  assert.deepEqual(result.discussion, input); assert.equal(result.audit.applied, false);
  assert.equal(result.audit.proposed[0].points.length, 1);
});
test('changed discussion/source and tampered archive cannot be restored over reviewer work', async () => {
  const result = await C.consolidate(fixtures(), sources, options());
  for (const mutate of [
    d => { d[0].points[0].text += ' Reviewer clarification.'; },
    d => { d[0].points[0].reviewerAuthored = true; },
    d => { d[0].topic = 'Reviewer heading'; }
  ]) {
    const changed = structuredClone(result.discussion); mutate(changed);
    assert.equal(C.restore(changed, sources, result.audit), null);
  }
  assert.equal(C.restore(result.discussion, [{ ...sources[0], text: 'Edited source.' }], result.audit), null);
  const audit = structuredClone(result.audit); audit.original[0].points[0].text = 'tampered';
  assert.equal(C.restore(result.discussion, sources, audit), null);
});
test('source checking covers every sentence of both records', async () => {
  const input = fixtures(); input[0].points[0].text += ' The supplier must retain the warranty.';
  const result = await C.consolidate(input, sources, options({
    verify: async (_, packet, selected) => {
      const value = proof(packet, selected);
      value.results[0].checks.find(check => check.clauseIndex === 1).retained = false;
      return value;
    }
  }));
  assert.deepEqual(result.discussion, input); assert.equal(result.audit.applied, false);
});
test('keeping receipts and submitting receipts are not an automatically interchangeable condition', async () => {
  const input = topic(row('a', 'The committee agreed to keep receipts for reimbursement.'),
    row('b', 'Maya approved up to £40, with reimbursement upon receipt submission.'), 'decisions');
  let calls = 0;
  const result = await C.consolidate(input, [{ id: 'T1', text: 'Keep the receipts and we will reimburse you.' }], options({
    assess: async () => { calls += 1; throw Error('not equivalent'); }
  }));
  assert.equal(calls, 0); assert.deepEqual(result.discussion, input);
});
test('malformed source text excludes candidates without invoking providers', async () => {
  let calls = 0;
  const result = await C.consolidate(fixtures(), [{ id: 'T1', text: 123 }], options({
    assess: async () => { calls += 1; throw Error('must not call'); }
  }));
  assert.equal(calls, 0); assert.deepEqual(result.discussion, fixtures());
});
test('restoration preserves unrelated reviewer edits and derived warnings in other topics', async () => {
  const input = fixtures();
  input.push({ id: 'unrelated', topic: 'Another topic', points: [{
    id: 'other', text: 'The independent review remains open.', evidenceIds: ['T1']
  }], decisions: [], openQuestions: [] });
  const result = await C.consolidate(input, sources, options());
  const changed = structuredClone(result.discussion);
  changed[1].topic = 'Reviewer heading';
  changed[1].points[0].text = 'Reviewer clarification in another topic.';
  changed[1].points[0].reviewFlagIds = ['derived-source-warning'];
  changed[1].points[0].reviewerAuthored = true;
  const restored = C.restore(changed, sources, result.audit);
  assert.deepEqual(restored[0], input[0]);
  assert.deepEqual(restored[1], changed[1]);
  assert.deepEqual(changed[0], result.discussion[0]);
});
module.exports = { fixtures, sources, options, response, proof };
