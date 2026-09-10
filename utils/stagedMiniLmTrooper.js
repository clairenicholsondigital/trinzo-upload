'use strict';

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MODEL = path.join(ROOT, 'artifacts', 'meeting-minutes-usefulness-v3', 'classifier.joblib');

function runJson(script, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PYTHON_BIN || 'python3', [path.join(ROOT, 'scripts', script), ...args], {
      cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        const error = new Error(`Staged MiniLM/Trooper process timed out after ${timeoutMs}ms.`);
        error.code = 'STAGED_TIMEOUT';
        error.retryable = true;
        error.details = stderr.slice(0, 2000);
        reject(error);
        return;
      }
      if (code !== 0) {
        const error = new Error(`Staged MiniLM/Trooper process failed (${code ?? signal}).`);
        error.details = stderr.slice(0, 2000);
        reject(error);
        return;
      }
      try { resolve(JSON.parse(stdout)); } catch {
        const error = new Error('Staged MiniLM/Trooper process returned invalid JSON.');
        error.details = stdout.slice(0, 1000);
        reject(error);
      }
    });
  });
}

function stagedStageResult(stage, result, telemetry = {}) {
  return {
    stagedStage: stage,
    screens: stage === 'discussion' ? { discussion: result.discussion || [] } : splitActionTiers(result.actions),
    validationFlags: [],
    preparedTranscriptTelemetry: {
      source: telemetry.source || 'prepared_minilm_v3',
      model: telemetry.model || null,
      embeddingModel: telemetry.embeddingModel || null,
      rawLength: telemetry.rawLength ?? null,
      preparedLength: telemetry.preparedLength ?? null,
      removedUnitCount: telemetry.removedUnitCount ?? null,
      keptUnitCount: telemetry.keptUnitCount ?? null,
      totalUnitCount: telemetry.totalUnitCount ?? null,
      removedRatio: telemetry.removedRatio ?? null,
      chunkCount: result.chunkCount || null,
      turnCount: result.turnCount || null,
      actionPrompt: stage === 'actions' ? (result.actionPromptProfile || 'general') : null,
      actionSampleCount: stage === 'actions' ? (result.actionSampleCount || 1) : null,
      discussionPrompt: stage === 'discussion' ? (result.discussionPromptProfile || 'general') : null,
      discussionCallCount: stage === 'discussion' ? (result.discussionCallCount || 1) : null,
      discussionSplitAfterTurn: stage === 'discussion' ? (result.splitAfterTurn || null) : null,
      discussionSplitAfterTurns: stage === 'discussion' ? (result.splitAfterTurns || null) : null,
      discussionCandidateCount: stage === 'discussion' ? (result.discussionCandidateCount ?? null) : null,
      discussionAcceptedCandidateCount: stage === 'discussion' ? (result.discussionAcceptedCandidateCount ?? null) : null
    }
  };
}

// Tier 1 rows were agreed by most independent extraction samples and are shown as actions.
// Tier 2 rows were seen by a minority: real often enough to keep in view, wrong often enough
// not to publish unasked. They go to the collapsed "raised" panel, from which the reviewer
// can add one to the table. Single-sample runs carry no tier and everything is tier 1.
function splitActionTiers(actions) {
  const rows = Array.isArray(actions) ? actions : [];
  return {
    actions: rows.filter((row) => Number(row?.tier ?? 1) !== 2),
    raisedActions: rows.filter((row) => Number(row?.tier ?? 1) === 2)
  };
}

async function denoiseMiniLmFile(rawPath) {
  const prepared = await runJson('staged_simplified_minilm.py', [rawPath, '--model', process.env.STAGED_SIMPLIFIED_MINILM_MODEL || MODEL,
    '--remove-threshold', String(process.env.STAGED_SIMPLIFIED_REMOVE_THRESHOLD || '0.85')],
  Number(process.env.STAGED_SIMPLIFIED_MINILM_TIMEOUT_MS || 180000));
  const removedRatio = Number(prepared.totalUnitCount || 0)
    ? Number(prepared.removedUnitCount || 0) / Number(prepared.totalUnitCount) : 1;
  if (!prepared.ok || prepared.keptUnitCount < 3 || String(prepared.preparedTranscript || '').length < 100 || removedRatio > 0.55) {
    const error = new Error(prepared.reason || 'MiniLM-v3 denoising failed its fail-open safety checks.');
    error.statusCode = 422;
    throw error;
  }
  return { ...prepared, removedRatio };
}

async function prepareMiniLmTranscript(transcriptText) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'staged-minilm-prepare-'));
  const rawPath = path.join(tempDir, 'transcript.txt');
  try {
    await fs.writeFile(rawPath, String(transcriptText || ''), 'utf8');
    return await denoiseMiniLmFile(rawPath);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function generateMiniLmTrooperStage(stage, transcriptText, options = {}) {
  if (!['discussion', 'actions'].includes(stage)) throw new Error(`Unsupported simplified stage: ${stage}`);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'staged-minilm-trooper-'));
  const rawPath = path.join(tempDir, 'transcript.txt');
  const denoisedPath = path.join(tempDir, 'denoised-v3.txt');
  try {
    await fs.writeFile(rawPath, String(transcriptText || ''), 'utf8');
    const prepared = await denoiseMiniLmFile(rawPath);
    const removedRatio = prepared.removedRatio;
    await fs.writeFile(denoisedPath, prepared.preparedTranscript, 'utf8');
    const scriptArgs = [denoisedPath, '--stage', stage];
    if (String(options.meetingType || '').trim()) {
      scriptArgs.push('--meeting-type', String(options.meetingType).trim());
    }
    const result = await runJson('staged_trooper_chunk_pipeline.py', scriptArgs,
      Number(options.timeoutMs || process.env.STAGED_TROOPER_CHUNK_TIMEOUT_MS || 600000));
    return stagedStageResult(stage, result, {
      source: 'minilm_v3_denoiser', model: prepared.model, embeddingModel: prepared.embeddingModel,
      rawLength: prepared.rawLength, preparedLength: prepared.preparedLength,
      removedUnitCount: prepared.removedUnitCount, keptUnitCount: prepared.keptUnitCount,
      totalUnitCount: prepared.totalUnitCount, removedRatio
    });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

// The Meeting Minutes Agent already owns a MiniLM-prepared transcript. Re-running
// the denoiser here wastes time and can alter the stable evidence-unit boundary.
// This entry point gives the private staged candidate branch the prepared units
// directly and applies a real child-process deadline rather than leaving a
// timed-out request consuming CPU in the background.
async function generatePreparedTrooperStage(stage, preparedTranscriptText, options = {}) {
  if (!['discussion', 'actions'].includes(stage)) throw new Error(`Unsupported simplified stage: ${stage}`);
  const preparedText = String(preparedTranscriptText || '').trim();
  if (!preparedText) throw new Error('A prepared transcript is required.');
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'staged-prepared-trooper-'));
  const denoisedPath = path.join(tempDir, 'denoised-v3.txt');
  try {
    await fs.writeFile(denoisedPath, preparedText, 'utf8');
    const scriptArgs = [denoisedPath, '--stage', stage];
    if (String(options.meetingType || '').trim()) {
      scriptArgs.push('--meeting-type', String(options.meetingType).trim());
    }
    const result = await runJson('staged_trooper_chunk_pipeline.py', scriptArgs,
      Number(options.timeoutMs || process.env.STAGED_TROOPER_CHUNK_TIMEOUT_MS || 600000));
    return stagedStageResult(stage, result, {
      source: 'prepared_minilm_v3',
      preparedLength: preparedText.length,
      keptUnitCount: preparedText.split(/\n\s*\n/).filter(Boolean).length
    });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

module.exports = { generateMiniLmTrooperStage, generatePreparedTrooperStage, prepareMiniLmTranscript, splitActionTiers };
