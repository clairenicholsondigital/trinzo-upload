#!/usr/bin/env node
'use strict';

require('dotenv').config();
const fsp = require('node:fs/promises');
const path = require('node:path');
const simplified = require('../utils/simplifiedStagedMinutes');

function clean(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }

function prompt(items, perspective) {
  return [
    perspective === 'auditor'
      ? 'Act as an independent transcript-evidence auditor for official meeting-minutes action retrieval.'
      : 'Act as a conservative meeting-minutes editor checking transcript windows for potentially missed Actions.',
    'For each contextual transcript window, decide ACTION_EVIDENCE, NON_ACTION, or UNCERTAIN. Do not write an action.',
    'ACTION_EVIDENCE means the window establishes or materially supports concrete outstanding work: an explicit commitment or assignment, an accepted proposal, a clearly incomplete ongoing deliverable, or a necessary unresolved prerequisite that still needs checking, verification, review, investigation, documentation or completion.',
    'NON_ACTION means completed-only history, a rejected or unaccepted suggestion, a hypothetical possibility, general discussion/status with no outstanding step, or routine meeting facilitation.',
    'A question or suggestion is not action evidence unless acceptance or necessity is clear in the supplied context.',
    'Use UNCERTAIN if the bounded context does not safely distinguish those cases.',
    'Return one decision for every ID. Return JSON only:',
    '{"decisions":[{"id":"recall_1_5","label":"action_evidence|non_action|uncertain","reason":"..."}]}',
    '',
    'WINDOWS:',
    JSON.stringify(items.map((item) => ({ id: item.id, transcriptWindow: item.text })))
  ].join('\n');
}

async function adjudicate(items, perspective) {
  const decisions = new Map();
  const usage = [];
  for (let offset = 0; offset < items.length; offset += 8) {
    let pending = items.slice(offset, offset + 8);
    for (let attempt = 1; attempt <= 2 && pending.length; attempt += 1) {
      try {
        const call = await simplified._private.callTrooper(prompt(pending, perspective), { maxTokens: 1800 });
        const allowed = new Set(pending.map((item) => item.id));
        for (const row of call.output?.decisions || []) {
          const id = clean(row?.id);
          const label = clean(row?.label).toLowerCase();
          if (allowed.has(id) && ['action_evidence', 'non_action', 'uncertain'].includes(label) && !decisions.has(id)) {
            decisions.set(id, { id, label, reason: clean(row?.reason) || 'not_stated' });
          }
        }
        if (call.usage) usage.push(call.usage);
      } catch {}
      pending = pending.filter((item) => !decisions.has(item.id));
    }
    for (const item of pending) decisions.set(item.id, { id: item.id, label: 'uncertain', reason: 'model_response_invalid' });
  }
  return { decisions: items.map((item) => decisions.get(item.id)), usage };
}

async function main() {
  const inputPath = path.resolve(process.argv[2]);
  const outputPath = path.resolve(process.argv[3]);
  const input = JSON.parse(await fsp.readFile(inputPath, 'utf8'));
  let cases = [];
  try {
    const saved = JSON.parse(await fsp.readFile(outputPath, 'utf8'));
    if (Array.isArray(saved.cases)) cases = saved.cases;
  } catch {}
  for (const item of input.cases || []) {
    if (cases.some((entry) => entry.caseId === item.caseId)) {
      process.stderr.write(`${item.caseId}: resumed\n`);
      continue;
    }
    const editor = await adjudicate(item.sampled || [], 'editor');
    const auditor = await adjudicate([...(item.sampled || [])].reverse(), 'auditor');
    const first = new Map(editor.decisions.map((row) => [row.id, row]));
    const second = new Map(auditor.decisions.map((row) => [row.id, row]));
    const decisions = (item.sampled || []).map((window) => {
      const editorDecision = first.get(window.id);
      const auditorDecision = second.get(window.id);
      const label = editorDecision.label === auditorDecision.label && editorDecision.label !== 'uncertain'
        ? editorDecision.label : 'uncertain';
      return { id: window.id, label, editor: editorDecision, auditor: auditorDecision };
    });
    cases.push({ caseId: item.caseId, decisions, usage: [...editor.usage, ...auditor.usage] });
    const counts = decisions.reduce((sum, row) => ({ ...sum, [row.label]: (sum[row.label] || 0) + 1 }), {});
    await fsp.writeFile(outputPath, `${JSON.stringify({ schemaVersion: 1, complete: false, generatedAt: new Date().toISOString(), cases }, null, 2)}\n`);
    process.stderr.write(`${item.caseId}: ${JSON.stringify(counts)}\n`);
  }
  const all = cases.flatMap((entry) => entry.decisions);
  const counts = all.reduce((sum, row) => ({ ...sum, [row.label]: (sum[row.label] || 0) + 1 }), {});
  await fsp.writeFile(outputPath, `${JSON.stringify({ schemaVersion: 1, complete: true, generatedAt: new Date().toISOString(), counts, cases }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ok: true, outputPath, counts }, null, 2)}\n`);
}

main().catch((error) => { console.error(error.stack || error.message || error); process.exitCode = 1; });
