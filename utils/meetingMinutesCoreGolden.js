const fs = require('fs/promises');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const CORE_GOLDEN_ROOT = path.join(REPO_ROOT, 'scripts', 'meeting-minutes-core-golden');

function normaliseText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function similarity(a, b) {
  const left = normaliseText(a);
  const right = normaliseText(b);
  if (!left && !right) return 1;
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.82;
  const leftTokens = new Set(left.split(/\s+/).filter(Boolean));
  const rightTokens = new Set(right.split(/\s+/).filter(Boolean));
  const overlap = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return overlap / Math.max(leftTokens.size, rightTokens.size, 1);
}

function listRecall(expected, actual) {
  const expectedItems = Array.isArray(expected) ? expected : [];
  const actualItems = Array.isArray(actual) ? actual : [];
  if (!expectedItems.length) return actualItems.length ? 0 : 1;
  const matched = expectedItems.filter((item) => Math.max(...actualItems.map((candidate) => similarity(item, candidate)), 0) >= 0.6);
  return matched.length / expectedItems.length;
}

function scoreCaseOutput(manifest, output) {
  const expectedActions = Array.isArray(manifest.expected_actions) ? manifest.expected_actions : [];
  const actualActions = Array.isArray(output?.actions) ? output.actions : [];
  const attendeeRecall = listRecall(manifest.expected_attendees, output?.attendees);
  const expectedClientAttendees = new Set((manifest.expected_client_attendees || []).map(normaliseText));
  const actualClientAttendees = new Set((output?.client_attendees || []).map(normaliseText));
  const clientSplit = expectedClientAttendees.size === actualClientAttendees.size
    && [...expectedClientAttendees].every((item) => actualClientAttendees.has(item)) ? 1 : 0;
  let matchedActions = 0;
  for (const expectedAction of expectedActions) {
    const match = actualActions.some((actualAction) => {
      return similarity(expectedAction.owner, actualAction?.owner) >= 0.75
        && similarity(expectedAction.action, actualAction?.action) >= 0.55;
    });
    if (match) matchedActions += 1;
  }
  const actionRecall = expectedActions.length ? matchedActions / expectedActions.length : (actualActions.length ? 0 : 1);
  const decisionRecall = listRecall(manifest.expected_decisions, output?.decisions);
  const riskRecall = listRecall(manifest.expected_risks, output?.risks);
  const score = 100 * ((0.15 * attendeeRecall) + (0.10 * clientSplit) + (0.45 * actionRecall) + (0.15 * decisionRecall) + (0.15 * riskRecall));

  return {
    score: Math.round(score * 10) / 10,
    attendeeRecall,
    clientSplit,
    actionRecall,
    decisionRecall,
    riskRecall
  };
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function parseCsvLine(line) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && quoted && line[index + 1] === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

async function readRunRecords() {
  const runRecordPaths = [
    path.join(CORE_GOLDEN_ROOT, 'run_record.csv'),
    path.join(CORE_GOLDEN_ROOT, 'runs', 'run_record.csv')
  ];
  const records = [];
  for (const filePath of runRecordPaths) {
    if (!(await exists(filePath))) continue;
    const lines = (await fs.readFile(filePath, 'utf8')).split(/\r?\n/).filter((line) => line.trim());
    if (lines.length < 2) continue;
    const headers = parseCsvLine(lines[0]);
    for (const line of lines.slice(1)) {
      const values = parseCsvLine(line);
      records.push(Object.fromEntries(headers.map((header, index) => [header, values[index] || ''])));
    }
  }
  return records;
}

function statusFromResult(result) {
  if (!result) return { key: 'not_run', label: 'Not run', tone: 'muted' };
  if (result.hardFail) return { key: 'needs_work', label: 'Needs work', tone: 'bad' };
  if (typeof result.score !== 'number') return { key: 'review', label: 'Review', tone: 'warn' };
  if (result.score >= 90) return { key: 'working', label: 'Working', tone: 'good' };
  if (result.score >= 70) return { key: 'close', label: 'Close', tone: 'warn' };
  return { key: 'needs_work', label: 'Needs work', tone: 'bad' };
}

function latestRecordsByCase(records) {
  const latest = new Map();
  for (const record of records) {
    const caseId = String(record.case_id || '').trim();
    if (!caseId) continue;
    const existing = latest.get(caseId);
    const sortValue = `${record.run_date || ''} ${record.run_id || ''}`;
    const existingSortValue = existing ? `${existing.run_date || ''} ${existing.run_id || ''}` : '';
    if (!existing || sortValue >= existingSortValue) latest.set(caseId, record);
  }
  return latest;
}

async function resultFromRecord(record, manifest) {
  if (!record) return null;
  let score = Number(record.baseline_score);
  let scoreBreakdown = null;
  const outputPath = String(record.output_path || '').trim();
  if (outputPath) {
    const candidates = [
      path.resolve(CORE_GOLDEN_ROOT, outputPath),
      path.resolve(REPO_ROOT, outputPath)
    ];
    const resolvedOutput = candidates.find((candidate) => !path.relative(REPO_ROOT, candidate).startsWith('..'));
    if (resolvedOutput && await exists(resolvedOutput)) {
      try {
        const output = await readJson(resolvedOutput);
        scoreBreakdown = scoreCaseOutput(manifest, output);
        score = scoreBreakdown.score;
      } catch {
        // Keep the recorded score if the output cannot be parsed.
      }
    }
  }
  const hardFail = ['1', 'true', 'yes', 'y'].includes(String(record.hard_fail || '').toLowerCase());
  return {
    runId: record.run_id || '',
    runDate: record.run_date || '',
    environment: record.environment || '',
    commitOrVersion: record.commit_or_version || '',
    outputPath,
    score: Number.isFinite(score) ? score : null,
    humanPerfectGap: Number.isFinite(score) ? Math.round((100 - score) * 10) / 10 : null,
    hardFail,
    reviewer: record.reviewer || '',
    notes: record.notes || '',
    scoreBreakdown
  };
}

async function listCaseDirectories(rootPath) {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

async function getMeetingMinutesCoreGoldenStatus() {
  const validation = { ok: true, errors: [] };
  const caseNames = await listCaseDirectories(path.join(CORE_GOLDEN_ROOT, 'cases'));
  const benchmarkNames = await listCaseDirectories(path.join(CORE_GOLDEN_ROOT, 'human_benchmarks'));
  const records = await readRunRecords();
  const latestRecords = latestRecordsByCase(records);

  if (caseNames.length !== 10) {
    validation.ok = false;
    validation.errors.push(`Expected 10 cases, found ${caseNames.length}.`);
  }

  const cases = [];
  for (const caseName of caseNames) {
    const caseDir = path.join(CORE_GOLDEN_ROOT, 'cases', caseName);
    const manifestPath = path.join(caseDir, 'manifest.json');
    const manifest = await readJson(manifestPath);
    const requiredFiles = ['transcript.docx', 'manifest.json', 'gold_minutes.md'];
    for (const fileName of requiredFiles) {
      if (!(await exists(path.join(caseDir, fileName)))) {
        validation.ok = false;
        validation.errors.push(`${caseName}: missing ${fileName}.`);
      }
    }
    const latestResult = await resultFromRecord(latestRecords.get(String(manifest.case_id)), manifest);
    const status = statusFromResult(latestResult);
    cases.push({
      id: manifest.case_id,
      slug: manifest.case_slug,
      directory: caseName,
      meetingType: manifest.meeting_type || '',
      focus: manifest.test_focus || '',
      expectedCounts: {
        attendees: (manifest.expected_attendees || []).length,
        clientAttendees: (manifest.expected_client_attendees || []).length,
        actions: (manifest.expected_actions || []).length,
        decisions: (manifest.expected_decisions || []).length,
        risks: (manifest.expected_risks || []).length,
        forbiddenClaims: (manifest.forbidden_claims || []).length
      },
      scoringNotes: manifest.scoring_notes || '',
      status,
      latestResult
    });
  }

  const benchmarks = [];
  for (const benchmarkName of benchmarkNames) {
    const benchmarkDir = path.join(CORE_GOLDEN_ROOT, 'human_benchmarks', benchmarkName);
    const benchmark = await readJson(path.join(benchmarkDir, 'benchmark.json'));
    benchmarks.push({
      id: benchmark.benchmark_id,
      directory: benchmarkName,
      evaluationMode: benchmark.evaluation_mode,
      notes: benchmark.notes,
      hasTranscript: await exists(path.join(benchmarkDir, benchmark.transcript || 'transcript.docx')),
      hasHumanMinutes: await exists(path.join(benchmarkDir, benchmark.human_minutes || 'human_minutes.pdf'))
    });
  }

  const recordedCases = cases.filter((item) => item.latestResult && typeof item.latestResult.score === 'number');
  const averageScore = recordedCases.length
    ? Math.round((recordedCases.reduce((sum, item) => sum + item.latestResult.score, 0) / recordedCases.length) * 10) / 10
    : null;
  const statusCounts = cases.reduce((counts, item) => {
    counts[item.status.key] = (counts[item.status.key] || 0) + 1;
    return counts;
  }, {});

  return {
    ok: true,
    suite: {
      name: 'Trinzo meeting-minutes core golden set',
      version: 'v1.0',
      path: 'scripts/meeting-minutes-core-golden',
      addedDate: '2026-08-12'
    },
    generatedAt: new Date().toISOString(),
    validation,
    summary: {
      caseCount: cases.length,
      benchmarkCount: benchmarks.length,
      recordedCaseCount: recordedCases.length,
      workingCount: statusCounts.working || 0,
      closeCount: statusCounts.close || 0,
      needsWorkCount: statusCounts.needs_work || 0,
      notRunCount: statusCounts.not_run || 0,
      averageScore,
      humanPerfectGap: averageScore == null ? null : Math.round((100 - averageScore) * 10) / 10
    },
    cases,
    benchmarks
  };
}

module.exports = {
  CORE_GOLDEN_ROOT,
  getMeetingMinutesCoreGoldenStatus,
  scoreCaseOutput
};
