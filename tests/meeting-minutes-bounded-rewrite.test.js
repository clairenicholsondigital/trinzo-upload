'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const B = require('../utils/canonicalMinutes/discussionBoundedRewrite');
const R = require('../utils/canonicalMinutes/discussionClaimConsolidation');
const sourceUnits = [
  { id: 'T1', speaker: 'Nora Patel', text: 'The current latch is rubbish, one of the cheap ones.' },
  { id: 'T2', speaker: 'Nora Patel', text: 'We want a proper bracket, a decent latch and maybe a warning light.' }
];
const rewritten = 'Nora Patel criticised the current latch as cheap and poor quality and proposed a proper bracket and a decent latch, with a warning light as a possibility.';
function input() { return [{ id: 'topic', topic: 'Equipment',
  points: [
    { id: 'a', text: 'The current latch was poor quality, with suggestions for a proper bracket, a decent latch, and potentially a warning light.',
      evidenceIds: ['T2'], primaryEvidenceIds: ['T2'], reviewFlagIds: [], supportingDetails: [], mergedFromIds: ['previous-a'] },
    { id: 'b', text: 'Nora Patel described the current latch as cheap and proposed a proper bracket, latch, and possibly a warning light.',
      evidenceIds: ['T1', 'T2'], reviewFlagIds: [], supportingDetails: [], discoveryDisposition: 'core' }
  ], decisions: [], openQuestions: [] }]; }
const witnesses = () => sourceUnits.map(s => ({ sourceId: s.id, quote: s.text }));
function inventory(packet) { return { version: B.VERSION, packetHash: packet.packetHash,
  results: packet.candidates.map(c => ({ id: c.id, decision: 'inventory',
    records: c.rows.map((row, i) => ({ recordId: row.record.id, claims: [
      { id: 'claim-' + i, text: row.record.text, originalQuote: row.record.text, sourceWitnesses: witnesses() }
    ] })) })) }; }
function proposal(packet, selected) { return { version: B.VERSION, packetHash: packet.packetHash,
  results: selected.map(c => ({ id: c.id, decision: 'rewrite', text: rewritten })) }; }
function verification(packet, selected) { return { version: B.VERSION, packetHash: packet.packetHash,
  results: selected.map(c => ({ id: c.id, selectionHash: c.selectionHash,
    claimChecks: c.inventory.flatMap(r => r.claims.map(claim => ({ claimId: claim.id, supported: true, retained: true,
      outputQuote: c.text, sourceWitnesses: witnesses() }))),
    originalChecks: c.rows.flatMap(r => r.sentences.map((_, sentenceIndex) => ({ recordId: r.record.id, sentenceIndex,
      allClaimsListed: true, supported: true, retained: true, sourceWitnesses: witnesses() }))),
    outputChecks: c.outputSentences.map((_, sentenceIndex) => ({ sentenceIndex, supported: true, noNewClaims: true, sourceWitnesses: witnesses() }))
  })) }; }
function options(extra = {}) { return { encode: async texts => texts.map(() => [1, 0]),
  inventory: async (_, packet) => inventory(packet), propose: async (_, packet, selected) => proposal(packet, selected),
  verify: async (_, packet, selected) => verification(packet, selected), ...extra }; }
test('a verified rewrite preserves full originals, provenance and metadata, with topic-scoped recovery', async () => {
  const original = input(), before = structuredClone(original);
  const result = await B.consolidate(original, sourceUnits, options());
  assert.equal(result.audit.candidates, 1); assert.equal(result.audit.applied, true);
  assert.equal(result.discussion[0].points.length, 1); assert.equal(result.discussion[0].points[0].text, rewritten);
  assert.deepEqual(result.discussion[0].points[0].evidenceIds, ['T2', 'T1']);
  assert.deepEqual(result.discussion[0].points[0].primaryEvidenceIds, ['T2']);
  assert.deepEqual(result.discussion[0].points[0].mergedFromIds, ['previous-a', 'b']);
  assert.equal(result.discussion[0].points[0].discoveryDisposition, 'core');
  assert.equal(result.audit.ledger[0].inventory.length, 2);
  assert.deepEqual(R.restore(result.discussion, sourceUnits, result.audit), before);
  assert.deepEqual(original, before);
});
for (const [name, mutate] of [
  ['unsupported inventory claim', r => { r.results[0].claimChecks[0].supported = false; }],
  ['lost quality or attribution', r => { r.results[0].claimChecks[0].retained = false; r.results[0].claimChecks[0].outputQuote = ''; }],
  ['incomplete atomic inventory despite positive claim checks', r => { r.results[0].originalChecks[0].allClaimsListed = false; }],
  ['unsupported original', r => { r.results[0].originalChecks[0].supported = false; }],
  ['unique original detail not retained', r => { r.results[0].originalChecks[0].retained = false; }],
  ['unsupported output', r => { r.results[0].outputChecks[0].supported = false; }],
  ['new agreement or reason', r => { r.results[0].outputChecks[0].noNewClaims = false; }],
  ['missing claim', r => { r.results[0].claimChecks.pop(); }],
  ['duplicate claim', r => { r.results[0].claimChecks[1] = r.results[0].claimChecks[0]; }],
  ['null claim', r => { r.results[0].claimChecks[0] = null; }],
  ['invented source quote', r => { r.results[0].claimChecks[0].sourceWitnesses[0].quote = 'Not in transcript'; }],
  ['invented output quote', r => { r.results[0].claimChecks[0].outputQuote = 'Not in output'; }],
  ['unknown source', r => { r.results[0].claimChecks[0].sourceWitnesses[0].sourceId = 'missing'; }],
  ['missing output check', r => { r.results[0].outputChecks = []; }],
  ['missing original check', r => { r.results[0].originalChecks = []; }],
  ['duplicate original check', r => { r.results[0].originalChecks[1] = r.results[0].originalChecks[0]; }],
  ['null original check', r => { r.results[0].originalChecks[0] = null; }],
  ['null output check', r => { r.results[0].outputChecks[0] = null; }],
  ['stale selection', r => { r.results[0].selectionHash = 'stale'; }],
  ['stale packet', r => { r.packetHash = 'stale'; }],
  ['overall acceptable verdict cannot replace checks', r => { r.results[0].acceptable = true; }]
]) test(name + ' keeps all original paragraphs', async () => {
  const original = input();
  const result = await B.consolidate(original, sourceUnits, options({ verify: async (_, packet, selected) => {
    const r = verification(packet, selected); mutate(r); return r;
  } }));
  assert.equal(result.audit.applied, false); assert.deepEqual(result.discussion, original);
});
for (const [name, mutate] of [
  ['missing record', r => { r.results[0].records.pop(); }],
  ['duplicate record', r => { r.results[0].records[1] = r.results[0].records[0]; }],
  ['omitted original words', r => { r.results[0].records[0].claims[0].originalQuote = 'The current latch was poor quality'; }],
  ['unknown source', r => { r.results[0].records[0].claims[0].sourceWitnesses[0].sourceId = 'missing'; }],
  ['invented source quote', r => { r.results[0].records[0].claims[0].sourceWitnesses[0].quote = 'invented'; }],
  ['null claim', r => { r.results[0].records[0].claims[0] = null; }],
  ['duplicate claim identity', r => { r.results[0].records[1].claims[0].id = 'claim-0'; }]
]) test('inventory: ' + name + ' cannot reach rewriting', async () => {
  let called = false; const original = input();
  const result = await B.consolidate(original, sourceUnits, options({
    inventory: async (_, packet) => { const r = inventory(packet); mutate(r); return r; },
    propose: async () => { called = true; }
  }));
  assert.equal(called, false); assert.equal(result.audit.applied, false); assert.deepEqual(result.discussion, original);
});
for (const [name, mutate] of [
  ['review warning', r => { r.reviewFlagIds = ['warning']; }],
  ['supporting child', r => { r.supportingDetails = [{ id: 'child', text: 'Unique context.', evidenceIds: ['T1'] }]; }],
  ['reviewer edit', r => { r.reviewerAuthored = true; }],
  ['unknown metadata', r => { r.customState = 'keep'; }],
  ['simulation provenance', r => { r.simulationSource = 'other'; }],
  ['inconsistent citations', r => { r.primaryEvidenceIds = ['missing']; }],
  ['question role', r => { r.text += ' Is this approved?'; }]
]) test(name + ' stays outside rewrite nomination', async () => {
  const original = input(); original[0].points.forEach(mutate);
  let calls = 0; const result = await B.consolidate(original, sourceUnits, options({ inventory: async () => { calls++; } }));
  assert.equal(result.audit.candidates, 0); assert.equal(calls, 0); assert.deepEqual(result.discussion, original);
});
test('reviewer content elsewhere protects the entire topic', async () => {
  const original = input(); original[0].openQuestions.push({ id: 'manual-question', text: 'Review this.', reviewerAuthored: true });
  assert.equal((await B.consolidate(original, sourceUnits, options())).audit.candidates, 0);
});
test('changed figures, removed named attribution, non-shorter output and malformed responses cannot publish', async () => {
  for (const text of [rewritten.replace('Nora Patel ', ''), rewritten + ' It costs 25.', input()[0].points.map(r => r.text).join(' ')]) {
    const result = await B.consolidate(input(), sourceUnits, options({ propose: async (_, packet, selected) => {
      const r = proposal(packet, selected); r.results[0].text = text; return r;
    } }));
    assert.equal(result.audit.applied, false);
  }
});
test('complete source quotes alone do not bypass retained-output witnesses', async () => {
  const result = await B.consolidate(input(), sourceUnits, options({ verify: async (_, packet, selected) => {
    const r = verification(packet, selected); r.results[0].claimChecks[0].outputQuote = ''; return r;
  } }));
  assert.equal(result.audit.applied, false);
});
test('source-neighbour expansion excludes remote accidentally cited context', async () => {
  const sources = Array.from({ length: 40 }, (_, i) => ({ id: 'source-' + i, text: 'Context ' + i }));
  sources[30] = { ...sourceUnits[0], id: 'source-30' }; sources[31] = { ...sourceUnits[1], id: 'source-31' };
  const original = input(); original[0].points[0].evidenceIds = ['source-31']; original[0].points[0].primaryEvidenceIds = ['source-31'];
  original[0].points[1].evidenceIds = ['source-30', 'source-31'];
  original[0].points.push({ id: 'neighbour', text: 'Separate supporting discussion.', evidenceIds: ['source-2'] });
  const packet = await B.prepare(original, sources, options());
  assert.equal(packet.candidates.length, 1); assert.ok(!packet.candidates[0].sourceUnits.some(s => s.id === 'source-2'));
});
test('duplicate sources and record identities cannot publish', async () => {
  assert.equal((await B.consolidate(input(), [...sourceUnits, sourceUnits[0]], options())).audit.candidates, 0);
  const original = input(); original[0].points[1].id = 'a';
  assert.equal((await B.consolidate(original, sourceUnits, options())).audit.candidates, 0);
});
test('callbacks cannot mutate trusted packets or output; stale originals, service failures and shadow mode keep input', async () => {
  const original = input();
  const mutation = await B.consolidate(original, sourceUnits, options({ verify: async (_, packet, selected) => {
    const r = verification(packet, selected); packet.candidates.length = 0; selected[0].text = 'Tampered.'; return r;
  } }));
  assert.equal(mutation.discussion[0].points[0].text, rewritten);
  const shadow = await B.consolidate(original, sourceUnits, options({ shadow: true }));
  assert.deepEqual(shadow.discussion, original); assert.equal(shadow.audit.applied, false); assert.equal(shadow.audit.proposed[0].points.length, 1);
  const failed = await B.consolidate(original, sourceUnits, options({ verify: async () => { throw Error('Offline'); } }));
  assert.deepEqual(failed.discussion, original); assert.equal(failed.audit.reason, 'assessment_failed');
  const changed = structuredClone(sourceUnits);
  const stale = await B.consolidate(original, changed, options({ verify: async (_, packet, selected) => {
    const r = verification(packet, selected); changed[0].text += ' New context.'; return r;
  } }));
  assert.equal(stale.audit.reason, 'stale_input'); assert.deepEqual(stale.discussion, original);
});
test('recovery preserves unrelated edits and refuses source or affected-topic edits', async () => {
  const original = input(); original.push({ id: 'other', topic: 'Other', points: [{ id: 'elsewhere', text: 'Other context.', evidenceIds: ['T1'] }], decisions: [], openQuestions: [] });
  const result = await B.consolidate(original, sourceUnits, options());
  result.discussion[1].points[0].text = 'Reviewer edit.';
  const restored = R.restore(result.discussion, sourceUnits, result.audit);
  assert.deepEqual(restored[0], original[0]); assert.equal(restored[1].points[0].text, 'Reviewer edit.');
  assert.equal(R.restore(result.discussion, [{ ...sourceUnits[0], text: 'Changed.' }], result.audit), null);
  result.discussion[0].points[0].text += ' Reviewer clarification.';
  assert.equal(R.restore(result.discussion, sourceUnits, result.audit), null);
});
test('source-supported wording cannot disappear even when a verifier would approve it', async () => {
  let verifyCalls = 0;
  const original = input();
  const result = await B.consolidate(original, sourceUnits, options({
    propose: async (_, packet, selected) => {
      const response = proposal(packet, selected);
      response.results[0].text = rewritten.replace('a decent latch', 'a latch');
      return response;
    },
    verify: async () => { verifyCalls++; throw Error('Must be rejected before verification'); }
  }));
  assert.equal(verifyCalls, 0); assert.equal(result.audit.reason, 'no_safe_proposal');
  assert.deepEqual(result.discussion, original);
});
test('unsupported checks may report no witnesses but can never become approved coverage', async () => {
  const result = await B.consolidate(input(), sourceUnits, options({ verify: async (_, packet, selected) => {
    const response = verification(packet, selected);
    response.results[0].claimChecks[0].supported = false;
    response.results[0].claimChecks[0].sourceWitnesses = [];
    return response;
  } }));
  assert.equal(result.audit.reason, 'coverage_rejected');
  assert.equal(result.audit.diagnostics[0].failedClaims.length, 1);
  assert.deepEqual(result.discussion, input());
});
test('the independent provider view omits old citation subsets and proposer-picked witnesses, retaining full originals and sources', async () => {
  const packet = await B.prepare(input(), sourceUnits, options());
  const listed = B.inventories(packet, inventory(packet));
  const selected = B.proposals(packet, listed, proposal(packet, listed));
  const view = JSON.parse(B.verificationPrompt(packet, selected).split('\nDATA\n')[1]);
  assert.deepEqual(view.candidates[0].sourceUnits, sourceUnits);
  assert.equal(view.candidates[0].rows[0].originalText, input()[0].points[0].text);
  assert.equal(view.candidates[0].rows[0].evidenceIds, undefined);
  assert.equal(view.candidates[0].inventory[0].claims[0].sourceWitnesses, undefined);
  assert.equal(view.candidates[0].inventory[0].claims[0].text, listed[0].inventory[0].claims[0].text);
});
test('a rejected check preserves topics without points arrays byte-for-byte', async () => {
  const original = input(); original.push({ id: 'decisions-only', topic: 'Other', decisions: [] });
  const result = await B.consolidate(original, sourceUnits, options({ verify: async (_, packet, selected) => {
    const response = verification(packet, selected); response.results[0].claimChecks[0].retained = false; return response;
  } }));
  assert.deepEqual(result.discussion, original);
});
test('uncovered quality, conditions and attribution words fail inventory-span coverage', () => {
  assert.equal(B.coversText('Nora wants a decent latch if approved.', ['Nora wants', 'latch']), false);
  assert.equal(B.coversText('Nora wants a decent latch if approved.', ['Nora wants a decent latch if approved.']), true);
});
