'use strict';

// Populate the MiniLM disk cache for the whole transcript corpus.
//
// A profile costs roughly twelve seconds because each one starts a Python
// process and loads the model; sequentially that is half an hour before any
// verification can begin. The work is embarrassingly parallel and identical for
// every run downstream of prepareEvidence, so pay it once, concurrently, and
// every later eval or corpus comparison reads from disk in about a millisecond.
//
//   CANONICAL_MINILM_DISK_CACHE=/path/to/cache node scripts/warm_minilm_cache.js [workers]
//
// Safe to re-run: an entry that already exists is skipped, and a payload that
// genuinely changed misses the cache and is recomputed.

const os = require('os');
const { fork } = require('child_process');
const { listTranscripts, readTranscript } = require('./evidence_parse_baseline');
const { prepareEvidence } = require('../utils/canonicalMinutes/evidence');
const { loadMiniLMProfileSync } = require('../utils/canonicalMinutes/minilm');

// Child mode: profile one transcript and exit.
if (process.env.WARM_ONE) {
  (async () => {
    try {
      loadMiniLMProfileSync(prepareEvidence(await readTranscript(process.env.WARM_ONE)));
      process.exit(0);
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
  })();
  return;
}

if (!process.env.CANONICAL_MINILM_DISK_CACHE) {
  console.error('CANONICAL_MINILM_DISK_CACHE must be set, or there is nothing to warm.');
  process.exitCode = 1;
  return;
}

// Leave headroom: this shares a machine with the live service.
const workers = Math.max(1, Math.min(Number(process.argv[2]) || 4, Math.max(1, os.cpus().length - 2)));
const files = listTranscripts();
let next = 0;
let done = 0;
let failed = 0;
const started = Date.now();

function runNext() {
  if (next >= files.length) return Promise.resolve();
  const file = files[next++];
  return new Promise((resolve) => {
    const child = fork(__filename, [], { env: { ...process.env, WARM_ONE: file }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    child.on('exit', (code) => {
      done += 1;
      if (code !== 0) failed += 1;
      if (done % 10 === 0 || done === files.length) {
        const rate = (Date.now() - started) / done;
        console.log(`${done}/${files.length} profiled  (~${Math.round((files.length - done) * rate / 1000)}s remaining)`);
      }
      resolve();
    });
  }).then(runNext);
}

Promise.all(Array.from({ length: workers }, runNext)).then(() => {
  console.log(`warmed ${files.length - failed}/${files.length} profiles in ${Math.round((Date.now() - started) / 1000)}s using ${workers} workers`);
  if (failed) process.exitCode = 1;
});
