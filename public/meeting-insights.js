(function () {
  'use strict';

  var PAGE_SIZE = 40;
  var state = { offset: 0, total: 0, loading: false, facetsLoaded: false };
  var elements = {
    search: document.getElementById('insightSearch'), searchButton: document.getElementById('searchButton'),
    type: document.getElementById('typeFilter'), person: document.getElementById('personFilter'), topic: document.getElementById('topicFilter'),
    status: document.getElementById('statusFilter'), from: document.getElementById('fromFilter'), to: document.getElementById('toFilter'),
    apply: document.getElementById('applyFilters'), clear: document.getElementById('clearFilters'),
    groups: document.getElementById('resultGroups'), count: document.getElementById('resultCount'), title: document.getElementById('resultsTitle'),
    panel: document.querySelector('.results-panel'), message: document.getElementById('insightsMessage'),
    pagination: document.getElementById('pagination'), previous: document.getElementById('previousPage'), next: document.getElementById('nextPage'), pageLabel: document.getElementById('pageLabel')
  };

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (character) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character];
    });
  }

  function formatDate(value) {
    if (!value) return '';
    var date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? value + 'T00:00:00Z' : value);
    return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date);
  }

  function typeLabel(kind) {
    return ({ decision: 'Decision', action: 'Action', question: 'Open question', discussion: 'Discussion' })[kind] || kind;
  }

  function statusLabel(status) {
    return ({ complete: 'Complete', review: 'In review', draft: 'Draft' })[status] || status || 'Draft';
  }

  function setMessage(text, kind) {
    elements.message.hidden = !text;
    elements.message.textContent = text || '';
    elements.message.className = 'message status-message' + (kind ? ' ' + kind : '');
  }

  function queryString() {
    var params = new URLSearchParams();
    var values = {
      q: elements.search.value.trim(), type: elements.type.value, person: elements.person.value,
      topic: elements.topic.value, status: elements.status.value, from: elements.from.value, to: elements.to.value
    };
    Object.keys(values).forEach(function (key) { if (values[key]) params.set(key, values[key]); });
    params.set('limit', String(PAGE_SIZE));
    params.set('offset', String(state.offset));
    return params;
  }

  function populateSelect(select, values, key) {
    var current = select.value;
    var first = select.options[0].outerHTML;
    select.innerHTML = first + values.map(function (value) {
      var item = key ? value[key] : value;
      var suffix = key && value.count ? ' (' + value.count + ')' : '';
      return '<option value="' + escapeHtml(item) + '">' + escapeHtml(item + suffix) + '</option>';
    }).join('');
    if (Array.from(select.options).some(function (option) { return option.value === current; })) select.value = current;
  }

  function renderStats(stats) {
    document.getElementById('meetingCount').textContent = stats.meetings;
    document.getElementById('decisionCount').textContent = stats.decisions;
    document.getElementById('actionCount').textContent = stats.actions;
    document.getElementById('questionCount').textContent = stats.openQuestions;
  }

  function renderDashboard(payload) {
    var row = document.getElementById('dashboardRow');
    var recent = payload.recentMeetings || [];
    var attention = payload.attention || [];
    row.hidden = !recent.length && !attention.length;
    document.getElementById('recentMeetings').innerHTML = recent.length ? recent.slice(0, 5).map(function (meeting) {
      return '<a class="mini-item" href="' + escapeHtml(meeting.resumeUrl) + '"><strong>' + escapeHtml(meeting.title) + '</strong><span>' + escapeHtml(formatDate(meeting.date || meeting.updatedAt)) + '</span></a>';
    }).join('') : '<p class="muted">No meetings have been indexed yet.</p>';
    document.getElementById('attentionItems').innerHTML = attention.length ? attention.slice(0, 5).map(function (item) {
      return '<a class="mini-item" href="' + escapeHtml(item.meeting.resumeUrl) + '"><strong>' + escapeHtml(item.text) + '</strong><span>' + escapeHtml(item.attentionReason) + '</span></a>';
    }).join('') : '<p class="muted">Nothing currently needs attention.</p>';
  }

  function evidenceHtml(evidence) {
    if (!evidence || !evidence.length) return '';
    return '<details class="evidence"><summary>Show ' + evidence.length + ' supporting transcript ' + (evidence.length === 1 ? 'passage' : 'passages') + '</summary><div class="evidence-lines">' + evidence.map(function (line) {
      return '<div class="evidence-line"><div><strong>' + escapeHtml(line.speaker || 'Speaker') + '</strong>' + (line.timestamp ? '<time>' + escapeHtml(line.timestamp) + '</time>' : '') + '</div><div>' + escapeHtml(line.text) + '</div></div>';
    }).join('') + '</div></details>';
  }

  function resultHtml(item) {
    var meta = [statusLabel(item.meeting.status), item.topic, item.people && item.people.length ? item.people.join(', ') : '', item.timing, formatDate(item.meeting.date || item.meeting.updatedAt)].filter(Boolean);
    return '<article class="insight-result" data-kind="' + escapeHtml(item.kind) + '"><div class="result-top"><div><span class="kind-label">' + escapeHtml(typeLabel(item.kind)) + '</span><p class="result-text">' + escapeHtml(item.text) + '</p></div><a class="result-source" href="' + escapeHtml(item.meeting.resumeUrl) + '">Open meeting →</a></div>'
      + '<div class="result-meta"><strong>' + escapeHtml(item.meeting.title) + '</strong>' + meta.map(function (value) { return '<span>' + escapeHtml(value) + '</span>'; }).join('') + '</div>'
      + (item.needsAttention && item.attentionReason ? '<span class="attention-note">' + escapeHtml(item.attentionReason) + '</span>' : '')
      + evidenceHtml(item.evidence) + '</article>';
  }

  function renderResults(results) {
    var order = ['decision', 'action', 'question', 'discussion'];
    var grouped = {};
    results.forEach(function (item) { (grouped[item.kind] = grouped[item.kind] || []).push(item); });
    elements.groups.innerHTML = order.filter(function (kind) { return grouped[kind] && grouped[kind].length; }).map(function (kind) {
      return '<section class="result-group"><h3>' + escapeHtml(typeLabel(kind) + (kind === 'discussion' ? ' context' : 's')) + '<span class="group-count">' + grouped[kind].length + '</span></h3><div class="result-list">' + grouped[kind].map(resultHtml).join('') + '</div></section>';
    }).join('');
    if (!results.length) elements.groups.innerHTML = '<div class="empty-state"><strong>No matching meeting knowledge</strong><p>Try fewer words, clear a filter, or process another meeting.</p></div>';
  }

  function renderPagination() {
    var page = Math.floor(state.offset / PAGE_SIZE) + 1;
    var pages = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
    elements.pagination.hidden = state.total <= PAGE_SIZE;
    elements.pageLabel.textContent = 'Page ' + page + ' of ' + pages;
    elements.previous.disabled = state.offset === 0;
    elements.next.disabled = state.offset + PAGE_SIZE >= state.total;
  }

  async function loadInsights(options) {
    options = options || {};
    if (state.loading) return;
    if (options.reset) state.offset = 0;
    state.loading = true;
    elements.panel.setAttribute('aria-busy', 'true');
    elements.searchButton.disabled = true;
    elements.count.textContent = 'Searching…';
    setMessage('');
    try {
      var response = await fetch('/api/meeting-minutes-agent/insights?' + queryString().toString(), { credentials: 'same-origin', cache: 'no-store' });
      var payload = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(payload.error || 'Meeting Insights could not be loaded.');
      renderStats(payload.stats);
      if (!state.facetsLoaded) {
        populateSelect(elements.person, payload.facets.people || []);
        populateSelect(elements.topic, payload.facets.topics || [], 'name');
        state.facetsLoaded = true;
      }
      renderDashboard(payload);
      renderResults(payload.results || []);
      state.total = payload.pagination.total;
      elements.count.textContent = state.total + ' result' + (state.total === 1 ? '' : 's');
      elements.title.textContent = elements.search.value.trim() ? 'Results from your meetings' : 'Meeting knowledge';
      renderPagination();
    } catch (error) {
      setMessage(error.message, 'error');
      elements.count.textContent = 'Could not load';
    } finally {
      state.loading = false;
      elements.searchButton.disabled = false;
      elements.panel.setAttribute('aria-busy', 'false');
    }
  }

  elements.searchButton.addEventListener('click', function () { loadInsights({ reset: true }); });
  elements.search.addEventListener('keydown', function (event) { if (event.key === 'Enter') loadInsights({ reset: true }); });
  elements.apply.addEventListener('click', function () { loadInsights({ reset: true }); });
  elements.clear.addEventListener('click', function () {
    elements.search.value = ''; elements.type.value = ''; elements.person.value = ''; elements.topic.value = '';
    elements.status.value = ''; elements.from.value = ''; elements.to.value = ''; loadInsights({ reset: true });
  });
  document.querySelectorAll('[data-example]').forEach(function (button) {
    button.addEventListener('click', function () { elements.search.value = button.dataset.example; loadInsights({ reset: true }); });
  });
  elements.previous.addEventListener('click', function () { state.offset = Math.max(0, state.offset - PAGE_SIZE); loadInsights(); elements.panel.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  elements.next.addEventListener('click', function () { state.offset += PAGE_SIZE; loadInsights(); elements.panel.scrollIntoView({ behavior: 'smooth', block: 'start' }); });

  loadInsights({ reset: true });
})();
