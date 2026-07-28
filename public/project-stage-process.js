// Process stage: the transcript → project-report flow. Reuses the existing
// buildTranscriptTestPage engine, but the project is fixed by the workspace bar
// (fixedProjectId), so the tool's own project picker is suppressed.
(function () {
  const PW = window.ProjectWorkspace;

  function mount(container, ctx) {
    container.innerHTML = `
      <section class="panel meeting-hero">
        <span class="eyebrow">Project update meeting</span>
        <h1>Capture this update</h1>
        <p class="intro">Use the agenda below, then paste the meeting notes or transcript to create a reviewed draft report.</p>
      </section>
      <section class="panel meeting-agenda-panel">
        <div class="section-heading-row">
          <div>
            <h2>Suggested project update agenda</h2>
            <p class="intro">Automatically built from the monitored milestones and risks in this project profile. Use it to guide the meeting, then paste the notes/transcript below.</p>
          </div>
          <button type="button" data-open-stage="insights">Edit project profile</button>
        </div>
        <div id="meetingAgenda" class="empty-state">Building agenda from project profile…</div>
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
    renderMeetingAgenda(container, ctx);
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

  async function renderMeetingAgenda(container, ctx) {
    const target = container.querySelector('#meetingAgenda');
    if (!target) return;
    try {
      const payload = await PW.request(`context?projectId=${encodeURIComponent(ctx.projectId)}&limit=4`);
      const context = payload.context || {};
      const milestones = PW.asArray(context.activeMilestones).slice(0, 6);
      const risks = PW.asArray(context.activeRisks).slice(0, 6);
      const milestoneHtml = milestones.length
        ? milestones.map((item) => `<li><strong>${PW.escapeHtml(PW.friendlyLabel(item.milestoneName))}</strong>${item.forecastFinishDate ? ` <span class="muted">Forecast ${PW.escapeHtml(PW.displayDate(item.forecastFinishDate))}</span>` : ''}</li>`).join('')
        : '<li class="muted">No monitored milestones yet — add them in the project profile if this meeting should track delivery progress.</li>';
      const riskHtml = risks.length
        ? risks.map((item) => `<li><strong>${PW.escapeHtml(item.riskTitle || 'Risk')}</strong>${item.category ? ` <span class="muted">${PW.escapeHtml(PW.friendlyLabel(item.category))}</span>` : ''}${item.mitigation ? `<br /><span class="muted">Mitigation: ${PW.escapeHtml(String(item.mitigation).slice(0, 120))}${String(item.mitigation).length > 120 ? '…' : ''}</span>` : ''}</li>`).join('')
        : '<li class="muted">No monitored risks yet — add standing risks in the project profile if they need regular review.</li>';
      target.className = 'meeting-agenda';
      target.innerHTML = `
        <article class="agenda-step"><span class="step-no">1</span><div><h3>Start with changes since the last update</h3><ul><li>What has moved forward, changed, slipped, or become clearer?</li><li>Are there any decisions or actions from the previous update to close out?</li></ul></div></article>
        <article class="agenda-step"><span class="step-no">2</span><div><h3>Review monitored milestones</h3><p class="muted">For each item, confirm what changed, what is blocked, and whether the forecast still holds.</p><ul>${milestoneHtml}</ul></div></article>
        <article class="agenda-step"><span class="step-no">3</span><div><h3>Review monitored risks</h3><p class="muted">Confirm whether each risk has reduced, escalated, or needs a new action.</p><ul>${riskHtml}</ul></div></article>
        <article class="agenda-step"><span class="step-no">4</span><div><h3>Capture decisions, actions and next update</h3><ul><li>What decisions were made?</li><li>Who owns each action and by when?</li><li>What should the client-facing update say?</li></ul></div></article>
      `;
    } catch (error) {
      target.className = 'empty-state';
      target.innerHTML = `Could not build the agenda from the project profile. You can still paste notes and create a draft report.`;
    }
  }

  window.ProjectStages = window.ProjectStages || {};
  window.ProjectStages.process = { mount };
}());
