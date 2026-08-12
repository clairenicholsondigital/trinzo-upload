'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

function evidencePayload(evidence) {
  return { events: evidence.events.map(({ id, turnId, turnIndex, speaker, text }) => ({ id, turnId, turnIndex, speaker, text })) };
}

function loadMiniLMProfileSync(evidence, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'trinzo-canonical-minilm-'));
  const inputPath = path.join(directory, 'evidence.json');
  try {
    fs.writeFileSync(inputPath, JSON.stringify(evidencePayload(evidence)));
    const result = spawnSync(process.env.PYTHON_BIN || 'python3', [path.join(__dirname, '..', '..', 'scripts', 'canonical_minutes_minilm_profile.py'), inputPath], {
      cwd: path.join(__dirname, '..', '..'), encoding: 'utf8', timeout: Number(options.timeoutMs || 120000), maxBuffer: 20 * 1024 * 1024
    });
    if (result.status !== 0) throw new Error(result.stderr || `MiniLM profile process exited with ${result.status}`);
    return JSON.parse(result.stdout);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function semanticFor(profile, eventOrId) {
  return profile?.events?.[typeof eventOrId === 'string' ? eventOrId : eventOrId?.id] || { scores: {}, primaryRole: 'unknown', confidence: 0, margin: 0 };
}

module.exports = { evidencePayload, loadMiniLMProfileSync, semanticFor };
