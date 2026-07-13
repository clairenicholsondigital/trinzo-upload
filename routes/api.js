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
  listMeetingMinutesJobs,
  getMeetingMinutesJob,
  retryMeetingMinutesJob,
  cancelMeetingMinutesJob,
  deleteMeetingMinutesJob,
  updateMeetingMinutesJobResult,
  getMeetingStatus,
  claimNextJob,
  markJobCompleted,
  markJobFailure,
  queueWebhookJob,
  markWebhookSuccess,
  markWebhookFailure,
  hasDatabaseConfig,
  getDatabaseConfigError
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
// /meeting-minutes-final now uses a single full-transcript Trooper Liv operator pass.
// Large transcripts can still take several seconds, so keep the route timeout generous.
const MEETING_MINUTES_FINAL_TIMEOUT_MS = Number(process.env.MEETING_MINUTES_FINAL_TIMEOUT_MS || 180000);

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
      parseError: error.message,
      rawOutput: rawOutput.slice(0, 4000)
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
        env: process.env,
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
          error.details = { stderr };
          reject(error);
          return;
        }

        if (code !== 0) {
          const error = new Error(`${scriptName} failed with exit code ${code}.`);
          error.statusCode = 502;
          error.details = { stderr: stderr.slice(0, 4000), stdout: stdout.slice(0, 4000) };
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
          error.details = { stderr };
          reject(error);
          return;
        }

        if (code !== 0) {
          const error = new Error(`${scriptName} failed with exit code ${code}.`);
          error.statusCode = 502;
          error.details = { stderr: stderr.slice(0, 4000), stdout: stdout.slice(0, 4000) };
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
  console.error('[Transcript test endpoint failed]', error);
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
      body: parsedBody || rawBody || null
    });

    const error = new Error(`Webhook call failed with status ${response.status}.`);
    error.statusCode = 502;
    error.details = parsedBody || rawBody || null;
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

router.post('/meeting-minutes-test', withTestUpload(async (req, res) => {
  try {
    const transcript = await readTestTranscript(req);
    validateTranscriptText(transcript.text);
    const result = await runPythonTranscriptScript('python_llm_meeting_minutes.py', transcript.text);

    return res.json(buildTestTranscriptResponse(req, transcript, result));
  } catch (error) {
    return sendTestError(res, error);
  }
}));

router.post('/meeting-minutes-numbers', withTestUpload(async (req, res) => {
  try {
    const transcript = await readTestTranscript(req);
    validateTranscriptText(transcript.text);
    const result = await runPythonTranscriptScript('python_meeting_minutes_numbers.py', transcript.text);

    return res.json(buildTestTranscriptResponse(req, transcript, result));
  } catch (error) {
    return sendTestError(res, error);
  }
}));

router.post('/meeting-minutes-comparison', withTestUpload(async (req, res) => {
  try {
    const transcript = await readTestTranscript(req);
    validateTranscriptText(transcript.text);
    const result = await runPythonTranscriptScript('meeting_minutes_minilm_compare_single.py', transcript.text);

    return res.json(buildTestTranscriptResponse(req, transcript, result));
  } catch (error) {
    return sendTestError(res, error);
  }
}));

router.post('/meeting-minutes-minilm-only', withTestUpload(async (req, res) => {
  try {
    const transcript = await readTestTranscript(req);
    validateTranscriptText(transcript.text);
    const scriptArgs = [];

    if (!truthyFlag(req.query?.includeBaselineReference) && !truthyFlag(req.body?.includeBaselineReference)) {
      // Baseline comparison is optional in the lab and should stay off by default on the web path.
    } else {
      scriptArgs.push('--include-baseline-reference');
    }

    if (!truthyFlag(req.query?.includeDiagnostics) && !truthyFlag(req.body?.includeDiagnostics)) {
      scriptArgs.push('--skip-diagnostics');
    }

    const result = await runPythonTranscriptScript('meeting_minutes_minilm_only.py', transcript.text, scriptArgs);

    return res.json(buildTestTranscriptResponse(req, transcript, result));
  } catch (error) {
    return sendTestError(res, error);
  }
}));

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
      meetingActionPointDeadline: row.detail || 'Not stated',
      ...(row.topic ? { topic: row.topic } : {}),
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
  try {
    const transcript = await readTestTranscript(req);
    validateTranscriptText(transcript.text);
    const scriptArgs = [];
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

    const projectTimeoutMs = Number(process.env.PROJECT_UPDATE_TIMEOUT_MS || 180000);
    let result;
    try {
      result = await runPythonTranscriptScript('project_update_minilm.py', transcript.text, scriptArgs, { timeoutMs: projectTimeoutMs });
    } catch (primaryError) {
      console.error('[project-update-test] primary script failed, using legacy fallback', primaryError);
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

    if (result?.projectReport && typeof result.projectReport === 'object') {
      result.projectReport.retrievedKnowledge = result.projectReport.retrievedKnowledge || { retrievalMode: retrievedKnowledge.retrievalMode || 'none', chunkCount: Array.isArray(retrievedKnowledge.chunks) ? retrievedKnowledge.chunks.length : 0 };
      result.projectReport.projectResolution = result.projectReport.projectResolution || {
        requestedProjectId: projectId,
        projectId: resolvedProjectId,
        projectName,
        contextFound
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
      durationMs: Date.now() - startedAt,
      skipMiniLM: truthyFlag(req.query?.skipMiniLM) || truthyFlag(req.body?.skipMiniLM),
      skipRewrite: truthyFlag(req.query?.skipRewrite) || truthyFlag(req.body?.skipRewrite),
      skipSave: truthyFlag(req.query?.skipSave) || truthyFlag(req.body?.skipSave),
      skipContext: truthyFlag(req.query?.skipContext) || truthyFlag(req.body?.skipContext),
      skipKnowledge: truthyFlag(req.query?.skipKnowledge) || truthyFlag(req.body?.skipKnowledge)
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
    const result = await answerProjectKnowledge({
      projectId,
      question,
      topK: Math.min(Math.max(Number(req.body?.topK || req.query?.topK || 8), 1), 25),
      timeoutMs: Math.min(Math.max(Number(req.body?.timeoutMs || 30000), 5000), 45000)
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

router.get('/project-update-test/reports', async (req, res) => {
  try {
    const reports = await listProjectReports(req.query?.limit, { projectId: req.query?.projectId });
    return res.json({ ok: true, reports });
  } catch (error) {
    return sendTestError(res, error);
  }
});

router.get('/project-update-test/projects', async (req, res) => {
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

router.get('/project-update-test/reports/:reportId', async (req, res) => {
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

router.get('/project-update-test/milestones', async (req, res) => {
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

router.get('/project-update-test/milestones/:milestoneId', async (req, res) => {
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

router.get('/project-update-test/context', async (req, res) => {
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

router.get('/project-update-test/context/snapshots/:snapshotId', async (req, res) => {
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
    console.error(error);
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
    console.error(error);
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
      webhookResponse: webhookResult.body || webhookResult.rawBody || null,
      finalMessage: 'Approved content sent to Power Automate webhook successfully.'
    });
  } catch (error) {
    console.error(error);
    return res.status(error.statusCode || 500).json({
      ok: false,
      error: error.message || 'Finalisation webhook call failed.'
    });
  }
});

router.post('/meetings/save', async (req, res) => {
  console.log('[POST /api/meetings/save] Route hit');

  if (!hasDatabaseConfig()) {
    return res.status(500).json({ success: false, error: getDatabaseConfigError() });
  }

  try {
    const result = await saveMeetingMinutes(req.body || {});
    console.log(`[POST /api/meetings/save] Meeting inserted with ID ${result.meetingId}`);

    return res.json({
      success: true,
      meetingId: result.meetingId,
      jobId: result.jobId,
      status: result.status
    });
  } catch (error) {
    console.error('[POST /api/meetings/save] Database save failed:', error.message);
    return res.status(500).json({ success: false, error: error.message || 'Database save failed.' });
  }
});

router.get('/meetings', async (req, res) => {
  if (!hasDatabaseConfig()) {
    return res.status(500).json({ success: false, error: getDatabaseConfigError() });
  }

  try {
    const meetings = await listMeetings();
    return res.json({ success: true, meetings });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Failed to load meetings.' });
  }
});

router.get('/meetings/:id', async (req, res) => {
  if (!hasDatabaseConfig()) {
    return res.status(500).json({ success: false, error: getDatabaseConfigError() });
  }

  try {
    const meeting = await getMeetingById(req.params.id);
    if (!meeting) return res.status(404).json({ success: false, error: 'Meeting not found.' });

    return res.json({ success: true, meeting });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Failed to load meeting.' });
  }
});

router.put('/meetings/:id', async (req, res) => {
  if (!hasDatabaseConfig()) {
    return res.status(500).json({ success: false, error: getDatabaseConfigError() });
  }

  try {
    const existing = await getMeetingById(req.params.id);
    if (!existing) return res.status(404).json({ success: false, error: 'Meeting not found.' });

    const payload = {
      ...req.body,
      payload: {
        ...(req.body?.payload || {}),
        source: 'meeting-update'
      }
    };

    const result = await updateMeetingById(req.params.id, payload);

    return res.json({
      success: true,
      meetingId: result.meetingId,
      message: 'Meeting updated.'
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Failed to update meeting.' });
  }
});

router.get('/meetings/:meetingId/status', async (req, res) => {
  if (!hasDatabaseConfig()) {
    return res.status(500).json({ success: false, error: getDatabaseConfigError() });
  }

  try {
    const data = await getMeetingStatus(req.params.meetingId);
    if (!data) return res.status(404).json({ success: false, error: 'Meeting not found.' });

    return res.json({ success: true, ...data });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Failed to load meeting status.' });
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
          webhookResponse: webhookResult.body || webhookResult.rawBody || null
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

router.post('/meetings/:meetingId/webhook', async (req, res) => {
  if (!hasDatabaseConfig()) {
    return res.status(500).json({ success: false, error: getDatabaseConfigError() });
  }

  try {
    const meeting = await getMeetingById(req.params.meetingId);
    if (!meeting) return res.status(404).json({ success: false, error: 'Meeting not found.' });

    const reviewData = normalizeReviewData(req.body?.reviewData || meeting, req.body?.transcript || '');
    const payload = buildFinalisationPayload(reviewData);
    const queued = await queueWebhookJob(req.params.meetingId, payload);

    return res.json({
      success: true,
      meetingId: Number(req.params.meetingId),
      jobId: queued.jobId,
      webhookStatus: queued.webhookStatus
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to queue webhook job.'
    });
  }
});

router.delete('/meetings/:id', async (req, res) => {
  if (!hasDatabaseConfig()) {
    return res.status(500).json({ success: false, error: getDatabaseConfigError() });
  }

  try {
    const deleted = await deleteMeetingById(req.params.id);

    if (!deleted) {
      return res.status(404).json({ success: false, error: 'Meeting not found.' });
    }

    return res.json({ success: true, message: 'Meeting deleted.' });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Failed to delete meeting.' });
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
    console.error(error);
    return res.status(500).json({ ok: false, error: error.message || 'Chat test failed.' });
  }
});

module.exports = router;
