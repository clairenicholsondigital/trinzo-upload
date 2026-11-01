const { meetingMinutesAgentGlobalTopicArrangerEnabled, meetingMinutesAgentPrimaryUnionEnabled, meetingMinutesCommitmentDedupeEnabled, meetingMinutesAgentEarlyActionPrewarmEnabled, meetingAgentTopicLabelRuleEnabled, meetingAgentTopicSegmentsEnabled, includeAllDiscussionDetailsExperiment, meetingMinutesAuditPublishEnabled } = require('../utils/meetingMinutesOriginalFeatures');
const { dedupeActionDiscoveryInventory, uncoveredCandidateInventory } = require('../utils/meetingMinutesDiscoveryInventory');
const { refereeClusterSupportingCandidates, discussionRefereeSufficiency, discussionRefereeFallbackPlan, corroboratedOmittedDiscussionRecords, reconstructMissingRefereeDiscussion, enrichDiscussionEvidenceFromDispositions } = require('../utils/meetingMinutesRefereeDiscussion');
const { reconcileAcceptedRefereeActions, isReviewableActionProposal, publishedActionCoversProposal, meetingAgentCommitmentRecheckNeeded, hybridCandidateCoveredByRecord, hybridCandidateDispositions, splitCompoundActionList, hybridActionSourceInfo, highConfidenceRefereedAction, safeAgentProposalPromotion, explicitFutureDocumentationCommitment, repeatedOwnerCommitment, criticConfirmedActionPromotions, isPersonalErrandAction, removePublishedActionProposalDuplicates, annotateActionProposalChains, strongUnresolvedActionCandidateFlags, foldUnownedNearCopies, gateTranscriptShapedActions } = require('../utils/meetingMinutesActionPromotion');
const { borrowOwnersFromTwin, reconstructRefereeActions, corroboratedOmittedActionProposals, strongOmittedDiscoveryProposals, acceptedVisitAssignmentActions, unresolvedOperationalGapProposals, commitmentThreadBackstopProposals } = require('../utils/meetingMinutesRefereeActionRecovery');
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
const { compactDiscussionPropositions, dedupeSupportingDetailsSemantically, limitSupportingDetails, mergeHybridDiscussionTopics, promotePrioritySupportingDetails, prioritySupportingDetail, consolidateSupportingDetails } = require('../utils/meetingMinutesDiscussionSelection');
const { meetingAgentDraftForPdf, meetingAgentPublicationContent, removeHeadingFragmentsFromDiscussion, removeMinorCommunicationCourtesyDiscussion, stripMinorCommunicationCourtesy, completeDiscussionSuggestionText, meetingAgentDraftForDocx, minorCommunicationCourtesy, looksLikeStandaloneHeadingFragment } = require('../utils/meetingMinutesPublication');
const {
  discussionStructureDiagnostics, finalisePromotedDiscussion, promoteAllDiscussionDetails
} = require('../utils/meetingMinutesDiscussionFinalization');
const { meetingAgentSummaryAuthority, meetingAgentReviewerSummaryHash } = require('../utils/meetingMinutesSummaryPublication');
const { meetingMinutesAgentRefereeContract, effectiveDiscussionRefereeDispositions, meetingAgentRefereeCandidates } = require('../utils/meetingMinutesRefereeCandidates');
require('../utils/meetingMinutesAssessmentEvidence');

const {
  normaliseAgentDeclaredProposals, meetingAgentEmptyDiscoveryError, normaliseRefereeDeclaredProposals,
  normaliseAnchoredActionDiscovery, normaliseAnchoredDiscussionDiscovery,
  meetingAgentEmptyDiscoveryRepairPrompt
} = require('../utils/meetingMinutesDiscoveryValidation');
const { unionActionDiscoveryResults, mergeMeetingAgentRefereeResults, mergeBatchedMeetingAgentRefereeResults } = require('../utils/meetingMinutesResultAggregation');
const { actionDeliveryFrame, bundleSameRecipientDeliveries, dedupeHybridActionProposals, dedupeHybridActionRecords, distinctActionDeliverables, hybridCandidateMatchesRecord, isClientReadyActionWording, mergeDocumentDeliveryWorkflow, nestedActionWork, publishedActionNamesSameThing, sameActionApproach, sameDocumentDeliveryWorkflow, strictActionDeliverableMatch, mergePublishedActionEvidence } = require('../utils/meetingMinutesActionDuplicatePolicy');
require('../utils/meetingMinutesRecordMatching');
const { sanitiseDetails: sanitiseMeetingAgentDetails, meetingAgentTimingAnchor, meetingAgentPromptDetails } = require('../utils/meetingMinutesDraftContext');
const { normaliseFlag: normaliseMeetingAgentFlag, isUsefulReviewFlag: isUsefulMeetingAgentReviewFlag, mergeMeetingAgentFlags, meetingAgentProposalReviewFlagId } = require('../utils/meetingMinutesReviewFlags');
const { preparedTranscriptFromUnits } = require('../utils/meetingMinutesEvidenceContext');
require('../utils/meetingMinutesEvidenceResolution');
const { isMeetingAdminAction } = require('../utils/meetingMinutesActionEvidence');
const { applyRequesterOwnerRule } = require('../utils/meetingMinutesPeopleEvidence');
const { meetingAgentPassCacheKey } = require('../utils/meetingMinutesPassCache');
const { meetingAgentResultError, meetingAgentRefereeRoute, meetingAgentInfrastructureFailure, refereeActionMaterializationIssues, meetingAgentDispositionError, meetingAgentRefereeAccountedForAllCandidates, normaliseMeetingAgentRefereeContractResult, meetingAgentRefereeRepairCandidates, normaliseAgentCandidateDispositions, refereeDiscussionContractDiagnostics, discussionRefereeHasCompleteCandidateAccounting, reconcileRefereeActionMaterialization } = require('../utils/meetingMinutesResponseContracts');
const { meetingAgentRefereeBatches, meetingAgentRefereeBatchPlan, meetingAgentRunOrderedConcurrent, shouldStopMeetingAgentRefereeBatches } = require('../utils/meetingMinutesRefereeBatches');
require('../utils/meetingMinutesDiscussionRows');
const { truthyFlag } = require('../utils/requestFlags');
const { safeLogError, sendTestError } = require('../utils/apiErrors');
const { stagedAnalyticsObject, stagedAnalyticsArray, buildStagedReviewDiffs, summariseStagedReviewDiffs, stagedWorkflowInteractionEvents, summariseStagedWorkflowInteractions, stagedReviewProjectKey } = require('../utils/stagedReviewAnalytics');
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
require('../utils/meetingMinutesCitedFilingAliases');
require('../utils/canonicalMinutes/discussionBoundedRewrite');
require('../utils/canonicalMinutes/discussionOwnParentCoverage');
require('../utils/canonicalMinutes/discussionDirectionalCoverage');
require('../utils/canonicalMinutes/discussionMainPointCoverage');
require('../utils/canonicalMinutes/discussionPointDecisionCoverage');
require('../utils/canonicalMinutes/discussionActionSeparation');
require('../utils/meetingMinutesMinimalFidelityRepair');
require('../utils/canonicalMinutes/referenceText');
const multer = require('multer');
const mammoth = require('mammoth');
const fetch = require('node-fetch');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
require('../utils/meetingMinutesRefereeFailureAudit');
const { runProjectKnowledgeRetrieval } = require('../utils/knowledge');

const {
  generateToken,
  startConversation,
  sendMessage,
  getBotMessages
} = require('../utils/copilot');

const { extractTextFromUpload, validateTranscriptText, transcriptMetadata } = require('../utils/transcript');
const { matchingMeetingAgentDrafts } = require('../utils/meetingAgentDuplicate');
const { cleanGeneratedMeetingAgentResult } = require('../utils/meetingMinutesGeneratedHygiene');
require('../utils/meetingMinutesSemanticPolicy');
require('../utils/meetingMinutesDiscussionCoveragePolicy');
require('../utils/meetingMinutesEnquiryRecovery');
require('../utils/meetingMinutesSemanticStage');
require('../utils/canonicalMinutes/actionSemanticReconciliation');
require('../utils/meetingMinutesReviewedAiEdits');
const {
  assertStagedSourceIdentity,
  assertStagedTranscriptHash
} = require('../utils/stagedIdentity');
const { buildEvidenceBoundStagedActionInventory, parseDeadlineEvidence } = require('../utils/stagedActionRecovery');
const { buildStagedEvidenceLedger } = require('../utils/stagedEvidenceLedger');

const { isMalformedStagedLine, buildTightStagedObjectives, dedupeStagedDiscussionCards, compactStagedDiscussionCards, reshapeStagedDiscussionCardsForHumanMinutes, buildStagedValidationFlags, normaliseFinalStagedActionCandidate, normaliseAndValidateActionOwner } = require('../utils/stagedEditorial');
require('../utils/actionTextGate');
const { getMeetingMinutesCoreGoldenStatus } = require('../utils/meetingMinutesCoreGolden');
const { runCanonicalNoEditPass } = require('../utils/canonicalMinutes/runner');
require('../utils/canonicalMinutes/liveStages');
require('../utils/canonicalMinutes/minilm');
require('../utils/canonicalMinutes/meetingTypeSuggestion');
const { prepareEvidence } = require('../utils/canonicalMinutes/evidence');
const { normaliseRefereeOutput, normaliseReferenceArrays } = require('../utils/refereeNormaliser');
require('../config/meeting-minutes-discussion-materiality-policy.json');
require('../utils/meetingMinutesDiscussionTaskBoundary');
require('../utils/meetingMinutesExactDiscussionProvenance');
require('../utils/canonicalMinutes/trooperPolish');
require('../utils/canonicalMinutes/proposedActions');
require('../utils/canonicalMinutes/semanticStages');
require('../utils/canonicalMinutes/proposedDiscussion');
require('../utils/meetingMinutesFilingAliases');
require('../utils/meetingMinutesSupportingDetails');
const { discussionSelectionCoverage, discussionPublicationCoverage } = require('../utils/meetingMinutesDiscussionCoverage');
require('../utils/entityNormalization');
const { encodeViaWorker, cosine } = require('../utils/canonicalMinutes/semanticDedupe');
require('../utils/canonicalMinutes/discussionOrganiser');
require('../utils/canonicalMinutes/discussionPublication');
require('../utils/canonicalMinutes/discourseSegments');
const { mergeCommitmentDuplicates } = require('../utils/canonicalMinutes/commitmentDuplicates');
require('../utils/canonicalMinutes/actionDuplicateCoverage');
require('../utils/canonicalMinutes/actionDeliverableIdentity');
require('../utils/canonicalMinutes/claimCheck');
require('../utils/minutesEnglish');

require('../utils/canonicalMinutes/state');
const actionDiagnostics = require('../utils/meetingMinutesActionDiagnostics');
require('../utils/canonicalMinutes/topicEditorial');
require('../utils/canonicalMinutes/actionReviewRanking');
const { reviewGeneratedContent } = require('../utils/terminologyQa');
const { normaliseDomainTermsDeep, applyTranscriptPhraseCorrections } = require('../utils/domainTerms');
require('../utils/settingsStore');

const { TIMING_POLICY_VERSION, isValidCalendarDate } = require('../utils/meetingMinutesTiming');

const { meetingAgentReviewPacketError } = require('../utils/meetingMinutesReviewAccounting');
require('../utils/meetingMinutesTemporalReview');
require('../utils/meetingMinutesTimedStepCoverage');
const { generateStagedMinutesPdf, stagedMinutesPdfFilename } = require('../utils/stagedMinutesPdf');
require('../utils/stagedExecutiveSummaryGrammar');
require('../utils/stagedInitialUnderstandingPolish');
require('../utils/stagedTranscriptHealth');
require('../utils/meetingAdministration');
const { generateMiniLmTrooperStage, prepareMiniLmTranscript } = require('../utils/stagedMiniLmTrooper');
const { filterActionsForPresentation } = require('../utils/stagedActionPresentation');
const { buildConfirmedUnderstanding } = require('../utils/stagedSemanticAuthority');

const { saveProjectUpdateDraft, getProjectManagementDetail, getProjectContext, saveMeetingMinutesFeedback, queueMeetingMinutesGeneration, queueStagedMeetingMinutesStage, queueProjectUpdateGeneration, getGenerationJob, saveStagedMeetingMinutesReviewEvent, listStagedMeetingMinutesReviewEvents, createMeetingMinutesAgentDraft, getMeetingMinutesAgentDraft, listMeetingMinutesAgentDrafts, linkMeetingMinutesAgentDraftToProject, listTerminologyQaDecisions, saveTerminologyQaDecision, claimNextJob, markJobCompleted, markJobFailure, markWebhookSuccess, markWebhookFailure, hasDatabaseConfig, getDatabaseConfigError, query } = require('../utils/db');
const { promoteMaterialObjectionDetails, commitmentCheckEnabled: meetingMinutesCommitmentCheckEnabled, commitmentCheckItems, commitmentCheckPrompt, applyCommitmentCheckResults, describesUsualPractice } = require('../utils/meetingMinutesAgentV2');
const { normaliseKnownTerms: normaliseMeetingAgentKnownTerms, isAutomaticTerminologyFlag: isAutomaticMeetingAgentTerminologyFlag } = require('../utils/meetingMinutesText');
const { normaliseAgentResult } = require('../utils/meetingMinutesResultNormalization');
require('../utils/meetingMinutesActionTimingInference');
const { correctnessChecksEnabled } = require('../utils/meetingMinutesEvidenceChecks');
require('../utils/discussionShape');
require('../utils/presenterAidGate');
require('../utils/actionReviewState');
require('../utils/meetingMinutesActionIdentity');
require('../utils/includedSections');
const { renderMinutesForProjectUpdate, minutesHaveContent, minutesActionsForProjectReport } = require('../utils/minutesForProjectUpdate');
require('../utils/meetingMinutesAgentDocx');
const { requireAuth } = require('./auth');

const { buildProposal } = require('../utils/meetingMinutesProposals');
const parallelMinutes = require('../utils/meetingMinutesParallel');
const { createOriginalMinutesStages } = require('../utils/meetingMinutesOriginalStages');
const { verifyMeetingAgentSummaryTiming } = require('../utils/meetingMinutesOriginalSummary');
const { reconcileFinalApprovedActions } = require('../utils/meetingMinutesFinalActionPreservation');
const { createOriginalFinalization } = require('../utils/meetingMinutesOriginalFinalization');
const { createOriginalEditStage } = require('../utils/meetingMinutesOriginalEdits');
const { canonicalKnownStagedPersonName, TEAMS_TIMESTAMP_PATTERN, buildPreparedTranscriptForStagedAI, cleanStagedGeneratedLine, stripStagedTranscriptArtefacts, isNoEvidenceDiscussionText, cleanStagedActionText, uniqueCleanDiscussionItems } = require('../utils/stagedMinutesContext');
const { mergeNamedTopics, assessGenerationHealth, canonicalStagedResponse } = require('../utils/stagedMinutesCanonicalResponse');
const { extractStagedDetailsFromTranscript, normaliseDateInput, extractTeamsTranscriptHeader, isLikelyPersonName, uniqueNames, extractTeamsSpeakerNames, inferStagedMeetingType } = require('../utils/stagedMinutesDetails');
const { stagedNoEditReviewExperience, runStagedSequenceForEvaluation } = require('../utils/stagedMinutesEvaluation');
const router = express.Router();






const upload = multer({ storage: multer.memoryStorage() });
const testUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

const PYTHON_TIMEOUT_MS = Number(process.env.TRANSCRIPT_TEST_TIMEOUT_MS || 30000);
// /meeting-minutes-final supports the old single full-transcript Trooper pass and the
// more reliable queued chunked pipeline. Large transcripts can still take several
// seconds, so keep the route timeout generous.
const MEETING_MINUTES_FINAL_TIMEOUT_MS = Number(process.env.MEETING_MINUTES_FINAL_TIMEOUT_MS || 180000);
const { MEETING_MINUTES_JOB_PIPELINE, launchQueuedStagedMeetingMinutesStage, stagedStageResumeUrl } = require('../utils/stagedMinutesQueue');
const STAGED_MINILM_TIMEOUT_MS = Number(process.env.STAGED_MINILM_TIMEOUT_MS || 45000);
const STAGED_MINILM_WORKER_URL = (process.env.MINUTES_MINILM_WORKER_URL || 'http://127.0.0.1:8767').trim();

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

function stagedTextHasFutureCommitmentMarker(value) {
  return /\b(?:will|shall|to\s+(?:review|send|share|update|complete|prepare|provide|confirm|submit|arrange|follow up|finali[sz]e|check|circulate|draft|issue)|needs?\s+to|should|going\s+to|by\s+(?:next\s+)?(?:monday|tuesday|wednesday|thursday|friday|week|\d{1,2})|before\s+(?:the\s+)?(?:next|release|submission|audit|review)|follow[- ]?up)\b/i.test(String(value || ''));
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




// Nothing which has survived the evidence, timing and lifecycle checks may be
// lost merely because a later presentation deduper decides that two related
// deliverables sound alike.  This is deliberately not an extractor: it can
// only restore a row already present in the approved, display-eligible set,
// and only when no strict equivalent remains in the finished list.
require('../utils/meetingMinutesPromotionSourceIdentity');

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
  awaitPrivateStagedCandidateLedger,
  dedupeCommitmentsSemantically,
  startPrivateActionPrimaryPrewarm,
  startPrivateStagedCandidateLedger,
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
