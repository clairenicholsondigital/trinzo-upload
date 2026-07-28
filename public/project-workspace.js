// Workspace controller: owns project selection + the Setup→Process→Reports→Insights
// stage flow. Renders a project chooser when nothing is selected, otherwise a
// persistent project bar + stage tabs, mounting one stage at a time.
(function () {
  const PW = window.ProjectWorkspace;
  const Stages = window.ProjectStages || {};
  const root = document.getElementById('workspaceRoot');
  const { escapeHtml } = PW;

  const STAGES = [
    { key: 'setup', no: 1, label: 'Setup', hint: 'Milestones & context' },
    { key: 'process', no: 2, label: 'Process', hint: 'Transcript → report' },
    { key: 'reports', no: 3, label: 'Reports', hint: 'Saved reports' },
    { key: 'insights', no: 4, label: 'Insights', hint: 'Analytics & memory' }
  ];
  const STAGE_KEYS = STAGES.map((stage) => stage.key);

  // process is mounted once and kept alive so in-progress transcript text is not
  // lost when switching tabs; data stages rebuild on each activation for freshness.
  const PERSISTENT_STAGES = new Set(['process']);
  const mounted = {};

  function currentStageKey() {
    const requested = new URLSearchParams(location.search).get('stage');
    return STAGE_KEYS.includes(requested) ? requested : 'setup';
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

  // ---- Project chooser -------------------------------------------------------

  function renderChooser(projects) {
    Object.keys(mounted).forEach((key) => delete mounted[key]);
    root.innerHTML = `
      <section class="panel">
        <h1>Project workspace</h1>
        <p class="intro">Pick a project to work on, then move through Setup → Process → Reports → Insights. Everything below stays scoped to the project you choose.</p>
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
      ? projects.map((project) => `
          <button type="button" class="project-card" data-open-project="${escapeHtml(project.projectId)}">
            <span class="pc-name">${escapeHtml(project.projectName || `Project ${project.projectId}`)}</span>
            <span class="muted">${escapeHtml(project.clientName || 'No client set')}</span>
            <span class="pc-meta">
              ${statusPill(project.status)}
              <span class="badge muted">${escapeHtml(project.reportCount || 0)} reports</span>
              <span class="badge muted">${escapeHtml(project.activeMilestoneCount || 0)} milestones</span>
            </span>
          </button>
        `).join('')
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
          <button id="editProjectBtn" type="button">Edit details</button>
          <button id="switchProjectBtn" type="button">Switch project</button>
        </div>
      </section>
      ${contextWarning}
      <div id="editProjectPanel"></div>
    `;
  }

  function renderStageTabs(activeKey) {
    return `
      <nav class="stage-tabs" aria-label="Workspace stages">
        ${STAGES.map((stage) => `
          <button type="button" class="stage-tab ${stage.key === activeKey ? 'active' : ''}" data-stage="${stage.key}" aria-current="${stage.key === activeKey ? 'page' : 'false'}">
            <span class="step-no">${stage.no}</span>
            <span><span class="step-label">${escapeHtml(stage.label)}</span> <span class="step-hint">${escapeHtml(stage.hint)}</span></span>
          </button>
        `).join('')}
      </nav>
    `;
  }

  function stageContext(project) {
    return {
      projectId: String(project.projectId),
      project,
      workspace: PW,
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
    if (!STAGE_KEYS.includes(stageKey)) stageKey = 'setup';
    setStageInUrl(stageKey, !push);
    const project = PW.getProject(PW.getSelectedProjectId());
    if (project) showStage(project, stageKey);
  }

  function attachEditPanel(project) {
    const editBtn = document.getElementById('editProjectBtn');
    const switchBtn = document.getElementById('switchProjectBtn');
    const editPanel = document.getElementById('editProjectPanel');

    switchBtn.addEventListener('click', () => {
      renderChooser(PW.getCachedProjects());
    });

    editBtn.addEventListener('click', () => {
      if (editPanel.dataset.open === 'true') {
        editPanel.dataset.open = 'false';
        editPanel.innerHTML = '';
        return;
      }
      editPanel.dataset.open = 'true';
      editPanel.innerHTML = `
        <section class="panel">
          <h2>Edit project details</h2>
          <div class="form-grid">
            <label class="wide">Project name <input id="editProjectName" type="text" value="${escapeHtml(project.projectName || '')}" /></label>
            <label>Client <input id="editProjectClient" type="text" value="${escapeHtml(project.clientName || '')}" /></label>
            <label>Status
              <select id="editProjectStatus">
                ${['active', 'paused', 'completed', 'archived'].map((option) => `<option value="${option}" ${option === (project.status || 'active') ? 'selected' : ''}>${option.charAt(0).toUpperCase() + option.slice(1)}</option>`).join('')}
              </select>
            </label>
            <label class="full">Description <textarea id="editProjectDescription">${escapeHtml(project.description || '')}</textarea></label>
          </div>
          <div class="actions" style="margin-top:.75rem">
            <button id="saveProjectDetailsBtn" class="primary" type="button">Save details</button>
            <button id="deleteProjectBtn" class="danger" type="button">Delete project</button>
          </div>
          <p id="editProjectStatusMsg" class="status"></p>
        </section>
      `;

      const saveBtn = document.getElementById('saveProjectDetailsBtn');
      const deleteBtn = document.getElementById('deleteProjectBtn');
      const statusMsg = document.getElementById('editProjectStatusMsg');

      saveBtn.addEventListener('click', async () => {
        const projectName = document.getElementById('editProjectName').value.trim();
        if (!projectName) {
          statusMsg.className = 'status error';
          statusMsg.textContent = 'Project name is required.';
          return;
        }
        saveBtn.disabled = true;
        statusMsg.className = 'status';
        statusMsg.textContent = 'Saving…';
        try {
          await PW.request(`projects/${encodeURIComponent(project.projectId)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              projectName,
              clientName: document.getElementById('editProjectClient').value.trim(),
              status: document.getElementById('editProjectStatus').value,
              description: document.getElementById('editProjectDescription').value.trim()
            })
          });
          await PW.loadProjects();
          const fresh = PW.getProject(project.projectId) || project;
          refreshProjectBar(fresh);
          Object.assign(project, fresh);
          statusMsg.className = 'status success';
          statusMsg.textContent = 'Project updated.';
        } catch (error) {
          statusMsg.className = 'status error';
          statusMsg.textContent = error.message || 'Could not save project.';
        } finally {
          saveBtn.disabled = false;
        }
      });

      deleteBtn.addEventListener('click', async () => {
        const summary = `${project.projectName} (${project.reportCount || 0} reports, ${project.activeMilestoneCount || 0} milestones)`;
        if (!window.confirm(`Delete ${summary}? This also deletes this project's saved reports, milestones, risks, context snapshots and knowledge items.`)) return;
        deleteBtn.disabled = true;
        try {
          await PW.request(`projects/${encodeURIComponent(project.projectId)}`, { method: 'DELETE' });
          PW.clearSelectedProject();
          await PW.loadProjects();
          renderChooser(PW.getCachedProjects());
        } catch (error) {
          statusMsg.className = 'status error';
          statusMsg.textContent = error.message || 'Could not delete project.';
          deleteBtn.disabled = false;
        }
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
    attachEditPanel(project);
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
    const selected = PW.getProject(PW.getSelectedProjectId());
    if (selected) renderWorkspace();
    else renderChooser(PW.getCachedProjects());
  }

  init();
}());
