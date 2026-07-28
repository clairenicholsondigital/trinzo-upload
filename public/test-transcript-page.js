function buildTranscriptTestPage(config) {
  const state = {
    result: null,
    loading: false,
    projectReport: null,
    autosaveTimer: null,
    projects: []
  };

  const root = document.getElementById('transcriptTestRoot');
  root.innerHTML = `
    <section class="panel">
      <h1>${config.title}</h1>
      <p class="intro">${config.intro}</p>
      ${config.projectReportUi && !config.fixedProjectId ? `
      <div class="field">
        <label for="projectPicker">Project context</label>
        <select id="projectPicker"><option value="">Loading projects…</option></select>
        <div class="project-picker-actions">
          <small>Choose an explicit project so stored context and report saves do not rely on name matching.</small>
          <button id="toggleProjectManagerBtn" class="secondary" type="button">Manage projects</button>
        </div>
        <div id="projectManager" class="project-manager hidden">
          <div class="project-manager-grid">
            <label>Project name <input id="projectNameInput" type="text" placeholder="Project name" /></label>
            <label>Client <input id="projectClientInput" type="text" placeholder="Optional client" /></label>
            <label>Status
              <select id="projectStatusInput">
                <option value="active">Active</option>
                <option value="paused">Paused</option>
                <option value="completed">Completed</option>
                <option value="archived">Archived</option>
              </select>
            </label>
            <label class="wide">Description <textarea id="projectDescriptionInput" placeholder="Optional project notes"></textarea></label>
          </div>
          <div class="actions">
            <button id="saveProjectBtn" type="button">Create project</button>
            <button id="newProjectBtn" class="secondary" type="button">New</button>
            <button id="deleteProjectBtn" class="secondary danger" type="button" disabled>Delete selected</button>
          </div>
          <small id="projectManagerStatus" class="autosave-status"></small>
        </div>
      </div>
      ` : ''}
      <div class="field">
        <label for="transcriptFile">Transcript file</label>
        <input id="transcriptFile" type="file" accept=".txt,.docx,.csv,text/plain,text/csv,application/vnd.openxmlformats-officedocument.wordprocessingml.document" />
        <small>Supports pasted text and .txt uploads. .docx and .csv are accepted when extraction is available.</small>
      </div>
      <div class="field">
        <label for="transcriptText">Paste transcript text</label>
        <textarea id="transcriptText" placeholder="Paste transcript here..."></textarea>
        <small>If both a file and pasted text are provided, pasted text takes priority.</small>
      </div>
      ${config.projectReportUi ? '<div class="safeguard-banner"><strong>Draft workspace:</strong> generated project updates are review drafts. Check the selected project context, evidence, risks, actions and dates before approving or sharing.</div><div class="safeguard-banner quiet"><strong>Data handling:</strong> pasted notes/transcripts are sent to the server to create the draft. Browser autosave stays on this device until you save. Saving a report stores the transcript, draft report and project context in this workspace so the report can be reviewed later.</div>' : ''}
      <div class="actions">
        <button id="goBtn" type="button">${config.buttonText}</button>
        <button id="clearBtn" class="secondary" type="button">${config.resetButtonText || 'Clear / reset'}</button>
      </div>
      <small id="autosaveStatus" class="autosave-status hidden"></small>
      <div id="message" class="message hidden"></div>
    </section>

    <section id="summaryPanel" class="panel hidden">
      <h2>Summary</h2>
      <div id="summaryGrid" class="summary-grid"></div>
    </section>

    <section id="projectReportPanel" class="panel hidden">
      <div class="json-heading">
        <div class="project-report-brand">
          <img class="project-report-logo print-only" src="/static/trinzo-logo.svg" alt="Trinzo logo" />
          <h2>Project report</h2>
        </div>
        <div class="actions">
          <button id="saveProjectReportDraftBtn" class="secondary" type="button">Save report</button>
          <button id="downloadProjectReportPdfBtn" class="secondary" type="button">Download PDF</button>
          <button id="openProjectReportFullScreenBtn" class="secondary" type="button">Open in full screen</button>
        </div>
      </div>
      <div id="projectReportOutput"></div>
      <div id="projectReportPrintOutput" aria-hidden="true"></div>
    </section>

    <section id="advancedDetailsPanel" class="panel hidden support-panel">
      <details class="support-details raw-json">
        <summary>Support / audit details</summary>
        <p class="muted">Kept out of the main workflow. Use only if you need to inspect support data, diagnostics, or the backend response.</p>
        <div id="debugPanel" class="hidden">
          <h3>Support diagnostics</h3>
          <div id="debugSummary" class="summary-grid"></div>
          <pre id="debugOutput"></pre>
        </div>
        <div id="jsonPanel" class="hidden">
          <div class="json-heading">
            <h3>Backend response</h3>
            <button id="copyBtn" class="secondary" type="button">Copy data</button>
          </div>
          <pre id="jsonOutput"></pre>
        </div>
      </details>
    </section>
  `;

  const fileInput = document.getElementById('transcriptFile');
  const textInput = document.getElementById('transcriptText');
  const projectPicker = document.getElementById('projectPicker');
  const toggleProjectManagerBtn = document.getElementById('toggleProjectManagerBtn');
  const projectManager = document.getElementById('projectManager');
  const projectNameInput = document.getElementById('projectNameInput');
  const projectClientInput = document.getElementById('projectClientInput');
  const projectStatusInput = document.getElementById('projectStatusInput');
  const projectDescriptionInput = document.getElementById('projectDescriptionInput');
  const saveProjectBtn = document.getElementById('saveProjectBtn');
  const newProjectBtn = document.getElementById('newProjectBtn');
  const deleteProjectBtn = document.getElementById('deleteProjectBtn');
  const projectManagerStatus = document.getElementById('projectManagerStatus');
  const goBtn = document.getElementById('goBtn');
  const clearBtn = document.getElementById('clearBtn');
  const copyBtn = document.getElementById('copyBtn');
  const message = document.getElementById('message');
  const autosaveStatus = document.getElementById('autosaveStatus');
  const summaryPanel = document.getElementById('summaryPanel');
  const summaryGrid = document.getElementById('summaryGrid');
  const projectReportPanel = document.getElementById('projectReportPanel');
  const projectReportOutput = document.getElementById('projectReportOutput');
  const projectReportPrintOutput = document.getElementById('projectReportPrintOutput');
  const downloadProjectReportPdfBtn = document.getElementById('downloadProjectReportPdfBtn');
  const saveProjectReportDraftBtn = document.getElementById('saveProjectReportDraftBtn');
  const openProjectReportFullScreenBtn = document.getElementById('openProjectReportFullScreenBtn');
  const advancedDetailsPanel = document.getElementById('advancedDetailsPanel');
  const jsonPanel = document.getElementById('jsonPanel');
  const jsonOutput = document.getElementById('jsonOutput');
  const debugPanel = document.getElementById('debugPanel');
  const debugSummary = document.getElementById('debugSummary');
  const debugOutput = document.getElementById('debugOutput');

  function setMessage(text, type) {
    message.textContent = text || '';
    message.className = text ? `message ${type || ''}` : 'message hidden';
  }

  function setLoading(isLoading) {
    state.loading = isLoading;
    goBtn.disabled = isLoading;
    clearBtn.disabled = isLoading;
    fileInput.disabled = isLoading;
    textInput.disabled = isLoading;
    goBtn.textContent = isLoading ? 'Working...' : config.buttonText;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  const PROJECT_SELECTION_KEY = 'trinzoProjectUpdateSelectedProjectId';

  function setProjectManagerStatus(text, type) {
    if (!projectManagerStatus) return;
    projectManagerStatus.textContent = text || '';
    projectManagerStatus.className = `autosave-status${type ? ` ${type}` : ''}`;
  }

  function projectById(projectId) {
    return state.projects.find((project) => String(project.projectId) === String(projectId)) || null;
  }

  function projectFormPayload() {
    return {
      projectName: projectNameInput ? projectNameInput.value.trim() : '',
      clientName: projectClientInput ? projectClientInput.value.trim() : '',
      status: projectStatusInput ? projectStatusInput.value : 'active',
      description: projectDescriptionInput ? projectDescriptionInput.value.trim() : ''
    };
  }

  function populateProjectForm(project) {
    if (!projectNameInput) return;
    const item = project || {};
    projectNameInput.value = item.projectName || '';
    projectClientInput.value = item.clientName || '';
    projectStatusInput.value = item.status || 'active';
    projectDescriptionInput.value = item.description || '';
    saveProjectBtn.textContent = item.projectId ? 'Save project' : 'Create project';
    deleteProjectBtn.disabled = !item.projectId;
    setProjectManagerStatus(item.projectId
      ? `${item.reportCount || 0} reports, ${item.activeMilestoneCount || 0} active milestones, ${item.activeRiskCount || 0} active risks.`
      : ''
    );
  }

  async function loadProjectPicker() {
    if (!projectPicker) return;
    try {
      const response = await fetch('/api/project-update-test/projects', { credentials: 'same-origin' });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload || payload.ok === false) throw new Error(payload?.error || 'Could not load projects.');
      const selected = localStorage.getItem(PROJECT_SELECTION_KEY) || '';
      const projects = Array.isArray(payload.projects) ? payload.projects : [];
      state.projects = projects;
      projectPicker.innerHTML = [
        '<option value="">Default project</option>',
        ...projects.map((project) => `<option value="${escapeHtml(project.projectId)}">${escapeHtml(project.projectName || `Project ${project.projectId}`)} (${project.reportCount || 0} reports, ${project.activeMilestoneCount || 0} milestones)</option>`)
      ].join('');
      if (selected && projects.some((project) => String(project.projectId) === selected)) projectPicker.value = selected;
      populateProjectForm(projectById(projectPicker.value));
    } catch (error) {
      projectPicker.innerHTML = '<option value="">Default project</option>';
      setMessage(`Project list unavailable; uploads will use the default project name. ${error.message || ''}`.trim(), 'error');
    }
  }

  function selectedProjectPayload() {
    // When embedded in the workspace, the selected project is owned by the
    // workspace bar rather than an internal picker.
    if (config.fixedProjectId) return { projectId: Number(config.fixedProjectId) };
    if (!projectPicker || !projectPicker.value) return {};
    localStorage.setItem(PROJECT_SELECTION_KEY, projectPicker.value);
    return { projectId: Number(projectPicker.value) };
  }

  async function saveProject() {
    if (!projectPicker) return;
    const payload = projectFormPayload();
    if (!payload.projectName) {
      setProjectManagerStatus('Project name is required.', 'error');
      return;
    }
    const selectedProjectId = projectPicker.value;
    const url = selectedProjectId
      ? `/api/project-update-test/projects/${encodeURIComponent(selectedProjectId)}`
      : '/api/project-update-test/projects';
    const method = selectedProjectId ? 'PATCH' : 'POST';
    try {
      saveProjectBtn.disabled = true;
      const response = await fetch(url, {
        method,
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result || result.ok === false) throw new Error(result?.error || 'Could not save project.');
      const project = result.project || {};
      localStorage.setItem(PROJECT_SELECTION_KEY, String(project.projectId || ''));
      await loadProjectPicker();
      if (project.projectId) projectPicker.value = String(project.projectId);
      populateProjectForm(projectById(project.projectId) || project);
      setProjectManagerStatus(selectedProjectId ? 'Project updated.' : 'Project created.', 'success');
    } catch (error) {
      setProjectManagerStatus(error.message || 'Could not save project.', 'error');
    } finally {
      saveProjectBtn.disabled = false;
    }
  }

  async function deleteSelectedProject() {
    const project = projectById(projectPicker && projectPicker.value);
    if (!project) return;
    const summary = `${project.projectName} (${project.reportCount || 0} reports, ${project.activeMilestoneCount || 0} milestones)`;
    if (!window.confirm(`Delete ${summary}? This also deletes this project's saved reports, milestones, risks, context snapshots and knowledge items.`)) return;
    try {
      deleteProjectBtn.disabled = true;
      const response = await fetch(`/api/project-update-test/projects/${encodeURIComponent(project.projectId)}`, {
        method: 'DELETE',
        credentials: 'same-origin'
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result || result.ok === false) throw new Error(result?.error || 'Could not delete project.');
      localStorage.removeItem(PROJECT_SELECTION_KEY);
      await loadProjectPicker();
      projectPicker.value = '';
      populateProjectForm(null);
      setProjectManagerStatus('Project deleted.', 'success');
    } catch (error) {
      setProjectManagerStatus(error.message || 'Could not delete project.', 'error');
      deleteProjectBtn.disabled = false;
    }
  }

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value || {}));
  }

  function titleize(value) {
    return String(value || '')
      .replace(/[_-]+/g, ' ')
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function sentenceLabel(value) {
    const label = titleize(value).trim();
    return label ? label.charAt(0).toUpperCase() + label.slice(1).toLowerCase() : '';
  }

  function friendlyMilestoneLabel(value) {
    return titleize(value).trim() || String(value || '').trim();
  }

  function isColourPath(path) {
    return /(^|\.)overallHealthRag$|(^|\.)agreed_rag_status$|(^|\.)rag_status$/i.test(String(path || ''));
  }

  function colourValue(value) {
    const key = String(value || '').trim().toLowerCase().replace(/[^a-z]+/g, '_');
    const colours = {
      blue: '#2563eb',
      green: '#16a34a',
      amber: '#f59e0b',
      yellow: '#facc15',
      red: '#dc2626',
      blocked: '#7f1d1d',
      off_track: '#dc2626',
      at_risk: '#f59e0b',
      on_track: '#16a34a',
      completed: '#2563eb'
    };
    return colours[key] || '';
  }

  function renderColourField(value, path) {
    const escapedPath = escapeHtml(path);
    const rawValue = String(value ?? '').trim();
    const colour = colourValue(rawValue);
    const title = rawValue ? sentenceLabel(rawValue) : 'No colour set';
    return `
      <span class="project-colour-field" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">
        <input class="project-hidden-field" type="hidden" data-project-path="${escapedPath}" value="${escapeHtml(rawValue)}" />
        <span class="project-colour-swatch ${colour ? '' : 'unknown'}" style="${colour ? `background:${escapeHtml(colour)}` : ''}"></span>
      </span>
    `;
  }

  function renderDisplayField(value, path) {
    const statusPath = /(^|\.)(status|delivery_status|health_assessment|trend)$/i.test(String(path || ''));
    const displayValue = statusPath && String(value || '').trim().toLowerCase() === 'unknown' ? '' : value;
    return `
      <span class="project-display-value">${escapeHtml(sentenceLabel(displayValue) || '—')}</span>
      <input class="project-hidden-field" type="hidden" data-project-path="${escapeHtml(path)}" value="${escapeHtml(value ?? '')}" />
    `;
  }

  function renderSelectField(value, path, options) {
    const current = String(value ?? '');
    const optionValues = options.includes(current) ? options : [current, ...options].filter(Boolean);
    return `
      <select data-project-path="${escapeHtml(path)}">
        ${optionValues.map((option) => `<option value="${escapeHtml(option)}"${option === current ? ' selected' : ''}>${escapeHtml(sentenceLabel(option) || option)}</option>`).join('')}
      </select>
    `;
  }

  function statusOptionsForPath(path) {
    const key = String(path || '');
    if (/(^|\.)reportStatus$/i.test(key)) return ['draft', 'in_review', 'approved', 'archived'];
    if (/(^|\.)trend$/i.test(key)) return ['improving', 'stable', 'deteriorating', 'replanned', 'new_update', 'new_risk', 'resolved', 'unknown'];
    if (/(^|\.)health_assessment$|(^|\.)overallHealth$/i.test(key)) return ['on_track', 'at_risk', 'off_track', 'completed', 'unknown'];
    if (/(^|\.)delivery_status$|(^|\.)status$/i.test(key)) return ['completed', 'on_track', 'at_risk', 'delayed', 'blocked', 'not_started', 'unknown'];
    return null;
  }

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function asLines(value) {
    return asArray(value).map((item) => String(item || '').trim()).filter(Boolean);
  }

  function parseLines(value) {
    return String(value || '').split('\n').map((item) => item.trim()).filter(Boolean);
  }

  function renderProjectCell(value, path, multiline = false, placeholder = '', type = 'text') {
    if (isColourPath(path)) {
      return renderColourField(value, path);
    }
    const statusOptions = statusOptionsForPath(path);
    if (statusOptions) {
      return renderSelectField(value, path, statusOptions);
    }
    if (/(^|\.)related_milestone$|(^|\.)relatedMilestone$/i.test(String(path || ''))) {
      return renderDisplayField(value, path);
    }
    const escapedPath = escapeHtml(path);
    const escapedValue = escapeHtml(value ?? '');
    if (multiline) {
      return `<textarea data-project-path="${escapedPath}" placeholder="${escapeHtml(placeholder)}">${escapedValue}</textarea>`;
    }
    const milestoneMarker = /\.milestone$/i.test(String(path || '')) ? ' data-project-milestone-name="true" list="projectMilestoneOptions"' : '';
    const deadlineMarker = /\.baseline_finish_date$/i.test(String(path || ''))
      ? ' data-project-baseline-deadline="true"'
      : /\.forecast_finish_date$/i.test(String(path || ''))
        ? ' data-project-forecast-deadline="true"'
        : '';
    return `<input type="${escapeHtml(type)}" data-project-path="${escapedPath}" value="${escapedValue}" placeholder="${escapeHtml(placeholder)}"${milestoneMarker}${deadlineMarker} />`;
  }

  function projectAutosaveKey() {
    const endpoint = String(config.endpoint || 'default').replace(/[^a-z0-9_-]+/gi, '_');
    // Scope the local draft per project so switching projects in the workspace
    // does not restore another project's in-progress transcript.
    const scope = config.fixedProjectId ? String(config.fixedProjectId) : 'all';
    return `transcriptTest:${endpoint}:${scope}:autosave`;
  }

  function setAutosaveStatus(text) {
    if (!config.projectReportUi) return;
    autosaveStatus.textContent = text || '';
    autosaveStatus.className = text ? 'autosave-status' : 'autosave-status hidden';
  }

  function readProjectAutosave() {
    if (!config.projectReportUi) return null;
    try {
      return JSON.parse(localStorage.getItem(projectAutosaveKey()) || 'null');
    } catch {
      return null;
    }
  }

  function writeProjectAutosave() {
    if (!config.projectReportUi) return;
    const payload = {
      transcriptText: textInput.value,
      result: state.result,
      projectReport: state.projectReport,
      projectId: config.fixedProjectId || '',
      projectName: selectedProjectPayload().projectName || '',
      savedAt: new Date().toISOString()
    };
    localStorage.setItem(projectAutosaveKey(), JSON.stringify(payload));
    setAutosaveStatus(`Browser draft only — not saved to server until you press Save report. Last local autosave ${new Date(payload.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`);
  }

  function queueProjectAutosave() {
    if (!config.projectReportUi) return;
    clearTimeout(state.autosaveTimer);
    state.autosaveTimer = setTimeout(writeProjectAutosave, 500);
  }

  function restoreProjectAutosave() {
    const saved = readProjectAutosave();
    if (!saved) return;
    if (saved.transcriptText && !textInput.value) {
      textInput.value = saved.transcriptText;
    }
    if (saved.result && saved.projectReport) {
      state.result = saved.result;
      state.projectReport = saved.projectReport;
      state.result.projectReport = saved.projectReport;
      displaySummary(state.result);
      renderProjectReport(state.projectReport, state.result);
      displayJson(state.result);
    }
    if (saved.savedAt) {
      const projectLabel = saved.projectName || saved.projectId ? ` for ${saved.projectName || `project ${saved.projectId}`}` : '';
      setAutosaveStatus(`Restored browser-only draft${projectLabel} from ${new Date(saved.savedAt).toLocaleString()}. Press Save report to save it to the server.`);
    }
  }

  function setByPath(target, path, value) {
    const parts = String(path || '').split('.');
    let node = target;
    parts.slice(0, -1).forEach((part) => {
      const key = /^\d+$/.test(part) ? Number(part) : part;
      if (node[key] == null) node[key] = {};
      node = node[key];
    });
    const last = parts[parts.length - 1];
    node[/^\d+$/.test(last) ? Number(last) : last] = value;
  }

  function collectEditedProjectReport() {
    if (!state.projectReport) return null;
    const report = cloneJson(state.projectReport);
    projectReportOutput.querySelectorAll('[data-project-path]').forEach((field) => {
      if (field.hasAttribute('readonly')) return;
      const path = field.getAttribute('data-project-path');
      const mode = field.getAttribute('data-project-mode');
      const value = mode === 'lines' ? parseLines(field.value) : field.value.trim();
      setByPath(report, path, value);
    });
    return report;
  }

  function refreshProjectReportState() {
    const report = collectEditedProjectReport();
    if (!report) return;
    state.projectReport = report;
    if (state.result && state.result.projectReport) {
      state.result.projectReport = report;
      jsonOutput.textContent = JSON.stringify(state.result, null, 2);
    }
    queueProjectAutosave();
  }

  function withEditedProjectReport(callback) {
    const report = collectEditedProjectReport() || cloneJson(state.projectReport);
    if (!report) return;
    callback(report);
    state.projectReport = report;
    if (state.result) {
      state.result.projectReport = report;
    }
    renderProjectReport(report, state.result || {});
    displayJson(state.result || { projectReport: report });
    queueProjectAutosave();
  }

  function renderReportSummaryTab(report) {
    return `
      <div class="project-form-grid">
        <label>Report status ${renderProjectCell(report.reportStatus, 'reportStatus', false, 'draft')}</label>
        <label>Overall health assessment ${renderProjectCell(report.overallHealth, 'overallHealth', false, 'on_track')}</label>
        <label>Overall status ${renderProjectCell(report.overallHealthRag, 'overallHealthRag', false, 'amber')}</label>
        <label class="wide">Executive summary
          <span class="project-hint">Use this field for the executive summary and key updates.</span>
          ${renderProjectCell(report.summary, 'summary', true, 'Project summary and key updates')}
        </label>
      </div>
    `;
  }

  function renderHealthTab(report) {
    const areas = report.healthAreas && typeof report.healthAreas === 'object' ? report.healthAreas : {};
    const keys = Object.keys(areas);
    if (!keys.length) return '<p class="intro">No health areas were returned.</p>';
    return `
      <div class="table-scroll">
        <table class="project-table">
          <thead><tr><th>Area</th><th>Status</th><th>Trend</th><th>Evidence</th></tr></thead>
          <tbody>
            ${keys.map((key) => {
              const area = areas[key] || {};
              const evidence = asArray(area.evidence).map((item) => item.text || item.source || '').filter(Boolean).join('\n');
              return `
                <tr>
                  <th>${escapeHtml(titleize(key))}</th>
                  <td>${renderProjectCell(area.status, `healthAreas.${key}.status`)}</td>
                  <td>${renderProjectCell(area.trend, `healthAreas.${key}.trend`)}</td>
                  <td>${renderProjectCell(evidence, `healthAreas.${key}.evidenceNotes`, true, 'Evidence notes')}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderMilestonesTab(report) {
    const milestones = asArray(report.milestones);
    const milestoneOptions = milestones
      .map((item) => item && item.milestone)
      .filter(Boolean)
      .map((milestone) => `<option value="${escapeHtml(milestone)}"></option>`)
      .join('');
    return `
      <datalist id="projectMilestoneOptions">${milestoneOptions}</datalist>
      <div class="project-table-actions">
        <button class="secondary" type="button" data-project-add="milestones">Add milestone</button>
      </div>
      <div class="table-scroll">
        <table class="project-table dense">
          <thead>
            <tr><th>Milestone</th><th>Baseline deadline</th><th>Forecast deadline</th><th>Delivery status</th><th>Status</th><th>AI health assessment</th><th>Summary</th><th>Next steps</th><th></th></tr>
          </thead>
          <tbody>
            ${(milestones.length ? milestones : [{}]).map((item, index) => `
              <tr>
                <td>${renderProjectCell(friendlyMilestoneLabel(item.milestone), `milestones.${index}.milestone`)}</td>
                <td>${renderProjectCell(item.baseline_finish_date || item.baselineDeadline || item.deadline, `milestones.${index}.baseline_finish_date`, false, 'Baseline', 'date')}</td>
                <td>${renderProjectCell(item.forecast_finish_date || item.forecastDeadline || item.deadline, `milestones.${index}.forecast_finish_date`, false, 'Forecast', 'date')}</td>
                <td>${renderProjectCell(item.delivery_status || item.status, `milestones.${index}.delivery_status`)}</td>
                <td>${renderProjectCell(item.agreed_rag_status || item.rag_status, `milestones.${index}.agreed_rag_status`)}</td>
                <td>${renderProjectCell(item.health_assessment, `milestones.${index}.health_assessment`)}</td>
                <td>${renderProjectCell(item.normalised_evidence_summary || item.excerpt, `milestones.${index}.normalised_evidence_summary`, true)}</td>
                <td><textarea data-project-path="milestones.${index}.next_steps" data-project-mode="lines">${escapeHtml(combinedNextSteps(item).join('\n'))}</textarea></td>
                <td><button class="secondary project-row-action" type="button" data-project-remove="milestones" data-project-index="${index}">Remove</button></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderRisksTab(report) {
    const risks = asArray(report.risks);
    return `
      <div class="table-scroll">
        <table class="project-table">
          <thead><tr><th>Risk</th><th>Description</th><th>Mitigation</th><th>Milestone</th></tr></thead>
          <tbody>
            ${(risks.length ? risks : [{}]).map((risk, index) => `
              <tr>
                <td>${renderProjectCell(risk.riskTitle, `risks.${index}.riskTitle`, true, 'Risk title')}</td>
                <td>${renderProjectCell(risk.description, `risks.${index}.description`, true, 'Description')}</td>
                <td>${renderProjectCell(risk.suggestedMitigation, `risks.${index}.suggestedMitigation`, true, 'Mitigation')}</td>
                <td>${renderProjectCell(risk.relatedMilestone, `risks.${index}.relatedMilestone`)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderActionsTab(report) {
    const actions = asArray(report.actions);
    return `
      <div class="table-scroll">
        <table class="project-table">
          <thead><tr><th>Action</th><th>Owner</th><th>Deadline</th><th>Related milestone</th></tr></thead>
          <tbody>
            ${(actions.length ? actions : [{}]).map((action, index) => `
              <tr>
                <td>${renderProjectCell(action.action || action.meetingActionPoint, `actions.${index}.action`, true, 'Action')}</td>
                <td>${renderProjectCell(action.meetingActionPointOwner || action.owner, `actions.${index}.meetingActionPointOwner`, false, 'Owner')}</td>
                <td>${renderProjectCell(action.deadline || action.meetingActionPointDeadline, `actions.${index}.deadline`, false, 'Deadline')}</td>
                <td>${renderProjectCell(action.related_milestone || action.relatedMilestone, `actions.${index}.related_milestone`)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function staticText(value) {
    if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean).join('\n') || '—';
    return sentenceLabel(value) || String(value || '').trim() || '—';
  }

  function renderStaticColour(value) {
    const rawValue = String(value ?? '').trim();
    const colour = colourValue(rawValue);
    const title = sentenceLabel(rawValue) || 'No status set';
    return `
      <span class="project-print-colour" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">
        <span class="project-colour-swatch ${colour ? '' : 'unknown'}" style="${colour ? `background:${escapeHtml(colour)}` : ''}"></span>
      </span>
    `;
  }

  function combinedNextSteps(item) {
    const seen = new Set();
    return ['blocking_factors', 'next_steps'].flatMap((field) => asLines(item && item[field]))
      .filter((value) => {
        const key = value.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  function renderStaticProjectReport(report) {
    const areas = report.healthAreas && typeof report.healthAreas === 'object' ? report.healthAreas : {};
    const milestones = asArray(report.milestones);
    const risks = asArray(report.risks);
    const actions = asArray(report.actions);

    return `
      <div class="project-print-report">
        <div class="project-print-footer">Exported ${escapeHtml(new Date().toLocaleString())}</div>
        <section>
          <h3>Summary</h3>
          <div class="project-print-summary">
            <div><strong>Report status</strong><span>${escapeHtml(staticText(report.reportStatus))}</span></div>
            <div><strong>Overall health</strong><span>${escapeHtml(staticText(report.overallHealth))}</span></div>
            <div><strong>Overall status</strong><span>${renderStaticColour(report.overallHealthRag)}</span></div>
          </div>
          <h4>Executive summary</h4>
          <p>${escapeHtml(report.summary || '')}</p>
        </section>

        <section>
          <h3>Overall summary</h3>
          <table class="project-print-table">
            <thead><tr><th>Area</th><th>Status</th><th>Trend</th><th>Evidence</th></tr></thead>
            <tbody>
              ${Object.keys(areas).map((key) => {
                const area = areas[key] || {};
                const evidence = asArray(area.evidence).map((item) => item.text || item.source || '').filter(Boolean).join('\n');
                return `<tr><th>${escapeHtml(titleize(key))}</th><td>${escapeHtml(staticText(area.status))}</td><td>${escapeHtml(staticText(area.trend))}</td><td>${escapeHtml(evidence || area.evidenceNotes || '—')}</td></tr>`;
              }).join('') || '<tr><td colspan="4">—</td></tr>'}
            </tbody>
          </table>
        </section>

        <section>
          <h3>Milestones</h3>
          <table class="project-print-table project-print-milestones">
            <thead><tr><th>Milestone</th><th>Baseline</th><th>Forecast</th><th>Status</th><th>Overall status</th><th>Health</th><th>Summary</th><th>Next steps</th></tr></thead>
            <tbody>
              ${milestones.map((item) => `
                <tr>
                  <td>${escapeHtml(friendlyMilestoneLabel(item.milestone) || '—')}</td>
                  <td>${escapeHtml(staticText(item.baseline_finish_date || item.baselineDeadline || item.deadline))}</td>
                  <td>${escapeHtml(staticText(item.forecast_finish_date || item.forecastDeadline || item.deadline))}</td>
                  <td>${escapeHtml(staticText(item.delivery_status || item.status))}</td>
                  <td>${renderStaticColour(item.agreed_rag_status || item.rag_status)}</td>
                  <td>${escapeHtml(staticText(item.health_assessment))}</td>
                  <td>${escapeHtml(staticText(item.normalised_evidence_summary || item.excerpt))}</td>
                  <td>${escapeHtml(staticText(combinedNextSteps(item)))}</td>
                </tr>
              `).join('') || '<tr><td colspan="8">—</td></tr>'}
            </tbody>
          </table>
        </section>

        <section>
          <h3>Risks</h3>
          <table class="project-print-table">
            <thead><tr><th>Risk</th><th>Description</th><th>Mitigation</th><th>Milestone</th></tr></thead>
            <tbody>
              ${risks.map((risk) => `<tr><td>${escapeHtml(staticText(risk.riskTitle))}</td><td>${escapeHtml(staticText(risk.description))}</td><td>${escapeHtml(staticText(risk.suggestedMitigation))}</td><td>${escapeHtml(staticText(risk.relatedMilestone))}</td></tr>`).join('') || '<tr><td colspan="4">—</td></tr>'}
            </tbody>
          </table>
        </section>

        <section>
          <h3>Actions</h3>
          <table class="project-print-table">
            <thead><tr><th>Action</th><th>Owner</th><th>Deadline</th><th>Milestone</th></tr></thead>
            <tbody>
              ${actions.map((action) => `<tr><td>${escapeHtml(staticText(action.action || action.meetingActionPoint))}</td><td>${escapeHtml(staticText(action.meetingActionPointOwner || action.owner))}</td><td>${escapeHtml(staticText(action.deadline || action.meetingActionPointDeadline))}</td><td>${escapeHtml(staticText(action.related_milestone || action.relatedMilestone))}</td></tr>`).join('') || '<tr><td colspan="4">—</td></tr>'}
            </tbody>
          </table>
        </section>
      </div>
    `;
  }

  function renderSnapshotTab(report, result) {
    const snapshot = report.comparisonSnapshot || {};
    const persistence = result.projectReportPersistence || {};
    const backendPayload = result || {};
    const statusDiagnostics = report.statusClassifierDiagnostics || result.statusClassifierDiagnostics || {};
    const transcript = textInput.value || '';
    const diagnosticsSummary = statusDiagnostics && Object.keys(statusDiagnostics).length
      ? `<div class="empty-state" style="margin-bottom:.75rem">
          <strong>Status cross-check</strong><br />
          ${statusDiagnostics.decisionUse === 'diagnostics_only'
            ? 'This classifier is a review aid only. It does not change the report status.'
            : 'This classifier output should be reviewed before it affects the report status.'}
          ${statusDiagnostics.itemCount || statusDiagnostics.items?.length ? `<br />${escapeHtml(statusDiagnostics.itemCount || statusDiagnostics.items.length)} transcript-backed signal${Number(statusDiagnostics.itemCount || statusDiagnostics.items.length) === 1 ? '' : 's'} found.` : ''}
        </div>`
      : '';
    return `
      ${diagnosticsSummary}
      <div class="project-meta-grid">
        <div class="summary-item"><div class="summary-label">Saved</div><div class="summary-value">${escapeHtml(persistence.saved === true ? 'yes' : 'no')}</div></div>
        <div class="summary-item"><div class="summary-label">Report ID</div><div class="summary-value">${escapeHtml(persistence.reportId || '—')}</div></div>
      </div>
      <details class="support-details raw-json" style="margin-top:.75rem">
        <summary>Support / audit details</summary>
        <p class="muted">Kept out of the main report flow. Use only if you need to inspect the source transcript, comparison snapshot, save details, status cross-check, or backend response.</p>
        <div class="actions" style="justify-content:flex-start;margin:.75rem 0">
          <button id="copyProjectReportBtn" class="secondary" type="button">Copy report data</button>
        </div>
        <details style="margin-top:.75rem">
          <summary>Comparison snapshot</summary>
          <textarea data-project-path="comparisonSnapshotJson" data-project-mode="json" readonly>${escapeHtml(JSON.stringify(snapshot, null, 2))}</textarea>
        </details>
        <details style="margin-top:.75rem">
          <summary>Transcript used for report</summary>
          <textarea readonly>${escapeHtml(transcript || 'Transcript text is not available in this browser session.')}</textarea>
        </details>
        <details style="margin-top:.75rem">
          <summary>Run and save details</summary>
          <div class="project-form-grid">
            <label class="wide">Save details
              <textarea readonly>${escapeHtml(JSON.stringify(persistence, null, 2))}</textarea>
            </label>
            <label class="wide">Status cross-check details
              <textarea readonly>${escapeHtml(JSON.stringify(statusDiagnostics, null, 2))}</textarea>
            </label>
            <label class="wide">Run details
              <textarea readonly>${escapeHtml(JSON.stringify({ mode: result.mode || 'unknown', runtimeMs: result.modelDiagnostics && result.modelDiagnostics.totalRuntimeMs || null }, null, 2))}</textarea>
            </label>
          </div>
        </details>
        <details style="margin-top:.75rem">
          <summary>Backend response</summary>
          <textarea readonly>${escapeHtml(JSON.stringify(backendPayload, null, 2))}</textarea>
        </details>
      </details>
    `;
  }

  function renderProjectReport(report, result) {
    const reportStatus = String(report.reportStatus || result?.projectReport?.reportStatus || 'draft').toLowerCase();
    const reviewBanner = reportStatus === 'approved'
      ? '<div class="safeguard-banner success"><strong>Approved report:</strong> this has been marked approved. Re-check any edits before sharing a new PDF or saving changes.</div>'
      : `<div class="safeguard-banner warning"><strong>Draft / review required:</strong> this report is ${escapeHtml(reportStatus.replace(/[_-]+/g, ' '))}. Treat every AI-generated claim as provisional until the evidence, dates, risks and actions have been checked.</div>`;
    const tabs = [
      ['summary', 'Summary', renderReportSummaryTab(report)],
      ['health', 'Overall summary', renderHealthTab(report)],
      ['milestones', 'Milestones', renderMilestonesTab(report)],
      ['risks', 'Risks', renderRisksTab(report)],
      ['actions', 'Actions', renderActionsTab(report)],
      ['snapshot', 'Review details', renderSnapshotTab(report, result)]
    ];
    projectReportOutput.innerHTML = `
      ${reviewBanner}
      <div class="project-tabs" role="tablist">
        ${tabs.map(([key, label], index) => `<button class="project-tab ${index === 0 ? 'active' : ''}" type="button" role="tab" aria-selected="${index === 0 ? 'true' : 'false'}" data-project-tab="${key}">${escapeHtml(label)}</button>`).join('')}
      </div>
      ${tabs.map(([key, , content], index) => `<div class="project-tab-panel ${index === 0 ? '' : 'hidden'}" data-project-panel="${key}">${content}</div>`).join('')}
    `;
    projectReportPrintOutput.innerHTML = renderStaticProjectReport(report);
    projectReportOutput.querySelectorAll('[data-project-tab]').forEach((tab) => {
      tab.addEventListener('click', () => {
        const key = tab.getAttribute('data-project-tab');
        projectReportOutput.querySelectorAll('[data-project-tab]').forEach((node) => {
          const active = node === tab;
          node.classList.toggle('active', active);
          node.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        projectReportOutput.querySelectorAll('[data-project-panel]').forEach((panel) => {
          panel.classList.toggle('hidden', panel.getAttribute('data-project-panel') !== key);
        });
      });
    });
    projectReportOutput.querySelectorAll('[data-project-path]').forEach((field) => {
      if (field.hasAttribute('readonly')) return;
      field.addEventListener('input', refreshProjectReportState);
      field.addEventListener('change', refreshProjectReportState);
    });
    projectReportOutput.querySelectorAll('[data-project-milestone-name]').forEach((field) => {
      field.addEventListener('change', () => {
        const row = field.closest('tr');
        if (!row) return;
        const selected = asArray(state.projectReport && state.projectReport.milestones)
          .find((item) => String(item.milestone || '').trim().toLowerCase() === field.value.trim().toLowerCase());
        if (!selected) return;
        const baselineField = row.querySelector('[data-project-baseline-deadline]');
        const forecastField = row.querySelector('[data-project-forecast-deadline]');
        if (baselineField) baselineField.value = selected.baseline_finish_date || selected.baselineDeadline || selected.deadline || '';
        if (forecastField) forecastField.value = selected.forecast_finish_date || selected.forecastDeadline || selected.deadline || '';
        refreshProjectReportState();
      });
    });
    projectReportOutput.querySelectorAll('[data-project-add="milestones"]').forEach((button) => {
      button.addEventListener('click', () => {
        withEditedProjectReport((draft) => {
          draft.milestones = asArray(draft.milestones);
          draft.milestones.push({
            milestone: '',
            baseline_finish_date: '',
            forecast_finish_date: '',
            delivery_status: 'unknown',
            agreed_rag_status: 'unknown',
            health_assessment: 'unknown',
            normalised_evidence_summary: '',
            blocking_factors: [],
            next_steps: []
          });
        });
      });
    });
    projectReportOutput.querySelectorAll('[data-project-remove="milestones"]').forEach((button) => {
      button.addEventListener('click', () => {
        const index = Number(button.getAttribute('data-project-index'));
        withEditedProjectReport((draft) => {
          draft.milestones = asArray(draft.milestones).filter((_, itemIndex) => itemIndex !== index);
        });
      });
    });
    const copyProjectReportBtn = document.getElementById('copyProjectReportBtn');
    if (copyProjectReportBtn) {
      copyProjectReportBtn.addEventListener('click', async () => {
        refreshProjectReportState();
        if (!state.projectReport) return;
        await navigator.clipboard.writeText(JSON.stringify(state.projectReport, null, 2));
        setMessage('Project report data copied to clipboard.', 'success');
      });
    }
    projectReportPanel.classList.remove('hidden');
  }

  function displayProjectReport(result) {
    if (!config.projectReportUi) return;
    const report = result && result.projectReport ? cloneJson(result.projectReport) : null;
    if (!report) {
      projectReportPanel.classList.add('hidden');
      projectReportOutput.innerHTML = '';
      projectReportPrintOutput.innerHTML = '';
      return;
    }
    state.projectReport = report;
    renderProjectReport(report, result || {});
  }

  function displaySummary(result) {
    const items = config.summary(result || {});
    summaryGrid.innerHTML = items.map((item) => `
      <div class="summary-item">
        <div class="summary-label">${escapeHtml(item.label)}</div>
        <div class="summary-value">${escapeHtml(item.value)}</div>
      </div>
    `).join('');
    summaryPanel.classList.remove('hidden');
  }

  function displayJson(payload) {
    state.result = payload;
    jsonOutput.textContent = JSON.stringify(payload, null, 2);
    if (config.projectReportUi) return;
    advancedDetailsPanel.classList.remove('hidden');
    jsonPanel.classList.remove('hidden');
  }

  function displayDebugPanel(result, responsePayload) {
    if (!config.debugPanel) return;

    const debug = result && result.numberExperimentDebug ? result.numberExperimentDebug : {};
    const details = {
      transcriptMetadata: responsePayload.transcriptMetadata || null,
      discussionPointDetails: result && Array.isArray(result.discussionPointDetails) ? result.discussionPointDetails : [],
      decisionDetails: result && Array.isArray(result.decisionDetails) ? result.decisionDetails : [],
      statusReviewPoints: debug.statusReviewPoints || [],
      statusReviewWorkstreams: debug.statusReviewWorkstreams || [],
      finalDiscussionPoints: debug.finalDiscussionPoints || [],
      topicClusters: debug.topicClusters || []
    };

    const digest = responsePayload.transcriptMetadata && responsePayload.transcriptMetadata.transcriptSha256
      ? responsePayload.transcriptMetadata.transcriptSha256
      : 'not requested';
    const detailCounts = [
      { label: 'Input digest', value: digest },
      { label: 'Characters', value: String((responsePayload.transcriptMetadata && responsePayload.transcriptMetadata.transcriptLength) || responsePayload.transcriptLength || 0) },
      { label: 'Discussion details', value: String(details.discussionPointDetails.length) },
      { label: 'Decision details', value: String(details.decisionDetails.length) },
      { label: 'Status points', value: String(details.statusReviewPoints.length) }
    ];

    debugSummary.innerHTML = detailCounts.map((item) => `
      <div class="summary-item">
        <div class="summary-label">${item.label}</div>
        <div class="summary-value">${item.value}</div>
      </div>
    `).join('');
    debugOutput.textContent = JSON.stringify(details, null, 2);
    advancedDetailsPanel.classList.remove('hidden');
    debugPanel.classList.remove('hidden');
  }

  async function submitTranscript() {
    const pastedText = textInput.value.trim();
    const file = fileInput.files[0];

    if (!pastedText && !file) {
      setMessage('Paste transcript text or choose a transcript file first.', 'error');
      return;
    }

    const qualityWarning = transcriptQualityWarning(pastedText, file);
    if (qualityWarning && !window.confirm(`${qualityWarning}\n\nContinue anyway?`)) {
      setMessage(qualityWarning, 'warning');
      return;
    }

    setLoading(true);
    setMessage(config.loadingMessage || 'Analysing transcript with local Python logic...', 'info');
    summaryPanel.classList.add('hidden');
    projectReportPanel.classList.add('hidden');
    advancedDetailsPanel.classList.add('hidden');
    jsonPanel.classList.add('hidden');
    debugPanel.classList.add('hidden');

    try {
      const options = { method: 'POST', credentials: 'same-origin' };
      const projectPayload = selectedProjectPayload();
      if (pastedText) {
        options.headers = { 'Content-Type': 'application/json' };
        options.body = JSON.stringify({ text: pastedText, ...projectPayload });
      } else {
        const formData = new FormData();
        formData.append('file', file);
        if (projectPayload.projectId) formData.append('projectId', String(projectPayload.projectId));
        options.body = formData;
      }

      const endpoint = config.includeTranscriptMetadata
        ? `${config.endpoint}${config.endpoint.includes('?') ? '&' : '?'}includeTranscriptMetadata=1`
        : config.endpoint;
      const response = await fetch(endpoint, options);
      const payload = await response.json().catch(() => null);

      if (!response.ok || !payload || payload.ok === false) {
        const detailText = payload && payload.details ? ` ${JSON.stringify(payload.details)}` : '';
        throw new Error((payload && payload.error ? payload.error : `Request failed with status ${response.status}.`) + detailText);
      }

      const fallback = payload.result && payload.result.mode === 'project_update_legacy_fallback'
        ? (payload.result.projectWorkflowFallback || {})
        : null;
      const doneText = `Done. Analysed ${payload.transcriptLength || 0} characters from ${payload.source || 'transcript'}.`;
      setMessage(
        fallback
          ? `${doneText} Note: the primary analysis pipeline failed, so this report was generated with the simplified fallback engine (${fallback.reason || 'reason unknown'}). Quality may be reduced.`
          : doneText,
        fallback ? 'warning' : 'success'
      );
      displaySummary(payload.result);
      displayProjectReport(payload.result);
      displayDebugPanel(payload.result, payload);
      displayJson(payload.result);
      queueProjectAutosave();
    } catch (error) {
      setMessage(error.message || 'Transcript analysis failed.', 'error');
    } finally {
      setLoading(false);
    }
  }

  function resetPage() {
    fileInput.value = '';
    textInput.value = '';
    state.result = null;
    state.projectReport = null;
    clearTimeout(state.autosaveTimer);
    if (config.projectReportUi) localStorage.removeItem(projectAutosaveKey());
    setAutosaveStatus('');
    setMessage('', '');
    summaryPanel.classList.add('hidden');
    projectReportPanel.classList.add('hidden');
    advancedDetailsPanel.classList.add('hidden');
    jsonPanel.classList.add('hidden');
    debugPanel.classList.add('hidden');
    debugOutput.textContent = '';
    debugSummary.innerHTML = '';
    projectReportOutput.innerHTML = '';
    projectReportPrintOutput.innerHTML = '';
    jsonOutput.textContent = '';
  }

  function confirmResetPage() {
    if (config.confirmReset && !window.confirm('Are you sure you want to reset the page and start again?')) {
      return;
    }
    resetPage();
  }

  async function copyJson() {
    if (!state.result) return;
    await navigator.clipboard.writeText(JSON.stringify(state.result, null, 2));
    setMessage('Data copied to clipboard.', 'success');
  }

  async function saveCurrentProjectReport() {
    refreshProjectReportState();
    const persistence = state.result && state.result.projectReportPersistence ? state.result.projectReportPersistence : {};
    const reportId = persistence.reportId || persistence.report_id || '';
    if (!reportId || !state.projectReport) {
      setMessage('Process meeting with saving enabled before saving report edits.', 'error');
      return;
    }
    saveProjectReportDraftBtn.disabled = true;
    try {
      const response = await fetch(`/api/project-update-test/reports/${encodeURIComponent(reportId)}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectReport: state.projectReport,
          reportName: state.result.fileName || state.result.projectName || `Report ${reportId}`,
          reportStatus: state.projectReport.reportStatus || 'draft',
          changeSummary: 'Saved from project update page.'
        })
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload || payload.ok === false) throw new Error(payload?.error || 'Could not save report.');
      setAutosaveStatus(`Saved report at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`);
      setMessage('Report edits saved.', 'success');
    } catch (error) {
      setMessage(error.message || 'Could not save report.', 'error');
    } finally {
      saveProjectReportDraftBtn.disabled = false;
    }
  }

  goBtn.addEventListener('click', submitTranscript);
  clearBtn.addEventListener('click', confirmResetPage);
  textInput.addEventListener('input', queueProjectAutosave);
  if (projectPicker) projectPicker.addEventListener('change', () => {
    if (projectPicker.value) localStorage.setItem(PROJECT_SELECTION_KEY, projectPicker.value);
    else localStorage.removeItem(PROJECT_SELECTION_KEY);
    populateProjectForm(projectById(projectPicker.value));
  });
  if (toggleProjectManagerBtn) toggleProjectManagerBtn.addEventListener('click', () => {
    projectManager.classList.toggle('hidden');
    populateProjectForm(projectById(projectPicker.value));
  });
  if (newProjectBtn) newProjectBtn.addEventListener('click', () => {
    projectPicker.value = '';
    localStorage.removeItem(PROJECT_SELECTION_KEY);
    populateProjectForm(null);
    projectNameInput.focus();
  });
  if (saveProjectBtn) saveProjectBtn.addEventListener('click', saveProject);
  if (deleteProjectBtn) deleteProjectBtn.addEventListener('click', deleteSelectedProject);
  copyBtn.addEventListener('click', copyJson);
  saveProjectReportDraftBtn.addEventListener('click', saveCurrentProjectReport);
  downloadProjectReportPdfBtn.addEventListener('click', () => {
    refreshProjectReportState();
    if (!state.projectReport) return;
    projectReportPrintOutput.innerHTML = renderStaticProjectReport(state.projectReport);
    window.print();
  });
  openProjectReportFullScreenBtn.addEventListener('click', () => {
    refreshProjectReportState();
    const persistence = state.result && state.result.projectReportPersistence ? state.result.projectReportPersistence : {};
    const reportId = persistence.reportId || persistence.report_id || '';
    if (!reportId) {
      setMessage('Process meeting with saving enabled before opening the report detail page.', 'error');
      return;
    }
    window.open(`/project-update-test/reports/${encodeURIComponent(reportId)}`, '_blank', 'noopener');
  });
  restoreProjectAutosave();
  loadProjectPicker();
}

function listValue(value) {
  if (Array.isArray(value)) return value.join(', ') || '—';
  return value || '—';
}

function meetingMinutesSummary(result) {
  const participants = result.participants || {};
  const clientParticipants = result['participants.client'] || participants.client || [];
  const trinzoParticipants = result['participants.trinzo'] || participants.trinzo || [];
  const actionCount = Array.isArray(result.meetingActionPoint)
    ? result.meetingActionPoint.length
    : Array.isArray(result.nextSteps)
      ? result.nextSteps.length
      : 0;
  return [
    { label: 'Title', value: result.meetingTitle || '—' },
    { label: 'Date', value: result.meetingDate || '—' },
    { label: 'Client participants', value: listValue(clientParticipants) },
    { label: 'Trinzo participants', value: listValue(trinzoParticipants) },
    { label: 'Action count', value: String(actionCount) }
  ];
}

function projectUpdateSummary(result) {
  const segments = Array.isArray(result.segments) ? result.segments : [];
  const report = result.projectReport || {};
  const counts = segments.reduce((acc, segment) => {
    const status = String(segment.agreed_rag_status || segment.rag_status || 'unknown').toLowerCase();
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
  const changedCount = Array.isArray(result.changes) ? result.changes.length : Number(result.summary && result.summary.changed_count) || 0;
  return [
    { label: 'Report status', value: report.reportStatus ? report.reportStatus.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()).replace(/\B\w/g, (letter) => letter.toLowerCase()) : '—' },
    { label: 'Overall health', value: report.overallHealth ? report.overallHealth.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()).replace(/\B\w/g, (letter) => letter.toLowerCase()) : '—' },
    { label: 'Milestone count', value: String(segments.length) },
    { label: 'Green', value: String(counts.green || 0) },
    { label: 'Amber', value: String(counts.amber || 0) },
    { label: 'Red', value: String(counts.red || 0) },
    { label: 'Risks', value: String(Array.isArray(report.risks) ? report.risks.length : 0) },
    { label: 'Actions', value: String(Array.isArray(report.actions) ? report.actions.length : 0) },
    { label: 'Changed', value: String(changedCount) }
  ];
}

function buildTranscriptComparisonPage(config) {
  const state = {
    payload: null,
    loading: false
  };

  const root = document.getElementById('transcriptComparisonRoot');
  root.innerHTML = `
    <section class="panel">
      <h1>${config.title}</h1>
      <p class="intro">${config.intro}</p>
      <div class="field">
        <label for="comparisonTranscriptFile">Transcript file</label>
        <input id="comparisonTranscriptFile" type="file" accept=".txt,.docx,.csv,text/plain,text/csv,application/vnd.openxmlformats-officedocument.wordprocessingml.document" />
        <small>Supports pasted text and .txt uploads. .docx and .csv are accepted when extraction is available.</small>
      </div>
      <div class="field">
        <label for="comparisonTranscriptText">Paste transcript text</label>
        <textarea id="comparisonTranscriptText" placeholder="Paste transcript here..."></textarea>
        <small>If both a file and pasted text are provided, pasted text takes priority.</small>
      </div>
      <div class="actions">
        <button id="comparisonGoBtn" type="button">${config.buttonText}</button>
        <button id="comparisonClearBtn" class="secondary" type="button">Clear / reset</button>
      </div>
      <div id="comparisonMessage" class="message hidden"></div>
    </section>

    <section id="comparisonSummaryPanel" class="panel hidden">
      <h2>Summary</h2>
      <div id="comparisonSummaryGrid" class="summary-grid"></div>
    </section>

    <section id="comparisonOutputsPanel" class="panel hidden">
      <h2>Outputs</h2>
      <p class="note">Baseline is the current numbers extractor. MiniLM is the experimental sidecar variant. The baseline remains the production-safe output.</p>
      <div class="output-grid">
        <div>
          <div class="json-heading">
            <h2>Baseline numbers output</h2>
            <button id="copyBaselineBtn" class="secondary" type="button">Copy baseline</button>
          </div>
          <pre id="baselineOutput"></pre>
        </div>
        <div>
          <div class="json-heading">
            <h2>MiniLM variant output</h2>
            <button id="copyMinilmBtn" class="secondary" type="button">Copy MiniLM</button>
          </div>
          <pre id="minilmOutput"></pre>
        </div>
      </div>
    </section>

    <section id="comparisonDiffPanel" class="panel hidden">
      <div class="json-heading">
        <h2>Diff and diagnostics</h2>
        <button id="copyDiffBtn" class="secondary" type="button">Copy diff</button>
      </div>
      <pre id="diffOutput"></pre>
    </section>
  `;

  const fileInput = document.getElementById('comparisonTranscriptFile');
  const textInput = document.getElementById('comparisonTranscriptText');
  const goBtn = document.getElementById('comparisonGoBtn');
  const clearBtn = document.getElementById('comparisonClearBtn');
  const copyBaselineBtn = document.getElementById('copyBaselineBtn');
  const copyMinilmBtn = document.getElementById('copyMinilmBtn');
  const copyDiffBtn = document.getElementById('copyDiffBtn');
  const message = document.getElementById('comparisonMessage');
  const summaryPanel = document.getElementById('comparisonSummaryPanel');
  const summaryGrid = document.getElementById('comparisonSummaryGrid');
  const outputsPanel = document.getElementById('comparisonOutputsPanel');
  const diffPanel = document.getElementById('comparisonDiffPanel');
  const baselineOutput = document.getElementById('baselineOutput');
  const minilmOutput = document.getElementById('minilmOutput');
  const diffOutput = document.getElementById('diffOutput');

  function setMessage(text, type) {
    message.textContent = text || '';
    message.className = text ? `message ${type || ''}` : 'message hidden';
  }

  function setLoading(isLoading) {
    state.loading = isLoading;
    goBtn.disabled = isLoading;
    clearBtn.disabled = isLoading;
    fileInput.disabled = isLoading;
    textInput.disabled = isLoading;
    goBtn.textContent = isLoading ? 'Working...' : config.buttonText;
  }

  function comparisonSummaryItems(payload) {
    const result = payload && payload.result ? payload.result : {};
    const baseline = result.baseline || {};
    const minilm = result.minilm || {};
    const comparison = result.comparison || {};
    const baselineCounts = comparison.baselineCounts || {};
    const minilmCounts = comparison.minilmCounts || {};
    const modelStatus = minilm.modelAvailable ? 'available' : `unavailable: ${minilm.modelReason || 'unknown reason'}`;
    return [
      { label: 'Baseline actions', value: String(baselineCounts.actions || 0) },
      { label: 'MiniLM actions', value: String(minilmCounts.actions || 0) },
      { label: 'Baseline decisions', value: String(baselineCounts.decisions || 0) },
      { label: 'MiniLM decisions', value: String(minilmCounts.decisions || 0) },
      { label: 'Baseline discussion', value: String(baselineCounts.discussionPoints || 0) },
      { label: 'MiniLM discussion', value: String(minilmCounts.discussionPoints || 0) },
      { label: 'Model status', value: modelStatus },
      { label: 'Runtime ms', value: String((result.timingMs && result.timingMs.total) || 0) }
    ];
  }

  function displayPayload(payload) {
    state.payload = payload;
    const items = comparisonSummaryItems(payload);
    summaryGrid.innerHTML = items.map((item) => `
      <div class="summary-item">
        <div class="summary-label">${item.label}</div>
        <div class="summary-value">${item.value}</div>
      </div>
    `).join('');
    summaryPanel.classList.remove('hidden');

    const result = payload.result || {};
    baselineOutput.textContent = JSON.stringify(result.baseline || {}, null, 2);
    minilmOutput.textContent = JSON.stringify(result.minilm || {}, null, 2);
    diffOutput.textContent = JSON.stringify({
      comparison: result.comparison || {},
      timingMs: result.timingMs || {},
      transcriptMetadata: payload.transcriptMetadata || null
    }, null, 2);

    outputsPanel.classList.remove('hidden');
    diffPanel.classList.remove('hidden');
  }

  async function submitTranscript() {
    const pastedText = textInput.value.trim();
    const file = fileInput.files[0];

    if (!pastedText && !file) {
      setMessage('Paste transcript text or choose a transcript file first.', 'error');
      return;
    }

    setLoading(true);
    setMessage('Running baseline numbers output and MiniLM variant side by side...', 'info');
    summaryPanel.classList.add('hidden');
    outputsPanel.classList.add('hidden');
    diffPanel.classList.add('hidden');

    try {
      const options = { method: 'POST' };
      if (pastedText) {
        options.headers = { 'Content-Type': 'application/json' };
        options.body = JSON.stringify({ text: pastedText });
      } else {
        const formData = new FormData();
        formData.append('file', file);
        options.body = formData;
      }

      const endpoint = config.endpoint;
      const response = await fetch(endpoint, options);
      const payload = await response.json().catch(() => null);

      if (!response.ok || !payload || payload.ok === false) {
        const detailText = payload && payload.details ? ` ${JSON.stringify(payload.details)}` : '';
        throw new Error((payload && payload.error ? payload.error : `Request failed with status ${response.status}.`) + detailText);
      }

      setMessage(`Done. Compared ${payload.transcriptLength || 0} characters from ${payload.source || 'transcript'}.`, 'success');
      displayPayload(payload);
    } catch (error) {
      setMessage(error.message || 'Transcript comparison failed.', 'error');
    } finally {
      setLoading(false);
    }
  }

  function resetPage() {
    fileInput.value = '';
    textInput.value = '';
    state.payload = null;
    setMessage('', '');
    summaryPanel.classList.add('hidden');
    outputsPanel.classList.add('hidden');
    diffPanel.classList.add('hidden');
    baselineOutput.textContent = '';
    minilmOutput.textContent = '';
    diffOutput.textContent = '';
  }

  async function copyValue(value, label) {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setMessage(`${label} copied to clipboard.`, 'success');
  }

  goBtn.addEventListener('click', submitTranscript);
  clearBtn.addEventListener('click', resetPage);
  copyBaselineBtn.addEventListener('click', () => copyValue(baselineOutput.textContent, 'Baseline output'));
  copyMinilmBtn.addEventListener('click', () => copyValue(minilmOutput.textContent, 'MiniLM output'));
  copyDiffBtn.addEventListener('click', () => copyValue(diffOutput.textContent, 'Diff output'));
}

function buildTranscriptMinilmOnlyPage(config) {
  const state = {
    payload: null,
    loading: false,
    improving: false,
    snippetImproving: false,
    schemaOutput: null,
    extractedText: '',
    currentJobId: null,
    jobPollTimer: null
  };

  const root = document.getElementById('transcriptMinilmOnlyRoot');
  root.innerHTML = `
    <section class="panel">
      <h1>${config.title}</h1>
      <p class="intro">${config.intro}</p>
      <div class="field">
        <label for="minilmOnlyTranscriptFile">Transcript file</label>
        <input id="minilmOnlyTranscriptFile" type="file" accept=".txt,.docx,.csv,text/plain,text/csv,application/vnd.openxmlformats-officedocument.wordprocessingml.document" />
        <small>Supports pasted text and .txt uploads. .docx and .csv are accepted when extraction is available.</small>
      </div>
      <div class="field">
        <label for="minilmOnlyTranscriptText">Paste transcript text</label>
        <textarea id="minilmOnlyTranscriptText" placeholder="Paste transcript here..."></textarea>
        <small>If both a file and pasted text are provided, pasted text takes priority.</small>
      </div>
      <div class="safeguard-banner"><strong>Draft workflow:</strong> generated minutes must be reviewed before exporting or sending. Confirm the title, date, discussion points, owners and deadlines against the transcript.</div>
      <div class="safeguard-banner quiet"><strong>Data handling:</strong> uploaded or pasted transcripts are sent to the server to create draft minutes. Saved jobs keep the transcript and generated result until the job is deleted.</div>
      <div class="actions">
        <button id="minilmOnlyGoBtn" type="button">${config.buttonText}</button>
        <button id="minilmOnlyClearBtn" class="secondary" type="button">Clear / reset</button>
        ${config.jobsPageUrl ? `<a class="button secondary" href="${escapeHtml(config.jobsPageUrl)}" style="text-decoration:none;">View jobs</a>` : ''}
      </div>
      <div id="minilmOnlyMessage" class="message hidden"></div>
      <div id="minilmOnlyProgress" class="progress-card hidden" role="status" aria-live="polite">
        <div class="progress-header">
          <div>
            <div id="minilmOnlyProgressTitle" class="progress-title">Preparing transcript…</div>
            <div id="minilmOnlyProgressTip" class="progress-tip">Large transcripts can take a minute or two while the AI writes the minutes.</div>
          </div>
          <div id="minilmOnlyProgressTime" class="progress-time">0s</div>
        </div>
        <div class="progress-track" aria-hidden="true"><div class="progress-fill"></div></div>
        <div id="minilmOnlyProgressSteps" class="progress-steps"></div>
      </div>
    </section>

    <section id="minilmOnlyOutputPanel" class="panel hidden">
      <div class="json-heading">
        <h2>Minutes output</h2>
        <button id="copyMinilmOnlyOutputBtn" class="secondary" type="button">Copy minutes data</button>
      </div>
      <div class="safeguard-banner warning"><strong>Draft minutes — review required:</strong> check all editable fields before exporting or sending to SharePoint. AI-written minutes can miss nuance, invent certainty, or misassign actions.</div>
      <div id="minilmOnlyOutput"></div>
      <div class="panel-actions">
        ${config.improveEndpoint ? '<button id="minilmOnlyImproveBtn" class="secondary" type="button" disabled>Improve minutes</button>' : ''}
        <button id="exportPdfBtn" class="secondary hidden" type="button">Export PDF</button>
        <button id="finaliseBtn" type="button" class="hidden">Confirm & Send to SharePoint</button>
      </div>
    </section>

    <section id="minilmOnlyDiagnosticsPanel" class="panel hidden">
      <div class="accordion">
        <details>
          <summary>Advanced details</summary>
          <div class="accordion-body">
            <div class="accordion">
              <details>
                <summary>Summary</summary>
                <div class="accordion-body">
                  <div id="minilmOnlySummaryGrid" class="summary-grid"></div>
                </div>
              </details>
              <details>
                <summary>Original output</summary>
                <div class="accordion-body">
                  <div class="json-heading">
                    <span class="note">Original MiniLM-only payload</span>
                    <button id="copyMinilmOnlyRawBtn" class="secondary" type="button">Copy raw output</button>
                  </div>
                  <pre id="minilmOnlyRawOutput"></pre>
                </div>
              </details>
              <details>
                <summary>Diagnostics</summary>
                <div class="accordion-body">
                  <div class="json-heading">
                    <span class="note">Current diagnostics, timings, and transcript metadata</span>
                    <button id="copyMinilmOnlyDiagnosticsBtn" class="secondary" type="button">Copy diagnostics</button>
                  </div>
                  <pre id="minilmOnlyDiagnostics"></pre>
                </div>
              </details>
            </div>
          </div>
        </details>
      </div>
    </section>
  `;

  const fileInput = document.getElementById('minilmOnlyTranscriptFile');
  const textInput = document.getElementById('minilmOnlyTranscriptText');
  const goBtn = document.getElementById('minilmOnlyGoBtn');
  const improveBtn = document.getElementById('minilmOnlyImproveBtn');
  const clearBtn = document.getElementById('minilmOnlyClearBtn');
  const copyOutputBtn = document.getElementById('copyMinilmOnlyOutputBtn');
  const copyRawBtn = document.getElementById('copyMinilmOnlyRawBtn');
  const copyDiagnosticsBtn = document.getElementById('copyMinilmOnlyDiagnosticsBtn');
  const finaliseBtn = document.getElementById('finaliseBtn');
  const exportPdfBtn = document.getElementById('exportPdfBtn');
  const message = document.getElementById('minilmOnlyMessage');
  const progressPanel = document.getElementById('minilmOnlyProgress');
  const progressTitle = document.getElementById('minilmOnlyProgressTitle');
  const progressTip = document.getElementById('minilmOnlyProgressTip');
  const progressTime = document.getElementById('minilmOnlyProgressTime');
  const progressStepsNode = document.getElementById('minilmOnlyProgressSteps');
  const summaryGrid = document.getElementById('minilmOnlySummaryGrid');
  const outputPanel = document.getElementById('minilmOnlyOutputPanel');
  const diagnosticsPanel = document.getElementById('minilmOnlyDiagnosticsPanel');
  const outputNode = document.getElementById('minilmOnlyOutput');
  const rawOutputNode = document.getElementById('minilmOnlyRawOutput');
  const diagnosticsNode = document.getElementById('minilmOnlyDiagnostics');
  const REVIEW_STORAGE_KEY = 'reviewData';
  const PROGRESS_STEPS = [
    { at: 0, label: 'Preparing transcript', tip: 'Reading the uploaded file or pasted transcript.' },
    { at: 4, label: 'Sending to AI', tip: 'Sending the full transcript to the meeting-minutes model.' },
    { at: 14, label: 'Writing minutes', tip: 'The AI is turning the transcript into client-ready minutes.' },
    { at: 38, label: 'Checking structure', tip: 'Checking the output has objectives, discussion points and actions.' },
    { at: 70, label: 'Formatting table', tip: 'Almost there — formatting the editable table.' }
  ];
  let progressTimer = null;
  let progressStartedAt = 0;

  function setStep(n) {
    const stepper = document.getElementById('stepper');
    if (!stepper) return;
    stepper.querySelectorAll('.step').forEach((node) => {
      node.classList.toggle('active', Number(node.dataset.step) === Number(n));
    });
  }

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function saveReviewDataToStorage(data) {
    localStorage.setItem(REVIEW_STORAGE_KEY, JSON.stringify(data || {}));
  }

  function getReviewDataFromStorage() {
    const raw = localStorage.getItem(REVIEW_STORAGE_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function setMessage(text, type) {
    message.textContent = text || '';
    message.className = text ? `message ${type || ''}` : 'message hidden';
  }

  function updateProgress() {
    if (!progressPanel || !progressStartedAt) return;
    const elapsed = Math.max(0, Math.floor((Date.now() - progressStartedAt) / 1000));
    const current = [...PROGRESS_STEPS].reverse().find((step) => elapsed >= step.at) || PROGRESS_STEPS[0];
    progressTitle.textContent = `${current.label}…`;
    progressTip.textContent = elapsed > 95
      ? 'Still working. Long transcripts and free AI models can take a little while, but the request is still active.'
      : current.tip;
    progressTime.textContent = `${elapsed}s`;
    progressStepsNode.innerHTML = PROGRESS_STEPS.map((step) => `
      <span class="progress-step ${elapsed >= step.at ? 'active' : ''}">${escapeHtml(step.label)}</span>
    `).join('');
  }

  function startProgress() {
    if (!progressPanel) return;
    progressStartedAt = Date.now();
    progressPanel.classList.remove('hidden');
    updateProgress();
    clearInterval(progressTimer);
    progressTimer = setInterval(updateProgress, 1000);
  }

  function stopProgress() {
    clearInterval(progressTimer);
    progressTimer = null;
    progressStartedAt = 0;
    if (progressPanel) progressPanel.classList.add('hidden');
  }

  function stopJobPolling() {
    if (state.jobPollTimer) clearInterval(state.jobPollTimer);
    state.jobPollTimer = null;
  }

  function updateQueuedProgress(job) {
    if (!progressPanel || !job) return;
    progressPanel.classList.remove('hidden');
    const createdAt = job.startedAt || job.createdAt;
    const elapsed = createdAt ? Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000)) : 0;
    const stage = job.stage || job.status || 'queued';
    progressTitle.textContent = `${titleize(stage)}…`;
    progressTip.textContent = job.statusMessage || 'Waiting for the meeting-minutes worker.';
    progressTime.textContent = `${elapsed}s`;
    const activeProgress = Number(job.progressPercent || 0);
    progressStepsNode.innerHTML = [
      { at: 0, label: 'Queued' },
      { at: 10, label: 'Extracting' },
      { at: 30, label: 'Drafting' },
      { at: 80, label: 'Finalising' },
      { at: 100, label: 'Ready' }
    ].map((step) => `
      <span class="progress-step ${activeProgress >= step.at ? 'active' : ''}">${escapeHtml(step.label)}</span>
    `).join('');
  }

  function setLoading(isLoading) {
    state.loading = isLoading;
    goBtn.disabled = isLoading || state.improving;
    clearBtn.disabled = isLoading || state.improving;
    fileInput.disabled = isLoading || state.improving;
    textInput.disabled = isLoading || state.improving;
    if (improveBtn) {
      improveBtn.disabled = isLoading || state.improving || !(state.payload && state.payload.result && state.payload.result.output);
    }
    if (exportPdfBtn) exportPdfBtn.disabled = isLoading || state.improving || !state.schemaOutput;
    if (isLoading) startProgress();
    else stopProgress();
    goBtn.textContent = isLoading ? 'Generating minutes...' : config.buttonText;
  }

  function setImproving(isImproving) {
    state.improving = isImproving;
    const busy = isImproving || state.snippetImproving;
    goBtn.disabled = busy || state.loading;
    clearBtn.disabled = busy || state.loading;
    fileInput.disabled = busy || state.loading;
    textInput.disabled = busy || state.loading;
    if (improveBtn) {
      improveBtn.disabled = busy || state.loading || !(state.payload && state.payload.result && state.payload.result.output);
      improveBtn.textContent = isImproving ? 'Improving...' : 'Improve minutes';
    }
    if (exportPdfBtn) exportPdfBtn.disabled = busy || state.loading || !state.schemaOutput;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function nearestElement(node) {
    return node && node.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement || null;
  }

  function deriveSnippetCategory(element) {
    const field = element?.dataset?.actionField || '';
    const id = element?.id || '';
    if (field === 'action' || id.includes('Action')) return 'action';
    if (id.includes('Objectives')) return 'objective';
    if (id.includes('discussion') || id.includes('Discussion')) return 'discussion';
    return 'discussion';
  }

  function getEditableSnippetSelection() {
    if (!outputNode || outputPanel.classList.contains('hidden')) return null;
    const active = document.activeElement;
    if (active && outputNode.contains(active) && typeof active.selectionStart === 'number' && typeof active.selectionEnd === 'number') {
      const start = active.selectionStart;
      const end = active.selectionEnd;
      const value = String(active.value || '');
      const text = value.slice(start, end);
      if (!text.trim()) return null;
      return {
        text,
        category: deriveSnippetCategory(active),
        replace(replacement) {
          active.value = `${value.slice(0, start)}${replacement}${value.slice(end)}`;
          active.focus();
          const caretEnd = start + replacement.length;
          active.setSelectionRange(start, caretEnd);
          active.dispatchEvent(new Event('input', { bubbles: true }));
          active.dispatchEvent(new Event('change', { bubbles: true }));
        }
      };
    }

    const selection = window.getSelection ? window.getSelection() : null;
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    if (!outputNode.contains(selection.anchorNode) || !outputNode.contains(selection.focusNode)) return null;
    const range = selection.getRangeAt(0).cloneRange();
    const text = selection.toString();
    if (!text.trim()) return null;
    return {
      text,
      category: deriveSnippetCategory(nearestElement(range.commonAncestorContainer)),
      replace(replacement) {
        range.deleteContents();
        const inserted = document.createTextNode(replacement);
        range.insertNode(inserted);
        selection.removeAllRanges();
        const nextRange = document.createRange();
        nextRange.selectNodeContents(inserted);
        selection.addRange(nextRange);
      }
    };
  }

  function setSnippetImproving(isImproving) {
    state.snippetImproving = isImproving;
    setImproving(state.improving);
  }

  async function improveSelectedSnippet() {
    if (!config.snippetImproveEndpoint) return;
    const selection = getEditableSnippetSelection();
    if (!selection) {
      setMessage('Select text inside the minutes table first, then press Ctrl+Shift+M (Cmd+Shift+M on Mac) to improve only that snippet.', 'error');
      return;
    }

    setSnippetImproving(true);
    setMessage(`Selected snippet sent to AI (${selection.text.trim().slice(0, 180)}${selection.text.trim().length > 180 ? '…' : ''})`, 'info');

    try {
      const response = await fetch(config.snippetImproveEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ snippet: selection.text, category: selection.category })
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload || payload.ok === false || !payload.result) {
        const detailText = payload && payload.details ? ` ${JSON.stringify(payload.details)}` : '';
        throw new Error((payload && payload.error ? payload.error : `Request failed with status ${response.status}.`) + detailText);
      }
      const improved = String(payload.result.rewritten || selection.text);
      selection.replace(improved);
      saveReviewDataToStorage(buildReviewDataFromSchema(collectEditedSchemaOutput()));
      const statusPrefix = payload.result.rewriterAvailable ? 'AI returned an improved snippet' : 'AI rewriter unavailable; original snippet kept';
      setMessage(`${statusPrefix}:\n${improved}`, payload.result.rewriterAvailable ? 'success' : 'error');
    } catch (error) {
      setMessage(error.message || 'Improving the selected snippet failed.', 'error');
    } finally {
      setSnippetImproving(false);
    }
  }

  function deriveObjectives(output) {
    if (Array.isArray(output.objectives) && output.objectives.length) return output.objectives;
    if (Array.isArray(output.meetingObjectives) && output.meetingObjectives.length) return output.meetingObjectives;
    const decisions = Array.isArray(output.decisions) ? output.decisions : [];
    if (decisions.length) return decisions.slice(0, 2).map((point) => point.replace(/\.$/, ''));
    const points = Array.isArray(output.discussionPoints) ? output.discussionPoints : [];
    return points.slice(0, 2).map((point) => point.replace(/\.$/, ''));
  }

  function buildStructuredMinutesSchema(output) {
    const participants = output.participants || {};
    const actionPoints = Array.isArray(output.meetingActionPoint) ? output.meetingActionPoint : [];
    const actionOwners = Array.isArray(output.meetingActionPointOwner) ? output.meetingActionPointOwner : [];
    const actionDeadlines = Array.isArray(output.meetingActionPointDeadline) ? output.meetingActionPointDeadline : [];
    const discussionPoints = Array.isArray(output.discussionPoints) ? output.discussionPoints : [];
    return {
      meetingTitle: output.meetingTitle || '',
      meetingDate: output.meetingDate || '',
      meetingLocation: output.meetingLocation || 'Online',
      meetingObjectives: deriveObjectives(output),
      participants: {
        client: Array.isArray(participants.client) ? participants.client : [],
        trinzo: Array.isArray(participants.trinzo) ? participants.trinzo : []
      },
      itemTopic: output.itemTopic || output.meetingTitle || 'Meeting discussion',
      discussionPoints,
      meetingActionPoint: actionPoints,
      meetingActionPointOwner: actionOwners,
      meetingActionPointDeadline: actionDeadlines
    };
  }

  function displayDetailsSummary(payload, result) {
    const output = result.output || {};
    const modelStatus = Object.prototype.hasOwnProperty.call(result, 'modelAvailable')
      ? (result.modelAvailable ? 'available' : `unavailable: ${result.modelReason || 'unknown reason'}`)
      : 'not rerun';
    const items = [
      { label: 'Model status', value: modelStatus },
      { label: 'Rewrite status', value: Object.prototype.hasOwnProperty.call(result, 'rewriterAvailable') ? (result.rewriterAvailable ? 'available' : `unavailable: ${result.rewriterReason || 'unknown reason'}`) : 'not run' },
      { label: 'Discussion points', value: String((result.counts && result.counts.discussionPoints) || 0) },
      { label: 'Decisions', value: String((result.counts && result.counts.decisions) || 0) },
      { label: 'Actions', value: String((result.counts && result.counts.actions) || 0) },
      { label: 'Runtime ms', value: String((result.timingMs && result.timingMs.total) || 0) },
      { label: 'Transcript chars', value: String(payload.transcriptLength || 0) },
      { label: 'Title', value: output.meetingTitle || '—' }
    ];
    summaryGrid.innerHTML = items.map((item) => `
      <div class="summary-item">
        <div class="summary-label">${escapeHtml(item.label)}</div>
        <div class="summary-value">${escapeHtml(item.value)}</div>
      </div>
    `).join('');
  }

  function renderTextarea(id, items, placeholder) {
    const value = Array.isArray(items) ? items.join('\n') : (items || '');
    return `<textarea id="${id}" placeholder="${escapeHtml(placeholder || '')}">${escapeHtml(value)}</textarea>`;
  }

  function toDateInputValue(value) {
    const text = String(value || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
    const match = text.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})$/);
    if (!match) return '';
    const monthIndex = [
      'january', 'february', 'march', 'april', 'may', 'june',
      'july', 'august', 'september', 'october', 'november', 'december'
    ].indexOf(match[2].toLowerCase());
    if (monthIndex < 0) return '';
    return `${match[3]}-${String(monthIndex + 1).padStart(2, '0')}-${String(Number(match[1])).padStart(2, '0')}`;
  }

  function renderActionTable(schemaOutput) {
    const actions = Array.isArray(schemaOutput.meetingActionPoint) ? schemaOutput.meetingActionPoint : [];
    const owners = Array.isArray(schemaOutput.meetingActionPointOwner) ? schemaOutput.meetingActionPointOwner : [];
    const deadlines = Array.isArray(schemaOutput.meetingActionPointDeadline) ? schemaOutput.meetingActionPointDeadline : [];
    const rowCount = Math.max(actions.length, owners.length, deadlines.length, 1);
    return `
      <table class="schema-subtable" id="actionsTable">
        <thead>
          <tr>
            <th>Action</th>
            <th>Owner</th>
            <th>Deadline</th>
          </tr>
        </thead>
        <tbody>
          ${Array.from({ length: rowCount }).map((_, index) => `
            <tr>
              <td><textarea class="action-field" data-action-field="action" placeholder="Action">${escapeHtml(actions[index] || '')}</textarea></td>
              <td><input type="text" data-action-field="owner" value="${escapeHtml(owners[index] || '')}" placeholder="Owner" /></td>
              <td><input type="text" data-action-field="deadline" value="${escapeHtml(deadlines[index] || '')}" placeholder="Deadline" /></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      <div class="schema-inline-actions">
        <button id="addActionRowBtn" class="secondary" type="button">Add action row</button>
      </div>
    `;
  }

  function renderParticipantsTable(participants) {
    const client = Array.isArray(participants.client) ? participants.client : [];
    const trinzo = Array.isArray(participants.trinzo) ? participants.trinzo : [];
    return `
      <table class="schema-subtable">
        <thead>
          <tr>
            <th>Client</th>
            <th>Trinzo</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>${renderTextarea('participantsClientInput', client, 'One client participant per line')}</td>
            <td>${renderTextarea('participantsTrinzoInput', trinzo, 'One Trinzo participant per line')}</td>
          </tr>
        </tbody>
      </table>
    `;
  }

  function renderSchemaTable(schemaOutput) {
    return `
      <table class="schema-table">
        <tbody>
          <tr>
            <th>Meeting title</th>
            <td><input id="meetingTitleInput" type="text" value="${escapeHtml(schemaOutput.meetingTitle || '')}" placeholder="Meeting title" /></td>
          </tr>
          <tr>
            <th>Meeting date</th>
            <td><input id="meetingDateInput" type="date" value="${escapeHtml(toDateInputValue(schemaOutput.meetingDate))}" /></td>
          </tr>
          <tr>
            <th>Meeting location</th>
            <td><input id="meetingLocationInput" type="text" value="${escapeHtml(schemaOutput.meetingLocation || '')}" placeholder="Meeting location" /></td>
          </tr>
          <tr>
            <th>Meeting objectives</th>
            <td>${renderTextarea('meetingObjectivesInput', schemaOutput.meetingObjectives, 'One objective per line')}</td>
          </tr>
          <tr>
            <th>Participants</th>
            <td>${renderParticipantsTable(schemaOutput.participants || {})}</td>
          </tr>
          <tr>
            <th>Discussion points</th>
            <td>${renderTextarea('discussionPointsInput', schemaOutput.discussionPoints, 'One discussion point per line')}</td>
          </tr>
          <tr>
            <th>Actions</th>
            <td>${renderActionTable(schemaOutput)}</td>
          </tr>
        </tbody>
      </table>
    `;
  }

  function parseLines(value) {
    return String(value || '')
      .split('\n')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function collectEditedSchemaOutput() {
    if (!state.schemaOutput) return null;
    const schema = {
      meetingTitle: document.getElementById('meetingTitleInput')?.value.trim() || '',
      meetingDate: document.getElementById('meetingDateInput')?.value.trim() || '',
      meetingLocation: document.getElementById('meetingLocationInput')?.value.trim() || '',
      meetingObjectives: parseLines(document.getElementById('meetingObjectivesInput')?.value || ''),
      participants: {
        client: parseLines(document.getElementById('participantsClientInput')?.value || ''),
        trinzo: parseLines(document.getElementById('participantsTrinzoInput')?.value || ''),
      },
      itemTopic: state.schemaOutput?.itemTopic || state.payload?.result?.output?.itemTopic || state.payload?.result?.output?.meetingTitle || 'Meeting discussion',
      discussionPoints: parseLines(document.getElementById('discussionPointsInput')?.value || ''),
      meetingActionPoint: [],
      meetingActionPointOwner: [],
      meetingActionPointDeadline: []
    };

    const actionRows = Array.from(outputNode.querySelectorAll('#actionsTable tbody tr'));
    actionRows.forEach((row) => {
      const action = row.querySelector('[data-action-field="action"]')?.value.trim() || '';
      const owner = row.querySelector('[data-action-field="owner"]')?.value.trim() || '';
      const deadline = row.querySelector('[data-action-field="deadline"]')?.value.trim() || '';
      if (!action && !owner && !deadline) return;
      schema.meetingActionPoint.push(action);
      schema.meetingActionPointOwner.push(owner || 'Owner not specified');
      schema.meetingActionPointDeadline.push(deadline);
    });
    return schema;
  }

  function buildEditableOutputFromSchema(schema) {
    const output = cloneJson((state.payload && state.payload.result && state.payload.result.output) || {});
    output.meetingTitle = schema.meetingTitle;
    output.meetingDate = schema.meetingDate;
    output.meetingLocation = schema.meetingLocation;
    output.meetingObjectives = schema.meetingObjectives;
    output.participants = {
      client: schema.participants.client,
      trinzo: schema.participants.trinzo,
    };
    output.itemTopic = schema.itemTopic;
    output.discussionPoints = schema.discussionPoints;
    output.meetingActionPoint = schema.meetingActionPoint;
    output.meetingActionPointOwner = schema.meetingActionPointOwner;
    output.meetingActionPointDeadline = schema.meetingActionPointDeadline;
    output.actions = schema.meetingActionPoint.map((action, index) => ({
      meetingActionPoint: action,
      meetingActionPointOwner: schema.meetingActionPointOwner[index] || 'Owner not specified',
      meetingActionPointDeadline: schema.meetingActionPointDeadline[index] || '',
      actionConfidence: Array.isArray(output.actions) && output.actions[index] ? output.actions[index].actionConfidence || 0 : 0,
      relatedMilestone: Array.isArray(output.actions) && output.actions[index] ? output.actions[index].relatedMilestone || 'minilm_only' : 'minilm_only',
      _evidence: Array.isArray(output.actions) && output.actions[index] ? output.actions[index]._evidence || [] : [],
    }));
    if (output.internalEvidence && typeof output.internalEvidence === 'object') {
      output.internalEvidence.actions = output.actions.map((item) => ({ text: item.meetingActionPoint, _evidence: item._evidence || [] }));
      output.internalEvidence.discussionPoints = schema.discussionPoints.map((text, index) => {
        const current = Array.isArray(output.internalEvidence.discussionPoints) ? output.internalEvidence.discussionPoints[index] : null;
        return { text, _evidence: current && Array.isArray(current._evidence) ? current._evidence : [] };
      });
    }
    return output;
  }

  function buildReviewDataFromSchema(schema) {
    return {
      meetingTitle: schema.meetingTitle || '',
      meetingDate: schema.meetingDate || '',
      meetingLocation: schema.meetingLocation || '',
      meetingDescription: '',
      meetingObjectives: Array.isArray(schema.meetingObjectives) ? schema.meetingObjectives : [],
      participants: {
        client: Array.isArray(schema.participants?.client) ? schema.participants.client : [],
        trinzo: Array.isArray(schema.participants?.trinzo) ? schema.participants.trinzo : [],
      },
      meetingMinutes: [
        {
          topic: schema.itemTopic || '',
          discussionPoints: Array.isArray(schema.discussionPoints) ? schema.discussionPoints : [],
        }
      ],
      nextSteps: (schema.meetingActionPoint || []).map((action, index) => ({
        action,
        owner: schema.meetingActionPointOwner[index] || 'Owner not specified',
        deadline: schema.meetingActionPointDeadline[index] || '',
      })),
      autosave: {
        enabled: true,
        savedAt: new Date().toISOString(),
        transcript: state.extractedText || '',
        transcriptLength: (state.extractedText || '').length,
      },
    };
  }

  function attachSchemaHandlers() {
    const addActionRowBtn = document.getElementById('addActionRowBtn');
    if (addActionRowBtn) {
      addActionRowBtn.addEventListener('click', () => {
        const tableBody = outputNode.querySelector('.schema-subtable tbody');
        if (!tableBody) return;
        tableBody.insertAdjacentHTML('beforeend', `
          <tr>
            <td><textarea class="action-field" data-action-field="action" placeholder="Action"></textarea></td>
            <td><input type="text" data-action-field="owner" value="" placeholder="Owner" /></td>
            <td><input type="text" data-action-field="deadline" value="" placeholder="Deadline" /></td>
          </tr>
        `);
      });
    }
  }

  function rowsFromList(values) {
    return (Array.isArray(values) ? values : [])
      .map((value) => `<tr><td>${escapeHtml(value)}</td></tr>`)
      .join('') || '<tr><td class="empty">Not stated</td></tr>';
  }

  function exportMinutesPdf() {
    const editedSchema = collectEditedSchemaOutput();
    const reviewData = editedSchema ? buildReviewDataFromSchema(editedSchema) : getReviewDataFromStorage();
    if (!reviewData) {
      return setMessage('No minutes found to export. Generate minutes first.', 'error');
    }

    const minutes = Array.isArray(reviewData.meetingMinutes) ? reviewData.meetingMinutes : [];
    const nextSteps = Array.isArray(reviewData.nextSteps) ? reviewData.nextSteps : [];
    const participants = reviewData.participants || {};
    const title = reviewData.meetingTitle || 'Meeting minutes';

    const minutesRows = minutes.flatMap((minute) => {
      const topic = minute.topic || title || 'Discussion';
      const points = Array.isArray(minute.discussionPoints) ? minute.discussionPoints : [];
      return points.length
        ? points.map((point) => `<tr><td>${escapeHtml(topic)}</td><td>${escapeHtml(point)}</td></tr>`)
        : [`<tr><td>${escapeHtml(topic)}</td><td class="empty">No discussion points stated</td></tr>`];
    }).join('') || '<tr><td>Discussion</td><td class="empty">No discussion points stated</td></tr>';

    const actionRows = nextSteps.map((item) => `
      <tr>
        <td>${escapeHtml(item.action || '')}</td>
        <td>${escapeHtml(item.owner || 'Not stated')}</td>
        <td>${escapeHtml(item.deadline || 'Not stated')}</td>
      </tr>
    `).join('') || '<tr><td class="empty">No actions stated</td><td></td><td></td></tr>';

    const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #111827; margin: 0; font-size: 11pt; }
  h1 { font-size: 20pt; margin: 0 0 8px; color: #0f172a; }
  h2 { font-size: 13pt; margin: 18px 0 8px; color: #0f172a; }
  .toolbar { position: sticky; top: 0; margin: 0 0 12px; padding: 10px; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 8px; }
  .toolbar button { background: #14b8a6; color: #042f2e; border: none; border-radius: 8px; padding: 8px 12px; font-weight: 700; cursor: pointer; }
  .meta { width: 100%; border-collapse: collapse; margin: 10px 0 14px; }
  table { width: 100%; border-collapse: collapse; page-break-inside: auto; }
  tr { page-break-inside: avoid; page-break-after: auto; }
  th, td { border: 1px solid #cbd5e1; padding: 7px 8px; vertical-align: top; text-align: left; }
  th { background: #e2e8f0; font-weight: 700; color: #0f172a; }
  .meta th { width: 28%; }
  .empty { color: #64748b; font-style: italic; }
  .footer { margin-top: 18px; color: #64748b; font-size: 9pt; }
  @media print { .toolbar { display: none; } }
</style>
</head>
<body>
  <div class="toolbar"><button type="button" onclick="window.print()">Print / Save as PDF</button></div>
  <h1>${escapeHtml(title)}</h1>
  <table class="meta">
    <tr><th>Date</th><td>${escapeHtml(reviewData.meetingDate || 'Not stated')}</td></tr>
    <tr><th>Location</th><td>${escapeHtml(reviewData.meetingLocation || 'Not stated')}</td></tr>
    <tr><th>Objectives</th><td>${(reviewData.meetingObjectives || []).map(escapeHtml).join('<br>') || '<span class="empty">Not stated</span>'}</td></tr>
    <tr><th>Client participants</th><td>${(participants.client || []).map(escapeHtml).join('<br>') || '<span class="empty">Not stated</span>'}</td></tr>
    <tr><th>Trinzo participants</th><td>${(participants.trinzo || []).map(escapeHtml).join('<br>') || '<span class="empty">Not stated</span>'}</td></tr>
  </table>

  <h2>Discussion points</h2>
  <table>
    <thead><tr><th style="width:28%">Topic</th><th>Point</th></tr></thead>
    <tbody>${minutesRows}</tbody>
  </table>

  <h2>Actions</h2>
  <table>
    <thead><tr><th>Action</th><th style="width:22%">Owner</th><th style="width:20%">Deadline</th></tr></thead>
    <tbody>${actionRows}</tbody>
  </table>

  <div class="footer">Generated from Trinzo meeting minutes tool. Use the print dialog to save as PDF.</div>
  <script>window.addEventListener('load', () => { window.focus(); setTimeout(() => window.print(), 400); });<\/script>
</body>
</html>`;

    const printWindow = window.open('about:blank', '_blank', 'width=1100,height=800');
    if (!printWindow) {
      const blob = new Blob([html], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${title.replace(/[^a-z0-9_-]+/gi, '_').slice(0, 80) || 'meeting_minutes'}.html`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      return setMessage('Popup blocked, so an HTML export was downloaded. Open it and choose Print → Save as PDF.', 'success');
    }

    try {
      printWindow.document.open();
      printWindow.document.write(html);
      printWindow.document.close();
      printWindow.focus();
      setMessage('PDF export opened. Choose “Save as PDF” in the print dialog.', 'success');
    } catch (error) {
      printWindow.close();
      const blob = new Blob([html], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      setMessage('PDF export opened in a fallback tab. Use Print → Save as PDF.', 'success');
    }
  }

  async function parseJsonResponse(response) {
    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch (error) {
      const contentType = response.headers.get('content-type') || 'unknown content type';
      const preview = text.replace(/\s+/g, ' ').slice(0, 240);
      throw new Error(`Server returned ${response.status} ${contentType}, not JSON. ${preview}`);
    }
  }

  async function finaliseWithAgent() {
    const editedSchema = collectEditedSchemaOutput();
    const payloadReviewData = editedSchema ? buildReviewDataFromSchema(editedSchema) : getReviewDataFromStorage();

    if (!payloadReviewData) {
      return setMessage(
        'No review data found. Process transcript first, then use the edit screen.',
        'error'
      );
    }

    const finaliseIssues = minutesReviewIssues(payloadReviewData);
    if (finaliseIssues.length) {
      setMessage(`Review these before sending to SharePoint:\n- ${finaliseIssues.join('\n- ')}`, 'error');
      return;
    }

    const confirmed = window.confirm('Send these reviewed minutes to SharePoint? This should only be done after checking the transcript, title/date, discussion points, owners and deadlines.');
    if (!confirmed) {
      setMessage('SharePoint send cancelled. Keep reviewing the draft until it is ready.', 'warning');
      return;
    }

    saveReviewDataToStorage(payloadReviewData);
    setStep(5);
    setMessage('Sending approved meeting minutes to webhook...', 'info');

    try {
      const response = await fetch('/api/agent/finalise', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          reviewData: payloadReviewData,
          transcript: state.extractedText
        })
      });

      const data = await parseJsonResponse(response);

      if (!response.ok || !data.ok) {
        throw new Error(data.error || 'Final webhook call failed');
      }

      setMessage('Successfully sent to SharePoint', 'success');
    } catch (err) {
      setMessage(`Final webhook call failed: ${err.message}`, 'error');
    }
  }

  function displayPayload(payload) {
    state.payload = payload;
    const result = payload.result || {};
    const output = result.output || {};
    if (!result.output) {
      state.schemaOutput = null;
      displayDetailsSummary(payload, result);
      outputNode.innerHTML = `<p class="note">No minutes output was produced. ${escapeHtml(result.modelReason || 'Check diagnostics for the extractor status.')}</p>`;
      rawOutputNode.textContent = JSON.stringify(result, null, 2);
      diagnosticsNode.textContent = JSON.stringify({
        mode: result.mode || 'minilm_only',
        diagnostics: result.diagnostics || {},
        timingMs: result.timingMs || {},
        transcriptMetadata: payload.transcriptMetadata || null
      }, null, 2);
      outputPanel.classList.remove('hidden');
      diagnosticsPanel.classList.remove('hidden');
      if (finaliseBtn) finaliseBtn.classList.add('hidden');
      if (exportPdfBtn) exportPdfBtn.classList.add('hidden');
      if (improveBtn) improveBtn.disabled = true;
      setMessage(result.modelReason ? `Extractor did not run: ${result.modelReason}` : 'Extractor did not produce minutes output.', 'error');
      return;
    }
    const schemaOutput = buildStructuredMinutesSchema(output);
    state.schemaOutput = schemaOutput;

    displayDetailsSummary(payload, result);
    outputNode.innerHTML = renderSchemaTable(schemaOutput);
    attachSchemaHandlers();
    saveReviewDataToStorage(buildReviewDataFromSchema(schemaOutput));
    rawOutputNode.textContent = JSON.stringify(output, null, 2);
    diagnosticsNode.textContent = JSON.stringify({
      mode: result.mode || 'minilm_only',
      diagnostics: result.diagnostics || {},
      timingMs: result.timingMs || {},
      transcriptMetadata: payload.transcriptMetadata || null
    }, null, 2);
    outputPanel.classList.remove('hidden');
    diagnosticsPanel.classList.remove('hidden');
    if (finaliseBtn) finaliseBtn.classList.remove('hidden');
    if (exportPdfBtn) {
      exportPdfBtn.classList.remove('hidden');
      exportPdfBtn.disabled = false;
    }
    if (improveBtn) improveBtn.disabled = !(state.payload && state.payload.result && state.payload.result.output);
  }

  async function submitTranscript() {
    const pastedText = textInput.value.trim();
    const file = fileInput.files[0];

    if (!pastedText && !file) {
      setMessage('Paste transcript text or choose a transcript file first.', 'error');
      return;
    }

    const qualityWarning = transcriptQualityWarning(pastedText, file);
    if (qualityWarning && !window.confirm(`${qualityWarning}\n\nContinue anyway?`)) {
      setMessage(qualityWarning, 'warning');
      return;
    }

    setLoading(true);
    setMessage(config.queuedEndpoint ? 'Queued meeting minutes generation...' : 'Running meeting minutes extraction...', 'info');
    outputPanel.classList.add('hidden');
    diagnosticsPanel.classList.add('hidden');

    try {
      const options = { method: 'POST' };
      if (pastedText) {
        state.extractedText = pastedText;
        options.headers = { 'Content-Type': 'application/json' };
        options.body = JSON.stringify({ text: pastedText });
      } else {
        const formData = new FormData();
        formData.append('file', file);
        options.body = formData;
        state.extractedText = await file.text().catch(() => '');
      }

      const endpointBase = config.queuedEndpoint || config.endpoint;
      const endpoint = `${endpointBase}?includeTranscriptMetadata=1`;
      const response = await fetch(endpoint, options);
      const payload = await response.json().catch(() => null);

      if (!response.ok || !payload || payload.ok === false) {
        const detailText = payload && payload.details ? ` ${JSON.stringify(payload.details)}` : '';
        throw new Error((payload && payload.error ? payload.error : `Request failed with status ${response.status}.`) + detailText);
      }

      if (config.queuedEndpoint && payload.jobId) {
        state.currentJobId = payload.jobId;
        const jobUrl = `${config.jobsPageUrl || '/meeting-minutes-final/jobs'}/${encodeURIComponent(payload.jobId)}`;
        setMessage(`Queued. Opening job #${payload.jobId} so you can track progress.`, 'success');
        window.location.assign(jobUrl);
        return;
      }

      const rewriterDegraded = payload.result && payload.result.rewriterAvailable === false;
      const doneText = `Done. Created draft meeting minutes from ${payload.transcriptLength || 0} characters.`;
      setMessage(
        rewriterDegraded
          ? `${doneText} Note: the AI writing pass did not run (${payload.result.rewriterReason || 'reason unknown'}), so these minutes are the unpolished draft extraction. Quality may be reduced.`
          : doneText,
        rewriterDegraded ? 'warning' : 'success'
      );
      displayPayload(payload);
    } catch (error) {
      setMessage(error.message || 'Meeting minutes extraction failed.', 'error');
    } finally {
      if (!config.queuedEndpoint) setLoading(false);
    }
  }

  async function pollQueuedJob(jobId) {
    const response = await fetch(`/api/meeting-minutes-final/jobs/${encodeURIComponent(jobId)}`, { credentials: 'same-origin' });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || payload.ok === false) {
      throw new Error(payload?.error || 'Could not load queued job status.');
    }
    const job = payload.job || {};
    updateQueuedProgress(job);

    if (job.status === 'completed' && payload.result) {
      stopJobPolling();
      stopProgress();
      setLoading(false);
      const resultPayload = payload.result;
      const rewriterDegraded = resultPayload.result && resultPayload.result.rewriterAvailable === false;
      setMessage(
        rewriterDegraded
          ? `Done. Job #${jobId} created draft meeting minutes. Note: the AI writing pass did not run (${resultPayload.result.rewriterReason || 'reason unknown'}), so quality may be reduced.`
          : `Done. Job #${jobId} created draft meeting minutes from ${resultPayload.transcriptLength || job.transcriptLength || 0} characters.`,
        rewriterDegraded ? 'warning' : 'success'
      );
      displayPayload(resultPayload);
      return;
    }

    if (job.status === 'failed' || job.status === 'cancelled') {
      stopJobPolling();
      stopProgress();
      setLoading(false);
      setMessage(job.errorMessage || job.statusMessage || `Job ${job.status}.`, 'error');
    }
  }

  async function improveMinutes() {
    if (!config.improveEndpoint || !state.payload || !state.payload.result || !state.payload.result.output) {
      return;
    }

    setImproving(true);
    setMessage('Improving extracted minutes with local LLM...', 'info');

    try {
      const editedSchema = collectEditedSchemaOutput();
      const editedOutput = editedSchema ? buildEditableOutputFromSchema(editedSchema) : state.payload.result.output;
      const response = await fetch(config.improveEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ output: editedOutput })
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok || !payload || payload.ok === false) {
        const detailText = payload && payload.details ? ` ${JSON.stringify(payload.details)}` : '';
        throw new Error((payload && payload.error ? payload.error : `Request failed with status ${response.status}.`) + detailText);
      }

      const mergedPayload = {
        ...state.payload,
        result: payload.result
      };
      if (payload.result && payload.result.rewriteSucceeded === false) {
        const failureCount = payload.result.rewriteFailureCount || 0;
        setMessage(`Local LLM improvement did not fully complete (${failureCount} rewrite item${failureCount === 1 ? '' : 's'} failed). Review diagnostics before using this output.`, 'error');
      } else {
        setMessage('Minutes improved with the local LLM layer.', 'success');
      }
      displayPayload(mergedPayload);
    } catch (error) {
      setMessage(error.message || 'Improving minutes failed.', 'error');
    } finally {
      setImproving(false);
      setLoading(state.loading);
    }
  }

  function resetPage() {
    fileInput.value = '';
    textInput.value = '';
    state.payload = null;
    state.schemaOutput = null;
    state.extractedText = '';
    state.currentJobId = null;
    stopJobPolling();
    setMessage('', '');
    stopProgress();
    outputPanel.classList.add('hidden');
    diagnosticsPanel.classList.add('hidden');
    outputNode.innerHTML = '';
    rawOutputNode.textContent = '';
    diagnosticsNode.textContent = '';
    summaryGrid.innerHTML = '';
    if (improveBtn) improveBtn.disabled = true;
    if (exportPdfBtn) exportPdfBtn.classList.add('hidden');
    if (finaliseBtn) finaliseBtn.classList.add('hidden');
  }

  async function copyValue(value, label) {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setMessage(`${label} copied to clipboard.`, 'success');
  }

  goBtn.addEventListener('click', submitTranscript);
  if (improveBtn) improveBtn.addEventListener('click', improveMinutes);
  if (exportPdfBtn) exportPdfBtn.addEventListener('click', exportMinutesPdf);
  if (finaliseBtn) finaliseBtn.addEventListener('click', finaliseWithAgent);
  document.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.key.toLowerCase() !== 'm') return;
    if (!getEditableSnippetSelection()) return;
    event.preventDefault();
    improveSelectedSnippet();
  });
  clearBtn.addEventListener('click', resetPage);
  copyOutputBtn.addEventListener('click', () => {
    const editedSchema = collectEditedSchemaOutput();
    copyValue(editedSchema ? JSON.stringify(editedSchema, null, 2) : '', 'MiniLM-only schema output');
  });
  copyRawBtn.addEventListener('click', () => copyValue(rawOutputNode.textContent, 'MiniLM-only raw output'));
  copyDiagnosticsBtn.addEventListener('click', () => copyValue(diagnosticsNode.textContent, 'MiniLM-only diagnostics'));
}

function transcriptQualityWarning(pastedText, file) {
  const text = String(pastedText || '').trim();
  const fileName = file && file.name ? String(file.name) : '';
  const lower = text.toLowerCase();
  if (text && text.length < 800) {
    return 'This transcript is very short, so the draft may be thin or misleading. Use a fuller transcript where possible.';
  }
  if (text && /(lorem ipsum|test transcript|sample transcript|placeholder|asdf|dummy data)/i.test(text)) {
    return 'This looks like test or placeholder input. Do not approve, share, or send the generated output as a real client report.';
  }
  if (text && !/[.!?]\s+[A-Z0-9]/.test(text) && text.length > 1200) {
    return 'This transcript has very little sentence structure. Check the source file/extraction before trusting the draft.';
  }
  if (!text && fileName && /test|sample|dummy|placeholder/i.test(fileName)) {
    return 'The selected file name looks like test or placeholder data. Do not treat the generated output as client-ready unless this is intentional.';
  }
  return '';
}

function minutesReviewIssues(reviewData) {
  const issues = [];
  const minutes = Array.isArray(reviewData?.meetingMinutes) ? reviewData.meetingMinutes : [];
  const nextSteps = Array.isArray(reviewData?.nextSteps) ? reviewData.nextSteps : [];
  const discussionPoints = minutes.flatMap((minute) => Array.isArray(minute.discussionPoints) ? minute.discussionPoints : []);
  if (!String(reviewData?.meetingTitle || '').trim()) issues.push('Meeting title is blank.');
  if (!String(reviewData?.meetingDate || '').trim()) issues.push('Meeting date is blank.');
  if (!discussionPoints.some((point) => String(point || '').trim())) issues.push('No discussion points are recorded.');
  const ownerlessActions = nextSteps.filter((item) => String(item?.action || '').trim() && (!String(item?.owner || '').trim() || /owner not specified/i.test(String(item?.owner || ''))));
  if (ownerlessActions.length) issues.push(`${ownerlessActions.length} action${ownerlessActions.length === 1 ? '' : 's'} missing a named owner.`);
  return issues;
}
