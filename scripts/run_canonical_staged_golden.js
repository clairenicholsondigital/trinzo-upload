'use strict';

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const mammoth = require('mammoth');
const { runCanonicalNoEditPass } = require('../utils/canonicalMinutes/runner');

const ROOT = path.resolve(__dirname, 'meeting-minutes-core-golden');

async function main() {
  const outputDirectory = process.argv[2] ? path.resolve(process.argv[2]) : await fs.mkdtemp(path.join(os.tmpdir(), 'canonical-staged-'));
  await fs.mkdir(outputDirectory, { recursive: true });
  const caseRoot = path.join(ROOT, 'cases');
  const caseNames = (await fs.readdir(caseRoot)).filter((name) => /^\d\d_/.test(name)).sort();
  const cases = [];
  for (const caseName of caseNames) {
    const caseDirectory = path.join(caseRoot, caseName);
    const { value } = await mammoth.extractRawText({ path: path.join(caseDirectory, 'transcript.docx') });
    const result = runCanonicalNoEditPass(value, { fileName: `${caseName}.docx` });
    const visible = result.visibleOutput;
    const normalised = {
      attendees: [...visible.participants.trinzo, ...visible.participants.client],
      client_attendees: visible.participants.client,
      actions: visible.actions.map((item) => ({ owner: item.meetingActionPointOwner, action: item.meetingActionPoint, deadline: item.meetingActionPointDeadline })),
      decisions: visible.decisions,
      risks: visible.risks
    };
    const outputPath = path.join(outputDirectory, `${caseName}.json`);
    await fs.writeFile(outputPath, `${JSON.stringify(normalised, null, 2)}\n`);
    const scored = spawnSync('python3', [path.join(ROOT, 'tools/score_output.py'), caseDirectory, outputPath], { encoding: 'utf8' });
    if (scored.status !== 0) throw new Error(scored.stderr || `Scoring failed for ${caseName}`);
    const score = JSON.parse(scored.stdout);
    cases.push({ caseName, score, extractionMode: result.metrics.extractionMode, topologyObservation: result.metrics.topologyObservation, counts: { actions: normalised.actions.length, decisions: normalised.decisions.length, risks: normalised.risks.length }, semanticLockPassed: result.audits.semanticLock.passed, completenessSuggestions: result.audits.completeness.suggestions.length, semanticCandidateCount: result.metrics.semanticCandidateCount, topicClusterCount: result.metrics.topicClusterCount, durationMs: result.metrics.durationMs });
  }
  const summary = {
    pipeline: 'canonical_staged_v2',
    cases: cases.length,
    meanScore: Math.round((cases.reduce((sum, item) => sum + item.score.score, 0) / cases.length) * 10) / 10,
    casesAtOrAbove75: cases.filter((item) => item.score.score >= 75).length,
    semanticLockPasses: cases.filter((item) => item.semanticLockPassed).length,
    extractionModes: cases.reduce((counts, item) => ({ ...counts, [item.extractionMode]: (counts[item.extractionMode] || 0) + 1 }), {}),
    modelCalls: cases.length,
    embeddingModel: cases.length ? 'sentence-transformers/all-MiniLM-L6-v2' : null
  };
  const report = { generatedAt: new Date().toISOString(), summary, cases };
  await fs.writeFile(path.join(outputDirectory, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stderr.write(`Outputs: ${outputDirectory}\n`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
