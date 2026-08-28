#!/usr/bin/env node
'use strict';

require('dotenv').config();
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const simplified = require('../utils/simplifiedStagedMinutes');
const { buildActionRecallWindows } = require('../utils/actionRecallRescue');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = path.join(ROOT, 'scripts', 'staged-workflow-confidence', 'corpus-v2', 'manifest.json');
const ACTION_CUE = /\b(?:will|shall|need(?:s)? to|must|have to|going to|follow up|send|share|review|verify|check|confirm|complete|update|prepare|investigate|look at|come back|next week|tomorrow|by (?:monday|tuesday|wednesday|thursday|friday))\b/i;

function hashRank(value) { return crypto.createHash('sha1').update(value).digest('hex'); }

async function main() {
  const outputPath = path.resolve(process.argv[2]);
  const manifest = JSON.parse(await fsp.readFile(MANIFEST, 'utf8'));
  let cases = [];
  try {
    const saved = JSON.parse(await fsp.readFile(outputPath, 'utf8'));
    if (Array.isArray(saved.cases)) cases = saved.cases;
  } catch {}
  for (const item of manifest.cases) {
    if (cases.some((entry) => entry.caseId === item.caseId)) {
      process.stderr.write(`${item.caseId}: resumed\n`);
      continue;
    }
    const transcript = await fsp.readFile(path.join(ROOT, item.transcriptPath), 'utf8');
    const expected = JSON.parse(await fsp.readFile(path.join(ROOT, item.expectedV2Path), 'utf8')).expected;
    const prepared = await simplified.prepareTranscript(transcript, [], { skipCache: true });
    const windows = buildActionRecallWindows(prepared.units);
    const actionBySource = new Map();
    for (const action of (expected.actions || []).filter((row) => row.support === 'transcript_supported')) {
      for (const evidence of action.evidence || []) {
        if (!actionBySource.has(evidence.sourceId)) actionBySource.set(evidence.sourceId, []);
        actionBySource.get(evidence.sourceId).push(action.id);
      }
    }
    const anchors = [];
    const pool = [];
    for (const window of windows) {
      const expectedActionIds = [...new Set(window.evidenceIds.flatMap((id) => actionBySource.get(id) || []))];
      const row = { ...window, expectedActionIds };
      if (expectedActionIds.length) anchors.push({ ...row, label: 'action_evidence', source: 'human_expected_evidence' });
      else pool.push(row);
    }
    const cue = pool.filter((row) => ACTION_CUE.test(row.text)).sort((a, b) => hashRank(`${item.caseId}:${a.id}`).localeCompare(hashRank(`${item.caseId}:${b.id}`))).slice(0, 18);
    const cueIds = new Set(cue.map((row) => row.id));
    const ordinary = pool.filter((row) => !cueIds.has(row.id)).sort((a, b) => hashRank(`${item.caseId}:ordinary:${a.id}`).localeCompare(hashRank(`${item.caseId}:ordinary:${b.id}`))).slice(0, 8);
    const sampled = [...cue, ...ordinary].map((row) => ({ ...row, source: ACTION_CUE.test(row.text) ? 'action_cue_sample' : 'ordinary_sample' }));
    cases.push({ caseId: item.caseId, transcriptSha256: item.transcriptSha256, unitCount: prepared.units.length, windowCount: windows.length, anchors, sampled });
    await fsp.mkdir(path.dirname(outputPath), { recursive: true });
    await fsp.writeFile(outputPath, `${JSON.stringify({ schemaVersion: 1, complete: false, generatedAt: new Date().toISOString(), cases }, null, 2)}\n`);
    process.stderr.write(`${item.caseId}: ${anchors.length} positive anchor window(s), ${sampled.length} sampled window(s)\n`);
  }
  const counts = cases.reduce((sum, entry) => ({ anchors: sum.anchors + entry.anchors.length, sampled: sum.sampled + entry.sampled.length }), { anchors: 0, sampled: 0 });
  await fsp.writeFile(outputPath, `${JSON.stringify({ schemaVersion: 1, complete: true, generatedAt: new Date().toISOString(), counts, cases }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ok: true, outputPath, counts }, null, 2)}\n`);
}

main().catch((error) => { console.error(error.stack || error.message || error); process.exitCode = 1; });
