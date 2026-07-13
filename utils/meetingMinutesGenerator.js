const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const {
  updateMeetingMinutesJobProgress,
  markMeetingMinutesJobCompleted,
  markMeetingMinutesJobFailure
} = require('./db');

const MAX_TRANSCRIPT_CHARS = 2 * 1024 * 1024;
const PYTHON_TIMEOUT_MS = Number(process.env.TRANSCRIPT_TEST_TIMEOUT_MS || 180000);

function truthy(value) {
  return String(value || '').trim().toLowerCase() === '1'
    || String(value || '').trim().toLowerCase() === 'true'
    || String(value || '').trim().toLowerCase() === 'yes'
    || String(value || '').trim().toLowerCase() === 'on';
}

function validateTranscriptText(text) {
  if (!text || !String(text).trim()) {
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
      rawOutput: String(rawOutput || '').slice(0, 4000)
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

function transcriptMetadata(text) {
  return {
    transcriptLength: text.length,
    transcriptSha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
  };
}

function buildQueuedTranscriptResponse(job, result) {
  const transcriptText = String(job.transcriptText || '');
  const input = job.inputPayload || {};
  const response = {
    ok: true,
    source: input.source || 'meeting-minutes-final-queue',
    fileName: input.fileName || null,
    transcriptLength: transcriptText.length,
    meetingId: job.meetingId,
    jobId: job.jobId,
    result
  };

  if (input.includeTranscriptMetadata) {
    response.transcriptMetadata = transcriptMetadata(transcriptText);
  }

  return response;
}

async function processMeetingMinutesJob(job, options = {}) {
  const timeoutMs = Number(options.timeoutMs || process.env.MEETING_MINUTES_FINAL_TIMEOUT_MS || 180000);
  const startedAt = Date.now();
  const input = job.inputPayload || {};
  const scriptArgs = [];

  if (input.skipRewrite) scriptArgs.push('--skip-rewrite');
  if (!input.includeDiagnostics) scriptArgs.push('--skip-diagnostics');
  if (input.includeProjectStatusEvidence || truthy(process.env.MEETING_MINUTES_PROJECT_STATUS_EVIDENCE)) {
    scriptArgs.push('--include-project-status-evidence');
  }

  try {
    if (job.cancelRequested) {
      throw new Error('Job was cancelled before processing started.');
    }

    await updateMeetingMinutesJobProgress(job.jobId, 'extracting', 12, 'Transcript loaded. Preparing AI generation.');
    validateTranscriptText(job.transcriptText || '');

    await updateMeetingMinutesJobProgress(job.jobId, 'analysing', 25, 'Building project-status evidence for extra detail.');
    await updateMeetingMinutesJobProgress(job.jobId, 'drafting', 35, 'Writing detailed meeting minutes with Trooper.');
    const result = await runPythonTranscriptScript('meeting_minutes_trooper.py', job.transcriptText, scriptArgs, { timeoutMs });

    await updateMeetingMinutesJobProgress(job.jobId, 'finalising', 90, 'Formatting editable minutes output.');
    const response = buildQueuedTranscriptResponse(job, result);
    response.result = {
      ...(response.result || {}),
      queuedDiagnostics: {
        jobId: job.jobId,
        meetingId: job.meetingId,
        workerMode: 'meeting_minutes_generate',
        projectStatusEvidenceEnabled: scriptArgs.includes('--include-project-status-evidence'),
        durationMs: Date.now() - startedAt
      }
    };

    await markMeetingMinutesJobCompleted(job.jobId, job.meetingId, response);
    return { ok: true, response };
  } catch (error) {
    await markMeetingMinutesJobFailure(job, error.message || 'Meeting minutes generation failed.');
    return { ok: false, error };
  }
}

module.exports = {
  processMeetingMinutesJob,
  runPythonTranscriptScript,
  buildQueuedTranscriptResponse,
  transcriptMetadata,
  validateTranscriptText
};
