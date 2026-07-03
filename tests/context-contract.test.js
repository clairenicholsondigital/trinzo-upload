const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoDir = path.resolve(__dirname, '..');
const fixture = JSON.parse(fs.readFileSync(path.join(repoDir, 'tests/fixtures/project_context_contract.json'), 'utf8'));
const dbSource = fs.readFileSync(path.join(repoDir, 'utils/db.js'), 'utf8');
const apiSource = fs.readFileSync(path.join(repoDir, 'routes/api.js'), 'utf8');

test('canonical project context fixture contains the Node/Python boundary keys', () => {
  for (const key of [
    'projectId',
    'projectName',
    'found',
    'projectResolution',
    'activeMilestones',
    'activeRisks',
    'recentReports',
    'healthHistory',
    'milestoneHistory',
    'riskSuggestions',
    'latestSnapshot',
    'generatedAt'
  ]) {
    assert.ok(Object.hasOwn(fixture, key), `missing ${key}`);
  }
  const milestone = fixture.activeMilestones[0];
  for (const key of ['comparisonKey', 'latestAssessment', 'previousAssessment']) {
    assert.ok(Object.hasOwn(milestone, key), `missing activeMilestones[].${key}`);
  }
});

test('project context producer preserves the contract and deterministic resolution fields', () => {
  for (const token of [
    "projectResolution",
    "activeMilestones",
    "riskSuggestions",
    "latestSnapshot",
    "listProjectOptions",
    "resolveProjectForContext"
  ]) {
    assert.ok(dbSource.includes(token), `utils/db.js should contain ${token}`);
  }
  assert.ok(apiSource.includes("router.get('/project-update-test/projects'"));
  assert.ok(apiSource.includes('projectId'));
});
