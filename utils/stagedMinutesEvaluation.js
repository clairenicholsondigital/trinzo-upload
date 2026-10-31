const { cleanStagedGeneratedLine, cleanStagedDiscussionText, uniqueCleanDiscussionItems, cleanStagedActionText, stagedTokenSimilarity } = require('./stagedMinutesContext');
const { hasStagedDecisionEvidence } = require('./stagedEditorial');
const { validateTranscriptText } = require('./transcript');
const { extractStagedDetailsFromTranscript } = require('./stagedMinutesDetails');
const { buildStagedEvidenceLedger } = require('./stagedEvidenceLedger');
const { canonicalStagedResponse } = require('./stagedMinutesCanonicalResponse');
const { buildEvidenceBoundStagedActionInventory } = require('./stagedActionRecovery');

// stagedEvaluationRequest was the 15-line entry point of the pre-canonical staged path, deleted in the
// Phase 5 consolidation when its last caller (runStagedSequenceForEvaluation) moved to
// canonicalStagedResponse - the pipeline the reviewer actually sees. Its shared helpers
// remain where other paths still use them.
function stagedEvaluationVisibleOutput(state = {}) {
  const discussion = Array.isArray(state.discussion) ? state.discussion : [];
  const actions = Array.isArray(state.actions) ? state.actions : [];
  return {
    meetingTitle: state.details?.meetingTitle || 'Untitled meeting',
    participants: {
      trinzo: Array.isArray(state.details?.internalAttendees) ? state.details.internalAttendees : [],
      client: Array.isArray(state.details?.clientAttendees) ? state.details.clientAttendees : []
    },
    meetingObjectives: Array.isArray(state.summary?.objectives) ? state.summary.objectives : [],
    executiveSummary: state.summary?.executiveSummary || '',
    discussionPoints: discussion.flatMap((card) => {
      const topic = cleanStagedGeneratedLine(card?.topic || 'Discussion');
      return (Array.isArray(card?.points) ? card.points : [])
        .map((point) => `${topic}: ${cleanStagedDiscussionText(point)}`)
        .filter((point) => point && !point.endsWith(': '));
    }),
    decisions: uniqueCleanDiscussionItems([...(Array.isArray(state.decisions) ? state.decisions.map((item) => item?.text || item) : []), ...discussion.flatMap((card) => uniqueCleanDiscussionItems([
      card?.decisionOrAgreement || '',
      ...(Array.isArray(card?.points) ? card.points.filter((point) => hasStagedDecisionEvidence(point)) : [])
    ]))]).filter(Boolean),
    risks: uniqueCleanDiscussionItems(Array.isArray(state.risks) ? state.risks.map((item) => item?.text || item) : []).filter(Boolean),
    actions: actions.map((item) => ({
      meetingActionPointOwner: item?.owner || 'Not stated',
      meetingActionPoint: item?.action || '',
      meetingActionPointDeadline: item?.deadline || 'Not stated'
    })).filter((item) => item.meetingActionPoint)
  };
}

function stagedNoEditStageMessage(stage) {
  if (stage === 'details') return 'Meeting details generated. Review or edit this screen before continuing.';
  if (stage === 'summary') return 'Topics generated. Review or edit them before continuing.';
  if (stage === 'discussion') return 'Discussion points generated from the topic context.';
  if (stage === 'actions') return 'Actions generated. Check owners and dates before continuing.';
  return 'This staged screen has been generated.';
}

function stagedReviewerChoicesForFlag(flag = {}) {
  if (flag.type === 'unresolved_substantive_workstream') {
    return ['add_to_discussion', 'intentionally_omit', 'return_to_summary_topics'];
  }
  if (flag.discussionSuggestion) return ['add_to_discussion', 'review_manually'];
  if (flag.repairCandidates) return ['approve_repair', 'reject_candidate', 'review_evidence'];
  return ['review_manually'];
}

function stagedNoEditReviewExperience(trace = []) {
  const stageLabels = {
    details: 'Meeting details',
    summary: 'Summary and topics',
    discussion: 'Discussion points',
    actions: 'Actions'
  };
  const stages = (Array.isArray(trace) ? trace : []).map((item) => {
    const flags = (Array.isArray(item.validationFlags) ? item.validationFlags : []).map((flag) => ({
      type: flag.type || 'editorial_check',
      severity: flag.severity || 'info',
      blocking: Boolean(flag.blocking),
      resolutionKey: flag.resolutionKey || null,
      message: flag.message || '',
      uiLabel: flag.repairCandidates ? 'Decide' : flag.discussionSuggestion ? 'Add or omit' : flag.severity === 'warning' ? 'Review' : 'Tidied',
      reviewerChoices: stagedReviewerChoicesForFlag(flag),
      discussionSuggestion: flag.discussionSuggestion || null,
      repairCandidates: Array.isArray(flag.repairCandidates) ? flag.repairCandidates : null
    }));
    return {
      stage: item.stage,
      screenLabel: stageLabels[item.stage] || item.stage,
      statusMessage: stagedNoEditStageMessage(item.stage),
      editorialHeading: flags.length ? 'Editorial checks (review before moving on)' : null,
      flags,
      blocking: flags.some((flag) => flag.blocking)
    };
  });
  const flags = stages.flatMap((stage) => stage.flags.map((flag) => ({ ...flag, stage: stage.stage })));
  const blockingFlags = flags.filter((flag) => flag.blocking);
  return {
    mode: 'no_human_edits',
    description: 'The generated output from each screen was accepted unchanged and passed into the next screen.',
    stages,
    flags,
    warningCount: flags.filter((flag) => flag.severity === 'warning').length,
    blockingCount: blockingFlags.length,
    readyForFinalApproval: blockingFlags.length === 0,
    finalReviewMessage: blockingFlags.length
      ? 'Final review would remain locked until every substantive workstream is resolved.'
      : 'All generated screens can proceed to final human approval.',
    requiredReviewerActions: blockingFlags.map((flag) => ({
      stage: flag.stage,
      resolutionKey: flag.resolutionKey,
      message: flag.message,
      choices: flag.reviewerChoices,
      discussionSuggestion: flag.discussionSuggestion,
      repairCandidates: flag.repairCandidates
    }))
  };
}

async function runStagedSequenceForEvaluation(transcriptText, options = {}) {
  // The evaluation sequence runs the pipeline that ships, because it used to run a
  // different one. This function drove buildStagedSummaryResponse and its siblings - an
  // older, parallel staged path - while every reviewer-facing screen was served by
  // canonicalStagedResponse, so the no-edit pass and both evaluation scripts were
  // measuring code the reviewer never saw. An evaluation of the wrong pipeline is worse
  // than no evaluation: it produces confident numbers about nothing.
  //
  // The shape of the return is unchanged - state, visibleOutput, trace,
  // deterministicActionInventoryCount - and the trace entries keep the two fields their
  // consumers actually read (stage, validationFlags), now with each stage's
  // pipelineHealth riding along, since the whole point of a no-edit pass is to see what
  // served the screen.
  validateTranscriptText(transcriptText);
  const rawTranscript = {
    text: String(transcriptText || ''),
    source: 'staged-seven-case-evaluation',
    fileName: String(options.fileName || 'transcript.txt')
  };
  const detailsResponse = extractStagedDetailsFromTranscript(rawTranscript.text, rawTranscript.fileName);
  const evidenceLedger = buildStagedEvidenceLedger(rawTranscript.text);
  const state = {
    details: detailsResponse.screens.details,
    summary: null,
    discussion: [],
    actions: [],
    decisions: evidenceLedger.decisions,
    risks: evidenceLedger.risks
  };
  const trace = [{
    stage: 'details',
    provider: 'deterministic_stage_1_prep',
    outputCount: 1,
    telemetry: detailsResponse.telemetryPreview,
    // contextMode chose between generation backends on the old path. The canonical
    // pipeline has one backend, so the option is recorded as ignored rather than
    // silently accepted - an evaluation flag that quietly does nothing is a trap for
    // whoever reads the results.
    ...(options.contextMode ? { ignoredOptions: { contextMode: String(options.contextMode) } } : {})
  }];

  const transcript = { text: rawTranscript.text, source: rawTranscript.source, fileName: rawTranscript.fileName };
  for (const stage of ['summary', 'discussion', 'actions']) {
    const input = { confirmedDetails: state.details };
    if (stage !== 'summary' && state.summary) {
      input.confirmedSummary = {
        meetingPurpose: state.summary.meetingPurpose,
        objectives: state.summary.objectives || [],
        executiveSummary: state.summary.executiveSummary,
        overallTopics: state.summary.overallTopics || [],
        topicRefs: (state.summary.topicRefs || []).map((ref) => ({ text: ref.text, topicId: ref.topicId, evidenceIds: ref.evidenceIds }))
      };
    }
    const response = await canonicalStagedResponse(stage, transcript, input);
    const value = response.screens?.[stage];
    state[stage] = stage === 'summary'
      ? (value || {})
      : (Array.isArray(value) ? value : []);
    const validationFlags = Array.isArray(response.validationFlags) ? [...response.validationFlags] : [];
    if (stage === 'actions') {
      const surfaced = new Set(state.actions.map((item) => cleanStagedActionText(item?.action).toLowerCase()));
      const missing = evidenceLedger.actions.filter((item) => ![...surfaced].some((text) => stagedTokenSimilarity(text, cleanStagedActionText(item.action).toLowerCase()) >= 0.55));
      if (missing.length) validationFlags.push({
        type: 'detected_actions_not_surfaced', severity: 'warning', blocking: true,
        message: `${missing.length} possible action${missing.length === 1 ? ' was' : 's were'} found in the transcript but not added to the table. Add the real actions and dismiss anything that is only background or already completed.`,
        repairCandidates: missing
      });
    }
    trace.push({
      stage,
      provider: 'canonical_staged_pipeline',
      fallbackUsed: response.pipelineHealth?.served === 'degraded',
      inputTopicCount: Array.isArray(state.summary?.overallTopics) ? state.summary.overallTopics.length : 0,
      outputCount: stage === 'summary'
        ? (Array.isArray(state.summary?.overallTopics) ? state.summary.overallTopics.length : 0)
        : state[stage].length,
      outputPointCount: stage === 'discussion'
        ? state.discussion.reduce((sum, card) => sum + (Array.isArray(card?.points) ? card.points.length : 0), 0)
        : undefined,
      validationFlags,
      telemetry: response.telemetryPreview || {},
      pipelineHealth: response.pipelineHealth || null
    });
  }

  return {
    state,
    visibleOutput: stagedEvaluationVisibleOutput(state),
    trace,
    deterministicActionInventoryCount: buildEvidenceBoundStagedActionInventory(rawTranscript.text).length
  };
}

module.exports = {
  stagedNoEditReviewExperience,
  runStagedSequenceForEvaluation
};
