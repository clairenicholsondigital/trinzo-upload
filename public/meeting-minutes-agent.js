(function () {
  'use strict';

  var state = { draft: null, currentStep: 0 };
  var agentRetryDelaysSeconds = [5, 15, 30];
  // 0 details, 1 focus, 2 discussion, 3 actions, 4 summary, 5 review
  var MAX_STEP = 5;
  var STAGE_STEP = { discussion: 2, actions: 3, summary: 4 };
  var GENERATION_POLL_MS = 2000;
  var generationTimer = null;
  var saveTimer = null;
  var saveInFlight = null;
  var saveQueued = false;
  var rendering = false;
  var fileInput = document.getElementById('transcriptFile');
  var uploadZone = document.getElementById('uploadZone');
  var detailsEditor = document.getElementById('detailsEditor');
  var status = document.getElementById('workflowStatus');

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
    });
  }

  function icon(name) {
    return '<svg class="ic" aria-hidden="true"><use href="#i-' + name + '"/></svg>';
  }

  function setStatus(message, error) {
    status.textContent = message || '';
    status.hidden = !message;
    status.classList.toggle('error', Boolean(error));
  }

  function setSaveStatus(message, kind) {
    var element = document.getElementById('saveStatus');
    document.getElementById('saveStrip').hidden = !state.draft;
    element.textContent = message || '';
    element.dataset.state = kind || '';
  }

  function savedStatusText(value) {
    var savedAt = value ? new Date(value) : new Date();
    if (Number.isNaN(savedAt.getTime())) return 'Saved';
    return 'Saved at ' + savedAt.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
  }

  function setBusy(busy, message) {
    document.body.classList.toggle('busy', busy);
    status.setAttribute('aria-busy', busy ? 'true' : 'false');
    if (message) setStatus(message, false);
  }

  /* ------------------------------------------------------------------ *
   * Focus, selection and scroll survive a re-render.
   * renderAll() replaces the innerHTML of the discussion list, the action
   * table and the flag list, which happens on every autosave. Without this
   * the caret and the reader's place are destroyed roughly once a second
   * while they are typing.
   * ------------------------------------------------------------------ */
  function controlSelector(element) {
    if (!element || !element.matches || !element.matches('input,textarea,select')) return '';
    if (element.id) return '#' + element.id;
    var parts = Object.keys(element.dataset).map(function (key) {
      var attribute = key.replace(/[A-Z]/g, function (char) { return '-' + char.toLowerCase(); });
      return '[data-' + attribute + '="' + String(element.dataset[key]).replace(/"/g, '\\"') + '"]';
    });
    return parts.length ? element.tagName.toLowerCase() + parts.join('') : '';
  }

  function captureFocus() {
    var snapshot = { scrollY: window.pageYOffset };
    var element = document.activeElement;
    var selector = controlSelector(element);
    if (!selector) return snapshot;
    var matches;
    try { matches = document.querySelectorAll(selector); } catch (error) { return snapshot; }
    snapshot.selector = selector;
    snapshot.index = Array.prototype.indexOf.call(matches, element);
    // selectionStart throws on date, checkbox and radio inputs.
    try { snapshot.start = element.selectionStart; snapshot.end = element.selectionEnd; } catch (error) { snapshot.start = null; }
    return snapshot;
  }

  function restoreFocus(snapshot) {
    if (!snapshot) return;
    if (typeof snapshot.scrollY === 'number') window.scrollTo(0, snapshot.scrollY);
    if (!snapshot.selector) return;
    var matches;
    try { matches = document.querySelectorAll(snapshot.selector); } catch (error) { return; }
    var element = matches[snapshot.index >= 0 ? snapshot.index : 0];
    if (!element) return;
    element.focus({ preventScroll: true });
    if (snapshot.start == null) return;
    try { element.setSelectionRange(snapshot.start, snapshot.end); } catch (error) { /* unsupported input type */ }
  }

  async function jsonRequest(url, options) {
    var response = await fetch(url, Object.assign({ credentials: 'same-origin' }, options || {}));
    var payload = await response.json().catch(function () { return {}; });
    if (!response.ok || payload.ok === false) {
      var error = new Error(payload.error || 'The request could not be completed.');
      error.status = response.status;
      error.code = payload.code || '';
      error.retryable = payload.retryable === true;
      error.currentDraft = payload.currentDraft || null;
      throw error;
    }
    return payload;
  }

  function waitForAgentRetry(seconds, nextAttempt, totalAttempts) {
    return new Promise(function (resolve) {
      var remaining = seconds;
      function tick() {
        if (remaining <= 0) { setStatus('Retrying the agent now...', false); resolve(); return; }
        setStatus('Microsoft is temporarily busy. Retrying in ' + remaining + ' second' + (remaining === 1 ? '' : 's') + ' (attempt ' + nextAttempt + ' of ' + totalAttempts + ')...', false);
        remaining -= 1;
        window.setTimeout(tick, 1000);
      }
      tick();
    });
  }

  function participantNames() {
    var inputs = document.querySelectorAll('[data-attendee-name]');
    var names = inputs.length ? Array.from(inputs).map(function (input) { return input.value; }) : ((state.draft && state.draft.details && state.draft.details.allAttendees) || []);
    return names.map(function (name) { return name.trim(); }).filter(Boolean).filter(function (name, index, all) {
      return all.findIndex(function (candidate) { return candidate.toLowerCase() === name.toLowerCase(); }) === index;
    });
  }

  function attendeeNames(group) {
    return Array.from(document.querySelectorAll('[data-attendee-name="' + group + '"]')).map(function (input) { return input.value.trim(); }).filter(Boolean).filter(function (name, index, all) {
      return all.findIndex(function (candidate) { return candidate.toLowerCase() === name.toLowerCase(); }) === index;
    });
  }

  function attendeeChip(name, group) {
    var destination = group === 'internal' ? 'Client' : 'Internal';
    var removeLabel = 'Remove ' + (name || 'attendee');
    return '<div class="attendee-chip"><input data-attendee-name="' + group + '" value="' + escapeHtml(name || '') + '" aria-label="' + (group === 'internal' ? 'Internal' : 'Client or external') + ' attendee name" placeholder="Enter a name"><button class="secondary" data-move-attendee="' + group + '" type="button">Move to ' + destination + '</button><button class="delete icon-only" data-remove-attendee type="button" aria-label="' + escapeHtml(removeLabel) + '" title="' + escapeHtml(removeLabel) + '">' + icon('trash') + '<span class="visually-hidden">' + escapeHtml(removeLabel) + '</span></button></div>';
  }

  function renderAttendeeGroup(group, names) {
    document.getElementById(group + 'Attendees').innerHTML = (names || []).map(function (name) { return attendeeChip(name, group); }).join('');
  }

  function sourceUnits() { return (state.draft && state.draft.sourceUnits) || []; }

  function evidenceContext(ids) {
    var wanted = new Set(ids || []);
    var units = sourceUnits();
    var indexes = units.map(function (unit, index) { return wanted.has(unit.id) ? index : -1; }).filter(function (index) { return index >= 0; });
    var include = new Set();
    indexes.forEach(function (index) { [index - 1, index, index + 1].forEach(function (candidate) { if (candidate >= 0 && candidate < units.length) include.add(candidate); }); });
    return Array.from(include).sort(function (a, b) { return a - b; }).map(function (index) {
      return Object.assign({}, units[index], { cited: wanted.has(units[index].id) });
    });
  }

  function evidenceHtml(ids) {
    var context = evidenceContext(ids);
    if (!context.length) return '<p class="muted">No source passage is linked. A review flag has been added.</p>';
    return context.map(function (unit) {
      return '<div class="evidence-row' + (unit.cited ? ' cited' : '') + '"><div class="source-meta">' + escapeHtml(unit.id + ' - ' + unit.speaker + (unit.timestamp ? ' - ' + unit.timestamp : '') + (unit.cited ? ' - cited' : ' - surrounding context')) + '</div><div>' + escapeHtml(unit.text) + '</div></div>';
    }).join('');
  }

  function evidenceBlock(ids) {
    var count = (ids || []).length;
    return '<details><summary class="evidence-toggle">Evidence &middot; ' + count + '</summary><div class="evidence-panel">' + evidenceHtml(ids) + '</div></details>';
  }

  function autoGrow(root) {
    (root || document).querySelectorAll('textarea').forEach(function (area) {
      area.style.height = 'auto';
      area.style.height = Math.max(area.scrollHeight, 52) + 'px';
    });
  }

  function showStep(index, options) {
    state.currentStep = Math.max(0, Math.min(MAX_STEP, Number(index) || 0));
    var stepChanged = Boolean(state.draft) && Number(state.draft.currentStep || 0) !== state.currentStep;
    document.querySelectorAll('[data-screen]').forEach(function (screen) { screen.classList.toggle('active', Number(screen.dataset.screen) === state.currentStep); });
    document.querySelectorAll('[data-step]').forEach(function (button) {
      var step = Number(button.dataset.step);
      var draft = state.draft || {};
      var furthestStep = Math.max(Number(draft.currentStep || 0), state.currentStep);
      var unlocked = step <= furthestStep;
      button.disabled = !unlocked;
      button.classList.toggle('active', step === state.currentStep);
      button.classList.toggle('complete', step < state.currentStep);
    });
    if (state.draft) state.draft.currentStep = state.currentStep;
    autoGrow();
    if (!rendering && stepChanged) scheduleSave();
    // Only a deliberate navigation scrolls. A re-render triggered by autosave
    // must leave the reader exactly where they were.
    if (options && options.scroll) window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function setFieldValue(id, value) {
    var element = document.getElementById(id);
    if (!element || element === document.activeElement) return;
    if (element.value !== value) element.value = value;
  }

  function generationRunning(stage) {
    var generation = state.draft && state.draft.generation;
    return Boolean(generation && generation.status === 'running' && (!stage || generation.stage === stage));
  }

  function readSteer() {
    var field = document.getElementById('meetingSteer');
    if (state.draft && field) state.draft.steer = field.value;
  }

  function renderSteer() {
    var field = document.getElementById('meetingSteer');
    if (!field || field === document.activeElement) return;
    var value = (state.draft && state.draft.steer) || '';
    if (field.value !== value) field.value = value;
  }

  function readSummary() {
    if (!state.draft) return;
    var summary = document.getElementById('executiveSummary');
    if (summary) state.draft.executiveSummary = summary.value.trim();
    state.draft.meetingObjectives = Array.from(document.querySelectorAll('[data-objective-index]'))
      .map(function (field) { return field.value.trim(); })
      .filter(Boolean);
  }

  function renderSummary() {
    var draft = state.draft || {};
    var summary = document.getElementById('executiveSummary');
    if (summary && summary !== document.activeElement) {
      var value = draft.executiveSummary || '';
      if (summary.value !== value) summary.value = value;
    }
    var objectives = draft.meetingObjectives || [];
    document.getElementById('objectivesList').innerHTML = objectives.map(function (text, index) {
      return '<div class="record-row"><textarea data-objective-index="' + index + '" rows="2" aria-label="Objective ' + (index + 1) + '">' + escapeHtml(text) + '</textarea><div class="record-tools"><button class="delete quiet" data-remove-objective="' + index + '" type="button">Remove</button></div></div>';
    }).join('') || '<p class="muted record-empty">None yet. Generate them, or add one by hand.</p>';
    autoGrow(document.getElementById('objectivesList'));
  }

  function readDetails() {
    if (!state.draft) return {};
    var internalAttendees = attendeeNames('internal');
    var clientAttendees = attendeeNames('client');
    state.draft.details = {
      meetingTitle: document.getElementById('meetingTitle').value.trim(),
      meetingDate: document.getElementById('meetingDate').value,
      meetingLocation: document.getElementById('meetingLocation').value.trim(),
      meetingType: document.getElementById('meetingType').value.trim(),
      clientAttendeeLabel: document.getElementById('clientAttendeeLabelSelect').value === 'External' ? 'External' : 'Client',
      internalAttendees: internalAttendees,
      clientAttendees: clientAttendees,
      allAttendees: internalAttendees.concat(clientAttendees)
    };
    return state.draft.details;
  }

  function renderDetails() {
    var draft = state.draft || {};
    var details = draft.details || {};
    setFieldValue('meetingTitle', details.meetingTitle || '');
    setFieldValue('meetingDate', details.meetingDate || '');
    setFieldValue('meetingLocation', details.meetingLocation || '');
    setFieldValue('meetingType', details.meetingType || '');
    renderAttendeeGroup('internal', details.internalAttendees || []);
    renderAttendeeGroup('client', details.clientAttendees || []);
    setFieldValue('clientAttendeeLabelSelect', details.clientAttendeeLabel === 'External' ? 'External' : 'Client');
    document.getElementById('clientAttendeeHeading').textContent = details.clientAttendeeLabel === 'External' ? 'External' : 'Client';
    var denoise = draft.denoise || {};
    document.getElementById('denoiseSummary').textContent = denoise.totalUnitCount ? denoise.keptUnitCount + ' of ' + denoise.totalUnitCount + ' passages retained' : '';
  }

  async function prepareFile(file) {
    if (!file) return;
    if (!/\.docx$/i.test(file.name)) return setStatus('Choose a Word .docx transcript.', true);
    var form = new FormData(); form.append('file', file);
    setBusy(true, 'Reading the Word document and preparing the transcript...');
    try {
      var payload = await jsonRequest('/api/meeting-minutes-agent/prepare', { method: 'POST', body: form });
      adoptDraft(payload.draft);
      history.replaceState(null, '', payload.resumeUrl || ('/meeting-minutes-agent?draftId=' + encodeURIComponent(state.draft.draftId)));
      setStatus('Transcript prepared. Check the meeting details before continuing.', false);
    } catch (error) { setStatus(error.message, true); }
    finally { setBusy(false); }
  }

  function pointSection(topic, topicIndex, field, heading) {
    var rows = topic[field] || [];
    var labels = { points: 'Discussion point', decisions: 'Decision', openQuestions: 'Open question' };
    var rowLabel = labels[field] || 'Item';
    return '<div class="record-section"><div class="record-section-head"><h3>' + escapeHtml(heading) + '</h3></div><div class="record-list">' + (rows.map(function (item, itemIndex) {
      return '<div class="record-row"><textarea data-record-field="' + field + '" data-topic-index="' + topicIndex + '" data-item-index="' + itemIndex + '" aria-label="' + escapeHtml(rowLabel + ' ' + (itemIndex + 1)) + '">' + escapeHtml(item.text || '') + '</textarea><div class="record-tools">' + evidenceBlock(item.evidenceIds) + '<button class="delete quiet" data-remove-record="' + field + '" data-topic-index="' + topicIndex + '" data-item-index="' + itemIndex + '" type="button">Remove</button></div></div>';
    }).join('') || '<p class="muted record-empty">None recorded.</p>') + '</div><button class="secondary add-record" data-add-record="' + field + '" data-topic-index="' + topicIndex + '" type="button">Add ' + escapeHtml(rowLabel.toLowerCase()) + '</button></div>';
  }

  function renderDiscussion() {
    if (generationRunning('discussion')) {
      document.getElementById('discussionList').innerHTML = '<p class="generating">The agent is drafting the discussion from your transcript. This keeps running if you close the tab &mdash; the draft will be waiting in your Library.</p>';
      return;
    }
    var discussion = (state.draft && state.draft.discussion) || [];
    document.getElementById('discussionList').innerHTML = discussion.map(function (topic, index) {
      return '<article class="discussion-card"><div class="card-head"><label class="topic-field"><span class="visually-hidden">Discussion topic</span><input data-topic-index="' + index + '" data-topic value="' + escapeHtml(topic.topic || '') + '" aria-label="Discussion topic" placeholder="Topic"></label><button class="delete" data-delete-topic="' + index + '" type="button">Remove topic</button></div>' + pointSection(topic, index, 'points', 'Discussion') + pointSection(topic, index, 'decisions', 'Decisions') + pointSection(topic, index, 'openQuestions', 'Open questions') + '</article>';
    }).join('') || '<p class="muted">No discussion content has been generated.</p>';
    autoGrow(document.getElementById('discussionList'));
  }

  function readDiscussion() {
    if (!state.draft) return [];
    document.querySelectorAll('[data-topic]').forEach(function (input) {
      var topic = state.draft.discussion[Number(input.dataset.topicIndex)];
      if (topic) topic.topic = input.value.trim();
    });
    document.querySelectorAll('[data-record-field]').forEach(function (area) {
      var topic = state.draft.discussion[Number(area.dataset.topicIndex)];
      var list = topic && topic[area.dataset.recordField];
      if (list && list[Number(area.dataset.itemIndex)]) list[Number(area.dataset.itemIndex)].text = area.value.trim();
    });
    return state.draft.discussion;
  }

  function ownerEditor(action, index) {
    var owners = action.owners || [];
    var taken = owners.map(function (owner) { return owner.toLowerCase(); });
    var available = participantNames().filter(function (name) { return taken.indexOf(name.toLowerCase()) < 0; });
    var chips = owners.map(function (owner) {
      return '<span class="owner-chip" data-owner-chip data-action-index="' + index + '" data-owner="' + escapeHtml(owner) + '">' + escapeHtml(owner) + '<button type="button" data-remove-owner data-action-index="' + index + '" data-owner="' + escapeHtml(owner) + '" aria-label="Remove owner ' + escapeHtml(owner) + '">&times;</button></span>';
    }).join('') || '<span class="muted">Not stated</span>';
    var options = available.map(function (name) {
      return '<option value="' + escapeHtml(name) + '">' + escapeHtml(name) + '</option>';
    }).join('');
    return '<div class="owner-chips">' + chips + '</div><div class="owner-add"><select data-add-owner data-action-index="' + index + '" aria-label="Add an attendee as owner"><option value="">Add owner...</option>' + options + '<option value="__other">Someone else...</option></select><input data-owner-other data-action-index="' + index + '" placeholder="Name" aria-label="Add another owner by name" hidden></div>';
  }

  function timingEditor(timing, index) {
    var kinds = [['not_stated', 'Not stated'], ['target', 'Target'], ['deadline', 'Deadline'], ['dependency', 'Dependency']];
    var segments = kinds.map(function (pair) {
      var checked = timing.kind === pair[0] ? ' checked' : '';
      return '<label><input type="radio" name="timing-' + index + '" value="' + pair[0] + '" data-timing-kind data-action-index="' + index + '"' + checked + '><span>' + pair[1] + '</span></label>';
    }).join('');
    return '<div class="timing-editor"><div class="seg" role="radiogroup" aria-label="Timing kind">' + segments + '</div><input data-timing-wording data-action-index="' + index + '" value="' + escapeHtml(timing.wording || '') + '" placeholder="e.g. this week" aria-label="Timing wording"><input data-timing-date data-action-index="' + index + '" type="date" value="' + escapeHtml(timing.exactDate || '') + '" aria-label="Exact date"></div>';
  }

  function renderActions() {
    var actions = (state.draft && state.draft.actions) || [];
    document.getElementById('actionsBody').innerHTML = actions.map(function (item, index) {
      var timing = item.timing || {kind:'not_stated',wording:'',exactDate:''};
      return '<tr data-action-row="' + index + '"><td data-label="Action"><textarea data-action-index="' + index + '" data-action aria-label="Action ' + (index + 1) + '">' + escapeHtml(item.action || '') + '</textarea><div class="action-tools">' + evidenceBlock(item.evidenceIds) + '<button class="delete quiet" data-delete-action="' + index + '" type="button">Remove</button></div></td><td data-label="Owners">' + ownerEditor(item, index) + '</td><td data-label="Timing">' + timingEditor(timing, index) + '</td></tr>';
    }).join('') || '<tr><td colspan="3" class="muted">No actions have been generated.</td></tr>';
    autoGrow(document.getElementById('actionsBody'));
  }

  function rerenderActions() {
    var snapshot = captureFocus();
    renderActions();
    restoreFocus(snapshot);
  }

  function readActions() {
    if (!state.draft) return [];
    // Scoped to each row: the previous version issued four document-wide
    // querySelectorAll calls per action, on every keystroke.
    document.querySelectorAll('#actionsBody [data-action-row]').forEach(function (row) {
      var action = state.draft.actions[Number(row.dataset.actionRow)];
      if (!action) return;
      var area = row.querySelector('[data-action]');
      if (area) action.action = area.value.trim();
      action.owners = Array.from(row.querySelectorAll('[data-owner-chip]')).map(function (chip) { return chip.dataset.owner; }).filter(Boolean);
      var kind = row.querySelector('[data-timing-kind]:checked');
      var wording = row.querySelector('[data-timing-wording]');
      var date = row.querySelector('[data-timing-date]');
      action.timing = { kind: kind ? kind.value : 'not_stated', wording: wording ? wording.value.trim() : '', exactDate: date ? date.value : '' };
    });
    return state.draft.actions;
  }

  function addOwner(index, name) {
    var owner = String(name || '').trim();
    if (!owner) return false;
    readActions();
    var action = state.draft && state.draft.actions[index];
    if (!action) return false;
    var existing = (action.owners || []).some(function (value) { return value.toLowerCase() === owner.toLowerCase(); });
    if (existing) return false;
    action.owners = (action.owners || []).concat(owner);
    return true;
  }

  function renderFlags() {
    var flags = (state.draft && state.draft.reviewFlags) || [];
    var open = flags.filter(function (flag) { return flag.status === 'open'; });
    var panel = document.getElementById('reviewFlags');
    var wasHidden = panel.hidden;
    panel.hidden = !flags.length;
    if (flags.length && wasHidden) panel.open = false;
    document.getElementById('flagCount').textContent = open.length + ' open';
    var flagLabels = { uncertain_fact:'Uncertain detail', unclear_reference:'Reference to check', ownership:'Owner to check', timing:'Timing to check', unresolved_decision:'Open decision', missing_evidence:'Source evidence needed', possible_missed_follow_up:'Possible missed follow-up' };
    document.getElementById('flagList').innerHTML = flags.map(function (flag, index) {
      var label = flagLabels[flag.kind] || flag.kind.replace(/_/g, ' ').replace(/\b\w/g, function (letter) { return letter.toUpperCase(); });
      var body = '<span class="flag-kind">' + escapeHtml(label) + '</span><div class="flag-message">' + escapeHtml(flag.message) + '</div>';
      if (flag.status === 'open') {
        body += '<input data-flag-correction="' + index + '" value="' + escapeHtml(flag.correctionNote || '') + '" placeholder="Add a correction note (optional)" aria-label="Correction note">';
      } else if (flag.correctionNote) {
        body += '<div class="muted">Correction: ' + escapeHtml(flag.correctionNote) + '</div>';
      }
      if ((flag.evidenceIds || []).length) body += evidenceBlock(flag.evidenceIds);
      // One primary: "Looks correct" is the answer a reviewer gives most often.
      var actions = flag.status === 'open'
        ? '<button class="button" data-flag-index="' + index + '" data-flag-status="confirmed" type="button">Looks correct</button><button class="secondary" data-flag-index="' + index + '" data-flag-status="corrected" type="button">Save correction</button><button class="secondary quiet" data-flag-index="' + index + '" data-flag-status="dismissed" type="button">Dismiss</button>'
        : '<button class="secondary" data-flag-index="' + index + '" data-flag-status="open" type="button">Reopen</button>';
      return '<div class="flag' + (flag.status === 'open' ? '' : ' resolved') + '"><div>' + body + '</div><div class="flag-actions">' + actions + '</div></div>';
    }).join('');
  }

  function proposalRecord(value) {
    if (!value) return 'Removed';
    if (value.action) return value.action + (value.owners && value.owners.length ? ' - ' + value.owners.join(', ') : '');
    return value.topic || value.text || JSON.stringify(value);
  }

  function renderProposal() {
    var proposal = state.draft && state.draft.pendingProposal;
    var panel = document.getElementById('proposalPanel');
    panel.hidden = !proposal || !(proposal.changes || []).length;
    if (panel.hidden) return;
    var changeLabels = { add:'New item', modify:'Suggested edit', remove:'Suggested removal' };
    document.getElementById('proposalChanges').innerHTML = proposal.changes.map(function (change) {
      var content;
      if (change.before && change.after) {
        content = '<div class="proposal-comparison"><div><div class="proposal-value-label">Before</div><pre>' + escapeHtml(proposalRecord(change.before)) + '</pre></div><div><div class="proposal-value-label">Proposed</div><pre>' + escapeHtml(proposalRecord(change.after)) + '</pre></div></div>';
      } else {
        content = '<pre>' + escapeHtml(proposalRecord(change.after || change.before)) + '</pre>';
      }
      return '<label class="proposal-change"><input type="checkbox" data-proposal-change="' + escapeHtml(change.id) + '" checked><span class="proposal-kind">' + escapeHtml(changeLabels[change.type] || 'Suggested change') + '</span><div class="proposal-content">' + content + '</div></label>';
    }).join('');
    panel.scrollIntoView({behavior:'smooth',block:'nearest'});
  }

  function formatUkDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return value || '';
    return new Intl.DateTimeFormat('en-GB', {day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}).format(new Date(value + 'T00:00:00Z'));
  }

  function timingText(timing) {
    timing = timing || {};
    if (timing.kind === 'not_stated' || (!timing.wording && !timing.exactDate)) return 'Not stated';
    var prefix = timing.kind === 'target' ? 'Target: ' : (timing.kind === 'dependency' ? 'Dependent on: ' : 'Deadline: ');
    return prefix + (timing.exactDate ? formatUkDate(timing.exactDate) : timing.wording);
  }

  function renderFinal() {
    readDetails(); readSteer(); readDiscussion(); readActions(); readSummary();
    var draft = state.draft || {}; var details = draft.details || {};
    var objectives = (draft.meetingObjectives || []).filter(Boolean);
    var summaryHtml = (objectives.length ? '<section><h3>Meeting objectives</h3><ul>' + objectives.map(function (item) { return '<li>' + escapeHtml(item) + '</li>'; }).join('') + '</ul></section>' : '')
      + (draft.executiveSummary ? '<section><h3>Executive summary</h3><p>' + escapeHtml(draft.executiveSummary) + '</p></section>' : '');
    var decisions = (draft.discussion || []).flatMap(function (topic) { return (topic.decisions || []).map(function (item) { return {topic:topic.topic,text:item.text}; }); });
    var questions = (draft.discussion || []).flatMap(function (topic) { return (topic.openQuestions || []).map(function (item) { return {topic:topic.topic,text:item.text}; }); });
    document.getElementById('finalDocument').innerHTML = '<h2>' + escapeHtml(details.meetingTitle || 'Meeting minutes') + '</h2><p><strong>Date:</strong> ' + escapeHtml(details.meetingDate ? formatUkDate(details.meetingDate) : 'Not stated') + '<br><strong>Location:</strong> ' + escapeHtml(details.meetingLocation || 'Not stated') + '<br><strong>Meeting type:</strong> ' + escapeHtml(details.meetingType || 'Not stated') + '</p><p><strong>Internal attendees:</strong> ' + escapeHtml((details.internalAttendees || []).join(', ') || 'Not stated') + '<br><strong>' + escapeHtml(details.clientAttendeeLabel === 'External' ? 'External' : 'Client') + ' attendees:</strong> ' + escapeHtml((details.clientAttendees || []).join(', ') || 'Not stated') + '</p>' + summaryHtml + '<section><h3>Discussion</h3>' + ((draft.discussion || []).map(function (topic) { return '<h4>' + escapeHtml(topic.topic) + '</h4><ul>' + (topic.points || []).map(function (point) { return '<li>' + escapeHtml(point.text) + '</li>'; }).join('') + '</ul>'; }).join('') || '<p>No discussion recorded.</p>') + '</section><section><h3>Decisions</h3>' + (decisions.length ? '<ul>' + decisions.map(function (item) { return '<li><strong>' + escapeHtml(item.topic) + ':</strong> ' + escapeHtml(item.text) + '</li>'; }).join('') + '</ul>' : '<p>No decisions recorded.</p>') + '</section><section><h3>Open questions</h3>' + (questions.length ? '<ul>' + questions.map(function (item) { return '<li><strong>' + escapeHtml(item.topic) + ':</strong> ' + escapeHtml(item.text) + '</li>'; }).join('') + '</ul>' : '<p>No open questions recorded.</p>') + '</section><section><h3>Actions</h3><div class="actions-wrap"><table class="actions-table"><thead><tr><th>Action</th><th>Owners</th><th>Timing</th></tr></thead><tbody>' + ((draft.actions || []).map(function (action) { return '<tr><td>' + escapeHtml(action.action) + '</td><td>' + escapeHtml((action.owners || []).join(', ') || 'Not stated') + '</td><td>' + escapeHtml(timingText(action.timing)) + '</td></tr>'; }).join('') || '<tr><td colspan="3">No actions recorded.</td></tr>') + '</tbody></table></div></section>';
  }

  function renderAll() {
    var snapshot = captureFocus();
    rendering = true;
    uploadZone.hidden = Boolean(state.draft);
    detailsEditor.hidden = !state.draft;
    document.getElementById('saveStrip').hidden = !state.draft;
    if (state.draft) {
      renderDetails(); renderSteer(); renderDiscussion(); renderActions(); renderSummary(); renderFlags(); renderProposal();
      var busyStage = generationRunning();
      ['generateActions', 'addDiscussion', 'applyDiscussionEdit', 'generateSummary'].forEach(function (id) {
        var button = document.getElementById(id);
        if (button) button.disabled = busyStage;
      });
      var stale = state.draft.staleStages || [];
      document.getElementById('staleNotice').hidden = !stale.length;
      document.getElementById('staleStages').textContent = stale.join(' and ');
    } else document.getElementById('staleNotice').hidden = true;
    showStep(state.draft ? Math.max(Number(state.draft.currentStep) || 0, state.currentStep || 0) : 0);
    rendering = false;
    restoreFocus(snapshot);
  }

  function adoptDraft(draft) {
    if (!draft) return;
    document.getElementById('reloadDraft').hidden = true;
    state.draft = draft;
    // Never navigate the reviewer backwards. A background run finishing while they
    // have moved on would otherwise yank them back to the screen the server last
    // recorded - which is the screen they were on when the run started.
    state.currentStep = Math.max(Number(draft.currentStep) || 0, state.currentStep || 0);
    renderAll();
    // A reload in the middle of a run must not look dead.
    if (generationRunning()) pollGeneration();
    setSaveStatus(savedStatusText(draft.updatedAt), 'saved');
  }

  function readEditors() { if (!state.draft) return; readDetails(); readSteer(); readDiscussion(); readActions(); readSummary(); state.draft.currentStep = state.currentStep; }

  function draftPatchBody(statusValue) {
    var body = {
      revision: state.draft.revision,
      // Tells the server this client speaks the six-step numbering. A tab loaded
      // before the deploy will not send it, and its currentStep is then ignored
      // rather than being read as a screen it did not mean.
      payloadVersion: 3,
      details: state.draft.details,
      steer: state.draft.steer || '',
      discussion: state.draft.discussion,
      actions: state.draft.actions,
      executiveSummary: state.draft.executiveSummary || '',
      meetingObjectives: state.draft.meetingObjectives || [],
      reviewFlags: state.draft.reviewFlags,
      currentStep: state.currentStep
    };
    if (statusValue) body.status = statusValue;
    return body;
  }

  function draftUrl(suffix) {
    return '/api/meeting-minutes-agent/drafts/' + encodeURIComponent(state.draft.draftId) + (suffix || '');
  }

  function scheduleSave() {
    if (rendering || !state.draft) return;
    setSaveStatus('Unsaved changes - saving shortly...', 'dirty');
    clearTimeout(saveTimer);
    // While a background run is in flight, hold the save. Its completion writes
    // against a fresh read, so letting an autosave race it would surface the
    // conflict banner over the reviewer's own generation. Flushed on completion.
    if (generationRunning()) return;
    saveTimer = window.setTimeout(function () { saveDraftNow(); }, 900);
  }

  async function saveDraftNow(statusValue) {
    if (!state.draft) return null;
    clearTimeout(saveTimer);
    if (saveInFlight) { saveQueued = true; await saveInFlight; if (!saveQueued) return state.draft; saveQueued = false; }
    readEditors();
    setSaveStatus('Saving...', 'saving');
    saveInFlight = jsonRequest(draftUrl(), {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(draftPatchBody(statusValue))}).then(function (payload) {
      adoptDraft(payload.draft); return state.draft;
    }).catch(function (error) {
      // A conflict used to adopt the server copy, silently destroying the edits
      // the message was warning about. Keep them on screen and let the reviewer
      // decide to take the saved version instead.
      if (error.currentDraft) {
        document.getElementById('reloadDraft').hidden = false;
        setSaveStatus('Changed elsewhere - your edits are here but unsaved.', 'error');
        throw error;
      }
      setSaveStatus(error.message, 'error'); throw error;
    }).finally(function () { saveInFlight = null; });
    return saveInFlight;
  }

  // Kicks a stage off server-side and returns straight away, so the reviewer can
  // read while it runs. The server keeps going even if this tab closes.
  async function startBackgroundStage(stage) {
    if (!state.draft) return;
    try { await saveDraftNow(); } catch (error) { setStatus(error.message, true); return; }
    try {
      var payload = await jsonRequest(draftUrl('/generate-background'), {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({stage:stage,revision:state.draft.revision})});
      adoptDraft(payload.draft);
      state.draft.generation = payload.generation;
      showStep(STAGE_STEP[stage], { scroll: true });
      renderDiscussion();
      setStatus('Working on the discussion now. You can keep reading.', false);
      pollGeneration();
    } catch (error) { setStatus(error.message, true); }
  }

  function pollGeneration() {
    clearTimeout(generationTimer);
    if (!state.draft || !generationRunning()) return;
    generationTimer = window.setTimeout(async function () {
      if (!state.draft) return;
      try {
        var payload = await jsonRequest(draftUrl('/generation'));
        state.draft.generation = payload.generation;
        if (payload.generation && payload.generation.status === 'running') { pollGeneration(); return; }
        if (payload.draft) {
          // The run wrote one content field the reviewer could not have edited,
          // because it did not exist while it ran. Everything they CAN have
          // touched meanwhile is carried across explicitly rather than adopted.
          var localDetails = state.draft.details;
          var localSteer = state.draft.steer;
          adoptDraft(payload.draft);
          state.draft.details = localDetails;
          state.draft.steer = localSteer;
          state.draft.generation = payload.generation;
          renderDetails();
          renderSteer();
          renderDiscussion();
        }
        if (payload.generation && payload.generation.status === 'failed') {
          setStatus(payload.generation.error || 'The agent could not finish. Try generating again.', true);
        } else {
          setStatus('Discussion draft generated. Review its evidence and flags.', false);
        }
        scheduleSave();
      } catch (error) { setStatus(error.message, true); }
    }, GENERATION_POLL_MS);
  }

  async function runAgent(stage, instruction) {
    if (!state.draft) return false;
    try { await saveDraftNow(); } catch (error) { setStatus(error.message, true); return false; }
    setBusy(true, instruction ? 'The agent is preparing a change preview...' : 'The agent is reviewing the prepared transcript...');
    try {
      var payload; var totalAttempts = agentRetryDelaysSeconds.length + 1;
      for (var attempt = 0; attempt < totalAttempts; attempt += 1) {
        if (attempt > 0) await waitForAgentRetry(agentRetryDelaysSeconds[attempt - 1], attempt + 1, totalAttempts);
        try {
          payload = await jsonRequest('/api/meeting-minutes-agent/generate', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({stage:stage,draftId:state.draft.draftId,revision:state.draft.revision,instruction:instruction || ''})});
          break;
        } catch (error) {
          if (!(error.code === 'M365_AGENT_USAGE_LIMIT' && error.retryable) || attempt === totalAttempts - 1) throw error;
        }
      }
      adoptDraft(payload.draft);
      if (instruction) { renderProposal(); setStatus('Review the proposed changes. Nothing has been applied yet.', false); }
      else {
        showStep(STAGE_STEP[stage] || 2, { scroll: true });
        setStatus(stage === 'discussion' ? 'Discussion draft generated. Review its evidence and flags.' : 'Action draft generated. Running the separate missed-action check next.', false);
        if (stage === 'actions') await auditActions(true);
      }
      return true;
    } catch (error) { setStatus(error.message, true); return false; }
    finally { setBusy(false); }
  }

  async function auditActions(automatic) {
    if (!state.draft) return;
    try { await saveDraftNow(); } catch (error) { setStatus(error.message, true); return; }
    setBusy(true, 'Checking the transcript for missed follow-up actions...');
    try {
      var payload; var totalAttempts = agentRetryDelaysSeconds.length + 1;
      for (var attempt = 0; attempt < totalAttempts; attempt += 1) {
        if (attempt > 0) await waitForAgentRetry(agentRetryDelaysSeconds[attempt - 1], attempt + 1, totalAttempts);
        try {
          payload = await jsonRequest(draftUrl('/audit-actions'), {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:state.draft.revision})});
          break;
        } catch (error) {
          if (!(error.code === 'M365_AGENT_USAGE_LIMIT' && error.retryable) || attempt === totalAttempts - 1) throw error;
        }
      }
      adoptDraft(payload.draft);
      setStatus(payload.proposal ? 'The completeness check found proposed actions. Review them before applying.' : 'The completeness check found no additional supported actions.', false);
    } catch (error) { setStatus((automatic ? 'The action draft is available, but the completeness check failed: ' : '') + error.message, true); }
    finally { setBusy(false); }
  }

  async function reviewProposal(decision, acceptAll) {
    var proposal = state.draft && state.draft.pendingProposal; if (!proposal) return;
    var ids = Array.from(document.querySelectorAll('[data-proposal-change]:checked')).map(function (input) { return input.dataset.proposalChange; });
    try { await saveDraftNow(); } catch (error) { setStatus(error.message, true); return; }
    setBusy(true, decision === 'reject' ? 'Rejecting proposed changes...' : 'Applying selected changes...');
    try {
      var payload = await jsonRequest(draftUrl('/proposal'), {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:state.draft.revision,decision:decision,acceptAll:Boolean(acceptAll),changeIds:ids})});
      adoptDraft(payload.draft); setStatus(decision === 'reject' ? 'Proposed changes rejected.' : 'Selected agent changes applied.', false);
    } catch (error) { setStatus(error.message, true); }
    finally { setBusy(false); }
  }

  async function downloadExport(kind) {
    var isPdf = kind === 'pdf';
    try { await saveDraftNow('complete'); } catch (error) { return setStatus(error.message, true); }
    setBusy(true, isPdf ? 'Generating your PDF...' : 'Creating the Word document...');
    try {
      var response = await fetch(draftUrl(isPdf ? '/export.pdf' : '/export.docx'), {method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({includeEvidence:document.getElementById('includeEvidence').checked})});
      if (!response.ok) {
        var problem = await response.json().catch(function () { return {}; });
        throw new Error(problem.error || (isPdf ? 'The PDF could not be generated.' : 'The Word document could not be created.'));
      }
      var blob = await response.blob();
      var disposition = response.headers.get('content-disposition') || '';
      var match = disposition.match(/filename="([^"]+)"/i);
      var url = URL.createObjectURL(blob);
      var link = document.createElement('a');
      link.href = url;
      link.download = match ? match[1] : (isPdf ? 'Meeting minutes.pdf' : 'Meeting minutes.docx');
      document.body.appendChild(link); link.click(); link.remove();
      window.setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
      setStatus(isPdf ? 'PDF downloaded.' : 'Word document downloaded.', false);
    } catch (error) { setStatus(error.message, true); }
    finally { setBusy(false); }
  }

  async function loadDraft(draftId) {
    setBusy(true, 'Loading your saved draft...');
    try { var payload = await jsonRequest('/api/meeting-minutes-agent/drafts/' + encodeURIComponent(draftId)); adoptDraft(payload.draft); setStatus('Saved draft restored.', false); }
    catch (error) { setStatus(error.message, true); }
    finally { setBusy(false); }
  }

  /* ------------------------------------------------------------ events */
  uploadZone.addEventListener('click', function (event) { if (event.target.id !== 'chooseFile') fileInput.click(); });
  document.getElementById('chooseFile').addEventListener('click', function (event) { event.stopPropagation(); fileInput.click(); });
  uploadZone.addEventListener('keydown', function (event) { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); fileInput.click(); } });
  ['dragenter','dragover'].forEach(function (name) { uploadZone.addEventListener(name, function (event) { event.preventDefault(); uploadZone.classList.add('dragover'); }); });
  ['dragleave','drop'].forEach(function (name) { uploadZone.addEventListener(name, function (event) { event.preventDefault(); uploadZone.classList.remove('dragover'); }); });
  uploadZone.addEventListener('drop', function (event) { if (event.dataTransfer && event.dataTransfer.files.length) prepareFile(event.dataTransfer.files[0]); });
  fileInput.addEventListener('change', function () { prepareFile(fileInput.files[0]); });
  document.getElementById('replaceTranscript').addEventListener('click', function () { fileInput.value=''; fileInput.click(); });

  detailsEditor.addEventListener('click', function (event) {
    var add = event.target.closest('[data-add-attendee]');
    var move = event.target.closest('[data-move-attendee]');
    var remove = event.target.closest('[data-remove-attendee]');
    if (add) {
      var group = add.dataset.addAttendee;
      document.getElementById(group + 'Attendees').insertAdjacentHTML('beforeend', attendeeChip('', group));
      var addedInputs = document.querySelectorAll('[data-attendee-name="' + group + '"]');
      if (addedInputs.length) addedInputs[addedInputs.length - 1].focus();
      return;
    }
    if (move) {
      var chip = move.closest('.attendee-chip');
      var input = chip && chip.querySelector('[data-attendee-name]');
      var destination = move.dataset.moveAttendee === 'internal' ? 'client' : 'internal';
      document.getElementById(destination + 'Attendees').insertAdjacentHTML('beforeend', attendeeChip(input ? input.value : '', destination));
      chip.remove();
    } else if (remove) {
      remove.closest('.attendee-chip').remove();
    }
    if (move || remove) { readDetails(); rerenderActions(); scheduleSave(); }
  });

  document.getElementById('clientAttendeeLabelSelect').addEventListener('change', function (event) {
    document.getElementById('clientAttendeeHeading').textContent = event.target.value === 'External' ? 'External' : 'Client';
  });
  document.getElementById('toSteer').addEventListener('click', function () { readDetails(); showStep(1, { scroll: true }); });
  document.getElementById('startDiscussion').addEventListener('click', function () { readSteer(); startBackgroundStage('discussion'); });
  document.getElementById('toSummary').addEventListener('click', function () { readActions(); showStep(4, { scroll: true }); });
  document.getElementById('generateSummary').addEventListener('click', function () { runAgent('summary',''); });
  document.getElementById('addObjective').addEventListener('click', function () {
    readSummary();
    state.draft.meetingObjectives = (state.draft.meetingObjectives || []).concat('');
    renderSummary();
    var fields = document.querySelectorAll('[data-objective-index]');
    if (fields.length) fields[fields.length - 1].focus();
  });
  document.getElementById('objectivesList').addEventListener('click', function (event) {
    var button = event.target.closest('[data-remove-objective]');
    if (!button) return;
    readSummary();
    state.draft.meetingObjectives.splice(Number(button.dataset.removeObjective), 1);
    renderSummary();
    scheduleSave();
  });
  document.getElementById('generateActions').addEventListener('click', function () { runAgent('actions',''); });
  document.getElementById('auditActions').addEventListener('click', function () { auditActions(false); });
  document.getElementById('applyDiscussionEdit').addEventListener('click', function () { var input=document.getElementById('discussionInstruction'); if (!input.value.trim()) return setStatus('Describe the discussion edits you want.',true); runAgent('discussion',input.value.trim()).then(function(ok){if(ok)input.value='';}); });
  document.getElementById('applyActionsEdit').addEventListener('click', function () { var input=document.getElementById('actionsInstruction'); if (!input.value.trim()) return setStatus('Describe the action edits you want.',true); runAgent('actions',input.value.trim()).then(function(ok){if(ok)input.value='';}); });
  document.getElementById('addDiscussion').addEventListener('click', function () { readDiscussion(); state.draft.discussion.push({id:'manual-topic-'+Date.now(),topic:'',points:[],decisions:[],openQuestions:[]}); renderDiscussion(); scheduleSave(); });

  document.getElementById('discussionList').addEventListener('click', function (event) {
    var add=event.target.closest('[data-add-record]');
    var remove=event.target.closest('[data-remove-record]');
    var topicButton=event.target.closest('[data-delete-topic]');
    if(!add && !remove && !topicButton) return;
    readDiscussion();
    if(add){state.draft.discussion[Number(add.dataset.topicIndex)][add.dataset.addRecord].push({id:'manual-'+Date.now(),text:'',evidenceIds:[],reviewFlagIds:[]});}
    if(remove){state.draft.discussion[Number(remove.dataset.topicIndex)][remove.dataset.removeRecord].splice(Number(remove.dataset.itemIndex),1);}
    if(topicButton){state.draft.discussion.splice(Number(topicButton.dataset.deleteTopic),1);}
    renderDiscussion();
    scheduleSave();
  });

  document.getElementById('actionsBody').addEventListener('click', function (event) {
    var removeOwner = event.target.closest('[data-remove-owner]');
    if (removeOwner) {
      readActions();
      var owned = state.draft.actions[Number(removeOwner.dataset.actionIndex)];
      if (owned) owned.owners = (owned.owners || []).filter(function (name) { return name !== removeOwner.dataset.owner; });
      rerenderActions(); scheduleSave();
      return;
    }
    var button = event.target.closest('[data-delete-action]');
    if (!button) return;
    readActions();
    state.draft.actions.splice(Number(button.dataset.deleteAction),1);
    renderActions(); scheduleSave();
  });

  document.getElementById('actionsBody').addEventListener('change', function (event) {
    var select = event.target.closest('[data-add-owner]');
    if (!select || !select.value) return;
    var index = Number(select.dataset.actionIndex);
    if (select.value === '__other') {
      var other = select.parentElement.querySelector('[data-owner-other]');
      select.value = '';
      if (other) { other.hidden = false; other.focus(); }
      return;
    }
    if (addOwner(index, select.value)) { rerenderActions(); scheduleSave(); }
    else select.value = '';
  });

  function commitOtherOwner(input) {
    if (!input) return;
    if (!input.value.trim()) { input.hidden = true; return; }
    var index = Number(input.dataset.actionIndex);
    var added = addOwner(index, input.value);
    input.value = '';
    if (!added) return;
    renderActions();
    // The field this was typed into is hidden again by the re-render, so focus
    // has to be placed deliberately or it falls back to <body> and the tab
    // order restarts at the top of the page.
    var select = document.querySelector('#actionsBody [data-action-row="' + index + '"] [data-add-owner]');
    if (select) select.focus({ preventScroll: true });
    scheduleSave();
  }
  document.getElementById('actionsBody').addEventListener('keydown', function (event) {
    if (event.key !== 'Enter') return;
    var input = event.target.closest('[data-owner-other]');
    if (!input) return;
    event.preventDefault();
    commitOtherOwner(input);
  });
  document.getElementById('actionsBody').addEventListener('focusout', function (event) {
    var input = event.target.closest('[data-owner-other]');
    if (input) commitOtherOwner(input);
  });

  document.getElementById('addAction').addEventListener('click', function () { readActions(); state.draft.actions.push({id:'manual-action-'+Date.now(),action:'',owners:[],timing:{kind:'not_stated',wording:'',exactDate:''},evidenceIds:[],reviewFlagIds:[]}); renderActions(); scheduleSave(); });
  document.getElementById('flagList').addEventListener('click', function (event) { var button=event.target.closest('[data-flag-index]'); if(!button)return; var index=Number(button.dataset.flagIndex); var note=document.querySelector('[data-flag-correction="'+index+'"]'); state.draft.reviewFlags[index].status=button.dataset.flagStatus; if(note)state.draft.reviewFlags[index].correctionNote=note.value.trim(); renderFlags(); scheduleSave(); });
  document.getElementById('acceptAllProposal').addEventListener('click', function () { reviewProposal('accept',true); });
  document.getElementById('acceptSelectedProposal').addEventListener('click', function () { reviewProposal('accept',false); });
  document.getElementById('rejectProposal').addEventListener('click', function () { reviewProposal('reject',false); });
  document.getElementById('openFinalReview').addEventListener('click', function () { renderFinal(); showStep(MAX_STEP, { scroll: true }); setStatus('Review the complete minutes. Open flags do not prevent saving or export.',false); });
  document.getElementById('saveMinutes').addEventListener('click', function () { saveDraftNow('complete').then(function(){setStatus('Minutes saved. You can resume them from Library.',false);}).catch(function(error){setStatus(error.message,true);}); });
  document.getElementById('reloadDraft').addEventListener('click', function () {
    if (state.draft) loadDraft(state.draft.draftId);
  });
  document.getElementById('downloadWord').addEventListener('click', function () { downloadExport('docx'); });
  document.getElementById('downloadPdf').addEventListener('click', function () { downloadExport('pdf'); });
  document.getElementById('printMinutes').addEventListener('click', function () { window.print(); });
  document.getElementById('newMinutes').addEventListener('click', function () { window.location.href='/meeting-minutes-agent'; });
  document.querySelectorAll('[data-back]').forEach(function(button){button.addEventListener('click',function(){showStep(button.dataset.back, { scroll: true });});});
  document.querySelectorAll('[data-step]').forEach(function(button){button.addEventListener('click',function(){if(!button.disabled){if(Number(button.dataset.step)===MAX_STEP)renderFinal();showStep(button.dataset.step, { scroll: true });}});});

  document.addEventListener('input', function (event) {
    if (!state.draft || rendering) return;
    if (event.target.matches('textarea,input,select') && !event.target.matches('[data-proposal-change],#includeEvidence,#transcriptFile,[data-add-owner],[data-owner-other]')) {
      readEditors();
      autoGrow(event.target.parentElement);
      scheduleSave();
    }
  });

  window.addEventListener('beforeunload', function (event) {
    if (!state.draft || document.getElementById('saveStatus').dataset.state !== 'dirty') return;
    readEditors();
    var body = JSON.stringify(draftPatchBody());
    var delivered = false;
    // keepalive lets the PATCH outlive the page. sendBeacon cannot be used
    // here: it always POSTs, and this endpoint is a PATCH. Its body cap is
    // 64KB, so a very large draft falls back to the browser's own prompt.
    var byteLength = window.Blob ? new Blob([body]).size : body.length;
    if (window.fetch && byteLength < 60000) {
      try {
        fetch(draftUrl(), {method:'PATCH',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:body,keepalive:true});
        delivered = true;
      } catch (error) { delivered = false; }
    }
    if (delivered) return;
    event.preventDefault();
    event.returnValue = '';
  });

  var requestedDraft = new URLSearchParams(window.location.search).get('draftId');
  if (requestedDraft) loadDraft(requestedDraft); else renderAll();
})();
