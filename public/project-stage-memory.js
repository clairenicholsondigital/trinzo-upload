// Memory stage: searchable background knowledge for the selected project.
// Structured setup (milestones/risks) can answer fresh-project questions
// immediately; memory items make Ask richer once indexed.
(function () {
  const PW = window.ProjectWorkspace;
  const { escapeHtml, friendlyLabel, dateValue, asArray } = PW;

  function memoryStatus(item) {
    const counts = item.embeddingCounts || {};
    const embedded = Number(counts.embedded || 0);
    const queued = Number(counts.queued || 0);
    const failed = Number(counts.failed || 0);
    if (failed) return 'Failed indexing';
    if (embedded) return 'Searchable';
    if (queued) return 'Queued for indexing';
    return 'Saved';
  }

  function renderMemoryRows(items) {
    return items.map((item) => `
      <tr>
        <td>${escapeHtml(item.title)}</td>
        <td>${escapeHtml(friendlyLabel(item.itemType))}</td>
        <td>${item.isOfficial ? 'Included' : 'Draft'}</td>
        <td>${escapeHtml(memoryStatus(item))}</td>
        <td>${escapeHtml(dateValue(item.updatedAt))}</td>
        <td>
          <div class="row-actions compact-actions">
            <button type="button" data-edit-knowledge="${escapeHtml(item.itemId)}">Edit</button>
            <button type="button" class="danger" data-archive-knowledge="${escapeHtml(item.itemId)}">Archive</button>
          </div>
        </td>
      </tr>
    `).join('') || '<tr><td colspan="6"><strong>No memory items added yet.</strong><br />Ask can still use project setup straight away. Add background docs, decisions or notes here when you want searchable project memory.</td></tr>';
  }

  function mount(container, ctx) {
    const projectId = ctx.projectId;
    container.innerHTML = `
      <section class="panel">
        <h1>Memory</h1>
        <p class="intro">Store background that should guide future reports and project questions. This is searchable project memory; transcript evidence still has to come from the update transcript itself.</p>
        <div class="safeguard-banner quiet">
          <strong>Fresh project note:</strong> Ask works even before memory is indexed by using project setup, milestones and monitored risks. Add memory items when you want it to retrieve background docs, decisions or notes.
        </div>
      </section>
      <section class="panel">
        <h2 id="memoryFormHeading">Add memory item</h2>
        <div class="grid">
          <label>Title <input id="knowledgeTitle" type="text" placeholder="Statement of work / background note" /></label>
          <label>Type <select id="knowledgeType"><option value="background_doc">Background doc</option><option value="decision">Decision</option><option value="note">Note</option><option value="risk">Risk</option></select></label>
        </div>
        <label style="margin-top:.75rem">Content <textarea id="knowledgeContent" placeholder="Paste project background here..."></textarea></label>
        <div class="actions" style="margin-top:.75rem">
          <button id="saveKnowledgeBtn" class="primary" type="button">Save memory item</button>
          <button id="cancelKnowledgeEditBtn" class="secondary" type="button" hidden>Cancel edit</button>
          <button id="processKnowledgeBtn" type="button">Refresh memory search</button>
        </div>
        <p id="knowledgeStatus" class="status"></p>
      </section>
      <section class="panel">
        <h2>Memory health</h2>
        <p class="intro">Queued items are waiting to be indexed. Searchable items are available for semantic retrieval. Failed indexing means refresh memory search or check the worker.</p>
        <div id="knowledgeList" class="table-scroll"><table><tbody><tr><td>Loading memory items…</td></tr></tbody></table></div>
        <p class="muted">Approved reports become future project memory after review.</p>
      </section>
    `;

    const listNode = container.querySelector('#knowledgeList');
    const statusNode = container.querySelector('#knowledgeStatus');
    const headingNode = container.querySelector('#memoryFormHeading');
    const saveBtn = container.querySelector('#saveKnowledgeBtn');
    const cancelBtn = container.querySelector('#cancelKnowledgeEditBtn');
    const titleInput = container.querySelector('#knowledgeTitle');
    const typeInput = container.querySelector('#knowledgeType');
    const contentInput = container.querySelector('#knowledgeContent');
    let loadedItems = [];
    let editingItemId = null;

    function resetEditor() {
      editingItemId = null;
      headingNode.textContent = 'Add memory item';
      saveBtn.textContent = 'Save memory item';
      cancelBtn.hidden = true;
      titleInput.value = '';
      contentInput.value = '';
      typeInput.value = 'background_doc';
    }

    function beginEdit(itemId) {
      const item = loadedItems.find((entry) => String(entry.itemId) === String(itemId));
      if (!item) return;
      editingItemId = item.itemId;
      headingNode.textContent = 'Edit memory item';
      saveBtn.textContent = 'Update memory item';
      cancelBtn.hidden = false;
      titleInput.value = item.title || '';
      typeInput.value = item.itemType || 'note';
      contentInput.value = item.content || '';
      titleInput.focus();
      statusNode.className = 'status';
      statusNode.textContent = 'Editing existing memory item.';
    }

    async function loadKnowledge() {
      try {
        const payload = await PW.request(`knowledge/items?projectId=${encodeURIComponent(projectId)}&status=active`);
        const items = asArray(payload.items);
        loadedItems = items;
        listNode.innerHTML = `
          <table>
            <thead><tr><th>Title</th><th>Type</th><th>Baseline</th><th>Search status</th><th>Updated</th><th>Action</th></tr></thead>
            <tbody>${renderMemoryRows(items)}</tbody>
          </table>
        `;
        listNode.querySelectorAll('[data-edit-knowledge]').forEach((button) => {
          button.addEventListener('click', () => beginEdit(button.getAttribute('data-edit-knowledge')));
        });
        listNode.querySelectorAll('[data-archive-knowledge]').forEach((button) => {
          button.addEventListener('click', async () => {
            const itemId = button.getAttribute('data-archive-knowledge');
            if (!window.confirm('Archive this memory item?')) return;
            await PW.request(`knowledge/items/${encodeURIComponent(itemId)}`, { method: 'DELETE' });
            if (String(editingItemId) === String(itemId)) resetEditor();
            await loadKnowledge();
          });
        });
      } catch (error) {
        listNode.innerHTML = `<table><tbody><tr><td class="status error">${escapeHtml(error.message || 'Could not load memory items.')}</td></tr></tbody></table>`;
      }
    }

    cancelBtn.addEventListener('click', () => {
      resetEditor();
      statusNode.className = 'status';
      statusNode.textContent = 'Edit cancelled.';
    });

    saveBtn.addEventListener('click', async () => {
      statusNode.className = 'status';
      statusNode.textContent = editingItemId ? 'Updating memory item…' : 'Saving memory item…';
      const body = {
        projectId,
        title: titleInput.value,
        content: contentInput.value,
        itemType: typeInput.value,
        isOfficial: true,
        metadata: { source: 'workspace_memory' }
      };
      try {
        const result = await PW.request(editingItemId ? `knowledge/items/${encodeURIComponent(editingItemId)}` : 'knowledge/items', {
          method: editingItemId ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        statusNode.className = 'status success';
        statusNode.textContent = result.embeddingWorker?.spawned
          ? 'Memory item saved. Search indexing has started.'
          : 'Memory item saved. Search indexing will run shortly.';
        resetEditor();
        await loadKnowledge();
      } catch (error) {
        statusNode.className = 'status error';
        statusNode.textContent = error.message || 'Could not save memory item.';
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
        statusNode.textContent = error.message || 'Could not refresh memory search.';
      }
    });

    loadKnowledge();
  }

  window.ProjectStages = window.ProjectStages || {};
  window.ProjectStages.memory = { mount };
}());
