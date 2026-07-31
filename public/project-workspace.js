// Workspace controller: owns project selection + the project-update meeting
// scaffold. Renders a project chooser when nothing is selected, otherwise opens
// straight into the update meeting flow with supporting tools tucked away.
(function () {
  const PW = window.ProjectWorkspace;
  const Stages = window.ProjectStages || {};
  const root = document.getElementById('workspaceRoot');
  const { escapeHtml } = PW;

  const STAGES = [
    { key: 'process', no: 1, label: 'Update meeting', hint: 'Run the meeting → draft report' },
    { key: 'insights', no: 2, label: 'Project profile', hint: 'Milestones, risks & baseline' },
    { key: 'reports', no: 3, label: 'Saved reports', hint: 'Review previous updates' },
    { key: 'setup', no: 4, label: 'Setup', hint: 'Milestones & project memory' }
  ];
  const STAGE_KEYS = STAGES.map((stage) => stage.key);

  // process is mounted once and kept alive so in-progress transcript text is not
  // lost when switching tabs; data stages rebuild on each activation for freshness.
  const PERSISTENT_STAGES = new Set(['process']);
  const mounted = {};

  function currentStageKey() {
    const requested = new URLSearchParams(location.search).get('stage');
    return STAGE_KEYS.includes(requested) ? requested : 'process';
  }

  function requestedProjectName() {
    return (new URLSearchParams(location.search).get('projectName') || '').trim().toLowerCase();
  }

  function setStageInUrl(stageKey, replace) {
    const params = new URLSearchParams(location.search);
    params.set('stage', stageKey);
    const url = `${location.pathname}?${params.toString()}`;
    if (replace) history.replaceState({ stage: stageKey }, '', url);
    else history.pushState({ stage: stageKey }, '', url);
  }

  function statusPill(status) {
    const value = String(status || 'active').toLowerCase();
    return `<span class="status-pill" data-status="${escapeHtml(value)}">${escapeHtml(value)}</span>`;
  }

  function projectCard(project, currentProjectId) {
    const selected = String(project.projectId) === String(currentProjectId || '');
    return `
      <button type="button" class="project-card ${selected ? 'selected' : ''}" data-open-project="${escapeHtml(project.projectId)}" aria-current="${selected ? 'true' : 'false'}">
        <span class="pc-name">${escapeHtml(project.projectName || `Project ${project.projectId}`)}</span>
        <span class="muted">${escapeHtml(project.clientName || 'No client set')}</span>
        <span class="pc-meta">
          ${statusPill(project.status)}
          <span class="badge muted">${escapeHtml(project.reportCount || 0)} reports</span>
          <span class="badge muted">${escapeHtml(project.activeMilestoneCount || 0)} milestones</span>
          ${selected ? '<span class="badge success">Current</span>' : ''}
        </span>
      </button>
    `;
  }

  // ---- Project chooser -------------------------------------------------------

  function renderChooser(projects) {
    Object.keys(mounted).forEach((key) => delete mounted[key]);
    root.innerHTML = `
      <section class="panel">
        <h1>Project workspace</h1>
        <p class="intro">Pick a project, then use the workspace as a scaffold for the next project update meeting. Profile/admin tools stay scoped to the project you choose.</p>
      </section>
      <section class="panel">
        <h2>Your projects</h2>
        <div id="chooserGrid" class="chooser-grid"></div>
      </section>
      <section class="panel">
        <h2>New project</h2>
        <div class="form-grid">
          <label class="wide">Project name <input id="newProjectName" type="text" placeholder="e.g. Acme platform rollout" /></label>
          <label>Client <input id="newProjectClient" type="text" placeholder="Optional client" /></label>
          <label>Status
            <select id="newProjectStatus">
              <option value="active">Active</option>
              <option value="paused">Paused</option>
              <option value="completed">Completed</option>
              <option value="archived">Archived</option>
            </select>
          </label>
          <label class="full">Description <textarea id="newProjectDescription" placeholder="Optional project notes"></textarea></label>
          <button id="createProjectBtn" class="primary" type="button">Create and open</button>
        </div>
        <p id="createProjectStatus" class="status"></p>
      </section>
    `;

    const grid = document.getElementById('chooserGrid');
    grid.innerHTML = projects.length
      ? projects.map((project) => projectCard(project, PW.getSelectedProjectId())).join('')
      : '<p class="empty-state">No projects yet. Create your first one below.</p>';

    grid.querySelectorAll('[data-open-project]').forEach((card) => {
      card.addEventListener('click', () => openProject(card.getAttribute('data-open-project')));
    });

    const createBtn = document.getElementById('createProjectBtn');
    createBtn.addEventListener('click', async () => {
      const status = document.getElementById('createProjectStatus');
      const projectName = document.getElementById('newProjectName').value.trim();
      if (!projectName) {
        status.className = 'status error';
        status.textContent = 'Project name is required.';
        return;
      }
      createBtn.disabled = true;
      status.className = 'status';
      status.textContent = 'Creating project…';
      try {
        const payload = await PW.request('projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectName,
            clientName: document.getElementById('newProjectClient').value.trim(),
            status: document.getElementById('newProjectStatus').value,
            description: document.getElementById('newProjectDescription').value.trim()
          })
        });
        await PW.loadProjects();
        openProject(payload.project.projectId);
      } catch (error) {
        status.className = 'status error';
        status.textContent = error.message || 'Could not create project.';
        createBtn.disabled = false;
      }
    });
  }

  function openProject(projectId) {
    PW.setSelectedProjectId(projectId);
    setStageInUrl(currentStageKey(), true);
    renderWorkspace();
  }

  // ---- Workspace (bar + tabs + stage panel) ---------------------------------

  function renderProjectBar(project) {
    const status = String(project.status || 'active').toLowerCase();
    const contextWarning = ['paused', 'archived', 'completed'].includes(status)
      ? `<div class="safeguard-banner warning"><strong>Check project context:</strong> this project is ${escapeHtml(status)}. Do not process a new client update here unless that status is intentional.</div>`
      : '';
    return `
      <section class="panel project-bar">
        <div class="identity">
          <span class="eyebrow">Project workspace</span>
          <span class="name">${escapeHtml(project.projectName || `Project ${project.projectId}`)}</span>
          <span class="meta">
            <span class="muted">${escapeHtml(project.clientName || 'No client set')}</span>
            ${statusPill(project.status)}
            <span class="badge muted">${escapeHtml(project.reportCount || 0)} reports</span>
            <span class="badge muted">${escapeHtml(project.activeMilestoneCount || 0)} milestones</span>
          </span>
        </div>
        <div class="bar-actions">
          <button id="switchProjectBtn" class="secondary" type="button">Switch project</button>
          <button id="openProjectProfileBtn" class="primary" type="button">Open project profile</button>
        </div>
      </section>
      ${contextWarning}
    `;
  }

  function renderProjectSwitcher(project) {
    const projects = PW.getCachedProjects();
    const otherProjects = projects.filter((item) => String(item.projectId) !== String(project.projectId));
    const previewProjects = [project, ...otherProjects].slice(0, 4);
    const hiddenCount = Math.max(projects.length - previewProjects.length, 0);
    return `
      <section class="panel project-switcher-panel">
        <div>
          <span class="eyebrow">Choose project</span>
          <h2>Working in: ${escapeHtml(project.projectName || `Project ${project.projectId}`)}</h2>
          <p class="intro">Projects are separate workspaces. Pick another project below, or use the full chooser to create/manage projects.</p>
        </div>
        <div class="compact-project-grid">
          ${previewProjects.map((item) => projectCard(item, project.projectId)).join('')}
        </div>
        <div class="actions switcher-actions">
          <button id="openProjectChooserBtn" type="button">View all projects${hiddenCount ? ` (+${hiddenCount})` : ''}</button>
          <button id="hideProjectSwitcherBtn" class="secondary" type="button">Hide project list</button>
        </div>
      </section>
    `;
  }

  function renderStageTabs(activeKey) {
    return `
      <details class="supporting-tools">
        <summary>Supporting tools</summary>
        <p class="muted">Most updates should start on <strong>Update meeting</strong>. Use these when you need to adjust the project profile, review old reports, or do admin maintenance.</p>
        <nav class="stage-tabs" aria-label="Workspace stages">
        ${STAGES.map((stage) => `
          <button type="button" class="stage-tab ${stage.key === activeKey ? 'active' : ''}" data-stage="${stage.key}" aria-current="${stage.key === activeKey ? 'page' : 'false'}">
            <span class="step-no">${stage.no}</span>
            <span><span class="step-label">${escapeHtml(stage.label)}</span> <span class="step-hint">${escapeHtml(stage.hint)}</span></span>
          </button>
        `).join('')}
        </nav>
        <div id="stageSupportActions" class="stage-support-actions"></div>
      </details>
    `;
  }

  function stageContext(project) {
    return {
      projectId: String(project.projectId),
      project,
      workspace: PW,
      exportProjectOverview,
      reloadProject: async () => {
        await PW.loadProjects();
        const fresh = PW.getProject(project.projectId);
        if (fresh) refreshProjectBar(fresh);
      }
    };
  }

  function refreshProjectBar(project) {
    const bar = root.querySelector('.project-bar');
    if (!bar) return;
    const meta = bar.querySelector('.meta');
    if (meta) {
      meta.innerHTML = `
        <span class="muted">${escapeHtml(project.clientName || 'No client set')}</span>
        ${statusPill(project.status)}
        <span class="badge muted">${escapeHtml(project.reportCount || 0)} reports</span>
        <span class="badge muted">${escapeHtml(project.activeMilestoneCount || 0)} milestones</span>
      `;
    }
    const name = bar.querySelector('.identity .name');
    if (name) name.textContent = project.projectName || `Project ${project.projectId}`;
  }

  function showStage(project, stageKey) {
    const panel = document.getElementById('stagePanel');
    if (!panel) return;
    const supportActions = document.getElementById('stageSupportActions');
    if (supportActions) supportActions.innerHTML = '';
    root.querySelectorAll('[data-stage]').forEach((tab) => {
      const active = tab.getAttribute('data-stage') === stageKey;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-current', active ? 'page' : 'false');
    });

    // Hide every mounted stage container.
    Array.from(panel.children).forEach((child) => { child.hidden = true; });

    const stage = Stages[stageKey];
    if (!stage || typeof stage.mount !== 'function') {
      let missing = mounted[`__missing_${stageKey}`];
      if (!missing) {
        missing = document.createElement('div');
        missing.innerHTML = `<section class="panel"><p class="status error">Stage "${escapeHtml(stageKey)}" is unavailable.</p></section>`;
        panel.appendChild(missing);
        mounted[`__missing_${stageKey}`] = missing;
      }
      missing.hidden = false;
      return;
    }

    let container = mounted[stageKey];
    if (container && PERSISTENT_STAGES.has(stageKey)) {
      container.hidden = false;
      return;
    }
    // Rebuild data stages each activation for fresh data.
    if (container) container.remove();
    container = document.createElement('div');
    panel.appendChild(container);
    mounted[stageKey] = container;
    container.hidden = false;
    try {
      stage.mount(container, stageContext(project));
    } catch (error) {
      container.innerHTML = `<section class="panel"><p class="status error">${escapeHtml(error.message || 'Could not load this stage.')}</p></section>`;
    }
  }

  function goToStage(stageKey, push) {
    if (!STAGE_KEYS.includes(stageKey)) stageKey = 'process';
    setStageInUrl(stageKey, !push);
    const project = PW.getProject(PW.getSelectedProjectId());
    if (project) showStage(project, stageKey);
  }

  function attachProjectBarActions(project) {
    const switchBtn = document.getElementById('switchProjectBtn');
    const profileBtn = document.getElementById('openProjectProfileBtn');

    if (switchBtn) switchBtn.addEventListener('click', () => {
      renderChooser(PW.getCachedProjects());
    });
    if (profileBtn) profileBtn.addEventListener('click', () => {
      goToStage('insights', true);
    });
  }

  function safeFilename(value) {
    return String(value || 'project-overview')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'project-overview';
  }

  function mdLine(value) {
    return String(value || '').trim() || '-';
  }

  function mdDate(value) {
    return PW.displayDate ? PW.displayDate(value) : (value ? String(value).slice(0, 10) : '-');
  }

  function buildProjectOverviewMarkdown(project, context = {}) {
    const milestones = PW.asArray(context.activeMilestones);
    const risks = PW.asArray(context.activeRisks);
    const reports = PW.asArray(context.recentReports);
    const health = PW.asArray(context.healthHistory);
    const generatedAt = new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
    const lines = [
      `# ${mdLine(project.projectName || context.projectName || 'Project overview')}`,
      '',
      `Generated: ${generatedAt}`,
      `Client: ${mdLine(project.clientName || context.clientName)}`,
      `Status: ${mdLine(project.status || context.status)}`,
      project.description ? `Description: ${mdLine(project.description)}` : '',
      '',
      '## Monitored milestones',
      ''
    ].filter((line) => line !== '');

    if (milestones.length) {
      milestones.forEach((milestone) => {
        const latest = milestone.latestAssessment || {};
        lines.push(
          `### ${mdLine(PW.friendlyLabel(milestone.milestoneName))}`,
          `- Category: ${mdLine(milestone.category)}`,
          `- Baseline date: ${mdDate(milestone.baselineFinishDate)}`,
          `- Forecast date: ${mdDate(milestone.forecastFinishDate || latest.forecastFinishDate)}`,
          `- Latest status: ${mdLine(PW.friendlyLabel(latest.status))}`,
          `- Trend: ${mdLine(PW.friendlyLabel(latest.trend))}`,
          `- Summary: ${mdLine(latest.summary || milestone.description)}`,
          ''
        );
      });
    } else {
      lines.push('- No monitored milestones.', '');
    }

    lines.push('## Monitored risks', '');
    if (risks.length) {
      risks.forEach((risk) => {
        lines.push(
          `### ${mdLine(risk.riskTitle || 'Risk')}`,
          `- Category: ${mdLine(risk.category)}`,
          `- Description: ${mdLine(risk.description)}`,
          `- Mitigation/check: ${mdLine(risk.mitigation)}`,
          ''
        );
      });
    } else {
      lines.push('- No monitored risks.', '');
    }

    lines.push('## Project health overview', '');
    if (health.length) {
      health.forEach((item) => {
        lines.push(`- ${mdLine(PW.friendlyLabel(item.area))}: ${mdLine(PW.friendlyLabel(item.status))}; trend ${mdLine(PW.friendlyLabel(item.trend))}; confidence ${mdLine(item.confidence)}. ${mdLine(item.rationale)}`);
      });
      lines.push('');
    } else {
      lines.push('- No project health overview yet.', '');
    }

    lines.push('## Recent reports', '');
    if (reports.length) {
      reports.forEach((report) => {
        lines.push(`- Report ${mdLine(report.reportId)} (${mdLine(report.periodLabel)}): ${mdLine(report.summary)} — /project-update-test/reports/${mdLine(report.reportId)}`);
      });
    } else {
      lines.push('- No saved reports yet.');
    }

    return `${lines.join('\n')}\n`;
  }

  async function exportProjectOverview(project, button) {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = 'Exporting…';
    try {
      const payload = await PW.request(`context?projectId=${encodeURIComponent(project.projectId)}&limit=20`);
      const markdown = buildProjectOverviewMarkdown(project, payload.context || {});
      const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${safeFilename(project.projectName)}-project-overview.md`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      window.alert(error.message || 'Could not export project overview.');
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  function attachProjectSwitcher(project) {
    const slot = document.getElementById('projectSwitcherSlot');
    const fullChooserBtn = document.getElementById('openProjectChooserBtn');
    const hideBtn = document.getElementById('hideProjectSwitcherBtn');
    if (!slot) return;
    slot.querySelectorAll('[data-open-project]').forEach((card) => {
      card.addEventListener('click', () => {
        const nextProjectId = card.getAttribute('data-open-project');
        if (String(nextProjectId) === String(project.projectId)) return;
        openProject(nextProjectId);
      });
    });
    if (fullChooserBtn) fullChooserBtn.addEventListener('click', () => renderChooser(PW.getCachedProjects()));
    if (hideBtn) hideBtn.addEventListener('click', () => {
      slot.innerHTML = `
        <section class="panel project-switcher-collapsed">
          <p><strong>Current project:</strong> ${escapeHtml(project.projectName || `Project ${project.projectId}`)}</p>
          <button id="showProjectSwitcherBtn" type="button">Choose/switch project</button>
        </section>
      `;
      const showBtn = document.getElementById('showProjectSwitcherBtn');
      if (showBtn) showBtn.addEventListener('click', () => {
        slot.innerHTML = renderProjectSwitcher(project);
        attachProjectSwitcher(project);
      });
    });
  }

  function renderWorkspace() {
    const project = PW.getProject(PW.getSelectedProjectId());
    if (!project) {
      if (PW.getSelectedProjectId()) PW.clearSelectedProject();
      renderChooser(PW.getCachedProjects());
      return;
    }
    Object.keys(mounted).forEach((key) => delete mounted[key]);
    const activeKey = currentStageKey();
    root.innerHTML = `
      ${renderProjectBar(project)}
      ${renderStageTabs(activeKey)}
      <div id="stagePanel"></div>
    `;
    attachProjectBarActions(project);
    root.querySelectorAll('[data-stage]').forEach((tab) => {
      tab.addEventListener('click', () => goToStage(tab.getAttribute('data-stage'), true));
    });
    showStage(project, activeKey);
  }

  window.addEventListener('popstate', () => {
    if (!PW.getProject(PW.getSelectedProjectId())) return;
    const project = PW.getProject(PW.getSelectedProjectId());
    if (root.querySelector('#stagePanel')) showStage(project, currentStageKey());
    else renderWorkspace();
  });

  async function init() {
    try {
      await PW.loadProjects();
    } catch (error) {
      root.innerHTML = `<section class="panel"><h1>Project workspace</h1><p class="status error">${escapeHtml(error.message || 'Could not load projects.')}</p></section>`;
      return;
    }
    const params = new URLSearchParams(location.search);
    if (params.get('choose') === 'project') {
      PW.clearSelectedProject();
      renderChooser(PW.getCachedProjects());
      return;
    }
    const namedProject = requestedProjectName();
    if (namedProject) {
      const match = PW.getCachedProjects().find((project) => String(project.projectName || '').trim().toLowerCase() === namedProject);
      if (match) PW.setSelectedProjectId(match.projectId);
    }
    const selected = PW.getProject(PW.getSelectedProjectId());
    if (selected) renderWorkspace();
    else renderChooser(PW.getCachedProjects());
  }

  init();
}());
