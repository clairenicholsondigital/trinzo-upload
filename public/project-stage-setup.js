// Setup stage: everything you configure ON a project before/around processing
// transcripts — milestones and standing knowledge/context. Both are scoped to
// the selected project. Lifted from the old milestones + context pages.
(function () {
  const PW = window.ProjectWorkspace;
  const { escapeHtml, friendlyLabel, dateOnly, dateValue, renderColour, asArray } = PW;

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
            <li>Add standing context such as SoW constraints, decisions, known risks, or client preferences.</li>
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
        <h2>Project memory</h2>
        <p class="intro">Store background that should guide future reports. This is retrieved as project memory; transcript evidence still has to come from the update transcript itself.</p>
        <div class="grid">
          <label>Title <input id="knowledgeTitle" type="text" placeholder="Statement of work / background note" /></label>
          <label>Type <select id="knowledgeType"><option value="background_doc">Background doc</option><option value="decision">Decision</option><option value="note">Note</option><option value="risk">Risk</option></select></label>
        </div>
        <label style="margin-top:.75rem">Content <textarea id="knowledgeContent" placeholder="Paste project background here..."></textarea></label>
        <div class="actions" style="margin-top:.75rem">
          <button id="saveKnowledgeBtn" class="primary" type="button">Save to project memory</button>
        </div>
        <details style="margin-top:.75rem">
          <summary>Memory search maintenance</summary>
          <p class="muted"><strong>What this does:</strong> project memory is turned into searchable chunks so “Ask this project” can find the right background later. This usually happens automatically after you save memory.</p>
          <p class="muted"><strong>When to use it:</strong> only refresh if you have just saved memory and “Ask this project” still cannot find it after a short wait.</p>
          <button id="processKnowledgeBtn" type="button">Refresh memory search</button>
        </details>
        <p id="knowledgeStatus" class="status"></p>
        <div id="knowledgeList" class="table-scroll"><table><tbody><tr><td>Loading knowledge items…</td></tr></tbody></table></div>
      </section>
    `;

    setupMilestones(container, ctx, projectId);
    setupKnowledge(container, ctx, projectId);
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
                  <td>${escapeHtml(dateOnly(milestone.baselineFinishDate))}</td>
                  <td>${escapeHtml(dateOnly(milestone.forecastFinishDate || latest.forecastFinishDate))}</td>
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

  // ---- Standing knowledge ----------------------------------------------------

  function setupKnowledge(container, ctx, projectId) {
    const listNode = container.querySelector('#knowledgeList');
    const statusNode = container.querySelector('#knowledgeStatus');

    async function loadKnowledge() {
      try {
        const payload = await PW.request(`knowledge/items?projectId=${encodeURIComponent(projectId)}&status=active`);
        const items = asArray(payload.items);
        listNode.innerHTML = `<table><thead><tr><th>Title</th><th>Type</th><th>Official</th><th>Search status</th><th>Updated</th><th>Action</th></tr></thead><tbody>${items.map((item) => {
          const counts = item.embeddingCounts || {};
          const embedded = Number(counts.embedded || 0);
          const queued = Number(counts.queued || 0);
          const failed = Number(counts.failed || 0);
          const searchStatus = failed ? 'Needs refresh' : embedded ? 'Searchable' : queued ? 'Indexing' : 'Saved';
          return `<tr><td>${escapeHtml(item.title)}</td><td>${escapeHtml(friendlyLabel(item.itemType))}</td><td>${item.isOfficial ? '✅' : '—'}</td><td>${escapeHtml(searchStatus)}</td><td>${escapeHtml(dateValue(item.updatedAt))}</td><td><button type="button" data-archive-knowledge="${escapeHtml(item.itemId)}">Archive</button></td></tr>`;
        }).join('') || '<tr><td colspan="6"><strong>No project memory yet.</strong><br />Add standing context, constraints, decisions, or risks before the first report.</td></tr>'}</tbody></table>`;
        listNode.querySelectorAll('[data-archive-knowledge]').forEach((button) => {
          button.addEventListener('click', async () => {
            await PW.request(`knowledge/items/${encodeURIComponent(button.getAttribute('data-archive-knowledge'))}`, { method: 'DELETE' });
            await loadKnowledge();
          });
        });
      } catch (error) {
        listNode.innerHTML = `<table><tbody><tr><td class="status error">${escapeHtml(error.message || 'Could not load knowledge items.')}</td></tr></tbody></table>`;
      }
    }

    container.querySelector('#saveKnowledgeBtn').addEventListener('click', async () => {
      statusNode.className = 'status';
      statusNode.textContent = 'Saving knowledge item…';
      try {
        const result = await PW.request('knowledge/items', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId,
            title: container.querySelector('#knowledgeTitle').value,
            content: container.querySelector('#knowledgeContent').value,
            itemType: container.querySelector('#knowledgeType').value,
            isOfficial: true,
            metadata: { source: 'workspace_setup' }
          })
        });
        statusNode.className = 'status success';
        statusNode.textContent = result.embeddingWorker?.spawned
          ? 'Saved to project memory. Search indexing has started.'
          : 'Saved to project memory. Search indexing will run shortly.';
        container.querySelector('#knowledgeTitle').value = '';
        container.querySelector('#knowledgeContent').value = '';
        await loadKnowledge();
      } catch (error) {
        statusNode.className = 'status error';
        statusNode.textContent = error.message || 'Could not save knowledge item.';
      }
    });

    container.querySelector('#processKnowledgeBtn').addEventListener('click', async () => {
      statusNode.className = 'status';
      statusNode.textContent = 'Refreshing memory search…';
      try {
        const result = await PW.request('knowledge/embeddings/process', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId })
        });
        statusNode.className = 'status success';
        statusNode.textContent = result.embeddingWorker?.spawned ? 'Memory search refresh started.' : 'Memory search refresh could not start automatically.';
        window.setTimeout(loadKnowledge, 1500);
      } catch (error) {
        statusNode.className = 'status error';
        statusNode.textContent = error.message || 'Could not process embeddings.';
      }
    });

    loadKnowledge();
  }

  window.ProjectStages = window.ProjectStages || {};
  window.ProjectStages.setup = { mount };
}());
