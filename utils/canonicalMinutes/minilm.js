'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const profileCache = new Map();
const PROFILE_CACHE_TTL_MS = Number(process.env.CANONICAL_MINILM_CACHE_TTL_MS || 20 * 60 * 1000);
const PROFILE_CACHE_LIMIT = Number(process.env.CANONICAL_MINILM_CACHE_LIMIT || 8);

function evidencePayload(evidence) {
  return { events: evidence.events.map(({ id, turnId, turnIndex, speaker, text, previousText, nextText, contextText }) => ({ id, turnId, turnIndex, speaker, text, previousText, nextText, contextText })) };
}

function loadMiniLMProfileSync(evidence, options = {}) {
  const payload = JSON.stringify(evidencePayload(evidence));
  const cacheKey = crypto.createHash('sha256').update(payload).digest('hex');
  const cached = profileCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < PROFILE_CACHE_TTL_MS) {
    profileCache.delete(cacheKey);
    profileCache.set(cacheKey, cached);
    return cached.profile;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'trinzo-canonical-minilm-'));
  const inputPath = path.join(directory, 'evidence.json');
  try {
    fs.writeFileSync(inputPath, payload);
    const result = spawnSync(process.env.PYTHON_BIN || 'python3', [path.join(__dirname, '..', '..', 'scripts', 'canonical_minutes_minilm_profile.py'), inputPath], {
      cwd: path.join(__dirname, '..', '..'), encoding: 'utf8', timeout: Number(options.timeoutMs || 120000), maxBuffer: 20 * 1024 * 1024
    });
    if (result.status !== 0) throw new Error(result.stderr || `MiniLM profile process exited with ${result.status}`);
    const profile = JSON.parse(result.stdout);
    profileCache.set(cacheKey, { profile, createdAt: Date.now() });
    while (profileCache.size > PROFILE_CACHE_LIMIT) profileCache.delete(profileCache.keys().next().value);
    return profile;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function semanticFor(profile, eventOrId) {
  return profile?.events?.[typeof eventOrId === 'string' ? eventOrId : eventOrId?.id] || { scores: {}, primaryRole: 'unknown', confidence: 0, margin: 0 };
}

module.exports = { evidencePayload, loadMiniLMProfileSync, semanticFor };
