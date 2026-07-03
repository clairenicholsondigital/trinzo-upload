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

module.exports = {
  spawnProjectKnowledgeEmbedWorker,
  runProjectKnowledgeRetrieval,
  startProjectKnowledgeEmbedInterval
};
