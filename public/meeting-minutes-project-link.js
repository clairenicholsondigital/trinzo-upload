// When the Meeting Minutes Agent is opened from a project's Process tab, this
// shows a small banner that sends the current minutes to that project as a
// project update ("process once"). Project context is explicit in this URL;
// the agent's save bridge flushes the current editors before queuing an update.
(function () {
  'use strict';

  var LINK_KEY = 'trinzo.minutesProjectLink';

  function readLink() {
    // Older versions stored one project for every minutes draft in this tab.
    // Never let that context attach itself to an unrelated draft.
    try { sessionStorage.removeItem(LINK_KEY); } catch (_error) { /* URL context still works */ }
    var params = new URLSearchParams(window.location.search);
    var projectId = params.get('projectId');
    if (projectId && /^[1-9]\d*$/.test(projectId)) {
      return { projectId: projectId, projectName: params.get('projectName') || '' };
    }
    return null;
  }

  function currentDraftId() {
    var draftId = new URLSearchParams(window.location.search).get('draftId');
    return draftId && /^\d+$/.test(draftId) ? draftId : '';
  }

  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) { node.setAttribute(key, attrs[key]); });
    if (text) node.textContent = text;
    return node;
  }

  var link = readLink();
  if (!link) return;

  function projectWorkspaceUrl(stage) {
    var params = new URLSearchParams({ stage: stage, projectId: link.projectId });
    params.set('engine', new URLSearchParams(window.location.search).get('engine') === 'parallel' ? 'parallel' : 'original');
    return '/project-update-test?' + params.toString();
  }

  var banner = el('section', { 'class': 'panel project-link-banner', id: 'projectLinkBanner', 'aria-label': 'Linked project' });
  var heading = el('p', {}, '');
  var strong = el('strong', {}, 'Linked to project' + (link.projectName ? ': ' + link.projectName : ''));
  heading.appendChild(strong);
  heading.appendChild(document.createTextNode('. When these minutes are finished, send them to the project as an update.'));
  var actions = el('p', {});
  var backLink = el('a', { href: projectWorkspaceUrl('process'), 'class': 'button secondary', id: 'backToProject' }, 'Back to project');
  var createButton = el('button', { type: 'button', id: 'createProjectUpdateFromMinutes' }, 'Create project update');
  var unlinkButton = el('button', { type: 'button', 'class': 'secondary quiet', id: 'unlinkProject' }, 'Unlink project');
  var status = el('p', { 'class': 'muted', role: 'status', 'aria-live': 'polite' });
  actions.appendChild(backLink);
  actions.appendChild(document.createTextNode(' '));
  actions.appendChild(createButton);
  actions.appendChild(document.createTextNode(' '));
  actions.appendChild(unlinkButton);
  banner.appendChild(heading);
  banner.appendChild(actions);
  banner.appendChild(status);

  var hero = document.querySelector('main .hero');
  if (hero && hero.parentNode) hero.parentNode.insertBefore(banner, hero.nextSibling);
  else document.body.insertBefore(banner, document.body.firstChild);

  // Tag each minutes draft opened here with this project, once per draft, so
  // the project's Process tab can list it.
  var taggedDraftId = '';
  function tagDraftWithProject() {
    var draftId = currentDraftId();
    if (!draftId || draftId === taggedDraftId) return;
    taggedDraftId = draftId;
    fetch('/api/meeting-minutes-agent/drafts/' + encodeURIComponent(draftId) + '/project-link', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: link.projectId })
    }).then(function (response) {
      if (!response.ok && taggedDraftId === draftId) taggedDraftId = '';
    }).catch(function () {
      if (taggedDraftId === draftId) taggedDraftId = '';
    });
  }

  var submitting = false;
  function refreshButton() {
    tagDraftWithProject();
    backLink.setAttribute('href', projectWorkspaceUrl('process'));
    createButton.disabled = submitting || !currentDraftId();
    unlinkButton.disabled = submitting;
    if (!currentDraftId() && !status.textContent) status.textContent = 'Upload a transcript first.';
    else if (currentDraftId() && status.textContent === 'Upload a transcript first.') status.textContent = '';
  }
  refreshButton();
  var refreshTimer = setInterval(refreshButton, 2000);
  document.addEventListener('change', function (event) {
    if (event.target && event.target.id === 'betaFlow') refreshButton();
  });

  unlinkButton.addEventListener('click', function () {
    if (submitting) return;
    try { sessionStorage.removeItem(LINK_KEY); } catch (_error) { /* nothing stored */ }
    var url = new URL(window.location.href);
    url.searchParams.delete('projectId');
    url.searchParams.delete('projectName');
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
    clearInterval(refreshTimer);
    banner.remove();
  });

  createButton.addEventListener('click', async function () {
    var draftId = currentDraftId();
    if (!draftId || submitting) return;
    submitting = true;
    refreshButton();
    status.textContent = 'Saving these minutes before creating the project update…';
    try {
      if (!window.MeetingMinutesAgent || typeof window.MeetingMinutesAgent.saveForProjectUpdate !== 'function') {
        throw new Error('Reload the minutes before creating the project update.');
      }
      var saved = await window.MeetingMinutesAgent.saveForProjectUpdate();
      var revision = Number(saved && saved.revision);
      if (!saved || String(saved.id) !== draftId || currentDraftId() !== draftId
        || !Number.isSafeInteger(revision) || revision < 1) {
        throw new Error('The open minutes changed. Try again from the minutes you want to use.');
      }
      status.textContent = 'Queuing the project update from these saved minutes…';
      var response = await fetch('/api/project-update-test/from-minutes', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draftId: draftId, revision: revision, projectId: link.projectId, projectName: link.projectName || '' })
      });
      var payload = await response.json().catch(function () { return null; });
      if (payload && payload.duplicate && payload.existingUrl) {
        status.textContent = (payload.error || 'A project update from these minutes already exists.') + ' ';
        status.appendChild(el('a', { href: payload.existingUrl }, payload.kind === 'report' ? 'Open the existing report' : 'Follow it in the Library'));
        status.appendChild(document.createTextNode('.'));
        return;
      }
      if (!response.ok || !payload || payload.ok === false) {
        throw new Error((payload && payload.error) || ('Request failed with status ' + response.status + '.'));
      }
      status.textContent = '';
      status.appendChild(document.createTextNode('Project update queued. '));
      status.appendChild(el('a', { href: payload.jobUrl || ('/jobs/' + encodeURIComponent(payload.jobId)) }, 'Follow it in the Library'));
      status.appendChild(document.createTextNode(' or '));
      status.appendChild(el('a', { href: projectWorkspaceUrl('reports') }, 'go to the project reports'));
      status.appendChild(document.createTextNode('.'));
    } catch (error) {
      status.textContent = error.message || 'Could not create the project update.';
    } finally {
      submitting = false;
      refreshButton();
    }
  });
})();
