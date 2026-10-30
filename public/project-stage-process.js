// Process stage: "process once". The meeting is processed by the Meeting
// Minutes Agent (the one central transcript engine), then the project update
// report is built from those reviewed minutes via /from-minutes.
(function () {
  const PW = window.ProjectWorkspace;
  const { escapeHtml } = PW;

  const BETA_CHOICE_KEY = 'trinzo.projectMinutesBeta.';
  const refreshers = new WeakMap();

  function minutesAgentUrl(ctx, draftId, betaEnabled = false) {
    const params = new URLSearchParams();
    if (draftId) params.set('draftId', String(draftId));
    params.set('projectId', String(ctx.projectId));
    if (ctx.project?.projectName) params.set('projectName', ctx.project.projectName);
    // This is the next-upload preference. A saved draft keeps its own provider.
    params.set('engine', betaEnabled ? 'parallel' : 'original');
    return `/meeting-minutes-agent?${params.toString()}`;
  }

  function storeBetaChoice(userId, enabled) {
    if (!userId) return;
    try { sessionStorage.setItem(BETA_CHOICE_KEY + userId, enabled ? 'parallel' : 'original'); } catch (_) {}
  }

  function requestedBetaChoice(userId) {
    const params = new URLSearchParams(window.location.search);
    // An explicit off link always wins over a previously enabled preference.
    if (params.has('engine')) return params.get('engine') === 'parallel';
    if (!userId) return false;
    try { return sessionStorage.getItem(BETA_CHOICE_KEY + userId) === 'parallel'; } catch (_) { return false; }
  }

  function updateBetaUrl(enabled) {
    const url = new URL(window.location.href);
    url.searchParams.set('engine', enabled ? 'parallel' : 'original');
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  }

  function refreshBetaNavigation(enabled) {
    // Keep normal clicks and opening a project navigation link in a new tab
    // consistent, including the separate project chooser.
    document.querySelectorAll('a[data-project-nav], #switchProjectLink').forEach((link) => {
      const destination = new URL(link.href, window.location.href);
      if (destination.origin !== window.location.origin || destination.pathname !== window.location.pathname) return;
      destination.searchParams.set('engine', enabled ? 'parallel' : 'original');
      link.href = destination.pathname + destination.search + destination.hash;
    });
  }

  async function initialiseBetaChoice(container, ctx, selection) {
    const control = container.querySelector('#projectBetaControl');
    const toggle = container.querySelector('#projectBetaFlow');
    const status = container.querySelector('#projectBetaStatus');
    const applyChoice = () => {
      toggle.checked = selection.enabled;
      refreshBetaNavigation(selection.enabled);
      status.textContent = selection.enabled
        ? 'On — use the new streamlined meeting-minutes flow for your next upload, then review it and create the project update as usual.'
        : 'Off — use the existing meeting-minutes flow for your next upload.';
      const newMinutesLink = container.querySelector('#openMinutesAgent');
      newMinutesLink.href = minutesAgentUrl(ctx, null, selection.enabled);
      newMinutesLink.removeAttribute('aria-disabled');
      container.querySelectorAll('[data-open-minutes-draft]').forEach((link) => {
        link.href = minutesAgentUrl(ctx, link.dataset.openMinutesDraft, selection.enabled);
        link.removeAttribute('aria-disabled');
      });
    };
    try {
      const auth = await PW.request('/api/auth/me');
      if (!container.isConnected) return;
      selection.allowed = auth.user?.role === 'admin';
      selection.userId = String(auth.user?.userId || auth.user?.id || '');
      selection.enabled = selection.allowed && requestedBetaChoice(selection.userId);
      if (selection.allowed) {
        storeBetaChoice(selection.userId, selection.enabled);
        updateBetaUrl(selection.enabled);
        control.hidden = false;
      }
    } catch (_) {
      // A failed auth check never opts a user into Beta.
      selection.allowed = false;
      selection.enabled = false;
    }
    selection.ready = true;
    applyChoice();
    toggle.addEventListener('change', () => {
      if (!selection.allowed) return;
      selection.enabled = toggle.checked;
      storeBetaChoice(selection.userId, selection.enabled);
      updateBetaUrl(selection.enabled);
      applyChoice();
    });
    window.addEventListener('popstate', () => {
      if (!container.isConnected || !selection.allowed) return;
      selection.enabled = requestedBetaChoice(selection.userId);
      storeBetaChoice(selection.userId, selection.enabled);
      applyChoice();
    });
  }

  function mount(container, ctx) {
    const selection = { allowed: false, enabled: false, ready: false, userId: '' };
    container.innerHTML = `
      <section class="panel meeting-hero">
        <span class="eyebrow">Project update meeting</span>
        <h1>Capture this update</h1>
        <p class="intro">Process the meeting once in the Meeting Minutes Agent, then build this project's update from the finished minutes.</p>
      </section>
      <section class="process-subtabs" aria-label="Project update meeting sections">
        <button class="process-subtab active" type="button" data-process-panel="meeting" aria-pressed="true">Process meeting</button>
        <button class="process-subtab" type="button" data-process-panel="agenda" aria-pressed="false">Suggested agenda</button>
      </section>
      <div class="process-subpanel" data-process-tab-panel="meeting">
        <section class="panel">
          <h2>1. Write the minutes</h2>
          <p class="intro">Upload the transcript to the Meeting Minutes Agent and work through Details, Discussion, Actions and Summary. It remembers this project, so you can create the update from its last step.</p>
          <div class="project-beta-control" id="projectBetaControl" hidden>
            <label class="project-beta-switch" for="projectBetaFlow">
              <input type="checkbox" role="switch" id="projectBetaFlow" aria-describedby="projectBetaStatus" />
              <span class="project-beta-track" aria-hidden="true"></span>
              <span>Beta meeting minutes</span>
            </label>
            <p class="muted" id="projectBetaStatus" role="status" aria-live="polite">Off — use the existing meeting-minutes flow for your next upload.</p>
          </div>
          <p><a class="button" id="openMinutesAgent" aria-disabled="true">Open the Meeting Minutes Agent</a></p>
        </section>
        <section class="panel">
          <h2>2. Create the project update from minutes</h2>
          <p class="intro">Pick the finished minutes for this meeting. The draft report uses project memory as background, but its evidence comes from these minutes.</p>
          <p id="fromMinutesStatus" class="status" role="status" aria-live="polite" hidden></p>
          <div id="minutesDraftList" class="empty-state">Loading this project's minutes…</div>
          <p><button type="button" class="secondary quiet" id="toggleAllMinutes" aria-pressed="false">Show all my minutes</button></p>
        </section>
      </div>
      <div class="process-subpanel" data-process-tab-panel="agenda" hidden>
        <section class="panel meeting-agenda-panel">
          <div>
            <h2>Suggested project update agenda</h2>
            <p class="intro">Automatically built from the monitored milestones and risks in this project profile. Use it to guide the meeting, then process the transcript in the Meeting Minutes Agent.</p>
          </div>
          <div id="meetingAgenda" class="empty-state">Building agenda from project profile…</div>
        </section>
      </div>
    `;
    wireProcessSubtabs(container);
    initialiseBetaChoice(container, ctx, selection);
    renderMeetingAgenda(container, ctx);
    renderMinutesDrafts(container, ctx, false, selection);
    const toggle = container.querySelector('#toggleAllMinutes');
    refreshers.set(container, () => renderMinutesDrafts(container, ctx, toggle?.getAttribute('aria-pressed') === 'true', selection));
    if (toggle) {
      toggle.addEventListener('click', () => {
        const showAll = toggle.getAttribute('aria-pressed') !== 'true';
        toggle.setAttribute('aria-pressed', showAll ? 'true' : 'false');
        toggle.textContent = showAll ? "Show only this project's minutes" : 'Show all my minutes';
        renderMinutesDrafts(container, ctx, showAll, selection);
      });
    }
  }

  function draftUpdatedLabel(draft) {
    const value = draft.updatedAt || draft.createdAt;
    return value ? PW.displayDate(value) : '';
  }

  // By default only minutes written for this project are listed. Minutes are
  // tagged when opened from this tab or sent to this project.
  async function renderMinutesDrafts(container, ctx, showAll, selection) {
    const target = container.querySelector('#minutesDraftList');
    if (!target) return;
    const requestId = String(Date.now() + Math.random());
    target.dataset.requestId = requestId;
    try {
      const query = showAll ? 'limit=10' : `limit=10&projectId=${encodeURIComponent(ctx.projectId)}`;
      const payload = await PW.request(`/api/meeting-minutes-agent/drafts?${query}`);
      if (target.dataset.requestId !== requestId) return;
      const drafts = PW.asArray(payload.drafts);
      if (!drafts.length) {
        target.className = 'empty-state';
        target.innerHTML = showAll
          ? 'No minutes yet. Open the Meeting Minutes Agent above to process this meeting first.'
          : 'No minutes for this project yet. Open the Meeting Minutes Agent above to process this meeting, or show all your minutes.';
        return;
      }
      target.className = 'minutes-draft-list';
      target.innerHTML = drafts.map((draft) => `
        <article class="agenda-step" data-minutes-draft="${escapeHtml(draft.draftId)}">
          <div>
            <h3>${escapeHtml(draft.title || 'Meeting minutes')}${draft.generationProvider === 'parallel-specialists-v1' ? ' <span class="badge project-beta-badge">Beta</span>' : ''}</h3>
            <p class="muted">${escapeHtml([draft.stageLabel ? `At ${draft.stageLabel}` : '', draftUpdatedLabel(draft) ? `updated ${draftUpdatedLabel(draft)}` : ''].filter(Boolean).join(', '))}</p>
            <p>
              <button type="button" class="button" data-create-from-minutes="${escapeHtml(draft.draftId)}" data-minutes-revision="${escapeHtml(draft.revision)}">Create project update</button>
              <a class="button secondary" data-open-minutes-draft="${escapeHtml(draft.draftId)}" ${selection.ready ? `href="${escapeHtml(minutesAgentUrl(ctx, draft.draftId, selection.enabled))}"` : 'aria-disabled="true"'}>Open minutes</a>
            </p>
          </div>
        </article>
      `).join('');
      target.querySelectorAll('[data-create-from-minutes]').forEach((button) => {
        button.addEventListener('click', () => createFromMinutes(container, ctx, button));
      });
    } catch (error) {
      target.className = 'empty-state';
      target.textContent = error.message || 'Could not load your minutes.';
    }
  }

  async function createFromMinutes(container, ctx, button) {
    if (button.dataset.submitting === 'true') return;
    const status = container.querySelector('#fromMinutesStatus');
    const draftId = button.getAttribute('data-create-from-minutes');
    const revision = Number(button.getAttribute('data-minutes-revision'));
    const setStatus = (html, kind) => {
      if (!status) return;
      status.hidden = false;
      status.className = `status ${kind || ''}`.trim();
      status.innerHTML = html;
    };
    if (!Number.isSafeInteger(revision) || revision < 1) {
      setStatus('Reload this project to choose the latest saved minutes.', 'error');
      return;
    }
    button.dataset.submitting = 'true';
    button.disabled = true;
    setStatus('Queuing the project update from these minutes…', 'info');
    try {
      const payload = await PW.request('from-minutes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draftId, revision, projectId: ctx.projectId, projectName: ctx.project?.projectName || '' })
      });
      const jobUrl = payload.jobUrl || `/jobs/${encodeURIComponent(payload.jobId)}`;
      setStatus(`Project update queued. <a href="${escapeHtml(jobUrl)}">Follow it in the Library</a>; the draft report appears under Reports when it is ready.`, 'success');
    } catch (error) {
      const existingUrl = error.payload && error.payload.duplicate ? error.payload.existingUrl : '';
      const link = existingUrl
        ? ` <a href="${escapeHtml(existingUrl)}">${error.payload.kind === 'report' ? 'Open the existing report' : 'Follow it in the Library'}</a>.`
        : '';
      setStatus(`${escapeHtml(error.message || 'Could not create the project update.')}${link}`, 'error');
      if (error.status === 409 && !error.payload?.duplicate) refreshers.get(container)?.();
    } finally {
      delete button.dataset.submitting;
      button.disabled = false;
    }
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
      // With no milestones the agenda below is the standard template, not one
      // built from this project, so say so and point to Setup.
      const setupUrl = `?stage=setup&projectId=${encodeURIComponent(ctx.projectId)}`;
      const genericNotice = milestones.length ? '' : `
        <div class="safeguard-banner warning generic-agenda-notice" role="note">
          <strong>Generic agenda:</strong> this project has no milestones set up yet, so this is the standard project update agenda rather than one tailored to this project.
          <a href="${PW.escapeHtml(setupUrl)}" data-agenda-open-setup style="color:inherit;font-weight:600;text-decoration:underline">Add milestones in Setup</a> to build an agenda around this project's delivery.
        </div>`;
      target.className = 'meeting-agenda';
      target.innerHTML = `${genericNotice}
        <article class="agenda-step"><span class="step-no">1</span><div><h3>Start with changes since the last update</h3><ul><li>What has moved forward, changed, slipped, or become clearer?</li><li>Are there any decisions or actions from the previous update to close out?</li></ul></div></article>
        <article class="agenda-step"><span class="step-no">2</span><div><h3>Review monitored milestones</h3><p class="muted">For each item, confirm what changed, what is blocked, and whether the forecast still holds.</p><ul>${milestoneHtml}</ul></div></article>
        <article class="agenda-step"><span class="step-no">3</span><div><h3>Review monitored risks</h3><p class="muted">Confirm whether each risk has reduced, escalated, or needs a new action.</p><ul>${riskHtml}</ul></div></article>
        <article class="agenda-step"><span class="step-no">4</span><div><h3>Capture decisions, actions and next update</h3><ul><li>What decisions were made?</li><li>Who owns each action and by when?</li><li>What should the client-facing update say?</li></ul></div></article>
      `;
      const setupLink = target.querySelector('[data-agenda-open-setup]');
      const setupTab = document.querySelector('.stage-tab[data-stage="setup"]');
      if (setupLink && setupTab) {
        setupLink.addEventListener('click', (event) => {
          event.preventDefault();
          setupTab.click();
        });
      }
    } catch (error) {
      target.className = 'empty-state';
      target.innerHTML = `Could not build the agenda from the project profile. You can still process the meeting in the Meeting Minutes Agent.`;
    }
  }

  function wireProcessSubtabs(container) {
    const buttons = Array.from(container.querySelectorAll('[data-process-panel]'));
    const panels = Array.from(container.querySelectorAll('[data-process-tab-panel]'));
    buttons.forEach((button) => {
      button.addEventListener('click', () => {
        const target = button.getAttribute('data-process-panel');
        buttons.forEach((node) => {
          const active = node === button;
          node.classList.toggle('active', active);
          node.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
        panels.forEach((panel) => {
          panel.hidden = panel.getAttribute('data-process-tab-panel') !== target;
        });
      });
    });
  }

  window.ProjectStages = window.ProjectStages || {};
  window.ProjectStages.process = { mount, refresh: (container) => refreshers.get(container)?.() };
}());
