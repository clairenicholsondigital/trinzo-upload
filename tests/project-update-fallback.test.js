'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), { spawnSync } = require('node:child_process');
const { buildFallbackProjectReport } = require('../utils/projectUpdateFallback');

test('actual offline backup output becomes a complete editable report with a consistent assessment', () => {
  const py = spawnSync(process.env.PROJECT_HISTORY_TEST_PYTHON || '/srv/m365-agent-test/.venv/bin/python', ['-c', "import json\nfrom scripts.python_llm import analyse\nprint(json.dumps(analyse('Sam: The migration is blocked because supplier approval has not arrived.')))"], { cwd: require('node:path').resolve(__dirname, '..'), encoding: 'utf8', timeout: 30000, env: { ...process.env, PYTHONDONTWRITEBYTECODE:'1', HF_HUB_OFFLINE:'1', TRANSFORMERS_OFFLINE:'1' } });
  assert.equal(py.status, 0, py.stderr);
  const raw = JSON.parse(py.stdout), original = structuredClone(raw), report = buildFallbackProjectReport(raw);
  assert(report.summary.trim());
  assert.equal(report.overallHealthRag, raw.project_health_summary.overall_health);
  assert.equal(report.healthAreas.schedule.status, report.overallHealth);
  assert.deepEqual(report.milestones, raw.segments);
  assert.deepEqual(report.actions, raw.actions);
  assert.deepEqual(raw, original);
  for (const key of ['milestones','risks','actions','keyUpdates']) assert(Array.isArray(report[key]));
  assert.equal(Object.keys(report.healthAreas).length, 5);
  assert.equal(report.reportStatus, 'draft');
});

test('missing or malformed backup health does not imply Green or invent evidence', () => {
  for (const raw of [{}, { project_health_summary:{ overall_health:'green' } }, { project_health_summary:{overall_health:'bad',overall_health_reason:'Not assessed.'} }, {segments:[null,'invalid']}]) {
    const r = buildFallbackProjectReport(raw);
    assert.equal(r.overallHealth, 'unknown');
    assert.equal(r.overallHealthRag, 'unknown');
    assert.equal(r.healthAreas.schedule.status, 'unknown');
    assert.equal(r.healthAreas.scope.status, 'unknown');
    assert.deepEqual(r.healthAreas.scope.evidence, []);
    assert(r.summary);
  }
});
