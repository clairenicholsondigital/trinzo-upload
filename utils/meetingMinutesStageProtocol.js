'use strict';

// Shared screen/stage protocol and input fingerprints used by generation, reads and reviewer staleness.

const { TIMING_INFERENCE_POLICY_VERSION } = require('./meetingMinutesActionTimingInference');
const { discussionCoveragePolicyForFingerprint } = require('./meetingMinutesDiscussionCoveragePolicy');
const { meetingAgentPromptDetails, sanitiseDetails: sanitiseMeetingAgentDetails } = require('./meetingMinutesDraftContext');
const { meetingMinutesAgentText } = require('./meetingMinutesPlainText');
const { semanticPolicyForFingerprint } = require('./meetingMinutesSemanticPolicy');
const { TIMING_POLICY_VERSION } = require('./meetingMinutesTiming');
const crypto = require('crypto');

// Screen order: 0 details, 1 focus, 2 discussion, 3 actions, 4 summary, 5 review.
const MEETING_AGENT_MAX_STEP = 5;

const MEETING_AGENT_STAGE_STEP = Object.freeze({ discussion: 2, actions: 3, summary: 4 });

// The Library renders this rather than deriving a label from the step number, so
// changing the flow again cannot silently mislabel every draft in the list.
const MEETING_AGENT_STEP_LABELS = Object.freeze(['details', 'focus', 'discussion', 'actions', 'summary', 'final review']);

function meetingMinutesAgentHybridEnabled() {
  return /^(?:1|true|yes|on)$/i.test(String(process.env.MEETING_MINUTES_AGENT_HYBRID_V4 || '0'));
}

// Run the next stage ahead of the reviewer with exactly the inputs the real
// run would use, keep the result privately, and let the real run adopt it if
// those inputs are unchanged. Nothing about the prompts, passes or flags
// differs; only when the work happens.
function meetingMinutesAgentSpeculativePipelineEnabled() {
  return /^(?:1|true|yes|on)$/i.test(String(process.env.MEETING_MINUTES_AGENT_SPECULATIVE_PIPELINE_V1 || '0'));
}

// Everything a stage reads from the draft, hashed. If this changes between
// the speculative run and the real one the result is not adopted.
function meetingAgentStageInputFingerprint(draft = {}, stage = '') {
  const preparedTranscript = String(draft.preparedTranscript || '');
  const input = {
    timingPolicyVersion: TIMING_POLICY_VERSION,
    timingContext: meetingAgentPromptDetails(draft).timingContext,
    semanticPolicy: semanticPolicyForFingerprint(draft),
    discussionCoveragePolicy: discussionCoveragePolicyForFingerprint(draft),
    stage,
    transcript: draft.transcriptSha256 || '',
    prepared: crypto.createHash('sha256').update(preparedTranscript).digest('hex'),
    details: sanitiseMeetingAgentDetails(draft.details),
    steer: meetingMinutesAgentText(draft.steer, 4000),
    salientDetails: Array.isArray(draft.salientDetails) ? draft.salientDetails : []
  };
  if (stage === 'actions' || stage === 'summary') {
    input.upstream = meetingAgentUpstreamFingerprint(draft, stage);
    input.timingInferenceVersion = TIMING_INFERENCE_POLICY_VERSION;
  }
  return crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

// When a stage was last generated, from the run's own quality record. Empty
// output is still output: a meeting where nobody takes anything on ends its
// Actions run with no rows, and that run is finished all the same.
function meetingAgentStageGeneratedAt(draft = {}, stage = '') {
  const state = draft?.qualityState && typeof draft.qualityState === 'object' ? draft.qualityState[stage] : null;
  return state && typeof state === 'object' ? meetingMinutesAgentText(state.completedAt, 40) : '';
}

// Does this stage already hold something the reviewer could be looking at?
// A stage that has been run and legitimately came back empty counts: draft
// 1051 (a parking meeting with no owned actions) ended its Actions run with
// zero rows, and treating that as "never run" made speculation run the stage
// again and write the same empty result over it, moving the revision under the
// reviewer's tab until Create summary failed with "updated elsewhere". Being
// outdated is a separate question (see meetingAgentNextSpeculativeStage): an
// outdated stage is re-run, but what it holds is still the reviewer's.
function meetingAgentStageHasContent(draft = {}, stage = '') {
  if (!['discussion', 'actions', 'summary'].includes(stage)) return true;
  if (stage === 'discussion' && Array.isArray(draft.discussion) && draft.discussion.length > 0) return true;
  if (stage === 'actions' && Array.isArray(draft.actions) && draft.actions.length > 0) return true;
  if (stage === 'summary' && meetingMinutesAgentText(draft.executiveSummary, 20)) return true;
  return Boolean(meetingAgentStageGeneratedAt(draft, stage));
}

// What Actions and the Summary are derived from: the discussion's wording and
// structure including supporting details, the steer, and who was in the room
// (owners are chosen from the attendee lists). The Summary also reads Actions.
// Ids, flags and evidence are left out so a re-normalised but unchanged draft
// does not read as an edit.
function meetingAgentUpstreamFingerprint(draft = {}, stage = 'actions') {
  const rows = (kind, topic) => (Array.isArray(topic?.[kind]) ? topic[kind] : [])
    .map((record) => ({
      text: meetingMinutesAgentText(record?.text, 1600),
      supportingDetails: (Array.isArray(record?.supportingDetails) ? record.supportingDetails : [])
        .map((detail) => meetingMinutesAgentText(detail?.text, 1600))
    }));
  const details = draft.details || {};
  return JSON.stringify({
    discussion: (Array.isArray(draft.discussion) ? draft.discussion : []).map((topic) => ({
      topic: meetingMinutesAgentText(topic?.topic, 240),
      points: rows('points', topic), decisions: rows('decisions', topic), openQuestions: rows('openQuestions', topic)
    })),
    steer: meetingMinutesAgentText(draft.steer, 4000),
    attendees: [
      ...(Array.isArray(details.internalAttendees) ? details.internalAttendees : []),
      '|',
      ...(Array.isArray(details.clientAttendees) ? details.clientAttendees : [])
    ].map((name) => meetingMinutesAgentText(name, 120)),
    ...(stage === 'summary' ? {
      actions: (Array.isArray(draft.actions) ? draft.actions : []).map((action) => ({
        action: meetingMinutesAgentText(action?.action, 1600),
        owners: (Array.isArray(action?.owners) ? action.owners : []).map((owner) => meetingMinutesAgentText(owner, 120)),
        timing: {
          kind: meetingMinutesAgentText(action?.timing?.kind, 40),
          wording: meetingMinutesAgentText(action?.timing?.wording, 220),
          exactDate: meetingMinutesAgentText(action?.timing?.exactDate, 40)
        }
      }))
    } : {})
  });
}

module.exports = {
  MEETING_AGENT_MAX_STEP,
  MEETING_AGENT_STAGE_STEP,
  MEETING_AGENT_STEP_LABELS,
  meetingAgentStageGeneratedAt,
  meetingAgentStageHasContent,
  meetingAgentStageInputFingerprint,
  meetingAgentUpstreamFingerprint,
  meetingMinutesAgentHybridEnabled,
  meetingMinutesAgentSpeculativePipelineEnabled
};
