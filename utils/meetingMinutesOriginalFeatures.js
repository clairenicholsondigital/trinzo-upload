'use strict';

// Shared Original generation feature defaults; each consumer reads the same live policy.

function meetingMinutesAgentCompactDiscussionEnabled() {
  return /^(?:1|true|yes|on)$/i.test(String(process.env.MEETING_AGENT_COMPACT_DISCUSSION_V1 || '0'));
}

function meetingMinutesAgentCompactDiscussionShadowEnabled() {
  return /^(?:1|true|yes|on)$/i.test(String(process.env.MEETING_AGENT_COMPACT_DISCUSSION_SHADOW || '0'));
}

function meetingMinutesAgentGlobalDiscussionRefereeEnabled() {
  return /^(?:1|true|yes|on)$/i.test(String(
    process.env.MEETING_MINUTES_AGENT_GLOBAL_DISCUSSION_REFEREE_V1 || '0'
  ));
}

function meetingMinutesAgentGlobalTopicArrangerEnabled() {
  return /^(?:1|true|yes|on)$/i.test(String(
    process.env.MEETING_MINUTES_AGENT_GLOBAL_TOPIC_ARRANGER_V1 || '0'
  ));
}

function meetingMinutesAgentPromoteMaterialSupportingEnabled() {
  return /^(?:1|true|yes|on)$/i.test(String(
    process.env.MEETING_MINUTES_AGENT_PROMOTE_MATERIAL_SUPPORTING_V1 || '0'
  ));
}

function meetingMinutesAgentAnchoredDiscussionEnabled() {
  return /^(?:1|true|yes|on)$/i.test(String(
    process.env.MEETING_MINUTES_AGENT_ANCHORED_DISCUSSION_V1 || '0'
  ));
}

function meetingMinutesAgentPrimaryUnionEnabled() {
  return /^(?:1|true|yes|on)$/i.test(String(process.env.MEETING_MINUTES_AGENT_PRIMARY_UNION_V1 || '0'));
}

function meetingMinutesCommitmentDedupeEnabled() {
  return !/^(?:0|false|no|off)$/i.test(String(process.env.MEETING_MINUTES_AGENT_COMMITMENT_DEDUPE_V1 || '1'));
}

function meetingMinutesDiscussionRestatementsEnabled() {
  return !/^(?:0|false|no|off)$/i.test(String(process.env.MEETING_MINUTES_AGENT_DISCUSSION_RESTATEMENTS_V1 || '1'));
}

function meetingMinutesMinuteInstructionRuleEnabled() {
  return !/^(?:0|false|no|off)$/i.test(String(process.env.MEETING_MINUTES_AGENT_MINUTE_INSTRUCTION_V1 || '1'));
}

function meetingMinutesAgentDiscussionOrganiseEnabled() {
  return /^(?:1|true|yes|on)$/i.test(String(process.env.MEETING_MINUTES_AGENT_DISCUSSION_ORGANISE_V1 || '0'));
}

function meetingMinutesAgentFastActionPathEnabled() {
  return /^(?:1|true|yes|on)$/i.test(String(process.env.MEETING_MINUTES_AGENT_FAST_ACTION_PATH_V1 || '0'));
}

function meetingMinutesAgentDedupedCoverageEnabled() {
  return /^(?:1|true|yes|on)$/i.test(String(process.env.MEETING_MINUTES_AGENT_DEDUPED_COVERAGE_V1 || '0'));
}

function meetingMinutesAgentEarlyActionPrewarmEnabled() {
  return /^(?:1|true|yes|on)$/i.test(String(process.env.MEETING_MINUTES_AGENT_EARLY_ACTION_PREWARM_V1 || '0'));
}

function meetingMinutesAgentAnchoredActionEnabled() {
  return /^(?:1|true|yes|on)$/i.test(String(
    process.env.MEETING_MINUTES_AGENT_ANCHORED_ACTION_V1 || '0'
  ));
}

function meetingAgentCorrectionRuleEnabled() {
  return /^(?:1|true|yes|on)$/i.test(String(process.env.MEETING_MINUTES_AGENT_CORRECTION_RULE_V1 || '0'));
}

function meetingAgentTopicLabelRuleEnabled() {
  return /^(?:1|true|yes|on)$/i.test(String(process.env.MEETING_MINUTES_AGENT_TOPIC_LABEL_RULE_V1 || '0'));
}

function meetingAgentTopicSegmentsEnabled() {
  return /^(?:1|true|yes|on)$/i.test(String(process.env.MEETING_MINUTES_AGENT_TOPIC_SEGMENTS_V1 || '0'));
}

function includeAllDiscussionDetailsExperiment() {
  return /^(?:1|true|yes|on)$/i.test(String(process.env.MEETING_MINUTES_AGENT_INCLUDE_ALL_DISCUSSION_DETAILS || '').trim());
}

function meetingMinutesAuditPublishEnabled() {
  return /^(?:1|true|yes|on)$/i.test(String(process.env.MEETING_MINUTES_AGENT_AUDIT_PUBLISH_V1 || '0'));
}

function meetingMinutesPromoteNamedFactsEnabled() {
  return /^(?:1|true|yes|on)$/i.test(String(process.env.MEETING_MINUTES_AGENT_PROMOTE_NAMED_FACTS_V1 || '0'));
}

function meetingMinutesDiscussionActionCandidatesEnabled() {
  // Discussion rows are only added to the candidate inventory; the ordinary
  // evidence, commitment and referee gates still decide whether they become a
  // confirmed action or a reviewer proposal. Keep an explicit off switch for
  // operational rollback, but make the conservative completeness check the
  // default for every meeting type.
  return !/^(?:0|false|no|off)$/i.test(String(process.env.MEETING_MINUTES_AGENT_DISCUSSION_ACTION_CANDIDATES_V1 || '1'));
}

function meetingMinutesProposalRecheckEnabled() {
  return /^(?:1|true|yes|on)$/i.test(String(process.env.MEETING_MINUTES_AGENT_PROPOSAL_RECHECK_V1 || '0'));
}

module.exports = {
  meetingMinutesAgentCompactDiscussionEnabled,
  meetingMinutesAgentCompactDiscussionShadowEnabled,
  meetingMinutesAgentGlobalDiscussionRefereeEnabled,
  meetingMinutesAgentGlobalTopicArrangerEnabled,
  meetingMinutesAgentPromoteMaterialSupportingEnabled,
  meetingMinutesAgentAnchoredDiscussionEnabled,
  meetingMinutesAgentPrimaryUnionEnabled,
  meetingMinutesCommitmentDedupeEnabled,
  meetingMinutesDiscussionRestatementsEnabled,
  meetingMinutesMinuteInstructionRuleEnabled,
  meetingMinutesAgentDiscussionOrganiseEnabled,
  meetingMinutesAgentFastActionPathEnabled,
  meetingMinutesAgentDedupedCoverageEnabled,
  meetingMinutesAgentEarlyActionPrewarmEnabled,
  meetingMinutesAgentAnchoredActionEnabled,
  meetingAgentCorrectionRuleEnabled,
  meetingAgentTopicLabelRuleEnabled,
  meetingAgentTopicSegmentsEnabled,
  includeAllDiscussionDetailsExperiment,
  meetingMinutesAuditPublishEnabled,
  meetingMinutesPromoteNamedFactsEnabled,
  meetingMinutesDiscussionActionCandidatesEnabled,
  meetingMinutesProposalRecheckEnabled
};
