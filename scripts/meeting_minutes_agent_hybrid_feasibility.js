'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const mammoth = require('mammoth');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const repo = path.join(__dirname, '..');
const priorRoot = path.join(repo, 'benchmark-results/meeting-minutes-agent-vs-staged/a91046f-2026-09-07/agent');
const corpusRoots = ['/srv/files/public/Transcripts', '/srv/files/public/NewTranscripts'];
const selection = (process.env.HYBRID_FEASIBILITY_CASES || '01_abbott_audit_kickoff,02_dita_importer_obligations,07_t761_eakin_tech_file_weekly,new_03_M211-rehearsal,13_parking_no_decision').split(',').map((value) => value.trim()).filter(Boolean);
const selected = new Set(selection);
const runAll = selected.has('all');
const concurrency = Math.max(1, Math.min(2, Number(process.env.HYBRID_FEASIBILITY_CONCURRENCY || 1)));
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
const outputRoot = process.env.HYBRID_FEASIBILITY_OUTPUT || path.join(repo, 'benchmark-results', 'meeting-minutes-agent-hybrid-v4-feasibility', `${commit.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}`);
const api = require(path.join(repo, 'routes/api')).stagedEvaluation;
const { prepareMiniLmTranscript } = require(path.join(repo, 'utils/stagedMiniLmTrooper'));
const {
  sanitiseDetails, normaliseSourceUnits, preparedTranscriptFromUnits, salientDetailInventory,
  applyProposal, isUsefulReviewFlag
} = require(path.join(repo, 'utils/meetingMinutesAgentV2'));

function findDocx(fileName) {
  for (const root of corpusRoots) {
    for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const candidate = path.join(root, dir.name, fileName);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error(`Source document not found: ${fileName}`);
}

function cases() {
  return fs.readdirSync(priorRoot).filter((name) => name.endsWith('.json')).sort().map((name) => {
    const prior = JSON.parse(fs.readFileSync(path.join(priorRoot, name), 'utf8'));
    return { id: prior.id, outputName: name, sourceFileName: prior.sourceFileName, sourcePath: findDocx(prior.sourceFileName), expected: prior.expected };
  }).filter((item) => runAll || selected.has(item.id));
}

function mergeFlags(...groups) {
  const byId = new Map();
  for (const flag of groups.flat().filter(isUsefulReviewFlag)) byId.set(flag.id || `${flag.kind}|${flag.message}`, flag);
  return [...byId.values()];
}

async function runCase(testCase, index, total) {
  const started = Date.now();
  console.log(`[${index}/${total}] PREP ${testCase.id}`);
  const rawTranscript = (await mammoth.extractRawText({ path: testCase.sourcePath })).value;
  const prepared = await prepareMiniLmTranscript(rawTranscript);
  const sourceUnits = normaliseSourceUnits(prepared.sourceUnits);
  const preparedTranscript = preparedTranscriptFromUnits(sourceUnits);
  let draft = {
    draftId: `feasibility-${testCase.id}`, revision: 1, fileName: testCase.sourceFileName,
    sourceUnits, preparedTranscript, salientDetails: salientDetailInventory(sourceUnits),
    details: sanitiseDetails(api.extractStagedDetailsFromTranscript(rawTranscript, testCase.sourceFileName).screens?.details || {}),
    discussion: [], actions: [], meetingObjectives: [], executiveSummary: '', reviewFlags: [],
    candidateLedger: [], passProvenance: [], qualityState: {}, currentStep: 0
  };
  if (typeof api.prewarmPrivateStagedCandidateLedgers === 'function') api.prewarmPrivateStagedCandidateLedgers(draft);
  const stages = {};
  for (const stage of ['discussion', 'actions', 'summary']) {
    console.log(`[${index}/${total}] ${stage.toUpperCase()} ${testCase.id}`);
    const stageStarted = Date.now();
    const result = await api.generateHybridMeetingAgentStage(draft, stage);
    draft = { ...draft, ...result.changes, reviewFlags: mergeFlags(draft.reviewFlags, result.reviewFlags) };
    const provenance = (result.changes.passProvenance || []).filter((item) => item.stage === stage);
    stages[stage] = {
      ok: true, attempts: provenance.flatMap((item) => item.timings || []), latencyMs: Date.now() - stageStarted,
      passes: provenance.map((item) => item.pass)
    };
  }
  const actionsIfAccepted = draft.pendingProposal?.changes?.length
    ? applyProposal(draft.actions, draft.pendingProposal, draft.pendingProposal.changes.map((change) => change.id))
    : draft.actions;
  const output = {
    benchmarkVersion: 4, testedCommit: commit, testedAt: new Date().toISOString(),
    id: testCase.id, sourceFileName: testCase.sourceFileName, expected: testCase.expected,
    details: draft.details,
    denoise: { rawLength: prepared.rawLength, preparedLength: preparedTranscript.length, sourceUnitCount: sourceUnits.length },
    stages,
    visible: {
      discussion: draft.discussion,
      actions: draft.actions,
      actionProposal: draft.pendingProposal,
      actionsIfAccepted,
      summary: { executiveSummary: draft.executiveSummary, meetingObjectives: draft.meetingObjectives.map((item) => item.text || item) }
    },
    reviewFlags: { final: draft.reviewFlags },
    // Keep the established comparison contract at the top level as well as the
    // screen-oriented `visible` block. This lets the same lexical and semantic
    // scorer compare compact and non-compact runs without bespoke adapters.
    ok: true,
    system: 'agent',
    discussion: draft.discussion,
    actions: draft.actions,
    actionsIfAccepted,
    meetingObjectives: draft.meetingObjectives,
    executiveSummary: draft.executiveSummary,
    proposals: draft.pendingProposal?.changes || [],
    evidence: {
      invalid: 0
    },
    attempts: Object.values(stages).flatMap((item) => item.attempts || []),
    timing: { totalLatencyMs: Date.now() - started },
    qualityState: draft.qualityState,
    diagnostics: {
      candidateLedger: draft.candidateLedger,
      passProvenance: draft.passProvenance
    },
    totalLatencyMs: Date.now() - started
  };
  fs.mkdirSync(outputRoot, { recursive: true });
  fs.writeFileSync(path.join(outputRoot, testCase.outputName), JSON.stringify(output, null, 2));
  console.log(`[${index}/${total}] DONE ${testCase.id} d=${draft.discussion.length} a=${draft.actions.length} p=${draft.pendingProposal?.changes?.length || 0} ${(output.totalLatencyMs / 1000).toFixed(1)}s`);
}

(async () => {
  const rows = cases();
  if (!rows.length) throw new Error('No feasibility cases selected.');
  let next = 0;
  async function worker() {
    while (next < rows.length) {
      const index = next;
      next += 1;
      await runCase(rows[index], index + 1, rows.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
  console.log(`RESULTS ${outputRoot}`);
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
