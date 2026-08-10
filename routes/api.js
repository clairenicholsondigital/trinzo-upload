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
  deleteMeetingMinutesJob,
  updateMeetingMinutesJobResult,
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
    .replace(/\s+/g, ' ')
    .replace(/\s+\.\s*$/g, '')
    .trim();

  title = titleCaseMeetingText(title);
  if (readableDate && options.includeReadableDate !== false && !title.includes(readableDate)) {
    title = `${title} - ${readableDate}`;
  }

  return title.replace(/\s+-\s+-\s+/g, ' - ').trim();
}

function inferStagedMeetingType(text, fileName = '') {
  const combined = `${text || ''}\n${fileName || ''}`;
  if (/\b(webinar|rehearsal|dry run|run-through|run through)\b/i.test(combined)) return 'Webinar rehearsal';
  if (/\bworkshop\b/i.test(combined)) return 'Workshop';
  if (/\bdecision\b/i.test(combined)) return 'Decision meeting';
  if (/\b(client update|status update)\b/i.test(combined)) return 'Client update';
  return 'Project review';
}

function extractLineAfterLabel(text, labels) {
  const labelPattern = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const match = String(text || '').match(new RegExp(`(?:^|\\n)\\s*(?:${labelPattern})\\s*[:\\-]\\s*([^\\n]{1,180})`, 'i'));
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

const TEAMS_PERSON_NAME_PATTERN = "[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+(?:\\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+){1,4}";
const TEAMS_TIMESTAMP_PATTERN = "(?:\\d{1,2}:)?\\d{1,2}:\\d{2}";
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
  const transcript = String(text || '');
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
    const cleaned = String(name || '').replace(/\s+/g, ' ').trim();
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
  const raw = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
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
      const speaker = turnMatch[1].replace(/\s+/g, ' ').trim();
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
  const transcript = String(text || '');
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
  const text = String(transcriptText || '');
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
  const headerDate = teamsHeader.meetingDate || '';
  const headerTitle = teamsHeader.meetingTitle || '';

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
        meetingType: inferStagedMeetingType(text, fileName),
        internalAttendees: explicitInternalAttendees,
        clientAttendees: explicitClientAttendees.length ? explicitClientAttendees : teamsSpeakers,
        allAttendees: uniqueNames([...explicitInternalAttendees, ...explicitClientAttendees, ...teamsSpeakers])
      }
    },
    telemetryPreview: {
      stage: 'details',
      transcriptLength: text.length,
      screenCount: 1,
      attendeeExtraction: {
        source: teamsStructure.speakers.length ? 'microsoft_teams_speaker_turns' : 'explicit_or_fallback',
        speakerCount: teamsSpeakers.length,
        turnCount: teamsStructure.turnCount,
        eventSpeakerCount: teamsStructure.eventSpeakers.length,
        headerSource: teamsHeader.source || '',
        dateSource: headerDate ? 'microsoft_teams_header' : 'explicit_or_filename'
      }
    }
  };
}

const STAGED_TOPIC_RULES = [
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

function pushUniqueTopic(topics, topic, limit = 10) {
  const cleaned = String(topic || '').replace(/\s+/g, ' ').trim();
  if (!isUsableStagedTopic(cleaned)) return;
  if (topics.some((item) => item.toLowerCase() === cleaned.toLowerCase())) return;
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
  return /\b(?:no specific discussion points|no substantive discussion|not discussed in the transcript|no transcript evidence|no evidence)\b/i.test(text);
}

function isLowValueStagedDiscussionText(value) {
  const cleaned = cleanStagedDiscussionText(value);
  const text = cleaned.toLowerCase();
  if (!text) return true;
  if (/^(?:yeah|yes|no|okay|ok|absolutely|presumably|perfect|right)[.!?,\s]*(?:yeah|yes|no|okay|ok|absolutely|presumably|perfect|right)?[.!?,\s]*$/.test(text)) return true;
  if (/\b([A-Z][a-z]+)\s+said\s+that\s+\1\b/.test(cleaned)) return true;
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
  return polished;
}

function polishStagedDiscussionCards(cards) {
  return (Array.isArray(cards) ? cards : [])
    .map(polishStagedDiscussionCard)
    .filter(Boolean)
    .slice(0, 8);
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
  return cleanStagedGeneratedLine(value)
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !/\bthe reviewer should check\b/i.test(sentence))
    .join(' ')
    .trim();
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
    if (!cleaned) continue;
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

function discussionFromStagedMiniLM(minilmContext) {
  const output = stagedMiniLMOutput(minilmContext);
  const discussionTopics = Array.isArray(output.discussionTopics) ? output.discussionTopics : [];
  const discussionCards = Array.isArray(output.discussion) ? output.discussion : [];
  const minutes = Array.isArray(output.meetingMinutes) ? output.meetingMinutes : [];
  const cards = [];

  for (const card of discussionCards) {
    const structured = structuredDiscussionFromItem(card);
    if (structured) cards.push(structured);
    if (cards.length >= 8) return polishStagedDiscussionCards(cards);
  }

  for (const topicItem of discussionTopics) {
    const structured = structuredDiscussionFromItem(topicItem);
    if (structured) cards.push(structured);
    if (cards.length >= 8) break;
  }

  if (cards.length) return polishStagedDiscussionCards(cards);

  for (const minute of minutes) {
    const structured = structuredDiscussionFromItem({
      ...minute,
      topic: minute?.topic || minute?.topicLabel,
      points: minute?.discussionPoints
    });
    if (structured) cards.push(structured);
    if (cards.length >= 8) break;
  }

  if (cards.length) return polishStagedDiscussionCards(cards);

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

  return polishStagedDiscussionCards(cards);
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
  if (!text || isNoEvidenceDiscussionText(text) || isLowValueStagedDiscussionText(text)) return false;
  if (/\b(?:everything|stuff|things|sort out|as much as possible|front[- ]?end everything|prep\b|progress\b|look at|think about|discuss|consider)\b/i.test(text)) return false;
  const hasConcreteVerb = /\b(?:arrange|update|review|send|share|confirm|prepare|complete|finali[sz]e|provide|draft|submit|circulate|issue|upload|book|schedule|agree|approve)\b/i.test(text);
  const hasObject = text.split(/\s+/).length >= 4;
  const hasCommitmentSignal = stagedTextHasFutureCommitmentMarker(text) || /\b(?:action|owner|deadline|by|before|next|follow[- ]?up|catch[- ]?up)\b/i.test(text) || cleanStagedGeneratedLine(deadline);
  const hasUsableOwner = cleanStagedGeneratedLine(owner) && !/^not stated$/i.test(cleanStagedGeneratedLine(owner));
  return hasConcreteVerb && hasObject && (hasCommitmentSignal || hasUsableOwner);
}

function polishStagedActions(actions) {
  const result = [];
  for (const item of Array.isArray(actions) ? actions : []) {
    if (!item || typeof item !== 'object') continue;
    const action = cleanStagedActionText(item.action || item.meetingActionPoint);
    const owner = normaliseStagedActionOwner(item.owner || item.meetingActionPointOwner || 'Not stated');
    const deadline = cleanStagedGeneratedLine(item.deadline || item.meetingActionPointDeadline || '');
    if (!isAuditableStagedAction(action, owner, deadline)) continue;
    if (result.some((existing) => stagedDiscussionPointSimilarity(existing.action, action) >= 0.76)) continue;
    result.push({ owner, action, deadline });
    if (result.length >= 8) break;
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
    if (actions.length >= 8) return polishStagedActions(actions);
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
    if (actions.length >= 8) break;
  }

  return polishStagedActions(actions);
}

function normaliseStagedActionOwner(owner) {
  const cleaned = cleanStagedGeneratedLine(owner || 'Not stated') || 'Not stated';
  if (/^(?:we|us|our team|the team|everyone)$/i.test(cleaned)) return 'All';
  return cleaned;
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
    overallTopics: context.overallTopics,
    reviewerGuidance: context.additionalContext,
    topicEvidence: discussionEvidencePack,
    workstreamState: discussionWorkstreamState
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

function stagedFastContextIsUsable(stage, context) {
  if (!context || !context.ok) return false;
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
    return Boolean(actionsFromStagedMiniLM(context).length);
  }
  return false;
}

async function buildStagedGenerationContext(stage, transcript, req, onProgress = async () => {}) {
  let fastContext = null;
  let evidencePack = [];
  let workstreamState = [];
  if (stage === 'discussion') {
    await onProgress(18, 'Building a semantic evidence pack for the confirmed discussion topics.');
    fastContext = await buildStagedMiniLMContext(transcript);
    const confirmedTopics = stagedContextFromRequest(req).overallTopics;
    evidencePack = fillMissingStagedWorkstreamEvidence(
      buildStagedMiniLMEvidencePack(fastContext, confirmedTopics),
      transcript,
      confirmedTopics
    );
    workstreamState = buildStagedWorkstreamState(evidencePack, fastContext, confirmedTopics);
  }

  await onProgress(25, stage === 'summary'
    ? 'AI is drafting objectives, summary and topics from the confirmed meeting details.'
    : `AI is drafting staged ${stage} content from the confirmed meeting details.`);
  let trooperContext = await buildStagedTrooperContext(stage, transcript, req, { evidencePack, workstreamState });
  if (stage === 'discussion' && trooperContext.ok && stagedDiscussionNeedsRetry(trooperContext, req, transcript, evidencePack, workstreamState)) {
    await onProgress(45, 'AI discussion output was too thin, re-running against the semantic topic evidence.');
    const retryContext = await buildStagedTrooperContext(stage, transcript, req, { strictTopicCoverage: true, evidencePack, workstreamState });
    const originalCount = discussionFromStagedMiniLM(trooperContext).length;
    const retryCount = discussionFromStagedMiniLM(retryContext).length;
    const originalMissing = missingStagedWorkstreamsFromOutput(trooperContext, workstreamState).length;
    const retryMissing = missingStagedWorkstreamsFromOutput(retryContext, workstreamState).length;
    if (retryContext.ok && (!stagedDiscussionNeedsRetry(retryContext, req, transcript, evidencePack, workstreamState) || retryCount > originalCount || retryMissing < originalMissing)) {
      trooperContext = retryContext;
    }
  }
  if (trooperContext.ok) {
    return { context: trooperContext, provider: 'trooper-stage', fallbackUsed: false };
  }

  await onProgress(45, stage === 'summary'
    ? 'AI stage was unavailable, using the faster transcript scan for summary and topics.'
    : `AI stage was unavailable, using the faster transcript scan for ${stage}.`);
  if (!fastContext) fastContext = await buildStagedMiniLMContext(transcript);
  if (stagedFastContextIsUsable(stage, fastContext)) {
    return { context: fastContext, provider: 'fast-staged-analysis', fallbackUsed: true };
  }

  return {
    context: fastContext.ok ? fastContext : trooperContext,
    provider: fastContext.ok ? 'fast-staged-analysis' : 'trooper',
    fallbackUsed: true
  };
}

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
  return {
    meetingTitle: firstString(req.body?.meetingTitle, req.query?.meetingTitle),
    meetingDate: firstString(req.body?.meetingDate, req.query?.meetingDate),
    meetingLocation: firstString(req.body?.meetingLocation, req.query?.meetingLocation),
    meetingType: firstString(req.body?.meetingType, req.query?.meetingType, 'Project review'),
    participants: linesFrom(req.body?.participants || req.query?.participants),
    overallTopics: linesFrom(req.body?.overallTopics || req.query?.overallTopics || req.body?.topics || req.query?.topics),
    additionalContext: firstString(req.body?.additionalContext, req.query?.additionalContext).slice(0, 3000)
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

function buildStagedSummaryResponse(req, transcript, minilmContext = null) {
  const details = stagedDetailsWithConfirmedContext(req, transcript);
  const output = stagedMiniLMOutput(minilmContext);
  const topics = topicsFromStagedMiniLM(minilmContext).length
    ? topicsFromStagedMiniLM(minilmContext)
    : extractOverallTopicsFromTranscript(transcript.text);
  const objectives = [
    'Confirm the current project position and what has changed since the last review.',
    'Capture agreed decisions, follow-ups, owners and unresolved dependencies.',
    'Identify risks or blockers that could affect the timeline or release readiness.'
  ];
  const summary = cleanStagedExecutiveSummary(output.executiveSummary || output.meetingDescription || output.summary) ||
    (topics.length
      ? `The project status needs to be read through ${topics.map((topic) => topic.toLowerCase()).join(', ')}. The next review stage should draw out the agreed changes, unresolved dependencies, timeline pressure and release-readiness implications from the transcript evidence.`
      : 'The project status, agreed changes, unresolved risks and timeline impact should be confirmed from the transcript before moving to detailed discussion points.');

  return {
    ok: true,
    source: transcript.source,
    fileName: transcript.fileName || null,
    transcriptLength: transcript.text.length,
    staged: true,
    stagedStage: 'summary',
    screens: {
      summary: {
        objectives,
        executiveSummary: summary,
        overallTopics: topics
      }
    },
    telemetryPreview: {
      stage: 'summary',
      topicCount: topics.length,
      transcriptLength: transcript.text.length,
      embeddingClassifier: stagedMiniLMTelemetry(minilmContext)
    }
  };
}

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
  let best = { topic: '', score: 0 };
  for (const topic of topics) {
    const score = Math.max(
      stagedTokenSimilarity(topic, item.topic),
      stagedTokenSimilarity(topic, searchable)
    );
    if (score > best.score) best = { topic, score };
  }
  return best.score >= 0.12 ? best.topic : '';
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
  return Math.max(topicFit * 0.7, evidenceFit, exactFit * 0.85);
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
    const shouldMove = best.topic && best.score >= 0.18 && best.score >= currentScore + 0.08;
    const next = {
      ...item,
      topic: shouldMove ? best.topic : item.topic,
      originalTopic: shouldMove ? item.topic : item.originalTopic,
      attribution: {
        workstreamEvidenceFitScore: Number((shouldMove ? best.score : Math.max(best.score, currentScore)).toFixed(3)),
        competingWorkstream: runnerUp.topic || '',
        competingFitScore: Number((runnerUp.score || 0).toFixed(3)),
        reassignedByWorkstreamFit: Boolean(shouldMove)
      }
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
  const cards = discussionFromStagedMiniLM(minilmContext);
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
  const topicWords = topicKey.split(/\s+/).filter((word) => word.length >= 4);
  return cards.find((card) => {
    const cardKey = normaliseTopicKey(card && card.topic);
    if (!cardKey) return false;
    if (cardKey === topicKey || cardKey.includes(topicKey) || topicKey.includes(cardKey)) return true;
    return topicWords.length && topicWords.some((word) => cardKey.includes(word));
  }) || null;
}

function discussionFallbackForTopic(transcript, topic, meetingType, participants) {
  return null;
}

function alignDiscussionCardsToConfirmedTopics(cards, topics, transcript, meetingType, participants) {
  if (!topics.length) return cards;
  return topics.slice(0, 8).map((topic) => {
    const matched = findDiscussionCardForTopic(cards, topic);
    if (matched && Array.isArray(matched.points) && matched.points.length) {
      return { ...matched, topic, points: uniqueCleanDiscussionItems(matched.points).slice(0, 5) };
    }
    return discussionFallbackForTopic(transcript, topic, meetingType, participants);
  }).filter(Boolean);
}

function buildStagedDiscussionResponse(req, transcript, minilmContext = null) {
  const context = stagedContextFromRequest(req);
  const miniLmDiscussion = discussionFromStagedMiniLM(minilmContext);
  const topics = context.overallTopics.length
    ? context.overallTopics
    : (topicsFromStagedMiniLM(minilmContext).length ? topicsFromStagedMiniLM(minilmContext) : extractOverallTopicsFromTranscript(transcript.text));
  const details = stagedDetailsWithConfirmedContext(req, transcript);
  const participants = context.participants.length ? context.participants : details.allAttendees;
  const meetingType = context.meetingType || details.meetingType || 'Project review';
  const discussion = miniLmDiscussion.length
    ? alignDiscussionCardsToConfirmedTopics(miniLmDiscussion, context.overallTopics, transcript, meetingType, participants)
    : [];
  const output = stagedMiniLMOutput(minilmContext);
  const executiveSummaryFromFindings = cleanStagedExecutiveSummary(
    output.executiveSummaryFromFindings || output.summaryFromFindings || output.executiveSummary || ''
  );
  const screens = {
    discussion: discussion.length ? discussion : []
  };
  if (executiveSummaryFromFindings) {
    screens.summary = {
      executiveSummary: executiveSummaryFromFindings,
      overallTopics: topics
    };
  }

  return {
    ok: true,
    source: transcript.source,
    fileName: transcript.fileName || null,
    transcriptLength: transcript.text.length,
    staged: true,
    stagedStage: 'discussion',
    screens,
    contextUsed: {
      meetingType,
      participantCount: participants.length,
      overallTopics: topics
    },
    telemetryPreview: {
      stage: 'discussion',
      topicCount: topics.length,
      discussionCards: discussion.length,
      transcriptLength: transcript.text.length,
      embeddingClassifier: stagedMiniLMTelemetry(minilmContext)
    }
  };
}

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
    if (candidates.length >= 8) break;
  }

  return candidates;
}

function buildStagedActionsResponse(req, transcript, minilmContext = null) {
  const stagedActions = actionsFromStagedMiniLM(minilmContext);
  const actions = polishStagedActions(stagedActions.length
    ? stagedActions
    : extractActionCandidatesFromTranscript(transcript.text));

  return {
    ok: true,
    source: transcript.source,
    fileName: transcript.fileName || null,
    transcriptLength: transcript.text.length,
    staged: true,
    stagedStage: 'actions',
    screens: {
      actions: actions.length ? actions : [{
        owner: 'Not stated',
        action: 'Review transcript for agreed actions.',
        deadline: ''
      }]
    },
    telemetryPreview: {
      stage: 'actions',
      actionCount: actions.length,
      transcriptLength: transcript.text.length,
      embeddingClassifier: stagedMiniLMTelemetry(minilmContext)
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
  const discussion = reviewData.meetingMinutes.map((item) => ({
    topic: item.topic || 'Discussion',
    points: item.discussionPoints.length ? item.discussionPoints : ['Review this section against the transcript.']
  }));
  const actions = reviewData.nextSteps.map((item) => ({
    owner: item.owner || 'Not stated',
    action: item.action || 'Review action wording',
    deadline: item.deadline || 'Not stated'
  }));
  const internalAttendees = reviewData.participants.trinzo;
  const clientAttendees = reviewData.participants.client;

  return {
    ...base,
    staged: true,
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
      discussion: discussion.length ? discussion : [{
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
      participants: input.participants || '',
      overallTopics: input.overallTopics || '',
      additionalContext: input.additionalContext || ''
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
      const aiTranscript = transcriptForStagedAI(transcript, input);
      const generation = await buildStagedGenerationContext(stage, aiTranscript, stagedReq, (percent, message) => (
        updateGenerationJobProgress(jobId, stage, percent, message)
      ));
      const context = generation.context;
      if (stage === 'summary') payload = buildStagedSummaryResponse(stagedReq, aiTranscript, context);
      else if (stage === 'discussion') payload = buildStagedDiscussionResponse(stagedReq, aiTranscript, context);
      else if (stage === 'actions') payload = buildStagedActionsResponse(stagedReq, aiTranscript, context);
      else {
        const error = new Error(`Unsupported staged meeting-minutes stage: ${stage}`);
        error.statusCode = 400;
        throw error;
      }
      payload.preparedTranscriptTelemetry = aiTranscript.preparedTranscriptTelemetry || null;
    }

    await updateGenerationJobProgress(jobId, stage, 90, `Staged ${stage} content generated. Preparing resume link.`);
    const resultPayload = {
      ok: true,
      staged: true,
      source: transcript.source,
      fileName: transcript.fileName || null,
      transcriptLength: transcript.text.length,
      meetingId: job.meetingId,
      jobId,
      result: {
        ...payload,
        jobId,
        meetingId: job.meetingId,
        queuedDiagnostics: {
          jobId,
          meetingId: job.meetingId,
          workerMode: 'staged_meeting_minutes_stage',
          rawTranscriptLength: transcript.text.length,
          preparedTranscriptLength: payload.preparedTranscriptTelemetry?.preparedLength || transcript.text.length,
          durationMs: Date.now() - startedAt
        }
      }
    };
    resultPayload.resumeUrl = stagedStageResumeUrl({ ...input, jobId }, payload);
    resultPayload.result.resumeUrl = resultPayload.resumeUrl;
    await markGenerationJobCompleted(jobId, job.meetingId, resultPayload, `Staged ${stage} content is ready to review.`);
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
    return getGenerationJob(sourceJobId, { includeTranscript: true });
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
  return jobId ? getGenerationJob(jobId, { includeTranscript: true }) : null;
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

    if (requestedStage === 'summary') {
      const trooperContext = await buildStagedTrooperContext('summary', aiTranscript, req);
      const fallbackContext = trooperContext.ok ? null : await buildStagedMiniLMContext(aiTranscript);
      const summaryResponse = buildStagedSummaryResponse(req, aiTranscript, trooperContext.ok ? trooperContext : fallbackContext);
      summaryResponse.preparedTranscriptTelemetry = aiTranscript.preparedTranscriptTelemetry;

      console.info(JSON.stringify({
        event: 'staged_meeting_minutes_summary_completed',
        source: transcript.source,
        fileName: transcript.fileName || null,
        transcriptLength: transcript.text.length,
        topicCount: summaryResponse.telemetryPreview.topicCount,
        trooperUsed: trooperContext.rewriterAvailable,
        fallbackUsed: !trooperContext.ok,
        embeddingClassifierUsed: summaryResponse.telemetryPreview.embeddingClassifier.used && !trooperContext.ok,
        durationMs: Date.now() - startedAt
      }));

      return res.json(summaryResponse);
    }

    if (requestedStage === 'discussion') {
      const generation = await buildStagedGenerationContext('discussion', aiTranscript, req);
      const discussionResponse = buildStagedDiscussionResponse(req, aiTranscript, generation.context);
      discussionResponse.preparedTranscriptTelemetry = aiTranscript.preparedTranscriptTelemetry;

      console.info(JSON.stringify({
        event: 'staged_meeting_minutes_discussion_completed',
        source: transcript.source,
        fileName: transcript.fileName || null,
        transcriptLength: transcript.text.length,
        topicCount: discussionResponse.telemetryPreview.topicCount,
        discussionCards: discussionResponse.telemetryPreview.discussionCards,
        trooperUsed: generation.provider === 'trooper-stage',
        fallbackUsed: generation.fallbackUsed,
        embeddingClassifierUsed: discussionResponse.telemetryPreview.embeddingClassifier.used && generation.fallbackUsed,
        durationMs: Date.now() - startedAt
      }));

      return res.json(discussionResponse);
    }

    if (requestedStage === 'actions') {
      const trooperContext = await buildStagedTrooperContext('actions', aiTranscript, req);
      const fallbackContext = trooperContext.ok ? null : await buildStagedMiniLMContext(aiTranscript);
      const actionsResponse = buildStagedActionsResponse(req, aiTranscript, trooperContext.ok ? trooperContext : fallbackContext);
      actionsResponse.preparedTranscriptTelemetry = aiTranscript.preparedTranscriptTelemetry;

      console.info(JSON.stringify({
        event: 'staged_meeting_minutes_actions_completed',
        source: transcript.source,
        fileName: transcript.fileName || null,
        transcriptLength: transcript.text.length,
        actionCount: actionsResponse.telemetryPreview.actionCount,
        trooperUsed: trooperContext.rewriterAvailable,
        fallbackUsed: !trooperContext.ok,
        embeddingClassifierUsed: actionsResponse.telemetryPreview.embeddingClassifier.used && !trooperContext.ok,
        durationMs: Date.now() - startedAt
      }));

      return res.json(actionsResponse);
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
      meetingTitle: req.body?.meetingTitle || transcript.fileName || '',
      meetingDate: req.body?.meetingDate || '',
      meetingLocation: req.body?.meetingLocation || '',
      meetingType: req.body?.meetingType || '',
      participants: req.body?.participants || '',
      overallTopics: req.body?.overallTopics || '',
      additionalContext: req.body?.additionalContext || '',
      draftId: req.body?.draftId || '',
      targetScreen: req.body?.targetScreen || 0,
      regenerate: truthyFlag(req.body?.regenerate),
      queuedBy: req.authUser?.email || ''
    });
    launchQueuedStagedMeetingMinutesStage(queued.jobId);

    return res.status(202).json({
      ok: true,
      success: true,
      ...queued,
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

module.exports = router;
