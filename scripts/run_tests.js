'use strict';

// A small wrapper around Node/unittest, with the complete regression suite retained.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const DB_KEYS = ['INTERNAL_AI_TASK_TEST_DATABASE_URL', 'PROJECT_REPORT_TEST_DATABASE_URL', 'SETTINGS_TEST_DATABASE_URL'];
const infrastructure = new Set(['scripts/run_tests.js', 'tests/suites.json', 'deploy.sh', 'package-lock.json', 'package.json']);
const databaseCode = /^(?:sql\/|routes\/(?:api|auth|settings|internalAiTasks|projectRecords|projectContext|projectKnowledge|generationJobs|meetingMinutesJobs|minutesFeedback)\.js$|utils\/(?:db|settingsDb|settingsStore|requestFlags|knowledge|internalAiTasks|project[A-Z]|minutesForProjectUpdate|meetingMinutesDraftStorage|meetingMinutesProcessing|meetingMinutesAgentGeneration|meetingMinutesPeopleEvidence|meetingMinutesStagePersistence|meetingMinutesPassCache|meetingMinutesDiscussionFingerprint|meetingMinutesSource|meetingMinutesOriginal|meetingMinutesReviewAccounting|meetingMinutesReviewFlags|meetingMinutesEvidenceContext|meetingMinutesJobEdits|meetingMinutesDraftContext|meetingMinutesResponseContracts|meetingMinutesRefereeBatches|meetingMinutesDiscussionRows|canonicalMinutes\/(?:discussionClaimConsolidationState|discussionActionRecovery))|scripts\/(?:project_|python_llm\.py))/;

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function changedFiles(root, base) {
  try {
    git(root, ['rev-parse', '--verify', base + '^{commit}']);
    return [...new Set([
      ...git(root, ['diff', '--name-only', '--no-renames', '-z', base, '--']).split('\0'),
      ...git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0')
    ].filter(Boolean))];
  } catch {
    throw new Error('Cannot compare against ' + base + '. Fetch main or supply --base <revision>; no checks were silently skipped.');
  }
}

function modulePath(root, from, request) {
  const target = path.resolve(root, path.dirname(from), request);
  const choices = [target, target + '.js', target + '.cjs', target + '.json', path.join(target, 'index.js')];
  const found = choices.find(p => fs.existsSync(p) && fs.statSync(p).isFile());
  return path.relative(root, found || (/\.[a-z]+$/i.test(target) ? target : target + '.js')).split(path.sep).join('/');
}

function dependencyReader(root) {
  const cache = new Map();
  return function read(file) {
    if (cache.has(file)) return cache.get(file);
    const absolute = path.join(root, file);
    const source = fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : '';
    const dependencies = [...source.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)]
      .map(match => modulePath(root, file, match[1]));
    const record = { source, dependencies };
    cache.set(file, record);
    return record;
  };
}

function dependsOn(test, changed, read, visited = new Set()) {
  if (test === changed) return true;
  if (visited.has(test)) return false;
  visited.add(test);
  const record = read(test);
  // Also retain tests reading fixtures/source via fs/path.join rather than require.
  if (record.source.includes(path.basename(changed))) return true;
  return record.dependencies.some(file => dependsOn(file, changed, read, visited));
}

function dependenciesChanged(root, files, base) {
  if (files.includes('package-lock.json')) return true;
  if (!files.includes('package.json')) return false;
  try {
    const before = JSON.parse(git(root, ['show', base + ':package.json']));
    const after = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    return ['dependencies', 'devDependencies', 'optionalDependencies'].some(k => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  } catch { return true; }
}

function plan({ root = ROOT, mode = 'core', base = 'origin/main', files, all: forceFull = false } = {}) {
  if (!['core', 'changed', 'release', 'full', 'integration'].includes(mode)) throw new Error('Unknown suite: ' + mode);
  const suites = JSON.parse(fs.readFileSync(path.join(root, 'tests/suites.json'), 'utf8'));
  for (const file of [...suites.core, ...suites.integration]) {
    if (!fs.existsSync(path.join(root, file))) throw new Error('Suite refers to a missing file: ' + file);
  }
  for (const file of suites.corePython) if (!fs.existsSync(path.join(root, 'tests', file))) throw new Error('Suite refers to a missing Python file: ' + file);
  const pythonFiles = new Set(suites.corePython);
  const pythonReaders = fs.readdirSync(path.join(root, 'tests')).filter(f => /^test_.*\.py$/.test(f));
  const all = fs.readdirSync(path.join(root, 'tests')).filter(f => f.endsWith('.test.js')).map(f => 'tests/' + f).sort();
  const unclassified = all.filter(file => !suites.integration.includes(file) && /^[ \t]*(?:const|let|var)\s+\w+\s*=\s*process\.env\.(?:INTERNAL_AI_TASK_TEST_DATABASE_URL|PROJECT_REPORT_TEST_DATABASE_URL|SETTINGS_TEST_DATABASE_URL)\b/m.test(fs.readFileSync(path.join(root, file), 'utf8')));
  if (unclassified.length) throw new Error('Database fixtures must be classified in tests/suites.json: ' + unclassified.join(', '));
  const broad = all.filter(f => !suites.integration.includes(f));
  const selected = new Set(mode === 'full' ? broad : mode === 'integration' ? [] : suites.core);
  const reasons = [];
  let python = mode === 'full' ? 'full' : mode === 'integration' ? 'none' : 'core';
  let integrationRequired = mode === 'integration';
  let qualityReviewRequired = false;
  if (forceFull) {
    if (mode !== 'release') throw new Error('--all is only used for an explicit full release check.');
    broad.forEach(f => selected.add(f)); python = 'full'; integrationRequired = true; reasons.push('No verified baseline: all regressions and persistence checks');
  }
  if (['changed', 'release'].includes(mode) && !forceFull) {
    files = files || changedFiles(root, base);
    const read = dependencyReader(root);
    integrationRequired = files.some(f => databaseCode.test(f)) || dependenciesChanged(root, files, base);
    for (const file of files) {
      if (path.isAbsolute(file) || file.split('/').includes('..')) throw new Error('Changed paths must stay inside the repository.');
      if (infrastructure.has(file)) {
        broad.forEach(f => selected.add(f)); python = 'full'; integrationRequired = true; reasons.push(file + ': test/install infrastructure; full regressions'); continue;
      }
      if (/^config\/meeting-minutes-parallel\/(?:summary|actions|discussion|discussion-flat)\.txt$/.test(file)) {
        broad.filter(test => test.startsWith('tests/meeting-minutes-parallel')).forEach(test => selected.add(test));
        qualityReviewRequired = true;
        reasons.push(file + ': provider-prompt contracts; transcript quality comparison remains separate');
        continue;
      }
      const documentation = file.startsWith('docs/') || (/\.md$/.test(file) && !file.startsWith('tests/'));
      if (/\.py$/.test(file) || file.startsWith('config/')) python = 'full';
      const related = broad.filter(test => dependsOn(test, file, read));
      const databaseRelated = suites.integration.some(test => dependsOn(test, file, read));
      if (databaseRelated) integrationRequired = true;
      const relatedPython = pythonReaders.filter(test => fs.readFileSync(path.join(root, 'tests', test), 'utf8').includes(path.basename(file)));
      relatedPython.forEach(test => pythonFiles.add(test));
      if (relatedPython.length && python === 'core') python = 'focused';
      if (file.startsWith('public/') || file.startsWith('views/') || file.startsWith('client/')) {
        broad.filter(test => /(?:playwright|puppeteer)/.test(read(test).source)).forEach(test => related.push(test));
      }
      if (related.length || relatedPython.length || databaseRelated) { related.forEach(f => selected.add(f)); reasons.push(file + ': ' + new Set(related).size + ' JavaScript, ' + relatedPython.length + ' Python consumers' + (databaseRelated ? '; persistence checks required' : '')); }
      else if (documentation) continue;
      else if (!suites.integration.includes(file) && !/\.py$/.test(file)) {
        broad.forEach(f => selected.add(f)); python = 'full'; if (!file.startsWith('tests/')) integrationRequired = true; reasons.push(file + ': no reliable mapping; full regressions');
      }
    }
  }
  return { mode, base, files: [...selected].sort(), python, pythonFiles: [...pythonFiles].sort(),
    integration: suites.integration, integrationRequired, qualityReviewRequired, reasons };
}

function integrationEnvironment(env) {
  const result = { ...env };
  for (const key of DB_KEYS) {
    const url = env.TEST_DATABASE_URL || env[key];
    if (!url) throw new Error('Database checks require TEST_DATABASE_URL pointing to a disposable trinzo_tasks_test database. Production DATABASE_URL is never a fallback.');
    const parsed = new URL(url);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || parsed.pathname !== '/trinzo_tasks_test') {
      throw new Error('Database checks only accept the explicit disposable trinzo_tasks_test database.');
    }
    result[key] = url;
  }
  // Even an early import must never inherit production database credentials.
  result.DATABASE_URL = result.PROJECT_REPORT_TEST_DATABASE_URL;
  for (const key of Object.keys(result)) if (/^PG[A-Z_]+$/.test(key)) delete result[key];
  return result;
}

function execute(selection, env = process.env) {
  const hasIntegration = Boolean(env.TEST_DATABASE_URL || DB_KEYS.every(k => env[k]));
  // Fail before starting a release if required persistence checks cannot run.
  const runIntegration = selection.mode === 'integration' || (hasIntegration && (selection.mode === 'full' || (selection.mode !== 'core' && selection.integrationRequired)));
  if (selection.mode === 'release' && selection.integrationRequired && !hasIntegration) integrationEnvironment(env);
  const integrationEnv = runIntegration ? integrationEnvironment(env) : null;
  const common = { ...env, HF_HUB_OFFLINE: env.HF_HUB_OFFLINE || '1', TRANSFORMERS_OFFLINE: env.TRANSFORMERS_OFFLINE || '1',
    PYTHONDONTWRITEBYTECODE: '1', CANONICAL_MINILM_DISK_CACHE: env.CANONICAL_MINILM_DISK_CACHE || '.minilm-cache' };
  function run(command, args, extra = {}) {
    const result = spawnSync(command, args, { cwd: ROOT, env: { ...common, ...extra }, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(command + ' checks failed (' + (result.signal || result.status) + ').');
  }
  if (selection.files.length) run(process.execPath, ['--test', '--test-concurrency=1', ...selection.files]);
  const python = env.PYTHON_BIN || 'python3';
  if (selection.python === 'full') run(python, ['scripts/run_python_regression_tests.py']);
  else if (['core', 'focused'].includes(selection.python)) for (const file of selection.pythonFiles) run(python, ['-m', 'unittest', 'discover', '-s', 'tests', '-p', file, '-v']);
  if (runIntegration) run(process.execPath, ['--test', '--test-concurrency=1', ...selection.integration], integrationEnv);
  else if (selection.mode !== 'core') console.log('Database integration not run; use npm run test:integration with TEST_DATABASE_URL.' +
    (selection.integrationRequired ? ' These changes require it before release.' : ''));
  if (selection.qualityReviewRequired) console.log('AI output quality was not evaluated. Compare representative transcripts before publishing the provider instructions.');
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2), mode = args.shift() || 'core';
    let base = 'origin/main', list = false, all = false; const files = [];
    while (args.length) {
      const arg = args.shift();
      if (arg === '--base') { base = args.shift(); if (!base) throw new Error('--base needs a revision.'); }
      else if (arg === '--file') { const file = args.shift(); if (!file) throw new Error('--file needs a path.'); files.push(file); }
      else if (arg === '--list') list = true;
      else if (arg === '--all') all = true;
      else throw new Error('Unknown argument: ' + arg);
    }
    if (files.length && mode !== 'changed') throw new Error('--file is for development selection only; release checks derive all changes from Git.');
    const selection = plan({ mode, base, all, files: files.length ? files : undefined });
    console.log('Suite: ' + mode + '; JavaScript files: ' + selection.files.length + '; Python: ' + selection.python +
      '; database integration required: ' + selection.integrationRequired);
    if (list) console.log(JSON.stringify(selection, null, 2));
    else execute(selection);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { plan, integrationEnvironment };
