'use strict';

// Parse-invariance harness for prepareEvidence().
//
// Every transcript fixture in the repo is parsed and its evidence output hashed.
// The hashes are committed to tests/fixtures/evidence-parse-baseline.json and
// checked by tests/evidence-parse-invariance.test.js, so any change to the
// parser must either leave output byte-identical or declare exactly which
// transcripts it changed. No MiniLM, no network, no model variance — it is a
// pure function of the fixture corpus and the parser.
//
// Regenerate after a deliberate parser change:
//   node scripts/evidence_parse_baseline.js --write
//
// Coverage figures are recorded as diagnostics only. They are not asserted,
// because the denominator moves whenever the header grammar changes; the hash
// is the invariant.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mammoth = require('mammoth');
const { prepareEvidence, buildSpeakerHeaderPattern } = require('../utils/canonicalMinutes/evidence');

const REPO_ROOT = path.resolve(__dirname, '..');
const BASELINE_PATH = path.join(REPO_ROOT, 'tests', 'fixtures', 'evidence-parse-baseline.json');
const CORPORA = [
  path.join('scripts', 'transcript-tests'),
  path.join('scripts', 'meeting-minutes-core-golden'),
  path.join('scripts', 'meeting-minutes-final-golden')
];

const normalise = (value) => String(value || '').replace(/\s+/g, ' ').trim();

function listTranscripts() {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/^transcript\.(txt|docx)$/.test(entry.name)) found.push(path.relative(REPO_ROOT, full));
    }
  };
  for (const corpus of CORPORA) {
    const dir = path.join(REPO_ROOT, corpus);
    if (fs.existsSync(dir)) walk(dir);
  }
  return found.sort();
}

async function readTranscript(relativePath) {
  const full = path.join(REPO_ROOT, relativePath);
  if (full.endsWith('.docx')) return (await mammoth.extractRawText({ path: full })).value;
  return fs.readFileSync(full, 'utf8');
}

// Content characters are the source minus speaker headers: the text a reader
// would consider the meeting itself. Parsed characters are what survives into
// evidence turns, excluding turns synthesised from a structured actions table
// (those are not present in the prose and would inflate the figure).
function measureOne(text) {
  const evidence = prepareEvidence(text);
  const contentChars = normalise(text.replace(buildSpeakerHeaderPattern(), ' ')).length;
  const parsedChars = normalise(evidence.turns.filter((turn) => !turn.structuredSource).map((turn) => turn.text).join(' ')).length;
  return {
    turns: evidence.turns.length,
    events: evidence.events.length,
    participants: evidence.participants.length,
    contentChars,
    parsedChars,
    coverage: contentChars ? Number(Math.min(1, parsedChars / contentChars).toFixed(3)) : 1,
    hash: crypto.createHash('sha256').update(JSON.stringify(evidence)).digest('hex').slice(0, 16)
  };
}

async function measureCorpus() {
  const rows = [];
  for (const file of listTranscripts()) rows.push({ file, ...measureOne(await readTranscript(file)) });
  return rows;
}

function readBaseline() {
  return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
}

// Structural comparison: hash plus the counts a reader would check by hand.
// Coverage is deliberately excluded — see the note at the top of this file.
function diffAgainstBaseline(rows, baseline) {
  const current = new Map(rows.map((row) => [row.file, row]));
  const previous = new Map(baseline.map((row) => [row.file, row]));
  const changed = [];
  for (const [file, before] of previous) {
    const after = current.get(file);
    if (!after) { changed.push({ file, kind: 'removed' }); continue; }
    const fields = ['hash', 'turns', 'events', 'participants'].filter((field) => before[field] !== after[field]);
    if (fields.length) changed.push({ file, kind: 'changed', fields, before, after });
  }
  for (const file of current.keys()) if (!previous.has(file)) changed.push({ file, kind: 'added' });
  return changed;
}

function describeChange(change) {
  if (change.kind !== 'changed') return `  ${change.kind.padEnd(7)} ${change.file}`;
  const detail = change.fields.map((field) => `${field}: ${change.before[field]} -> ${change.after[field]}`).join(', ');
  return `  changed ${change.file}\n            ${detail}`;
}

async function main() {
  const rows = await measureCorpus();
  const lost = rows.map((row) => row.contentChars - row.parsedChars);
  console.log(`transcripts          : ${rows.length}`);
  console.log(`zero-turn parses     : ${rows.filter((row) => row.turns === 0).length}`);
  console.log(`total content chars  : ${rows.reduce((sum, row) => sum + row.contentChars, 0)}`);
  console.log(`total lost chars     : ${lost.reduce((sum, value) => sum + value, 0)}`);
  console.log(`files losing >200    : ${lost.filter((value) => value > 200).length}`);
  console.log('\nlowest 10 by coverage:');
  rows.slice().sort((a, b) => a.coverage - b.coverage).slice(0, 10).forEach((row) => {
    console.log(`  cov=${String(row.coverage).padEnd(6)} turns=${String(row.turns).padEnd(4)} lost=${String(row.contentChars - row.parsedChars).padEnd(6)} ${row.file}`);
  });

  if (process.argv.includes('--write')) {
    fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(rows, null, 2)}\n`);
    console.log(`\nwrote ${path.relative(REPO_ROOT, BASELINE_PATH)}`);
    return;
  }

  if (!fs.existsSync(BASELINE_PATH)) {
    console.log('\nno baseline committed yet; run with --write');
    return;
  }
  const changed = diffAgainstBaseline(rows, readBaseline());
  if (!changed.length) { console.log('\nparse output identical to baseline'); return; }
  console.log(`\n${changed.length} transcript(s) differ from baseline:`);
  changed.forEach((change) => console.log(describeChange(change)));
  process.exitCode = 1;
}

module.exports = { listTranscripts, readTranscript, measureOne, measureCorpus, readBaseline, diffAgainstBaseline, describeChange, BASELINE_PATH };

if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
