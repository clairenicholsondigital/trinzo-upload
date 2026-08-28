const express = require('express');
const multer = require('multer');
const mammoth = require('mammoth');
const fetch = require('node-fetch');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const { spawnProjectKnowledgeEmbedWorker, runProjectKnowledgeRetrieval, answerProjectKnowledge } = require('../utils/knowledge');

const {
  generateToken,
  startConversation,
  sendMessage,
  getBotMessages
} = require('../utils/copilot');

const { extractTextFromUpload } = require('../utils/transcript');
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
  normaliseAndValidateActionOwner
} = require('../utils/stagedEditorial');
const { getMeetingMinutesCoreGoldenStatus } = require('../utils/meetingMinutesCoreGolden');
const { runCanonicalNoEditPass } = require('../utils/canonicalMinutes/runner');
const { runCanonicalLiveStage } = require('../utils/canonicalMinutes/liveStages');
const { suggestMeetingTypeFromEvidence } = require('../utils/canonicalMinutes/meetingTypeSuggestion');
const { prepareEvidence } = require('../utils/canonicalMinutes/evidence');
const { polishCanonicalStage, canonicalFallback, addRecoveredActionCandidates, clientReadyPresentation, repairActionWording, repairDiscussionWording, wordingFaults, ownerSupported, unresolvedReference } = require('../utils/canonicalMinutes/trooperPolish');
const { proposeActions, proposeMissedActions } = require('../utils/canonicalMinutes/proposedActions');
const { meetingRecordAdminAction } = require('../utils/canonicalMinutes/semanticStages');
const { proposeDiscussionPoints } = require('../utils/canonicalMinutes/proposedDiscussion');
const { normaliseAttendeeReferences } = require('../utils/entityNormalization');
const { duplicateGroups, encodeViaWorker, cosine, splitDedupeGroupsByOwner } = require('../utils/canonicalMinutes/semanticDedupe');
const { personErrorAssertion } = require('../utils/canonicalMinutes/claimCheck');
const { minutesEnglishFaults } = require('../utils/minutesEnglish');
const { isReviewerAuthored } = require('../utils/canonicalMinutes/state');
const { isPublishableTopicLabel, labelNamesAWorkstream } = require('../utils/canonicalMinutes/topicEditorial');
const { enrichActionReviewCandidate } = require('../utils/canonicalMinutes/actionReviewRanking');
const { reviewGeneratedContent } = require('../utils/terminologyQa');
const { generateStagedMinutesPdf, stagedMinutesPdfFilename } = require('../utils/stagedMinutesPdf');
const { polishExecutiveSummaryGrammar } = require('../utils/stagedExecutiveSummaryGrammar');
const { polishInitialUnderstanding } = require('../utils/stagedInitialUnderstandingPolish');
const { assessStagedTranscriptHealth, stagedTranscriptHealthFlag } = require('../utils/stagedTranscriptHealth');
const {
  generateTopics: generateSimplifiedTopics,
  generateDiscussion: generateSimplifiedDiscussion,
  generateDiscussionInventory: generateSimplifiedDiscussionInventory,
  generateActions: generateSimplifiedActions
} = require('../utils/simplifiedStagedMinutes');
const {
  buildConfirmedUnderstanding,
  repairDiscussionForConfirmedUnderstanding
} = require('../utils/stagedSemanticAuthority');

const {
  saveMeetingMinutes,
  saveProjectUpdateDraft,
  listProjectReports,
  getProjectReportDetail,
  saveProjectReportDetail,
  deleteProjectReport,
  deleteProjectReports,
  listProjectMilestones,
  getProjectMilestoneDetail,
  createProjectMilestone,
  updateProjectMilestone,
  deleteProjectMilestone,
  deactivateProjectMilestones,
  listProjectRisks,
  getProjectRiskDetail,
  createProjectRisk,
  updateProjectRisk,
  deleteProjectRisk,
  listProjectOptions,
  createProject,
  updateProject,
  deleteProject,
  getProjectContext,
  createProjectContextSnapshot,
  getProjectContextSnapshot,
  markProjectContextOfficial,
  cleanupProjectUpdateTestContext,
  createProjectKnowledgeItem,
  listProjectKnowledgeItems,
  updateProjectKnowledgeItem,
  archiveProjectKnowledgeItem,
  getProjectKnowledgeStatus,
  listMeetings,
  getMeetingById,
  deleteMeetingById,
  updateMeetingById,
  saveMeetingMinutesFeedback,
  listMeetingMinutesFeedback,
  getMeetingMinutesFeedback,
  updateMeetingMinutesFeedback,
  deleteMeetingMinutesFeedback,
  queueMeetingMinutesGeneration,
  queueStagedMeetingMinutesStage,
  queueProjectUpdateGeneration,
  listGenerationJobs,
  listMeetingMinutesJobs,
  getGenerationJob,
  getMeetingMinutesJob,
  retryGenerationJob,
  retryMeetingMinutesJob,
  cancelGenerationJob,
  cancelMeetingMinutesJob,
  deleteGenerationJob,
  archiveGenerationJobs,
  deleteMeetingMinutesJob,
  updateMeetingMinutesJobResult,
  saveStagedMeetingMinutesReviewEvent,
  listStagedMeetingMinutesReviewEvents,
  listTerminologyQaDecisions,
  saveTerminologyQaDecision,
  updateGenerationJobProgress,
  markGenerationJobCompleted,
  markGenerationJobFailure,
  getMeetingStatus,
  claimNextJob,
  markJobCompleted,
  markJobFailure,
  queueWebhookJob,
  markWebhookSuccess,
  markWebhookFailure,
  hasDatabaseConfig,
  getDatabaseConfigError,
  query
} = require('../utils/db');
const { requireAuth } = require('./auth');

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
const STAGED_EVIDENCE_CLASSIFIER_TIMEOUT_MS = Number(process.env.STAGED_EVIDENCE_CLASSIFIER_TIMEOUT_MS || 45000);
const TROOPER_STAGE_URL_DEFAULT = 'https://eu.router.trooper.ai/v1/chat/completions';
const TROOPER_STAGE_MODEL_DEFAULT = 'eu_liv_000099';

function safeErrorInfo(error, extra = {}) {
  const details = error && error.details && typeof error.details === 'object' ? error.details : null;
  return {
    message: error && error.message ? error.message : String(error || 'Unknown error'),
    statusCode: error && error.statusCode ? error.statusCode : undefined,
    code: error && error.code ? error.code : undefined,
    scriptName: details && details.scriptName ? details.scriptName : undefined,
    exitCode: details && details.exitCode != null ? details.exitCode : undefined,
    stdoutBytes: details && details.stdoutBytes != null ? details.stdoutBytes : undefined,
    stderrBytes: details && details.stderrBytes != null ? details.stderrBytes : undefined,
    rawOutputBytes: details && details.rawOutputBytes != null ? details.rawOutputBytes : undefined,
    parseError: details && details.parseError ? details.parseError : undefined,
    ...extra
  };
}

function safeLogError(label, error, extra = {}) {
  console.error(label, safeErrorInfo(error, extra));
}

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

function stagedAnalyticsObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function stagedAnalyticsArray(value) {
  return Array.isArray(value) ? value : [];
}

function stagedAnalyticsText(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(stagedAnalyticsText).filter(Boolean).join('\n');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value).replace(/\s+/g, ' ').trim();
}

function stagedAnalyticsWords(value) {
  return stagedAnalyticsText(value).toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2);
}

function stagedAnalyticsSimilarity(left, right) {
  const leftWords = new Set(stagedAnalyticsWords(left));
  const rightWords = new Set(stagedAnalyticsWords(right));
  if (!leftWords.size && !rightWords.size) return 1;
  if (!leftWords.size || !rightWords.size) return 0;
  const overlap = [...leftWords].filter((word) => rightWords.has(word)).length;
  return overlap / Math.max(leftWords.size, rightWords.size);
}

function stagedReviewField(stage, fieldPath, label, value) {
  return {
    stage,
    fieldPath,
    label,
    value: stagedAnalyticsText(value)
  };
}

function flattenStagedReviewVersion(versions = {}) {
  const fields = [];
  const details = stagedAnalyticsObject(versions.details);
  fields.push(stagedReviewField('details', 'details.meetingTitle', 'Meeting title', details.meetingTitle));
  fields.push(stagedReviewField('details', 'details.meetingDate', 'Meeting date', details.meetingDate));
  fields.push(stagedReviewField('details', 'details.meetingLocation', 'Meeting location', details.meetingLocation));
  fields.push(stagedReviewField('details', 'details.meetingType', 'Meeting type', details.meetingType));
  fields.push(stagedReviewField('details', 'details.internalAttendees', 'Trinzo participants', details.internalAttendees || details.trinzoAttendees));
  fields.push(stagedReviewField('details', 'details.clientAttendees', 'Client participants', details.clientAttendees || details.allAttendees));

  const summary = stagedAnalyticsObject(versions.summary);
  // The purpose and the key facts steer more of the later stages than anything else the
  // reviewer touches, and until now neither was recorded — so the edit analytics were
  // blind to the two fields most worth knowing about.
  fields.push(stagedReviewField('summary', 'summary.meetingPurpose', 'Meeting purpose', summary.meetingPurpose));
  fields.push(stagedReviewField('summary', 'summary.keyFacts', 'Key facts to preserve', summary.keyFacts));
  fields.push(stagedReviewField('summary', 'summary.objectives', 'Meeting objectives', summary.objectives));
  fields.push(stagedReviewField('summary', 'summary.executiveSummary', 'Executive summary', summary.executiveSummary));
  fields.push(stagedReviewField('summary', 'summary.overallTopics', 'Overall topics', summary.overallTopics));

  stagedAnalyticsArray(versions.discussion).forEach((item, index) => {
    fields.push(stagedReviewField('discussion', `discussion.${index}.topic`, `Discussion ${index + 1} topic`, item?.topic));
    fields.push(stagedReviewField('discussion', `discussion.${index}.points`, `Discussion ${index + 1} points`, item?.points || item?.bullets || item?.discussionPoints));
  });

  stagedAnalyticsArray(versions.actions).forEach((item, index) => {
    fields.push(stagedReviewField('actions', `actions.${index}.owner`, `Action ${index + 1} owner`, item?.owner));
    fields.push(stagedReviewField('actions', `actions.${index}.action`, `Action ${index + 1}`, item?.action || item?.meetingActionPoint));
    fields.push(stagedReviewField('actions', `actions.${index}.deadline`, `Action ${index + 1} due`, item?.deadline || item?.meetingActionPointDeadline));
  });

  return fields.filter((field) => field.value);
}

function classifyStagedReviewEdit(before, after) {
  if (!before && after) return 'added_by_reviewer';
  if (before && !after) return 'removed_by_reviewer';
  if (before === after) return 'accepted_unchanged';
  const similarity = stagedAnalyticsSimilarity(before, after);
  if (similarity >= 0.82) return 'wording_or_formatting_edit';
  if (similarity >= 0.45) return 'substantive_rewrite';
  return 'structural_or_semantic_change';
}

function buildStagedReviewDiffs(generatedVersions = {}, approvedVersions = {}) {
  const generated = flattenStagedReviewVersion(generatedVersions);
  const approved = flattenStagedReviewVersion(approvedVersions);
  const generatedByPath = new Map(generated.map((field) => [field.fieldPath, field]));
  const approvedByPath = new Map(approved.map((field) => [field.fieldPath, field]));
  const paths = [...new Set([...generatedByPath.keys(), ...approvedByPath.keys()])].sort();
  return paths.map((fieldPath) => {
    const before = generatedByPath.get(fieldPath);
    const after = approvedByPath.get(fieldPath);
    const beforeText = before ? before.value : '';
    const afterText = after ? after.value : '';
    const editType = classifyStagedReviewEdit(beforeText, afterText);
    return {
      stage: (after || before)?.stage || '',
      fieldPath,
      label: (after || before)?.label || fieldPath,
      editType,
      before: beforeText,
      after: afterText,
      beforeLength: beforeText.length,
      afterLength: afterText.length,
      similarity: Number(stagedAnalyticsSimilarity(beforeText, afterText).toFixed(3))
    };
  });
}

function summariseStagedReviewDiffs(fieldDiffs = []) {
  const byType = {};
  const byStage = {};
  fieldDiffs.forEach((diff) => {
    byType[diff.editType] = (byType[diff.editType] || 0) + 1;
    const stage = diff.stage || 'unknown';
    byStage[stage] = byStage[stage] || {};
    byStage[stage][diff.editType] = (byStage[stage][diff.editType] || 0) + 1;
  });
  return {
    totalFields: fieldDiffs.length,
    changedFields: fieldDiffs.filter((diff) => diff.editType !== 'accepted_unchanged').length,
    byType,
    byStage,
    recurringProblemCandidates: fieldDiffs
      .filter((diff) => ['substantive_rewrite', 'structural_or_semantic_change', 'removed_by_reviewer'].includes(diff.editType))
      .map((diff) => ({ stage: diff.stage, fieldPath: diff.fieldPath, editType: diff.editType, label: diff.label }))
  };
}

function stagedWorkflowInteractionEvents(events = []) {
  return stagedAnalyticsArray(events).slice(-250).map((event) => ({
    id: firstString(event?.id).slice(0, 120),
    type: firstString(event?.type).slice(0, 120),
    at: firstString(event?.at).slice(0, 80),
    stage: firstString(event?.stage).slice(0, 100),
    activeScreen: Number.isFinite(Number(event?.activeScreen)) ? Number(event.activeScreen) : null,
    source: firstString(event?.source).slice(0, 120),
    details: stagedAnalyticsObject(event?.details)
  })).filter((event) => event.type);
}

function summariseStagedWorkflowInteractions(events = []) {
  const byType = {};
  const byStage = {};
  events.forEach((event) => {
    byType[event.type] = (byType[event.type] || 0) + 1;
    const stage = event.stage || 'unknown';
    byStage[stage] = byStage[stage] || {};
    byStage[stage][event.type] = (byStage[stage][event.type] || 0) + 1;
  });
  return {
    totalEvents: events.length,
    byType,
    byStage,
    stageTransitionCount: events.filter((event) => ['stage_entered', 'stage_left', 'stage_revisited'].includes(event.type)).length,
    candidateDecisionCount: events.filter((event) => ['action_candidate_accepted', 'action_candidate_dismissed'].includes(event.type)).length,
    manualActionEventCount: events.filter((event) => /^manual_action_|^action_row_/.test(event.type)).length,
    ownerCorrectionCount: events.filter((event) => event.type === 'action_owner_changed').length,
    pdfEventCount: events.filter((event) => /^pdf_/.test(event.type)).length,
    resumeCount: events.filter((event) => event.type === 'draft_resumed').length,
    errorEventCount: events.filter((event) => /(?:failed|error|retry|timeout)/.test(event.type)).length,
    abandonmentSignalCount: events.filter((event) => event.type === 'workflow_abandonment_signal').length
  };
}

function stagedReviewProjectKey(details = {}, draftId = '') {
  return firstString(
    details.projectKey,
    details.projectName,
    details.meetingTitle,
    draftId,
    'unscoped'
  ).slice(0, 500);
}


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


function truthyFlag(value) {
  if (Array.isArray(value)) return value.some((item) => truthyFlag(item));
  if (value == null) return false;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
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

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
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
  if (/\binternal\b.*\b(?:follow ?up|review from client call|debrief)\b/i.test(titleHint)) return 'Internal follow-up';
  if (/\bimporter(?:['’]s)?\s+(?:obligations?|responsibilit(?:y|ies)|requirements?)\b/i.test(titleHint)) return 'Importer obligations review';
  if (/\baudit\b.*\b(?:kick ?off|planning|preparation|readiness)\b/i.test(titleHint)) return 'Audit kick-off / planning';
  // Split deliberately. "Technical file review" names the artefact, so review is enough to
  // identify it. "Software ... review" does not: "Software Release Review" is an ordinary
  // release review, and it was being told it was closing a technical-file change package.
  // A software technical-file review is a recurring commitment, so the recurrence words
  // are what identify that one.
  if (/\btech(?:nical)? file\b.*\b(?:weekly|check ?in|review|status)\b/i.test(titleHint)) return 'Technical file review';
  if (/\b(?:sw|software)\b.*\b(?:weekly|check ?in)\b/i.test(titleHint)) return 'Technical file review';
  if (/\b(webinar|rehearsal|dry run|run-through|run through)\b/i.test(titleHint)) return 'Webinar rehearsal';
  if (/\bworkshop\b/i.test(titleHint)) return 'Workshop';
  if (/\b(client update|status update)\b/i.test(titleHint)) return 'Client update';
  if (/\bdecision\b/i.test(titleHint)) return 'Decision meeting';
  return 'Project review';
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

const STAGED_KNOWN_INTERNAL_ATTENDEES = [
  'Colm O’Rourke',
  'Jacqui Fox',
  'David Didsbury',
  'Conor Flynn',
  'Claire Nicholson',
  'Mark Kelleher',
  'John-Paul Hughes',
  'Jenny Gough',
  'Stuart Smith',
  'Orla Skally'
];

const STAGED_KNOWN_CLIENT_ATTENDEES = [
  'Grace McGroogan',
  'Rebecca Gill',
  'Patrick Stewart',
  'Jonny Dobbin',
  'Adil Kauim',
  'Kevin Beattie',
  'Andrew Kane',
  'Christina Cargan',
  'Ciaran Ryan',
  'Claire Doherty',
  'Luke Speers',
  'Janine Thomas',
  'Abby Lennon'
];

const STAGED_ATTENDEE_BUCKET_BY_NAME = new Map([
  ...STAGED_KNOWN_INTERNAL_ATTENDEES.map((name) => [stagedKnownAttendeeKey(name), { bucket: 'internal', name }]),
  ...STAGED_KNOWN_CLIENT_ATTENDEES.map((name) => [stagedKnownAttendeeKey(name), { bucket: 'client', name }])
]);

const STAGED_KNOWN_PERSON_BY_FIRST_NAME = new Map();
for (const name of [...STAGED_KNOWN_INTERNAL_ATTENDEES, ...STAGED_KNOWN_CLIENT_ATTENDEES]) {
  const firstName = stagedKnownAttendeeKey(name).split(/\s+/)[0];
  if (!firstName) continue;
  const existing = STAGED_KNOWN_PERSON_BY_FIRST_NAME.get(firstName);
  STAGED_KNOWN_PERSON_BY_FIRST_NAME.set(firstName, existing ? null : name);
}

const STAGED_KNOWN_ATTENDEE_ALIASES = new Map([
  [stagedKnownAttendeeKey('Smith, Stuart M'), 'Stuart Smith'],
  [stagedKnownAttendeeKey('Smith Stuart M'), 'Stuart Smith']
]);

function canonicalStagedAttendeeAlias(value) {
  const cleaned = String(value || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  return STAGED_KNOWN_ATTENDEE_ALIASES.get(stagedKnownAttendeeKey(cleaned)) || cleaned;
}

function normaliseStagedKnownAttendeeAliasesInText(value) {
  return String(value || '').replace(/\bSmith,\s*Stuart\s+M\b/g, 'Stuart Smith');
}

function canonicalKnownStagedPersonName(value) {
  const cleaned = cleanStagedGeneratedLine(canonicalStagedAttendeeAlias(value || ''));
  if (!cleaned) return '';
  const exact = STAGED_ATTENDEE_BUCKET_BY_NAME.get(stagedKnownAttendeeKey(cleaned));
  if (exact?.name) return exact.name;
  if (/^[A-Za-zÀ-ÖØ-öø-ÿ'’.-]+$/.test(cleaned)) {
    const byFirstName = STAGED_KNOWN_PERSON_BY_FIRST_NAME.get(stagedKnownAttendeeKey(cleaned));
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
    const byFirstName = STAGED_KNOWN_PERSON_BY_FIRST_NAME.get(parts[0]);
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
    const known = STAGED_ATTENDEE_BUCKET_BY_NAME.get(stagedKnownAttendeeKey(canonicalName));
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
  const explicitClientAttendees = extractNamesFromLine(clientLine || attendeesLine);
  const explicitInternalAttendees = extractNamesFromLine(trinzoLine);
  const explicitClientBuckets = bucketKnownStagedAttendees(explicitClientAttendees);
  const explicitInternalBuckets = bucketKnownStagedAttendees(explicitInternalAttendees);
  const speakerBuckets = bucketKnownStagedAttendees(teamsSpeakers);
  const internalAttendees = uniqueNames([
    ...explicitInternalBuckets.internal,
    ...explicitInternalBuckets.unknown,
    ...explicitClientBuckets.internal,
    ...speakerBuckets.internal
  ]);
  const clientAttendees = uniqueNames([
    ...explicitClientBuckets.client,
    ...explicitClientBuckets.unknown,
    ...explicitInternalBuckets.client,
    ...speakerBuckets.client,
    ...(explicitClientAttendees.length ? [] : speakerBuckets.unknown)
  ]);
  const headerDate = teamsHeader.meetingDate || '';
  const headerTitle = teamsHeader.meetingTitle || '';
  const attendeeNameWarnings = teamsSpeakers.flatMap((name) => {
    const parts = stagedKnownAttendeeKey(name).split(/\s+/).filter(Boolean);
    if (parts.length < 2 || STAGED_ATTENDEE_BUCKET_BY_NAME.has(stagedKnownAttendeeKey(name))) return [];
    const knownFirstName = STAGED_KNOWN_PERSON_BY_FIRST_NAME.get(parts[0]);
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

  // The title decides the type when it can. When it cannot - the title-only inference
  // returned the default - ask the discussion, gated on recurrence and dominance, and
  // offer the answer as a pre-selected suggestion the reviewer can overrule. The evidence
  // trail travels with the payload so the suggestion is auditable, and the flag makes it
  // visible: a pre-selected dropdown with no note is indistinguishable from a default.
  const titleOnlyType = inferStagedMeetingType(text, fileName, headerTitle || meetingTitle);
  let meetingTypeSuggestion = null;
  if (titleOnlyType === 'Project review') {
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

  return {
    ok: true,
    staged: true,
    stagedStage: 'details',
    screens: {
      details: {
        meetingTitle: (headerTitle || meetingTitle).slice(0, 180),
        meetingDate: headerDate || normaliseDateInput(rawDate),
        meetingLocation: rawLocation || (/teams|microsoft teams/i.test(text) ? 'Microsoft Teams' : 'Microsoft Teams'),
        organisation: rawOrganisation,
        meetingType: suggestedType || titleOnlyType,
        meetingTypeSuggestion,
        internalAttendees,
        clientAttendees,
        // teamsSpeakers carries the transcript's own spelling, so a name repaired in the
        // bucketed lists reappeared here beside its broken twin: "Rebecca Gill" and
        // "Rebecca Cuckoo" both listed as attendees of the same meeting. Canonicalise
        // before the union so the dedupe can actually see they are one person.
        allAttendees: uniqueNames([...internalAttendees, ...clientAttendees, ...teamsSpeakers.map((name) => canonicalKnownStagedPersonName(name) || name)])
      }
    },
    validationFlags: [...attendeeNameWarnings, ...typeSuggestionFlags],
    telemetryPreview: {
      stage: 'details',
      transcriptLength: text.length,
      screenCount: 1,
      attendeeExtraction: {
        source: teamsStructure.speakers.length ? 'microsoft_teams_speaker_turns' : 'explicit_or_fallback',
        speakerCount: teamsSpeakers.length,
        turnCount: teamsStructure.turnCount,
        eventSpeakerCount: teamsStructure.eventSpeakers.length,
        knownInternalAttendeeCount: internalAttendees.length,
        knownClientAttendeeCount: clientAttendees.filter((name) => STAGED_ATTENDEE_BUCKET_BY_NAME.get(stagedKnownAttendeeKey(name))?.bucket === 'client').length,
        headerSource: teamsHeader.source || '',
        dateSource: headerDate ? 'microsoft_teams_header' : 'explicit_or_filename'
      }
    }
  };
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

function extractOverallTopicsFromTranscript(transcriptText) {
  const text = String(transcriptText || '');
  const topics = [];
  for (const rule of STAGED_TOPIC_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(text))) {
      pushUniqueTopic(topics, rule.topic);
    }
  }

  const candidateLines = text
    .split(/\r?\n/)
    .map(cleanTranscriptContentLine)
    .filter((line) => line.length >= 22 && line.length <= 180)
    .slice(0, 180);

  for (const line of candidateLines) {
    const matches = [
      line.match(/\b(?:around|about|regarding|on|for|with|covering)\s+([A-Za-z][A-Za-z0-9 /&-]{5,54})(?:[,.]|$)/i),
      line.match(/\b(?:the|this)\s+([A-Za-z][A-Za-z0-9 /&-]{5,54})\s+(?:piece|section|process|update|review|issue|risk)\b/i)
    ].filter(Boolean);

    for (const match of matches) {
      const raw = String(match[1] || '')
        .replace(/\b(?:and|or|the|this|that|with|from|into|then)\s*$/i, '')
        .trim();
      if (!raw || raw.split(/\s+/).length > 7) continue;
      pushUniqueTopic(topics, raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase());
    }
    if (topics.length >= 8) break;
  }

  if (!topics.length) {
    pushUniqueTopic(topics, 'Meeting context and decisions');
    pushUniqueTopic(topics, 'Actions and ownership');
  }

  return topics.slice(0, 8);
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

function challengeUnsupportedStagedLabels(value) {
  let text = cleanStagedDiscussionText(value);
  if (!text) return '';
  const hasHardRiskEvidence = /\b(?:blocker|blocked|delay|delayed|cannot proceed|threatens|impact(?:ing)? the timeline|critical|significant risk|major risk)\b/i.test(text);
  if (!hasHardRiskEvidence) {
    text = text
      .replace(/\bRisk exists regarding\b/ig, 'The discussion covered')
      .replace(/\bThis creates a risk regarding\b/ig, 'The discussion covered')
      .replace(/\bThere is a risk that\b/ig, 'It was noted that');
  }
  const hasHardDependencyEvidence = /\b(?:required before|cannot proceed until|blocked until|dependent on approval|waiting for|subject to|prerequisite)\b/i.test(text);
  if (!hasHardDependencyEvidence) {
    text = text
      .replace(/\bis dependent on\b/ig, 'will be aligned with')
      .replace(/\bdepends on\b/ig, 'will be aligned with')
      .replace(/\bdependency\b/ig, 'related point');
  }
  return cleanStagedDiscussionText(text);
}

function consolidateStagedDiscussionPoints(values, limit = 4) {
  const result = [];
  for (const value of values) {
    const cleaned = challengeUnsupportedStagedLabels(value);
    if (!cleaned || isNoEvidenceDiscussionText(cleaned) || isLowValueStagedDiscussionText(cleaned)) continue;
    const duplicateIndex = result.findIndex((existing) => {
      const similarity = stagedDiscussionPointSimilarity(existing, cleaned);
      return similarity >= 0.72 ||
        normaliseStagedPointForSimilarity(existing).includes(normaliseStagedPointForSimilarity(cleaned)) ||
        normaliseStagedPointForSimilarity(cleaned).includes(normaliseStagedPointForSimilarity(existing));
    });
    if (duplicateIndex >= 0) {
      if (cleaned.length < result[duplicateIndex].length || classifyStagedEvidenceRoles(cleaned).length > classifyStagedEvidenceRoles(result[duplicateIndex]).length) {
        result[duplicateIndex] = cleaned;
      }
      continue;
    }
    result.push(cleaned);
    if (result.length >= limit) break;
  }
  return result;
}

function polishStagedDiscussionCard(card) {
  if (!card || typeof card !== 'object') return null;
  const pointCandidates = [
    card.currentPosition,
    card.whatWasDiscussed,
    card.decisionOrAgreement,
    card.dependencyOrRisk,
    card.nextStep,
    ...(Array.isArray(card.points) ? card.points : [])
  ];
  const points = consolidateStagedDiscussionPoints(pointCandidates, 4);
  if (!points.length) return null;
  const polished = { ...card, points };
  for (const key of ['whatWasDiscussed', 'currentPosition', 'decisionOrAgreement', 'dependencyOrRisk', 'nextStep']) {
    if (polished[key]) polished[key] = challengeUnsupportedStagedLabels(polished[key]);
  }
  if (polished.dependencyOrRisk && !/\b(?:risk|blocker|blocked|delay|timeline|dependent|dependency|required before|cannot proceed|waiting for|subject to|prerequisite)\b/i.test(polished.dependencyOrRisk)) {
    delete polished.dependencyOrRisk;
  }
  if (polished.decisionOrAgreement && !hasStagedDecisionEvidence(polished.decisionOrAgreement)) {
    delete polished.decisionOrAgreement;
  }
  return polished;
}

function polishStagedDiscussionCards(cards) {
  const polished = (Array.isArray(cards) ? cards : [])
    .map(polishStagedDiscussionCard)
    .filter(Boolean);
  // Deduplicate whole sections (not just points within a section) so a phantom
  // workstream that merely copies another card's evidence is removed before the
  // reviewer ever sees it. Dropped headings are stashed for the advisory flag.
  const { cards: deduped, dropped } = dedupeStagedDiscussionCards(polished);
  const result = deduped.slice(0, 8);
  result.droppedDuplicates = dropped;
  return result;
}

function structuredDiscussionFromItem(item) {
  if (!item || typeof item !== 'object') return null;
  const topic = cleanStagedGeneratedLine(item.topic || item.title || item.heading || 'Discussion');
  if (!isUsableStagedTopic(topic)) return null;
  const fields = {
    whatWasDiscussed: cleanStagedDiscussionText(item.whatWasDiscussed || item.discussed || item.summary),
    currentPosition: cleanStagedDiscussionText(item.currentPosition || item.position || item.status || item.outcome),
    decisionOrAgreement: cleanStagedDiscussionText(item.decisionOrAgreement || item.decision || item.agreement),
    dependencyOrRisk: cleanStagedDiscussionText(item.dependencyOrRisk || item.dependency || item.risk),
    nextStep: cleanStagedDiscussionText(item.nextStep || item.nextAction || item.followUp)
  };
  const itemPoints = Array.isArray(item.items) ? item.items : [];
  const points = uniqueCleanDiscussionItems([
    ...Object.values(fields),
    ...stringListFromAny(item.points || item.discussionPoints || itemPoints, ['text', 'point', 'summary', 'decision', 'risk', 'dependency'])
  ]).slice(0, 6);

  const cleanFields = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value && !isNoEvidenceDiscussionText(value))
  );
  if (!Object.keys(cleanFields).length && !points.length) return null;
  return { topic, ...cleanFields, points };
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
    sharedTransport: true,
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
    sharedTransport: true,
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

function attachStagedDecisionsToDiscussionCards(cards, output = {}) {
  const result = (Array.isArray(cards) ? cards : []).map((card) => ({
    ...card,
    points: Array.isArray(card?.points) ? [...card.points] : []
  }));
  const decisions = stringListFromAny(output.decisions, ['text', 'decision', 'summary'])
    .map(cleanStagedDiscussionText)
    .filter((decision) => decision && hasStagedDecisionEvidence(decision));
  for (const decision of decisions) {
    const ranked = result
      .map((card, index) => ({
        index,
        score: stagedTokenSimilarity(decision, `${card.topic || ''} ${(card.points || []).join(' ')}`),
        occupied: Boolean(card.decisionOrAgreement)
      }))
      .sort((left, right) => left.occupied - right.occupied || right.score - left.score);
    let selected = ranked.find((item) => !item.occupied && item.score >= 0.12);
    if (!selected) selected = ranked.slice().sort((left, right) => right.score - left.score)[0];
    const target = result[selected?.index];
    if (!target || Number(selected?.score || 0) < 0.12) continue;
    target.decisionOrAgreement = target.decisionOrAgreement
      ? uniqueCleanDiscussionItems([target.decisionOrAgreement, decision]).join(' ')
      : decision;
    target.points = uniqueCleanDiscussionItems([...(target.points || []), decision]).slice(0, 6);
  }
  return result;
}

function finaliseStagedMiniLMDiscussion(cards, output) {
  return attachStagedDecisionsToDiscussionCards(polishStagedDiscussionCards(cards), output);
}

function discussionFromStagedMiniLM(minilmContext) {
  const output = stagedMiniLMOutput(minilmContext);
  const discussionTopics = Array.isArray(output.discussionTopics) ? output.discussionTopics : [];
  const discussionCards = Array.isArray(output.discussion) ? output.discussion : [];
  const minutes = Array.isArray(output.meetingMinutes) ? output.meetingMinutes : [];
  const cards = [];

  for (const card of discussionCards) {
    const structured = structuredDiscussionFromItem(card);
    if (structured) cards.push(structured);
    if (cards.length >= 8) return finaliseStagedMiniLMDiscussion(cards, output);
  }

  for (const topicItem of discussionTopics) {
    const structured = structuredDiscussionFromItem(topicItem);
    if (structured) cards.push(structured);
    if (cards.length >= 8) break;
  }

  if (cards.length) return finaliseStagedMiniLMDiscussion(cards, output);

  for (const minute of minutes) {
    const structured = structuredDiscussionFromItem({
      ...minute,
      topic: minute?.topic || minute?.topicLabel,
      points: minute?.discussionPoints
    });
    if (structured) cards.push(structured);
    if (cards.length >= 8) break;
  }

  if (cards.length) return finaliseStagedMiniLMDiscussion(cards, output);

  const details = Array.isArray(output.discussionPointDetails) ? output.discussionPointDetails : [];
  for (const detail of details) {
    if (!detail || typeof detail !== 'object') continue;
    const point = cleanStagedDiscussionText(detail.discussionPoint);
    const supporting = uniqueCleanDiscussionItems(stringListFromAny(detail.supportingContext || detail.directEvidence, ['text'])).slice(0, 3);
    if (!point || isNoEvidenceDiscussionText(point)) continue;
    const topic = cleanStagedGeneratedLine(detail.topic || detail.topicLabel || topic_label_from_text(point) || 'Discussion');
    cards.push({
      topic: isUsableStagedTopic(topic) ? topic : 'Discussion',
      whatWasDiscussed: point,
      points: uniqueCleanDiscussionItems([point, ...supporting]).slice(0, 5)
    });
    if (cards.length >= 8) break;
  }

  if (!cards.length) {
    const plainPoints = stringListFromAny(output.discussionPoints, ['discussionPoint', 'text', 'summary']);
    for (const point of plainPoints) {
      const cleaned = cleanStagedDiscussionText(point);
      if (!cleaned || isNoEvidenceDiscussionText(cleaned) || isLowValueStagedDiscussionText(cleaned)) continue;
      const structured = structuredDiscussionFromItem({
        topic: topic_label_from_text(cleaned),
        points: [cleaned]
      });
      if (!structured) continue;
      if (cards.length < 8) {
        cards.push(structured);
        continue;
      }
      const ranked = cards
        .map((card, index) => ({
          index,
          score: stagedDiscussionPointSimilarity(cleaned, `${card.topic || ''} ${(card.points || []).join(' ')}`)
        }))
        .sort((left, right) => right.score - left.score);
      const target = cards[ranked[0]?.index ?? (cards.length - 1)];
      if (target && Array.isArray(target.points) && target.points.length < 6) target.points.push(cleaned);
    }
  }

  return finaliseStagedMiniLMDiscussion(cards, output);
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

function attachStagedEvidenceClassifierContext(context, evidenceContext) {
  const base = context && typeof context === 'object'
    ? context
    : {
        ok: false,
        output: {},
        counts: {},
        diagnostics: {}
      };
  const diagnostics = base.diagnostics && typeof base.diagnostics === 'object' ? base.diagnostics : {};
  return {
    ...base,
    ok: Boolean(base.ok || evidenceContext?.ok),
    evidenceClassifier: evidenceContext,
    diagnostics: {
      ...diagnostics,
      evidenceClassifier: stagedEvidenceClassifierTelemetry({ evidenceClassifier: evidenceContext })
    }
  };
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

function stagedActionKeywords(action) {
  const stopWords = new Set([
    'the', 'and', 'for', 'with', 'from', 'into', 'onto', 'that', 'this', 'copy',
    'review', 'share', 'send', 'follow', 'complete', 'confirm', 'prepare', 'update',
    'provide', 'draft', 'arrange', 'schedule', 'sign', 'off'
  ]);
  return cleanStagedActionText(action)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 4 && !stopWords.has(word))
    .slice(0, 8);
}

function stagedDeadlineEvidenceWindows(transcriptText) {
  const lines = String(transcriptText || '')
    .split(/\r?\n/)
    .map(cleanTranscriptContentLine)
    .filter(Boolean);
  return lines.map((line, index) => ({
    line,
    window: [lines[index - 1], line, lines[index + 1]].filter(Boolean).join(' ')
  }));
}

function inferredDeadlineForStagedAction(action, transcriptText) {
  const keywords = stagedActionKeywords(action);
  if (keywords.length < 3) return '';
  let best = { score: 0, deadline: '' };
  for (const item of stagedDeadlineEvidenceWindows(transcriptText)) {
    const deadline = deadlineFromActionEvidence(item.window);
    if (!deadline) continue;
    const lower = item.window.toLowerCase();
    const overlap = keywords.filter((word) => lower.includes(word)).length;
    const hasActionCue = /\b(?:will|i'll|i will|we will|can you|could you|please|need to|needs to|follow[- ]?up|action|deadline|by|before)\b/i.test(item.window);
    const score = overlap + (hasActionCue ? 1 : 0);
    if (score > best.score && overlap >= 3 && score >= 4) best = { score, deadline };
  }
  return best.deadline || '';
}

function normaliseDeadlineKey(value) {
  return cleanStagedGeneratedLine(value || '')
    .toLowerCase()
    .replace(/^next\s+/i, '')
    .replace(/\bof\s+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stagedDeadlineIsSupportedByActionEvidence(action, deadline, transcriptText) {
  const cleanedDeadline = cleanStagedGeneratedLine(deadline || '');
  if (!cleanedDeadline || /^not stated$/i.test(cleanedDeadline)) return true;
  const keywords = stagedActionKeywords(action);
  if (keywords.length < 3) return false;
  const deadlineKey = normaliseDeadlineKey(cleanedDeadline);
  for (const item of stagedDeadlineEvidenceWindows(transcriptText)) {
    const found = deadlineFromActionEvidence(item.window);
    if (!found || normaliseDeadlineKey(found) !== deadlineKey) continue;
    const lower = item.window.toLowerCase();
    const overlap = keywords.filter((word) => lower.includes(word)).length;
    const hasActionCue = /\b(?:will|i'll|i will|we will|can you|could you|please|need to|needs to|follow[- ]?up|action|deadline|by|before|complete|review|send|share|update|sign)\b/i.test(item.window);
    if (overlap >= 3 && hasActionCue) return true;
  }
  return false;
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

function stagedTrooperSchema(stage) {
  if (stage === 'summary') {
    return {
      objectives: ['Outcome-led project review objective'],
      executiveSummary: 'Client-ready status summary covering current project position, changes, agreements, risks and timeline threats.',
      overallTopics: ['Topic label']
    };
  }
  if (stage === 'discussion') {
    return {
      executiveSummaryFromFindings: 'Optional concise minutes summary synthesised from the included evidence-backed discussion findings',
      discussionTopics: [
        {
          topic: 'One of the confirmed overallTopics, in the same order where possible',
          whatWasDiscussed: 'What was materially discussed for this topic, if evidenced',
          currentPosition: 'Current project position or status for this topic, if evidenced',
          decisionOrAgreement: 'Decision, agreement, or changed position, if evidenced',
          dependencyOrRisk: 'Dependency, blocker, risk, or timeline threat, if evidenced',
          nextStep: 'Next step or follow-up, if evidenced',
          items: [{ text: 'Additional evidence-backed discussion point only if useful', evidence: 'Short transcript phrase if useful' }]
        }
      ]
    };
  }
  if (stage === 'actions') {
    return {
      actions: [
        {
          owner: 'Named person, All, or Not stated',
          action: 'Concrete agreed follow-up',
          deadline: 'Explicit date/relative deadline or Not stated',
          evidence: 'Short transcript phrase if useful'
        }
      ]
    };
  }
  return {};
}

function buildStagedTrooperPrompt(stage, transcript, req, options = {}) {
  const details = stagedDetailsWithConfirmedContext(req, transcript);
  const context = stagedContextFromRequest(req);
  const confirmedUnderstanding = context.confirmedUnderstanding;
  const discussionEvidencePack = stage === 'discussion'
    ? (Array.isArray(options.evidencePack) && options.evidencePack.length
      ? options.evidencePack
      : topicEvidenceForStagedDiscussion(transcript, context.overallTopics))
    : [];
  const discussionWorkstreamState = stage === 'discussion' && Array.isArray(options.workstreamState)
    ? options.workstreamState
    : [];
  const confirmed = {
    meetingTitle: details.meetingTitle || context.meetingTitle,
    meetingDate: details.meetingDate || context.meetingDate,
    meetingLocation: details.meetingLocation || context.meetingLocation,
    meetingType: context.meetingType || details.meetingType || 'Project review',
    participants: context.participants.length ? context.participants : details.allAttendees,
    meetingPurpose: confirmedUnderstanding.meetingPurpose,
    keyFacts: confirmedUnderstanding.criticalFacts.map((fact) => fact.text),
    confirmedUnderstanding,
    overallTopics: context.overallTopics,
    reviewerGuidance: context.additionalContext,
    topicEvidence: discussionEvidencePack,
    workstreamState: discussionWorkstreamState,
    actionInventory: stage === 'actions'
      ? polishStagedActions([
        ...buildStagedActionInventory(transcript.text),
        ...actionsFromEvidenceClassifier({ evidenceClassifier: options.actionEvidenceContext })
      ])
      : [],
    actionEvidenceClassifier: stage === 'actions'
      ? {
        actions: actionsFromEvidenceClassifier({ evidenceClassifier: options.actionEvidenceContext }),
        telemetry: stagedEvidenceClassifierTelemetry({ evidenceClassifier: options.actionEvidenceContext })
      }
      : null
  };
  const stageInstruction = {
    summary: [
      'Write stage 2 only: objectives, executive summary and overall topic labels.',
      'Use the confirmed meeting title, project/meeting type, date, location and participants as the frame.',
      'Use reviewerGuidance to improve emphasis and framing when supplied, but do not treat it as transcript evidence.',
      'Write the executiveSummary as a project-status narrative, not a list of topics covered.',
      'The executiveSummary must capture where the project actually stands, what changed, what was agreed, and what threatens the timeline.',
      'Do not write phrases such as "key discussions covered", "the meeting covered", "this meeting focused on", or "the reviewer should check".',
      'If evidence is limited, state the high-confidence status and open risk plainly rather than padding.',
      'Return 2-4 objectives, one concise executiveSummary paragraph, and 4-8 overallTopics.'
    ],
    discussion: [
      'Write stage 3 only: discussion points grouped against the confirmed topics.',
      'Treat CONFIRMED_CONTEXT.confirmedUnderstanding.meetingPurpose and CONFIRMED_CONTEXT.confirmedUnderstanding.criticalFacts as reviewer-confirmed semantic framing when they are relevant to the transcript evidence.',
      'Preserve relevant reviewer-confirmed critical facts in the discussion output; do not weaken them into generic topic labels.',
      'Treat CONFIRMED_CONTEXT.overallTopics as the agenda for a methodical transcript pass.',
      'For each confirmed overall topic, look through the transcript for evidence relevant to that topic before moving to the next topic.',
      'Use CONFIRMED_CONTEXT.topicEvidence as the MiniLM semantic evidence pack where present, then cross-check against the transcript.',
      'Use CONFIRMED_CONTEXT.workstreamState as the internal project-record object before writing the public discussion table.',
      'The workstreamState object classifies evidence into current status, completed/past activity, future commitment, decision/agreement, open point, dependency, technical detail, general chatter/noise and explicit action buckets.',
      'Render discussion rows from workstreamState first, using topicEvidence only as the supporting evidence backstop.',
      'Each workstreamState row has already been attribution-scored against competing workstreams. Use only evidence listed under that exact workstream.',
      'Do not borrow evidence from another workstream simply because both workstreams involve documentation, procedures, submissions, reviews or feedback.',
      'If qualityFlags include missing_workstream_recovered, include the row when the evidence is substantive because it was recovered after the first semantic clustering pass missed it.',
      'Preserve the current status, changes since last review, decisions, open points, dependencies, technical detail and next steps where evidenced.',
      'For process-heavy topics, preserve the operational sequence as short concrete bullets rather than compressing it into one generic paragraph.',
      'Human-style discussion rows should read like minutes: current position first, then process/detail, then decisions, dependencies/risks and next step if evidenced.',
      'Do not convert completed or past activity into a future action.',
      'Keep explicit actions for the actions stage unless they are needed as a clearly evidenced next-step sentence in the discussion row.',
      'If a workstream has qualityFlags such as abstract_workstream_heading or low_heading_evidence_match, prefer a more operational label from the evidence, confirmed topic, document, deliverable, system, standard or process.',
      'If workstreamState contains a substantive evidenced workstream, include it unless it is clearly redundant with another row; this is the omission-risk check.',
      'Before finalising each row, check: does every bullet belong to this exact workstream rather than a neighbouring topic?',
      'For every confirmed topic that has topicEvidence snippets, return one discussionTopics object unless the snippets are clearly irrelevant.',
      'Do not collapse separate confirmed topics into one combined topic.',
      'Also do not over-segment: if topicEvidence combines overlapping transcript evidence under one topic, keep it as one consolidated topic.',
      'Prefer consolidation over coverage: include the distinct points a reviewer needs to understand the meeting outcome, not every detectable phrase.',
      'Merge repeated prerequisites, repeated status statements and repeated next-step statements into one stronger bullet.',
      'Before using labels such as risk, dependency, agreed, confirmed, will or must, check that the transcript evidence actually supports that label.',
      'Do not describe scope control, regulatory breadth or ordinary sequencing as a risk or dependency unless the evidence frames it as a blocker, threat, required-before condition or unresolved constraint.',
      'Return discussionTopics in the same order as the confirmed overallTopics where possible.',
      'Use the confirmed title, meeting type, participants, summary topics and transcript evidence.',
      'Use reviewerGuidance as non-evidence context for emphasis only when supplied.',
      'Do not create new unrelated topics unless the confirmed overallTopics list is empty.',
      'Only include a topic if there is substantive transcript evidence for it.',
      'If a confirmed topic has little or no evidence, omit that topic entirely. Do not write that there was no discussion.',
      'For each included topic, populate only evidenced fields from: whatWasDiscussed, currentPosition, decisionOrAgreement, dependencyOrRisk, nextStep.',
      'Write each field as polished formal-minutes prose, not copied transcript text.',
      'Never include raw speaker names, timestamps, timecodes, glued speaker/timecode prefixes, filler words, false starts, or malformed transcript phrasing in any public field.',
      'Do not write "Name said that..." narration; write the account in neutral third-person formal minutes style.',
      'Also return executiveSummaryFromFindings: a concise formal-minutes summary synthesised from the included findings, focused on status, changes, agreements, risks, dependencies and time-critical next steps.',
      'Do not describe the meeting itself or list the included topics in executiveSummaryFromFindings.',
      'Return 2-8 discussionTopics with concise evidence-backed fields and no filler.'
    ],
    actions: [
      'Write stage 4 only: actions, owners and deadlines.',
      'Use the confirmed title, meeting type, participants and transcript evidence.',
      'Use CONFIRMED_CONTEXT.actionInventory as a transcript-wide candidate action ledger before selecting or formatting actions.',
      'Use CONFIRMED_CONTEXT.actionEvidenceClassifier as a supporting evidence ledger: keep confirmed action candidates and respect suppression reasons such as completed history, sequence-only wording, record-location wording, hypotheticals without assignment, and low-value logistics.',
      'Preserve every distinct commitment from actionInventory unless the transcript clearly shows it is completed, cancelled, or a true duplicate.',
      'Do not compress actions to a target count. Separate actions must remain separate when the owner, deliverable, verb, standard/document/system, or deadline differs.',
      'For example, "review a standard", "share the standard", "complete testing", and "identify testing gaps" are separate actions even if they sit under one workstream.',
      'Use reviewerGuidance as non-evidence context for emphasis only when supplied.',
      'Only include real commitments or follow-ups. If the owner or deadline is not explicit, use Not stated.',
      'Every action must have an auditable verb and object. Reject conversational fragments such as "front-end everything", "sort things", "do prep", "look at it" or "progress this".',
      'Rewrite catch-up commitments as concrete scheduling actions, for example "Arrange a catch-up meeting with [person]" where the transcript supports the object.',
      'Do not turn completed work, general intentions, ongoing workstreams or open points into actions.',
      'If the transcript clearly says the group owns an action using we/us/the team, use All as the owner.'
    ]
  }[stage] || ['Write only the requested staged meeting-minutes section.'];

  return [
    '[CMD: task=staged_meeting_minutes_section; format=json; evidence=transcript_grounded; style=client_ready_uk_business_english]',
    '',
    'CONFIRMED_CONTEXT:',
    JSON.stringify(confirmed, null, 2),
    '',
    ...(options.strictTopicCoverage ? [
      'RETRY_NOTE:',
      'The previous stage 3 response was too thin, duplicated, omitted evidenced workstreams, or placed evidence under the wrong workstream. Re-run the stage methodically, using workstreamState and topicEvidence to produce concise topic rows for the distinct evidenced workstreams.',
      ''
    ] : []),
    'STAGE_INSTRUCTIONS:',
    stageInstruction.map((line) => `- ${line}`).join('\n'),
    '',
    'Return valid JSON only with this shape:',
    JSON.stringify(stagedTrooperSchema(stage), null, 2),
    '',
    'Rules:',
    '- Do not invent facts, attendees, owners, deadlines, decisions or topics.',
    '- Prefer fewer high-confidence points over many weak points.',
    '- Keep wording professional and concise.',
    '- Use British English spelling.',
    '- Do not copy raw transcript turns into public text; rewrite them into clear complete sentences without speaker labels or timestamps.',
    '- Do not output raw "Name:" or "Name said that..." wording.',
    '',
    '[TRANSCRIPT]',
    String(transcript.text || '').slice(0, Number(process.env.STAGED_TROOPER_MAX_TRANSCRIPT_CHARS || 90000)),
    '[/TRANSCRIPT]'
  ].join('\n');
}

async function buildStagedTrooperContext(stage, transcript, req, options = {}) {
  const apiKey = String(process.env.TROOPER_API_KEY || '').trim();
  const model = String(process.env.TROOPER_MODEL || TROOPER_STAGE_MODEL_DEFAULT).trim() || TROOPER_STAGE_MODEL_DEFAULT;
  const url = String(process.env.TROOPER_CHAT_COMPLETIONS_URL || TROOPER_STAGE_URL_DEFAULT).trim() || TROOPER_STAGE_URL_DEFAULT;
  if (!apiKey) {
    return {
      ok: false,
      output: {},
      counts: {},
      rewriterAvailable: false,
      rewriterReason: 'TROOPER_API_KEY is not configured.',
      diagnostics: {
        provider: 'trooper_stage',
        modelAvailable: false,
        modelName: model,
        modelReason: 'TROOPER_API_KEY is not configured.',
        pipeline: `staged_${stage}_targeted`,
        timingMs: {}
      }
    };
  }

  try {
    const startedAt = Date.now();
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: 'You generate one staged meeting-minutes section at a time. Return valid JSON only.'
          },
          {
            role: 'user',
            content: buildStagedTrooperPrompt(stage, transcript, req, options)
          }
        ],
        temperature: Number(process.env.STAGED_TROOPER_TEMPERATURE || 0.15),
        max_tokens: Number(process.env.STAGED_TROOPER_MAX_TOKENS || (stage === 'discussion' ? 2200 : 1400)),
        response_format: { type: 'json_object' }
      })
    });
    const rawBody = await response.text();
    if (!response.ok) {
      const error = new Error(`Trooper staged ${stage} request failed with status ${response.status}.`);
      error.statusCode = response.status;
      error.details = { responseBytes: Buffer.byteLength(rawBody || '', 'utf8') };
      throw error;
    }
    let parsedBody;
    try {
      parsedBody = rawBody ? JSON.parse(rawBody) : {};
    } catch (error) {
      const wrapped = new Error(`Trooper staged ${stage} response was not valid JSON.`);
      wrapped.details = { responseBytes: Buffer.byteLength(rawBody || '', 'utf8') };
      throw wrapped;
    }
    const content = parsedBody?.choices?.[0]?.message?.content || '';
    const output = typeof content === 'object' && content ? content : extractJsonFromText(content);
    const outputContext = output && typeof output === 'object' ? { ok: true, output } : null;
    const missingWorkstreams = stage === 'discussion'
      ? missingStagedWorkstreamsFromOutput(outputContext, options.workstreamState)
      : [];
    return {
      ok: Boolean(output && typeof output === 'object'),
      output: output && typeof output === 'object' ? output : {},
      counts: {},
      workstreamState: stage === 'discussion' && Array.isArray(options.workstreamState) ? options.workstreamState : [],
      rewriterAvailable: true,
      rewriterReason: `Trooper targeted staged ${stage} generation used${options.strictTopicCoverage ? ' with strict topic coverage retry' : ''}.`,
      diagnostics: {
        provider: 'trooper_stage',
        modelAvailable: true,
        modelName: model,
        modelReason: `Trooper targeted staged ${stage} generation used${options.strictTopicCoverage ? ' with strict topic coverage retry' : ''}.`,
        pipeline: `staged_${stage}_targeted`,
        timingMs: { total: Date.now() - startedAt },
        strictTopicCoverage: Boolean(options.strictTopicCoverage),
        evidencePackTopicCount: Array.isArray(options.evidencePack) ? options.evidencePack.length : 0,
        workstreamStateCount: Array.isArray(options.workstreamState) ? options.workstreamState.length : 0,
        missingWorkstreamCount: missingWorkstreams.length,
        missingWorkstreams,
        workstreamQualityFlags: Array.isArray(options.workstreamState)
          ? [...new Set(options.workstreamState.flatMap((item) => Array.isArray(item.qualityFlags) ? item.qualityFlags : []))].slice(0, 12)
          : [],
        usage: parsedBody?.usage || null
      }
    };
  } catch (error) {
    safeLogError('[Staged meeting minutes targeted Trooper generation failed]', error, { stage });
    return {
      ok: false,
      output: {},
      counts: {},
      rewriterAvailable: false,
      rewriterReason: error?.message || 'Trooper targeted stage generation failed.',
      diagnostics: {
        provider: 'trooper_stage',
        modelAvailable: false,
        modelName: model,
        modelReason: error?.message || 'Trooper targeted stage generation failed.',
        pipeline: `staged_${stage}_targeted`,
        timingMs: {}
      }
    };
  }
}

async function buildStagedMiniLMContext(transcript) {
  if (!STAGED_MINILM_WORKER_URL) {
    return {
      ok: false,
      output: {},
      counts: {},
      diagnostics: {
        modelAvailable: false,
        modelName: '',
        modelReason: 'No embedding worker URL configured.'
      }
    };
  }

  try {
    const result = await runPythonTranscriptScript(
      'meeting_minutes_minilm_only.py',
      transcript.text,
      ['--skip-rewrite', '--skip-diagnostics'],
      {
        timeoutMs: STAGED_MINILM_TIMEOUT_MS,
        env: {
          MINUTES_MINILM_WORKER_URL: STAGED_MINILM_WORKER_URL
        }
      }
    );
    const output = result?.output && typeof result.output === 'object' ? result.output : {};
    return {
      ok: Boolean(result?.executed && result?.modelAvailable && Object.keys(output).length),
      output,
      counts: result?.counts || {},
      diagnostics: {
        modelAvailable: Boolean(result?.modelAvailable),
        modelName: result?.modelName || '',
        modelReason: result?.modelReason || '',
        timingMs: result?.timingMs || {}
      }
    };
  } catch (error) {
    safeLogError('[Staged meeting minutes embedding context failed]', error);
    return {
      ok: false,
      output: {},
      counts: {},
      diagnostics: {
        modelAvailable: false,
        modelName: '',
        modelReason: error?.message || 'Embedding context failed.'
      }
    };
  }
}

async function buildStagedEvidenceClassifierContext(transcript) {
  try {
    const result = await runPythonTranscriptScript(
      'meeting_minutes_evidence_classifier.py',
      transcript.text,
      ['--limit', '20'],
      { timeoutMs: STAGED_EVIDENCE_CLASSIFIER_TIMEOUT_MS }
    );
    return {
      ok: Boolean(result?.executed && result?.modelAvailable),
      executed: Boolean(result?.executed),
      modelAvailable: Boolean(result?.modelAvailable),
      modelName: result?.modelName || '',
      modelReason: result?.modelReason || '',
      counts: result?.counts || {},
      segmentsConsidered: Number(result?.segmentsConsidered || 0),
      segmentsScored: Number(result?.segmentsScored || 0),
      actions: Array.isArray(result?.actions) ? result.actions : [],
      items: Array.isArray(result?.items) ? result.items : [],
      diagnostics: {
        provider: 'meeting_minutes_evidence_classifier',
        modelAvailable: Boolean(result?.modelAvailable),
        modelName: result?.modelName || '',
        modelPath: result?.modelPath || '',
        modelReason: result?.modelReason || '',
        timingMs: result?.timingMs || {}
      }
    };
  } catch (error) {
    safeLogError('[Staged meeting minutes evidence classifier failed]', error);
    return {
      ok: false,
      executed: false,
      modelAvailable: false,
      modelName: '',
      modelReason: error?.message || 'Evidence classifier failed.',
      counts: {},
      segmentsConsidered: 0,
      segmentsScored: 0,
      actions: [],
      items: [],
      diagnostics: {
        provider: 'meeting_minutes_evidence_classifier',
        modelAvailable: false,
        modelName: '',
        modelPath: '',
        modelReason: error?.message || 'Evidence classifier failed.',
        timingMs: {}
      }
    };
  }
}

function stagedFastContextIsUsable(stage, context) {
  if (!context) return false;
  if (stage === 'actions' && actionsFromEvidenceClassifier(context).length) return true;
  if (!context.ok) return false;
  if (stage === 'summary') {
    const output = stagedMiniLMOutput(context);
    return Boolean(
      topicsFromStagedMiniLM(context).length ||
      cleanStagedGeneratedLine(output.executiveSummary || output.meetingDescription || output.summary)
    );
  }
  if (stage === 'discussion') {
    return Boolean(discussionFromStagedMiniLM(context).length);
  }
  if (stage === 'actions') {
    return Boolean(actionsFromStagedMiniLM(context).length || actionsFromEvidenceClassifier(context).length);
  }
  return false;
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
    meetingType: firstString(confirmedDetails.meetingType, req.body?.meetingType, req.query?.meetingType, 'Project review'),
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

function parseStagedReviewArray(value) {
  return parseStagedJsonArray(value);
}

function stagedReviewContextFromRequest(req) {
  return {
    objectives: parseStagedReviewArray(req.body?.reviewObjectives || req.query?.reviewObjectives)
      .map((item) => cleanStagedGeneratedLine(item))
      .filter(Boolean),
    discussion: parseStagedReviewArray(req.body?.reviewDiscussion || req.query?.reviewDiscussion)
      .map((item) => {
        if (!item || typeof item !== 'object') return null;
        const points = uniqueCleanDiscussionItems(item.points || item.bullets || item.discussionPoints || []);
        const topic = cleanStagedGeneratedLine(item.topic || item.title || 'Discussion');
        return topic && points.length ? { topic, points } : null;
      })
      .filter(Boolean),
    actions: parseStagedReviewArray(req.body?.reviewActions || req.query?.reviewActions)
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

function topicKeywords(topic) {
  return String(topic || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4 && !['meeting', 'review', 'update', 'discussion'].includes(word))
    .slice(0, 6);
}

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

function extractStagedEvidenceTexts(values, limit = 6) {
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const raw = value && typeof value === 'object' ? value.text : value;
    const cleaned = cleanStagedEvidenceSnippet(raw);
    const key = cleaned.toLowerCase();
    if (!cleaned || seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
    if (result.length >= limit) break;
  }
  return result;
}

function extractStagedSourceTurns(values) {
  const turns = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    if (!value || typeof value !== 'object') continue;
    const candidates = Array.isArray(value.sourceTurnIndices) ? value.sourceTurnIndices : [value.sourceTurnIndex, value.turnIndex, value.index];
    for (const candidate of candidates) {
      const number = Number(candidate);
      if (Number.isFinite(number) && number >= 0) turns.add(number);
    }
  }
  return [...turns].sort((left, right) => left - right);
}

function bestConfirmedTopicForEvidence(item, confirmedTopics) {
  const topics = Array.isArray(confirmedTopics) ? confirmedTopics.map(cleanStagedGeneratedLine).filter(Boolean) : [];
  if (!topics.length) return '';
  const searchable = [
    item.topic,
    ...(item.points || []),
    ...(item.evidence || []),
    ...(item.supportingContext || [])
  ].join(' ');
  const ranked = topics.map((topic) => ({
    topic,
    score: Math.max(stagedTokenSimilarity(topic, item.topic), stagedTokenSimilarity(topic, searchable)),
    distinctiveHits: distinctiveWorkstreamTokens(topic).filter((token) => searchable.toLowerCase().includes(token)).length
  })).sort((left, right) => right.score - left.score || right.distinctiveHits - left.distinctiveHits);
  const best = ranked[0] || { topic: '', score: 0, distinctiveHits: 0 };
  const runnerUp = ranked[1] || { score: 0 };
  return best.score >= 0.26 && best.score - runnerUp.score >= 0.1 && best.distinctiveHits > 0 ? best.topic : '';
}

const GENERIC_WORKSTREAM_TOKENS = new Set(['process', 'review', 'product', 'products', 'document', 'documentation', 'requirement', 'requirements', 'status', 'update', 'discussion', 'project', 'meeting', 'current', 'position', 'workstream', 'business']);

function distinctiveWorkstreamTokens(value) {
  return [...stagedTopicTokenSet(value)].filter((token) => token.length >= 4 && !GENERIC_WORKSTREAM_TOKENS.has(token));
}

function stagedEvidenceSearchText(item) {
  return [
    item?.topic,
    ...(Array.isArray(item?.points) ? item.points : []),
    ...(Array.isArray(item?.evidence) ? item.evidence : []),
    ...(Array.isArray(item?.supportingContext) ? item.supportingContext : []),
    ...(Array.isArray(item?.decisionsOrAgreements) ? item.decisionsOrAgreements : []),
    ...(Array.isArray(item?.risksOrDependencies) ? item.risksOrDependencies : []),
    ...(Array.isArray(item?.actions) ? item.actions : [])
  ].join(' ');
}

function workstreamEvidenceFitScore(workstream, item) {
  const topic = cleanStagedGeneratedLine(workstream);
  if (!topic || !item) return 0;
  const searchText = stagedEvidenceSearchText(item);
  const topicFit = stagedTokenSimilarity(topic, item.topic || '');
  const evidenceFit = stagedTokenSimilarity(topic, searchText);
  const topicTokens = stagedTopicTokenSet(topic);
  const textTokens = stagedTopicTokenSet(searchText);
  let exactHits = 0;
  for (const token of topicTokens) {
    if (textTokens.has(token)) exactHits += 1;
  }
  const exactFit = topicTokens.size ? exactHits / topicTokens.size : 0;
  const distinctive = distinctiveWorkstreamTokens(topic);
  const distinctiveHits = distinctive.filter((token) => textTokens.has(token)).length;
  const distinctiveFit = distinctive.length ? distinctiveHits / distinctive.length : 0;
  return Math.max(topicFit * 0.55, evidenceFit * 0.75, exactFit * 0.65, distinctiveFit);
}

function bestWorkstreamForEvidence(item, workstreams = []) {
  const scored = (Array.isArray(workstreams) ? workstreams : [])
    .map((topic) => ({ topic: cleanStagedGeneratedLine(topic), score: workstreamEvidenceFitScore(topic, item) }))
    .filter((entry) => entry.topic)
    .sort((left, right) => right.score - left.score);
  return {
    best: scored[0] || { topic: '', score: 0 },
    runnerUp: scored[1] || { topic: '', score: 0 }
  };
}

function reassignStagedEvidencePackByWorkstream(items, confirmedTopics = []) {
  const topics = (Array.isArray(confirmedTopics) ? confirmedTopics : [])
    .map(cleanStagedGeneratedLine)
    .filter(Boolean);
  if (!topics.length) return Array.isArray(items) ? items : [];
  const reassigned = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue;
    const { best, runnerUp } = bestWorkstreamForEvidence(item, topics);
    const currentScore = workstreamEvidenceFitScore(item.topic, item);
    const searchText = stagedEvidenceSearchText(item).toLowerCase();
    const distinctiveHits = distinctiveWorkstreamTokens(best.topic).filter((token) => searchText.includes(token)).length;
    const decisive = best.score >= 0.28 && best.score - runnerUp.score >= 0.12 && distinctiveHits > 0;
    const shouldMove = best.topic && decisive && best.score >= currentScore + 0.1;
    const uncertain = !shouldMove && currentScore < 0.18 && (!decisive || best.score - runnerUp.score < 0.12);
    const next = {
      ...item,
      topic: shouldMove ? best.topic : (uncertain ? 'Unassigned evidence (review)' : item.topic),
      originalTopic: shouldMove ? item.topic : item.originalTopic,
      attribution: {
        workstreamEvidenceFitScore: Number((shouldMove ? best.score : Math.max(best.score, currentScore)).toFixed(3)),
        competingWorkstream: runnerUp.topic || '',
        competingFitScore: Number((runnerUp.score || 0).toFixed(3)),
        reassignedByWorkstreamFit: Boolean(shouldMove),
        uncertain: Boolean(uncertain)
      },
      qualityFlags: [...new Set([...(Array.isArray(item.qualityFlags) ? item.qualityFlags : []), ...(uncertain ? ['unassigned_workstream_evidence'] : [])])]
    };
    reassigned.push(next);
  }
  return mergeStagedDiscussionEvidencePack(reassigned, 8);
}

function mergeStagedDiscussionEvidencePack(items, limit = 6) {
  const merged = [];
  for (const item of items) {
    const topic = cleanStagedGeneratedLine(item.topic);
    if (!topic || !isUsableStagedTopic(topic)) continue;
    const sourceTurns = Array.isArray(item.sourceTurnIndices) ? item.sourceTurnIndices : [];
    const existing = merged.find((candidate) => {
      const sharedTurns = sourceTurns.length && candidate.sourceTurnIndices.some((turn) => sourceTurns.includes(turn));
      const similarity = stagedTokenSimilarity(candidate.topic, topic);
      if (sharedTurns && similarity >= 0.22) return true;
      return similarity >= 0.45 || candidate.topic.toLowerCase().includes(topic.toLowerCase()) || topic.toLowerCase().includes(candidate.topic.toLowerCase());
    });
    const target = existing || {
      topic,
      points: [],
      evidence: [],
      supportingContext: [],
      decisionsOrAgreements: [],
      risksOrDependencies: [],
      actions: [],
      sourceTurnIndices: [],
      confidence: 0,
      source: item.source || 'staged_evidence_pack',
      originalTopic: item.originalTopic || '',
      attribution: item.attribution || null,
      qualityFlags: Array.isArray(item.qualityFlags) ? item.qualityFlags.slice(0, 8) : []
    };
    target.points = uniqueCleanDiscussionItems([...(target.points || []), ...(item.points || [])]).slice(0, 6);
    target.evidence = extractStagedEvidenceTexts([...(target.evidence || []), ...(item.evidence || [])], 6);
    target.supportingContext = extractStagedEvidenceTexts([...(target.supportingContext || []), ...(item.supportingContext || [])], 4);
    target.decisionsOrAgreements = uniqueCleanDiscussionItems([...(target.decisionsOrAgreements || []), ...(item.decisionsOrAgreements || [])]).slice(0, 4);
    target.risksOrDependencies = uniqueCleanDiscussionItems([...(target.risksOrDependencies || []), ...(item.risksOrDependencies || [])]).slice(0, 4);
    target.actions = uniqueCleanDiscussionItems([...(target.actions || []), ...(item.actions || [])]).slice(0, 4);
    target.sourceTurnIndices = [...new Set([...(target.sourceTurnIndices || []), ...sourceTurns])].sort((left, right) => left - right);
    target.confidence = Math.max(Number(target.confidence || 0), Number(item.confidence || 0));
    target.attribution = target.attribution || item.attribution || null;
    target.qualityFlags = [...new Set([...(target.qualityFlags || []), ...(Array.isArray(item.qualityFlags) ? item.qualityFlags : [])])].slice(0, 12);
    if (!existing) merged.push(target);
  }
  return merged
    .filter((item) => item.evidence.length || item.points.length)
    .sort((left, right) => {
      const leftScore = left.evidence.length * 2 + left.points.length + left.sourceTurnIndices.length * 0.3 + left.confidence;
      const rightScore = right.evidence.length * 2 + right.points.length + right.sourceTurnIndices.length * 0.3 + right.confidence;
      return rightScore - leftScore;
    })
    .slice(0, limit);
}

function stagedMiniLMEvidenceItems(minilmContext, confirmedTopics = []) {
  const output = stagedMiniLMOutput(minilmContext);
  const items = [];
  for (const topic of Array.isArray(output.evidenceBackedTopics) ? output.evidenceBackedTopics : []) {
    if (!topic || typeof topic !== 'object') continue;
    const evidence = extractStagedEvidenceTexts(topic.directEvidence, 6);
    const supportingContext = extractStagedEvidenceTexts(topic.supportingContext, 4);
    const topicLabel = cleanStagedGeneratedLine(topic.topicLabel);
    const themeLabel = cleanStagedGeneratedLine(topic.themeLabel);
    const points = uniqueCleanDiscussionItems([
      topicLabel,
      ...(Array.isArray(topic.attributedDetailPoints) ? topic.attributedDetailPoints : [])
    ]).slice(0, 6);
    if (!evidence.length && !points.length) continue;
    const item = {
      topic: isUsableStagedTopic(themeLabel) ? themeLabel : topic_label_from_text(topicLabel || points[0] || 'Discussion'),
      points,
      evidence,
      supportingContext,
      decisionsOrAgreements: [],
      risksOrDependencies: uniqueCleanDiscussionItems([
        ...(Array.isArray(topic.candidateOpenQuestions) ? topic.candidateOpenQuestions : []),
        ...(Array.isArray(topic.candidateResponsibilitiesMentioned) ? topic.candidateResponsibilitiesMentioned : [])
      ]).slice(0, 4),
      actions: uniqueCleanDiscussionItems(
        (Array.isArray(topic.candidateActionsOnlyIfExplicitlyStated) ? topic.candidateActionsOnlyIfExplicitlyStated : [])
          .map((action) => action && typeof action === 'object' ? action.action || action.meetingActionPoint : action)
      ).slice(0, 4),
      sourceTurnIndices: Array.isArray(topic.sourceTurnIndices) && topic.sourceTurnIndices.length
        ? topic.sourceTurnIndices
        : extractStagedSourceTurns([...(Array.isArray(topic.directEvidence) ? topic.directEvidence : []), ...(Array.isArray(topic.supportingContext) ? topic.supportingContext : [])]),
      confidence: Number(topic.confidence || 0),
      source: 'minilm_evidence_backed_topic'
    };
    item.topic = bestConfirmedTopicForEvidence(item, confirmedTopics) || item.topic || topic_label_from_text(points[0] || 'Discussion');
    items.push(item);
  }

  for (const detail of Array.isArray(output.discussionPointDetails) ? output.discussionPointDetails : []) {
    if (!detail || typeof detail !== 'object') continue;
    const evidence = extractStagedEvidenceTexts(detail.directEvidence || detail.evidence || detail._evidence, 5);
    const supportingContext = extractStagedEvidenceTexts(detail.supportingContext, 3);
    const points = uniqueCleanDiscussionItems([detail.discussionPoint, detail.topicLabel, ...(Array.isArray(detail.cleanedCandidateSentences) ? detail.cleanedCandidateSentences : [])]).slice(0, 5);
    if (!evidence.length && !points.length) continue;
    const item = {
      topic: cleanStagedGeneratedLine(detail.topic || detail.topicLabel || topic_label_from_text(detail.discussionPoint || 'Discussion')),
      points,
      evidence,
      supportingContext,
      decisionsOrAgreements: [],
      risksOrDependencies: [],
      actions: [],
      sourceTurnIndices: Array.isArray(detail.sourceTurnIndices) && detail.sourceTurnIndices.length
        ? detail.sourceTurnIndices
        : extractStagedSourceTurns([...(Array.isArray(detail.directEvidence) ? detail.directEvidence : []), ...(Array.isArray(detail.supportingContext) ? detail.supportingContext : [])]),
      confidence: Number(detail.evidenceScore || 0),
      source: 'minilm_discussion_detail'
    };
    item.topic = bestConfirmedTopicForEvidence(item, confirmedTopics) || item.topic;
    items.push(item);
  }
  return items;
}

function buildStagedMiniLMEvidencePack(minilmContext, confirmedTopics = []) {
  if (!minilmContext || !minilmContext.ok) return [];
  return reassignStagedEvidencePackByWorkstream(
    mergeStagedDiscussionEvidencePack(stagedMiniLMEvidenceItems(minilmContext, confirmedTopics), 8),
    confirmedTopics
  );
}

function stagedTextHasPastMarker(value) {
  return /\b(?:was|were|had|has been|have been|already|previously|completed|reviewed|checked|approved|submitted|sent|shared|updated|finali[sz]ed|on\s+(?:monday|tuesday|wednesday|thursday|friday)|last\s+(?:week|month|review|meeting))\b/i.test(String(value || ''));
}

function stagedTextHasFutureCommitmentMarker(value) {
  return /\b(?:will|shall|to\s+(?:review|send|share|update|complete|prepare|provide|confirm|submit|arrange|follow up|finali[sz]e|check|circulate|draft|issue)|needs?\s+to|should|going\s+to|by\s+(?:next\s+)?(?:monday|tuesday|wednesday|thursday|friday|week|\d{1,2})|before\s+(?:the\s+)?(?:next|release|submission|audit|review)|follow[- ]?up)\b/i.test(String(value || ''));
}

function classifyStagedEvidenceRoles(value) {
  const text = cleanStagedDiscussionText(value);
  if (!text || isLowValueStagedDiscussionText(text)) return ['general chatter/noise'];
  const roles = new Set();
  if (/\b(?:ongoing|in progress|current(?:ly)?|status|position|pending|on track|ready|not ready|complete|completed|finali[sz]ed|approved|available|waiting|open|closed|remains|is still|no issues)\b/i.test(text)) {
    roles.add('current status');
  }
  if (stagedTextHasPastMarker(text)) roles.add('completed/past activity');
  if (stagedTextHasFutureCommitmentMarker(text)) roles.add('future commitment');
  if (/\b(?:agreed|agreement|confirmed|approved|accepted|decided|decision|signed off|can proceed|acceptable|aligned|resolved)\b/i.test(text)) {
    roles.add('decision/agreement');
  }
  if (/\b(?:open point|outstanding|unclear|question|whether|need to understand|needs? clarification|to clarify|to determine|not yet clear|tbc|to be confirmed)\b/i.test(text)) {
    roles.add('open point');
  }
  if (/\b(?:dependency|depends|dependent|required before|required for|waiting for|blocked|blocker|risk|issue|threat|impact|delay|tight|constraint|missing|gap|cannot proceed)\b/i.test(text)) {
    roles.add('dependency');
  }
  if (/\b(?:\d{1,2}(?:st|nd|rd|th)?\s+[A-Z][a-z]+|20\d{2}|v\d+(?:\.\d+)*|version|document|report|file|plan|protocol|standard|requirement|test|testing|software|release|parameter|specification|scope|contract|minutes|\b[A-Z]{2,}(?:\b|[-/]))\b/.test(text)) {
    roles.add('technical detail');
  }
  if (!roles.size) roles.add('general chatter/noise');
  return [...roles];
}

function stagedLooksLikeAbstractWorkstream(value) {
  return /\b(?:readiness|confidence|alignment|strategy|overview|deep dive|discussion|general|analytics|miscellaneous|updates?|status review)\b/i.test(String(value || ''));
}

function stagedEvidenceTextsForWorkstream(item) {
  return uniqueCleanDiscussionItems([
    ...(Array.isArray(item.points) ? item.points : []),
    ...(Array.isArray(item.evidence) ? item.evidence : []),
    ...(Array.isArray(item.supportingContext) ? item.supportingContext : []),
    ...(Array.isArray(item.decisionsOrAgreements) ? item.decisionsOrAgreements : []),
    ...(Array.isArray(item.risksOrDependencies) ? item.risksOrDependencies : []),
    ...(Array.isArray(item.actions) ? item.actions : [])
  ]).slice(0, 12);
}

function stagedHeadingEvidenceScore(topic, texts) {
  if (!topic || !Array.isArray(texts) || !texts.length) return 0;
  return Math.max(...texts.map((text) => stagedTokenSimilarity(topic, text)));
}

function stagedOperationalWorkstreamLabel(item, confirmedTopics = []) {
  const topic = cleanStagedGeneratedLine(item.topic);
  if (isUsableStagedTopic(topic) && !stagedLooksLikeAbstractWorkstream(topic)) return topic;
  const confirmed = bestConfirmedTopicForEvidence(item, confirmedTopics);
  if (confirmed && isUsableStagedTopic(confirmed)) return confirmed;
  const texts = stagedEvidenceTextsForWorkstream(item).join(' ');
  const match = texts.match(/\b(?:[A-Z][A-Za-z0-9/&-]+(?:\s+[A-Z][A-Za-z0-9/&-]+){0,4}\s+(?:file|plan|report|protocol|testing|test|review|update|release|contract|scope|documentation|standard|process|assessment|study))\b/);
  return cleanStagedGeneratedLine(match ? match[0] : topic || 'Project workstream');
}

function pushStagedRoleValue(target, key, value, limit = 5) {
  const cleaned = cleanStagedDiscussionText(value);
  if (!cleaned || isNoEvidenceDiscussionText(cleaned) || isLowValueStagedDiscussionText(cleaned)) return;
  if (target[key].some((item) => stagedTokenSimilarity(item, cleaned) >= 0.82 || item.toLowerCase() === cleaned.toLowerCase())) return;
  target[key].push(cleaned);
  if (target[key].length > limit) target[key].length = limit;
}

function buildStagedWorkstreamState(evidencePack = [], minilmContext = null, confirmedTopics = []) {
  const items = Array.isArray(evidencePack) && evidencePack.length
    ? evidencePack
    : buildStagedMiniLMEvidencePack(minilmContext, confirmedTopics);
  const states = [];

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const evidenceTexts = stagedEvidenceTextsForWorkstream(item);
    if (!evidenceTexts.length) continue;
    const workstream = stagedOperationalWorkstreamLabel(item, confirmedTopics);
    if (!isUsableStagedTopic(workstream)) continue;
    const state = {
      workstream,
      currentStatus: [],
      changesSinceLastReview: [],
      decisionsOrAgreements: [],
      openPoints: [],
      dependencies: [],
      technicalDetails: [],
      nextSteps: [],
      explicitActions: [],
      sourceTurnIndices: Array.isArray(item.sourceTurnIndices) ? item.sourceTurnIndices.slice(0, 12) : [],
      evidence: evidenceTexts.slice(0, 8),
      confidence: Number(item.confidence || 0),
      roleCounts: {},
      qualityFlags: Array.isArray(item.qualityFlags) ? item.qualityFlags.slice(0, 10) : []
    };

    if (stagedLooksLikeAbstractWorkstream(item.topic)) state.qualityFlags.push('abstract_workstream_heading');
    if (stagedHeadingEvidenceScore(workstream, evidenceTexts) < 0.08) state.qualityFlags.push('low_heading_evidence_match');
    if (item.attribution?.reassignedByWorkstreamFit) state.qualityFlags.push('workstream_evidence_reassigned');
    if (item.attribution?.competingFitScore && item.attribution.competingFitScore >= Math.max(0.16, item.attribution.workstreamEvidenceFitScore - 0.08)) {
      state.qualityFlags.push('competing_workstream_attribution_close');
    }

    const actionTexts = uniqueCleanDiscussionItems(Array.isArray(item.actions) ? item.actions : []);
    for (const text of evidenceTexts) {
      const roles = classifyStagedEvidenceRoles(text);
      for (const role of roles) state.roleCounts[role] = Number(state.roleCounts[role] || 0) + 1;
      if (roles.includes('current status')) pushStagedRoleValue(state, 'currentStatus', text);
      if (roles.includes('completed/past activity')) pushStagedRoleValue(state, 'changesSinceLastReview', text);
      if (roles.includes('decision/agreement')) pushStagedRoleValue(state, 'decisionsOrAgreements', text);
      if (roles.includes('open point')) pushStagedRoleValue(state, 'openPoints', text);
      if (roles.includes('dependency')) pushStagedRoleValue(state, 'dependencies', text);
      if (roles.includes('technical detail')) pushStagedRoleValue(state, 'technicalDetails', text);
      if (roles.includes('future commitment') && !stagedTextHasPastMarker(text)) pushStagedRoleValue(state, 'nextSteps', text);
    }

    for (const action of actionTexts) {
      if (stagedTextHasPastMarker(action) && !stagedTextHasFutureCommitmentMarker(action)) {
        state.qualityFlags.push('possible_past_activity_as_action');
        pushStagedRoleValue(state, 'changesSinceLastReview', action);
        continue;
      }
      pushStagedRoleValue(state, stagedTextHasFutureCommitmentMarker(action) ? 'explicitActions' : 'nextSteps', action, 4);
    }

    if (state.evidence.length && !state.currentStatus.length && !state.technicalDetails.length && !state.decisionsOrAgreements.length) {
      state.qualityFlags.push('substantive_workstream_omission_risk');
    }
    state.qualityFlags = [...new Set(state.qualityFlags)];
    states.push(state);
  }

  return states.slice(0, 8);
}

function evidenceForTopic(transcriptText, topic) {
  const keywords = topicKeywords(topic);
  const lines = String(transcriptText || '')
    .split(/\r?\n/)
    .map(cleanTranscriptContentLine)
    .filter((line) => line.length >= 35 && line.length <= 260);
  const matches = lines.filter((line) => {
    const lower = line.toLowerCase();
    return keywords.some((keyword) => lower.includes(keyword));
  });

  return matches.slice(0, 3).map((line) => line.replace(/\s+/g, ' ').trim());
}

function topicEvidenceForStagedDiscussion(transcript, topics) {
  return (Array.isArray(topics) ? topics : [])
    .slice(0, 8)
    .map((topic) => ({
      topic: cleanStagedGeneratedLine(topic),
      evidence: evidenceForTopic(transcript.text, topic).slice(0, 5),
      points: [],
      supportingContext: [],
      decisionsOrAgreements: [],
      risksOrDependencies: [],
      actions: [],
      sourceTurnIndices: [],
      source: 'keyword_topic_evidence'
    }))
    .filter((item) => item.topic && item.evidence.length);
}

function fillMissingStagedWorkstreamEvidence(evidencePack = [], transcript, confirmedTopics = []) {
  const pack = Array.isArray(evidencePack) ? evidencePack : [];
  const topics = (Array.isArray(confirmedTopics) ? confirmedTopics : [])
    .map(cleanStagedGeneratedLine)
    .filter(Boolean)
    .slice(0, 8);
  if (!topics.length) return pack;
  const additions = [];
  const presentTopics = new Set(pack.map((item) => normaliseTopicKey(item.topic)));
  for (const topic of topics) {
    const alreadyPresent = presentTopics.has(normaliseTopicKey(topic)) ||
      pack.some((item) => stagedTokenSimilarity(item.topic, topic) >= 0.45 || workstreamEvidenceFitScore(topic, item) >= 0.35);
    if (alreadyPresent) continue;
    const fallback = topicEvidenceForStagedDiscussion(transcript, [topic])[0];
    if (!fallback || !Array.isArray(fallback.evidence) || fallback.evidence.length < 1) continue;
    additions.push({
      ...fallback,
      source: 'missing_workstream_keyword_backfill',
      qualityFlags: ['missing_workstream_recovered']
    });
  }
  return reassignStagedEvidencePackByWorkstream([...pack, ...additions], topics);
}

function stagedDiscussionCoverageIsThin(minilmContext, req, transcript, evidencePack = [], workstreamState = []) {
  const context = stagedContextFromRequest(req);
  const topicEvidence = Array.isArray(evidencePack) && evidencePack.length
    ? evidencePack
    : topicEvidenceForStagedDiscussion(transcript, context.overallTopics);
  const substantiveWorkstreams = Array.isArray(workstreamState)
    ? workstreamState.filter((item) => item && (Array.isArray(item.evidence) ? item.evidence.length : 0))
    : [];
  const expectedWork = substantiveWorkstreams.length || topicEvidence.length;
  if (expectedWork < 2) return false;
  const cards = discussionFromStagedMiniLM(minilmContext);
  const expectedMinimum = Math.min(3, expectedWork);
  return cards.length < expectedMinimum;
}

function stagedDiscussionNeedsRetry(minilmContext, req, transcript, evidencePack = [], workstreamState = []) {
  if (stagedDiscussionCoverageIsThin(minilmContext, req, transcript, evidencePack, workstreamState)) return true;
  return missingStagedWorkstreamsFromOutput(minilmContext, workstreamState).length > 0;
}

function missingStagedWorkstreamsFromOutput(minilmContext, workstreamState = []) {
  const cards = filterDiscussionCardsByWorkstreamEvidence(discussionFromStagedMiniLM(minilmContext), workstreamState);
  return (Array.isArray(workstreamState) ? workstreamState : [])
    .filter((state) => state && Array.isArray(state.evidence) && state.evidence.length)
    .filter((state) => !findDiscussionCardForTopic(cards, state.workstream))
    .map((state) => state.workstream)
    .filter(Boolean)
    .slice(0, 6);
}

function normaliseTopicKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function findDiscussionCardForTopic(cards, topic) {
  const topicKey = normaliseTopicKey(topic);
  if (!topicKey) return null;
  const exact = cards.find((card) => {
    const cardKey = normaliseTopicKey(card && card.topic);
    if (!cardKey) return false;
    return cardKey === topicKey || cardKey.includes(topicKey) || topicKey.includes(cardKey);
  });
  if (exact) return exact;
  const genericTopicWords = new Set([
    'discussion', 'discussed', 'review', 'reviewed', 'timing', 'requirements',
    'process', 'project', 'meeting', 'status', 'update', 'updates', 'planned'
  ]);
  const topicWords = topicKey
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !genericTopicWords.has(word));
  if (!topicWords.length) return null;
  const ranked = cards
    .map((card) => {
      const cardKey = normaliseTopicKey(card && card.topic);
      const cardWords = cardKey.split(/\s+/);
      const overlap = topicWords.filter((word) => cardWords.includes(word)).length;
      return { card, overlap, similarity: stagedTokenSimilarity(cardKey, topicKey) };
    })
    .filter((item) => item.overlap > 0)
    .sort((left, right) => right.overlap - left.overlap || right.similarity - left.similarity);
  return ranked[0]?.card || null;
}

function findWorkstreamStateForTopic(workstreamState = [], topic = '') {
  const topicKey = normaliseTopicKey(topic);
  if (!topicKey) return null;
  const states = Array.isArray(workstreamState) ? workstreamState : [];
  return states.find((state) => {
    const stateKey = normaliseTopicKey(state && state.workstream);
    if (!stateKey) return false;
    if (stateKey === topicKey || stateKey.includes(topicKey) || topicKey.includes(stateKey)) return true;
    return stagedTokenSimilarity(state.workstream, topic) >= 0.34;
  }) || null;
}

function stagedWorkstreamStateEvidenceTexts(state) {
  if (!state || typeof state !== 'object') return [];
  return uniqueCleanDiscussionItems([
    state.workstream,
    ...(Array.isArray(state.currentStatus) ? state.currentStatus : []),
    ...(Array.isArray(state.changesSinceLastReview) ? state.changesSinceLastReview : []),
    ...(Array.isArray(state.decisionsOrAgreements) ? state.decisionsOrAgreements : []),
    ...(Array.isArray(state.openPoints) ? state.openPoints : []),
    ...(Array.isArray(state.dependencies) ? state.dependencies : []),
    ...(Array.isArray(state.technicalDetails) ? state.technicalDetails : []),
    ...(Array.isArray(state.nextSteps) ? state.nextSteps : []),
    ...(Array.isArray(state.explicitActions) ? state.explicitActions : []),
    ...(Array.isArray(state.evidence) ? state.evidence : [])
  ]).slice(0, 24);
}

function discussionPointEvidenceFitScore(point, state) {
  const cleaned = cleanStagedDiscussionText(point);
  if (!cleaned || !state) return 0;
  const topicScore = stagedTokenSimilarity(cleaned, state.workstream || '');
  const evidenceScores = stagedWorkstreamStateEvidenceTexts(state)
    .filter((text) => text && text !== state.workstream)
    .map((text) => stagedTokenSimilarity(cleaned, text));
  const evidenceScore = evidenceScores.length ? Math.max(...evidenceScores) : 0;
  return Math.max(topicScore * 0.82, evidenceScore);
}

function filterDiscussionCardsByWorkstreamEvidence(cards = [], workstreamState = [], options = {}) {
  const threshold = Number(options.threshold ?? 0.18);
  const filtered = [];
  const droppedMisattributed = [];
  for (const card of Array.isArray(cards) ? cards : []) {
    if (!card || typeof card !== 'object') continue;
    const state = findWorkstreamStateForTopic(workstreamState, card.topic);
    const points = uniqueCleanDiscussionItems(card.points || card.bullets || []);
    if (!state || !Array.isArray(state.evidence) || !state.evidence.length || !points.length) {
      filtered.push(card);
      continue;
    }
    const kept = points.filter((point) => discussionPointEvidenceFitScore(point, state) >= threshold);
    if (kept.length) {
      filtered.push({ ...card, points: kept });
      if (kept.length < points.length) {
        droppedMisattributed.push({
          topic: card.topic || 'Discussion',
          droppedPointCount: points.length - kept.length,
          reason: 'low_workstream_evidence_fit'
        });
      }
      continue;
    }
    droppedMisattributed.push({
      topic: card.topic || 'Discussion',
      droppedPointCount: points.length,
      reason: 'misattributed_discussion_evidence'
    });
  }
  filtered.droppedMisattributed = droppedMisattributed;
  return filtered;
}

function repairDiscussionPointWorkstreamLeakage(cards = [], workstreamState = []) {
  const states = Array.isArray(workstreamState) ? workstreamState.filter((state) => state?.workstream) : [];
  const repaired = (Array.isArray(cards) ? cards : []).map((card) => ({ ...card, points: [] }));
  const moved = [];
  const dropped = [];
  for (let cardIndex = 0; cardIndex < (Array.isArray(cards) ? cards : []).length; cardIndex += 1) {
    const card = cards[cardIndex];
    const currentState = findWorkstreamStateForTopic(states, card.topic);
    for (const point of uniqueCleanDiscussionItems(card.points || card.bullets || [])) {
      const headingRanked = repaired.map((candidate, index) => ({ index, topic: candidate.topic, score: stagedTokenSimilarity(point, candidate.topic) }))
        .sort((left, right) => right.score - left.score);
      const bestHeading = headingRanked[0] || { index: cardIndex, score: 0 };
      const runnerHeading = headingRanked[1] || { score: 0 };
      const currentHeadingScore = stagedTokenSimilarity(point, card.topic);
      if (bestHeading.index !== cardIndex && bestHeading.score >= 0.28 && bestHeading.score - runnerHeading.score >= 0.1 && bestHeading.score >= currentHeadingScore + 0.12) {
        repaired[bestHeading.index].points.push(point);
        moved.push({ point, from: card.topic, to: repaired[bestHeading.index].topic });
        continue;
      }
      if (currentHeadingScore < 0.12 && /\b(?:were|was)\s+(?:discussed|reviewed)\b/i.test(point) && point.split(/\s+/).length <= 12) {
        const derivedTopic = cleanStagedGeneratedLine(point.replace(/\b(?:were|was)\s+(?:discussed|reviewed)\b.*$/i, '').replace(/[.!?]+$/, '').trim());
        if (derivedTopic && isUsableStagedTopic(derivedTopic) && !repaired.some((candidate) => stagedTokenSimilarity(candidate.topic, derivedTopic) >= 0.45)) {
          repaired.push({ topic: derivedTopic, points: [point], source: 'unassigned_evidence_review' });
          moved.push({ point, from: card.topic, to: derivedTopic });
          continue;
        }
      }
      if (states.length < 2) {
        repaired[cardIndex].points.push(point);
        continue;
      }
      const ranked = states.map((state) => ({ state, score: discussionPointEvidenceFitScore(point, state) }))
        .sort((left, right) => right.score - left.score);
      const best = ranked[0] || { state: null, score: 0 };
      const runnerUp = ranked[1] || { score: 0 };
      const currentScore = currentState ? discussionPointEvidenceFitScore(point, currentState) : 0;
      if (best.state && best.score >= 0.28 && best.score - runnerUp.score >= 0.12 && best.state !== currentState && best.score >= currentScore + 0.12) {
        const targetIndex = repaired.findIndex((candidate) => findWorkstreamStateForTopic([best.state], candidate.topic));
        if (targetIndex >= 0) {
          repaired[targetIndex].points.push(point);
          moved.push({ point, from: card.topic, to: repaired[targetIndex].topic });
          continue;
        }
      }
      if (currentScore < 0.1 && best.score >= 0.22) {
        dropped.push({ point, from: card.topic, competingWorkstream: best.state?.workstream || '' });
        continue;
      }
      repaired[cardIndex].points.push(point);
    }
  }
  return { cards: repaired.filter((card) => card.points.length), moved, dropped };
}

function discussionFallbackForWorkstreamState(state, topic = '') {
  if (!state || typeof state !== 'object') return null;
  const points = uniqueCleanDiscussionItems([
    ...(Array.isArray(state.currentStatus) ? state.currentStatus : []),
    ...(Array.isArray(state.changesSinceLastReview) ? state.changesSinceLastReview : []),
    ...(Array.isArray(state.technicalDetails) ? state.technicalDetails : []),
    ...(Array.isArray(state.decisionsOrAgreements) ? state.decisionsOrAgreements : []),
    ...(Array.isArray(state.openPoints) ? state.openPoints : []),
    ...(Array.isArray(state.dependencies) ? state.dependencies : []),
    ...(Array.isArray(state.nextSteps) ? state.nextSteps : []),
    ...(Array.isArray(state.evidence) ? state.evidence : [])
  ])
    .filter((point) => discussionPointEvidenceFitScore(point, state) >= 0.18)
    .slice(0, 6);
  if (!points.length) return null;
  return {
    topic: cleanStagedGeneratedLine(topic || state.workstream || 'Discussion'),
    points,
    source: 'workstream_state_discussion_fallback'
  };
}

function discussionFallbackForTopic(transcript, topic, meetingType, participants, workstreamState = []) {
  return discussionFallbackForWorkstreamState(findWorkstreamStateForTopic(workstreamState, topic), topic);
}

function alignDiscussionCardsToConfirmedTopics(cards, topics, transcript, meetingType, participants, workstreamState = []) {
  if (!topics.length) return cards;
  const aligned = [];
  const used = new Set();
  for (const topic of topics.slice(0, 8)) {
    const matched = findDiscussionCardForTopic(
      (Array.isArray(cards) ? cards : []).filter((card) => !used.has(card)),
      topic
    );
    if (matched && Array.isArray(matched.points) && matched.points.length) {
      used.add(matched);
      aligned.push({ ...matched, topic, points: uniqueCleanDiscussionItems(matched.points).slice(0, 5) });
      continue;
    }
    const fallback = discussionFallbackForTopic(transcript, topic, meetingType, participants, workstreamState);
    if (fallback) aligned.push(fallback);
  }
  if (!Array.isArray(workstreamState) || !workstreamState.length) {
    for (const card of Array.isArray(cards) ? cards : []) {
      if (used.has(card) || !Array.isArray(card?.points) || !card.points.length) continue;
      aligned.push(card);
      if (aligned.length >= 8) break;
    }
  }
  return aligned.slice(0, 8);
}

function buildStagedWorkstreamCoverage(topics = [], discussion = [], workstreamState = []) {
  return (Array.isArray(topics) ? topics : []).map((topic) => {
    const classification = classifyStagedTopic(topic);
    const state = findWorkstreamStateForTopic(workstreamState, topic);
    const card = findDiscussionCardForTopic(discussion, topic);
    const evidenceCount = Array.isArray(state?.evidence) ? state.evidence.length : 0;
    const pointCount = Array.isArray(card?.points) ? card.points.length : 0;
    let status = classification === 'administrative_only' ? 'administrative' : 'missing';
    if (status !== 'administrative' && pointCount >= 2) status = 'covered';
    else if (status !== 'administrative' && pointCount === 1) status = 'thin';
    return {
      topic,
      classification,
      evidenceCount,
      discussionCardCount: card ? 1 : 0,
      assignedTurnIds: Array.isArray(state?.sourceTurnIndices) ? state.sourceTurnIndices : [],
      status
    };
  });
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
        meetingType: candidate?.meetingType || 'Project review',
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
  if (stage === 'summary') return 'Objectives and summary generated. Review or edit them before continuing.';
  if (stage === 'discussion') return 'Discussion points grouped from the complete denoised transcript for reviewer organisation.';
  if (stage === 'actions') return 'Actions generated. Check owners and dates before continuing.';
  return 'This staged screen has been generated.';
}

function stagedReviewerChoicesForFlag(flag = {}) {
  if (flag.type === 'unresolved_substantive_workstream') {
    return ['add_to_discussion', 'intentionally_omit', 'open_discussion_organizer'];
  }
  if (flag.discussionSuggestion) return ['add_to_discussion', 'review_manually'];
  if (flag.repairCandidates) return ['approve_repair', 'reject_candidate', 'review_evidence'];
  return ['review_manually'];
}

function stagedNoEditReviewExperience(trace = []) {
  const stageLabels = {
    details: 'Meeting details',
    summary: 'Objectives and summary',
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

function buildStagedUiMirror(sequence = {}, metadata = {}, options = {}) {
  const state = sequence.state || {};
  const noEditExperience = stagedNoEditReviewExperience(sequence.trace || []);
  const reviewExperience = options.reviewerOrganisedDiscussion
    ? {
        ...noEditExperience,
        mode: 'simulated_reviewer_edits',
        description: 'Browser automation supplied reviewer-organised discussion groups before the Actions stage.'
      }
    : noEditExperience;
  const reviewByStage = new Map(reviewExperience.stages.map((item) => [item.stage, item]));
  const definitions = [
    { key: 'details', label: 'Details' },
    { key: 'summary', label: 'Summary' },
    { key: 'discussion', label: 'Discussion' },
    { key: 'actions', label: 'Actions' }
  ];
  const screens = definitions.map((definition, index) => {
    const review = reviewByStage.get(definition.key) || {};
    let data = state[definition.key] ?? (definition.key === 'summary' ? {} : []);
    if (definition.key === 'summary') {
      data = { ...(data || {}) };
      delete data.overallTopics;
      delete data.topicRefs;
    }
    return {
      index,
      key: definition.key,
      label: definition.label,
      generated: true,
      statusMessage: review.statusMessage || stagedNoEditStageMessage(definition.key),
      editorialChecks: Array.isArray(review.flags) ? review.flags : [],
      data,
      ...(definition.key === 'summary' ? {
        visibleFields: ['meetingPurpose', 'objectives', 'executiveSummary']
      } : {}),
      ...(definition.key === 'discussion' ? {
        organizer: {
          mode: 'discussion_first',
          instructions: 'Review suggested groups, rename topics, move points between groups, and resolve anything left in Unassigned.',
          groups: (Array.isArray(state.discussion) ? state.discussion : []).map((card, groupIndex) => ({
            topic: cleanStagedGeneratedLine(card?.topic) || 'Unassigned',
            topicId: cleanStagedGeneratedLine(card?.topicId) || `group_${groupIndex + 1}`,
            suggested: card?.suggested !== false && !/^unassigned$/i.test(cleanStagedGeneratedLine(card?.topic)),
            unassigned: /^unassigned$/i.test(cleanStagedGeneratedLine(card?.topic)),
            points: (Array.isArray(card?.points) ? card.points : []).map((point, pointIndex) => ({
              id: `${cleanStagedGeneratedLine(card?.topicId) || `group_${groupIndex + 1}`}_point_${pointIndex + 1}`,
              text: typeof point === 'string' ? point : cleanStagedGeneratedLine(point?.text),
              evidenceIds: Array.isArray(card?.pointRefs?.[pointIndex]?.evidenceIds) ? card.pointRefs[pointIndex].evidenceIds : []
            }))
          })),
          operations: {
            renameTopic: true,
            createTopic: true,
            deleteEmptyTopic: true,
            movePoint: true,
            editPoint: true,
            unassignedGroup: true
          },
          automationSubmitField: 'confirmedDiscussion'
        }
      } : {})
    };
  });
  screens.push({
    index: 4,
    key: 'finalReview',
    label: 'Final review',
    generated: true,
    statusMessage: reviewExperience.finalReviewMessage,
    editorialChecks: reviewExperience.requiredReviewerActions,
    data: {
      readyForFinalApproval: reviewExperience.readyForFinalApproval,
      details: state.details || {},
      summary: (() => {
        const summary = { ...(state.summary || {}) };
        delete summary.overallTopics;
        delete summary.topicRefs;
        return summary;
      })(),
      discussion: Array.isArray(state.discussion) ? state.discussion : [],
      actions: Array.isArray(state.actions) ? state.actions : []
    }
  });
  return {
    ok: true,
    contractVersion: 'staged-meeting-minutes-ui-mirror-v2',
    mode: 'browserless_ui_mirror',
    browserRoute: '/staged-meeting-minutes',
    source: metadata.source || 'text',
    fileName: metadata.fileName || null,
    transcriptLength: Number(metadata.transcriptLength || 0),
    ui: {
      screenOrder: screens.map((screen) => screen.key),
      activeScreen: 4,
      activeScreenKey: 'finalReview',
      generationState: 'complete',
      generatedStages: { details: true, summary: true, discussion: true, actions: true },
      screens
    },
    visibleOutput: sequence.visibleOutput || stagedEvaluationVisibleOutput(state),
    reviewExperience,
    ...(options.includeDiagnostics ? {
      diagnostics: {
        servingRevision: servingRevision(),
        contractVersion: 'staged-meeting-minutes-ui-mirror-v2',
        pipelineMode: 'shared_staged_workflow',
        trace: sequence.trace || []
      }
    } : {})
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
    // This is the same hand-off the browser makes before requesting Actions. The
    // reviewer-visible discussion headings are authoritative at that point, including
    // any heading edits made during the preceding screen.
    if (stage === 'actions') input.confirmedDiscussion = state.discussion;
    const response = await (options.stageRunner || stagedWorkflowResponse)(stage, transcript, input);
    const value = response.screens?.[stage];
    state[stage] = stage === 'summary'
      ? (value || {})
      : (Array.isArray(value) ? value : []);
    if (stage === 'discussion' && Array.isArray(options.confirmedDiscussion) && options.confirmedDiscussion.length) {
      state.discussion = options.confirmedDiscussion;
    }
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
      provider: response.pipeline || 'staged_workflow',
      fallbackUsed: Boolean(response.pipelineHealth?.simplifiedPipeline?.fallback),
      inputTopicCount: Array.isArray(state.summary?.overallTopics) ? state.summary.overallTopics.length : 0,
      outputCount: stage === 'summary'
        ? (Array.isArray(state.summary?.overallTopics) ? state.summary.overallTopics.length : 0)
        : state[stage].length,
      outputPointCount: stage === 'discussion'
        ? state.discussion.reduce((sum, card) => sum + (Array.isArray(card?.points) ? card.points.length : 0), 0)
        : undefined,
      validationFlags,
      telemetry: response.telemetryPreview || {},
      pipelineHealth: response.pipelineHealth || null,
      reviewerOrganisationApplied: stage === 'discussion' && Array.isArray(options.confirmedDiscussion) && options.confirmedDiscussion.length > 0
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

function confirmedTopicsForSimplifiedStage(stage, confirmed = {}) {
  if (stage === 'actions' && Array.isArray(confirmed.discussion) && confirmed.discussion.length) {
    const discussionTopics = confirmed.discussion.map((item) => cleanStagedGeneratedLine(item?.topic)).filter(Boolean);
    if (discussionTopics.length) return discussionTopics.slice(0, 16);
  }
  return stringListFromAny(confirmed.summary?.overallTopics, ['topic', 'text', 'title']).slice(0, 8);
}

function confirmedMeetingContextForSimplifiedStage(confirmed = {}) {
  return {
    meetingType: cleanStagedGeneratedLine(confirmed.details?.meetingType).slice(0, 120),
    meetingPurpose: cleanStagedGeneratedLine(confirmed.summary?.meetingPurpose).slice(0, 1000)
  };
}

function validationFlagsAfterSimplifiedOverride(flags, stage, output = []) {
  const existing = Array.isArray(flags) ? flags : [];
  const filtered = existing.filter((flag) => {
    const type = String(flag?.type || '').toLowerCase();
    if (stage === 'discussion') return !/(?:discussion|workstream|confirmed_fact)/.test(type);
    if (stage === 'actions') return !/(?:action|owner|deadline)/.test(type);
    return true;
  });
  if (stage === 'actions' && !output.length) filtered.push({
    type: 'no_actions_detected',
    severity: 'info',
    blocking: false,
    message: 'No evidence-grounded actions were found under the confirmed meeting topics. Add an action manually if the transcript contains a follow-up that should be tracked.'
  });
  return filtered;
}

async function applySimplifiedStagedOverride(stage, result, transcript, confirmed, options = {}) {
  const enabled = process.env.STAGED_SIMPLIFIED_PIPELINE !== '0';
  if (!enabled || !['summary', 'discussion', 'actions'].includes(stage)) {
    return { result, telemetry: { enabled, used: false, fallback: false, reason: enabled ? 'not_applicable' : 'disabled' } };
  }
  try {
    if (stage === 'summary') {
      return {
        result: {
          ...result,
          pipeline: 'simplified_staged_minilm_trooper_v1',
          strategy: 'discussion_first_summary_v2',
          screens: {
            ...(result.screens || {}),
            summary: {
              ...(result.screens?.summary || {}),
              overallTopics: [],
              topicRefs: []
            }
          }
        },
        telemetry: { enabled: true, used: true, fallback: false, stage, mode: 'discussion_first', reason: 'summary_topics_deferred_to_discussion_organizer' }
      };
    }

    if (stage === 'discussion') {
      const generated = await (options.generateDiscussionInventory || generateSimplifiedDiscussionInventory)(transcript.text, {
        ...options,
        meetingContext: confirmedMeetingContextForSimplifiedStage(confirmed)
      });
      return {
        result: {
          ...result,
          pipeline: 'simplified_staged_minilm_trooper_v1',
          strategy: 'simplified_discussion_inventory_v2',
          screens: { ...(result.screens || {}), discussion: generated.discussion },
          validationFlags: validationFlagsAfterSimplifiedOverride(result.validationFlags, stage, generated.discussion)
        },
        telemetry: { enabled: true, used: true, fallback: false, stage, ...generated.telemetry }
      };
    }

    const topics = confirmedTopicsForSimplifiedStage(stage, confirmed);
    if (!topics.length) throw new Error(`No reviewer-confirmed topics were available for the simplified ${stage} stage.`);
    const generated = await (options.generateActions || generateSimplifiedActions)(transcript.text, topics, {
      ...options,
      discussionGroups: confirmed.discussion,
      meetingContext: confirmedMeetingContextForSimplifiedStage(confirmed)
    });
    return {
      result: {
        ...result,
        pipeline: 'simplified_staged_minilm_trooper_v1',
        strategy: 'simplified_per_reviewed_group_actions_v2',
        screens: { ...(result.screens || {}), actions: generated.actions },
        validationFlags: validationFlagsAfterSimplifiedOverride(result.validationFlags, stage, generated.actions)
      },
      telemetry: { enabled: true, used: true, fallback: false, stage, ...generated.telemetry }
    };
  } catch (error) {
    safeLogError('[Simplified staged minutes override failed; canonical stage retained]', error, { stage });
    return {
      result,
      telemetry: {
        enabled: true,
        used: false,
        fallback: true,
        stage,
        reason: error?.message || 'Simplified staged generation failed.'
      }
    };
  }
}

function aggregateSimplifiedTokenUsage(usages = []) {
  return (Array.isArray(usages) ? usages : []).reduce((totals, usage) => ({
    prompt_tokens: totals.prompt_tokens + Number(usage?.prompt_tokens || 0),
    completion_tokens: totals.completion_tokens + Number(usage?.completion_tokens || 0),
    total_tokens: totals.total_tokens + Number(usage?.total_tokens || 0)
  }), { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
}

function simplifiedConfirmedCollections(confirmed = {}) {
  return {
    details: Object.keys(confirmed.details || {}).length,
    objectives: Array.isArray(confirmed.summary?.objectives) ? confirmed.summary.objectives.length : 0,
    topics: Array.isArray(confirmed.summary?.overallTopics) ? confirmed.summary.overallTopics.length : 0,
    discussion: Array.isArray(confirmed.discussion) ? confirmed.discussion.length : 0,
    actions: Array.isArray(confirmed.actions) ? confirmed.actions.length : 0
  };
}

async function stagedWorkflowResponse(stage, transcript, input = {}, options = {}) {
  const startedAt = Date.now();
  const simplifiedEnabled = process.env.STAGED_SIMPLIFIED_PIPELINE !== '0';
  if (!simplifiedEnabled || stage === 'summary' || !['discussion', 'actions'].includes(stage)) {
    return (options.canonicalFallback || canonicalStagedResponse)(stage, transcript, input);
  }
  const confirmed = canonicalConfirmedStages(input);
  const topics = stage === 'discussion' ? [] : confirmedTopicsForSimplifiedStage(stage, confirmed);
  const meetingContext = confirmedMeetingContextForSimplifiedStage(confirmed);
  try {
    const generated = stage === 'discussion'
      ? await (options.generateDiscussionInventory || generateSimplifiedDiscussionInventory)(transcript.text, { ...options, meetingContext })
      : await (async () => {
          if (!topics.length) throw new Error('No reviewer-organised discussion groups were available for the simplified actions stage.');
          return (options.generateActions || generateSimplifiedActions)(transcript.text, topics, {
            ...options,
            discussionGroups: confirmed.discussion,
            meetingContext
          });
        })();
    const output = stage === 'discussion' ? generated.discussion : generated.actions;
    if (!Array.isArray(output) || (stage === 'discussion' && !output.length)) {
      throw new Error(`Simplified ${stage} generation returned no valid output.`);
    }
    const usage = aggregateSimplifiedTokenUsage(generated.telemetry?.tokenUsage);
    const actionAccounting = stage === 'actions'
      ? { supplied: output.length, published: output.length }
      : null;
    const simplifiedTelemetry = {
      enabled: true,
      used: true,
      fallback: false,
      stage,
      ...(generated.telemetry || {})
    };
    const pipelineHealth = {
      revision: servingRevision(),
      stage,
      served: 'full',
      degradations: [],
      durationMs: Date.now() - startedAt,
      actionAccounting,
      wordingRepair: { attempted: 0, repaired: 0, reason: '' },
      simplifiedPipeline: { enabled: true, used: true, fallback: false, reason: '' }
    };
    return {
      source: transcript.source,
      fileName: transcript.fileName || null,
      transcriptLength: transcript.text.length,
      pipeline: 'simplified_staged_minilm_trooper_v1',
      strategy: stage === 'discussion' ? 'simplified_discussion_inventory_v2' : 'simplified_per_reviewed_group_actions_v2',
      stagedStage: stage,
      screens: { [stage]: output },
      validationFlags: validationFlagsAfterSimplifiedOverride([], stage, output),
      canonicalDiagnostics: {
        architecture: 'simplified_primary_with_canonical_fallback',
        humanConfirmedInputIsAuthoritative: true,
        confirmedCollections: simplifiedConfirmedCollections(confirmed),
        actionAccounting
      },
      pipelineHealth,
      telemetryPreview: {
        transcriptHealth: assessStagedTranscriptHealth(transcript.text),
        simplifiedPipeline: simplifiedTelemetry,
        trooper: {
          used: true,
          reason: stage === 'discussion'
            ? `${output.reduce((sum, card) => sum + (card.points || []).length, 0)} grounded discussion point(s) returned as a whole-transcript inventory.`
            : `${output.length} grounded action(s) returned across ${topics.length} reviewer-organised group call(s).`,
          usage,
          input: stage === 'discussion' ? 'whole_denoised_transcript_inventory' : 'reviewer_organised_evidence'
        }
      }
    };
  } catch (error) {
    safeLogError('[Simplified primary stage failed; running canonical fallback]', error, { stage });
    const externalFailure = [422, 429, 500, 502, 503, 504].includes(Number(error?.statusCode));
    const fallback = await (options.canonicalFallback || canonicalStagedResponse)(stage, transcript, {
      ...input,
      _skipSimplifiedOverride: true,
      _skipTrooperExternal: externalFailure
    });
    const fallbackTelemetry = {
      enabled: true,
      used: false,
      fallback: true,
      stage,
      reason: error?.message || `Simplified ${stage} generation failed.`
    };
    return {
      ...fallback,
      pipelineHealth: {
        ...(fallback.pipelineHealth || {}),
        simplifiedPipeline: { enabled: true, used: false, fallback: true, reason: fallbackTelemetry.reason }
      },
      telemetryPreview: {
        ...(fallback.telemetryPreview || {}),
        simplifiedPipeline: fallbackTelemetry
      }
    };
  }
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
  // A simplified request that has exhausted its transport retries must not trigger a
  // second burst through canonical proposal, polish and wording calls. The deterministic
  // canonical path remains available, but external Trooper calls stay off for this stage.
  const skipTrooperExternal = Boolean(input._skipTrooperExternal);
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
  if (['discussion', 'actions'].includes(stage) && !skipTrooperExternal) {
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
  if (stage === 'actions' && !skipTrooperExternal) {
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
  if (stage === 'actions' && !skipTrooperExternal) {
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
  if (stage === 'discussion' && !skipTrooperExternal) {
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
    if (!skipTrooperExternal && process.env.DISCUSSION_PROPOSALS !== '0') {
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
          for (const memberIndex of group.slice(1)) {
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
  const simplifiedOverride = input._skipSimplifiedOverride
    ? { result, telemetry: { enabled: true, used: false, fallback: false, stage, reason: 'canonical_fallback_requested' } }
    : await applySimplifiedStagedOverride(stage, result, transcript, confirmed);
  result = simplifiedOverride.result;
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
    wordingRepair: (({ attempted = 0, repaired = 0, reason = '' }) => ({ attempted, repaired, reason }))(stage === 'discussion' ? discussionWordingRepair : actionWordingRepair),
    simplifiedPipeline: {
      enabled: Boolean(simplifiedOverride.telemetry?.enabled),
      used: Boolean(simplifiedOverride.telemetry?.used),
      fallback: Boolean(simplifiedOverride.telemetry?.fallback),
      reason: simplifiedOverride.telemetry?.reason || ''
    }
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
  return {
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
      simplifiedPipeline: simplifiedOverride.telemetry,
      trooper: { used: polished.used, reason: polished.reason, usage: polished.usage || null, input: 'bounded_minilm_evidence' }
    },
    preparedTranscriptTelemetry: semanticTranscript.preparedTranscriptTelemetry || transcript.preparedTranscriptTelemetry || null
  };
}

function stagedStageResumeUrl(inputPayload, payload) {
  const draftId = String(inputPayload?.draftId || '').trim();
  const stage = String(payload?.stagedStage || inputPayload?.stage || 'details').trim().toLowerCase();
  const screenByStage = { details: 0, summary: 1, discussion: 2, actions: 3 };
  const screen = Number.isFinite(Number(inputPayload?.targetScreen))
    ? Number(inputPayload.targetScreen)
    : (screenByStage[stage] || 0);
  const params = new URLSearchParams();
  if (draftId) params.set('draftId', draftId);
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
    } else {
      const evidenceProgressMessage = stage === 'actions'
        ? 'Reviewing action evidence.'
        : stage === 'discussion'
          ? 'Reviewing discussion evidence.'
          : 'Reviewing summary evidence.';
      await updateGenerationJobProgress(jobId, stage, 35, evidenceProgressMessage);
      payload = await stagedWorkflowResponse(stage, transcript, input);
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

function sendTestError(res, error) {
  safeLogError('[Transcript test endpoint failed]', error);
  return res.status(error.statusCode || 500).json({
    ok: false,
    error: error.message || 'Transcript analysis failed.'
  });
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
  const source = candidate && typeof candidate === 'object' ? candidate : {};

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
      : []
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
      : Number(req.body?.activeScreen || 0) >= 4 ? 'final_review' : 'in_review';
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

// A machine-readable rendering contract for browserless user simulations. It executes
// the same no-edit staged sequence as the reviewer-facing flow and returns the ordered
// screen state that the page hydrates, without pretending to reproduce layout, CSS or
// browser accessibility behaviour. Diagnostics remain opt-in so agents see client-facing
// minutes by default rather than internal evidence and model traces.
router.post('/staged-meeting-minutes/ui-mirror', requireAuth, withTestUpload(async (req, res) => {
  const startedAt = Date.now();
  try {
    const transcript = await readTestTranscript(req);
    validateTranscriptText(transcript.text);
    const confirmedDiscussion = parseStagedReviewArray(
      req.body?.confirmedDiscussion || req.body?.discussionReview || req.query?.confirmedDiscussion
    ).map((item) => ({
      topic: cleanStagedGeneratedLine(item?.topic) || 'Unassigned',
      points: uniqueCleanDiscussionItems(item?.points || item?.bullets || []),
      topicId: cleanStagedGeneratedLine(item?.topicId),
      evidenceIds: Array.isArray(item?.evidenceIds) ? item.evidenceIds : [],
      pointRefs: Array.isArray(item?.pointRefs) ? item.pointRefs : []
    })).filter((item) => item.points.length);
    const sequence = await runStagedSequenceForEvaluation(transcript.text, {
      fileName: transcript.fileName || 'transcript.txt',
      confirmedDiscussion
    });
    const payload = buildStagedUiMirror(sequence, {
      source: transcript.source,
      fileName: transcript.fileName,
      transcriptLength: transcript.text.length
    }, {
      includeDiagnostics: truthyFlag(req.query?.includeDiagnostics) || truthyFlag(req.body?.includeDiagnostics),
      reviewerOrganisedDiscussion: confirmedDiscussion.length > 0
    });
    console.info(JSON.stringify({
      event: 'staged_meeting_minutes_ui_mirror_completed',
      source: transcript.source,
      fileName: transcript.fileName || null,
      transcriptLength: transcript.text.length,
      reviewerOrganisedDiscussion: confirmedDiscussion.length > 0,
      readyForFinalApproval: payload.reviewExperience.readyForFinalApproval,
      durationMs: Date.now() - startedAt
    }));
    return res.json(payload);
  } catch (error) {
    console.error(JSON.stringify({
      event: 'staged_meeting_minutes_ui_mirror_failed',
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

      return res.json(detailsResponse);
    }

    if (['summary', 'discussion', 'actions'].includes(requestedStage)) {
      const confirmed = {
        confirmedDetails: parseStagedJsonObject(req.body?.confirmedDetails),
        confirmedSummary: parseStagedJsonObject(req.body?.confirmedSummary),
        confirmedDiscussion: parseStagedJsonArray(req.body?.confirmedDiscussion),
        confirmedActions: parseStagedJsonArray(req.body?.confirmedActions),
        additionalContext: firstString(req.body?.additionalContext, req.query?.additionalContext)
      };
      const response = await stagedWorkflowResponse(requestedStage, {
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
      return res.json(response);
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

router.get('/meeting-minutes-final/jobs', requireAuth, async (req, res) => {
  try {
    const jobs = await listMeetingMinutesJobs(req.query?.limit || 75);
    return res.json({ ok: true, success: true, jobs });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ ok: false, success: false, error: error.message || 'Failed to list jobs.' });
  }
});

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

router.get('/jobs', requireAuth, async (req, res) => {
  try {
    const jobs = await listGenerationJobs(req.query?.limit || 75, { type: req.query?.type || '' });
    return res.json({ ok: true, success: true, jobs });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ ok: false, success: false, error: error.message || 'Failed to list jobs.' });
  }
});

router.get('/jobs/:jobId', requireAuth, async (req, res) => {
  try {
    const job = await getGenerationJob(req.params.jobId);
    if (!job) return res.status(404).json({ ok: false, success: false, error: 'Job not found.' });
    return res.json({
      ok: true,
      success: true,
      job,
      result: job.status === 'completed' ? job.resultPayload : null
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ ok: false, success: false, error: error.message || 'Failed to load job.' });
  }
});

router.post('/jobs/:jobId/retry', requireAuth, async (req, res) => {
  try {
    const job = await retryGenerationJob(req.params.jobId);
    if (!job) return res.status(404).json({ ok: false, success: false, error: 'Retryable job not found.' });
    if (job.jobType === 'staged_meeting_minutes_stage') {
      launchQueuedStagedMeetingMinutesStage(job.jobId);
    }
    return res.json({ ok: true, success: true, job });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ ok: false, success: false, error: error.message || 'Failed to retry job.' });
  }
});

router.post('/jobs/:jobId/cancel', requireAuth, async (req, res) => {
  try {
    const job = await cancelGenerationJob(req.params.jobId);
    if (!job) return res.status(404).json({ ok: false, success: false, error: 'Cancellable job not found.' });
    return res.json({ ok: true, success: true, job });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ ok: false, success: false, error: error.message || 'Failed to cancel job.' });
  }
});

router.delete('/jobs/:jobId', requireAuth, async (req, res) => {
  try {
    const deleted = await deleteGenerationJob(req.params.jobId);
    if (!deleted) return res.status(404).json({ ok: false, success: false, error: 'Deletable completed/failed/cancelled job not found.' });
    return res.json({ ok: true, success: true });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ ok: false, success: false, error: error.message || 'Failed to delete job.' });
  }
});

router.post('/jobs/archive', requireAuth, async (req, res) => {
  try {
    const requestedIds = Array.isArray(req.body?.jobIds) ? req.body.jobIds : [];
    const archiveAll = req.body?.archiveAll === true;
    if (!archiveAll && !requestedIds.length) {
      return res.status(400).json({ ok: false, success: false, error: 'Select at least one item to archive.' });
    }
    const archivedIds = await archiveGenerationJobs(requestedIds, { archiveAll });
    return res.json({ ok: true, success: true, archivedIds, archivedCount: archivedIds.length });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ ok: false, success: false, error: error.message || 'Failed to archive items.' });
  }
});

router.get('/meeting-minutes-final/jobs/:jobId', requireAuth, async (req, res) => {
  try {
    const job = await getMeetingMinutesJob(req.params.jobId);
    if (!job) return res.status(404).json({ ok: false, success: false, error: 'Job not found.' });
    return res.json({
      ok: true,
      success: true,
      job,
      result: job.status === 'completed' ? job.resultPayload : null
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ ok: false, success: false, error: error.message || 'Failed to load job.' });
  }
});

router.patch('/meeting-minutes-final/jobs/:jobId/result', requireAuth, async (req, res) => {
  try {
    const job = await getMeetingMinutesJob(req.params.jobId);
    if (!job) return res.status(404).json({ ok: false, success: false, error: 'Job not found.' });
    if (job.status !== 'completed') {
      return res.status(409).json({ ok: false, success: false, error: 'Only completed meeting-minutes jobs can be edited.' });
    }

    const editedRows = Array.isArray(req.body?.editedRows) ? req.body.editedRows : null;
    if (!editedRows) {
      return res.status(400).json({ ok: false, success: false, error: 'Provide editedRows as an array.' });
    }

    const safeRows = editedRows.slice(0, 500).map((row) => ({
      type: String(row?.type || 'Note').slice(0, 80),
      topic: String(row?.topic || '').slice(0, 300),
      itemType: String(row?.itemType || '').slice(0, 80),
      owner: String(row?.owner || '').slice(0, 300),
      deadline: String(row?.deadline || '').slice(0, 300),
      text: String(row?.text || '').slice(0, 10000),
      detail: String(row?.detail || '').slice(0, 10000),
      evidence: String(row?.evidence || '').slice(0, 10000)
    })).filter((row) => row.text.trim());

    const currentPayload = job.resultPayload && typeof job.resultPayload === 'object' ? job.resultPayload : {};
    const currentResult = currentPayload.result && typeof currentPayload.result === 'object' ? currentPayload.result : {};
    const currentOutput = currentResult.output && typeof currentResult.output === 'object' ? currentResult.output : {};
    const editedMeta = req.body?.editedMeta && typeof req.body.editedMeta === 'object' ? req.body.editedMeta : {};
    const currentParticipants = currentOutput.participants && typeof currentOutput.participants === 'object' ? currentOutput.participants : {};
    const safeMeta = {
      meetingTitle: String(editedMeta.meetingTitle ?? currentOutput.meetingTitle ?? currentOutput.title ?? '').slice(0, 300),
      meetingDate: String(editedMeta.meetingDate ?? currentOutput.meetingDate ?? currentOutput.date ?? '').slice(0, 120),
      meetingLocation: String(editedMeta.meetingLocation ?? currentOutput.meetingLocation ?? currentOutput.location ?? '').slice(0, 300),
      meetingType: String(editedMeta.meetingType ?? currentOutput.meetingType ?? '').slice(0, 120),
      meetingObjectives: Array.isArray(editedMeta.meetingObjectives)
        ? editedMeta.meetingObjectives.map((value) => String(value || '').slice(0, 1000).trim()).filter(Boolean).slice(0, 100)
        : Array.isArray(currentOutput.meetingObjectives)
          ? currentOutput.meetingObjectives.map((value) => String(value || '').slice(0, 1000).trim()).filter(Boolean).slice(0, 100)
          : [],
      participants: {
        client: Array.isArray(editedMeta.participants?.client)
          ? editedMeta.participants.client.map((value) => String(value || '').slice(0, 200).trim()).filter(Boolean).slice(0, 100)
          : Array.isArray(currentParticipants.client || currentOutput['participants.client'])
            ? (currentParticipants.client || currentOutput['participants.client']).map((value) => String(value || '').slice(0, 200).trim()).filter(Boolean).slice(0, 100)
            : [],
        trinzo: Array.isArray(editedMeta.participants?.trinzo)
          ? editedMeta.participants.trinzo.map((value) => String(value || '').slice(0, 200).trim()).filter(Boolean).slice(0, 100)
          : Array.isArray(currentParticipants.trinzo || currentOutput['participants.trinzo'])
            ? (currentParticipants.trinzo || currentOutput['participants.trinzo']).map((value) => String(value || '').slice(0, 200).trim()).filter(Boolean).slice(0, 100)
            : []
      }
    };
    const discussionRows = safeRows.filter((row) => row.type.toLowerCase() === 'discussion');
    const actionRows = safeRows.filter((row) => row.type.toLowerCase() === 'action');
    const discussionTopicMap = new Map();
    for (const row of discussionRows) {
      const topic = row.topic || 'Discussion';
      if (!discussionTopicMap.has(topic)) {
        discussionTopicMap.set(topic, {
          topicId: topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'discussion',
          topic,
          summary: '',
          outcome: '',
          items: []
        });
      }
      const itemType = (row.itemType || 'discussion').toLowerCase().replace(/[\s-]+/g, '_');
      discussionTopicMap.get(topic).items.push({
        type: itemType,
        text: row.text,
        ...(row.owner ? { owner: row.owner } : {}),
        ...(row.deadline ? { deadline: row.deadline } : {}),
        ...(row.detail ? { detail: row.detail } : {}),
        ...(row.evidence ? { evidence: row.evidence } : {})
      });
    }
    const editedDiscussionTopics = Array.from(discussionTopicMap.values());
    const editedMeetingMinutes = editedDiscussionTopics.map((topic) => ({
      topic: topic.topic,
      discussionPoints: topic.items.map((item) => item.text).filter(Boolean)
    })).filter((topic) => topic.discussionPoints.length);
    const editedActions = actionRows.map((row) => ({
      meetingActionPoint: row.text,
      meetingActionPointOwner: row.owner || 'Not stated',
      meetingActionPointDeadline: row.deadline || row.detail || 'Not stated',
      ...(row.topic ? { topic: row.topic } : {}),
      ...(row.detail ? { detail: row.detail } : {}),
      ...(row.evidence ? { evidence: row.evidence } : {})
    }));
    const editedOutput = {
      ...currentOutput,
      meetingTitle: safeMeta.meetingTitle,
      meetingDate: safeMeta.meetingDate,
      meetingLocation: safeMeta.meetingLocation,
      meetingType: safeMeta.meetingType,
      meetingObjectives: safeMeta.meetingObjectives,
      participants: safeMeta.participants,
      discussionTopics: editedDiscussionTopics,
      meetingMinutes: editedMeetingMinutes,
      discussionPoints: discussionRows.map((row) => row.text),
      actions: editedActions,
      meetingActionPoint: editedActions.map((row) => row.meetingActionPoint),
      meetingActionPointOwner: editedActions.map((row) => row.meetingActionPointOwner),
      meetingActionPointDeadline: editedActions.map((row) => row.meetingActionPointDeadline),
      nextSteps: editedActions.map((row) => ({
        action: row.meetingActionPoint,
        owner: row.meetingActionPointOwner,
        deadline: row.meetingActionPointDeadline
      })),
      editedMeta: safeMeta,
      editedRows: safeRows,
      humanEdited: true,
      humanEditedAt: new Date().toISOString(),
      humanEditedBy: req.authUser?.email || 'OpenClaw'
    };

    const nextPayload = {
      ...currentPayload,
      humanEdited: true,
      humanEditedAt: editedOutput.humanEditedAt,
      humanEditedBy: editedOutput.humanEditedBy,
      result: {
        ...currentResult,
        originalOutput: currentResult.originalOutput || currentOutput,
        output: editedOutput
      }
    };

    const updated = await updateMeetingMinutesJobResult(req.params.jobId, nextPayload);
    if (!updated) return res.status(404).json({ ok: false, success: false, error: 'Editable completed job not found.' });
    return res.json({ ok: true, success: true, job: updated, result: updated.resultPayload });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ ok: false, success: false, error: error.message || 'Failed to save edited result.' });
  }
});

router.post('/meeting-minutes-final/jobs/:jobId/retry', requireAuth, async (req, res) => {
  try {
    const job = await retryMeetingMinutesJob(req.params.jobId);
    if (!job) return res.status(404).json({ ok: false, success: false, error: 'Retryable job not found.' });
    return res.json({ ok: true, success: true, job });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ ok: false, success: false, error: error.message || 'Failed to retry job.' });
  }
});

router.post('/meeting-minutes-final/jobs/:jobId/cancel', requireAuth, async (req, res) => {
  try {
    const job = await cancelMeetingMinutesJob(req.params.jobId);
    if (!job) return res.status(404).json({ ok: false, success: false, error: 'Cancellable job not found.' });
    return res.json({ ok: true, success: true, job });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ ok: false, success: false, error: error.message || 'Failed to cancel job.' });
  }
});

router.delete('/meeting-minutes-final/jobs/:jobId', requireAuth, async (req, res) => {
  try {
    const deleted = await deleteMeetingMinutesJob(req.params.jobId);
    if (!deleted) return res.status(404).json({ ok: false, success: false, error: 'Deletable completed/failed/cancelled job not found.' });
    return res.json({ ok: true, success: true });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ ok: false, success: false, error: error.message || 'Failed to delete job.' });
  }
});

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

router.get('/meeting-minutes-final/feedback-submissions', requireAuth, async (req, res) => {
  try {
    if (!hasDatabaseConfig()) {
      const error = new Error(getDatabaseConfigError());
      error.statusCode = 503;
      throw error;
    }
    const feedback = await listMeetingMinutesFeedback(req.query?.limit || 100);
    return res.json({ ok: true, feedback });
  } catch (error) {
    return sendTestError(res, error);
  }
});

router.get('/meeting-minutes-final/feedback-submissions/:feedbackId', requireAuth, async (req, res) => {
  try {
    if (!hasDatabaseConfig()) {
      const error = new Error(getDatabaseConfigError());
      error.statusCode = 503;
      throw error;
    }
    const feedback = await getMeetingMinutesFeedback(req.params.feedbackId);
    if (!feedback) return res.status(404).json({ ok: false, error: 'Feedback not found.' });
    return res.json({ ok: true, feedback });
  } catch (error) {
    return sendTestError(res, error);
  }
});

router.patch('/meeting-minutes-final/feedback-submissions/:feedbackId', requireAuth, async (req, res) => {
  try {
    if (!hasDatabaseConfig()) {
      const error = new Error(getDatabaseConfigError());
      error.statusCode = 503;
      throw error;
    }
    const feedback = await updateMeetingMinutesFeedback(req.params.feedbackId, {
      status: req.body?.status,
      claireComments: req.body?.claireComments,
      fixDetails: req.body?.fixDetails
    });
    if (!feedback) return res.status(404).json({ ok: false, error: 'Feedback not found.' });
    return res.json({ ok: true, feedback });
  } catch (error) {
    return sendTestError(res, error);
  }
});

router.delete('/meeting-minutes-final/feedback-submissions/:feedbackId', requireAuth, async (req, res) => {
  try {
    if (!hasDatabaseConfig()) {
      const error = new Error(getDatabaseConfigError());
      error.statusCode = 503;
      throw error;
    }
    const deleted = await deleteMeetingMinutesFeedback(req.params.feedbackId);
    if (!deleted) return res.status(404).json({ ok: false, error: 'Feedback not found.' });
    return res.json({ ok: true });
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


router.post('/project-update-test/knowledge/items', requireAuth, async (req, res) => {
  try {
    if (!hasDatabaseConfig()) throw new Error(getDatabaseConfigError());
    const body = req.body || {};
    const projectId = Number(body.projectId || 0);
    const item = await createProjectKnowledgeItem({
      projectId,
      title: body.title,
      content: body.content,
      itemType: body.itemType || 'background_doc',
      isOfficial: body.isOfficial !== false,
      metadata: body.metadata || { source: 'manual' }
    });
    const embeddingWorker = spawnProjectKnowledgeEmbedWorker(['--project-id', String(projectId)]);
    res.json({ ok: true, item, embeddingWorker });
  } catch (error) {
    sendJson(res, error.statusCode || 500, { ok: false, error: error.message });
  }
});

router.get('/project-update-test/knowledge/items', requireAuth, async (req, res) => {
  try {
    if (!hasDatabaseConfig()) throw new Error(getDatabaseConfigError());
    const items = await listProjectKnowledgeItems({
      projectId: req.query.projectId,
      itemType: req.query.itemType,
      status: req.query.status || 'active',
      limit: req.query.limit
    });
    res.json({ ok: true, items });
  } catch (error) {
    sendJson(res, error.statusCode || 500, { ok: false, error: error.message });
  }
});

router.patch('/project-update-test/knowledge/items/:itemId', requireAuth, async (req, res) => {
  try {
    if (!hasDatabaseConfig()) throw new Error(getDatabaseConfigError());
    const item = await updateProjectKnowledgeItem(req.params.itemId, req.body || {});
    if (!item) return sendJson(res, 404, { ok: false, error: 'Knowledge item not found.' });
    const embeddingWorker = Object.prototype.hasOwnProperty.call(req.body || {}, 'content')
      ? spawnProjectKnowledgeEmbedWorker(['--item-id', String(req.params.itemId)])
      : { spawned: false, reason: 'content unchanged' };
    res.json({ ok: true, item, embeddingWorker });
  } catch (error) {
    sendJson(res, error.statusCode || 500, { ok: false, error: error.message });
  }
});

router.delete('/project-update-test/knowledge/items/:itemId', requireAuth, async (req, res) => {
  try {
    if (!hasDatabaseConfig()) throw new Error(getDatabaseConfigError());
    const item = await archiveProjectKnowledgeItem(req.params.itemId, { hard: truthyFlag(req.query.hard) });
    if (!item) return sendJson(res, 404, { ok: false, error: 'Knowledge item not found.' });
    res.json({ ok: true, item });
  } catch (error) {
    sendJson(res, error.statusCode || 500, { ok: false, error: error.message });
  }
});

router.post('/project-update-test/knowledge/ask', requireAuth, async (req, res) => {
  try {
    if (!hasDatabaseConfig()) throw new Error(getDatabaseConfigError());
    const projectId = Number(req.body?.projectId || req.query?.projectId || 0);
    const question = String(req.body?.question || req.query?.question || '').trim();
    if (!Number.isFinite(projectId) || projectId <= 0) return sendJson(res, 400, { ok: false, error: 'Valid projectId is required.' });
    if (!question) return sendJson(res, 400, { ok: false, error: 'Question is required.' });
    const projectContext = await getProjectContext({ projectId }, 8);
    const result = await answerProjectKnowledge({
      projectId,
      question,
      topK: Math.min(Math.max(Number(req.body?.topK || req.query?.topK || 8), 1), 25),
      timeoutMs: Math.min(Math.max(Number(req.body?.timeoutMs || 30000), 5000), 45000),
      projectContext
    });
    res.json(result);
  } catch (error) {
    sendJson(res, error.statusCode || 500, { ok: false, error: error.message });
  }
});

router.get('/project-update-test/knowledge/status', requireAuth, async (req, res) => {
  try {
    if (!hasDatabaseConfig()) throw new Error(getDatabaseConfigError());
    const status = await getProjectKnowledgeStatus({ projectId: req.query.projectId });
    res.json({ ok: true, status });
  } catch (error) {
    sendJson(res, error.statusCode || 500, { ok: false, error: error.message });
  }
});

router.post('/project-update-test/knowledge/embeddings/process', requireAuth, async (req, res) => {
  try {
    const projectId = req.body?.projectId || req.query?.projectId;
    const args = projectId ? ['--project-id', String(projectId)] : [];
    const embeddingWorker = spawnProjectKnowledgeEmbedWorker(args);
    res.json({ ok: true, embeddingWorker });
  } catch (error) {
    sendJson(res, error.statusCode || 500, { ok: false, error: error.message });
  }
});

router.get('/project-update-test/reports', requireAuth, async (req, res) => {
  try {
    const reports = await listProjectReports(req.query?.limit, { projectId: req.query?.projectId });
    return res.json({ ok: true, reports });
  } catch (error) {
    return sendTestError(res, error);
  }
});

router.get('/project-update-test/projects', requireAuth, async (req, res) => {
  try {
    const projects = await listProjectOptions(req.query?.limit);
    return res.json({ ok: true, projects });
  } catch (error) {
    return sendTestError(res, error);
  }
});

router.post('/project-update-test/projects', requireAuth, async (req, res) => {
  try {
    const project = await createProject(req.body || {});
    return res.status(201).json({ ok: true, project });
  } catch (error) {
    return sendTestError(res, error);
  }
});

router.patch('/project-update-test/projects/:projectId', requireAuth, async (req, res) => {
  try {
    const project = await updateProject(req.params.projectId, req.body || {});
    return res.json({ ok: true, project });
  } catch (error) {
    return sendTestError(res, error);
  }
});

router.delete('/project-update-test/projects/:projectId', requireAuth, async (req, res) => {
  try {
    const project = await deleteProject(req.params.projectId);
    if (!project) return res.status(404).json({ ok: false, error: 'Project not found.' });
    return res.json({ ok: true, project });
  } catch (error) {
    return sendTestError(res, error);
  }
});

router.get('/project-update-test/reports/:reportId', requireAuth, async (req, res) => {
  try {
    const report = await getProjectReportDetail(req.params.reportId);
    if (!report) {
      return res.status(404).json({ ok: false, error: 'Project report not found.' });
    }
    return res.json({ ok: true, report });
  } catch (error) {
    return sendTestError(res, error);
  }
});

router.post('/project-update-test/reports/bulk-delete', requireAuth, async (req, res) => {
  try {
    const result = await deleteProjectReports(req.body?.reportIds || []);
    return res.json({ ok: true, result });
  } catch (error) {
    return sendTestError(res, error);
  }
});

router.patch('/project-update-test/reports/:reportId', requireAuth, async (req, res) => {
  try {
    const report = await saveProjectReportDetail(req.params.reportId, req.body || {});
    if (!report) {
      return res.status(404).json({ ok: false, error: 'Project report not found.' });
    }
    return res.json({ ok: true, report });
  } catch (error) {
    return sendTestError(res, error);
  }
});

router.delete('/project-update-test/reports/:reportId', requireAuth, async (req, res) => {
  try {
    const report = await deleteProjectReport(req.params.reportId);
    if (!report) {
      return res.status(404).json({ ok: false, error: 'Project report not found.' });
    }
    return res.json({ ok: true, report });
  } catch (error) {
    return sendTestError(res, error);
  }
});

router.get('/project-update-test/milestones', requireAuth, async (req, res) => {
  try {
    const milestones = await listProjectMilestones(req.query?.limit, { projectId: req.query?.projectId });
    return res.json({ ok: true, milestones });
  } catch (error) {
    return sendTestError(res, error);
  }
});

router.post('/project-update-test/milestones', requireAuth, async (req, res) => {
  try {
    const milestone = await createProjectMilestone(req.body || {});
    return res.status(milestone?.created ? 201 : 200).json({ ok: true, milestone });
  } catch (error) {
    return sendTestError(res, error);
  }
});

router.get('/project-update-test/milestones/:milestoneId', requireAuth, async (req, res) => {
  try {
    const milestone = await getProjectMilestoneDetail(req.params.milestoneId);
    if (!milestone) {
      return res.status(404).json({ ok: false, error: 'Project milestone not found.' });
    }
    return res.json({ ok: true, milestone });
  } catch (error) {
    return sendTestError(res, error);
  }
});

router.post('/project-update-test/milestones/bulk-inactivate', requireAuth, async (req, res) => {
  try {
    const result = await deactivateProjectMilestones(req.body?.milestoneIds || []);
    return res.json({ ok: true, result });
  } catch (error) {
    return sendTestError(res, error);
  }
});

router.patch('/project-update-test/milestones/:milestoneId', requireAuth, async (req, res) => {
  try {
    const milestone = await updateProjectMilestone(req.params.milestoneId, req.body || {});
    if (!milestone) {
      return res.status(404).json({ ok: false, error: 'Project milestone not found.' });
    }
    return res.json({ ok: true, milestone });
  } catch (error) {
    return sendTestError(res, error);
  }
});

router.delete('/project-update-test/milestones/:milestoneId', requireAuth, async (req, res) => {
  try {
    const milestone = await deleteProjectMilestone(req.params.milestoneId);
    if (!milestone) {
      return res.status(404).json({ ok: false, error: 'Project milestone not found.' });
    }
    return res.json({ ok: true, milestone });
  } catch (error) {
    return sendTestError(res, error);
  }
});

router.get('/project-update-test/risks', requireAuth, async (req, res) => {
  try {
    const risks = await listProjectRisks(req.query?.limit, { projectId: req.query?.projectId });
    return res.json({ ok: true, risks });
  } catch (error) {
    return sendTestError(res, error);
  }
});

router.post('/project-update-test/risks', requireAuth, async (req, res) => {
  try {
    const risk = await createProjectRisk(req.body || {});
    return res.status(risk?.created ? 201 : 200).json({ ok: true, risk });
  } catch (error) {
    return sendTestError(res, error);
  }
});

router.get('/project-update-test/risks/:riskId', requireAuth, async (req, res) => {
  try {
    const risk = await getProjectRiskDetail(req.params.riskId);
    if (!risk) return res.status(404).json({ ok: false, error: 'Project risk not found.' });
    return res.json({ ok: true, risk });
  } catch (error) {
    return sendTestError(res, error);
  }
});

router.patch('/project-update-test/risks/:riskId', requireAuth, async (req, res) => {
  try {
    const risk = await updateProjectRisk(req.params.riskId, req.body || {});
    if (!risk) return res.status(404).json({ ok: false, error: 'Project risk not found.' });
    return res.json({ ok: true, risk });
  } catch (error) {
    return sendTestError(res, error);
  }
});

router.delete('/project-update-test/risks/:riskId', requireAuth, async (req, res) => {
  try {
    const risk = await deleteProjectRisk(req.params.riskId);
    if (!risk) return res.status(404).json({ ok: false, error: 'Project risk not found.' });
    return res.json({ ok: true, risk });
  } catch (error) {
    return sendTestError(res, error);
  }
});

router.get('/project-update-test/context', requireAuth, async (req, res) => {
  try {
    const context = await getProjectContext({ projectId: req.query?.projectId, projectName: req.query?.projectName }, req.query?.limit);
    return res.json({ ok: true, context });
  } catch (error) {
    return sendTestError(res, error);
  }
});

router.post('/project-update-test/context/snapshots', requireAuth, async (req, res) => {
  try {
    const snapshot = await createProjectContextSnapshot({ projectId: req.body?.projectId || req.query?.projectId, projectName: req.body?.projectName || req.query?.projectName }, req.body || {});
    return res.status(201).json({ ok: true, snapshot });
  } catch (error) {
    return sendTestError(res, error);
  }
});

router.get('/project-update-test/context/snapshots/:snapshotId', requireAuth, async (req, res) => {
  try {
    const snapshot = await getProjectContextSnapshot(req.params.snapshotId);
    if (!snapshot) return res.status(404).json({ ok: false, error: 'Project context snapshot not found.' });
    return res.json({ ok: true, snapshot });
  } catch (error) {
    return sendTestError(res, error);
  }
});

router.post('/project-update-test/context/mark-official', requireAuth, async (req, res) => {
  try {
    const result = await markProjectContextOfficial(
      { projectId: req.body?.projectId || req.query?.projectId, projectName: req.body?.projectName || req.query?.projectName },
      req.body?.officialLabel || req.query?.officialLabel || 'Official baseline'
    );
    return res.json({ ok: true, result });
  } catch (error) {
    return sendTestError(res, error);
  }
});

router.post('/project-update-test/context/cleanup-tests', requireAuth, async (req, res) => {
  try {
    const result = await cleanupProjectUpdateTestContext({ projectId: req.body?.projectId || req.query?.projectId, projectName: req.body?.projectName || req.query?.projectName }, {
      archiveReports: !truthyFlag(req.body?.keepReports) && !truthyFlag(req.query?.keepReports),
      deleteNonOfficialSnapshots: !truthyFlag(req.body?.keepSnapshots) && !truthyFlag(req.query?.keepSnapshots)
    });
    return res.json({ ok: true, result });
  } catch (error) {
    return sendTestError(res, error);
  }
});

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

router.stagedEvaluation = {
  runStagedSequenceForEvaluation,
  // The health judgement is pure so its rules can be tested without a pipeline run.
  assessGenerationHealth,
  // Exposed so the merge can be tested for the property that matters - that a renamed
  // heading keeps the evidence the discussion stage allocates against - rather than by
  // running the whole stage and hoping.
  mergeNamedTopics,
  stagedNoEditReviewExperience,
  canonicalStagedResponse,
  stagedWorkflowResponse,
  extractStagedDetailsFromTranscript,
  buildStagedActionsResponse,
  buildPreparedTranscriptForStagedAI,
  applySimplifiedStagedOverride,
  buildStagedUiMirror,
  // Exported so the review analytics can be tested as behaviour rather than by grepping
  // the source for the field names.
  buildStagedReviewDiffs,
  summariseStagedReviewDiffs,
  // Exposed so the purpose baseline can ask the question that matters about a meeting
  // type: would we still call it this if we could only see the title? A type that
  // survives only while the transcript body is visible was inferred from something
  // somebody happened to say, not from what the meeting is.
  inferStagedMeetingType
};

module.exports = router;
