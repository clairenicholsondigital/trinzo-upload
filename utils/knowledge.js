const path = require('path');
const { spawn } = require('child_process');

function pythonBin() {
  return process.env.PYTHON_BIN || 'python3';
}

function repoRoot() {
  return path.join(__dirname, '..');
}

function spawnProjectKnowledgeEmbedWorker(extraArgs = []) {
  if (String(process.env.PROJECT_KNOWLEDGE_EMBED_AUTO || '1') === '0') {
    return { spawned: false, reason: 'disabled' };
  }
  const scriptPath = path.join(repoRoot(), 'scripts', 'project_knowledge_embed_worker.py');
  const child = spawn(pythonBin(), [scriptPath, ...extraArgs], {
    cwd: repoRoot(),
    env: process.env,
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true
  });
  child.unref();
  return { spawned: true, pid: child.pid || null };
}

function runProjectKnowledgeRetrieval({ projectId, query, topK = 8, itemTypes = [], timeoutMs = 15000 }) {
  return new Promise((resolve) => {
    const id = Number(projectId || 0);
    if (!Number.isFinite(id) || id <= 0 || !String(query || '').trim()) {
      resolve({ ok: true, retrieval_mode: 'none', chunks: [], diagnostics: { reason: 'missing project id or query' } });
      return;
    }
    const scriptPath = path.join(repoRoot(), 'scripts', 'project_knowledge_retrieval.py');
    const args = [scriptPath, '--project-id', String(id), '--query', String(query || ''), '--top-k', String(topK || 8)];
    if (Array.isArray(itemTypes) && itemTypes.length) args.push('--item-types', itemTypes.join(','));
    const child = spawn(pythonBin(), args, { cwd: repoRoot(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, retrieval_mode: 'error', chunks: [], error: 'Project knowledge retrieval timed out.' });
    }, Number(timeoutMs || 15000));
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => finish({ ok: false, retrieval_mode: 'error', chunks: [], error: error.message }));
    child.on('close', () => {
      if (settled) return;
      try {
        const parsed = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop() || '{}');
        finish(parsed && typeof parsed === 'object' ? parsed : { ok: false, retrieval_mode: 'error', chunks: [], error: 'Invalid retrieval response.' });
      } catch (error) {
        finish({ ok: false, retrieval_mode: 'error', chunks: [], error: stderr.trim() || error.message });
      }
    });
  });
}

function startProjectKnowledgeEmbedInterval({ intervalMs } = {}) {
  const configured = Number(intervalMs || process.env.PROJECT_KNOWLEDGE_EMBED_INTERVAL_MS || 0);
  if (!Number.isFinite(configured) || configured <= 0) {
    return { started: false, reason: 'PROJECT_KNOWLEDGE_EMBED_INTERVAL_MS not set' };
  }
  const minInterval = 60000;
  const every = Math.max(configured, minInterval);
  const timer = setInterval(() => {
    const result = spawnProjectKnowledgeEmbedWorker([]);
    if (result.spawned) {
      console.log(JSON.stringify({ event: 'project_knowledge_embed_interval_spawned', pid: result.pid || null }));
    }
  }, every);
  if (typeof timer.unref === 'function') timer.unref();
  return { started: true, intervalMs: every };
}


function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function askModelName() {
  return (process.env.PROJECT_KNOWLEDGE_ASK_MODEL || process.env.GOOGLE_AI_STUDIO_MODEL || 'gemini-2.5-flash').trim();
}

function buildProjectKnowledgeAskPrompt({ question, chunks }) {
  const safeChunks = (Array.isArray(chunks) ? chunks : []).slice(0, 8).map((chunk) => ({
    chunk_id: chunk.chunk_id || chunk.chunkId,
    item_id: chunk.item_id || chunk.itemId,
    title: cleanText(chunk.title).slice(0, 180),
    item_type: cleanText(chunk.item_type || chunk.itemType),
    text: cleanText(chunk.chunk_text || chunk.chunkText).slice(0, 1600),
    score: chunk.score || null,
    metadata: chunk.metadata || {}
  }));
  return [
    'Answer the user question using ONLY the supplied project memory chunks.',
    'If the chunks are insufficient, say that the project memory is insufficient and explain what is missing.',
    'Do not invent facts, dates, owners, decisions, statuses, or evidence.',
    'Cite chunk ids explicitly in the answer using [chunk:<id>] for every factual claim drawn from memory.',
    'Use British English. Keep the answer concise and useful.',
    'Return JSON only with this shape: {"answer":"","citations":[{"chunkId":0,"reason":""}],"confidence":"low|medium|high"}',
    '',
    `Question: ${cleanText(question)}`,
    '',
    `Project memory chunks: ${JSON.stringify(safeChunks)}`
  ].join('\n');
}

function extractJsonObject(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(raw); } catch (_) {}
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch (_) { return null; }
}

async function generateProjectKnowledgeAnswer({ question, chunks, timeoutMs = 30000 }) {
  const apiKey = (process.env.GOOGLE_AI_STUDIO_API_KEY || process.env.GEMINI_API_KEY || '').trim();
  const model = askModelName();
  const diagnostics = { provider: 'google_ai_studio', model, available: Boolean(apiKey), used: false, error: '' };
  if (!apiKey) {
    diagnostics.error = 'GOOGLE_AI_STUDIO_API_KEY is not configured.';
    return { answerMode: 'retrieval_only', answer: '', citations: [], diagnostics };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(timeoutMs || 30000));
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: buildProjectKnowledgeAskPrompt({ question, chunks }) }] }],
        generationConfig: { temperature: 0.1, topP: 0.8, maxOutputTokens: 2048, responseMimeType: 'application/json' }
      })
    });
    if (!response.ok) {
      const detail = cleanText(await response.text().catch(() => '')).slice(0, 240);
      diagnostics.error = `Google AI Studio HTTP ${response.status}${detail ? `: ${detail}` : ''}`;
      return { answerMode: 'retrieval_only', answer: '', citations: [], diagnostics };
    }
    const payload = await response.json();
    const text = (payload.candidates || [])
      .flatMap((candidate) => (((candidate || {}).content || {}).parts || []).map((part) => part && part.text).filter(Boolean))
      .join('\n');
    const parsed = extractJsonObject(text) || {};
    const answer = cleanText(parsed.answer);
    if (!answer) {
      diagnostics.error = 'Google AI Studio returned no parseable answer.';
      return { answerMode: 'retrieval_only', answer: '', citations: [], diagnostics };
    }
    diagnostics.used = true;
    return {
      answerMode: 'generated',
      answer,
      citations: Array.isArray(parsed.citations) ? parsed.citations.slice(0, 12) : [],
      confidence: cleanText(parsed.confidence) || 'medium',
      diagnostics
    };
  } catch (error) {
    diagnostics.error = error.name === 'AbortError' ? 'Google AI Studio request timed out.' : `Google AI Studio request failed: ${error.message}`;
    return { answerMode: 'retrieval_only', answer: '', citations: [], diagnostics };
  } finally {
    clearTimeout(timer);
  }
}

async function answerProjectKnowledge({ projectId, question, topK = 8, timeoutMs = 30000 }) {
  const retrieval = await runProjectKnowledgeRetrieval({
    projectId,
    query: question,
    topK,
    itemTypes: ['background_doc', 'decision', 'report_summary', 'risk', 'note'],
    timeoutMs: Math.min(Number(timeoutMs || 30000), 30000)
  });
  const chunks = Array.isArray(retrieval.chunks) ? retrieval.chunks : [];
  if (!chunks.length) {
    return {
      ok: true,
      answerMode: 'no_context',
      retrievalMode: retrieval.retrieval_mode || retrieval.retrievalMode || 'none',
      retrievedChunks: [],
      answer: '',
      citations: [],
      diagnostics: { retrieval: retrieval.diagnostics || {}, generation: null, error: retrieval.error || '' }
    };
  }
  const generated = await generateProjectKnowledgeAnswer({ question, chunks, timeoutMs });
  return {
    ok: true,
    answerMode: generated.answerMode,
    retrievalMode: retrieval.retrieval_mode || retrieval.retrievalMode || 'none',
    retrievedChunks: chunks,
    answer: generated.answer || '',
    citations: generated.citations || [],
    confidence: generated.confidence || '',
    diagnostics: { retrieval: retrieval.diagnostics || {}, generation: generated.diagnostics || {}, error: retrieval.error || '' }
  };
}

module.exports = {
  spawnProjectKnowledgeEmbedWorker,
  runProjectKnowledgeRetrieval,
  startProjectKnowledgeEmbedInterval,
  answerProjectKnowledge,
  buildProjectKnowledgeAskPrompt
};
