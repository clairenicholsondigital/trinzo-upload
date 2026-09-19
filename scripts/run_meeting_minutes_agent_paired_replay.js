#!/usr/bin/env node
// Paired replay: compares two configurations of the Actions stage on the SAME
// cached model responses, so only the code or settings differ between arms.
// Use it for any change that acts after the models (checks, filters, merges).
// Changes to preparation or prompts alter what the models see and need a live
// side-by-side harness run instead.
//
// 1. Produce kept drafts:  node scripts/run_meeting_minutes_agent_performance_baseline.js \
//      --base-url http://127.0.0.1:3980 --case-dir <golden> --cases all --runs 2 --keep-drafts --output kept.json
// 2. Compare:              node scripts/run_meeting_minutes_agent_paired_replay.js kept.json \
//      --a "MEETING_MINUTES_AGENT_PROPOSAL_RECHECK_V1=0" --b "MEETING_MINUTES_AGENT_PROPOSAL_RECHECK_V1=1" \
//      [--out-dir dir] [--env-file path] [--delete-drafts]
// Later model passes that are not cached (recovery, critic, salvage) still run
// live and vary; compare totals, not individual rows.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const value = (flag, fallback = '') => (args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback);
const keptFile = path.resolve(args[0] || '');
if (!args[0] || !fs.existsSync(keptFile)) {
  console.error('usage: run_meeting_minutes_agent_paired_replay.js <kept.json> --a "K=V,K=V" --b "K=V" [--out-dir d] [--env-file p] [--delete-drafts]');
  process.exit(2);
}
const outDir = path.resolve(value('--out-dir', path.dirname(keptFile)));
const envFile = value('--env-file', path.join(ROOT, '.env'));
const parseEnv = (text) => Object.fromEntries(String(text || '').split(',').map((pair) => pair.trim()).filter(Boolean)
  .map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]));
const arms = { a: parseEnv(value('--a')), b: parseEnv(value('--b')) };

function replay(name) {
  const out = path.join(outDir, `paired-${name}.json`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'replay_meeting_minutes_agent_actions.js'), ROOT, keptFile, out, '--env-file', envFile],
      { env: { ...process.env, ...arms[name] }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => String(chunk).split('\n').filter((line) => line && !line.startsWith('{'))
      .forEach((line) => console.log(`[${name}] ${line}`)));
    child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`arm ${name} exited ${code}`))));
  });
}

function score(file) {
  const result = spawnSync('python3', [path.join(__dirname, 'score_meeting_minutes_agent_golden.py'), file, '--json', file.replace(/\.json$/, '-scores.json')], { encoding: 'utf8' });
  const lines = String(result.stdout || '').split('\n');
  return lines.filter((line) => /^journeys|^tolerant/.test(line)).join('\n');
}

(async () => {
  console.log(`arm a: ${JSON.stringify(arms.a)}\narm b: ${JSON.stringify(arms.b)}`);
  const [a, b] = await Promise.all([replay('a'), replay('b')]);
  for (const [name, file] of [['a', a], ['b', b]]) console.log(`\n== arm ${name}\n${score(file)}`);
  if (args.includes('--delete-drafts')) {
    require(path.join(ROOT, 'node_modules/dotenv')).config({ path: envFile, quiet: true });
    const db = require(path.join(ROOT, 'utils/db'));
    const ids = JSON.parse(fs.readFileSync(keptFile, 'utf8')).journeys.map((journey) => Number(journey.draftId)).filter(Boolean);
    const removed = await db.query(`DELETE FROM meeting_minutes_agent_drafts WHERE id = ANY($1) AND file_name LIKE '%-performance-baseline.txt' RETURNING id`, [ids]);
    console.log(`\ndeleted ${removed.rows.length} kept drafts`);
  }
  process.exit(0);
})().catch((error) => { console.error(error.message); process.exit(1); });
