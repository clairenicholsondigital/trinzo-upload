// Shared helpers + project-selection state for the project-update workspace.
// Exposed on window.ProjectWorkspace so the workspace shell and every stage
// module share ONE source of truth for "which project am I working on" and a
// single copy of the formatting/auth helpers that used to be duplicated across
// the milestones / reports / context pages.
(function () {
  const PROJECT_SELECTION_KEY = 'trinzoProjectUpdateSelectedProjectId';
  const API_BASE = '/api/project-update-test';

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function dateValue(value) {
    if (!value) return '-';
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? String(value).replace(/T/g, ' ').replace(/Z$/i, '')
      : date.toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function dateOnly(value) {
    return value ? String(value).slice(0, 10) : '-';
  }

  function displayDate(value) {
    if (!value) return '-';
    const raw = String(value).slice(0, 10);
    const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const date = match
      ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
      : new Date(value);
    return Number.isNaN(date.getTime())
      ? raw
      : date.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  // Acronym-aware title case (milestones / context style).
  function friendlyLabel(value) {
    const words = String(value || '').replace(/[_-]+/g, ' ').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return '-';
    return words.map((word) => {
      const lower = word.toLowerCase();
      if (['ai', 'rag', 'sow', 'ei'].includes(lower)) return lower.toUpperCase();
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    }).join(' ');
  }

  // Sentence case (reports list style: "In review", "On track").
  function sentenceLabel(value) {
    const label = String(value || '').replace(/[_-]+/g, ' ').trim().replace(/\b\w/g, (letter) => letter.toUpperCase());
    return label ? label.charAt(0).toUpperCase() + label.slice(1).toLowerCase() : '-';
  }

  // Title case without lowercasing the tail (report table headings/keys).
  function titleLabel(value) {
    return String(value || '').replace(/[_-]+/g, ' ').trim().replace(/\b\w/g, (letter) => letter.toUpperCase()) || '-';
  }

  function staticText(value) {
    if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean).join('\n') || '-';
    return String(value || '').trim() || '-';
  }

  function proseOrLabel(value) {
    const text = String(value || '').trim();
    if (!text) return '-';
    const looksLikeEnum = /^[a-z0-9_-]+$/i.test(text) && !text.includes(' ');
    return looksLikeEnum ? friendlyLabel(text) : text;
  }

  function trendClass(value) {
    return `trend-${String(value || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
  }

  function colourValue(value) {
    const key = String(value || '').trim().toLowerCase().replace(/[^a-z]+/g, '_');
    const colours = {
      blue: '#2563eb',
      green: '#16a34a',
      amber: '#f59e0b',
      yellow: '#facc15',
      red: '#dc2626',
      blocked: '#7f1d1d',
      off_track: '#dc2626',
      at_risk: '#f59e0b',
      on_track: '#16a34a',
      completed: '#2563eb'
    };
    return colours[key] || '';
  }

  function renderColour(value) {
    const colour = colourValue(value);
    const label = friendlyLabel(value);
    return `<span class="colour-field" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"><span class="colour-swatch ${colour ? '' : 'unknown'}" style="${colour ? `background:${escapeHtml(colour)}` : ''}"></span></span>`;
  }

  function authMessage() {
    return 'You need to log in before changing project update data. Open /auth/login, then retry this action.';
  }

  function authedFetch(url, options = {}) {
    return fetch(url, { credentials: 'same-origin', ...options });
  }

  // Fetch + parse a project-update API endpoint, throwing an auth-aware Error on
  // failure so callers can surface a consistent message.
  async function request(path, options = {}) {
    const url = path.startsWith('http') || path.startsWith('/') ? path : `${API_BASE}/${path}`;
    const response = await authedFetch(url, options);
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || payload.ok === false) {
      const message = response.status === 401
        ? authMessage()
        : (payload && payload.error ? payload.error : `Request failed with status ${response.status}.`);
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  // ---- Project selection: single source of truth ----------------------------

  let projectCache = [];

  function getSelectedProjectId() {
    const value = localStorage.getItem(PROJECT_SELECTION_KEY) || '';
    return value ? String(value) : '';
  }

  function setSelectedProjectId(projectId) {
    if (projectId) localStorage.setItem(PROJECT_SELECTION_KEY, String(projectId));
    else localStorage.removeItem(PROJECT_SELECTION_KEY);
  }

  function clearSelectedProject() {
    localStorage.removeItem(PROJECT_SELECTION_KEY);
  }

  async function loadProjects() {
    const payload = await request('projects');
    projectCache = asArray(payload.projects);
    return projectCache;
  }

  function getCachedProjects() {
    return projectCache;
  }

  function getProject(projectId) {
    return projectCache.find((project) => String(project.projectId) === String(projectId)) || null;
  }

  window.ProjectWorkspace = {
    PROJECT_SELECTION_KEY,
    API_BASE,
    escapeHtml,
    asArray,
    dateValue,
    dateOnly,
    displayDate,
    friendlyLabel,
    sentenceLabel,
    titleLabel,
    staticText,
    proseOrLabel,
    trendClass,
    colourValue,
    renderColour,
    authMessage,
    authedFetch,
    request,
    getSelectedProjectId,
    setSelectedProjectId,
    clearSelectedProject,
    loadProjects,
    getCachedProjects,
    getProject
  };
}());
