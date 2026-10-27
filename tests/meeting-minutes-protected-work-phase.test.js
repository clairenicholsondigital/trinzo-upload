'use strict';

process.env.MEETING_MINUTES_AGENT_SPECULATIVE_PIPELINE_V1 = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const { stagedEvaluation: A } = require('../routes/api');
const S = require('../utils/canonicalMinutes/actionSemanticReconciliation');
const U = require('../utils/meetingMinutesActionUnionRewrite');
const C = require('../utils/meetingMinutesCompilationUnion');
const P = require('../utils/meetingMinutesSemanticPolicy');

function fixture() {
  const sourceUnits = [
    { id: 'P01', speaker: 'Morgan Lee', text: 'I am adding the thermal and flow-control considerations to the review checklist.' },
    { id: 'P02', speaker: 'Casey Green', text: 'What do we need to do to progress the two aspects?' },
    { id: 'P03', speaker: 'Morgan Lee', text: "I'm tidying the checklist to share back to the team to have a look, and then I'll add those considerations." },
    { id: 'P04', speaker: 'Morgan Lee', text: "I'm hoping to get that done for Tuesday because I'm focusing on the review for our Tuesday meeting." }
  ];
  const actions = [
    { id: 'phase-a', action: 'Update and share the review checklist including thermal and flow-control considerations.',
      owners: ['Morgan Lee'], evidenceIds: ['P01', 'P03', 'P04'],
      timing: { kind: 'target', wording: 'for Tuesday', exactDate: '' },
      timingDecision: { status: 'rejected', checkerStatus: 'rejected', rejectedExactDates: ['2026-06-16'],
        rejectedWordings: [], reason: 'timing_source_unresolved,unsupported_exact_date' },
      reviewFlagIds: ['a-source', 'a-date', 'a-binding'] },
    { id: 'phase-b', action: 'Complete the review checklist updates and share the updated material for review.',
      owners: ['Morgan Lee'], evidenceIds: ['P03', 'P04'],
      timing: { kind: 'target', wording: 'hoping done for Tuesday', exactDate: '' },
      timingDecision: { status: 'rejected', checkerStatus: 'rejected', rejectedExactDates: ['2026-06-16'],
        rejectedWordings: [], reason: 'timing_source_unresolved,unsupported_exact_date' },
      reviewFlagIds: ['b-source', 'b-date', 'b-binding'] }
  ];
  return { actions, sourceUnits };
}

for (const reverse of [false, true]) test('ordered file handoff/additions are not treated as interchangeable actions (reverse=' + reverse + ')', () => {
  const f = fixture();
  if (reverse) f.actions.reverse();
  const before = structuredClone(f);
  const deduped = A.dedupeHybridActionRecords(f.actions, { sourceUnits: f.sourceUnits });
  const final = A.reconcileFinalApprovedActions(deduped, f.actions, { sourceUnits: f.sourceUnits });
  assert.equal(deduped.length, 2);
  assert.equal(final.actions.length, 2);
  assert.deepEqual(new Set(final.actions.flatMap(r => r.reviewFlagIds)), new Set(f.actions.flatMap(r => r.reviewFlagIds)));
  for (const original of f.actions) {
    const retained = final.actions.find(row => row.id === original.id);
    assert.equal(retained.action, original.action);
    assert.deepEqual(retained.timing, original.timing);
    assert.deepEqual(retained.timingDecision, original.timingDecision);
    assert.deepEqual(retained.evidenceIds, original.evidenceIds);
  }
  assert.deepEqual(f, before);
});

test('a shorter instruction is not an unchanged survivor for the extra scope or review purpose', () => {
  const { actions } = fixture();
  assert.equal(S.mechanicalCoverage(actions[0], actions[1]).covered, false);
  assert.equal(S.mechanicalCoverage(actions[1], actions[0]).covered, false);
});

test('general untimed and compilation classes stay closed to flagged target-timed work', () => {
  const f = fixture();
  const policy = P.captureSemanticPolicy({
    MEETING_MINUTES_AGENT_BOUNDED_SURVIVOR_DEDUPE_V1: '1',
    MEETING_MINUTES_AGENT_CONTACT_ENQUIRY_DEDUPE_V1: '1',
    MEETING_MINUTES_AGENT_CONTAINED_REQUIREMENTS_V1: '1',
    MEETING_MINUTES_AGENT_QUALIFIED_DEPENDENCY_DEDUPE_V1: '1',
    MEETING_MINUTES_AGENT_COMPILATION_UNION_V1: '1'
  });
  assert.equal(S.prepareActionReconciliation({ ...policy, ...f }).candidates.length, 0);
  assert.equal(U.prepare(f.actions, f.sourceUnits, '2026-06-15'), null);
  assert.equal(C.prepare(f.actions, f.sourceUnits, '2026-06-15'), null);
});

for (const [label, change] of [
  ['different assignee', f => { f.actions[1].owners = ['Casey Green']; }],
  ['different occurrence', f => { f.actions[1].timing.wording = 'next Tuesday'; }],
  ['reviewer edit', f => { f.actions[1].reviewerAuthored = true; }],
  ['different version', f => { f.actions[1].action = f.actions[1].action.replace('checklist', 'checklist version 2'); }]
]) test(label + ' cannot be erased because the file or citations overlap', () => {
  const f = fixture(); change(f);
  const final = A.reconcileFinalApprovedActions(
    A.dedupeHybridActionRecords(f.actions, { sourceUnits: f.sourceUnits }),
    f.actions, { sourceUnits: f.sourceUnits });
  assert.equal(final.actions.length, 2);
  assert.ok(final.actions.some(row => row.action === f.actions[1].action));
});
