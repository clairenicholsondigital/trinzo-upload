#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

function percentile(values, percentileValue) {
  const ordered = (Array.isArray(values) ? values : [])
    .map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (!ordered.length) return null;
  const index = Math.max(0, Math.ceil((percentileValue / 100) * ordered.length) - 1);
  return ordered[index];
}

function distribution(values) {
  const rows = (Array.isArray(values) ? values : []).map(Number).filter(Number.isFinite);
  return {
    count: rows.length,
    p50: percentile(rows, 50),
    p90: percentile(rows, 90),
    p95: percentile(rows, 95),
    min: rows.length ? Math.min(...rows) : null,
    max: rows.length ? Math.max(...rows) : null
  };
}

function parseEvents(text) {
  return String(text || '').split(/\r?\n/).map((line) => {
    const start = line.indexOf('{');
    if (start < 0) return null;
    try { return JSON.parse(line.slice(start)); } catch { return null; }
  }).filter((item) => item && /^meeting_agent_/.test(item.event || ''));
}

function summariseEvents(events = []) {
  const passes = events.filter((event) => event.event === 'meeting_agent_pass');
  const stages = events.filter((event) => event.event === 'meeting_agent_stage_performance');
  const preparations = events.filter((event) => event.event === 'meeting_agent_preparation' && event.ok);
  const polls = events.filter((event) => event.event === 'meeting_agent_poll_observed');
  const byPass = {};
  for (const event of passes) {
    const key = `${event.stage || 'unknown'}:${event.pass || 'unknown'}`;
    if (!byPass[key]) byPass[key] = [];
    byPass[key].push(event);
  }
  const passSummary = Object.fromEntries(Object.entries(byPass).map(([key, rows]) => [key, {
    calls: rows.length,
    successCount: rows.filter((row) => row.ok).length,
    elapsedMs: distribution(rows.map((row) => row.elapsedMs)),
    promptChars: distribution(rows.map((row) => row.promptChars)),
    candidateCount: distribution(rows.map((row) => row.candidateCount)),
    retryCount: rows.reduce((sum, row) => sum + Math.max(0, Number(row.attempts || 0) - 1), 0),
    failureClasses: rows.filter((row) => !row.ok).reduce((counts, row) => {
      const name = row.failureClass || 'unclassified';
      counts[name] = (counts[name] || 0) + 1;
      return counts;
    }, {})
  }]));
  const stageNames = [...new Set(stages.map((event) => event.stage).filter(Boolean))];
  const stageSummary = Object.fromEntries(stageNames.map((stage) => {
    const rows = stages.filter((event) => event.stage === stage);
    const calls = rows.flatMap((row) => Array.isArray(row.calls) ? row.calls : []);
    return [stage, {
      runs: rows.length,
      processingElapsedMs: distribution(rows.map((row) => row.processingElapsedMs)),
      persistenceElapsedMs: distribution(rows.map((row) => row.persistenceElapsedMs)),
      totalElapsedMs: distribution(rows.map((row) => row.totalElapsedMs)),
      conflictCount: rows.reduce((sum, row) => sum + Number(row.conflictFieldCount || 0), 0),
      retryCount: rows.reduce((sum, row) => sum + Math.max(0, Number(row.persistenceAttemptCount || 1) - 1), 0),
      modelCallCount: calls.length,
      materialModelCallCount: calls.filter((call) => call.materiallyChangedFinalMinutes === true).length,
      materialContributionCount: calls.reduce((sum, call) =>
        sum + Math.max(0, Number(call.materialContributionCount || 0)), 0)
    }];
  }));
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    journeyCount: new Set(events.map((event) => event.journeyId).filter(Boolean)).size,
    preparation: {
      runs: preparations.length,
      preparationMs: distribution(preparations.map((row) => row.preparationMs)),
      persistenceMs: distribution(preparations.map((row) => row.persistenceMs)),
      totalElapsedMs: distribution(preparations.map((row) => row.totalElapsedMs))
    },
    stages: stageSummary,
    passes: passSummary,
    pollingOverheadMs: distribution(polls.map((row) => row.pollingOverheadMs))
  };
}

function evaluateReleaseGates(baseline = {}, candidate = {}, gates = {}) {
  const failures = [];
  const baselineAction = Number(baseline?.stages?.actions?.totalElapsedMs?.p50);
  const candidateAction = Number(candidate?.stages?.actions?.totalElapsedMs?.p50);
  const improvement = baselineAction > 0 && candidateAction >= 0
    ? (baselineAction - candidateAction) / baselineAction : null;
  if (improvement == null || improvement < Number(gates.minimumActionP50ImprovementRatio || 0.3)) {
    failures.push('Action p50 latency improvement is below the required threshold.');
  }
  const ceilings = gates.absoluteP50CeilingsMs || {};
  for (const [name, ceiling] of Object.entries(ceilings)) {
    const actual = name === 'preparation'
      ? candidate?.preparation?.totalElapsedMs?.p50
      : candidate?.stages?.[name]?.totalElapsedMs?.p50;
    if (!Number.isFinite(Number(actual)) || Number(actual) > Number(ceiling)) {
      failures.push(`${name} p50 latency exceeds ${ceiling}ms.`);
    }
  }
  const quality = gates.qualityMetricsNoRegression || [];
  for (const key of quality) {
    const before = Number(baseline?.quality?.[key]);
    const after = Number(candidate?.quality?.[key]);
    if (!Number.isFinite(before) || !Number.isFinite(after) || after < before) {
      failures.push(`Quality metric ${key} regressed or is missing.`);
    }
  }
  return { passed: failures.length === 0, actionP50ImprovementRatio: improvement, failures };
}

function main(argv = process.argv.slice(2)) {
  if (argv[0] === '--compare') {
    const baseline = JSON.parse(fs.readFileSync(argv[1], 'utf8'));
    const candidate = JSON.parse(fs.readFileSync(argv[2], 'utf8'));
    const gates = JSON.parse(fs.readFileSync(argv[3], 'utf8'));
    const result = evaluateReleaseGates(baseline, candidate, gates);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.passed) process.exitCode = 1;
    return;
  }
  const text = argv.length
    ? argv.map((file) => fs.readFileSync(file, 'utf8')).join('\n')
    : fs.readFileSync(0, 'utf8');
  process.stdout.write(`${JSON.stringify(summariseEvents(parseEvents(text)), null, 2)}\n`);
}

if (require.main === module) main();

module.exports = { percentile, distribution, parseEvents, summariseEvents, evaluateReleaseGates };
