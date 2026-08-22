'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const profileCache = new Map();
const PROFILE_CACHE_TTL_MS = Number(process.env.CANONICAL_MINILM_CACHE_TTL_MS || 20 * 60 * 1000);
const PROFILE_CACHE_LIMIT = Number(process.env.CANONICAL_MINILM_CACHE_LIMIT || 8);

// Optional disk cache, off unless CANONICAL_MINILM_DISK_CACHE names a directory.
//
// The profile is a pure function of the evidence payload, and the in-memory
// cache above is per-process and holds eight entries, so a run over the whole
// corpus recomputes every profile from scratch — a fresh Python process and a
// fresh model load per transcript. Editorial and resolver work downstream of
// prepareEvidence cannot change the payload, so successive verification runs
// ask the identical question and wait an hour for the identical answer.
//
// Deliberately opt-in: the server never sets it, so production behaviour is
// unchanged. Evals and verification runs set it and read the profiles back.
// The key is the payload hash, so a genuine change to the evidence misses the
// cache and recomputes, which is the behaviour that makes it safe to leave on.
const DISK_CACHE_DIR = process.env.CANONICAL_MINILM_DISK_CACHE || '';

function diskCachePath(cacheKey) {
  return path.join(DISK_CACHE_DIR, `${cacheKey}.json`);
}

function readDiskCache(cacheKey) {
  if (!DISK_CACHE_DIR) return null;
  try {
    return JSON.parse(fs.readFileSync(diskCachePath(cacheKey), 'utf8'));
  } catch {
    return null;
  }
}

function writeDiskCache(cacheKey, profile) {
  if (!DISK_CACHE_DIR) return;
  try {
    fs.mkdirSync(DISK_CACHE_DIR, { recursive: true });
    // Write then rename so a concurrent reader never sees a partial file.
    const temporary = `${diskCachePath(cacheKey)}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(profile));
    fs.renameSync(temporary, diskCachePath(cacheKey));
  } catch {
    // A cache that cannot be written must never break the run that uses it.
  }
}

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
  const fromDisk = readDiskCache(cacheKey);
  if (fromDisk) {
    profileCache.set(cacheKey, { profile: fromDisk, createdAt: Date.now() });
    return fromDisk;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'trinzo-canonical-minilm-'));
  const inputPath = path.join(directory, 'evidence.json');
  try {
    fs.writeFileSync(inputPath, payload);
    const result = spawnSync(process.env.PYTHON_BIN || 'python3', [path.join(__dirname, '..', '..', 'scripts', 'canonical_minutes_minilm_profile.py'), inputPath], {
      // A backstop against a hung profiler, not a performance budget. One profile takes
      // about twenty-five seconds on an idle machine; several at once - which is what the
      // test suite does, and what a busy server does - take considerably longer, and at
      // 120s they were being killed on a cold cache and reported as "profile unavailable".
      // Killing work that would have finished buys nothing, so the limit is set where it
      // still catches a genuine hang.
      cwd: path.join(__dirname, '..', '..'), encoding: 'utf8', timeout: Number(options.timeoutMs || process.env.CANONICAL_MINILM_TIMEOUT_MS || 600000), maxBuffer: 20 * 1024 * 1024
    });
    if (result.status !== 0) throw new Error(result.stderr || `MiniLM profile process exited with ${result.status}`);
    const profile = JSON.parse(result.stdout);
    writeDiskCache(cacheKey, profile);
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
