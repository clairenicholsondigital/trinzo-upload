(function () {
  'use strict';

  var state = { draft: null, currentStep: 0 };
  var agentRetryDelaysSeconds = [5, 15, 30];
  // 0 details, 1 focus, 2 discussion, 3 actions, 4 summary, 5 review
  var MAX_STEP = 5;
  var STAGE_STEP = { details: 0, focus: 1, discussion: 2, actions: 3, summary: 4, review: 5 };
  var GENERATION_POLL_MS = 1000;
  var generationTimer = null;
  var prewarmTimer = null;
  var completedGenerationNotice = null;
  var saveTimer = null;
  var saveInFlight = null;
  var saveQueued = false;
  var pendingGenerationEdits = false;
  var actionsInvalidatedDuringGeneration = false;
  var generationPollKey = '';
  var actionEditorState = { pendingRows: {}, customOwners: {} };
  var discussionEditorState = { pendingTopics: {}, pendingRecords: {} };
  var editVersion = 0;
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

  function setStatus(message, error, stage) {
    status.textContent = message || '';
    status.dataset.stage = stage || '';
    status.hidden = !message || Boolean(stage && STAGE_STEP[stage] !== state.currentStep);
    status.classList.toggle('error', Boolean(error));
  }

  function currentStageName() {
    return ['details', 'focus', 'discussion', 'actions', 'summary', 'review'][state.currentStep] || '';
  }

  // One rule for whether leaving is safe: anything unsaved, anything waiting
  // behind a running generation, or any unfinished entry that only exists in
  // this tab. Every "Keep this tab open" message and the Resume-later link
  // read this, so they can never disagree.
  function mustKeepTabOpen(kind) {
    var unsaved = ['dirty','waiting','local-only','saving','error'].includes(kind);
    return unsaved || Boolean(pendingGenerationEdits) || hasTransientEditorState();
  }

  function refreshLeaveSafety() {
    var element = document.getElementById('saveStatus');
    var keepOpen = mustKeepTabOpen(element ? element.dataset.state : '');
    var resumeLink = document.getElementById('resumeLaterLink');
    if (resumeLink) resumeLink.hidden = keepOpen;
    // Refresh on every save transition, not only mid-run: once a run ended the
    // panel froze on "Everything is saved" beside a live unfinished-entry warning.
    var leaveMessage = document.getElementById('generationLeaveMessage');
    if (leaveMessage) leaveMessage.textContent = generationSaveText(generationRunning());
  }

  function setSaveStatus(message, kind) {
    var element = document.getElementById('saveStatus');
    if (mustKeepTabOpen(kind) && message && !/Keep this tab open/i.test(message)) message += ' Keep this tab open.';
    document.getElementById('saveStrip').hidden = !state.draft;
    element.textContent = message || '';
    element.dataset.state = kind || '';
    refreshLeaveSafety();
  }

  function savedStatusText(value) {
    var savedAt = value ? new Date(value) : new Date();
    if (Number.isNaN(savedAt.getTime())) return 'Saved';
    return 'Saved at ' + savedAt.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
  }

  function hasTransientActionState() {
    return Object.keys(actionEditorState.pendingRows).length > 0
      || Object.keys(actionEditorState.customOwners).some(function (key) {
        var owner = actionEditorState.customOwners[key];
        return owner && (owner.visible || owner.value);
      });
  }

  function hasTransientDiscussionState() {
    return Object.keys(discussionEditorState.pendingTopics).length > 0
      || Object.keys(discussionEditorState.pendingRecords).length > 0;
  }

  function hasTransientEditorState() {
    return hasTransientActionState() || hasTransientDiscussionState();
  }

  function generationSaveText(running) {
    if (pendingGenerationEdits) return 'Unsaved edits are waiting to save. Keep this tab open.';
    if (hasTransientEditorState()) return 'New unfinished entries are kept in this tab until their text is entered. Keep this tab open.';
    return 'Everything is saved. You can leave and resume later' + (running === false ? '.' : ' while generation continues.');
  }

  function setBusy(busy, message, stage) {
    document.body.classList.toggle('busy', busy);
    status.setAttribute('aria-busy', busy ? 'true' : 'false');
    if (message) setStatus(message, false, stage);
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

  function waitForAgentRetry(seconds, nextAttempt, totalAttempts, stage) {
    return new Promise(function (resolve) {
      var remaining = seconds;
      function tick() {
        if (remaining <= 0) { setStatus('Retrying the agent now...', false, stage); resolve(); return; }
        setStatus('Microsoft is temporarily busy. Retrying in ' + remaining + ' second' + (remaining === 1 ? '' : 's') + ' (attempt ' + nextAttempt + ' of ' + totalAttempts + ')...', false, stage);
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
    if (completedGenerationNotice && STAGE_STEP[completedGenerationNotice.stage] === state.currentStep) {
      completedGenerationNotice = null;
    }
    var stepChanged = Boolean(state.draft)
      && Number(state.draft.selectedStep == null ? state.draft.currentStep : state.draft.selectedStep) !== state.currentStep;
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
    if (state.draft) {
      state.draft.currentStep = Math.max(Number(state.draft.currentStep || 0), state.currentStep);
      state.draft.selectedStep = state.currentStep;
    }
    autoGrow();
    var statusStage = status.dataset.stage;
    status.hidden = !status.textContent || Boolean(statusStage && STAGE_STEP[statusStage] !== state.currentStep);
    // Deliberate navigation is persisted independently from the furthest unlocked
    // step. During generation scheduleSave holds it until the background write is
    // complete, so reopening the draft returns to the screen the reviewer chose.
    if (!rendering && stepChanged && !(options && options.persist === false)) scheduleSave();
    // Only a deliberate navigation scrolls. A re-render triggered by autosave
    // must leave the reader exactly where they were.
    if (options && options.scroll) window.scrollTo({ top: 0, behavior: 'smooth' });
    renderGenerationProgress();
    if (options && options.scroll) maybeOpenPreparedSummary();
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

  function generationPhaseStatus(generation, phase) {
    var pass = String(generation.pass || '');
    var completed = generation.completedPasses || [];
    var hasCompleted = function (prefix) { return completed.some(function (item) { return String(item).indexOf(prefix) === 0; }); };
    var rank = function (value) {
      if (/^(critic|salvage)/.test(value)) return 4;
      if (/^referee/.test(value)) return 3;
      if (value === 'recovery') return 2;
      if (value === 'primary') return 1;
      return 0;
    };
    var currentRank = rank(pass);
    if (phase.key === 'primary') return hasCompleted('primary') || currentRank > 1 ? 'done' : currentRank === 1 ? 'active' : '';
    if (phase.key === 'recovery') return hasCompleted('recovery') || currentRank > 2 ? 'done' : currentRank === 2 ? 'active' : '';
    if (phase.key === 'referee') return hasCompleted('referee') || currentRank > 3 ? 'done' : currentRank === 3 ? 'active' : '';
    if (phase.key === 'final') return hasCompleted('critic') && (!/^salvage/.test(pass) || hasCompleted('salvage')) ? 'done' : currentRank === 4 ? 'active' : '';
    if (phase.key === 'summary') return hasCompleted('summary') ? 'done' : 'active';
    return '';
  }

  function generationPhases(generation) {
    if (generation.stage === 'actions') return [
      {key:'primary',label:'Find possible actions'},
      {key:'recovery',label:'Recover missed items'},
      {key:'referee',label:'Check the evidence'},
      {key:'final',label:'Final missed-action check'}
    ];
    if (generation.stage === 'discussion') return [
      {key:'primary',label:'Find meeting content'},
      {key:'recovery',label:'Recover missed topics'},
      {key:'referee',label:'Check the evidence'},
      {key:'final',label:'Finalise the draft'}
    ];
    return [{key:'summary',label:'Draft and ground the summary'}];
  }

  function renderGenerationProgress() {
    var panel = document.getElementById('generationProgress');
    if (!panel) return;
    var generation = state.draft && state.draft.generation;
    var notice = completedGenerationNotice;
    panel.hidden = !generation && !notice;
    document.querySelectorAll('[data-step]').forEach(function (button) {
      var step = Number(button.dataset.step);
      button.classList.toggle('generating', Boolean(generation && STAGE_STEP[generation.stage] === step));
      button.classList.toggle('ready', Boolean(notice && STAGE_STEP[notice.stage] === step));
    });
    if (panel.hidden) return;
    var stage = generation ? generation.stage : notice.stage;
    var preview = generation && Array.isArray(generation.previewActions) ? generation.previewActions : [];
    document.getElementById('generationProgressTitle').textContent = generation
      ? (stage === 'actions' ? 'Preparing actions' : stage === 'discussion' ? 'Preparing discussion' : 'Preparing summary')
      : (stage === 'actions' ? 'Actions are ready' : 'Generation complete');
    document.getElementById('generationProgressMessage').textContent = generation
      ? (generation.message || 'Preparing independent quality checks…')
      : (notice.message || 'The completed draft is ready to review.');
    var leaveMessage = document.getElementById('generationLeaveMessage');
    if (leaveMessage) leaveMessage.textContent = generationSaveText(Boolean(generation));
    var started = generation && new Date(generation.startedAt).getTime();
    var elapsed = started && !Number.isNaN(started) ? Math.max(0, Math.floor((Date.now() - started) / 1000)) : 0;
    document.getElementById('generationElapsed').textContent = generation
      ? 'Elapsed ' + Math.floor(elapsed / 60) + ':' + String(elapsed % 60).padStart(2, '0') + ' · usually around 2–4 minutes'
      : 'Complete';
    document.getElementById('generationPhases').innerHTML = generationPhases(generation || {stage:stage}).map(function (phase) {
      var phaseState = generation ? generationPhaseStatus(generation, phase) : 'done';
      return '<li class="generation-phase ' + phaseState + '">' + escapeHtml(phase.label) + '</li>';
    }).join('');
    var previewNote = document.getElementById('generationPreviewNote');
    previewNote.hidden = !generation || !preview.length;
    previewNote.textContent = preview.length
      ? preview.length + ' evidence-checked action' + (preview.length === 1 ? '' : 's') + ' available to read while the final check continues. Editing unlocks when checks finish.'
      : '';
    var view = document.getElementById('viewGeneratedStage');
    view.hidden = stage !== 'actions' || state.currentStep === STAGE_STEP.actions || (!preview.length && !notice);
    view.textContent = generation ? 'View action preview' : 'View actions';
  }

  // An edit to earlier content marks what is derived from it as outdated,
  // whether or not a generation is running. The server derives the same thing
  // from the saved content, so the mark survives a refresh and other tabs;
  // this is the immediate, local half.
  function discussionRecordHasContent(record) {
    return Boolean(record && String(record.text || '').trim());
  }

  function discussionTopicHasContent(topic) {
    if (!topic) return false;
    if (String(topic.topic || '').trim()) return true;
    return ['points', 'decisions', 'openQuestions'].some(function (field) {
      return (topic[field] || []).some(discussionRecordHasContent);
    });
  }

  function markDownstreamStale() {
    if (!state.draft) return;
    var stale = new Set(state.draft.staleStages || []);
    if ((state.draft.actions || []).length) stale.add('actions');
    if (state.draft.executiveSummary) stale.add('summary');
    if (generationRunning('actions')) actionsInvalidatedDuringGeneration = true;
    if (!stale.size) return;
    state.draft.staleStages = Array.from(stale);
    var notice = document.getElementById('staleNotice');
    notice.hidden = false;
    document.getElementById('staleStages').textContent = state.draft.staleStages.join(' and ');
  }

  function speculationFor(stage) {
    var speculation = state.draft && state.draft.speculation;
    return speculation && speculation.stage === stage ? speculation : null;
  }

  var SPECULATION_NOTICE_TEXT = {
    discussion: {
      preparing: 'Preparing the Discussion in the background while you check the details…',
      ready: 'The Discussion is ready. Continue to open it.'
    },
    actions: {
      preparing: 'Preparing Actions in the background while you review Discussion…',
      ready: 'Actions preparation is ready. Starting Actions will reuse this work.'
    },
    summary: {
      preparing: 'Preparing the Summary in the background while you review Actions…',
      ready: 'The Summary is ready. It opens with the next step.'
    }
  };

  function renderSpeculationNotice(element, stage, info) {
    if (!element) return;
    element.hidden = !info || generationRunning(stage);
    if (element.hidden) return;
    element.textContent = SPECULATION_NOTICE_TEXT[stage][info.status === 'ready' ? 'ready' : 'preparing'];
  }

  function renderActionsPrewarm() {
    if (!state.draft) return;
    // The Actions notice keeps its older prewarm source so a deployment
    // without the speculative pipeline still says what it used to.
    renderSpeculationNotice(document.getElementById('actionsPrewarmNotice'), 'actions',
      speculationFor('actions') || state.draft.actionsPrewarm);
    document.querySelectorAll('[data-speculation-notice]').forEach(function (element) {
      var stage = element.dataset.speculationNotice;
      renderSpeculationNotice(element, stage, speculationFor(stage));
    });
  }

  function backgroundWorkPreparing() {
    if (!state.draft) return false;
    var speculation = state.draft.speculation;
    var prewarm = state.draft.actionsPrewarm;
    return Boolean((speculation && speculation.status === 'preparing') || (prewarm && prewarm.status === 'preparing'));
  }

  function pollActionPrewarm() {
    clearTimeout(prewarmTimer);
    if (!backgroundWorkPreparing() || generationRunning()) return;
    prewarmTimer = window.setTimeout(async function () {
      if (!state.draft || generationRunning()) return;
      try {
        var payload = await jsonRequest(draftUrl('/generation'));
        state.draft.actionsPrewarm = payload.actionsPrewarm || null;
        state.draft.speculation = payload.speculation || null;
        renderActionsPrewarm();
        maybeOpenPreparedSummary();
        pollActionPrewarm();
      } catch (error) {
        prewarmTimer = window.setTimeout(pollActionPrewarm, 5000);
      }
    }, GENERATION_POLL_MS);
  }

  // On the Summary screen with nothing written yet, the Summary the server
  // has been preparing (or is preparing) is what the Generate button would
  // produce, so start it without the click. Without the speculative pipeline
  // there is no such notice and the button behaves as before.
  function maybeOpenPreparedSummary() {
    if (!state.draft || state.currentStep !== STAGE_STEP.summary || rendering) return;
    if (generationRunning() || autoSummaryStarted) return;
    if (String(state.draft.executiveSummary || '').trim()) return;
    if (!speculationFor('summary')) return;
    autoSummaryStarted = true;
    startBackgroundStage('summary');
  }
  var autoSummaryStarted = false;

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
    var prior = state.draft.meetingObjectives || [];
    state.draft.meetingObjectives = Array.from(document.querySelectorAll('[data-objective-index]'))
      .map(function (field, index) {
        var value = field.value.trim(); var old = prior[index];
        if (!value) return null;
        return typeof old === 'object' ? Object.assign({}, old, {text:value}) : {id:'objective-'+(index+1),text:value,evidenceIds:[]};
      }).filter(Boolean);
  }

  function renderSummary() {
    var draft = state.draft || {};
    var summary = document.getElementById('executiveSummary');
    if (summary && summary !== document.activeElement) {
      var value = draft.executiveSummary || '';
      if (summary.value !== value) summary.value = value;
    }
    var objectives = draft.meetingObjectives || [];
    document.getElementById('objectivesList').innerHTML = objectives.map(function (item, index) {
      var objectiveText = typeof item === 'string' ? item : item.text;
      return '<div class="record-row"><textarea data-objective-index="' + index + '" rows="2" aria-label="Objective ' + (index + 1) + '">' + escapeHtml(objectiveText) + '</textarea><div class="record-tools"><button class="delete quiet" data-remove-objective="' + index + '" type="button">Remove</button></div></div>';
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
      setStatus('Transcript prepared. Check the meeting details before continuing.', false, 'details');
    } catch (error) { setStatus(error.message, true); }
    finally { setBusy(false); }
  }

  function recordDomId(kind, id, fallback) {
    var key = String(id || fallback || '').replace(/[^a-zA-Z0-9_-]+/g, '-');
    return 'minutes-' + kind + '-' + key;
  }

  function topicSupportingDetails(topic, topicIndex) {
    var labels = { points: 'Discussion', decisions: 'Decision', openQuestions: 'Open question' };
    var rows = ['points', 'decisions', 'openQuestions'].flatMap(function (field) {
      return (topic[field] || []).flatMap(function (item, itemIndex) {
        return (item.supportingDetails || []).map(function (detail, detailIndex) {
          return { field:field, item:item, itemIndex:itemIndex, detail:detail, detailIndex:detailIndex };
        });
      });
    });
    if (!rows.length) return '';
    return '<section class="supporting-context"><div class="supporting-context-head"><h3>Supporting context</h3><span>' + rows.length + ' item' + (rows.length === 1 ? '' : 's') + '</span></div><p class="muted">Related facts are grouped here so you can review context without opening each sentence.</p><div class="supporting-detail-list">' + rows.map(function (row) {
      return '<div class="supporting-detail"><div class="supporting-parent"><span>' + escapeHtml(labels[row.field]) + '</span><strong>' + escapeHtml(row.item.text || '') + '</strong></div><p>' + escapeHtml(row.detail.text || '') + '</p><div class="record-tools">' + evidenceBlock(row.detail.evidenceIds) + '<button class="secondary compact" data-promote-supporting="' + row.detailIndex + '" data-parent-field="' + row.field + '" data-topic-index="' + topicIndex + '" data-item-index="' + row.itemIndex + '" type="button">Promote to minutes</button></div></div>';
    }).join('') + '</div></section>';
  }

  function discussionPropositions(topic, topicIndex) {
    var labels = { points: 'Discussion', decisions: 'Decision', openQuestions: 'Open question' };
    var rows = ['points', 'decisions', 'openQuestions'].flatMap(function (field) {
      return (topic[field] || []).map(function (item, itemIndex) { return {field:field,item:item,itemIndex:itemIndex}; });
    });
    return '<div class="record-section proposition-section"><div class="record-section-head"><h3>Key meeting content</h3><div class="proposition-add"><button class="secondary compact" data-add-record="points" data-topic-index="' + topicIndex + '" type="button">Add discussion</button><button class="secondary compact" data-add-record="decisions" data-topic-index="' + topicIndex + '" type="button">Add decision</button><button class="secondary compact" data-add-record="openQuestions" data-topic-index="' + topicIndex + '" type="button">Add open question</button></div></div><div class="record-list proposition-list">' + (rows.map(function (row) {
      var label = labels[row.field];
      var targetId = recordDomId('discussion', row.item.id, topicIndex + '-' + row.field + '-' + row.itemIndex);
      return '<div id="' + escapeHtml(targetId) + '" class="record-row proposition-row"><div class="proposition-kind ' + escapeHtml(row.field) + '">' + escapeHtml(label) + '</div><textarea data-record-field="' + row.field + '" data-topic-index="' + topicIndex + '" data-item-index="' + row.itemIndex + '" aria-label="' + escapeHtml(label) + '">' + escapeHtml(row.item.text || '') + '</textarea><div class="record-tools">' + evidenceBlock(row.item.evidenceIds) + (rows.length > 1 ? '<button class="secondary quiet" data-demote-record="' + row.field + '" data-topic-index="' + topicIndex + '" data-item-index="' + row.itemIndex + '" type="button">Move to context</button>' : '') + '<button class="delete quiet" data-remove-record="' + row.field + '" data-topic-index="' + topicIndex + '" data-item-index="' + row.itemIndex + '" type="button">Remove</button></div></div>';
    }).join('') || '<p class="muted record-empty">No meeting content recorded.</p>') + '</div>' + topicSupportingDetails(topic, topicIndex) + '</div>';
  }

  function renderDiscussion() {
    if (generationRunning('discussion')) {
      document.getElementById('discussionList').innerHTML = '<p class="generating">The agent is drafting the discussion from your transcript. ' + escapeHtml(generationSaveText()) + '</p>';
      return;
    }
    var discussion = (state.draft && state.draft.discussion) || [];
    document.getElementById('discussionList').innerHTML = discussion.map(function (topic, index) {
      return '<article class="discussion-card"><div class="card-head"><label class="topic-field"><span class="visually-hidden">Discussion topic</span><input data-topic-index="' + index + '" data-topic value="' + escapeHtml(topic.topic || '') + '" aria-label="Discussion topic" placeholder="Topic"></label><button class="delete" data-delete-topic="' + index + '" type="button">Remove topic</button></div>' + discussionPropositions(topic, index) + '</article>';
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

  function cloneEditorValue(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function discussionRecordHasText(record) {
    return Boolean(record && String(record.text || '').trim());
  }

  function topicHasDiscussionText(topic) {
    return ['points', 'decisions', 'openQuestions'].some(function (field) {
      return (topic[field] || []).some(discussionRecordHasText);
    });
  }

  function rememberPendingDiscussion() {
    if (!state.draft) return;
    (state.draft.discussion || []).forEach(function (topic) {
      var topicId = String(topic.id || '');
      if (/^manual-topic-/.test(topicId) && !topicHasDiscussionText(topic)) {
        discussionEditorState.pendingTopics[topicId] = cloneEditorValue(topic);
      } else if (topicId) delete discussionEditorState.pendingTopics[topicId];
      ['points', 'decisions', 'openQuestions'].forEach(function (field) {
        (topic[field] || []).forEach(function (record) {
          var recordId = String(record.id || '');
          if (/^manual-/.test(recordId) && !discussionRecordHasText(record)) {
            discussionEditorState.pendingRecords[recordId] = {
              topicId: topicId, field: field, record: cloneEditorValue(record)
            };
          } else if (recordId) delete discussionEditorState.pendingRecords[recordId];
        });
      });
    });
  }

  function restorePendingDiscussion(draft) {
    var discussion = Array.isArray(draft.discussion) ? draft.discussion : [];
    Object.keys(discussionEditorState.pendingTopics).forEach(function (id) {
      if (!discussion.some(function (topic) { return topic.id === id; })) {
        discussion.push(cloneEditorValue(discussionEditorState.pendingTopics[id]));
      }
    });
    Object.keys(discussionEditorState.pendingRecords).forEach(function (id) {
      var pending = discussionEditorState.pendingRecords[id];
      var topic = discussion.find(function (candidate) { return candidate.id === pending.topicId; });
      if (!topic) return;
      var list = topic[pending.field] || (topic[pending.field] = []);
      if (!list.some(function (record) { return record.id === id; })) list.push(cloneEditorValue(pending.record));
    });
    draft.discussion = discussion;
    return draft;
  }

  function forgetPendingDiscussion(value) {
    if (!value || typeof value !== 'object') return;
    if (value.id) {
      delete discussionEditorState.pendingTopics[value.id];
      delete discussionEditorState.pendingRecords[value.id];
    }
    Object.keys(value).forEach(function (key) { forgetPendingDiscussion(value[key]); });
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
    var actionId = String(action.id || ('action-' + index));
    var ownerDraft = actionEditorState.customOwners[actionId] || {};
    return '<div class="owner-chips">' + chips + '</div><div class="owner-add"><select data-add-owner data-action-index="' + index + '" data-action-id="' + escapeHtml(actionId) + '" aria-label="Add an attendee as owner"><option value="">Add owner...</option>' + options + '<option value="__other">Someone else...</option></select><input data-owner-other data-action-index="' + index + '" data-action-id="' + escapeHtml(actionId) + '" value="' + escapeHtml(ownerDraft.value || '') + '" placeholder="Name" aria-label="Add another owner by name"' + (ownerDraft.visible ? '' : ' hidden') + '></div>';
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
    if (generationRunning('actions')) {
      var generation = state.draft.generation || {};
      var preview = Array.isArray(generation.previewActions) ? generation.previewActions : [];
      var prior = Array.isArray(state.draft.actions) ? state.draft.actions : [];
      var intro = preview.length
        ? 'You can start reading these while the final missed-action checks continue. Editing unlocks when the final version is ready.'
        : prior.length
          ? 'These saved actions remain visible while a refreshed version is prepared.'
          : 'Possible actions will appear here as soon as the evidence check finishes.';
      var readOnlyRows = function (items, className) { return items.map(function (item) {
        return '<tr class="preview-action-row ' + className + '"><td data-label="Action"><div>' + escapeHtml(item.action || '') + '</div><div class="action-tools">' + evidenceBlock(item.evidenceIds) + '</div></td><td data-label="Owners"><div class="preview-action-meta">' + escapeHtml((item.owners || []).join(', ') || 'Not stated') + '</div></td><td data-label="Timing"><div class="preview-action-meta">' + escapeHtml(timingText(item.timing)) + '</div></td></tr>';
      }).join(''); };
      var sections = '';
      if (preview.length) sections += '<tr class="generation-section-row"><th colspan="3">Evidence-checked preview</th></tr>' + readOnlyRows(preview, 'preview-current');
      if (prior.length) sections += '<tr class="generation-section-row saved-actions-heading"><th colspan="3">Previously saved actions</th></tr>' + readOnlyRows(prior, 'preview-saved');
      document.getElementById('actionsBody').innerHTML = '<tr class="generation-row"><td colspan="3"><p class="generating">' + escapeHtml(intro) + '</p></td></tr>' + sections;
      return;
    }
    var actions = (state.draft && state.draft.actions) || [];
    document.getElementById('actionsBody').innerHTML = actions.map(function (item, index) {
      var timing = item.timing || {kind:'not_stated',wording:'',exactDate:''};
      var targetId = recordDomId('action', item.id, index);
      return '<tr id="' + escapeHtml(targetId) + '" data-action-row="' + index + '" data-action-id="' + escapeHtml(item.id || '') + '"><td data-label="Action"><textarea data-action-index="' + index + '" data-action aria-label="Action ' + (index + 1) + '">' + escapeHtml(item.action || '') + '</textarea><div class="action-tools">' + evidenceBlock(item.evidenceIds) + '<button class="delete quiet" data-delete-action="' + index + '" type="button">Remove</button></div></td><td data-label="Owners">' + ownerEditor(item, index) + '</td><td data-label="Timing">' + timingEditor(timing, index) + '</td></tr>';
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

  function rememberPendingActions() {
    if (!state.draft) return;
    (state.draft.actions || []).forEach(function (action) {
      if (/^manual-action-/.test(String(action.id || '')) && !String(action.action || '').trim()) {
        actionEditorState.pendingRows[action.id] = JSON.parse(JSON.stringify(action));
      } else if (action.id) delete actionEditorState.pendingRows[action.id];
    });
  }

  function linkedReviewFlagIds(value) {
    if (!value || typeof value !== 'object') return [];
    var own = Array.isArray(value.reviewFlagIds) ? value.reviewFlagIds : [];
    var nested = Array.isArray(value) ? value : Object.keys(value).map(function (key) { return value[key]; });
    return own.concat(nested.flatMap(linkedReviewFlagIds));
  }

  function resolveDeletedTargetFlags(flagIds) {
    if (!state.draft || !flagIds || !flagIds.length) return;
    var stillLinked = new Set(linkedReviewFlagIds([
      state.draft.discussion || [], state.draft.actions || []
    ]));
    var removed = new Set(flagIds);
    state.draft.reviewFlags = (state.draft.reviewFlags || []).map(function (flag) {
      if (!removed.has(flag.id) || stillLinked.has(flag.id)) return flag;
      return Object.assign({}, flag, { status: 'dismissed' });
    });
  }

  function restorePendingActions(draft) {
    var actions = Array.isArray(draft.actions) ? draft.actions : [];
    Object.keys(actionEditorState.pendingRows).forEach(function (id) {
      if (!actions.some(function (action) { return action.id === id; })) actions.push(actionEditorState.pendingRows[id]);
    });
    draft.actions = actions;
    return draft;
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

  function flagTarget(flag) {
    var flagId = String(flag && flag.id || '');
    if (!flagId || !state.draft) return null;
    for (var topicIndex = 0; topicIndex < (state.draft.discussion || []).length; topicIndex += 1) {
      var topic = state.draft.discussion[topicIndex];
      for (var fieldIndex = 0; fieldIndex < 3; fieldIndex += 1) {
        var field = ['points', 'decisions', 'openQuestions'][fieldIndex];
        for (var itemIndex = 0; itemIndex < (topic[field] || []).length; itemIndex += 1) {
          var item = topic[field][itemIndex];
          if ((item.reviewFlagIds || []).indexOf(flagId) >= 0) return {
            stage: 2,
            elementId: recordDomId('discussion', item.id, topicIndex + '-' + field + '-' + itemIndex),
            label: field === 'decisions' ? 'Decision' : field === 'openQuestions' ? 'Open question' : 'Discussion sentence',
            text: item.text || ''
          };
        }
      }
    }
    for (var actionIndex = 0; actionIndex < (state.draft.actions || []).length; actionIndex += 1) {
      var action = state.draft.actions[actionIndex];
      if ((action.reviewFlagIds || []).indexOf(flagId) >= 0) return {
        stage: 3,
        elementId: recordDomId('action', action.id, actionIndex),
        label: 'Action',
        text: action.action || ''
      };
    }
    return null;
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
      var target = flagTarget(flag);
      if (target) body += '<div class="flag-target"><span>Affected ' + escapeHtml(target.label.toLowerCase()) + '</span><blockquote>' + escapeHtml(target.text) + '</blockquote><button class="secondary compact" data-view-flag-target="' + escapeHtml(target.elementId) + '" data-target-step="' + target.stage + '" type="button">View and edit</button></div>';
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

  function discussionProposalLabel(change) {
    if (!change || !change.before || !change.after) return '';
    function counts(topic) {
      var records=['points','decisions','openQuestions'].flatMap(function(field){return (topic[field]||[]);});
      return { core:records.length, supporting:records.reduce(function(total,item){return total+(item.supportingDetails||[]).length;},0) };
    }
    var before=counts(change.before), after=counts(change.after);
    if(after.core<before.core && after.supporting>before.supporting) return 'Proposed merge or move to context';
    if(after.core>before.core && after.supporting<before.supporting) return 'Proposed promotion to minutes';
    if(after.core>before.core+1) return 'Proposed split';
    if(after.core<before.core) return 'Proposed merge';
    return '';
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
      if (change.reviewContext) {
        content += '<div class="proposal-rationale"><div><strong>Why this needs review:</strong> ' + escapeHtml(change.reviewContext.reason || '') + '</div>'
          + (change.reviewContext.label ? '<div class="commitment-chain"><span>Evidence path</span> ' + escapeHtml(change.reviewContext.label) + '</div>' : '')
          + ((change.reviewContext.evidenceIds || []).length ? evidenceBlock(change.reviewContext.evidenceIds) : '') + '</div>';
      }
      var semanticLabel=proposal.stage==='discussion' ? discussionProposalLabel(change) : '';
      return '<div class="proposal-change"><input type="checkbox" data-proposal-change="' + escapeHtml(change.id) + '" checked aria-label="Select this proposed change"><span class="proposal-kind">' + escapeHtml(semanticLabel || changeLabels[change.type] || 'Suggested change') + '</span><div class="proposal-content">' + content + '</div></div>';
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
    var objectives = (draft.meetingObjectives || []).map(function(item){return typeof item === 'string' ? item : item.text;}).filter(Boolean);
    var summaryHtml = (objectives.length ? '<section><h3>Meeting objectives</h3><ul>' + objectives.map(function (item) { return '<li>' + escapeHtml(item) + '</li>'; }).join('') + '</ul></section>' : '')
      + (draft.executiveSummary ? '<section><h3>Executive summary</h3><p>' + escapeHtml(draft.executiveSummary) + '</p></section>' : '');
    var finalDiscussion = (draft.discussion || []).map(function (topic) {
      var rows = [{key:'points',label:'Discussion'}, {key:'decisions',label:'Decision'}, {key:'openQuestions',label:'Open question'}]
        .flatMap(function (group) { return (topic[group.key] || []).map(function (item) { return {label:group.label,text:item.text}; }); });
      return '<h4>' + escapeHtml(topic.topic) + '</h4>' + (rows.length ? '<ul class="final-propositions">' + rows.map(function (item) { return '<li><span class="final-kind">' + escapeHtml(item.label) + '</span>' + escapeHtml(item.text) + '</li>'; }).join('') + '</ul>' : '');
    }).join('');
    document.getElementById('finalDocument').innerHTML = '<h2>' + escapeHtml(details.meetingTitle || 'Meeting minutes') + '</h2><p><strong>Date:</strong> ' + escapeHtml(details.meetingDate ? formatUkDate(details.meetingDate) : 'Not stated') + '<br><strong>Location:</strong> ' + escapeHtml(details.meetingLocation || 'Not stated') + '<br><strong>Meeting type:</strong> ' + escapeHtml(details.meetingType || 'Not stated') + '</p><p><strong>Internal attendees:</strong> ' + escapeHtml((details.internalAttendees || []).join(', ') || 'Not stated') + '<br><strong>' + escapeHtml(details.clientAttendeeLabel === 'External' ? 'External' : 'Client') + ' attendees:</strong> ' + escapeHtml((details.clientAttendees || []).join(', ') || 'Not stated') + '</p>' + summaryHtml + '<section><h3>Meeting content</h3>' + (finalDiscussion || '<p>No meeting content recorded.</p>') + '</section><section><h3>Actions</h3><div class="actions-wrap"><table class="actions-table"><thead><tr><th>Action</th><th>Owners</th><th>Timing</th></tr></thead><tbody>' + ((draft.actions || []).map(function (action) { return '<tr><td>' + escapeHtml(action.action) + '</td><td>' + escapeHtml((action.owners || []).join(', ') || 'Not stated') + '</td><td>' + escapeHtml(timingText(action.timing)) + '</td></tr>'; }).join('') || '<tr><td colspan="3">No actions recorded.</td></tr>') + '</tbody></table></div></section>';
  }

  function renderAll() {
    var snapshot = captureFocus();
    rendering = true;
    uploadZone.hidden = Boolean(state.draft);
    detailsEditor.hidden = !state.draft;
    document.getElementById('saveStrip').hidden = !state.draft;
    if (state.draft) {
      renderDetails(); renderSteer(); renderDiscussion(); renderActions(); renderSummary(); renderFlags(); renderProposal();
      renderActionsPrewarm();
      var activeGenerationStage = state.draft.generation && state.draft.generation.status === 'running'
        ? state.draft.generation.stage : '';
      var disabledControls = {
        generateActions: Boolean(activeGenerationStage),
        addDiscussion: activeGenerationStage === 'discussion',
        applyDiscussionEdit: Boolean(activeGenerationStage),
        generateSummary: Boolean(activeGenerationStage),
        addAction: activeGenerationStage === 'actions',
        applyActionsEdit: Boolean(activeGenerationStage),
        auditActions: Boolean(activeGenerationStage),
        toSummary: activeGenerationStage === 'actions'
      };
      Object.keys(disabledControls).forEach(function (id) {
        var button = document.getElementById(id);
        if (button) button.disabled = disabledControls[id];
      });
      var discussionInstruction = document.getElementById('discussionInstruction');
      var actionsInstruction = document.getElementById('actionsInstruction');
      if (discussionInstruction) discussionInstruction.disabled = generationRunning('discussion');
      if (actionsInstruction) actionsInstruction.disabled = generationRunning('actions');
      var stale = state.draft.staleStages || [];
      document.getElementById('staleNotice').hidden = !stale.length;
      document.getElementById('staleStages').textContent = stale.join(' and ');
    } else document.getElementById('staleNotice').hidden = true;
    showStep(state.draft ? state.currentStep : 0, { persist: false });
    renderGenerationProgress();
    rendering = false;
    restoreFocus(snapshot);
  }

  function adoptDraft(draft) {
    if (!draft) return;
    var replacingExistingDraft = Boolean(state.draft);
    rememberPendingActions();
    rememberPendingDiscussion();
    document.getElementById('reloadDraft').hidden = true;
    state.draft = restorePendingActions(restorePendingDiscussion(draft));
    // Responses to saves and background work must not navigate the reviewer.
    // On the initial load, restore the separately persisted selected screen;
    // older drafts fall back to their furthest unlocked step.
    if (!replacingExistingDraft) {
      state.currentStep = Math.max(0, Math.min(MAX_STEP,
        Number(draft.selectedStep == null ? draft.currentStep : draft.selectedStep) || 0));
    }
    renderAll();
    // A reload in the middle of a run must not look dead.
    if (generationRunning()) pollGeneration();
    else pollActionPrewarm();
    if (generationRunning()) {
      setSaveStatus(generationSaveText(), pendingGenerationEdits ? 'waiting' : 'generating');
    } else if (hasTransientEditorState()) {
      setSaveStatus('New unfinished entries are kept in this tab until their text is entered.', 'local-only');
    } else {
      setSaveStatus(savedStatusText(draft.updatedAt), 'saved');
    }
  }

  function readEditors() {
    if (!state.draft) return;
    readDetails(); readSteer(); readDiscussion(); readActions(); readSummary();
    state.draft.currentStep = Math.max(Number(state.draft.currentStep || 0), state.currentStep);
    state.draft.selectedStep = state.currentStep;
  }

  function draftPatchBody(statusValue) {
    var body = {
      revision: state.draft.revision,
      // Tells the server this client speaks the six-step numbering. A tab loaded
      // before the deploy will not send it, and its currentStep is then ignored
      // rather than being read as a screen it did not mean.
      payloadVersion: 5,
      details: state.draft.details,
      steer: state.draft.steer || '',
      discussion: state.draft.discussion,
      actions: state.draft.actions,
      executiveSummary: state.draft.executiveSummary || '',
      meetingObjectives: state.draft.meetingObjectives || [],
      reviewFlags: state.draft.reviewFlags,
      staleStages: state.draft.staleStages || [],
      currentStep: Math.max(Number(state.draft.currentStep || 0), state.currentStep),
      selectedStep: state.currentStep
    };
    if (statusValue) body.status = statusValue;
    return body;
  }

  function draftUrl(suffix) {
    return '/api/meeting-minutes-agent/drafts/' + encodeURIComponent(state.draft.draftId) + (suffix || '');
  }

  function scheduleSave() {
    if (rendering || !state.draft) return;
    rememberPendingDiscussion();
    editVersion += 1;
    clearTimeout(saveTimer);
    // While a background run is in flight, hold the save. Its completion writes
    // against a fresh read, so letting an autosave race it would surface the
    // conflict banner over the reviewer's own generation. Flushed on completion.
    if (generationRunning()) {
      pendingGenerationEdits = true;
      setSaveStatus(generationSaveText(), 'waiting');
      renderDiscussion();
      renderActions();
      return;
    }
    setSaveStatus('Unsaved changes - saving shortly...', 'dirty');
    saveTimer = window.setTimeout(function () { saveDraftNow(); }, 900);
  }

  async function saveDraftNow(statusValue) {
    if (!state.draft) return null;
    clearTimeout(saveTimer);
    if (saveInFlight) { saveQueued = true; await saveInFlight; if (!saveQueued) return state.draft; saveQueued = false; }
    readEditors();
    var requestEditVersion = editVersion;
    setSaveStatus('Saving...', 'saving');
    saveInFlight = jsonRequest(draftUrl(), {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(draftPatchBody(statusValue))}).then(function (payload) {
      if (editVersion !== requestEditVersion) {
        // A newer keystroke landed while this request was in flight. Advance the
        // revision but do not replace the newer editor values with the response.
        state.draft.revision = payload.draft.revision;
        state.draft.updatedAt = payload.draft.updatedAt;
        setSaveStatus('Unsaved changes - saving shortly...', 'dirty');
        return state.draft;
      }
      pendingGenerationEdits = false;
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
      var selectedStep = stage === 'actions' ? state.currentStep : STAGE_STEP[stage];
      var payload = await jsonRequest(draftUrl('/generate-background'), {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({stage:stage,revision:state.draft.revision,selectedStep:selectedStep})});
      adoptDraft(payload.draft);
      state.draft.generation = payload.generation;
      completedGenerationNotice = null;
      pendingGenerationEdits = false;
      if (stage === 'actions') actionsInvalidatedDuringGeneration = false;
      generationPollKey = [state.draft.draftId, stage, payload.generation && payload.generation.startedAt].join('|');
      if (stage !== 'actions') showStep(STAGE_STEP[stage], { scroll: true });
      renderAll();
      setSaveStatus(generationSaveText(), 'generating');
      setStatus((payload.generation && payload.generation.message) || 'Preparing independent quality checks…', false, stage);
      pollGeneration();
    } catch (error) { setStatus(error.message, true, stage); }
  }

  function pollGeneration() {
    clearTimeout(generationTimer);
    if (!state.draft || !generationRunning()) return;
    generationTimer = window.setTimeout(async function () {
      if (!state.draft) return;
      var expectedDraftId = state.draft.draftId;
      var expectedGeneration = state.draft.generation || {};
      var expectedKey = [expectedDraftId, expectedGeneration.stage, expectedGeneration.startedAt].join('|');
      try {
        var payload = await jsonRequest(draftUrl('/generation'));
        var currentGeneration = state.draft && state.draft.generation;
        var currentKey = [state.draft && state.draft.draftId, currentGeneration && currentGeneration.stage, currentGeneration && currentGeneration.startedAt].join('|');
        if (!state.draft || state.draft.draftId !== expectedDraftId || (generationPollKey && currentKey !== expectedKey)) return;
        var activeStage = (state.draft.generation && state.draft.generation.stage) || 'discussion';
        state.draft.generation = payload.generation;
        if (payload.speculation !== undefined) state.draft.speculation = payload.speculation;
        if (payload.generation && payload.generation.status === 'running') {
          setSaveStatus(generationSaveText(), pendingGenerationEdits ? 'waiting' : 'generating');
          setStatus(payload.generation.message || 'The agent is checking the prepared transcript…', false, activeStage);
          renderGenerationProgress();
          if (activeStage === 'actions') renderActions();
          pollGeneration(); return;
        }
        if (payload.draft) {
          // Preserve every field outside the stage-owned result. Reviewers can
          // navigate while generation runs, and a completion response must not
          // replace edits they made on another screen.
          var localDraft = state.draft;
          var completedDraft = payload.draft;
          completedDraft.details = localDraft.details;
          completedDraft.steer = localDraft.steer;
          if (activeStage !== 'discussion') completedDraft.discussion = localDraft.discussion;
          if (activeStage !== 'actions') completedDraft.actions = localDraft.actions;
          if (activeStage !== 'summary') {
            completedDraft.executiveSummary = localDraft.executiveSummary;
            completedDraft.meetingObjectives = localDraft.meetingObjectives;
          }
          var generationFailed = Boolean(payload.generation && payload.generation.status === 'failed');
          var localStale = localDraft.staleStages || [];
          if (!generationFailed && !actionsInvalidatedDuringGeneration) {
            localStale = localStale.filter(function (value) { return value !== activeStage; });
          }
          completedDraft.staleStages = Array.from(new Set([
            ...(completedDraft.staleStages || []), ...localStale
          ]));
          if (activeStage === 'actions' && state.currentStep !== STAGE_STEP.actions
            && !(payload.generation && payload.generation.status === 'failed')) {
            completedGenerationNotice = {
              stage:'actions',
              message:'The final actions are ready. Open Actions when you are ready to review them.'
            };
          }
          adoptDraft(completedDraft);
          state.draft.generation = payload.generation;
          if (activeStage === 'actions' && !generationFailed) actionsInvalidatedDuringGeneration = false;
          renderAll();
        }
        if (payload.generation && payload.generation.status === 'failed') {
          setStatus(payload.generation.error || 'The agent could not finish. Try generating again.', true, activeStage);
        } else {
          setStatus(state.draft.qualityNotice || (activeStage === 'discussion' ? 'Discussion draft generated. Review its evidence and flags.' : activeStage === 'actions' ? 'Action draft generated and independently checked. Review any proposed additions.' : 'Summary generated from the confirmed minutes.'), Boolean(state.draft.qualityNotice), activeStage);
        }
        generationPollKey = '';
        if (pendingGenerationEdits) scheduleSave();
        else if (hasTransientEditorState()) setSaveStatus('Unfinished entries are not saved yet. Keep this tab open.', 'local-only');
        else setSaveStatus(savedStatusText(state.draft.updatedAt), 'saved');
      } catch (error) { setStatus(error.message, true, expectedGeneration.stage); }
    }, GENERATION_POLL_MS);
  }

  async function runAgent(stage, instruction) {
    if (!state.draft) return false;
    try { await saveDraftNow(); } catch (error) { setStatus(error.message, true); return false; }
    setBusy(true, instruction ? 'The agent is preparing a change preview...' : 'The agent is reviewing the prepared transcript...', stage);
    try {
      var payload; var totalAttempts = agentRetryDelaysSeconds.length + 1;
      for (var attempt = 0; attempt < totalAttempts; attempt += 1) {
        if (attempt > 0) await waitForAgentRetry(agentRetryDelaysSeconds[attempt - 1], attempt + 1, totalAttempts, stage);
        try {
          payload = await jsonRequest('/api/meeting-minutes-agent/generate', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({stage:stage,draftId:state.draft.draftId,revision:state.draft.revision,instruction:instruction || ''})});
          break;
        } catch (error) {
          if (!(error.code === 'M365_AGENT_USAGE_LIMIT' && error.retryable) || attempt === totalAttempts - 1) throw error;
        }
      }
      adoptDraft(payload.draft);
      if (instruction) { renderProposal(); setStatus('Review the proposed changes. Nothing has been applied yet.', false, stage); }
      else {
        showStep(STAGE_STEP[stage] || 2, { scroll: true });
        setStatus(stage === 'discussion' ? 'Discussion draft generated. Review its evidence and flags.' : 'Action draft generated. Running the separate missed-action check next.', false, stage);
        if (stage === 'actions') await auditActions(true);
      }
      return true;
    } catch (error) { setStatus(error.message, true, stage); return false; }
    finally { setBusy(false); }
  }

  async function auditActions(automatic) {
    if (!state.draft) return;
    try { await saveDraftNow(); } catch (error) { setStatus(error.message, true); return; }
    setBusy(true, 'Checking the transcript for missed follow-up actions...', 'actions');
    try {
      var payload; var totalAttempts = agentRetryDelaysSeconds.length + 1;
      for (var attempt = 0; attempt < totalAttempts; attempt += 1) {
        if (attempt > 0) await waitForAgentRetry(agentRetryDelaysSeconds[attempt - 1], attempt + 1, totalAttempts, 'actions');
        try {
          payload = await jsonRequest(draftUrl('/audit-actions'), {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:state.draft.revision})});
          break;
        } catch (error) {
          if (!(error.code === 'M365_AGENT_USAGE_LIMIT' && error.retryable) || attempt === totalAttempts - 1) throw error;
        }
      }
      adoptDraft(payload.draft);
      setStatus(payload.proposal ? 'The completeness check found proposed actions. Review them before applying.' : 'The completeness check found no additional supported actions.', false, 'actions');
    } catch (error) { setStatus((automatic ? 'The action draft is available, but the completeness check failed: ' : '') + error.message, true, 'actions'); }
    finally { setBusy(false); }
  }

  async function reviewProposal(decision, acceptAll) {
    var proposal = state.draft && state.draft.pendingProposal; if (!proposal) return;
    var proposalStage = proposal.stage || '';
    var ids = Array.from(document.querySelectorAll('[data-proposal-change]:checked')).map(function (input) { return input.dataset.proposalChange; });
    try { await saveDraftNow(); } catch (error) { setStatus(error.message, true); return; }
    setBusy(true, decision === 'reject' ? 'Rejecting proposed changes...' : 'Applying selected changes...', proposalStage);
    try {
      var payload = await jsonRequest(draftUrl('/proposal'), {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:state.draft.revision,decision:decision,acceptAll:Boolean(acceptAll),changeIds:ids})});
      adoptDraft(payload.draft); setStatus(decision === 'reject' ? 'Proposed changes rejected.' : 'Selected agent changes applied.', false, proposalStage);
    } catch (error) { setStatus(error.message, true, proposalStage); }
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
      setStatus(isPdf ? 'PDF downloaded.' : 'Word document downloaded.', false, 'review');
    } catch (error) { setStatus(error.message, true, currentStageName()); }
    finally { setBusy(false); }
  }

  async function loadDraft(draftId) {
    setBusy(true, 'Loading your saved draft...');
    try { var payload = await jsonRequest('/api/meeting-minutes-agent/drafts/' + encodeURIComponent(draftId)); adoptDraft(payload.draft); setStatus('Saved draft restored.', false, currentStageName()); }
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
  document.getElementById('generateSummary').addEventListener('click', function () { startBackgroundStage('summary'); });
  document.getElementById('addObjective').addEventListener('click', function () {
    readSummary();
    state.draft.meetingObjectives = (state.draft.meetingObjectives || []).concat({id:'objective-'+Date.now(),text:'',evidenceIds:[]});
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
  document.getElementById('generateActions').addEventListener('click', function () { startBackgroundStage('actions'); });
  document.getElementById('viewGeneratedStage').addEventListener('click', function () {
    var generation = state.draft && state.draft.generation;
    var stage = generation ? generation.stage : completedGenerationNotice && completedGenerationNotice.stage;
    if (stage && STAGE_STEP[stage] != null) showStep(STAGE_STEP[stage], { scroll:true });
  });
  document.getElementById('auditActions').addEventListener('click', function () { auditActions(false); });
  document.getElementById('applyDiscussionEdit').addEventListener('click', function () { var input=document.getElementById('discussionInstruction'); if (!input.value.trim()) return setStatus('Describe the discussion edits you want.',true,'discussion'); runAgent('discussion',input.value.trim()).then(function(ok){if(ok)input.value='';}); });
  document.getElementById('applyActionsEdit').addEventListener('click', function () { var input=document.getElementById('actionsInstruction'); if (!input.value.trim()) return setStatus('Describe the action edits you want.',true,'actions'); runAgent('actions',input.value.trim()).then(function(ok){if(ok)input.value='';}); });
  document.getElementById('addDiscussion').addEventListener('click', function () {
    readDiscussion();
    var topic = {id:'manual-topic-'+Date.now(),topic:'',points:[],decisions:[],openQuestions:[]};
    state.draft.discussion.push(topic);
    discussionEditorState.pendingTopics[topic.id] = cloneEditorValue(topic);
    renderDiscussion();
    setSaveStatus('New topic is kept in this tab until you add meeting content.', 'local-only');
    var field = document.querySelector('[data-topic-index="' + (state.draft.discussion.length - 1) + '"][data-topic]');
    if (field) field.focus({ preventScroll:true });
  });

  document.getElementById('discussionList').addEventListener('click', function (event) {
    var add=event.target.closest('[data-add-record]');
    var remove=event.target.closest('[data-remove-record]');
    var demote=event.target.closest('[data-demote-record]');
    var promote=event.target.closest('[data-promote-supporting]');
    var topicButton=event.target.closest('[data-delete-topic]');
    if(!add && !remove && !demote && !promote && !topicButton) return;
    readDiscussion();
    // Only a change to real content makes the Actions outdated. Adding a blank
    // row, or deleting a row or topic that never had any text, changes nothing
    // the Actions were built from and must not ask for a regeneration.
    var material = Boolean(demote || promote);
    var addedRecord = null;
    if(add){
      var addTopic=state.draft.discussion[Number(add.dataset.topicIndex)];
      addedRecord={id:'manual-'+Date.now(),text:'',evidenceIds:[],reviewFlagIds:[],supportingDetails:[]};
      addTopic[add.dataset.addRecord].push(addedRecord);
      discussionEditorState.pendingRecords[addedRecord.id]={topicId:addTopic.id,field:add.dataset.addRecord,record:cloneEditorValue(addedRecord)};
    }
    if(remove){
      var removedRecord=state.draft.discussion[Number(remove.dataset.topicIndex)][remove.dataset.removeRecord].splice(Number(remove.dataset.itemIndex),1)[0];
      material = material || discussionRecordHasContent(removedRecord);
      forgetPendingDiscussion(removedRecord);
      resolveDeletedTargetFlags(linkedReviewFlagIds(removedRecord));
    }
    if(demote){
      var demoteTopic=state.draft.discussion[Number(demote.dataset.topicIndex)];
      var demoteList=demoteTopic && demoteTopic[demote.dataset.demoteRecord];
      var demoted=demoteList && demoteList[Number(demote.dataset.itemIndex)];
      var targets=demoteTopic && ['decisions','openQuestions','points'].flatMap(function(field){return (demoteTopic[field]||[]).filter(function(item){return item!==demoted;});});
      if(demoted && targets && targets.length){
        var target=targets[0];
        target.supportingDetails=(target.supportingDetails||[]).concat([{id:demoted.id,text:demoted.text,evidenceIds:demoted.evidenceIds||[]}],demoted.supportingDetails||[]);
        demoteList.splice(Number(demote.dataset.itemIndex),1);
      }
    }
    if(promote){
      var promoteTopic=state.draft.discussion[Number(promote.dataset.topicIndex)];
      var promoteList=promoteTopic && promoteTopic[promote.dataset.parentField];
      var parent=promoteList && promoteList[Number(promote.dataset.itemIndex)];
      var promoted=parent && (parent.supportingDetails||[]).splice(Number(promote.dataset.promoteSupporting),1)[0];
      if(promoted) promoteList.push({id:promoted.id||('promoted-'+Date.now()),text:promoted.text,evidenceIds:promoted.evidenceIds||[],reviewFlagIds:[],supportingDetails:[]});
    }
    if(topicButton){
      var removedTopic=state.draft.discussion.splice(Number(topicButton.dataset.deleteTopic),1)[0];
      material = material || discussionTopicHasContent(removedTopic);
      forgetPendingDiscussion(removedTopic);
      resolveDeletedTargetFlags(linkedReviewFlagIds(removedTopic));
    }
    if(material) markDownstreamStale();
    renderDiscussion();
    if(addedRecord){
      rememberPendingDiscussion();
      setSaveStatus('New discussion row is kept in this tab until you enter its text.', 'local-only');
      var addedField=document.getElementById(recordDomId('discussion',addedRecord.id));
      if(addedField){var editor=addedField.querySelector('textarea');if(editor)editor.focus({preventScroll:true});}
      return;
    }
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
    var removedAction = state.draft.actions.splice(Number(button.dataset.deleteAction),1)[0];
    resolveDeletedTargetFlags(linkedReviewFlagIds(removedAction));
    if (removedAction && removedAction.id) {
      delete actionEditorState.pendingRows[removedAction.id];
      delete actionEditorState.customOwners[removedAction.id];
    }
    renderActions(); scheduleSave();
  });

  document.getElementById('actionsBody').addEventListener('change', function (event) {
    var select = event.target.closest('[data-add-owner]');
    if (!select || !select.value) return;
    var index = Number(select.dataset.actionIndex);
    if (select.value === '__other') {
      var other = select.parentElement.querySelector('[data-owner-other]');
      actionEditorState.customOwners[select.dataset.actionId] = { visible:true, value:'' };
      select.value = '';
      if (other) { other.hidden = false; other.focus(); }
      setSaveStatus('Custom owner entry is kept in this tab until you finish it.', 'local-only');
      return;
    }
    if (addOwner(index, select.value)) { rerenderActions(); scheduleSave(); }
    else select.value = '';
  });

  function commitOtherOwner(input) {
    if (!input) return;
    var actionId = input.dataset.actionId;
    if (!input.value.trim()) {
      delete actionEditorState.customOwners[actionId];
      input.hidden = true;
      refreshLeaveSafety();
      return;
    }
    var index = (state.draft.actions || []).findIndex(function (action) { return action.id === actionId; });
    if (index < 0) index = Number(input.dataset.actionIndex);
    var added = addOwner(index, input.value);
    input.value = '';
    delete actionEditorState.customOwners[actionId];
    refreshLeaveSafety();
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
    // A controlled render replaces the action table and naturally blurs its
    // focused field. Committing from that synthetic blur would recursively
    // replace the same DOM subtree and can both throw and lose unfinished text.
    if (input && !rendering) commitOtherOwner(input);
  });

  document.getElementById('addAction').addEventListener('click', function () {
    readActions();
    var action = {id:'manual-action-'+Date.now(),action:'',owners:[],timing:{kind:'not_stated',wording:'',exactDate:''},evidenceIds:[],reviewFlagIds:[]};
    state.draft.actions.push(action);
    actionEditorState.pendingRows[action.id] = JSON.parse(JSON.stringify(action));
    renderActions();
    setSaveStatus('New action row is kept in this tab until you enter the action.', 'local-only');
    var field = document.querySelector('#' + recordDomId('action', action.id) + ' [data-action]');
    if (field) field.focus({ preventScroll:true });
  });
  document.getElementById('flagList').addEventListener('click', function (event) {
    var targetButton = event.target.closest('[data-view-flag-target]');
    if (targetButton) {
      showStep(Number(targetButton.dataset.targetStep), { scroll:true });
      window.setTimeout(function () {
        var target = document.getElementById(targetButton.dataset.viewFlagTarget);
        if (!target) return;
        target.scrollIntoView({behavior:'smooth',block:'center'});
        target.classList.add('flag-target-highlight');
        var editor = target.querySelector('textarea,input');
        if (editor) editor.focus({preventScroll:true});
        window.setTimeout(function () { target.classList.remove('flag-target-highlight'); }, 2400);
      }, 0);
      return;
    }
    var button=event.target.closest('[data-flag-index]'); if(!button)return; var index=Number(button.dataset.flagIndex); var note=document.querySelector('[data-flag-correction="'+index+'"]'); state.draft.reviewFlags[index].status=button.dataset.flagStatus; if(note)state.draft.reviewFlags[index].correctionNote=note.value.trim(); renderFlags(); scheduleSave();
  });
  document.getElementById('acceptAllProposal').addEventListener('click', function () { reviewProposal('accept',true); });
  document.getElementById('acceptSelectedProposal').addEventListener('click', function () { reviewProposal('accept',false); });
  document.getElementById('rejectProposal').addEventListener('click', function () { reviewProposal('reject',false); });
  document.getElementById('openFinalReview').addEventListener('click', function () { renderFinal(); showStep(MAX_STEP, { scroll: true }); setStatus('Review the complete minutes. Open flags do not prevent saving or export.',false,'review'); });
  document.getElementById('saveMinutes').addEventListener('click', function () { saveDraftNow('complete').then(function(){setStatus('Minutes saved. You can resume them from Library.',false,'review');}).catch(function(error){setStatus(error.message,true,'review');}); });
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
    if (event.target.closest('#discussionList') || event.target.closest('#detailsEditor') || event.target.id === 'meetingSteer') {
      markDownstreamStale();
    }
    if (event.target.matches('[data-owner-other]')) {
      actionEditorState.customOwners[event.target.dataset.actionId] = { visible:true, value:event.target.value };
      setSaveStatus('Custom owner entry is kept in this tab until you finish it.', 'local-only');
      return;
    }
    if (event.target.matches('textarea,input,select') && !event.target.matches('[data-proposal-change],#includeEvidence,#transcriptFile,[data-add-owner],[data-owner-other]')) {
      readEditors();
      rememberPendingActions();
      rememberPendingDiscussion();
      autoGrow(event.target.parentElement);
      scheduleSave();
    }
  });

  window.addEventListener('beforeunload', function (event) {
    if (!state.draft) return;
    var saveState = document.getElementById('saveStatus').dataset.state;
    if (!['dirty','waiting','local-only'].includes(saveState)) return;
    // Waiting edits cannot safely race progress writes, and an empty manual row
    // is intentionally client-only. Be honest and let the browser warn instead
    // of claiming a keepalive request made either state resumable.
    if (saveState === 'waiting' || saveState === 'local-only') {
      event.preventDefault();
      event.returnValue = '';
      return;
    }
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
