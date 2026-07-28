// Process stage: the transcript → project-report flow. Reuses the existing
// buildTranscriptTestPage engine, but the project is fixed by the workspace bar
// (fixedProjectId), so the tool's own project picker is suppressed.
(function () {
  const PW = window.ProjectWorkspace;

  function mount(container, ctx) {
    container.innerHTML = `
      <section class="panel meeting-hero">
        <span class="eyebrow">Project update meeting</span>
        <h1>${PW.escapeHtml(ctx.project.projectName || 'Project update')}</h1>
        <p class="intro">Use this as the scaffold for a real update meeting: check the baseline, capture what changed, then turn the transcript or notes into a reviewed draft report.</p>
        <div class="meeting-scaffold-grid">
          <article class="scaffold-card">
            <strong>1. Before the meeting</strong>
            <ul>
              <li>Check milestones and configured risks.</li>
              <li>Remind yourself what changed last time.</li>
              <li>Note any decisions or context the update should respect.</li>
            </ul>
          </article>
          <article class="scaffold-card">
            <strong>2. During the meeting</strong>
            <ul>
              <li>What changed since the last update?</li>
              <li>Are any milestones blocked, delayed, or complete?</li>
              <li>Are there new risks, decisions, or actions?</li>
            </ul>
          </article>
          <article class="scaffold-card">
            <strong>3. After the meeting</strong>
            <ul>
              <li>Paste transcript or rough notes below.</li>
              <li>Create a draft report.</li>
              <li>Review evidence before saving anything as project memory.</li>
            </ul>
          </article>
        </div>
      </section>
      <section class="panel profile-summary-panel">
        <div class="section-heading-row">
          <div>
            <h2>Project profile at a glance</h2>
            <p class="intro">The standing baseline this update is compared against.</p>
          </div>
          <button type="button" data-open-stage="insights">Edit project profile</button>
        </div>
        <div id="meetingProfileSummary" class="empty-state">Loading milestones and risks…</div>
      </section>
      <section class="panel">
        <h2>Create the update</h2>
        <p class="intro">Paste meeting notes or a transcript. The draft can use project memory as background, but report evidence must come from this update.</p>
      </section>
      <main id="transcriptTestRoot"></main>
    `;
    container.querySelectorAll('[data-open-stage]').forEach((button) => {
      button.addEventListener('click', () => {
        const stage = button.getAttribute('data-open-stage');
        const tab = document.querySelector(`.stage-tab[data-stage="${stage}"]`);
        if (tab) tab.click();
      });
    });
    renderProfileSummary(container, ctx);
    buildTranscriptTestPage({
      title: 'Meeting notes or transcript',
      intro: 'Create a draft project update from this meeting. Review it before approving it as project memory.',
      buttonText: 'Create draft report',
      resetButtonText: 'Clear and restart',
      confirmReset: true,
      loadingMessage: 'Analysing transcript...',
      endpoint: '/api/project-update-test',
      projectReportUi: true,
      fixedProjectId: ctx.projectId,
      summary: projectUpdateSummary
    });
  }

  async function renderProfileSummary(container, ctx) {
    const target = container.querySelector('#meetingProfileSummary');
    if (!target) return;
    try {
      const payload = await PW.request(`context?projectId=${encodeURIComponent(ctx.projectId)}&limit=4`);
      const context = payload.context || {};
      const milestones = PW.asArray(context.activeMilestones).slice(0, 6);
      const risks = PW.asArray(context.activeRisks).slice(0, 6);
      const milestoneHtml = milestones.length
        ? milestones.map((item) => `<li><strong>${PW.escapeHtml(PW.friendlyLabel(item.milestoneName))}</strong>${item.forecastFinishDate ? ` <span class="muted">forecast ${PW.escapeHtml(PW.displayDate(item.forecastFinishDate))}</span>` : ''}</li>`).join('')
        : '<li class="muted">No milestones yet.</li>';
      const riskHtml = risks.length
        ? risks.map((item) => `<li><strong>${PW.escapeHtml(item.riskTitle || 'Risk')}</strong>${item.mitigation ? ` <span class="muted">— ${PW.escapeHtml(String(item.mitigation).slice(0, 120))}</span>` : ''}</li>`).join('')
        : '<li class="muted">No configured risks yet.</li>';
      target.className = 'profile-summary-grid';
      target.innerHTML = `
        <article class="card"><h3>Milestones</h3><ul>${milestoneHtml}</ul></article>
        <article class="card"><h3>Configured risks</h3><ul>${riskHtml}</ul></article>
      `;
    } catch (error) {
      target.className = 'empty-state';
      target.innerHTML = `Could not load the project profile summary. You can still paste notes and create a draft report.`;
    }
  }

  window.ProjectStages = window.ProjectStages || {};
  window.ProjectStages.process = { mount };
}());
