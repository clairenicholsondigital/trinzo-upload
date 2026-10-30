'use strict';

const { meetingAgentTimingAnchor } = require('./meetingMinutesDraftContext');
const { flattenHybridDiscussion } = require('./meetingMinutesDiscussionRows');

const { annotateMeetingAgentPassImpact, meetingAgentCallPerformance,
  meetingAgentExecutionTelemetry, meetingAgentMaterialPassImpact } = require('./meetingMinutesAgentGeneration');
const { applyIncludedSections, summaryStageIsEmpty } = require('./includedSections');
const { groundedExecutiveSummary, mergeGroundedObjectiveRecords } = require('./meetingMinutesAgentV2');
const { stripMeetingTitleReferences } = require('./canonicalMinutes/referenceText');
const { summaryTemporalCheckItems, summaryTemporalCheckPrompt,
  applySummaryTemporalCheckResults } = require('./meetingMinutesTemporalReview');
const { meetingAgentReviewPacketError } = require('./meetingMinutesReviewAccounting');

function createOriginalSummaryStage(services) {
  const {
    meetingAgentReviewerSummaryHash,
    meetingAgentSummaryAuthority,
    meetingMinutesAgentPrompt,
    verifyMeetingAgentSummaryTiming,
  } = services;

  return async function runOriginalSummaryStage(context) {
    let {
      call,
      completedPasses,
      degradedSources,
      details,
      draft,
      passProvenance,
      stage,
      stageStartedAt,
      transcript,
      execution,
    } = context;
    // Nothing to ask for: the reviewer wants neither an executive summary nor
    // objectives, so the stage completes without calling the model at all.
    if (summaryStageIsEmpty(draft)) {
      console.log(JSON.stringify({
        event: 'meeting_agent_summary_stage_skipped', journeyId: draft.draftId,
        reason: 'both optional sections excluded'
      }));
      return {
        changes: {
          executiveSummary: '', meetingObjectives: [],
          qualityState: { ...(draft.qualityState || {}), summary: {
            completedPasses: [], degradedSources: [],
            stageElapsedMs: Date.now() - stageStartedAt,
            completedAt: new Date().toISOString(),
            skipped: true
          } }
        }
      };
    }
    const parsed = await call('summary', meetingMinutesAgentPrompt({
      stage, transcript, details, current: meetingAgentSummaryAuthority(draft), steer: draft.steer
    }), {
      candidateCount: flattenHybridDiscussion(draft.discussion || []).length + (draft.actions || []).length
    });
    // One call covers both sections, so excluding one does not save a request;
    // what it does guarantee is that the excluded section never reaches the
    // minutes, whichever pass produced it.
    const summaryValues = applyIncludedSections(draft, {
      executiveSummary: stripMeetingTitleReferences(groundedExecutiveSummary(parsed.executiveSummary, draft.discussion || [], draft.actions || []), draft.details?.meetingTitle),
      meetingObjectives: mergeGroundedObjectiveRecords([
        draft.meetingObjectives || [], parsed.meetingObjectives || parsed.objectives || []
      ], draft.sourceUnits)
    });
    const summaryTiming = await verifyMeetingAgentSummaryTiming(draft, summaryValues, call);
    const executiveSummary = summaryTiming.values.executiveSummary;
    const meetingObjectives = summaryTiming.values.meetingObjectives;
    const passImpact = meetingAgentMaterialPassImpact([], { summary: {
      materialContributionCount: Number(Boolean(executiveSummary)) + meetingObjectives.length
    } });
    const measuredProvenance = annotateMeetingAgentPassImpact(passProvenance, passImpact);
    return {
      changes: {
        executiveSummary,
        meetingObjectives,
        passProvenance: [...(draft.passProvenance || []), ...measuredProvenance].slice(-40),
        passCache: execution.passCache,
        qualityState: { ...(draft.qualityState || {}), summary: {
          completedPasses, degradedSources,
          stageElapsedMs: Date.now() - stageStartedAt,
          completedAt: new Date().toISOString(),
          passImpact,
          temporalReview: summaryTiming.accounting,
          reviewerSummaryHash: meetingAgentReviewerSummaryHash(draft, executiveSummary),
          callPerformance: meetingAgentCallPerformance(measuredProvenance),
          telemetry: meetingAgentExecutionTelemetry(measuredProvenance)
        } }
      },
      reviewFlags: summaryTiming.flags, replaceCoverageFlags: false
    };
  };
}

function createSummaryTimingVerifier(services) {
  const {
    meetingAgentSummaryAuthority,
    meetingAgentReviewerSummaryHash,
  } = services;

  return async function verifyMeetingAgentSummaryTiming(draft, values, call) {
    const authority = meetingAgentSummaryAuthority(draft);
    const options = { meetingDate: meetingAgentTimingAnchor(draft),
      summaryReviewerAuthored: Boolean(meetingAgentReviewerSummaryHash(draft, values.executiveSummary)) };
    const items = summaryTemporalCheckItems(values, authority, draft.sourceUnits || [], options);
    const batches = [];
    for (let index = 0; index < items.length; index += 8) batches.push(items.slice(index, index + 8));
    const results = (await Promise.all(batches.map((batch, index) => call(
      `critic-summary-timing-${index + 1}`, summaryTemporalCheckPrompt(batch), {
        optional: true, responseKind: 'correction_check', maxAttempts: 2,
        independentBudgetMs: 120000, attemptTimeoutMs: 60000,
        candidateCount: batch.length, candidateIds: batch.map(item => item.id),
        validateResult: result => meetingAgentReviewPacketError(batch, result, ['supported', 'corrected', 'uncertain'])
      }
    )))).flatMap(result => Array.isArray(result?.results) ? result.results : []);
    return applySummaryTemporalCheckResults(values, items, results, options);
  };
}

module.exports = { createOriginalSummaryStage, createSummaryTimingVerifier };
