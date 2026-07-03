const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoDir = path.resolve(__dirname, '..');
const fixture = JSON.parse(fs.readFileSync(path.join(repoDir, 'tests/fixtures/project_context_contract.json'), 'utf8'));
const dbSource = fs.readFileSync(path.join(repoDir, 'utils/db.js'), 'utf8');
const apiSource = fs.readFileSync(path.join(repoDir, 'routes/api.js'), 'utf8');
const migrationSource = fs.readFileSync(path.join(repoDir, 'sql/migrations/20260703_add_project_knowledge_schema.sql'), 'utf8');
const serverSource = fs.readFileSync(path.join(repoDir, 'server.js'), 'utf8');
const knowledgeSource = fs.readFileSync(path.join(repoDir, 'utils/knowledge.js'), 'utf8');
const backfillSource = fs.readFileSync(path.join(repoDir, 'scripts/backfill_project_knowledge.js'), 'utf8');
const contextPageSource = fs.readFileSync(path.join(repoDir, 'views/project-update-context.html'), 'utf8');
const roadmapPageSource = fs.readFileSync(path.join(repoDir, 'views/project-update-roadmap.html'), 'utf8');
const dashboardPageSource = fs.readFileSync(path.join(repoDir, 'views/dashboard.html'), 'utf8');
const archivePageSource = fs.readFileSync(path.join(repoDir, 'views/archive.html'), 'utf8');

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

test('project knowledge phase 1 surfaces schema and protected endpoints', () => {
  assert.ok(migrationSource.includes('project_knowledge_items'));
  assert.ok(migrationSource.includes('project_knowledge_chunks'));
  assert.ok(migrationSource.includes('VECTOR(384)'));
  assert.ok(apiSource.includes("router.post('/project-update-test/knowledge/items', requireAuth"));
  assert.ok(apiSource.includes("router.post('/project-update-test/knowledge/embeddings/process', requireAuth"));
  assert.ok(apiSource.includes("router.get('/project-update-test/knowledge/status', requireAuth"));
  assert.ok(serverSource.includes('startProjectKnowledgeEmbedInterval'));
  assert.ok(knowledgeSource.includes('runProjectKnowledgeRetrieval'));
  assert.ok(apiSource.includes('runProjectKnowledgeRetrieval'));
  assert.ok(apiSource.includes('skipKnowledge'));
  assert.ok(apiSource.includes('projectContext.retrievedKnowledge'));
  assert.ok(backfillSource.includes('ingestApprovedProjectReportVersion'));
  assert.ok(apiSource.includes("router.post('/project-update-test/knowledge/ask', requireAuth"));
  assert.ok(knowledgeSource.includes('answerProjectKnowledge'));
  assert.ok(knowledgeSource.includes('Cite chunk ids explicitly'));
  assert.ok(knowledgeSource.includes('answerMode: \'retrieval_only\''));
  assert.ok(contextPageSource.includes('Ask this project'));
  assert.ok(contextPageSource.includes('/api/project-update-test/knowledge/ask'));
});

test('dashboard and archive keep the active tool infrastructure organised', () => {
  const serverSource = fs.readFileSync(path.join(repoDir, 'server.js'), 'utf8');
  assert.ok(serverSource.includes("sendView(res, 'dashboard.html')"));
  assert.ok(serverSource.includes("app.get('/archive'"));
  assert.ok(serverSource.includes("'/archive/legacy-transcript-workflow': 'index.html'"));
  assert.ok(serverSource.includes("'/meeting-minutes-test': '/archive/meeting-minutes-test'"));
  assert.ok(dashboardPageSource.includes('Meeting transcript to minutes'));
  assert.ok(dashboardPageSource.includes('Project update tool'));
  assert.ok(dashboardPageSource.includes('Older labs and prototypes'));
  assert.ok(archivePageSource.includes('Legacy / archived'));
  assert.ok(archivePageSource.includes('/archive/meeting-minutes-minilm-only'));
});

test('project update roadmap page keeps deferred lifecycle ideas visible', () => {
  const serverSource = fs.readFileSync(path.join(repoDir, 'server.js'), 'utf8');
  assert.ok(serverSource.includes("app.get('/project-update-test/roadmap'"));
  assert.ok(roadmapPageSource.includes('Project update roadmap'));
  assert.ok(roadmapPageSource.includes('Auto-compaction and retention policy'));
  assert.ok(roadmapPageSource.includes('Never auto-archive official/manual background docs'));
  assert.ok(contextPageSource.includes('/project-update-test/roadmap'));
});
