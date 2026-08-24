'use strict';

// What the actions stage publishes, across the transcript corpus.
//
// Actions are the part of the minutes a reviewer is least able to repair from memory: a
// discussion point they can rewrite, but an action that was never extracted is an action
// they have to notice is missing. Nothing measured the published list corpus-wide, so a
// change to extraction, consolidation or ranking could quietly drop a commitment in
// forty other meetings while fixing the one in front of you.
//
// This records, per transcript, the published owner/action/deadline rows. The comparison
// is deliberately a diff, not a score:
// there is no ground truth here, so the harness's job is to make every change visible and
// leave the judgement to a human reading the added and removed lines.
//
// Capture:  node scripts/actions_sweep.js --write
// Compare:  node scripts/actions_sweep.js
// One file: node scripts/actions_sweep.js --only 003_webinar
//
// MiniLM makes this slow cold. Set CANONICAL_MINILM_DISK_CACHE to a directory and the
// second run costs minutes rather than an hour.

const fs = require('fs');
const path = require('path');
const { listTranscripts, readTranscript } = require('./evidence_parse_baseline');

const REPO_ROOT = path.resolve(__dirname, '..');
const BASELINE_PATH = path.join(REPO_ROOT, 'tests', 'fixtures', 'actions-sweep-baseline.json');

function isolateEvaluationFromDatabase() {
  const dbPath = require.resolve('../utils/db');
  const unavailable = async () => {
    throw new Error('Database access is unavailable inside the actions sweep.');
  };
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: new Proxy({}, { get: () => unavailable })
  };
}

function row(item) {
  const clean = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return `${clean(item.owner) || 'Not stated'} :: ${clean(item.humanFinal || item.action)} :: ${clean(item.deadline) || 'Not stated'}`;
}

async function collect(only) {
  isolateEvaluationFromDatabase();
  const { runCanonicalLiveStage } = require('../utils/canonicalMinutes/liveStages');
  const files = listTranscripts().filter((file) => !only || file.includes(only));
  const results = {};
  for (const file of files) {
    const text = await readTranscript(file);
    try {
      const stage = runCanonicalLiveStage(text, { stage: 'actions', fileName: path.basename(path.dirname(file)), confirmed: {} });
      results[file] = { published: (stage.screens?.actions || []).map(row) };
    } catch (error) {
      results[file] = { error: error.message };
    }
    process.stderr.write(`${Object.keys(results).length}/${files.length} ${file}\n`);
  }
  return results;
}

function diff(before, after) {
  const files = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  let changed = 0;
  let added = 0;
  let removed = 0;
  for (const file of files) {
    const left = before[file]?.published || [];
    const right = after[file]?.published || [];
    const gone = left.filter((item) => !right.includes(item));
    const fresh = right.filter((item) => !left.includes(item));
    if (!gone.length && !fresh.length) continue;
    changed += 1;
    added += fresh.length;
    removed += gone.length;
    console.log(`\n${file}  (${left.length} -> ${right.length})`);
    for (const item of gone) console.log(`  - ${item}`);
    for (const item of fresh) console.log(`  + ${item}`);
  }
  const total = (source) => Object.values(source).reduce((sum, entry) => sum + (entry.published?.length || 0), 0);
  console.log(`\n${changed} of ${files.length} transcripts changed | published rows ${total(before)} -> ${total(after)} | +${added} -${removed}`);
  return changed;
}

async function main() {
  const write = process.argv.includes('--write');
  const onlyIndex = process.argv.indexOf('--only');
  const only = onlyIndex >= 0 ? process.argv[onlyIndex + 1] : '';
  const results = await collect(only);
  if (write) {
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(results, null, 2)}\n`);
    console.log(`wrote ${Object.keys(results).length} transcripts to ${path.relative(REPO_ROOT, BASELINE_PATH)}`);
    return;
  }
  if (!fs.existsSync(BASELINE_PATH)) {
    console.error('no baseline yet - run with --write first');
    process.exitCode = 2;
    return;
  }
  diff(JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')), results);
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
