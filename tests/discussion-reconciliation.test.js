'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { VERSION, FACETS, prepareDiscussionReconciliation: prepare, applyDiscussionReconciliation: apply } = require('../utils/canonicalMinutes/discussionReconciliation');
const clone = value => JSON.parse(JSON.stringify(value));
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, stable(value[key])])) : value;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const row = (id, text, extra = {}) => ({ id, text, evidenceIds: ['T1'], reviewFlagIds: [], supportingDetails: [], ...extra });
const topic = (id, points = [], extra = {}) => ({ id, topic: 'Delivery planning', points, decisions: [], openQuestions: [], ...extra });
const unit = (id, text) => ({ id, speaker: 'Alex Reed', text });
const opts = sourceUnits => ({ sourceUnits, policyVersion: 'test-policy' });
function span(source) { return { unitId: source.id, start: 0, end: source.text.length, quote: source.text }; }
function envelope(packet, choices = {}) {
  return { version: VERSION, packetHash: packet.packetHash, sourceHash: packet.sourceHash, inputHash: packet.inputHash,
    decisions: packet.candidates.map(candidate => {
      const choice = choices[candidate.candidateId] || { relation: 'distinct' };
      if (['distinct', 'partial_overlap', 'unresolved'].includes(choice.relation)) return { candidateId: candidate.candidateId, relation: choice.relation };
      const winner = packet.rows.find(row => row.ref === choice.survivorRef);
      const originals = [candidate.leftRef, candidate.rightRef].map(ref => packet.rows.find(row => row.ref === ref));
      return { candidateId: candidate.candidateId, relation: choice.relation, survivorRef: winner.ref,
        coverage: originals.map(original => ({
          fromRef: original.ref, toRef: winner.ref, preservedFacets: [...FACETS], protectedFacets: clone(original.protectedFacets),
          sourceSpans: [span(packet.sourceUnits[0])],
          clauseMap: original.clauses.map(clause => ({
            fromClauseId: clause.clauseId, toClauseIds: winner.clauses.map(value => value.clauseId),
            sourceSpans: [span(packet.sourceUnits[0])]
          }))
        }))
      };
    })
  };
}
function choose(packet, fromIndex, survivorIndex) {
  const from = packet.rows[fromIndex], winner = packet.rows[survivorIndex];
  const candidate = packet.candidates.find(pair => [pair.leftRef, pair.rightRef].includes(from.ref) && [pair.leftRef, pair.rightRef].includes(winner.ref));
  assert.ok(candidate, 'fixture must reach semantic nomination');
  return [candidate.candidateId, { relation: candidate.rightRef === winner.ref ? 'left_covered_by_right' : 'right_covered_by_left', survivorRef: winner.ref }];
}

test('exact same-role proposition merges metadata without changing topic order or inputs', () => {
  const text = 'The committee approved the extension.';
  const input = [topic('one', [row('first', text, { reviewFlagIds: ['a'] }), row('second', text, { reviewFlagIds: ['b'], primaryEvidenceIds: ['T1'] })]),
    topic('two', [row('distinct', 'The supplier confirmed delivery.')])];
  const sources = [unit('T1', text)];
  const before = clone(input), packet = prepare(input, opts(sources));
  assert.equal(packet.deterministicDecisions.length, 1);
  const result = apply(input, packet, null, opts(sources));
  assert.equal(result.discussion[0].points.length, 1);
  assert.deepEqual(result.discussion.map(value => value.id), ['one', 'two']);
  assert.equal(result.discussion[0].points[0].id, 'first');
  assert.deepEqual(result.discussion[0].points[0].reviewFlagIds, ['a', 'b']);
  assert.deepEqual(result.discussion[0].points[0].primaryEvidenceIds, ['T1']);
  assert.deepEqual(input, before);
  assert.deepEqual(result.ledger[0].originalRows.map(value => value.record.id), ['first', 'second']);
  assert.equal(result.ledger[0].finalSurvivorHash, hash(result.discussion[0].points[0]));
});

test('parent main fact can absorb its exact supporting echo while retaining other supporting facts', () => {
  const text = 'The committee approved the extension.';
  const input = [topic('one', [row('main', text, { supportingDetails: [
    row('echo', text, { reviewFlagIds: ['support-check'] }), row('unique', 'The supplier requires a separate permit.')
  ] })])];
  const sources = [unit('T1', text)], packet = prepare(input, opts(sources));
  const result = apply(input, packet, null, opts(sources));
  assert.deepEqual(result.discussion[0].points[0].supportingDetails.map(value => value.id), ['unique']);
  assert.deepEqual(result.discussion[0].points[0].reviewFlagIds, ['support-check']);
  assert.equal(result.ledger[0].finalSurvivorHash, hash(result.discussion[0].points[0]));
});

test('source-complete independent sentence is retained inside the richer existing main row', () => {
  const text = 'The committee approved the extension.';
  const input = [topic('one', [row('short', text), row('rich', text + ' The supplier confirmed delivery.')])];
  const sources = [unit('T1', text)];
  const result = apply(input, prepare(input, opts(sources)), null, opts(sources));
  assert.equal(result.discussion[0].points.length, 1);
  assert.equal(result.discussion[0].points[0].id, 'rich');
  assert.equal(result.discussion[0].points[0].text, input[0].points[1].text);
});

test('questions, decisions and point roles do not substitute for one another', () => {
  const text = 'The committee approved the extension.';
  const input = [topic('one', [row('point', text)], {
    decisions: [row('decision', text)], openQuestions: [row('question', 'Did the committee approve the extension?')]
  })];
  const sources = [unit('T1', text)], packet = prepare(input, opts(sources));
  assert.equal(packet.candidates.length, 0);
  assert.equal(packet.deterministicDecisions.length, 0);
  assert.deepEqual(apply(input, packet, null, opts(sources)).discussion, input);
});

test('reported inquiries remain distinct from their answers even without a question mark', () => {
  for (const inquiry of [
    'Alex asks whether the inspection report is approved.',
    'Alex questions the approval of the inspection report.',
    'Whether the inspection report is approved remains unclear.'
  ]) {
    const answer = 'Alex confirms the inspection report is approved.';
    const input = [topic('one', [row('question', inquiry, { supportingDetails: [row('answer-support', answer)] }), row('answer', answer)])];
    const sources = [unit('T1', inquiry + ' ' + answer)], packet = prepare(input, opts(sources));
    assert.equal(packet.rows[0].protectedReason, 'question_role');
    assert.equal(packet.rows[1].protectedReason, 'reviewer_or_protected_context');
    assert.equal(packet.candidates.length, 0);
    assert.equal(packet.deterministicDecisions.length, 0);
    assert.deepEqual(apply(input, packet, null, opts(sources)).discussion, input);
  }
});

test('reviewer ancestors and explicitly protected proposal before paths remain immutable', () => {
  for (const extra of [{ reviewerAuthored: true }, { source: 'stage_2_human_confirmation' }, { confirmedTopic: true }]) {
    const text = 'The committee approved the extension.';
    const input = [topic('one', [row('main', text, { supportingDetails: [row('support', text)] }), row('echo', text)], extra)];
    const sources = [unit('T1', text)], packet = prepare(input, opts(sources));
    assert.equal(packet.stats.protectedRows, 3);
    assert.deepEqual(apply(input, packet, null, opts(sources)).discussion, input);
  }
  const input = [topic('one', [row('before', 'The committee approved the extension.'), row('generated', 'The committee approved the extension.')])];
  const sources = [unit('T1', input[0].points[0].text)];
  const packet = prepare(input, { ...opts(sources), protectedPaths: [[0, 'points', 0]] });
  assert.deepEqual(apply(input, packet, null, opts(sources)).discussion, input);
});

test('an existing supported semantic survivor uses complete clause mappings and retains source/warning lineage', () => {
  const input = [topic('one', [
    row('one', 'The inspection report received committee approval.', { reviewFlagIds: ['a'] }),
    row('two', 'The committee approved the inspection report.', { reviewFlagIds: ['b'] })
  ])];
  const sources = [unit('T1', 'The committee approved the inspection report at the meeting.')];
  const packet = prepare(input, opts(sources)), [key, choice] = choose(packet, 0, 1);
  const result = apply(input, packet, envelope(packet, { [key]: choice }), opts(sources));
  assert.equal(result.discussion[0].points.length, 1);
  assert.equal(result.discussion[0].points[0].id, 'two');
  assert.deepEqual(result.discussion[0].points[0].reviewFlagIds, ['b', 'a']);
  assert.equal(result.stats.semanticMerged, 1);
  assert.equal(result.ledger[0].representations[0].coverage.length, 2);
});

test('distinct is an assessed successful nonmerge rather than unresolved', () => {
  const input = [topic('one', [row('one', 'The inspection report is approved.'), row('two', 'The inspection report requires revision.')])];
  const sources = [unit('T1', 'The inspection report is approved and the inspection report requires revision.')];
  const packet = prepare(input, opts(sources)), result = apply(input, packet, envelope(packet), opts(sources));
  assert.equal(result.stats.distinctCandidates, packet.candidates.length);
  assert.equal(result.stats.assessedCandidates, packet.candidates.length);
  assert.equal(result.unresolved.length, 0);
  assert.deepEqual(result.discussion, input);
});

test('missing, duplicate, unknown or stale semantic accounting never authorizes a paraphrase removal', () => {
  const input = [topic('one', [row('one', 'The inspection report received committee approval.'), row('two', 'The committee approved the inspection report.')])];
  const sources = [unit('T1', 'The committee approved the inspection report at the meeting.')];
  const packet = prepare(input, opts(sources)), [key, choice] = choose(packet, 0, 1), correct = envelope(packet, { [key]: choice });
  const variants = [null, { ...correct, packetHash: 'stale' }, { ...correct, decisions: [] },
    { ...correct, decisions: [...correct.decisions, ...correct.decisions] },
    { ...correct, decisions: [{ ...correct.decisions[0], candidateId: 'unknown' }] }];
  for (const value of variants) assert.deepEqual(apply(input, packet, value, opts(sources)).discussion, input);
  assert.deepEqual(apply(input, packet, correct, opts([unit('T1', 'Changed source content.')])).discussion, input);
  assert.deepEqual(apply(input, packet, correct, { ...opts(sources), policyVersion: 'new-policy' }).discussion, input);
});

test('clipped source quotes and missing or duplicated clause coverage are rejected', () => {
  const input = [topic('one', [row('one', 'The inspection report received committee approval.'), row('two', 'The committee approved the inspection report.')])];
  const sources = [unit('T1', 'The committee approved the inspection report at the meeting.')];
  const packet = prepare(input, opts(sources)), [key, choice] = choose(packet, 0, 1), correct = envelope(packet, { [key]: choice });
  for (const change of [
    decision => { decision.coverage[0].clauseMap = []; },
    decision => { decision.coverage[0].preservedFacets.pop(); },
    decision => { decision.coverage[0].protectedFacets.numbers.push('99'); },
    decision => { const bad = { unitId: 'T1', start: 4, end: 13, quote: 'committee' }; decision.coverage[0].sourceSpans = [bad]; decision.coverage[0].clauseMap[0].sourceSpans = [bad]; },
    decision => { decision.coverage[0].clauseMap[0].toClauseIds = ['nonexistent']; }
  ]) {
    const value = clone(correct); change(value.decisions[0]);
    assert.deepEqual(apply(input, packet, value, opts(sources)).discussion, input);
  }
});

test('a unique second proposition cannot be hidden behind a mapped unrelated survivor clause', () => {
  const input = [topic('one', [row('one', 'The inspection report is approved. The tender remains open.'), row('two', 'The committee approved the inspection report.')])];
  const sources = [unit('T1', 'The committee approved the inspection report. The tender remains open.')];
  const packet = prepare(input, opts(sources)), [key, choice] = choose(packet, 0, 1);
  assert.deepEqual(apply(input, packet, envelope(packet, { [key]: choice }), opts(sources)).discussion, input);
});

for (const [name, left, right] of [
  ['quantity', 'The report includes three samples.', 'The report includes four samples.'],
  ['unit', 'The report specifies 10 mL.', 'The report specifies 10 ML.'],
  ['polarity', 'The report is not approved.', 'The report is approved.'],
  ['condition', 'The report is sent if approval arrives.', 'The report is sent unless approval arrives.'],
  ['recurrence', 'The report is sent on Monday.', 'The report is sent on Tuesday.'],
  ['causality', 'A battery defect caused an alarm.', 'An alarm caused a battery defect.'],
  ['bounds', 'The report specifies at least 10 samples.', 'The report specifies at most 10 samples.'],
  ['phase', 'The committee approved the report.', 'The committee will approve the report.']
]) test('mechanical direction guards block conflicting ' + name + ' without requesting adjudication', () => {
  const input = [topic('one', [row('one', left), row('two', right)])];
  const sources = [unit('T1', left + ' ' + right)], packet = prepare(input, opts(sources));
  // A less-qualified row can sometimes be represented by a richer one, but
  // conflicting protected values cannot be exchanged in either direction.
  if (['quantity', 'unit', 'polarity', 'condition', 'recurrence', 'causality', 'bounds', 'phase'].includes(name)) assert.equal(packet.candidates.length, 0);
  assert.deepEqual(apply(input, packet, null, opts(sources)).discussion, input);
});

test('main text is never buried into support and unique child details never disappear', () => {
  const text = 'The committee approved the extension.';
  const input = [topic('one', [row('main', text, { supportingDetails: [row('unique', 'The supplier needs a separate permit.')] }),
    row('other', 'The inspection report is ready.', { supportingDetails: [row('echo', text)] })])];
  const sources = [unit('T1', text)], packet = prepare(input, opts(sources));
  for (const decision of packet.deterministicDecisions) {
    const loser = packet.rows.find(row => row.ref === decision.removedRef);
    assert.equal(loser.hasChildren, false);
  }
  const result = apply(input, packet, null, opts(sources));
  assert.equal(result.discussion[0].points[0].supportingDetails[0].id, 'unique');
  assert.equal(result.discussion[0].points[0].text, text);
});

test('no transitive bridge or pooled citation grants an unassessed member coverage', () => {
  const input = [topic('one', [
    row('a', 'The committee approved the inspection report.', { evidenceIds: ['T1'] }),
    row('b', 'Committee approval covers the inspection report.', { evidenceIds: ['T1', 'T2'] }),
    row('c', 'The inspection report has committee approval.', { evidenceIds: ['T2'] })
  ])];
  const sources = [unit('T1', 'The committee approved the inspection report at the meeting.'), unit('T2', 'The inspection report has committee approval for publication.')];
  const packet = prepare(input, opts(sources));
  const ab = choose(packet, 0, 1), bc = choose(packet, 1, 2);
  const decisions = { [ab[0]]: ab[1], [bc[0]]: bc[1] };
  const value = envelope(packet, decisions);
  const normalResult = apply(input, packet, value, opts(sources));
  const reversed = apply(input, packet, { ...value, decisions: [...value.decisions].reverse() }, opts(sources));
  assert.equal(normalResult.stats.removedRows, 1);
  assert.deepEqual(normalResult.discussion, reversed.discussion);
  assert.equal(normalResult.discussion[0].points.length, 2);
});

test('citation and warning limits block a merge without truncating originals', () => {
  for (const kind of ['evidence', 'flags']) {
    const text = 'The committee approved the extension.';
    const sources = Array.from({ length: 9 }, (_, index) => unit('T' + (index + 1), text));
    const input = [topic('one', [row('one', text, { evidenceIds: sources.slice(0, 5).map(value => value.id),
      reviewFlagIds: kind === 'flags' ? Array.from({ length: 20 }, (_, index) => 'a' + index) : [] }),
    row('two', text, { evidenceIds: kind === 'evidence' ? ['T1', ...sources.slice(5).map(value => value.id)] : ['T1'],
      reviewFlagIds: kind === 'flags' ? Array.from({ length: 10 }, (_, index) => 'b' + index) : [] })])];
    const result = apply(input, prepare(input, opts(sources)), null, opts(sources));
    assert.deepEqual(result.discussion, input);
    assert.ok(result.unresolved.some(value => value.reason === 'source_or_warning_limit'));
  }
});

test('candidate budgets expose every unassessed nominated pair and deterministic replay is idempotent', () => {
  const text = 'The committee approved the extension.';
  const input = [topic('one', [row('one', text), row('two', text), row('three', 'Committee approval covers the extension.')])];
  const sources = [unit('T1', text)];
  const packet = prepare(input, { ...opts(sources), maxCandidates: 0 });
  assert.equal(packet.candidates.length, 0);
  assert.ok(packet.unresolved.some(value => value.reason === 'candidate_budget'));
  const first = apply(input, packet, null, opts(sources));
  const second = apply(first.discussion, prepare(first.discussion, { ...opts(sources), maxCandidates: 0 }), null, opts(sources));
  assert.deepEqual(second.discussion, first.discussion);
  assert.equal(second.stats.removedRows, 0);
});

test('invalid source references and repeated source IDs cannot authorize exact removals', () => {
  const text = 'The committee approved the extension.';
  const input = [topic('one', [row('one', text), row('two', text)])];
  for (const sources of [[], [unit('T1', text), unit('T1', text)]]) {
    const packet = prepare(input, opts(sources));
    assert.equal(packet.stats.protectedRows, 2);
    assert.deepEqual(apply(input, packet, null, opts(sources)).discussion, input);
  }
});

test('explicit equivalent clock ranges remain ordered while the richer approval gate survives', () => {
  const short = 'Proposed workshop hours run from 8:30 AM start until 5:00 PM finish.';
  const rich = 'Proposed workshop hours are 8:30 AM to 5 PM, subject to venue approval.';
  const input = [topic('one', [row('short', short), row('rich', rich)])];
  const sources = [unit('T1', rich)], packet = prepare(input, opts(sources));
  const [key, choice] = choose(packet, 0, 1);
  assert.deepEqual(packet.rows[0].protectedFacets.ranges, ['510:1020']);
  assert.deepEqual(packet.rows[1].protectedFacets.ranges, ['510:1020']);
  const result = apply(input, packet, envelope(packet, { [key]: choice }), opts(sources));
  assert.equal(result.discussion[0].points.length, 1);
  assert.equal(result.discussion[0].points[0].text, rich);
  const reversedChoice = choose(packet, 1, 0);
  assert.deepEqual(apply(input, packet, envelope(packet, { [reversedChoice[0]]: reversedChoice[1] }), opts(sources)).discussion, input);
});

test('clock range parsing preserves changed endpoints, order and event-dependent stopping conditions', () => {
  const left = 'Proposed workshop hours are 8:30 AM to 5 PM.';
  for (const right of [
    'Proposed workshop hours are 9:30 AM to 5 PM.',
    'Proposed workshop hours are 5 PM to 8:30 AM.',
    'Proposed workshop hours are 8:30 AM to 5 PM, until the inspection finishes.'
  ]) {
    const input = [topic('one', [row('one', left), row('two', right)])];
    const sources = [unit('T1', left + ' ' + right)], packet = prepare(input, opts(sources));
    if (right.includes('inspection')) {
      const candidate = packet.candidates[0];
      assert.ok(candidate);
      assert.deepEqual(candidate.eligibleDirections, ['left_covered_by_right']);
    } else assert.equal(packet.candidates.length, 0);
    assert.deepEqual(apply(input, packet, null, opts(sources)).discussion, input);
  }
});

test('an unchanged dependency gate may retain additional comma-separated qualifications', () => {
  const short = 'The safety certificate must be ready before the inspection formally starts.';
  const rich = 'The safety certificate must be ready before the inspection formally starts, ideally by Thursday.';
  const input = [topic('one', [row('short', short), row('rich', rich)])];
  const sources = [unit('T1', rich)], packet = prepare(input, opts(sources));
  const [key, choice] = choose(packet, 0, 1);
  const result = apply(input, packet, envelope(packet, { [key]: choice }), opts(sources));
  assert.equal(result.discussion[0].points.length, 1);
  assert.equal(result.discussion[0].points[0].text, rich);
  for (const changed of [
    'The safety certificate must be ready before the inspection formally ends, ideally by Thursday.',
    'The safety certificate must be ready after the inspection formally starts, ideally by Thursday.'
  ]) {
    const other = [topic('one', [row('short', short), row('rich', changed)])];
    assert.equal(prepare(other, opts([unit('T1', changed)])).candidates.length, 0);
  }
});

test('shared citations do not spend semantic budget on clauses without proposition anchors', () => {
  const input = [topic('one', [row('one', 'The inspection report is approved.'), row('two', 'Archive delivery remains operational.')])];
  const sources = [unit('T1', 'The inspection report is approved. Archive delivery remains operational.')];
  const packet = prepare(input, opts(sources));
  assert.equal(packet.candidates.length, 0);
  assert.ok(packet.unresolved.some(item => item.reason === 'mechanically_blocked_pair'));
});

test('malformed nested coverage falls back unchanged rather than throwing', () => {
  const input = [topic('one', [row('one', 'The inspection report received committee approval.'), row('two', 'The committee approved the inspection report.')])];
  const sources = [unit('T1', 'The committee approved the inspection report at the meeting.')];
  const packet = prepare(input, opts(sources)), [key, choice] = choose(packet, 0, 1), correct = envelope(packet, { [key]: choice });
  for (const change of [
    value => { value.decisions[0].coverage = [null, null]; },
    value => { delete value.decisions[0].coverage[0].protectedFacets; },
    value => { value.decisions[0].coverage[0].clauseMap = [null]; },
    value => { value.decisions[0].coverage[0].sourceSpans = [null]; },
    value => { value.decisions[0].coverage[0].clauseMap[0].sourceSpans = [null]; }
  ]) {
    const value = clone(correct); change(value);
    assert.deepEqual(apply(input, packet, value, opts(sources)).discussion, input);
  }
});
