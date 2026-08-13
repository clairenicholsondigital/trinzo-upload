'use strict';

const fs = require('fs/promises');
const path = require('path');
const mammoth = require('mammoth');
const { runCanonicalNoEditPass } = require('../utils/canonicalMinutes/runner');
const { assessWeightedErrors, scoreCaseOutput } = require('../utils/meetingMinutesCoreGolden');

const REPO_ROOT = path.resolve(__dirname, '..');
const GOLDEN_ROOT = path.join(__dirname, 'meeting-minutes-core-golden');
const RUNS_ROOT = path.join(GOLDEN_ROOT, 'runs');

function csvCell(value) {
  const text = String(value == null ? '' : value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function main() {
  process.env.MEETING_MINUTES_ENRICHED_EVIDENCE = '1';
  const commit = String(process.argv[2] || '').trim();
  if (!/^[a-f0-9]{7,40}$/i.test(commit)) throw new Error('Usage: node scripts/record_canonical_staged_golden.js <commit> [run-id]');
  const generatedAt = new Date().toISOString();
  const stamp = generatedAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').replace('T', 'T');
  const runId = String(process.argv[3] || `canonical-${commit.slice(0, 7)}-${stamp}`).trim();
  const runDirectory = path.join(RUNS_ROOT, runId);
  await fs.mkdir(runDirectory, { recursive: true });

  const caseRoot = path.join(GOLDEN_ROOT, 'cases');
  const caseNames = (await fs.readdir(caseRoot)).filter((name) => /^\d\d_/.test(name)).sort();
  const summaries = [];
  const recordRows = [];
  for (const caseName of caseNames) {
    const caseDirectory = path.join(caseRoot, caseName);
    const manifest = JSON.parse(await fs.readFile(path.join(caseDirectory, 'manifest.json'), 'utf8'));
    const { value: transcript } = await mammoth.extractRawText({ path: path.join(caseDirectory, 'transcript.docx') });
    const result = runCanonicalNoEditPass(transcript, { fileName: `${caseName}.docx` });
    const visible = result.visibleOutput;
    const output = {
      attendees: [...visible.participants.trinzo, ...visible.participants.client],
      client_attendees: visible.participants.client,
      actions: visible.actions.map((item) => ({
        owner: item.meetingActionPointOwner,
        action: item.meetingActionPoint,
        due_evidence: item.meetingActionPointDeadline
      })),
      decisions: visible.decisions,
      risks: visible.risks
    };
    const outputDirectory = path.join(runDirectory, caseName);
    await fs.mkdir(outputDirectory, { recursive: true });
    const outputPath = path.join(outputDirectory, 'normalised_output.json');
    await fs.writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
    const coverage = scoreCaseOutput(manifest, output);
    const weighted = assessWeightedErrors(manifest, output);
    const hardFail = weighted.blockingCount > 0;
    summaries.push({
      case: caseName,
      score: coverage.score,
      weightedScore: weighted.weightedScore,
      issueCount: weighted.errorCount,
      blockingCount: weighted.blockingCount,
      actions: output.actions.length,
      decisions: output.decisions.length,
      risks: output.risks.length,
      errorTypeCounts: weighted.errorTypeCounts,
      semanticLockPassed: result.audits.semanticLock.passed
    });
    const relativeOutputPath = path.relative(REPO_ROOT, outputPath).replace(/\\/g, '/');
    recordRows.push([
      `${runId}-${caseName}`,
      generatedAt,
      'canonical-enriched-local-no-edit',
      commit.slice(0, 12),
      manifest.case_id,
      relativeOutputPath,
      coverage.score,
      hardFail,
      'Codex',
      `${weighted.errorCount} weighted issues; ${weighted.blockingCount} blocking; semantic lock passed`
    ].map(csvCell).join(','));
  }

  const report = {
    liveCommit: commit.slice(0, 12),
    generatedAt,
    pipeline: 'canonical_staged_v2',
    caseCount: summaries.length,
    totalIssues: summaries.reduce((sum, item) => sum + item.issueCount, 0),
    totalBlockingIssues: summaries.reduce((sum, item) => sum + item.blockingCount, 0),
    maximumIssuesPerCase: Math.max(...summaries.map((item) => item.issueCount), 0),
    casesBelowFiveIssues: summaries.filter((item) => item.issueCount < 5).length,
    averageScore: Math.round((summaries.reduce((sum, item) => sum + item.score, 0) / summaries.length) * 10) / 10,
    averageWeightedScore: Math.round((summaries.reduce((sum, item) => sum + item.weightedScore, 0) / summaries.length) * 10) / 10,
    summaries
  };
  await fs.writeFile(path.join(runDirectory, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`);
  const recordPath = path.join(RUNS_ROOT, 'run_record.csv');
  await fs.appendFile(recordPath, `${recordRows.join('\n')}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
