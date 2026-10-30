'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOriginalDiscussionStage } = require('../utils/meetingMinutesOriginalDiscussion');
const A = require('../routes/api').stagedEvaluation;
const V = require('../utils/meetingMinutesAgentV2');
const { appendRefereeFailureAudit } = require('../utils/meetingMinutesRefereeFailureAudit');
const { discussionSelectionCoverage } = require('../utils/meetingMinutesDiscussionCoverage');

function environment(t, overrides = {}) {
  const values = {
    MEETING_AGENT_COMPACT_DISCUSSION_V1: '0',
    MEETING_AGENT_COMPACT_DISCUSSION_SHADOW: '0',
    MEETING_MINUTES_AGENT_CORRECTNESS_V1: '0',
    MEETING_MINUTES_AGENT_ANSWERED_CHECK_V1: '0',
    MEETING_MINUTES_AGENT_DECISION_CHECK_V1: '0',
    MEETING_MINUTES_AGENT_DISCUSSION_ORGANISE_V1: '0',
    MEETING_MINUTES_AGENT_GLOBAL_TOPIC_ARRANGER_V1: '0',
    MEETING_MINUTES_AGENT_TOPIC_ARRANGER_BUDGET_MS: '300000',
    MEETING_MINUTES_AGENT_TOPIC_ARRANGER_TIMEOUT_MS: '180000',
    MEETING_MINUTES_AGENT_DISCUSSION_BOUNDED_REWRITE_V1: '0',
    MEETING_MINUTES_AGENT_DISCUSSION_CLAIM_CONSOLIDATION_V1: '0',
    MEETING_MINUTES_AGENT_DISCUSSION_OWN_PARENT_COVERAGE_V1: '0',
    MEETING_MINUTES_AGENT_MINIMAL_FIDELITY_REPAIR_V1: '1',
    ...overrides
  };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  // Keep the real lexical fallback when the optional embedding I/O is absent.
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 503 }));
}

function context(records, rejectedIds = []) {
  const sourceUnits = V.normaliseSourceUnits(records.map((record, index) => ({
    id: `T${String(index + 1).padStart(4, '0')}`, speaker: 'Morgan Taylor',
    text: record.source || record.text
  })));
  const discussion = records.map((record, index) => ({
    id: `topic-${record.id}`, topic: record.topic,
    points: [{ id: record.id, text: record.text, evidenceIds: [sourceUnits[index].id],
      reviewFlagIds: [], supportingDetails: [] }], decisions: [], openQuestions: []
  }));
  const primaryParsed = { discussion };
  const primary = V.normaliseAgentResult(primaryParsed, sourceUnits, 'discussion');
  const ensemble = A.hybridCandidateLedgerFromResult(primary, 'primary');
  const refereeContract = A.meetingMinutesAgentRefereeContract('discussion', ensemble, 'discussion-stage-fixture');
  const refereeParsed = {
    schemaVersion: V.SCHEMA_VERSION, requestId: refereeContract.requestId, stage: refereeContract.stage,
    expectedCandidateCount: refereeContract.expectedCandidateIds.length,
    returnedDispositionCount: refereeContract.candidates.length,
    candidateDispositions: refereeContract.candidates.map(candidate => {
      const record = ensemble.find(item => item.candidateId === candidate.candidateId).record;
      return { candidateId: candidate.candidateId,
        disposition: rejectedIds.includes(record.id) ? 'reject' : 'core',
        targetId: record.id, reason: 'The supplied source establishes this proposition.',
        evidenceIds: candidate.evidenceIds };
    }),
    discussion: primary.discussion.map(topic => ({ ...topic,
      points: topic.points.filter(record => !rejectedIds.includes(record.id))
    })).filter(topic => topic.points.length), actions: [], reviewFlags: []
  };
  const referee = V.normaliseAgentResult(refereeParsed, sourceUnits, 'discussion');
  const draft = {
    draftId: 'discussion-stage-fixture', sourceUnits,
    preparedTranscript: V.preparedTranscriptFromUnits(sourceUnits),
    details: { meetingTitle: 'Equipment review', meetingType: 'General', meetingDate: '2026-10-30',
      internalAttendees: ['Morgan Taylor'], clientAttendees: [] },
    discussion: [], actions: [], reviewFlags: [], qualityState: {}, unassignedSupportingDetails: []
  };
  return {
    draft, primary, primaryParsed, recovery: null, ensemble, referee, refereeParsed, refereeContract,
    refereeRoute: 'structured_prompt', refereeFlags: referee.reviewFlags,
    suppliedRefereeCandidates: refereeContract.candidates, candidateLedger: ensemble,
    selectionCoverage: discussionSelectionCoverage(ensemble, refereeContract.candidates),
    topicLabels: [], topicSegments: [], cachedStaged: [], stagedCandidatesFromPrewarm: false,
    stagedCandidateElapsedMs: 17, timingAnchor: '2026-10-30', stageStartedAt: Date.now(),
    passProvenance: [], completedPasses: ['primary', 'referee'], degradedSources: [],
    execution: { passCache: [], refereeFailureAudit: undefined, stageDeadlineAt: Date.now() + 360000 }
  };
}

function stage() {
  const prewarms = [];
  const run = createOriginalDiscussionStage({
    ...A.originalMinutesStageServices,
    startPrivateStagedCandidateLedger: async (draft, nextStage) => { prewarms.push(['staged', draft, nextStage]); },
    startPrivateActionPrimaryPrewarm: async draft => { prewarms.push(['primary', draft]); }
  });
  return { run, prewarms };
}

const visible = result => result.changes.discussion.flatMap(topic =>
  ['points', 'decisions', 'openQuestions'].flatMap(field => topic[field] || []));

test('Discussion respects a complete Referee rejection instead of recovering the discovery row', async t => {
  environment(t);
  const input = context([
    { id: 'review', topic: 'Calibration review', text: 'The calibration review is complete.' },
    { id: 'archive', topic: 'Equipment archive', text: 'The equipment archive contains the inspection history.' }
  ], ['archive']);
  input.call = async pass => assert.fail(`No further provider call is needed: ${pass}`);
  const { run, prewarms } = stage();
  const result = await run(input);
  assert.deepEqual(visible(result).map(row => row.id), ['review']);
  assert.equal(result.changes.unassignedSupportingDetails.some(row => row.id === 'archive'), false);
  const quality = result.changes.qualityState.discussion;
  assert.equal(quality.refereeContract.undisposedCandidateCount, 0);
  assert.equal(quality.corroboratedRecoveryCount, 0);
  assert.equal(quality.refereeCandidateDispositions.find(row => row.disposition === 'reject').candidateId,
    input.ensemble.find(candidate => candidate.record.id === 'archive').candidateId);
  assert.equal(result.replaceCoverageFlags, false);
  assert.deepEqual(prewarms.map(([kind, draft, nextStage]) => [kind, draft === input.draft, nextStage]),
    [['staged', true, 'actions'], ['primary', true, undefined]]);
});

test('Discussion retains fidelity withholding and reads live cache, audit and deadline state', async t => {
  environment(t, { MEETING_MINUTES_AGENT_CORRECTNESS_V1: '1' });
  let clock = 100000;
  t.mock.method(Date, 'now', () => { clock += 7; return clock; });
  const input = context([{ id: 'approval', topic: 'Calibration report',
    text: 'The calibration report is approved.', source: 'The calibration report was reviewed.' }]);
  const deadline = input.execution.stageDeadlineAt;
  const oldCache = input.execution.passCache;
  const updatedCache = [{ stage: 'discussion', pass: 'critic-discussion-fidelity-1',
    promptSha256: 'f'.repeat(64), result: { results: [] } }];
  const calls = [];
  input.call = async (pass, prompt, options) => {
    calls.push({ pass, prompt, options });
    assert.equal(pass, 'critic-discussion-fidelity-1');
    input.execution.passCache = updatedCache;
    input.execution.refereeFailureAudit = appendRefereeFailureAudit(undefined, {
      runId: 'discussion-stage-fixture', stage: 'discussion', pass: 'referee-batch-1', requestId: 'late-audit',
      attempt: 1, prompt: 'Retained private referee request', validation: { code: 'invalid_referee_target' }
    });
    input.completedPasses.push(pass);
    return { results: [{ id: 'df1', verdict: 'uncertain', issue: 'added_detail',
      problemQuote: 'The calibration report is approved.', reason: 'The source describes review without approval.' }] };
  };
  const { run } = stage();
  const result = await run(input);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.responseKind, 'correction_check');
  assert.equal(calls[0].options.candidateCount, 1);
  assert.match(calls[0].prompt, /The calibration report was reviewed\./);
  assert.deepEqual(visible(result), []);
  const quality = result.changes.qualityState.discussion;
  assert.equal(quality.fidelityWithheldRows.length, 1);
  assert.equal(quality.fidelityWithheldRows[0].record.id, 'approval');
  assert.equal(quality.fidelityReview.expected, 1);
  assert.equal(quality.fidelityReview.received, 1);
  assert.equal(quality.fidelityReview.complete, false);
  assert.equal(quality.fidelityReview.counts.uncertain, 1);
  assert.ok(result.reviewFlags.some(flag => /withheld for source review/.test(flag.message)));
  assert.equal(result.changes.passCache, updatedCache);
  assert.notEqual(result.changes.passCache, oldCache);
  assert.equal(quality.refereeFailureAudit, input.execution.refereeFailureAudit);
  assert.equal(input.execution.stageDeadlineAt, deadline + 7);
});

test('Discussion keeps the final source-backed rows when the separately budgeted arranger is unavailable', async t => {
  environment(t, { MEETING_MINUTES_AGENT_GLOBAL_TOPIC_ARRANGER_V1: '1' });
  const input = context([
    { id: 'review', topic: 'Calibration review', text: 'The calibration review is complete.' },
    { id: 'archive', topic: 'Equipment archive', text: 'The equipment log contains the inspection history.' },
    { id: 'certificate', topic: 'Supplier certificate', text: 'The supplier certificate is missing.' }
  ]);
  const calls = [];
  input.call = async (pass, prompt, options) => {
    calls.push({ pass, prompt, options });
    assert.equal(pass, 'topic-arranger');
    options.captureError(new Error('The topic arrangement service did not respond.'));
    return null;
  };
  const { run } = stage();
  const result = await run(input);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.independentBudgetMs, 300000);
  assert.equal(calls[0].options.attemptTimeoutMs, 180000);
  assert.equal(calls[0].options.responseKind, 'topic_arrangement');
  assert.deepEqual(new Set(visible(result).map(row => row.id)), new Set(['review', 'archive', 'certificate']));
  for (const row of visible(result)) assert.ok(calls[0].prompt.includes(row.text));
  const arrangement = result.changes.qualityState.discussion.topicArrangement;
  assert.equal(arrangement.applied, false);
  assert.equal(arrangement.fallbackReason, 'The topic arrangement service did not respond.');
});
