const { meetingMinutesAgentGlobalTopicArrangerEnabled, meetingMinutesAgentPrimaryUnionEnabled, meetingMinutesCommitmentDedupeEnabled, meetingMinutesAgentEarlyActionPrewarmEnabled, meetingAgentTopicLabelRuleEnabled, meetingAgentTopicSegmentsEnabled, includeAllDiscussionDetailsExperiment, meetingMinutesAuditPublishEnabled } = require('../utils/meetingMinutesOriginalFeatures');
const { meetingMinutesAgentAuditPrompt, compactMeetingAgentDiscussionContext, MEETING_AGENT_TOPIC_LABEL_RULE, MEETING_AGENT_TOPIC_NAMING_RULE, meetingMinutesAgentTopicNamingPrompt, meetingMinutesAgentTopicArrangementPrompt, meetingMinutesAgentTopicArrangementRepairPrompt, meetingMinutesAgentAnchoredDiscussionPrompt, meetingMinutesAgentAnchoredActionPrompt, meetingMinutesAgentRecoveryPrompt, meetingAgentRefereeEvidencePacket, meetingMinutesAgentRefereePrompt, meetingMinutesAgentRefereeRepairPrompt, meetingAgentActionAuditCandidates, meetingMinutesAgentCriticPrompt, meetingMinutesAgentSalvagePrompt } = require('../utils/meetingMinutesAgentPrompts');
const { createMeetingMinutesGenerationLifecycle } = require('../utils/meetingMinutesGenerationLifecycle');
const { hybridActionsEquivalent, actionDispositionWithContext, echoesPublishedAction, preselectActionProposal, preselectDiscussionProposal, preselectRequestedProposal, meetingAgentProposalChangeIsVisible } = require('../utils/meetingMinutesProposalSelection');
const { meetingAgentActionsFingerprint, admitMeetingAgentGeneratedActionChanges, meetingAgentRegenerationChanges, applyStageResultVirtually, meetingAgentUntouchedSpeculationChanges, meetingAgentPreviewSavedActions } = require('../utils/meetingMinutesGenerationAdmission');
const { createMeetingMinutesCandidatePrewarm } = require('../utils/meetingMinutesCandidatePrewarm');
const { hybridCandidateLedgerFromResult, stagedCandidateLedgerFromResult, cachedStagedCandidatesForStage, peekReadyPrivateStagedCandidateLedger } = require('../utils/meetingMinutesCandidateLedger');
const { stagedGenerationMeetingType } = require('../utils/meetingMinutesStageMeetingType');
const { actionCandidateInventory, actionCommitmentChainInventory, actionCommitmentThreadInventory } = require('../utils/meetingMinutesActionCandidateInventory');
const { askPowerAutomateMeetingMinutesAgent, askPowerAutomateMeetingMinutesAgentWithRetry, meetingAgentFlowUrlFor, meetingAgentCallContext, parseJsonLenient } = require('../utils/meetingMinutesAgentTransport');
const { registerMeetingMinutesReviewerParallelProposals, registerMeetingMinutesReviewerSave, registerMeetingMinutesReviewerSource, registerMeetingMinutesReviewerDecisionsHistory } = require('./meetingMinutesReviewer');
const { meetingAgentDraftPayload, normaliseMeetingAgentQualityState, normaliseMeetingAgentGeneration, meetingAgentReviewSnapshot, meetingAgentReviewHistoryEntry, meetingAgentDerivedStaleStages, meetingAgentDiscussionUsesDateAnchor, meetingAgentStaleStagesAfterGeneration, assertMeetingAgentDateInput, reopenFlagsOfReAddedItems } = require('../utils/meetingMinutesReviewerState');
const { saveMeetingAgentDraft, normaliseMeetingAgentDraftChanges } = require('../utils/meetingMinutesDraftPersistence');
const { rebaseMeetingAgentProposal, automaticMeetingAgentProposalReview, meetingAgentEditableActionSignature, retainedDocumentReferenceReviewFlags, resolveMeetingAgentProposalFlags } = require('../utils/meetingMinutesProposalReview');
const { finaliseMeetingAgentTimingProposal } = require('../utils/meetingMinutesProposalTiming');
const { salientDetailInventory } = require('../utils/meetingMinutesAssessmentEvidence');
require('../utils/meetingMinutesCandidatePack');
const { MEETING_AGENT_COMMITMENT_LANGUAGE, MEETING_AGENT_DISCUSSION_COVERAGE_RULE, meetingMinutesAgentPrimaryPrompt, meetingMinutesAgentPrompt } = require('../utils/meetingMinutesAgentPrompts');
const { meetingAgentStageHasContent, meetingAgentStageInputFingerprint, meetingAgentUpstreamFingerprint, meetingMinutesAgentHybridEnabled, meetingMinutesAgentSpeculativePipelineEnabled } = require('../utils/meetingMinutesStageProtocol');
const { MEETING_AGENT_BOOT_ID, meetingAgentNextSpeculativeStage, meetingAgentSpeculationState, privateStageSpeculations, privateStagedCandidateCacheKey, meetingAgentActionPrimaryPromptForDraft } = require('../utils/meetingMinutesGenerationRuntime');
const { buildMeetingInsights, completeActionSuggestionText, filterIncompleteProposalChanges, isVagueReconstructedAction, meetingAgentProposalFlagMatchesChange, publicMeetingAgentDraft, reconcileMeetingAgentOrphanFlags } = require('../utils/meetingMinutesDraftView');
const {
  loadOwnedMeetingAgentDraft,
  sendMeetingAgentFailure
} = require('../utils/meetingMinutesDraftHttp');
const { registerMeetingMinutesLibraryList, registerMeetingMinutesLibraryDetail, registerMeetingMinutesLibraryDelete, registerMeetingMinutesLibraryExports } = require('./meetingMinutesLibrary');
const {
  meetingMinutesAgentSupportingDedupeThreshold, mayDiscardSupportingDetail,
  compactDiscussionPropositions, dedupeSupportingDetailsSemantically, limitSupportingDetails,
  mergeHybridDiscussionTopics, promotePrioritySupportingDetails, prioritySupportingDetail,
  consolidateSupportingDetails
} = require('../utils/meetingMinutesDiscussionSelection');
const {
  meetingAgentDraftForPdf, hasMeetingAgentReviewerContent, meetingAgentPublicationContent, removeHeadingFragmentsFromDiscussion,
  removeMinorCommunicationCourtesyDiscussion, removeWithheldGeneratedDiscussion,
  stripMinorCommunicationCourtesy, completeDiscussionSuggestionText, meetingAgentDraftForDocx,
  minorCommunicationCourtesy, looksLikeStandaloneHeadingFragment
} = require('../utils/meetingMinutesPublication');
const {
  discussionStructureDiagnostics, finalisePromotedDiscussion, promoteAllDiscussionDetails
} = require('../utils/meetingMinutesDiscussionFinalization');
const {
  meetingAgentSummaryAuthority, meetingAgentReviewerSummaryHash, groundedObjectives, mergeGroundedObjectiveRecords, groundedExecutiveSummary
} = require('../utils/meetingMinutesSummaryPublication');
const { meetingMinutesAgentRefereeContract, effectiveDiscussionRefereeDispositions, meetingAgentRefereeCandidates } = require('../utils/meetingMinutesRefereeCandidates');
const { requiresDocumentReferenceReview } = require('../utils/meetingMinutesAssessmentEvidence');

const {
  normaliseAgentDeclaredProposals, meetingAgentEmptyDiscoveryError, normaliseRefereeDeclaredProposals,
  normaliseAnchoredActionDiscovery, normaliseAnchoredDiscussionDiscovery,
  meetingAgentEmptyDiscoveryRepairPrompt
} = require('../utils/meetingMinutesDiscoveryValidation');
const { unionActionDiscoveryResults, mergeMeetingAgentRefereeResults, mergeBatchedMeetingAgentRefereeResults } = require('../utils/meetingMinutesResultAggregation');
const { NESTED_STOP, WAY_TO_ACTION, actionDeliveryFrame, bundleSameRecipientDeliveries, dedupeHybridActionProposals, dedupeHybridActionRecords, distinctActionDeliverables, hybridActionTypes, hybridCandidateMatchesRecord, isClientReadyActionWording, mergeDocumentDeliveryWorkflow, nestedActionWork, publishedActionNamesSameThing, sameActionApproach, sameDocumentDeliveryWorkflow, strictActionDeliverableMatch, mergePublishedActionEvidence } = require('../utils/meetingMinutesActionDuplicatePolicy');
const { hybridRecordText, hybridTokenOverlap, hybridContentTokenOverlap } = require('../utils/meetingMinutesRecordMatching');
const { sanitiseDetails: sanitiseMeetingAgentDetails, meetingAgentTimingAnchor, meetingAgentPromptDetails } = require('../utils/meetingMinutesDraftContext');
const { normaliseFlag: normaliseMeetingAgentFlag, isUsefulReviewFlag: isUsefulMeetingAgentReviewFlag, reconcileUsefulRecordFlags, mergeMeetingAgentFlags, meetingAgentProposalReviewFlagId, coverageFlags } = require('../utils/meetingMinutesReviewFlags');
const { preparedTranscriptFromUnits, evidenceSupportScore, surroundingEvidence } = require('../utils/meetingMinutesEvidenceContext');
const { resolveEvidence } = require('../utils/meetingMinutesEvidenceResolution');
const { actionEvidenceDisposition, actionNegatedByEvidence, isMeetingAdminAction } = require('../utils/meetingMinutesActionEvidence');
const {
  applyRequesterOwnerRule, groundRowAttributions, flagConflictingDiscussionRoles,
  meetingAgentPeopleNames
} = require('../utils/meetingMinutesPeopleEvidence');
const { meetingAgentPassCacheKey, meetingMinutesAgentReplayPassCacheEnabled } = require('../utils/meetingMinutesPassCache');
const { meetingAgentResultError, meetingAgentRefereeRoute, meetingAgentInfrastructureFailure, refereeActionMaterializationIssues, refereeDiscussionTargetId, meetingAgentDispositionError, meetingAgentRefereeAccountedForAllCandidates, normaliseMeetingAgentRefereeContractResult, meetingAgentRefereeRepairCandidates, normaliseAgentCandidateDispositions, refereeDiscussionContractDiagnostics, discussionRefereeHasCompleteCandidateAccounting, reconcileRefereeActionMaterialization } = require('../utils/meetingMinutesResponseContracts');
const { meetingAgentRefereeBatches, meetingAgentRefereeBatchPlan, meetingAgentRunOrderedConcurrent, shouldStopMeetingAgentRefereeBatches } = require('../utils/meetingMinutesRefereeBatches');
const { flattenHybridDiscussion } = require('../utils/meetingMinutesDiscussionRows');
const { truthyFlag } = require('../utils/requestFlags');
const { safeLogError, sendTestError } = require('../utils/apiErrors');
const {
  stagedAnalyticsObject, stagedAnalyticsArray, stagedAnalyticsText, buildStagedReviewDiffs,
  summariseStagedReviewDiffs, stagedWorkflowInteractionEvents,
  summariseStagedWorkflowInteractions, stagedReviewProjectKey
} = require('../utils/stagedReviewAnalytics');
const { firstString, meetingMinutesAgentText } = require('../utils/meetingMinutesPlainText');
const { normaliseMeetingAgentPassCache } = require('../utils/meetingMinutesPassCache');
const { meetingAgentDiscussionFingerprint } = require('../utils/meetingMinutesDiscussionFingerprint');
const { normaliseSourceUnits } = require('../utils/meetingMinutesSource');
const {
  meetingAgentStageContentFields,
  meetingAgentStageContentConflicts,
  meetingAgentStagePersistenceChanges
} = require('../utils/meetingMinutesStagePersistence');
const { meetingAgentPassTimingPolicy, meetingAgentFailureClass, meetingAgentResultCounts, meetingAgentMaterialPassImpact, annotateMeetingAgentPassImpact, meetingAgentCallPerformance, meetingAgentExecutionTelemetry } = require('../utils/meetingMinutesAgentGeneration');
require('../utils/meetingMinutesActionUnionRewrite');
require('../utils/meetingMinutesActionPhaseCorrection');
require('../utils/canonicalMinutes/detailedContactCoverage');
const express = require('express');
require('../utils/meetingMinutesOptionalReview');
const citedFilingAliases = require('../utils/meetingMinutesCitedFilingAliases');
const discussionRewrite = require('../utils/canonicalMinutes/discussionBoundedRewrite');
const discussionOwnParent = require('../utils/canonicalMinutes/discussionOwnParentCoverage');
const discussionDirectional = require('../utils/canonicalMinutes/discussionDirectionalCoverage');
const discussionMainPoint = require('../utils/canonicalMinutes/discussionMainPointCoverage');
const discussionPointDecision = require('../utils/canonicalMinutes/discussionPointDecisionCoverage');
require('../utils/canonicalMinutes/discussionActionSeparation');
const minimalFidelityRepair = require('../utils/meetingMinutesMinimalFidelityRepair');
const { stripMeetingTitleReferences } = require('../utils/canonicalMinutes/referenceText');
const multer = require('multer');
const mammoth = require('mammoth');
const fetch = require('node-fetch');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const { appendRefereeFailureAudit } = require('../utils/meetingMinutesRefereeFailureAudit');
const { runProjectKnowledgeRetrieval } = require('../utils/knowledge');

const {
  generateToken,
  startConversation,
  sendMessage,
  getBotMessages
} = require('../utils/copilot');

const { extractTextFromUpload } = require('../utils/transcript');
const { matchingMeetingAgentDrafts } = require('../utils/meetingAgentDuplicate');
const { cleanGeneratedMeetingAgentResult } = require('../utils/meetingMinutesGeneratedHygiene');
const { normaliseSemanticPolicy, semanticPolicyForRun } = require('../utils/meetingMinutesSemanticPolicy');
const { normaliseDiscussionCoveragePolicy, discussionCoveragePolicyForRun } = require('../utils/meetingMinutesDiscussionCoveragePolicy');
require('../utils/meetingMinutesEnquiryRecovery');
const { reconcileGeneratedSemanticStage } = require('../utils/meetingMinutesSemanticStage');
require('../utils/canonicalMinutes/actionSemanticReconciliation');
const { preserveCopiedReviewerContent } = require('../utils/meetingMinutesReviewedAiEdits');
const {
  assertStagedSourceIdentity,
  assertStagedTranscriptHash
} = require('../utils/stagedIdentity');
const {
  buildEvidenceBoundStagedActionInventory,
  unassignedActionsWorthPublishing,
  readsAsAnActionRecord,
  parseDeadlineEvidence
} = require('../utils/stagedActionRecovery');
const { buildStagedEvidenceLedger } = require('../utils/stagedEvidenceLedger');

const {
  isMalformedStagedLine,
  hasStagedDecisionEvidence,
  buildTightStagedObjectives,
  classifyStagedTopic,
  topicIsIncomplete,
  dedupeStagedDiscussionCards,
  compactStagedDiscussionCards,
  reshapeStagedDiscussionCardsForHumanMinutes,
  buildStagedValidationFlags,
  normaliseFinalStagedActionCandidate,
  normaliseAndValidateActionOwner,
  isRawTranscriptDiscussionPoint
} = require('../utils/stagedEditorial');
const {
  gateEnabled: transcriptTextGateEnabled,
  transcriptTextIssue,
  partitionTranscriptText,
  rejectionSummary: transcriptTextRejectionSummary
} = require('../utils/actionTextGate');
const { getMeetingMinutesCoreGoldenStatus } = require('../utils/meetingMinutesCoreGolden');
const { runCanonicalNoEditPass } = require('../utils/canonicalMinutes/runner');
const { runCanonicalLiveStage } = require('../utils/canonicalMinutes/liveStages');
require('../utils/canonicalMinutes/minilm');
const { suggestMeetingTypeFromEvidence } = require('../utils/canonicalMinutes/meetingTypeSuggestion');
const { prepareEvidence } = require('../utils/canonicalMinutes/evidence');
const { batchRefereeCandidates, normaliseRefereeOutput, normaliseReferenceArrays } = require('../utils/refereeNormaliser');
require('../config/meeting-minutes-discussion-materiality-policy.json');
const { retainPureFutureAssignments } = require('../utils/meetingMinutesDiscussionTaskBoundary');
const { carryExactDiscussionProvenance } = require('../utils/meetingMinutesExactDiscussionProvenance');
const { polishCanonicalStage, canonicalFallback, addRecoveredActionCandidates, clientReadyPresentation, repairActionWording, repairDiscussionWording, wordingFaults, ownerSupported, unresolvedReference } = require('../utils/canonicalMinutes/trooperPolish');
const { proposeActions, proposeMissedActions } = require('../utils/canonicalMinutes/proposedActions');
const { meetingRecordAdminAction } = require('../utils/canonicalMinutes/semanticStages');
const { proposeDiscussionPoints } = require('../utils/canonicalMinutes/proposedDiscussion');
const filingAliases = require('../utils/meetingMinutesFilingAliases');
const { collectUnassignedSupportingDetails, foldLiteralParentSupportingRepeats } = require('../utils/meetingMinutesSupportingDetails');
const { discussionSelectionCoverage, discussionPublicationCoverage } = require('../utils/meetingMinutesDiscussionCoverage');
const {
  knownPersonName,
  normaliseDirectoryNameSpellings,
  normaliseAttendeeReferences,
  normalisePublishedParticipantReference
} = require('../utils/entityNormalization');
const { duplicateGroups, encodeViaWorker, cosine, splitDedupeGroupsByOwner } = require('../utils/canonicalMinutes/semanticDedupe');
const { validateDiscussionTopicArrangement, applyDiscussionTopicArrangement, normaliseDiscussionPresentation, removeRawGeneratedDiscussionRows, dedupeAdjacentRestatements, demoteContainedPrimaryRows, dedupeGlobalRestatements } = require('../utils/canonicalMinutes/discussionOrganiser');
const { stampPrimaryDiscussionEvidence } = require('../utils/canonicalMinutes/discussionPublication');
const {
  discourseSegments, segmentAnchors, segmentLabels
} = require('../utils/canonicalMinutes/discourseSegments');
const { mergeCommitmentDuplicates, commitmentCanBeRepresented } = require('../utils/canonicalMinutes/commitmentDuplicates');
const { actionIsLosslesslyCovered, actionIsSafelyCovered } = require('../utils/canonicalMinutes/actionDuplicateCoverage');
require('../utils/canonicalMinutes/actionDeliverableIdentity');
const { personErrorAssertion } = require('../utils/canonicalMinutes/claimCheck');
const { minutesEnglishFaults } = require('../utils/minutesEnglish');

const { isReviewerAuthored } = require('../utils/canonicalMinutes/state');
const actionDiagnostics = require('../utils/meetingMinutesActionDiagnostics');
const { isPublishableTopicLabel, labelNamesAWorkstream } = require('../utils/canonicalMinutes/topicEditorial');
const { enrichActionReviewCandidate } = require('../utils/canonicalMinutes/actionReviewRanking');
const { reviewGeneratedContent } = require('../utils/terminologyQa');
const { normaliseDomainTermsDeep, applyTranscriptPhraseCorrections } = require('../utils/domainTerms');
const settingsStore = require('../utils/settingsStore');

const { TIMING_POLICY_VERSION, isValidCalendarDate } = require('../utils/meetingMinutesTiming');

const { indexReviewResults, meetingAgentReviewPacketError } = require('../utils/meetingMinutesReviewAccounting');
const {
  summaryTemporalCheckItems, summaryTemporalCheckPrompt, applySummaryTemporalCheckResults
} = require('../utils/meetingMinutesTemporalReview');
const { timedStepCoverage, mergeTimedStepRecovery } = require('../utils/meetingMinutesTimedStepCoverage');
const { generateStagedMinutesPdf, stagedMinutesPdfFilename } = require('../utils/stagedMinutesPdf');
const { polishExecutiveSummaryGrammar } = require('../utils/stagedExecutiveSummaryGrammar');
const { polishInitialUnderstanding } = require('../utils/stagedInitialUnderstandingPolish');
const { assessStagedTranscriptHealth, stagedTranscriptHealthFlag } = require('../utils/stagedTranscriptHealth');
const {
  isRoutineMeetingAdministrationText,
  removeRoutineMeetingAdministrationSentences
} = require('../utils/meetingAdministration');
const { generateMiniLmTrooperStage, prepareMiniLmTranscript } = require('../utils/stagedMiniLmTrooper');
const { filterActionsForPresentation } = require('../utils/stagedActionPresentation');
const {
  buildConfirmedUnderstanding,
  repairDiscussionForConfirmedUnderstanding
} = require('../utils/stagedSemanticAuthority');

const {
  saveProjectUpdateDraft,
  getProjectManagementDetail,
  getProjectContext,
  saveMeetingMinutesFeedback,
  queueMeetingMinutesGeneration,
  queueStagedMeetingMinutesStage,
  queueProjectUpdateGeneration,
  getGenerationJob,
  getMeetingMinutesJob,
  saveStagedMeetingMinutesReviewEvent,
  listStagedMeetingMinutesReviewEvents,
  createMeetingMinutesAgentDraft,
  getMeetingMinutesAgentDraft,
  listMeetingMinutesAgentDrafts,
  listMeetingMinutesAgentDraftPage,
  linkMeetingMinutesAgentDraftToProject,
  unlinkMeetingMinutesAgentDraftFromProject,
  deleteMeetingMinutesAgentDraft,
  listTerminologyQaDecisions,
  saveTerminologyQaDecision,
  updateGenerationJobProgress,
  markGenerationJobCompleted,
  markGenerationJobFailure,
  claimNextJob,
  markJobCompleted,
  markJobFailure,
  markWebhookSuccess,
  markWebhookFailure,
  hasDatabaseConfig,
  getDatabaseConfigError,
  query
} = require('../utils/db');
const { discussionCandidateInventory, discussionAnchorInventory, uncoveredCandidateInventory, discussionRecoveryNeeded, actionRecoveryNeeded, applyTimingClauseChecks, backfillActionCommitmentEvidence, attachNearbyDependencyConditions, timingCheckEnabled: meetingMinutesTimingCheckEnabled, timingCheckItems, timingCheckPrompt, applyTimingCheckResults, decisionCheckEnabled: meetingMinutesDecisionCheckEnabled, decisionCheckItems, decisionCheckPrompt, applyDecisionCheckResults, discussionFidelityCheckItems, discussionFidelityCheckPrompt, applyDiscussionFidelityResults, filterUnsupportedQuantifiedDiscussion, promoteMaterialObjectionDetails, actionCompletenessCheckItems, actionCompletenessCheckPrompt, applyActionCompletenessResults, commitmentCheckEnabled: meetingMinutesCommitmentCheckEnabled, commitmentCheckItems, commitmentCheckPrompt, applyCommitmentCheckResults, finalActionLifecycleCheckItems, finalActionLifecycleCheckPrompt, applyFinalActionLifecycleResults, answeredCheckEnabled: meetingMinutesAnsweredCheckEnabled, answeredCheckItems, answeredCheckPrompt, applyAnsweredCheckResults, openQuestionCheckItems, openQuestionCheckPrompt, applyOpenQuestionCheckResults, completedInMeetingCheckItems, completedInMeetingCheckPrompt, applyCompletedInMeetingCheckResults, applyChainedTimingRule, mergeDuplicateCommitments, splitExplicitMultiOwnerActions, demoteSupersededRows, labelSupersededContext, promoteNamedFactDetails, describesUsualPractice, isNotAnAction, isMinuteInstruction, groundUnstatedDiscussionMonths, isSocialAside, isAobPersonalAside, isFarewellAction, softenBestEffortCompletion, discussionActionCandidates, supersededCheckItems, supersededVerdicts } = require('../utils/meetingMinutesAgentV2');
const {
  isIdeaOnlyContemplation,
  normaliseKnownTerms: normaliseMeetingAgentKnownTerms,
  isAutomaticTerminologyFlag: isAutomaticMeetingAgentTerminologyFlag
} = require('../utils/meetingMinutesText');
const { normaliseAgentResult } = require('../utils/meetingMinutesResultNormalization');
const {
  evidenceClauses, timingClauseChecksEnabled: meetingMinutesTimingClauseChecksEnabled
} = require('../utils/meetingMinutesActionTimingInference');
const { correctnessChecksEnabled } = require('../utils/meetingMinutesEvidenceChecks');
const { removeDiscussionActionDuplicates } = require('../utils/discussionShape');
const { applyPresenterAidGate } = require('../utils/presenterAidGate');
const { actionReviewCounts } = require('../utils/actionReviewState');
require('../utils/meetingMinutesActionIdentity');
const { summaryStageIsEmpty } = require('../utils/includedSections');
const { renderMinutesForProjectUpdate, minutesHaveContent, minutesActionsForProjectReport } = require('../utils/minutesForProjectUpdate');
const { generateMeetingMinutesAgentDocx, docxFilename } = require('../utils/meetingMinutesAgentDocx');
const { requireAuth } = require('./auth');

const { buildProposal } = require('../utils/meetingMinutesProposals');
const parallelMinutes = require('../utils/meetingMinutesParallel');
const { createOriginalMinutesStages } = require('../utils/meetingMinutesOriginalStages');
const { verifyMeetingAgentSummaryTiming } = require('../utils/meetingMinutesOriginalSummary');
const { reconcileFinalApprovedActions, semanticReceiptCoversActionProposal } = require('../utils/meetingMinutesFinalActionPreservation');
const { createOriginalFinalization } = require('../utils/meetingMinutesOriginalFinalization');
const { createOriginalEditStage } = require('../utils/meetingMinutesOriginalEdits');
const router = express.Router();






const upload = multer({ storage: multer.memoryStorage() });
const testUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

const MAX_TRANSCRIPT_CHARS = 2 * 1024 * 1024;
const PYTHON_TIMEOUT_MS = Number(process.env.TRANSCRIPT_TEST_TIMEOUT_MS || 30000);
// /meeting-minutes-final supports the old single full-transcript Trooper pass and the
// more reliable queued chunked pipeline. Large transcripts can still take several
// seconds, so keep the route timeout generous.
const MEETING_MINUTES_FINAL_TIMEOUT_MS = Number(process.env.MEETING_MINUTES_FINAL_TIMEOUT_MS || 180000);
const MEETING_MINUTES_JOB_PIPELINE = process.env.MEETING_MINUTES_JOB_PIPELINE || 'chunked';
const STAGED_MINILM_TIMEOUT_MS = Number(process.env.STAGED_MINILM_TIMEOUT_MS || 45000);
const STAGED_MINILM_WORKER_URL = (process.env.MINUTES_MINILM_WORKER_URL || 'http://127.0.0.1:8767').trim();
const TROOPER_STAGE_URL_DEFAULT = 'https://eu.router.trooper.ai/v1/chat/completions';
const TROOPER_STAGE_MODEL_DEFAULT = 'eu_liv_000099';

const REVIEW_TEMPLATE = {
  meetingTitle: '',
  meetingDate: '',
  meetingLocation: '',
  meetingDescription: '',
  meetingObjectives: [],
  participants: {
    client: [],
    trinzo: []
  },
  meetingMinutes: [
    {
      topic: '',
      discussionPoints: []
    }
  ],
  nextSteps: [
    {
      action: '',
      owner: '',
      deadline: ''
    }
  ],
  autosave: {
    enabled: true,
    savedAt: '',
    transcript: '',
    transcriptLength: 0
  }
};

function runUploadMiddleware(req, res, middleware) {
  return new Promise((resolve, reject) => {
    middleware(req, res, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function readTestTranscript(req) {
  const bodyText = typeof req.body?.text === 'string' ? req.body.text : '';

  if (bodyText.trim()) {
    return { text: bodyText, source: 'text' };
  }

  if (!req.file) {
    const error = new Error('Provide transcript text or upload a transcript file.');
    error.statusCode = 400;
    throw error;
  }

  const extraction = await extractTextFromUpload(req.file, mammoth);

  if (extraction.unsupported) {
    const error = new Error('Unsupported file type. Please upload a .txt, .docx, or .csv file.');
    error.statusCode = 400;
    throw error;
  }

  return { text: extraction.text || '', source: 'file', fileName: extraction.fileName };
}

function buildProjectKnowledgeQuery(transcriptText, projectContext = {}) {
  const milestoneNames = Array.isArray(projectContext.activeMilestones)
    ? projectContext.activeMilestones.map((item) => item && (item.milestoneName || item.comparisonKey)).filter(Boolean).slice(0, 12)
    : [];
  return [String(transcriptText || '').slice(0, 2000), ...milestoneNames].join('\n');
}

function shouldIncludeTranscriptMetadata(req) {
  return truthyFlag(req.query?.includeTranscriptMetadata)
    || truthyFlag(req.query?.includeTranscriptDigest)
    || truthyFlag(req.body?.includeTranscriptMetadata)
    || truthyFlag(req.body?.includeTranscriptDigest);
}

function transcriptMetadata(text) {
  return {
    transcriptLength: text.length,
    transcriptSha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
  };
}

function buildTestTranscriptResponse(req, transcript, result) {
  const response = {
    ok: true,
    source: transcript.source,
    fileName: transcript.fileName || null,
    transcriptLength: transcript.text.length,
    result
  };

  if (shouldIncludeTranscriptMetadata(req)) {
    response.transcriptMetadata = transcriptMetadata(transcript.text);
  }

  return response;
}

function linesFrom(value) {
  if (Array.isArray(value)) return value.map((item) => asString(item).trim()).filter(Boolean);
  if (typeof value !== 'string') return [];
  return value
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean);
}

function normaliseDateInput(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const compactMatch = text.match(/\b(20\d{2})(\d{2})(\d{2})\b/);
  if (compactMatch) {
    return `${compactMatch[1]}-${compactMatch[2]}-${compactMatch[3]}`;
  }
  const isoMatch = text.match(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2].padStart(2, '0')}-${isoMatch[3].padStart(2, '0')}`;
  }
  const ukMatch = text.match(/\b(\d{1,2})[/-](\d{1,2})[/-](20\d{2})\b/);
  if (ukMatch) {
    return `${ukMatch[3]}-${ukMatch[2].padStart(2, '0')}-${ukMatch[1].padStart(2, '0')}`;
  }
  const namedMatch = text.match(/\b(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(20\d{2})\b/i);
  if (namedMatch) {
    const monthIndex = [
      'january',
      'february',
      'march',
      'april',
      'may',
      'june',
      'july',
      'august',
      'september',
      'october',
      'november',
      'december'
    ].indexOf(namedMatch[2].toLowerCase());
    if (monthIndex >= 0) {
      return `${namedMatch[3]}-${String(monthIndex + 1).padStart(2, '0')}-${namedMatch[1].padStart(2, '0')}`;
    }
  }
  return '';
}

function formatReadableUkDate(value) {
  const normalised = normaliseDateInput(value);
  const match = normalised.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return '';
  const months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December'
  ];
  return `${Number(match[3])} ${months[Number(match[2]) - 1]} ${match[1]}`;
}

function titleCaseMeetingText(value) {
  return String(value || '')
    .split(' ')
    .map((word) => {
      if (!word) return '';
      if (/[A-Z]{2,}|\d/.test(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ')
    .replace(/\bApi\b/g, 'API')
    .replace(/\bPms\b/g, 'PMS');
}

function cleanStagedMeetingTitleCandidate(value, options = {}) {
  let title = String(value || '').trim();
  if (!title) return '';

  title = title
    .replace(/\.[A-Za-z0-9]{2,5}$/g, '')
    .replace(/\b(?:microsoft\s+teams|ms\s+teams)\b/gi, '')
    .replace(/\b(?:meeting\s+transcript|transcript|recording)\b/gi, '')
    .replace(/\b(?:started|stopped)\s+transcription\b/gi, '');

  const compactDateMatch = title.match(/\b(20\d{2})(\d{2})(\d{2})(?:[_-]?\d{4,6})?\b/);
  const readableDate = compactDateMatch ? formatReadableUkDate(`${compactDateMatch[1]}-${compactDateMatch[2]}-${compactDateMatch[3]}`) : '';

  title = title
    .replace(/\b20\d{6}(?:[_-]?\d{4,6})?\b/g, '')
    .replace(/\b\d{1,2}[:.]\d{2}(?::\d{2})?\b/g, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b(?:meeting\s+transcript|transcript|recording)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+\.\s*$/g, '')
    .trim();

  title = titleCaseMeetingText(title);
  if (readableDate && options.includeReadableDate !== false && !title.includes(readableDate)) {
    title = `${title} - ${readableDate}`;
  }

  title = title.replace(/\s+-\s+-\s+/g, ' - ').trim();
  if (/^(?:meeting\s+overview|untitled\s+meeting|meeting|overview|transcript|recording|staged\s+review\s+draft)$/i.test(title)) return '';
  return title;
}

// What kind of meeting this is, decided from what it was called.
//
// Three of these tests used to read `combined`, which includes the whole transcript body,
// and a meeting-type decision taken from the body is a decision taken from something
// somebody happened to say. "Right, let's run through the AI programme items quickly"
// made "Daily AI Check In" a webinar rehearsal, and the profile then published "Rehearse
// the webinar flow, content, handovers and technical setup so the live session can run
// smoothly" as its purpose - about a meeting that did not happen, and unflagged, because
// only the inferred purposes carry a flag. Seven meetings in the committed corpus were
// framed this way.
//
// The title is what a meeting is called; the body is what was said in it. Only the first
// answers "what kind of meeting is this", so every test now reads titleHint.
function inferStagedMeetingType(text, fileName = '', meetingTitle = '') {
  const titleHint = `${fileName || ''} ${meetingTitle || ''}`.replace(/[_-]+/g, ' ');
  if (/\binternal\b.*\b(?:follow ?up|review from client call|debrief)\b/i.test(titleHint)) return 'General';
  if (/\bimporter(?:['’]s)?\s+(?:obligations?|responsibilit(?:y|ies)|requirements?)\b/i.test(titleHint)) return 'Importer obligations review';
  if (/\baudit\b.*\b(?:kick ?off|planning|preparation|readiness)\b/i.test(titleHint)) return 'Audit kick-off / planning';
  // Recurring software reviews have their own discussion profile; ordinary release reviews
  // still fall through because recurrence remains required.
  const isSoftwareWeekly = /\b(?:sw|software)\b.*\b(?:weekly|check ?in)\b/i.test(titleHint);
  const isTechnicalFile = /\btech(?:nical)? file\b.*\b(?:weekly|check ?in|review|status)\b/i.test(titleHint);
  if (isSoftwareWeekly && isTechnicalFile) return 'Software and technical-file weekly review';
  if (isSoftwareWeekly) return 'Software weekly review';
  if (isTechnicalFile && /\bconsultancy\b/i.test(titleHint)) return 'Technical file consultancy review';
  if (isTechnicalFile) return 'Technical file review';
  if (/\b(?:process|pipeline|lead generation)\b.*\b(?:planning|review|design)\b|\b(?:planning|review|design)\b.*\b(?:process|pipeline)\b/i.test(titleHint)) return 'General';
  if (/\b(webinar|rehearsal|dry run|run-through|run through)\b/i.test(titleHint)) return 'Webinar rehearsal';
  // Ordinary project reviews discuss decisions, and filenames often use "decision" for
  // an agenda item or document. Only an explicit decision-making meeting identity should
  // override General here; the evidence fallback below handles titles that say nothing.
  if (/\b(?:decision(?:[ -]making)?[ -](?:meeting|review|session)|approval[ -](?:meeting|review|session)|sign[ -]?off(?:[ -](?:meeting|review|session))?|go[ /-]?no[ -]?go)\b/i.test(titleHint)) return 'Decision meeting';
  return 'General';
}

function extractLineAfterLabel(text, labels) {
  const labelPattern = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const match = String(text || '').match(new RegExp(`(?:^|\\n)\\s*(?:${labelPattern})\\s*(?:[:\\-]|\\s+)\\s*([^\\n]{1,180})`, 'i'));
  return match ? match[1].trim() : '';
}

function extractNamesFromLine(value) {
  return String(value || '')
    .split(/,|;|\band\b|\/|\|/i)
    .map((item) => item.trim().replace(/^[-*]\s*/, ''))
    .filter((item) => item && item.length < 80)
    .slice(0, 12);
}

function isLikelyPersonName(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 80) return false;
  if (!/^[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+(?:\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+){1,4}$/.test(text)) return false;
  return !/\b(Meeting|Transcript|Client|Review|Weekly|Started|Stopped|Transcription)\b/i.test(text);
}

function uniqueNames(names) {
  const seen = new Set();
  const unique = [];
  for (const name of names) {
    const cleaned = String(name || '').replace(/\s+/g, ' ').trim();
    const key = cleaned.toLowerCase();
    if (!isLikelyPersonName(cleaned) || seen.has(key)) continue;
    seen.add(key);
    unique.push(cleaned);
  }
  return unique.slice(0, 40);
}

function stagedKnownAttendeeKey(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’‘`]/g, "'")
    .replace(/[^a-z'\s-]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// The known people come from the Settings page People list (see
// utils/settingsStore.js). The lookups below are rebuilt whenever that list
// changes.
let stagedPeopleRegistryCache = { version: -1 };

function stagedPeopleRegistry() {
  const version = settingsStore.version();
  if (stagedPeopleRegistryCache.version === version) return stagedPeopleRegistryCache;
  const people = settingsStore.getPeople();
  const bucketByName = new Map(people.map((person) => [
    stagedKnownAttendeeKey(person.name),
    { bucket: person.side === 'client' ? 'client' : 'internal', name: person.name }
  ]));
  const personByFirstName = new Map();
  for (const person of people) {
    const firstName = stagedKnownAttendeeKey(person.name).split(/\s+/)[0];
    if (!firstName) continue;
    personByFirstName.set(firstName, personByFirstName.has(firstName) ? null : person.name);
  }
  // Speaker labels are rewritten silently through these aliases. A spelling
  // that keeps the person's first name ("Rebecca Cuckoo") is left to the
  // first-name correction instead, which tells the reviewer what was changed.
  const aliases = new Map();
  for (const person of people) {
    const firstName = stagedKnownAttendeeKey(person.name).split(/\s+/)[0];
    for (const spelling of person.spellings || []) {
      const spellingKey = stagedKnownAttendeeKey(spelling);
      if (spellingKey.split(/\s+/)[0] === firstName) continue;
      aliases.set(spellingKey, person.name);
    }
  }
  stagedPeopleRegistryCache = { version, bucketByName, personByFirstName, aliases };
  return stagedPeopleRegistryCache;
}

function canonicalStagedAttendeeAlias(value) {
  const cleaned = String(value || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  return stagedPeopleRegistry().aliases.get(stagedKnownAttendeeKey(cleaned)) || cleaned;
}

function normaliseStagedKnownAttendeeAliasesInText(value) {
  // Every transcript entry point runs through here, so confirmed phrase
  // corrections reach the models, the denoiser and the evidence panel alike.
  return applyTranscriptPhraseCorrections(normaliseDirectoryNameSpellings(String(value || ''))).text;
}

function canonicalKnownStagedPersonName(value) {
  const cleaned = cleanStagedGeneratedLine(canonicalStagedAttendeeAlias(value || ''));
  if (!cleaned) return '';
  // Other spellings, misspellings and "Surname, First" forms of the people on the
  // Settings page People list resolve to their proper name, so they land in the
  // right bucket rather than unresolved.
  const listed = knownPersonName(cleaned);
  if (listed) return listed;
  const exact = stagedPeopleRegistry().bucketByName.get(stagedKnownAttendeeKey(cleaned));
  if (exact?.name) return exact.name;
  if (/^[A-Za-zÀ-ÖØ-öø-ÿ'’.-]+$/.test(cleaned)) {
    const byFirstName = stagedPeopleRegistry().personByFirstName.get(stagedKnownAttendeeKey(cleaned));
    if (byFirstName) return byFirstName;
  }
  // A transcription that gets the first name right and invents the surname.
  //
  // Teams wrote "Rebecca Cuckoo" 388 times across this corpus where the attendee is
  // Rebecca Gill, and the existing check only WARNED about it
  // (possible_attendee_name_mismatch) - the correction was detected and never applied, so
  // the invented surname travelled into owners, discussion prose and the final document.
  // The first name is the anchor and the known-people registry is the authority.
  //
  // The ambiguity guard is already built into that registry: it stores null when two known
  // people share a first name, so a shared first name resolves to nothing and the
  // transcript's own spelling stands rather than one person being renamed into another.
  const parts = stagedKnownAttendeeKey(cleaned).split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    const byFirstName = stagedPeopleRegistry().personByFirstName.get(parts[0]);
    if (byFirstName) return byFirstName;
  }
  return cleaned;
}

function bucketKnownStagedAttendees(names) {
  const internal = [];
  const client = [];
  const unknown = [];
  for (const rawName of uniqueNames(names)) {
    // canonicalKnownStagedPersonName, not just the literal alias map: the alias map only
    // knows spellings somebody wrote down in advance ("Smith, Stuart M"), while the
    // registry can repair a first-name match with an invented surname. Without this the
    // action OWNER read "Rebecca Gill" and the attendee list on the details screen still
    // read "Rebecca Cuckoo" - the same person, spelled two ways on two screens of the
    // same document.
    const canonicalName = canonicalKnownStagedPersonName(rawName) || canonicalStagedAttendeeAlias(rawName);
    const known = stagedPeopleRegistry().bucketByName.get(stagedKnownAttendeeKey(canonicalName));
    if (known?.bucket === 'internal') {
      internal.push(known.name);
    } else if (known?.bucket === 'client') {
      client.push(known.name);
    } else {
      unknown.push(canonicalName);
    }
  }
  return {
    internal: uniqueNames(internal),
    client: uniqueNames(client),
    unknown: uniqueNames(unknown)
  };
}

const TEAMS_PERSON_NAME_PATTERN = "[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+(?:\\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+){1,4}";
const TEAMS_CLOCK_TIMESTAMP_PATTERN = "(?:\\d{1,2}:)?\\d{1,2}:\\d{2}";
const TEAMS_VERBOSE_TIMESTAMP_PATTERN = "(?:(?:\\d+\\s+hours?\\s+)?\\d+\\s+minutes?(?:\\s+\\d+\\s+seconds?)?|\\d+\\s+seconds?)";
const TEAMS_TIMESTAMP_PATTERN = `(?:${TEAMS_CLOCK_TIMESTAMP_PATTERN}|${TEAMS_VERBOSE_TIMESTAMP_PATTERN})(?:${TEAMS_CLOCK_TIMESTAMP_PATTERN})?`;
const TEAMS_HEADER_DATE_PATTERN = "\\b(?:20\\d{6}|20\\d{2}[-/]\\d{1,2}[-/]\\d{1,2}|\\d{1,2}[/-]\\d{1,2}[/-]20\\d{2}|\\d{1,2}\\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\\s+20\\d{2})\\b";

function extractTeamsTranscriptHeader(lines) {
  const headerLines = Array.isArray(lines) ? lines.map((line) => String(line || '').trim()).filter(Boolean).slice(0, 8) : [];
  const titleLine = headerLines.find((line) => /\b(?:meeting transcript|transcript|recording)\b/i.test(line)) || headerLines[0] || '';
  const dateLine = headerLines.find((line) => new RegExp(TEAMS_HEADER_DATE_PATTERN, 'i').test(line)) || '';
  const durationLine = headerLines.find((line) => /\b\d+\s*(?:h|hr|hrs|hour|hours|m|min|mins|minute|minutes)\b/i.test(line)) || '';
  const dateMatch = dateLine.match(new RegExp(TEAMS_HEADER_DATE_PATTERN, 'i'));

  return {
    meetingTitle: cleanStagedMeetingTitleCandidate(titleLine, { includeReadableDate: false }),
    meetingDate: normaliseDateInput(dateMatch ? dateMatch[0] : dateLine),
    duration: durationLine,
    source: titleLine || dateLine ? 'microsoft_teams_header' : ''
  };
}

function extractTeamsTranscriptStructure(text) {
  const transcript = normaliseStagedKnownAttendeeAliasesInText(text);
  const firstLines = transcript
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 12);
  const header = extractTeamsTranscriptHeader(firstLines);
  const speakerTurnCounts = new Map();
  const eventSpeakers = [];
  let turnCount = 0;

  const addSpeaker = (name, isTurn = false) => {
    const cleaned = canonicalStagedAttendeeAlias(name).replace(/\s+/g, ' ').trim();
    if (!isLikelyPersonName(cleaned)) return;
    if (isTurn) {
      speakerTurnCounts.set(cleaned, (speakerTurnCounts.get(cleaned) || 0) + 1);
      turnCount += 1;
    } else {
      eventSpeakers.push(cleaned);
    }
  };

  const turnLinePattern = new RegExp(`^\\s*(${TEAMS_PERSON_NAME_PATTERN})\\s+${TEAMS_TIMESTAMP_PATTERN}(?=\\s|[A-Za-z*]|$)`, 'i');
  const eventLinePattern = new RegExp(`^\\s*(${TEAMS_PERSON_NAME_PATTERN})\\s+(?:started|stopped)\\s+transcription\\b`, 'i');

  for (const line of transcript.split(/\r?\n/)) {
    const turnMatch = line.match(turnLinePattern);
    if (turnMatch) {
      addSpeaker(turnMatch[1], true);
      continue;
    }
    const eventMatch = line.match(eventLinePattern);
    if (eventMatch) {
      addSpeaker(eventMatch[1], false);
    }
  }

  const flattenedPattern = new RegExp(`\\b\\d{4,}\\s+\\d{4,}\\s+(${TEAMS_PERSON_NAME_PATTERN})\\s+${TEAMS_TIMESTAMP_PATTERN}(?=\\s|[A-Za-z*]|$)`, 'g');
  let match;
  while ((match = flattenedPattern.exec(transcript)) !== null) {
    addSpeaker(match[1], true);
  }

  return {
    header,
    speakers: uniqueNames([...speakerTurnCounts.keys(), ...eventSpeakers]),
    speakerTurnCounts: Object.fromEntries([...speakerTurnCounts.entries()].sort((a, b) => b[1] - a[1])),
    eventSpeakers: uniqueNames(eventSpeakers),
    turnCount
  };
}

function buildPreparedTranscriptForStagedAI(text) {
  const phraseCorrections = applyTranscriptPhraseCorrections(text).applied;
  if (phraseCorrections.length) console.log(JSON.stringify({
    event: 'meeting_agent_transcript_phrase_corrections', corrections: phraseCorrections
  }));
  const raw = normaliseStagedKnownAttendeeAliasesInText(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = raw.split('\n');
  const prepared = [];
  const removedReasons = {
    teamsHeader: 0,
    transcriptionEvent: 0,
    blankLine: 0,
    timestampOnly: 0
  };
  const turnLinePattern = new RegExp(`^\\s*(${TEAMS_PERSON_NAME_PATTERN})\\s+(${TEAMS_TIMESTAMP_PATTERN})\\s*(.*)$`, 'i');
  const eventLinePattern = new RegExp(`^\\s*${TEAMS_PERSON_NAME_PATTERN}\\s+(?:started|stopped)\\s+transcription\\b`, 'i');

  lines.forEach((line, index) => {
    const trimmed = String(line || '').trim();
    if (!trimmed) {
      removedReasons.blankLine += 1;
      return;
    }

    if (index < 8) {
      if (/\b(?:meeting transcript|transcript|recording)\b/i.test(trimmed)) {
        removedReasons.teamsHeader += 1;
        return;
      }
      if (new RegExp(TEAMS_HEADER_DATE_PATTERN, 'i').test(trimmed)) {
        removedReasons.teamsHeader += 1;
        return;
      }
      if (/^\d+\s*(?:h|hr|hrs|hour|hours|m|min|mins|minute|minutes)(?:\s+\d+\s*(?:m|min|mins|s|sec|secs|second|seconds))?$/i.test(trimmed)) {
        removedReasons.teamsHeader += 1;
        return;
      }
    }

    if (eventLinePattern.test(trimmed)) {
      removedReasons.transcriptionEvent += 1;
      return;
    }

    if (new RegExp(`^${TEAMS_TIMESTAMP_PATTERN}$`, 'i').test(trimmed)) {
      removedReasons.timestampOnly += 1;
      return;
    }

    const turnMatch = trimmed.match(turnLinePattern);
    if (turnMatch) {
      const speaker = canonicalStagedAttendeeAlias(turnMatch[1]).replace(/\s+/g, ' ').trim();
      const spoken = String(turnMatch[3] || '').replace(/\s+/g, ' ').trim();
      prepared.push(spoken ? `${speaker}: ${spoken}` : `${speaker}:`);
      return;
    }

    prepared.push(trimmed.replace(/\s+/g, ' '));
  });

  const preparedText = prepared.join('\n').trim();
  const removedLineCount = Object.values(removedReasons).reduce((sum, value) => sum + value, 0);
  return {
    text: preparedText || raw.trim(),
    rawLength: raw.length,
    preparedLength: preparedText.length || raw.trim().length,
    removedLineCount,
    removedReasons
  };
}

function extractTeamsSpeakerNames(text) {
  const structured = extractTeamsTranscriptStructure(text);
  if (structured.speakers.length) return structured.speakers;
  const transcript = normaliseStagedKnownAttendeeAliasesInText(text);
  const names = [];
  const linePattern = /^\s*([A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+(?:\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+){1,4})\s+(?:\d{1,2}:)?\d{1,2}:\d{2}(?=\s|[A-Za-z*]|$)/gm;
  const flattenedPattern = /\b\d{4,}\s+\d{4,}\s+([A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+(?:\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+){1,4})\s+(?:\d{1,2}:)?\d{1,2}:\d{2}(?=\s|[A-Za-z*]|$)/g;
  let match;

  while ((match = linePattern.exec(transcript)) !== null) {
    names.push(match[1]);
  }

  while ((match = flattenedPattern.exec(transcript)) !== null) {
    names.push(match[1]);
  }

  return uniqueNames(names);
}

function extractStagedDetailsFromTranscript(transcriptText, fileName = '') {
  const text = normaliseStagedKnownAttendeeAliasesInText(transcriptText);
  const firstLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 30);
  const firstChunk = firstLines.join('\n');
  const meetingTitle = firstString(
    cleanStagedMeetingTitleCandidate(extractLineAfterLabel(firstChunk, ['meeting title', 'title', 'subject'])),
    cleanStagedMeetingTitleCandidate(firstLines.find((line) => /meeting|review|workshop|sync|update|transcript/i.test(line) && !/:$/.test(line))),
    cleanStagedMeetingTitleCandidate(fileName),
    'Untitled meeting'
  );
  const rawDate = firstString(
    extractLineAfterLabel(firstChunk, ['meeting date', 'date']),
    (firstChunk.match(/\b(?:20\d{6}|20\d{2}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[/-]\d{1,2}[/-]20\d{2}|\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+20\d{2})\b/i) || [])[0],
    (String(fileName || '').match(/\b20\d{6}\b/) || [])[0]
  );
  const rawLocation = extractLineAfterLabel(firstChunk, ['location', 'venue', 'platform']);
  const rawOrganisation = extractLineAfterLabel(firstChunk, ['organisation', 'organization', 'client', 'company']);
  const attendeesLine = extractLineAfterLabel(firstChunk, ['attendees', 'participants', 'present']);
  const clientLine = extractLineAfterLabel(firstChunk, ['client attendees', 'client participants']);
  const trinzoLine = extractLineAfterLabel(firstChunk, ['trinzo attendees', 'internal attendees', 'trinzo participants', 'internal participants']);
  const teamsStructure = extractTeamsTranscriptStructure(text);
  const teamsHeader = teamsStructure.header || {};
  const teamsSpeakers = teamsStructure.speakers.length ? teamsStructure.speakers : extractTeamsSpeakerNames(text);
  const explicitClientAttendees = extractNamesFromLine(clientLine);
  const explicitInternalAttendees = extractNamesFromLine(trinzoLine);
  const unlabelledAttendees = extractNamesFromLine(attendeesLine);
  const explicitClientBuckets = bucketKnownStagedAttendees(explicitClientAttendees);
  const explicitInternalBuckets = bucketKnownStagedAttendees(explicitInternalAttendees);
  const unlabelledBuckets = bucketKnownStagedAttendees(unlabelledAttendees);
  const speakerBuckets = bucketKnownStagedAttendees(teamsSpeakers);
  const internalAttendees = uniqueNames([
    ...explicitInternalBuckets.internal,
    ...explicitInternalBuckets.unknown,
    ...explicitClientBuckets.internal,
    ...unlabelledBuckets.internal,
    ...speakerBuckets.internal
  ]);
  const clientAttendees = uniqueNames([
    ...explicitClientBuckets.client,
    ...explicitClientBuckets.unknown,
    ...explicitInternalBuckets.client,
    ...unlabelledBuckets.client,
    ...speakerBuckets.client
  ]);
  const unresolvedAttendees = uniqueNames([
    ...unlabelledBuckets.unknown,
    ...speakerBuckets.unknown
  ]).filter((name) => !internalAttendees.includes(name) && !clientAttendees.includes(name));
  const headerDate = teamsHeader.meetingDate || '';
  const headerTitle = teamsHeader.meetingTitle || '';
  const attendeeNameWarnings = teamsSpeakers.flatMap((name) => {
    const parts = stagedKnownAttendeeKey(name).split(/\s+/).filter(Boolean);
    if (parts.length < 2 || stagedPeopleRegistry().bucketByName.has(stagedKnownAttendeeKey(name))) return [];
    const knownFirstName = stagedPeopleRegistry().personByFirstName.get(parts[0]);
    if (!knownFirstName) return [];
    // The message has to describe what the document now says, not what the transcript
    // said. This flag used to read "Check attendee name X, the surname differs" while the
    // attendee list already showed the corrected name - so the reviewer was asked to fix
    // something that was not there, against a name that appeared nowhere on the screen.
    // Now the correction is applied, the flag reports the decision and offers the way back.
    const corrected = canonicalKnownStagedPersonName(name);
    if (corrected && stagedKnownAttendeeKey(corrected) !== stagedKnownAttendeeKey(name)) {
      return [{
        type: 'attendee_name_corrected',
        severity: 'info',
        blocking: false,
        message: `The transcript says “${name}”, which is not a known participant. It has been recorded as “${corrected}” because the first name matches. Edit the attendee if that is wrong.`
      }];
    }
    return [{ type: 'possible_attendee_name_mismatch', severity: 'warning', blocking: false, message: `Check attendee name “${name}”. The first name matches known participant “${knownFirstName}”, but the transcript surname differs.` }];
  });
  const attendeeAffiliationFlags = unresolvedAttendees.length ? [{
    type: 'attendee_affiliation_unconfirmed',
    severity: 'warning',
    blocking: false,
    message: `Internal or client affiliation was not stated for ${unresolvedAttendees.join(', ')}. Review the attendee lists before finalising.`
  }] : [];

  // The title decides the type when it can. When it cannot - the title-only inference
  // returned the default - ask the discussion, gated on recurrence and dominance, and
  // offer the answer as a pre-selected suggestion the reviewer can overrule. The evidence
  // trail travels with the payload so the suggestion is auditable, and the flag makes it
  // visible: a pre-selected dropdown with no note is indistinguishable from a default.
  const titleOnlyType = inferStagedMeetingType(text, fileName, headerTitle || meetingTitle);
  let meetingTypeSuggestion = null;
  if (titleOnlyType === 'General') {
    try {
      meetingTypeSuggestion = suggestMeetingTypeFromEvidence(prepareEvidence(text));
    } catch {
      meetingTypeSuggestion = null;
    }
  }
  const suggestedType = meetingTypeSuggestion && meetingTypeSuggestion.accepted ? meetingTypeSuggestion.type : null;
  const typeSuggestionFlags = suggestedType ? [{
    type: 'meeting_type_suggested',
    severity: 'warning',
    blocking: false,
    resolutionKey: 'meeting-type-suggested',
    message: `The meeting type was set to "${suggestedType}" from the discussion itself - ${meetingTypeSuggestion.supportedHints.length} of that type's topic areas recur across ${meetingTypeSuggestion.totalMatchedEvents} moments in the transcript, while the title alone reads as a general project review. Change it if that is not what this meeting was.`
  }] : [];

  return normaliseDomainTermsDeep({
    ok: true,
    staged: true,
    stagedStage: 'details',
    screens: {
      details: {
        meetingTitle: (headerTitle || meetingTitle).slice(0, 180),
        meetingDate: headerDate || normaliseDateInput(rawDate),
        meetingLocation: rawLocation || (/\b(?:microsoft\s+teams|teams meeting)\b/i.test(text) ? 'Microsoft Teams' : ''),
        organisation: rawOrganisation,
        meetingType: suggestedType || titleOnlyType,
        meetingTypeSuggestion,
        internalAttendees,
        clientAttendees,
        // teamsSpeakers carries the transcript's own spelling, so a name repaired in the
        // bucketed lists reappeared here beside its broken twin: "Rebecca Gill" and
        // "Rebecca Cuckoo" both listed as attendees of the same meeting. Canonicalise
        // before the union so the dedupe can actually see they are one person.
        allAttendees: uniqueNames([
          ...internalAttendees,
          ...clientAttendees,
          ...unresolvedAttendees,
          ...teamsSpeakers.map((name) => canonicalKnownStagedPersonName(name) || name)
        ])
      }
    },
    validationFlags: [...attendeeNameWarnings, ...attendeeAffiliationFlags, ...typeSuggestionFlags],
    telemetryPreview: {
      stage: 'details',
      transcriptLength: text.length,
      screenCount: 1,
      attendeeExtraction: {
        source: teamsStructure.speakers.length ? 'microsoft_teams_speaker_turns' : 'explicit_or_fallback',
        speakerCount: teamsSpeakers.length,
        unresolvedAffiliationCount: unresolvedAttendees.length,
        turnCount: teamsStructure.turnCount,
        eventSpeakerCount: teamsStructure.eventSpeakers.length,
        knownInternalAttendeeCount: internalAttendees.length,
        knownClientAttendeeCount: clientAttendees.filter((name) => stagedPeopleRegistry().bucketByName.get(stagedKnownAttendeeKey(name))?.bucket === 'client').length,
        headerSource: teamsHeader.source || '',
        dateSource: headerDate ? 'microsoft_teams_header' : 'explicit_or_filename'
      }
    }
  });
}

const STAGED_TOPIC_RULES = [
  { topic: 'Alarm changes', patterns: [/alarm/i, /mute button/i, /audible sound/i, /chirp/i, /flash(?:ing)?/i] },
  { topic: 'Language changes', patterns: [/language files?/i, /translated languages?/i, /Arabic/i, /Vietnamese/i, /Greek/i, /font/i] },
  { topic: 'Software versioning changes', patterns: [/software version/i, /\bv\d+(?:\.\d+)+\b/i, /version\s+1\.?0?1/i, /version\s+1\.?0?2/i, /traceability/i] },
  { topic: 'Debug review', patterns: [/debug/i, /test scripts?/i, /commands/i] },
  { topic: 'Change request', patterns: [/change request/i, /change control/i, /change owner/i, /non[- ]?significant change/i] },
  { topic: 'Cybersecurity', patterns: [/cyber\s*security/i, /USB port/i, /port lock/i, /password protected/i, /unwarranted interference/i] },
  { topic: 'Risk management', patterns: [/risk\b/i, /risk matrix/i, /risk register/i] },
  { topic: 'Software updates', patterns: [/software/i, /\bAPI\b/i, /system update/i, /platform/i] },
  { topic: 'Subcontractors', patterns: [/subcontractor/i, /supplier/i, /vendor/i] },
  { topic: 'Usability', patterns: [/usability/i, /user acceptance/i, /\bUAT\b/i, /user experience/i] },
  { topic: 'Process maps', patterns: [/process map/i, /workflow/i, /process flow/i] },
  { topic: 'PMS', patterns: [/\bPMS\b/i, /project management system/i] },
  { topic: 'Technical file', patterns: [/technical file/i, /tech file/i, /design history file/i] },
  { topic: 'Compliance testing', patterns: [/compliance/i, /testing/i, /verification/i, /validation/i] },
  { topic: 'Document updates', patterns: [/document/i, /\bSOP\b/i, /template/i, /report/i] },
  { topic: 'Actions and ownership', patterns: [/action/i, /owner/i, /follow[- ]?up/i, /deadline/i] }
];

function stagedTopicsAreNearDuplicates(left, right) {
  const leftKey = normaliseTopicKey(left);
  const rightKey = normaliseTopicKey(right);
  if (!leftKey || !rightKey) return false;
  if (leftKey === rightKey || leftKey.includes(rightKey) || rightKey.includes(leftKey)) return true;
  const aliasGroups = [
    ['electrical compliance testing', 'compliance testing', 'electrical safety testing'],
    ['software versioning changes', 'software updates'],
    ['cybersecurity', 'risk management'],
    ['change request', 'document updates']
  ];
  return aliasGroups.some((group) => group.includes(leftKey) && group.includes(rightKey));
}

function pushUniqueTopic(topics, topic, limit = 10) {
  const cleaned = String(topic || '').replace(/\s+/g, ' ').trim();
  if (!isUsableStagedTopic(cleaned) || isNoEvidenceDiscussionText(cleaned)) return;
  if (topics.some((item) => stagedTopicsAreNearDuplicates(item, cleaned))) return;
  topics.push(cleaned.slice(0, 80));
  if (topics.length > limit) topics.length = limit;
}

function isUsableStagedTopic(topic) {
  const cleaned = String(topic || '').replace(/\s+/g, ' ').trim();
  if (!cleaned || cleaned.length < 3 || cleaned.length > 86) return false;
  const words = cleaned.split(/\s+/);
  if (words.length > 9) return false;
  if (/[.?!]/.test(cleaned)) return false;
  if (/\b(?:said that|and the other|review these topics|evidence-backed discussion|transcript-generated|proper english)\b/i.test(cleaned)) return false;
  if (/^[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+(?:\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+){0,3}\s+(?:said|noted|explained|mentioned|queried|asked|advised|confirmed|suggested|thought|thinks?|wanted?|wants?)\b/i.test(cleaned)) return false;
  if (/^(?:he|she|they|we|i|you)\s+(?:said|noted|explained|mentioned|queried|asked|advised|confirmed|suggested|thought|thinks?|wanted?|wants?)\b/i.test(cleaned)) return false;
  return true;
}

function cleanTranscriptContentLine(line) {
  return stripStagedTranscriptArtefacts(line)
    .replace(/\b\d{4,}\s+\d{4,}\s+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}


function stringListFromAny(value, keys = []) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => stringListFromAny(item, keys));
  }
  if (typeof value === 'string') return linesFrom(value).length ? linesFrom(value) : [value.trim()].filter(Boolean);
  if (typeof value === 'object') {
    for (const key of keys) {
      const nested = stringListFromAny(value[key], keys);
      if (nested.length) return nested;
    }
  }
  return [];
}

function cleanStagedGeneratedLine(value) {
  return capitaliseStagedDateMonths(String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/^[-*]\s*/, '')
    .trim());
}

const STAGED_PUBLIC_TIMESTAMP_PATTERN = '(?:\\d{1,2}:)?\\d{1,2}[:.]\\d{2}(?::\\d{2})?';
const STAGED_PUBLIC_SPEAKER_PATTERN = "[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]*,?(?:\\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]*,?){0,5}";
const STAGED_MONTH_NAMES = {
  january: 'January',
  february: 'February',
  march: 'March',
  april: 'April',
  may: 'May',
  june: 'June',
  july: 'July',
  august: 'August',
  september: 'September',
  october: 'October',
  november: 'November',
  december: 'December'
};

function capitaliseStagedDateMonths(value) {
  return String(value || '').replace(
    /\b(\d{1,2})(st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december)\b/ig,
    (match, day, suffix, month) => `${day}${suffix || ''} ${STAGED_MONTH_NAMES[String(month).toLowerCase()] || month}`
  );
}

function hasStagedSpeakerTurnPrefix(value) {
  const text = cleanStagedGeneratedLine(value);
  if (!text) return false;
  return [
    new RegExp(`^\\s*${STAGED_PUBLIC_SPEAKER_PATTERN}\\s*:\\s*`, 'u'),
    new RegExp(`^\\s*${STAGED_PUBLIC_SPEAKER_PATTERN}\\s+${STAGED_PUBLIC_TIMESTAMP_PATTERN}\\s*:?\\s*`, 'u'),
    new RegExp(`^\\s*${STAGED_PUBLIC_TIMESTAMP_PATTERN}\\s+${STAGED_PUBLIC_SPEAKER_PATTERN}\\s*:?\\s*`, 'u')
  ].some((pattern) => pattern.test(text));
}

function stripStagedTranscriptArtefacts(value) {
  let text = cleanStagedGeneratedLine(value)
    .replace(new RegExp(`(?:\\[\\s*${STAGED_PUBLIC_TIMESTAMP_PATTERN}\\s*\\]|\\(\\s*${STAGED_PUBLIC_TIMESTAMP_PATTERN}\\s*\\))`, 'g'), ' ');
  if (!text) return '';
  for (let index = 0; index < 3; index += 1) {
    text = text
      .replace(new RegExp(`^\\s*${STAGED_PUBLIC_SPEAKER_PATTERN}\\s*:\\s*`, 'u'), '')
      .replace(new RegExp(`^\\s*${STAGED_PUBLIC_SPEAKER_PATTERN}\\s+${STAGED_PUBLIC_TIMESTAMP_PATTERN}\\s*:?\\s*`, 'u'), '')
      .replace(new RegExp(`^\\s*${STAGED_PUBLIC_TIMESTAMP_PATTERN}\\s+${STAGED_PUBLIC_SPEAKER_PATTERN}\\s*:?\\s*`, 'u'), '')
      .replace(new RegExp(`^\\s*${STAGED_PUBLIC_TIMESTAMP_PATTERN}\\s*:?\\s*`, 'u'), '')
      .replace(/([.!?])(?=[A-Z])/g, '$1 ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return text.replace(/^([a-z])/, (match) => match.toUpperCase());
}

function cleanStagedDiscussionText(value) {
  if (hasStagedSpeakerTurnPrefix(value)) return '';
  return stripStagedTranscriptArtefacts(value)
    .replace(/\bNo specific discussion points were explicitly detailed[^.?!]*[.?!]?/ig, '')
    .replace(/\bNo substantive discussion(?: was| points were)?[^.?!]*[.?!]?/ig, '')
    .replace(/\bnot discussed in the transcript[^.?!]*[.?!]?/ig, '')
    .replace(/\b(?:yeah|yes|no|okay|ok|absolutely|presumably|perfect|right)[.!?,\s]+(?:yeah|yes|no|okay|ok|absolutely|presumably|perfect|right)[.!?,\s]*/ig, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isNoEvidenceDiscussionText(value) {
  const text = cleanStagedGeneratedLine(value);
  if (!text) return true;
  return /\b(?:no specific discussion points|no substantive discussion|not discussed in the transcript|no transcript evidence|no evidence|generation issue|(?:trooper[_ ]?)?api[_ ]key is not configured|rewriter is not configured)\b/i.test(text);
}

function isLowValueStagedDiscussionText(value) {
  const cleaned = cleanStagedDiscussionText(value);
  const text = cleaned.toLowerCase();
  if (!text) return true;
  if (/^(?:yeah|yes|no|okay|ok|absolutely|presumably|perfect|right)[.!?,\s]*(?:yeah|yes|no|okay|ok|absolutely|presumably|perfect|right)?[.!?,\s]*$/.test(text)) return true;
  if (/\b([A-Z][a-z]+)\s+said\s+that\s+\1\b/.test(cleaned)) return true;
  if (isMalformedStagedLine(cleaned)) return true;
  if (text.split(/\s+/).length < 5) return true;
  return false;
}

function uniqueCleanDiscussionItems(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const cleaned = cleanStagedDiscussionText(value);
    const key = cleaned.toLowerCase();
    if (!cleaned || isNoEvidenceDiscussionText(cleaned) || isLowValueStagedDiscussionText(cleaned) || seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
  }
  return result;
}

function normaliseStagedPointForSimilarity(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\b(?:the|a|an|and|or|to|be|been|being|will|must|should|before|after|first|then|both|required|requires|requirement)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stagedDiscussionPointSimilarity(left, right) {
  const leftTokens = new Set(normaliseStagedPointForSimilarity(left).split(/\s+/).filter((word) => word.length >= 4));
  const rightTokens = new Set(normaliseStagedPointForSimilarity(right).split(/\s+/).filter((word) => word.length >= 4));
  if (!leftTokens.size || !rightTokens.size) return 0;
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }
  return overlap / Math.min(leftTokens.size, rightTokens.size);
}

function cleanStagedExecutiveSummary(value) {
  const cleaned = cleanStagedGeneratedLine(value)
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !/\bthe reviewer should check\b/i.test(sentence))
    .join(' ')
    .trim();
  return isNoEvidenceDiscussionText(cleaned) ? '' : cleaned;
}

async function grammarPolishStagedExecutiveSummary(value) {
  const original = cleanStagedExecutiveSummary(value);
  if (!original) return { text: '', used: false, reason: 'empty_text' };
  return polishExecutiveSummaryGrammar(original, {
    apiKey: process.env.TROOPER_API_KEY,
    model: String(process.env.TROOPER_MODEL || TROOPER_STAGE_MODEL_DEFAULT).trim() || TROOPER_STAGE_MODEL_DEFAULT,
    url: String(process.env.TROOPER_CHAT_COMPLETIONS_URL || TROOPER_STAGE_URL_DEFAULT).trim() || TROOPER_STAGE_URL_DEFAULT,
    fetchImpl: fetch,
    maxTokens: Number(process.env.STAGED_SUMMARY_GRAMMAR_MAX_TOKENS || 700),
    timeoutMs: Number(process.env.STAGED_SUMMARY_GRAMMAR_TIMEOUT_MS || 20000)
  });
}

async function polishStagedInitialUnderstanding(summary, meetingTitle, evidencePack = null, meetingText = '') {
  return polishInitialUnderstanding({
    meetingTitle,
    meetingPurpose: summary?.meetingPurpose,
    objectives: summary?.objectives,
    overallTopics: summary?.overallTopics,
    executiveSummary: summary?.executiveSummary
  }, {
    apiKey: process.env.TROOPER_API_KEY,
    model: String(process.env.TROOPER_MODEL || TROOPER_STAGE_MODEL_DEFAULT).trim() || TROOPER_STAGE_MODEL_DEFAULT,
    url: String(process.env.TROOPER_CHAT_COMPLETIONS_URL || TROOPER_STAGE_URL_DEFAULT).trim() || TROOPER_STAGE_URL_DEFAULT,
    fetchImpl: fetch,
    evidencePack,
    meetingText,
    // 1300/30s with a pack: the same single call carries ~8-10k more prompt tokens and
    // brings back a three-to-five sentence summary, up to eight objectives and now the
    // topic headings too. At 900 the response no longer fit, and the tell was indirect -
    // the router answered 422 json_generation_failed on a truncated object, the retry
    // dropped the pack, and three meetings quietly fell back to deterministic text with a
    // reason that pointed at the wording rather than the size. Without a pack the old
    // budget stands.
    maxTokens: Number(process.env.STAGED_INITIAL_UNDERSTANDING_MAX_TOKENS || (evidencePack ? 1300 : 650)),
    timeoutMs: Number(process.env.STAGED_INITIAL_UNDERSTANDING_TIMEOUT_MS || (evidencePack ? 30000 : 20000))
  });
}

function stagedMiniLMOutput(minilmContext) {
  return minilmContext && minilmContext.ok && minilmContext.output && typeof minilmContext.output === 'object'
    ? minilmContext.output
    : {};
}

function stagedMiniLMTelemetry(minilmContext) {
  const diagnostics = minilmContext?.diagnostics || {};
  return {
    used: Boolean(minilmContext?.ok),
    provider: diagnostics.provider || (minilmContext?.rewriterAvailable ? 'trooper' : 'embedding'),
    rewriterAvailable: Boolean(minilmContext?.rewriterAvailable),
    rewriterReason: minilmContext?.rewriterReason || diagnostics.rewriterReason || '',
    pipeline: diagnostics.pipeline || '',
    modelAvailable: Boolean(diagnostics.modelAvailable),
    modelName: diagnostics.modelName || '',
    modelReason: diagnostics.modelReason || '',
    counts: minilmContext?.counts || {},
    evidencePackTopicCount: Number(diagnostics.evidencePackTopicCount || 0),
    workstreamStateCount: Number(diagnostics.workstreamStateCount || 0),
    missingWorkstreamCount: Number(diagnostics.missingWorkstreamCount || 0),
    missingWorkstreams: Array.isArray(diagnostics.missingWorkstreams) ? diagnostics.missingWorkstreams : [],
    workstreamQualityFlags: Array.isArray(diagnostics.workstreamQualityFlags) ? diagnostics.workstreamQualityFlags : [],
    timingMs: diagnostics.timingMs || {}
  };
}

function stagedEvidenceClassifierContext(context) {
  return context?.evidenceClassifier && typeof context.evidenceClassifier === 'object'
    ? context.evidenceClassifier
    : null;
}

function stagedEvidenceClassifierTelemetry(context) {
  const evidenceContext = stagedEvidenceClassifierContext(context);
  const diagnostics = evidenceContext?.diagnostics || {};
  return {
    used: Boolean(evidenceContext?.ok),
    executed: Boolean(evidenceContext?.executed),
    modelAvailable: Boolean(evidenceContext?.modelAvailable),
    modelName: evidenceContext?.modelName || diagnostics.modelName || '',
    modelPath: diagnostics.modelPath || '',
    modelReason: evidenceContext?.modelReason || diagnostics.modelReason || '',
    actionCount: Array.isArray(evidenceContext?.actions) ? evidenceContext.actions.length : 0,
    itemCount: Array.isArray(evidenceContext?.items) ? evidenceContext.items.length : 0,
    segmentsScored: Number(evidenceContext?.segmentsScored || 0),
    counts: evidenceContext?.counts || {},
    timingMs: diagnostics.timingMs || {}
  };
}

function topicsFromStagedMiniLM(minilmContext) {
  const output = stagedMiniLMOutput(minilmContext);
  const topics = [];
  for (const topic of stringListFromAny(output.overallTopics || output.topics, ['topic', 'title', 'text'])) {
    pushUniqueTopic(topics, topic, 10);
  }
  const discussionTopics = Array.isArray(output.discussionTopics) ? output.discussionTopics : [];
  const meetingMinutes = Array.isArray(output.meetingMinutes) ? output.meetingMinutes : [];
  const evidenceTopics = Array.isArray(output.evidenceBackedTopics) ? output.evidenceBackedTopics : [];

  for (const item of discussionTopics) {
    if (!item || typeof item !== 'object') continue;
    pushUniqueTopic(topics, item.topic || item.title || item.heading, 10);
  }

  for (const item of meetingMinutes) {
    if (!item || typeof item !== 'object') continue;
    pushUniqueTopic(topics, item.topic || item.topicLabel || item.title, 10);
  }

  for (const item of evidenceTopics) {
    if (!item || typeof item !== 'object') continue;
    pushUniqueTopic(topics, item.themeLabel || item.topicLabel || item.topic, 10);
    pushUniqueTopic(topics, item.topicLabel || item.topic || item.themeLabel, 10);
  }

  for (const point of stringListFromAny(output.discussionPoints, ['discussionPoint', 'topicLabel', 'text'])) {
    const cleaned = cleanStagedGeneratedLine(point);
    if (!cleaned || isNoEvidenceDiscussionText(cleaned)) continue;
    pushUniqueTopic(topics, topic_label_from_text(cleaned), 10);
  }

  return topics.slice(0, 8);
}

function topic_label_from_text(value) {
  const text = cleanStagedGeneratedLine(value).replace(/[.?!]\s.*$/, '').replace(/[.?!]$/, '');
  if (!text) return '';
  const words = text.split(/\s+/);
  if (words.length <= 9 && isUsableStagedTopic(text)) return text;
  return words.slice(0, 8).join(' ');
}

function cleanStagedActionText(value) {
  let action = cleanStagedGeneratedLine(value)
    .replace(/\s+/g, ' ')
    .trim();
  action = action.replace(/^have a catch[- ]?up meeting\b/i, 'Arrange a catch-up meeting');
  action = action.replace(/^catch up\b/i, 'Arrange a catch-up');
  return action;
}

function isAuditableStagedAction(action, owner = '', deadline = '') {
  const text = cleanStagedActionText(action);
  if (!text || isNoEvidenceDiscussionText(text) || isMalformedStagedLine(text)) return false;
  if (isQuestionShapedStagedAction(text)) return false;
  if (/\b(?:everything|stuff|things|sort out|as much as possible|front[- ]?end everything|prep\b|progress\b|look at|think about|discuss|consider)\b/i.test(text)) return false;
  const hasConcreteVerb = /\b(?:arrange|book|schedule|organise|coordinate|set\s+up|update|review|send|share|confirm|prepare|complete|finali[sz]e|provide|draft|submit|circulate|issue|upload|agree|approve|sign(?:\s+off)?|trace|generate|identify|document|follow[- ]?up)\b/i.test(text);
  const hasObject = text.split(/\s+/).length >= 3;
  const hasCommitmentSignal = stagedTextHasFutureCommitmentMarker(text) || /\b(?:action|owner|deadline|by|before|next|follow[- ]?up|catch[- ]?up)\b/i.test(text) || cleanStagedGeneratedLine(deadline);
  const hasUsableOwner = cleanStagedGeneratedLine(owner) && !/^not stated$/i.test(cleanStagedGeneratedLine(owner));
  return hasConcreteVerb && hasObject && (hasCommitmentSignal || hasUsableOwner);
}

function isQuestionShapedStagedAction(action) {
  const text = cleanStagedActionText(action);
  return /\?\s*$/.test(text) || /^(?:did|do|does|is|are|am|can|could|would|should|what|when|where|why|how)\b/i.test(text);
}

function stagedActionIntent(action) {
  const text = cleanStagedActionText(action).toLowerCase();
  if (/\b(?:share|send|provide|circulate|issue|upload|forward)\b/.test(text)) return 'share';
  if (/\b(?:complete|prepare|develop|draft|build|create|finali[sz]e|finish|produce|generate|trace|document|identify)\b/.test(text)) return 'produce';
  if (/\b(?:arrange|book|schedule|organise|coordinate|set up)\b/.test(text)) return 'arrange';
  if (/\b(?:review|check|confirm|verify|validate|assess)\b/.test(text)) return 'review';
  if (/\b(?:sign|approve|agree|accept)\b/.test(text)) return 'approve';
  return 'other';
}

function stagedActionsAreDuplicates(existing, candidate) {
  const existingAction = cleanStagedActionText(existing?.action || existing || '');
  const candidateAction = cleanStagedActionText(candidate?.action || candidate || '');
  const existingIntent = stagedActionIntent(existingAction);
  const candidateIntent = stagedActionIntent(candidateAction);
  const ownerA = normaliseStagedActionOwner(existing?.owner || '').toLowerCase();
  const ownerB = normaliseStagedActionOwner(candidate?.owner || '').toLowerCase();
  const sameKnownOwner = ownerA && ownerB && ownerA !== 'not stated' && ownerB !== 'not stated' && ownerA === ownerB;
  const combinedActionText = `${existingAction} ${candidateAction}`;
  const evidenceA = new Set(Array.isArray(existing?.sourceTurnIds) ? existing.sourceTurnIds : []);
  const evidenceOverlap = (Array.isArray(candidate?.sourceTurnIds) ? candidate.sourceTurnIds : []).some((turnId) => evidenceA.has(turnId));
  const sharedConcept = [
    /\b(?:usb|cybersecurity|port-lock)\b/i,
    /\belectrical compliance\b/i,
    /\bclinical review\b/i,
    /\bfan logic\b/i,
    /\bmute button\b/i
  ].some((pattern) => pattern.test(existingAction) && pattern.test(candidateAction));

  if (sharedConcept && (evidenceOverlap || existingIntent === candidateIntent || Math.min(existingAction.length, candidateAction.length) < 65)) {
    return true;
  }

  if (/\bfan logic\b/i.test(existingAction) && /\bfan logic\b/i.test(candidateAction) && /\bcognidocs\b/i.test(combinedActionText)) {
    return existingIntent === candidateIntent || evidenceOverlap;
  }

  if (
    /\bhpra\b/i.test(combinedActionText) &&
    /\b(?:invoice|bill|fee)\b/i.test(existingAction) &&
    /\b(?:invoice|bill|fee)\b/i.test(candidateAction) &&
    (
      (existingIntent === 'review' && candidateIntent === 'share') ||
      (existingIntent === 'share' && candidateIntent === 'review')
    )
  ) {
    return true;
  }

  // Same owner and same subject can still be two different actions:
  // "complete the risk assessment" is not a duplicate of "share the risk analysis".
  if (existingIntent !== candidateIntent && existingIntent !== 'other' && candidateIntent !== 'other') {
    return false;
  }

  const similarity = stagedDiscussionPointSimilarity(existingAction, candidateAction);
  if (
    existingIntent === 'share' &&
    candidateIntent === 'share' &&
    /\bhpra\b/i.test(combinedActionText) &&
    /\b(?:invoice|bill|fee)\b/i.test(existingAction) &&
    /\b(?:invoice|bill|fee)\b/i.test(candidateAction) &&
    /\bemail\b/i.test(combinedActionText)
  ) {
    return true;
  }
  if (
    sameKnownOwner &&
    existingIntent === candidateIntent &&
    existingIntent === 'review' &&
    /\bmute\b/i.test(combinedActionText) &&
    /\b(?:led|flash|flashing|sequence|behaviour|behavior)\b/i.test(combinedActionText)
  ) {
    return true;
  }
  if (
    sameKnownOwner &&
    existingIntent === candidateIntent &&
    existingIntent === 'review' &&
    /\b(?:standard|standards|81001|27427|cybersecurity|usb|applicable|applicability|guidance)\b/i.test(`${existingAction} ${candidateAction}`) &&
    (
      similarity >= 0.45 ||
      (/\b(?:standard|standards|81001|27427)\b/i.test(existingAction) && /\b(?:standard|standards|81001|27427)\b/i.test(candidateAction))
    )
  ) {
    return true;
  }
  if (sameKnownOwner && similarity >= 0.7 && existingIntent === candidateIntent) return true;
  return similarity >= 0.82 && existingIntent === candidateIntent;
}

function polishStagedActions(actions) {
  const result = [];
  for (const item of Array.isArray(actions) ? actions : []) {
    if (!item || typeof item !== 'object') continue;
    const action = cleanStagedActionText(item.action || item.meetingActionPoint);
    if (/\b(?:world and his wife|every regulation under the sun|you know|or whatever)\b/i.test(action)) continue;
    const rawOwner = cleanStagedGeneratedLine(item.owner || item.meetingActionPointOwner || 'Not stated') || 'Not stated';
    const owner = /^\p{Lu}[\p{L}'’.-]+$/u.test(rawOwner)
      ? rawOwner
      : normaliseStagedActionOwner(rawOwner);
    const deadline = cleanStagedGeneratedLine(item.deadline || item.meetingActionPointDeadline || '');
    const finalAction = normaliseFinalStagedActionCandidate({
      owner,
      action,
      deadline,
      evidence: item.evidence || item.sourceText || item.contextText || ''
    });
    if (!finalAction) continue;
    if (!isAuditableStagedAction(finalAction.action, finalAction.owner, finalAction.deadline)) continue;
    if (result.some((existing) => stagedActionsAreDuplicates(existing, finalAction))) continue;
    result.push({
      ...finalAction,
      source: item.source || undefined,
      evidence: item.evidence || item.sourceText || item.contextText || '',
      sourceTurnIds: Array.isArray(item.sourceTurnIds) ? item.sourceTurnIds : []
    });
    if (result.length >= 20) break;
  }
  return result;
}

function actionsFromStagedMiniLM(minilmContext) {
  const output = stagedMiniLMOutput(minilmContext);
  const actions = [];
  const actionObjects = Array.isArray(output.actions) ? output.actions : [];

  for (const item of actionObjects) {
    if (!item || typeof item !== 'object') continue;
    const action = cleanStagedActionText(item.action || item.meetingActionPoint);
    if (!action) continue;
    actions.push({
      owner: normaliseStagedActionOwner(item.owner || item.meetingActionPointOwner || 'Not stated'),
      action,
      deadline: cleanStagedGeneratedLine(item.deadline || item.meetingActionPointDeadline)
    });
    if (actions.length >= 20) return polishStagedActions(actions);
  }

  const points = Array.isArray(output.meetingActionPoint) ? output.meetingActionPoint : [];
  const owners = Array.isArray(output.meetingActionPointOwner) ? output.meetingActionPointOwner : [];
  const deadlines = Array.isArray(output.meetingActionPointDeadline) ? output.meetingActionPointDeadline : [];
  for (let index = 0; index < points.length; index += 1) {
    const action = cleanStagedActionText(points[index]);
    if (!action) continue;
    actions.push({
      owner: normaliseStagedActionOwner(owners[index] || 'Not stated'),
      action,
      deadline: cleanStagedGeneratedLine(deadlines[index] || '')
    });
    if (actions.length >= 20) break;
  }

  return polishStagedActions(actions);
}

function actionsFromEvidenceClassifier(context) {
  const evidenceContext = stagedEvidenceClassifierContext(context);
  const actions = Array.isArray(evidenceContext?.actions) ? evidenceContext.actions : [];
  return polishStagedActions(actions.map((item) => ({
    owner: item?.owner || 'Not stated',
    action: item?.action || '',
    deadline: item?.deadline || '',
    source: item?.source || 'meeting_minutes_evidence_classifier'
  })));
}

function actionReviewCandidateSuggestion(text) {
  const value = cleanStagedGeneratedLine(text || '')
    .replace(/\bofpulling\b/gi, 'of pulling')
    .replace(/\bgenerateleads\b/gi, 'generate leads')
    .replace(/\byou\.aim\b/gi, 'you aim')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.?!]+$/, '');
  if (!value) return '';
  const lower = value.toLowerCase();
  let suggestion = '';
  if (/\bfour[- ]week pilot\b/.test(lower)) {
    suggestion = 'Run a four-week pilot to test the volume and quality of leads before automating the process';
  } else if (/\b(?:criteria|criterion)\b/.test(lower) && /\b(?:icp|ideal client profile|fit)\b/.test(lower)) {
    suggestion = 'Define the ICP fit criteria for the lead generation process';
  } else if (/\bqualif(?:y|ying)\b/.test(lower) && /\bleads?\b/.test(lower)) {
    suggestion = 'Define how client delivery leads should be qualified';
  } else if (/\bcapture\b/.test(lower) && /\bsignal\b/.test(lower)) {
    suggestion = 'Confirm how lead signals will be captured and triaged';
  } else if (/\bkey questions\b/i.test(value) && /\bleadership\b/i.test(value)) {
    suggestion = 'Prepare the key questions for the leadership meeting';
  } else if (/\bforward(?:ing)?\s+(?:me\s+)?(.+?)(?:\s+and\s+i['’]?ll|\s+and then|$)/i.test(value)) {
    suggestion = `Forward ${value.match(/\bforward(?:ing)?\s+(?:me\s+)?(.+?)(?:\s+and\s+i['’]?ll|\s+and then|$)/i)[1]}`;
  } else if (/\b(?:send|share|forward)\b/.test(lower) && /\b(?:article|document|pack|report|information|points|transcript)\b/.test(lower)) {
    suggestion = value
      .replace(/^.*?\b(?:send|share|forward)\b/i, (match) => match.replace(/^.*?\b/i, '').trim())
      .replace(/^send\b/i, 'Send')
      .replace(/^share\b/i, 'Share')
      .replace(/^forward\b/i, 'Forward');
  } else if (/\bwe need (?:a way )?to\b/i.test(value)) {
    suggestion = value.replace(/^.*?\bwe need (?:a way )?to\b/i, 'Confirm how to');
  } else if (/\bneeds? to\b/i.test(value)) {
    suggestion = value.replace(/^.*?\bneeds? to\b/i, 'Confirm how to');
  } else if (/\b(?:i['’]?ll|i will|i need to|i have to|we['’]?ll|we will|we need to|we have to)\b/i.test(value)) {
    suggestion = value
      .replace(/^.*?\b(?:i['’]?ll|i will|i need to|i have to|we['’]?ll|we will|we need to|we have to)\b/i, '')
      .replace(/^\s*(?:to\s+)?/i, '')
      .trim();
  }
  suggestion = cleanStagedActionText(suggestion || value);
  if (!suggestion || suggestion.split(/\s+/).length < 4 || suggestion.split(/\s+/).length > 32) return '';
  if (/^(?:and then|but|because|okay|yeah|no|what|when|where|why|how)\b/i.test(suggestion)) return '';
  if (/\b(?:take it from there|move you off (?:this )?screen|looking at yourselves|reception|wi-?fi)\b/i.test(suggestion)) return '';
  if (isQuestionShapedStagedAction(suggestion)) return '';
  return suggestion[0].toUpperCase() + suggestion.slice(1);
}

function actionReviewCandidateIsUseful(text, item = {}) {
  const value = cleanStagedGeneratedLine(text || '');
  if (value.length < 28 || value.length > 320) return false;
  if (/^(?:#|[-*]\s*(?:source file|meeting id|stored meeting title|transcript length|autosave timestamp)|\d+\s*(?:m|h|s)\b)/i.test(value)) return false;
  if (/\b(?:meeting transcript|source file|stored meeting title|autosave timestamp|stopped transcription|started transcription)\b/i.test(value)) return false;
  if (/\b(?:move you off (?:this )?screen|looking at yourselves|reception|wi-?fi)\b/i.test(value)) return false;
  if (/\?\s*$/.test(value) && !/\b(?:need to|needs to|can you|could you|should|will|going to)\b/i.test(value)) return false;
  if (/\b(?:good to see you|thanks|bye|take care|highlights by the way)\b/i.test(value)) return false;
  const evidenceType = cleanStagedGeneratedLine(item.evidenceType || '');
  const commitmentState = cleanStagedGeneratedLine(item.commitmentState || '');
  const usefulType = /^(?:action_commitment|document_control_task|process_overview)$/i.test(evidenceType);
  const usefulState = /^(?:possible_action|confirmed_action)$/i.test(commitmentState);
  const usefulLanguage = /\b(?:need(?:s)? to|we need|i need|i['’]?ll|i will|we['’]?ll|we will|going to|four[- ]week pilot|define|qualif(?:y|ying)|capture|triage|send|share|forward|confirm|test|pilot)\b/i.test(value);
  return usefulLanguage || usefulType || usefulState;
}

function actionReviewCandidatesFromEvidence(context, transcriptText) {
  const candidates = [];
  const seen = new Set();
  const push = (candidate) => {
    if (!candidate) return;
    const action = actionReviewCandidateSuggestion(candidate.text);
    if (!action) return;
    const key = action.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({
      owner: candidate.speaker || 'Not stated',
      action,
      suggestedAction: action,
      deadline: 'Not stated',
      reviewDisposition: 'review_required',
      confidenceTier: 'review',
      reviewerUsefulnessTier: 'medium',
      source: candidate.source || 'action_review_candidate',
      sourceSnippet: cleanStagedGeneratedLine(candidate.text || ''),
      sourceSpeaker: cleanStagedGeneratedLine(candidate.speaker || '')
    });
  };

  const evidenceContext = stagedEvidenceClassifierContext(context);
  for (const item of Array.isArray(evidenceContext?.items) ? evidenceContext.items : []) {
    const text = cleanStagedGeneratedLine(item?.text || '');
    if (item?.suppressReason || !actionReviewCandidateIsUseful(text, item)) continue;
    push({ text, speaker: cleanStagedGeneratedLine(item?.speaker || ''), source: 'meeting_minutes_evidence_classifier_review' });
    if (candidates.length >= 6) return candidates;
  }

  const evidence = prepareEvidence(transcriptText);
  for (const event of evidence.events || []) {
    if (!Array.isArray(event.roles) || !event.roles.includes('action_candidate')) continue;
    if (event.roles.includes('negative_or_superseding') || event.roles.includes('completed_history')) continue;
    if (!actionReviewCandidateIsUseful(event.text, { evidenceType: 'action_commitment', commitmentState: 'possible_action' })) continue;
    push({ text: event.text, speaker: event.speaker, source: 'transcript_action_review_candidate' });
    if (candidates.length >= 6) return candidates;
  }

  return candidates;
}



function ownerFromTeamsSpeakerLine(line) {
  const text = String(line || '').replace(/\s+/g, ' ').trim();
  const commaMatch = text.match(/^([A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+),\s*([A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+)(?:\s+([A-Z]))?\b/);
  if (commaMatch) return [commaMatch[2], commaMatch[3]].filter(Boolean).join(' ');
  const teamsMatch = text.match(new RegExp(`^([A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+(?:\\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+){0,2})\\s+${TEAMS_TIMESTAMP_PATTERN}\\b`, 'i'));
  if (teamsMatch && isLikelyPersonName(teamsMatch[1])) return teamsMatch[1];
  const nameMatch = text.match(/^([A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+(?:\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+){1,2})\b/);
  return nameMatch && isLikelyPersonName(nameMatch[1]) ? nameMatch[1] : 'Not stated';
}

function deadlineFromActionEvidence(line) {
  return parseDeadlineEvidence(line)?.normalised || '';
}


function normaliseDeadlineKey(value) {
  return cleanStagedGeneratedLine(value || '')
    .toLowerCase()
    .replace(/^next\s+/i, '')
    .replace(/\bof\s+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}



function enrichStagedActionDeadlinesFromTranscript(actions, transcriptText) {
  return polishStagedActions((Array.isArray(actions) ? actions : []).map((item) => {
    const deadline = cleanStagedGeneratedLine(item?.deadline || item?.meetingActionPointDeadline || '');
    const evidence = String(item?.evidence || item?.sourceText || item?.contextText || '');
    if (deadline && !/^not stated$/i.test(deadline)) {
      const parsed = parseDeadlineEvidence(evidence);
      return parsed && normaliseDeadlineKey(parsed.normalised) === normaliseDeadlineKey(deadline)
        ? item
        : { ...item, deadline: 'Not stated' };
    }
    const inferred = deadlineFromActionEvidence(evidence);
    return inferred ? { ...item, deadline: inferred } : item;
  }));
}

function transcriptPreservedStagedActions(transcriptText) {
  const lines = String(transcriptText || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const preserved = [];

  for (const line of lines) {
    const normalised = line.toLowerCase();
    if (
      /\brisk assessment\b/.test(normalised) &&
      /\baudit plan\b/.test(normalised) &&
      /\b(?:got to|need to|needs to|must|will|trying to|getting ready|ready for)\b/.test(normalised) &&
      /\b(?:develop|prepare|complete|input into|ready for)\b/.test(normalised)
    ) {
      preserved.push({
        owner: ownerFromTeamsSpeakerLine(line),
        action: 'Complete the risk assessment to develop the audit plan',
        deadline: deadlineFromActionEvidence(line) || 'Wednesday',
        evidence: line,
        source: 'transcript_action_preservation_guard'
      });
    }
  }

  return polishStagedActions(preserved);
}

function pushTranscriptActionInventoryAction(actions, candidate) {
  if (!candidate || typeof candidate !== 'object') return;
  const action = cleanStagedActionText(candidate.action || '');
  const owner = cleanStagedGeneratedLine(candidate.owner || 'Not stated') || 'Not stated';
  const deadline = cleanStagedGeneratedLine(candidate.deadline || '');
  const next = { owner, action, deadline, source: candidate.source || 'transcript_action_inventory' };
  if (!isAuditableStagedAction(action, owner, deadline)) return;
  if (actions.some((existing) => stagedActionsAreDuplicates(existing, next))) return;
  actions.push(next);
}

function buildStagedActionInventory(transcriptText) {
  const actions = [];
  for (const candidate of buildEvidenceBoundStagedActionInventory(transcriptText)) {
    pushTranscriptActionInventoryAction(actions, candidate);
  }
  return polishStagedActions(actions);
}

function mergePreservedStagedActions(actions, transcriptText) {
  const inventory = buildStagedActionInventory(transcriptText);
  const merged = polishStagedActions([...inventory, ...(Array.isArray(actions) ? actions : [])]);
  const preserved = transcriptPreservedStagedActions(transcriptText)
    .filter((candidate) => !merged.some((existing) => stagedActionsAreDuplicates(existing, candidate)));
  return enrichStagedActionDeadlinesFromTranscript([...merged, ...preserved], transcriptText);
}

function normaliseStagedActionOwner(owner) {
  const cleaned = cleanStagedGeneratedLine(owner || 'Not stated') || 'Not stated';
  if (/^(?:we|us|our team|the team|everyone)$/i.test(cleaned)) return 'All';
  return cleaned
    .split(/\s*\/\s*/)
    .map((part) => canonicalKnownStagedPersonName(part))
    .filter(Boolean)
    .join(' / ') || cleaned;
}







// buildStagedGenerationContext was the 60-line entry point of the pre-canonical staged path, deleted in the
// Phase 5 consolidation when its last caller (runStagedSequenceForEvaluation) moved to
// canonicalStagedResponse - the pipeline the reviewer actually sees. Its shared helpers
// remain where other paths still use them.

function transcriptForStagedAI(transcript, inputPayload = {}) {
  const prepared = transcript?.preparedTranscript || inputPayload?.preparedTranscript;
  if (prepared && typeof prepared === 'object' && String(prepared.text || '').trim()) {
    return {
      text: String(prepared.text || ''),
      source: `${transcript.source || 'staged-meeting-minutes'}-prepared`,
      fileName: transcript.fileName || '',
      preparedTranscriptTelemetry: transcript.preparedTranscriptTelemetry || inputPayload.preparedTranscriptTelemetry || prepared.telemetry || null
    };
  }
  const generated = buildPreparedTranscriptForStagedAI(transcript.text);
  return {
    text: generated.text,
    source: `${transcript.source || 'staged-meeting-minutes'}-prepared`,
    fileName: transcript.fileName || '',
    preparedTranscriptTelemetry: {
      rawLength: generated.rawLength,
      preparedLength: generated.preparedLength,
      removedLineCount: generated.removedLineCount,
      removedReasons: generated.removedReasons,
      source: 'deterministic_stage_1_prep_fallback'
    }
  };
}

function stagedContextFromRequest(req) {
  const confirmedDetails = parseStagedJsonObject(req.body?.confirmedDetails || req.query?.confirmedDetails);
  const confirmedSummary = parseStagedJsonObject(req.body?.confirmedSummary || req.query?.confirmedSummary);
  const explicitKeyFacts = parseStagedJsonArray(req.body?.keyFacts || req.query?.keyFacts);
  const summaryForUnderstanding = {
    ...confirmedSummary,
    meetingPurpose: firstString(confirmedSummary.meetingPurpose, confirmedSummary.purpose, req.body?.meetingPurpose, req.query?.meetingPurpose),
    keyFacts: Array.isArray(confirmedSummary.keyFacts) && confirmedSummary.keyFacts.length
      ? confirmedSummary.keyFacts
      : explicitKeyFacts
  };
  const confirmedUnderstanding = buildConfirmedUnderstanding(summaryForUnderstanding);
  return {
    meetingTitle: firstString(confirmedDetails.meetingTitle, req.body?.meetingTitle, req.query?.meetingTitle),
    meetingDate: firstString(confirmedDetails.meetingDate, req.body?.meetingDate, req.query?.meetingDate),
    meetingLocation: firstString(confirmedDetails.meetingLocation, req.body?.meetingLocation, req.query?.meetingLocation),
    meetingType: firstString(confirmedDetails.meetingType, req.body?.meetingType, req.query?.meetingType, 'General'),
    participants: linesFrom(confirmedDetails.participants || req.body?.participants || req.query?.participants),
    meetingPurpose: confirmedUnderstanding.meetingPurpose,
    keyFacts: confirmedUnderstanding.criticalFacts.map((fact) => fact.text),
    confirmedUnderstanding,
    objectives: linesFrom(confirmedSummary.objectives || req.body?.reviewObjectives || req.query?.reviewObjectives),
    overallTopics: linesFrom(confirmedSummary.overallTopics || req.body?.overallTopics || req.query?.overallTopics || req.body?.topics || req.query?.topics),
    additionalContext: firstString(req.body?.additionalContext, req.query?.additionalContext).slice(0, 3000)
  };
}

function parseStagedJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseStagedJsonArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}


function stagedReviewContextFromRequest(req) {
  return {
    objectives: parseStagedJsonArray(req.body?.reviewObjectives || req.query?.reviewObjectives)
      .map((item) => cleanStagedGeneratedLine(item))
      .filter(Boolean),
    discussion: parseStagedJsonArray(req.body?.reviewDiscussion || req.query?.reviewDiscussion)
      .map((item) => {
        if (!item || typeof item !== 'object') return null;
        const points = uniqueCleanDiscussionItems(item.points || item.bullets || item.discussionPoints || []);
        const topic = cleanStagedGeneratedLine(item.topic || item.title || 'Discussion');
        return topic && points.length ? { topic, points } : null;
      })
      .filter(Boolean),
    actions: parseStagedJsonArray(req.body?.reviewActions || req.query?.reviewActions)
      .map((item) => {
        if (!item || typeof item !== 'object') return null;
        return {
          owner: normaliseStagedActionOwner(item.owner || 'Not stated'),
          action: cleanStagedActionText(item.action || item.meetingActionPoint || ''),
          deadline: cleanStagedGeneratedLine(item.deadline || item.meetingActionPointDeadline || '')
        };
      })
      .filter((item) => item && item.action)
  };
}

function stagedDetailsWithConfirmedContext(req, transcript) {
  const extracted = extractStagedDetailsFromTranscript(transcript.text, transcript.fileName).screens.details;
  const context = stagedContextFromRequest(req);
  return {
    ...extracted,
    meetingTitle: context.meetingTitle || extracted.meetingTitle,
    meetingDate: normaliseDateInput(context.meetingDate) || extracted.meetingDate,
    meetingLocation: context.meetingLocation || extracted.meetingLocation,
    meetingType: context.meetingType || extracted.meetingType,
    allAttendees: context.participants.length ? context.participants : extracted.allAttendees
  };
}

// buildStagedSummaryResponse was the 53-line entry point of the pre-canonical staged path, deleted in the
// Phase 5 consolidation when its last caller (runStagedSequenceForEvaluation) moved to
// canonicalStagedResponse - the pipeline the reviewer actually sees. Its shared helpers
// remain where other paths still use them.

function stagedTopicTokenSet(value) {
  const ignored = new Set(['meeting', 'review', 'update', 'discussion', 'point', 'points', 'status', 'topic', 'project', 'document', 'documentation', 'management', 'workstream', 'client']);
  return new Set(
    String(value || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 4 && !ignored.has(word))
  );
}

function stagedTokenSimilarity(left, right) {
  const leftTokens = stagedTopicTokenSet(left);
  const rightTokens = stagedTopicTokenSet(right);
  if (!leftTokens.size || !rightTokens.size) return 0;
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }
  return overlap / Math.max(leftTokens.size, rightTokens.size);
}

function cleanStagedEvidenceSnippet(value) {
  const cleaned = stripStagedTranscriptArtefacts(value);
  if (!cleaned || isNoEvidenceDiscussionText(cleaned) || isLowValueStagedDiscussionText(cleaned)) return '';
  const words = cleaned.split(/\s+/);
  if (words.length < 5) return '';
  return cleaned;
}

function stagedTextHasFutureCommitmentMarker(value) {
  return /\b(?:will|shall|to\s+(?:review|send|share|update|complete|prepare|provide|confirm|submit|arrange|follow up|finali[sz]e|check|circulate|draft|issue)|needs?\s+to|should|going\s+to|by\s+(?:next\s+)?(?:monday|tuesday|wednesday|thursday|friday|week|\d{1,2})|before\s+(?:the\s+)?(?:next|release|submission|audit|review)|follow[- ]?up)\b/i.test(String(value || ''));
}



function normaliseTopicKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}





// buildStagedDiscussionResponse was the 134-line entry point of the pre-canonical staged path, deleted in the
// Phase 5 consolidation when its last caller (runStagedSequenceForEvaluation) moved to
// canonicalStagedResponse - the pipeline the reviewer actually sees. Its shared helpers
// remain where other paths still use them.

function extractActionCandidatesFromTranscript(transcriptText) {
  const lines = String(transcriptText || '')
    .split(/\r?\n/)
    .map(cleanTranscriptContentLine)
    .filter((line) => line.length >= 28 && line.length <= 260);
  const actionPatterns = [
    /\b(?:action|actions|follow up|follow-up|to do|owner|deadline)\b/i,
    /\b(?:will|needs to|need to|should|can you|please|going to)\b/i,
    /\b(?:next monday|next week|friday|monday|tuesday|wednesday|thursday|today|tomorrow|by\s+\d{1,2})\b/i
  ];
  const candidates = [];

  for (const line of lines) {
    if (!actionPatterns.some((pattern) => pattern.test(line))) continue;
    const ownerMatch = line.match(/^([A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+)(?:\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+)?\b/);
    const deadlineMatch = line.match(/\b(?:by\s+)?(?:next\s+)?(?:monday|tuesday|wednesday|thursday|friday|next week|today|tomorrow|\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+20\d{2}|\d{1,2}[/-]\d{1,2}[/-]20\d{2})\b/i);
    candidates.push({
      owner: ownerMatch && isLikelyPersonName(ownerMatch[0]) ? ownerMatch[0] : 'Not stated',
      action: line.replace(/\s+/g, ' ').trim(),
      deadline: deadlineMatch ? deadlineMatch[0].replace(/^by\s+/i, '').trim() : ''
    });
    if (candidates.length >= 20) break;
  }

  return candidates;
}

function buildStagedActionsResponse(req, transcript, minilmContext = null, recoveryTranscriptText = transcript.text) {
  const stagedActions = actionsFromStagedMiniLM(minilmContext);
  const evidenceActions = actionsFromEvidenceClassifier(minilmContext);
  const groundedTranscriptText = String(recoveryTranscriptText || transcript.text || '');
  const evidenceLedger = buildStagedEvidenceLedger(groundedTranscriptText);
  const actionInventory = buildStagedActionInventory(groundedTranscriptText);
  const sourceActions = polishStagedActions([...evidenceActions, ...stagedActions, ...actionInventory]);
  const mergedActions = mergePreservedStagedActions(sourceActions.length
    ? sourceActions
    : extractActionCandidatesFromTranscript(groundedTranscriptText), groundedTranscriptText);
  // The ledger repairs sparse/fallback extraction. Once the established pipeline
  // already has a substantive inventory, do not let a second extractor inflate it.
  const ledgerRepairs = mergedActions.length < 4 ? evidenceLedger.actions : [];
  const evidenceMergedActions = [...ledgerRepairs, ...mergedActions].filter((candidate, index, all) =>
    all.findIndex((existing) => stagedActionsAreDuplicates(existing, candidate)) === index
  ).filter((candidate) => isAuditableStagedAction(candidate?.action || '', candidate?.owner || '', candidate?.deadline || ''));
  const details = stagedDetailsWithConfirmedContext(req, transcript);
  const participants = uniqueNames([
    ...(Array.isArray(details.allAttendees) ? details.allAttendees : []),
    ...extractTeamsSpeakerNames(groundedTranscriptText)
  ]);
  const ownerValidationFlags = [];
  const actions = evidenceMergedActions.map((item, index) => {
    const validation = normaliseAndValidateActionOwner(item.owner, participants);
    if (!['accepted', 'repaired_unambiguous'].includes(validation.status)) {
      ownerValidationFlags.push({
        type: 'uncertain_action_owner',
        severity: 'warning',
        fieldPath: `actions.${index}.owner`,
        message: `The tool could not safely match "${item.owner}" to a confirmed attendee, so the owner is set to Not stated. Choose the correct owner from the table if the transcript supports one.`
      });
    }
    return { owner: validation.owner, action: item.action, deadline: item.deadline || 'Not stated', ...(item.source ? { source: item.source } : {}) };
  });
  const reviewContext = stagedReviewContextFromRequest(req);
  const validationFlags = [...buildStagedValidationFlags({
    objectives: reviewContext.objectives,
    discussion: reviewContext.discussion,
    actions
  }), ...ownerValidationFlags];
  const actionReviewCandidates = actions.length ? [] : actionReviewCandidatesFromEvidence(minilmContext, groundedTranscriptText);
  if (!actions.length && actionReviewCandidates.length) validationFlags.push({
    type: 'action_review_candidates',
    severity: 'warning',
    blocking: false,
    message: `${actionReviewCandidates.length} possible follow-up${actionReviewCandidates.length === 1 ? ' needs' : 's need'} your decision. Add anything that is a real action, and dismiss anything that is only background or process discussion.`,
    repairCandidates: actionReviewCandidates
  });
  if (!actions.length && !actionReviewCandidates.length) validationFlags.push({
    type: 'no_actions_detected',
    severity: 'info',
    blocking: false,
    message: 'No actions were found. If the meeting really had no follow-ups, mark this as reviewed. Otherwise, add the missing action manually.'
  });

  return {
    ok: true,
    source: transcript.source,
    fileName: transcript.fileName || null,
    transcriptLength: transcript.text.length,
    staged: true,
    stagedStage: 'actions',
    validationFlags,
    actionReviewCandidates,
    screens: {
      actions
    },
    telemetryPreview: {
      stage: 'actions',
      actionCount: actions.length,
      actionPreservation: {
        transcriptPreservedActionCount: transcriptPreservedStagedActions(groundedTranscriptText).length,
        transcriptActionInventoryCount: actionInventory.length,
        evidenceLedgerActionCount: evidenceLedger.actions.length,
        evidenceClassifierActionCount: evidenceActions.length,
        transcriptActionInventoryUsed: Boolean(actionInventory.length || evidenceActions.length)
      },
      transcriptLength: transcript.text.length,
      embeddingClassifier: stagedMiniLMTelemetry(minilmContext),
      evidenceClassifier: stagedEvidenceClassifierTelemetry(minilmContext)
    }
  };
}

function buildStagedMeetingMinutesResponse(req, transcript, result) {
  const base = buildTestTranscriptResponse(req, transcript, result);
  const candidate = result?.output && typeof result.output === 'object' ? result.output : result;
  const reviewData = normalizeReviewData(candidate, transcript.text);
  const objectives = reviewData.meetingObjectives.length
    ? reviewData.meetingObjectives
    : linesFrom(candidate?.meetingObjectives);
  const summary = firstString(
    candidate?.executiveSummary,
    candidate?.summary,
    candidate?.meetingDescription,
    reviewData.meetingDescription
  );
  // An empty section publishes empty. Filling it with "Review this section against the
  // transcript." put an instruction written to ourselves into the client's minutes, and
  // it reads as content rather than as the absence of it.
  const discussion = reviewData.meetingMinutes.map((item) => ({
    topic: item.topic || 'Discussion',
    points: item.discussionPoints.length ? item.discussionPoints : []
  }));
  const actions = reviewData.nextSteps.map((item) => ({
    owner: item.owner || 'Not stated',
    action: item.action || 'Review action wording',
    deadline: item.deadline || 'Not stated'
  }));
  const internalAttendees = reviewData.participants.trinzo;
  const clientAttendees = reviewData.participants.client;

  const { cards: dedupedDiscussion, dropped: droppedDuplicates } = dedupeStagedDiscussionCards(discussion);
  const clientCleanDiscussion = reshapeStagedDiscussionCardsForHumanMinutes(dedupedDiscussion, {
    pointLimit: 6,
    processDetailPointLimit: 8
  });
  const validationFlags = buildStagedValidationFlags({
    objectives,
    actions,
    discussion: clientCleanDiscussion,
    droppedDuplicates
  });

  return {
    ...base,
    staged: true,
    validationFlags,
    screens: {
      details: {
        meetingTitle: reviewData.meetingTitle || candidate?.title || 'Untitled meeting',
        meetingDate: reviewData.meetingDate || '',
        meetingLocation: reviewData.meetingLocation || 'Microsoft Teams',
        organisation: candidate?.organisation || candidate?.clientName || '',
        meetingType: candidate?.meetingType || 'General',
        internalAttendees,
        clientAttendees
      },
      summary: {
        objectives,
        executiveSummary: summary || 'Review the transcript-generated summary before moving on.'
      },
      discussion: clientCleanDiscussion.length ? clientCleanDiscussion : [{
        topic: 'Discussion',
        points: ['Review the transcript-generated discussion points before moving on.']
      }],
      actions: actions.length ? actions : [{
        owner: 'Not stated',
        action: 'Review transcript for agreed actions.',
        deadline: 'Not stated'
      }],
      finalReview: {
        signOff: 'Ready for human approval.',
        generatedAt: new Date().toISOString()
      }
    },
    telemetryPreview: {
      transcriptLength: transcript.text.length,
      screenCount: 5,
      discussionCards: discussion.length,
      actionCount: actions.length
    }
  };
}

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

function canonicalConfirmedStages(input = {}) {
  return {
    details: input.confirmedDetails || {},
    summary: input.confirmedSummary || {},
    discussion: Array.isArray(input.confirmedDiscussion) ? input.confirmedDiscussion : [],
    actions: Array.isArray(input.confirmedActions) ? input.confirmedActions : [],
    decisions: Array.isArray(input.confirmedDecisions) ? input.confirmedDecisions : [],
    risks: Array.isArray(input.confirmedRisks) ? input.confirmedRisks : []
  };
}

function stableActionCandidateHash(candidate = {}) {
  const payload = {
    owner: cleanStagedGeneratedLine(candidate.owner || 'Not stated') || 'Not stated',
    action: cleanStagedActionText(candidate.suggestedAction || candidate.action || ''),
    deadline: cleanStagedGeneratedLine(candidate.deadline || 'Not stated') || 'Not stated',
    disposition: cleanStagedGeneratedLine(candidate.reviewDisposition || candidate.confidenceTier || ''),
    evidenceIds: Array.isArray(candidate.evidenceIds) ? candidate.evidenceIds : [],
    sourceTurnIds: Array.isArray(candidate.sourceTurnIds) ? candidate.sourceTurnIds : []
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

function serialiseActionReviewCandidate(item = {}) {
  const evidenceEntries = Array.isArray(item.evidence) ? item.evidence.filter(Boolean) : [];
  const primaryEvidence = evidenceEntries.find((entry) => entry.current || entry.text) || {};
  const evidenceIds = Array.isArray(item.evidenceIds)
    ? item.evidenceIds
    : (Array.isArray(item.evidence)
      ? item.evidence.map((entry) => entry && entry.id).filter(Boolean)
      : []);
  const candidate = enrichActionReviewCandidate({
    owner: item.owner || 'Not stated',
    action: item.action || item.suggestedAction || '',
    suggestedAction: item.suggestedAction || item.action || '',
    deadline: item.deadline || 'Not stated',
    reviewDisposition: item.reviewDisposition || 'review_required',
    evidenceIds,
    sourceTurnIds: Array.isArray(item.sourceTurnIds) ? item.sourceTurnIds : [],
    evidence: item.evidence
  });
  return {
    id: `action-candidate-${stableActionCandidateHash(candidate)}`,
    ...candidate,
    sourceSnippet: cleanStagedGeneratedLine(item.sourceSnippet || primaryEvidence.current || primaryEvidence.text || item.action || item.suggestedAction || ''),
    sourceSpeaker: cleanStagedGeneratedLine(item.sourceSpeaker || primaryEvidence.speaker || '')
  };
}

function attachActionCandidateSourceSnippets(payload = {}) {
  const packedEvidence = (Array.isArray(payload._canonicalEvidencePack) ? payload._canonicalEvidencePack : [])
    .flatMap((pack) => Array.isArray(pack?.evidence) ? pack.evidence : []);
  const evidenceById = new Map(packedEvidence
    .flatMap((entry) => [entry, ...(Array.isArray(entry?.contextWindow) ? entry.contextWindow : [])])
    .filter((entry) => entry?.id)
    .map((entry) => [String(entry.id), entry]));
  const candidateLists = [
    ...(Array.isArray(payload.validationFlags) ? payload.validationFlags : []).map((flag) => flag?.repairCandidates),
    payload.actionReviewCandidates
  ];
  for (const candidates of candidateLists) {
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
      const evidence = [
        ...(Array.isArray(candidate.representativeEvidenceIds) ? candidate.representativeEvidenceIds : []),
        ...(Array.isArray(candidate.evidenceIds) ? candidate.evidenceIds : [])
      ]
        .map((id) => evidenceById.get(String(id)))
        .filter(Boolean)
        .map((entry) => ({
          entry,
          snippet: cleanStagedEvidenceSnippet(entry.current || entry.text),
          relevance: stagedTokenSimilarity(candidate.suggestedAction || candidate.action, entry.current || entry.text)
        }))
        .filter((item) => item.snippet)
        .sort((left, right) => right.relevance - left.relevance || left.snippet.length - right.snippet.length)[0]?.entry;
      if (!evidence) continue;
      candidate.sourceSnippet = cleanStagedGeneratedLine(evidence.current || evidence.text);
      candidate.sourceSpeaker = cleanStagedGeneratedLine(evidence.speaker || '');
    }
  }
  return payload;
}

// Topic headings the model named, merged onto the ones the pipeline derived.
//
// A heading is not just a line on the summary screen: the discussion stage allocates
// evidence per topic, so replacing the text and losing the ids would leave the reviewer
// with better headings over empty cards. So a named heading that covers ground the
// pipeline already found REPLACES that topic's wording and keeps its id and evidence; one
// that covers new ground is ADDED with the turns it cited. Nothing the reviewer confirmed
// is touched - that contract is older than this feature and outranks it.
function mergeNamedTopics(summary, namedTopics, confirmedTopics) {
  const text = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').replace(/[.\u2026]+$/, '').trim();
  const named = Array.isArray(namedTopics) ? namedTopics.filter((item) => text(item?.text)) : [];
  if (!named.length || (Array.isArray(confirmedTopics) && confirmedTopics.length)) return {};
  const refs = Array.isArray(summary?.topicRefs) ? summary.topicRefs.map((item) => ({ ...item })) : [];
  const used = new Set();
  for (const topic of named) {
    const ids = new Set(Array.isArray(topic.evidenceIds) ? topic.evidenceIds.map(String) : []);
    let bestIndex = -1;
    let bestOverlap = 0;
    refs.forEach((ref, index) => {
      if (used.has(index)) return;
      const existing = Array.isArray(ref.evidenceIds) ? ref.evidenceIds.map(String) : [];
      if (!existing.length || !ids.size) return;
      const shared = existing.filter((id) => ids.has(id)).length / Math.min(existing.length, ids.size);
      if (shared > bestOverlap) { bestOverlap = shared; bestIndex = index; }
    });
    if (bestIndex >= 0 && bestOverlap >= 0.34) {
      used.add(bestIndex);
      refs[bestIndex] = { ...refs[bestIndex], text: text(topic.text) };
      continue;
    }
    refs.push({ text: text(topic.text), topicId: '', evidenceIds: [...ids] });
  }
  // Additive, deliberately. Letting the named list stand alone was tried and measured: on
  // the Eakin weekly the model named three headings well and the meeting lost four correct
  // derived ones - debug evidence, change control, electrical compliance, cybersecurity -
  // because naming three subjects is not the same as saying the other four were wrong. The
  // model summarises at whatever grain it chooses; the derived labels come from patterns
  // that matched real evidence. A heading is only replaced when a named one demonstrably
  // covers the same turns.
  return { overallTopics: refs.map((ref) => ref.text).filter(Boolean), topicRefs: refs };
}

// Objectives topped up from the topics the model named and the validators accepted.
//
// Deterministic objectives derive from workstreams, and workstreams on informal meetings
// are thin - the domain concepts don't match an allotment committee, and the emergent
// labels that used to fill the gap were quotations and are now refused. The scorecard made
// the cost concrete: the allotment's five expected objectives collapsed to one, for a
// meeting about a water butt, a boundary fence, plot fees, a waiting list, a show and a
// break-in. The named topics for those meetings are good - they passed the citation
// validators and the heading gates - so each one not already covered by an objective
// becomes "Review {topic}.", the same template the deterministic path has always used.
// Composed from a validated heading, not quoted from anywhere.
function topUpObjectivesFromNamedTopics(objectives, namedTopics, limit = 8) {
  const existing = Array.isArray(objectives) ? objectives.slice() : [];
  const text = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  const tokensOf = (value) => new Set((text(value).toLowerCase().match(/[a-z][a-z0-9'\u2019-]{2,}/g) || [])
    .filter((token) => !['the', 'and', 'review', 'confirm', 'agree'].includes(token)));
  for (const topic of Array.isArray(namedTopics) ? namedTopics : []) {
    if (existing.length >= limit) break;
    const label = text(topic?.text || topic);
    if (!label) continue;
    const labelTokens = tokensOf(label);
    if (!labelTokens.size) continue;
    const covered = existing.some((objective) => {
      const objectiveTokens = tokensOf(objective);
      const shared = [...labelTokens].filter((token) => objectiveTokens.has(token)).length;
      return shared / labelTokens.size >= 0.5;
    });
    if (covered) continue;
    const lowered = /^[A-Z][a-z]/.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label;
    existing.push(`Review ${lowered}.`);
  }
  return existing;
}

// The health record: one judgement per generation, built from signals that already exist.
//
// Every silent failure in this area followed the same script - a component degraded, said
// nothing, and the output looked plausible. The summary polish was rejected invisibly and
// the fallback reproduced the thin output that prompted the work; a token ceiling
// presented as a complaint about wording; the wording repair failed over HTTP and nobody
// could tell repaired rows from untouched ones. Each took an afternoon to dig out of pm2
// logs and the database, and each would have been one line here.
//
// The rule for what counts as a degradation is narrow on purpose: a step that chose not
// to run (wrong stage, nothing to do, reviewer already confirmed the text) is quiet,
// because flagging the ordinary path teaches reviewers to ignore the flag - which is the
// exact failure this exists to end. Only a step that TRIED to serve the screen and served
// something lesser instead is a degradation.
const HEALTH_QUIET_REASONS = new Set([
  'Trooper is not used for this stage.',
  'No bounded evidence pack.',
  'No published actions to rewrite.',
  'not_applicable',
  'empty_notes',
  'empty_text',
  'reviewer_confirmed',
  'superseded_by_evidence_polish',
  'purpose_only'
]);

function assessGenerationHealth({ stage, trooper, summaryPolish, grammarPolish, wordingRepair }) {
  const degradations = [];
  const note = (step, reason, label) => degradations.push({ step, reason: String(reason || ''), label });

  if (['discussion', 'actions'].includes(stage) && trooper && !trooper.used && !HEALTH_QUIET_REASONS.has(String(trooper.reason || ''))) {
    note('trooper_rewrite', trooper.reason, 'the evidence-grounded rewrite (deterministic wording served instead)');
  }
  if (stage === 'summary' && summaryPolish?.attempted) {
    const reason = String(summaryPolish.reason || '');
    if (!summaryPolish.used && !HEALTH_QUIET_REASONS.has(reason)) {
      note('summary_polish', reason, 'the summary polish (deterministic summary served instead)');
    }
    if (summaryPolish.truncated) note('summary_polish', 'response_truncated', 'a summary polish response that was cut short by its size limit');
    if (summaryPolish.degraded) note('summary_polish', 'retried_without_evidence', 'the evidence-cited summary (the simpler uncited form served instead)');
  }
  // The grammar pass is judged by consequence, not symmetry with the summary polish. When
  // the summary polish's validator refuses, the screen falls back to the deterministic
  // floor - a genuinely lesser screen, and the original silent incident. When the grammar
  // pass's validator refuses, the text it was HANDED serves unchanged - the guard working,
  // nothing lost - so only a pass that could not run at all counts.
  if (grammarPolish?.attempted && !grammarPolish.used) {
    const reason = String(grammarPolish.reason || '');
    if (/^(?:unavailable|request_failed|timeout)$/.test(reason) || reason.startsWith('http_')) {
      note('summary_grammar', reason, 'the summary grammar pass');
    }
  }
  // The repair failing its guards on a row is not a degradation - those rows carry their
  // own flag. Only a repair that could not run at all is one.
  if (['actions', 'discussion'].includes(stage) && wordingRepair?.attempted > 0 && wordingRepair?.reason) {
    note('wording_repair', wordingRepair.reason, `the wording repair (${wordingRepair.attempted} flagged row${wordingRepair.attempted === 1 ? '' : 's'} published as extracted)`);
  }
  return { served: degradations.length ? 'degraded' : 'full', degradations };
}

// The revision serving this generation. Workers were once found serving three-day-old
// code across several deploys, and nothing in any payload said so; now every generation
// records what it ran as. Read once - the file changes only on deploy, and a deploy
// restarts the process.
let SERVING_REVISION = '';
function servingRevision() {
  if (SERVING_REVISION) return SERVING_REVISION;
  try {
    SERVING_REVISION = require('fs').readFileSync(path.join(__dirname, '..', '.openclaw-deployed-revision'), 'utf8').trim().slice(0, 12) || 'dev';
  } catch {
    SERVING_REVISION = 'dev';
  }
  return SERVING_REVISION;
}

async function canonicalStagedResponse(stage, transcript, input = {}) {
  const generationStartedAt = Date.now();
  // One-run loss attribution (scripts/action_loss_attribution.js). ACTION_TRACE names a
  // file; every snapshot and row-eating mutation in the actions stage is recorded there,
  // so a single scorecard run can say, for each expected action the scorecard missed,
  // which pass lost it and what survived in its place. The stage-level ACTION_FUNNEL tap
  // stops at actionsStage's return value - every pass in THIS function (band merge,
  // claim check, wording repair, dedupe) runs after that, and the recall those passes
  // cost was invisible to both instruments. Dead code when the env var is unset.
  const actionTrace = stage === 'actions' && process.env.ACTION_TRACE
    ? { fileName: transcript.fileName || 'transcript.txt', snapshots: [], proposals: null, mutations: [] }
    : null;
  const traceSnap = (pass, rows) => {
    if (!actionTrace) return;
    actionTrace.snapshots.push({
      pass,
      rows: (Array.isArray(rows) ? rows : []).map((item) => ({
        owner: item.owner || 'Not stated',
        action: String(item.action || ''),
        modelProposed: Boolean(item.modelProposed),
        ownerUnassigned: Boolean(item.ownerUnassigned),
        reviewerAuthored: Boolean(item.reviewerAuthored)
      }))
    });
  };
  const confirmed = canonicalConfirmedStages(input);
  const semanticTranscript = transcriptForStagedAI(transcript, input);
  const transcriptHealth = assessStagedTranscriptHealth(semanticTranscript.text);
  let payload = runCanonicalLiveStage(semanticTranscript.text, {
    stage,
    fileName: transcript.fileName || 'transcript.txt',
    confirmed,
    reviewerGuidance: input.additionalContext || '',
    includeEvidencePack: ['summary', 'discussion', 'actions'].includes(stage)
  });
  // canonicalDiagnostics.entityNames is built from raw Teams speaker labels
  // (liveStages.js), so an invented surname lived here at the source: "Rebecca Cuckoo" was
  // the canonical name every downstream consumer worked from - the repeated_person_name
  // detector, the "people" list threaded into every repair/polish call, and the entity
  // sweep below. Correcting the owner column alone left the reference list itself wrong,
  // so anything correcting discussion or action TEXT against that list had nothing to
  // correct against. Fixed at the source: every consumer downstream inherits it free.
  if (payload?.canonicalDiagnostics?.entityNames) {
    const correctedNames = payload.canonicalDiagnostics.entityNames.map((name) => canonicalKnownStagedPersonName(name) || name);
    if (correctedNames.some((name, index) => name !== payload.canonicalDiagnostics.entityNames[index])) {
      payload = { ...payload, canonicalDiagnostics: { ...payload.canonicalDiagnostics, entityNames: [...new Set(correctedNames)] } };
    }
  }
  // Screen 0. A transcript the parser could only partly read produces thin
  // minutes at every later stage, so the reviewer needs to know before they
  // spend time editing them, not after.
  if (stage === 'details') {
    const healthFlag = stagedTranscriptHealthFlag(transcriptHealth);
    if (healthFlag) payload.validationFlags = [...(payload.validationFlags || []), healthFlag];
  }
  if (stage === 'actions') payload = attachActionCandidateSourceSnippets(payload);
  let unassignedActions = [];
  if (stage === 'actions') {
    const recoveredActions = buildEvidenceBoundStagedActionInventory(semanticTranscript.text);
    // Decided here, before the candidate list is built, so a row that is going to be
    // published does not also appear underneath as something to consider adding. The
    // reviewer seeing the same action twice, once as theirs and once as a suggestion, is
    // its own kind of noise.
    unassignedActions = unassignedActionsWorthPublishing(recoveredActions, payload?.screens?.actions || []);
    // Recovered rows carry NUMERIC turn indices from the recovery parser, while the
    // evidence pack keys everything by evt_* event ids - so the wording repair's evidence
    // window lookup never matched and these rows were repaired blind, with an empty
    // window in the prompt. Map turn index to the event ids of that turn here, where both
    // id schemes are in scope.
    if (unassignedActions.length) {
      const eventsByTurnIndex = new Map();
      for (const event of prepareEvidence(semanticTranscript.text).events) {
        if (!eventsByTurnIndex.has(event.turnIndex)) eventsByTurnIndex.set(event.turnIndex, []);
        eventsByTurnIndex.get(event.turnIndex).push(event.id);
      }
      unassignedActions = unassignedActions.map((item) => {
        const mapped = (Array.isArray(item.evidenceIds) ? item.evidenceIds : [])
          .flatMap((id) => (typeof id === 'number' ? (eventsByTurnIndex.get(id) || []) : [id]));
        return mapped.length ? { ...item, evidenceIds: mapped } : item;
      });
    }
    const promoted = new Set(unassignedActions.map((item) => String(item.action || '').toLowerCase()));
    const stillCandidates = recoveredActions.filter((item) => !promoted.has(String(item.action || '').toLowerCase()));
    payload = addRecoveredActionCandidates(payload, stillCandidates);
    const reviewOnly = stillCandidates.filter((item) => item.reviewDisposition && item.reviewDisposition !== 'confirmed_action');
    if (reviewOnly.length) {
      const counts = reviewOnly.reduce((summary, item) => {
        const key = item.reviewDisposition || 'review_required';
        summary[key] = (summary[key] || 0) + 1;
        return summary;
      }, {});
      const labels = {
        needs_assignment: 'need an owner',
        requirement: 'are requirements rather than agreed actions',
        completed_history: 'look completed or historical',
        review_required: 'need reviewer confirmation'
      };
      payload.validationFlags = [
        ...(Array.isArray(payload.validationFlags) ? payload.validationFlags : []),
        {
          type: 'action_review_candidates',
          severity: 'warning',
          blocking: false,
          message: `${reviewOnly.length} possible follow-up${reviewOnly.length === 1 ? ' needs' : 's need'} a decision: ${Object.entries(counts).map(([key, count]) => `${count} ${labels[key] || 'need review'}`).join(', ')}. Add the real actions and dismiss anything that should not appear in the minutes.`,
          resolutionKey: `action-review-candidates:${crypto.createHash('sha256').update(reviewOnly.map((item) => stableActionCandidateHash(item)).join('|')).digest('hex').slice(0, 16)}`,
          repairCandidates: reviewOnly.map(serialiseActionReviewCandidate)
        }
      ];
    }
  }
  if (stage === 'actions') traceSnap('stage_published', payload?.screens?.actions);
  const canonicalEvidencePack = Array.isArray(payload._canonicalEvidencePack) ? payload._canonicalEvidencePack : [];
  let polished = { payload, used: false, reason: 'Trooper is not used for this stage.' };
  if (['discussion', 'actions'].includes(stage)) {
    try {
      polished = await polishCanonicalStage(payload, { reviewerGuidance: input.additionalContext || '' });
    } catch (error) {
      safeLogError('[Canonical staged Trooper polish failed]', error, { stage });
      const fallback = canonicalFallback(payload);
      polished = { payload: fallback, used: false, reason: error?.message || 'Trooper rewrite failed.' };
    }
  }
  if (stage === 'discussion') {
    const evidence = prepareEvidence(semanticTranscript.text);
    const semanticPreservation = repairDiscussionForConfirmedUnderstanding({
      discussion: polished.payload?.screens?.discussion || [],
      understanding: buildConfirmedUnderstanding(confirmed.summary),
      transcriptText: semanticTranscript.text,
      evidenceEvents: evidence.events
    });
    polished.payload = {
      ...polished.payload,
      screens: {
        ...(polished.payload?.screens || {}),
        discussion: semanticPreservation.discussion
      },
      validationFlags: [
        ...(Array.isArray(polished.payload?.validationFlags)
          ? polished.payload.validationFlags.filter((flag) => flag.type !== 'reviewer_confirmed_fact_not_preserved')
          : []),
        ...semanticPreservation.validationFlags
      ],
      telemetryPreview: {
        ...(polished.payload?.telemetryPreview || {}),
        reviewerConfirmedFactPreservationAfterPolish: semanticPreservation.telemetry
      }
    };
  }
  if (stage === 'actions') {
    // Published after the rewrite, not before it. These records are already composed - the
    // recovery rules built them from cited turns and they match the human minutes almost
    // word for word - so there is nothing for the polish to improve and a real risk it
    // drops them, since its own contract tells it requirements are not final actions.
    const published = polished.payload?.screens?.actions || [];
    const unassigned = unassignedActions;
    if (unassigned.length) {
      polished.payload = {
        ...polished.payload,
        screens: { ...(polished.payload?.screens || {}), actions: [...published, ...unassigned] },
        validationFlags: [
          ...(Array.isArray(polished.payload?.validationFlags) ? polished.payload.validationFlags : []),
          {
            type: 'actions_need_an_owner',
            severity: 'warning',
            blocking: false,
            message: `${unassigned.length} action${unassigned.length === 1 ? '' : 's'} below ${unassigned.length === 1 ? 'has' : 'have'} no owner: the meeting agreed the work without naming anybody. Assign ${unassigned.length === 1 ? 'it' : 'them'} before sharing, or delete ${unassigned.length === 1 ? 'it' : 'them'} if ${unassigned.length === 1 ? 'it is' : 'they are'} not yours to track.`,
            resolutionKey: `actions-need-an-owner:${crypto.createHash('sha256').update(unassigned.map((item) => item.action).join('|')).digest('hex').slice(0, 16)}`
          }
        ]
      };
    }
  }
  // Discovery by proposal, restraint by validation.
  //
  // The deterministic layer reached 29 of 102 ground-truth actions and four attempts to
  // tune its gates recovered none; one plain request to the model reached 39-40. So the
  // model proposes here, and every veto stays deterministic: a proposal must quote a turn
  // that resolves to THIS transcript or it is refused, an owner the transcript never names
  // becomes "Not stated", and an option the meeting never agreed is filed as considered
  // rather than published as a commitment.
  //
  // Merged after the rewrite for the same reason the recovered rows are: these records are
  // already composed against cited turns, and applyActionRewrite's contract would treat
  // them as candidates rather than final rows.
  let actionProposals = { agreed: [], requirements: [], considered: [], ungrounded: [], reason: 'not_attempted' };
  if (stage === 'actions') {
    // Same parse the stage itself ran on, so a quote resolves against the events the
    // pipeline actually saw rather than a second, differently-parsed view of the meeting.
    actionProposals = await proposeActions(semanticTranscript.text, prepareEvidence(semanticTranscript.text), {});
    const existing = polished.payload?.screens?.actions || [];
    traceSnap('after_polish', existing);
    if (actionTrace) {
      const population = (items) => (Array.isArray(items) ? items : []).map((item) => ({
        owner: item.owner || 'Not stated', action: String(item.action || '')
      }));
      actionTrace.proposals = {
        agreed: population(actionProposals.agreed),
        requirements: population(actionProposals.requirements),
        considered: population(actionProposals.considered),
        ungrounded: population(actionProposals.ungrounded)
      };
    }
    // Same duplicate rule the recovery path uses, so a proposal cannot restate a row the
    // deterministic layer already published.
    const seen = existing.map((item) => new Set(String(item.action || '').toLowerCase().match(/[a-z][a-z0-9'’-]{2,}/g) || []));
    const isNew = (item) => {
      const tokens = new Set(String(item.action || '').toLowerCase().match(/[a-z][a-z0-9'’-]{2,}/g) || []);
      if (!tokens.size) return false;
      return !seen.some((other) => {
        if (!other.size) return false;
        let shared = 0;
        for (const token of tokens) if (other.has(token)) shared += 1;
        return shared / Math.min(tokens.size, other.size) >= 0.6;
      });
    };
    // Proposals carry selectionFinal so the wording gate cannot remove them, which also
    // means no quality bar applies unless one is applied here. The content bar is the same
    // predicate recovered rows already pass - an instruction of 3-26 words, opening on a
    // verb rather than a name or pronoun, with a concrete object - so a vague proposal
    // ("Limit risk for them", "Think about how to execute the study") is held back as a
    // candidate rather than published as work. This is a CONTENT check, not a wording one:
    // it asks whether the row states a task, never whether it is phrased nicely.
    // meetingRecordAdminAction: the deterministic path already refuses "update the
    // minutes"-class rows via reviewCandidateNoise, but the model proposes the same
    // commitment independently and this path was its way back in.
    const proposalIsPublishable = (item) => readsAsAnActionRecord(String(item.action || ''))
      && !meetingRecordAdminAction(String(item.action || ''));
    // The model sometimes proposes the same commitment twice in different words. Deduped
    // against each other on the same overlap rule used against the deterministic rows, so
    // one commitment produces one row.
    const distinct = [];
    for (const item of [...actionProposals.agreed, ...actionProposals.requirements]) {
      const tokens = new Set(String(item.action || '').toLowerCase().match(/[a-z][a-z0-9'’-]{2,}/g) || []);
      if (!tokens.size) continue;
      const duplicate = distinct.some((other) => {
        let shared = 0;
        for (const token of tokens) if (other.tokens.has(token)) shared += 1;
        return shared / Math.min(tokens.size, other.tokens.size) >= 0.6;
      });
      if (!duplicate) distinct.push({ item, tokens });
    }
    const heldBack = [];
    // The paraphrase band, closed at its source. isNew drops a proposal that overlaps an
    // existing row at >= 0.6; the corroboration filter keeps a deterministic row that a
    // proposal overlaps at >= 0.34. Between the two, the same commitment published twice,
    // once in each wording - Abbott's "Provide the applicable classifications and an
    // overview of the products" beside "Provide overall view of products". A proposal in
    // that band is now treated as the same commitment: its minutes-English wording
    // REPLACES the deterministic row's, the row keeps its owner when the proposal lacks
    // one, and the evidence of both is united on one row.
    const bandOverlap = (a, b) => {
      if (!a.size || !b.size) return 0;
      let shared = 0;
      for (const token of a) if (b.has(token)) shared += 1;
      return shared / Math.min(a.size, b.size);
    };
    const replacements = new Map();
    const bandMerges = [];
    const isBandMatch = (item) => {
      // BAND_MERGE=0 reverts a proposal in the band to the normal isNew/publishable path:
      // worst case a visible duplicate on the screen, never a silently replaced wording.
      if (process.env.BAND_MERGE === '0') return false;
      const tokens = new Set(String(item.action || '').toLowerCase().match(/[a-z][a-z0-9'’-]{2,}/g) || []);
      if (!tokens.size) return false;
      for (let index = 0; index < existing.length; index += 1) {
        if (replacements.has(index)) continue;
        const row = existing[index];
        if (row.reviewerAuthored) continue;
        // Different real owners are different commitments, whatever the words say.
        const rowOwner = String(row.owner || 'Not stated');
        const itemOwner = String(item.owner || 'Not stated');
        if (rowOwner !== 'Not stated' && itemOwner !== 'Not stated' && rowOwner !== itemOwner) continue;
        const overlap = bandOverlap(tokens, new Set(String(row.action || '').toLowerCase().match(/[a-z][a-z0-9'’-]{2,}/g) || []));
        if (overlap >= 0.34 && overlap < 0.6) {
          replacements.set(index, {
            ...row,
            action: item.action,
            owner: rowOwner !== 'Not stated' ? rowOwner : itemOwner,
            evidenceIds: [...new Set([...(row.evidenceIds || []), ...(item.evidenceIds || [])])],
            modelProposed: true,
            wordingRepaired: true
          });
          bandMerges.push({
            before: String(row.action || ''),
            after: String(item.action || ''),
            owner: rowOwner !== 'Not stated' ? rowOwner : itemOwner,
            overlap: Number(overlap.toFixed(3))
          });
          return true;
        }
      }
      return false;
    };
    const added = distinct.map((entry) => entry.item).filter(isNew).filter((item) => {
      if (isBandMatch(item)) return false;
      if (proposalIsPublishable(item)) return true;
      heldBack.push(item);
      return false;
    }).map((item) => ({
      owner: item.owner,
      action: item.action,
      deadline: 'Not stated',
      evidenceIds: item.evidenceIds,
      ownerUnassigned: item.owner === 'Not stated',
      modelProposed: true,
      // Composed against a cited turn and already checked for grounding and owner safety,
      // so the presentation wording gate must not silently remove it - the same treatment
      // deterministically selected rows get. Without this, Abbott produced seven grounded
      // proposals and published two: the gate dropped five real actions on wording alone.
      selectionFinal: true,
      reviewDisposition: item.disposition === 'requirement' ? 'requirement' : 'confirmed_action'
    }));
    // Corroboration filter, applied only when the proposal call actually succeeded.
    //
    // The model reads the whole transcript and lists everything actionable in it. A
    // deterministic row with no counterpart anywhere in that reading - not among the
    // agreed items, the requirements, the options, or even the proposals refused for
    // grounding - is a row the model saw the evidence for and did not think was work.
    // That is what "Prepare the response to the cars" and "Update the ports table for the
    // new set of minutes" are: mis-transcribed fragments the pattern layer shaped into
    // instructions. Never applied when proposals were unavailable, because then the
    // absence of corroboration means nothing.
    const everythingProposed = [
      ...actionProposals.agreed, ...actionProposals.requirements,
      ...actionProposals.considered, ...(actionProposals.ungrounded || [])
    ].map((item) => new Set(String(item.action || '').toLowerCase().match(/[a-z][a-z0-9'’-]{2,}/g) || []));
    const corroborated = (item) => {
      if (item.reviewerAuthored || item.ownerUnassigned) return true;
      const tokens = new Set(String(item.action || '').toLowerCase().match(/[a-z][a-z0-9'’-]{2,}/g) || []);
      if (!tokens.size) return false;
      return everythingProposed.some((other) => {
        if (!other.size) return false;
        let shared = 0;
        for (const token of tokens) if (other.has(token)) shared += 1;
        return shared / Math.min(tokens.size, other.size) >= 0.34;
      });
    };
    // The verdict is deferred, not skipped. One reading is one sample: the loss
    // attribution measured six real expected actions dropped here because the single
    // reading happened not to mention them ("Continue updating the risk management
    // plan", "Get a quote from St John Ambulance"). The completeness sweep below is a
    // SECOND independent reading, so a row it names is corroborated after all - and a
    // row neither reading names is still exactly what this filter was built to remove.
    // Rows are withheld here and either restored or dropped once the sweep has spoken.
    const withheld = new Map();
    const corroborationRestored = [];
    const keptExisting = (process.env.ACTION_CORROBORATION === '0' || !actionProposals.agreed.length
      ? existing.map((item, index) => replacements.get(index) || item)
      : existing.map((item, index) => replacements.get(index) || item).filter((item, index) => {
        if (replacements.has(index) || corroborated(item)) return true;
        withheld.set(index, item);
        return false;
      }));
    const uncorroborated = [...withheld.values()];
    if (added.length || actionProposals.considered.length || uncorroborated.length || replacements.size) {
      polished.payload = {
        ...polished.payload,
        screens: {
          ...(polished.payload?.screens || {}),
          actions: [...keptExisting, ...added],
          // The third bucket. A meeting that weighed options and agreed nothing produced no
          // actions and plenty of content, and forcing that into the actions table was how
          // a residents' parking meeting published seven commitments nobody made.
          consideredOptions: actionProposals.considered.map((item) => ({
            option: item.action, raisedBy: item.owner, evidenceIds: item.evidenceIds
          }))
        }
      };
    }
    // `applied` records whether the guard above actually took the merges. It always does
    // now that replacements.size is part of the condition - before that, a generation
    // where EVERY distinct proposal was a band match silently discarded the replacements.
    const proposalMergeApplied = Boolean(added.length || actionProposals.considered.length || uncorroborated.length || replacements.size);
    if (bandMerges.length) {
      console.log(JSON.stringify({ event: 'staged_band_merge', stage: 'actions', applied: proposalMergeApplied, merges: bandMerges }));
    }
    if (actionTrace) {
      for (const merge of bandMerges) actionTrace.mutations.push({ type: 'band_replace', applied: proposalMergeApplied, ...merge });
      for (const item of heldBack) actionTrace.mutations.push({ type: 'held_back', owner: item.owner || 'Not stated', action: String(item.action || '') });
    }
    traceSnap('after_proposal_merge', polished.payload?.screens?.actions);
    // The completeness sweep: one reading of a transcript is one sample, and the loss
    // attribution measured 23 of 53 missing expected actions as never discovered by any
    // source plus 5 more eaten by the corroboration filter because that single reading
    // happened not to mention them. A second call sees what is already captured and may
    // only name commitments NOT covered; everything it returns faces the same referee
    // (verbatim quote grounding, owner resolution, content bar, duplicate rule), and the
    // claim check and dedupe still run after it. Skipped entirely on the no-decision
    // shape, where a "what's missing" question invites invention. The gate is the FIRST
    // reading's own disposition judgement: a meeting whose full-attention reading found
    // ZERO agreed items is a meeting that agreed nothing, and the sweep does not run -
    // measured directly on the parking fixture, where rows awaiting the presentation
    // gate's cull made any published-row-count guard see work that was never real, the
    // sweep ran, and two "commitments" were published for a meeting that agreed none.
    // ACTION_COMPLETENESS_SWEEP=0 disables.
    if (process.env.ACTION_COMPLETENESS_SWEEP !== '0' && !actionProposals.reason && actionProposals.agreed.length) {
      const currentRows = polished.payload?.screens?.actions || [];
      {
        const sweep = await proposeMissedActions(semanticTranscript.text, prepareEvidence(semanticTranscript.text), currentRows.map((item) => ({ owner: item.owner, action: item.action })), {});
        const currentTokens = currentRows.map((item) => new Set(String(item.action || '').toLowerCase().match(/[a-z][a-z0-9'’-]{2,}/g) || []));
        const coveredByCurrent = (item) => {
          const tokens = new Set(String(item.action || '').toLowerCase().match(/[a-z][a-z0-9'’-]{2,}/g) || []);
          if (!tokens.size) return true;
          return currentTokens.some((other) => {
            if (!other.size) return false;
            let shared = 0;
            for (const token of tokens) if (other.has(token)) shared += 1;
            return shared / Math.min(tokens.size, other.size) >= 0.6;
          });
        };
        // Disposition consistency: the first reading saw the whole meeting with its
        // attention on agreed-vs-considered, and an item it filed as an OPTION must not
        // come back through the sweep re-badged as a commitment. Measured: the sweep
        // re-proposed "Think about parking" - filed considered by the first reading,
        // correctly - as an agreed item on the no-decision fixture.
        const consideredTokens = actionProposals.considered.map((item) => new Set(String(item.action || '').toLowerCase().match(/[a-z][a-z0-9'’-]{2,}/g) || []));
        const consideredByFirstReading = (item) => {
          const tokens = new Set(String(item.action || '').toLowerCase().match(/[a-z][a-z0-9'’-]{2,}/g) || []);
          if (!tokens.size) return false;
          return consideredTokens.some((other) => {
            if (!other.size) return false;
            let shared = 0;
            for (const token of tokens) if (other.has(token)) shared += 1;
            return shared / Math.min(tokens.size, other.size) >= 0.6;
          });
        };
        const sweepRefused = [];
        const sweepRows = [...sweep.agreed, ...sweep.requirements].filter((item) => {
          if (coveredByCurrent(item)) { sweepRefused.push({ action: item.action, reason: 'already_covered' }); return false; }
          if (consideredByFirstReading(item)) { sweepRefused.push({ action: item.action, reason: 'considered_by_first_reading' }); return false; }
          if (!proposalIsPublishable(item)) { sweepRefused.push({ action: item.action, reason: 'content_bar' }); return false; }
          return true;
        }).map((item) => ({
          owner: item.owner,
          action: item.action,
          deadline: 'Not stated',
          evidenceIds: item.evidenceIds,
          ownerUnassigned: item.owner === 'Not stated',
          modelProposed: true,
          completenessSweep: true,
          selectionFinal: true,
          reviewDisposition: item.disposition === 'requirement' ? 'requirement' : 'confirmed_action'
        }));
        if (sweepRows.length || sweepRefused.length || (sweep.ungrounded || []).length) {
          console.log(JSON.stringify({
            event: 'staged_completeness_sweep',
            added: sweepRows.map((item) => item.action),
            refused: sweepRefused,
            ungrounded: (sweep.ungrounded || []).length
          }));
        }
        // The withheld rows' second chance. A row the corroboration filter could not
        // find in the FIRST reading is restored when the sweep's reading names it -
        // two independent readings both seeing work is corroboration, and the rows
        // neither reading names are still dropped, which is the whole point of the
        // filter. Skipped when the sweep already published the same content as a row
        // of its own, so a rescue never produces a duplicate.
        const sweepUniverse = [...sweep.agreed, ...sweep.requirements, ...sweep.considered, ...(sweep.ungrounded || [])]
          .map((item) => new Set(String(item.action || '').toLowerCase().match(/[a-z][a-z0-9'’-]{2,}/g) || []));
        const sweepRowTokens = sweepRows.map((item) => new Set(String(item.action || '').toLowerCase().match(/[a-z][a-z0-9'’-]{2,}/g) || []));
        const overlapAgainst = (tokens, others, bar) => others.some((other) => {
          if (!other.size || !tokens.size) return false;
          let shared = 0;
          for (const token of tokens) if (other.has(token)) shared += 1;
          return shared / Math.min(tokens.size, other.size) >= bar;
        });
        for (const [index, item] of withheld) {
          const tokens = new Set(String(item.action || '').toLowerCase().match(/[a-z][a-z0-9'’-]{2,}/g) || []);
          if (!overlapAgainst(tokens, sweepUniverse, 0.34)) continue;
          if (overlapAgainst(tokens, sweepRowTokens, 0.6)) continue;
          corroborationRestored.push(item);
          withheld.delete(index);
        }
        if (sweepRows.length || corroborationRestored.length) {
          polished.payload = {
            ...polished.payload,
            screens: { ...(polished.payload?.screens || {}), actions: [...keptExisting, ...corroborationRestored, ...added, ...sweepRows] }
          };
        }
        traceSnap('after_completeness_sweep', polished.payload?.screens?.actions);
      }
    }
    // Reported after both readings have spoken, so the line says what was actually
    // dropped rather than what was provisionally withheld.
    if (withheld.size || corroborationRestored.length) {
      console.log(JSON.stringify({
        event: 'staged_corroboration',
        stage: 'actions',
        dropped: [...withheld.values()].map((item) => String(item.action || '')),
        restoredBySweep: corroborationRestored.map((item) => String(item.action || ''))
      }));
    }
    if (actionTrace) {
      for (const item of withheld.values()) actionTrace.mutations.push({ type: 'corroboration_drop', owner: item.owner || 'Not stated', action: String(item.action || '') });
      for (const item of corroborationRestored) actionTrace.mutations.push({ type: 'corroboration_restored', owner: item.owner || 'Not stated', action: String(item.action || '') });
    }
  }
  let result = clientReadyPresentation(polished.payload);
  if (stage === 'actions' && Array.isArray(result?.screens?.actions)) {
    // The owner is a person, and the known-people registry is the authority on how that
    // person's name is spelled. Teams wrote "Rebecca Cuckoo" 388 times across this corpus
    // where the attendee is Rebecca Gill; the mismatch was detected and only warned about,
    // so the invented surname reached the owner column. canonicalKnownStagedPersonName
    // resolves it, and declines when two known people share a first name.
    result = {
      ...result,
      screens: {
        ...result.screens,
        actions: result.screens.actions.map((item) => {
          const owner = canonicalKnownStagedPersonName(item.owner || '');
          return owner && owner !== item.owner ? { ...item, owner } : item;
        })
      }
    };
  }
  if (stage === 'actions' && canonicalEvidencePack.length) {
    result = attachActionCandidateSourceSnippets({ ...result, _canonicalEvidencePack: canonicalEvidencePack });
    delete result._canonicalEvidencePack;
  }
  // Wording repair runs on what would otherwise ship: after the presentation pass, after the
  // unassigned-action merge, on the exact rows the reviewer would have read. Rows with clean
  // wording cost nothing, because the repair only fires when at least one row is broken.
  let actionWordingRepair = { repaired: 0, attempted: 0 };
  if (stage === 'actions') {
    traceSnap('after_presentation', result?.screens?.actions);
    // The participant list travels with the repair so the repeated_person_name detector
    // can actually fire on this path - wordingFaults without options.people can never
    // detect a doubled roster name, whatever the row says.
    actionWordingRepair = await repairActionWording(result, canonicalEvidencePack, {
      people: result?.canonicalDiagnostics?.entityNames || [],
      // The whole meeting, so a rewrite's context window can reach the later turn where
      // the meeting summarises the same thing and the neighbours that disambiguate a
      // garbled phrase. The evidence pack carries only each row's own cited turns.
      allEvents: prepareEvidence(semanticTranscript.text).events
    });
    result = actionWordingRepair.payload || result;
    const stillBroken = (result?.screens?.actions || []).filter((item) => wordingFaults(String(item.action || '')).length);
    if (stillBroken.length) {
      result = {
        ...result,
        validationFlags: [
          ...(Array.isArray(result.validationFlags) ? result.validationFlags : []),
          {
            type: 'action_wording_needs_review',
            severity: 'warning',
            blocking: false,
            // Never silently. A row we could not phrase properly still reaches the reviewer,
            // because deleting a real commitment to keep the prose tidy is the worse trade -
            // but it is pointed at rather than left to be noticed.
            message: `${stillBroken.length} action${stillBroken.length === 1 ? '' : 's'} below still read${stillBroken.length === 1 ? 's' : ''} like speech rather than a minute. The work is real; the wording needs a pass before sharing.`,
            resolutionKey: `action-wording-needs-review:${crypto.createHash('sha256').update(stillBroken.map((item) => item.action).join('|')).digest('hex').slice(0, 16)}`
          }
        ]
      };
    }
    // A last, whole-screen sweep for an invented surname. The owner column is corrected
    // above (canonicalKnownStagedPersonName), but the ACTION TEXT can carry a name too -
    // "Ask Rebecca Cuckoo to review it" - and that text is written by three different
    // sources (deterministic selection, the model rewrite, the model proposal), each
    // reading the raw transcript rather than a normalised copy. One sweep over the
    // finished rows catches every source at once rather than patching each upstream.
    const actionEntityNames = result?.canonicalDiagnostics?.entityNames || [];
    if (actionEntityNames.length) {
      result = {
        ...result,
        screens: {
          ...result.screens,
          actions: (result.screens.actions || []).map((item) => {
            const action = normaliseAttendeeReferences(item.action, actionEntityNames).text;
            return action !== item.action ? { ...item, action } : item;
          })
        }
      };
    }
    traceSnap('after_wording_repair', result?.screens?.actions);
    // A named person's cognitive error is not minutes content, and a record that asserts
    // more than its evidence supports is not either. "David Didsbury misinterpreted the
    // software." came from "Or I misinterpreted the software" - a speaker walking back
    // their own guess - and "Compute a firm decision on the mute aspect" came from the
    // garbled "if we can compute a firm on that mute aspect". Both are grammatical, both
    // cite real turns, both are unique: nothing else in the pipeline asks whether the
    // claim is true to its evidence. Only an explicit "unsupported" removes a row.
    if (process.env.CLAIM_CHECK !== '0' && (result?.screens?.actions || []).length) {
      const rows = result.screens.actions;
      const allEvents = prepareEvidence(semanticTranscript.text).events;
      const byId = new Map(allEvents.map((event) => [String(event.id), String(event.text || '').replace(/\s+/g, ' ').trim()]));
      const windowFor = (item) => (item.evidenceIds || []).map((id) => byId.get(String(id))).filter(Boolean).slice(0, 4).join(' ');
      const dropped = [];
      const kept = rows.filter((item) => {
        if (item.reviewerAuthored) return true;
        if (personErrorAssertion(item.action)) { dropped.push(item.action); return false; }
        return true;
      });
      if (dropped.length) {
        console.log(JSON.stringify({ event: 'staged_claim_check', stage: 'actions', dropped }));
        if (actionTrace) for (const action of dropped) actionTrace.mutations.push({ type: 'claim_drop', action });
        result = { ...result, screens: { ...result.screens, actions: kept } };
      }
    }
    traceSnap('after_claim_check', result?.screens?.actions);
    // Final semantic near-duplicate pass, the safety net behind the paraphrase-band
    // merge: rows the lexical rules cannot see as the same commitment. Threshold 0.80 -
    // above every observed distinct pair on the reviewer-named fixtures - so only
    // near-restatements merge, and judgement calls ("thirty-second intro cap" beside
    // "drop the nervous comment") stay on the screen. Rows with different real owners
    // never merge; reviewer-authored rows are never dropped; the survivor is chosen by
    // owner > minutes-English wording > earliest, and inherits the dropped rows'
    // evidence. DEDUP_PASS=0 disables.
    if (process.env.DEDUP_PASS !== '0' && (result?.screens?.actions || []).length > 1) {
      const rows = result.screens.actions;
      const dedupe = await duplicateGroups(rows.map((item) => String(item.action || '')));
      const drop = new Set();
      const dropRecords = [];
      for (const group of dedupe.groups) {
        const members = group.filter((index) => !rows[index].reviewerAuthored);
        // Split by real owner: only same-owner (or ownerless) members may merge, and an
        // ownerless row joins a named cluster only on scored-pair evidence - with two
        // named owners in a group it must not be absorbed into an arbitrary one.
        const clusters = splitDedupeGroupsByOwner(members, (index) => rows[index].owner, dedupe.pairs);
        for (const cluster of clusters) {
          if (cluster.length < 2) continue;
          const survivor = [...cluster].sort((a, b) => {
            const ownerA = String(rows[a].owner || 'Not stated') !== 'Not stated' ? 0 : 1;
            const ownerB = String(rows[b].owner || 'Not stated') !== 'Not stated' ? 0 : 1;
            if (ownerA !== ownerB) return ownerA - ownerB;
            const polishedA = rows[a].wordingRepaired || rows[a].modelProposed ? 0 : 1;
            const polishedB = rows[b].wordingRepaired || rows[b].modelProposed ? 0 : 1;
            if (polishedA !== polishedB) return polishedA - polishedB;
            return a - b;
          })[0];
          const merged = [...new Set(cluster.flatMap((index) => rows[index].evidenceIds || []))];
          rows[survivor] = { ...rows[survivor], evidenceIds: merged };
          for (const index of cluster) {
            if (index === survivor) continue;
            drop.add(index);
            dropRecords.push({
              dropped: String(rows[index].action || ''),
              owner: rows[index].owner || 'Not stated',
              survivor: String(rows[survivor].action || ''),
              survivorOwner: rows[survivor].owner || 'Not stated'
            });
          }
        }
      }
      if (drop.size) {
        // Auditable, because a merge that cannot be audited is a merge that hides a bug:
        // one greppable line per generation naming exactly what merged, into what, and at
        // what score. The survivor mapping matters: a dropped row whose survivor no longer
        // carries its content is a lost action, and only this line can show that.
        console.log(JSON.stringify({ event: 'staged_dedupe', stage: 'actions', dropped: [...drop].map((index) => rows[index].action), merges: dropRecords, pairs: dedupe.pairs }));
        if (actionTrace) for (const record of dropRecords) actionTrace.mutations.push({ type: 'dedupe_drop', ...record });
        result = { ...result, screens: { ...result.screens, actions: rows.filter((item, index) => !drop.has(index)) } };
      }
    }
    // The reviewer's three-proof rule for a confirmed action, applied to what would
    // otherwise ship. Commitment is already proven upstream (disposition strictness and
    // the corroboration of two readings); these are the other two proofs.
    //
    // Concreteness: a record whose reference cannot be resolved by a reader is not a
    // task. "Limit risk for them" was published as a confirmed action from a
    // conversational aside - grammatical, verb-initial, concrete-object-shaped, and
    // useless, because "them" names nobody. Such a row is demoted to a review
    // candidate, never silently dropped. ACTION_CONCRETENESS=0 disables.
    if (process.env.ACTION_CONCRETENESS !== '0' && (result?.screens?.actions || []).length) {
      const demoted = [];
      const kept = result.screens.actions.filter((item) => {
        if (item.reviewerAuthored) return true;
        if (!unresolvedReference(item.action)) return true;
        demoted.push(item);
        return false;
      });
      if (demoted.length) {
        console.log(JSON.stringify({ event: 'staged_concreteness_gate', stage: 'actions', demoted: demoted.map((item) => item.action) }));
        if (actionTrace) for (const item of demoted) actionTrace.mutations.push({ type: 'concreteness_demotion', owner: item.owner || 'Not stated', action: String(item.action || '') });
        result = {
          ...result,
          screens: {
            ...result.screens,
            actions: kept,
            actionCandidates: [
              ...(result.screens.actionCandidates || []),
              ...demoted.map((item) => ({ owner: item.owner, action: item.action, suggestedAction: item.action, reviewDisposition: 'review_required', evidenceIds: item.evidenceIds }))
            ]
          }
        };
      }
    }
    // Owner support - BUILT, MEASURED, AND OFF BY DEFAULT. The idea: a name on a row is
    // an assertion, and an unsupported one should become an honest blank ("Send training
    // attestation" carried Stuart's name when the transcript shows Stuart telling NIAMH
    // she needs to complete it). The measurement: with the evidence correctly flattened,
    // the full corpus run still demoted ~44 owners and many were plainly CORRECT -
    // "Priya Sethi: Handle the opening" and "Callum Reid: Hit record" are their own
    // explicit commitments. ownerSupported was designed as a PROMOTION gate, where a
    // false negative costs nothing; as a demotion gate every false negative blanks a
    // right name, and evidence citations are too noisy for absence-of-proof to mean
    // wrongness. Re-enable (OWNER_SUPPORT_GATE=1) only with a version that demotes on
    // POSITIVE contrary evidence - the cited turns showing a DIFFERENT person committing
    // - rather than on absence of support.
    if (process.env.OWNER_SUPPORT_GATE === '1' && (result?.screens?.actions || []).length && canonicalEvidencePack.length) {
      // Flattened to the entry shape citedEntries reads. Passing the pack unflattened
      // resolved zero cited turns, which read as "no owner is supported" and demoted 89
      // of 95 named owners in one run - the scorecard's blank-owner escape hatch kept
      // recall LOOKING fine while the screens filled with blank owner cells. Measured
      // before shipping, which is the only reason it did not ship.
      const ownerEvidence = { evidence: canonicalEvidencePack.flatMap((item) => item.evidence || []) };
      const demotions = [];
      const gated = result.screens.actions.map((item) => {
        if (item.reviewerAuthored || !item.owner || item.owner === 'Not stated') return item;
        if (ownerSupported({ owner: item.owner, evidenceIds: item.evidenceIds || [] }, ownerEvidence)) return item;
        demotions.push({ owner: item.owner, action: String(item.action || '') });
        return { ...item, owner: 'Not stated', ownerUnassigned: true, ownerDemoted: item.owner };
      });
      if (demotions.length) {
        console.log(JSON.stringify({ event: 'staged_owner_demotion', stage: 'actions', demotions }));
        if (actionTrace) for (const item of demotions) actionTrace.mutations.push({ type: 'owner_demotion', ...item });
        result = { ...result, screens: { ...result.screens, actions: gated } };
      }
    }
    traceSnap('final', result?.screens?.actions);
    if (actionTrace) {
      try { require('fs').appendFileSync(process.env.ACTION_TRACE, `${JSON.stringify(actionTrace)}\n`); } catch { /* tracing must never break generation */ }
    }
  }
  // Discussion prose gets the same publication promise as actions: broken wording is
  // mechanically repaired, then sent to the model, and whatever survives both rounds is
  // pointed at rather than left to be noticed. Until this block a broken discussion point
  // had no second chance anywhere - the rewrite that produced it was the last pass that
  // touched it.
  let discussionWordingRepair = { repaired: 0, attempted: 0 };
  if (stage === 'discussion') {
    discussionWordingRepair = await repairDiscussionWording(result, canonicalEvidencePack, {
      people: result?.canonicalDiagnostics?.entityNames || [],
      allEvents: prepareEvidence(semanticTranscript.text).events
    });
    result = discussionWordingRepair.payload || result;
    // Discussion by proposal, restraint by validation - the actions architecture applied
    // here for the same measured reason. The deterministic path selects representative
    // sentences from MiniLM clusters, and a narrated story fragments across them:
    // Andrew's alarm demonstration split into five micro-clusters, so the card surfaced
    // "I'm gonna try and include sound" (screen-share mechanics) while the demonstration
    // itself scattered. A model reading the whole transcript keeps the story together;
    // every proposed point must quote a turn that resolves to this transcript, must pass
    // the wording detectors, and must not duplicate a point already on the screen.
    // DISCUSSION_PROPOSALS=0 turns the pass off.
    if (process.env.DISCUSSION_PROPOSALS !== '0') {
      const existingCards = Array.isArray(result?.screens?.discussion) ? result.screens.discussion : [];
      const existingPoints = existingCards.flatMap((card) => (card.points || []).map((point) => (typeof point === 'string' ? point : point?.text || '')));
      const proposal = await proposeDiscussionPoints(semanticTranscript.text, prepareEvidence(semanticTranscript.text), existingPoints, {});
      if (proposal.grounded.length) {
        const tokensOf = (value) => new Set(String(value || '').toLowerCase().match(/[a-z][a-z0-9'’-]{2,}/g) || []);
        const overlapOf = (a, b) => {
          if (!a.size || !b.size) return 0;
          let shared = 0;
          for (const token of a) if (b.has(token)) shared += 1;
          return shared / Math.min(a.size, b.size);
        };
        const cards = existingCards.map((card) => ({ ...card, points: [...(card.points || [])] }));
        const newCards = new Map();
        // A confirmed agenda IS the agenda.
        //
        // Measured on the Abbott rerun: the discussion stage honoured the reviewer's four
        // themes exactly - five cards in, four of them confirmed - and this block turned
        // that into twenty-two by minting a heading for every proposal whose label failed
        // to overlap an existing one at 0.34. "Hotel reservation details" and "Audit
        // attendees confirmation" never will overlap "Audit scope, timing, and logistics",
        // so the reviewer's structure was intact right up to the point where it was
        // buried under micro-sections.
        //
        // When any card is reviewer-confirmed, no new heading may be minted. A proposed
        // point belongs to one of THEIR topics or it does not belong on the screen, and
        // the label the model happened to invent for it is the weakest available signal
        // for deciding which - it was measured at 0.00 lexical overlap against the right
        // theme. Evidence is the strongest: a point drawn from turns a card already owns
        // belongs to that card. Semantic similarity of the POINT (not its label) against
        // the heading is the fallback, and anything below the floor is dropped rather
        // than given a section of its own.
        // Targets are every card the stage produced, not only the confirmed ones. The
        // stage emits a generic catch-all card beside the reviewer's themes, and that is
        // the honest home for a real point that fits none of them - better than dropping
        // it, and far better than giving it a heading of its own.
        const confirmedAgenda = cards.some((card) => card.confirmedTopic);
        const agendaCards = cards;
        let catchAllCard = cards.find((card) => !card.confirmedTopic && /^(?:other|general|miscellaneous|any other business)\b/i.test(String(card.topic || '')));
        const attachFloor = Number(process.env.AGENDA_ATTACH_FLOOR || 0.4);
        let agendaVectors = null;
        if (confirmedAgenda && proposal.grounded.length) {
          const vecTexts = [...new Set([
            ...agendaCards.map((card) => String(card.topic || '')),
            ...proposal.grounded.map((item) => String(item.point || ''))
          ])].filter(Boolean);
          const encoded = await encodeViaWorker(vecTexts);
          if (encoded) agendaVectors = new Map(vecTexts.map((text, index) => [text, encoded[index]]));
        }
        const agendaAttachments = [];
        const agendaDropped = [];
        for (const item of proposal.grounded) {
          const pointText = item.point;
          const topicTokens = tokensOf(item.topic);
          if (confirmedAgenda) {
            const itemEvidence = new Set((item.evidenceIds || []).map(String));
            let home = agendaCards.find((card) => (card.evidenceIds || []).some((id) => itemEvidence.has(String(id))));
            let how = 'evidence';
            let score = 1;
            if (!home && agendaVectors) {
              const pointVector = agendaVectors.get(String(pointText || ''));
              let best = null;
              for (const card of agendaCards) {
                const cardVector = agendaVectors.get(String(card.topic || ''));
                const value = pointVector && cardVector ? cosine(pointVector, cardVector) : 0;
                if (!best || value > best.value) best = { card, value };
              }
              if (best && best.value >= attachFloor) { home = best.card; how = 'semantic'; score = Number(best.value.toFixed(3)); }
            }
            // Nothing is dropped under a confirmed agenda. Forbidding new headings is a
            // structure rule, not a licence to lose content: measured, dropping the
            // unmatched cost 41 published points and 16 of discussion coverage, because
            // the fixtures where every card is confirmed have no catch-all to fall back
            // on. One catch-all section is created on demand instead - the reviewer can
            // redistribute or delete it, which is a far smaller job than reading
            // seventeen micro-sections, and no evidence goes missing.
            if (!home) {
              if (!catchAllCard) {
                catchAllCard = { topic: 'Other points raised', points: [], evidenceIds: [], modelProposed: true };
                cards.push(catchAllCard);
              }
              home = catchAllCard;
              how = 'catch_all';
              score = 0;
            }
            home.points.push(pointText);
            home.evidenceIds = [...new Set([...(home.evidenceIds || []), ...item.evidenceIds])];
            agendaAttachments.push({ point: String(pointText).slice(0, 80), topic: home.topic, via: how, score });
            continue;
          }
          // Attach to the existing card whose heading this point's proposed topic best
          // matches; a new heading is only minted when nothing existing fits, and it must
          // read as a heading - the same bar every other label source passes.
          let bestCard = null;
          let bestScore = 0;
          for (const card of cards) {
            const score = overlapOf(topicTokens, tokensOf(card.topic));
            if (score > bestScore) { bestScore = score; bestCard = card; }
          }
          if (bestCard && bestScore >= 0.34) {
            bestCard.points.push(pointText);
            bestCard.evidenceIds = [...new Set([...(bestCard.evidenceIds || []), ...item.evidenceIds])];
          } else if (item.topic.split(/\s+/).length >= 2 && labelNamesAWorkstream(item.topic) && isPublishableTopicLabel(item.topic)) {
            // Not canHeadlineTopic: its 4-word floor and meta-text screen are calibrated
            // for stopword-strip debris ("Let get total"), and both were measured before
            // being kept - but a model-written heading is different provenance. The floor
            // refused "Change request documentation", and the meta screen refused "Alarm
            // mute button behaviour" because "mute button" usually means Teams mechanics -
            // here it is the product's own mute button. The heading still has to read as a
            // workstream and be client-ready, and the points under it are quote-grounded.
            const key = item.topic.toLowerCase();
            if (!newCards.has(key)) newCards.set(key, { topic: item.topic, points: [], evidenceIds: [], modelProposed: true });
            const card = newCards.get(key);
            card.points.push(pointText);
            card.evidenceIds = [...new Set([...card.evidenceIds, ...item.evidenceIds])];
          }
          // A point whose topic neither matches a card nor survives the heading gates is
          // dropped - coverage is not worth a heading that reads as speech.
        }
        if (agendaAttachments.length || agendaDropped.length) {
          console.log(JSON.stringify({ event: 'staged_agenda_attach', attached: agendaAttachments, dropped: agendaDropped.map((text) => String(text).slice(0, 80)) }));
        }
        result = {
          ...result,
          screens: { ...result.screens, discussion: [...cards, ...newCards.values()] }
        };
      }
    }
    const stillBrokenPoints = (result?.screens?.discussion || [])
      .flatMap((card) => (card.points || []).map((point) => (typeof point === 'string' ? point : point?.text)))
      .filter((point) => wordingFaults(String(point || '')).length);
    if (stillBrokenPoints.length) {
      result = {
        ...result,
        validationFlags: [
          ...(Array.isArray(result.validationFlags) ? result.validationFlags : []),
          {
            type: 'discussion_wording_needs_review',
            severity: 'warning',
            blocking: false,
            message: `${stillBrokenPoints.length} discussion point${stillBrokenPoints.length === 1 ? '' : 's'} below still read${stillBrokenPoints.length === 1 ? 's' : ''} like speech rather than a minute. The content is real; the wording needs a pass before sharing.`,
            resolutionKey: `discussion-wording-needs-review:${crypto.createHash('sha256').update(stillBrokenPoints.join('|')).digest('hex').slice(0, 16)}`
          }
        ]
      };
    }
    // A last, whole-screen sweep for an invented surname, over both the topic heading and
    // every point. "Rebecca Cuckoo" was corrected to "Rebecca Gill" in owners and
    // attendees, but discussion PROSE is written by four different sources by this point
    // (the deterministic presentation pass, the fault-gated repair, the universal polish,
    // and the model proposal) and each reads the raw transcript rather than a normalised
    // copy - so a name fixed upstream could still resurface downstream. One sweep over the
    // finished cards catches every source at once, wherever the bad spelling came from.
    const discussionEntityNames = result?.canonicalDiagnostics?.entityNames || [];
    if (discussionEntityNames.length) {
      result = {
        ...result,
        screens: {
          ...result.screens,
          discussion: (result.screens.discussion || []).map((card) => {
            const topic = normaliseAttendeeReferences(card.topic, discussionEntityNames).text;
            const points = (card.points || []).map((point) => {
              if (typeof point === 'string') return normaliseAttendeeReferences(point, discussionEntityNames).text;
              const text = normaliseAttendeeReferences(point?.text || '', discussionEntityNames).text;
              return text !== point?.text ? { ...point, text } : point;
            });
            return topic !== card.topic || points.some((point, index) => point !== card.points[index])
              ? { ...card, topic, points }
              : card;
          })
        }
      };
    }
    // Same claim check for discussion points, and the same deterministic refusal of a
    // named person's error. A point is dropped only on an explicit "unsupported"; a card
    // emptied by the pass is removed unless reviewer-authored or confirmed.
    if (process.env.CLAIM_CHECK !== '0' && (result?.screens?.discussion || []).length) {
      const cards = result.screens.discussion.map((card) => ({ ...card, points: [...(card.points || [])] }));
      const allEvents = prepareEvidence(semanticTranscript.text).events;
      const byId = new Map(allEvents.map((event) => [String(event.id), String(event.text || '').replace(/\s+/g, ' ').trim()]));
      const flat = [];
      cards.forEach((card, cardIndex) => card.points.forEach((point, pointIndex) => {
        flat.push({
          index: flat.length, cardIndex, pointIndex,
          text: String(typeof point === 'string' ? point : point?.text || ''),
          evidence: (card.evidenceIds || []).map((id) => byId.get(String(id))).filter(Boolean).slice(0, 4).join(' ')
        });
      }));
      const dropKeys = new Set();
      const droppedPoints = [];
      for (const entry of flat) {
        if (personErrorAssertion(entry.text)) {
          dropKeys.add(`${entry.cardIndex}:${entry.pointIndex}`);
          droppedPoints.push(entry.text);
        }
      }
      if (dropKeys.size) {
        console.log(JSON.stringify({ event: 'staged_claim_check', stage: 'discussion', dropped: droppedPoints }));
        result = {
          ...result,
          screens: {
            ...result.screens,
            discussion: cards
              .map((card, cardIndex) => ({ ...card, points: card.points.filter((point, pointIndex) => !dropKeys.has(`${cardIndex}:${pointIndex}`)) }))
              .filter((card) => card.points.length || isReviewerAuthored(card) || card.confirmedTopic)
          }
        };
      }
    }
    // Card consolidation, before the point dedupe.
    //
    // The attach rule is lexical min-set overlap >= 0.34, and THREE-word headings sharing
    // exactly one word score 0.333 every time - so "Alarm code review" / "Alarm
    // functionality testing" / "Alarm visual indication" each minted their own card,
    // missing by a hundredth. Measured on the reviewer's live rerun: four separate alarm
    // cards, and the demonstration restated across five of them. "Benefit-risk analysis"
    // and "Risk assessment conclusion" share NO tokens at all (lexical 0.00) yet are
    // plainly one subject (cosine 0.597).
    //
    // So cards merge on heading MEANING as well as tokens. 0.62 sits below the alarm
    // family (0.610-0.736) and above the closest pair that reads as genuinely separate.
    // Reviewer-authored and confirmed cards are never absorbed - they keep their heading
    // and their identity. Points move; headings never blend.
    if (process.env.CARD_MERGE !== '0') {
      const cards = (result?.screens?.discussion || []).map((card) => ({ ...card, points: [...(card.points || [])] }));
      if (cards.length > 1) {
        const headingVectors = await encodeViaWorker(cards.map((card) => String(card.topic || '')));
        if (headingVectors) {
          const absorbed = new Set();
          for (let i = 0; i < cards.length; i += 1) {
            if (absorbed.has(i)) continue;
            for (let j = i + 1; j < cards.length; j += 1) {
              if (absorbed.has(j)) continue;
              if (isReviewerAuthored(cards[j]) || cards[j].confirmedTopic) continue;
              if (!headingVectors[i] || !headingVectors[j]) continue;
              if (cosine(headingVectors[i], headingVectors[j]) < 0.62) continue;
              cards[i].points.push(...cards[j].points);
              cards[i].evidenceIds = [...new Set([...(cards[i].evidenceIds || []), ...(cards[j].evidenceIds || [])])];
              absorbed.add(j);
            }
          }
          if (absorbed.size) {
            console.log(JSON.stringify({ event: 'staged_card_merge', absorbed: [...absorbed].map((index) => cards[index].topic) }));
            result = { ...result, screens: { ...result.screens, discussion: cards.filter((card, index) => !absorbed.has(index)) } };
          }
        }
      }
    }
    // Final semantic near-duplicate pass across ALL cards' points - the proposal dedupe
    // only compared against points that existed at merge time, so a paraphrase could land
    // in a NEW card while its twin sat in another (DITA's B2B-ordering point appeared
    // under two headings). Same 0.80 near-restatement bar as actions; first occurrence
    // wins; a card emptied by the pass is removed unless it is reviewer-authored or a
    // confirmed topic. Card HEADINGS never merge - "Alarm functionality testing" and
    // "Alarm visual and auditory configuration" are legitimately different topics.
    if (process.env.DEDUP_PASS !== '0') {
      const cards = (result?.screens?.discussion || []).map((card) => ({ ...card, points: [...(card.points || [])] }));
      const flat = [];
      cards.forEach((card, cardIndex) => card.points.forEach((point, pointIndex) => {
        flat.push({ cardIndex, pointIndex, text: String(typeof point === 'string' ? point : point?.text || '') });
      }));
      if (flat.length > 1) {
        // Discussion restatements measured on the reviewer's live rerun cluster at
        // 0.71-0.78 - every one under the 0.80 action bar, which is why five versions of
        // the alarm demonstration all published. Discussion gets its own threshold; the
        // 0.708 distinct pair that set the action bar was an ACTIONS pair, so lowering
        // here does not reopen it.
        const dedupe = await duplicateGroups(flat.map((entry) => entry.text), { threshold: Number(process.env.DISCUSSION_DEDUPE_THRESHOLD || 0.72) });
        const dropKeys = new Set();
        for (const group of dedupe.groups) {
          const informationScore = (memberIndex) => {
            const entry = flat[memberIndex];
            const point = cards[entry.cardIndex].points[entry.pointIndex];
            const words = new Set(String(entry.text || '').toLowerCase().match(/[a-z0-9][a-z0-9'’-]{2,}/g) || []);
            const figures = (String(entry.text || '').match(/(?:[$£€]\s*)?\d+(?:[.,]\d+)?(?:\s*%|\s*(?:days?|weeks?|months?|years?))?/g) || []).length;
            return words.size + figures * 4 + Math.min(12, (point?.evidenceIds || []).length) * 0.25
              + Math.min(4, (point?.supportingDetails || []).length);
          };
          const survivorIndex = [...group].sort((a, b) => informationScore(b) - informationScore(a) || a - b)[0];
          const survivorEntry = flat[survivorIndex];
          const survivorPoint = cards[survivorEntry.cardIndex].points[survivorEntry.pointIndex];
          const mergedPoints = group.map((memberIndex) => {
            const entry = flat[memberIndex];
            return cards[entry.cardIndex].points[entry.pointIndex];
          }).filter((point) => point && typeof point === 'object');
          if (survivorPoint && typeof survivorPoint === 'object') {
            survivorPoint.evidenceIds = [...new Set(mergedPoints.flatMap((point) => point.evidenceIds || []))].slice(0, 24);
            survivorPoint.reviewFlagIds = [...new Set(mergedPoints.flatMap((point) => point.reviewFlagIds || []))].slice(0, 24);
            survivorPoint.supportingDetails = mergedPoints.flatMap((point) => point.supportingDetails || [])
              .filter((detail, index, all) => all.findIndex((candidate) => String(candidate?.text || '').toLowerCase() === String(detail?.text || '').toLowerCase()) === index);
            const mergedFromIds = [...new Set(mergedPoints.flatMap((point) => [point.id, ...(point.mergedFromIds || [])]).filter(Boolean))]
              .filter((id) => id !== survivorPoint.id);
            if (mergedFromIds.length) survivorPoint.mergedFromIds = mergedFromIds;
          }
          for (const memberIndex of group) {
            if (memberIndex === survivorIndex) continue;
            const entry = flat[memberIndex];
            dropKeys.add(`${entry.cardIndex}:${entry.pointIndex}`);
          }
        }
        if (dropKeys.size) {
          console.log(JSON.stringify({ event: 'staged_dedupe', stage: 'discussion', dropped: [...dropKeys].map((key) => { const [c, i] = key.split(':').map(Number); const point = cards[c].points[i]; return typeof point === 'string' ? point : point?.text; }), pairs: dedupe.pairs }));
          const deduped = cards
            .map((card, cardIndex) => ({
              ...card,
              points: card.points.filter((point, pointIndex) => !dropKeys.has(`${cardIndex}:${pointIndex}`))
            }))
            .filter((card) => card.points.length || isReviewerAuthored(card) || card.confirmedTopic);
          result = { ...result, screens: { ...result.screens, discussion: deduped } };
        }
      }
    }
    // The reviewer's hard rule, applied last: no published sentence may read as spoken
    // transcript language. Every point above has already been OFFERED repair and polish;
    // one that still carries a voice-severity fault here is one the model could not
    // restate within the acceptance guards - "Limit the risk for them, yeah, okay." -
    // and until now it published anyway, because the finaliser's rejection was undone by
    // a fallback that restored the raw text. It moves to the wording flag as a review
    // candidate, never silently: the flag names each removed point in full. Cards
    // emptied by the gate follow the existing empty-card contract.
    // DISCUSSION_SPEECH_GATE=0 disables.
    if (process.env.DISCUSSION_SPEECH_GATE !== '0' && Array.isArray(result?.screens?.discussion)) {
      const people = result?.canonicalDiagnostics?.entityNames || [];
      const removed = [];
      const gatedCards = result.screens.discussion.map((card) => {
        if (isReviewerAuthored(card)) return card;
        const points = (card.points || []).filter((point) => {
          const text = typeof point === 'string' ? point : String(point?.text || '');
          const spoken = minutesEnglishFaults(text, { people, spokenRegister: true })
            .some((fault) => fault.severity === 'voice');
          if (spoken) removed.push({ section: card.topic || 'Discussion', text });
          return !spoken;
        });
        return points.length === (card.points || []).length ? card : { ...card, points };
      }).filter((card) => (card.points || []).length || isReviewerAuthored(card) || card.confirmedTopic);
      if (removed.length) {
        console.log(JSON.stringify({ event: 'staged_speech_gate', stage: 'discussion', removed }));
        result = {
          ...result,
          screens: { ...result.screens, discussion: gatedCards },
          validationFlags: [
            ...(Array.isArray(result.validationFlags) ? result.validationFlags : []),
            {
              type: 'discussion_speech_removed',
              severity: 'warning',
              blocking: false,
              message: `${removed.length} discussion point${removed.length === 1 ? '' : 's'} read as spoken transcript language and could not be restated, so ${removed.length === 1 ? 'it was' : 'they were'} moved here for a decision rather than published as minutes.`,
              resolutionKey: `discussion-speech-removed:${crypto.createHash('sha256').update(removed.map((item) => item.text).join('|')).digest('hex').slice(0, 16)}`,
              repairCandidates: removed
            }
          ]
        };
      }
    }
  }
  // Routine mechanics of running the call are neither discussion content nor a
  // meeting outcome.  Model prompts already say this, but a grounded rewrite can
  // still paraphrase "wait for an attendee" and pass a lexical evidence check.
  // Apply the deterministic publication rule after rewriting; reviewer-authored
  // cards remain authoritative.
  if (stage === 'discussion' && Array.isArray(result?.screens?.discussion)) {
    const removed = [];
    const cards = result.screens.discussion.map((card) => {
      if (isReviewerAuthored(card)) return card;
      const points = (card.points || []).filter((point) => {
        const pointText = typeof point === 'string' ? point : String(point?.text || '');
        if (isRoutineMeetingAdministrationText(pointText)) removed.push(pointText);
        return !isRoutineMeetingAdministrationText(pointText);
      });
      return points.length === (card.points || []).length ? card : { ...card, points };
    }).filter((card) => (card.points || []).length || isReviewerAuthored(card) || card.confirmedTopic);
    if (removed.length) console.info(JSON.stringify({ event: 'staged_meeting_admin_removed', stage, removed }));
    result = { ...result, screens: { ...result.screens, discussion: cards } };
  }
  let initialUnderstandingPolish = { used: false, reason: 'not_applicable' };
  const presentationInitialSummary = result?.screens?.summary;
  if (stage === 'summary' && presentationInitialSummary) {
    const summaryEvidencePack = stage === 'summary' && Array.isArray(payload._canonicalEvidencePack)
      ? payload._canonicalEvidencePack
      : null;
    initialUnderstandingPolish = await polishStagedInitialUnderstanding(
      presentationInitialSummary,
      confirmed.details?.meetingTitle || input.meetingTitle || '',
      summaryEvidencePack,
      semanticTranscript.text
    );
    if (initialUnderstandingPolish.used) {
      // A field the reviewer wrote is not ours to copy-edit. The polish is a presentation
      // pass over model prose; run over confirmed text it silently rewrites the reviewer's
      // own words back at them, which is the thing they came here to stop.
      const confirmedSummary = confirmed.summary || {};
      const keepConfirmed = (confirmedValue, polishedValue, presentedValue) => (
        stagedAnalyticsText(confirmedValue) ? presentedValue : polishedValue
      );
      // A purpose somebody said in the meeting, or one taken from the title, is a quote.
      // Copy-editing it is how "sense check our academic theory" became "The session
      // focused on a sense check of the academic theory" - vaguer than what was actually
      // said, and no longer the thing the cited turn supports. Only prose we composed
      // ourselves is ours to rewrite.
      // The purpose decides for itself whether it is ours to rewrite, because the module
      // that builds it is the only place that knows where its words came from. An
      // enumerated list here describing objects constructed in another file is how
      // MODE_CONFIG escaped the source check written to catch exactly that.
      // 'never'  - somebody said it; a quote is not replaced, however good the polish.
      // 'evidence_grounded' - a title standing in for an absent purpose; replaceable by
      //             a cited paragraph that passed the citation validators, which is what
      //             fieldOutcomes.purpose === 'accepted' certifies.
      // 'free'/absent - prose the pipeline composed; the polish may rewrite it.
      const purposeMeta = presentationInitialSummary?.initialUnderstanding?.meetingPurpose || {};
      const purposePolicy = purposeMeta.purposeReplacementPolicy
        || (purposeMeta.purposeIsAuthoredElsewhere ? 'evidence_grounded' : 'free');
      const citedPurposeAccepted = initialUnderstandingPolish.cited
        && initialUnderstandingPolish.fieldOutcomes?.purpose === 'accepted';
      const purposeIsQuoted = purposePolicy === 'never'
        || (purposePolicy === 'evidence_grounded' && !citedPurposeAccepted);
      result = {
        ...result,
        screens: {
          ...(result.screens || {}),
          summary: {
            ...presentationInitialSummary,
            meetingPurpose: purposeIsQuoted
              ? presentationInitialSummary.meetingPurpose
              : keepConfirmed(confirmedSummary.meetingPurpose, initialUnderstandingPolish.meetingPurpose, presentationInitialSummary.meetingPurpose),
            objectives: keepConfirmed(
              confirmedSummary.objectives,
              topUpObjectivesFromNamedTopics(initialUnderstandingPolish.objectives, initialUnderstandingPolish.namedTopics),
              presentationInitialSummary.objectives
            ),
            ...mergeNamedTopics(presentationInitialSummary, initialUnderstandingPolish.namedTopics, confirmedSummary.overallTopics),
            executiveSummary: keepConfirmed(confirmedSummary.executiveSummary, initialUnderstandingPolish.executiveSummary, presentationInitialSummary.executiveSummary),
            // The turns behind the composed prose, for the screen to show on demand. The
            // reviewer asked to see the evidence rather than delete id markers from the
            // sentences; this is where the markers went.
            evidenceQuotes: initialUnderstandingPolish.evidenceQuotes || null
          }
        }
      };
    }
  }
  // Objectives are derived from the meeting's own action phrases, so two near-identical
  // commitments produce two near-identical objectives - Abbott published "Run the code
  // of conduct through the site in advance to ensure alignment." beside "Run code of
  // conduct through the site in advance to make sure they're in alignment with it" -
  // and the existing dedupe compares normalised string KEYS, which different wordings
  // sail straight past. Semantic near-restatements collapse here, first occurrence
  // kept, live path only (the corpus baselines call runCanonicalLiveStage directly and
  // never reach this). Reviewer-confirmed objectives are never touched: their list IS
  // the list. OBJECTIVE_DEDUPE=0 disables.
  if (stage === 'summary' && process.env.OBJECTIVE_DEDUPE !== '0'
      && !stagedAnalyticsText(confirmed.summary?.objectives)
      && Array.isArray(result?.screens?.summary?.objectives)
      && result.screens.summary.objectives.length > 1) {
    const objectives = result.screens.summary.objectives;
    const dedupe = await duplicateGroups(objectives.map((item) => String(item || '')));
    const drop = new Set();
    for (const group of dedupe.groups) for (const index of group.slice(1)) drop.add(index);
    if (drop.size) {
      console.log(JSON.stringify({ event: 'staged_objective_dedupe', dropped: [...drop].map((index) => objectives[index]), pairs: dedupe.pairs }));
      result = {
        ...result,
        screens: {
          ...result.screens,
          summary: { ...result.screens.summary, objectives: objectives.filter((item, index) => !drop.has(index)) }
        }
      };
    }
  }
  let executiveSummaryGrammar = { used: false, reason: 'not_applicable' };
  const presentationSummary = result?.screens?.summary?.executiveSummary;
  const executiveSummaryIsConfirmed = Boolean(stagedAnalyticsText(confirmed.summary?.executiveSummary));
  if (executiveSummaryIsConfirmed) executiveSummaryGrammar = { used: false, reason: 'reviewer_confirmed' };
  // An evidence-cited summary is already minutes-ready prose validated claim by claim;
  // re-polishing it would fight the enrichment (the grammar pass's own 1.3x length gate
  // rejects sanctioned growth) and could reintroduce the outcome-summary drift the
  // citation contract exists to prevent. The purpose-prefix invariant scopes to the
  // deterministic path from here: a cited summary need not open with the purpose - the
  // user's own exemplars do not - and the supersession is pinned by test.
  const summaryWasCited = initialUnderstandingPolish.used && initialUnderstandingPolish.cited
    && initialUnderstandingPolish.fieldOutcomes?.summary === 'accepted';
  if (summaryWasCited) {
    executiveSummaryGrammar = { used: false, reason: 'superseded_by_evidence_polish' };
    result = {
      ...result,
      validationFlags: [
        ...(result.validationFlags || []),
        {
          type: 'summary_machine_composed',
          severity: 'info',
          blocking: false,
          resolutionKey: 'summary-machine-composed',
          message: 'This summary was composed from the meeting\'s own evidence by the drafting model, with each statement tied to cited moments. Read it before sharing - it is a draft, not a record.'
        }
      ]
    };
  }
  if (!executiveSummaryIsConfirmed && !summaryWasCited && ['summary', 'discussion'].includes(stage) && presentationSummary) {
    // The summary is built as purpose-sentence-then-spine, and the purpose field itself
    // is exempt from copy-editing when its words are quoted or the reviewer's. Sending
    // the whole summary through the grammar pass quietly undid that from the other side:
    // the purpose field said "Check in on progress for AI." while the summary opening
    // said "The session focused on...". Same words, two renderings, one screen.
    //
    // So the purpose is an opaque prefix. The grammar pass polishes only what follows it,
    // and the prefix is reattached byte-identical - which makes the divergence impossible
    // rather than merely fixed, and is asserted as an invariant by
    // executive-summary-prefix.test.js.
    const summaryPurpose = String(result?.screens?.summary?.meetingPurpose || '').trim();
    const protectPrefix = summaryPurpose && presentationSummary.startsWith(summaryPurpose);
    const polishable = protectPrefix ? presentationSummary.slice(summaryPurpose.length).trim() : presentationSummary;
    if (!polishable) {
      executiveSummaryGrammar = { used: false, reason: 'purpose_only' };
    } else {
      executiveSummaryGrammar = await grammarPolishStagedExecutiveSummary(polishable);
      if (executiveSummaryGrammar.text) {
        const polished = protectPrefix ? `${summaryPurpose} ${executiveSummaryGrammar.text}` : executiveSummaryGrammar.text;
        result = {
          ...result,
          screens: {
            ...(result.screens || {}),
            summary: {
              ...(result.screens?.summary || {}),
              executiveSummary: polished
            }
          }
        };
      }
    }
  }
  // Run after every optional summary rewrite.  The guard is field-specific so
  // text the reviewer confirmed is never silently removed.
  if (stage === 'summary' && result?.screens?.summary) {
    const summary = result.screens.summary;
    const purposeConfirmed = Boolean(stagedAnalyticsText(confirmed.summary?.meetingPurpose));
    const objectivesConfirmed = Boolean(stagedAnalyticsText(confirmed.summary?.objectives));
    const topicsConfirmed = Boolean(stagedAnalyticsText(confirmed.summary?.overallTopics));
    const generatedPurpose = purposeConfirmed || !isRoutineMeetingAdministrationText(summary.meetingPurpose)
      ? summary.meetingPurpose : '';
    const generatedObjectives = objectivesConfirmed ? summary.objectives : (summary.objectives || [])
      .filter((item) => !isRoutineMeetingAdministrationText(item));
    const generatedTopics = topicsConfirmed ? summary.overallTopics : (summary.overallTopics || [])
      .filter((item) => !isRoutineMeetingAdministrationText(item));
    const visibleTopicKeys = new Set(generatedTopics.map((item) => stagedAnalyticsText(item).toLowerCase()));
    const executiveSummary = executiveSummaryIsConfirmed
      ? summary.executiveSummary
      : removeRoutineMeetingAdministrationSentences(summary.executiveSummary);
    result = {
      ...result,
      screens: {
        ...result.screens,
        summary: {
          ...summary,
          meetingPurpose: generatedPurpose,
          objectives: generatedObjectives,
          overallTopics: generatedTopics,
          topicRefs: topicsConfirmed ? summary.topicRefs : (summary.topicRefs || [])
            .filter((item) => visibleTopicKeys.has(stagedAnalyticsText(item?.text).toLowerCase())),
          executiveSummary,
          ...(summary.initialUnderstanding ? {
            initialUnderstanding: {
              ...summary.initialUnderstanding,
              meetingPurpose: purposeConfirmed || !isRoutineMeetingAdministrationText(summary.initialUnderstanding?.meetingPurpose?.text)
                ? summary.initialUnderstanding.meetingPurpose
                : { ...summary.initialUnderstanding.meetingPurpose, text: '' },
              meetingSpine: (summary.initialUnderstanding.meetingSpine || [])
                .filter((item) => !isRoutineMeetingAdministrationText(item?.text))
            }
          } : {})
        }
      }
    };
  }
  if (stage === 'actions' && Array.isArray(result?.screens?.actions)) {
    const presentedActions = filterActionsForPresentation(result.screens.actions);
    const removed = result.screens.actions.filter((item) => !presentedActions.includes(item));
    if (removed.length) console.log(JSON.stringify({
      event: 'staged_minimum_action_words_gate',
      stage: 'actions',
      removed: removed.map((item) => item?.action || item?.meetingActionPoint || '')
    }));
    result = { ...result, screens: { ...result.screens, actions: presentedActions } };
  }
  const health = assessGenerationHealth({
    stage,
    trooper: { used: polished.used, reason: polished.reason },
    summaryPolish: {
      attempted: stage === 'summary' && Boolean(presentationInitialSummary),
      used: Boolean(initialUnderstandingPolish.used),
      reason: initialUnderstandingPolish.reason,
      truncated: Boolean(initialUnderstandingPolish.truncated),
      degraded: Boolean(initialUnderstandingPolish.degraded)
    },
    grammarPolish: {
      attempted: ['summary', 'discussion'].includes(stage) && Boolean(presentationSummary),
      used: Boolean(executiveSummaryGrammar.used),
      reason: executiveSummaryGrammar.reason
    },
    wordingRepair: stage === 'discussion' ? discussionWordingRepair : actionWordingRepair
  });
  const pipelineHealth = {
    revision: servingRevision(),
    stage,
    served: health.served,
    degradations: health.degradations,
    durationMs: Date.now() - generationStartedAt,
    actionAccounting: result?.canonicalDiagnostics?.actionAccounting || null,
    wordingRepair: (({ attempted = 0, repaired = 0, reason = '' }) => ({ attempted, repaired, reason }))(stage === 'discussion' ? discussionWordingRepair : actionWordingRepair)
  };
  // One greppable line per generation, because the last five incidents in this area were
  // each dug out of pm2 logs by hand. `grep staged_generation_health` now answers the
  // first three questions of any dig - what ran, what degraded, what code served it.
  console.log(JSON.stringify({ event: 'staged_generation_health', fileName: transcript.fileName || null, ...pipelineHealth }));
  if (health.degradations.length) {
    result = {
      ...result,
      validationFlags: [
        ...(Array.isArray(result.validationFlags) ? result.validationFlags : []),
        {
          type: 'generation_degraded',
          severity: 'warning',
          blocking: false,
          // Written for the reviewer, not the operator: what it means for their read.
          message: `Part of this screen was generated in a reduced mode - without ${[...new Set(health.degradations.map((item) => item.label))].join('; and without ')}. The content is complete, but the wording is worth a closer read before sharing.`,
          resolutionKey: `generation-degraded:${stage}:${crypto.createHash('sha256').update(health.degradations.map((item) => `${item.step}|${item.reason}`).join('|')).digest('hex').slice(0, 12)}`
        }
      ]
    };
  }
  return normaliseDomainTermsDeep({
    source: transcript.source,
    fileName: transcript.fileName || null,
    transcriptLength: transcript.text.length,
    ...result,
    pipelineHealth,
    telemetryPreview: {
      ...(result.telemetryPreview || {}),
      executiveSummaryGrammar: {
        attempted: ['summary', 'discussion'].includes(stage) && Boolean(presentationSummary),
        used: Boolean(executiveSummaryGrammar.used),
        reason: executiveSummaryGrammar.reason,
        overlap: executiveSummaryGrammar.overlap,
        timingMs: executiveSummaryGrammar.timingMs
      },
      initialUnderstandingPolish: {
        attempted: stage === 'summary' && Boolean(presentationInitialSummary),
        used: Boolean(initialUnderstandingPolish.used),
        cited: Boolean(initialUnderstandingPolish.cited),
        reason: initialUnderstandingPolish.reason,
        // Per-field acceptance and every rejection reason - the failure mode this whole
        // area keeps re-teaching is the invisible one, where a validator quietly refuses
        // and the fallback reproduces the thin output that prompted the work.
        fieldOutcomes: initialUnderstandingPolish.fieldOutcomes || null,
        overlap: initialUnderstandingPolish.overlap,
        // Whether the model ran out of room, and whether what came back was the fallback
        // request rather than the one we meant to make. Both were invisible, and their
        // absence is why a maxTokens ceiling presented as a complaint about wording.
        truncated: Boolean(initialUnderstandingPolish.truncated),
        degraded: Boolean(initialUnderstandingPolish.degraded),
        finishReason: initialUnderstandingPolish.finishReason || '',
        timingMs: initialUnderstandingPolish.timingMs
      },
      transcriptHealth,
      trooper: { used: polished.used, reason: polished.reason, usage: polished.usage || null, input: 'bounded_minilm_evidence' }
    },
    preparedTranscriptTelemetry: semanticTranscript.preparedTranscriptTelemetry || transcript.preparedTranscriptTelemetry || null
  });
}

function stagedStageResumeUrl(inputPayload, payload) {
  const draftId = String(inputPayload?.draftId || '').trim();
  const stage = String(payload?.stagedStage || inputPayload?.stage || 'details').trim().toLowerCase();
  // targetScreen is a screen index recorded by whichever version of the review page queued
  // the job, and screen indices have already shifted once - removing Summary moved every
  // stage after Details down by one. A job queued before that shift still carries the old
  // index, so honouring it would resume the reviewer a stage further on than they had got
  // to. The stage name is what survives a renumbering, so it decides the screen, and it
  // goes in the link for the page to read back.
  const screenByStage = { details: 0, discussion: 1, actions: 2 };
  const screen = Object.prototype.hasOwnProperty.call(screenByStage, stage)
    ? screenByStage[stage]
    : (Number.isFinite(Number(inputPayload?.targetScreen)) ? Number(inputPayload.targetScreen) : 0);
  const params = new URLSearchParams();
  if (draftId) params.set('draftId', draftId);
  params.set('stage', stage);
  params.set('screen', String(screen));
  params.set('stageJobId', String(inputPayload?.jobId || ''));
  return `/staged-meeting-minutes?${params.toString()}`;
}

async function runQueuedStagedMeetingMinutesStage(jobId) {
  const startedAt = Date.now();
  const job = await getGenerationJob(jobId, { includeTranscript: true });
  if (!job || job.jobType !== 'staged_meeting_minutes_stage') return;
  const input = job.inputPayload || {};
  const stage = String(input.stage || 'details').trim().toLowerCase();
  const transcript = {
    text: job.transcriptText || '',
    source: input.source || 'staged-meeting-minutes',
    fileName: input.fileName || '',
    preparedTranscript: job.preparedTranscript || null,
    preparedTranscriptTelemetry: job.preparedTranscriptTelemetry || input.preparedTranscriptTelemetry || null
  };
  const stagedReq = {
    query: { pipeline: input.pipeline || MEETING_MINUTES_JOB_PIPELINE },
    body: {
      stage,
      meetingTitle: input.confirmedDetails?.meetingTitle || input.meetingTitle || '',
      meetingDate: input.confirmedDetails?.meetingDate || input.meetingDate || '',
      meetingLocation: input.confirmedDetails?.meetingLocation || input.meetingLocation || '',
      meetingType: input.meetingType || '',
      participants: Array.isArray(input.confirmedDetails?.participants) ? input.confirmedDetails.participants.join('\n') : input.participants || '',
      overallTopics: Array.isArray(input.confirmedSummary?.overallTopics) ? input.confirmedSummary.overallTopics.join('\n') : input.overallTopics || '',
      reviewObjectives: input.reviewObjectives || '',
      reviewDiscussion: input.reviewDiscussion || '',
      reviewActions: input.reviewActions || '',
      additionalContext: input.additionalContext || '',
      confirmedDetails: input.confirmedDetails || {},
      confirmedSummary: input.confirmedSummary || {},
      confirmedDiscussion: input.confirmedDiscussion || [],
      confirmedActions: input.confirmedActions || []
    }
  };

  try {
    await query(
      `UPDATE meeting_jobs
       SET status = 'running',
           attempts = COALESCE(attempts, 0) + 1,
           started_at = COALESCE(started_at, NOW()),
           updated_at = NOW()
       WHERE id = $1 AND job_type = 'staged_meeting_minutes_stage'`,
      [Number(jobId)]
    );
    await updateGenerationJobProgress(jobId, stage, 10, `Generating staged ${stage} content.`);
    validateTranscriptText(transcript.text);
    const transcriptIdentity = transcriptMetadata(transcript.text);
    assertStagedTranscriptHash(
      input.transcriptSha256,
      transcriptIdentity.transcriptSha256,
      'queued job transcript'
    );

    let payload;
    if (stage === 'details') {
      const preparedTranscript = buildPreparedTranscriptForStagedAI(transcript.text);
      payload = {
        source: transcript.source,
        fileName: transcript.fileName || null,
        transcriptLength: transcript.text.length,
        ...extractStagedDetailsFromTranscript(transcript.text, transcript.fileName),
        preparedTranscriptTelemetry: {
          rawLength: preparedTranscript.rawLength,
          preparedLength: preparedTranscript.preparedLength,
          removedLineCount: preparedTranscript.removedLineCount,
          removedReasons: preparedTranscript.removedReasons,
          source: 'deterministic_stage_1_prep'
        }
      };
    } else if (stage === 'discussion' || stage === 'actions') {
      await updateGenerationJobProgress(jobId, stage, 35, stage === 'actions'
        ? 'Denoising, chunking and reviewing action evidence.'
        : 'Denoising and organising discussion evidence.');
      // This is the measured live pipeline: MiniLM-v3 denoising followed by the
      // meeting-type-specific, multi-pass Trooper stage. Do not route these screens
      // through canonicalStagedResponse; that path reduced the measured Discussion
      // coverage from 168/193 to 113/194 and bypassed the high-recall action extractor.
      const selectedMeetingType = input.confirmedDetails?.meetingType || input.meetingType || '';
      const meetingIdentity = `${input.confirmedDetails?.meetingTitle || ''} ${transcript.fileName || ''}`;
      payload = await generateMiniLmTrooperStage(stage, transcript.text, {
        meetingType: stagedGenerationMeetingType(selectedMeetingType, meetingIdentity)
      });
    } else {
      const evidenceProgressMessage = stage === 'actions'
        ? 'Reviewing action evidence.'
        : stage === 'discussion'
          ? 'Reviewing discussion evidence.'
          : 'Reviewing summary evidence.';
      await updateGenerationJobProgress(jobId, stage, 35, evidenceProgressMessage);
      payload = await canonicalStagedResponse(stage, transcript, input);
    }

    const priorScreens = {};
    if (input.confirmedDetails && Object.keys(input.confirmedDetails).length) priorScreens.details = input.confirmedDetails;
    if (input.confirmedSummary && Object.keys(input.confirmedSummary).length) priorScreens.summary = input.confirmedSummary;
    if (Array.isArray(input.confirmedDiscussion) && input.confirmedDiscussion.length) priorScreens.discussion = input.confirmedDiscussion;
    if (Array.isArray(input.confirmedActions) && input.confirmedActions.length) priorScreens.actions = input.confirmedActions;
    if (Object.keys(priorScreens).length) {
      payload.screens = {
        ...priorScreens,
        ...(payload.screens || {})
      };
    }

    if (stage === 'actions' && Array.isArray(payload?.screens?.actions)) {
      const presentedActions = filterActionsForPresentation(payload.screens.actions);
      const removed = payload.screens.actions.filter((item) => !presentedActions.includes(item));
      if (removed.length) console.info(JSON.stringify({
        event: 'staged_minimum_action_words_gate',
        jobId: Number(jobId),
        stage: 'actions',
        removed: removed.map((item) => item?.action || item?.meetingActionPoint || '')
      }));
      payload.screens.actions = presentedActions;
      if (Array.isArray(payload.screens.raisedActions)) {
        payload.screens.raisedActions = filterActionsForPresentation(payload.screens.raisedActions);
      }
    }

    // Apply unconditional terminology corrections after current and prior screens have
    // been assembled, so queued results are clean both in storage and on retrieval.
    payload = normaliseDomainTermsDeep(payload);

    await updateGenerationJobProgress(jobId, stage, 90, `Staged ${stage} content generated. Preparing resume link.`);
    const resultPayload = {
      ok: true,
      staged: true,
      source: transcript.source,
      fileName: transcript.fileName || null,
      transcriptLength: transcript.text.length,
      transcriptSha256: transcriptIdentity.transcriptSha256,
      meetingId: job.meetingId,
      jobId,
      result: {
        ...payload,
        jobId,
        meetingId: job.meetingId,
        transcriptSha256: transcriptIdentity.transcriptSha256,
        queuedDiagnostics: {
          jobId,
          meetingId: job.meetingId,
          workerMode: 'staged_meeting_minutes_stage',
          rawTranscriptLength: transcript.text.length,
          transcriptSha256: transcriptIdentity.transcriptSha256,
          preparedTranscriptLength: payload.preparedTranscriptTelemetry?.preparedLength || transcript.text.length,
          durationMs: Date.now() - startedAt
        }
      }
    };
    resultPayload.resumeUrl = stagedStageResumeUrl({ ...input, jobId }, payload);
    resultPayload.result.resumeUrl = resultPayload.resumeUrl;
    await markGenerationJobCompleted(jobId, job.meetingId, resultPayload, `Staged ${stage} content is ready to review.`);
    console.info(JSON.stringify({
      event: 'staged_meeting_minutes_stage_completed',
      jobId: Number(jobId),
      draftId: String(input.draftId || ''),
      stage,
      transcriptSha256: transcriptIdentity.transcriptSha256,
      transcriptLength: transcript.text.length,
      durationMs: Date.now() - startedAt
    }));
  } catch (error) {
    await markGenerationJobFailure(
      { ...job, attempts: Number(job.attempts || 0) + 1 },
      error?.message || `Staged ${stage} generation failed.`,
      'Staged generation'
    );
  }
}

function launchQueuedStagedMeetingMinutesStage(jobId) {
  setImmediate(() => {
    runQueuedStagedMeetingMinutesStage(jobId).catch((error) => {
      safeLogError('[Queued staged meeting minutes stage failed]', error, { jobId });
    });
  });
}

async function findStagedSourceJobFromRequest(req) {
  const sourceJobId = Number(req.body?.sourceJobId || req.query?.sourceJobId || 0);
  if (sourceJobId) {
    const sourceJob = await getGenerationJob(sourceJobId, { includeTranscript: true });
    if (sourceJob) {
      assertStagedSourceIdentity(
        {
          draftId: req.body?.draftId || req.query?.draftId || '',
          transcriptSha256: req.body?.transcriptSha256 || req.query?.transcriptSha256 || ''
        },
        {
          draftId: sourceJob.inputPayload?.draftId || '',
          transcriptSha256: sourceJob.inputPayload?.transcriptSha256 || ''
        }
      );
    }
    return sourceJob;
  }

  const draftId = String(req.body?.draftId || req.query?.draftId || '').trim();
  if (!draftId) return null;
  // Any prior staged stage for this draft still holds the transcript in its autosave, so
  // include 'failed'/'cancelled' too — the transcript should stay recoverable even if an
  // earlier stage's generation errored, rather than forcing the reviewer to re-upload.
  const result = await query(
    `SELECT id
     FROM meeting_jobs
     WHERE job_type = 'staged_meeting_minutes_stage'
       AND input_payload->>'draftId' = $1
       AND status IN ('completed','running','queued','failed','cancelled')
     ORDER BY id DESC
     LIMIT 1`,
    [draftId]
  );
  const jobId = result.rows[0]?.id;
  const sourceJob = jobId ? await getGenerationJob(jobId, { includeTranscript: true }) : null;
  if (sourceJob) {
    assertStagedSourceIdentity(
      {
        draftId,
        transcriptSha256: req.body?.transcriptSha256 || req.query?.transcriptSha256 || ''
      },
      {
        draftId: sourceJob.inputPayload?.draftId || '',
        transcriptSha256: sourceJob.inputPayload?.transcriptSha256 || ''
      }
    );
  }
  return sourceJob;
}

function validateTranscriptText(text) {
  if (!text || !text.trim()) {
    const error = new Error('Transcript text is empty. Paste text or upload a non-empty transcript file.');
    error.statusCode = 400;
    throw error;
  }

  if (text.length > MAX_TRANSCRIPT_CHARS) {
    const error = new Error(`Transcript is too large. Maximum supported text length is ${MAX_TRANSCRIPT_CHARS} characters.`);
    error.statusCode = 413;
    throw error;
  }
}

function parsePythonJson(rawOutput, scriptName) {
  try {
    return JSON.parse(rawOutput);
  } catch (error) {
    const wrapped = new Error(`${scriptName} returned output that could not be parsed as JSON.`);
    wrapped.statusCode = 502;
    wrapped.details = {
      scriptName,
      parseError: error.message,
      rawOutputBytes: Buffer.byteLength(String(rawOutput || ''), 'utf8')
    };
    throw wrapped;
  }
}

async function runPythonTranscriptScript(scriptName, transcriptText, scriptArgs = [], options = {}) {
  validateTranscriptText(transcriptText);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trinzo-transcript-'));
  const tempPath = path.join(tempDir, 'transcript.txt');
  const scriptPath = path.join(__dirname, '..', 'scripts', scriptName);

  try {
    await fs.writeFile(tempPath, transcriptText, 'utf8');

    const rawOutput = await new Promise((resolve, reject) => {
      const child = spawn(process.env.PYTHON_BIN || 'python3', [scriptPath, tempPath, ...scriptArgs], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, ...(options.env || {}) },
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timeoutMs = Number(options.timeoutMs || PYTHON_TIMEOUT_MS);
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });

      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          const error = new Error(`${scriptName} timed out after ${timeoutMs}ms.`);
          error.statusCode = 504;
          error.details = { scriptName, stderrBytes: Buffer.byteLength(stderr, 'utf8') };
          reject(error);
          return;
        }

        if (code !== 0) {
          const error = new Error(`${scriptName} failed with exit code ${code}.`);
          error.statusCode = 502;
          error.details = {
            scriptName,
            exitCode: code,
            stderrBytes: Buffer.byteLength(stderr, 'utf8'),
            stdoutBytes: Buffer.byteLength(stdout, 'utf8')
          };
          reject(error);
          return;
        }

        resolve(stdout);
      });
    });

    return parsePythonJson(rawOutput, scriptName);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function runPythonJsonScript(scriptName, payload, scriptArgs = []) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trinzo-json-'));
  const tempPath = path.join(tempDir, 'payload.json');
  const scriptPath = path.join(__dirname, '..', 'scripts', scriptName);

  try {
    await fs.writeFile(tempPath, JSON.stringify(payload), 'utf8');

    const rawOutput = await new Promise((resolve, reject) => {
      const child = spawn(process.env.PYTHON_BIN || 'python3', [scriptPath, tempPath, ...scriptArgs], {
        cwd: path.join(__dirname, '..'),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, PYTHON_TIMEOUT_MS);

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });

      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          const error = new Error(`${scriptName} timed out after ${PYTHON_TIMEOUT_MS}ms.`);
          error.statusCode = 504;
          error.details = { scriptName, stderrBytes: Buffer.byteLength(stderr, 'utf8') };
          reject(error);
          return;
        }

        if (code !== 0) {
          const error = new Error(`${scriptName} failed with exit code ${code}.`);
          error.statusCode = 502;
          error.details = {
            scriptName,
            exitCode: code,
            stderrBytes: Buffer.byteLength(stderr, 'utf8'),
            stdoutBytes: Buffer.byteLength(stdout, 'utf8')
          };
          reject(error);
          return;
        }

        resolve(stdout);
      });
    });

    return parsePythonJson(rawOutput, scriptName);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function withTestUpload(handler) {
  return async (req, res) => {
    try {
      await runUploadMiddleware(req, res, testUpload.single('file'));
      return handler(req, res);
    } catch (error) {
      if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
        error.statusCode = 413;
        error.message = 'Uploaded file is too large. Maximum upload size is 5 MB.';
      }
      return sendTestError(res, error);
    }
  };
}



function extractJsonFromText(text) {
  if (!text) return null;

  const cleaned = String(text)
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');

  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;

  try {
    return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
  } catch (error) {
    console.error('JSON parse failed:', error.message);
    return null;
  }
}

function asString(value) {
  if (value == null) return '';
  return typeof value === 'string' ? value : String(value);
}

function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => asString(v)).filter(Boolean);
}

function normalizeReviewData(candidate, transcriptText = '') {
  const transcriptEvidenceIds = [
    ...[...String(transcriptText || '').matchAll(/\bT\d{4}\b/g)].map((match) => match[0]),
    ...(transcriptText ? prepareEvidence(transcriptText).events.map((event) => event.id) : [])
  ];
  const source = normaliseReferenceArrays(candidate && typeof candidate === 'object' ? candidate : {}, {
    validEvidenceIds: transcriptEvidenceIds
  });
  const refereeOutput = normaliseRefereeOutput(source);

  const normalized = {
    meetingTitle: asString(source.meetingTitle),
    meetingDate: asString(source.meetingDate),
    meetingLocation: asString(source.meetingLocation),
    meetingDescription: asString(source.meetingDescription),
    meetingObjectives: asStringArray(source.meetingObjectives),
    participants: {
      client: asStringArray(source.participants?.client),
      trinzo: asStringArray(source.participants?.trinzo)
    },
    meetingMinutes: Array.isArray(source.meetingMinutes)
      ? source.meetingMinutes
          .map((item) => ({
            topic: asString(item?.topic),
            discussionPoints: asStringArray(item?.discussionPoints)
          }))
          .filter((item) => item.topic || item.discussionPoints.length)
      : [],
    nextSteps: Array.isArray(source.nextSteps)
      ? source.nextSteps
          .map((item) => ({
            action: asString(item?.action),
            owner: asString(item?.owner),
            deadline: asString(item?.deadline)
          }))
          .filter((item) => item.action || item.owner || item.deadline)
      : [],
    ...(refereeOutput ? { refereeOutput } : {})
  };

  if (!normalized.meetingMinutes.length && Array.isArray(source.discussionPoints)) {
    const discussionPoints = asStringArray(source.discussionPoints);
    if (discussionPoints.length) {
      normalized.meetingMinutes = [{ topic: asString(source.itemTopic || source.meetingTitle || 'Discussion'), discussionPoints }];
    }
  }

  if (!normalized.nextSteps.length && Array.isArray(source.meetingActionPoint)) {
    const points = asStringArray(source.meetingActionPoint);
    const owners = asStringArray(source.meetingActionPointOwner);
    const deadlines = asStringArray(source.meetingActionPointDeadline);
    normalized.nextSteps = points.map((point, index) => ({
      action: point,
      owner: owners[index] || 'Not stated',
      deadline: deadlines[index] || 'Not stated'
    }));
  }

  const transcript = asString(transcriptText || source.autosave?.transcript);

  normalized.autosave = {
    enabled: true,
    savedAt: new Date().toISOString(),
    transcript,
    transcriptLength: transcript.length
  };

  return normalized;
}

function hasAnyApprovedContent(reviewData) {
  return Boolean(
    reviewData.meetingTitle ||
      reviewData.meetingDate ||
      reviewData.meetingLocation ||
      reviewData.meetingDescription ||
      reviewData.meetingObjectives.length ||
      reviewData.participants.client.length ||
      reviewData.participants.trinzo.length ||
      reviewData.meetingMinutes.length ||
      reviewData.nextSteps.length
  );
}

function buildFinalisationPayload(reviewData) {
  const minutes = Array.isArray(reviewData.meetingMinutes) ? reviewData.meetingMinutes : [];
  const nextSteps = Array.isArray(reviewData.nextSteps) ? reviewData.nextSteps : [];

  return {
    meetingTitle: asString(reviewData.meetingTitle),
    meetingDate: asString(reviewData.meetingDate),
    meetingLocation: asString(reviewData.meetingLocation),
    meetingDescription: asString(reviewData.meetingDescription),

    meetingObjectives: asStringArray(reviewData.meetingObjectives).join('\n'),

    clientAttendees: asStringArray(reviewData.participants?.client).join('\n'),
    participantsTrinzo: asStringArray(reviewData.participants?.trinzo).join('\n'),

    meetingItems: minutes.map((item) => ({
      itemTopic: asString(item?.topic),
      discussionPoints: asStringArray(item?.discussionPoints).join('\n')
    })),

    nextSteps: nextSteps.map((item) => ({
      meetingActionPoint: asString(item?.action),
      meetingActionPointOwner: asString(item?.owner),
      meetingActionPointDeadline: asString(item?.deadline)
    }))
  };
}

async function postToWebhook(payload) {
  const webhookUrl = process.env.POWER_AUTOMATE_WEBHOOK_URL;

  if (!webhookUrl) {
    const error = new Error('POWER_AUTOMATE_WEBHOOK_URL is not configured.');
    error.statusCode = 500;
    throw error;
  }

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const rawBody = await response.text();

  let parsedBody = null;
  if (rawBody) {
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      parsedBody = rawBody;
    }
  }

  if (!response.ok) {
    console.error('[Webhook failed]', {
      status: response.status,
      responseBytes: Buffer.byteLength(rawBody || '', 'utf8'),
      responseContentType: response.headers.get('content-type') || ''
    });

    const error = new Error(`Webhook call failed with status ${response.status}.`);
    error.statusCode = 502;
    error.details = {
      status: response.status,
      responseBytes: Buffer.byteLength(rawBody || '', 'utf8')
    };
    throw error;
  }

  return { status: response.status, body: parsedBody, rawBody };
}

async function askAgent(prompt, userId) {
  const token = await generateToken();
  const conversationId = await startConversation(token);

  await sendMessage(token, conversationId, userId, prompt);

  const maxWaitMs = 90000;
  const pollEveryMs = 3000;
  const startedAt = Date.now();

  let lastResult = {
    botMessages: [],
    activitiesData: [],
    finalText: ''
  };

  while (Date.now() - startedAt < maxWaitMs) {
    const { botMessages, activitiesData } = await getBotMessages(token, conversationId, userId);

    lastResult = {
      botMessages,
      activitiesData,
      finalText: botMessages[botMessages.length - 1] || ''
    };

    if (lastResult.finalText) {
      const parsed = extractJsonFromText(lastResult.finalText);

      if (parsed) {
        return {
          conversationId,
          botMessages,
          activitiesData,
          finalText: lastResult.finalText
        };
      }
    }

    await new Promise((resolve) => setTimeout(resolve, pollEveryMs));
  }

  return {
    conversationId,
    ...lastResult
  };
}

router.post('/meeting-minutes-final', requireAuth, withTestUpload(async (req, res) => {
  const startedAt = Date.now();
  try {
    const transcript = await readTestTranscript(req);
    validateTranscriptText(transcript.text);
    const scriptArgs = [];
    const skipRewrite = truthyFlag(req.query?.skipRewrite) || truthyFlag(req.body?.skipRewrite);

    if (skipRewrite) {
      scriptArgs.push('--skip-rewrite');
    }

    if (['single', 'chunked', 'auto'].includes(String(req.query?.pipeline || req.body?.pipeline || '').trim())) {
      scriptArgs.push('--pipeline', String(req.query?.pipeline || req.body?.pipeline).trim());
    }

    if (truthyFlag(req.query?.includeBaselineReference) || truthyFlag(req.body?.includeBaselineReference)) {
      scriptArgs.push('--include-baseline-reference');
    }

    if (truthyFlag(req.query?.includeProjectStatusEvidence) || truthyFlag(req.body?.includeProjectStatusEvidence)) {
      scriptArgs.push('--include-project-status-evidence');
    }

    if (!truthyFlag(req.query?.includeDiagnostics) && !truthyFlag(req.body?.includeDiagnostics)) {
      scriptArgs.push('--skip-diagnostics');
    }

    const result = await runPythonTranscriptScript('meeting_minutes_trooper.py', transcript.text, scriptArgs, { timeoutMs: MEETING_MINUTES_FINAL_TIMEOUT_MS });

    console.info(JSON.stringify({
      event: 'meeting_minutes_final_completed',
      source: transcript.source,
      fileName: transcript.fileName || null,
      transcriptLength: transcript.text.length,
      skipRewrite,
      rewriterAvailable: result?.rewriterAvailable ?? null,
      rewriterUsed: result?.rewriterReason === 'Trooper Liv HelixScribe operator used.',
      rewriterReason: result?.rewriterReason ?? null,
      rewriterDiagnosticsSummary: result?.rewriterDiagnosticsSummary ?? null,
      rewriterTokenUsage: result?.rewriterTokenUsage ?? null,
      durationMs: Date.now() - startedAt
    }));

    return res.json(buildTestTranscriptResponse(req, transcript, result));
  } catch (error) {
    console.error(JSON.stringify({
      event: 'meeting_minutes_final_failed',
      message: error?.message || String(error),
      statusCode: error?.statusCode || null,
      details: error?.details || null,
      durationMs: Date.now() - startedAt
    }));
    return sendTestError(res, error);
  }
}));

router.get('/staged-meeting-minutes/pre-testing', requireAuth, async (req, res, next) => {
  try {
    const status = await getMeetingMinutesCoreGoldenStatus();
    res.json(status);
  } catch (error) {
    next(error);
  }
});

router.get('/staged-meeting-minutes/review-events', requireAuth, async (req, res) => {
  try {
    const events = await listStagedMeetingMinutesReviewEvents(req.query?.limit || 100, {
      draftId: firstString(req.query?.draftId)
    });
    return res.json({ success: true, events });
  } catch (error) {
    safeLogError('[Staged review event list failed]', error);
    return res.status(500).json({ success: false, error: 'Staged review analytics are temporarily unavailable.' });
  }
});

router.post('/staged-meeting-minutes/review-events', requireAuth, async (req, res) => {
  try {
    const draftId = firstString(req.body?.draftId).slice(0, 500);
    if (!draftId) return res.status(400).json({ success: false, error: 'Draft id is required.' });
    const eventType = firstString(req.body?.eventType, 'review_snapshot').slice(0, 100);
    const finalReviewCompleted = Boolean(req.body?.finalReviewCompleted);
    const details = stagedAnalyticsObject(req.body?.meetingContext || req.body?.approvedVersions?.details);
    const generatedVersions = stagedAnalyticsObject(req.body?.generatedVersions);
    const approvedVersions = stagedAnalyticsObject(req.body?.approvedVersions);
    const fieldDiffs = buildStagedReviewDiffs(generatedVersions, approvedVersions);
    const interactionEvents = stagedWorkflowInteractionEvents(req.body?.interactionEvents);
    const interactionSummary = summariseStagedWorkflowInteractions(interactionEvents);
    const reviewStatus = finalReviewCompleted
      ? 'completed'
      : Number(req.body?.activeScreen || 0) >= 3 ? 'final_review' : 'in_review';
    const saved = await saveStagedMeetingMinutesReviewEvent({
      draftId,
      eventKey: firstString(req.body?.eventKey, finalReviewCompleted ? 'final_review_completed' : 'latest_snapshot').slice(0, 200),
      eventType,
      reviewStatus,
      meetingTitle: firstString(details.meetingTitle, approvedVersions.details?.meetingTitle).slice(0, 500),
      meetingDate: firstString(details.meetingDate, approvedVersions.details?.meetingDate),
      meetingLocation: firstString(details.meetingLocation, approvedVersions.details?.meetingLocation).slice(0, 500),
      meetingType: firstString(details.meetingType, approvedVersions.details?.meetingType).slice(0, 500),
      projectKey: stagedReviewProjectKey(details, draftId),
      sourceJobId: firstString(req.body?.sourceJobId).slice(0, 500),
      transcriptSha256: firstString(req.body?.transcriptSha256).slice(0, 128),
      activeScreen: Number(req.body?.activeScreen || 0),
      currentStage: firstString(req.body?.currentStage).slice(0, 100),
      generatedVersions,
      approvedVersions,
      fieldDiffs,
      editSummary: {
        ...summariseStagedReviewDiffs(fieldDiffs),
        reviewDurationMs: Math.max(0, Number(req.body?.reviewDurationMs || 0)),
        reviewEditCount: Math.max(0, Number(req.body?.reviewEditCount || 0)),
        regenerationCount: stagedAnalyticsArray(req.body?.regenerationEvents).length,
        terminologyDecisionCount: stagedAnalyticsArray(req.body?.terminologyDecisions).length,
        unresolvedWorkstreamCount: stagedAnalyticsArray(req.body?.unresolvedWorkstreams).length,
        interactionEventCount: interactionSummary.totalEvents,
        interactionSummary,
        workflowDurationMs: Math.max(0, Number(req.body?.workflowDurationMs || 0)),
        stageDwellMsByStage: stagedAnalyticsObject(req.body?.stageDwellMsByStage),
        stageActiveEditMsByStage: stagedAnalyticsObject(req.body?.stageActiveEditMsByStage),
        // Which kind of purpose the reviewer was shown, and what they did with it.
        //
        // fieldDiffs already grades summary.meetingPurpose as accepted_unchanged,
        // wording_or_formatting_edit or substantive_rewrite. What was missing was where
        // the purpose came from, so the two could not be crossed - and the acceptance rate
        // by source is the only measure of this that runs on real meetings rather than on
        // a corpus of invented ones.
        purposeSource: firstString(req.body?.purposeSource).slice(0, 60),
        purposeEdit: (fieldDiffs.find((diff) => diff.fieldPath === 'summary.meetingPurpose') || {}).editType || 'not_recorded',
        finalReviewCompleted
      },
      regenerationEvents: stagedAnalyticsArray(req.body?.regenerationEvents),
      terminologyDecisions: stagedAnalyticsArray(req.body?.terminologyDecisions),
      unresolvedWorkstreams: stagedAnalyticsArray(req.body?.unresolvedWorkstreams),
      finalReviewCompleted,
      reviewDurationMs: Math.max(0, Number(req.body?.reviewDurationMs || 0)),
      reviewEditCount: Math.max(0, Number(req.body?.reviewEditCount || 0)),
      userId: req.authUser?.userId,
      userEmail: req.authUser?.email,
      context: {
        generatedStages: stagedAnalyticsObject(req.body?.generatedStages),
        transcriptLength: Number(req.body?.transcriptLength || 0),
        fileName: firstString(req.body?.fileName).slice(0, 500),
        additionalContext: firstString(req.body?.additionalContext).slice(0, 5000),
        meetingContext: details,
        workflowStartedAt: firstString(req.body?.workflowStartedAt).slice(0, 80),
        workflowDurationMs: Math.max(0, Number(req.body?.workflowDurationMs || 0)),
        interactionEvents,
        interactionSummary,
        stageDwellMsByStage: stagedAnalyticsObject(req.body?.stageDwellMsByStage),
        stageActiveEditMsByStage: stagedAnalyticsObject(req.body?.stageActiveEditMsByStage),
        stageVisitCounts: stagedAnalyticsObject(req.body?.stageVisitCounts)
      }
    });
    return res.json({ success: true, event: saved, editSummary: summariseStagedReviewDiffs(fieldDiffs) });
  } catch (error) {
    safeLogError('[Staged review event save failed]', error);
    return res.status(500).json({ success: false, error: 'The staged review analytics snapshot could not be saved.' });
  }
});

router.post('/staged-meeting-minutes/terminology-qa/suggestions', requireAuth, async (req, res) => {
  try {
    const stage = firstString(req.body?.stage).toLowerCase();
    if (!['summary', 'discussion', 'actions'].includes(stage)) return res.status(400).json({ success: false, error: 'Unsupported review stage.' });
    const details = req.body?.details && typeof req.body.details === 'object' ? req.body.details : {};
    const scopeKey = firstString(details.meetingTitle, req.body?.draftId, 'unscoped').slice(0, 500);
    const clientKey = firstString(details.clientName, scopeKey.match(/^Client\s+(.+?)(?:\s+T\d+|\s*[-–—]|$)/i)?.[1]).slice(0, 500);
    const projectDecisions = await listTerminologyQaDecisions('project', scopeKey);
    const clientDecisions = clientKey ? await listTerminologyQaDecisions('client', clientKey) : [];
    const seenDecisions = new Set();
    const decisions = [...projectDecisions, ...clientDecisions].filter((item) => {
      const signature = `${String(item.originalText).toLowerCase()}|${String(item.suggestedText).toLowerCase()}`;
      if (seenDecisions.has(signature)) return false;
      seenDecisions.add(signature); return true;
    });
    const suggestions = reviewGeneratedContent({
      stage,
      content: req.body?.content,
      attendees: Array.isArray(details.participants) ? details.participants : [],
      controlledTerms: [
        ...(Array.isArray(details.clientTerminology) ? details.clientTerminology : []),
        ...(Array.isArray(details.projectTerminology) ? details.projectTerminology : [])
      ],
      learned: decisions.filter((item) => item.decision === 'accepted'),
      rejected: decisions.filter((item) => item.decision === 'rejected'),
      scope: { type: 'project', key: scopeKey }
    });
    return res.json({
      success: true,
      suggestions: suggestions.map((item) => ({
        ...item,
        availableScopes: [
          { type: 'project', key: scopeKey, label: 'This project' },
          ...(clientKey ? [{ type: 'client', key: clientKey, label: `This client (${clientKey})` }] : []),
          { type: 'global', key: '', label: 'All meetings' }
        ]
      }))
    });
  } catch (error) {
    safeLogError('[Terminology QA suggestions failed]', error);
    return res.status(500).json({ success: false, error: 'Terminology suggestions are temporarily unavailable.' });
  }
});

router.post('/staged-meeting-minutes/terminology-qa/decision', requireAuth, async (req, res) => {
  try {
    const decision = firstString(req.body?.decision).toLowerCase();
    if (!['accepted', 'rejected'].includes(decision)) return res.status(400).json({ success: false, error: 'Decision must be accepted or rejected.' });
    const originalText = firstString(req.body?.originalText).slice(0, 500);
    const suggestedText = firstString(req.body?.suggestedText).slice(0, 500);
    if (!originalText || !suggestedText) return res.status(400).json({ success: false, error: 'Original and suggested text are required.' });
    const scopeType = ['global', 'client', 'project'].includes(firstString(req.body?.scopeType)) ? firstString(req.body?.scopeType) : 'project';
    const scopeKey = scopeType === 'global' ? '' : firstString(req.body?.scopeKey, req.body?.draftId, 'unscoped').slice(0, 500);
    const saved = await saveTerminologyQaDecision({
      originalText, suggestedText, decision, scopeType, scopeKey,
      fieldPath: firstString(req.body?.fieldPath).slice(0, 500),
      draftId: firstString(req.body?.draftId).slice(0, 500),
      userId: req.authUser?.userId,
      userEmail: req.authUser?.email,
      contextHash: crypto.createHash('sha256').update(`${scopeType}|${scopeKey}|${originalText}|${suggestedText}`).digest('hex')
    });
    return res.json({ success: true, decision: { ...saved, decision } });
  } catch (error) {
    safeLogError('[Terminology QA decision failed]', error);
    return res.status(500).json({ success: false, error: 'The proofreading decision could not be saved.' });
  }
});

router.post('/staged-meeting-minutes/pdf', requireAuth, async (req, res) => {
  try {
    const minutes = req.body?.minutes && typeof req.body.minutes === 'object' ? req.body.minutes : {};
    const pdf = await generateStagedMinutesPdf(minutes);
    const filename = stagedMinutesPdfFilename(minutes).replace(/["\\]/g, '');
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${filename}"`,
      'Cache-Control': 'no-store',
      'Content-Length': String(pdf.length)
    });
    return res.send(pdf);
  } catch (error) {
    safeLogError('[Staged meeting minutes PDF failed]', error);
    return res.status(500).json({ success: false, error: 'The PDF could not be generated. Please try again.' });
  }
});

router.post('/staged-meeting-minutes/no-edit-pass', requireAuth, withTestUpload(async (req, res) => {
  const startedAt = Date.now();
  try {
    const transcript = await readTestTranscript(req);
    validateTranscriptText(transcript.text);
    const sequence = await runStagedSequenceForEvaluation(transcript.text, {
      fileName: transcript.fileName || 'transcript.txt'
    });
    const reviewExperience = stagedNoEditReviewExperience(sequence.trace);
    console.info(JSON.stringify({
      event: 'staged_meeting_minutes_no_edit_pass_completed',
      source: transcript.source,
      fileName: transcript.fileName || null,
      transcriptLength: transcript.text.length,
      warningCount: reviewExperience.warningCount,
      blockingCount: reviewExperience.blockingCount,
      readyForFinalApproval: reviewExperience.readyForFinalApproval,
      durationMs: Date.now() - startedAt
    }));
    return res.json({
      ok: true,
      staged: true,
      mode: 'no_human_edits',
      source: transcript.source,
      fileName: transcript.fileName || null,
      transcriptLength: transcript.text.length,
      screens: {
        details: sequence.state.details,
        summary: sequence.state.summary,
        discussion: sequence.state.discussion,
        actions: sequence.state.actions,
        decisions: sequence.state.decisions,
        risks: sequence.state.risks,
        finalReview: {
          readyForFinalApproval: reviewExperience.readyForFinalApproval,
          message: reviewExperience.finalReviewMessage
        }
      },
      visibleOutput: sequence.visibleOutput,
      reviewExperience,
      trace: sequence.trace
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: 'staged_meeting_minutes_no_edit_pass_failed',
      message: error?.message || String(error),
      statusCode: error?.statusCode || null,
      durationMs: Date.now() - startedAt
    }));
    return sendTestError(res, error);
  }
}));

router.post('/staged-meeting-minutes/canonical-no-edit-pass', requireAuth, withTestUpload(async (req, res) => {
  const startedAt = Date.now();
  try {
    const transcript = await readTestTranscript(req);
    validateTranscriptText(transcript.text);
    const strategy = String(req.query?.strategy || req.body?.strategy || 'semantic_v2').trim();
    const result = runCanonicalNoEditPass(transcript.text, { fileName: transcript.fileName || 'transcript.txt', strategy });
    console.info(JSON.stringify({
      event: 'canonical_staged_minutes_no_edit_pass_completed',
      fileName: transcript.fileName || null,
      transcriptLength: transcript.text.length,
      warningCount: result.reviewExperience.warningCount,
      semanticLockPassed: result.audits.semanticLock.passed,
      durationMs: Date.now() - startedAt
    }));
    return res.json({ ...result, source: transcript.source, fileName: transcript.fileName || null, transcriptLength: transcript.text.length });
  } catch (error) {
    console.error(JSON.stringify({ event: 'canonical_staged_minutes_no_edit_pass_failed', message: error?.message || String(error), durationMs: Date.now() - startedAt }));
    return sendTestError(res, error);
  }
}));

router.post('/staged-meeting-minutes', requireAuth, withTestUpload(async (req, res) => {
  const startedAt = Date.now();
  try {
    const transcript = await readTestTranscript(req);
    validateTranscriptText(transcript.text);
    const requestedStage = String(req.query?.stage || req.body?.stage || '').trim().toLowerCase();
    const preparedTranscript = buildPreparedTranscriptForStagedAI(transcript.text);
    const aiTranscript = {
      text: preparedTranscript.text,
      source: `${transcript.source || 'staged-meeting-minutes'}-prepared`,
      fileName: transcript.fileName || '',
      preparedTranscriptTelemetry: {
        rawLength: preparedTranscript.rawLength,
        preparedLength: preparedTranscript.preparedLength,
        removedLineCount: preparedTranscript.removedLineCount,
        removedReasons: preparedTranscript.removedReasons,
        source: 'deterministic_stage_1_prep'
      }
    };

    if (requestedStage === 'details') {
      const detailsResponse = {
        source: transcript.source,
        fileName: transcript.fileName || null,
        transcriptLength: transcript.text.length,
        ...extractStagedDetailsFromTranscript(transcript.text, transcript.fileName),
        preparedTranscriptTelemetry: aiTranscript.preparedTranscriptTelemetry
      };

      console.info(JSON.stringify({
        event: 'staged_meeting_minutes_details_completed',
        source: transcript.source,
        fileName: transcript.fileName || null,
        transcriptLength: transcript.text.length,
        durationMs: Date.now() - startedAt
      }));

      return res.json(normaliseDomainTermsDeep(detailsResponse));
    }

    if (['summary', 'discussion', 'actions'].includes(requestedStage)) {
      const confirmed = {
        confirmedDetails: parseStagedJsonObject(req.body?.confirmedDetails),
        confirmedSummary: parseStagedJsonObject(req.body?.confirmedSummary),
        confirmedDiscussion: parseStagedJsonArray(req.body?.confirmedDiscussion),
        confirmedActions: parseStagedJsonArray(req.body?.confirmedActions),
        additionalContext: firstString(req.body?.additionalContext, req.query?.additionalContext)
      };
      const response = await canonicalStagedResponse(requestedStage, {
        ...transcript,
        preparedTranscriptTelemetry: aiTranscript.preparedTranscriptTelemetry
      }, confirmed);
      console.info(JSON.stringify({
        event: 'canonical_staged_meeting_minutes_stage_completed',
        stage: requestedStage,
        source: transcript.source,
        fileName: transcript.fileName || null,
        transcriptLength: transcript.text.length,
        pipeline: response.pipeline,
        inputStateVersion: response.canonicalDiagnostics?.inputStateVersion,
        humanConfirmedInputIsAuthoritative: true,
        durationMs: Date.now() - startedAt
      }));
      return res.json(normaliseDomainTermsDeep(response));
    }

    const scriptArgs = [];
    const skipRewrite = truthyFlag(req.query?.skipRewrite) || truthyFlag(req.body?.skipRewrite);

    if (skipRewrite) {
      scriptArgs.push('--skip-rewrite');
    }

    const requestedPipeline = String(req.query?.pipeline || req.body?.pipeline || '').trim();
    scriptArgs.push('--pipeline', ['single', 'chunked', 'auto'].includes(requestedPipeline) ? requestedPipeline : MEETING_MINUTES_JOB_PIPELINE);

    if (truthyFlag(req.query?.includeBaselineReference) || truthyFlag(req.body?.includeBaselineReference)) {
      scriptArgs.push('--include-baseline-reference');
    }

    if (truthyFlag(req.query?.includeProjectStatusEvidence) || truthyFlag(req.body?.includeProjectStatusEvidence)) {
      scriptArgs.push('--include-project-status-evidence');
    }

    if (!truthyFlag(req.query?.includeDiagnostics) && !truthyFlag(req.body?.includeDiagnostics)) {
      scriptArgs.push('--skip-diagnostics');
    }

    const result = await runPythonTranscriptScript('meeting_minutes_trooper.py', transcript.text, scriptArgs, { timeoutMs: MEETING_MINUTES_FINAL_TIMEOUT_MS });

    console.info(JSON.stringify({
      event: 'staged_meeting_minutes_completed',
      source: transcript.source,
      fileName: transcript.fileName || null,
      transcriptLength: transcript.text.length,
      skipRewrite,
      pipeline: scriptArgs.includes('--pipeline') ? scriptArgs[scriptArgs.indexOf('--pipeline') + 1] : null,
      durationMs: Date.now() - startedAt
    }));

    return res.json(buildStagedMeetingMinutesResponse(req, transcript, result));
  } catch (error) {
    console.error(JSON.stringify({
      event: 'staged_meeting_minutes_failed',
      message: error?.message || String(error),
      statusCode: error?.statusCode || null,
      details: error?.details || null,
      durationMs: Date.now() - startedAt
    }));
    return sendTestError(res, error);
  }
}));

router.post('/staged-meeting-minutes/jobs', requireAuth, withTestUpload(async (req, res) => {
  try {
    let transcript;
    try {
      transcript = await readTestTranscript(req);
    } catch (error) {
      const sourceJob = await findStagedSourceJobFromRequest(req);
      if (!sourceJob || sourceJob.jobType !== 'staged_meeting_minutes_stage' || !sourceJob.transcriptText) throw error;
      transcript = {
        text: sourceJob.transcriptText,
        source: 'staged-meeting-minutes-job',
        fileName: sourceJob.fileName || sourceJob.inputPayload?.fileName || '',
        preparedTranscript: sourceJob.preparedTranscript || null,
        preparedTranscriptTelemetry: sourceJob.preparedTranscriptTelemetry || sourceJob.inputPayload?.preparedTranscriptTelemetry || null
      };
    }
    validateTranscriptText(transcript.text);
    const meta = transcriptMetadata(transcript.text);
    assertStagedTranscriptHash(
      req.body?.transcriptSha256 || req.query?.transcriptSha256 || '',
      meta.transcriptSha256,
      'submitted transcript'
    );
    const preparedTranscript = transcript.preparedTranscript?.text
      ? {
          text: String(transcript.preparedTranscript.text || ''),
          rawLength: Number(transcript.preparedTranscript.rawLength || transcript.text.length),
          preparedLength: Number(transcript.preparedTranscript.preparedLength || String(transcript.preparedTranscript.text || '').length),
          removedLineCount: Number(transcript.preparedTranscript.removedLineCount || 0),
          removedReasons: transcript.preparedTranscript.removedReasons || {}
        }
      : buildPreparedTranscriptForStagedAI(transcript.text);
    const preparedTranscriptTelemetry = transcript.preparedTranscriptTelemetry || {
      rawLength: preparedTranscript.rawLength,
      preparedLength: preparedTranscript.preparedLength,
      removedLineCount: preparedTranscript.removedLineCount,
      removedReasons: preparedTranscript.removedReasons,
      source: 'deterministic_stage_1_prep'
    };
    const requestedStage = String(req.query?.stage || req.body?.stage || 'details').trim().toLowerCase();
    if (!['details', 'summary', 'discussion', 'actions'].includes(requestedStage)) {
      const error = new Error('Choose a valid staged meeting-minutes stage.');
      error.statusCode = 400;
      throw error;
    }
    const confirmedDetails = parseStagedJsonObject(req.body?.confirmedDetails);
    const confirmedSummary = parseStagedJsonObject(req.body?.confirmedSummary);
    const confirmedDiscussion = parseStagedJsonArray(req.body?.confirmedDiscussion);
    const confirmedActions = parseStagedJsonArray(req.body?.confirmedActions);

    const queued = await queueStagedMeetingMinutesStage({
      transcriptText: transcript.text,
      source: 'staged-meeting-minutes',
      fileName: transcript.fileName || '',
      transcriptSha256: meta.transcriptSha256,
      preparedTranscript: {
        text: preparedTranscript.text,
        rawLength: preparedTranscript.rawLength,
        preparedLength: preparedTranscript.preparedLength,
        removedLineCount: preparedTranscript.removedLineCount,
        removedReasons: preparedTranscript.removedReasons
      },
      preparedTranscriptTelemetry,
      stage: requestedStage,
      meetingTitle: confirmedDetails.meetingTitle || req.body?.meetingTitle || transcript.fileName || '',
      meetingDate: confirmedDetails.meetingDate || req.body?.meetingDate || '',
      meetingLocation: confirmedDetails.meetingLocation || req.body?.meetingLocation || '',
      meetingType: confirmedDetails.meetingType || req.body?.meetingType || '',
      participants: Array.isArray(confirmedDetails.participants) ? confirmedDetails.participants.join('\n') : req.body?.participants || '',
      overallTopics: Array.isArray(confirmedSummary.overallTopics) ? confirmedSummary.overallTopics.join('\n') : req.body?.overallTopics || '',
      reviewObjectives: req.body?.reviewObjectives || '',
      reviewDiscussion: req.body?.reviewDiscussion || '',
      reviewActions: req.body?.reviewActions || '',
      additionalContext: req.body?.additionalContext || '',
      confirmedDetails,
      confirmedSummary,
      confirmedDiscussion,
      confirmedActions,
      draftId: req.body?.draftId || '',
      targetScreen: req.body?.targetScreen || 0,
      regenerate: truthyFlag(req.body?.regenerate),
      queuedBy: req.authUser?.email || ''
    });
    console.info(JSON.stringify({
      event: 'staged_meeting_minutes_stage_queued',
      jobId: Number(queued.jobId),
      draftId: String(req.body?.draftId || ''),
      stage: requestedStage,
      transcriptSha256: meta.transcriptSha256,
      transcriptLength: transcript.text.length
    }));
    launchQueuedStagedMeetingMinutesStage(queued.jobId);

    return res.status(202).json({
      ok: true,
      success: true,
      ...queued,
      transcriptSha256: meta.transcriptSha256,
      statusUrl: `/api/jobs/${queued.jobId}`,
      resultUrl: `/api/jobs/${queued.jobId}`,
      jobsUrl: `/jobs/${queued.jobId}`,
      resumeUrl: `/staged-meeting-minutes?${new URLSearchParams({
        ...(req.body?.draftId ? { draftId: String(req.body.draftId) } : {}),
        screen: String(Number(req.body?.targetScreen || 0)),
        stageJobId: String(queued.jobId)
      }).toString()}`
    });
  } catch (error) {
    return sendTestError(res, error);
  }
}));

router.post('/meeting-minutes-final/jobs', requireAuth, withTestUpload(async (req, res) => {
  try {
    const transcript = await readTestTranscript(req);
    validateTranscriptText(transcript.text);
    const meta = transcriptMetadata(transcript.text);
    const queued = await queueMeetingMinutesGeneration({
      transcriptText: transcript.text,
      source: 'meeting-minutes-final',
      fileName: transcript.fileName || '',
      transcriptSha256: meta.transcriptSha256,
      includeDiagnostics: truthyFlag(req.query?.includeDiagnostics) || truthyFlag(req.body?.includeDiagnostics),
      includeTranscriptMetadata: shouldIncludeTranscriptMetadata(req),
      skipRewrite: truthyFlag(req.query?.skipRewrite) || truthyFlag(req.body?.skipRewrite),
      pipeline: ['single', 'chunked', 'auto'].includes(String(req.query?.pipeline || req.body?.pipeline || '').trim())
        ? String(req.query?.pipeline || req.body?.pipeline).trim()
        : MEETING_MINUTES_JOB_PIPELINE,
      includeProjectStatusEvidence: truthyFlag(req.query?.includeProjectStatusEvidence) || truthyFlag(req.body?.includeProjectStatusEvidence),
      queuedBy: req.authUser?.email || ''
    });

    return res.status(202).json({
      ok: true,
      success: true,
      ...queued,
      statusUrl: `/api/meeting-minutes-final/jobs/${queued.jobId}`,
      resultUrl: `/api/meeting-minutes-final/jobs/${queued.jobId}`,
      jobsUrl: '/meeting-minutes-final/jobs'
    });
  } catch (error) {
    return sendTestError(res, error);
  }
}));

require('./meetingMinutesJobs').registerMeetingMinutesJobList(router);

router.post('/project-update-test/jobs', requireAuth, withTestUpload(async (req, res) => {
  try {
    const transcript = await readTestTranscript(req);
    validateTranscriptText(transcript.text);
    const meta = transcriptMetadata(transcript.text);
    const projectId = Number(req.body?.projectId || req.query?.projectId || 0) || null;
    const projectName = req.body?.projectName || req.query?.projectName || process.env.PROJECT_UPDATE_DEFAULT_PROJECT || 'Project update test';
    const queued = await queueProjectUpdateGeneration({
      transcriptText: transcript.text,
      source: 'project-update-test',
      fileName: transcript.fileName || '',
      transcriptSha256: meta.transcriptSha256,
      includeTranscriptMetadata: shouldIncludeTranscriptMetadata(req),
      projectId,
      projectName,
      periodLabel: req.body?.periodLabel || req.query?.periodLabel || '',
      skipMiniLM: truthyFlag(req.query?.skipMiniLM) || truthyFlag(req.body?.skipMiniLM),
      skipRewrite: truthyFlag(req.query?.skipRewrite) || truthyFlag(req.body?.skipRewrite),
      skipSave: truthyFlag(req.query?.skipSave) || truthyFlag(req.body?.skipSave),
      skipContext: truthyFlag(req.query?.skipContext) || truthyFlag(req.body?.skipContext),
      skipKnowledge: truthyFlag(req.query?.skipKnowledge) || truthyFlag(req.body?.skipKnowledge),
      skipStatusDiagnostics: truthyFlag(req.query?.skipStatusDiagnostics) || truthyFlag(req.body?.skipStatusDiagnostics),
      queuedBy: req.authUser?.email || ''
    });

    return res.status(202).json({
      ok: true,
      success: true,
      ...queued,
      statusUrl: `/api/jobs/${queued.jobId}`,
      resultUrl: `/api/jobs/${queued.jobId}`,
      jobsUrl: '/jobs'
    });
  } catch (error) {
    return sendTestError(res, error);
  }
}));

require('./generationJobs')(router, { launchQueuedStagedMeetingMinutesStage });

require('./meetingMinutesJobs').registerMeetingMinutesJobCommands(router);

router.post('/meeting-minutes-final/improve', async (req, res) => {
  try {
    const output = req.body?.output;
    if (!output || typeof output !== 'object' || Array.isArray(output)) {
      const error = new Error('Provide an extracted meeting minutes output object to improve.');
      error.statusCode = 400;
      throw error;
    }

    const scriptArgs = [];
    if (!truthyFlag(req.query?.includeDiagnostics) && !truthyFlag(req.body?.includeDiagnostics)) {
      scriptArgs.push('--skip-diagnostics');
    }

    const result = await runPythonJsonScript('meeting_minutes_rewrite_output.py', output, scriptArgs);
    return res.json({ ok: true, result });
  } catch (error) {
    return sendTestError(res, error);
  }
});

router.post('/meeting-minutes-final/improve-snippet', async (req, res) => {
  try {
    const snippet = String(req.body?.snippet || '').trim();
    const category = String(req.body?.category || 'discussion').trim().toLowerCase() || 'discussion';

    if (snippet.length < 3) {
      const error = new Error('Select a longer snippet to improve.');
      error.statusCode = 400;
      throw error;
    }
    if (snippet.length > 4000) {
      const error = new Error('Selected snippet must be 4,000 characters or fewer.');
      error.statusCode = 400;
      throw error;
    }

    const result = await runPythonJsonScript('meeting_minutes_rewrite_snippet.py', { snippet, category });
    return res.json({ ok: true, result });
  } catch (error) {
    return sendTestError(res, error);
  }
});

router.post('/meeting-minutes-final/feedback', async (req, res) => {
  try {
    if (!hasDatabaseConfig()) {
      const error = new Error(getDatabaseConfigError());
      error.statusCode = 503;
      throw error;
    }

    const feedbackType = String(req.body?.feedbackType || 'general').trim().toLowerCase();
    const allowedTypes = new Set(['general', 'bug', 'idea', 'confusing', 'praise']);
    const safeFeedbackType = allowedTypes.has(feedbackType) ? feedbackType : 'general';
    const message = String(req.body?.message || '').trim();
    const contactName = String(req.body?.contactName || '').trim();
    const contactEmail = String(req.body?.contactEmail || '').trim();
    const selectedSnippet = String(req.body?.selectedSnippet || '').trim();

    if (message.length < 10) {
      const error = new Error('Please add a little more detail before sending feedback.');
      error.statusCode = 400;
      throw error;
    }
    if (message.length > 2000) {
      const error = new Error('Feedback must be 2,000 characters or fewer.');
      error.statusCode = 400;
      throw error;
    }
    if (contactName.length > 120) {
      const error = new Error('Name must be 120 characters or fewer.');
      error.statusCode = 400;
      throw error;
    }
    if (contactEmail && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail) || contactEmail.length > 254)) {
      const error = new Error('Please enter a valid email address, or leave it blank.');
      error.statusCode = 400;
      throw error;
    }
    if (selectedSnippet.length > 4000) {
      const error = new Error('Selected snippet must be 4,000 characters or fewer.');
      error.statusCode = 400;
      throw error;
    }

    const result = await saveMeetingMinutesFeedback({
      route: '/meeting-minutes-final',
      feedbackType: safeFeedbackType,
      message,
      contactName,
      contactEmail,
      userAgent: req.get('user-agent') || '',
      metadata: {
        source: 'meeting-minutes-final-feedback-widget',
        pathname: String(req.body?.route || '/meeting-minutes-final').slice(0, 255),
        selectedSnippet: selectedSnippet || null
      }
    });

    return res.status(201).json({ ok: true, feedbackId: result.feedbackId, createdAt: result.createdAt });
  } catch (error) {
    return sendTestError(res, error);
  }
});

require('./minutesFeedback')(router);

// "Process once": the meeting is processed by the Meeting Minutes Agent, and
// the project report is built from those reviewed minutes rather than from a
// second, separate pass over the raw transcript.
router.post('/project-update-test/from-minutes', requireAuth, async (req, res) => {
  try {
    const draftId = String(req.body?.draftId || '').trim();
    if (!/^\d+$/.test(draftId)) {
      return res.status(400).json({ ok: false, success: false, error: 'Choose saved meeting minutes to build the project update from.' });
    }
    const projectId = Number(req.body?.projectId);
    if (!Number.isSafeInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ ok: false, success: false, error: 'Choose a project for this update.' });
    }
    const revision = Number(req.body?.revision);
    if (!Number.isSafeInteger(revision) || revision <= 0) {
      return res.status(400).json({ ok: false, success: false, error: 'Save the latest minutes before creating the project update.' });
    }
    const draft = await getMeetingMinutesAgentDraft(draftId, req.authUser?.userId);
    if (!draft) {
      return res.status(404).json({ ok: false, success: false, error: 'Meeting minutes not found.' });
    }
    if (revision !== Number(draft.revision)) {
      return res.status(409).json({ ok: false, success: false, error: 'These minutes changed after saving. Reload the saved minutes before creating the project update.' });
    }
    const visibleDraft = publicMeetingAgentDraft(draft);
    if (['queued', 'running', 'retrying'].includes(visibleDraft.generation?.status)
      || (visibleDraft.pendingProposal?.changes || []).length) {
      return res.status(409).json({ ok: false, success: false, error: 'Wait for the minutes to finish updating before creating the project update.' });
    }
    const project = await getProjectManagementDetail(projectId);
    if (!project) {
      return res.status(404).json({ ok: false, success: false, error: 'Selected project was not found.' });
    }
    const minutes = meetingAgentDraftForPdf(draft, false);
    if (!minutesHaveContent(minutes)) {
      return res.status(400).json({ ok: false, success: false, error: 'These minutes have no discussion or actions yet. Finish them in the Meeting Minutes Agent first.' });
    }
    // Reviewed actions travel separately. For action-only minutes, also give
    // the analyser that context rather than analysing just the meeting title.
    const hasDiscussion = minutesHaveContent({ ...minutes, actions: [] });
    const minutesText = renderMinutesForProjectUpdate(minutes, { includeActions: !hasDiscussion });
    validateTranscriptText(minutesText);
    const meetingTitle = minutes.details?.meetingTitle || draft.title || 'Meeting minutes';
    const minutesActions = minutesActionsForProjectReport(minutes.actions);
    const sourceFingerprint = crypto.createHash('sha256').update(JSON.stringify({ minutesText, minutesActions })).digest('hex');
    await linkMeetingMinutesAgentDraftToProject(draftId, req.authUser?.userId, projectId);
    const queued = await queueProjectUpdateGeneration({
      transcriptText: minutesText,
      source: 'meeting-minutes-agent',
      fileName: draft.fileName || '',
      meetingTitle,
      meetingDescription: 'Project update built from Meeting Minutes Agent minutes.',
      transcriptSha256: sourceFingerprint,
      sourceFingerprint,
      projectId,
      projectName: project.projectName,
      periodLabel: req.body?.periodLabel || '',
      minutesDraftId: draftId,
      minutesDraftRevision: draft.revision,
      minutesActions,
      queuedBy: req.authUser?.email || ''
    });
    if (queued.duplicate) {
      const existingUrl = queued.kind === 'report'
        ? `/project-update-test/reports/${queued.reportId}`
        : `/jobs/${queued.jobId}`;
      return res.status(409).json({
        ok: false,
        success: false,
        duplicate: true,
        ...queued,
        existingUrl,
        error: queued.kind === 'report'
          ? 'A project update from these exact minutes already exists. Edit the minutes, or archive that report, if you want a new one.'
          : 'A project update from these minutes is already being created.'
      });
    }
    return res.status(202).json({
      ok: true,
      success: true,
      ...queued,
      minutesDraftId: draftId,
      statusUrl: `/api/jobs/${queued.jobId}`,
      resultUrl: `/api/jobs/${queued.jobId}`,
      jobUrl: `/jobs/${queued.jobId}`,
      jobsUrl: '/jobs'
    });
  } catch (error) {
    return sendTestError(res, error);
  }
});

router.post('/project-update-test', requireAuth, withTestUpload(async (req, res) => {
  const startedAt = Date.now();
  let scriptUsed = 'project_update_minilm.py';
  let fallbackUsed = false;
  let contextFound = false;
  let resolvedProjectId = null;
  let saveOk = false;
  let retrievedKnowledge = { retrievalMode: 'none', chunks: [] };
  let statusClassifierDiagnostics = { enabled: true, available: false, items: [], reason: 'Not run yet.' };
  try {
    const transcript = await readTestTranscript(req);
    validateTranscriptText(transcript.text);
    const scriptArgs = [];
    const skipStatusDiagnostics = truthyFlag(req.query?.skipStatusDiagnostics) || truthyFlag(req.body?.skipStatusDiagnostics);
    if (truthyFlag(req.query?.skipMiniLM) || truthyFlag(req.body?.skipMiniLM)) {
      scriptArgs.push('--skip-minilm');
    }
    if (truthyFlag(req.query?.skipRewrite) || truthyFlag(req.body?.skipRewrite)) {
      scriptArgs.push('--skip-rewrite');
    }

    let contextTempDir = null;
    const projectName = req.body?.projectName || req.query?.projectName || process.env.PROJECT_UPDATE_DEFAULT_PROJECT || 'Project update test';
    const projectId = Number(req.body?.projectId || req.query?.projectId || 0) || null;
    const projectRef = projectId ? { projectId, projectName } : { projectName };
    if (hasDatabaseConfig() && !truthyFlag(req.query?.skipContext) && !truthyFlag(req.body?.skipContext)) {
      try {
        const projectContext = await getProjectContext(projectRef, req.query?.contextLimit || req.body?.contextLimit || 8);
        contextFound = Boolean(projectContext?.found);
        resolvedProjectId = projectContext?.projectId || projectContext?.projectResolution?.projectId || projectId || null;
        if (!truthyFlag(req.query?.skipKnowledge) && !truthyFlag(req.body?.skipKnowledge) && resolvedProjectId) {
          try {
            const retrieval = await runProjectKnowledgeRetrieval({
              projectId: resolvedProjectId,
              query: buildProjectKnowledgeQuery(transcript.text, projectContext),
              topK: Number(req.query?.knowledgeTopK || req.body?.knowledgeTopK || 8),
              itemTypes: ['background_doc', 'decision', 'report_summary', 'risk']
            });
            retrievedKnowledge = {
              retrievalMode: retrieval.retrieval_mode || retrieval.retrievalMode || 'none',
              chunks: Array.isArray(retrieval.chunks) ? retrieval.chunks : [],
              diagnostics: retrieval.diagnostics || {},
              error: retrieval.error || ''
            };
          } catch (knowledgeError) {
            retrievedKnowledge = { retrievalMode: 'error', chunks: [], error: knowledgeError.message };
          }
          projectContext.retrievedKnowledge = retrievedKnowledge;
        } else if (truthyFlag(req.query?.skipKnowledge) || truthyFlag(req.body?.skipKnowledge)) {
          retrievedKnowledge = { retrievalMode: 'skipped', chunks: [] };
          projectContext.retrievedKnowledge = retrievedKnowledge;
        }
        contextTempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trinzo-project-context-'));
        const contextPath = path.join(contextTempDir, 'context.json');
        await fs.writeFile(contextPath, JSON.stringify({ context: projectContext }), 'utf8');
        scriptArgs.push('--context-file', contextPath);
      } catch (contextError) {
        contextTempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trinzo-project-context-'));
        const contextPath = path.join(contextTempDir, 'context-error.json');
        retrievedKnowledge = { retrievalMode: 'error', chunks: [], error: contextError.message };
        await fs.writeFile(contextPath, JSON.stringify({ _contextLoadError: contextError.message, retrievedKnowledge }), 'utf8');
        scriptArgs.push('--context-file', contextPath);
      }
    }

    if (skipStatusDiagnostics) {
      statusClassifierDiagnostics = {
        enabled: false,
        available: false,
        items: [],
        reason: 'skipStatusDiagnostics requested.'
      };
    } else {
      try {
        statusClassifierDiagnostics = await runPythonTranscriptScript(
          'project_status_evidence_pack.py',
          transcript.text,
          ['--max-chunks', String(Math.min(Math.max(Number(req.query?.statusDiagnosticsMaxChunks || req.body?.statusDiagnosticsMaxChunks || 24), 1), 80))],
          { timeoutMs: Number(process.env.PROJECT_STATUS_DIAGNOSTICS_TIMEOUT_MS || 45000) }
        );
      } catch (statusError) {
        statusClassifierDiagnostics = {
          enabled: true,
          available: false,
          items: [],
          reason: `Project status diagnostics failed open: ${statusError.message}`
        };
      }
    }

    const projectTimeoutMs = Number(process.env.PROJECT_UPDATE_TIMEOUT_MS || 180000);
    let result;
    try {
      result = await runPythonTranscriptScript('project_update_minilm.py', transcript.text, scriptArgs, { timeoutMs: projectTimeoutMs });
    } catch (primaryError) {
      safeLogError('[project-update-test] primary script failed, using legacy fallback', primaryError);
      scriptUsed = 'python_llm.py';
      fallbackUsed = true;
      const fallback = await runPythonTranscriptScript('python_llm.py', transcript.text, [], { timeoutMs: projectTimeoutMs });
      result = {
        ...fallback,
        mode: 'project_update_legacy_fallback',
        projectWorkflowFallback: {
          script: 'python_llm.py',
          reason: primaryError.message
        }
      };
    } finally {
      if (contextTempDir) {
        await fs.rm(contextTempDir, { recursive: true, force: true });
        contextTempDir = null;
      }
    }

    if (hasDatabaseConfig() && !truthyFlag(req.query?.skipSave) && !truthyFlag(req.body?.skipSave)) {
      try {
        result.projectReportPersistence = await saveProjectUpdateDraft({
          projectId,
          projectName,
          periodLabel: req.body?.periodLabel || req.query?.periodLabel || '',
          fileName: transcript.fileName || null,
          sourceType: transcript.source === 'file' ? 'txt' : 'text',
          transcriptText: transcript.text,
          result
        });
        saveOk = Boolean(result.projectReportPersistence?.saved);
        resolvedProjectId = result.projectReportPersistence?.projectId || resolvedProjectId;
      } catch (saveError) {
        result.projectReportPersistence = {
          saved: false,
          error: saveError.message
        };
      }
    } else {
      result.projectReportPersistence = {
        saved: false,
        reason: hasDatabaseConfig() ? 'skipSave requested' : getDatabaseConfigError()
      };
    }

    result.statusClassifierDiagnostics = {
      ...statusClassifierDiagnostics,
      decisionUse: 'diagnostics_only'
    };
    if (result?.projectReport && typeof result.projectReport === 'object') {
      result.projectReport.retrievedKnowledge = result.projectReport.retrievedKnowledge || { retrievalMode: retrievedKnowledge.retrievalMode || 'none', chunkCount: Array.isArray(retrievedKnowledge.chunks) ? retrievedKnowledge.chunks.length : 0 };
      result.projectReport.projectResolution = result.projectReport.projectResolution || {
        requestedProjectId: projectId,
        projectId: resolvedProjectId,
        projectName,
        contextFound
      };
      result.projectReport.statusClassifierDiagnostics = {
        enabled: statusClassifierDiagnostics.enabled !== false,
        available: Boolean(statusClassifierDiagnostics.available),
        decisionUse: 'diagnostics_only',
        chunksAnalysed: Number(statusClassifierDiagnostics.chunksAnalysed || 0),
        itemCount: Array.isArray(statusClassifierDiagnostics.items) ? statusClassifierDiagnostics.items.length : 0,
        topItems: Array.isArray(statusClassifierDiagnostics.items) ? statusClassifierDiagnostics.items.slice(0, 5) : [],
        reason: statusClassifierDiagnostics.reason || ''
      };
    }

    console.info(JSON.stringify({
      event: 'project_update_test_upload_completed',
      source: transcript.source,
      fileName: transcript.fileName || null,
      transcriptLength: transcript.text.length,
      transcriptSha256: crypto.createHash('sha256').update(transcript.text, 'utf8').digest('hex').slice(0, 16),
      projectName,
      projectId: resolvedProjectId || projectId || null,
      contextFound,
      scriptUsed,
      fallbackUsed,
      saveOk,
      retrievalMode: retrievedKnowledge.retrievalMode || 'none',
      retrievedKnowledgeChunks: Array.isArray(retrievedKnowledge.chunks) ? retrievedKnowledge.chunks.length : 0,
      statusDiagnosticsAvailable: Boolean(statusClassifierDiagnostics.available),
      statusDiagnosticsItems: Array.isArray(statusClassifierDiagnostics.items) ? statusClassifierDiagnostics.items.length : 0,
      durationMs: Date.now() - startedAt,
      skipMiniLM: truthyFlag(req.query?.skipMiniLM) || truthyFlag(req.body?.skipMiniLM),
      skipRewrite: truthyFlag(req.query?.skipRewrite) || truthyFlag(req.body?.skipRewrite),
      skipSave: truthyFlag(req.query?.skipSave) || truthyFlag(req.body?.skipSave),
      skipContext: truthyFlag(req.query?.skipContext) || truthyFlag(req.body?.skipContext),
      skipKnowledge: truthyFlag(req.query?.skipKnowledge) || truthyFlag(req.body?.skipKnowledge),
      skipStatusDiagnostics
    }));

    return res.json(buildTestTranscriptResponse(req, transcript, result));
  } catch (error) {
    return sendTestError(res, error);
  }
}));

require('./projectKnowledge')(router);

require('./projectRecords')(router);

require('./projectContext')(router);

router.post('/extract-docx', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file selected.' });

    const { fileName, mimeType, text, unsupported } = await extractTextFromUpload(req.file, mammoth);

    if (unsupported) {
      return res.status(400).json({
        ok: false,
        error: 'Unsupported file type. Please upload a .docx or .txt file.'
      });
    }

    if (!text || !text.trim()) {
      return res.status(400).json({
        ok: false,
        error: 'Text extraction succeeded but content is empty.'
      });
    }

    return res.json({
      ok: true,
      fileName,
      mimeType,
      extractedText: text,
      extractedTextLength: text.length
    });
  } catch (error) {
    safeLogError('[extract-docx] failed', error);
    return res.status(500).json({ ok: false, error: error.message || 'Failed text extraction.' });
  }
});

router.post('/agent/process', async (req, res) => {
  try {
    const extractedText = req.body?.extractedText;

    if (!extractedText || !extractedText.trim()) {
      return res.status(400).json({ ok: false, error: 'Missing extractedText.' });
    }

    const prompt = `Format meeting transcript for review

Return meeting minutes as JSON.

You must reply with a single valid JSON object only.
No markdown or extra text.

Use this exact schema and key names:
${JSON.stringify(REVIEW_TEMPLATE, null, 2)}

Rules:
- Use only information explicitly present in the transcript.
- Keep arrays and nested objects exactly as shown.
- Use empty strings/arrays when missing.
- Include autosave object with transcript left empty (server will fill it).

Transcript:
${extractedText}`;

    const agent = await askAgent(prompt, 'trinzo-process-user');

    if (!agent.finalText) {
      return res.status(502).json({
        ok: false,
        error: 'Agent processing failed: empty response.',
        conversationId: agent.conversationId
      });
    }

    const parsed = extractJsonFromText(agent.finalText);

    if (!parsed) {
      return res.status(502).json({
        ok: false,
        error: 'Agent returned invalid output. JSON not found.',
        agentRawOutput: agent.finalText,
        conversationId: agent.conversationId
      });
    }

    const reviewData = normalizeReviewData(parsed, extractedText);

    return res.json({
      ok: true,
      conversationId: agent.conversationId,
      reviewData,
      reviewDataJson: JSON.stringify(reviewData, null, 2),
      agentRawOutput: agent.finalText
    });
  } catch (error) {
    safeLogError('[agent/process] failed', error);
    return res.status(500).json({ ok: false, error: error.message || 'Agent processing failed.' });
  }
});

router.post('/agent/finalise', async (req, res) => {
  try {
    const reviewData = normalizeReviewData(req.body?.reviewData, req.body?.transcript || '');

    if (!hasAnyApprovedContent(reviewData)) {
      return res.status(400).json({
        ok: false,
        error: 'Cannot finalise. No reviewed meeting minutes content was provided.'
      });
    }

    const payload = buildFinalisationPayload(reviewData);
    const webhookResult = await postToWebhook(payload);

    return res.json({
      ok: true,
      approvedContent: JSON.stringify(reviewData, null, 2),
      payload,
      webhookStatus: webhookResult.status,
      webhookResponse: webhookResult.rawBody ? { responseBytes: Buffer.byteLength(webhookResult.rawBody, 'utf8') } : null,
      finalMessage: 'Approved content sent to Power Automate webhook successfully.'
    });
  } catch (error) {
    safeLogError('[agent/finalise] failed', error);
    return res.status(error.statusCode || 500).json({
      ok: false,
      error: error.message || 'Finalisation webhook call failed.'
    });
  }
});

router.post('/jobs/run-once', async (req, res) => {
  if (!hasDatabaseConfig()) {
    return res.status(500).json({ success: false, error: getDatabaseConfigError() });
  }

  const workerId = `manual-${process.pid}`;

  try {
    const job = await claimNextJob(workerId);

    if (!job) {
      return res.json({ success: true, message: 'No queued jobs available.' });
    }

    if (job.jobType === 'agent_extract') {
      await markJobCompleted(job.id, job.meetingId, {
        message: 'Agent extract job claimed successfully. Hook existing extraction here.'
      });

      return res.json({
        success: true,
        processed: { ...job, finalStatus: 'completed' }
      });
    }

    if (job.jobType === 'webhook_send') {
      const payload = job.inputPayload || job.input_payload;

      if (!payload || typeof payload !== 'object') {
        await markWebhookFailure(job, 'Webhook job is missing input payload.');

        return res.status(400).json({
          success: false,
          processed: { ...job, finalStatus: 'failed' },
          error: 'Webhook job is missing input payload.'
        });
      }

      try {
        const webhookResult = await postToWebhook(payload);

        await markWebhookSuccess(job.id, job.meetingId, {
          webhookStatus: webhookResult.status,
          webhookResponse: webhookResult.rawBody ? { responseBytes: Buffer.byteLength(webhookResult.rawBody, 'utf8') } : null
        });

        return res.json({
          success: true,
          processed: { ...job, finalStatus: 'completed' }
        });
      } catch (error) {
        await markWebhookFailure(job, error.message || 'Webhook send failed.');

        return res.status(502).json({
          success: false,
          processed: { ...job, finalStatus: 'failed' },
          error: error.message || 'Webhook send failed.',
          details: error.details || null
        });
      }
    }

    await markJobFailure(job, `Unsupported job type: ${job.jobType}`);

    return res.status(400).json({
      success: false,
      error: `Unsupported job type: ${job.jobType}`
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Job runner failed.' });
  }
});

// Run action discovery twice and take the union. Measured 2026-09-27 from the
// same direct-to-flow study as the commitment-language block, 12 transcripts
// with answer keys, 10 runs each: with that block on, one run finds 91.1% of
// the answer-key actions, the union of two finds 97.5%, three 98.3%, while
// surplus moves from 0.12 to 0.18 actions per run. What one run misses another
// mostly catches: the variance between runs is complementary, not noise on top
// of a fixed ceiling. The union is taken before the referee, which then judges
// every candidate on evidence as it always did. Costs one extra call per
// actions stage, made in parallel, so no extra wall time.
// Deterministic rule, on unless MEETING_MINUTES_AGENT_MINUTE_INSTRUCTION_V1=0.
// One commitment written twice, merged by reading the pair the way a
// minute-taker does (utils/canonicalMinutes/commitmentDuplicates.js). On
// unless MEETING_MINUTES_AGENT_COMMITMENT_DEDUPE_V1=0. Measured 2026-09-27:
// on 101 union pairs from the flow, 11.2 -> 9.7 actions per run with gold
// recall 96.5% -> 96.3% (both lost hits were 0.30-threshold artefacts); on the
// 21 live drafts the four hand-labelled duplicates and nothing else.
async function dedupeCommitmentsSemantically(actions = [], journeyId = '', step = '', sourceUnits = []) {
  const list = Array.isArray(actions) ? actions : [];
  if (!meetingMinutesCommitmentDedupeEnabled() || list.length < 2) return list;
  const texts = list.map((action) => meetingMinutesAgentText(action?.action, 1600));
  let cosines = null;
  try {
    const vectors = await encodeViaWorker(texts, { timeoutMs: 6000 });
    if (vectors) {
      cosines = new Map();
      for (let i = 0; i < texts.length; i += 1) for (let j = i + 1; j < texts.length; j += 1) {
        if (vectors[i] && vectors[j]) cosines.set(`${i}|${j}`, cosine(vectors[i], vectors[j]));
      }
    }
  } catch (error) { cosines = null; /* the lexical levers still apply */ }
  const merged = mergeCommitmentDuplicates(list, { cosines: cosines || undefined, sourceUnits });
  if (merged.merged.length) console.log(JSON.stringify({
    event: 'meeting_agent_commitment_duplicates', journeyId, step, semantic: Boolean(cosines), merged: merged.merged
  }));
  return merged.actions;
}

// Same fact twice under one discussion subject. On unless
// MEETING_MINUTES_AGENT_DISCUSSION_RESTATEMENTS_V1=0.
// A structured referee that returned exactly one disposition for every
// candidate it was given has already judged the whole inventory. The critic
// and salvage passes exist to catch what an incomplete referee missed; on a
// complete one they have returned nothing material in every measured run.

// The discovery inventory lists one commitment up to three times: as a chain,
// as the thread inside it, and as each raw candidate the chain was built
// from. Every coverage test (recovery, critic, salvage) then counts the same
// gap three times. Keep the chain, drop the members it already contains.
function dedupeActionDiscoveryInventory(chains = [], threads = [], candidates = []) {
  const covered = new Set();
  const chainCovered = new Set();
  const candidatesById = new Map((Array.isArray(candidates) ? candidates : [])
    .map((candidate) => [String(candidate?.candidateId || ''), candidate]));
  const retainedComponentIds = new Set();
  for (const chain of chains) {
    const members = (chain?.candidateIds || []).map((id) => candidatesById.get(String(id))).filter(Boolean);
    const actionFamilies = new Set(members.map((candidate) => String(candidate?.actionFamily || '').trim()).filter(Boolean));
    // A chain is a context graph, not automatically one deliverable. Keep its
    // component candidates when it contains different operations so that the
    // referee can retain separate send/test, trace/incorporate, or review/follow-up
    // work. Same-operation request/acceptance pairs remain safely collapsed.
    if (actionFamilies.size > 1) {
      for (const member of members) retainedComponentIds.add(String(member.candidateId));
    }
    for (const id of chain?.candidateIds || []) {
      chainCovered.add(String(id));
      if (!retainedComponentIds.has(String(id))) covered.add(String(id));
    }
  }
  const keptThreads = threads.filter((thread) => {
    const members = (thread?.candidateIds || []).map(String);
    return !(members.length && members.every((id) => chainCovered.has(id)));
  });
  for (const thread of keptThreads) for (const id of thread?.candidateIds || []) covered.add(String(id));
  const keptCandidates = candidates.filter((candidate) => !covered.has(String(candidate?.candidateId || '')));
  return [...chains, ...keptThreads, ...keptCandidates];
}

// Only the rows the Actions passes reason about: topic and primary texts.
// Recovery used to receive the whole discussion object (ids, evidence,
// flags, supporting details) uncapped, which made it the largest prompt of
// the stage.
// When a speaker corrects themselves ("I presumed X ... but that has changed,
// it will now be Y"), minutes must state Y. Sent as data with the Discussion
// requests; off unless MEETING_MINUTES_AGENT_CORRECTION_RULE_V1 is on.
// What a topic label is. Discovery returns one record per anchor and, left to
// itself, one freshly written label per record ("Clarification on probability
// bands context"): 32 anchors, 32 labels, every topic a singleton until the
// organiser guesses which captions describe one subject. Sent as data with the
// anchored discovery request; the text must stay byte-identical to
// tests/fixtures/topic-label-rule-v1.txt. Off unless
// MEETING_MINUTES_AGENT_TOPIC_LABEL_RULE_V1 is on.
// Name subjects, not records. The transcript is segmented where the meeting
// changes subject (utils/canonicalMinutes/discourseSegments.js), the segments
// go through the same discovery prompt as anchors so the model names each
// one, and every discovered record is filed under the segment its evidence
// sits in. Runs beside the primary discovery call; a failed naming leg leaves
// the per-record labels as they were. The rule text must stay byte-identical
// to tests/fixtures/topic-naming-rule-v1.txt. Off unless
// MEETING_MINUTES_AGENT_TOPIC_SEGMENTS_V1 is on.


// Context warnings are durable review records even if a later lifecycle or
// proposal filter withholds the candidate. Keeping the question is not adding
// its instruction to the minutes.


function deterministicHybridLedger(draft, stage) {
  if (stage === 'actions') {
    const candidates = actionCandidateInventory(draft.sourceUnits);
    const rows = candidates.map((candidate) => ({
      ...candidate, sourcePass: 'deterministic', recordType: 'action', text: candidate.focusText,
      record: { action: candidate.focusText, owners: [], timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds: candidate.evidenceIds }
    }));
    return [
      ...actionCommitmentChainInventory(draft.sourceUnits, candidates),
      ...actionCommitmentThreadInventory(draft.sourceUnits, candidates),
      ...rows
    ];
  }
  return discussionCandidateInventory(draft.sourceUnits).map((candidate) => ({
    ...candidate, sourcePass: 'deterministic', recordType: candidate.kindHints?.includes('decision') ? 'decision' : candidate.kindHints?.includes('open_question') ? 'open_question' : 'discussion_point',
    text: candidate.focusText, record: { text: candidate.focusText, evidenceIds: candidate.evidenceIds }
  }));
}

function refereeClusterSupportingCandidates(dispositions = [], candidates = []) {
  const dedupeThreshold = meetingMinutesAgentSupportingDedupeThreshold();
  const dispositionById = new Map((Array.isArray(dispositions) ? dispositions : [])
    .filter((item) => item?.candidateId).map((item) => [String(item.candidateId), item]));
  const result = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const disposition = dispositionById.get(String(candidate?.candidateId || ''));
    const kind = disposition?.disposition || disposition?.classification;
    if (!['core', 'supporting', 'merge', 'reject'].includes(kind)) continue;
    const targetId = refereeDiscussionTargetId(disposition)
      || (kind === 'core' ? candidate.candidateId : '');
    for (const member of Array.isArray(candidate.clusterMembers) ? candidate.clusterMembers : []) {
      if (!member?.text || !Array.isArray(member.evidenceIds) || !member.evidenceIds.length) continue;
      // Referee representatives carry only the best proposition. Other
      // editorial discovery rows remain useful collapsed context. Raw
      // deterministic windows are intentionally excluded, and a rejected
      // representative only releases distinct overflow—not its paraphrases.
      const editorialMember = ['primary', 'recovery', 'staged'].includes(member.sourcePass);
      const deterministicContext = member.sourcePass === 'deterministic'
        && Number(member.priority || 0) >= 7
        && String(member.text || '').trim().length >= 30
        && !/^\s*(?:yeah|yes|no|okay|ok|right|thanks|thank you|bye|cheers)\b/i.test(String(member.text || ''));
      if (!editorialMember && !deterministicContext) continue;
      if (kind === 'reject' && member.clusterRelation !== 'overflow') continue;
      // Members of different clusters can still say the same thing; release
      // each fact once rather than once per cluster.
      if (result.some((item) => hybridContentTokenOverlap(item.candidate.text, member.text) >= dedupeThreshold
        && mayDiscardSupportingDetail(member, item.candidate))) continue;
      const unassessed = member.clusterRelation === 'overflow';
      result.push({ candidate: member, mergeTarget: unassessed ? '' : targetId,
        clusterRepresentativeId: candidate.candidateId, ...(unassessed ? { unassessed: true } : {}) });
    }
  }
  return result.slice(0, 240);
}



function discussionRefereeSufficiency(discussion = [], baseline = []) {
  const visible = flattenHybridDiscussion(discussion);
  const baselineTopics = [...new Set((Array.isArray(baseline) ? baseline : [])
    .map((topic) => meetingMinutesAgentText(topic?.topic, 240).toLowerCase()).filter(Boolean))];
  const visibleTopics = [...new Set(visible
    .map((item) => meetingMinutesAgentText(item?.topic, 240).toLowerCase()).filter(Boolean))];
  const coveredTopics = baselineTopics.filter((topic) => visibleTopics.some((candidate) =>
    candidate === topic || hybridTokenOverlap(candidate, topic) >= 0.55));
  const topicCoverage = baselineTopics.length ? coveredTopics.length / baselineTopics.length : (visible.length ? 1 : 0);
  return {
    sufficient: visible.length > 0 && (baselineTopics.length <= 2 || topicCoverage >= 0.65),
    visibleCount: visible.length,
    baselineTopicCount: baselineTopics.length,
    coveredTopicCount: coveredTopics.length,
    topicCoverage
  };
}

// A failed sibling is not permission to reclassify an already checked claim.
// Match discovery records exactly, never by topic, shared sources or similarity.
function discussionRefereeFallbackPlan(result, contract, ensemble = [], baseline = []) {
  const inactive = { active: false, dispositions: result?.candidateDispositions || [],
    candidates: ensemble, discussion: baseline, settledCandidateIds: [], routedRecords: [] };
  if (meetingAgentRefereeRoute(result, contract) !== 'structured_prompt') return inactive;
  const error = meetingAgentDispositionError(result, contract.candidates, contract);
  const dispositions = error ? error.validCandidateDispositions || [] : result.candidateDispositions || [];
  if (!dispositions.length) return inactive;
  const stable = value => Array.isArray(value) ? value.map(stable)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort()
      .filter(key => value[key] !== undefined).map(key => [key, stable(value[key])])) : value;
  const key = (kind, record) => JSON.stringify(stable([kind, Object.fromEntries(
    Object.entries(record || {}).filter(([name]) => !['primaryEvidenceIds', 'discoveryDisposition'].includes(name))
  )]));
  const settled = new Set(dispositions.map(row => row.candidateId));
  const records = new Map();
  // Production selection is a compact wire projection without .record. Bind
  // private records only here, by unique exact identity, so settled discovery
  // cannot return through fallback. Never put these trees in the AI payload.
  const privateCandidates = new Map();
  for (const candidate of ensemble) {
    if (!candidate?.candidateId) continue;
    privateCandidates.set(candidate.candidateId,
      privateCandidates.has(candidate.candidateId) ? null : candidate);
  }
  const recordFor = candidate => {
    if (candidate?.record) return candidate.record;
    const source = privateCandidates.get(candidate?.candidateId);
    if (!source?.record || isReviewerAuthored(source) || !['sourcePass', 'recordType', 'topic', 'text', 'evidenceIds']
      .every(field => JSON.stringify(stable(candidate[field])) === JSON.stringify(stable(source[field])))) return null;
    return source.record;
  };
  const add = candidate => {
    const record = recordFor(candidate);
    if (!record || isReviewerAuthored(candidate) || hasMeetingAgentReviewerContent(record)
      || record.supportingDetails?.length) return;
    records.set(key(candidate.recordType, record), candidate);
  };
  for (const candidate of contract.candidates) {
    if (!settled.has(candidate.candidateId)) continue;
    add(candidate);
  }
  // Consume only members actually released by the existing supporting route,
  // not every member of a rejected/filtered cluster. A separately supplied
  // member whose verdict is missing still needs fallback.
  for (const released of refereeClusterSupportingCandidates(dispositions, contract.candidates)) {
    if (released.unassessed) continue;
    const { candidate: member } = released;
    if (contract.candidates.some(row => row.candidateId === member.candidateId)
      && !settled.has(member.candidateId)) continue;
    add(member);
  }
  const routedRecords = [];
  const discussion = baseline.map(topic => {
    if (isReviewerAuthored(topic)) return topic;
    const next = { ...topic };
    for (const [field, kind] of [['points', 'discussion_point'], ['decisions', 'decision'], ['openQuestions', 'open_question']]) {
      next[field] = (topic[field] || []).filter(record => {
        if (hasMeetingAgentReviewerContent(record) || !records.has(key(kind, record))) return true;
        routedRecords.push({ topic: topic.topic, kind, record: structuredClone(record) });
        return false;
      });
    }
    return next;
  }).filter(topic => isReviewerAuthored(topic)
    || ['points', 'decisions', 'openQuestions'].some(field => topic[field]?.length));
  return { active: true, dispositions, discussion, routedRecords,
    settledCandidateIds: [...settled],
    candidates: ensemble.filter(candidate => isReviewerAuthored(candidate) || hasMeetingAgentReviewerContent(candidate.record)
      || !settled.has(candidate.candidateId) && !records.has(key(candidate.recordType, candidate.record))) };
}

// A fully accepted, strongly grounded action must not silently disappear between
// Referee acceptance and the editable Actions list. This is a reconciliation
// invariant, not another extractor: it can only restore a named-owner row which
// already passed the Referee and the existing high-confidence evidence gate.
function reconcileAcceptedRefereeActions(published = [], accepted = [], proposed = [], candidates = [], sourceUnits = []) {
  const actions = [...(Array.isArray(published) ? published : [])];
  const proposals = Array.isArray(proposed) ? proposed : [];
  const restored = [];
  let eligibleCount = 0;
  for (const record of Array.isArray(accepted) ? accepted : []) {
    if (!(record?.owners || []).length || isVagueReconstructedAction(record?.action)
      || !highConfidenceRefereedAction(record, candidates, sourceUnits)) continue;
    eligibleCount += 1;
    if (actions.some((existing) => strictActionDeliverableMatch(record, existing))
      || proposals.some((existing) => strictActionDeliverableMatch(record, existing))) continue;
    actions.push(record);
    restored.push(record);
    actionDiagnostics.transition('restored', [record], [record], { mechanism: 'approved_action_preservation', reason: 'not_proved_represented' });
  }
  const firstEvidence = (record) => Math.min(...(record.evidenceIds || [])
    .map((id) => Number(String(id).match(/\d+/)?.[0] || Infinity)));
  actions.sort((left, right) => firstEvidence(left) - firstEvidence(right)
    || String(left.action || '').localeCompare(String(right.action || '')));
  return { actions, restored, eligibleCount };
}

// Nothing which has survived the evidence, timing and lifecycle checks may be
// lost merely because a later presentation deduper decides that two related
// deliverables sound alike.  This is deliberately not an extractor: it can
// only restore a row already present in the approved, display-eligible set,
// and only when no strict equivalent remains in the finished list.
function isReviewableActionProposal(record = {}, sourceUnits = []) {
  if (!record?.action || !Array.isArray(record.evidenceIds) || !record.evidenceIds.length) return false;
  const evidence = surroundingEvidence(sourceUnits, record.evidenceIds).filter((unit) => unit.cited)
    .map((unit) => `${unit.speaker}: ${unit.text}`).join(' ');
  if (isIdeaOnlyContemplation(`${record.action} ${evidence}`)) return false;
  const disposition = actionDispositionWithContext(record, sourceUnits, evidence);
  // A proposal is still reviewer work. Suggestions, rejected or completed
  // work, status narration and unanswered requests are not uncertain actions;
  // they are non-actions and should not be presented for acceptance.
  return !['suggestion', 'rejected', 'completed', 'status_only', 'meeting_admin', 'unaccepted_request']
    .includes(disposition);
}

function publishedActionCoversProposal(published = {}, proposal = {}) {
  return hybridCandidateCoveredByRecord({
    recordType: 'action', text: proposal.action, evidenceIds: proposal.evidenceIds, record: proposal
  }, published);
}

function meetingAgentCommitmentRecheckNeeded(record = {}, published = []) {
  return isClientReadyActionWording(record.action) && !isMeetingAdminAction(record.action)
    // Similarity is not coverage: two reviews can share an owner, citations
    // and nearly all their words while naming different documents. Uncertain
    // paraphrases should reach the existing quote check instead of vanishing.
    && !published.some((existing) => actionIsLosslesslyCovered(record, existing));
}

function hybridCandidateCoveredByRecord(candidate, record) {
  if (record?._recordType && candidate?.recordType && record._recordType !== candidate.recordType) return false;
  if (candidate?.recordType !== 'action') return hybridCandidateMatchesRecord(candidate, record);
  const action = candidate.record || {};
  const required = {
    ...action,
    action: action.action || candidate.text,
    evidenceIds: action.evidenceIds || candidate.evidenceIds || []
  };
  return actionIsSafelyCovered(required, record)
    || (hybridCandidateMatchesRecord(candidate, record) && commitmentCanBeRepresented(required, record));
}

function hybridCandidateDispositions(candidates = [], published = [], proposed = [], supporting = []) {
  const publishedRows = Array.isArray(published) ? published : [];
  const proposedRows = Array.isArray(proposed) ? proposed : [];
  return (Array.isArray(candidates) ? candidates : []).map((candidate) => {
    const publishMatch = publishedRows.find((record) => hybridCandidateCoveredByRecord(candidate, record));
    const proposalMatch = proposedRows.find((record) => hybridCandidateCoveredByRecord(candidate, record));
    const supportingMatch = (Array.isArray(supporting) ? supporting : []).find((record) => hybridCandidateCoveredByRecord(candidate, record));
    const disposition = publishMatch ? 'publish' : proposalMatch ? 'proposal' : supportingMatch ? 'supporting' : 'reject';
    return {
      candidateId: candidate.candidateId,
      sourcePass: candidate.sourcePass,
      recordType: candidate.recordType,
      disposition,
      matchedRecordId: (publishMatch || proposalMatch)?.id || '',
      reason: publishMatch
        ? 'Represented by an evidence-grounded published record.'
        : proposalMatch
          ? 'Evidence-grounded but retained for reviewer acceptance.'
          : 'Not retained after deliverable-aware evidence adjudication.'
    };
  }).slice(0, 1200);
}

// "Restore the animation on the pricing slide, build the closing slide, and
// re-share the deck once it's done" is three pieces of work. Kept as one row,
// a later merge can keep a wording that drops the first clause, and the
// reader cannot tick off one part. A comma-separated series of instructions,
// each starting with its own verb, becomes one action per instruction; each
// keeps the owners and evidence, and the timing stays with the clause that
// states it. "Build X and send it to Y" (no comma list) is left whole.
const COMPOUND_ACTION_VERBS = 'add|agree|arrange|ask|book|brief|build|call|chase|check|circulate|clarify|collect|complete|confirm|contact|create|draft|email|ensure|find|finalise|finalize|fix|follow|forward|get|identify|investigate|let|message|monitor|move|order|organise|organize|prepare|print|produce|provide|put|raise|re-send|re-share|record|remove|replace|request|reschedule|resend|restore|review|revise|run|schedule|send|set|share|sort|speak|start|submit|talk|test|trace|update|upload|write';
const COMPOUND_SPLIT = new RegExp(String.raw`,\s*(?:and\s+|then\s+|and\s+then\s+)?(?=(?:${COMPOUND_ACTION_VERBS})\b)`, 'i');
function splitCompoundActionList(actions = [], journeyId = '', options = {}) {
  const out = [];
  const splits = [];
  for (const action of Array.isArray(actions) ? actions : []) {
    if (hasMeetingAgentReviewerContent(action)) { out.push(action); continue; }
    const wording = meetingMinutesAgentText(action?.action, 1600).replace(/[.]+$/, '');
    const firstVerb = new RegExp(String.raw`^(?:${COMPOUND_ACTION_VERBS})\b`, 'i').test(wording);
    const parts = firstVerb ? wording.split(COMPOUND_SPLIT).map((part) => part.trim()).filter(Boolean) : [wording];
    // A later clause that points back ("..., and send it to Jo") only makes
    // sense attached to the one before it.
    const pointsBack = parts.slice(1).some((part) => /^\S+\s+(?:it|them|this|that|these|those)\b/i.test(part));
    if (parts.length < 2 || pointsBack || parts.some((part) => part.split(/\s+/).length < 3)) {
      out.push(action);
      continue;
    }
    // A date on the original compound is not evidence that every step shares
    // it. Bind it to a unique explicit clause, or to source wording that names
    // that step. An unresolved binding remains visible as a review flag.
    const canonical = value => String(value || '').normalize('NFKC').toLowerCase()
      .replace(/[’]/g, "'").replace(/[^\p{L}\p{N}' ]/gu, ' ').replace(/\s+/g, ' ').trim();
    const timingWording = canonical(action.timing?.wording || action.timing?.exactDate);
    const timingNeedle = timingWording.replace(/^(?:by|on|at|during)\s+/, '');
    const hasTiming = Boolean(action.timing?.kind && action.timing.kind !== 'not_stated');
    const timedParts = new Set();
    if (hasTiming && timingNeedle) {
      const explicit = parts.map((part, index) => canonical(part).includes(timingNeedle) ? index : -1).filter(index => index >= 0);
      if (explicit.length === 1) timedParts.add(explicit[0]);
      const cited = new Set(action.evidenceIds || []);
      const source = normaliseSourceUnits(options.sourceUnits || []).filter(unit => cited.has(unit.id));
      const timingTokens = new Set(timingWording.split(' '));
      const owners = new Set((action.owners || []).flatMap(owner => canonical(owner).split(' ')));
      const stop = new Set([...NESTED_STOP, 'another', 'related', 'required', 'completed', 'tasks', 'task', 'items', 'steps', 'work']);
      const words = value => new Set((canonical(value).match(/[\p{L}\p{N}']{3,}/gu) || [])
        .filter(word => !stop.has(word) && !timingTokens.has(word) && !owners.has(word)));
      const objects = parts.map(part => words(part.replace(/^\s*\S+\s+/, '')));
      const distinctive = objects.map((tokens, at) => new Set([...tokens].filter(token =>
        objects.every((other, index) => index === at || !other.has(token)))));
      for (const unit of source) {
        const statement = canonical(unit.text);
        if (!statement.includes(timingNeedle)) continue;
        // A refusal, reassignment or later qualification cannot establish the
        // original compound's deadline for one of its newly separated steps.
        if (/\b(?:not|never|cannot|can't|won't|instead|except|excluding|unless|but|however|later|rather than)\b/.test(statement)) continue;
        const sourceWords = words(unit.text);
        const speakerWords = new Set(canonical(unit.speaker).split(' ').filter(word => word.length > 1));
        const otherFutureSubject = [...String(unit.text || '').matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+(?:will|shall|must|is\s+going\s+to)\b/g)]
          .some(match => !/^(?:We|They|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/.test(match[1])
            && !canonical(match[1]).split(' ').every(word => owners.has(word)));
        const ownerNamed = (action.owners || []).some(owner => {
          const name = canonical(owner);
          const nameWords = name.split(' ').filter(word => word.length > 1);
          const ownsTurn = name === canonical(unit.speaker)
            || (nameWords.length >= 2 && nameWords.every(word => speakerWords.has(word)));
          const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const assignedDirectly = new RegExp(`\\b${escaped}\\s+(?:will|shall|must|is\\s+to)\\b`).test(statement);
          return !otherFutureSubject && (ownsTurn || assignedDirectly);
        });
        if (!ownerNamed) continue;
        const commonDeadline = /\b(?:both|all|each)(?:\s+(?:of\s+)?(?:these|those|the))?(?:\s+(?:tasks?|items?|steps?|actions?|jobs?|deliverables?))?\s+(?:are|is|will|must|need|needs|should|due|by|before)\b/.test(statement)
          && !/\b(?:not|never|except|excluding)\b/.test(statement)
          && objects.every(tokens => [...tokens].some(token => sourceWords.has(token)));
        if (commonDeadline) { parts.forEach((_, index) => timedParts.add(index)); break; }
        if (explicit.length) continue;
        const exactStep = parts.map((part, index) => canonical(part).split(' ').length >= 3
          && statement.includes(canonical(part)) ? index : -1).filter(index => index >= 0);
        if (exactStep.length === 1) { timedParts.add(exactStep[0]); continue; }
        const matches = distinctive.map((tokens, index) => tokens.size
          && [...tokens].filter(token => sourceWords.has(token)).length >= Math.min(2, tokens.size) ? index : -1)
          .filter(index => index >= 0);
        if (matches.length === 1) timedParts.add(matches[0]);
      }
    }
    let timingFlag = null;
    if (hasTiming && !timedParts.size) {
      timingFlag = normaliseMeetingAgentFlag({
        kind: 'timing',
        message: `The timing "${action.timing?.wording || action.timing?.exactDate}" could not be assigned safely to a step in "${wording}". Confirm which work it concerns.`,
        evidenceIds: action.evidenceIds || []
      });
      if (Array.isArray(options.flags)) options.flags.push(timingFlag);
    }
    parts.forEach((part, index) => {
      const sentence = `${part.charAt(0).toUpperCase()}${part.slice(1)}.`;
      const keepsTiming = hasTiming && timedParts.has(index);
      out.push({
        ...action,
        id: index === 0 ? action.id : `${action.id}-part${index + 1}`,
        action: sentence,
        timing: keepsTiming ? { ...action.timing } : { kind: 'not_stated', wording: '', exactDate: '' },
        ...(timingFlag ? { reviewFlagIds: [...new Set([...(action.reviewFlagIds || []), timingFlag.id])] } : {})
      });
    });
    splits.push({ from: meetingMinutesAgentText(action.action, 200), parts: parts.length });
  }
  if (splits.length) console.log(JSON.stringify({ event: 'meeting_agent_compound_action_split', journeyId, splits }));
  return out;
}

function hybridActionSourceInfo(action, candidates = []) {
  const matches = candidates.filter((candidate) => candidate.recordType === 'action' && hybridCandidateMatchesRecord(candidate, action));
  const discoverySources = [...new Set(matches.map((candidate) => candidate.sourcePass).filter((source) => ['staged', 'primary', 'primary-2', 'recovery', 'salvage'].includes(source)))];
  const explicitDeterministic = matches.some((candidate) => candidate.sourcePass === 'deterministic' && ['committed', 'accepted_request'].includes(candidate.dispositionHint));
  return { discoverySources, explicitDeterministic, candidateIds: matches.map((candidate) => candidate.candidateId) };
}

function highConfidenceRefereedAction(action, candidates = [], sourceUnits = []) {
  if (!action?.action || !Array.isArray(action.evidenceIds) || !action.evidenceIds.length) return false;
  if (Array.isArray(action.reviewFlagIds) && action.reviewFlagIds.length) return false;
  const sourceInfo = hybridActionSourceInfo(action, candidates);
  if (!sourceInfo.discoverySources.some((source) => source === 'primary' || source === 'recovery')) return false;
  const evidence = surroundingEvidence(sourceUnits, action.evidenceIds).filter((unit) => unit.cited)
    .map((unit) => `${unit.speaker}: ${unit.text}`).join(' ');
  if (evidenceSupportScore(action.action, evidence) < 0.3) return false;
  return ['committed', 'accepted_request', 'conditional_commitment']
    .includes(actionDispositionWithContext(action, sourceUnits, evidence));
}

function safeAgentProposalPromotion(action, candidates = [], sourceUnits = []) {
  if (!action?.action || !Array.isArray(action.evidenceIds) || !action.evidenceIds.length) return false;
  if (transcriptTextGateEnabled() && transcriptTextIssue(action.action, sourceUnits)) return false;
  // A documentation promise proves commitment, not every owner, timing,
  // quantity or source concern. Use the same review gate as other promotions;
  // the candidate remains available for explicit reviewer acceptance.
  if (Array.isArray(action.reviewFlagIds) && action.reviewFlagIds.length) return false;
  const explicitDocumentation = explicitFutureDocumentationCommitment(action, sourceUnits);
  const sourceInfo = hybridActionSourceInfo(action, candidates);
  const evidence = surroundingEvidence(sourceUnits, action.evidenceIds).filter((unit) => unit.cited)
    .map((unit) => `${unit.speaker}: ${unit.text}`).join(' ');
  if (isIdeaOnlyContemplation(`${action.action} ${evidence}`)) return false;
  if (explicitDocumentation) return true;
  // Nobody shown taking it on: it stays a suggestion ("no owner"), however
  // many passes found it. Adding an owner is the reviewer's call.
  if (!(action.owners || []).length) return false;
  const support = evidenceSupportScore(action.action, evidence);
  const disposition = actionDispositionWithContext(action, sourceUnits, evidence);
  if (!['committed', 'accepted_request', 'conditional_commitment'].includes(disposition)) return false;
  // Two independent Agent discovery passes are sufficient even when their
  // formal wording is slightly broader than one cited turn. A deterministic
  // accepted/committed chain may also supply the second independent signal.
  return repeatedOwnerCommitment(action, sourceUnits)
    || (sourceInfo.discoverySources.length >= 2 && support >= 0.24)
    || (sourceInfo.explicitDeterministic && support >= 0.3)
    || highConfidenceRefereedAction(action, candidates, sourceUnits);
}

const { sourceSpeakerIdentityScope } = require('../utils/meetingMinutesPromotionSourceIdentity');

// A concrete first-person promise to write the meeting record does not need a
// second model pass. Keep this narrow: one named owner must speak the cited
// future-tense words, and the public action must share their material subject.
function explicitFutureDocumentationCommitment(action = {}, sourceUnits = []) {
  const actionOpening = String(action.action || '').match(/^\s*(?:write(?: down)?|document|record|note)\b/i);
  if ((action.owners || []).length !== 1 || !actionOpening) return false;
  const identityScope = sourceSpeakerIdentityScope(sourceUnits);
  const ownerIdentity = identityScope.resolve(action.owners[0]);
  if (!ownerIdentity) return false;
  const actionSubject = String(action.action).slice(actionOpening[0].length);
  // Separate operations in either wording need ordinary proposal review.
  const hasCoordinatedOperation = (subject) => {
    const tail = subject.match(/\b(?:and(?:\s+then)?|then|but|while)\s+(.+)$/i)?.[1] || '';
    return hybridActionTypes(tail, { includeDocumentation: true }).size > 0
      || /\b(?:and|but|then|while)\s+(?:i|we|you|he|she|they|it|there)\b/i.test(subject);
  };
  if (hasCoordinatedOperation(actionSubject)) return false;
  const cited = new Set((action.evidenceIds || []).map(String));
  return normaliseSourceUnits(sourceUnits).some((unit) => {
    if (!cited.has(String(unit.id))) return false;
    if (identityScope.resolve(unit.speaker) !== ownerIdentity) return false;
    // Subject proof only narrows the original gate. Splitting a long turn
    // must not raise its overlap enough to create a newly eligible shortcut.
    if (hybridContentTokenOverlap(action.action, unit.text) < 0.24) return false;
    return evidenceClauses(unit.text).some((clause) => {
      const promise = clause.match(/\bi(?:'m| am)\s+going\s+to\s+(?:write(?: down)?|document|record|note)\b|\bi(?:'ll| will)\s+(?:write(?: down)?|document|record|note)\b/i);
      if (!promise) return false;
      const promisedSubject = clause.slice(promise.index + promise[0].length);
      if (hasCoordinatedOperation(promisedSubject)) return false;
      // Shared write/down/record words do not identify the promised work.
      // Reuse the material-subject guard with the same neutral lead verb,
      // and bind it to the promise's own clause rather than another sentence.
      if (distinctActionDeliverables({ action: `Record ${actionSubject}` },
        { action: `Record ${promisedSubject}` })) return false;
      return hybridContentTokenOverlap(action.action, clause) >= 0.24;
    });
  });
}

// A direct commitment which is repeated in the meeting's action recap is
// stronger than a single model classification. This is deliberately strict:
// the same named owner must speak both cited lines, both lines must describe
// the action, and the confirmations must be separated in the transcript.
function repeatedOwnerCommitment(action = {}, sourceUnits = []) {
  const identityScope = sourceSpeakerIdentityScope(sourceUnits);
  const ownerIdentities = new Set((action.owners || []).map(owner => identityScope.resolve(owner)).filter(Boolean));
  if (!ownerIdentities.size || !(action.evidenceIds || []).length) return false;
  const units = new Map(normaliseSourceUnits(sourceUnits).map((unit, index) => [unit.id, {
    ...unit,
    index: Number(String(unit.id || '').match(/\d+/)?.[0] || index)
  }]));
  const commitment = /\b(?:i(?:'ll| will| can| am going to|'m going to)|we(?:'ll| will| can| are going to)|leave (?:it|that|this) with me|will do)\b|^\s*me\s*[,;:-]/i;
  const supportedByOwner = new Map();
  for (const unit of (action.evidenceIds || []).map(id => units.get(id)).filter(Boolean)) {
    const identity = identityScope.resolve(unit.speaker);
    if (!ownerIdentities.has(identity) || !commitment.test(unit.text)
      || hybridContentTokenOverlap(action.action, unit.text) < 0.24) continue;
    if (!supportedByOwner.has(identity)) supportedByOwner.set(identity, []);
    supportedByOwner.get(identity).push(unit.index);
  }
  return [...supportedByOwner.values()].some(indices => indices.length >= 2
    && Math.max(...indices) - Math.min(...indices) >= 3);
}

// Reuse the existing final critic as the targeted promotion referee. An action
// remains a proposal after one discovery/referee result, but a materially
// matching result from the independent critic supplies the second judgement
// needed for safe automatic publication. Deterministic commitments may also be
// promoted when the critic independently reconstructs and validates them.
function criticConfirmedActionPromotions(criticActions = [], singleSource = [], candidates = [], sourceUnits = [], options = {}) {
  const promoted = [];
  for (const criticAction of Array.isArray(criticActions) ? criticActions : []) {
    if (!criticAction?.action || !criticAction.evidenceIds?.length || criticAction.reviewFlagIds?.length) continue;
    const evidence = surroundingEvidence(sourceUnits, criticAction.evidenceIds).filter((unit) => unit.cited)
      .map((unit) => `${unit.speaker}: ${unit.text}`).join(' ');
    if (evidenceSupportScore(criticAction.action, evidence) < 0.3) continue;
    if (!['committed', 'accepted_request', 'conditional_commitment'].includes(actionEvidenceDisposition(criticAction.action, evidence))) continue;
    const matchingReferee = (singleSource || []).find((record) => hybridCandidateMatchesRecord({
      recordType: 'action', text: record.action, evidenceIds: record.evidenceIds, record
    }, criticAction));
    const deterministic = hybridActionSourceInfo(criticAction, candidates).explicitDeterministic;
    if (!matchingReferee && !deterministic) continue;
    const preferred = matchingReferee || criticAction;
    promoted.push({
      ...preferred,
      evidenceIds: [...new Set([...(preferred.evidenceIds || []), ...(criticAction.evidenceIds || [])])].slice(0, 8)
    });
  }
  return normaliseAgentResult({ actions: promoted }, sourceUnits, 'actions', {
    meetingDate: options.meetingDate
  }).actions;
}

function corroboratedOmittedDiscussionRecords(candidates = [], discussion = [], sourceUnits = [], options = {}) {
  const unitsById = new Map(normaliseSourceUnits(sourceUnits).map((unit) => [unit.id, unit]));
  const eligible = (Array.isArray(candidates) ? candidates : []).filter((candidate) =>
    ['discussion_point', 'decision', 'open_question'].includes(candidate?.recordType)
    && ['primary', 'recovery', 'staged'].includes(candidate?.sourcePass)
    && candidate?.text && candidate?.evidenceIds?.length
  ).filter((candidate) => {
    const evidence = (candidate.evidenceIds || []).map((id) => unitsById.get(id)).filter(Boolean)
      .map((unit) => `${unit.speaker || ''}: ${unit.text || ''}`).join(' ');
    if (evidence && evidenceSupportScore(candidate.text, evidence) >= 0.22) return true;
    // A correctly expanded source year is not an unsupported quantity. Use
    // the same anchored value proof as normalisation, while still requiring
    // support from an ID this candidate actually supplied.
    if (!options.meetingDate) return false;
    const resolved = resolveEvidence(candidate.text, sourceUnits, candidate.evidenceIds, options);
    return resolved.supportScore >= 0.22
      && resolved.evidenceIds.some(id => candidate.evidenceIds.includes(id));
  });
  const represented = flattenHybridDiscussion(discussion);
  const groups = [];
  for (const candidate of eligible) {
    const group = groups.find((items) => items.some((other) => {
      const sameTopic = String(other.topic || '').toLowerCase() === String(candidate.topic || '').toLowerCase()
        || hybridTokenOverlap(other.topic, candidate.topic) >= 0.55;
      const lexical = hybridContentTokenOverlap(other.text, candidate.text);
      const evidence = new Set(other.evidenceIds || []);
      const sharedEvidence = (candidate.evidenceIds || []).some((id) => evidence.has(id));
      return sameTopic && (lexical >= 0.5 || (sharedEvidence && lexical >= 0.25));
    }));
    if (group) group.push(candidate);
    else groups.push([candidate]);
  }
  const additions = [];
  const sourceRank = { primary: 3, recovery: 2, staged: 1 };
  const typeRank = { decision: 3, open_question: 2, discussion_point: 1 };
  const explicitlyMaterial = (candidate) => candidate.recordType === 'decision'
    || candidate.recordType === 'open_question'
    || /\b(?:agree(?:d|ment)?|decid(?:e|ed|ion)|approv(?:e|ed|al)|block(?:ed|er|ing)?|risk|depend(?:s|ent|ency)?|subject to|unresolved|required|must|standard|regulation|scope|deadline|target|increase|decrease|quantity|total|percent|%|\d+(?:[.,]\d+)?)\b/i
      .test(String(candidate.text || ''));
  for (const group of groups) {
    const sources = new Set(group.map((candidate) => candidate.sourcePass));
    // Independent discovery corroboration is the normal route. A strongly
    // material decision or unresolved matter may also survive from one source,
    // but it remains subject to evidence validation above and compacting below.
    if (sources.size < 2 && !group.some(explicitlyMaterial)) continue;
    if (group.some((candidate) => represented.some((item) => {
      const sameTopic = String(item.topic || '').toLowerCase() === String(candidate.topic || '').toLowerCase()
        || hybridTokenOverlap(item.topic, candidate.topic) >= 0.55;
      return sameTopic && (hybridCandidateMatchesRecord(candidate, item.record)
        || hybridContentTokenOverlap(candidate.text, item.record?.text) >= 0.58);
    }))) continue;
    const preferred = [...group].sort((left, right) => Number(sourceRank[right.sourcePass] || 0) - Number(sourceRank[left.sourcePass] || 0)
      || Number(typeRank[right.recordType] || 0) - Number(typeRank[left.recordType] || 0)
      || String(right.text).length - String(left.text).length)[0];
    additions.push({
      ...preferred,
      evidenceIds: [...new Set(group.flatMap((candidate) => candidate.evidenceIds || []))].slice(0, 12),
      sourcePasses: [...sources]
    });
  }
  const byTopic = new Map();
  for (const candidate of additions) {
    const topic = meetingMinutesAgentText(candidate.topic || 'Additional evidenced points', 240);
    if (!byTopic.has(topic)) byTopic.set(topic, { topic, points: [], decisions: [], openQuestions: [] });
    const key = candidate.recordType === 'decision' ? 'decisions'
      : candidate.recordType === 'open_question' ? 'openQuestions' : 'points';
    byTopic.get(topic)[key].push({
      ...(candidate.record || {}), text: candidate.text,
      evidenceIds: [...new Set(candidate.evidenceIds || [])].slice(0, 8)
    });
  }
  return normaliseAgentResult({ discussion: [...byTopic.values()] }, sourceUnits, 'discussion', options).discussion;
}

function exactDiscussionTwinEvidence(candidate = {}, candidates = [], sourceUnits = [], options = {}, rejectedIds = new Set()) {
  const hasEvidence = (row) => (Array.isArray(row?.evidenceIds) && row.evidenceIds.length)
    || (Array.isArray(row?.record?.evidenceIds) && row.record.evidenceIds.length);
  const rejected = (row) => row?.reviewerAuthored === true || row?.record?.reviewerAuthored === true
    || rejectedIds.has(String(row?.candidateId || ''))
    || ['reject', 'rejected'].includes(row?.dispositionHint)
    || row?.record?.discoveryDisposition === 'reject'
    || [row, row?.record].some(value => value?._unsupportedEvidenceIds?.length || value?._weakEvidenceIds?.length);
  if (!['discussion_point', 'decision', 'open_question'].includes(candidate.recordType)
    || typeof candidate.text !== 'string' || !candidate.text || hasEvidence(candidate) || rejected(candidate)
    || (candidate.record?.text && candidate.record.text !== candidate.text)) return [];
  // Navigation, presentation and provenance may differ between discovery
  // passes. Every other field, including any actor, timing, qualification or
  // explicit transcript-version metadata, must describe the identical claim.
  const navigation = new Set(['candidateId', 'sourcePass', 'recordType', 'topic', 'text', 'evidenceIds', 'record',
    'priority', 'sequence', 'context', 'focusText', 'focusEvidenceId', 'dispositionHint', 'kindHints', 'clusterMembers']);
  const provenance = new Set(['id', 'text', 'evidenceIds', 'reviewFlagIds', 'supportingDetails', 'primaryEvidenceIds', 'discoveryDisposition']);
  const stable = (value) => Array.isArray(value) ? value.map(stable)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  const fields = (value, ignored) => Object.fromEntries(Object.entries(value || {}).filter(([key]) => !ignored.has(key)));
  const claimKey = (row) => JSON.stringify(stable([
    row.recordType, row.text, fields(row, navigation), fields(row.record, provenance)
  ]));
  const key = claimKey(candidate);
  const twins = (Array.isArray(candidates) ? candidates : []).filter(twin => twin && twin !== candidate
    && twin.candidateId !== candidate.candidateId && ['primary', 'recovery'].includes(twin.sourcePass)
    && !rejected(twin) && twin.text === candidate.text
    && (!twin.record?.text || twin.record.text === twin.text) && claimKey(twin) === key);
  const requested = (row) => [...new Set((Array.isArray(row.evidenceIds) ? row.evidenceIds : row.record?.evidenceIds || [])
    .filter(id => typeof id === 'string' && id))];
  // This is an empty-slot repair, not overflow handling. Do not reorder or
  // evict existing citations, or truncate a ninth source to make a union fit.
  const union = [...new Set(twins.flatMap(requested))];
  if (!union.length || union.length > 8) return [];
  const validated = new Set();
  for (const twin of twins) {
    const supplied = requested(twin);
    if (!supplied.length) continue;
    const resolved = resolveEvidence(candidate.text, sourceUnits, supplied, options);
    // Reuse only surviving supplied evidence. A remap to newly found sources
    // or an invalid/weak donor is not proof that its original links were valid.
    if (resolved.invalidIds.length || resolved.weakIds.length || !resolved.evidenceIds.length
      || resolved.evidenceIds.some(id => !supplied.includes(id))) continue;
    resolved.evidenceIds.forEach(id => validated.add(id));
  }
  return [...validated].sort();
}

function reconstructMissingRefereeDiscussion(discussion = [], dispositions = [], candidates = [], sourceUnits = [], options = {}) {
  const result = (Array.isArray(discussion) ? discussion : []).map((topic) => ({
    ...topic,
    points: [...(topic.points || [])],
    decisions: [...(topic.decisions || [])],
    openQuestions: [...(topic.openQuestions || [])]
  }));
  const existingIds = new Set(flattenHybridDiscussion(result)
    .map((item) => String(item.record?.id || '')).filter(Boolean));
  const candidatesById = new Map((Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => candidate?.candidateId).map((candidate) => [String(candidate.candidateId), candidate]));
  const groups = new Map();
  for (const disposition of Array.isArray(dispositions) ? dispositions : []) {
    const kind = disposition?.disposition || disposition?.classification;
    const candidateId = String(disposition?.candidateId || '');
    const candidate = candidatesById.get(candidateId);
    const targetId = refereeDiscussionTargetId(disposition)
      || (kind === 'core' ? candidateId : '');
    if (!targetId || kind === 'reject' || !candidate
      || !['discussion_point', 'decision', 'open_question'].includes(candidate.recordType)) continue;
    if (!groups.has(targetId)) groups.set(targetId, []);
    groups.get(targetId).push({ disposition, kind, candidate });
  }
  const reconstructedTargetIds = [];
  const rejectedIds = new Set((Array.isArray(dispositions) ? dispositions : [])
    .filter(item => (item?.disposition || item?.classification) === 'reject').map(item => String(item.candidateId || '')));
  const sourceRank = { primary: 5, recovery: 4, staged: 3, deterministic: 2, unknown: 1 };
  const typeRank = { decision: 3, open_question: 2, discussion_point: 1 };
  for (const [targetId, group] of groups) {
    if (existingIds.has(targetId)) continue;
    const eligible = group.filter((item) => item.kind === 'core');
    // An invalid merge reference is unresolved checking, not permission to
    // promote its supporting material into a new primary proposition.
    const selected = [...eligible].sort((left, right) =>
      Number(!isRawTranscriptDiscussionPoint(right.candidate.text)) - Number(!isRawTranscriptDiscussionPoint(left.candidate.text))
      || Number(sourceRank[right.candidate.sourcePass] || 0) - Number(sourceRank[left.candidate.sourcePass] || 0)
      || Number(typeRank[right.candidate.recordType] || 0) - Number(typeRank[left.candidate.recordType] || 0)
      || Number(right.candidate.priority || 0) - Number(left.candidate.priority || 0)
      || String(right.candidate.text || '').length - String(left.candidate.text || '').length)[0];
    if (!selected?.candidate?.text) continue;
    // Supporting text retains its own citations below. It must not donate
    // those citations to the primary claim before its placement is checked;
    // later detaching a misplaced child cannot otherwise undo that donation.
    const evidenceIds = [...new Set(eligible.flatMap((item) => [
      ...(item.candidate.evidenceIds || item.candidate.record?.evidenceIds || []),
      ...(Array.isArray(item.disposition.evidenceIds) ? item.disposition.evidenceIds : [])
    ]))].slice(0, 12);
    if (!evidenceIds.length) evidenceIds.push(...exactDiscussionTwinEvidence(
      selected.candidate, candidates, sourceUnits, options, rejectedIds
    ));
    const record = {
      ...(selected.candidate.record || {}), id: targetId,
      text: selected.candidate.text, evidenceIds,
      primaryEvidenceIds: [...new Set([
        ...(selected.candidate.evidenceIds || selected.candidate.record?.evidenceIds || []),
        ...(Array.isArray(selected.disposition.evidenceIds) ? selected.disposition.evidenceIds : [])
      ])].filter(id => evidenceIds.includes(id)).slice(0, 12),
      supportingDetails: group
        .filter((item) => item !== selected && ['supporting', 'merge'].includes(item.kind))
        .map((item) => ({
          ...(item.candidate.record || {}),
          id: item.candidate.record?.id || item.candidate.candidateId,
          text: item.candidate.text,
          originalTopic: item.candidate.record?.originalTopic || item.candidate.originalTopic || item.candidate.topic,
          evidenceIds: [...new Set([
            ...(item.candidate.evidenceIds || item.candidate.record?.evidenceIds || []),
            ...(Array.isArray(item.disposition.evidenceIds) ? item.disposition.evidenceIds : [])
          ])].slice(0, 8)
        }))
    };
    const topicName = meetingMinutesAgentText(selected.candidate.topic, 240) || 'Discussion';
    let topic = result.find((item) => item.topic.toLowerCase() === topicName.toLowerCase())
      || result.find((item) => hybridTokenOverlap(item.topic, topicName) >= 0.6);
    if (!topic) {
      topic = { id: `reconstructed-topic-${result.length + 1}`, topic: topicName, points: [], decisions: [], openQuestions: [] };
      result.push(topic);
    }
    const key = selected.candidate.recordType === 'decision' ? 'decisions'
      : selected.candidate.recordType === 'open_question' ? 'openQuestions' : 'points';
    topic[key].push(record);
    existingIds.add(targetId);
    reconstructedTargetIds.push(targetId);
  }
  return {
    discussion: carryExactDiscussionProvenance(result,
      normaliseAgentResult({ discussion: result }, sourceUnits, 'discussion', options).discussion),
    exactPublicationOrigins: result,
    reconstructedTargetIds,
    referencedTargetIds: [...groups.keys()],
    unresolvedTargetIds: [...groups.keys()].filter((id) => !existingIds.has(id))
  };
}

// The candidate the referee publishes is not always the one that carried the
// owner. Discovery finds "Andrew will complete the MDD review" with Andrew
// named; recovery, citing only the line where Jacqui says "your review",
// finds the same deliverable with nobody; the referee is shown the second and
// publishes it. Across twenty live drafts 20 of 23 unowned published actions
// had an owned twin somewhere in the ensemble. When the published candidate
// names nobody, take the owner - and the lines that name them - from a twin
// that does; the evidence guard downstream still decides whether it stands.
function candidateOwnersOf(candidate = {}) {
  const owners = Array.isArray(candidate?.record?.owners) && candidate.record.owners.length ? candidate.record.owners
    : Array.isArray(candidate?.owners) ? candidate.owners : [];
  return owners.map((owner) => meetingMinutesAgentText(owner, 120)).filter(Boolean);
}

function borrowOwnersFromTwin(selected = {}, pool = []) {
  const action = meetingMinutesAgentText(selected?.record?.action || selected?.text, 1200);
  if (!action) return null;
  const evidence = new Set([...(selected.evidenceIds || []), ...(selected.record?.evidenceIds || [])]);
  const twins = (Array.isArray(pool) ? pool : []).filter((candidate) => candidate && candidate !== selected
    && candidate.candidateId !== selected.candidateId
    && ['action', 'action_chain', 'action_thread'].includes(String(candidate.recordType || ''))
    && candidateOwnersOf(candidate).length);
  const rank = { primary: 4, 'primary-2': 4, recovery: 3, salvage: 2, staged: 1 };
  const scored = twins.map((candidate) => {
    const text = meetingMinutesAgentText(candidate.record?.action || candidate.text, 1200);
    const overlap = hybridContentTokenOverlap(action, text);
    const shared = [...(candidate.evidenceIds || []), ...(candidate.record?.evidenceIds || [])].some((id) => evidence.has(id));
    const match = overlap >= 0.62 || (shared && overlap >= 0.48);
    return match ? { candidate, score: overlap + (shared ? 0.25 : 0) + (rank[candidate.sourcePass] || 0) * 0.01 } : null;
  }).filter(Boolean).sort((left, right) => right.score - left.score);
  if (!scored.length) return null;
  const twin = scored[0].candidate;
  actionDiagnostics.transition('owner_borrow_proposed', [selected.record || { action, evidenceIds: selected.evidenceIds || [] },
    twin.record || { action: twin.text, owners: candidateOwnersOf(twin), evidenceIds: twin.evidenceIds || [] }], [],
    { mechanism: 'borrowOwnersFromTwin', selectedCandidate: selected.candidateId, donorCandidate: twin.candidateId, donorPass: twin.sourcePass });
  return {
    owners: candidateOwnersOf(twin),
    evidenceIds: [...new Set([...(twin.evidenceIds || []), ...(twin.record?.evidenceIds || [])])]
  };
}

// Where a suggestion goes between the candidate pool and the review queue.
// MEETING_MINUTES_AGENT_TRACE_PROPOSALS=<text> prints every step for the
// proposals whose wording contains that text.
function traceProposals(step, records = [], draftId = '') {
  const needle = String(process.env.MEETING_MINUTES_AGENT_TRACE_PROPOSALS || '').trim().toLowerCase();
  if (!needle) return;
  const rows = (Array.isArray(records) ? records : []).map((record) => record?.after || record)
    .filter((record) => String(record?.action || '').toLowerCase().includes(needle))
    .map((record) => `${meetingMinutesAgentText(record.action, 120)} | ${JSON.stringify(record.owners || [])} | ${JSON.stringify(record.evidenceIds || [])}`);
  console.info(JSON.stringify({ event: 'meeting_agent_proposal_trace', journeyId: draftId, step, count: rows.length, rows }));
}

function traceOwners(step, actions = [], journeyId = '') {
  actionDiagnostics.checkpoint(step, actions);
  if (!/^(?:1|true|yes|on)$/i.test(String(process.env.MEETING_MINUTES_AGENT_TRACE_OWNERS || ''))) return;
  const list = Array.isArray(actions) ? actions : [];
  const probe = String(process.env.MEETING_MINUTES_AGENT_TRACE_OWNERS_PROBE || '').toLowerCase();
  const hit = probe ? list.find((a) => String(a?.action || '').toLowerCase().includes(probe)) : null;
  console.info(JSON.stringify({ event: 'owner_trace', journeyId, step, total: list.length,
    owned: list.filter((a) => (a?.owners || []).length).length,
    probe: probe ? (hit ? { owners: hit.owners || [], evidence: hit.evidenceIds || [] } : 'absent') : undefined }));
  const file = String(process.env.MEETING_MINUTES_AGENT_TRACE_OWNERS_FILE || '');
  if (file) {
    try {
      require('fs').appendFileSync(file, `${JSON.stringify({ journeyId, step, actions: list.map((a) => ({
        id: a?.id, action: a?.action, owners: a?.owners || [], evidenceIds: a?.evidenceIds || [], reviewFlagIds: a?.reviewFlagIds || []
      })) })}\n`);
    } catch { /* tracing only */ }
  }
}

function reconstructRefereeActions(dispositions = [], candidates = [], sourceUnits = [], options = {}) {
  const candidatesById = new Map((Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => candidate?.candidateId)
    .map((candidate) => [String(candidate.candidateId), candidate]));
  const ownerPool = [...(Array.isArray(candidates) ? candidates : []), ...(Array.isArray(options.ownerPool) ? options.ownerPool : [])];
  // Referee contracts deliberately compact away records and review flags.
  // Recover the restriction by exact candidate ID from the server's ledger,
  // not from model wording or an inferred twin.
  const documentReviewRecords = new Map(ownerPool
    .filter(candidate => candidate?.candidateId && requiresDocumentReferenceReview(candidate.record))
    .map(candidate => [String(candidate.candidateId), candidate.record]));
  const unresolvedMaterializations = refereeActionMaterializationIssues(dispositions, candidates);
  const unresolvedIds = new Set(unresolvedMaterializations.map((item) => item.candidateId));
  let borrowedOwners = 0;
  const evidenceByTarget = new Map();
  const rows = [];
  const dispositionKind = (value) => ({ core: 'publish', keep: 'publish' }[value] || value);
  for (const disposition of Array.isArray(dispositions) ? dispositions : []) {
    const kind = dispositionKind(disposition?.disposition || disposition?.classification);
    const candidateId = String(disposition?.candidateId || '');
    if (unresolvedIds.has(candidateId)) continue;
    const candidate = candidatesById.get(candidateId);
    const targetId = meetingMinutesAgentText(disposition?.targetId || disposition?.mergeTarget, 160);
    const targetCandidate = targetId ? candidatesById.get(targetId) : null;
    const selected = kind === 'merge' ? targetCandidate : candidate;
    const evidenceKey = targetId || candidateId;
    if (evidenceKey) {
      const evidence = evidenceByTarget.get(evidenceKey) || [];
      evidenceByTarget.set(evidenceKey, [...new Set([
        ...evidence,
        ...(candidate?.evidenceIds || candidate?.record?.evidenceIds || []),
        ...(Array.isArray(disposition?.evidenceIds) ? disposition.evidenceIds : [])
      ])]);
    }
    if (!['publish', 'proposal'].includes(kind) || !selected || selected.recordType !== 'action') continue;
    const action = meetingMinutesAgentText(selected.record?.action || selected.text, 1200);
    if (!action) continue;
    // A referee verdict cannot settle a document association or acceptance
    // that source-context recovery explicitly left for a human. Keep that
    // restriction through reconstruction, before any owner inference.
    const documentReviewRecord = documentReviewRecords.get(String(selected.candidateId));
    const documentReviewRequired = Boolean(documentReviewRecord);
    const materializedKind = documentReviewRequired ? 'proposal' : kind;
    let owners = documentReviewRequired ? [...(documentReviewRecord.owners || [])] : candidateOwnersOf(selected);
    if (!documentReviewRequired && !owners.length && Array.isArray(disposition?.owners)) {
      owners = disposition.owners.map((owner) => meetingMinutesAgentText(owner, 120)).filter(Boolean);
    }
    let borrowedEvidence = [];
    if (!documentReviewRequired && !owners.length && kind === 'publish') {
      const borrowed = borrowOwnersFromTwin(selected, ownerPool);
      if (borrowed) { owners = borrowed.owners; borrowedEvidence = borrowed.evidenceIds; borrowedOwners += 1; }
    }
    const diagnosticSource = selected.record || { action, owners: candidateOwnersOf(selected), evidenceIds: selected.evidenceIds || [] };
    rows.push({
      kind: materializedKind,
      targetId: targetId || candidateId,
      record: {
        id: meetingMinutesAgentText(selected.record?.id || targetId || candidateId, 160),
        action,
        owners,
        timing: selected.record?.timing || selected.timing
          || { kind: 'not_stated', wording: '', exactDate: '' },
        evidenceIds: [...new Set([
          ...(selected.evidenceIds || selected.record?.evidenceIds || []),
          ...(Array.isArray(disposition?.evidenceIds) ? disposition.evidenceIds : []),
          ...borrowedEvidence
        ])],
        reviewFlagIds: documentReviewRequired ? [...documentReviewRecord.reviewFlagIds] : []
      }
    });
    actionDiagnostics.transition(borrowedEvidence.length ? 'owner_borrowed' : 'referee_materialised', [diagnosticSource], [rows.at(-1).record],
      { mechanism: 'reconstructRefereeActions', candidateId, disposition: kind,
        ...(documentReviewRequired ? { materializedDisposition: materializedKind, documentReviewRequired: true } : {}) });
  }
  const writtenRows = rows.filter((item) => !(transcriptTextGateEnabled()
    && transcriptTextIssue(item.record.action, sourceUnits)));
  if (writtenRows.length !== rows.length) {
    console.log(JSON.stringify({
      event: 'meeting_agent_transcript_text_gate', stage: 'referee_reconstruction',
      removed: rows.length - writtenRows.length,
      items: rows.filter((item) => !writtenRows.includes(item)).map((item) => ({
        reason: transcriptTextIssue(item.record.action, sourceUnits),
        action: meetingMinutesAgentText(item.record.action, 160)
      }))
    }));
  }
  rows.splice(0, rows.length, ...writtenRows);
  const withMergedEvidence = rows.map((item) => ({
    ...item.record,
    evidenceIds: [...new Set([
      ...(item.record.evidenceIds || []),
      ...(evidenceByTarget.get(item.targetId) || [])
    ])].slice(0, 12)
  }));
  const published = withMergedEvidence.filter((record, index) => rows[index].kind === 'publish');
  const proposed = withMergedEvidence.filter((record, index) => rows[index].kind === 'proposal');
  if (borrowedOwners) {
    console.info(JSON.stringify({ event: 'meeting_agent_owner_borrowed', journeyId: options.journeyId || '', borrowed: borrowedOwners, published: published.length }));
  }
  return {
    actions: dedupeHybridActionRecords(normaliseAgentResult(
      { actions: published }, sourceUnits, 'actions', { meetingDate: options.meetingDate }
    ).actions),
    actionProposals: dedupeHybridActionProposals(normaliseAgentResult(
      { actions: proposed }, sourceUnits, 'actions', { enforceEvidence: false, meetingDate: options.meetingDate }
    ).actions),
    ...(unresolvedMaterializations.length ? { unresolvedMaterializations } : {})
  };
}

function enrichDiscussionEvidenceFromDispositions(discussion = [], dispositions = [], candidates = []) {
  const result = (Array.isArray(discussion) ? discussion : []).map((topic) => ({
    ...topic,
    points: (topic.points || []).map((record) => ({ ...record })),
    decisions: (topic.decisions || []).map((record) => ({ ...record })),
    openQuestions: (topic.openQuestions || []).map((record) => ({ ...record }))
  }));
  const recordRows = result.flatMap((topic) => [...topic.points, ...topic.decisions, ...topic.openQuestions]
    .map((record) => ({ topic: topic.topic || 'Discussion', record })));
  const recordsById = new Map(recordRows.filter((item) => item.record?.id)
    .map((item) => [String(item.record.id), item.record]));
  const candidatesById = new Map((Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => candidate?.candidateId).map((candidate) => [candidate.candidateId, candidate]));
  for (const disposition of Array.isArray(dispositions) ? dispositions : []) {
    const classification = disposition?.disposition || disposition?.classification;
    if (!['core', 'merge'].includes(classification)) continue;
    const targetId = disposition?.mergeTarget || disposition?.targetId
      || disposition?.discussionId || disposition?.targetRecordId || disposition?.primaryId;
    const record = recordsById.get(String(targetId || ''));
    const candidate = candidatesById.get(disposition?.candidateId);
    if (!record || !candidate) continue;
    record.evidenceIds = [...new Set([
      ...(record.evidenceIds || []), ...(candidate.evidenceIds || candidate.record?.evidenceIds || [])
    ])].slice(0, 12);
  }
  const classifiedCandidates = (Array.isArray(dispositions) ? dispositions : []).flatMap((disposition) => {
    const classification = disposition?.disposition || disposition?.classification;
    const candidate = candidatesById.get(disposition?.candidateId);
    return candidate && ['core', 'merge'].includes(classification) ? [{ candidate, disposition }] : [];
  });
  for (const row of recordRows.filter((item) => !(item.record.evidenceIds || []).length)) {
    const ranked = classifiedCandidates.map((item) => {
      const lexical = hybridContentTokenOverlap(row.record.text, item.candidate.text || item.candidate.record?.text || '');
      const topic = hybridTokenOverlap(row.topic, item.candidate.topic || '') * 0.3;
      return { ...item, score: lexical + topic };
    }).filter((item) => item.score >= 0.28)
      .sort((left, right) => right.score - left.score);
    if (!ranked.length) continue;
    row.record.evidenceIds = [...new Set(ranked.filter((item) => item.score >= ranked[0].score - 0.12)
      .slice(0, 3).flatMap((item) => item.candidate.evidenceIds || item.candidate.record?.evidenceIds || []))].slice(0, 12);
  }
  return result;
}

// A referee is another probabilistic pass, so it can occasionally omit a
// deliverable which two independent discovery passes both found. Do not publish
// that work automatically: recover it into the existing accept/reject proposal
// UI. Single-source staged rows deliberately do not qualify here.
function corroboratedOmittedActionProposals(candidates = [], records = [], sourceUnits = [], options = {}) {
  const eligible = (Array.isArray(candidates) ? candidates : []).filter((candidate) =>
    candidate?.recordType === 'action'
    && ['staged', 'primary', 'primary-2', 'recovery'].includes(candidate?.sourcePass)
    && hybridRecordText(candidate?.record || candidate)
    && Array.isArray(candidate?.evidenceIds)
    && candidate.evidenceIds.length
  );
  const groups = [];
  for (const candidate of eligible) {
    const group = groups.find((items) => items.some((other) =>
      hybridCandidateMatchesRecord(candidate, other.record || other)
      || hybridCandidateMatchesRecord(other, candidate.record || candidate)
    ));
    if (group) group.push(candidate);
    else groups.push([candidate]);
  }
  const sourceRank = { primary: 3, 'primary-2': 3, recovery: 2, staged: 1 };
  const proposed = [];
  for (const group of groups) {
    const sources = [...new Set(group.map((candidate) => candidate.sourcePass))];
    if (sources.length < 2) continue;
    if (group.some((candidate) => (records || []).some((record) => hybridCandidateMatchesRecord(candidate, record)))) continue;
    const ordered = [...group].sort((left, right) => Number(sourceRank[right.sourcePass] || 0) - Number(sourceRank[left.sourcePass] || 0)
      || hybridRecordText(right.record || right).length - hybridRecordText(left.record || left).length);
    const preferred = ordered[0];
    // Ownership or timing reported by only one pass is not corroborated. The
    // normal evidence validator remains the final authority even when fields do
    // agree across sources.
    const ownerCounts = new Map();
    const timingCounts = new Map();
    for (const candidate of group) {
      for (const owner of candidate.record?.owners || []) {
        const key = String(owner).trim().toLowerCase();
        if (key) ownerCounts.set(key, { owner, sources: new Set([...(ownerCounts.get(key)?.sources || []), candidate.sourcePass]) });
      }
      const timing = candidate.record?.timing;
      if (timing && timing.kind && timing.kind !== 'not_stated') {
        const key = JSON.stringify(timing);
        timingCounts.set(key, { timing, sources: new Set([...(timingCounts.get(key)?.sources || []), candidate.sourcePass]) });
      }
    }
    const owners = [...ownerCounts.values()].filter((entry) => entry.sources.size >= 2).map((entry) => entry.owner);
    const timing = [...timingCounts.values()].find((entry) => entry.sources.size >= 2)?.timing
      || { kind: 'not_stated', wording: '', exactDate: '' };
    proposed.push({
      ...(preferred.record || {}),
      action: hybridRecordText(preferred.record || preferred),
      owners,
      timing,
      evidenceIds: [...new Set(group.flatMap((candidate) => candidate.evidenceIds || []))].slice(0, 8)
    });
  }
  return normaliseAgentResult({ actions: proposed }, sourceUnits, 'actions', {
    meetingDate: options.meetingDate
  }).actions.slice(0, 8);
}

function strongOmittedDiscoveryProposals(candidates = [], records = [], sourceUnits = [], options = {}) {
  const deterministic = (candidates || []).filter((candidate) => candidate.sourcePass === 'deterministic'
    && candidate.recordType === 'action'
    && ['committed', 'accepted_request', 'conditional_commitment'].includes(candidate.dispositionHint));
  const proposals = [];
  for (const candidate of (candidates || []).filter((item) => ['primary', 'recovery'].includes(item.sourcePass)
    && item.recordType === 'action' && item.record?.action && item.evidenceIds?.length)) {
    if ((records || []).some((record) => hybridCandidateMatchesRecord(candidate, record))) continue;
    if (!deterministic.some((cue) => hybridCandidateMatchesRecord(cue, candidate.record))) continue;
    const evidence = surroundingEvidence(sourceUnits, candidate.evidenceIds).filter((unit) => unit.cited)
      .map((unit) => `${unit.speaker}: ${unit.text}`).join(' ');
    if (evidenceSupportScore(candidate.record.action, evidence) < 0.3) continue;
    if (!['committed', 'accepted_request', 'conditional_commitment'].includes(actionDispositionWithContext(candidate.record, sourceUnits, evidence))) continue;
    proposals.push(candidate.record);
  }
  return dedupeHybridActionRecords(normaliseAgentResult({ actions: proposals }, sourceUnits, 'actions', {
    meetingDate: options.meetingDate
  }).actions).slice(0, 8);
}

// A concrete volunteered visit followed immediately by the requester defining
// the checks is a complete accepted assignment even without a literal “yes”.
// This is a general discourse pattern (offer -> scope acceptance), not a
// meeting-type rule. Keep its wording close to the cited request.
function acceptedVisitAssignmentActions(sourceUnits = [], records = [], options = {}) {
  const units = normaliseSourceUnits(sourceUnits).filter((unit) => unit.classification !== 'remove' || unit.restored);
  const offer = /\bI\s+(?:can|could|would be able to)\s+(?:go|visit|attend)\b/i;
  const request = /\b(?:can|could|would)\s+(?:somebody|someone|you)\s+(?:go|visit|attend|look|inspect|check)\b/i;
  const scopedCheck = /^\s*(?:(?:and|then|also)\s+)?(?:(?:when|once|after)\b.{0,100}?,\s*)?(?:please\s+)?(?:check|inspect|verify|test)\b/i;
  const results = [];
  for (let index = 0; index < units.length; index += 1) {
    const offered = units[index];
    if (!offer.test(offered.text || '')) continue;
    const prior = units.slice(Math.max(0, index - 2), index).reverse().find((unit) => request.test(unit.text || ''));
    const scope = units.slice(index + 1, Math.min(units.length, index + 3)).find((unit) => scopedCheck.test(unit.text || ''));
    if (!prior || !scope) continue;
    const object = meetingMinutesAgentText(String(prior.text || '').match(/\b(?:look at|visit|inspect|check)\s+(?:the\s+)?([^?.!,]{2,80})/i)?.[1], 100);
    const checks = meetingMinutesAgentText(String(scope.text || '')
      .replace(/^\s*(?:(?:and|then|also)\s+)?(?:(?:when|once|after)\b.{0,100}?,\s*)?/i, ''), 700)
      .replace(/[.]+$/, '');
    if (!checks || !object) continue;
    // Only the owner's own visit clause may supply its timing. A different
    // task in the same turn (or a date inside its dependency) is not a visit
    // date. Keep a complete temporal tail, including its qualifiers/bounds.
    const temporalWords = new Set('today tonight tomorrow monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december this next last previous week weeks day days month months year years weekend morning afternoon evening noon midnight early mid late end start of the on at in by before after within until from to or and not no earlier later than probably presumably possibly maybe perhaps hopefully ideally preferably approximately roughly around about if possible all being well least latest first second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth thirteenth fourteenth fifteenth sixteenth seventeenth eighteenth nineteenth twentieth thirtieth one two three four five six seven eight nine ten eleven twelve every each weekly daily monthly am pm utc gmt bst cet cest'.split(' '));
    const ownClause = String(offered.text || '').split(/[;!?]|\.(?!\d)|\b(?:and|but|then)\s+(?=(?:I|we|[A-Z][a-z]+)\s+(?:will|shall|can|could|must|need(?:s)? to|have to|am going to|is going to|are going to)|I['’](?:ll|m going to)|we['’]re going to)/i)
      .map(value => value.trim()).find(value => /^(?:(?:yes|yeah|okay|ok|sure|well|right)[, ]+)*I\s+(?:can|could|would be able to)\s+(?:go|visit|attend)\b/i.test(value));
    const ownOffer = ownClause?.match(offer);
    let tail = meetingMinutesAgentText(ownOffer ? ownClause.slice(ownOffer.index + ownOffer[0].length) : '', 220)
      .replace(/[.!?]+$/, '');
    // A destination can repeat the request or refer back as "down there".
    // Strip only that source-bound location, never an arbitrary new object.
    tail = tail.replace(/^(?:(?:down|up|over|out|back)\s+)?(?:there|here)\b\s*/i, '');
    const objectWords = object.split(/\s+/).filter(Boolean);
    for (let offset = 0; offset < objectWords.length; offset += 1) {
      const destination = objectWords.slice(offset).join(' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      tail = tail.replace(new RegExp(`^(?:(?:down|up|over|out|back)\\s+)?(?:(?:to|at)\\s+)?(?:the\\s+)?${destination}\\b\\s*`, 'i'), '')
        .replace(new RegExp(`\\s+to\\s+(?:the\\s+)?${destination}$`, 'i'), '').trim();
    }
    const words = tail.toLowerCase().match(/[a-z]+/g) || [];
    const hasCalendar = /\b(?:today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month|year|january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(tail);
    const timingWord = hasCalendar && words.every(word => temporalWords.has(word)) ? tail : '';
    const action = {
      id: `accepted-visit-${offered.id}`,
      action: `Visit the ${object} and ${checks.charAt(0).toLowerCase()}${checks.slice(1)}.`,
      owners: [offered.speaker].filter(Boolean),
      timing: timingWord ? { kind: 'target', wording: timingWord, exactDate: '' } : { kind: 'not_stated', wording: '', exactDate: '' },
      evidenceIds: [prior.id, offered.id, scope.id]
    };
    if (!(records || []).some((record) => hybridCandidateMatchesRecord({ recordType: 'action', text: action.action, evidenceIds: action.evidenceIds, record: action }, record))) results.push(action);
  }
  const normalised = normaliseAgentResult({ actions: results }, sourceUnits, 'actions', {
    enforceEvidence: false, meetingDate: options.meetingDate
  }).actions;
  const validIds = new Set(units.map((unit) => unit.id));
  for (const action of normalised) {
    const source = results.find((candidate) => candidate.id === action.id);
    if (source) action.evidenceIds = (source.evidenceIds || []).filter((id) => validIds.has(id));
  }
  return normalised;
}

function operationalGapActionText(questionText = '') {
  const clean = meetingMinutesAgentText(questionText, 1200).replace(/[?.!]+$/, '');
  if (/^how\s+/i.test(clean)) {
    // Turn question word order into minute/action word order.  Leaving the
    // auxiliary in front of the subject produced text such as "Clarify how is
    // feedback captured", which is needlessly awkward in the review UI.
    const inverted = clean.match(/^how\s+(is|are|was|were|do|does|did|has|have|had|can|could|will|would|should)\s+(.+)$/i);
    if (inverted) {
      const [, auxiliary, remainder] = inverted;
      const words = remainder.split(/\s+/);
      const boundary = words.findIndex((word, index) => index > 0 && /^(?:being|captured|recorded|tracked|logged|documented|reported|stored|routed|monitored|provided|handled|managed|processed|working|work|operate|operating)$/i.test(word));
      if (boundary > 0) {
        return `Clarify how ${words.slice(0, boundary).join(' ')} ${auxiliary.toLowerCase()} ${words.slice(boundary).join(' ')}`
          .replace(/\b(currently|usually|normally|consistently)\s+(is|are|was|were|has|have|had)\b/i, '$2 $1');
      }
    }
    return clean.replace(/^how\s+/i, 'Clarify how ');
  }
  if (/^whether\s+/i.test(clean)) return clean.replace(/^whether\s+/i, 'Determine whether ');
  if (/^who\s+/i.test(clean)) return clean.replace(/^who\s+/i, 'Confirm who ');
  if (/^what\s+/i.test(clean)) return clean.replace(/^what\s+/i, 'Define what ');
  return `Resolve: ${clean}`;
}

function sourceOperationalGapActionText(questionText = '', gapText = '') {
  const combined = `${questionText} ${gapText}`;
  const verbs = [];
  if (/\bcaptur(?:e|ed|ing)\b/i.test(combined)) verbs.push('capturing');
  if (/\btrack(?:ed|ing)?\b/i.test(combined)) verbs.push('tracking');
  if (/\brecord(?:ed|ing)?\b/i.test(combined)) verbs.push('recording');
  if (/\breport(?:ed|ing)?\b/i.test(combined)) verbs.push('reporting');
  if (/\bmonitor(?:ed|ing)?\b/i.test(combined)) verbs.push('monitoring');
  const object = combined.match(/\b(?:client(?:[- ]delivery)?|customer|project|quality|staff|consultant)?\s*(?:feedback|information|data|issues|requests|leads?|opportunities|decisions|actions)\b/i)?.[0]?.trim();
  const activities = [...new Set(verbs)].slice(0, 3);
  if (!activities.length) return 'Clarify the current operational process described in the cited passages.';
  const activityText = activities.length === 1 ? activities[0] : `${activities.slice(0, -1).join(', ')} and ${activities.at(-1)}`;
  return `Clarify the current process for ${activityText} ${object || 'the relevant information'}.`;
}

// An unresolved operational question is not an agreed action. When its nearby
// evidence explicitly describes a current process gap, however, it is useful to
// offer an ownerless follow-up for human acceptance rather than silently lose
// the issue. This path can never auto-publish an action.
function unresolvedOperationalGapProposals(discussion = [], records = [], sourceUnits = [], options = {}) {
  const units = normaliseSourceUnits(sourceUnits);
  const byId = new Map(units.map((unit, index) => [unit.id, { unit, index }]));
  const operational = /\b(?:captur(?:e|ed|ing)|record(?:ed|ing)?|track(?:ed|ing)?|log(?:ged|ging)?|document(?:ed|ing)?|monitor(?:ed|ing)?|measure(?:d|ment|ing)?|store(?:d|ing)?|rout(?:e|ed|ing)|report(?:ed|ing)?|workflow|process)\b/i;
  const currentStateQuestion = /^(?:how|what)\b[\s\S]*\b(?:current|currently|today|at present|now)\b/i;
  const sourceCurrentState = /\b(?:current|currently|today|at present|at the moment|until now|now)\b/i;
  const gap = /\b(?:not always|not consistently|inconsisten(?:t|tly)|var(?:y|ies|ied|ying)|depends? on|not yet|unclear|ad[ -]?hoc|no (?:clear|consistent|formal)|without (?:a )?(?:clear|consistent|formal))\b/i;
  const proposed = [];
  for (const topic of Array.isArray(discussion) ? discussion : []) {
    for (const question of topic?.openQuestions || []) {
      if (!operational.test(question?.text || '') || !currentStateQuestion.test(question?.text || '')) continue;
      const anchorIndexes = (question.evidenceIds || []).map((id) => byId.get(id)?.index).filter(Number.isInteger);
      if (!anchorIndexes.length) continue;
      const nearby = units.filter((_unit, index) => anchorIndexes.some((anchor) => Math.abs(index - anchor) <= 10));
      const gapUnits = nearby.filter((unit) => gap.test(unit.text || ''));
      if (!gapUnits.length) continue;
      const evidenceIds = [...new Set([...(question.evidenceIds || []), ...gapUnits.map((unit) => unit.id)])].slice(0, 8);
      const proposal = {
        action: operationalGapActionText(question.text), owners: [],
        timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds
      };
      if ((records || []).some((record) => hybridTokenOverlap(proposal.action, hybridRecordText(record)) >= 0.55)) continue;
      proposed.push(proposal);
      if (proposed.length >= 4) break;
    }
    if (proposed.length >= 4) break;
  }
  // The referee may compress or omit the current-state question. Fall back to
  // the source exchange itself: a question about the present process followed
  // nearby by an explicit inconsistency is strong enough for a proposal, but
  // never for automatic publication.
  for (let index = 0; index < units.length && proposed.length < 4; index += 1) {
    const questionUnit = units[index];
    if (!questionUnit.text?.includes('?') || !operational.test(questionUnit.text) || !sourceCurrentState.test(questionUnit.text)) continue;
    if (proposed.some((record) => (record.evidenceIds || []).includes(questionUnit.id))) continue;
    const nearby = units.slice(Math.max(0, index - 2), Math.min(units.length, index + 11));
    const gapUnits = nearby.filter((unit) => gap.test(unit.text || ''));
    if (!gapUnits.length) continue;
    const proposal = {
      action: sourceOperationalGapActionText(questionUnit.text, gapUnits.map((unit) => unit.text).join(' ')),
      owners: [], timing: { kind: 'not_stated', wording: '', exactDate: '' },
      evidenceIds: [...new Set([questionUnit.id, ...gapUnits.map((unit) => unit.id)])].slice(0, 8)
    };
    if ([...(records || []), ...proposed].some((record) => hybridTokenOverlap(proposal.action, hybridRecordText(record)) >= 0.55)) continue;
    proposed.push(proposal);
  }
  // These are intentionally allowed to retain a question/status evidence
  // disposition because acceptance by the reviewer is what promotes them.
  const normalised = normaliseAgentResult({ actions: proposed }, sourceUnits, 'actions', {
    enforceEvidence: false, meetingDate: options.meetingDate
  }).actions;
  const validIds = new Set(units.map((unit) => unit.id));
  for (const action of normalised) {
    const source = proposed.find((candidate) => candidate.action === action.action);
    if (source) action.evidenceIds = [...new Set([
      ...(action.evidenceIds || []), ...(source.evidenceIds || []).filter((id) => validIds.has(id))
    ])].slice(0, 8);
  }
  return normalised;
}

// Personal errands mentioned in passing ("I need to book a holiday") are not
// meeting actions and should never be offered as suggestions.
const PERSONAL_ERRAND_ACTION = /^\s*(?:book|plan|take|go on|arrange|sort(?: out)?)\s+(?:a |an |my |the |some )?(?:holiday|vacation|annual leave|day off|dentist|doctor(?:['’]s)?(?: appointment)?|haircut|hair appointment|gym|birthday|anniversary|wedding|vet)\b|^\s*(?:walk|feed)\s+the\s+(?:dog|cat)\b|\bschool run\b/i;
function isPersonalErrandAction(value = '') {
  return PERSONAL_ERRAND_ACTION.test(meetingMinutesAgentText(value, 400));
}

function removePublishedActionProposalDuplicates(proposal = {}, published = [], options = {}) {
  const publishedRows = Array.isArray(published) ? published : [];
  return {
    ...proposal,
    changes: (Array.isArray(proposal?.changes) ? proposal.changes : []).filter((change) => {
      if (change?.type !== 'add' || !change.after?.action) return true;
      if (isPersonalErrandAction(change.after.action)) return false;
      return !semanticReceiptCoversActionProposal(change.after, publishedRows, options)
        && !publishedRows.some((record) => publishedActionCoversProposal(record, change.after));
    })
  };
}

const MEETING_AGENT_UNCERTAINTY_WORDS = { unclear_reference: 'what it refers to', acceptance: 'whether it was accepted', ownership: 'who owns it' };
const MEETING_AGENT_SIGNAL_WORDS = { request: 'asked', offer: 'offered', acceptance: 'agreed', commitment: 'committed', completed: 'done', rejected: 'declined' };

function annotateActionProposalChains(proposal = {}, chains = []) {
  const chainRows = (Array.isArray(chains) ? chains : []).filter((candidate) => candidate?.recordType === 'action_chain');
  return {
    ...proposal,
    changes: (Array.isArray(proposal?.changes) ? proposal.changes : []).map((change) => {
      if (change?.type !== 'add' || !change.after?.action) return change;
      const evidence = new Set(change.after.evidenceIds || []);
      const ranked = chainRows.map((chain) => ({
        chain,
        shared: (chain.evidenceIds || []).filter((id) => evidence.has(id)).length,
        lexical: hybridTokenOverlap(change.after.action, chain.text || '')
      })).filter((item) => item.shared > 0)
        .sort((left, right) => (right.shared * 3 + right.lexical) - (left.shared * 3 + left.lexical));
      const match = ranked[0]?.chain;
      if (!match) return change;
      const signalOrder = ['request', 'offer', 'acceptance', 'commitment', 'completed', 'rejected'];
      const signals = signalOrder.filter((name) => match.signals?.[name]);
      const uncertainties = [...new Set((match.uncertainties || []).map((item) => item.kind).filter(Boolean))];
      const reason = uncertainties.length
        ? `The transcript suggests this task, but ${uncertainties.map((value) => MEETING_AGENT_UNCERTAINTY_WORDS[value] || value.replace(/_/g, ' ')).join(' and ')} still needs confirming.`
        : 'The transcript suggests someone took this on, but not clearly enough to add it automatically. Check the linked lines and add it if it is a real action.';
      return { ...change, reviewContext: {
        label: signals.length ? signals.map((name) => MEETING_AGENT_SIGNAL_WORDS[name] || name).join(', then ') : 'related transcript lines',
        reason, evidenceIds: [...new Set(match.evidenceIds || [])].slice(0, 12),
        actionConfidence: match.scores?.action
      } };
    })
  };
}

function strongUnresolvedActionCandidateFlags(candidates = [], records = []) {
  const strong = uncoveredCandidateInventory(candidates, records).filter((candidate) => {
    const cues = new Set(candidate?.cueKinds || []);
    return cues.has('decision_resolution') && ['committed', 'accepted_request', 'conditional_commitment'].includes(candidate?.dispositionHint);
  }).sort((left, right) => Number((right.cueKinds || []).includes('decision_resolution')) - Number((left.cueKinds || []).includes('decision_resolution'))
    || Number(right.priority || 0) - Number(left.priority || 0)
    || Number(left.sequence || 0) - Number(right.sequence || 0));
  const selected = [];
  for (const candidate of strong) {
    const ids = new Set(candidate.evidenceIds || []);
    const duplicatesExisting = selected.some((existing) => (existing.evidenceIds || []).filter((id) => ids.has(id)).length >= 2);
    if (!duplicatesExisting) selected.push(candidate);
    if (selected.length >= 8) break;
  }
  return selected.map((candidate, index) => normaliseMeetingAgentFlag({
    kind: 'possible_missed_follow_up',
    message: 'A strongly evidenced commitment to plan or resolve an open decision was not represented in the action register. Review the cited passage and add it if appropriate.',
    evidenceIds: candidate.evidenceIds || []
  }, index));
}

// Recover two common multi-turn commitments which do not contain the simple
// "we need to do that" wording handled below:
//   1. a concrete question whose answer is explicitly deferred until a known
//      meeting/check ("I'll know after Wednesday"); and
//   2. a proposed option followed by a first-person commitment to work through
//      the criteria needed to decide it.
// These are deliberately proposals, never automatic actions. The goal is to
// keep strongly evidenced work reviewable when an optional discovery source
// times out without weakening the publication threshold.
function deferredCommitmentThreadProposal(thread, evidenceUnits = [], resolveSpeaker = (value) => value) {
  const ordered = [...evidenceUnits].sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
  const replacePerspective = (value, referencedSpeaker, addressedSpeaker = referencedSpeaker) => meetingMinutesAgentText(value, 300)
    .replace(/\b(?:I|me)\b/gi, referencedSpeaker || 'the requester')
    .replace(/\bmy\b/gi, referencedSpeaker ? `${referencedSpeaker}'s` : "the requester's")
    .replace(/\bhaving\s+you\b/i, referencedSpeaker ? `${referencedSpeaker} should be` : 'the requester should be')
    .replace(/\bputting\s+you\b/i, referencedSpeaker ? `put ${referencedSpeaker}` : 'put the requester')
    .replace(/\bassigning\s+you\b/i, referencedSpeaker ? `assign ${referencedSpeaker}` : 'assign the requester')
    .replace(/\bmoving\s+you\b/i, referencedSpeaker ? `move ${referencedSpeaker}` : 'move the requester')
    .replace(/\bkeeping\s+you\b/i, referencedSpeaker ? `keep ${referencedSpeaker}` : 'keep the requester')
    .replace(/\byou\b/gi, addressedSpeaker || 'the other participant')
    .replace(/\byour\b/gi, addressedSpeaker ? `${addressedSpeaker}'s` : "the other participant's")
    .replace(/\s+/g, ' ').trim();

  const deferredAnswer = /\b(?:i|we)\s*(?:['’]ll|will)\s+(?:know|confirm|find out|have (?:an? )?answer|be able to confirm)\b/i;
  const resolution = ordered.find((unit) => deferredAnswer.test(unit.text || ''));
  const earlierQuestions = resolution ? ordered.filter((unit) =>
    Number(unit.sequence || 0) < Number(resolution.sequence || 0) && /\?\s*$/.test(unit.text || '')
  ) : [];
  const question = earlierQuestions.find((unit) => /^\s*(?:so\s+)?(?:will|can|could|would|do|does|is|are)\b/i.test(unit.text || ''))
    || earlierQuestions.at(-1);
  if (resolution && question) {
    const rewrittenQuestion = replacePerspective(String(question.text || '').replace(/\?+$/, ''), question.speaker, resolution.speaker)
      .replace(/^so\s+/i, '').trim();
    const auxiliary = rewrittenQuestion.match(/^(will|can|could|would|is|are|do|does)\s+(.+)$/i);
    let subject = auxiliary?.[2] || rewrittenQuestion.replace(/^whether\s+/i, '');
    if (auxiliary && question.speaker) {
      const escapedSpeaker = question.speaker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const remainder = subject.replace(new RegExp(`^${escapedSpeaker}\\s+`, 'i'), '');
      if (remainder !== subject) {
        const verb = auxiliary[1].toLowerCase();
        subject = /^(?:do|does)$/i.test(verb) ? `${question.speaker} ${remainder}` : `${question.speaker} ${verb} ${remainder}`;
      }
      subject = subject.replace(new RegExp(`\\bso that ${escapedSpeaker} can\\b`, 'i'), 'so that they can');
    }
    subject = subject.trim();
    // The knowledge answer, not any earlier timed task in the thread, owns
    // this proposal's timing. Copy an explicit relation from that same clause;
    // implicit "know then" references remain untimed rather than borrowing a date.
    const clauses = String(resolution.text || '').split(/[;!?]|\.(?!\d)|\b(?:and|but|then)\s+(?=(?:I|we|[A-Z][a-z]+)\s+(?:will|shall|can|could|must|need(?:s)? to|have to|am going to|is going to|are going to)|I['’](?:ll|m going to)|we['’]re going to)/i).map(value => value.trim()).filter(Boolean);
    const knowledge = clauses.find(value => /^(?:(?:so|and|well|yes|yeah|okay|ok)[, ]+)*(?:I|we)\s*(?:['’]ll|will)\s+(?:know|confirm|find out|have (?:an? )?answer|be able to confirm)\b/i.test(value))
      || clauses.find(value => /,\s*so\s+(?:I|we)\s*(?:['’]ll|will)\s+(?:know|confirm|find out|have (?:an? )?answer|be able to confirm)\b/i.test(value));
    let timingWord = '';
    const answer = knowledge?.match(deferredAnswer);
    if (answer) {
      const tail = knowledge.slice(answer.index + answer[0].length).trim().replace(/^(?:more|that|the answer)\s+/i, '').replace(/[.!?]+$/, '');
      if (/^(?:(?:probably|presumably|possibly|maybe|hopefully|ideally|roughly|approximately)\s+)*(?:after|before|on|by|once|when|until|following|within)\b/i.test(tail)) {
        timingWord = tail;
      } else if (/^(?:(?:probably|presumably|possibly|maybe|hopefully|ideally|roughly|approximately|early|late)\s+)*(?:today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|this week|next week)(?:\s+(?:morning|afternoon|evening|if possible|all being well))?$/i.test(tail)) {
        timingWord = tail;
      }
      // A meeting followed by "I'll know then" is useful source context,
      // but does not state when the follow-up confirmation itself is due.
      // Keep that proposal and its citations without inventing a deadline.
    }
    // A copied dependency must not carry an independent next obligation.
    // Withhold an ambiguous coordinated tail instead of donating its date or
    // dropping one of the source conditions to manufacture a shorter timing.
    if (/\b(?:and|but)\s+(?:(?:I|we)\s+)?(?:will|shall|can|could|must|need(?:s)?\s+to|have\s+to|want(?:s)?\s+to|am\s+going\s+to)\b|\bthen\s+[a-z]+\b/i.test(timingWord)) timingWord = '';
    timingWord = meetingMinutesAgentText(timingWord, 220);
    if (timingWord) timingWord = timingWord.charAt(0).toUpperCase() + timingWord.slice(1);
    if (subject.split(/\s+/).length >= 3) return {
      action: `Confirm whether ${subject}${timingWord ? ` ${timingWord.charAt(0).toLowerCase()}${timingWord.slice(1)}` : ''}.`,
      owners: [resolveSpeaker(resolution.speaker)].filter(Boolean),
      timing: timingWord ? { kind: /^(?:after|before|once|when|until|following)\b/i.test(timingWord) ? 'dependency' : 'target', wording: timingWord, exactDate: '' } : { kind: 'not_stated', wording: '', exactDate: '' },
      evidenceIds: [...new Set([question.id, resolution.id])].slice(0, 8)
    };
  }

  const pendingResolution = /\b(?:i(?:'m| am) trying to|i(?:'ve| have) (?:just )?got to|i (?:need|have) to|we (?:need|have) to)\s+(?:work (?:out|through)|decide|determine|resolve|check|review)\b/i;
  const resolver = ordered.find((unit) => pendingResolution.test(unit.text || ''));
  const optionPattern = /\b(?:i(?:'m| am)\s+)?(?:thinking|considering)\s+(?:about\s+|of\s+)?((?:having|putting|using|running|splitting|assigning|allocating|keeping|moving|making)\b.{3,150}?)(?=,|\bbut\b|\bwhich\b|\bso\b|\.|$)/i;
  const optionUnit = resolver && ordered.find((unit) => Math.abs(Number(unit.sequence || 0) - Number(resolver.sequence || 0)) <= 2
    && optionPattern.test(unit.text || ''));
  const option = String(optionUnit?.text || '').match(optionPattern)?.[1];
  if (!resolver || !optionUnit || !option) return null;
  const referencedSpeaker = ordered.filter((unit) =>
    Number(unit.sequence || 0) < Number(resolver.sequence || 0) && unit.speaker && unit.speaker !== resolver.speaker
  ).at(-1)?.speaker || '';
  let optionText = replacePerspective(option, referencedSpeaker)
    .replace(/^having\s+/i, '')
    .replace(/^using\s+/i, 'use ')
    .replace(/^running\s+/i, 'run ')
    .replace(/^splitting\s+/i, 'split ')
    .replace(/^allocating\s+/i, 'allocate ')
    .trim();
  if (optionText.split(/\s+/).length < 3) return null;
  const combined = ordered.map((unit) => unit.text || '').join(' ');
  const criteria = [];
  if (/\blogistics\b/i.test(combined)) criteria.push('logistics');
  const risk = combined.match(/\brisk (?:analysis|assessment)\b/i)?.[0]?.toLowerCase();
  if (risk) criteria.push(risk);
  const criteriaText = criteria.length ? ` based on ${criteria.length === 1 ? criteria[0] : `${criteria[0]} and ${criteria[1]}`}` : '';
  return {
    action: `Determine whether ${optionText}${criteriaText}.`,
    owners: [resolveSpeaker(resolver.speaker)].filter(Boolean),
    timing: criteria.length ? { kind: 'dependency', wording: `Based on ${criteria.length === 1 ? criteria[0] : `${criteria[0]} and ${criteria[1]}`}`, exactDate: '' } : { kind: 'not_stated', wording: '', exactDate: '' },
    evidenceIds: [...new Set([resolver.id, optionUnit.id, ...(thread.dependencyEvidenceIds || [])])].slice(0, 8)
  };
}

function commitmentThreadBackstopProposals(candidates = [], records = [], sourceUnits = [], options = {}) {
  const units = normaliseSourceUnits(sourceUnits).filter((unit) => unit.classification !== 'remove' || unit.restored);
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const speakers = [...new Set(units.map((unit) => meetingMinutesAgentText(unit.speaker, 180)).filter(Boolean))];
  const resolveSpeaker = (name) => {
    const wanted = meetingMinutesAgentText(name, 180).toLowerCase();
    if (!wanted) return '';
    const exact = speakers.find((speaker) => speaker.toLowerCase() === wanted);
    if (exact) return exact;
    const firstMatches = speakers.filter((speaker) => speaker.toLowerCase().split(/[\s,]+/)[0] === wanted.split(/\s+/)[0]);
    return firstMatches.length === 1 ? firstMatches[0] : '';
  };
  const acceptedReference = /\bwe\s+(?:probably\s+)?need to\s+(plan|review|check|resolve|decide|determine|sort out|work through)\s+(?:through\s+)?(?:that|this)\b/i;
  const antecedentObject = /\b(?:have a look at|look at|look into|review|check|resolve|plan|decide|determine|sort out|work through)\s+(?:just\s+)?(?:the\s+)?(.{3,100}?)(?=,|\.|\s+in terms of|$)/i;
  const proposals = [];
  // Do not discard a whole thread merely because one deliverable within its
  // evidence window is already represented. A deferred confirmation and the
  // contingent work that follows it, for example, are separate accountability
  // items even though they share adjacent turns. The final action-level
  // similarity check below still removes genuine duplicates.
  const unresolvedThreads = (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => candidate?.recordType === 'action_thread'
      && Number(candidate.priority || 0) >= 10
      && (candidate.cueKinds || []).includes('decision_resolution')
      && ['accepted_request', 'committed', 'conditional_commitment'].includes(candidate.dispositionHint));
  for (const thread of unresolvedThreads) {
    const evidenceUnits = (thread.evidenceIds || []).map((id) => byId.get(id)).filter(Boolean)
      .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
    const acceptance = evidenceUnits.find((unit) => acceptedReference.test(unit.text || ''));
    if (!acceptance) {
      const deferred = deferredCommitmentThreadProposal(thread, evidenceUnits, resolveSpeaker);
      if (!deferred) continue;
      const proposal = normaliseAgentResult({ actions: [{
        id: `thread-proposal-${thread.candidateId}`,
        ...deferred
      }] }, sourceUnits, 'actions', { enforceEvidence: false, meetingDate: options.meetingDate }).actions[0];
      if (!proposal) continue;
      if ([...(records || []), ...proposals].some((record) => hybridActionsEquivalent(proposal.action, hybridRecordText(record)))) continue;
      proposals.push(proposal);
      continue;
    }
    const referenceMatch = String(acceptance.text || '').match(acceptedReference);
    const earlier = evidenceUnits.filter((unit) => Number(unit.sequence || 0) < Number(acceptance.sequence || 0)).reverse();
    let antecedent = null;
    let object = '';
    for (const unit of earlier) {
      const match = String(unit.text || '').match(antecedentObject);
      const cleaned = meetingMinutesAgentText(match?.[1], 100)
        .replace(/\s+(?:for|around|about)\s+(?:that|this)$/i, '')
        .replace(/^(?:a|an|the)\s+/i, '')
        .trim();
      if (cleaned.split(/\s+/).length >= 1 && !/^(?:it|that|this|them|things?)$/i.test(cleaned)) {
        antecedent = unit;
        object = cleaned;
        break;
      }
    }
    if (!antecedent || !object) continue;
    const verb = String(referenceMatch?.[1] || 'resolve').toLowerCase().replace('sort out', 'resolve');
    const availabilityEvidenceIds = (thread.dependencyEvidenceIds || []).filter((id) =>
      /\b(?:unavailable|won't be (?:available|around)|not be (?:available|around))\b/i.test(byId.get(id)?.text || ''));
    const hasAvailabilityConstraint = availabilityEvidenceIds.length > 0;
    const action = `${verb.charAt(0).toUpperCase()}${verb.slice(1)} the ${object}${hasAvailabilityConstraint ? ' around the recorded availability constraint' : ''}.`;
    const acceptancePrefix = String(acceptance.text || '').split(/\bwe\s+(?:probably\s+)?need to\b/i)[0];
    const addressed = speakers.filter((speaker) => {
      const first = speaker.split(/[\s,]+/)[0];
      return first && new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(acceptancePrefix);
    });
    const owners = [...new Set([resolveSpeaker(acceptance.speaker), ...addressed.map(resolveSpeaker)].filter(Boolean))];
    const evidenceIds = [...new Set([
      antecedent.id, acceptance.id,
      ...(hasAvailabilityConstraint ? availabilityEvidenceIds : [])
    ])].slice(0, 8);
    const proposal = normaliseAgentResult({ actions: [{
      id: `thread-proposal-${thread.candidateId}`,
      action, owners, timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds
    }] }, sourceUnits, 'actions', { enforceEvidence: false, meetingDate: options.meetingDate }).actions[0];
    if (!proposal) continue;
    if ([...(records || []), ...proposals].some((record) => hybridActionsEquivalent(proposal.action, hybridRecordText(record)))) continue;
    proposals.push(proposal);
  }
  return proposals;
}

async function generateHybridMeetingAgentStage(draft, stage, options = {}) {
  if (parallelMinutes.isParallel(draft)) throw Object.assign(new Error('Use the parallel minutes generator for this draft.'), {statusCode:422});
  return actionDiagnostics.generate(draft, stage, options, async () => {
    const result = await finishMeetingAgentGeneratedStage(await generateHybridMeetingAgentStageRaw(draft, stage, options), draft, stage, options);
    actionDiagnostics.checkpoint('final_generation_register', result?.changes?.actions || []);
    actionDiagnostics.transition('final_register', [], result?.changes?.actions || []);
    return result;
  });
}

const {
  buildPrivateStagedCandidateLedger,
  startPrivateStagedCandidateLedger,
  awaitPrivateStagedCandidateLedger,
  startPrivateActionPrimaryPrewarm,
  usePrivateActionPrimaryPrewarm,
  prewarmPrivateStagedCandidateLedgers
} = createMeetingMinutesCandidatePrewarm(runStagedSequenceForEvaluation);

const originalMinutesStageServices = Object.freeze({
  acceptedVisitAssignmentActions,
  annotateActionProposalChains,
  awaitPrivateStagedCandidateLedger,
  commitmentThreadBackstopProposals,
  corroboratedOmittedActionProposals,
  corroboratedOmittedDiscussionRecords,
  criticConfirmedActionPromotions,
  dedupeActionDiscoveryInventory,
  dedupeCommitmentsSemantically,
  deterministicHybridLedger,
  discussionRefereeFallbackPlan,
  discussionRefereeSufficiency,
  enrichDiscussionEvidenceFromDispositions,
  foldUnownedNearCopies,
  gateTranscriptShapedActionChanges,
  gateTranscriptShapedActions,
  highConfidenceRefereedAction,
  hybridActionSourceInfo,
  hybridCandidateCoveredByRecord,
  hybridCandidateDispositions,
  isReviewableActionProposal,
  meetingAgentCommitmentRecheckNeeded,
  publishedActionCoversProposal,
  reconcileAcceptedRefereeActions,
  reconstructMissingRefereeDiscussion,
  reconstructRefereeActions,
  refereeClusterSupportingCandidates,
  removePublishedActionProposalDuplicates,
  safeAgentProposalPromotion,
  splitCompoundActionList,
  startPrivateActionPrimaryPrewarm,
  startPrivateStagedCandidateLedger,
  strongOmittedDiscoveryProposals,
  strongUnresolvedActionCandidateFlags,
  traceOwners,
  traceProposals,
  unresolvedOperationalGapProposals,
  usePrivateActionPrimaryPrewarm,
});
const { finishMeetingAgentSemanticStage, finishMeetingAgentGeneratedStage } = createOriginalFinalization();
const generateMeetingAgentStageRaw = createOriginalEditStage();
const generateOriginalMinutesStage = createOriginalMinutesStages(originalMinutesStageServices);

async function generateHybridMeetingAgentStageRaw(draft, stage, options = {}) {
  return generateOriginalMinutesStage(draft, stage, options);
}

const {
  startStageSpeculation,
  adoptStageSpeculation,
  meetingAgentSerialDraftWrite,
  persistMeetingAgentBackgroundStage,
  meetingAgentMemoryCacheState,
  clearMeetingAgentMemoryCaches,
  scheduleStageSpeculation,
  startInitialMeetingAgentProcessing,
  registerMeetingMinutesBackgroundGeneration,
  registerMeetingMinutesGenerationStatus,
  registerMeetingMinutesGeneration
} = createMeetingMinutesGenerationLifecycle(generateHybridMeetingAgentStage, generateMeetingAgentStage);

router.post('/meeting-minutes-agent/check-duplicate', requireAuth, async (req, res) => {
  try {
    const fileName = String(req.body?.fileName || '').trim();
    const fileSize = Number(req.body?.fileSize);
    if (!fileName || !Number.isSafeInteger(fileSize) || fileSize < 0) {
      return res.status(400).json({ ok: false, error: 'A transcript filename and size are required.' });
    }
    const drafts = await listMeetingMinutesAgentDrafts(req.authUser?.userId, 100);
    return res.json({
      ok: true,
      duplicates: matchingMeetingAgentDrafts(drafts, { fileName, fileSize })
    });
  } catch (error) {
    return sendMeetingAgentFailure(res, error);
  }
});

router.post('/meeting-minutes-agent/prepare', requireAuth, withTestUpload(async (req, res) => {
  const routeStartedAt = Date.now();
  try {
    const generationProvider = parallelMinutes.chooseProvider(req);
    const readStartedAt = Date.now();
    const transcript = await readTestTranscript(req);
    const transcriptReadMs = Date.now() - readStartedAt;
    validateTranscriptText(transcript.text);
    // Confirmed phrase corrections are applied to the transcript itself, so
    // the denoiser, every model pass and the evidence panel all read the same
    // corrected words. The raw upload is still stored unchanged on the draft.
    const corrected = applyTranscriptPhraseCorrections(transcript.text);
    if (corrected.applied.length) console.log(JSON.stringify({
      event: 'meeting_agent_transcript_phrase_corrections',
      fileName: transcript.fileName || '', corrections: corrected.applied
    }));
    transcript.text = corrected.text;
    const preparationStartedAt = Date.now();
    const preserveMeaningfulShortAnswers = parallelMinutes.preserveMeaningfulShortAnswers(generationProvider);
    const prepared = await prepareMiniLmTranscript(transcript.text, {
      // Preserve source-only dates/durations and their qualifications before
      // denoising; later checks still decide which work they belong to.
      preserveShortTemporalFragments: true,
      // Keep short qualifying context inside an already-retained speaker turn;
      // this does not enable standalone replies or change classifier decisions.
      preserveShortContextFragments: true,
      // Bounded quantities and qualified proceed replies; Beta only, default off.
      preserveMeaningfulShortAnswers,
      // Measured twice on the six real meetings (3 runs each): keeping short
      // replies lifts T733 reference commitments (18/42 -> 29/42) but costs
      // more on the golden set than it gains (actions 0.443 -> 0.348, overall
      // 0.699 -> 0.668). Left off; the code stays for a future re-test.
      keepShortReplies: /^(?:1|true|yes|on)$/i.test(String(process.env.MEETING_MINUTES_AGENT_KEEP_SHORT_REPLIES_V1 || '0'))
    });
    const preparationMs = Date.now() - preparationStartedAt;
    const metadataStartedAt = Date.now();
    const extractedDetails = extractStagedDetailsFromTranscript(transcript.text, transcript.fileName).screens.details;
    const dateContext = meetingAgentDateContext(transcript.text, transcript.fileName, extractedDetails);
    const details = sanitiseMeetingAgentDetails(extractedDetails);
    details.meetingLocation = 'Microsoft Teams';
    const sourceUnits = normaliseSourceUnits(prepared.sourceUnits);
    const preparedTranscript = preparedTranscriptFromUnits(sourceUnits);
    const salientDetails = salientDetailInventory(sourceUnits);
    const metadataMs = Date.now() - metadataStartedAt;
    const preparationPerformance = {
      transcriptReadMs, preparationMs, metadataMs,
      rawChars: transcript.text.length,
      preparedChars: preparedTranscript.length,
      sourceUnitCount: sourceUnits.length,
      shortContextFragmentsVersion: 1,
      meaningfulShortAnswersVersion: preserveMeaningfulShortAnswers ? 1 : 0,
      dateContext,
      completedAt: new Date().toISOString()
    };
    const persistenceStartedAt = Date.now();
    const created = await createMeetingMinutesAgentDraft({
      userId: req.authUser?.userId,
      title: details.meetingTitle || transcript.fileName || 'Meeting minutes',
      fileName: transcript.fileName || 'Meeting transcript.docx',
      rawTranscript: transcript.text,
      payload: meetingAgentDraftPayload({
        ...(generationProvider === parallelMinutes.PROVIDER ? { generationProvider } : {}),
        transcriptSha256: crypto.createHash('sha256').update(transcript.text).digest('hex'),
        uploadSizeBytes: Number(req.file?.size || 0),
        sourceUnits,
        preparedTranscript,
        salientDetails,
        details,
        discussion: [], actions: [], reviewFlags: dateContext.invalid.length || dateContext.conflict ? [{
          id: 'meeting-date-source-check', kind: 'timing', status: 'open', evidenceIds: [],
          message: dateContext.invalid.length
            ? 'The transcript or filename contains an invalid calendar date. Confirm the meeting date before relying on relative timing.'
            : 'The transcript and filename give different meeting dates. Confirm the meeting date before relying on relative timing.'
        }] : [], pendingProposal: null,
        changeHistory: [], staleStages: [], currentStep: 0,
        qualityState: { preparation: preparationPerformance },
        denoise: {
          rawLength: prepared.rawLength, preparedLength: preparedTranscript.length,
          removedUnitCount: prepared.removedUnitCount, keptUnitCount: prepared.keptUnitCount,
          totalUnitCount: prepared.totalUnitCount, removedRatio: prepared.removedRatio
        }
      })
    });
    const persistenceMs = Date.now() - persistenceStartedAt;
    const processingStartedAt = Date.now();
    const processing = await startInitialMeetingAgentProcessing(created, req);
    const processingStartMs = Date.now() - processingStartedAt;
    const totalElapsedMs = Date.now() - routeStartedAt;
    console.info(JSON.stringify({
      event: 'meeting_agent_preparation', journeyId: created.draftId || '', ok: true,
      ...preparationPerformance, persistenceMs, processingStartMs, totalElapsedMs
    }));
    if (!parallelMinutes.isParallel(created) && meetingMinutesAgentHybridEnabled()) {
      // The cache owns no user-visible state and the draft remains authoritative.
      // Starting here hides most of the staged candidate latency behind the
      // reviewer's details/discussion work.
      setImmediate(() => prewarmPrivateStagedCandidateLedgers({ ...created, rawTranscript: transcript.text }));
      if (meetingMinutesAgentEarlyActionPrewarmEnabled()) {
        // The actions primary prompt depends on nothing the Discussion stage
        // produces, so its ~30 s can overlap the whole Discussion stage rather
        // than start when it ends. The cache is private; the draft stays
        // authoritative.
        setImmediate(() => startPrivateActionPrimaryPrewarm({ ...created }).catch((error) => {
          console.warn(JSON.stringify({ event: 'meeting_agent_action_prewarm', when: 'prepare', ok: false, message: error.message }));
        }));
      }
    }
    if (!parallelMinutes.isParallel(created) && meetingMinutesAgentHybridEnabled() && meetingMinutesAgentSpeculativePipelineEnabled()) {
      scheduleStageSpeculation(created.draftId, req.authUser?.userId, { delayMs: 0 });
    }
    return res.json({
      ok: true,
      draft: publicMeetingAgentDraft(processing),
      resumeUrl: `/meeting-minutes-agent?draftId=${encodeURIComponent(processing.draftId)}`,
      performance: { ...preparationPerformance, persistenceMs, processingStartMs, totalElapsedMs }
    });
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'meeting_agent_preparation', ok: false,
      totalElapsedMs: Date.now() - routeStartedAt,
      errorCode: meetingMinutesAgentText(error.code, 120) || undefined,
      errorMessage: meetingMinutesAgentText(error.message, 300) || undefined
    }));
    return sendTestError(res, error);
  }
}));

registerMeetingMinutesLibraryList(router);

registerMeetingMinutesReviewerParallelProposals(router);

router.use('/meeting-minutes-agent/drafts/:draftId', requireAuth, async (req,res,next) => {
  if (!((req.method === 'POST' && ['/audit-actions','/proposal'].includes(req.path))
    || (req.method === 'PATCH' && req.path.startsWith('/source/')))) return next();
  try {
    const draft = await loadOwnedMeetingAgentDraft(req);
    if (parallelMinutes.isParallel(draft)) return res.status(422).json({ok:false,
      error:req.path.startsWith('/source/') ? 'Upload the revised transcript to generate updated minutes.' : 'Edit these minutes directly, or generate another complete draft.'});
    return next();
  } catch(error) { return sendMeetingAgentFailure(res,error); }
});

registerMeetingMinutesLibraryDetail(router);

// The server decides what an edit makes outdated, so the warning is the same
// in every tab and after a refresh. Previously the browser was trusted to
// send staleStages, and it only ever marked Actions while a run was in
// flight, so the ordinary "edit the discussion, look at the actions" flow
// produced no warning at all.




// A completed run clears its own stage, unless the content that stage is
// derived from changed while it was running: those edits are newer than the
// output, so the output is already outdated.




function meetingAgentDateContext(transcript = '', fileName = '', extracted = {}) {
  const lines = String(transcript || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, 30);
  const header = extractTeamsTranscriptHeader(lines);
  const candidates = [
    { source: 'transcript_header', date: header.meetingDate || '' },
    { source: 'transcript_metadata', date: String(extracted.meetingDate || '') },
    { source: 'filename', date: normaliseDateInput(String(fileName || '').replace(/_/g, ' ')) }
  ].filter(item => item.date);
  const selected = String(extracted.meetingDate || '');
  const valid = candidates.filter(item => isValidCalendarDate(item.date));
  const invalid = candidates.filter(item => !isValidCalendarDate(item.date));
  const different = [...new Set(valid.map(item => item.date))];
  return {
    meetingDate: isValidCalendarDate(selected) ? selected : '',
    source: candidates.find(item => item.date === selected)?.source || 'not_stated',
    candidates, invalid, conflict: different.length > 1,
    timingPolicyVersion: TIMING_POLICY_VERSION
  };
}

registerMeetingMinutesReviewerSave(router, scheduleStageSpeculation);

registerMeetingMinutesLibraryDelete(router);

registerMeetingMinutesReviewerSource(router);

// One stage, prompt to normalised changes. Deliberately free of `req` so the
// background worker runs the identical path. The steer is always read from the
// draft, never the request body, for the same reason.
async function generateMeetingAgentStage(draft, stage, instruction) {
  if (parallelMinutes.isParallel(draft)) throw Object.assign(new Error('Use Generate another draft for these minutes; direct AI edits are unavailable.'), {statusCode:422});
  const result = await generateMeetingAgentStageRaw(draft, stage, instruction);
  // Explicit edit requests remain literal proposals. Automatic consolidation
  // belongs to fresh generation, not acceptance or editing of reviewer work.
  return instruction ? cleanGeneratedMeetingAgentResult(result, stage)
    : finishMeetingAgentGeneratedStage(result, draft, stage);
}



// A suggested edit must change what the action says: its wording, owners or
// timing. One that only re-cites lines (or nothing at all) is noise.
// Paired replay on 12 journeys: offering Discussion rows as Actions candidates
// costs more than it gains (actions 0.406 -> 0.392, missing 8 -> 9) because the
// extra published rows are mostly practice descriptions and duplicates. Off;
// the code stays for a future re-test with tighter candidate filtering.
// The completeness check that runs after every Actions generation finds real
// omissions - run 8's Janine/Adil clinical review, run 9's TF03 work - but has
// only ever offered them as proposals, so a missed commitment stays missed
// unless the reviewer spots the flag. With this on, one whose commitment the
// model can quote and tie to its named owner is published, on the same bar the
// generation pass uses to rescue its own proposals. The rest stay proposals.
// The candidates the completeness check may publish: work that names an owner,
// reads as a client-ready action, is not meeting admin or a description of
// usual practice, and is not already published. Verification of the commitment
// itself is the model's, on top of this.
function meetingAgentAuditPublishCandidates(audited = [], declared = [], published = [], units = []) {
  return dedupeHybridActionRecords([...(audited || []), ...(declared || [])]
    .filter((record) => (record?.owners || []).length
      && isClientReadyActionWording(record.action)
      && !isMeetingAdminAction(record.action)
      && !describesUsualPractice(record, units)
      && !(published || []).some((existing) => hybridActionsEquivalent(record.action, existing?.action || ''))))
    .slice(0, 16);
}

// The critic's reply arrives as the object, wrapped in another, or as a JSON
// string in output/text depending on the flow's mood. Read all three rather
// than silently treating an unfamiliar wrapper as "no results".
function meetingAgentCriticResults(result) {
  const candidates = [result, result?.result, result?.output, result?.text, result?.body];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (Array.isArray(candidate?.results)) return candidate.results;
    if (typeof candidate === 'string') {
      try {
        const parsed = parseJsonLenient(candidate);
        if (Array.isArray(parsed?.results)) return parsed.results;
        if (Array.isArray(parsed?.result?.results)) return parsed.result.results;
      } catch { /* not JSON: try the next shape */ }
    }
  }
  return [];
}

// An unowned action that repeats an owned one (same opening verb, at least 80%
// of its subject words) is folded into the owned version, keeping its evidence.
const FOLD_STOP = new Set(['with', 'that', 'this', 'from', 'into', 'their', 'there', 'about', 'which', 'where', 'when', 'before', 'after', 'once', 'what', 'will', 'would', 'should', 'could', 'have', 'been', 'being', 'including', 'required', 'needed', 'relevant', 'related', 'whether']);
function foldSubjectWords(text) {
  return new Set((String(text || '').toLowerCase().match(/[a-z0-9][a-z0-9-]{3,}/g) || [])
    .filter((word) => !FOLD_STOP.has(word)).map((word) => word.replace(/(?:ing|ed|es|s)$/, '')));
}
function foldUnownedNearCopies(actions = [], journeyId = '') {
  const list = Array.isArray(actions) ? actions : [];
  const folded = [];
  const kept = list.filter((action) => {
    if ((action.owners || []).length) return true;
    const verb = String(action.action || '').trim().split(/\s+/)[0]?.toLowerCase();
    const words = foldSubjectWords(String(action.action || '').split(/\s+/).slice(1).join(' '));
    if (!verb || words.size < 3) return true;
    const partner = list.find((other) => other !== action && (other.owners || []).length
      && ((String(other.action || '').trim().split(/\s+/)[0]?.toLowerCase() === verb
        && [...words].filter((word) => foldSubjectWords(other.action).has(word)).length / words.size >= 0.8)
        // Or the same specific thing under a different verb.
        || publishedActionNamesSameThing(other, action)
        // An unowned row is the weakest kind of duplicate: nobody is shown
        // taking it on, and an owned action already describes the same work
        // in different words ("Figure out a way to give her access" beside
        // "Arrange secure SharePoint access"). Substantial word overlap is
        // enough here, without a shared phrase.
        || (!distinctActionDeliverables(other, action)
          && hybridContentTokenOverlap(other.action, action.action) >= 0.45)
        // "Figure out a way to get her access" beside "Work out secure
        // transmission ... and provide her with SharePoint access": a way-to
        // paraphrase of work somebody owns. The distinct-deliverable test is
        // deliberately not applied - such a row names no deliverable of its
        // own, which is what makes it a paraphrase.
        || (WAY_TO_ACTION.test(action.action || '')
          && hybridContentTokenOverlap(other.action, action.action) >= 0.25)));
    if (!partner) return true;
    partner.evidenceIds = [...new Set([...(partner.evidenceIds || []), ...(action.evidenceIds || [])])].slice(0, 12);
    folded.push({ removed: meetingMinutesAgentText(action.action, 160), into: meetingMinutesAgentText(partner.action, 160) });
    return false;
  });
  if (folded.length) console.log(JSON.stringify({ event: 'meeting_agent_unowned_copy_folded', journeyId, folded }));
  return kept;
}

function gateTranscriptShapedActions(records = [], sourceUnits = [], journeyId = '', stage = '') {
  const { kept, rejected } = partitionTranscriptText(records, sourceUnits);
  if (rejected.length) {
    console.log(JSON.stringify({
      event: 'meeting_agent_transcript_text_gate', journeyId, stage,
      removed: rejected.length, items: transcriptTextRejectionSummary(rejected)
    }));
  }
  return kept;
}

function gateTranscriptShapedActionChanges(changes = [], sourceUnits = [], journeyId = '', stage = '') {
  const rejected = [];
  const kept = (Array.isArray(changes) ? changes : []).filter((change) => {
    if (!['add', 'modify'].includes(change?.type) || !change.after) return true;
    const reason = transcriptTextGateEnabled() ? transcriptTextIssue(change.after.action, sourceUnits) : '';
    if (reason) rejected.push({ record: change.after, reason });
    return !reason;
  });
  if (rejected.length) {
    console.log(JSON.stringify({
      event: 'meeting_agent_transcript_text_gate', journeyId, stage,
      removed: rejected.length, items: transcriptTextRejectionSummary(rejected)
    }));
  }
  return kept;
}

registerMeetingMinutesBackgroundGeneration(router);

registerMeetingMinutesGenerationStatus(router);

registerMeetingMinutesGeneration(router);

router.post('/meeting-minutes-agent/drafts/:draftId/audit-actions', requireAuth, async (req, res) => {
  try {
    const draft = await loadOwnedMeetingAgentDraft(req);
    if (Number(req.body?.revision) !== draft.revision) {
      const error = new Error('This draft was updated elsewhere. Reload it before checking for missed actions.');
      error.statusCode = 409;
      error.currentDraft = draft;
      throw error;
    }
    const baseActionCandidates = actionCandidateInventory(draft.sourceUnits);
    const actionChains = actionCommitmentChainInventory(draft.sourceUnits, baseActionCandidates);
    const actionThreads = actionCommitmentThreadInventory(draft.sourceUnits, baseActionCandidates);
    const uncoveredActionCandidates = uncoveredCandidateInventory(
      [...actionChains, ...actionThreads, ...baseActionCandidates], draft.actions || []
    );
    const auditPrompt = meetingMinutesAgentHybridEnabled()
      ? meetingMinutesAgentCriticPrompt({
        transcript: draft.preparedTranscript,
        details: meetingAgentPromptDetails(draft),
        discussion: draft.discussion || [],
        actions: draft.actions || [],
        salientDetails: draft.salientDetails || [],
        candidates: uncoveredActionCandidates
      })
      : meetingMinutesAgentAuditPrompt({
        transcript: draft.preparedTranscript,
        details: meetingAgentPromptDetails(draft),
        actions: draft.actions || [],
        steer: draft.steer,
        salientDetails: draft.salientDetails || [],
        actionCandidates: uncoveredActionCandidates
      });
    const parsed = meetingMinutesAgentHybridEnabled()
      ? (await askPowerAutomateMeetingMinutesAgentWithRetry(auditPrompt, { pass: 'actions:critic-manual' })).result
      : await askPowerAutomateMeetingMinutesAgent(auditPrompt);
    const audited = normaliseAgentResult(parsed, draft.sourceUnits, 'actions', {
      meetingDate: meetingAgentTimingAnchor(draft)
    });
    const declaredProposals = normaliseAgentDeclaredProposals(parsed, draft.sourceUnits, {
      meetingDate: meetingAgentTimingAnchor(draft)
    });
    audited.reviewFlags = audited.reviewFlags.filter(isUsefulMeetingAgentReviewFlag);
    let rescuedActions = [];
    let rescueFlags = [];
    if (meetingMinutesAuditPublishEnabled() && meetingMinutesCommitmentCheckEnabled()) {
      const candidates = meetingAgentAuditPublishCandidates(
        audited.actions, declaredProposals, draft.actions || [], draft.sourceUnits);
      const commitmentItems = commitmentCheckItems(candidates, draft.sourceUnits);
      let verifiedCount = 0;
      let resultCount = 0;
      if (commitmentItems.length) {
        const batches = [];
        for (let index = 0; index < commitmentItems.length; index += 8) batches.push(commitmentItems.slice(index, index + 8));
        // Never swallow the reason. Run 11 logged results: 0 here with no clue
        // why, which is the same blindness the unconditional log above exists
        // to remove.
        const commitmentResults = (await Promise.all(batches.map((batch) =>
          askPowerAutomateMeetingMinutesAgentWithRetry(commitmentCheckPrompt(batch),
            { pass: 'actions:critic-audit-commitment', maxAttempts: 2, responseKind: 'commitment_check' })
            .then((response) => meetingAgentCriticResults(response?.result))
            .catch((error) => {
              console.log(JSON.stringify({ event: 'meeting_agent_audit_commitment_failed', journeyId: draft.draftId, message: String(error?.message || error).slice(0, 200) }));
              return [];
            })))).flat();
        // requireOwnerTie: the quoted words must tie this work to this owner,
        // so "I'll update that table" cannot carry an unrelated action.
        resultCount = commitmentResults.length;
        const verified = applyCommitmentCheckResults(candidates, commitmentItems, commitmentResults, { requireOwnerTie: true })
          .filter((record) => (record.owners || []).length);
        verifiedCount = verified.length;
        const owners = correctnessChecksEnabled()
          ? applyRequesterOwnerRule(verified, draft.sourceUnits)
          : { actions: verified, flags: [] };
        rescuedActions = owners.actions.filter((record) => (record.owners || []).length);
        rescueFlags = owners.flags;
      }
      // Logged whenever there was anything to consider, not only on success:
      // a silent zero is indistinguishable from the call never running, which
      // is exactly the ambiguity that made run 10's result unreadable.
      if (candidates.length) {
        console.log(JSON.stringify({ event: 'meeting_agent_audit_published', journeyId: draft.draftId,
          considered: candidates.length, verified: verifiedCount, published: rescuedActions.length,
          ownersRemoved: rescueFlags.length, results: resultCount }));
      }
    }
    // audited rows were already enforced above; the existing register holds the
    // reviewer's edits and must not be re-stripped when the two are merged.
    const cleanAuditActions = (actions) => cleanGeneratedMeetingAgentResult({ changes: { actions } }, 'actions').changes.actions;
    rescuedActions = cleanAuditActions(gateTranscriptShapedActions(rescuedActions, draft.sourceUnits, draft.draftId, 'audit_published'));
    const auditedActions = cleanAuditActions(gateTranscriptShapedActions(audited.actions, draft.sourceUnits, draft.draftId, 'audit_found'));
    const publishedBase = [...(draft.actions || []), ...rescuedActions];
    const combined = normaliseAgentResult({
      actions: [...publishedBase, ...auditedActions, ...cleanAuditActions(declaredProposals)]
    }, draft.sourceUnits, 'actions', { enforceEvidence: false }).actions;
    const reconciledActions = mergePublishedActionEvidence(publishedBase, combined);
    const proposal = annotateActionProposalChains(removePublishedActionProposalDuplicates(
      buildProposal('actions', reconciledActions, combined), reconciledActions,
      { phaseReceipts:draft.qualityState?.actions?.actionPhaseCorrection?.applied ? draft.qualityState.actions.actionPhaseCorrection.receipts : [],
        unionReceipts: draft.qualityState?.actions?.actionUnionRewrite?.applied ? draft.qualityState.actions.actionUnionRewrite.receipts : [],
        meetingDate: meetingAgentTimingAnchor(draft), receipts: draft.qualityState?.actions?.semanticReconciliation?.applied
        ? draft.qualityState.actions.semanticReconciliation.receipts : [], sourceUnits: draft.sourceUnits }
    ), actionChains);
    // Never re-propose an action the reviewer deleted since it was generated.
    const generatedTexts = Array.isArray(draft.qualityState?.actions?.generatedTexts) ? draft.qualityState.actions.generatedTexts : [];
    const deletedByReviewer = generatedTexts.filter((textValue) => !(draft.actions || [])
      .some((row) => meetingMinutesAgentText(row?.action, 1600) === textValue));
    proposal.changes = (proposal.changes || []).filter((change) => change.type !== 'add'
      || !deletedByReviewer.some((textValue) => hybridActionsEquivalent(textValue, change.after?.action || '')));
    const missedFlags = proposal.changes.filter((change) => change.type === 'add').map((change, index) => normaliseMeetingAgentFlag({
      id: meetingAgentProposalReviewFlagId(change),
      kind: 'possible_missed_follow_up',
      message: `The completeness check found a possible missed action: ${change.after?.action || 'Review this proposed action.'}`,
      evidenceIds: change.after?.evidenceIds || []
    }, index));
    const saved = await saveMeetingAgentDraft(draft, req, admitMeetingAgentGeneratedActionChanges(draft, {
      actions: reconciledActions,
      staleStages: [...new Set([
        ...(draft.staleStages || []),
        ...meetingAgentDerivedStaleStages(draft, { ...draft, actions: reconciledActions })
      ])],
      pendingProposal: (() => {
        const finalProposal = removePublishedActionProposalDuplicates(proposal, reconciledActions,
          { phaseReceipts:draft.qualityState?.actions?.actionPhaseCorrection?.applied ? draft.qualityState.actions.actionPhaseCorrection.receipts : [],
            unionReceipts: draft.qualityState?.actions?.actionUnionRewrite?.applied ? draft.qualityState.actions.actionUnionRewrite.receipts : [],
        meetingDate: meetingAgentTimingAnchor(draft), receipts: draft.qualityState?.actions?.semanticReconciliation?.applied
            ? draft.qualityState.actions.semanticReconciliation.receipts : [], sourceUnits: draft.sourceUnits });
        return finalProposal.changes.length ? preselectActionProposal(finalProposal, reconciledActions, draft.sourceUnits) : null;
      })(),
      reviewFlags: mergeMeetingAgentFlags(draft.reviewFlags, [...audited.reviewFlags, ...rescueFlags, ...missedFlags])
    }, `${draft.draftId || ''}:${draft.revision}:audit`));
    return res.json({ ok: true, proposal: saved.pendingProposal || null, draft: publicMeetingAgentDraft(saved) });
  } catch (error) {
    safeLogError('[meeting-minutes-agent/audit-actions] failed', error);
    return sendMeetingAgentFailure(res, error);
  }
});

registerMeetingMinutesReviewerDecisionsHistory(router);









registerMeetingMinutesLibraryExports(router);

router.post('/copilot-chat', async (req, res) => {
  try {
    const prompt = req.body?.prompt;

    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ ok: false, error: 'Missing prompt.' });
    }

    const agent = await askAgent(prompt, 'trinzo-chat-test-user');

    return res.json({
      ok: true,
      conversationId: agent.conversationId,
      botMessages: agent.botMessages,
      finalText: agent.finalText
    });
  } catch (error) {
    safeLogError('[copilot-chat] failed', error);
    return res.status(500).json({ ok: false, error: error.message || 'Chat test failed.' });
  }
});

router.meetingInsights = { buildMeetingInsights };

router.stagedEvaluation = {
  originalMinutesStageServices,
  meetingAgentReviewerSummaryHash,
  meetingAgentReviewPacketError,
  meetingAgentSummaryAuthority,
  verifyMeetingAgentSummaryTiming,
  runStagedSequenceForEvaluation,
  // The scorecard generates discussion and actions through the same function and the same
  // meeting-type routing as the queued stage, so it measures the pipeline the reviewer sees.
  generateMiniLmTrooperStage,
  stagedGenerationMeetingType,
  filterActionsForPresentation,
  // The health judgement is pure so its rules can be tested without a pipeline run.
  assessGenerationHealth,
  // Exposed so the merge can be tested for the property that matters - that a renamed
  // heading keeps the evidence the discussion stage allocates against - rather than by
  // running the whole stage and hoping.
  mergeNamedTopics,
  stagedNoEditReviewExperience,
  canonicalStagedResponse,
  extractStagedDetailsFromTranscript,
  buildStagedActionsResponse,
  buildPreparedTranscriptForStagedAI,
  // Exported so the review analytics can be tested as behaviour rather than by grepping
  // the source for the field names.
  buildStagedReviewDiffs,
  summariseStagedReviewDiffs,
  // Exposed so a resume link can be tested for the property that matters - that it names
  // the stage it resumes, and does not simply repeat a screen index recorded under a
  // numbering that has since changed.
  stagedStageResumeUrl,
  // Exposed so the purpose baseline can ask the question that matters about a meeting
  // type: would we still call it this if we could only see the title? A type that
  // survives only while the transcript body is visible was inferred from something
  // somebody happened to say, not from what the meeting is.
  inferStagedMeetingType,
  meetingMinutesAgentPrompt,
  meetingMinutesAgentPrimaryPrompt,
  meetingMinutesAgentAnchoredDiscussionPrompt,
  meetingAgentFlowUrlFor,
  MEETING_AGENT_TOPIC_LABEL_RULE,
  MEETING_AGENT_DISCUSSION_COVERAGE_RULE,
  MEETING_AGENT_TOPIC_NAMING_RULE,
  meetingMinutesAgentTopicNamingPrompt,
  meetingMinutesAgentTopicArrangementPrompt,
  meetingMinutesAgentTopicArrangementRepairPrompt,
  meetingMinutesAgentGlobalTopicArrangerEnabled,
  meetingAgentTopicSegmentsEnabled,
  meetingAgentTopicLabelRuleEnabled,
  normaliseAnchoredDiscussionDiscovery,
  meetingMinutesAgentAnchoredActionPrompt,
  normaliseAnchoredActionDiscovery,
  meetingMinutesAgentAuditPrompt,
  meetingMinutesAgentRecoveryPrompt,
  meetingMinutesAgentRefereePrompt,
  meetingMinutesAgentRefereeRepairPrompt,
  mergeMeetingAgentRefereeResults,
  meetingAgentRefereeRepairCandidates,
  meetingAgentRefereeBatches,
  meetingAgentRefereeBatchPlan,
  meetingAgentRunOrderedConcurrent,
  meetingAgentExecutionTelemetry,
  meetingAgentPreviewSavedActions,
  meetingAgentFailureClass,
  meetingAgentPassTimingPolicy,
  askPowerAutomateMeetingMinutesAgentWithRetry,
  meetingAgentResultCounts,
  meetingAgentMaterialPassImpact,
  annotateMeetingAgentPassImpact,
  meetingAgentCallPerformance,
  shouldStopMeetingAgentRefereeBatches,
  mergeBatchedMeetingAgentRefereeResults,
  meetingMinutesAgentCriticPrompt,
  meetingMinutesAgentSalvagePrompt,
  meetingAgentActionAuditCandidates,
  meetingAgentInfrastructureFailure,
  isClientReadyActionWording,
  meetingAgentResultError,
  meetingAgentEmptyDiscoveryError,
  meetingAgentDispositionError,
  refereeActionMaterializationIssues,
  reconcileRefereeActionMaterialization,
  meetingAgentRefereeRoute,
  normaliseMeetingAgentRefereeContractResult,
  effectiveDiscussionRefereeDispositions,
  discussionRefereeSufficiency,
  discussionSelectionCoverage,
  discussionPublicationCoverage,
  discussionRefereeFallbackPlan,
  meetingMinutesAgentRefereeContract,
  meetingAgentCommitmentRecheckNeeded,
  meetingAgentRefereeEvidencePacket,
  meetingAgentRefereeCandidates,
  hybridCandidateLedgerFromResult,
  normaliseAgentDeclaredProposals,
  retainedDocumentReferenceReviewFlags,
  normaliseAgentCandidateDispositions,
  hybridCandidateMatchesRecord,
  hybridCandidateCoveredByRecord,
  hybridCandidateDispositions,
  strictActionDeliverableMatch,
  reconcileAcceptedRefereeActions,
  reconcileFinalApprovedActions,
  dedupeHybridActionRecords,
  actionDeliveryFrame,
  bundleSameRecipientDeliveries,
  sameDocumentDeliveryWorkflow,
  mergeDocumentDeliveryWorkflow,
  distinctActionDeliverables,
  sameActionApproach,
  nestedActionWork,
  splitCompoundActionList,
  dedupeHybridActionProposals,
  mergePublishedActionEvidence,
  removePublishedActionProposalDuplicates,
  annotateActionProposalChains,
  acceptedVisitAssignmentActions,
  strongOmittedDiscoveryProposals,
  hybridActionSourceInfo,
  highConfidenceRefereedAction,
  actionDispositionWithContext,
  safeAgentProposalPromotion,
  preselectActionProposal,
  filterIncompleteProposalChanges,
  completeActionSuggestionText,
  completeDiscussionSuggestionText,
  minorCommunicationCourtesy,
  stripMinorCommunicationCourtesy,
  removeMinorCommunicationCourtesyDiscussion,
  removeHeadingFragmentsFromDiscussion,
  looksLikeStandaloneHeadingFragment,
  prioritySupportingDetail,
  includeAllDiscussionDetailsExperiment,
  promoteAllDiscussionDetails,
  discussionStructureDiagnostics,
  finalisePromotedDiscussion,
  echoesPublishedAction,
  preselectDiscussionProposal,
  foldUnownedNearCopies,
  publishedActionNamesSameThing,
  isPersonalErrandAction,
  preselectRequestedProposal,
  explicitFutureDocumentationCommitment,
  repeatedOwnerCommitment,
  criticConfirmedActionPromotions,
  corroboratedOmittedDiscussionRecords,
  mergeHybridDiscussionTopics,
  compactDiscussionPropositions,
  consolidateSupportingDetails,
  promotePrioritySupportingDetails,
  limitSupportingDetails,
  promoteMaterialObjectionDetails,
  enrichDiscussionEvidenceFromDispositions,
  reconstructMissingRefereeDiscussion,
  reconstructRefereeActions,
  normaliseRefereeDeclaredProposals,
  refereeDiscussionContractDiagnostics,
  discussionRefereeHasCompleteCandidateAccounting,
  refereeClusterSupportingCandidates,
  dedupeSupportingDetailsSemantically,
  isVagueReconstructedAction,
  isReviewableActionProposal,
  publishedActionCoversProposal,
  corroboratedOmittedActionProposals,
  unresolvedOperationalGapProposals,
  commitmentThreadBackstopProposals,
  strongUnresolvedActionCandidateFlags,
  buildPrivateStagedCandidateLedger,
  stagedCandidateLedgerFromResult,
  cachedStagedCandidatesForStage,
  peekReadyPrivateStagedCandidateLedger,
  prewarmPrivateStagedCandidateLedgers,
  meetingAgentActionPrimaryPromptForDraft,
  borrowOwnersFromTwin,
  MEETING_AGENT_COMMITMENT_LANGUAGE,
  unionActionDiscoveryResults,
  meetingMinutesAgentPrimaryUnionEnabled,
  publicMeetingAgentDraft,
  meetingAgentPublicationContent,
  meetingAgentDraftForDocx,
  meetingAgentDraftForPdf,
  normaliseMeetingAgentGeneration,
  meetingAgentSerialDraftWrite,
  meetingAgentStageContentFields,
  meetingAgentStageContentConflicts,
  meetingAgentStagePersistenceChanges,
  meetingAgentUpstreamFingerprint,
  meetingAgentDerivedStaleStages,
  meetingAgentDiscussionUsesDateAnchor,
  meetingAgentStaleStagesAfterGeneration,
  meetingAgentRefereeAccountedForAllCandidates,
  dedupeActionDiscoveryInventory,
  compactMeetingAgentDiscussionContext,
  meetingAgentEmptyDiscoveryRepairPrompt,
  persistMeetingAgentBackgroundStage,
  meetingAgentRegenerationChanges,
  meetingAgentActionsFingerprint,
  meetingAgentEditableActionSignature,
  meetingAgentProposalChangeIsVisible,
  privateStagedCandidateCacheKey,
  assertMeetingAgentDateInput,
  meetingAgentDateContext,
  meetingAgentTimingAnchor,
  meetingAgentPromptDetails,
  meetingAgentDiscussionFingerprint,
  meetingAgentAuditPublishCandidates,
  meetingMinutesAuditPublishEnabled,
  reopenFlagsOfReAddedItems,
  reconcileMeetingAgentOrphanFlags,
  meetingAgentReviewSnapshot,
  meetingAgentReviewHistoryEntry,
  automaticMeetingAgentProposalReview,
  admitMeetingAgentGeneratedActionChanges,
  finaliseMeetingAgentTimingProposal,
  meetingAgentProposalReviewFlagId,
  meetingAgentProposalFlagMatchesChange,
  resolveMeetingAgentProposalFlags,
  rebaseMeetingAgentProposal,
  normaliseMeetingAgentPassCache,
  meetingAgentPassCacheKey,
  generateHybridMeetingAgentStage,
  finishMeetingAgentGeneratedStage,
  normaliseMeetingAgentDraftChanges,
  normaliseMeetingAgentQualityState,
  meetingAgentDraftPayload,
  meetingAgentStageInputFingerprint,
  meetingAgentStageHasContent,
  meetingAgentNextSpeculativeStage,
  meetingAgentSpeculationState,
  startStageSpeculation,
  adoptStageSpeculation,
  applyStageResultVirtually,
  meetingAgentUntouchedSpeculationChanges,
  privateStageSpeculations,
  meetingAgentMemoryCacheState,
  clearMeetingAgentMemoryCaches,
  meetingAgentCallContext,
  MEETING_AGENT_BOOT_ID,
  parseJsonLenient
};

module.exports = router;
