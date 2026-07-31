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
const projectStageSetupSource = fs.readFileSync(path.join(repoDir, 'public/project-stage-setup.js'), 'utf8');
const projectStageProcessSource = fs.readFileSync(path.join(repoDir, 'public/project-stage-process.js'), 'utf8');
const projectStageReportsSource = fs.readFileSync(path.join(repoDir, 'public/project-stage-reports.js'), 'utf8');
const projectStageInsightsSource = fs.readFileSync(path.join(repoDir, 'public/project-stage-insights.js'), 'utf8');
const roadmapPageSource = fs.readFileSync(path.join(repoDir, 'views/project-update-roadmap.html'), 'utf8');
const dashboardPageSource = fs.readFileSync(path.join(repoDir, 'views/dashboard.html'), 'utf8');
const reportsPageSource = fs.readFileSync(path.join(repoDir, 'views/project-update-reports.html'), 'utf8');
const sharedCssSource = fs.readFileSync(path.join(repoDir, 'public/trinzo.css'), 'utf8');

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
  assert.ok(apiSource.includes("router.get('/project-update-test/projects', requireAuth"));
  assert.ok(apiSource.includes("router.post('/project-update-test/projects', requireAuth"));
  assert.ok(apiSource.includes("router.patch('/project-update-test/projects/:projectId', requireAuth"));
  assert.ok(apiSource.includes("router.delete('/project-update-test/projects/:projectId', requireAuth"));
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

test('dashboard keeps only active tool infrastructure visible', () => {
  const serverSource = fs.readFileSync(path.join(repoDir, 'server.js'), 'utf8');
  assert.ok(serverSource.includes("sendView(res, 'dashboard.html')"));
  assert.ok(!serverSource.includes("app.get('/archive'"));
  assert.ok(!serverSource.includes("'/archive/legacy-transcript-workflow': 'index.html'"));
  assert.ok(!serverSource.includes("'/meeting-minutes-test': '/archive/meeting-minutes-test'"));
  assert.ok(!apiSource.includes("router.post('/meeting-minutes-test'"));
  assert.ok(!apiSource.includes("router.post('/meeting-minutes-numbers'"));
  assert.ok(!apiSource.includes("router.post('/meeting-minutes-comparison'"));
  assert.ok(!apiSource.includes("router.post('/meeting-minutes-minilm-only'"));
  assert.ok(dashboardPageSource.includes('Meeting transcript to minutes'));
  assert.ok(dashboardPageSource.includes('Project workspace'));
  assert.ok(!dashboardPageSource.includes('Older labs and prototypes'));
  assert.ok(!dashboardPageSource.includes('href="/archive"'));
});

test('project update roadmap page keeps deferred lifecycle ideas visible', () => {
  const serverSource = fs.readFileSync(path.join(repoDir, 'server.js'), 'utf8');
  assert.ok(serverSource.includes("app.get('/project-update-test/roadmap'"));
  assert.ok(serverSource.includes("app.get('/roadmap'"));
  assert.ok(roadmapPageSource.includes('Project update roadmap'));
  assert.ok(roadmapPageSource.includes('Knowledge lifecycle'));
  assert.ok(roadmapPageSource.includes('Never automatically archiving official or manually curated knowledge'));
  assert.ok(contextPageSource.includes('/project-update-test/roadmap'));
});

test('project report lifecycle archives instead of hard deleting reports', () => {
  assert.ok(dbSource.includes("SET report_status = 'archived'"));
  assert.ok(dbSource.includes('archivedCount'));
  assert.ok(dbSource.includes('WHERE id = ANY($1::bigint[])'));
  assert.ok(projectStageReportsSource.includes('Archive selected'));
  assert.ok(projectStageReportsSource.includes('keeps its version history'));
  assert.ok(projectStageReportsSource.includes('removes it from active reports and project context'));
});

test('project workspace labels separate memory, draft reports and evidence', () => {
  assert.ok(projectStageSetupSource.includes('Before the first report'));
  assert.ok(projectStageSetupSource.includes('Project memory'));
  assert.ok(projectStageSetupSource.includes('Memory search maintenance'));
  assert.ok(projectStageSetupSource.includes('Search status'));
  assert.ok(projectStageProcessSource.includes('Create draft report'));
  assert.ok(projectStageProcessSource.includes('Project update meeting'));
  assert.ok(projectStageProcessSource.includes('evidence must come from this update'));
  assert.ok(projectStageInsightsSource.includes('stored project memory'));
  assert.ok(projectStageInsightsSource.includes('Suggested follow-up risks'));
});

test('light theme keeps project health trend colours readable', () => {
  assert.ok(sharedCssSource.includes('.trend-improving'));
  assert.ok(sharedCssSource.includes('background:var(--ok-bg) !important'));
  assert.ok(sharedCssSource.includes('color:var(--ok-text) !important'));
  assert.ok(sharedCssSource.includes('font-weight:700 !important'));
});

test('saved report detail tables keep readable light-theme contrast', () => {
  assert.ok(reportsPageSource.includes('<body class="project-report-page">'));
  assert.ok(sharedCssSource.includes('.project-report-page .long-text-cell'));
  assert.ok(sharedCssSource.includes('.project-report-page .status-completed'));
  assert.ok(sharedCssSource.includes('.project-report-page .status-improving'));
  assert.ok(sharedCssSource.includes('.project-report-page .status-on_track'));
  assert.ok(sharedCssSource.includes('.project-report-page .status-stable'));
  assert.ok(sharedCssSource.includes('.project-report-page .nav .brand img'));
  assert.ok(sharedCssSource.includes('background:transparent !important'));
  assert.ok(sharedCssSource.includes('color:var(--text) !important'));
  assert.ok(sharedCssSource.includes('color:var(--ok-text) !important'));
  assert.ok(reportsPageSource.includes('.status-completed, .status-approved, .status-resolved, .status-improving'));
  assert.ok(reportsPageSource.includes('.brand .print-only'));
  assert.ok(!reportsPageSource.includes('.brand img { width:132px'));
});

test('project workspace heading hierarchy promotes the project title', () => {
  assert.ok(sharedCssSource.includes('.project-bar .identity .name'));
  assert.ok(sharedCssSource.includes('font-size:2.15rem !important'));
  assert.ok(!sharedCssSource.includes('.insights-header-panel h1'));
  assert.ok(!projectStageInsightsSource.includes('panel insights-header-panel'));
});

test('project bar behaves like scoped project navigation', () => {
  const workspaceShell = fs.readFileSync(path.join(repoDir, 'public/project-workspace.js'), 'utf8');
  assert.ok(workspaceShell.includes('project-nav'));
  assert.ok(workspaceShell.includes('data-project-nav="overview"'));
  assert.ok(workspaceShell.includes('data-project-nav="process"'));
  assert.ok(workspaceShell.includes('data-project-nav="reports"'));
  assert.ok(workspaceShell.includes('data-project-nav="ask"'));
  assert.ok(!workspaceShell.includes('data-project-nav="switch"'));
  assert.ok(workspaceShell.includes('workspaceStageUrl(\'process\')'));
  assert.ok(workspaceShell.includes('workspaceStageUrl(\'ask\')'));
  assert.ok(workspaceShell.includes("goToStage('process', true)"));
  assert.ok(workspaceShell.includes("goToStage('ask', true)"));
  assert.ok(workspaceShell.includes('project-nav-icon" aria-hidden="true">+</span><span>Process meeting</span>'));
  assert.ok(workspaceShell.includes('project-nav-icon" aria-hidden="true">&#128172;</span><span>Ask</span>'));
  assert.ok(workspaceShell.indexOf('>Overview</a>') < workspaceShell.indexOf('>Process meeting</span></a>'));
  assert.ok(workspaceShell.indexOf('>Process meeting</span></a>') < workspaceShell.indexOf('>Reports</a>'));
  assert.ok(workspaceShell.includes('id="openProjectProcessBtn"'));
  assert.ok(workspaceShell.includes('projectChooserUrl'));
  assert.ok(workspaceShell.includes('id="switchProjectLink"'));
  assert.ok(workspaceShell.includes('class="project-switch-link"'));
  assert.ok(workspaceShell.includes('target="_blank"'));
  assert.ok(workspaceShell.includes('rel="noopener"'));
  assert.ok(!workspaceShell.includes('switchProjectBtn'));
  assert.ok(workspaceShell.includes('project-switch-arrow'));
  assert.ok(workspaceShell.includes('&rarr;'));
  assert.ok(workspaceShell.includes('class="project-nav-link icon-only"'));
  assert.ok(workspaceShell.includes('aria-label="Settings"'));
  assert.ok(workspaceShell.includes('&#9881;'));
  assert.ok(!workspaceShell.includes('data-project-nav="settings">Settings</a>'));
  assert.ok(workspaceShell.includes('project-summary'));
  assert.ok(workspaceShell.includes('View your current project position, project profile and recent reports.'));
  assert.ok(workspaceShell.includes('aria-current'));
  assert.ok(sharedCssSource.includes('.project-nav-link.active'));
  assert.ok(sharedCssSource.includes('.project-nav-link.icon-only'));
  assert.ok(sharedCssSource.includes('.project-switch-link'));
  assert.ok(sharedCssSource.includes('color:var(--text) !important'));
  assert.ok(sharedCssSource.includes('color:var(--heading) !important'));
  assert.ok(sharedCssSource.includes('.project-bar .project-summary'));
  assert.ok(sharedCssSource.includes('.ask-panel-standalone .ask-layout'));
  assert.ok(sharedCssSource.includes('grid-template-columns:1fr !important'));
  assert.ok(projectStageInsightsSource.includes('id="ask-this-project"'));
  assert.ok(projectStageInsightsSource.includes('window.ProjectStages.ask'));
  assert.ok(projectStageInsightsSource.includes('ask-panel-standalone'));
  assert.ok(!workspaceShell.includes('#ask-this-project'));
});

test('mobile project profile row actions stay compact and distinct', () => {
  assert.ok(sharedCssSource.includes('.profile-editor-table .actions'));
  assert.ok(sharedCssSource.includes('grid-template-columns:repeat(2, minmax(0, 1fr)) !important'));
  assert.ok(sharedCssSource.includes('.profile-editor-table .actions [data-expand-edit-row]'));
  assert.ok(sharedCssSource.includes('.profile-editor-table .actions button.danger'));
  assert.ok(sharedCssSource.includes('.profile-editor-table { min-width:980px !important; }'));
  assert.ok(sharedCssSource.includes('.profile-editor-table .profile-monitor-column'));
  assert.ok(sharedCssSource.includes('width:60px !important'));
  assert.ok(projectStageInsightsSource.includes('suggested-risk-actions'));
  assert.ok(projectStageInsightsSource.includes('suggested-risk-table'));
  assert.ok(sharedCssSource.includes('.profile-editor-table .suggested-risk-actions'));
});

test('settings quick links are visible without an accordion', () => {
  const workspaceSource = fs.readFileSync(path.join(repoDir, 'public/project-workspace.js'), 'utf8');
  assert.ok(projectStageInsightsSource.includes('renderSupportActions'));
  assert.ok(workspaceSource.includes('<section class="panel quick-links">'));
  assert.ok(workspaceSource.includes('<h2>Quick links</h2>'));
  assert.ok(!workspaceSource.includes('<details class="supporting-tools">'));
  assert.ok(!workspaceSource.includes('class="supporting-tools" ${'));
});
