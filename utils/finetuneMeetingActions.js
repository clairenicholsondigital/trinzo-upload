const fetch = require('node-fetch');
const { prepareTranscript } = require('./simplifiedStagedMinutes');

const WORKER_URL = (process.env.QWEN_ACTIONS_WORKER_URL || 'http://127.0.0.1:8768').replace(/\/$/, '');
const WORKER_TIMEOUT_MS = Number(process.env.QWEN_ACTIONS_TIMEOUT_MS || 300000);

function normalizeActions(rows) {
  if (!Array.isArray(rows)) throw Object.assign(new Error('The trial model returned no actions array.'), { statusCode: 502 });
  return rows.map((row) => ({
    action: String(row?.action || '').replace(/\s+/g, ' ').trim(),
    owner: String(row?.owner || 'Not stated').replace(/\s+/g, ' ').trim() || 'Not stated'
  })).filter((row) => row.action);
}

async function callQwenWorker(denoisedTranscript) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WORKER_TIMEOUT_MS);
  try {
    const response = await fetch(`${WORKER_URL}/extract-actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ denoisedTranscript }),
      signal: controller.signal
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok === false) {
      const error = new Error(body.error || `The Qwen action worker returned HTTP ${response.status}.`);
      error.statusCode = response.status >= 400 && response.status < 500 ? response.status : 502;
      throw error;
    }
    return { ...body, actions: normalizeActions(body.actions) };
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeout = new Error('The trial model timed out before returning actions.');
      timeout.statusCode = 504;
      throw timeout;
    }
    if (error.code === 'ECONNREFUSED') {
      const unavailable = new Error('The local Qwen action model is not available.');
      unavailable.statusCode = 503;
      throw unavailable;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function generateFinetuneMeetingActions(transcriptText) {
  const startedAt = Date.now();
  const denoiserStartedAt = Date.now();
  const prepared = await prepareTranscript(transcriptText, []);
  const denoiserMs = Date.now() - denoiserStartedAt;
  const modelStartedAt = Date.now();
  const generated = await callQwenWorker(prepared.preparedTranscript);

  return {
    ok: true,
    pipeline: 'minilm_denoiser_v3_then_qwen3_0_6b_lora',
    actions: generated.actions,
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
    model: {
      id: generated.model,
      revision: generated.modelRevision,
      baseModel: generated.baseModel,
      baseRevision: generated.baseRevision,
      inputTokens: generated.inputTokens,
      outputTokens: generated.outputTokens,
      rawOutput: generated.rawModelOutput
    },
    timingMs: {
      denoiser: denoiserMs,
      model: Date.now() - modelStartedAt,
      generation: generated.generationMs,
      total: Date.now() - startedAt
    }
  };
}

module.exports = { generateFinetuneMeetingActions, _private: { normalizeActions, callQwenWorker } };
