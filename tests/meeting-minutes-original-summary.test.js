'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createOriginalSummaryStage, createSummaryTimingVerifier } = require('../utils/meetingMinutesOriginalSummary');
const { meetingAgentReviewPacketError } = require('../utils/meetingMinutesReviewAccounting');
const { meetingAgentResultCounts } = require('../utils/meetingMinutesAgentGeneration');
const { normaliseMeetingAgentPassCache } = require('../utils/meetingMinutesPassCache');

// Standalone timing-verifier tests supply explicit approved views. The Summary
// stage uses the real publication and reviewer-authority owners.
function policyPorts(draft, publication = { discussion: draft.discussion || [], actions: draft.actions || [] }, reviewed = new Map()) {
  return {
    meetingAgentSummaryAuthority: () => publication,
    meetingAgentTimingAnchor: () => draft.details?.meetingDate || '',
    meetingAgentReviewerSummaryHash: (_draft, value) => reviewed.get(value) || ''
  };
}
function verifyMeetingAgentSummaryTiming(draft, values, call) {
  return createSummaryTimingVerifier(policyPorts(draft))(draft, values, call);
}

function fixture({ includeSections, reply, timingReply, reviewed, publication } = {}) {
  const statement = 'The supplier report is due Friday.';
  const draft = {
    draftId: 'original-summary', details: { meetingTitle: 'Equipment review', meetingDate: '2026-06-17' },
    preparedTranscript: 'Morgan: We will review the supplier report. The supplier report is due Friday.',
    sourceUnits: [{ id: 'T0001', speaker: 'Morgan', text: 'We will review the supplier report. The supplier report is due Friday.' }],
    discussion: [{ topic: 'Supplier report', points: [{ id: 'p1', text: statement, evidenceIds: ['T0001'], supportingDetails: [], reviewFlagIds: [] }], decisions: [], openQuestions: [] }],
    actions: [], meetingObjectives: [{ id: 'existing-objective', text: 'Review the supplier report.', evidenceIds: ['T0001'] }],
    includeSections, qualityState: { preparation: { retained: true } },
    passProvenance: [{ stage: 'discussion', pass: 'existing' }]
  };
  if (reviewed?.has(statement)) {
    draft.qualityState.summary = { reviewerSummaryHash: reviewed.get(statement) };
  }
  const ports = policyPorts(draft, publication, reviewed);
  const calls = [], prompts = [];
  const context = {
    draft, stage: 'summary', transcript: draft.preparedTranscript, details: draft.details,
    stageStartedAt: Date.now() - 20, completedPasses: [], degradedSources: [], passProvenance: [],
    execution: { passCache: [], refereeFailureAudit: undefined, stageDeadlineAt: Date.now() + 360000 }
  };
  // call() is the shared execution port. Record its documented cache/provenance
  // effects while returning only fixture transport replies; stage policy stays real.
  context.call = async (pass, prompt, options) => {
    calls.push({ pass, prompt, options });
    const result = pass === 'summary' ? (reply || {
      executiveSummary: statement + ' Penguins deliver moon rockets.',
      meetingObjectives: [{ text: 'Review the supplier report.', evidenceIds: ['T0001'] }]
    }) : typeof timingReply === 'function' ? timingReply(pass, prompt, options)
      : timingReply === undefined ? { results: JSON.parse(prompt.slice(prompt.indexOf('ITEMS:\n') + 'ITEMS:\n'.length))
        .map(item => ({ id: item.id, verdict: 'supported', evidenceQuote: item.row })) } : timingReply;
    if (result === null) {
      context.degradedSources.push(`The optional ${pass} quality pass did not complete: unavailable.`);
      context.passProvenance.push({ stage: 'summary', pass, failed: true,
        timings: [{ pass: `summary:${pass}`, attempt: 1, ok: false, elapsedMs: 5, promptChars: prompt.length }] });
      return null;
    }
    if (result && options.validateResult) {
      const error = options.validateResult(result);
      if (error) throw error;
    }
    const hash = crypto.createHash('sha256').update(prompt).digest('hex');
    context.execution.passCache = normaliseMeetingAgentPassCache([
      ...context.execution.passCache,
      { stage: 'summary', pass, promptSha256: hash, completedAt: new Date().toISOString(), result: result || {} }
    ]);
    context.completedPasses.push(pass);
    context.passProvenance.push({ stage: 'summary', pass, timings: [{ pass: `summary:${pass}`, attempt: 1,
      ok: true, elapsedMs: 5, promptChars: prompt.length }], ...meetingAgentResultCounts(result || {}) });
    return result;
  };
  const run = createOriginalSummaryStage({
    verifyMeetingAgentSummaryTiming: createSummaryTimingVerifier(ports),
    // Prompt composition is a separate production port with existing contract
    // tests. Capture its complete input instead of replacing any output policy.
    meetingMinutesAgentPrompt(input) { prompts.push(input); return 'SUMMARY\n' + JSON.stringify(input); },
    flattenHybridDiscussion(discussion = []) {
      return discussion.flatMap(topic => [...(topic.points || []), ...(topic.decisions || []), ...(topic.openQuestions || [])]);
    }
  });
  return { draft, context, calls, prompts, run, statement };
}

test('Original Summary skips transport only when both optional sections are excluded', async () => {
  const f = fixture({ includeSections: { executiveSummary: false, meetingObjectives: false } });
  const result = await f.run(f.context);
  assert.equal(f.calls.length, 0);
  assert.equal(f.prompts.length, 0);
  assert.equal(result.changes.executiveSummary, '');
  assert.deepEqual(result.changes.meetingObjectives, []);
  assert.equal(result.changes.qualityState.summary.skipped, true);
  assert.deepEqual(result.changes.qualityState.preparation, { retained: true });
  assert.deepEqual(result.changes.qualityState.summary.completedPasses, []);
});

test('Original Summary grounds content, merges objectives and returns the live execution cache after timing checks', async () => {
  const f = fixture();
  const before = structuredClone(f.draft);
  const result = await f.run(f.context);
  assert.deepEqual(f.calls.map(call => call.pass), ['summary', 'critic-summary-timing-1']);
  assert.equal(f.calls[0].options.candidateCount, 1);
  assert.deepEqual(f.prompts[0].current, { discussion: f.draft.discussion, actions: [] });
  assert.equal(result.changes.executiveSummary, f.statement);
  assert.equal(result.changes.meetingObjectives.length, 1);
  assert.equal(result.changes.meetingObjectives[0].id, 'existing-objective');
  assert.equal(result.changes.passCache, f.context.execution.passCache);
  assert.equal(result.changes.passCache.length, 2);
  assert.deepEqual(result.changes.qualityState.summary.completedPasses, f.calls.map(call => call.pass));
  assert.equal(result.changes.passProvenance.length, 3);
  assert.equal(result.changes.qualityState.summary.telemetry.externalCallCount, 2);
  assert.equal(result.changes.qualityState.summary.passImpact.summary.materialContributionCount, 2);
  assert.equal(result.changes.qualityState.summary.temporalReview.complete, true);
  assert.equal(result.reviewFlags.length, 0);
  assert.equal(result.replaceCoverageFlags, false);
  assert.deepEqual(f.draft, before);
});

test('Original Summary still generates requested objectives when the executive summary is excluded', async () => {
  const f = fixture({ includeSections: { executiveSummary: false } });
  const result = await f.run(f.context);
  assert.deepEqual(f.calls.map(call => call.pass), ['summary']);
  assert.equal(result.changes.executiveSummary, '');
  assert.equal(result.changes.meetingObjectives.length, 1);
  assert.equal(result.changes.qualityState.summary.temporalReview.expected, 0);
  assert.equal(result.changes.qualityState.summary.passImpact.summary.materialContributionCount, 1);
});

test('Original Summary records an unavailable optional checker while retaining grounded content and completed cache entries', async () => {
  const f = fixture({ timingReply: null });
  const result = await f.run(f.context);
  assert.equal(result.changes.executiveSummary, f.statement);
  assert.equal(result.changes.passCache.length, 1);
  assert.deepEqual(result.changes.qualityState.summary.completedPasses, ['summary']);
  assert.equal(result.changes.qualityState.summary.degradedSources.length, 1);
  assert.equal(result.changes.qualityState.summary.temporalReview.complete, false);
  assert.ok(result.reviewFlags.length);
});

test('Original Summary applies a source-supported timing correction using approved publication authority', async () => {
  const approved = 'The supplier report is due Monday.';
  const f = fixture({ includeSections: { meetingObjectives: false }, publication: {
    discussion: [{ points: [{ id: 'approved', text: approved, evidenceIds: ['T0001'] }] }], actions: []
  }, timingReply(_pass, prompt) {
    const items = JSON.parse(prompt.slice(prompt.indexOf('ITEMS:\n') + 'ITEMS:\n'.length));
    assert.equal(items[0].passage, '[D1] ' + approved);
    return { results: items.map(item => ({ id: item.id, verdict: 'corrected', problemQuote: item.row,
      evidenceQuote: approved, correctedText: approved, reason: 'Retain the confirmed date.' })) };
  } });
  const result = await f.run(f.context);
  assert.equal(result.changes.executiveSummary, approved);
  assert.deepEqual(result.changes.meetingObjectives, []);
  assert.equal(result.changes.qualityState.summary.temporalReview.complete, true);
  assert.equal(result.changes.qualityState.summary.temporalReview.counts.corrected, 1);
  assert.equal(result.reviewFlags.length, 0);
});

test('Summary timing splits checks into bounded batches', async () => {
  const text = 'The supplier report is due Friday.';
  const objectives = Array.from({ length: 9 }, (_, index) => ({ id: `o${index}`, text, evidenceIds: ['T0001'] }));
  const draft = { details: { meetingDate: '2026-06-17' }, sourceUnits: [], discussion: [], actions: [] };
  const approved = { discussion: [{ points: [{ id: 'approved', text, evidenceIds: ['T0001'] }] }], actions: [] };
  const verifier = createSummaryTimingVerifier(policyPorts(draft, approved));
  const calls = [];
  const result = await verifier(draft, { executiveSummary: text, meetingObjectives: objectives }, async (pass, prompt, options) => {
    calls.push({ pass, prompt, options }); return null;
  });
  assert.deepEqual(calls.map(call => call.options.candidateCount), [8, 2]);
  assert.deepEqual(calls.map(call => call.pass), ['critic-summary-timing-1', 'critic-summary-timing-2']);
  assert.ok(calls.every(call => call.options.independentBudgetMs === 120000 && call.options.attemptTimeoutMs === 60000));
  assert.equal(result.values.executiveSummary, text);
  assert.equal(result.accounting.expected, 10);
  assert.equal(result.accounting.counts.missing, 10);
});

test('Original Summary preserves reviewer-owned timing when the checker proposes another approved date', async () => {
  const manual = 'The supplier report is due Friday.';
  const approved = 'The supplier report is due Monday.';
  const reviewerHash = crypto.createHash('sha256').update(manual).digest('hex');
  const f = fixture({ includeSections: { meetingObjectives: false }, reviewed: new Map([[manual, reviewerHash]]),
    publication: { discussion: [{ points: [{ text: approved, evidenceIds: ['T0001'] }] }], actions: [] },
    timingReply(_pass, prompt) {
      const items = JSON.parse(prompt.slice(prompt.indexOf('ITEMS:\n') + 'ITEMS:\n'.length));
      return { results: items.map(item => ({ id: item.id, verdict: 'corrected', problemQuote: item.row,
        evidenceQuote: approved, correctedText: approved, reason: 'Retain the confirmed date.' })) };
    }
  });
  const result = await f.run(f.context);
  assert.equal(result.changes.executiveSummary, manual);
  assert.equal(result.changes.qualityState.summary.reviewerSummaryHash, reviewerHash);
  assert.equal(result.changes.qualityState.summary.temporalReview.counts.uncertain, 1);
  assert.ok(result.reviewFlags.some(flag => /reviewer temporal wording preserved/.test(flag.message)));
});

test('review packet validation retries missing, duplicate, unknown and malformed verdicts', () => {
  const items = [{ id: 'a1' }, { id: 'a2' }];
  const good = [{ id: 'a1', verdict: 'supported' }, { id: 'a2', verdict: 'uncertain' }];
  assert.equal(meetingAgentReviewPacketError(items, { results: good }, ['supported', 'uncertain']), null);
  for (const results of [undefined, good.slice(0, 1), [...good, good[0]], [...good, { id: 'outside', verdict: 'supported' }],
    [good[0], { id: 'a2', verdict: 'unexpected' }]]) {
    const error = meetingAgentReviewPacketError(items, { results }, ['supported', 'uncertain']);
    assert.equal(error.code, 'invalid_meeting_timing_review_accounting');
    assert.equal(error.retryable, true);
  }
});

test('summary timing uses approved publication authority and records an unavailable checker', async () => {
  const draft = { details: { meetingDate: '2026-06-17' }, sourceUnits: [{ id: 'T0001', text: 'The report is due Friday.' }],
    discussion: [{ points: [{ id: 'd1', text: 'The report is due Friday.', evidenceIds: ['T0001'] }] }], actions: [] };
  const values = { executiveSummary: 'The report is due Friday.', meetingObjectives: [] };
  const calls = [];
  const result = await verifyMeetingAgentSummaryTiming(draft, values, async (pass, prompt, options) => {
    calls.push({ pass, prompt, options }); return null;
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].prompt, /^DISCUSSION_CRITIC_EVIDENCE_FIDELITY/);
  assert.equal(calls[0].options.responseKind, 'correction_check');
  assert.equal(result.accounting.complete, false);
  assert.equal(result.accounting.counts.missing, 1);
  assert.equal(result.values.executiveSummary, values.executiveSummary);
  assert.ok(result.flags.length);
});

test('non-temporal summary content does not cause another provider call', async () => {
  const values = { executiveSummary: 'The team discussed supplier quality.', meetingObjectives: [] };
  const result = await verifyMeetingAgentSummaryTiming({ discussion: [], actions: [], sourceUnits: [] }, values,
    async () => { throw Error('Unexpected provider call'); });
  assert.deepEqual(result.values, values);
  assert.equal(result.accounting.expected, 0);
});
