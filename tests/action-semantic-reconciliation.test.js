'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../utils/canonicalMinutes/actionSemanticReconciliation');
const row = (action, extra = {}) => ({ id: 'A4', action, owners: ['Morgan Lee'],
  timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds: ['T1'], reviewFlagIds: [], ...extra });
const source = (text, extra = {}) => ({ id: 'T1', speaker: 'Morgan Lee', text, ...extra });
const span = unit => ({ unitId: unit.id, start: 0, end: unit.text.length, quote: unit.text });
const makePacket = (actions, sourceUnits, extra = {}) => R.prepareActionReconciliation({ actions, sourceUnits, ...extra });
const plainWords = value => String(value).normalize('NFKC').replace(/[’]/g, "'").toLowerCase()
  .match(/[\p{L}\p{N}]+(?:\.[\p{N}]+)?|[£€$%°<>≤≥]/gu) || [];
function proof(packet, original, survivor, semantic = true) {
  const sourceSpans = packet.sourceUnits.map(span);
  const coverage = { originalRef: original.ref, survivorRef: survivor.ref, sourceSpans };
  if (semantic) coverage.semanticProof = {
    originalAction: original.action.action, survivorAction: survivor.action.action,
    originalFacets: structuredClone(original.facets), survivorFacets: structuredClone(survivor.facets),
    clauses: original.clauses.map(originalClause => {
      const survivorClause = survivor.action.action;
      const a = plainWords(originalClause); const b = plainWords(survivorClause);
      return { originalClause, survivorClause, facets: {
        operation: { original: a[0], survivor: b[0], sourceSpans },
        object: { original: a.slice(1).join(' '), survivor: b.slice(1).join(' '), sourceSpans }
      } };
    })
  };
  return coverage;
}
function envelope(packet, select = () => null) {
  return { version: packet.version, packetHash: packet.packetHash, sourceHash: packet.sourceHash,
    inputHash: packet.inputHash, decisions: packet.candidates.map(candidate => {
      const survivorRef = select(candidate, packet);
      if (!survivorRef) return { candidateId: candidate.candidateId, relation: 'distinct' };
      const survivor = packet.rows.find(item => item.ref === survivorRef);
      const refs = [candidate.leftRef, candidate.rightRef];
      return { candidateId: candidate.candidateId, relation: 'equivalent', survivorRef,
        coverage: refs.map(ref => proof(packet, packet.rows.find(item => item.ref === ref), survivor)) };
    }) };
}
function mergePair(actions, units, extra) {
  const packet = makePacket(actions, units, extra);
  const elected = packet.rows[1].ref;
  return { packet, envelope: envelope(packet, () => elected) };
}
const semanticPair = () => [row('Send the assessment results to Jordan.'),
  row('Provide Jordan with the assessment findings.', { id: 'A4', reviewFlagIds: ['flag-second'] })];
const semanticSource = () => [source('I will send Jordan the assessment results, including the findings.')];

test('one source-bound confirmation can reach existing proof without weakening distinct-work gates', () => {
  const units = [source('I will confirm the specification of the pump flow rate supplied by the vendor.')];
  const first = row('Confirm the specification of the pump flow rate supplied by the vendor.');
  const second = row('Confirm the vendor-supplied pump flow-rate specification.', { id: 'B4' });
  const options = { scope: 'bounded_existing_survivors', maxCandidates: 2 };
  const packet = makePacket([first, second], units, options);
  assert.equal(packet.candidates.length, 1, 'the pair must reach source verification');
  assert.equal(R.buildDeterministicEnvelope(packet).decisions[0].relation, 'unresolved',
    'similar wording is not automatic permission to merge');
  assert.equal(R.applyActionReconciliation(packet, envelope(packet)).actions.length, 2);
  for (const changed of [
    { ...second, owners: ['Casey Green'] },
    { ...second, timing: { kind: 'deadline', wording: 'Friday', exactDate: '' } },
    { ...second, reviewFlagIds: ['review-needed'] },
    { ...second, evidenceIds: ['OTHER'] },
    { ...second, action: 'Confirm the vendor-supplied pump flow-rate specification for a different device.' }
  ]) {
    assert.equal(makePacket([first, changed], units, options).candidates.length, 0);
  }
});

test('preparation freezes independent original witnesses and uses unique references despite colliding model IDs', () => {
  const actions = semanticPair(); const units = semanticSource(); const originals = structuredClone({ actions, units });
  const packet = makePacket(actions, units);
  assert.equal(new Set(packet.rows.map(item => item.ref)).size, 2);
  assert.ok(packet.rows.every(item => item.ref !== 'A4'));
  assert.ok(Object.isFrozen(packet.rows[0].action));
  actions[0].evidenceIds.push('later'); units[0].text = 'changed';
  assert.deepEqual(packet.rows.map(item => item.action), originals.actions);
  assert.deepEqual(packet.sourceUnits, originals.units);
  assert.deepEqual(makePacket(originals.actions, originals.units), packet);
});

test('complete source-bound facet mappings can authorize a paraphrase that existing lexical proof refuses', () => {
  const actions = semanticPair(); const units = semanticSource();
  const before = structuredClone({ actions, units }); const { packet, envelope: decision } = mergePair(actions, units);
  assert.equal(R.mechanicalCoverage(actions[0], actions[1]).covered, false);
  const result = R.applyActionReconciliation(packet, decision);
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].action, actions[1].action);
  assert.equal(result.actions[0].id, actions[1].id);
  assert.deepEqual(result.actions[0].reviewFlagIds, ['flag-second']);
  assert.equal(result.receipts.length, 1);
  assert.equal(result.receipts[0].lineage.length, 2);
  assert.equal(R.validateReconciliationReceipt(result.receipts[0], actions[0], result.actions[0], units), true);
  assert.deepEqual({ actions, units }, before);
});

test('a relation, confidence and true source quote alone cannot delete a semantic paraphrase', () => {
  const { packet, envelope: decision } = mergePair(semanticPair(), semanticSource());
  for (const item of decision.decisions[0].coverage) delete item.semanticProof;
  decision.decisions[0].confidence = 1;
  const result = R.applyActionReconciliation(packet, decision);
  assert.equal(result.actions.length, 2);
  assert.match(result.ledger[0].reasons.join(','), /source_grounded|semantic_coverage/);
});

test('incomplete, unknown, duplicated, stale and malformed envelopes preserve every row', () => {
  const { packet, envelope: decision } = mergePair(semanticPair(), semanticSource());
  for (const mutate of [e => e.decisions.pop(), e => e.decisions.push(e.decisions[0]),
    e => e.decisions[0].candidateId = 'unknown', e => e.inputHash = 'old',
    e => e.sourceHash = 'old', e => e.packetHash = 'old', e => e.decisions = {},
    e => e.decisions[0].relation = 'merge_everything',
    e => e.decisions[0].coverage[0] = null, e => e.decisions[0].coverage[1] = 4]) {
    const candidate = structuredClone(decision); mutate(candidate);
    const result = R.applyActionReconciliation(packet, candidate);
    assert.deepEqual(result.actions, packet.rows.map(item => item.action));
    assert.equal(result.stats.complete, false);
    assert.equal(result.receipts.length, 0);
  }
  assert.equal(R.applyActionReconciliation(packet, decision, { actions: [...semanticPair()].reverse() }).stats.merged, 0);
  assert.equal(R.applyActionReconciliation(packet, decision, { sourceUnits: [source('Another source.')] }).stats.merged, 0);
  assert.equal(R.applyActionReconciliation(packet, decision, { meetingDate: '2026-01-01' }).stats.merged, 0);
});

test('each exact original clause and its full operation/object mapping is required', () => {
  const { packet, envelope: decision } = mergePair(semanticPair(), semanticSource());
  const mutations = [e => e.decisions[0].coverage.pop(),
    e => e.decisions[0].coverage[0].semanticProof.clauses = [],
    e => e.decisions[0].coverage[0].semanticProof.originalAction += ' changed',
    e => e.decisions[0].coverage[0].semanticProof.originalFacets.owners = [],
    e => e.decisions[0].coverage[0].semanticProof.clauses[0].facets.object.original = 'assessment',
    e => e.decisions[0].coverage[0].semanticProof.clauses[0].survivorClause = 'Invented survivor'];
  for (const mutate of mutations) {
    const candidate = structuredClone(decision); mutate(candidate);
    assert.equal(R.applyActionReconciliation(packet, candidate).actions.length, 2);
  }
});

test('dotted prose abbreviations cannot invent a measurement unit in source-supported action coverage', () => {
  const actions = [row('Review the calibration guidance, e.g. the bench protocols.'),
    row('Review the calibration guidance, for example the bench protocols.')];
  const units = [source('I will review the calibration guidance, for example the bench protocols.')];
  const pair = mergePair(actions, units);
  const result = R.applyActionReconciliation(pair.packet, pair.envelope);
  assert.equal(result.actions.length, 1, 'an abbreviation must not become an unsupported gram unit: '
    + JSON.stringify(result.ledger.map(item => item.reasons)));
  assert.deepEqual(pair.packet.rows.map(item => item.facets.units), [[], []]);
  assert.ok(R.validateReconciliationReceipt(result.receipts[0], actions[0], result.actions[0], units));
});

test('abbreviation boundaries preserve attached real units, case-sensitive volumes and dotted unit products', () => {
  for (const unit of ['g', 'mg', 'kg', 'mL', 'ML']) {
    const packet = makePacket([row(`Send 5${unit} of reagent to Jordan.`)], [source(`I will send 5${unit} of reagent to Jordan.`)]);
    assert.deepEqual(packet.rows[0].facets.units, [unit], unit);
  }
  for (const [text, expected] of [
    ['Record the torque in N.m.', ['N', 'm']],
    ['Record the product in g.m.', ['g', 'm']],
    ['Send 5 mg of reagent to Jordan.', ['mg']]
  ]) {
    const packet = makePacket([row(text)], [source(text)]);
    assert.deepEqual(packet.rows[0].facets.units, expected, text);
  }
  for (const [from, to] of [['5g', '5mg'], ['5mg', '5kg'], ['5mL', '5ML']]) {
    const pair = mergePair([row(`Send ${from} of reagent to Jordan.`), row(`Send ${to} of reagent to Jordan.`)],
      [source(`I will send ${from} or ${to} of reagent to Jordan.`)]);
    const result = R.applyActionReconciliation(pair.packet, pair.envelope);
    assert.equal(result.actions.length, 2, `${from} must not be treated as ${to}`);
    assert.match(result.ledger[0].reasons.join(','), /units_would_change_or_be_lost/);
  }
});

test('unknown dotted products preserve recognized component units and cannot become equivalent', () => {
  for (const [from, to, expected] of [['H.m.', 'H.s.', [['m'], ['s']]], ['B.m.', 'B.s.', [['m'], ['s']]],
    ['e.g.m.', 'e.g.s.', [['g', 'm'], ['g', 's']]], ['tag.e.g.', 'tag.e.s.', [['g'], ['s']]]]) {
    const pair = mergePair([row(`Record the calibration response in ${from}`), row(`Record the calibration response in ${to}`)],
      [source(`I will record the calibration response in ${from} and ${to}`)]);
    const result = R.applyActionReconciliation(pair.packet, pair.envelope);
    assert.equal(result.actions.length, 2, `${from} and ${to} must not lose their distinct unit components`);
    assert.deepEqual(pair.packet.rows.map(item => item.facets.units), expected);
    assert.match(result.ledger[0].reasons.join(','), /units_would_change_or_be_lost/);
  }
});

test('abbreviation handling retains quantity, source-unit and timing safeguards', () => {
  for (const [from, to] of [['5 g', '6 g'], ['5g', '6g']]) {
    const pair = mergePair([row(`Send ${from} of reagent to Jordan.`), row(`Send ${to} of reagent to Jordan.`)],
      [source(`I will send ${from} or ${to} of reagent to Jordan.`)]);
    const result = R.applyActionReconciliation(pair.packet, pair.envelope);
    assert.equal(result.actions.length, 2, `${from} must not be treated as ${to}`);
  }
  const noUnit = mergePair([row('Send 5mg of reagent to Jordan.'), row('Provide Jordan with 5mg of reagent.')],
    [source('I will send Jordan 5 of reagent.')]);
  assert.equal(R.applyActionReconciliation(noUnit.packet, noUnit.envelope).actions.length, 2);
  const actions = [row('Review the calibration guidance, e.g. the bench protocols.', {
    timing: { kind: 'target', wording: 'Monday', exactDate: '' } }),
    row('Review the calibration guidance, for example the bench protocols.', {
      timing: { kind: 'target', wording: 'Tuesday', exactDate: '' } })];
  const pair = mergePair(actions, [source('I will review the calibration guidance and bench protocols Monday or Tuesday.')]);
  assert.equal(R.applyActionReconciliation(pair.packet, pair.envelope).actions.length, 2);
});

test('attached decimal measurements retain the whole number rather than an interchangeable integer prefix', () => {
  for (const quantity of ['5g', '5.2g', '5.6mg', '5.2kg', '5.2mL', '5.2ML']) {
    const packet = makePacket([row(`Send ${quantity} of reagent to Jordan.`)], [source(`I will send ${quantity} of reagent to Jordan.`)]);
    assert.deepEqual(packet.rows[0].facets.quantities, [quantity.match(/^[0-9.]+/)[0]], quantity);
  }
  const different = mergePair([row('Send 5.2g of reagent to Jordan.'), row('Send 5.6g of reagent to Jordan.')],
    [source('I will send 5.2g or 5.6g of reagent to Jordan.')]);
  const blocked = R.applyActionReconciliation(different.packet, different.envelope);
  assert.equal(blocked.actions.length, 2);
  assert.match(blocked.ledger[0].reasons.join(','), /quantities_would_change_or_be_lost/);
  const wrongSource = mergePair([row('Send 5.6g of reagent to Jordan.'), row('Provide Jordan with 5.6g of reagent.')],
    [source('I will send Jordan 5.2g of reagent.')]);
  const unsupported = R.applyActionReconciliation(wrongSource.packet, wrongSource.envelope);
  assert.equal(unsupported.actions.length, 2);
  assert.match(unsupported.ledger[0].reasons.join(','), /quantity_without_direct_source_support/);
  const equal = mergePair([row('Send 5.2g of reagent to Jordan.'), row('Provide Jordan with 5.2 g of reagent.')],
    [source('I will send Jordan 5.2 g of reagent.')]);
  assert.equal(R.applyActionReconciliation(equal.packet, equal.envelope).actions.length, 1,
    'equivalent spacing must not weaken or block a complete quantity witness');
});

test('leading decimals are protected as complete literal quantities', () => {
  const pair = mergePair([row('Send .5g of reagent to Jordan.'), row('Send .6g of reagent to Jordan.')],
    [source('I will send .5g or .6g of reagent to Jordan.')]);
  assert.deepEqual(pair.packet.rows.map(item => item.facets.quantities), [['.5'], ['.6']]);
  assert.equal(R.applyActionReconciliation(pair.packet, pair.envelope).actions.length, 2);
});

test('signed amounts cannot merge with an unsigned amount of the same magnitude', () => {
  const pair = mergePair([row('Send -5g of reagent to Jordan.'), row('Send 5g of reagent to Jordan.')],
    [source('I will send -5g or 5g of reagent to Jordan.')]);
  assert.deepEqual(pair.packet.rows.map(item => item.facets.quantities), [['-5'], ['5']]);
  assert.equal(R.applyActionReconciliation(pair.packet, pair.envelope).actions.length, 2);
});

test('scientific notation retains its whole coefficient and signed exponent', () => {
  for (const [from, to] of [['5e-3g', '5e-4g'], ['5e-3g', '6e-3g']]) {
    const pair = mergePair([row(`Send ${from} of reagent to Jordan.`), row(`Send ${to} of reagent to Jordan.`)],
      [source(`I will send ${from} or ${to} of reagent to Jordan.`)]);
    assert.deepEqual(pair.packet.rows.map(item => item.facets.quantities), [[from.slice(0, -1)], [to.slice(0, -1)]]);
    assert.equal(R.applyActionReconciliation(pair.packet, pair.envelope).actions.length, 2);
  }
});

test('literal numeric forms retain source support and equal attached or spaced measurements', () => {
  for (const quantity of ['.5', '-5', '5e-3', '-.5', '-5.2e-3', '5e+3', '−5']) {
    const pair = mergePair([row(`Send ${quantity}g of reagent to Jordan.`), row(`Provide Jordan with ${quantity} g of reagent.`)],
      [source(`I will send Jordan ${quantity} g of reagent.`)]);
    assert.equal(R.applyActionReconciliation(pair.packet, pair.envelope).actions.length, 1, quantity);
  }
  for (const [amount, sourceAmount] of [['.5', '.6'], ['-5', '5'], ['5e-3', '5e-4'], ['5e-3', '6e-3']]) {
    const pair = mergePair([row(`Send ${amount}g of reagent to Jordan.`), row(`Provide Jordan with ${amount} g of reagent.`)],
      [source(`I will send Jordan ${sourceAmount} g of reagent.`)]);
    const result = R.applyActionReconciliation(pair.packet, pair.envelope);
    assert.equal(result.actions.length, 2, `${sourceAmount} cannot support ${amount}`);
    assert.match(result.ledger[0].reasons.join(','), /quantity_without_direct_source_support/);
  }
});

test('numeric signs do not erase independent range endpoints', () => {
  for (const [amount, expected] of [['5-6', ['5', '6']], ['.5-.6', ['.5', '.6']], ['-5--6', ['-5', '-6']]]) {
    const packet = makePacket([row(`Record a range of ${amount} g.`)], [source(`I will record a range of ${amount} g.`)]);
    assert.deepEqual(packet.rows[0].facets.quantities, expected, amount);
  }
  const pair = mergePair([row('Record a range of -5--6 g.'), row('Record a range of -5--7 g.')],
    [source('I will record a range of -5--6 g or -5--7 g.')]);
  assert.equal(R.applyActionReconciliation(pair.packet, pair.envelope).actions.length, 2);
});

test('decimal backtracking protection preserves complete quantities before sentence punctuation', () => {
  for (const quantity of ['5', '5.2']) {
    const packet = makePacket([row(`Keep the sample count at ${quantity}.`)], [source(`I will keep the sample count at ${quantity}.`)]);
    assert.deepEqual(packet.rows[0].facets.quantities, [quantity]);
  }
  const pair = mergePair([row('Keep the sample count at 5.'), row('Keep the sample count at 6.')],
    [source('I will keep the sample count at 5 or 6.')]);
  assert.equal(R.applyActionReconciliation(pair.packet, pair.envelope).actions.length, 2);
});

test('numbered artifact and version identifiers remain exact tokens rather than independent quantities', () => {
  for (const [from, to] of [['CAL5mg', 'CAL6mg'], ['REV-5.2g', 'REV-5.6g'], ['v5.2', 'v5.6'],
    ['CAL5e-3g', 'CAL5e-4g'], ['v.5', 'v.6']]) {
    const pair = mergePair([row(`Review the ${from} calibration notes.`), row(`Review the ${to} calibration notes.`)],
      [source(`I will review the ${from} and ${to} calibration notes.`)]);
    for (const [index, identifier] of [from, to].entries()) {
      assert.deepEqual(pair.packet.rows[index].facets.quantities, [], identifier);
      assert.ok(pair.packet.rows[index].facets.identifiers.includes(identifier));
    }
    const result = R.applyActionReconciliation(pair.packet, pair.envelope);
    assert.equal(result.actions.length, 2, `${from} and ${to} remain separate identifiers`);
    assert.match(result.ledger[0].reasons.join(','), /identifiers_would_change_or_be_lost/);
  }
});

test('source spans must identify unique unchanged units with exact offsets, quotes and source-linked owners', () => {
  const { packet, envelope: decision } = mergePair(semanticPair(), semanticSource());
  for (const mutate of [e => e.decisions[0].coverage[0].sourceSpans[0].quote = 'invented source',
    e => e.decisions[0].coverage[0].sourceSpans[0].start = 1,
    e => e.decisions[0].coverage[0].sourceSpans[0].unitId = 'unknown',
    e => e.decisions[0].coverage[0].semanticProof.clauses[0].facets.object.sourceSpans = []]) {
    const candidate = structuredClone(decision); mutate(candidate);
    assert.equal(R.applyActionReconciliation(packet, candidate).actions.length, 2);
  }
  const wrongOwner = mergePair(semanticPair(), [source(semanticSource()[0].text, { speaker: 'Another Person' })]);
  assert.equal(R.applyActionReconciliation(wrongOwner.packet, wrongOwner.envelope).actions.length, 2);
  const duplicateUnits = mergePair(semanticPair(), [...semanticSource(), ...semanticSource()]);
  assert.equal(R.applyActionReconciliation(duplicateUnits.packet, duplicateUnits.envelope).actions.length, 2);
});

test('source quotes cannot be clipped to hide a negated operation or governing condition', () => {
  const actions = semanticPair();
  const units = [source('Do not send Jordan the assessment results, including the findings.')];
  const pair = mergePair(actions, units);
  assert.equal(R.applyActionReconciliation(pair.packet, pair.envelope).actions.length, 2);
  const clipped = structuredClone(pair.envelope);
  for (const coverage of clipped.decisions[0].coverage) {
    const shorten = spans => spans.forEach(item => { item.start = item.quote.indexOf('send'); item.quote = item.quote.slice(item.start); });
    shorten(coverage.sourceSpans);
    for (const clause of coverage.semanticProof.clauses) {
      shorten(clause.facets.operation.sourceSpans); shorten(clause.facets.object.sourceSpans);
    }
  }
  assert.equal(R.applyActionReconciliation(pair.packet, clipped).actions.length, 2);
  const conditional = mergePair(actions, [source('If approval arrives, I will send Jordan the assessment results, including the findings.')]);
  const partial = structuredClone(conditional.envelope);
  for (const coverage of partial.decisions[0].coverage) {
    const item = coverage.sourceSpans[0]; item.start = item.quote.indexOf('I will'); item.quote = item.quote.slice(item.start);
  }
  assert.equal(R.applyActionReconciliation(conditional.packet, partial).actions.length, 2);
});

test('hard actor, operation, recipient, condition, modality, quantity, unit and status conflicts override model decisions', () => {
  const base = row('Send the assessment results to Jordan.');
  const controls = [
    { owners: ['Another Person'] },
    { action: 'Review the assessment results to Jordan.' },
    { action: 'Send the assessment results to Casey.' },
    { action: 'Send the assessment results to Jordan after approval.' },
    { action: 'Maybe send the assessment results to Jordan.' },
    { action: 'Send 20 assessment results to Jordan.' },
    { disposition: 'completed' },
    { timing: { kind: 'deadline', wording: 'Tuesday', exactDate: '2026-10-27' } }
  ];
  for (const change of controls) {
    const altered = row(change.action || base.action, change);
    const units = [source('I will send the assessment results to Jordan and Casey after approval, maybe Tuesday, 20 results.')];
    const { packet, envelope: decision } = mergePair([altered, base], units);
    assert.equal(R.applyActionReconciliation(packet, decision).actions.length, 2, JSON.stringify(change));
  }
  for (const [a, b] of [['Send 10 mL of reagent to Jordan.', 'Send 10 ML of reagent to Jordan.'],
    ['Send 25 assessment results to Jordan.', 'Send 30 assessment results to Jordan.']]) {
    const { packet, envelope: decision } = mergePair([row(a), row(b)], [source('I will send 10 mL or 10 ML, 25 or 30 assessment results to Jordan.')]);
    assert.equal(R.applyActionReconciliation(packet, decision).actions.length, 2);
  }
});

test('descriptive when and question content are mapped as objects while actual governing conditions remain protected', () => {
  const first = row('Provide the debug command letters and usage details.');
  const second = row('Provide debug command letters and details of what occurs when those commands are used.');
  const units = [source('I will provide those debug command letters and usage details to you.')];
  const { packet, envelope: decision } = mergePair([first, second], units);
  assert.deepEqual(packet.rows[1].facets.conditions, []);
  assert.equal(R.applyActionReconciliation(packet, decision).actions.length, 1);
  const question = makePacket([row('Review whether the flow rate falls within the applicable range.')], units);
  assert.deepEqual(question.rows[0].facets.conditions, []);
  for (const wording of [
    'Provide debug command letters when approval is received.',
    'Provide debug command letters after approval.',
    'Provide debug command letters before approval.',
    'Provide debug command letters unless approval is refused.'
  ]) {
    const pair = mergePair([first, row(wording)], units);
    assert.equal(R.applyActionReconciliation(pair.packet, pair.envelope).actions.length, 2);
  }
});

test('pronoun-only source operations remain blocked pending a separately validated semantic source-operation contract', () => {
  const pair = mergePair([row('Provide the debug command letters and usage details.'),
    row('Provide debug command letters and details of what occurs when those commands are used.')],
  [source('I have those debug command letters and usage details. I will get those through to you.')]);
  const result = R.applyActionReconciliation(pair.packet, pair.envelope);
  assert.equal(result.actions.length, 2);
  assert.match(result.ledger[0].reasons.join(','), /operation_without_direct_source_anchor/);
});

test('governing prerequisites compare across the action and timing columns without donating a new gate', () => {
  const actions = [row('Sign the audit training documents before participation.', {
    timing: { kind: 'dependency', wording: 'before participation in the audit', exactDate: '' } }),
    row('Sign the audit training documents.', { timing: { kind: 'dependency', wording: 'before participation in the audit', exactDate: '' } })];
  const packet = makePacket(actions, [source('I will sign the audit training documents before participation in the audit.')]);
  assert.deepEqual(packet.rows[0].facets.conditions, packet.rows[1].facets.conditions);
  const changed = makePacket([actions[0], { ...actions[1], timing: { kind: 'dependency', wording: 'after participation in the audit', exactDate: '' } }], packet.sourceUnits);
  assert.equal(R.applyActionReconciliation(changed, envelope(changed, () => changed.rows[1].ref)).actions.length, 2);
});

test('quantity direction, identifiers and role relationships cannot be authorized by a claimed semantic mapping', () => {
  for (const [a, b] of [
    ['Explain the fee increase from £25 to £30 in the renewal letter.', 'Explain the fee increase from £30 to £25 in the renewal letter.'],
    ['Review the route from Depot A to Depot B.', 'Review the route from Depot B to Depot A.'],
    ['Review the ISO 9001 report.', 'Review the ISO 13485 report.']
  ]) {
    const { packet, envelope: decision } = mergePair([row(a), row(b)], [source('I will review and explain the fee increase, route from Depot A to Depot B and ISO 9001 and ISO 13485 reports from £25 to £30.')]);
    assert.equal(R.applyActionReconciliation(packet, decision).actions.length, 2);
  }
  const actions = [row("Review the standard's range of applicability."), row("Review the standard's range of applicability.", { id: 'second' })];
  const packet = makePacket(actions, [source("I will review the standard's range of applicability.")]);
  assert.deepEqual(packet.rows[0].facets.units, []);
  assert.equal(R.applyActionReconciliation(packet, R.buildDeterministicEnvelope(packet)).actions.length, 1);
});

test('inline temporal occurrences, version and universal scope stay distinct even with empty structured timing', () => {
  for (const [a, b] of [
    ['Send the assessment report tomorrow.', 'Send the assessment report Friday.'],
    ['Send the assessment report tomorrow morning.', 'Send the assessment report tomorrow evening.'],
    ['Send the current assessment report.', 'Send the previous assessment report.'],
    ['Review all assessment reports.', 'Review some assessment reports.'],
    ['Sign both assessment documents.', 'Sign the assessment document.']
  ]) {
    const pair = mergePair([row(a), row(b)], [source('I will send, review and sign all current and previous assessment reports and both documents tomorrow morning, Friday evening.')]);
    assert.equal(R.applyActionReconciliation(pair.packet, pair.envelope).actions.length, 2);
  }
});

test('extra supported monetary detail is directional while different amounts and missing source support remain blocked', () => {
  const simple = row('Explain the fee increase in the renewal letter.');
  const richer = row('Explain the fee increase from £25 to £30 in the renewal letter.');
  const units = [source('I will explain the fee increase from £25 to £30 in the renewal letter.')];
  const { packet, envelope: decision } = mergePair([simple, richer], units);
  assert.equal(R.applyActionReconciliation(packet, decision).actions.length, 1);
  const reverse = envelope(packet, () => packet.rows[0].ref);
  assert.equal(R.applyActionReconciliation(packet, reverse).actions.length, 2);
  const unsupported = mergePair([simple, richer], [source('I will explain the fee increase in the renewal letter.')]);
  assert.equal(R.applyActionReconciliation(unsupported.packet, unsupported.envelope).actions.length, 2);
});

test('a quantity substring or an absent source unit is not a direct source witness', () => {
  for (const [actions, units] of [
    [[row('Explain the fee increase in the renewal letter.'), row('Explain the £2 fee increase in the renewal letter.')],
      [source('I will explain the £25 fee increase in the renewal letter.')]],
    [[row('Send the reagent to Jordan.'), row('Send 10 mL of reagent to Jordan.')],
      [source('I will send 10 ML of reagent to Jordan.')]]
  ]) {
    const pair = mergePair(actions, units);
    const result = R.applyActionReconciliation(pair.packet, pair.envelope);
    assert.equal(result.actions.length, 2);
    assert.match(result.ledger[0].reasons.join(','), /quantity_without|unit_without/);
  }
});

test('spoken monetary comparisons use the existing number and currency normalizers without rewriting exact source spans', () => {
  const actions = [row('Explain the fee increase in the renewal letter.'),
    row('Explain the fee increase from £25 to £30 in the renewal letter.')];
  const units = [source('I will explain the fee increase from twenty-five to thirty pounds in the renewal letter.')];
  const { packet, envelope: decision } = mergePair(actions, units);
  const result = R.applyActionReconciliation(packet, decision);
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].action, actions[1].action);
  assert.equal(result.receipts[0].coverage[0].sourceSpans[0].quote, units[0].text);
});

test('a source-stated richer target phrase retains its context with identical temporal atoms and no timing upgrade', () => {
  const actions = [row('Take a photo of the boundary fence for the council letter.', {
    timing: { kind: 'target', wording: 'on my way past tomorrow', exactDate: '' }, timingDecision: { status: 'rejected' } }),
  row('Take a photo of the boundary fence.', { timing: { kind: 'target', wording: 'tomorrow', exactDate: '' },
    timingDecision: { status: 'rejected' } })];
  const units = [source('I will take a photo of the boundary fence for the council letter on my way past tomorrow.')];
  const packet = makePacket(actions, units);
  const result = R.applyActionReconciliation(packet, envelope(packet, () => packet.rows[0].ref));
  assert.equal(result.actions.length, 1);
  assert.deepEqual(result.actions[0].timing, actions[0].timing);
  assert.deepEqual(result.actions[0].timingDecision, actions[0].timingDecision);
  for (const timing of [
    { kind: 'deadline', wording: 'tomorrow', exactDate: '' },
    { kind: 'target', wording: 'probably tomorrow', exactDate: '' },
    { kind: 'target', wording: 'tomorrow morning', exactDate: '' },
    { kind: 'target', wording: 'tomorrow or Friday', exactDate: '' },
    { kind: 'target', wording: 'tomorrow', exactDate: '2026-10-23' },
    { kind: 'dependency', wording: 'after approval tomorrow', exactDate: '' }
  ]) {
    const controls = makePacket([actions[0], { ...actions[1], timing }], units);
    assert.equal(R.applyActionReconciliation(controls, envelope(controls, () => controls.rows[0].ref)).actions.length, 2);
  }
});

test('deterministic complete envelopes only merge bounded directly source-grounded instructions', () => {
  const actions = [row('Send the inspection report.'), row('Send the inspection report.', { id: 'second' })];
  const packet = makePacket(actions, [source('I will send the inspection report.')]);
  const decision = R.buildDeterministicEnvelope(packet);
  assert.equal(R.validateEnvelope(packet, decision), '');
  assert.equal(R.applyActionReconciliation(packet, decision).actions.length, 1);
  const unproved = makePacket(semanticPair(), semanticSource());
  const unchanged = R.applyActionReconciliation(unproved, R.buildDeterministicEnvelope(unproved));
  assert.equal(unchanged.actions.length, 2);
  assert.equal(unchanged.stats.complete, false);
});

test('validated proof citations are included and counted even when both old citation bundles are wrong', () => {
  const actions = semanticPair().map(action => ({ ...action, evidenceIds: ['WRONG'] }));
  const units = semanticSource();
  const { packet, envelope: decision } = mergePair(actions, units);
  const merged = R.applyActionReconciliation(packet, decision);
  assert.deepEqual(merged.actions[0].evidenceIds, ['T1', 'WRONG']);
  const capped = makePacket(actions, units, { evidenceLimit: 1 });
  assert.equal(R.applyActionReconciliation(capped, envelope(capped, () => capped.rows[1].ref)).actions.length, 2);
});

test('rejected or unresolved timing cannot become verified through a merge and original receipts remain in lineage', () => {
  const base = row('Send the assessment results to Jordan.', { timingDecision: { status: 'rejected', rejectedExactDates: ['2026-10-27'] } });
  const other = { ...base, timingDecision: { status: 'verified' } };
  const { packet, envelope: decision } = mergePair([base, other], [source('I will send the assessment results to Jordan.')]);
  assert.equal(R.applyActionReconciliation(packet, decision).actions.length, 2);
});

test('reviewer-authored and explicitly kept occurrences never enter automatic merge candidates', () => {
  const actions = semanticPair(); actions[0].reviewerAuthored = true;
  const protectedPacket = makePacket(actions, semanticSource());
  assert.equal(protectedPacket.candidates.length, 0);
  assert.deepEqual(R.applyActionReconciliation(protectedPacket, envelope(protectedPacket)).actions, actions);
  const kept = semanticPair(); kept[0].occurrenceId = 'kept-one';
  assert.equal(makePacket(kept, semanticSource(), { protectedOccurrenceIds: ['kept-one'] }).candidates.length, 0);
});

test('A-to-B and B-to-C never authorize an unproved A-to-C transitive merge or pooled evidence match', () => {
  const actions = [row('Send the assessment results to Jordan.', { id: 'one', evidenceIds: ['T1'] }),
    row('Provide Jordan with the assessment findings.', { id: 'two', evidenceIds: ['T1', 'T2'] }),
    row('Share the assessment conclusions with Jordan.', { id: 'three', evidenceIds: ['T2'] })];
  const units = [source('I will send Jordan the assessment results and findings.'),
    source('I will share the assessment findings and conclusions with Jordan.', { id: 'T2' })];
  const packet = makePacket(actions, units);
  const [a, b, c] = packet.rows;
  const decision = envelope(packet, pair => {
    const refs = [pair.leftRef, pair.rightRef];
    if (refs.includes(a.ref) && refs.includes(b.ref)) return b.ref;
    if (refs.includes(b.ref) && refs.includes(c.ref)) return c.ref;
    return null;
  });
  const result = R.applyActionReconciliation(packet, decision);
  assert.ok(result.actions.length >= 2);
  assert.ok(!result.receipts.some(receipt => receipt.originalRef === a.ref && receipt.survivorRef === c.ref));
  assert.deepEqual(packet.rows.map(item => item.action), actions);
});

test('capacity exhaustion preserves rows and complete source/flag lineage instead of truncating metadata', () => {
  const actions = semanticPair(); actions[0].evidenceIds = ['T1', 'T2']; actions[1].evidenceIds = ['T1', 'T3'];
  actions[0].reviewFlagIds = ['first'];
  for (const limits of [{ evidenceLimit: 2 }, { flagLimit: 1 }]) {
    const { packet, envelope: decision } = mergePair(actions, semanticSource(), limits);
    const result = R.applyActionReconciliation(packet, decision);
    assert.equal(result.actions.length, 2);
    assert.match(result.unresolved.map(item => item.reason).join(','), /capacity/);
    assert.deepEqual(result.actions, actions);
  }
});

test('candidate budgets expose unassessed pairs and never mutate or delete skipped work', () => {
  const actions = [...semanticPair(), row('Share the assessment conclusions with Jordan.', { id: 'third' })];
  const packet = makePacket(actions, semanticSource(), { maxCandidates: 1 });
  const result = R.applyActionReconciliation(packet, envelope(packet));
  assert.equal(result.actions.length, 3);
  assert.ok(result.unresolved.some(item => item.reason === 'candidate_budget_exhausted'));
  assert.equal(result.stats.complete, false);
});

test('merge preserves unsupported, weak and timing-warning metadata without selecting a different timing decision', () => {
  const actions = semanticPair();
  Object.assign(actions[0], { _unsupportedEvidenceIds: ['U1'], _weakEvidenceIds: ['W1'],
    _timingConflicts: ['conflict'], _timingPublicationIssue: 'source needs review' });
  const pair = mergePair(actions, semanticSource());
  const result = R.applyActionReconciliation(pair.packet, pair.envelope);
  assert.equal(result.actions.length, 1);
  for (const field of ['_unsupportedEvidenceIds', '_weakEvidenceIds', '_timingConflicts', '_timingPublicationIssue']) {
    assert.deepEqual(result.actions[0][field], actions[0][field]);
  }
  const incompatible = semanticPair();
  incompatible[0]._timingClauseNote = 'first source qualification';
  incompatible[1]._timingClauseNote = 'another source qualification';
  const blocked = mergePair(incompatible, semanticSource());
  assert.equal(R.applyActionReconciliation(blocked.packet, blocked.envelope).actions.length, 2);
});

test('merged timing rejection histories remain active while the elected assessment and lineage stay intact', () => {
  const Timing = require('../utils/meetingMinutesTiming');
  const units = semanticSource(); const meetingDate = '2026-10-22';
  const actions = semanticPair().map((item, index) => ({ ...item, timingDecision: {
    version: Timing.TIMING_POLICY_VERSION, ...Timing.timingAssessmentKey(item, units, meetingDate),
    status: 'rejected', reason: `original-assessment-${index}`,
    rejectedExactDates: index ? ['2030-05-03', '2030-06-04'] : ['2030-04-02', '2030-05-03'],
    rejectedWordings: index ? ['after the next inspection', 'next quarter'] : ['next Friday', 'next quarter']
  } }));
  const before = structuredClone(actions); const pair = mergePair(actions, units, { meetingDate });
  const result = R.applyActionReconciliation(pair.packet, pair.envelope);
  assert.equal(result.actions.length, 1);
  const elected = result.actions[0]; const decision = elected.timingDecision;
  assert.deepEqual(decision.rejectedExactDates, ['2030-04-02', '2030-05-03', '2030-06-04']);
  assert.deepEqual(decision.rejectedWordings, ['after the next inspection', 'next Friday', 'next quarter']);
  const { rejectedExactDates: _dates, rejectedWordings: _wordings, ...actualAssessment } = decision;
  const { rejectedExactDates: _oldDates, rejectedWordings: _oldWordings, ...expectedAssessment } = actions[1].timingDecision;
  assert.deepEqual(actualAssessment, expectedAssessment);
  assert.equal(Timing.assessmentMatches(elected, units, meetingDate, decision), true);
  for (const timing of [
    { kind: 'target', wording: '', exactDate: '2030-04-02' },
    { kind: 'target', wording: 'next Friday', exactDate: '' }
  ]) {
    const checked = Timing.assessActionTiming({ ...elected, timing }, units, { meetingDate });
    assert.equal(checked.action.timing.exactDate, '');
    assert.equal(checked.action.timing.wording, '');
    assert.deepEqual(checked.action.timingDecision.rejectedExactDates, decision.rejectedExactDates);
    assert.deepEqual(checked.action.timingDecision.rejectedWordings, decision.rejectedWordings);
  }
  assert.ok(R.validateReconciliationReceipt(result.receipts[0], actions[0], elected, units));
  assert.deepEqual(result.receipts[0].lineage.map(item => item.original).sort((a,b) => a.action.localeCompare(b.action)),
    [...before].sort((a,b) => a.action.localeCompare(b.action)));
  assert.deepEqual(actions, before);
});

test('a merge cannot revive a rejected wording or drop histories into an unassessed survivor', () => {
  const units = semanticSource(); const actions = semanticPair();
  actions[0].timingDecision = { status: 'verified', rejectedExactDates: ['2030-04-02'], rejectedWordings: ['next Friday'] };
  const first = mergePair(actions, units);
  assert.equal(R.applyActionReconciliation(first.packet, first.envelope).actions.length, 2);
  assert.match(R.applyActionReconciliation(first.packet, first.envelope).ledger[0].reasons.join(','), /timing_rejection_history_without_survivor_decision/);
  const timed = semanticPair().map(item => ({ ...item, timing: { kind: 'target', wording: 'next Friday', exactDate: '' },
    timingDecision: { status: 'rejected', rejectedWordings: ['next Friday'] } }));
  const second = mergePair(timed, units);
  assert.equal(R.applyActionReconciliation(second.packet, second.envelope).actions.length, 2);
  assert.match(R.applyActionReconciliation(second.packet, second.envelope).ledger[0].reasons.join(','), /rejected_wording_would_return/);
});

test('receipt identity rebinding permits only exact app-identity allocation and retains original lineage', () => {
  const input = semanticPair(); const units = semanticSource();
  const pair = mergePair(input, units); const result = R.applyActionReconciliation(pair.packet, pair.envelope);
  const before = result.actions[0]; const receipt = result.receipts[0];
  const after = { ...before, id: 'action-app-allocated', occurrenceId: 'occurrence-allocated' };
  const rebound = R.rebindReconciliationReceipt(receipt, before, after, units);
  assert.ok(rebound);
  assert.equal(Object.isFrozen(rebound), true);
  assert.equal(rebound.previousReceiptHash, receipt.receiptHash);
  assert.deepEqual(rebound.lineage, receipt.lineage);
  assert.deepEqual(rebound.identityMapping, { before: { id: before.id, occurrenceId: '' },
    after: { id: after.id, occurrenceId: after.occurrenceId } });
  assert.equal(R.validateReconciliationReceipt(rebound, input[0], after, units), true);
  assert.equal(R.validateReconciliationReceipt(receipt, input[0], after, units), false);
  for (const mutation of [{ action: 'Changed wording.' }, { owners: ['Wrong Person'] },
    { timing: { kind: 'target', wording: 'tomorrow', exactDate: '' } }, { evidenceIds: ['changed'] },
    { reviewFlagIds: [] }, { _timingConflicts: ['new metadata'] }, { occurrenceId: 'invalid token' }]) {
    assert.equal(R.rebindReconciliationReceipt(receipt, before, { ...after, ...mutation }, units), null);
  }
  assert.equal(R.rebindReconciliationReceipt(receipt, { ...before, occurrenceId: 'wrong-same-ID-sibling' }, after, units), null);
  assert.equal(R.rebindReconciliationReceipt(receipt, before, after, [source('Changed source.')]), null);
});

test('repeated reconciliation is idempotent and row permutation preserves the elected identity and metadata', () => {
  const actions = semanticPair(); const units = semanticSource();
  const first = mergePair(actions, units); const out = R.applyActionReconciliation(first.packet, first.envelope);
  const repeat = makePacket(out.actions, units);
  assert.deepEqual(R.applyActionReconciliation(repeat, envelope(repeat)).actions, out.actions);
  const reversed = makePacket([...actions].reverse(), units);
  const elected = reversed.rows.find(item => item.action.action === actions[1].action).ref;
  assert.deepEqual(R.applyActionReconciliation(reversed, envelope(reversed, () => elected)).actions, out.actions);
  assert.equal(R.validateReconciliationReceipt(out.receipts[0], actions[0], { ...out.actions[0], action: 'Changed text.' }, units), false);
  assert.equal(R.validateReconciliationReceipt(out.receipts[0], actions[0], out.actions[0], [source('Changed source.')]), false);
});

test('frozen photo and Saturday purchase timing differences remain explicitly blocked', () => {
  const photo = [row('Take a photo of the railway-side boundary fence for inclusion with the council correspondence.', {
    timing: { kind: 'target', wording: 'on my way past tomorrow', exactDate: '' } }),
  row('Take a photo of the boundary fence along the railway side.', { timing: { kind: 'target', wording: 'tomorrow', exactDate: '' } })];
  const units = [source('I will take a photo of the boundary fence on my way past tomorrow for the council correspondence.')];
  const first = mergePair(photo, units);
  assert.equal(R.applyActionReconciliation(first.packet, first.envelope).actions.length, 2);
  const purchase = [row('Buy a hasp, padlock and solar alarm, keeping the cost under £50.'),
    row('Buy a proper hasp, decent padlock and solar alarm, keeping the cost under £50.', {
      timing: { kind: 'target', wording: 'Saturday', exactDate: '' }, timingDecision: { status: 'rejected' } })];
  const second = mergePair(purchase, [source('Buy the hasp, padlock and solar alarm under £50 and fit it Saturday.')]);
  assert.equal(R.applyActionReconciliation(second.packet, second.envelope).actions.length, 2);
});
