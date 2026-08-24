'use strict';

// What the discussion stage publishes, across the transcript corpus.
//
// Discussion carries the strongest editorial bar in the pipeline - the
// finaliseDiscussionPointForMinutes chain - and its output has been byte-identical through
// several changes that touched everything around it. That stability is worth protecting,
// and until now it was protected by assertion: the topic-label sweep records headings, not
// points, so "discussion is unchanged" was checked by hand in a scratch script and thrown
// away each time.
//
// This is the same shape as actions_sweep.js: record what each transcript publishes, diff
// it, and leave the judgement to a human reading the added and removed lines. It exists so
// that a change to a shared predicate cannot quietly rewrite forty meetings' discussion
// while fixing the action in front of you.
//
// Capture:  node scripts/discussion_sweep.js --write
// Compare:  node scripts/discussion_sweep.js
// One file: node scripts/discussion_sweep.js --only 003_webinar
//
// Known gap, shared with actions_sweep.js: this runs with `confirmed: {}`, so
// buildConfirmedState sees no participants and anything gated on reviewer-confirmed
// attendees - name corrections among them - is invisible here. A change in that area needs
// unit tests, and a commit message that says so rather than claiming corpus evidence.
//
// MiniLM makes this slow cold. Set CANONICAL_MINILM_DISK_CACHE to a directory and the
// second run costs minutes rather than an hour.

const fs = require('fs');
const path = require('path');
const { listTranscripts, readTranscript } = require('./evidence_parse_baseline');

const REPO_ROOT = path.resolve(__dirname, '..');
const BASELINE_PATH = path.join(REPO_ROOT, 'tests', 'fixtures', 'discussion-sweep-baseline.json');

function isolateEvaluationFromDatabase() {
  const dbPath = require.resolve('../utils/db');
  const unavailable = async () => {
    throw new Error('Database access is unavailable inside the discussion sweep.');
  };
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: new Proxy({}, { get: () => unavailable })
  };
}

const clean = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();

function cardLines(card) {
  const topic = clean(card?.topic) || 'Discussion';
  const points = (Array.isArray(card?.points) ? card.points : [])
    .map((point) => clean(typeof point === 'string' ? point : point?.text))
    .filter(Boolean);
  return points.length ? points.map((point) => `${topic} :: ${point}`) : [`${topic} :: (no points)`];
}

async function collect(only) {
  isolateEvaluationFromDatabase();
  const { runCanonicalLiveStage } = require('../utils/canonicalMinutes/liveStages');
  const files = listTranscripts().filter((file) => !only || file.includes(only));
  const results = {};
  for (const file of files) {
    const text = await readTranscript(file);
    try {
      const stage = runCanonicalLiveStage(text, { stage: 'discussion', fileName: path.basename(path.dirname(file)), confirmed: {} });
      results[file] = { published: (stage.screens?.discussion || []).flatMap(cardLines) };
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
  console.log(`\n${changed} of ${files.length} transcripts changed | discussion points ${total(before)} -> ${total(after)} | +${added} -${removed}`);
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
