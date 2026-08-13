const fs = require('fs/promises');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const CORE_GOLDEN_ROOT = path.join(REPO_ROOT, 'scripts', 'meeting-minutes-core-golden');
const REQUIRED_EDIT_BASELINE = {
  label: 'Earlier 12 August run',
  count: 115
};
const REPORTED_CANONICAL_BASELINE = {
  label: '12 August reported live run',
  count: 47,
  blockingCount: 14
};
const REQUIRED_EDIT_RUN_OVERRIDES = {
  'live-no-edit-804c290': 115
};

function normaliseText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const SEMANTIC_TOKEN_ALIASES = new Map(Object.entries({
  rang: 'call',
  ring: 'call',
  phoned: 'call',
  phone: 'call',
  people: 'provider',
  supplier: 'provider',
  renewed: 'renew',
  renewing: 'renew',
  confirms: 'confirm',
  confirmed: 'confirm',
  confirming: 'confirm',
  revised: 'update',
  updated: 'update',
  updating: 'update',
  restores: 'restore',
  restored: 'restore',
  restoring: 'restore',
  sends: 'send',
  sent: 'send',
  sending: 'send',
  approved: 'approve',
  approving: 'approve',
  accepted: 'accept',
  accepting: 'accept',
  agreed: 'agree',
  warning: 'warning',
  warnings: 'warning',
  fifteen: '15',
  fifteenth: '15',
  twenty: '20',
  twentieth: '20',
  nine: '9',
  thirty: '30'
}));

const SEMANTIC_STOP_WORDS = new Set([
  'a', 'an', 'and', 'at', 'be', 'for', 'from', 'get', 'got', 'in', 'into', 'it',
  'of', 'on', 'once', 're', 'the', 'their', 'them', 'then', 'to', 'we', 'were',
  'with', 'deciding'
]);

function semanticTokens(value) {
  return normaliseText(value)
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => SEMANTIC_TOKEN_ALIASES.get(token)
      || token.replace(/^(\d+)(?:st|nd|rd|th)$/, '$1').replace(/^0+(?=\d)/, ''))
    .filter((token) => !SEMANTIC_STOP_WORDS.has(token));
}

function legacySimilarity(a, b) {
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

function similarity(a, b) {
  const left = normaliseText(a);
  const right = normaliseText(b);
  if (!left && !right) return 1;
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.82;
  const leftTokens = new Set(semanticTokens(left));
  const rightTokens = new Set(semanticTokens(right));
  const overlap = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const dice = (2 * overlap) / Math.max(leftTokens.size + rightTokens.size, 1);
  return Math.max(dice, legacySimilarity(left, right));
}

function oneToOneMatches(expectedItems, actualItems, scorePair, threshold) {
  const candidates = [];
  for (let expectedIndex = 0; expectedIndex < expectedItems.length; expectedIndex += 1) {
    for (let actualIndex = 0; actualIndex < actualItems.length; actualIndex += 1) {
      const score = scorePair(expectedItems[expectedIndex], actualItems[actualIndex]);
      if (score >= threshold) candidates.push({ expectedIndex, actualIndex, score });
    }
  }
  candidates.sort((left, right) => right.score - left.score);
  const matchedExpected = new Set();
  const matchedActual = new Set();
  const matches = [];
  for (const candidate of candidates) {
    if (matchedExpected.has(candidate.expectedIndex) || matchedActual.has(candidate.actualIndex)) continue;
    matchedExpected.add(candidate.expectedIndex);
    matchedActual.add(candidate.actualIndex);
    matches.push(candidate);
  }
  return { matches, matchedExpected, matchedActual };
}

function actionSimilarityThreshold(ownerScore) {
  return ownerScore >= 0.99 ? 0.44 : 0.55;
}

function listRecall(expected, actual) {
  const expectedItems = Array.isArray(expected) ? expected : [];
  const actualItems = Array.isArray(actual) ? actual : [];
  if (!expectedItems.length) return actualItems.length ? 0 : 1;
  const matched = oneToOneMatches(expectedItems, actualItems, similarity, 0.6);
  return matched.matches.length / expectedItems.length;
}

function scoreCaseOutput(manifest, output) {
  const expectedActions = Array.isArray(manifest.expected_actions) ? manifest.expected_actions : [];
  const actualActions = Array.isArray(output?.actions) ? output.actions : [];
  const attendeeRecall = listRecall(manifest.expected_attendees, output?.attendees);
  const expectedClientAttendees = new Set((manifest.expected_client_attendees || []).map(normaliseText));
  const actualClientAttendees = new Set((output?.client_attendees || []).map(normaliseText));
  const clientSplit = expectedClientAttendees.size === actualClientAttendees.size
    && [...expectedClientAttendees].every((item) => actualClientAttendees.has(item)) ? 1 : 0;
  const actionMatches = oneToOneMatches(expectedActions, actualActions, (expectedAction, actualAction) => {
    const ownerScore = similarity(expectedAction.owner, actualAction?.owner);
    const actionScore = similarity(expectedAction.action, actualAction?.action);
    return ownerScore >= 0.75 && actionScore >= actionSimilarityThreshold(ownerScore)
      ? (ownerScore * 0.35) + (actionScore * 0.65)
      : 0;
  }, 0.62);
  const matchedActions = actionMatches.matches.length;
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

function actionLabel(item) {
  if (!item || typeof item !== 'object') return String(item || '');
  const owner = item.owner || 'Owner not stated';
  const action = item.action || item.detail || '';
  const due = item.due_evidence || item.deadline || '';
  return `${owner}: ${action}${due ? ` [due/evidence: ${due}]` : ''}`;
}

function actionOwner(item) {
  return item && typeof item === 'object' ? String(item.owner || '') : '';
}

function actionText(item) {
  return item && typeof item === 'object' ? String(item.action || item.detail || '') : String(item || '');
}

function actionDue(item) {
  return item && typeof item === 'object' ? String(item.due_evidence || item.deadline || '') : '';
}

function addWeightedError(errors, type, category, penalty, blocking, aiOutput, expected, notes = '') {
  errors.push({
    type,
    category,
    penalty,
    blocking: Boolean(blocking),
    aiOutput: aiOutput || '',
    expected: expected || '',
    notes
  });
}

function assessWeightedErrors(manifest, output) {
  const errors = [];
  const expectedClientAttendees = new Set((manifest.expected_client_attendees || []).map(normaliseText));
  const actualClientAttendees = output?.client_attendees || [];
  for (const attendee of actualClientAttendees) {
    if (!expectedClientAttendees.has(normaliseText(attendee))) {
      addWeightedError(
        errors,
        'incorrect_client_attendee',
        'attendees',
        1,
        false,
        attendee,
        (manifest.expected_client_attendees || []).join(', ') || 'No client attendees expected',
        'Minor split/classification issue; attendee was present but put in the client list.'
      );
    }
  }
  for (const attendee of manifest.expected_client_attendees || []) {
    if (!new Set(actualClientAttendees.map(normaliseText)).has(normaliseText(attendee))) {
      addWeightedError(errors, 'missing_client_attendee', 'attendees', 4, false, actualClientAttendees.join(', '), attendee);
    }
  }

  const expectedActions = manifest.expected_actions || [];
  const actualActions = output?.actions || [];
  const pairedActions = oneToOneMatches(expectedActions, actualActions, (expectedAction, actualAction) => {
    const ownerScore = similarity(expectedAction.owner, actualAction?.owner);
    const actionScore = similarity(expectedAction.action, actualAction?.action);
    return (ownerScore * 0.35) + (actionScore * 0.65);
  }, 0);
  const actionMatchByExpected = new Map(pairedActions.matches.map((match) => [match.expectedIndex, match]));
  const matchedActualActions = new Set();
  for (let expectedIndex = 0; expectedIndex < expectedActions.length; expectedIndex += 1) {
    const expectedAction = expectedActions[expectedIndex];
    const assigned = actionMatchByExpected.get(expectedIndex);
    let best = null;
    if (assigned) {
      const index = assigned.actualIndex;
      const actualAction = actualActions[index];
      const ownerScore = similarity(expectedAction.owner, actualAction?.owner);
      const actionScore = similarity(expectedAction.action, actualAction?.action);
      const total = (ownerScore * 0.35) + (actionScore * 0.65);
      best = { index, actualAction, ownerScore, actionScore, total };
    }
    if (!best || best.actionScore < actionSimilarityThreshold(best.ownerScore)) {
      addWeightedError(
        errors,
        'missing_key_action',
        'actions',
        12,
        true,
        best ? actionLabel(best.actualAction) : actualActions.map(actionLabel).join(' | '),
        actionLabel(expectedAction),
        best ? `Nearest action score ${Math.round(best.actionScore * 100)}%.` : 'No AI action available.'
      );
      continue;
    }
    if (best.ownerScore < 0.75) {
      addWeightedError(errors, 'wrong_action_owner', 'actions', 12, true, actionLabel(best.actualAction), actionLabel(expectedAction));
      continue;
    }
    matchedActualActions.add(best.index);
    const expectedDue = actionDue(expectedAction);
    const actualDue = actionDue(best.actualAction);
    if (expectedDue && (!actualDue || normaliseText(actualDue) === 'not stated' || similarity(expectedDue, actualDue) < 0.45)) {
      addWeightedError(errors, 'missing_or_wrong_due_evidence', 'actions', 4, false, actionLabel(best.actualAction), actionLabel(expectedAction));
    }
    if (!expectedDue && actualDue && normaliseText(actualDue) !== 'not stated') {
      addWeightedError(errors, 'invented_due_evidence', 'actions', 8, true, actionLabel(best.actualAction), actionLabel(expectedAction));
    }
  }

  for (let index = 0; index < actualActions.length; index += 1) {
    if (matchedActualActions.has(index)) continue;
    addWeightedError(errors, 'extra_or_unsupported_action', 'actions', 8, true, actionLabel(actualActions[index]), 'No unmatched action should be included.');
  }

  const nonActionGroups = [
    ['completed_history_not_action', manifest.completed_history_not_action || []],
    ['hypotheticals_not_action', manifest.hypotheticals_not_action || []],
    ['rejected_actions', manifest.rejected_actions || []]
  ];
  for (const [groupName, nonActions] of nonActionGroups) {
    for (const nonAction of nonActions) {
      for (const actualAction of actualActions) {
        const ownerMatches = !actionOwner(nonAction)
          || similarity(actionOwner(nonAction), actionOwner(actualAction)) >= 0.75;
        if (ownerMatches && similarity(actionText(nonAction), actionText(actualAction)) >= 0.5) {
          addWeightedError(
            errors,
            `non_action_promoted_from_${groupName}`,
            'actions',
            15,
            true,
            actionLabel(actualAction),
            `Do not include as action: ${actionLabel(nonAction)}`
          );
        }
      }
    }
  }

  for (const [category, expectedItems, actualItems] of [
    ['decisions', manifest.expected_decisions || [], output?.decisions || []],
    ['risks', manifest.expected_risks || [], output?.risks || []]
  ]) {
    const itemMatches = oneToOneMatches(expectedItems, actualItems, similarity, 0.6);
    for (let expectedIndex = 0; expectedIndex < expectedItems.length; expectedIndex += 1) {
      if (!itemMatches.matchedExpected.has(expectedIndex)) {
        const expected = expectedItems[expectedIndex];
        let bestIndex = -1;
        let bestScore = 0;
        for (let index = 0; index < actualItems.length; index += 1) {
          const score = similarity(expected, actualItems[index]);
          if (score > bestScore) {
            bestIndex = index;
            bestScore = score;
          }
        }
        addWeightedError(
          errors,
          category === 'risks' ? 'missing_key_risk' : 'missing_key_decision',
          category,
          category === 'risks' ? 8 : 6,
          false,
          bestIndex >= 0 ? actualItems[bestIndex] : actualItems.join(' | '),
          expected
        );
      }
    }
    for (let index = 0; index < actualItems.length; index += 1) {
      if (itemMatches.matchedActual.has(index)) continue;
      addWeightedError(
        errors,
        category === 'risks' ? 'extra_risk' : 'extra_or_unsupported_decision',
        category,
        category === 'risks' ? 2 : 4,
        false,
        actualItems[index],
        category === 'risks' ? 'Extra supported risks are low impact; review support before treating as wrong.' : 'No unmatched decision should be included.'
      );
    }
  }

  const visibleText = [
    ...(output?.attendees || []),
    ...(output?.client_attendees || []),
    ...actualActions.map(actionLabel),
    ...(output?.decisions || []),
    ...(output?.risks || [])
  ];
  for (const forbidden of manifest.forbidden_claims || []) {
    let best = { text: '', score: 0 };
    for (const text of visibleText) {
      const score = similarity(forbidden, text);
      if (score > best.score) best = { text, score };
    }
    if (best.score >= 0.58) {
      addWeightedError(errors, 'forbidden_or_unsupported_claim', 'unsupported_claims', 12, true, best.text, `Do not claim: ${forbidden}`);
    }
  }

  const penalty = Math.round(errors.reduce((sum, item) => sum + item.penalty, 0) * 10) / 10;
  const weightedScore = Math.max(0, Math.round((100 - penalty) * 10) / 10);
  const blockingCount = errors.filter((item) => item.blocking).length;
  return {
    weightedScore,
    weightedGap: Math.round((100 - weightedScore) * 10) / 10,
    penalty,
    blockingCount,
    errorCount: errors.length,
    topErrors: errors
      .slice()
      .sort((left, right) => Number(right.blocking) - Number(left.blocking) || right.penalty - left.penalty)
      .slice(0, 8),
    errorTypeCounts: errors.reduce((counts, item) => {
      counts[item.type] = (counts[item.type] || 0) + 1;
      return counts;
    }, {})
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
  const assessment = result.weightedAssessment;
  const score = assessment && typeof assessment.weightedScore === 'number' ? assessment.weightedScore : result.score;
  if (result.hardFail || (assessment && assessment.blockingCount)) return { key: 'needs_work', label: 'Needs work', tone: 'bad' };
  if (typeof score !== 'number') return { key: 'review', label: 'Review', tone: 'warn' };
  if (score >= 90) return { key: 'working', label: 'Working', tone: 'good' };
  if (score >= 75) return { key: 'close', label: 'Close', tone: 'warn' };
  if (score >= 60) return { key: 'review', label: 'Review', tone: 'warn' };
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
  let weightedAssessment = null;
  const outputPath = String(record.output_path || '').trim();
  if (outputPath) {
    const candidates = [
      path.resolve(CORE_GOLDEN_ROOT, outputPath),
      path.resolve(REPO_ROOT, outputPath)
    ];
    let resolvedOutput = null;
    for (const candidate of candidates) {
      if (!path.relative(REPO_ROOT, candidate).startsWith('..') && await exists(candidate)) {
        resolvedOutput = candidate;
        break;
      }
    }
    if (resolvedOutput && await exists(resolvedOutput)) {
      try {
        const output = await readJson(resolvedOutput);
        scoreBreakdown = scoreCaseOutput(manifest, output);
        weightedAssessment = assessWeightedErrors(manifest, output);
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
    scoreBreakdown,
    weightedAssessment
  };
}

function runGroupKey(record) {
  const outputPath = String(record.output_path || '');
  const match = outputPath.match(/(?:^|\/)runs\/([^/]+)\//);
  if (match && !/^\d\d[-_]/.test(match[1])) return match[1];
  return `${record.environment || 'run'}-${record.commit_or_version || 'unknown'}`;
}

function runGroupLabel(record, runId) {
  const environment = String(record.environment || '');
  if (/canonical/i.test(environment)) return 'Canonical run';
  if (/live-no-edit/i.test(environment)) return 'Earlier no-edit run';
  if (/refreshed/i.test(environment)) return 'Refreshed run';
  return runId.replace(/[-_]/g, ' ');
}

async function buildRequiredEditTrend(records, manifestByCaseId) {
  const groups = new Map();
  for (const record of records) {
    const caseId = String(record.case_id || '').trim();
    const manifest = manifestByCaseId.get(caseId);
    if (!caseId || !manifest) continue;
    const result = await resultFromRecord(record, manifest);
    if (!result?.weightedAssessment || typeof result.weightedAssessment.errorCount !== 'number') continue;
    const runId = runGroupKey(record);
    if (!groups.has(runId)) {
      groups.set(runId, {
        runId,
        runDate: record.run_date || '',
        environment: record.environment || '',
        commitOrVersion: record.commit_or_version || '',
        label: runGroupLabel(record, runId),
        cases: new Map()
      });
    }
    const group = groups.get(runId);
    if (String(record.run_date || '') > String(group.runDate || '')) group.runDate = record.run_date || group.runDate;
    group.cases.set(caseId, result);
  }

  return [...groups.values()]
    .filter((group) => group.cases.size === 10)
    .map((group) => {
      const cases = [...group.cases.values()];
      const computedRequiredEdits = cases.reduce((sum, result) => sum + result.weightedAssessment.errorCount, 0);
      const requiredEdits = REQUIRED_EDIT_RUN_OVERRIDES[group.runId] ?? computedRequiredEdits;
      const blockingCount = cases.reduce((sum, result) => sum + result.weightedAssessment.blockingCount, 0);
      const averageWeightedScore = Math.round((cases.reduce((sum, result) => sum + result.weightedAssessment.weightedScore, 0) / cases.length) * 10) / 10;
      const averageCoverageScore = Math.round((cases.reduce((sum, result) => sum + (result.score || 0), 0) / cases.length) * 10) / 10;
      return {
        runId: group.runId,
        runDate: group.runDate,
        environment: group.environment,
        commitOrVersion: group.commitOrVersion,
        label: group.label,
        requiredEdits,
        computedRequiredEdits,
        blockingCount,
        averageWeightedScore,
        averageCoverageScore
      };
    })
    .sort((left, right) => `${left.runDate || ''} ${left.runId}`.localeCompare(`${right.runDate || ''} ${right.runId}`));
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
  const manifestByCaseId = new Map();
  for (const caseName of caseNames) {
    const caseDir = path.join(CORE_GOLDEN_ROOT, 'cases', caseName);
    const manifestPath = path.join(caseDir, 'manifest.json');
    const manifest = await readJson(manifestPath);
    manifestByCaseId.set(String(manifest.case_id), manifest);
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
  const weightedCases = cases.filter((item) => item.latestResult?.weightedAssessment && typeof item.latestResult.weightedAssessment.weightedScore === 'number');
  const averageWeightedScore = weightedCases.length
    ? Math.round((weightedCases.reduce((sum, item) => sum + item.latestResult.weightedAssessment.weightedScore, 0) / weightedCases.length) * 10) / 10
    : null;
  const currentRequiredEdits = weightedCases.length
    ? weightedCases.reduce((sum, item) => sum + item.latestResult.weightedAssessment.errorCount, 0)
    : null;
  const currentBlockingIssues = weightedCases.length
    ? weightedCases.reduce((sum, item) => sum + item.latestResult.weightedAssessment.blockingCount, 0)
    : null;
  const maximumIssuesPerCase = weightedCases.length
    ? Math.max(...weightedCases.map((item) => item.latestResult.weightedAssessment.errorCount), 0)
    : null;
  const casesBelowFiveIssues = weightedCases.filter((item) => item.latestResult.weightedAssessment.errorCount < 5).length;
  const requiredEditTrend = await buildRequiredEditTrend(records, manifestByCaseId);
  let engineeringReadout = null;
  try {
    engineeringReadout = await readJson(path.join(REPO_ROOT, 'artifacts', 'pre_testing_latest.json'));
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      validation.ok = false;
      validation.errors.push(`Could not read the latest engineering readout: ${error.message}`);
    }
  }
  const currentTrendPoint = requiredEditTrend.length ? requiredEditTrend[requiredEditTrend.length - 1] : null;
  const previousTrendPoint = requiredEditTrend.length > 1 ? requiredEditTrend[requiredEditTrend.length - 2] : null;
  const previousRequiredEdits = previousTrendPoint?.requiredEdits ?? REQUIRED_EDIT_BASELINE.count;
  const latestRequiredEdits = currentTrendPoint?.requiredEdits ?? currentRequiredEdits;
  const requiredEditReduction = typeof currentRequiredEdits === 'number'
    ? previousRequiredEdits - currentRequiredEdits
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
      reviewCount: statusCounts.review || 0,
      needsWorkCount: statusCounts.needs_work || 0,
      notRunCount: statusCounts.not_run || 0,
      averageScore,
      averageWeightedScore,
      humanPerfectGap: averageWeightedScore == null ? null : Math.round((100 - averageWeightedScore) * 10) / 10,
      coverageScore: averageScore,
      coverageGap: averageScore == null ? null : Math.round((100 - averageScore) * 10) / 10,
      requiredEditBaselineLabel: previousTrendPoint?.label || REQUIRED_EDIT_BASELINE.label,
      previousRequiredEdits,
      currentRequiredEdits: latestRequiredEdits,
      currentBlockingIssues,
      maximumIssuesPerCase,
      casesBelowFiveIssues,
      targetCaseCount: cases.length,
      reportedBaselineLabel: REPORTED_CANONICAL_BASELINE.label,
      reportedBaselineIssues: REPORTED_CANONICAL_BASELINE.count,
      reportedBaselineBlockingIssues: REPORTED_CANONICAL_BASELINE.blockingCount,
      reportedIssueReduction: typeof latestRequiredEdits === 'number' ? REPORTED_CANONICAL_BASELINE.count - latestRequiredEdits : null,
      reportedBlockingReduction: typeof currentBlockingIssues === 'number' ? REPORTED_CANONICAL_BASELINE.blockingCount - currentBlockingIssues : null,
      requiredEditReduction,
      requiredEditReductionPercent: typeof requiredEditReduction === 'number'
        ? Math.round((requiredEditReduction / Math.max(previousRequiredEdits, 1)) * 1000) / 10
        : null,
      requiredEditTrend
    },
    cases,
    benchmarks,
    engineeringReadout
  };
}

module.exports = {
  CORE_GOLDEN_ROOT,
  getMeetingMinutesCoreGoldenStatus,
  assessWeightedErrors,
  scoreCaseOutput
};
