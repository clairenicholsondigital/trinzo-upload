// Setup stage: structured project state used before/around processing
// transcripts — milestones and monitored risks. Searchable background knowledge
// lives in the Memory stage.
(function () {
  const PW = window.ProjectWorkspace;
  const { escapeHtml, friendlyLabel, displayDate, dateValue, renderColour, asArray } = PW;

  function mount(container, ctx) {
    const projectId = ctx.projectId;
    container.innerHTML = `
      <section class="panel">
        <h1>Setup</h1>
        <p class="intro">Set the baseline this project should be measured against before processing update transcripts.</p>
        <div class="empty-state">
          <strong>Before the first report</strong>
          <ol>
            <li>Add the agreed milestones or delivery workstreams.</li>
            <li>Add the standing risks you want monitored in future updates.</li>
            <li>Add background docs, decisions and notes in Memory if Ask should retrieve them later.</li>
            <li>Process the first transcript, review the draft, then approve only when it is good enough to become future project memory.</li>
          </ol>
        </div>
      </section>
      <section class="panel">
        <h2>Milestones</h2>
        <p class="intro" id="milestoneCount">Loading milestones…</p>
        <details style="margin:.5rem 0 1rem">
          <summary>Add a milestone</summary>
          <form id="milestoneForm" class="form-grid" style="margin-top:.75rem">
            <label class="wide">Milestone <input name="milestoneName" type="text" required placeholder="Milestone name" /></label>
            <label>Period <input name="periodLabel" type="text" placeholder="Q2 2026" /></label>
            <label>Category <input name="category" type="text" value="Manual" /></label>
            <label class="full">Description <textarea name="description" placeholder="Milestone description"></textarea></label>
            <label>Baseline deadline <input name="baselineFinishDate" type="date" /></label>
            <label>Forecast deadline <input name="forecastFinishDate" type="date" /></label>
            <button class="primary" type="submit">Create milestone</button>
          </form>
          <p id="milestoneFormStatus" class="status"></p>
        </details>
        <div class="bulk-actions">
          <p id="bulkMilestoneStatus" class="status">Select milestones to enable bulk actions.</p>
          <button id="bulkInactivateMilestonesBtn" class="danger" type="button" disabled>Inactivate selected</button>
        </div>
        <div id="milestoneList" class="table-scroll"><table><tbody><tr><td>Loading…</td></tr></tbody></table></div>
      </section>
      <section class="panel">
        <h2>Monitored risks</h2>
        <p class="intro">These are standing risks you want each project update to keep checking. They are structured project setup, not searchable memory items.</p>
        <div id="riskList" class="table-scroll"><table><tbody><tr><td>Loading monitored risks…</td></tr></tbody></table></div>
        <details style="margin-top:.75rem">
          <summary>Add monitored risk</summary>
          <div class="form-grid" style="margin-top:.75rem">
            <label class="wide">Risk title <input id="newRiskTitle" placeholder="e.g. Supplier decision delayed" /></label>
            <label>Category <input id="newRiskCategory" placeholder="Delivery" /></label>
            <label class="full">Description <textarea id="newRiskDescription" placeholder="What could affect delivery?"></textarea></label>
            <label class="full">Mitigation <textarea id="newRiskMitigation" placeholder="How should the team keep this under control?"></textarea></label>
          </div>
          <div class="actions" style="margin-top:.75rem"><button id="addRiskBtn" type="button" class="primary">Add risk</button></div>
        </details>
        <p id="riskStatus" class="status"></p>
      </section>
    `;

    setupMilestones(container, ctx, projectId);
    setupRisks(container, ctx, projectId);
  }

  // ---- Milestones -----------------------------------------------------------

  function setupMilestones(container, ctx, projectId) {
    const listNode = container.querySelector('#milestoneList');
    const countNode = container.querySelector('#milestoneCount');
    const form = container.querySelector('#milestoneForm');
    const formStatus = container.querySelector('#milestoneFormStatus');

    async function loadMilestones() {
      try {
        const payload = await PW.request(`milestones?projectId=${encodeURIComponent(projectId)}`);
        renderMilestones(asArray(payload.milestones));
      } catch (error) {
        listNode.innerHTML = `<table><tbody><tr><td class="status error">${escapeHtml(error.message || 'Could not load milestones.')}</td></tr></tbody></table>`;
      }
    }

    function renderMilestones(milestones) {
      countNode.textContent = milestones.length
        ? `${milestones.length} active milestone${milestones.length === 1 ? '' : 's'} for this project.`
        : 'No milestones yet. Add the delivery workstreams this project update should track.';
      listNode.innerHTML = `
        <table>
          <thead><tr><th class="select-cell"><input id="selectAllMilestones" type="checkbox" aria-label="Select all milestones" /></th><th>Milestone</th><th>Period</th><th>Baseline</th><th>Forecast</th><th>Latest status</th><th>Trend</th></tr></thead>
          <tbody>
            ${milestones.map((milestone) => {
              const latest = milestone.latestAssessment || {};
              const name = friendlyLabel(milestone.milestoneName);
              return `
                <tr>
                  <td class="select-cell"><input type="checkbox" data-milestone-select="${escapeHtml(milestone.milestoneId)}" data-milestone-name="${escapeHtml(name)}" aria-label="Select ${escapeHtml(name)}" /></td>
                  <td><a href="/project-update-test/milestones/${escapeHtml(milestone.milestoneId)}">${escapeHtml(name)}</a></td>
                  <td>${escapeHtml(milestone.periodLabel || '-')}</td>
                  <td>${escapeHtml(displayDate(milestone.baselineFinishDate))}</td>
                  <td>${escapeHtml(displayDate(milestone.forecastFinishDate || latest.forecastFinishDate))}</td>
                  <td>${escapeHtml(friendlyLabel(latest.status))}</td>
                  <td>${escapeHtml(friendlyLabel(latest.trend))}</td>
                </tr>
              `;
            }).join('') || '<tr><td colspan="7"><strong>No milestones yet.</strong><br />Add at least one milestone before processing the first transcript so the report has a project baseline.</td></tr>'}
          </tbody>
        </table>
      `;
      wireBulkActions();
    }

    function wireBulkActions() {
      const bulkStatus = container.querySelector('#bulkMilestoneStatus');
      const bulkButton = container.querySelector('#bulkInactivateMilestonesBtn');
      const selectAll = container.querySelector('#selectAllMilestones');
      const checkboxes = Array.from(container.querySelectorAll('[data-milestone-select]'));
      function selected() {
        return checkboxes.filter((c) => c.checked).map((c) => ({ id: c.getAttribute('data-milestone-select'), name: c.getAttribute('data-milestone-name') || 'Milestone' }));
      }
      function update() {
        const chosen = selected();
        bulkButton.disabled = chosen.length === 0;
        bulkStatus.textContent = chosen.length ? `${chosen.length} milestone${chosen.length === 1 ? '' : 's'} selected.` : 'Select milestones to enable bulk actions.';
        if (selectAll) {
          selectAll.checked = checkboxes.length > 0 && chosen.length === checkboxes.length;
          selectAll.indeterminate = chosen.length > 0 && chosen.length < checkboxes.length;
        }
      }
      if (selectAll) selectAll.addEventListener('change', () => { checkboxes.forEach((c) => { c.checked = selectAll.checked; }); update(); });
      checkboxes.forEach((c) => c.addEventListener('change', update));
      bulkButton.addEventListener('click', async () => {
        const chosen = selected();
        if (!chosen.length) return;
        const preview = chosen.slice(0, 8).map((m) => `• ${m.name}`).join('\n');
        const suffix = chosen.length > 8 ? `\n…and ${chosen.length - 8} more.` : '';
        if (!window.confirm(`Inactivate ${chosen.length} selected milestone${chosen.length === 1 ? '' : 's'}? They will be hidden from active lists but history is preserved.\n\n${preview}${suffix}`)) return;
        bulkButton.disabled = true;
        try {
          await PW.request('milestones/bulk-inactivate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ milestoneIds: chosen.map((m) => m.id) })
          });
          await loadMilestones();
          if (ctx.reloadProject) ctx.reloadProject();
        } catch (error) {
          window.alert(error.message || 'Could not inactivate selected milestones.');
          update();
        }
      });
      update();
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = form.querySelector('button[type="submit"]');
      const payload = Object.fromEntries(new FormData(form).entries());
      // Scope explicitly to the selected project (id preferred, name as belt-and-braces).
      payload.projectId = projectId;
      payload.projectName = ctx.project.projectName || '';
      formStatus.className = 'status';
      formStatus.textContent = 'Creating milestone…';
      button.disabled = true;
      try {
        const result = await PW.request('milestones', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        formStatus.className = 'status success';
        formStatus.textContent = result.milestone && result.milestone.created ? 'Milestone created.' : 'Existing milestone updated.';
        form.reset();
        await loadMilestones();
        if (ctx.reloadProject) ctx.reloadProject();
      } catch (error) {
        formStatus.className = 'status error';
        formStatus.textContent = error.message || 'Could not create milestone.';
      } finally {
        button.disabled = false;
      }
    });

    loadMilestones();
  }

  // ---- Monitored risks -------------------------------------------------------

  function riskInput(value) {
    return escapeHtml(value || '');
  }

  function riskPayload(row) {
    const payload = {};
    row.querySelectorAll('[data-risk-field]').forEach((field) => {
      payload[field.getAttribute('data-risk-field')] = field.value.trim();
    });
    return payload;
  }

  function setupRisks(container, ctx, projectId) {
    const listNode = container.querySelector('#riskList');
    const statusNode = container.querySelector('#riskStatus');
    const addButton = container.querySelector('#addRiskBtn');

    function setStatus(message, kind = '') {
      statusNode.className = kind ? `status ${kind}` : 'status';
      statusNode.textContent = message;
    }

    async function loadRisks() {
      try {
        const payload = await PW.request(`context?projectId=${encodeURIComponent(projectId)}&limit=8`);
        const risks = asArray(payload.context && payload.context.activeRisks);
        listNode.innerHTML = `
          <table class="profile-editor-table profile-risk-table">
            <thead><tr><th>Risk</th><th>Category</th><th>Description</th><th>Mitigation</th><th>Actions</th></tr></thead>
            <tbody>
              ${risks.map((risk) => `
                <tr data-risk-id="${escapeHtml(risk.riskId)}">
                  <td><textarea class="profile-title-field" data-risk-field="riskTitle">${riskInput(risk.riskTitle)}</textarea></td>
                  <td><input data-risk-field="category" value="${riskInput(risk.category || 'General')}" /></td>
                  <td><textarea data-risk-field="description">${riskInput(risk.description || '')}</textarea></td>
                  <td><textarea data-risk-field="mitigation">${riskInput(risk.mitigation || '')}</textarea></td>
                  <td class="actions"><button type="button" data-save-risk>Save</button><button type="button" class="danger" data-delete-risk>Remove</button></td>
                </tr>
              `).join('') || '<tr><td colspan="5"><strong>No monitored risks yet.</strong><br />Add standing risks here so fresh-project Ask and future reports know what to watch.</td></tr>'}
            </tbody>
          </table>
        `;
        wireRiskRows();
      } catch (error) {
        listNode.innerHTML = `<table><tbody><tr><td class="status error">${escapeHtml(error.message || 'Could not load monitored risks.')}</td></tr></tbody></table>`;
      }
    }

    function wireRiskRows() {
      listNode.querySelectorAll('[data-save-risk]').forEach((button) => {
        button.addEventListener('click', async () => {
          const row = button.closest('[data-risk-id]');
          if (!row) return;
          button.disabled = true;
          setStatus('Saving monitored risk…');
          try {
            await PW.request(`risks/${encodeURIComponent(row.getAttribute('data-risk-id'))}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(riskPayload(row))
            });
            setStatus('Monitored risk saved.', 'success');
            if (ctx.reloadProject) ctx.reloadProject();
          } catch (error) {
            setStatus(error.message || 'Could not save monitored risk.', 'error');
          } finally {
            button.disabled = false;
          }
        });
      });
      listNode.querySelectorAll('[data-delete-risk]').forEach((button) => {
        button.addEventListener('click', async () => {
          const row = button.closest('[data-risk-id]');
          if (!row) return;
          const name = row.querySelector('[data-risk-field="riskTitle"]')?.value || 'this risk';
          if (!window.confirm(`Remove ${name} from monitored risks? Existing reports stay intact.`)) return;
          button.disabled = true;
          setStatus('Removing monitored risk…');
          try {
            await PW.request(`risks/${encodeURIComponent(row.getAttribute('data-risk-id'))}`, { method: 'DELETE' });
            setStatus('Monitored risk removed.', 'success');
            await loadRisks();
            if (ctx.reloadProject) ctx.reloadProject();
          } catch (error) {
            setStatus(error.message || 'Could not remove monitored risk.', 'error');
            button.disabled = false;
          }
        });
      });
    }

    addButton.addEventListener('click', async () => {
      const riskTitle = container.querySelector('#newRiskTitle').value.trim();
      if (!riskTitle) {
        setStatus('Risk title is required.', 'error');
        return;
      }
      addButton.disabled = true;
      setStatus('Adding monitored risk…');
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
        container.querySelector('#newRiskTitle').value = '';
        container.querySelector('#newRiskCategory').value = '';
        container.querySelector('#newRiskDescription').value = '';
        container.querySelector('#newRiskMitigation').value = '';
        setStatus('Monitored risk added.', 'success');
        await loadRisks();
        if (ctx.reloadProject) ctx.reloadProject();
      } catch (error) {
        setStatus(error.message || 'Could not add monitored risk.', 'error');
      } finally {
        addButton.disabled = false;
      }
    });

    loadRisks();
  }

  window.ProjectStages = window.ProjectStages || {};
  window.ProjectStages.setup = { mount };
}());
