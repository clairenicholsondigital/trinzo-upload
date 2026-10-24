'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../routes/api').stagedEvaluation;
const S = require('../utils/meetingMinutesSupportingDetails');
const { discussionSelectionCoverage, discussionPublicationCoverage } = require('../utils/meetingMinutesDiscussionCoverage');
const candidate = (id, topic, text, extra = {}) => ({ candidateId: id, topic, text,
  recordType: 'discussion_point', sourcePass: 'primary', evidenceIds: ['T0001'], priority: 5,
  record: { id: id + '-record', text, evidenceIds: ['T0001'], reviewFlagIds: [], supportingDetails: [] }, ...extra });
const topic = points => [{ topic: 'Equipment', points, decisions: [], openQuestions: [] }];
const verdict = (id, targetId = id, disposition = 'core') => ({ candidateId: id, targetId,
  disposition, reason: 'Evidence checked.', evidenceIds: ['T0001'] });
const choose = candidates => {
  const before = process.env.MEETING_MINUTES_AGENT_DISCUSSION_REFEREE_CANDIDATE_LIMIT;
  process.env.MEETING_MINUTES_AGENT_DISCUSSION_REFEREE_CANDIDATE_LIMIT = '24';
  try { return A.meetingAgentRefereeCandidates('discussion', candidates); }
  finally { if (before === undefined) delete process.env.MEETING_MINUTES_AGENT_DISCUSSION_REFEREE_CANDIDATE_LIMIT;
    else process.env.MEETING_MINUTES_AGENT_DISCUSSION_REFEREE_CANDIDATE_LIMIT = before; }
};

test('a concrete subject receives independent assessment before repeated material from a broad risk facet', () => {
  const risk = Array.from({ length: 30 }, (_, i) => candidate('frequency-' + i, 'Frequency justification',
    `The frequency estimate ${i + 1} needs an independent rationale before approval.`,
    { recordType: 'decision', evidenceIds: ['T' + String(i + 1).padStart(4, '0')] }));
  const clock = candidate('battery', 'Battery service interval',
    'Early battery failure is mitigated by a shorter service interval and needs confirmation in the risk analysis.');
  const before = structuredClone([...risk, clock]), selected = choose([...risk, clock]);
  assert.ok(selected.some(c => c.candidateId === 'battery'));
  assert.ok(selected.every(c => !(c.clusterMembers || []).some(m => m.candidateId === 'battery')));
  assert.deepEqual([...risk, clock], before);
});

test('untitled raw windows cannot consume one candidate slot per editorial facet per round', () => {
  const editorial = Array.from({ length: 25 }, (_, i) => candidate('polished-' + i, 'Subject ' + i,
    `The equipment specification ${i + 1} remains under technical review.`,
    { evidenceIds: ['T' + String(i + 1).padStart(4, '0')] }));
  const windows = ['risk approval', 'software security', 'travel timing', 'scope standards', 'access permissions', 'team roles']
    .flatMap((words, group) => Array.from({ length: 5 }, (_, i) => candidate(`raw-${group}-${i}`, undefined,
      `So I think ${words} ${group * 5 + i + 1} needs checking, you know.`,
      { sourcePass: 'deterministic', recordType: 'decision', priority: 9,
        evidenceIds: ['T' + String(group * 5 + i + 100).padStart(4, '0')] })));
  const selected = choose([...windows, ...editorial]);
  assert.ok(selected.filter(c => c.sourcePass === 'deterministic').length <= 1);
  assert.ok(selected.filter(c => c.sourcePass === 'primary').length >= 23);
});

test('numerous secondary headings cannot displace qualified primary statements in the same broad facet', () => {
  const primary = Array.from({ length: 32 }, (_, i) => candidate('qualified-' + i, 'Calibration group ' + (i % 4),
    `Calibration risk ${i + 1} remains subject to supplier confirmation before approval.`,
    { evidenceIds: ['T' + String(i + 1).padStart(4, '0')] }));
  const staged = Array.from({ length: 30 }, (_, i) => candidate('secondary-' + i, 'Secondary heading ' + i,
    `Calibration risk ${i + 100} has been approved.`, { sourcePass: 'staged', recordType: 'decision',
      evidenceIds: ['T' + String(i + 100).padStart(4, '0')] }));
  const selected = choose([...primary, ...staged]);
  assert.equal(selected.length, 24);
  assert.ok(selected.every(c => c.sourcePass === 'primary'));
  assert.ok(selected.every(c => c.text.includes('subject to supplier confirmation')));
});

test('response-budget overflow stays explicitly unassessed and receives no unrelated target', () => {
  const candidates = Array.from({ length: 30 }, (_, i) => candidate('item-' + i, 'Distinct subject ' + i,
    `Material risk ${i + 1} has a separate dependency and needs an independent response.`,
    { evidenceIds: ['T' + String(i + 1).padStart(4, '0')] }));
  const selected = choose(candidates), coverage = discussionSelectionCoverage(candidates, selected);
  assert.equal(selected.length, 24);
  assert.equal(coverage.unassessedCandidateIds.length, 6);
  assert.equal(new Set([...coverage.suppliedCandidateIds, ...coverage.clusteredCandidateIds,
    ...coverage.unassessedCandidateIds]).size, candidates.length);
  assert.ok(selected.every(c => (c.clusterMembers || []).every(m => m.clusterRelation !== 'overflow')));
  const released = A.refereeClusterSupportingCandidates(selected.map(c => verdict(c.candidateId)), selected);
  assert.ok(coverage.unassessedCandidateIds.every(id => !released.some(r => r.candidate.candidateId === id)));
});

test('legacy overflow cannot inherit a target or be consumed as a settled fallback record', () => {
  const main = candidate('main', 'Pressure inspection', 'The coolant pressure inspection is complete.');
  const overflow = candidate('overflow', 'Supplier insurance', 'Supplier insurance confirmation remains outstanding.');
  const missing = candidate('missing', 'Delivery', 'The loading bay remains closed.');
  const supplied = [main, missing].map(c => ({ ...c }));
  supplied[0].clusterMembers = [{ ...overflow, clusterRelation: 'overflow' }];
  const contract = A.meetingMinutesAgentRefereeContract('discussion', supplied, 'legacy-test', { selected: true });
  const result = { requestId: 'legacy-test', stage: 'DISCUSSION_REFEREE', expectedCandidateCount: 2,
    returnedDispositionCount: 1, candidateDispositions: [verdict('main')] };
  const released = A.refereeClusterSupportingCandidates(result.candidateDispositions, supplied);
  assert.equal(released[0].mergeTarget, '');
  assert.equal(released[0].unassessed, true);
  const plan = A.discussionRefereeFallbackPlan(result, contract, [main, overflow, missing],
    topic([main.record, overflow.record, missing.record]));
  assert.ok(plan.discussion[0].points.some(r => r.id === overflow.record.id));
  assert.ok(!plan.routedRecords.some(r => r.record.id === overflow.record.id));
});

test('unassessed readable discovery is retained using subject placement without invented core promotion', () => {
  const units = [{ id: 'T0001', speaker: 'Morgan', text: 'The coolant pressure inspection is complete.' },
    { id: 'T0002', speaker: 'Priya', text: 'Supplier insurance confirmation remains outstanding.' }];
  const support = candidate('insurance', 'Supplier insurance', units[1].text, { evidenceIds: ['T0002'],
    record: { id: 'insurance-record', text: units[1].text, evidenceIds: ['T0002'], reviewFlagIds: ['check-insurance'] } });
  const pool = [];
  const result = A.compactDiscussionPropositions(topic([{ id: 'pressure', text: units[0].text,
    evidenceIds: ['T0001'] }]), [], units, { promoteMaterialSupporting: false,
    supportingCandidates: [{ candidate: support }], onUnassignedSupportingDetail: (row, context) => {
      pool.push(...S.collectUnassignedSupportingDetails(row, context)); return true;
    } });
  assert.equal(result[0].points.length, 1);
  assert.equal(pool[0].originalTopic, 'Supplier insurance');
  assert.deepEqual(pool[0].reviewFlagIds, ['check-insurance']);
  assert.equal(pool[0].placementReason, 'no_subject_match');
});

test('an approved readable candidate is preferred to raw speech for the same approved target', () => {
  const raw = candidate('raw', 'Pressure inspection', 'So I think the coolant pressure inspection is complete, you know.',
    { sourcePass: 'primary' });
  const formal = candidate('formal', 'Pressure inspection', 'The coolant pressure inspection is complete.',
    { sourcePass: 'recovery' });
  const units = [{ id: 'T0001', speaker: 'Morgan', text: raw.text }];
  const dispositions = [verdict('raw', 'accepted'), verdict('formal', 'accepted')];
  const before = structuredClone([raw, formal]);
  const rebuilt = A.reconstructMissingRefereeDiscussion([], dispositions, [raw, formal], units);
  const compact = A.compactDiscussionPropositions(rebuilt.discussion, [], units, { promoteMaterialSupporting: false });
  assert.equal(compact[0].points[0].text, formal.text);
  assert.equal(compact[0].points[0].id, 'accepted');
  assert.equal(discussionPublicationCoverage(compact, dispositions, [raw, formal]).complete, true);
  assert.deepEqual([raw, formal], before);
  // Supporting/rejected wording is not an approved replacement.
  for (const kind of ['supporting', 'reject']) {
    const out = A.reconstructMissingRefereeDiscussion([], [verdict('raw', 'accepted'), verdict('formal',
      kind === 'reject' ? '' : 'accepted', kind)], [raw, formal], units);
    assert.equal(out.discussion[0].points[0].text, raw.text);
  }
});

test('publication coverage distinguishes visible aliases, retained context and genuinely absent targets', () => {
  const candidates = ['visible', 'folded', 'support', 'filing', 'missing', 'withheld'].map(id => candidate(id, 'Equipment', id));
  const discussion = topic([{ id: 'visible', text: 'Visible.', evidenceIds: ['T0001'], mergedFromIds: ['folded'],
    supportingDetails: [{ id: 'support', text: 'Context.' }] }]);
  const result = discussionPublicationCoverage(discussion, candidates.map(c => verdict(c.candidateId)), candidates, {
    unassignedSupportingDetails: [{ id: 'filing', text: 'Retained.' }], withheldRows: [{ id: 'withheld', text: 'Uncertain.' }]
  });
  assert.deepEqual(result.targets.map(r => r.status), ['visible', 'visible', 'supporting', 'needs_filing', 'unmaterialized', 'withheld']);
  assert.equal(result.visibleCoreTargetCount, 2);
  assert.equal(result.complete, false);
  assert.deepEqual(result.unresolvedTargetIds, ['support', 'filing', 'missing', 'withheld']);
});

test('rejects, supporting verdicts and near-identical prose cannot falsely certify a missing core target', () => {
  const candidates = [candidate('core', 'Inspection', 'The pressure inspection remains outstanding.')];
  const copied = topic([{ id: 'different', text: candidates[0].text, evidenceIds: ['T0001'] }]);
  assert.equal(discussionPublicationCoverage(copied, [verdict('core')], candidates).complete, false);
  assert.equal(discussionPublicationCoverage([], [verdict('core', '', 'reject')], candidates).complete, true);
  assert.equal(discussionPublicationCoverage([], [verdict('core', '', 'supporting')], candidates).expectedCoreTargetCount, 0);
});

test('raw core reconstruction does not count as successful publication after the unchanged readability gate', () => {
  const raw = candidate('raw', 'Inspection', 'Could you check that?');
  const units = [{ id: 'T0001', speaker: 'Morgan', text: raw.text }];
  const rebuilt = A.reconstructMissingRefereeDiscussion([], [verdict('raw')], [raw], units);
  assert.deepEqual(rebuilt.unresolvedTargetIds, []);
  const compact = A.compactDiscussionPropositions(rebuilt.discussion, [], units);
  assert.equal(compact.length, 0);
  const coverage = discussionPublicationCoverage(compact, [verdict('raw')], [raw]);
  assert.equal(coverage.complete, false);
  assert.deepEqual(coverage.unresolvedTargetIds, ['raw']);
});

test('the final generation boundary recomputes coverage instead of trusting pre-cleanup accounting', async () => {
  const core = candidate('accepted', 'Inspection', 'The coolant pressure inspection is complete.');
  const draft = { details: { meetingDate: '2026-10-24' }, sourceUnits: [{ id: 'T0001', speaker: 'Morgan', text: core.text }],
    qualityState: {}, candidateLedger: [core], discussion: [] };
  const result = { changes: { discussion: [], candidateLedger: [core], unassignedSupportingDetails: [],
    qualityState: { discussion: { effectiveRefereeCandidateDispositions: [verdict('accepted')],
      refereePublication: { compact: { complete: true }, final: { complete: true } },
      refereeSufficiency: { sufficient: true, accountingAuthoritative: true } } } }, reviewFlags: [] };
  const finished = await A.finishMeetingAgentGeneratedStage(result, draft, 'discussion', { semanticPolicy: { mode: 'off' } });
  const state = finished.changes.qualityState.discussion;
  assert.equal(state.refereePublication.final.complete, false);
  assert.deepEqual(state.refereePublication.final.unresolvedTargetIds, ['accepted']);
  assert.equal(state.refereeSufficiency.sufficient, false);
  assert.equal(state.refereeSufficiency.publicationComplete, false);
  assert.deepEqual(finished.changes.discussion, [], 'do not bypass the publication gate with baseline text');
});

test('ambiguous IDs and uncited rows cannot certify publication, and nested retained context is accounted', () => {
  const c = candidate('accepted', 'Inspection', 'The coolant pressure inspection is complete.');
  const dispositions = [verdict('accepted')];
  assert.equal(discussionPublicationCoverage(topic([{ id: 'accepted', text: c.text, evidenceIds: [] }]),
    dispositions, [c]).complete, false);
  const duplicates = topic([{ id: 'accepted', text: c.text, evidenceIds: ['T0001'] },
    { id: 'other', text: 'A separate qualification.', evidenceIds: ['T0002'], mergedFromIds: ['accepted'] }]);
  assert.equal(discussionPublicationCoverage(duplicates, dispositions, [c]).targets[0].status, 'ambiguous');
  const nested = topic([{ id: 'parent', text: 'The equipment was reviewed.', evidenceIds: ['T0001'],
    supportingDetails: [{ id: 'child', text: 'Context.', supportingDetails: [{ id: 'accepted', text: c.text }] }] }]);
  assert.equal(discussionPublicationCoverage(nested, dispositions, [c]).targets[0].status, 'supporting');
});
