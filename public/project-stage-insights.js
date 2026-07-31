// Insights stage: the project's analytics/memory hub. One GET /context?projectId=
// call powers health tiles, milestone assessments + trend, project health overview, risks,
// risk suggestions and recent reports; plus an "Ask this project" memory box.
// Lifted from the old Context page, now driven by the workspace's selected project.
(function () {
  const PW = window.ProjectWorkspace;
  const { escapeHtml, friendlyLabel, proseOrLabel, dateValue, dateOnly, displayDate, trendClass, asArray } = PW;

  function inputValue(value) {
    return escapeHtml(value || '');
  }

  function renderMilestoneProfileRows(milestones) {
    return milestones.map((milestone) => `
      <tr data-profile-milestone="${escapeHtml(milestone.milestoneId)}">
        <td><textarea class="profile-title-field" data-field="milestoneName">${inputValue(milestone.milestoneName)}</textarea></td>
        <td><input data-field="category" value="${inputValue(milestone.category || 'Manual')}" /></td>
        <td><textarea data-field="description">${inputValue(milestone.description || '')}</textarea></td>
        <td><input data-field="baselineFinishDate" type="date" value="${inputValue(dateOnly(milestone.baselineFinishDate) === '-' ? '' : dateOnly(milestone.baselineFinishDate))}" /></td>
        <td><input data-field="forecastFinishDate" type="date" value="${inputValue(dateOnly(milestone.forecastFinishDate) === '-' ? '' : dateOnly(milestone.forecastFinishDate))}" /></td>
        <td><label class="monitor-checkbox" title="Monitor this milestone in future project updates"><input type="checkbox" data-monitor-profile checked aria-label="Monitor this milestone in future project updates" /></label></td>
        <td class="actions"><button type="button" class="subtle" data-expand-edit-row>Expand</button><button type="button" data-save-milestone>Save</button><button type="button" class="danger" data-delete-milestone>Delete</button></td>
      </tr>
    `).join('') || '<tr><td colspan="7"><strong>No profile milestones yet.</strong><br />Add milestones in Setup or from a reviewed report.</td></tr>';
  }

  function renderRiskProfileRows(risks) {
    return risks.map((risk) => `
      <tr data-profile-risk="${escapeHtml(risk.riskId)}">
        <td><textarea class="profile-title-field" data-field="riskTitle">${inputValue(risk.riskTitle)}</textarea></td>
        <td><input data-field="category" value="${inputValue(risk.category || 'General')}" /></td>
        <td><textarea data-field="description">${inputValue(risk.description || '')}</textarea></td>
        <td><textarea data-field="mitigation">${inputValue(risk.mitigation || '')}</textarea></td>
        <td><label class="monitor-checkbox" title="Monitor this risk in future project updates"><input type="checkbox" data-monitor-profile checked aria-label="Monitor this risk in future project updates" /></label></td>
        <td class="actions"><button type="button" class="subtle" data-expand-edit-row>Expand</button><button type="button" data-save-risk>Save</button><button type="button" class="danger" data-delete-risk>Delete</button></td>
      </tr>
    `).join('') || '<tr><td colspan="6"><strong>No configured risks yet.</strong><br />Add a core project risk below so future updates can track it.</td></tr>';
  }

  function renderSuggestedRiskRows(risks) {
    return risks.map((risk) => `
      <tr data-suggested-risk="${escapeHtml(risk.riskSuggestionId || '')}">
        <td><textarea class="profile-title-field" data-field="riskTitle">${inputValue(risk.riskTitle || '')}</textarea></td>
        <td><input data-field="category" value="${inputValue(risk.category || 'Follow-up risk')}" /></td>
        <td><textarea data-field="description">${inputValue(risk.description || '')}</textarea></td>
        <td><textarea data-field="mitigation">${inputValue(risk.suggestedMitigation || risk.mitigation || '')}</textarea></td>
        <td><a href="/project-update-test/reports/${escapeHtml(risk.reportId)}">Report ${escapeHtml(risk.reportId)}</a><br /><span class="muted">${escapeHtml(friendlyLabel(risk.reviewStatus))}${risk.confidence ? ` · ${escapeHtml(risk.confidence)} confidence` : ''}</span></td>
        <td class="actions suggested-risk-actions"><button type="button" class="subtle" data-expand-edit-row>Expand</button><button type="button" data-add-suggested-risk>Add to monitored risks</button></td>
      </tr>
    `).join('') || '<tr><td colspan="6"><strong>No suggested follow-up risks yet.</strong><br />New risks found in draft reports will appear here for review.</td></tr>';
  }

  function renderProjectSettings(project) {
    return `
      <section class="panel project-settings-panel">
        <h2>Project settings</h2>
        <p class="intro">Global details for this project workspace. Keep these here so the update meeting flow stays focused.</p>
        <div class="form-grid">
          <label class="wide">Project name <input id="settingsProjectName" type="text" value="${inputValue(project.projectName || '')}" /></label>
          <label>Client <input id="settingsProjectClient" type="text" value="${inputValue(project.clientName || '')}" /></label>
          <label>Status
            <select id="settingsProjectStatus">
              ${['active', 'paused', 'completed', 'archived'].map((option) => `<option value="${option}" ${option === (project.status || 'active') ? 'selected' : ''}>${option.charAt(0).toUpperCase() + option.slice(1)}</option>`).join('')}
            </select>
          </label>
          <label class="full">Description <textarea id="settingsProjectDescription">${inputValue(project.description || '')}</textarea></label>
        </div>
        <div class="actions" style="margin-top:.75rem">
          <button id="saveProjectSettingsBtn" class="primary" type="button">Save project settings</button>
        </div>
        <details class="danger-zone" style="margin-top:1rem">
          <summary>Danger zone</summary>
          <p class="muted">Only use this if the whole project workspace was created by mistake.</p>
          <button id="deleteProjectBtn" class="danger" type="button">Delete project workspace</button>
        </details>
        <p id="projectSettingsStatus" class="status"></p>
      </section>
    `;
  }

  function renderSupportActions(context) {
    const slot = document.getElementById('stageSupportActions');
    if (!slot) return;
    slot.innerHTML = `
      <div class="support-action-row">
        <span class="support-action-label">Project profile options</span>
        <button id="createSnapshotBtn" type="button" title="Save a point-in-time copy of the current project profile." ${context.found ? '' : 'disabled'}>Save snapshot</button>
        <button id="markOfficialBtn" type="button" title="Use the current milestones and risks as the agreed baseline." ${context.found ? '' : 'disabled'}>Approve baseline</button>
        <button id="exportProjectOverviewBtn" type="button" title="Download a Markdown overview of this project profile." ${context.found ? '' : 'disabled'}>Export project overview</button>
        <button id="cleanupTestsBtn" type="button" title="Archive draft clutter while keeping approved items active." ${context.found ? '' : 'disabled'}>Tidy drafts</button>
      </div>
    `;
  }

  function fieldLabel(field) {
    const labels = {
      milestoneName: 'Milestone',
      riskTitle: 'Risk',
      category: 'Category',
      description: 'Description',
      mitigation: 'Mitigation',
      baselineFinishDate: 'Baseline date',
      forecastFinishDate: 'Forecast date'
    };
    return labels[field] || friendlyLabel(field);
  }

  function openRowEditModal(row) {
    if (!row) return;
    const fields = Array.from(row.querySelectorAll('[data-field]'));
    if (!fields.length) return;
    const existing = document.querySelector('[data-row-edit-modal]');
    if (existing) existing.remove();
    const title = fields[0]?.value || 'Edit row';
    const modal = document.createElement('div');
    modal.className = 'row-edit-modal-backdrop';
    modal.setAttribute('data-row-edit-modal', 'true');
    modal.innerHTML = `
      <div class="row-edit-modal" role="dialog" aria-modal="true" aria-label="Expanded row editor">
        <div class="row-edit-modal-head">
          <div><strong>Edit row</strong><p class="muted">${escapeHtml(title)}</p></div>
          <button type="button" class="subtle" data-close-row-modal>Close</button>
        </div>
        <div class="row-edit-modal-fields">
          ${fields.map((field, index) => {
            const key = field.getAttribute('data-field');
            const type = field.getAttribute('type') === 'date' ? 'date' : 'text';
            const value = escapeHtml(field.value || '');
            if (field.tagName.toLowerCase() === 'input' && type === 'date') {
              return `<label>${escapeHtml(fieldLabel(key))}<input data-modal-field-index="${index}" type="date" value="${value}" /></label>`;
            }
            return `<label>${escapeHtml(fieldLabel(key))}<textarea data-modal-field-index="${index}">${value}</textarea></label>`;
          }).join('')}
        </div>
        <div class="row-edit-modal-actions"><button type="button" class="primary" data-apply-row-modal>Apply to row</button></div>
      </div>`;
    document.body.appendChild(modal);
    const close = () => modal.remove();
    modal.querySelector('[data-close-row-modal]').addEventListener('click', close);
    modal.addEventListener('click', (event) => { if (event.target === modal) close(); });
    modal.querySelector('[data-apply-row-modal]').addEventListener('click', () => {
      modal.querySelectorAll('[data-modal-field-index]').forEach((editor) => {
        const field = fields[Number(editor.getAttribute('data-modal-field-index'))];
        if (!field) return;
        field.value = editor.value;
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
      });
      close();
    });
    const firstField = modal.querySelector('[data-modal-field-index]');
    if (firstField) firstField.focus();
  }

  function mount(container, ctx) {
    const projectId = ctx.projectId;
    container.innerHTML = '<section class="panel"><h1>Insights</h1><p class="intro">Loading project status, report history and memory…</p></section>';

    PW.request(`context?projectId=${encodeURIComponent(projectId)}&limit=8`)
      .then((payload) => render(container, ctx, payload.context || {}))
      .catch((error) => {
        container.innerHTML = `<section class="panel"><h1>Insights</h1><p class="status error">${escapeHtml(error.message || 'Could not load project analytics.')}</p></section>`;
      });
  }

  function render(container, ctx, context) {
    const projectId = ctx.projectId;
    const milestones = asArray(context.activeMilestones);
    const recentReports = asArray(context.recentReports);
    const healthHistory = asArray(context.healthHistory);
    const activeRisks = asArray(context.activeRisks);
    const riskSuggestions = asArray(context.riskSuggestions);
    const latestReport = recentReports[0] || {};

    container.innerHTML = `
      <section class="panel insights-header-panel">
        <div class="section-title-row">
          <div>
            <h1>Insights</h1>
            <p class="intro">Current project position, profile and recent reports.</p>
          </div>
        </div>
        <p id="contextStatus" class="status"></p>
        ${context.found ? '' : '<p class="status">No project history yet. Add Setup context, then create and approve the first draft report.</p>'}
      </section>
      <section class="panel">
        <h2>At a glance</h2>
        <div class="at-glance-strip" aria-label="Project summary">
          <div class="glance-primary">
            <span class="label">Overall position</span>
            <strong>${escapeHtml(proseOrLabel(latestReport.overallHealth || latestReport.overallHealthRag))}</strong>
          </div>
          <div class="glance-metrics">
            <span><strong>${milestones.length}</strong> monitored milestone${milestones.length === 1 ? '' : 's'}</span>
            <span><strong>${activeRisks.length}</strong> monitored risk${activeRisks.length === 1 ? '' : 's'}</span>
            <span><strong>${recentReports.length}</strong> saved report${recentReports.length === 1 ? '' : 's'}</span>
            <span>${context.latestSnapshot ? `<a href="/project-update-test/context/snapshots/${escapeHtml(context.latestSnapshot.snapshotId)}">Latest snapshot ${escapeHtml(context.latestSnapshot.snapshotId)}</a>` : 'No snapshot yet'}</span>
          </div>
        </div>
      </section>
      <section class="panel">
        <h2>Project profile / baseline</h2>
        <p class="intro">This is the ongoing project state future reports compare against. Edit milestones and configured risks here; reports are snapshots against this profile.</p>
      </section>
      ${renderProjectSettings(ctx.project || {})}
      <section class="panel">
        <h2>Project health overview</h2>
        <p class="intro">Latest saved-report view of each health area, with the trend and rationale behind it.</p>
        <div class="table-scroll"><table><thead><tr><th>Area</th><th>Status</th><th>Trend</th><th>Confidence</th><th>Report</th><th>Rationale</th></tr></thead><tbody>
          ${healthHistory.map((item) => `<tr><td>${escapeHtml(friendlyLabel(item.area))}</td><td>${escapeHtml(friendlyLabel(item.status))}</td><td class="${escapeHtml(trendClass(item.trend))}">${escapeHtml(friendlyLabel(item.trend))}</td><td>${escapeHtml(item.confidence || '-')}</td><td><a href="/project-update-test/reports/${escapeHtml(item.reportId)}">Report ${escapeHtml(item.reportId)}</a></td><td>${escapeHtml(item.rationale || '-')}</td></tr>`).join('') || '<tr><td colspan="6"><strong>No project health overview yet.</strong><br />Approved reports will build a timeline here.</td></tr>'}
        </tbody></table></div>
      </section>
      <section class="panel">
        <h2>Profile milestones</h2>
        <div class="table-scroll profile-editor-scroll"><table class="profile-editor-table"><thead><tr><th>Milestone</th><th>Category</th><th>Description</th><th>Baseline</th><th>Forecast</th><th>Monitor?</th><th>Actions</th></tr></thead><tbody id="profileMilestonesBody">
          ${renderMilestoneProfileRows(milestones)}
        </tbody></table></div>
      </section>
      <section class="panel">
        <h2>Configured risks</h2>
        <p class="intro">These are standing project risks, not one-off AI suggestions. Keep them current as part of the project profile.</p>
        <div class="table-scroll profile-editor-scroll"><table class="profile-editor-table"><thead><tr><th>Risk</th><th>Category</th><th>Description</th><th>Mitigation</th><th>Monitor?</th><th>Actions</th></tr></thead><tbody id="profileRisksBody">
          ${renderRiskProfileRows(activeRisks)}
        </tbody></table></div>
        <details style="margin-top:.75rem">
          <summary>Add configured risk</summary>
          <div class="form-grid" style="margin-top:.75rem">
            <label class="wide">Risk title <input id="newRiskTitle" placeholder="e.g. Wrong project context used" /></label>
            <label>Category <input id="newRiskCategory" placeholder="Context" /></label>
            <label class="full">Description <textarea id="newRiskDescription"></textarea></label>
            <label class="full">Mitigation <textarea id="newRiskMitigation"></textarea></label>
          </div>
          <div class="actions" style="margin-top:.75rem"><button id="addProfileRiskBtn" type="button" class="primary">Add risk</button></div>
        </details>
      </section>
      <section class="panel">
        <h2>Milestone progress</h2>
        <p class="intro">Read-only view of the latest progress against the monitored milestones. Use this to see what is complete, what still needs checking, and what should be covered in the next update.</p>
        <div class="table-scroll"><table><thead><tr><th>Milestone</th><th>Latest status</th><th>Previous status</th><th>Trend</th><th>Forecast</th><th>Monitor?</th><th>Summary</th></tr></thead><tbody>
          ${milestones.map((milestone) => {
            const latest = milestone.latestAssessment || {};
            const previous = milestone.previousAssessment || {};
            return `<tr><td>${escapeHtml(friendlyLabel(milestone.milestoneName))}</td><td>${escapeHtml(friendlyLabel(latest.status))}</td><td>${escapeHtml(friendlyLabel(previous.status))}</td><td class="${escapeHtml(trendClass(latest.trend))}">${escapeHtml(friendlyLabel(latest.trend))}</td><td>${escapeHtml(displayDate(latest.forecastFinishDate || milestone.forecastFinishDate))}</td><td><span class="monitor-indicator" title="Monitored in this project">✓</span></td><td>${escapeHtml(latest.summary || '-')}</td></tr>`;
          }).join('') || '<tr><td colspan="7"><strong>No active milestones yet.</strong><br />Add milestones in Setup so future reports can track delivery against a baseline.</td></tr>'}
        </tbody></table></div>
      </section>
      <section class="panel">
        <h2>Suggested follow-up risks</h2>
        <p class="intro">These are risks suggested from saved reports. Edit the wording here, then add the useful ones to the monitored project profile above.</p>
        <div class="table-scroll profile-editor-scroll"><table class="profile-editor-table suggested-risk-table"><thead><tr><th>Risk</th><th>Category</th><th>Description</th><th>Mitigation</th><th>Source</th><th>Actions</th></tr></thead><tbody>
          ${renderSuggestedRiskRows(riskSuggestions)}
        </tbody></table></div>
      </section>
      <section class="panel">
        <h2>Recent reports</h2>
        <p class="intro">Open a saved report to review or edit the full project update.</p>
        <div class="table-scroll"><table><thead><tr><th>Report</th><th>Period</th><th>Status</th><th>Overall health</th><th>Created</th><th>Summary</th><th>Actions</th></tr></thead><tbody>
          ${recentReports.map((report) => `<tr><td><strong>Report ${escapeHtml(report.reportId)}</strong></td><td>${escapeHtml(report.periodLabel || '-')}</td><td>${escapeHtml(friendlyLabel(report.reportStatus))}</td><td>${escapeHtml(proseOrLabel(report.overallHealth || report.overallHealthRag))}</td><td>${escapeHtml(dateValue(report.versionCreatedAt || report.createdAt))}</td><td>${escapeHtml(report.summary || '-')}</td><td><a class="button-link" href="/project-update-test/reports/${escapeHtml(report.reportId)}">Open report</a></td></tr>`).join('') || '<tr><td colspan="7"><strong>No reports yet.</strong><br />Process a transcript, review the draft, then approve it when it is ready to become project memory.</td></tr>'}
        </tbody></table></div>
      </section>
      <section class="panel ask-panel">
        <h2>Ask this project</h2>
        <div class="ask-layout">
          <div>
            <p class="intro">Ask stored project memory before a report, review, or client call. If generation is unavailable, the matching memory snippets still appear.</p>
            <label>Question <textarea id="knowledgeAskQuestion" placeholder="What risks, decisions, or constraints should I remember before the next update?"></textarea></label>
            <div class="actions" style="margin-top:.75rem">
              <button id="askKnowledgeBtn" class="primary" type="button">Ask project memory</button>
            </div>
            <p id="knowledgeAskStatus" class="status"></p>
          </div>
          <aside class="ask-help">
            <strong>Good questions</strong>
            <ul>
              <li>What risks should we watch this week?</li>
              <li>What decisions have already been made?</li>
              <li>What constraints from the SoW matter here?</li>
            </ul>
          </aside>
        </div>
        <div id="knowledgeAskResult" class="empty-state">Ask a question to retrieve relevant project memory.</div>
      </section>
    `;

    renderSupportActions(context);
    wireProfileEditors(container, ctx, projectId);
    wireProjectSettings(container, ctx, projectId);
    wireActions(container, ctx, projectId);
    wireAsk(container, projectId);
  }

  function wireProjectSettings(container, ctx, projectId) {
    const saveBtn = container.querySelector('#saveProjectSettingsBtn');
    const deleteBtn = container.querySelector('#deleteProjectBtn');
    const statusMsg = container.querySelector('#projectSettingsStatus');
    if (!saveBtn || !statusMsg) return;

    saveBtn.addEventListener('click', async () => {
      const projectName = container.querySelector('#settingsProjectName').value.trim();
      if (!projectName) {
        statusMsg.className = 'status error';
        statusMsg.textContent = 'Project name is required.';
        return;
      }
      saveBtn.disabled = true;
      statusMsg.className = 'status';
      statusMsg.textContent = 'Saving project settings…';
      try {
        await PW.request(`projects/${encodeURIComponent(projectId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectName,
            clientName: container.querySelector('#settingsProjectClient').value.trim(),
            status: container.querySelector('#settingsProjectStatus').value,
            description: container.querySelector('#settingsProjectDescription').value.trim()
          })
        });
        await PW.loadProjects();
        const fresh = PW.getProject(projectId);
        if (fresh && ctx.project) Object.assign(ctx.project, fresh);
        if (ctx.reloadProject) await ctx.reloadProject();
        statusMsg.className = 'status success';
        statusMsg.textContent = 'Project settings saved.';
      } catch (error) {
        statusMsg.className = 'status error';
        statusMsg.textContent = error.message || 'Could not save project settings.';
      } finally {
        saveBtn.disabled = false;
      }
    });

    if (deleteBtn) {
      deleteBtn.addEventListener('click', async () => {
        const project = ctx.project || {};
        const summary = `${project.projectName || 'this project'} (${project.reportCount || 0} reports, ${project.activeMilestoneCount || 0} milestones)`;
        if (!window.confirm(`Delete ${summary}? This also deletes this project's saved reports, milestones, risks, snapshots and project memory.`)) return;
        deleteBtn.disabled = true;
        statusMsg.className = 'status';
        statusMsg.textContent = 'Deleting project workspace…';
        try {
          await PW.request(`projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' });
          PW.clearSelectedProject();
          window.location.href = '/project-update-test';
        } catch (error) {
          statusMsg.className = 'status error';
          statusMsg.textContent = error.message || 'Could not delete project.';
          deleteBtn.disabled = false;
        }
      });
    }
  }

  function rowPayload(row) {
    const payload = {};
    row.querySelectorAll('[data-field]').forEach((field) => {
      payload[field.getAttribute('data-field')] = field.value.trim();
    });
    return payload;
  }

  function setProfileStatus(container, message, kind = '') {
    const status = container.querySelector('#contextStatus');
    if (!status) return;
    status.className = kind ? `status ${kind}` : 'status';
    status.textContent = message;
  }

  async function removeFromMonitoring(container, ctx, kind, id, name) {
    const label = kind === 'milestone' ? 'milestone' : 'configured risk';
    const endpoint = kind === 'milestone' ? 'milestones' : 'risks';
    if (!window.confirm(`Remove ${name || `this ${label}`} from ongoing project monitoring? Existing reports stay intact, but it will no longer appear in the active project profile.`)) {
      return false;
    }
    setProfileStatus(container, `Removing ${label} from monitoring…`);
    await PW.request(`${endpoint}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    setProfileStatus(container, `${label.charAt(0).toUpperCase() + label.slice(1)} removed from monitoring. Reloading…`, 'success');
    if (ctx.reloadProject) ctx.reloadProject();
    window.setTimeout(() => mount(container, ctx), 500);
    return true;
  }

  function wireProfileEditors(container, ctx, projectId) {
    container.querySelectorAll('[data-expand-edit-row]').forEach((button) => {
      button.addEventListener('click', () => openRowEditModal(button.closest('tr')));
    });

    container.querySelectorAll('[data-save-milestone]').forEach((button) => {
      button.addEventListener('click', async () => {
        const row = button.closest('[data-profile-milestone]');
        if (!row) return;
        const monitorBox = row.querySelector('[data-monitor-profile]');
        const name = row.querySelector('[data-field="milestoneName"]')?.value || 'this milestone';
        button.disabled = true;
        setProfileStatus(container, 'Saving milestone profile…');
        try {
          if (monitorBox && !monitorBox.checked) {
            const removed = await removeFromMonitoring(container, ctx, 'milestone', row.getAttribute('data-profile-milestone'), name);
            if (!removed) button.disabled = false;
            return;
          }
          await PW.request(`milestones/${encodeURIComponent(row.getAttribute('data-profile-milestone'))}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(rowPayload(row))
          });
          setProfileStatus(container, 'Milestone profile saved. Reloading…', 'success');
          if (ctx.reloadProject) ctx.reloadProject();
          window.setTimeout(() => mount(container, ctx), 500);
        } catch (error) {
          setProfileStatus(container, error.message || 'Could not save milestone.', 'error');
          button.disabled = false;
        }
      });
    });

    container.querySelectorAll('[data-delete-milestone]').forEach((button) => {
      button.addEventListener('click', async () => {
        const row = button.closest('[data-profile-milestone]');
        if (!row) return;
        const name = row.querySelector('[data-field="milestoneName"]')?.value || 'this milestone';
        button.disabled = true;
        try {
          const removed = await removeFromMonitoring(container, ctx, 'milestone', row.getAttribute('data-profile-milestone'), name);
          if (!removed) button.disabled = false;
        } catch (error) {
          setProfileStatus(container, error.message || 'Could not delete milestone from monitoring.', 'error');
          button.disabled = false;
        }
      });
    });

    container.querySelectorAll('[data-save-risk]').forEach((button) => {
      button.addEventListener('click', async () => {
        const row = button.closest('[data-profile-risk]');
        if (!row) return;
        const monitorBox = row.querySelector('[data-monitor-profile]');
        const name = row.querySelector('[data-field="riskTitle"]')?.value || 'this risk';
        button.disabled = true;
        setProfileStatus(container, 'Saving configured risk…');
        try {
          if (monitorBox && !monitorBox.checked) {
            const removed = await removeFromMonitoring(container, ctx, 'risk', row.getAttribute('data-profile-risk'), name);
            if (!removed) button.disabled = false;
            return;
          }
          await PW.request(`risks/${encodeURIComponent(row.getAttribute('data-profile-risk'))}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(rowPayload(row))
          });
          setProfileStatus(container, 'Configured risk saved. Reloading…', 'success');
          if (ctx.reloadProject) ctx.reloadProject();
          window.setTimeout(() => mount(container, ctx), 500);
        } catch (error) {
          setProfileStatus(container, error.message || 'Could not save risk.', 'error');
          button.disabled = false;
        }
      });
    });

    container.querySelectorAll('[data-delete-risk]').forEach((button) => {
      button.addEventListener('click', async () => {
        const row = button.closest('[data-profile-risk]');
        if (!row) return;
        const name = row.querySelector('[data-field="riskTitle"]')?.value || 'this risk';
        button.disabled = true;
        try {
          const removed = await removeFromMonitoring(container, ctx, 'risk', row.getAttribute('data-profile-risk'), name);
          if (!removed) button.disabled = false;
        } catch (error) {
          setProfileStatus(container, error.message || 'Could not delete risk from monitoring.', 'error');
          button.disabled = false;
        }
      });
    });

    const addRiskBtn = container.querySelector('#addProfileRiskBtn');
    if (addRiskBtn) addRiskBtn.addEventListener('click', async () => {
      const riskTitle = container.querySelector('#newRiskTitle').value.trim();
      if (!riskTitle) {
        setProfileStatus(container, 'Risk title is required.', 'error');
        return;
      }
      addRiskBtn.disabled = true;
      setProfileStatus(container, 'Adding configured risk…');
      try {
        await PW.request('risks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId,
            riskTitle,
            category: container.querySelector('#newRiskCategory').value.trim(),
            description: container.querySelector('#newRiskDescription').value.trim(),
            mitigation: container.querySelector('#newRiskMitigation').value.trim()
          })
        });
        setProfileStatus(container, 'Configured risk added. Reloading…', 'success');
        if (ctx.reloadProject) ctx.reloadProject();
        window.setTimeout(() => mount(container, ctx), 500);
      } catch (error) {
        setProfileStatus(container, error.message || 'Could not add risk.', 'error');
        addRiskBtn.disabled = false;
      }
    });

    container.querySelectorAll('[data-add-suggested-risk]').forEach((button) => {
      button.addEventListener('click', async () => {
        const row = button.closest('[data-suggested-risk]');
        if (!row) return;
        const payload = rowPayload(row);
        if (!payload.riskTitle) {
          setProfileStatus(container, 'Add a risk title before adding it to the monitored profile.', 'error');
          return;
        }
        button.disabled = true;
        setProfileStatus(container, 'Adding suggested risk to monitored profile…');
        try {
          await PW.request('risks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectId, ...payload })
          });
          setProfileStatus(container, 'Suggested risk added to monitored risks. Reloading…', 'success');
          if (ctx.reloadProject) ctx.reloadProject();
          window.setTimeout(() => mount(container, ctx), 500);
        } catch (error) {
          setProfileStatus(container, error.message || 'Could not add suggested risk to monitoring.', 'error');
          button.disabled = false;
        }
      });
    });
  }

  function wireActions(container, ctx, projectId) {
    const status = container.querySelector('#contextStatus');
    const actionRoot = document.getElementById('stageSupportActions') || container;
    const snapshotBtn = actionRoot.querySelector('#createSnapshotBtn');
    const officialBtn = actionRoot.querySelector('#markOfficialBtn');
    const exportBtn = actionRoot.querySelector('#exportProjectOverviewBtn');
    const cleanupBtn = actionRoot.querySelector('#cleanupTestsBtn');

    if (exportBtn && typeof ctx.exportProjectOverview === 'function') {
      exportBtn.addEventListener('click', () => ctx.exportProjectOverview(ctx.project || {}, exportBtn));
    }

    if (snapshotBtn) snapshotBtn.addEventListener('click', async () => {
      snapshotBtn.disabled = true;
      status.className = 'status';
      status.textContent = 'Creating context snapshot…';
      try {
        const result = await PW.request('context/snapshots', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId })
        });
        status.className = 'status success';
        status.innerHTML = `Snapshot created: <a href="/project-update-test/context/snapshots/${escapeHtml(result.snapshot.snapshotId)}">Snapshot ${escapeHtml(result.snapshot.snapshotId)}</a>`;
      } catch (error) {
        status.className = 'status error';
        status.textContent = error.message || 'Could not create snapshot.';
      } finally {
        snapshotBtn.disabled = false;
      }
    });

    if (officialBtn) officialBtn.addEventListener('click', async () => {
      const officialLabel = window.prompt('Label for this agreed baseline?', 'Approved baseline');
      if (!officialLabel) return;
      officialBtn.disabled = true;
      status.className = 'status';
      status.textContent = 'Approving active milestones and risks as the baseline…';
      try {
        const result = await PW.request('context/mark-official', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId, officialLabel })
        });
        status.className = 'status success';
        status.textContent = `Approved baseline: ${result.result.officialMilestones} milestones, ${result.result.officialRisks} risks. Reloading…`;
        window.setTimeout(() => mount(container, ctx), 700);
      } catch (error) {
        status.className = 'status error';
        status.textContent = error.message || 'Could not approve the active baseline.';
        officialBtn.disabled = false;
      }
    });

    if (cleanupBtn) cleanupBtn.addEventListener('click', async () => {
      if (!window.confirm('Tidy draft workspace for this project? This archives draft reports, removes unapproved profile clutter, and keeps approved items active.')) return;
      cleanupBtn.disabled = true;
      status.className = 'status';
      status.textContent = 'Clearing draft clutter…';
      try {
        const result = await PW.request('context/cleanup-tests', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId })
        });
        status.className = 'status success';
        status.textContent = `Cleanup complete: archived ${result.result.archivedReports} reports and ${result.result.archivedKnowledgeItems || 0} knowledge items, deactivated ${result.result.deactivatedMilestones} milestones and ${result.result.deactivatedRisks} risks, removed ${result.result.deletedSnapshots} snapshots. Reloading…`;
        if (ctx.reloadProject) ctx.reloadProject();
        window.setTimeout(() => mount(container, ctx), 900);
      } catch (error) {
        status.className = 'status error';
        status.textContent = error.message || 'Could not clear draft clutter.';
        cleanupBtn.disabled = false;
      }
    });
  }

  function modeBadgeClass(value) {
    const mode = String(value || '').toLowerCase();
    if (['generated', 'semantic'].includes(mode)) return 'success';
    if (['retrieval_only', 'keyword_fallback'].includes(mode)) return 'warn';
    return 'muted';
  }

  function renderAskResult(result) {
    const chunks = asArray(result.retrievedChunks);
    const citations = asArray(result.citations);
    const answerMode = friendlyLabel(result.answerMode);
    const retrievalMode = friendlyLabel(result.retrievalMode);
    const citationHtml = citations.length
      ? `<div class="citation-list">${citations.map((citation) => `<span class="badge muted">chunk ${escapeHtml(citation.chunkId || citation.chunk_id || '-')}</span>`).join('')}</div>`
      : '';
    const answer = result.answer
      ? `<div class="ask-answer"><h3>Answer from project memory</h3><p>${escapeHtml(result.answer)}</p>${citationHtml}</div>`
      : result.answerMode === 'retrieval_only'
        ? '<div class="empty-state"><strong>Generation unavailable.</strong><br />Showing the most relevant project-memory snippets instead.</div>'
        : '';
    const chunksHtml = chunks.length
      ? `<h3 style="margin:.9rem 0 .2rem">Retrieved memory</h3><div class="chunk-grid">${chunks.map((chunk) => {
          const chunkId = chunk.chunk_id || chunk.chunkId || '-';
          const score = Number(chunk.score || 0);
          return `<article class="chunk-card"><strong>${escapeHtml(chunk.title || 'Project memory')}</strong><div class="chunk-meta"><span class="badge muted">chunk ${escapeHtml(chunkId)}</span><span class="badge muted">${escapeHtml(friendlyLabel(chunk.item_type || chunk.itemType))}</span>${score ? `<span class="badge muted">score ${escapeHtml(score.toFixed(2))}</span>` : ''}</div><div class="chunk-text">${escapeHtml((chunk.chunk_text || chunk.chunkText || '').slice(0, 700))}</div></article>`;
        }).join('')}</div>`
      : '<div class="empty-state"><strong>No matching project memory found.</strong><br />Try adding background notes, decisions, risks, or an SoW excerpt to Setup → Project memory first.</div>';
    return `<div class="badges"><span class="badge ${escapeHtml(modeBadgeClass(result.answerMode))}">Answer: ${escapeHtml(answerMode)}</span><span class="badge ${escapeHtml(modeBadgeClass(result.retrievalMode))}">Retrieval: ${escapeHtml(retrievalMode)}</span><span class="badge muted">${chunks.length} chunk${chunks.length === 1 ? '' : 's'}</span>${result.confidence ? `<span class="badge muted">Confidence: ${escapeHtml(friendlyLabel(result.confidence))}</span>` : ''}</div>${answer}${chunksHtml}`;
  }

  function wireAsk(container, projectId) {
    const button = container.querySelector('#askKnowledgeBtn');
    const status = container.querySelector('#knowledgeAskStatus');
    const resultBox = container.querySelector('#knowledgeAskResult');
    button.addEventListener('click', async () => {
      status.className = 'status';
      status.textContent = 'Asking project memory…';
      resultBox.className = 'empty-state';
      resultBox.innerHTML = 'Searching stored project memory…';
      button.disabled = true;
      try {
        const result = await PW.request('knowledge/ask', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId, question: container.querySelector('#knowledgeAskQuestion').value, topK: 8 })
        });
        status.className = result.answerMode === 'no_context' ? 'status' : 'status success';
        status.textContent = result.answerMode === 'generated'
          ? 'Generated from project memory.'
          : result.answerMode === 'retrieval_only'
            ? 'Showing retrieved memory snippets; generation was unavailable.'
            : 'No matching project memory found.';
        resultBox.className = '';
        resultBox.innerHTML = renderAskResult(result);
      } catch (error) {
        status.className = 'status error';
        status.textContent = error.message || 'Could not ask project memory.';
        resultBox.className = 'empty-state';
        resultBox.innerHTML = 'The project memory search could not complete. Check you are logged in, then try again.';
      } finally {
        button.disabled = false;
      }
    });
  }

  window.ProjectStages = window.ProjectStages || {};
  window.ProjectStages.insights = { mount };
}());
