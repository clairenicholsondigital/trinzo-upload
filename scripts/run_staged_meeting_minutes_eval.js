#!/usr/bin/env node
'use strict';

require('dotenv').config({ quiet: true });

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_DIR = path.resolve(__dirname, '..');
const PACK_DIR = path.join(__dirname, 'meeting-minutes-final-golden');
const REAL_CASE_PATTERN = /^02[1-7]_real_/;

function parseArgs(argv) {
  const options = {
    contextMode: 'extractor',
    json: false,
    outputPath: '',
    cases: []
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--mode') options.contextMode = String(argv[++index] || '');
    else if (arg.startsWith('--mode=')) options.contextMode = arg.slice('--mode='.length);
    else if (arg === '--output') options.outputPath = String(argv[++index] || '');
    else if (arg.startsWith('--output=')) options.outputPath = arg.slice('--output='.length);
    else if (arg === '--cases') options.cases = String(argv[++index] || '').split(',').filter(Boolean);
    else if (arg.startsWith('--cases=')) options.cases = arg.slice('--cases='.length).split(',').filter(Boolean);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!['extractor', 'targeted'].includes(options.contextMode)) {
    throw new Error('--mode must be extractor or targeted.');
  }
  return options;
}

async function findRealCases(requested = []) {
  const names = (await fs.readdir(PACK_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && REAL_CASE_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (!requested.length) return names;
  const requestedSet = new Set(requested);
  const selected = names.filter((name) => requestedSet.has(name));
  const missing = requested.filter((name) => !names.includes(name));
  if (missing.length) throw new Error(`Unknown real case(s): ${missing.join(', ')}`);
  return selected;
}

function scorePrecomputed(outputDir, caseNames) {
  const args = [
    path.join(__dirname, 'run_meeting_minutes_final_golden_eval.py'),
    '--precomputed-dir', outputDir,
    '--literal-only',
    '--json',
    '--cases', ...caseNames
  ];
  const result = spawnSync(process.env.PYTHON_BIN || 'python3', args, {
    cwd: REPO_DIR,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  });
  if (!result.stdout.trim()) {
    throw new Error(result.stderr.trim() || `Golden scorer exited ${result.status}.`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Golden scorer returned invalid JSON: ${error.message}`);
  }
}

function stageSummary(trace = []) {
  return Object.fromEntries(trace.map((stage) => [stage.stage, {
    provider: stage.provider,
    fallbackUsed: stage.fallbackUsed,
    inputTopicCount: stage.inputTopicCount,
    outputCount: stage.outputCount,
    outputPointCount: stage.outputPointCount,
    validationFlagTypes: (stage.validationFlags || []).map((flag) => flag.type),
    telemetry: stage.telemetry,
    generationDiagnostics: stage.generationDiagnostics
  }]));
}

function isolateEvaluationFromDatabase() {
  const dbPath = require.resolve('../utils/db');
  const unavailable = async () => {
    throw new Error('Database access is unavailable inside the offline staged evaluation harness.');
  };
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: new Proxy({}, { get: () => unavailable })
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const caseNames = await findRealCases(options.cases);
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trinzo-staged-eval-'));
  isolateEvaluationFromDatabase();
  const router = require('../routes/api');
  const runSequence = router.stagedEvaluation?.runStagedSequenceForEvaluation;
  if (typeof runSequence !== 'function') throw new Error('Staged evaluation entry point is unavailable.');
  const stagedResults = new Map();

  try {
    for (const caseName of caseNames) {
      const caseDir = path.join(PACK_DIR, caseName);
      const transcript = await fs.readFile(path.join(caseDir, 'transcript.txt'), 'utf8');
      const result = await runSequence(transcript, {
        fileName: `${caseName}.txt`,
        contextMode: options.contextMode
      });
      stagedResults.set(caseName, result);
      await fs.writeFile(
        path.join(outputDir, `${caseName}.json`),
        JSON.stringify(result, null, 2),
        'utf8'
      );
    }

    const report = scorePrecomputed(outputDir, caseNames);
    report.summary.stagedContextMode = options.contextMode;
    report.summary.stageProviders = {};
    for (const caseReport of report.cases) {
      const staged = stagedResults.get(caseReport.case);
      caseReport.stagedDiagnostics = {
        stages: stageSummary(staged?.trace),
        deterministicActionInventoryCount: staged?.deterministicActionInventoryCount || 0,
        clientVisibleOutput: staged?.visibleOutput || {}
      };
      for (const stage of staged?.trace || []) {
        const provider = stage.provider || 'unknown';
        report.summary.stageProviders[provider] = (report.summary.stageProviders[provider] || 0) + 1;
      }
    }

    const rendered = JSON.stringify(report, null, 2);
    if (options.outputPath) {
      const resolved = path.resolve(options.outputPath);
      await fs.writeFile(resolved, `${rendered}\n`, 'utf8');
    }
    if (options.json) {
      process.stdout.write(`${rendered}\n`);
    } else {
      process.stdout.write(
        `Staged seven-case eval: mode=${options.contextMode}, passed=${report.summary.passedCases}/${report.summary.executedCases}\n`
      );
      for (const item of report.cases) {
        const evaluation = item.evaluation || {};
        const stages = item.stagedDiagnostics?.stages || {};
        process.stdout.write(
          `${item.case}: score=${evaluation.score ?? 0}, passed=${Boolean(evaluation.passed)}, ` +
          `topics=${stages.summary?.outputCount ?? 0}, discussion_cards=${stages.discussion?.outputCount ?? 0}, ` +
          `discussion_points=${stages.discussion?.outputPointCount ?? 0}, actions=${stages.actions?.outputCount ?? 0}, ` +
          `grounded_inventory=${item.stagedDiagnostics?.deterministicActionInventoryCount ?? 0}\n`
        );
        for (const failure of evaluation.failures || []) process.stdout.write(`  - ${failure}\n`);
      }
      if (options.outputPath) process.stdout.write(`Full JSON report: ${path.resolve(options.outputPath)}\n`);
    }
    process.exitCode = report.summary.failedCases ? 1 : 0;
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 2;
});
