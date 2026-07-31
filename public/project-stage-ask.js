// Ask stage: a project-specific RAG-style interface over stored project memory.
(function () {
  const PW = window.ProjectWorkspace;
  const { escapeHtml, friendlyLabel, asArray } = PW;

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
      : '<div class="empty-state"><strong>No matching project memory found.</strong><br />Try adding background notes, decisions, risks, or an SoW excerpt to Setup -> Project memory first.</div>';
    return `<div class="badges"><span class="badge ${escapeHtml(modeBadgeClass(result.answerMode))}">Answer: ${escapeHtml(answerMode)}</span><span class="badge ${escapeHtml(modeBadgeClass(result.retrievalMode))}">Retrieval: ${escapeHtml(retrievalMode)}</span><span class="badge muted">${chunks.length} chunk${chunks.length === 1 ? '' : 's'}</span>${result.confidence ? `<span class="badge muted">Confidence: ${escapeHtml(friendlyLabel(result.confidence))}</span>` : ''}</div>${answer}${chunksHtml}`;
  }

  function mount(container, ctx) {
    const projectId = ctx.projectId;
    container.innerHTML = `
      <section class="panel ask-panel ask-stage-panel">
        <div class="section-title-row">
          <div>
            <h1>Ask this project</h1>
            <p class="intro">Ask stored project memory before a report, review, or client call. If generation is unavailable, the matching memory snippets still appear.</p>
          </div>
        </div>
        <div class="ask-layout">
          <div class="ask-question-area">
            <label>Question <textarea id="knowledgeAskQuestion" placeholder="What risks, decisions, or constraints should I remember before the next update?"></textarea></label>
            <div class="actions ask-actions">
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
    wireAsk(container, projectId);
  }

  function wireAsk(container, projectId) {
    const button = container.querySelector('#askKnowledgeBtn');
    const status = container.querySelector('#knowledgeAskStatus');
    const resultBox = container.querySelector('#knowledgeAskResult');
    button.addEventListener('click', async () => {
      status.className = 'status';
      status.textContent = 'Asking project memory...';
      resultBox.className = 'empty-state';
      resultBox.innerHTML = 'Searching stored project memory...';
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
  window.ProjectStages.ask = { mount };
}());
