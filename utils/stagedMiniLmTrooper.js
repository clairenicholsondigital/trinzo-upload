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
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
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

async function generateMiniLmTrooperStage(stage, transcriptText, options = {}) {
  if (!['discussion', 'actions'].includes(stage)) throw new Error(`Unsupported simplified stage: ${stage}`);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'staged-minilm-trooper-'));
  const rawPath = path.join(tempDir, 'transcript.txt');
  const denoisedPath = path.join(tempDir, 'denoised-v3.txt');
  try {
    await fs.writeFile(rawPath, String(transcriptText || ''), 'utf8');
    const prepared = await runJson('staged_simplified_minilm.py', [rawPath, '--model', process.env.STAGED_SIMPLIFIED_MINILM_MODEL || MODEL,
      '--remove-threshold', String(process.env.STAGED_SIMPLIFIED_REMOVE_THRESHOLD || '0.85')],
    Number(process.env.STAGED_SIMPLIFIED_MINILM_TIMEOUT_MS || 180000));
    const removedRatio = Number(prepared.totalUnitCount || 0)
      ? Number(prepared.removedUnitCount || 0) / Number(prepared.totalUnitCount) : 1;
    if (!prepared.ok || prepared.keptUnitCount < 3 || String(prepared.preparedTranscript || '').length < 100 || removedRatio > 0.55) {
      throw new Error(prepared.reason || 'MiniLM-v3 denoising failed its fail-open safety checks.');
    }
    await fs.writeFile(denoisedPath, prepared.preparedTranscript, 'utf8');
    const scriptArgs = [denoisedPath, '--stage', stage];
    if (stage === 'actions' && String(options.meetingType || '').trim()) {
      scriptArgs.push('--meeting-type', String(options.meetingType).trim());
    }
    const result = await runJson('staged_trooper_chunk_pipeline.py', scriptArgs,
      Number(process.env.STAGED_TROOPER_CHUNK_TIMEOUT_MS || 600000));
    return {
      stagedStage: stage,
      screens: stage === 'discussion' ? { discussion: result.discussion || [] } : { actions: result.actions || [] },
      validationFlags: [],
      preparedTranscriptTelemetry: {
        source: 'minilm_v3_denoiser', model: prepared.model, embeddingModel: prepared.embeddingModel,
        rawLength: prepared.rawLength, preparedLength: prepared.preparedLength,
        removedUnitCount: prepared.removedUnitCount, keptUnitCount: prepared.keptUnitCount,
        totalUnitCount: prepared.totalUnitCount, removedRatio,
        chunkCount: result.chunkCount || null, turnCount: result.turnCount || null,
        actionPrompt: stage === 'actions' ? (result.actionPromptProfile || 'general') : null
      }
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

module.exports = { generateMiniLmTrooperStage };
