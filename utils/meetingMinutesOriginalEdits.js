'use strict';

const { meetingMinutesAgentPrompt } = require('./meetingMinutesAgentPrompts');
const { verifyMeetingAgentSummaryTiming } = require('./meetingMinutesOriginalSummary');
const { MEETING_AGENT_STAGE_STEP } = require('./meetingMinutesStageProtocol');

const {
  meetingAgentReviewerSummaryHash, meetingAgentSummaryAuthority, groundedExecutiveSummary,
  groundedObjectiveRecords
} = require('./meetingMinutesSummaryPublication');

const { meetingAgentTimingAnchor, meetingAgentPromptDetails } = require('./meetingMinutesDraftContext');
const {
  isUsefulReviewFlag: isUsefulMeetingAgentReviewFlag, mergeMeetingAgentFlags, coverageFlags
} = require('./meetingMinutesReviewFlags');
const { resolveEvidence } = require('./meetingMinutesEvidenceResolution');

const { actionCandidateInventory } = require('./meetingMinutesActionCandidateInventory');
require('./meetingMinutesAgentV2');
const { discussionCandidateInventory } = require('./meetingMinutesDiscoveryInventory');
const { normaliseAgentResult } = require('./meetingMinutesResultNormalization');
const { stripMeetingTitleReferences } = require('./canonicalMinutes/referenceText');
const { safeLogError } = require('./apiErrors');
const { reconcileDiscussionClauseSources } = require('./meetingMinutesDiscussionSources');
const { preserveCopiedReviewerContent } = require('./meetingMinutesReviewedAiEdits');

function createOriginalEditStage() {
  const { askPowerAutomateMeetingMinutesAgent, askPowerAutomateMeetingMinutesAgentWithRetry } = require('./meetingMinutesAgentTransport');
  return async function generateMeetingAgentStageRaw(draft, stage, instruction) {
    const transcript = String(draft.preparedTranscript || '').trim();
    if (transcript.length < 100) {
      const error = new Error('Prepare a transcript before asking the agent.');
      error.statusCode = 400;
      throw error;
    }
    if (Buffer.byteLength(transcript, 'utf8') > 200000) {
      const error = new Error('The denoised transcript is too large for one agent request.');
      error.statusCode = 413;
      throw error;
    }
    const current = stage === 'discussion' ? { discussion: draft.discussion || [] }
      : stage === 'actions' ? { actions: draft.actions || [] }
      : meetingAgentSummaryAuthority(draft);
    const prompt = meetingMinutesAgentPrompt({
      stage,
      transcript,
      details: meetingAgentPromptDetails(draft),
      current,
      instruction,
      steer: draft.steer,
      salientDetails: draft.salientDetails || [],
      discussionContext: stage === 'actions' ? (draft.discussion || []) : [],
      actionCandidates: stage === 'actions' ? actionCandidateInventory(draft.sourceUnits) : [],
      discussionCandidates: stage === 'discussion' ? discussionCandidateInventory(draft.sourceUnits) : []
    });
    const parsed = await askPowerAutomateMeetingMinutesAgent(prompt);
    if (stage === 'summary') {
      // A prose summary has no evidence structure to normalise, so it does not go
      // through normaliseAgentResult. Coverage is recalculated once against the
      // whole draft; model-created summary flags otherwise duplicate issues that
      // are already represented by the evidence-backed records.
      const values = {
        executiveSummary: stripMeetingTitleReferences(groundedExecutiveSummary(parsed.executiveSummary, draft.discussion || [], draft.actions || []), draft.details?.meetingTitle),
        meetingObjectives: groundedObjectiveRecords(parsed.meetingObjectives, draft.sourceUnits)
      };
      const timingReview = await verifyMeetingAgentSummaryTiming(draft, values, async (pass, prompt, options) => {
        try {
          const response = await askPowerAutomateMeetingMinutesAgentWithRetry(prompt, {
            ...options, pass: `summary:${pass}`, deadlineAt: Date.now() + 120000
          });
          return response.result;
        } catch (error) {
          safeLogError('[meeting-minutes-agent] summary timing review incomplete', error);
          return null;
        }
      });
      const changes = { ...timingReview.values, qualityState: { ...(draft.qualityState || {}), summary: {
        ...(draft.qualityState?.summary || {}), temporalReview: timingReview.accounting,
        reviewerSummaryHash: meetingAgentReviewerSummaryHash(draft, timingReview.values.executiveSummary),
        completedAt: new Date().toISOString()
      } } };
      return {
        changes,
        reviewFlags: mergeMeetingAgentFlags(timingReview.flags, coverageFlags(draft.salientDetails || [], {
          discussion: draft.discussion || [],
          actions: draft.actions || [],
          ...changes
        })),
        replaceCoverageFlags: true
      };
    }
    let normalised = normaliseAgentResult(parsed, draft.sourceUnits, stage, {
      meetingDate: meetingAgentTimingAnchor(draft)
    });
    if (stage === 'discussion') normalised.discussion = reconcileDiscussionClauseSources(normalised.discussion, draft.sourceUnits,
      { resolve: resolveEvidence, meetingDate: meetingAgentTimingAnchor(draft) }).discussion;
    if (instruction) normalised = preserveCopiedReviewerContent(draft, parsed, normalised, stage);
    normalised.reviewFlags = normalised.reviewFlags.filter(isUsefulMeetingAgentReviewFlag);
    // Discussion is generated before Actions, so judging the whole salient-detail
    // inventory against Discussion alone creates omissions by construction. Start
    // the holistic coverage check once both substantive stages exist.
    const shouldCheckCoverage = stage === 'actions'
      || (stage === 'discussion' && ((draft.actions || []).length > 0 || Number(draft.currentStep || 0) >= MEETING_AGENT_STAGE_STEP.actions));
    if (shouldCheckCoverage) {
      normalised.reviewFlags = mergeMeetingAgentFlags(normalised.reviewFlags, coverageFlags(draft.salientDetails || [], {
        discussion: stage === 'discussion' ? normalised.discussion : (draft.discussion || []),
        actions: stage === 'actions' ? normalised.actions : (draft.actions || []),
        executiveSummary: draft.executiveSummary || '',
        meetingObjectives: draft.meetingObjectives || []
      }));
    }
    return {
      normalised,
      changes: stage === 'discussion' ? { discussion: normalised.discussion } : { actions: normalised.actions },
      reviewFlags: normalised.reviewFlags,
      replaceCoverageFlags: shouldCheckCoverage
    };
  };
}

module.exports = { createOriginalEditStage };
