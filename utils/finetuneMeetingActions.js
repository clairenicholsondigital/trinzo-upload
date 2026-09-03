'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { prepareTranscript } = require('./simplifiedStagedMinutes');

const ROOT = path.resolve(__dirname, '..');
const PIPELINE_SCRIPT = path.join(ROOT, 'scripts', 'finetune_trooper_action_pipeline.py');

function normalizeActions(rows) {
  if (!Array.isArray(rows)) throw Object.assign(new Error('The Trooper trial returned no actions array.'), { statusCode: 502 });
  return rows.map((row) => ({
    action: String(row?.action || '').replace(/\s+/g, ' ').trim(),
    owner: String(row?.owner || 'Unclear').replace(/\s+/g, ' ').trim() || 'Unclear',
    deadline: String(row?.deadline || 'Not stated').replace(/\s+/g, ' ').trim() || 'Not stated',
    evidence: String(row?.evidence || '').replace(/\s+/g, ' ').trim(),
    chunkNumber: Number(row?.chunkNumber || 0) || null,
    turnRange: String(row?.turnRange || '').trim()
  })).filter((row) => row.action && row.evidence);
}

function runTrooperPipeline(denoisedTranscript) {
  return fs.mkdtemp(path.join(os.tmpdir(), 'finetune-trooper-')).then(async (tempDir) => {
    const transcriptPath = path.join(tempDir, 'denoised-transcript.txt');
    await fs.writeFile(transcriptPath, denoisedTranscript, { encoding: 'utf8', mode: 0o600 });
    try {
      return await new Promise((resolve, reject) => {
        const child = spawn(process.env.PYTHON_BIN || 'python3', [PIPELINE_SCRIPT, transcriptPath], {
          cwd: ROOT,
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        const maxOutputBytes = 12 * 1024 * 1024;
        const timeoutMs = Number(process.env.FINETUNE_TROOPER_TIMEOUT_MS || 900000);
        const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
        child.stdout.on('data', (chunk) => {
          stdout += chunk.toString('utf8');
          if (Buffer.byteLength(stdout, 'utf8') > maxOutputBytes) child.kill('SIGKILL');
        });
        child.stderr.on('data', (chunk) => {
          stderr += chunk.toString('utf8');
          if (Buffer.byteLength(stderr, 'utf8') > 256 * 1024) stderr = stderr.slice(-256 * 1024);
        });
        child.on('error', (error) => { clearTimeout(timer); reject(error); });
        child.on('close', (code, signal) => {
          clearTimeout(timer);
          if (code !== 0) {
            const error = new Error(`Trooper finetune pipeline failed (${code ?? signal}).`);
            error.details = stderr.slice(-4000);
            error.statusCode = 502;
            reject(error);
            return;
          }
          try {
            resolve(JSON.parse(stdout));
          } catch {
            const error = new Error('Trooper finetune pipeline returned invalid JSON.');
            error.details = stdout.slice(0, 1000);
            error.statusCode = 502;
            reject(error);
          }
        });
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
}

async function generateFinetuneMeetingActions(transcriptText) {
  const startedAt = Date.now();
  const denoiserStartedAt = Date.now();
  const prepared = await prepareTranscript(transcriptText, []);
  const denoiserMs = Date.now() - denoiserStartedAt;
  const trooperStartedAt = Date.now();
  const generated = await runTrooperPipeline(prepared.preparedTranscript);
  const actions = normalizeActions(generated.actions);
  const plannedActivities = normalizeActions(generated.plannedActivities || []);

  return {
    ok: true,
    pipeline: generated.pipeline,
    discussion: String(generated.discussion || '').trim(),
    actions,
    plannedActivities,
    denoisedTranscript: prepared.preparedTranscript,
    denoiser: {
      model: prepared.model,
      embeddingModel: prepared.embeddingModel,
      totalUnitCount: prepared.totalUnitCount,
      keptUnitCount: prepared.keptUnitCount,
      removedUnitCount: prepared.removedUnitCount,
      removedRatio: prepared.removedRatio,
      rawLength: prepared.rawLength,
      preparedLength: prepared.preparedLength
    },
    trooper: {
      model: process.env.TROOPER_MODEL || 'eu_liv_000099',
      diagnostics: generated.diagnostics || {}
    },
    timingMs: {
      denoiser: denoiserMs,
      trooper: Date.now() - trooperStartedAt,
      total: Date.now() - startedAt
    }
  };
}

module.exports = {
  generateFinetuneMeetingActions,
  _private: { normalizeActions, runTrooperPipeline }
};
