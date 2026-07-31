// Settings stage: global project workspace details and destructive workspace
// actions, kept separate from the status/profile view.
(function () {
  const PW = window.ProjectWorkspace;
  const { escapeHtml } = PW;

  function inputValue(value) {
    return escapeHtml(value || '');
  }

  function renderProjectSettings(project, renderStageTabs) {
    return `
      <section class="panel project-settings-panel">
        <h1>Project settings</h1>
        <p class="intro">Global details for this project workspace. Keep status review, milestones, risks and reports on the project status page.</p>
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
      ${typeof renderStageTabs === 'function' ? renderStageTabs('settings') : ''}
    `;
  }

  function mount(container, ctx) {
    const projectId = ctx.projectId;
    container.innerHTML = renderProjectSettings(ctx.project || {}, ctx.renderStageTabs);
    wireProjectSettings(container, ctx, projectId);
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
      statusMsg.textContent = 'Saving project settings...';
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
        statusMsg.textContent = 'Deleting project workspace...';
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

  window.ProjectStages = window.ProjectStages || {};
  window.ProjectStages.settings = { mount };
}());
