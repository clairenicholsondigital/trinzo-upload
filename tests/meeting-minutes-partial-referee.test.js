'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../routes/api').stagedEvaluation;
const clone = value => structuredClone(value);
const row = (id, wording, extra = {}) => ({ id, text: wording, evidenceIds: ['T0001'], reviewFlagIds: [], supportingDetails: [], ...extra });
const candidate = (id, record, extra = {}) => ({ candidateId: id, sourcePass: 'primary', recordType: 'discussion_point',
  topic: 'Delivery', text: record.text, evidenceIds: record.evidenceIds, record, ...extra });
const verdict = (id, disposition, targetId = '') => ({ candidateId: id, disposition, targetId,
  reason: 'Evidence reviewed.', evidenceIds: ['T0001'] });
const topic = points => [{ topic: 'Delivery', points, decisions: [], openQuestions: [] }];
function setup(kind = 'supporting') {
  const main = candidate('main', row('main-row', 'Supplier approval remains the delivery blocker.'));
  const support = candidate('context', row('context-row', 'The supplier approval is required before delivery can begin.'));
  const missing = candidate('missing', row('missing-row', 'The warehouse access checklist remains outstanding.', { evidenceIds: ['T0002'] }));
  const candidates = [main, support, missing];
  const contract = A.meetingMinutesAgentRefereeContract('discussion', candidates, 'request', { selected: true });
  const result = { requestId: 'request', stage: 'DISCUSSION_REFEREE', expectedCandidateCount: 3,
    returnedDispositionCount: 2, candidateDispositions: [verdict('main', 'core', 'main'), verdict('context', kind, kind === 'reject' ? '' : 'main')] };
  return { candidates, contract, result, baseline: topic(candidates.map(c => c.record)) };
}

for (const kind of ['supporting', 'merge', 'reject']) test(`a missing sibling cannot revive a valid ${kind} verdict`, () => {
  const s = setup(kind), before = JSON.stringify(s);
  const p = A.discussionRefereeFallbackPlan(s.result, s.contract, s.candidates, s.baseline);
  assert.equal(p.active, true);
  assert.deepEqual(p.dispositions, s.result.candidateDispositions);
  assert.deepEqual(p.candidates.map(c => c.candidateId), ['missing']);
  assert.deepEqual(p.discussion[0].points.map(r => r.id), ['missing-row']);
  assert.deepEqual(p.routedRecords.map(r => r.record.id), ['main-row', 'context-row']);
  assert.equal(JSON.stringify(s), before, 'inputs remain unchanged');
});

test('valid supporting context keeps its original route through actual reconstruction and compacting', () => {
  const s = setup(), p = A.discussionRefereeFallbackPlan(s.result, s.contract, s.candidates, s.baseline);
  const units = [{ id: 'T0001', speaker: 'Morgan', text: 'Supplier approval is required before delivery can begin. Supplier approval remains the delivery blocker.' },
    { id: 'T0002', speaker: 'Priya', text: 'The warehouse access checklist remains outstanding.' }];
  const rebuilt = A.reconstructMissingRefereeDiscussion([], p.dispositions, s.candidates, units);
  const pool = [];
  const compact = A.compactDiscussionPropositions(rebuilt.discussion, p.discussion, units, {
    promoteMaterialSupporting: false, onUnassignedSupportingDetail: detail => { pool.push(detail); return true; }
  });
  const primary = compact.flatMap(t => [...t.points, ...t.decisions]);
  assert.equal(primary.some(r => r.text === s.candidates[1].text), false);
  const all = [...primary, ...primary.flatMap(r => r.supportingDetails || []), ...pool];
  assert.ok(all.some(r => r.text === s.candidates[2].text), 'the failed sibling is retained');
});

test('supporting warnings survive reconstruction', () => {
  const s = setup();
  s.candidates[1].record.reviewFlagIds = ['warning-context'];
  const units = [{ id: 'T0001', speaker: 'Morgan', text: s.candidates.map(c => c.text).join(' ') }];
  const rebuilt = A.reconstructMissingRefereeDiscussion([], s.result.candidateDispositions, s.candidates, units);
  const detail = rebuilt.discussion.flatMap(t => t.points).flatMap(r => r.supportingDetails || [])[0];
  assert.ok(detail.reviewFlagIds.includes('warning-context'));
});

test('a discovery record carrying nested material remains available to fallback', () => {
  const s = setup();
  s.candidates[1].record.supportingDetails = [row('nested', 'Supplier approval is pending legal review.')];
  s.contract = A.meetingMinutesAgentRefereeContract('discussion', s.candidates, 'request', { selected: true });
  const p = A.discussionRefereeFallbackPlan(s.result, s.contract, s.candidates, s.baseline);
  assert.deepEqual(p.discussion[0].points.find(r => r.id === 'context-row').supportingDetails,
    s.candidates[1].record.supportingDetails);
});

test('invalid targets and duplicate candidate verdicts remain eligible for recovery', () => {
  for (const mutate of [s => { s.result.candidateDispositions[1].targetId = 'unknown'; },
    s => { s.result.candidateDispositions.push(clone(s.result.candidateDispositions[1])); s.result.returnedDispositionCount++; }]) {
    const s = setup(); mutate(s);
    const p = A.discussionRefereeFallbackPlan(s.result, s.contract, s.candidates, s.baseline);
    assert.deepEqual(p.settledCandidateIds, ['main']);
    assert.ok(p.candidates.some(c => c.candidateId === 'context'));
    assert.ok(p.discussion[0].points.some(r => r.id === 'context-row'));
  }
});

test('a valid untargeted supporting verdict is preserved without invented core promotion', () => {
  const s = setup(); s.result.candidateDispositions[1].targetId = '';
  const p = A.discussionRefereeFallbackPlan(s.result, s.contract, s.candidates, s.baseline);
  assert.equal(p.dispositions.find(r => r.candidateId === 'context').disposition, 'supporting');
  assert.equal(p.discussion[0].points.length, 1);
});

test('an all-rejected partial result does not require a primary paragraph', () => {
  const s = setup('reject'); s.result.candidateDispositions[0] = verdict('main', 'reject');
  const p = A.discussionRefereeFallbackPlan(s.result, s.contract, s.candidates, s.baseline);
  assert.equal(p.active, true);
  assert.deepEqual(p.discussion[0].points.map(r => r.id), ['missing-row']);
});

test('same IDs with changed wording, citations, warnings or unknown metadata remain recoverable', () => {
  for (const change of [r => { r.text += ' Only after legal review.'; }, r => { r.evidenceIds.push('T0003'); },
    r => { r.reviewFlagIds.push('new-warning'); }, r => { r.customQualification = 'conditional'; }]) {
    const s = setup(); s.baseline = clone(s.baseline); change(s.baseline[0].points[1]);
    const p = A.discussionRefereeFallbackPlan(s.result, s.contract, s.candidates, s.baseline);
    assert.ok(p.discussion[0].points.some(r => r.id === 'context-row'));
  }
});

test('reviewer rows, reviewer descendants and reviewer topics are never consumed by routing', () => {
  for (const change of [s => { s.candidates[1].record.reviewerAuthored = true; },
    s => { s.candidates[1].record.supportingDetails.push(row('manual-child', 'Keep this qualification.', { reviewerAuthored: true })); },
    s => { s.baseline[0].reviewerAuthored = true; }]) {
    const s = setup('reject'); change(s);
    const p = A.discussionRefereeFallbackPlan(s.result, s.contract, s.candidates, s.baseline);
    assert.ok(p.discussion[0].points.some(r => r.id === 'context-row'));
  }
});

test('cluster members use supporting routing but separately unresolved supplied members remain recoverable', () => {
  const s = setup();
  const member = candidate('cluster-extra', row('cluster-row', 'Supplier approval also covers the packing list.'));
  s.candidates[0].clusterMembers = [member, s.candidates[2]];
  s.contract = A.meetingMinutesAgentRefereeContract('discussion', s.candidates, 'request', { selected: true });
  s.candidates.push(member); s.baseline[0].points.push(member.record);
  const p = A.discussionRefereeFallbackPlan(s.result, s.contract, s.candidates, s.baseline);
  assert.equal(p.candidates.some(c => c.candidateId === member.candidateId), false);
  assert.equal(p.candidates.some(c => c.candidateId === 'missing'), true);
});

test('rejecting a cluster does not consume members that the supporting route did not release', () => {
  const s = setup('reject');
  const member = candidate('cluster-extra', row('cluster-row', 'Supplier approval also covers the packing list.'));
  s.candidates[1].clusterMembers = [member];
  s.contract = A.meetingMinutesAgentRefereeContract('discussion', s.candidates, 'request', { selected: true });
  s.candidates.push(member); s.baseline[0].points.push(member.record);
  const p = A.discussionRefereeFallbackPlan(s.result, s.contract, s.candidates, s.baseline);
  assert.ok(p.candidates.some(c => c.candidateId === member.candidateId));
  assert.ok(p.discussion[0].points.some(r => r.id === member.record.id));
});

test('legacy, mismatched and wholly failed contracts keep the existing fallback', () => {
  for (const change of [s => { s.result.requestId = 'different'; }, s => { delete s.result.stage; },
    s => { s.result.candidateDispositions = []; s.result.returnedDispositionCount = 0; }]) {
    const s = setup(); change(s);
    const p = A.discussionRefereeFallbackPlan(s.result, s.contract, s.candidates, s.baseline);
    assert.equal(p.active, false);
    assert.deepEqual(p.discussion, s.baseline);
    assert.deepEqual(p.candidates, s.candidates);
  }
});

test('the production compact selection still consumes exact settled discovery records', () => {
  for (const kind of ['supporting', 'merge', 'reject']) {
    const s = setup(kind);
    const contract = A.meetingMinutesAgentRefereeContract('discussion', s.candidates, 'request');
    assert.ok(contract.candidates.every(c => !c.record), 'exercise the real compact wire boundary');
    const before = JSON.stringify({ contract, candidates: s.candidates, baseline: s.baseline });
    const p = A.discussionRefereeFallbackPlan(s.result, contract, s.candidates, s.baseline);
    assert.equal(p.active, true);
    assert.deepEqual(p.dispositions, s.result.candidateDispositions);
    assert.deepEqual(p.discussion.flatMap(t => t.points).map(r => r.id), ['missing-row']);
    assert.deepEqual(new Set(p.routedRecords.map(r => r.record.id)), new Set(['main-row', 'context-row']));
    assert.equal(JSON.stringify({ contract, candidates: s.candidates, baseline: s.baseline }), before);
  }
});

test('compact binding declines stale or ambiguous identities and preserves protected record trees', () => {
  const mutations = [
    s => { s.candidates[1].text += ' Different claim.'; },
    s => { s.candidates[1].evidenceIds = ['T0099']; },
    s => { s.candidates.push(clone(s.candidates[1])); },
    s => { s.candidates[1].reviewerAuthored = true; },
    s => { s.candidates[1].record.reviewerAuthored = true; },
    s => { s.candidates[1].record.supportingDetails = [row('child', 'Keep the qualification.')]; }
  ];
  for (const mutate of mutations) {
    const s = setup('reject');
    const contract = A.meetingMinutesAgentRefereeContract('discussion', s.candidates, 'request');
    mutate(s);
    const p = A.discussionRefereeFallbackPlan(s.result, contract, s.candidates, s.baseline);
    assert.ok(p.discussion.flatMap(t => t.points).some(r => r.id === 'context-row'));
  }
});

test('recordless cluster members bind privately without consuming an unresolved supplied member', () => {
  const s = setup();
  const member = candidate('extra', row('extra-row', 'Supplier approval also covers packing documentation.'));
  s.candidates.push(member);
  s.baseline[0].points.push(member.record);
  const compact = s.contract.candidates.map(({ record, ...c }) => c);
  compact[0].clusterMembers = [member, s.candidates[2]].map(({ record, ...c }) => c);
  const contract = A.meetingMinutesAgentRefereeContract('discussion', compact, 'request', { selected: true });
  const p = A.discussionRefereeFallbackPlan(s.result, contract, s.candidates, s.baseline);
  assert.deepEqual(p.discussion[0].points.map(r => r.id), ['missing-row']);
  assert.ok(p.routedRecords.some(r => r.record.id === 'extra-row'));
  assert.ok(p.candidates.some(c => c.candidateId === 'missing'));
});
