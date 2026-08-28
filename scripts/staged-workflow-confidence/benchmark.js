#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../..');
const CORPUS_ROOT = path.join(__dirname, 'corpus-v2');
const DEFAULT_RESULTS_ROOT = path.join(ROOT, 'benchmark-results', 'staged-workflow-confidence');
const DEFAULT_BASE_URL = 'https://trinzo.virtual-hub.online';
const VERDICT_ORDER = { 'Light review': 0, 'Guided review': 1, 'Major edit': 2 };

function compact(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function ratio(numerator, denominator) { return denominator ? numerator / denominator : 1; }
function mean(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function round(value, places = 3) { return Number(Number(value || 0).toFixed(places)); }
function safeJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function supported(items) { return (items || []).filter((item) => item.support === 'transcript_supported'); }
function firstName(value) { return compact(value).toLowerCase().split(/\s+/)[0] || ''; }
function ownerCorrect(expected, generated) {
  const actual = compact(generated || 'Not stated');
  if (!actual || /^not stated$/i.test(actual)) return false;
  return firstName(expected) === firstName(actual);
}
function deadlineCorrect(expected, generated) {
  const target = compact(expected || 'Not stated').toLowerCase();
  const actual = compact(generated || 'Not stated').toLowerCase();
  if (target === 'not stated') return actual === 'not stated';
  return target === actual || actual.includes(target) || target.includes(actual);
}

function parseArgs(argv) {
  const options = {
    command: 'run',
    runs: 3,
    baseUrl: process.env.STAGED_BENCHMARK_BASE_URL || DEFAULT_BASE_URL,
    output: '',
    resume: '',
    caseId: '',
    cooldownMs: Number(process.env.STAGED_BENCHMARK_COOLDOWN_MS || 5000),
    reliabilityRetries: Number(process.env.STAGED_BENCHMARK_RELIABILITY_RETRIES || 3)
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (['run', 'validate', 'score'].includes(value) && index === 0) options.command = value;
    else if (value === '--runs') options.runs = Number(argv[++index]);
    else if (value === '--base-url') options.baseUrl = argv[++index];
    else if (value === '--output') options.output = argv[++index];
    else if (value === '--resume') options.resume = argv[++index];
    else if (value === '--case') options.caseId = argv[++index];
    else if (value === '--cooldown-ms') options.cooldownMs = Number(argv[++index]);
    else if (value === '--reliability-retries') options.reliabilityRetries = Number(argv[++index]);
    else if (value.startsWith('--runs=')) options.runs = Number(value.slice(7));
    else if (value.startsWith('--base-url=')) options.baseUrl = value.slice(11);
    else if (value.startsWith('--output=')) options.output = value.slice(9);
    else if (value.startsWith('--resume=')) options.resume = value.slice(9);
    else if (value.startsWith('--case=')) options.caseId = value.slice(7);
    else if (value.startsWith('--cooldown-ms=')) options.cooldownMs = Number(value.slice(14));
    else if (value.startsWith('--reliability-retries=')) options.reliabilityRetries = Number(value.slice(22));
    else if (index !== 0 || !['run', 'validate', 'score'].includes(value)) throw new Error(`Unknown argument: ${value}`);
  }
  if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 10) throw new Error('--runs must be between 1 and 10.');
  if (!Number.isFinite(options.cooldownMs) || options.cooldownMs < 0) throw new Error('--cooldown-ms must be zero or greater.');
  if (!Number.isInteger(options.reliabilityRetries) || options.reliabilityRetries < 0 || options.reliabilityRetries > 10) throw new Error('--reliability-retries must be between 0 and 10.');
  return options;
}

function loadCorpus() {
  const manifestPath = path.join(CORPUS_ROOT, 'manifest.json');
  const manifest = safeJson(manifestPath);
  const cases = manifest.cases.map((entry) => ({
    ...entry,
    transcript: fs.readFileSync(path.join(ROOT, entry.transcriptPath), 'utf8'),
    expected: safeJson(path.join(ROOT, entry.expectedV2Path))
  }));
  return { manifest, cases };
}

function validateCorpus({ manifest, cases }, { verifyCloud = false } = {}) {
  const errors = [];
  if (manifest.schemaVersion !== 1 || !manifest.corpusVersion) errors.push('Manifest schema/version is invalid.');
  if (cases.length !== 13) errors.push(`Expected 13 cases, found ${cases.length}.`);
  const seen = new Set();
  for (const item of cases) {
    const expected = item.expected;
    if (seen.has(item.caseId)) errors.push(`Duplicate case ${item.caseId}.`);
    seen.add(item.caseId);
    if (sha256(item.transcript) !== item.transcriptSha256 || item.transcriptSha256 !== expected.transcript.sha256) errors.push(`${item.caseId}: transcript checksum mismatch.`);
    if (expected.schemaVersion !== 2 || expected.corpusVersion !== manifest.corpusVersion) errors.push(`${item.caseId}: expected-v2 schema/version mismatch.`);
    if (expected.curation?.productionOutputSeen !== false) errors.push(`${item.caseId}: curation must not see production output.`);
    const sourceRows = new Map();
    for (const row of [...supported(expected.expected.summary.objectives), ...supported(expected.expected.discussionFacts), ...supported(expected.expected.actions)]) {
      if (!row.id || sourceRows.has(row.id)) errors.push(`${item.caseId}: duplicate or blank expectation id ${row.id}.`);
      sourceRows.set(row.id, row);
      if (!['critical', 'major', 'minor', undefined].includes(row.importance)) errors.push(`${item.caseId}/${row.id}: invalid importance.`);
      if (!row.evidence?.length) errors.push(`${item.caseId}/${row.id}: supported item has no evidence.`);
      for (const evidence of row.evidence || []) {
        if (!evidence.sourceId || !evidence.speaker || !evidence.quote || !item.transcript.includes(evidence.quote)) {
          errors.push(`${item.caseId}/${row.id}: evidence does not resolve exactly in transcript.`);
        }
      }
    }
    for (const action of expected.expected.actions || []) {
      if (!['transcript_supported', 'contextual_human_value', 'review_pending'].includes(action.support)) errors.push(`${item.caseId}/${action.id}: invalid support.`);
      if (!['explicit_commitment', 'accepted_proposal', 'ongoing_work', 'unresolved_prerequisite'].includes(action.basis)) errors.push(`${item.caseId}/${action.id}: invalid action basis.`);
    }
    if (verifyCloud && (!item.remote?.expectedSha256 || !item.remote?.docxSha256)) errors.push(`${item.caseId}: cloud checksums are absent.`);
  }
  return { ok: !errors.length, errors, caseCount: cases.length, corpusVersion: manifest.corpusVersion };
}

async function verifyCloudAssets({ manifest, cases }) {
  const errors = [];
  for (const item of cases) {
    const base = `${manifest.remoteRoot}/${encodeURIComponent(item.remote.folder)}`;
    for (const [label, filename, expectedHash] of [
      ['expected', 'expected.json', item.remote.expectedSha256],
      ['docx', item.expected.transcript.sourceDocument, item.remote.docxSha256]
    ]) {
      const response = await fetch(`${base}/${encodeURIComponent(filename)}`);
      if (!response.ok) { errors.push(`${item.caseId}: cloud ${label} returned ${response.status}.`); continue; }
      const actual = sha256(Buffer.from(await response.arrayBuffer()));
      if (actual !== expectedHash) errors.push(`${item.caseId}: cloud ${label} checksum changed (${actual}).`);
    }
  }
  return { ok: !errors.length, errors, checkedAssets: cases.length * 2 };
}

function semanticMatrices(requests) {
  if (!requests.length) return new Map();
  const run = spawnSync(process.env.PYTHON_BIN || 'python3', [path.join(__dirname, 'semantic_matrix.py')], {
    cwd: ROOT,
    input: JSON.stringify({ requests }),
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    timeout: 600000
  });
  if (run.status !== 0 || !run.stdout.trim()) throw new Error(run.stderr.trim() || 'Semantic matrix bridge failed.');
  const payload = JSON.parse(run.stdout.trim().split('\n').pop());
  if (!payload.ok) throw new Error(`Semantic matrix unavailable: ${payload.reason}`);
  return new Map(payload.results.map((result) => [result.id, result.matrix]));
}

// Hungarian minimum-cost assignment over a padded square matrix, converted from maximum similarity.
function oneToOneAssignment(matrix) {
  const rows = matrix.length;
  const columns = Math.max(0, ...matrix.map((row) => row.length));
  const size = Math.max(rows, columns);
  if (!size) return [];
  const maxScore = Math.max(1, ...matrix.flat());
  const cost = Array.from({ length: size }, (_, i) => Array.from({ length: size }, (_, j) => maxScore - Number(matrix[i]?.[j] || 0)));
  const u = Array(size + 1).fill(0), v = Array(size + 1).fill(0), p = Array(size + 1).fill(0), way = Array(size + 1).fill(0);
  for (let i = 1; i <= size; i += 1) {
    p[0] = i;
    let j0 = 0;
    const minv = Array(size + 1).fill(Infinity), used = Array(size + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity, j1 = 0;
      for (let j = 1; j <= size; j += 1) if (!used[j]) {
        const current = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (current < minv[j]) { minv[j] = current; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= size; j += 1) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0]; p[j0] = p[j1]; j0 = j1;
    } while (j0 !== 0);
  }
  const pairs = [];
  for (let column = 1; column <= size; column += 1) {
    const row = p[column] - 1, col = column - 1;
    if (row >= 0 && row < rows && col < columns) pairs.push({ left: row, right: col, similarity: Number(matrix[row]?.[col] || 0) });
  }
  return pairs;
}

function matchCollection(expected, generated, matrix, threshold) {
  const assignments = oneToOneAssignment(matrix).filter((pair) => pair.similarity >= threshold);
  const leftMatched = new Set(assignments.map((pair) => pair.left));
  const rightMatched = new Set(assignments.map((pair) => pair.right));
  return {
    matched: assignments.length,
    expectedTotal: expected.length,
    generatedTotal: generated.length,
    recall: round(ratio(assignments.length, expected.length)),
    precision: round(ratio(assignments.length, generated.length)),
    pairs: assignments.map((pair) => ({
      expectedIndex: pair.left, generatedIndex: pair.right, similarity: pair.similarity,
      expected: expected[pair.left], generated: generated[pair.right]
    })),
    missing: expected.filter((_, index) => !leftMatched.has(index)),
    unsupported: generated.filter((_, index) => !rightMatched.has(index))
  };
}

function screen(payload, key) { return payload.ui?.screens?.find((item) => item.key === key)?.data || (key === 'summary' ? {} : []); }
function extractOutput(payload) {
  const discussion = screen(payload, 'discussion');
  return {
    details: screen(payload, 'details'),
    summary: screen(payload, 'summary'),
    discussion,
    discussionPoints: discussion.flatMap((card, cardIndex) => (card.points || []).map((point) => ({ text: typeof point === 'string' ? point : point.text, topic: card.topic, cardIndex }))),
    actions: screen(payload, 'actions')
  };
}

function extractReliability(record) {
  const trace = record.payload.diagnostics?.trace || [];
  const stages = trace.map((stage) => {
    const simplified = stage.telemetry?.simplifiedPipeline || {};
    const usage = stage.telemetry?.trooper?.usage || {};
    return {
      stage: stage.stage,
      provider: stage.provider || 'unknown',
      fallbackUsed: Boolean(stage.fallbackUsed || simplified.fallback),
      fallbackReason: compact(stage.fallbackReason || simplified.reason),
      timingMs: Number(simplified.timingMs || stage.timingMs || stage.durationMs || 0),
      promptTokens: Number(usage.prompt_tokens || usage.promptTokens || 0),
      completionTokens: Number(usage.completion_tokens || usage.completionTokens || 0),
      totalTokens: Number(usage.total_tokens || usage.totalTokens || 0)
    };
  });
  const denoiser = trace.map((stage) => stage.telemetry?.simplifiedPipeline?.denoiser).find(Boolean) || null;
  return {
    durationMs: Number(record.durationMs || 0),
    totalTokens: stages.reduce((sum, stage) => sum + stage.totalTokens, 0),
    promptTokens: stages.reduce((sum, stage) => sum + stage.promptTokens, 0),
    completionTokens: stages.reduce((sum, stage) => sum + stage.completionTokens, 0),
    denoiser: denoiser ? {
      used: Boolean(denoiser.used),
      totalUnitCount: Number(denoiser.totalUnitCount || 0),
      keptUnitCount: Number(denoiser.keptUnitCount || 0),
      removedUnitCount: Number(denoiser.removedUnitCount || 0),
      removedRatio: round(denoiser.removedRatio || 0),
      counts: denoiser.counts || {},
      cacheHit: Boolean(denoiser.cacheHit)
    } : null,
    stages,
    fallbacks: stages.filter((stage) => stage.fallbackUsed).map((stage) => ({
      stage: stage.stage,
      reason: stage.fallbackReason || 'No reason supplied'
    }))
  };
}

function calibrationRequest(cases) {
  const rows = cases.flatMap((item) => supported(item.expected.expected.discussionFacts).map((fact) => ({ caseId: item.caseId, text: fact.text })));
  return { id: 'calibration::cross_case', left: rows.map((item) => item.text), right: rows.map((item) => item.text), rows };
}

function calibrateThreshold(matrix, rows) {
  const negatives = [];
  for (let left = 0; left < rows.length; left += 1) for (let right = 0; right < rows.length; right += 1) {
    if (rows[left].caseId !== rows[right].caseId) negatives.push(Number(matrix[left]?.[right] || 0));
  }
  negatives.sort((a, b) => a - b);
  const percentile = negatives[Math.max(0, Math.ceil(negatives.length * 0.99) - 1)] || 0.6;
  const threshold = Math.min(0.75, Math.max(0.60, percentile + 0.001));
  return { threshold: round(threshold, 4), targetFalsePositiveRate: 0.01, observedCrossMeetingFalsePositiveRate: round(ratio(negatives.filter((score) => score >= threshold).length, negatives.length), 4), negativePairCount: negatives.length };
}

function requestSet(cases, records) {
  const requests = [];
  const calibration = calibrationRequest(cases);
  requests.push({ id: calibration.id, left: calibration.left, right: calibration.right });
  for (const record of records) {
    const item = cases.find((entry) => entry.caseId === record.caseId);
    const output = extractOutput(record.payload);
    const expected = item.expected.expected;
    requests.push(
      { id: `${record.id}::objectives`, left: supported(expected.summary.objectives).map((row) => row.text), right: output.summary.objectives || [] },
      { id: `${record.id}::discussion`, left: supported(expected.discussionFacts).map((row) => row.text), right: output.discussionPoints.map((row) => row.text) },
      { id: `${record.id}::actions`, left: supported(expected.actions).map((row) => row.action), right: output.actions.map((row) => row.action) },
      { id: `${record.id}::action_duplicates`, left: output.actions.map((row) => row.action), right: output.actions.map((row) => row.action) },
      { id: `${record.id}::negative_actions`, left: (expected.negativeControls || []).flatMap((row) => (row.evidence || []).map((ev) => ev.quote)), right: output.actions.map((row) => row.action) }
    );
  }
  return { requests, calibration };
}

function classifyVerdict(metrics) {
  if (metrics.criticalFalseClaims > 0 || metrics.negativeControlActions > 0 || metrics.actions.recall < 0.60) return 'Major edit';
  if (metrics.discussion.criticalRecall >= 0.90 && metrics.actions.recall >= 0.80 && metrics.actions.precision >= 0.90 && metrics.reviewerEffort.substantiveCorrections <= 3) return 'Light review';
  return 'Guided review';
}

function scoreRecords(corpus, records, options = {}) {
  const { requests, calibration: calibrationData } = requestSet(corpus.cases, records);
  const matrices = semanticMatrices(requests);
  const calibration = calibrateThreshold(matrices.get(calibrationData.id), calibrationData.rows);
  const threshold = calibration.threshold;
  const scored = records.map((record) => {
    const item = corpus.cases.find((entry) => entry.caseId === record.caseId);
    const expected = item.expected.expected;
    const output = extractOutput(record.payload);
    const objectivesExpected = supported(expected.summary.objectives);
    const factsExpected = supported(expected.discussionFacts);
    const actionsExpected = supported(expected.actions);
    const objectives = matchCollection(objectivesExpected, output.summary.objectives || [], matrices.get(`${record.id}::objectives`) || [], threshold);
    const discussion = matchCollection(factsExpected, output.discussionPoints, matrices.get(`${record.id}::discussion`) || [], threshold);
    const actions = matchCollection(actionsExpected, output.actions, matrices.get(`${record.id}::actions`) || [], threshold);
    const criticalFacts = factsExpected.filter((row) => row.importance === 'critical');
    const matchedCriticalFacts = discussion.pairs.filter((pair) => pair.expected.importance === 'critical').length;
    discussion.criticalRecall = round(ratio(matchedCriticalFacts, criticalFacts.length));
    const uncertaintyErrors = discussion.pairs.filter((pair) => pair.expected.preserveUncertainty && !/\b(?:may|might|could|expected|likely|anticipated|uncertain|question|whether)\b/i.test(pair.generated.text)).length;
    const ownerErrors = actions.pairs.filter((pair) => !ownerCorrect(pair.expected.owner, pair.generated.owner)).length;
    const deadlineErrors = actions.pairs.filter((pair) => !deadlineCorrect(pair.expected.deadline, pair.generated.deadline)).length;
    const duplicateMatrix = matrices.get(`${record.id}::action_duplicates`) || [];
    let duplicates = 0;
    for (let left = 0; left < duplicateMatrix.length; left += 1) for (let right = left + 1; right < duplicateMatrix.length; right += 1) if (duplicateMatrix[left]?.[right] >= 0.82) duplicates += 1;
    const negativeMatrix = matrices.get(`${record.id}::negative_actions`) || [];
    let negativeControlActions = 0;
    for (const row of negativeMatrix) if (row.some((score) => score >= Math.max(0.72, threshold))) negativeControlActions += 1;
    if (!actionsExpected.length && output.actions.length) negativeControlActions += output.actions.length;
    const topicMoves = discussion.pairs.filter((pair) => {
      const families = pair.expected.acceptableTopicFamilies || [];
      const topic = compact(pair.generated.topic).toLowerCase();
      return families.length && !families.some((family) => {
        const words = compact(family).toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 3);
        return words.some((word) => topic.includes(word));
      });
    }).length;
    const unassigned = output.discussion.filter((card) => /^unassigned$/i.test(compact(card.topic))).reduce((sum, card) => sum + (card.points || []).length, 0);
    const substantiveCorrections = discussion.missing.length + discussion.unsupported.length + actions.missing.length + actions.unsupported.length + ownerErrors + deadlineErrors + topicMoves + uncertaintyErrors;
    const metrics = {
      details: {
        meetingTypeCorrect: compact(output.details.meetingType).toLowerCase() === compact(expected.details.meetingType).toLowerCase(),
        meetingTitleCorrect: compact(output.details.meetingTitle).toLowerCase() === compact(expected.details.meetingTitle).toLowerCase()
      },
      summary: { objectives, unsupportedClaimCount: objectives.unsupported.length },
      discussion: { ...discussion, uncertaintyErrors, crossTopicLeakage: topicMoves, unassignedPointCount: unassigned },
      actions: { ...actions, ownerErrors, deadlineErrors, duplicateCount: duplicates },
      negativeControlActions,
      criticalFalseClaims: negativeControlActions,
      reviewerEffort: {
        missingItemsToAdd: discussion.missing.length + actions.missing.length,
        unsupportedItemsToRemove: discussion.unsupported.length + actions.unsupported.length,
        pointsToMove: topicMoves,
        substantiveWordingCorrections: uncertaintyErrors,
        ownerCorrections: ownerErrors,
        deadlineCorrections: deadlineErrors,
        topicRenames: 0,
        substantiveCorrections
      },
      reliability: {
        warningCount: record.payload.reviewExperience?.warningCount || 0,
        blockingCount: record.payload.reviewExperience?.blockingCount || 0,
        readyForFinalApproval: Boolean(record.payload.reviewExperience?.readyForFinalApproval),
        ...extractReliability(record)
      }
    };
    metrics.verdict = classifyVerdict(metrics);
    return { id: record.id, caseId: record.caseId, run: record.run, durationMs: record.durationMs, metrics };
  });
  const selectedCaseIds = new Set(Array.isArray(options.caseIds) ? options.caseIds : []);
  const byCase = corpus.cases.filter((item) => !selectedCaseIds.size || selectedCaseIds.has(item.caseId)).map((item) => {
    const runs = scored.filter((row) => row.caseId === item.caseId);
    const actionExpectations = supported(item.expected.expected.actions);
    const stability = actionExpectations.map((action) => ({
      id: action.id,
      action: action.action,
      recoveredRuns: runs.filter((run) => run.metrics.actions.pairs.some((pair) => pair.expected.id === action.id)).length,
      totalRuns: runs.length
    }));
    const verdict = runs.reduce((worst, run) => VERDICT_ORDER[run.metrics.verdict] > VERDICT_ORDER[worst] ? run.metrics.verdict : worst, 'Light review');
    return {
      caseId: item.caseId,
      verdict,
      runs: runs.length,
      discussionRecall: { mean: round(mean(runs.map((run) => run.metrics.discussion.recall))), min: round(Math.min(...runs.map((run) => run.metrics.discussion.recall))) },
      actionRecall: { mean: round(mean(runs.map((run) => run.metrics.actions.recall))), min: round(Math.min(...runs.map((run) => run.metrics.actions.recall))) },
      actionPrecision: { mean: round(mean(runs.map((run) => run.metrics.actions.precision))), min: round(Math.min(...runs.map((run) => run.metrics.actions.precision))) },
      estimatedSubstantiveCorrections: round(mean(runs.map((run) => run.metrics.reviewerEffort.substantiveCorrections)), 1),
      reliability: {
        fallbackStages: runs.reduce((sum, run) => sum + run.metrics.reliability.fallbacks.length, 0),
        fallbackRuns: runs.filter((run) => run.metrics.reliability.fallbacks.length).length,
        simplifiedRuns: runs.filter((run) => !run.metrics.reliability.fallbacks.length).length,
        durationMsMean: Math.round(mean(runs.map((run) => run.metrics.reliability.durationMs))),
        totalTokensMean: Math.round(mean(runs.map((run) => run.metrics.reliability.totalTokens)))
      },
      stability
    };
  });
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    corpusVersion: corpus.manifest.corpusVersion,
    calibration,
    runCount: scored.length,
    servingRevision: records[0]?.servingRevision || records[0]?.payload?.diagnostics?.servingRevision || null,
    summary: {
      caseCount: byCase.length,
      verdicts: Object.fromEntries(Object.keys(VERDICT_ORDER).map((verdict) => [verdict, byCase.filter((row) => row.verdict === verdict).length])),
      discussionRecallMean: round(mean(scored.map((run) => run.metrics.discussion.recall))),
      actionRecallMean: round(mean(scored.map((run) => run.metrics.actions.recall))),
      actionPrecisionMean: round(mean(scored.map((run) => run.metrics.actions.precision))),
      totalFallbacks: scored.reduce((sum, run) => sum + run.metrics.reliability.fallbacks.length, 0),
      fallbackRuns: scored.filter((run) => run.metrics.reliability.fallbacks.length).length,
      simplifiedRuns: scored.filter((run) => !run.metrics.reliability.fallbacks.length).length,
      totalNegativeControlActions: scored.reduce((sum, run) => sum + run.metrics.negativeControlActions, 0),
      durationMs: {
        mean: Math.round(mean(scored.map((run) => run.metrics.reliability.durationMs))),
        min: Math.min(...scored.map((run) => run.metrics.reliability.durationMs)),
        max: Math.max(...scored.map((run) => run.metrics.reliability.durationMs))
      },
      tokenUsage: {
        mean: Math.round(mean(scored.map((run) => run.metrics.reliability.totalTokens))),
        total: scored.reduce((sum, run) => sum + run.metrics.reliability.totalTokens, 0)
      },
      denoiser: {
        runsUsed: scored.filter((run) => run.metrics.reliability.denoiser?.used).length,
        removedUnits: scored.reduce((sum, run) => sum + (run.metrics.reliability.denoiser?.removedUnitCount || 0), 0),
        totalUnits: scored.reduce((sum, run) => sum + (run.metrics.reliability.denoiser?.totalUnitCount || 0), 0)
      }
    },
    cases: byCase,
    runs: scored
  };
}

function escapeHtml(value) { return compact(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character])); }
function renderDashboard(report, previous = null) {
  const rows = report.cases.map((item) => `<tr><td><a href="#${escapeHtml(item.caseId)}">${escapeHtml(item.caseId)}</a></td><td class="${item.verdict.replace(/\s/g, '-').toLowerCase()}">${item.verdict}</td><td>${item.discussionRecall.mean} / ${item.discussionRecall.min}</td><td>${item.actionRecall.mean} / ${item.actionRecall.min}</td><td>${item.actionPrecision.mean} / ${item.actionPrecision.min}</td><td>${item.estimatedSubstantiveCorrections}</td><td>${item.reliability?.fallbackRuns || 0}/${item.runs}</td></tr>`).join('');
  const unstable = report.cases.flatMap((item) => item.stability.filter((action) => action.recoveredRuns !== action.totalRuns).map((action) => `<li><strong>${escapeHtml(item.caseId)}</strong>: ${escapeHtml(action.action)} — ${action.recoveredRuns}/${action.totalRuns} runs</li>`)).join('') || '<li>None.</li>';
  const comparison = previous?.summary
    ? `<p>Previous revision: <code>${escapeHtml(previous.servingRevision || 'unknown')}</code>; action recall ${previous.summary.actionRecallMean} → ${report.summary.actionRecallMean}; precision ${previous.summary.actionPrecisionMean} → ${report.summary.actionPrecisionMean}.</p>`
    : '<p>No earlier compatible report was supplied.</p>';
  const details = report.cases.map((item) => {
    const runs = (report.runs || []).filter((run) => run.caseId === item.caseId);
    const runRows = runs.map((run) => `<tr><td>${run.run}</td><td>${run.metrics.discussion.recall}</td><td>${run.metrics.actions.recall}</td><td>${run.metrics.actions.precision}</td><td>${run.metrics.actions.ownerErrors}</td><td>${run.metrics.actions.deadlineErrors}</td><td>${run.metrics.reliability.fallbacks.map((row) => `${escapeHtml(row.stage)}: ${escapeHtml(row.reason)}`).join('<br>') || 'None'}</td><td>${Math.round(run.metrics.reliability.durationMs / 1000)}s / ${run.metrics.reliability.totalTokens}</td></tr>`).join('');
    const missing = runs.flatMap((run) => run.metrics.actions.missing.map((action) => `<li>Run ${run.run}: ${escapeHtml(action.action)}</li>`)).join('') || '<li>None.</li>';
    const unsupported = runs.flatMap((run) => run.metrics.actions.unsupported.map((action) => `<li>Run ${run.run}: ${escapeHtml(action.action)} <small>(${escapeHtml(action.owner)} · ${escapeHtml(action.deadline)})</small></li>`)).join('') || '<li>None.</li>';
    const pairs = runs.flatMap((run) => run.metrics.actions.pairs.map((pair) => `<tr><td>${run.run}</td><td>${escapeHtml(pair.expected.action)}</td><td>${escapeHtml(pair.generated.action)}</td><td>${round(pair.similarity)}</td><td>${escapeHtml(pair.generated.owner)} / ${escapeHtml(pair.generated.deadline)}</td></tr>`)).join('') || '<tr><td colspan="5">No action matches.</td></tr>';
    return `<details id="${escapeHtml(item.caseId)}"><summary><strong>${escapeHtml(item.caseId)}</strong> — ${item.verdict}; ${item.reliability.fallbackRuns}/${item.runs} runs used fallback</summary><table><thead><tr><th>Run</th><th>Discussion recall</th><th>Action recall</th><th>Action precision</th><th>Owner errors</th><th>Deadline errors</th><th>Fallback</th><th>Latency / tokens</th></tr></thead><tbody>${runRows}</tbody></table><h3>Missing expected actions</h3><ul>${missing}</ul><h3>Unsupported generated actions</h3><ul>${unsupported}</ul><h3>One-to-one action matches</h3><table><thead><tr><th>Run</th><th>Expected</th><th>Generated</th><th>Similarity</th><th>Generated owner / deadline</th></tr></thead><tbody>${pairs}</tbody></table></details>`;
  }).join('');
  const reliability = { calibration: report.calibration, verdicts: report.summary.verdicts, fallbackStages: report.summary.totalFallbacks, fallbackRuns: report.summary.fallbackRuns, simplifiedRuns: report.summary.simplifiedRuns, durationMs: report.summary.durationMs, tokenUsage: report.summary.tokenUsage, denoiser: report.summary.denoiser };
  return `<!doctype html><html><head><meta charset="utf-8"><title>Staged workflow confidence</title><style>body{font:15px system-ui;margin:2rem;color:#17222c;max-width:1500px}h1{margin-bottom:.2rem}.cards{display:flex;gap:1rem;flex-wrap:wrap}.card{padding:1rem;border:1px solid #ccd7df;border-radius:10px;min-width:150px}table{border-collapse:collapse;width:100%;margin-top:1rem}th,td{padding:.55rem;border-bottom:1px solid #dde5ea;text-align:left;vertical-align:top}.light-review{color:#087443}.guided-review{color:#9a6100}.major-edit{color:#b42318}code{background:#eef3f6;padding:.15rem .3rem}details{margin:1rem 0;padding:.5rem;border:1px solid #dde5ea;border-radius:8px}small{color:#52616d}</style></head><body><h1>Thirteen-transcript workflow confidence</h1><p>Corpus ${escapeHtml(report.corpusVersion)} · deployed revision <code>${escapeHtml(report.servingRevision || 'unknown')}</code> · ${report.runCount} complete runs · threshold ${report.calibration.threshold}</p><div class="cards"><div class="card"><strong>Discussion recall</strong><br>${report.summary.discussionRecallMean}</div><div class="card"><strong>Action recall</strong><br>${report.summary.actionRecallMean}</div><div class="card"><strong>Action precision</strong><br>${report.summary.actionPrecisionMean}</div><div class="card"><strong>Fallback runs</strong><br>${report.summary.fallbackRuns || 0}/${report.runCount}</div><div class="card"><strong>Fallback stages</strong><br>${report.summary.totalFallbacks}</div><div class="card"><strong>Negative controls</strong><br>${report.summary.totalNegativeControlActions}</div></div><h2>Per-meeting result</h2><p>Recall and precision cells show mean / worst run. Verdicts follow the published bands; fallback failures are additionally reported as reliability failures.</p><table><thead><tr><th>Meeting</th><th>Verdict</th><th>Discussion recall</th><th>Action recall</th><th>Action precision</th><th>Estimated corrections</th><th>Fallback runs</th></tr></thead><tbody>${rows}</tbody></table><h2>Meeting evidence and errors</h2>${details}<h2>Unstable actions</h2><ul>${unstable}</ul><h2>Revision comparison</h2>${comparison}<details><summary>Calibration, model usage and reliability</summary><pre>${escapeHtml(JSON.stringify(reliability, null, 2))}</pre></details><p>The accompanying report.json contains every discussion and action match, missing item, unsupported item, owner/deadline error, topic-grouping metric, denoiser count and review-effort count.</p></body></html>`;
}

async function login(baseUrl) {
  if (process.env.STAGED_BENCHMARK_COOKIE) return process.env.STAGED_BENCHMARK_COOKIE;
  const email = process.env.STAGED_BENCHMARK_EMAIL;
  const password = process.env.STAGED_BENCHMARK_PASSWORD;
  if (!email || !password) throw new Error('Set STAGED_BENCHMARK_EMAIL and STAGED_BENCHMARK_PASSWORD, or STAGED_BENCHMARK_COOKIE.');
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password })
  });
  if (!response.ok) throw new Error(`Benchmark login failed with status ${response.status}.`);
  const cookie = response.headers.get('set-cookie');
  if (!cookie) throw new Error('Benchmark login returned no session cookie.');
  return cookie.split(';')[0];
}

function validateMirrorPayload(payload, status, expectedRevision = '') {
  if (status < 200 || status >= 300 || !payload?.ok || payload.contractVersion !== 'staged-meeting-minutes-ui-mirror-v2') {
    throw new Error(`Malformed UI-mirror response (${status}).`);
  }
  const traceRevisions = [...new Set((payload.diagnostics?.trace || []).map((stage) => compact(stage?.pipelineHealth?.revision)).filter(Boolean))];
  const revision = compact(payload.diagnostics?.servingRevision) || (traceRevisions.length === 1 ? traceRevisions[0] : '');
  if (!revision) throw new Error('Deployed UI mirror did not identify its serving revision.');
  if (expectedRevision && expectedRevision !== revision) throw new Error(`Serving revision changed during benchmark: ${expectedRevision} -> ${revision}.`);
  return revision;
}

function simplifiedFallbackReasons(payload) {
  return (payload?.diagnostics?.trace || [])
    .filter((stage) => ['discussion', 'actions'].includes(stage.stage) && stage.telemetry?.simplifiedPipeline?.fallback)
    .map((stage) => compact(stage.telemetry?.simplifiedPipeline?.reason));
}

async function runRemote(options, corpus, outputDir) {
  const cookie = await login(options.baseUrl);
  const rawDir = path.join(outputDir, 'raw');
  await fsp.mkdir(rawDir, { recursive: true });
  const checkpointPath = path.join(outputDir, 'checkpoint.json');
  let checkpoint = fs.existsSync(checkpointPath) ? safeJson(checkpointPath) : { schemaVersion: 1, corpusVersion: corpus.manifest.corpusVersion, baseUrl: options.baseUrl, servingRevision: null, completed: [] };
  const records = [];
  for (let run = 1; run <= options.runs; run += 1) {
    const offset = ((run - 1) * 4) % corpus.cases.length;
    const order = [...corpus.cases.slice(offset), ...corpus.cases.slice(0, offset)];
    for (const item of order) {
      const id = `run-${String(run).padStart(2, '0')}::${item.caseId}`;
      const file = path.join(rawDir, `run-${String(run).padStart(2, '0')}`, `${item.caseId}.json`);
      if (checkpoint.completed.includes(id) && fs.existsSync(file)) {
        const saved = safeJson(file); records.push(saved); continue;
      }
      let saved = null;
      for (let attempt = 1; attempt <= options.reliabilityRetries + 1; attempt += 1) {
        const started = Date.now();
        const form = new FormData(); form.append('text', item.transcript); form.append('includeDiagnostics', '1');
        const response = await fetch(`${options.baseUrl.replace(/\/$/, '')}/api/staged-meeting-minutes/ui-mirror?includeDiagnostics=1`, { method: 'POST', headers: { cookie }, body: form });
        const payload = await response.json().catch(() => null);
        let revision;
        try { revision = validateMirrorPayload(payload, response.status, checkpoint.servingRevision); }
        catch (error) { throw new Error(`${id}: ${error.message}`); }
        const reasons = simplifiedFallbackReasons(payload);
        if (reasons.length) {
          const attemptPath = path.join(outputDir, 'reliability-attempts', `run-${String(run).padStart(2, '0')}`, item.caseId, `attempt-${String(attempt).padStart(2, '0')}.json`);
          await fsp.mkdir(path.dirname(attemptPath), { recursive: true });
          await fsp.writeFile(attemptPath, `${JSON.stringify({ id, attempt, durationMs: Date.now() - started, servingRevision: revision, reasons, payload }, null, 2)}\n`, 'utf8');
          const transient = reasons.every((reason) => /status (?:422|429|500|502|503|504)|rate.?limit|json_generation_failed/i.test(reason));
          if (transient && attempt <= options.reliabilityRetries) {
            process.stderr.write(`${id}: reliability retry ${attempt}/${options.reliabilityRetries} after ${reasons.join('; ')}\n`);
            await new Promise((resolve) => setTimeout(resolve, Math.max(options.cooldownMs, 15000 * attempt)));
            continue;
          }
          throw new Error(`${id}: simplified pipeline fallback remained after ${attempt} attempt(s): ${reasons.join('; ')}`);
        }
        saved = { id, caseId: item.caseId, run, durationMs: Date.now() - started, receivedAt: new Date().toISOString(), transcriptSha256: item.transcriptSha256, servingRevision: revision, payload };
        break;
      }
      if (!saved) throw new Error(`${id}: no clean benchmark response was produced.`);
      checkpoint.servingRevision = saved.servingRevision;
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, `${JSON.stringify(saved, null, 2)}\n`, 'utf8');
      checkpoint.completed.push(id);
      await fsp.writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8');
      records.push(saved);
      process.stderr.write(`${id}: ${saved.durationMs}ms, revision ${saved.servingRevision}\n`);
      if (options.cooldownMs) await new Promise((resolve) => setTimeout(resolve, options.cooldownMs));
    }
  }
  return records;
}

function loadRecords(outputDir) {
  const rawDir = path.join(outputDir, 'raw');
  const files = [];
  function walk(directory) { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) entry.isDirectory() ? walk(path.join(directory, entry.name)) : entry.name.endsWith('.json') && files.push(path.join(directory, entry.name)); }
  walk(rawDir);
  return files.sort().map(safeJson);
}

async function writeReport(outputDir, report) {
  const reportPath = path.join(outputDir, 'report.json');
  const htmlPath = path.join(outputDir, 'report.html');
  if (fs.existsSync(reportPath) || fs.existsSync(htmlPath)) throw new Error('Refusing to overwrite immutable benchmark report. Use a new output directory.');
  let previous = null;
  const parent = path.dirname(outputDir);
  if (fs.existsSync(parent)) {
    const candidate = fs.readdirSync(parent).map((name) => path.join(parent, name, 'report.json')).filter((file) => file !== reportPath && fs.existsSync(file)).sort().pop();
    if (candidate) previous = safeJson(candidate);
  }
  await fsp.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await fsp.writeFile(htmlPath, renderDashboard(report, previous), 'utf8');
  return { reportPath, htmlPath };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const corpus = loadCorpus();
  const validation = validateCorpus(corpus, { verifyCloud: true });
  if (!validation.ok) throw new Error(`Corpus validation failed:\n- ${validation.errors.join('\n- ')}`);
  const cloud = options.command === 'score' || process.env.STAGED_BENCHMARK_SKIP_CLOUD === '1'
    ? { ok: true, skipped: true, errors: [] }
    : await verifyCloudAssets(corpus);
  if (!cloud.ok) throw new Error(`Cloud asset validation failed:\n- ${cloud.errors.join('\n- ')}`);
  if (options.command === 'validate') { console.log(JSON.stringify({ ...validation, cloud }, null, 2)); return; }
  const selectedCases = options.caseId
    ? corpus.cases.filter((item) => item.caseId === options.caseId)
    : corpus.cases;
  if (options.caseId && !selectedCases.length) throw new Error(`Unknown benchmark case: ${options.caseId}`);
  const runCorpus = { ...corpus, cases: selectedCases };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputDir = path.resolve(options.resume || options.output || path.join(DEFAULT_RESULTS_ROOT, stamp));
  await fsp.mkdir(outputDir, { recursive: true });
  const records = options.command === 'score' ? loadRecords(outputDir) : await runRemote(options, runCorpus, outputDir);
  const expectedRunCount = selectedCases.length * options.runs;
  if (records.length !== expectedRunCount) throw new Error(`Incomplete benchmark: ${records.length}/${expectedRunCount} records. No report was written.`);
  const revisions = new Set(records.map((record) => compact(record.servingRevision || record.payload?.diagnostics?.servingRevision)));
  if (revisions.size !== 1 || revisions.has('')) throw new Error(`Benchmark records span invalid revisions: ${[...revisions].join(', ')}`);
  const report = scoreRecords(corpus, records, { caseIds: selectedCases.map((item) => item.caseId) });
  const paths = await writeReport(outputDir, report);
  console.log(JSON.stringify({ ok: true, outputDir, ...paths, summary: report.summary }, null, 2));
}

module.exports = { loadCorpus, validateCorpus, verifyCloudAssets, semanticMatrices, oneToOneAssignment, matchCollection, calibrateThreshold, extractOutput, scoreRecords, classifyVerdict, renderDashboard, parseArgs, validateMirrorPayload, simplifiedFallbackReasons };
if (require.main === module) main().catch((error) => { console.error(error.stack || error.message || error); process.exitCode = 1; });
