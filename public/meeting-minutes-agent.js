(function () {
  'use strict';

  var state = { draft: null, currentStep: 0 };
  var agentRetryDelaysSeconds = [5, 15, 30];
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

  function setBusy(busy, message) {
    document.body.classList.toggle('busy', busy);
    status.setAttribute('aria-busy', busy ? 'true' : 'false');
    if (message) setStatus(message, false);
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
        if (remaining <= 0) { setStatus('Retrying the agent now…', false); resolve(); return; }
        setStatus('Microsoft is temporarily busy. Retrying in ' + remaining + ' second' + (remaining === 1 ? '' : 's') + ' (attempt ' + nextAttempt + ' of ' + totalAttempts + ')…', false);
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
    return '<div class="attendee-chip"><input data-attendee-name="' + group + '" value="' + escapeHtml(name || '') + '" aria-label="' + (group === 'internal' ? 'Internal' : 'Client or external') + ' attendee name" placeholder="Enter a name"><button class="secondary attendee-move" data-move-attendee="' + group + '" type="button">Move to ' + destination + '</button><button class="delete attendee-remove" data-remove-attendee type="button" aria-label="Remove ' + escapeHtml(name || 'attendee') + '">Remove</button></div>';
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
      return '<div class="evidence-row' + (unit.cited ? ' cited' : '') + '"><div class="source-meta">' + escapeHtml(unit.id + ' · ' + unit.speaker + (unit.timestamp ? ' · ' + unit.timestamp : '') + (unit.cited ? ' · cited' : ' · surrounding context')) + '</div><div>' + escapeHtml(unit.text) + '</div></div>';
    }).join('');
  }

  function autoGrow(root) {
    (root || document).querySelectorAll('textarea').forEach(function (area) {
      area.style.height = 'auto';
      area.style.height = Math.max(area.scrollHeight, 52) + 'px';
    });
  }

  function showStep(index) {
    state.currentStep = Math.max(0, Math.min(3, Number(index) || 0));
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
    window.scrollTo({ top: 0, behavior: 'smooth' });
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
    document.getElementById('meetingTitle').value = details.meetingTitle || '';
    document.getElementById('meetingDate').value = details.meetingDate || '';
    document.getElementById('meetingLocation').value = details.meetingLocation || '';
    document.getElementById('meetingType').value = details.meetingType || '';
    renderAttendeeGroup('internal', details.internalAttendees || []);
    renderAttendeeGroup('client', details.clientAttendees || []);
    document.getElementById('clientAttendeeLabelSelect').value = details.clientAttendeeLabel === 'External' ? 'External' : 'Client';
    document.getElementById('clientAttendeeHeading').textContent = details.clientAttendeeLabel === 'External' ? 'External' : 'Client';
    var denoise = draft.denoise || {};
    document.getElementById('denoiseSummary').textContent = denoise.totalUnitCount ? denoise.keptUnitCount + ' of ' + denoise.totalUnitCount + ' passages retained' : '';
  }

  async function prepareFile(file) {
    if (!file) return;
    if (!/\.docx$/i.test(file.name)) return setStatus('Choose a Word .docx transcript.', true);
    var form = new FormData(); form.append('file', file);
    setBusy(true, 'Reading the Word document and preparing the transcript…');
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
    return '<div class="record-section"><div class="toolbar"><h3>' + escapeHtml(heading) + '</h3><button class="secondary" data-add-record="' + field + '" data-topic-index="' + topicIndex + '" type="button">Add</button></div>' + (rows.map(function (item, itemIndex) {
      return '<div class="record-row"><textarea data-record-field="' + field + '" data-topic-index="' + topicIndex + '" data-item-index="' + itemIndex + '" aria-label="' + escapeHtml(heading) + '">' + escapeHtml(item.text || '') + '</textarea><div class="record-tools"><details><summary class="evidence-toggle">Evidence (' + (item.evidenceIds || []).length + ')</summary><div class="evidence-panel">' + evidenceHtml(item.evidenceIds) + '</div></details><button class="delete" data-remove-record="' + field + '" data-topic-index="' + topicIndex + '" data-item-index="' + itemIndex + '" type="button">Remove</button></div></div>';
    }).join('') || '<p class="muted">None recorded.</p>') + '</div>';
  }

  function renderDiscussion() {
    var discussion = (state.draft && state.draft.discussion) || [];
    document.getElementById('discussionList').innerHTML = discussion.map(function (topic, index) {
      return '<article class="discussion-card"><div class="card-head"><label class="topic-field"><span class="topic-label">Topic</span><input data-topic-index="' + index + '" data-topic value="' + escapeHtml(topic.topic || '') + '" aria-label="Discussion topic"></label><button class="delete" data-delete-topic="' + index + '" type="button">Remove topic</button></div>' + pointSection(topic, index, 'points', 'Discussion') + pointSection(topic, index, 'decisions', 'Decisions') + pointSection(topic, index, 'openQuestions', 'Open questions') + '</article>';
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
    var selected = (action.owners || []).map(function (owner) { return owner.toLowerCase(); });
    var participants = participantNames();
    var custom = (action.owners || []).filter(function (owner) { return !participants.some(function (name) { return name.toLowerCase() === owner.toLowerCase(); }); });
    return '<div class="owner-options">' + participants.map(function (name) {
      return '<label><input type="checkbox" data-owner-choice data-action-index="' + index + '" value="' + escapeHtml(name) + '"' + (selected.includes(name.toLowerCase()) ? ' checked' : '') + '> ' + escapeHtml(name) + '</label>';
    }).join('') + '<label>Another person</label><input data-other-owners data-action-index="' + index + '" value="' + escapeHtml(custom.join(', ')) + '" placeholder="Name, or multiple names"></div>';
  }

  function renderActions() {
    var actions = (state.draft && state.draft.actions) || [];
    document.getElementById('actionsBody').innerHTML = actions.map(function (item, index) {
      var timing = item.timing || {kind:'not_stated',wording:'',exactDate:''};
      return '<tr><td data-label="Action"><textarea data-action-index="' + index + '" data-action>' + escapeHtml(item.action || '') + '</textarea><details><summary class="evidence-toggle">Evidence (' + (item.evidenceIds || []).length + ')</summary><div class="evidence-panel">' + evidenceHtml(item.evidenceIds) + '</div></details></td><td data-label="Owners">' + ownerEditor(item, index) + '</td><td data-label="Timing"><div class="timing-editor"><select data-timing-kind data-action-index="' + index + '"><option value="not_stated"' + (timing.kind === 'not_stated' ? ' selected' : '') + '>Not stated</option><option value="target"' + (timing.kind === 'target' ? ' selected' : '') + '>Target</option><option value="deadline"' + (timing.kind === 'deadline' ? ' selected' : '') + '>Deadline</option></select><input data-timing-wording data-action-index="' + index + '" value="' + escapeHtml(timing.wording || '') + '" placeholder="e.g. this week"><input data-timing-date data-action-index="' + index + '" type="date" value="' + escapeHtml(timing.exactDate || '') + '"></div></td><td><button class="delete" data-delete-action="' + index + '" type="button">Remove</button></td></tr>';
    }).join('') || '<tr><td colspan="4" class="muted">No actions have been generated.</td></tr>';
    autoGrow(document.getElementById('actionsBody'));
  }

  function readActions() {
    if (!state.draft) return [];
    document.querySelectorAll('[data-action]').forEach(function (area) {
      var action = state.draft.actions[Number(area.dataset.actionIndex)]; if (action) action.action = area.value.trim();
    });
    state.draft.actions.forEach(function (action, index) {
      var owners = Array.from(document.querySelectorAll('[data-owner-choice][data-action-index="' + index + '"]:checked')).map(function (input) { return input.value; });
      var custom = document.querySelector('[data-other-owners][data-action-index="' + index + '"]');
      if (custom) owners = owners.concat(custom.value.split(/\s*(?:,|&|\band\b)\s*/i).map(function (name) { return name.trim(); }).filter(Boolean));
      action.owners = owners.filter(function (name, ownerIndex, all) { return all.findIndex(function (candidate) { return candidate.toLowerCase() === name.toLowerCase(); }) === ownerIndex; });
      var kind = document.querySelector('[data-timing-kind][data-action-index="' + index + '"]');
      var wording = document.querySelector('[data-timing-wording][data-action-index="' + index + '"]');
      var date = document.querySelector('[data-timing-date][data-action-index="' + index + '"]');
      action.timing = { kind: kind ? kind.value : 'not_stated', wording: wording ? wording.value.trim() : '', exactDate: date ? date.value : '' };
    });
    return state.draft.actions;
  }

  function renderFlags() {
    var flags = (state.draft && state.draft.reviewFlags) || [];
    var open = flags.filter(function (flag) { return flag.status === 'open'; });
    var panel = document.getElementById('reviewFlags');
    var wasHidden = panel.hidden;
    panel.hidden = !flags.length;
    if (flags.length && wasHidden) panel.open = false;
    document.getElementById('flagCount').textContent = open.length + (open.length === 1 ? ' item' : ' items');
    var flagLabels = { uncertain_fact:'Uncertain detail', unclear_reference:'Reference to check', ownership:'Owner to check', timing:'Timing to check', unresolved_decision:'Open decision', missing_evidence:'Source evidence needed', possible_missed_follow_up:'Possible missed follow-up' };
    document.getElementById('flagList').innerHTML = flags.map(function (flag, index) {
      var label = flagLabels[flag.kind] || flag.kind.replace(/_/g, ' ').replace(/\b\w/g, function (letter) { return letter.toUpperCase(); });
      return '<div class="flag' + (flag.status === 'open' ? '' : ' resolved') + '"><div><span class="flag-kind">' + escapeHtml(label) + '</span><div class="flag-message">' + escapeHtml(flag.message) + '</div>' + (flag.status === 'open' ? '<input data-flag-correction="' + index + '" value="' + escapeHtml(flag.correctionNote || '') + '" placeholder="Add a correction note (optional)">' : (flag.correctionNote ? '<div class="muted">Correction: ' + escapeHtml(flag.correctionNote) + '</div>' : '')) + ((flag.evidenceIds || []).length ? '<details><summary class="evidence-toggle">View evidence</summary><div class="evidence-panel">' + evidenceHtml(flag.evidenceIds) + '</div></details>' : '') + '</div><div class="flag-actions">' + (flag.status === 'open' ? '<button class="secondary" data-flag-index="' + index + '" data-flag-status="confirmed" type="button">Looks correct</button><button class="secondary" data-flag-index="' + index + '" data-flag-status="corrected" type="button">Save correction</button><button class="secondary" data-flag-index="' + index + '" data-flag-status="dismissed" type="button">Dismiss</button>' : '<button class="secondary" data-flag-index="' + index + '" data-flag-status="open" type="button">Reopen</button>') + '</div></div>';
    }).join('');
  }

  function proposalRecord(value) {
    if (!value) return 'Removed';
    if (value.action) return value.action + (value.owners && value.owners.length ? ' — ' + value.owners.join(', ') : '');
    return value.topic || value.text || JSON.stringify(value);
  }

  function renderProposal() {
    var proposal = state.draft && state.draft.pendingProposal;
    var panel = document.getElementById('proposalPanel');
    panel.hidden = !proposal || !(proposal.changes || []).length;
    if (panel.hidden) return;
    var changeLabels = { add:'New item', modify:'Suggested edit', remove:'Suggested removal' };
    document.getElementById('proposalChanges').innerHTML = proposal.changes.map(function (change) {
      return '<label class="proposal-change"><input type="checkbox" data-proposal-change="' + escapeHtml(change.id) + '" checked style="width:auto"><div><span class="proposal-kind">' + escapeHtml(changeLabels[change.type] || 'Suggested change') + '</span>' + (change.before ? '<div class="muted">Before</div><pre>' + escapeHtml(proposalRecord(change.before)) + '</pre>' : '') + (change.after ? '<div class="muted">Proposed</div><pre>' + escapeHtml(proposalRecord(change.after)) + '</pre>' : '') + '</div></label>';
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
    return (timing.kind === 'target' ? 'Target: ' : 'Deadline: ') + (timing.exactDate ? formatUkDate(timing.exactDate) : timing.wording);
  }

  function renderFinal() {
    readDetails(); readDiscussion(); readActions();
    var draft = state.draft || {}; var details = draft.details || {};
    var decisions = (draft.discussion || []).flatMap(function (topic) { return (topic.decisions || []).map(function (item) { return {topic:topic.topic,text:item.text}; }); });
    var questions = (draft.discussion || []).flatMap(function (topic) { return (topic.openQuestions || []).map(function (item) { return {topic:topic.topic,text:item.text}; }); });
    document.getElementById('finalDocument').innerHTML = '<h2>' + escapeHtml(details.meetingTitle || 'Meeting minutes') + '</h2><p><strong>Date:</strong> ' + escapeHtml(details.meetingDate ? formatUkDate(details.meetingDate) : 'Not stated') + '<br><strong>Location:</strong> ' + escapeHtml(details.meetingLocation || 'Not stated') + '<br><strong>Meeting type:</strong> ' + escapeHtml(details.meetingType || 'Not stated') + '</p><p><strong>Internal attendees:</strong> ' + escapeHtml((details.internalAttendees || []).join(', ') || 'Not stated') + '<br><strong>' + escapeHtml(details.clientAttendeeLabel === 'External' ? 'External' : 'Client') + ' attendees:</strong> ' + escapeHtml((details.clientAttendees || []).join(', ') || 'Not stated') + '</p><section><h3>Discussion</h3>' + ((draft.discussion || []).map(function (topic) { return '<h4>' + escapeHtml(topic.topic) + '</h4><ul>' + (topic.points || []).map(function (point) { return '<li>' + escapeHtml(point.text) + '</li>'; }).join('') + '</ul>'; }).join('') || '<p>No discussion recorded.</p>') + '</section><section><h3>Decisions</h3>' + (decisions.length ? '<ul>' + decisions.map(function (item) { return '<li><strong>' + escapeHtml(item.topic) + ':</strong> ' + escapeHtml(item.text) + '</li>'; }).join('') + '</ul>' : '<p>No decisions recorded.</p>') + '</section><section><h3>Open questions</h3>' + (questions.length ? '<ul>' + questions.map(function (item) { return '<li><strong>' + escapeHtml(item.topic) + ':</strong> ' + escapeHtml(item.text) + '</li>'; }).join('') + '</ul>' : '<p>No open questions recorded.</p>') + '</section><section><h3>Actions</h3><div class="actions-wrap"><table class="actions-table"><thead><tr><th>Action</th><th>Owners</th><th>Timing</th></tr></thead><tbody>' + ((draft.actions || []).map(function (action) { return '<tr><td>' + escapeHtml(action.action) + '</td><td>' + escapeHtml((action.owners || []).join(', ') || 'Not stated') + '</td><td>' + escapeHtml(timingText(action.timing)) + '</td></tr>'; }).join('') || '<tr><td colspan="3">No actions recorded.</td></tr>') + '</tbody></table></div></section>';
  }

  function renderAll() {
    rendering = true;
    uploadZone.hidden = Boolean(state.draft);
    detailsEditor.hidden = !state.draft;
    document.getElementById('saveStrip').hidden = !state.draft;
    if (state.draft) {
      renderDetails(); renderDiscussion(); renderActions(); renderFlags(); renderProposal();
      var stale = state.draft.staleStages || [];
      document.getElementById('staleNotice').hidden = !stale.length;
      document.getElementById('staleStages').textContent = stale.join(' and ');
    } else document.getElementById('staleNotice').hidden = true;
    showStep(state.draft ? (state.draft.currentStep || state.currentStep || 0) : 0);
    rendering = false;
  }

  function adoptDraft(draft) {
    if (!draft) return;
    state.draft = draft;
    state.currentStep = draft.currentStep || 0;
    renderAll();
    setSaveStatus('Saved at ' + new Date(draft.updatedAt || Date.now()).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}), 'saved');
  }

  function readEditors() { if (!state.draft) return; readDetails(); readDiscussion(); readActions(); state.draft.currentStep = state.currentStep; }

  function scheduleSave() {
    if (rendering || !state.draft) return;
    setSaveStatus('Unsaved changes — saving shortly…', 'dirty');
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(function () { saveDraftNow(); }, 900);
  }

  async function saveDraftNow(statusValue) {
    if (!state.draft) return null;
    clearTimeout(saveTimer);
    if (saveInFlight) { saveQueued = true; await saveInFlight; if (!saveQueued) return state.draft; saveQueued = false; }
    readEditors();
    var revision = state.draft.revision;
    var body = { revision: revision, details: state.draft.details, discussion: state.draft.discussion, actions: state.draft.actions, reviewFlags: state.draft.reviewFlags, currentStep: state.currentStep };
    if (statusValue) body.status = statusValue;
    setSaveStatus('Saving…', 'saving');
    saveInFlight = jsonRequest('/api/meeting-minutes-agent/drafts/' + encodeURIComponent(state.draft.draftId), {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(function (payload) {
      adoptDraft(payload.draft); return state.draft;
    }).catch(function (error) {
      if (error.currentDraft) adoptDraft(error.currentDraft);
      setSaveStatus(error.message, 'error'); throw error;
    }).finally(function () { saveInFlight = null; });
    return saveInFlight;
  }

  async function runAgent(stage, instruction) {
    if (!state.draft) return false;
    try { await saveDraftNow(); } catch (error) { setStatus(error.message, true); return false; }
    setBusy(true, instruction ? 'The agent is preparing a change preview…' : 'The agent is reviewing the prepared transcript…');
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
        showStep(stage === 'discussion' ? 1 : 2);
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
    setBusy(true, 'Checking the transcript for missed follow-up actions…');
    try {
      var payload; var totalAttempts = agentRetryDelaysSeconds.length + 1;
      for (var attempt = 0; attempt < totalAttempts; attempt += 1) {
        if (attempt > 0) await waitForAgentRetry(agentRetryDelaysSeconds[attempt - 1], attempt + 1, totalAttempts);
        try {
          payload = await jsonRequest('/api/meeting-minutes-agent/drafts/' + encodeURIComponent(state.draft.draftId) + '/audit-actions', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:state.draft.revision})});
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
    setBusy(true, decision === 'reject' ? 'Rejecting proposed changes…' : 'Applying selected changes…');
    try {
      var payload = await jsonRequest('/api/meeting-minutes-agent/drafts/' + encodeURIComponent(state.draft.draftId) + '/proposal', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:state.draft.revision,decision:decision,acceptAll:Boolean(acceptAll),changeIds:ids})});
      adoptDraft(payload.draft); setStatus(decision === 'reject' ? 'Proposed changes rejected.' : 'Selected agent changes applied. You can undo them from final review.', false);
    } catch (error) { setStatus(error.message, true); }
    finally { setBusy(false); }
  }

  async function downloadWord() {
    try { await saveDraftNow('complete'); } catch (error) { return setStatus(error.message, true); }
    setBusy(true, 'Creating the Word document…');
    try {
      var response = await fetch('/api/meeting-minutes-agent/drafts/' + encodeURIComponent(state.draft.draftId) + '/export.docx', {method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({includeEvidence:document.getElementById('includeEvidence').checked})});
      if (!response.ok) { var problem = await response.json().catch(function () { return {}; }); throw new Error(problem.error || 'The Word document could not be created.'); }
      var blob = await response.blob(); var disposition = response.headers.get('content-disposition') || ''; var match = disposition.match(/filename="([^"]+)"/i);
      var link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = match ? match[1] : 'Meeting minutes.docx'; document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(link.href);
      setStatus('Word document downloaded.', false);
    } catch (error) { setStatus(error.message, true); }
    finally { setBusy(false); }
  }

  async function downloadPdf() {
    try { await saveDraftNow('complete'); } catch (error) { return setStatus(error.message, true); }
    setBusy(true, 'Generating your PDF…');
    try {
      var response = await fetch('/api/meeting-minutes-agent/drafts/' + encodeURIComponent(state.draft.draftId) + '/export.pdf', {method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({includeEvidence:document.getElementById('includeEvidence').checked})});
      if (!response.ok) { var problem = await response.json().catch(function () { return {}; }); throw new Error(problem.error || 'The PDF could not be generated.'); }
      var blob = await response.blob(); var disposition = response.headers.get('content-disposition') || ''; var match = disposition.match(/filename="([^"]+)"/i);
      var url = URL.createObjectURL(blob); var link = document.createElement('a'); link.href = url; link.download = match ? match[1] : 'Meeting minutes.pdf'; document.body.appendChild(link); link.click(); link.remove();
      window.setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
      setStatus('PDF downloaded.', false);
    } catch (error) { setStatus(error.message || 'The PDF could not be generated.', true); }
    finally { setBusy(false); }
  }

  async function loadDraft(draftId) {
    setBusy(true, 'Loading your saved draft…');
    try { var payload = await jsonRequest('/api/meeting-minutes-agent/drafts/' + encodeURIComponent(draftId)); adoptDraft(payload.draft); setStatus('Saved draft restored.', false); }
    catch (error) { setStatus(error.message, true); }
    finally { setBusy(false); }
  }

  uploadZone.addEventListener('click', function (event) { if (event.target.id !== 'chooseFile') fileInput.click(); });
  document.getElementById('chooseFile').addEventListener('click', function (event) { event.stopPropagation(); fileInput.click(); });
  uploadZone.addEventListener('keydown', function (event) { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); fileInput.click(); } });
  ['dragenter','dragover'].forEach(function (name) { uploadZone.addEventListener(name, function (event) { event.preventDefault(); uploadZone.classList.add('dragover'); }); });
  ['dragleave','drop'].forEach(function (name) { uploadZone.addEventListener(name, function (event) { event.preventDefault(); uploadZone.classList.remove('dragover'); }); });
  uploadZone.addEventListener('drop', function (event) { prepareFile(event.dataTransfer.files[0]); });
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
    if (move || remove) { readDetails(); renderActions(); scheduleSave(); }
  });
  document.getElementById('clientAttendeeLabelSelect').addEventListener('change', function (event) {
    document.getElementById('clientAttendeeHeading').textContent = event.target.value === 'External' ? 'External' : 'Client';
  });
  document.getElementById('generateDiscussion').addEventListener('click', function () { runAgent('discussion',''); });
  document.getElementById('generateActions').addEventListener('click', function () { runAgent('actions',''); });
  document.getElementById('auditActions').addEventListener('click', function () { auditActions(false); });
  document.getElementById('applyDiscussionEdit').addEventListener('click', function () { var input=document.getElementById('discussionInstruction'); if (!input.value.trim()) return setStatus('Describe the discussion edits you want.',true); runAgent('discussion',input.value.trim()).then(function(ok){if(ok)input.value='';}); });
  document.getElementById('applyActionsEdit').addEventListener('click', function () { var input=document.getElementById('actionsInstruction'); if (!input.value.trim()) return setStatus('Describe the action edits you want.',true); runAgent('actions',input.value.trim()).then(function(ok){if(ok)input.value='';}); });
  document.getElementById('addDiscussion').addEventListener('click', function () { readDiscussion(); state.draft.discussion.push({id:'manual-topic-'+Date.now(),topic:'',points:[],decisions:[],openQuestions:[]}); renderDiscussion(); scheduleSave(); });
  document.getElementById('discussionList').addEventListener('click', function (event) { var add=event.target.closest('[data-add-record]'); var remove=event.target.closest('[data-remove-record]'); var topicButton=event.target.closest('[data-delete-topic]'); readDiscussion(); if(add){state.draft.discussion[Number(add.dataset.topicIndex)][add.dataset.addRecord].push({id:'manual-'+Date.now(),text:'',evidenceIds:[],reviewFlagIds:[]});} if(remove){state.draft.discussion[Number(remove.dataset.topicIndex)][remove.dataset.removeRecord].splice(Number(remove.dataset.itemIndex),1);} if(topicButton){state.draft.discussion.splice(Number(topicButton.dataset.deleteTopic),1);} if(add||remove||topicButton){renderDiscussion();scheduleSave();} });
  document.getElementById('actionsBody').addEventListener('click', function (event) { var button=event.target.closest('[data-delete-action]'); if(!button)return; readActions(); state.draft.actions.splice(Number(button.dataset.deleteAction),1); renderActions(); scheduleSave(); });
  document.getElementById('addAction').addEventListener('click', function () { readActions(); state.draft.actions.push({id:'manual-action-'+Date.now(),action:'',owners:[],timing:{kind:'not_stated',wording:'',exactDate:''},evidenceIds:[],reviewFlagIds:[]}); renderActions(); scheduleSave(); });
  document.getElementById('flagList').addEventListener('click', function (event) { var button=event.target.closest('[data-flag-index]'); if(!button)return; var index=Number(button.dataset.flagIndex); var note=document.querySelector('[data-flag-correction="'+index+'"]'); state.draft.reviewFlags[index].status=button.dataset.flagStatus; if(note)state.draft.reviewFlags[index].correctionNote=note.value.trim(); renderFlags(); scheduleSave(); });
  document.getElementById('acceptAllProposal').addEventListener('click', function () { reviewProposal('accept',true); });
  document.getElementById('acceptSelectedProposal').addEventListener('click', function () { reviewProposal('accept',false); });
  document.getElementById('rejectProposal').addEventListener('click', function () { reviewProposal('reject',false); });
  document.getElementById('openFinalReview').addEventListener('click', function () { renderFinal(); showStep(3); setStatus('Review the complete minutes. Open flags do not prevent saving or export.',false); });
  document.getElementById('saveMinutes').addEventListener('click', function () { saveDraftNow('complete').then(function(){setStatus('Minutes saved. You can resume them from Library.',false);}).catch(function(error){setStatus(error.message,true);}); });
  document.getElementById('downloadWord').addEventListener('click', downloadWord);
  document.getElementById('downloadPdf').addEventListener('click', downloadPdf);
  document.getElementById('printMinutes').addEventListener('click', function () { window.print(); });
  document.getElementById('newMinutes').addEventListener('click', function () { window.location.href='/meeting-minutes-agent'; });
  document.querySelectorAll('[data-back]').forEach(function(button){button.addEventListener('click',function(){showStep(button.dataset.back);});});
  document.querySelectorAll('[data-step]').forEach(function(button){button.addEventListener('click',function(){if(!button.disabled){if(Number(button.dataset.step)===3)renderFinal();showStep(button.dataset.step);}});});
  document.addEventListener('input', function (event) { if (!state.draft || rendering) return; if (event.target.matches('textarea,input,select') && !event.target.matches('[data-proposal-change],#includeEvidence,#transcriptFile')) { readEditors(); autoGrow(event.target.parentElement); scheduleSave(); } });
  window.addEventListener('beforeunload', function () { if (state.draft && document.getElementById('saveStatus').dataset.state === 'dirty') saveDraftNow(); });

  var requestedDraft = new URLSearchParams(window.location.search).get('draftId');
  if (requestedDraft) loadDraft(requestedDraft); else renderAll();
})();
