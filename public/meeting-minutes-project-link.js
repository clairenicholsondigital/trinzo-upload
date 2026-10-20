// When the Meeting Minutes Agent is opened from a project's Process tab, this
// shows a small banner that sends the current minutes to that project as a
// project update ("process once"). It reads the draft id from the URL, which
// the agent keeps up to date, so it needs nothing from the agent's own code.
(function () {
  'use strict';

  var LINK_KEY = 'trinzo.minutesProjectLink';

  function readLink() {
    var params = new URLSearchParams(window.location.search);
    var projectId = params.get('projectId');
    if (projectId && /^\d+$/.test(projectId)) {
      var fromUrl = { projectId: projectId, projectName: params.get('projectName') || '' };
      try { sessionStorage.setItem(LINK_KEY, JSON.stringify(fromUrl)); } catch (_error) { /* banner still works for this page */ }
      return fromUrl;
    }
    try {
      var stored = JSON.parse(sessionStorage.getItem(LINK_KEY) || 'null');
      if (stored && /^\d+$/.test(String(stored.projectId || ''))) return stored;
    } catch (_error) { /* no stored link */ }
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

  var banner = el('section', { 'class': 'panel project-link-banner', id: 'projectLinkBanner', 'aria-label': 'Linked project' });
  var heading = el('p', {}, '');
  var strong = el('strong', {}, 'Linked to project' + (link.projectName ? ': ' + link.projectName : ''));
  heading.appendChild(strong);
  heading.appendChild(document.createTextNode('. When these minutes are finished, send them to the project as an update.'));
  var actions = el('p', {});
  var createButton = el('button', { type: 'button', id: 'createProjectUpdateFromMinutes' }, 'Create project update');
  var unlinkButton = el('button', { type: 'button', 'class': 'secondary quiet', id: 'unlinkProject' }, 'Unlink project');
  var status = el('p', { 'class': 'muted', role: 'status', 'aria-live': 'polite' });
  actions.appendChild(createButton);
  actions.appendChild(document.createTextNode(' '));
  actions.appendChild(unlinkButton);
  banner.appendChild(heading);
  banner.appendChild(actions);
  banner.appendChild(status);

  var hero = document.querySelector('main .hero');
  if (hero && hero.parentNode) hero.parentNode.insertBefore(banner, hero.nextSibling);
  else document.body.insertBefore(banner, document.body.firstChild);

  function refreshButton() {
    createButton.disabled = !currentDraftId();
    if (!currentDraftId() && !status.textContent) status.textContent = 'Upload a transcript first.';
    else if (currentDraftId() && status.textContent === 'Upload a transcript first.') status.textContent = '';
  }
  refreshButton();
  setInterval(refreshButton, 2000);

  unlinkButton.addEventListener('click', function () {
    try { sessionStorage.removeItem(LINK_KEY); } catch (_error) { /* nothing stored */ }
    banner.remove();
  });

  createButton.addEventListener('click', async function () {
    var draftId = currentDraftId();
    if (!draftId) return;
    createButton.disabled = true;
    status.textContent = 'Queuing the project update from these minutes…';
    try {
      var response = await fetch('/api/project-update-test/from-minutes', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draftId: draftId, projectId: link.projectId, projectName: link.projectName || '' })
      });
      var payload = await response.json().catch(function () { return null; });
      if (!response.ok || !payload || payload.ok === false) {
        throw new Error((payload && payload.error) || ('Request failed with status ' + response.status + '.'));
      }
      status.textContent = '';
      status.appendChild(document.createTextNode('Project update queued. '));
      status.appendChild(el('a', { href: payload.jobUrl || ('/jobs/' + encodeURIComponent(payload.jobId)) }, 'Follow it in the Library'));
      status.appendChild(document.createTextNode(' or '));
      status.appendChild(el('a', { href: '/project-update-test?stage=reports&projectId=' + encodeURIComponent(link.projectId) }, 'go to the project reports'));
      status.appendChild(document.createTextNode('.'));
    } catch (error) {
      status.textContent = error.message || 'Could not create the project update.';
    } finally {
      createButton.disabled = !currentDraftId();
    }
  });
})();
