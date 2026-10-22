'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../utils/meetingMinutesTemporalReview');
const V = require('../utils/meetingMinutesAgentV2');

for (const row of [
  'Concern was raised about limited funds available.',
  'There are four rooms available free.',
  'Only two copies available for inspection.',
  'There is sufficient equipment available.',
  'Additional supplies available.',
  'Information available for reference.',
  'There are seven documents available.',
  'Limited money available for purchasing equipment.',
  'Several plots available free.'
]) test(`static resource availability needs ordinary fidelity, not a timing witness: ${row}`, () => {
  assert.equal(T.temporalClaim(row), false);
});

for (const row of [
  'Cody is available.', 'The assessor is available.', 'Cody available.',
  'I am available.', 'I am not available.', 'Dana availability remains unresolved.',
  'There are three assessors available.', 'There are three people available.',
  'There are three inspectors available.', 'Two assessors available.',
  'No staff are available.', 'Three consultants available.',
  'Staff availability is limited.', 'Concern was raised about limited assessors available.',
  'There is limited staff available.', 'Staff and equipment available.',
  'There are two inspectors and three rooms available.',
  'Funds are available.', 'Equipment is available.', 'Fund availability is limited.',
  'Funds available soon.', 'Supplies available now.', 'Rooms still available.',
  'Funds available immediately.', 'Supplies available shortly.',
  'Rooms available instantly.', 'Copies available right away.',
  'Copies currently available.', 'Documents not yet available.',
  'Copies no longer available.', 'Equipment used to be available.',
  'Materials will become available.', 'Materials can become available.',
  'Materials became available.', 'Rooms already available.',
  'There are two rooms available Friday.', 'Equipment available at 10:30.',
  'Copies available 2026-12-04.', 'Rooms available for two weeks.',
  'Rooms available during summer.', 'Supplies available next month.',
  'Materials available only after approval.', 'Fund availability is subject to approval.',
  'Funds available if approved.', 'Funds available on approval.',
  'Copies available on request.', 'Funds available, approval required.',
  'Rooms available pending inspection.', 'Equipment available with permission.',
  'Supplies available before work begins.', 'Funds available unless permission is withheld.',
  'Possibly funds available.', 'Documents available?',
  // Unknown locations or prerequisite tails deliberately retain the guard.
  'Manuals available on the website.'
]) test(`personal, ambiguous or qualified availability remains temporal: ${row}`, () => {
  assert.equal(T.temporalClaim(row), true);
});

function fixture(row, source = row, options = {}) {
  const units = [{ id: 'T0001', speaker: options.speaker || 'Chair', text: source }];
  const discussion = [{ id: 'resources', topic: 'Resources', points: [
    { id: 'availability', text: row, evidenceIds: ['T0001'], reviewFlagIds: [] }
  ], decisions: [], openQuestions: [] }];
  return { discussion, items: V.discussionFidelityCheckItems(discussion, units, options) };
}

function apply(f, extra = {}) {
  return V.applyDiscussionFidelityResults(f.discussion, f.items,
    [{ id: f.items[0].id, verdict: 'supported', evidenceQuote: '', ...extra }]);
}

test('the real discussion fidelity path accepts ordinary supported resources without temporal quotes', () => {
  for (const row of ['Concern was raised about limited funds available.', 'There are four rooms available free.']) {
    const f = fixture(row), before = structuredClone(f);
    const result = apply(f);
    assert.equal(result.accounting.complete, true);
    assert.equal(result.accounting.counts.supported, 1);
    assert.deepEqual(result.flags, []);
    assert.equal(result.discussion[0].points[0].text, row);
    assert.deepEqual(f, before);
  }
});

test('missing quotes still reject genuine scheduling and personal availability in the discussion path', () => {
  for (const row of ['Cody is available.', 'There are three inspectors available.',
    'There are four rooms available soon.', 'There are four rooms available after approval.']) {
    const result = apply(fixture(row));
    assert.equal(result.accounting.complete, false, row);
    assert.equal(result.accounting.items[0].reason, 'temporal_source_binding_not_proved');
    assert.ok(result.flags.some(flag => flag.kind === 'timing'), row);
  }
});

test('static-looking discussion claims cannot drop timing from their originally cited source', () => {
  const row = 'Limited funds available.';
  for (const source of ['Limited funds available after approval.', 'Limited funds available soon.',
    'Limited funds will become available.', 'Limited funds may be available.',
    'Limited funds available Friday.']) {
    const f = fixture(row, source);
    assert.equal(T.temporalClaim(row, { sourceRecords: f.items[0].passageUnits }), true);
    const result = apply(f);
    assert.equal(result.accounting.complete, false, source);
    assert.equal(result.accounting.items[0].reason, 'temporal_source_binding_not_proved', source);
    assert.ok(result.flags.some(flag => flag.kind === 'timing'), source);
  }
  const f = fixture(row, 'Limited funds available after approval.');
  assert.equal(apply(f, { evidenceQuote: 'Limited funds available after approval.' }).accounting.complete, false);
});

test('unrelated nearby scheduling cannot turn static resources into temporal claims', () => {
  const row = 'Limited funds available.', f = fixture(row);
  const units = [{ id: 'T0001', speaker: 'Chair', text: row },
    { id: 'T0002', speaker: 'Chair', text: 'Rooms available after approval Friday.' }];
  f.items = V.discussionFidelityCheckItems(f.discussion, units);
  assert.ok(f.items[0].passageUnits.some(unit => unit.id === 'T0002'));
  const result = apply(f);
  assert.equal(result.accounting.complete, true);
  assert.deepEqual(result.flags, []);
  // Forged item anchors cannot replace the original record's own citations.
  f.items[0].evidenceIds = ['T0002'];
  assert.equal(apply(f).accounting.complete, true);
});

test('speaker names are not interpreted as source timing context', () => {
  const f = fixture('Limited funds available.', undefined, { speaker: 'May' });
  assert.equal(apply(f).accounting.complete, true);
});

test('legacy or incomplete own-source context retains conservative availability checking', () => {
  for (const missing of ['passageUnits', 'evidenceIds', 'one-own-unit']) {
    const f = fixture('Limited funds available.');
    if (missing === 'passageUnits') delete f.items[0].passageUnits;
    if (missing === 'evidenceIds') delete f.discussion[0].points[0].evidenceIds;
    if (missing === 'one-own-unit') f.discussion[0].points[0].evidenceIds.push('T0099');
    const result = apply(f);
    assert.equal(result.accounting.complete, false, missing);
    assert.ok(result.flags.some(flag => flag.kind === 'timing'), missing);
  }
});

test('exact supplied source and attendee names override a resource homonym', () => {
  const row = 'Stock available.';
  assert.equal(T.temporalClaim(row), false);
  assert.equal(T.temporalClaim(row, { people: ['Stock'] }), true);
  assert.equal(T.temporalClaim('Limited funds available.', { people: ['Fund'] }), false);
  for (const options of [{ speaker: 'Stock' }, { people: ['Stock'] }]) {
    const f = fixture(row, row, options);
    assert.ok(f.items[0].temporalPeople.includes('Stock'));
    assert.equal(apply(f).accounting.complete, false);
  }
});

test('old items without people context keep unknown-person guarding', () => {
  const f = fixture('The assessor is available.');
  delete f.items[0].temporalPeople;
  assert.equal(apply(f).accounting.complete, false);
});

test('a supplied malformed temporal witness is never bypassed for static resources', () => {
  const f = fixture('There are four rooms available free.');
  for (const temporalEvidence of [null, [], {}, { schemaVersion: 1, sourceId: 'foreign' }]) {
    const result = apply(f, { temporalEvidence });
    assert.equal(result.accounting.complete, false);
    assert.equal(result.accounting.counts.rejected, 1);
    assert.notEqual(result.accounting.items[0].reason, '');
    assert.ok(result.flags.some(flag => flag.kind === 'timing'));
  }
});

test('static resource classification preserves uncertain, missing and malformed fidelity results', () => {
  const row = 'Limited funds available.', f = fixture(row);
  const uncertain = apply(f, { verdict: 'uncertain', issue: 'added_detail', problemQuote: row,
    reason: 'Cannot verify this resource assertion in the cited passage.' });
  assert.equal(uncertain.accounting.counts.uncertain, 1);
  assert.ok(uncertain.flags.length);
  assert.equal(uncertain.discussion[0].points.length, 0);
  const missing = V.applyDiscussionFidelityResults(f.discussion, f.items, []);
  assert.equal(missing.accounting.complete, false);
  assert.equal(missing.accounting.counts.missing, 1);
  const malformed = apply(f, { evidenceQuote: [] });
  assert.equal(malformed.accounting.complete, false);
  assert.equal(malformed.accounting.counts.malformed, 1);
});

test('existing flags are not passively removed or inputs mutated by the classifier or item preparation', () => {
  const f = fixture('Limited funds available.');
  f.discussion[0].points[0].reviewFlagIds = ['existing-review'];
  const before = structuredClone(f.discussion);
  T.temporalClaim(f.items[0].row);
  V.discussionFidelityCheckItems(f.discussion, []);
  assert.deepEqual(f.discussion, before);
  assert.deepEqual(apply(f).discussion[0].points[0].reviewFlagIds, ['existing-review']);
});

function summaryItems(row, authority = row, extras = {}) {
  const current = { discussion: [{ topic: 'Resources', points: [{ text: authority, evidenceIds: ['T0001'] }] }],
    actions: [], ...extras };
  return T.summaryTemporalCheckItems({ executiveSummary: row, meetingObjectives: [row] }, current);
}

test('summary and objectives skip only standalone static resource claims', () => {
  assert.equal(summaryItems('Limited funds available.').length, 0);
  assert.equal(summaryItems('There are four rooms available free.').length, 0);
  assert.equal(summaryItems('The assessor is available.').length, 2);
  assert.equal(summaryItems('Rooms available Friday.').length, 2);
});

test('summary authority retains temporal checking when static wording omits a real qualification', () => {
  for (const authority of ['Limited funds available after approval.', 'Limited funds will become available.',
    'Limited funds available soon.', 'Limited funds may be available.']) {
    assert.equal(summaryItems('Limited funds available.', authority).length, 2, authority);
  }
});

test('summary exact people context comes from source, details and approved owners', () => {
  const values = { executiveSummary: 'Stock available.', meetingObjectives: [] };
  for (const [current, units] of [
    [{}, [{ id: 'T1', speaker: 'Stock', text: 'A source passage.' }]],
    [{ details: { allAttendees: ['Stock'] } }, []],
    [{ actions: [{ action: 'Review documents.', owners: ['Stock'] }] }, []]
  ]) assert.equal(T.summaryTemporalCheckItems(values, current, units).length, 1);
});
