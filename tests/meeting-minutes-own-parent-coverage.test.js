'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const C = require('../utils/canonicalMinutes/discussionClaimConsolidation');
const F = require('./helpers/discussion-own-parent-fixture');
const { O, copy, sourceUnits, discussion, options, inventory, verification } = F;
test('generated origin metadata reaches assessment and survives exact restoration', async () => {
  const input=copy(discussion); input[0].points[0].supportingDetails[0].originalTopic='Inlet maintenance';
  const result=await O.consolidate(input,sourceUnits,options());
  assert.equal(result.audit.applied,true);
  assert.equal(result.audit.ledger[0].originalChild.originalTopic,'Inlet maintenance');
  assert.deepEqual(C.restore(result.discussion,sourceUnits,result.audit),input);
});
for(const origin of ['', 'x'.repeat(221), 'bad\u0000topic', {name:'topic'}])
test('malformed origin remains protected: '+JSON.stringify(origin),()=>{
  const input=copy(discussion);input[0].points[0].supportingDetails[0].originalTopic=origin;
  assert.equal(O.prepare(input,sourceUnits).candidates.length,0);
});
test('own-parent proof removes only a covered child, keeping parent wording, warning, evidence and complete restore', async () => {
  const before = copy(discussion), sources = copy(sourceUnits);
  const result = await O.consolidate(before, sources, options());
  assert.equal(result.audit.applied, true);
  const parent = result.discussion[0].points[0], original = before[0].points[0];
  assert.equal(parent.text, original.text);
  assert.deepEqual(parent.reviewFlagIds, original.reviewFlagIds);
  assert.deepEqual(parent.evidenceIds, original.evidenceIds);
  assert.deepEqual(parent.mergedFromIds, ['earlier-parent', 'child', 'earlier-child']);
  assert.deepEqual(parent.supportingDetails, []);
  assert.deepEqual(result.audit.ledger[0].originalChild, original.supportingDetails[0]);
  assert.deepEqual(C.restore(result.discussion, sources, result.audit), before);
  assert.deepEqual(before, discussion); assert.deepEqual(sources, sourceUnits);
});
for (const [name, change] of [
  ['child warning', p => { p.supportingDetails[0].reviewFlagIds = ['own-warning']; }],
  ['reviewer child', p => { p.supportingDetails[0].reviewerAuthored = true; }],
  ['reviewer parent', p => { p.reviewerAuthored = true; }],
  ['rich metadata', p => { p.supportingDetails[0].notes = 'reviewer notes'; }],
  ['child descendants', p => { p.supportingDetails[0].supportingDetails = [{ id: 'nested' }]; }],
  ['new citation', p => { p.supportingDetails[0].evidenceIds = ['T0002']; }],
  ['new primary citation', p => { p.supportingDetails[0].primaryEvidenceIds = ['T0001']; }],
  ['overflow history', p => { p.mergedFromIds = Array.from({ length: 1000 }, (_, i) => 'old-' + i); }],
  ['simulation', p => { p.supportingDetails[0].simulationSource = 'simulation'; }],
  ['different disposition', p => { p.supportingDetails[0].discoveryDisposition = 'include'; }]
]) test(name + ' is excluded before any provider call', async () => {
  const input = copy(discussion); change(input[0].points[0]);
  const result = await O.consolidate(input, sourceUnits, { inventory: () => assert.fail('ineligible provider call') });
  assert.equal(result.audit.reason, 'no_candidates'); assert.deepEqual(result.discussion, input);
});
test('missing/duplicate sources and duplicate identities fail closed', () => {
  assert.equal(O.prepare(discussion, []).candidates.length, 0);
  assert.equal(O.prepare(discussion, [...sourceUnits, ...sourceUnits]).candidates.length, 0);
  const input = copy(discussion); input[0].points.push(copy(input[0].points[0]));
  assert.equal(O.prepare(input, sourceUnits).candidates.length, 0);
});
test('one candidate per parent, at most three; never cross-parent removal', () => {
  const input = copy(discussion);
  input[0].points[0].supportingDetails.push({ ...copy(input[0].points[0].supportingDetails[0]), id: 'child2' });
  assert.equal(O.prepare(input, sourceUnits).candidates.length, 1);
  input[0].points[0].supportingDetails = [];
  assert.equal(O.prepare(input, sourceUnits).candidates.length, 0);
});
for (const [name, mutate] of [
  ['wrong packet', r => { r.packetHash = 'wrong'; }],
  ['missing candidate', r => { r.results = []; }],
  ['duplicate candidate', r => { r.results.push(copy(r.results[0])); }],
  ['invented parent quote', r => { r.results[0].claims[0].parentQuote = 'An invented quote.'; }],
  ['invented source quote', r => { r.results[0].claims[0].sourceWitnesses[0].quote = 'An invented quote.'; }],
  ['omitted inventory words', r => { r.results[0].claims[0].childQuote = 'Nora Patel'; }],
  ['unknown contract field', r => { r.results[0].approved = true; }],
  ['duplicate claim', r => { r.results[0].claims.push(copy(r.results[0].claims[0])); }]
]) test('rejects inventory: ' + name, async () => {
  const result = await O.consolidate(discussion, sourceUnits, {
    ...options(), inventory: async (_, p) => { const r = inventory(p); mutate(r); return r; }
  });
  assert.equal(result.audit.applied, false); assert.deepEqual(result.discussion, discussion);
});
for (const [name, mutate] of [
  ['failed claim cannot be overridden', r => { r.results[0].claimChecks[0].retained = false; }],
  ['unsupported claim', r => { r.results[0].claimChecks[0].supported = false; }],
  ['incomplete inventory', r => { r.results[0].sentenceChecks[0].allClaimsListed = false; }],
  ['missing sentence', r => { r.results[0].sentenceChecks = []; }],
  ['invented parent quote', r => { r.results[0].sentenceChecks[0].parentQuote = 'Not present.'; }],
  ['no witness', r => { r.results[0].sentenceChecks[0].sourceWitnesses = []; }],
  ['wrong claim id', r => { r.results[0].claimChecks[0].claimId = 'wrong'; }],
  ['unexpected overall verdict', r => { r.results[0].approved = true; }]
]) test('rejects independent verification: ' + name, async () => {
  const result = await O.consolidate(discussion, sourceUnits, {
    ...options(), verify: async (_, p, selected) => { const r = verification(p, selected); mutate(r); return r; }
  });
  assert.equal(result.audit.applied, false); assert.deepEqual(result.discussion, discussion);
});
test('mapped quotes must preserve uncertainty, attribution, quantities, conditions and time even if provider approves', () => {
  const packet = O.prepare(discussion, sourceUnits);
  for (const replacement of [
    'Nora Patel will replace the inlet this weekend, on Saturday morning.',
    'Nora Patel will replace the inlet this weekend, probably on Sunday morning.',
    'Nora Patel will replace the inlet this weekend, probably on Saturday morning, before visitors arrive.',
    'Someone will replace the inlet this weekend, probably on Saturday morning.'
  ]) {
    const p = copy(packet); p.candidates[0].parent.text = replacement;
    const r = inventory(p); r.results[0].claims[0].parentQuote = replacement;
    assert.equal(O.inventories(p, r).length, 0, replacement);
  }
  const p = copy(packet); p.candidates[0].child.text += ' Use two valves.';
  const r = inventory(p); assert.equal(O.inventories(p, r).length, 0);
});
test('exceptions, decline and stale input keep original; provider packets cannot mutate caller state', async () => {
  let result = await O.consolidate(discussion, sourceUnits, { inventory: async () => { throw Error('timeout'); }, verify: async () => {} });
  assert.equal(result.audit.reason, 'assessment_failed');
  const before = copy(discussion);
  result = await O.consolidate(before, sourceUnits, {
    ...options(), inventory: async (_, p) => { const r = inventory(p); p.candidates[0].parent.text = 'Mutated packet.'; return r; }
  });
  assert.equal(result.audit.applied, true); assert.deepEqual(before, discussion);
  result = await O.consolidate(before, sourceUnits, {
    ...options(), verify: async (_, p, selected) => { before[0].topic = 'Edited during call'; return verification(p, selected); }
  });
  assert.equal(result.audit.reason, 'stale_input');
  const shadow = await O.consolidate(discussion, sourceUnits, { ...options(), shadow: true });
  assert.equal(shadow.audit.shadow, true); assert.equal(shadow.audit.applied, false);
  assert.deepEqual(shadow.discussion, discussion);
});
test('archive composition restores BOTH earlier and own-parent changes, preserving unrelated topics and declining broken chains', async () => {
  const earlier = copy(discussion); earlier[0].points[0].text += ' Earlier wording.';
  const previous = { discussion: copy(discussion), audit: {
    version: C.VERSION, applied: true, original: earlier, originalHash: C.hash(earlier),
    sourceHash: C.hash(sourceUnits), ledger: [{ id: 'prior' }],
    affectedTopics: [{ index: 0, finalHash: C.hash(discussion[0]) }]
  } };
  const next = await O.consolidate(discussion, sourceUnits, options());
  const combined = O.combine(previous, next, sourceUnits);
  assert.deepEqual(C.restore(combined.discussion, sourceUnits, combined.audit), earlier);
  assert.deepEqual(combined.audit.priorAudit, previous.audit);
  assert.equal(combined.audit.ledger.length, 2);
  const changed = copy(combined.discussion); changed[0].points[0].text += ' Reviewer edit.';
  assert.equal(C.restore(changed, sourceUnits, combined.audit), null);
  const unrelated = copy(combined.discussion); unrelated.push({ topic: 'Unrelated reviewer topic' });
  assert.equal(C.restore(unrelated, sourceUnits, combined.audit)[1].topic, 'Unrelated reviewer topic');
  const stale = copy(next); stale.audit.inputHash = 'wrong';
  assert.deepEqual(O.combine(previous, stale, sourceUnits), previous);
  const declined = O.combine(previous, { audit: { applied: false, reason: 'coverage_rejected', candidates: 1 } }, sourceUnits);
  assert.deepEqual(declined.discussion, previous.discussion);
  assert.deepEqual(declined.audit.original, previous.audit.original);
  assert.deepEqual(declined.audit.ledger, previous.audit.ledger);
  assert.equal(declined.audit.ownParentAssessment.reason, 'coverage_rejected');
  assert.deepEqual(C.restore(declined.discussion, sourceUnits, declined.audit), earlier);
});
