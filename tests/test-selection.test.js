'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { plan, integrationEnvironment } = require('../scripts/run_tests');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trinzo-test-selection-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, text) => { const p = path.join(root, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
  write('tests/suites.json', JSON.stringify({ core: ['tests/core.test.js'], corePython: [], integration: ['tests/database.test.js'] }));
  write('tests/core.test.js', '');
  write('tests/database.test.js', '');
  write('tests/related.test.js', "require('../utils/outer');");
  write('tests/other.test.js', "require('../utils/other');");
  write('tests/browser.test.js', "require('playwright');");
  write('utils/outer.js', "require('./inner');");
  write('utils/inner.js', '');
  write('utils/other.js', '');
  return { root, write, select: files => plan({ root, mode: 'changed', files }) };
}

test('the default suite is explicit and excludes deep/database regressions', t => {
  const { root } = fixture(t);
  assert.deepEqual(plan({ root }).files, ['tests/core.test.js']);
});
test('transitive dependencies select related tests and always retain the core', t => {
  const { select } = fixture(t);
  assert.deepEqual(select(['utils/inner.js']).files, ['tests/core.test.js', 'tests/related.test.js']);
});
test('source/fixture reads and frontend changes retain their consumers and browser tests', t => {
  const { select, write } = fixture(t);
  write('tests/fixture.test.js', "readFile(path.join(root, 'fixtures', 'sample.json'));");
  assert.ok(select(['tests/fixtures/sample.json']).files.includes('tests/fixture.test.js'));
  assert.ok(select(['public/trinzo.css']).files.includes('tests/browser.test.js'));
});
test('JavaScript changes retain Python tests that inspect the same source', t => {
  const { select, write } = fixture(t);
  write('tests/test_frontend.py', "read_text('server.js')");
  write('tests/entry.test.js', "readFile('server.js')");
  const result = select(['server.js']);
  assert.equal(result.python, 'focused');
  assert.ok(result.pythonFiles.includes('test_frontend.py'));
});
test('provider wording selects its contracts and marks factual-quality review separately', t => {
  const { select, write } = fixture(t);
  write('tests/meeting-minutes-parallel.test.js', '');
  const result = select(['config/meeting-minutes-parallel/discussion.txt']);
  assert.deepEqual(result.files, ['tests/core.test.js', 'tests/meeting-minutes-parallel.test.js']);
  assert.equal(result.python, 'core');
  assert.equal(result.qualityReviewRequired, true);
});
test('Markdown used by a database workflow is not dismissed as documentation', t => {
  const { select, write } = fixture(t);
  write('tests/database.test.js', "readFile('CURRENT_PROJECT_STATUS.md')");
  assert.equal(select(['docs/CURRENT_PROJECT_STATUS.md']).integrationRequired, true);
});
test('an unmapped runtime change falls back to the full regression set', t => {
  const { select } = fixture(t), result = select(['utils/new-runtime.js']);
  assert.equal(result.files.length, 4);
  assert.equal(result.python, 'full');
  assert.match(result.reasons[0], /no reliable mapping/);
  assert.equal(result.integrationRequired, true);
});
test('changing test/install infrastructure selects the complete regressions', t => {
  const { select } = fixture(t), result = select(['scripts/run_tests.js']);
  assert.equal(result.files.length, 4);
  assert.equal(result.python, 'full');
});
test('a release without a baseline explicitly requires full regressions and real persistence checks', t => {
  const { root } = fixture(t), result = plan({ root, mode: 'release', all: true });
  assert.equal(result.files.length, 4);
  assert.equal(result.python, 'full');
  assert.equal(result.integrationRequired, true);
});
test('a newly added database fixture cannot be silently omitted from the integration suite', t => {
  const { root, write } = fixture(t);
  write('tests/new-database.test.js', 'const url = process.env.PROJECT_REPORT_TEST_DATABASE_URL;');
  assert.throws(() => plan({ root }), /Database fixtures must be classified/);
});
test('deleted modules still select tests importing the old path', t => {
  const { select, root } = fixture(t);
  fs.unlinkSync(path.join(root, 'utils/inner.js'));
  assert.ok(select(['utils/inner.js']).files.includes('tests/related.test.js'));
});
test('missing suite files, unavailable Git baselines and outside paths cannot silently pass', t => {
  const { select, root } = fixture(t);
  assert.throws(() => select(['../outside.js']), /inside the repository/);
  assert.throws(() => plan({ root, mode: 'changed', base: 'missing' }), /no checks were silently skipped/);
  fs.unlinkSync(path.join(root, 'tests/core.test.js'));
  assert.throws(() => plan({ root }), /missing file/);
});
test('database-sensitive changes require persistence checks before release', t => {
  const { root, write } = fixture(t);
  for (const file of ['utils/db.js', 'routes/projectRecords.js', 'routes/minutesFeedback.js',
    'utils/meetingMinutesDraftStorage.js', 'utils/meetingMinutesProcessing.js',
    'utils/meetingMinutesAgentGeneration.js', 'utils/meetingMinutesPeopleEvidence.js',
    'utils/meetingMinutesStagePersistence.js', 'utils/meetingMinutesPassCache.js',
    'utils/meetingMinutesDiscussionFingerprint.js', 'utils/meetingMinutesSource.js',
    'utils/canonicalMinutes/discussionClaimConsolidationState.js',
    'utils/canonicalMinutes/discussionActionRecovery.js',
    'utils/meetingMinutesOriginalExecution.js', 'utils/meetingMinutesOriginalDiscovery.js',
    'utils/meetingMinutesOriginalSummary.js', 'utils/meetingMinutesOriginalDiscussion.js',
    'utils/meetingMinutesOriginalActions.js', 'utils/meetingMinutesOriginalStages.js',
    'utils/meetingMinutesOriginalFinalization.js', 'utils/meetingMinutesOriginalEdits.js',
    'utils/meetingMinutesReviewAccounting.js', 'utils/meetingMinutesReviewFlags.js',
    'utils/meetingMinutesEvidenceContext.js', 'utils/meetingMinutesActionEvidence.js',
    'utils/meetingMinutesEvidenceResolution.js', 'utils/meetingMinutesReviewEvidence.js',
    'utils/meetingMinutesActionDuplicatePolicy.js', 'utils/meetingMinutesResultAggregation.js',
    'utils/meetingMinutesDiscussionNormalization.js',
    'utils/meetingMinutesEvidenceChecks.js',
    'utils/meetingMinutesActionSourceMatching.js',
    'utils/meetingMinutesActionFieldGrounding.js',
    'utils/meetingMinutesActionNormalization.js',
    'utils/meetingMinutesAssessmentEvidence.js',
    'utils/meetingMinutesResultNormalization.js',
    'utils/meetingMinutesActionTimingInference.js',
    'utils/meetingMinutesDiscoveryValidation.js',
    'utils/meetingMinutesRefereeCandidates.js',
    'utils/meetingMinutesPublication.js',
    'utils/meetingMinutesDiscussionFinalization.js',
    'utils/meetingMinutesDiscussionSelection.js',
    'utils/meetingMinutesSummaryPublication.js',
    'utils/meetingMinutesReviewerEdits.js',
    'utils/meetingMinutesText.js',
    'routes/projectContext.js',
    'routes/projectKnowledge.js', 'utils/requestFlags.js', 'routes/generationJobs.js',
    'routes/meetingMinutesJobs.js', 'utils/meetingMinutesJobEdits.js',
    'utils/meetingMinutesDraftContext.js', 'utils/meetingMinutesResponseContracts.js',
    'utils/meetingMinutesRefereeBatches.js', 'utils/meetingMinutesDiscussionRows.js']) {
    write('tests/consumer.test.js', "readFile('" + path.basename(file) + "')");
    const result = plan({ root, mode: 'release', files: [file] });
    assert.equal(result.integrationRequired, true, file);
    assert.ok(result.reasons.every(reason => !reason.includes('no reliable mapping')), file);
  }
  assert.equal(plan({ root, mode: 'release', files: ['README.md'] }).integrationRequired, false);
});
test('production database configuration is never used as the integration fallback', () => {
  assert.throws(() => integrationEnvironment({ DATABASE_URL: 'postgres://production/real_data' }), /Production DATABASE_URL is never a fallback/);
  assert.throws(() => integrationEnvironment({ TEST_DATABASE_URL: 'postgres://localhost/real_data' }), /only accept/);
});
test('an explicit disposable database configures every integration fixture and replaces inherited credentials', () => {
  const url = 'postgresql://fixture@localhost/trinzo_tasks_test';
  const env = integrationEnvironment({ TEST_DATABASE_URL: url, DATABASE_URL: 'postgres://production/real_data', PGPASSWORD: 'inherited' });
  for (const key of ['DATABASE_URL', 'INTERNAL_AI_TASK_TEST_DATABASE_URL', 'PROJECT_REPORT_TEST_DATABASE_URL', 'SETTINGS_TEST_DATABASE_URL']) assert.equal(env[key], url);
  assert.equal(env.PGPASSWORD, undefined);
});
test('release fails before executing tests when required database fixtures are unavailable', () => {
  const env = { ...process.env };
  for (const key of ['TEST_DATABASE_URL', 'INTERNAL_AI_TASK_TEST_DATABASE_URL', 'PROJECT_REPORT_TEST_DATABASE_URL', 'SETTINGS_TEST_DATABASE_URL']) delete env[key];
  const result = spawnSync(process.execPath, ['scripts/run_tests.js', 'release', '--all'], { cwd: path.resolve(__dirname, '..'), env, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Database checks require/);
  assert.doesNotMatch(result.stdout, /TAP version/);
});
test('release cannot replace all Git changes with a hand-picked development file list', () => {
  const result = spawnSync(process.execPath, ['scripts/run_tests.js', 'release', '--file', 'README.md', '--list'], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 10000
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /release checks derive all changes from Git/);
});
