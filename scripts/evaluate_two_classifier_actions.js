#!/usr/bin/env node
'use strict';

require('dotenv').config();
const fsp = require('node:fs/promises');
const path = require('node:path');
const simplified = require('../utils/simplifiedStagedMinutes');
const benchmark = require('./staged-workflow-confidence/benchmark');

const ROOT = path.resolve(__dirname, '..');

function supported(rows) { return (rows || []).filter((row) => row.support === 'transcript_supported'); }

function screen(payload, key) {
  return (payload?.ui?.screens || []).find((item) => item?.key === key)?.data;
}

async function browserContext(item, baselineRoot) {
  if (!baselineRoot) return null;
  try {
    const file = path.join(baselineRoot, 'raw', 'run-01', `${item.caseId}.json`);
    const record = JSON.parse(await fsp.readFile(file, 'utf8'));
    const details = screen(record.payload, 'details') || {};
    const summary = screen(record.payload, 'summary') || {};
    const discussion = screen(record.payload, 'discussion') || [];
    return {
      meetingContext: { meetingType: details.meetingType || '', meetingPurpose: summary.meetingPurpose || '' },
      topics: [...new Set(discussion.map((row) => String(row?.topic || '').trim()).filter(Boolean))]
    };
  } catch {
    return null;
  }
}

async function main() {
  const outputDir = path.resolve(process.argv[2] || path.join(ROOT, 'benchmark-results', 'two-classifier-actions-local'));
  const casesDir = path.join(outputDir, 'cases');
  await fsp.mkdir(casesDir, { recursive: true });
  const corpus = benchmark.loadCorpus();
  const requestedCaseIds = String(process.env.ACTION_EXPERIMENT_CASES || '').split(',').map((value) => value.trim()).filter(Boolean);
  const selectedCases = requestedCaseIds.length ? corpus.cases.filter((item) => requestedCaseIds.includes(item.caseId)) : corpus.cases;
  if (selectedCases.length !== (requestedCaseIds.length || corpus.cases.length)) throw new Error('One or more ACTION_EXPERIMENT_CASES values were not found.');
  const runs = Math.max(1, Number(process.env.ACTION_EXPERIMENT_RUNS || 1));
  const baselineRoot = String(process.env.ACTION_EXPERIMENT_BASELINE_RAW || '').trim();
  const generated = [];
  for (let run = 1; run <= runs; run += 1) for (const item of selectedCases) {
    const casePath = path.join(casesDir, `run-${String(run).padStart(2, '0')}`, `${item.caseId}.json`);
    try {
      const saved = JSON.parse(await fsp.readFile(casePath, 'utf8'));
      generated.push(saved);
      process.stderr.write(`run ${run} ${item.caseId}: resumed ${saved.actions.length} action(s)\n`);
      continue;
    } catch {}
    const startedAt = Date.now();
    const expected = item.expected.expected;
    const confirmed = await browserContext(item, baselineRoot);
    const meetingContext = confirmed?.meetingContext || { meetingType: expected.details?.meetingType || '', meetingPurpose: expected.summary?.meetingPurpose || '' };
    const result = await simplified.generateActionsEvidenceFirst(item.transcript, {
      meetingContext, skipCache: true
    });
    const record = { caseId: item.caseId, run, durationMs: Date.now() - startedAt, actions: result.actions, telemetry: result.telemetry, meetingContext, topics: confirmed?.topics || [] };
    await fsp.mkdir(path.dirname(casePath), { recursive: true });
    await fsp.writeFile(casePath, `${JSON.stringify(record, null, 2)}\n`);
    generated.push(record);
    process.stderr.write(`run ${run} ${item.caseId}: ${record.actions.length} action(s) from ${record.telemetry.selector?.selectedWindowCount || 0} selected window(s) in ${record.durationMs}ms\n`);
  }
  const records = generated.map((record) => {
    const item = corpus.cases.find((entry) => entry.caseId === record.caseId);
    const expected = item.expected.expected;
    return {
      id: `local-action-first::run-${record.run}::${record.caseId}`, caseId: record.caseId, run: record.run, durationMs: record.durationMs,
      payload: {
        ui: { screens: [
          { key: 'details', data: expected.details },
          { key: 'summary', data: { ...expected.summary, objectives: supported(expected.summary.objectives).map((row) => row.text) } },
          { key: 'discussion', data: supported(expected.discussionFacts).map((row) => ({ topic: row.acceptableTopicFamilies?.[0] || 'Discussion', points: [row.text] })) },
          { key: 'actions', data: record.actions }
        ] },
        diagnostics: { trace: [{ stage: 'actions', provider: 'simplified', fallbackUsed: false, telemetry: { simplifiedPipeline: record.telemetry } }] },
        reviewExperience: { warningCount: 0, blockingCount: 0, readyForFinalApproval: true }
      }
    };
  });
  const report = benchmark.scoreRecords(corpus, records);
  const actionSummary = {
    actionRecallMean: report.summary.actionRecallMean,
    actionPrecisionMean: report.summary.actionPrecisionMean,
    totalNegativeControlActions: report.summary.totalNegativeControlActions,
    actionCount: generated.reduce((sum, row) => sum + row.actions.length, 0),
    recallRescue: {
      nominatedWindows: generated.reduce((sum, row) => sum + Number(row.telemetry.recallRescue?.nominatedCount || 0), 0),
      selectedWindows: generated.reduce((sum, row) => sum + Number(row.telemetry.recallRescue?.selectedCount || 0), 0),
      recoveredCandidatesBeforePublication: generated.reduce((sum, row) => sum + Number(row.telemetry.recallRescue?.recoveredCount || 0), 0),
      publicationRemoved: generated.reduce((sum, row) => sum + Number(row.telemetry.editor?.removedCount || 0), 0)
    }
  };
  await fsp.writeFile(path.join(outputDir, 'report.json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), actionSummary, report, generated }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ok: true, outputDir, actionSummary }, null, 2)}\n`);
}

main().catch((error) => { console.error(error.stack || error.message || error); process.exitCode = 1; });
