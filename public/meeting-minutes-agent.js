(function () {
  'use strict';

  var state = { draft: null, currentStep: 0 };
  var betaFlowEnabled = false;
  var betaFlowAllowed = false;
  var betaFlowUserId = '';
  var betaAccessReady;
  var agentRetryDelaysSeconds = [5, 15, 30];
  // 0 details, 1 (retired: focus), 2 discussion, 3 actions, 4 summary, 5 review
  // Index 1 is left reserved so drafts saved under the six-step numbering still
  // resolve to the right screen.
  var MAX_STEP = 5;
  // Autosave waits for a pause in typing before writing.
  var SAVE_DEBOUNCE_MS = 1500;
  var STAGE_STEP = { details: 0, focus: 1, discussion: 2, actions: 3, summary: 4, review: 5 };
  var GENERATION_POLL_MS = 3000;
  var GENERATION_RETRY_MS = 8000;
  var generationTimer = null;
  var prewarmTimer = null;
  var generationPollController = null;
  var completedGenerationNotice = null;
  var saveTimer = null;
  var savePending = false;
  var saveInFlight = null;
  var saveQueued = false;
  var pendingGenerationEdits = false;
  var pendingGenerationNavigation = false;
  var actionsInvalidatedDuringGeneration = false;
  var generationPollKey = '';
  var navigationScrollStep = null;
  var navigationScrollToken = 0;
  var navigationScrollTimer = null;
  var navigationScrollRestore = false;
  var actionEditorState = { pendingRows: Object.create(null), customOwners: Object.create(null),
    editingOwners: Object.create(null), editingTiming: Object.create(null) };
  var discussionEditorState = { pendingTopics: {}, pendingRecords: {}, collapsedTopics: {} };
  var pendingReviewDecisionLabel = '';
  var undoToastTimer = null;
  var activeFinalEdit = null;
  var previewReturnStep = 4;
  var editVersion = 0;
  var rendering = false;
  var automaticProposalInFlight = false;
  var uploadedDraftId = '';
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
  // this tab.
  function mustKeepTabOpen(kind) {
    var unsaved = ['dirty','waiting','local-only','saving','error'].includes(kind);
    return unsaved || Boolean(pendingGenerationEdits) || hasTransientEditorState();
  }

  function setSaveStatus(message, kind) {
    var element = document.getElementById('saveStatus');
    if (kind === 'local-only' && element.dataset.state === 'error') return;
    // The status stays short. Asking the reviewer to keep the tab open is
    // left to the browser's own leave warning (beforeunload).
    var strip = document.getElementById('saveStrip');
    strip.hidden = !state.draft;
    strip.dataset.state = kind || '';
    element.textContent = message || '';
    element.dataset.state = kind || '';
    updateFinishingBar();
  }

  function formatReviewDecisionLabel(value) {
    var label = String(value || 'Review decision').trim();
    return label ? label.charAt(0).toUpperCase() + label.slice(1) : 'Review decision';
  }

  function updateFinishingBar() {
    if (!state.draft) return;
    var finalReview = state.currentStep === MAX_STEP;
    var finalComplete = finalReview && state.draft.status === 'complete';
    var saveStrip = document.getElementById('saveStrip');
    if (saveStrip) {
      saveStrip.classList.toggle('is-final-review', finalReview);
      saveStrip.hidden = finalComplete && !inDocumentMode();
    }
    document.body.classList.toggle('final-complete', finalComplete);
    // Both controls name the change they act on, so the reviewer can tell what
    // is about to happen before pressing them.
    var undo = document.getElementById('undoLastDecision');
    if (undo) {
      undo.hidden = !state.draft.lastUndo;
      var undoLabel = state.draft.lastUndo ? 'Undo: ' + formatReviewDecisionLabel(state.draft.lastUndo.label) : 'Undo';
      undo.innerHTML = '<span class="wide-label">' + escapeHtml(undoLabel) + '</span><span class="narrow-label">' + (finalReview ? 'Undo' : 'Undo last change') + '</span>';
      undo.setAttribute('aria-label', undoLabel);
      undo.title = state.draft.lastUndo ? undoLabel : '';
    }
    var redo = document.getElementById('redoLastDecision');
    if (redo) {
      redo.hidden = !state.draft.lastRedo;
      var redoLabel = state.draft.lastRedo ? 'Redo: ' + formatReviewDecisionLabel(state.draft.lastRedo.label) : 'Redo';
      redo.innerHTML = '<span class="wide-label">' + escapeHtml(redoLabel) + '</span><span class="narrow-label">Redo last change</span>';
      redo.setAttribute('aria-label', redoLabel);
      redo.title = state.draft.lastRedo ? redoLabel : '';
    }
    var preview = document.getElementById('previewDocument');
    if (preview) {
      preview.hidden = state.currentStep === MAX_STEP;
      var label = state.currentStep === MAX_STEP ? 'Back to editing' : 'Preview draft';
      var wide = preview.querySelector('.wide-label');
      var narrow = preview.querySelector('.narrow-label');
      if (wide) wide.textContent = label;
      if (narrow) narrow.textContent = state.currentStep === MAX_STEP ? 'Back' : 'Preview';
      preview.setAttribute('aria-label', label);
      // The same button previews the document and returns from it, so the icon
      // has to follow the label rather than stay an eye on the way back.
      var previewIcon = preview.querySelector('.ic use');
      if (previewIcon) previewIcon.setAttribute('href', state.currentStep === MAX_STEP ? '#i-arrow-left' : '#i-eye');
    }
    var download = document.getElementById('downloadDraft');
    if (download) download.hidden = state.currentStep === MAX_STEP;
    updateDraftDownloadState();
    // The document has one bar: save state and checks on the left, Preview
    // and Finalise on the right.
    var doc = inDocumentMode();
    var finalised = doc && documentFinalised();
    document.body.classList.toggle('doc-finalised', finalised);
    if (finalised) document.body.classList.add('doc-preview');
    var finalisedNote = document.getElementById('finalisedNote');
    if (finalisedNote) {
      finalisedNote.hidden = !finalised;
      finalisedNote.textContent = finalised ? 'Finalised ' + (formatUkDate(String(state.draft.updatedAt || '').slice(0, 10)) || '') : '';
    }
    ['copyDraftLink', 'reopenMinutes'].forEach(function (id) { var control = document.getElementById(id); if (control) control.hidden = !finalised; });
    var finalisedExport = document.getElementById('finalisedExport');
    var exportMenu = document.querySelector('.export-menu');
    if (finalisedExport && exportMenu) {
      finalisedExport.hidden = !finalised;
      if (finalised && exportMenu.parentElement !== finalisedExport) finalisedExport.appendChild(exportMenu);
      if (!finalised && exportMenu.parentElement === finalisedExport) renderDocumentMode();
    }
    var finalise = document.getElementById('finaliseMinutes');
    if (finalise) finalise.hidden = !documentReady() || finalComplete;
    if (documentReady() && download) download.hidden = true;
    if (documentReady() && !doc && preview) {
      preview.hidden = false;
      preview.querySelector('.wide-label').textContent = 'Preview';
      preview.querySelector('.narrow-label').textContent = 'Preview';
      preview.setAttribute('aria-label', 'Preview');
      preview.querySelector('.ic use').setAttribute('href', '#i-eye');
    }
    if (doc) {
      if (download) download.hidden = true;
      if (undo) undo.hidden = true;
      if (redo) redo.hidden = true;
      if (preview) {
        var previewing = document.body.classList.contains('doc-preview');
        preview.hidden = false;
        var previewLabel = previewing ? 'Back to editing' : 'Preview';
        preview.querySelector('.wide-label').textContent = previewLabel;
        preview.querySelector('.narrow-label').textContent = previewing ? 'Edit' : 'Preview';
        preview.setAttribute('aria-label', previewLabel);
        preview.querySelector('.ic use').setAttribute('href', previewing ? '#i-arrow-left' : '#i-eye');
      }
    }
    if (finalised) {
      if (preview) preview.hidden = true;
      document.getElementById('undoToast').hidden = true;
      var pill = document.getElementById('reviewQueueToggle');
      if (pill) pill.hidden = true;
    }
  }

  function documentFinalised() {
    return Boolean(state.draft && state.draft.status === 'complete');
  }

  function documentReadOnly() {
    return documentFinalised() || document.body.classList.contains('doc-preview');
  }

  function leaveDocumentPreview() {
    if (!state.draft || documentFinalised()) return false;
    if (document.body.classList.contains('doc-preview')) {
      document.body.classList.remove('doc-preview');
      renderFinal(); updateFinishingBar();
    }
    return true;
  }

  function generationStageLabel(stage) {
    var value = String(stage || '').replace(/[_-]+/g, ' ').trim();
    return value ? value.charAt(0).toUpperCase() + value.slice(1) : 'Generation';
  }

  function draftDownloadReadiness() {
    if (!state.draft) return { ready: false, message: 'A draft is needed before it can be downloaded.' };
    var running = state.draft.generation && state.draft.generation.status === 'running'
      ? state.draft.generation.stage : '';
    if (running) {
      return { ready: false, message: 'Download will be available when ' + generationStageLabel(running) + ' finishes generating.' };
    }
    if (state.draft.status === 'complete') return { ready: true, message: '' };
    var include = includedSectionState();
    var required = ['discussion', 'actions'];
    if (include.meetingObjectives || include.executiveSummary) required.push('summary');
    var missing = required.filter(function (stage) { return !stageGeneratedAt(state.draft, stage); });
    if (!missing.length) return { ready: true, message: '' };
    var labels = missing.map(generationStageLabel);
    var list = labels.length === 1 ? labels[0]
      : labels.slice(0, -1).join(', ') + ' and ' + labels[labels.length - 1];
    return { ready: false, message: 'Download will be available after ' + list + ' finish generating.' };
  }

  function updateDraftDownloadState() {
    var button = document.getElementById('downloadDraft');
    if (!button) return;
    var readiness = draftDownloadReadiness();
    button.disabled = !readiness.ready;
    button.title = readiness.message;
    button.setAttribute('aria-label', readiness.ready ? 'Download draft' : 'Preparing draft. ' + readiness.message);
    var wide = button.querySelector('.wide-label');
    var narrow = button.querySelector('.narrow-label');
    if (wide) wide.textContent = readiness.ready ? 'Download draft' : 'Preparing draft';
    if (narrow) narrow.textContent = readiness.ready ? 'Download' : 'Preparing';
    var hint = document.getElementById('downloadDraftHint');
    if (hint) hint.textContent = readiness.message;
  }

  function showUndoToast(label) {
    var toast = document.getElementById('undoToast');
    var message = document.getElementById('undoToastMessage');
    if (!toast || !message) return;
    clearTimeout(undoToastTimer);
    var formatted = formatReviewDecisionLabel(label);
    message.textContent = formatted + (/[.!?]$/.test(formatted) ? ' ' : '. ');
    toast.hidden = false;
    undoToastTimer = window.setTimeout(function () { toast.hidden = true; }, 8000);
  }

  // Every removal says what went, so the toast's Undo is clearly about it.
  function removedLabel(text) {
    var value = String(text || '').replace(/\s+/g, ' ').trim();
    if (value.length > 48) value = value.slice(0, 45).trim() + '…';
    return 'Removed “' + (value || 'empty item') + '”';
  }

  /* Fields the reviewer changed in the document keep a grey bar until the
     minutes are finalised. Kept in this browser only. */
  function editedStoreKey() { return 'mma-edited:' + ((state.draft && state.draft.draftId) || ''); }
  function editedFields() {
    if (!state.draft || state.draft.status === 'complete') return [];
    try { return JSON.parse(window.localStorage.getItem(editedStoreKey()) || '[]'); } catch (error) { return []; }
  }
  function fieldEditKey(kind, id, field) { return kind + '|' + id + '|' + field; }
  function markFieldEdited(kind, id, field) {
    var list = editedFields();
    var key = fieldEditKey(kind, id, field);
    if (list.indexOf(key) >= 0) return;
    list.push(key);
    try { window.localStorage.setItem(editedStoreKey(), JSON.stringify(list.slice(-500))); } catch (error) { /* private mode */ }
  }

  /* ------------------------------------------------------------------ *
   * What counts as one undoable step.
   * A continuous edit to one field is one step. Moving to another field,
   * pausing, or doing something else starts the next one. Autosaves are not
   * boundaries: the group survives them, or a long paragraph would undo a
   * second at a time.
   * ------------------------------------------------------------------ */
  var UNDO_GROUP_MS = 2000;
  var undoGroup = { key: '', at: 0 };

  // One field is one group. A blank identity would merge two different fields
  // into a single step, so anything unidentifiable gets its own group.
  function undoGroupKeyForField(field) {
    if (!field) return '';
    if (field.id) return 'id:' + field.id;
    var data = field.dataset || {};
    var parts = Object.keys(data).sort().map(function (key) { return key + '=' + data[key]; });
    return parts.length ? 'data:' + parts.join('|') : 'tag:' + field.tagName + ':' + Math.random();
  }

  function undoLabelForField(field) {
    if (!field) return 'edit';
    if (field.matches('[data-action]')) return 'edit action';
    if (field.matches('[data-record-field]')) return 'edit discussion item';
    if (field.matches('[data-topic]')) return 'edit topic';
    if (field.matches('[data-objective-index]')) return 'edit objective';
    if (field.id === 'executiveSummary') return 'edit summary';
    if (field.id === 'meetingSteer') return 'edit focus note';
    if (field.matches('[data-timing-kind],[data-timing-date],[data-timing-wording]')) return 'change timing';
    if (field.closest('#detailsEditor')) return 'edit meeting details';
    return 'edit';
  }

  function markUndoStep(label, groupKey) {
    var now = Date.now();
    if (groupKey && undoGroup.key === groupKey && (now - undoGroup.at) < UNDO_GROUP_MS) {
      undoGroup.at = now;
      return;
    }
    undoGroup = { key: groupKey || '', at: now };
    pendingReviewDecisionLabel = formatReviewDecisionLabel(label || 'Change').slice(0, 160);
  }

  // Anything that is not typing closes the current group, so the next
  // keystroke starts a fresh step rather than joining the previous one.
  function endUndoGroup() {
    undoGroup = { key: '', at: 0 };
  }

  function queueReviewDecision(label) {
    endUndoGroup();
    pendingReviewDecisionLabel = formatReviewDecisionLabel(label || 'Review decision').slice(0, 160);
    editVersion += 1;
    setSaveStatus('Saving…', 'saving');
    saveDraftNow().catch(function (error) { setStatus(error.message, true, currentStageName()); });
  }

  function savedStatusText(value) {
    return 'Saved';
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

  function hasTransientDocumentState() {
    return Boolean(activeFinalEdit)
      || Array.from(document.querySelectorAll('#finalDocument [data-owner-new], #finalDocument [data-due-text]')).some(function (input) {
        return input.value !== input.defaultValue;
      });
  }

  function hasTransientEditorState() {
    return hasTransientActionState() || hasTransientDiscussionState() || hasTransientDocumentState();
  }

  // An empty row is a placeholder, not unsaved work: it is worth saying it
  // lives only in this tab, but not in three different sentences.
  var EMPTY_ROW_NOTICE = 'Empty rows stay in this tab until you type into them.';

  function generationSaveText(running) {
    if (pendingGenerationEdits) return 'Waiting to save until generation finishes…';
    if (hasTransientEditorState()) return EMPTY_ROW_NOTICE;
    return 'Everything is saved. You can close the tab' + (running === false ? '.' : ' - generation carries on without it.');
  }

  function setBusy(busy, message, stage) {
    document.body.classList.toggle('busy', busy);
    status.setAttribute('aria-busy', busy ? 'true' : 'false');
    var betaToggle = document.getElementById('betaFlow');
    if (betaToggle) betaToggle.disabled = busy;
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
    if (!element || !element.matches) return '';
    // The reorder handle is a button, but focus has to survive a re-render on it
    // too or the arrow keys only work once.
    if (element.matches('[data-action-grip]')) return '[data-action-grip="' + element.dataset.actionGrip + '"]';
    if (!element.matches('input,textarea,select')) return '';
    if (element.id) return '#' + element.id;
    var parts = Object.keys(element.dataset).map(function (key) {
      var attribute = key.replace(/[A-Z]/g, function (char) { return '-' + char.toLowerCase(); });
      return '[data-' + attribute + '="' + String(element.dataset[key]).replace(/"/g, '\\"') + '"]';
    });
    return parts.length ? element.tagName.toLowerCase() + parts.join('') : '';
  }

  // The reader's place: the focused field, else the first field visible on
  // screen. Kept at the same screen position after a re-render, so a panel
  // appearing or disappearing above it no longer moves what they are reading.
  function captureAnchor() {
    var active = document.activeElement;
    var candidates = controlSelector(active) ? [active] : Array.prototype.filter.call(
      document.querySelectorAll('textarea, input[type="text"], input:not([type])'),
      function (field) { var box = field.getBoundingClientRect(); return box.height > 0 && box.bottom > 0 && box.top < window.innerHeight; });
    var field = candidates[0];
    var selector = controlSelector(field);
    if (!selector) return null;
    var matches;
    try { matches = document.querySelectorAll(selector); } catch (error) { return null; }
    return { selector: selector, index: Array.prototype.indexOf.call(matches, field), top: field.getBoundingClientRect().top };
  }

  function restoreAnchor(anchor) {
    if (!anchor) return;
    var matches;
    try { matches = document.querySelectorAll(anchor.selector); } catch (error) { return; }
    var field = matches[anchor.index >= 0 ? anchor.index : 0];
    if (!field) return;
    var drift = field.getBoundingClientRect().top - anchor.top;
    if (Math.abs(drift) >= 1) window.scrollBy(0, drift);
  }

  function captureFocus() {
    var snapshot = { scrollY: window.pageYOffset, anchor: captureAnchor() };
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
    if (navigationScrollStep === state.currentStep) {
      applyStepNavigationScroll(navigationScrollToken, false);
      return;
    }
    if (typeof snapshot.scrollY === 'number') window.scrollTo(0, snapshot.scrollY);
    restoreAnchor(snapshot.anchor);
    if (!snapshot.selector) return;
    var matches;
    try { matches = document.querySelectorAll(snapshot.selector); } catch (error) { return; }
    var element = matches[snapshot.index >= 0 ? snapshot.index : 0];
    if (!element) return;
    element.focus({ preventScroll: true });
    if (snapshot.start == null) return;
    try { element.setSelectionRange(snapshot.start, snapshot.end); } catch (error) { /* unsupported input type */ }
  }

  function clearStepNavigationScroll() {
    navigationScrollStep = null;
    clearTimeout(navigationScrollTimer);
    navigationScrollTimer = null;
  }

  function applyStepNavigationScroll(token, focusHeading) {
    window.requestAnimationFrame(function () {
      window.requestAnimationFrame(function () {
        if (token !== navigationScrollToken || navigationScrollStep !== state.currentStep) return;
        var screen = document.querySelector('[data-screen="' + state.currentStep + '"]');
        if (!screen) return;
        // Going back (a tab, the step picker or a Back button) returns the
        // reviewer to where they were on that screen. Moving forward, or
        // landing on freshly generated content, opens at the top of the page
        // so the steps and any notices above the screen are in view.
        var remembered = navigationScrollRestore ? stepScrollMemory[state.currentStep] : null;
        window.scrollTo({ top: typeof remembered === 'number' ? remembered : 0, behavior: 'auto' });
        if (!focusHeading) return;
        // Headings are not focusable. Keyboard focus goes to the current
        // step's tab, so it is not lost when the button pressed is hidden.
        // On a phone the tabs are replaced by the step picker.
        var tab = document.querySelector('.step[data-step="' + state.currentStep + '"]');
        if (!tab || !tab.getClientRects().length) tab = document.getElementById('mobileStepSelect');
        if (tab && tab.getClientRects().length) tab.focus({ preventScroll: true });
      });
    });
  }

  function beginStepNavigationScroll(restore) {
    navigationScrollRestore = Boolean(restore);
    navigationScrollToken += 1;
    navigationScrollStep = state.currentStep;
    clearTimeout(navigationScrollTimer);
    applyStepNavigationScroll(navigationScrollToken, true);
    // A step change normally saves within 900 ms. This fallback prevents an
    // active navigation from suppressing scroll restoration indefinitely if
    // no save is needed or the request never starts.
    navigationScrollTimer = window.setTimeout(clearStepNavigationScroll, 5000);
  }

  function settleStepNavigationScroll() {
    if (navigationScrollStep !== state.currentStep) return;
    var token = navigationScrollToken;
    applyStepNavigationScroll(token, false);
    window.requestAnimationFrame(function () {
      window.requestAnimationFrame(function () {
        if (token === navigationScrollToken) clearStepNavigationScroll();
      });
    });
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
        if (remaining <= 0) { setStatus('Continuing now...', false, stage); resolve(); return; }
        setStatus('Microsoft is temporarily busy. Continuing in ' + remaining + ' second' + (remaining === 1 ? '' : 's') + '...', false, stage);
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
    return '<div class="attendee-chip"><input data-attendee-name="' + group + '" value="' + escapeHtml(name || '') + '" aria-label="' + (group === 'internal' ? 'Internal' : 'Client or external') + ' attendee name" placeholder="Enter a name"><button class="secondary attendee-move" data-move-attendee="' + group + '" type="button" aria-label="Move ' + escapeHtml(name || 'attendee') + ' to ' + destination + '"><span class="move-long">Move to ' + destination + '</span><span class="move-short">Move</span></button>' + rowMenu('Options for ' + (name || 'attendee'), '<button class="delete quiet" data-remove-attendee type="button" aria-label="' + escapeHtml(removeLabel) + '">Remove person</button>') + '</div>';
  }

  function renderAttendeeGroup(group, names) {
    document.getElementById(group + 'Attendees').innerHTML = (names || []).map(function (name) { return attendeeChip(name, group); }).join('');
  }

  function setClientAttendeeVisibility(showGroup) {
    var group = document.getElementById('clientAttendeeGroup');
    var firstAdd = document.getElementById('addFirstClientAttendee');
    var labelControl = document.getElementById('clientAttendeeLabelControl');
    if (group) group.hidden = !showGroup;
    if (firstAdd) firstAdd.hidden = showGroup;
    if (labelControl) labelControl.hidden = !showGroup;
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
    return context.map(function (unit, index) {
      var previous = index > 0 ? context[index - 1] : null;
      var speaker = unit.speaker || 'Unknown speaker';
      var previousSpeaker = previous && (previous.speaker || 'Unknown speaker');
      var showSpeaker = !previous || speaker.trim().toLowerCase() !== previousSpeaker.trim().toLowerCase();
      return '<div class="evidence-row' + (unit.cited ? ' cited' : '') + '"><div class="source-meta">'
        + (showSpeaker ? '<span class="source-speaker">' + escapeHtml(speaker) + '</span>' : '')
        + (unit.timestamp ? '<span class="source-time">' + escapeHtml(unit.timestamp) + '</span>' : '')
        + '</div><div>' + escapeHtml(unit.text) + '</div></div>';
    }).join('');
  }

  /* ------------------------------------------------------------------ *
   * Keeping the reviewer's place.
   * Every list is rebuilt with innerHTML on each render, so a panel opened to
   * read a passage closed again on the next autosave. Panels that are worth
   * reopening carry a stable key; the ones that are transient by nature, like
   * the row menus, deliberately do not.
   * ------------------------------------------------------------------ */
  var openDisclosures = Object.create(null);

  function disclosureKey(ids, prefix) {
    return prefix + ':' + (ids || []).join(',');
  }

  function restoreDisclosures(root) {
    (root || document).querySelectorAll('[data-keep-open]').forEach(function (node) {
      if (openDisclosures[node.dataset.keepOpen]) node.open = true;
    });
  }

  document.addEventListener('toggle', function (event) {
    var node = event.target;
    if (!node || !node.dataset || !node.dataset.keepOpen) return;
    if (node.open) openDisclosures[node.dataset.keepOpen] = true;
    else delete openDisclosures[node.dataset.keepOpen];
  }, true);

  function evidenceBlock(ids, ownerKey) {
    var count = (ids || []).length;
    return '<details data-keep-open="' + escapeHtml(disclosureKey(ids, 'evidence:' + (ownerKey || 'shared'))) + '"><summary class="evidence-toggle">View transcript &middot; ' + count + '</summary><div class="evidence-panel">' + evidenceHtml(ids) + '</div></details>';
  }

  function recordNeedsReview(record) {
    var open = new Set(((state.draft && state.draft.reviewFlags) || []).filter(function (flag) {
      return flag.status === 'open';
    }).map(function (flag) { return flag.id; }));
    return (record.reviewFlagIds || []).some(function (id) { return open.has(id); });
  }

  // The transcript used to expand inside this menu and cover the rows below
  // it. The menu now holds a plain item that opens the side drawer instead.
  function transcriptMenuItem(record) {
    var ids = (record && record.evidenceIds) || [];
    var count = ids.length;
    if (!count) return '<button class="secondary quiet" type="button" disabled>No transcript linked</button>';
    var label = (recordNeedsReview(record) ? 'Check transcript' : 'View transcript') + ' (' + count + (count === 1 ? ' line)' : ' lines)');
    return '<button class="secondary quiet" data-view-transcript="' + escapeHtml(ids.join(',')) + '" data-transcript-pin="' + escapeHtml(record.text || record.action || '') + '" type="button">' + label + '</button>';
  }

  // A row's "…" menu: removal is always its last, red item.
  function rowMenu(label, items) {
    return '<details class="record-menu row-menu" data-menu><summary class="secondary quiet" aria-label="' + escapeHtml(label) + '" title="' + escapeHtml(label) + '">•••</summary><div class="record-menu-popover" data-menu-popover>' + items + '</div></details>';
  }

  function recordMenu(record, actions) {
    return '<details class="record-menu" data-menu><summary class="secondary quiet" aria-label="Item options" title="Item options">•••</summary><div class="record-menu-popover" data-menu-popover>' + transcriptMenuItem(record) + actions + '</div></details>';
  }

  /* ------------------------------------------------------------------ *
   * Menus.
   * Every row and topic menu is a <details>. Only one may be open at a
   * time; Esc, a click elsewhere and scrolling the page all close it.
   * ------------------------------------------------------------------ */
  var MENU_SELECTOR = 'details[data-menu]';

  function openMenus() { return Array.prototype.slice.call(document.querySelectorAll(MENU_SELECTOR + '[open]')); }

  function closeMenus(except, options) {
    var closed = false;
    openMenus().forEach(function (menu) {
      if (menu === except) return;
      menu.open = false;
      closed = true;
      // A document picker that is closed stays closed when the table re-renders.
      if (menu.dataset && menu.dataset.picker && menu.dataset.picker === docPickerOpen) docPickerOpen = '';
      if (options && options.focus) {
        var summary = menu.querySelector('summary');
        if (summary) summary.focus({ preventScroll: true });
      }
    });
    return closed;
  }

  // A menu near the bottom of the window opens upwards, so its last item is
  // never hidden behind the sticky save bar or the window edge.
  function placeMenu(menu) {
    var popover = menu.querySelector('[data-menu-popover]');
    if (!popover) return;
    menu.classList.remove('opens-up');
    popover.style.left = '';
    popover.style.right = '';
    var rect = popover.getBoundingClientRect();
    var shift = Math.max(8 - rect.left, Math.min(0, document.documentElement.clientWidth - 8 - rect.right));
    if (shift) {
      popover.style.left = (popover.offsetLeft + shift) + 'px';
      popover.style.right = 'auto';
    }
    var bar = document.getElementById('saveStrip');
    var floor = window.innerHeight - (bar && !bar.hidden ? bar.getBoundingClientRect().height + 12 : 8);
    rect = popover.getBoundingClientRect();
    var roomAbove = menu.getBoundingClientRect().top;
    if (rect.bottom > floor && roomAbove > rect.height + 8) menu.classList.add('opens-up');
  }

  document.addEventListener('toggle', function (event) {
    var menu = event.target;
    if (!menu || !menu.matches || !menu.matches(MENU_SELECTOR) || !menu.open) return;
    closeMenus(menu);
    placeMenu(menu);
  }, true);

  document.addEventListener('pointerdown', function (event) {
    var inside = event.target.closest && event.target.closest(MENU_SELECTOR);
    closeMenus(inside || null);
  }, true);

  document.addEventListener('focusin', function (event) {
    var inside = event.target.closest && event.target.closest(MENU_SELECTOR);
    if (!inside) closeMenus(null);
  });

  // Scrolling the page by wheel or touch closes a menu. Scrolls the browser
  // makes itself, to bring a focused menu item into view, do not.
  function closeMenusOnUserScroll(event) {
    var inside = event.target.closest && event.target.closest(MENU_SELECTOR);
    if (!inside) closeMenus(null);
  }
  window.addEventListener('wheel', closeMenusOnUserScroll, { passive: true });
  window.addEventListener('touchmove', closeMenusOnUserScroll, { passive: true });

  /* ------------------------------------------------------------------ *
   * Side drawer.
   * A panel over the right edge for transcript passages. It never moves the
   * document underneath it, and Esc closes it.
   * ------------------------------------------------------------------ */
  var drawerTrigger = null;

  function openDrawer(options) {
    var drawer = document.getElementById('sideDrawer');
    if (!drawer) return;
    drawerTrigger = options.trigger || document.activeElement;
    document.getElementById('sideDrawerTitle').textContent = options.title || '';
    var pinned = document.getElementById('sideDrawerPinned');
    pinned.hidden = !options.pinned;
    pinned.textContent = options.pinned || '';
    document.getElementById('sideDrawerBody').innerHTML = options.html || '';
    drawer.hidden = false;
    document.body.classList.add('has-side-drawer');
    document.getElementById('sideDrawerClose').focus({ preventScroll: true });
  }

  function closeDrawer() {
    var drawer = document.getElementById('sideDrawer');
    if (!drawer || drawer.hidden) return false;
    drawer.hidden = true;
    document.body.classList.remove('has-side-drawer');
    restoreFlagList();
    var trigger = drawerTrigger;
    drawerTrigger = null;
    // The menu that opened the drawer has closed, so focus goes back to the
    // menu's own button rather than an item that is no longer visible.
    var menu = trigger && trigger.closest && trigger.closest(MENU_SELECTOR);
    var target = menu ? menu.querySelector('summary') : trigger;
    if (target && document.contains(target)) target.focus({ preventScroll: true });
    return true;
  }

  document.addEventListener('click', function (event) {
    var button = event.target.closest && event.target.closest('[data-view-transcript]');
    if (button) {
      var ids = button.dataset.viewTranscript.split(',').filter(Boolean);
      closeMenus(null);
      openDrawer({
        title: 'Transcript (' + ids.length + (ids.length === 1 ? ' line)' : ' lines)'),
        pinned: button.dataset.transcriptPin || '',
        html: evidenceHtml(ids),
        trigger: button
      });
      return;
    }
    if (event.target.closest && event.target.closest('#sideDrawerClose')) closeDrawer();
  });

  // Esc closes the innermost thing first: an open menu, then the drawer.
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    if (closeMenus(null, { focus: true }) || (!activeFinalEdit && closeDrawer())) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);

  function autoGrow(root) {
    (root || document).querySelectorAll('textarea').forEach(function (area) {
      // Hidden editors have no measurable content height. Their next render
      // or step activation will size them at their actual visible width.
      if (!area.getClientRects().length) return;
      area.style.height = 'auto';
      var compact = area.matches('[data-record-field],[data-action],[data-objective-index],[data-topic]');
      var box = getComputedStyle(area);
      var number = function (value) { return parseFloat(value) || 0; };
      // scrollHeight includes padding but excludes borders; CSS height means
      // the border box here, or the content box for an explicitly styled editor.
      var adjustment = box.boxSizing === 'border-box'
        ? number(box.borderTopWidth) + number(box.borderBottomWidth)
        : -number(box.paddingTop) - number(box.paddingBottom);
      area.style.height = Math.max(Math.ceil(area.scrollHeight + adjustment), compact ? 36 : 52) + 'px';
    });
  }

  var autoGrowFrame = null;
  function scheduleAutoGrow() {
    if (autoGrowFrame !== null) return;
    autoGrowFrame = window.requestAnimationFrame(function () {
      autoGrowFrame = null;
      autoGrow();
    });
  }
  window.addEventListener('resize', scheduleAutoGrow);
  if (document.fonts) {
    document.fonts.ready.then(scheduleAutoGrow, scheduleAutoGrow);
    document.fonts.addEventListener('loadingdone', scheduleAutoGrow);
  }

  function actionTranscriptId(action, index) {
    return actionDomId(action, index, 'action-transcript');
  }

  // Where the reviewer was on each screen. Stepping out to the preview and
  // back used to land them at the top of a list they were halfway down.
  var stepScrollMemory = Object.create(null);

  function showStep(index, options) {
    var leavingStep = state.currentStep;
    state.currentStep = Math.max(0, Math.min(MAX_STEP, Number(index) || 0));
    if (inDocumentMode()) state.currentStep = MAX_STEP;
    else if (state.currentStep !== MAX_STEP || !documentReady()) structureStep = state.currentStep;
    // The upload confirmation belongs to the moment after upload; moving on
    // to another screen is the reviewer saying they have read it.
    if (state.currentStep !== 0) hideUploadConfirmation();
    if (leavingStep !== state.currentStep) stepScrollMemory[leavingStep] = window.scrollY;
    // A draft saved on the retired Focus step has nowhere to land; send it on
    // to Discussion rather than showing an empty screen.
    if (state.currentStep === 1) state.currentStep = 2;
    // The review queue is shared by every workflow screen. Close it when the
    // reviewer moves on so the next screen starts clean.
    if (leavingStep !== state.currentStep) {
      var reviewPanel = document.getElementById('reviewFlags');
      if (reviewPanel) reviewPanel.open = false;
    }
    if (completedGenerationNotice && STAGE_STEP[completedGenerationNotice.stage] === state.currentStep) {
      completedGenerationNotice = null;
    }
    var stepChanged = Boolean(state.draft)
      && Number(state.draft.selectedStep == null ? state.draft.currentStep : state.draft.selectedStep) !== state.currentStep;
    document.querySelectorAll('[data-screen]').forEach(function (screen) { screen.classList.toggle('active', Number(screen.dataset.screen) === state.currentStep); });
    document.querySelectorAll('[data-step]').forEach(function (button) {
      var step = Number(button.dataset.step);
      var furthestStep = furthestUnlockedStep();
      var unlocked = step <= furthestStep;
      button.disabled = !unlocked;
      button.classList.toggle('active', step === state.currentStep);
      button.classList.toggle('complete', step < state.currentStep);
    });
    var mobileStep = document.getElementById('mobileStepSelect');
    if (mobileStep) {
      var furthestStep = furthestUnlockedStep();
      mobileStep.value = String(state.currentStep);
      Array.from(mobileStep.options).forEach(function (option) {
        option.disabled = Number(option.value) > furthestStep;
      });
      // Five visible steps: index 1 is retired, so the label counts screens the
      // reviewer can actually reach rather than raw indices.
      var visibleStep = state.currentStep === 0 ? 1 : state.currentStep;
      document.getElementById('mobileStepCount').textContent = 'Step ' + visibleStep + ' of ' + MAX_STEP;
    }
    if (state.draft) {
      state.draft.currentStep = Math.max(Number(state.draft.currentStep || 0), state.currentStep);
      state.draft.selectedStep = state.currentStep;
    }
    autoGrow();
    var statusStage = status.dataset.stage;
    if (stepChanged && !statusStage) setStatus('');
    status.hidden = !status.textContent || Boolean(statusStage && STAGE_STEP[statusStage] !== state.currentStep);
    // Deliberate navigation is useful to remember, but it is not user work and
    // must not produce a warning that implies generation needs this tab. Save
    // the position after the generation write if the tab is still open.
    // Moving between screens is not an edit, so it never starts a save. The
    // selected screen is sent with the next content save; an edit still
    // waiting for its pause in typing is sent now, so leaving cannot lose it.
    if (!rendering && stepChanged && savePending && !draftWritesInFlight && !generationRunning()) saveDraftNow();
    // The screen is remembered in this browser, so reopening the draft comes
    // back to it without a save.
    if (!rendering && stepChanged && state.draft && !inDocumentMode()) rememberStep(state.draft.draftId, state.currentStep);

    // Deliberate navigation goes to the beginning of the newly opened section.
    // Autosave normally preserves the reader's position, but while this move is
    // settling it must not restore the position from the previous section.
    if (options && options.scroll) beginStepNavigationScroll(options.restore);
    renderGenerationProgress();
    updateFinishingBar();
    if (leavingStep !== state.currentStep) updateReviewQueueSummary();
    if (options && options.scroll) {
      maybeOpenPreparedDiscussion();
      maybeOpenPreparedSummary();
    }
  }

  // The stored meeting type stays 'Webinar rehearsal' (it selects the meeting
  // profile); people see a label that fits online, in-person and hybrid
  // rehearsals alike, and the stored value is written back on save.
  var MEETING_TYPE_LABELS = {'webinar rehearsal':'Presentation rehearsal'};
  var MEETING_TYPE_VALUES = {'presentation rehearsal':'Webinar rehearsal'};
  function meetingTypeLabel(value) { var key=String(value||'').trim().toLowerCase(); return MEETING_TYPE_LABELS[key] || value || ''; }
  function meetingTypeValue(label) { var key=String(label||'').trim().toLowerCase(); return MEETING_TYPE_VALUES[key] || String(label||'').trim(); }
  function setMeetingTypeField(value) {
    var element = document.getElementById('meetingType');
    if (!element || element === document.activeElement) return;
    var label = meetingTypeLabel(value || '');
    if (label && !Array.from(element.options).some(function (option) { return option.value === label; })) {
      // Preserve older or model-generated meeting types without turning the
      // control back into free text.
      element.add(new Option(label, label));
    }
    element.value = label;
  }
  function setFieldValue(id, value) {
    var element = document.getElementById(id);
    if (!element || element === document.activeElement) return;
    if (element.value !== value) element.value = value;
  }

  // Measured on real meetings: Discussion about a minute, Actions 15–45 s when
  // nothing could be prepared ahead, the summary a few seconds.
  var TYPICAL_SECONDS = { discussion: 120, actions: 60, summary: 30 };
  function typicalDurationText(stage, elapsed) {
    var typical = TYPICAL_SECONDS[stage] || 90;
    if (elapsed > typical * 2) return 'taking longer than usual, still working';
    return stage === 'discussion' ? 'usually 1–2 minutes' : stage === 'actions' ? 'usually under a minute' : 'usually a few seconds';
  }

  function generationRunning(stage) {
    var generation = state.draft && state.draft.generation;
    return Boolean(generation && ['queued', 'running', 'retrying'].includes(generation.status)
      && (!stage || generation.stage === stage));
  }

  function generationPhaseStatus(generation, phase) {
    if (isParallelDraft() && phase.key === 'parallel') return 'active';
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
    if (isParallelDraft()) return [{key:'parallel',label:'Preparing summary, discussion and actions together'}];
    if (generation.stage === 'actions') return [
      {key:'primary',label:'Find possible actions'},
      {key:'recovery',label:'Checking for missing details'},
      {key:'referee',label:'Verify against transcript'},
      {key:'final',label:'Finish the draft'}
    ];
    if (generation.stage === 'discussion') return [
      {key:'primary',label:'Find meeting content'},
      {key:'recovery',label:'Checking for missing details'},
      {key:'referee',label:'Verify against transcript'},
      {key:'final',label:'Finish the draft'}
    ];
    return [];
  }

  function friendlyGenerationMessage(message, stage) {
    var value = String(message || '');
    if (/missed|recover/i.test(value)) return stage === 'actions'
      ? 'Reviewing the transcript for additional actions…'
      : 'Reviewing the transcript for additional meeting content…';
    if (/evidence|referee|ground/i.test(value)) return 'Checking the draft against the transcript…';
    return value || 'Preparing independent quality checks…';
  }

  function renderGenerationProgress() {
    // The progress panel sits above the content; keep the reader's place when it
    // appears, changes size or goes away.
    var anchor = captureAnchor();
    renderGenerationProgressPanel();
    restoreAnchor(anchor);
  }

  function renderGenerationProgressPanel() {
    var panel = document.getElementById('generationProgress');
    if (!panel) return;
    // Only a live run gets the progress panel. A failed or interrupted run
    // stays on the draft so its error can be shown, but it must not hide the
    // step's buttons or read as still working.
    var generation = generationRunning() ? state.draft.generation : null;
    var notice = completedGenerationNotice;
    panel.hidden = !generation && !notice;
    document.body.classList.toggle('generation-active', Boolean(generation));
    document.querySelectorAll('[data-step]').forEach(function (button) {
      var step = Number(button.dataset.step);
      button.classList.toggle('generating', Boolean(generation && STAGE_STEP[generation.stage] === step));
      button.classList.toggle('ready', Boolean(notice && STAGE_STEP[notice.stage] === step));
    });
    if (panel.hidden) return;
    var stage = generation ? generation.stage : notice.stage;
    var preview = generation && Array.isArray(generation.previewActions) ? generation.previewActions : [];
    document.getElementById('generationProgressTitle').textContent = generation
      ? (isParallelDraft() ? 'Preparing meeting minutes' : stage === 'actions' ? 'Preparing actions' : stage === 'discussion' ? 'Preparing discussion' : 'Preparing summary…')
      : (stage === 'actions' ? 'Actions are ready' : 'Generation complete');
    document.getElementById('generationProgressMessage').textContent = generation
      ? stage === 'summary' ? '' : friendlyGenerationMessage(generation.message, stage)
      : (notice.message || 'The completed draft is ready to review.');
    if (generation && STAGE_STEP[stage] === state.currentStep) status.hidden = true;
    var started = generation && new Date(generation.startedAt).getTime();
    var elapsed = started && !Number.isNaN(started) ? Math.max(0, Math.floor((Date.now() - started) / 1000)) : 0;
    document.getElementById('generationElapsed').textContent = generation
      ? 'Elapsed ' + Math.floor(elapsed / 60) + ':' + String(elapsed % 60).padStart(2, '0') + (isParallelDraft() ? '' : ' · ' + typicalDurationText(stage, elapsed))
      : 'Complete';
    document.getElementById('generationPhases').innerHTML = generationPhases(generation || {stage:stage}).map(function (phase) {
      var phaseState = generation ? generationPhaseStatus(generation, phase) : 'done';
      return '<li class="generation-phase ' + phaseState + '">' + escapeHtml(phase.label) + '</li>';
    }).join('');
    var previewNote = document.getElementById('generationPreviewNote');
    previewNote.hidden = !generation || !preview.length;
    previewNote.textContent = preview.length
      ? preview.length + ' early possible action' + (preview.length === 1 ? '' : 's') + ' ready to look over while final checks continue. This temporary preview will be replaced automatically.'
      : '';
    var view = document.getElementById('viewGeneratedStage');
    view.hidden = stage !== 'actions' || state.currentStep === STAGE_STEP.actions || (!preview.length && !notice);
    view.textContent = generation ? 'View working preview' : 'View actions';
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

  /* ------------------------------------------------------------------ *
   * Outdated sections.
   * A section whose inputs changed since it was generated says so under its
   * own heading, with a link to regenerate it. The reviewer can dismiss the
   * link; the dismissal is kept per draft in this browser.
   * ------------------------------------------------------------------ */
  var STALE_LINK_TEXT = {
    actions: { lead: 'Discussion changed', link: 'regenerate actions?' },
    summary: { lead: 'Minutes changed', link: 'regenerate the summary?' },
    discussion: { lead: 'Details changed', link: 'regenerate the discussion?' }
  };

  function staleDismissKey() { return 'mma-stale-dismissed:' + ((state.draft && state.draft.draftId) || ''); }

  function staleDismissed() {
    try { return JSON.parse(window.localStorage.getItem(staleDismissKey()) || '{}') || {}; } catch (error) { return {}; }
  }

  function setStaleDismissed(stage, dismissed) {
    var value = staleDismissed();
    if (dismissed) value[stage] = true; else delete value[stage];
    try { window.localStorage.setItem(staleDismissKey(), JSON.stringify(value)); } catch (error) { /* private mode */ }
  }

  function visibleStaleStages() {
    if (!state.draft) return [];
    var stale = state.draft.staleStages || [];
    var dismissed = staleDismissed();
    // Once a stage is up to date again, forget its dismissal so the next
    // change is announced.
    Object.keys(dismissed).forEach(function (stage) { if (stale.indexOf(stage) === -1) setStaleDismissed(stage, false); });
    return stale.filter(function (stage) { return STALE_LINK_TEXT[stage] && !dismissed[stage]; });
  }

  function staleLinkHtml(stage) {
    if (visibleStaleStages().indexOf(stage) === -1) return '';
    var text = STALE_LINK_TEXT[stage];
    return '<p class="section-stale" data-stale-link="' + stage + '"><span class="stale-dot" aria-hidden="true"></span><span>' + escapeHtml(text.lead) + ' — <button type="button" class="link-button" data-update-stale-stage="' + stage + '">' + escapeHtml(text.link) + '</button></span>'
      + '<button type="button" class="stale-dismiss" data-dismiss-stale="' + stage + '" aria-label="Dismiss" title="Dismiss">&times;</button></p>';
  }

  function renderStaleNotice() {
    var notice = document.getElementById('staleNotice');
    if (!notice || !state.draft) return;
    var stale = state.draft.staleStages || [];
    // The old page-wide banner is retired; each affected section says so instead.
    notice.hidden = true;
    document.querySelectorAll('[data-stale-slot]').forEach(function (slot) {
      slot.innerHTML = staleLinkHtml(slot.dataset.staleSlot);
    });
    var stages = document.getElementById('staleStages');
    if (stages) stages.textContent = stale.join(' and ');
    var actions = document.getElementById('staleStageActions');
    if (!actions) return;
    var labels = { discussion:'Discussion', actions:'Actions', summary:'Summary' };
    actions.innerHTML = stale.map(function (stage) {
      return '<button type="button" class="secondary compact" data-update-stale-stage="' + escapeHtml(stage) + '">Update ' + escapeHtml(labels[stage] || stage) + '</button>';
    }).join('');
  }

  function markDownstreamStale() {
    if (!state.draft || isParallelDraft()) return;
    var stale = new Set(state.draft.staleStages || []);
    if ((state.draft.actions || []).length) stale.add('actions');
    if (state.draft.executiveSummary) stale.add('summary');
    if (generationRunning('actions')) actionsInvalidatedDuringGeneration = true;
    if (!stale.size) return;
    state.draft.staleStages = Array.from(stale);
    renderStaleNotice();
  }

  function speculationFor(stage) {
    var speculation = state.draft && state.draft.speculation;
    return speculation && speculation.stage === stage ? speculation : null;
  }

  var SPECULATION_NOTICE_TEXT = {
    discussion: {
      preparing: 'Preparing the Discussion in the background while you check the details…',
      ready: ''
    },
    actions: {
      preparing: 'Preparing Actions in the background while you review Discussion…',
      ready: ''
    },
    summary: {
      preparing: 'Preparing the Summary in the background while you review Actions…',
      ready: ''
    }
  };

  var RUNNING_NOTICE_TEXT = {
    discussion: 'The Discussion is being prepared.',
    actions: 'Actions are being prepared. You can keep editing the Discussion.',
    summary: 'The summary is being prepared.'
  };

  function renderSpeculationNotice(element, stage, info) {
    if (!element) return;
    // A notice that is showing when its run starts keeps its place and says
    // the run is under way. Hiding it moved everything above it when the
    // reader was scrolled to the bottom, so the next click missed.
    if (generationRunning(stage)) {
      if (!element.hidden) element.textContent = RUNNING_NOTICE_TEXT[stage] || element.textContent;
      return;
    }
    var noticeText = info ? SPECULATION_NOTICE_TEXT[stage][info.status === 'ready' ? 'ready' : 'preparing'] : '';
    // A stage with nothing useful to announce hides its box rather than
    // showing an empty one.
    element.hidden = !noticeText;
    if (element.hidden) return;
    element.textContent = noticeText;
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
    updateStageAdvanceLabels();
  }

  function backgroundWorkPreparing() {
    if (!state.draft) return false;
    var speculation = state.draft.speculation;
    var prewarm = state.draft.actionsPrewarm;
    return Boolean((speculation && speculation.status === 'preparing') || (prewarm && prewarm.status === 'preparing'));
  }

  function stagePreparingInBackground(stage) {
    if (!state.draft) return false;
    var info = speculationFor(stage) || (stage === 'actions' ? state.draft.actionsPrewarm : null);
    return Boolean(info && info.status === 'preparing');
  }

  // A stage reports ready a moment before it is written into the draft, so
  // stopping the poll the instant it turns ready would miss that write and
  // leave this tab a revision behind. Keep polling for a short while after -
  // bounded, because a superseded result never lands at all.
  var backgroundSettlePolls = 0;
  var BACKGROUND_SETTLE_POLLS = 10;

  function pollActionPrewarm(immediate) {
    clearTimeout(prewarmTimer);
    if (document.hidden) return;
    if (!state.draft || generationRunning()) return;
    if (backgroundWorkPreparing()) backgroundSettlePolls = BACKGROUND_SETTLE_POLLS;
    else if (backgroundSettlePolls > 0) backgroundSettlePolls -= 1;
    else return;
    prewarmTimer = window.setTimeout(async function () {
      if (!state.draft || generationRunning()) return;
      try {
        var payload = await jsonRequest(draftUrl('/generation'));
        state.draft.actionsPrewarm = payload.actionsPrewarm || null;
        state.draft.speculation = payload.speculation || null;
        // Background work that has already been written into the draft: show it
        // now rather than leaving the screen empty until the reviewer arrives,
        // and keep this tab's revision level with the server's.
        var backgroundStages = editorsSettled() ? backgroundStagesToAdopt(payload.draft) : null;
        if (backgroundStages) {
          backgroundSettlePolls = 0;
          adoptBackgroundStages(payload.draft, backgroundStages);
          renderAll();
        } else renderActionsPrewarm();
        maybeOpenPreparedDiscussion();
        maybeOpenPreparedSummary();
        pollActionPrewarm();
      } catch (error) {
        prewarmTimer = window.setTimeout(pollActionPrewarm, 5000);
      }
    }, immediate ? 0 : GENERATION_POLL_MS);
  }

  // Reaching an empty Summary screen is itself the request to prepare the
  // summary. Speculation can make that faster, but generation must not depend
  // on a private speculative result existing: disabled, failed or expired
  // speculation previously left the screen blank until a manual click.
  function maybeOpenPreparedSummary() {
    if (!state.draft || state.currentStep !== STAGE_STEP.summary || rendering) return;
    var draftId = String(state.draft.draftId || '');
    if (generationRunning() || autoSummaryStartedForDraft === draftId) return;
    if (String(state.draft.executiveSummary || '').trim() || (isParallelDraft() && stageGeneratedAt(state.draft, 'summary'))) return;
    autoSummaryStartedForDraft = draftId;
    startBackgroundStage('summary');
  }
  var autoSummaryStartedForDraft = '';

  // Discussion is prepared while the reviewer checks Focus. Adopt that work
  // as soon as it is ready (or wait on the existing preparation) so a finished
  // private result cannot remain invisible until the user retries manually.
  function maybeOpenPreparedDiscussion() {
    if (!state.draft || state.currentStep !== STAGE_STEP.focus || rendering) return;
    if (generationRunning() || autoDiscussionStarted) return;
    if ((state.draft.discussion || []).length) return;
    if (!speculationFor('discussion')) return;
    autoDiscussionStarted = true;
    startBackgroundStage('discussion');
  }
  var autoDiscussionStarted = false;

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

  function includedSectionState() {
    var raw = (state.draft && state.draft.includeSections) || {};
    return { meetingObjectives: raw.meetingObjectives !== false, executiveSummary: raw.executiveSummary !== false, topicHeadings: raw.topicHeadings !== false };
  }

  function renderIncludedSections() {
    var include = includedSectionState();
    var objectives = document.getElementById('includeObjectives');
    var summary = document.getElementById('includeSummary');
    if (objectives) objectives.checked = include.meetingObjectives;
    if (summary) summary.checked = include.executiveSummary;
    // An excluded section leaves the Summary screen entirely, rather than
    // sitting there empty and looking like generation failed.
    document.querySelectorAll('[data-section]').forEach(function (node) {
      node.hidden = include[node.dataset.section] === false;
    });
    var empty = document.getElementById('summaryAllExcluded');
    if (empty) empty.hidden = include.meetingObjectives || include.executiveSummary;
  }

  function renderSummary() {
    renderIncludedSections();
    var draft = state.draft || {};
    var summaryRunning = generationRunning('summary');
    var summaryHasContent = Boolean(String(draft.executiveSummary || '').trim()
      || (draft.meetingObjectives || []).some(function (item) { return String(typeof item === 'string' ? item : item && item.text || '').trim(); }));
    var fields = document.getElementById('summaryFields');
    if (fields) fields.hidden = summaryRunning && !summaryHasContent;
    var summary = document.getElementById('executiveSummary');
    if (summary && summary !== document.activeElement) {
      var value = draft.executiveSummary || '';
      if (summary.value !== value) summary.value = value;
    }
    var objectives = draft.meetingObjectives || [];
    document.getElementById('objectivesList').innerHTML = objectives.map(function (item, index) {
      var objectiveText = typeof item === 'string' ? item : item.text;
      return '<div class="record-row"><textarea data-objective-index="' + index + '" rows="1" aria-label="Objective ' + (index + 1) + '">' + escapeHtml(objectiveText) + '</textarea><div class="record-tools">' + rowMenu('Objective ' + (index + 1) + ' options', '<button class="delete quiet" data-remove-objective="' + index + '" type="button" aria-label="Remove objective ' + (index + 1) + '">Remove objective</button>') + '</div></div>';
    }).join('') || '<p class="muted record-empty">None yet. Generate them, or add one by hand.</p>';
    var generate = document.getElementById('generateSummary');
    generate.hidden = summaryRunning;
    generate.textContent = (draft.executiveSummary || objectives.length) ? 'Regenerate summary' : 'Create summary';
    autoGrow(document.getElementById('summaryFields'));
  }

  function renderBetaFlow() {
    var control = document.getElementById('betaFlowControl');
    var toggle = document.getElementById('betaFlow');
    if (!control || !toggle) return;
    control.hidden = !betaFlowAllowed || Boolean(state.draft);
    toggle.checked = betaFlowEnabled;
    document.getElementById('betaFlowStatus').textContent = betaFlowEnabled
      ? 'On — uses the new streamlined flow for your next upload.'
      : 'Off — uses the existing flow for your next upload.';
  }

  function rememberProjectBetaChoice() {
    if (!betaFlowAllowed || !betaFlowUserId
      || !/^[1-9]\d*$/.test(new URLSearchParams(window.location.search).get('projectId') || '')) return;
    try { sessionStorage.setItem('trinzo.projectMinutesBeta.' + betaFlowUserId, betaFlowEnabled ? 'parallel' : 'original'); }
    catch (_error) { /* The explicit URL choice still works without browser storage. */ }
  }

  async function initialiseBetaFlow() {
    try {
      var auth = await jsonRequest('/api/auth/me');
      betaFlowAllowed = auth.user?.role === 'admin';
      betaFlowUserId = String(auth.user?.userId || auth.user?.id || '');
      betaFlowEnabled = betaFlowAllowed && new URLSearchParams(window.location.search).get('engine') === 'parallel';
      rememberProjectBetaChoice();
    } catch (error) {
      betaFlowAllowed = false;
      betaFlowEnabled = false;
    }
    renderBetaFlow();
    renderPageHeading();
  }

  var betaToggle = document.getElementById('betaFlow');
  if (betaToggle) betaToggle.addEventListener('change', function () {
    if (!betaFlowAllowed || state.draft) return;
    betaFlowEnabled = betaToggle.checked;
    var url = new URL(window.location.href);
    if (betaFlowEnabled) url.searchParams.set('engine', 'parallel');
    else url.searchParams.delete('engine');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
    rememberProjectBetaChoice();
    renderBetaFlow();
    renderPageHeading();
  });

  /* ------------------------------------------------------------------ *
   * Document mode.
   * Once a transcript has been processed, the page is one document with
   * click-to-edit text. The step screens stay available behind the
   * "Edit structure" toggle, which is remembered per draft in this browser
   * and never saved to the draft.
   * ------------------------------------------------------------------ */
  var structureStep = 2;

  function documentReady() {
    var draft = state.draft;
    return Boolean(draft && (documentFinalised() || (stageGeneratedAt(draft, 'discussion') && stageGeneratedAt(draft, 'actions'))));
  }

  function editStructureKey() { return 'mma-edit-structure:' + ((state.draft && state.draft.draftId) || ''); }

  function editStructureOn() {
    if (!state.draft || documentFinalised()) return false;
    var stored = null;
    try { stored = window.localStorage.getItem(editStructureKey()); } catch (error) { stored = null; }
    if (stored === '1') return true;
    if (stored === '0') return false;
    // With nothing to read in a section, start where it can be built.
    return !(state.draft.discussion || []).length || !(state.draft.actions || []).length;
  }

  function inDocumentMode() { return documentReady() && !editStructureOn(); }

  function renderDocumentMode() {
    var ready = documentReady();
    var doc = ready && !editStructureOn();
    document.body.classList.toggle('doc-ready', ready);
    document.body.classList.toggle('doc-mode', doc);
    if (!doc) document.body.classList.remove('doc-preview');
    var toggle = document.getElementById('editStructureToggle');
    if (toggle) {
      toggle.setAttribute('aria-pressed', String(ready && !doc));
      toggle.hidden = documentFinalised();
      toggle.disabled = documentFinalised();
    }
    var structureItem = document.querySelector('[data-doc-edit-structure]');
    if (structureItem) structureItem.hidden = !ready || !doc || documentFinalised();
    var meta = document.getElementById('documentMeta');
    if (meta) meta.innerHTML = ready ? documentMetaHtml(doc && !documentReadOnly()) : '';
    // Download lives in Preview while the page is one document; the step
    // screens keep their own Export menu on Review.
    var exportLabel = document.getElementById('exportMenuLabel');
    if (exportLabel) exportLabel.textContent = doc ? 'Download' : 'Export';
    var exportMenu = document.querySelector('.export-menu');
    var home = doc ? document.getElementById('previewExport') : document.querySelector('.final-actions .spacer');
    if (exportMenu && home) {
      if (doc && exportMenu.parentElement !== home) home.appendChild(exportMenu);
      if (!doc && exportMenu.previousElementSibling !== home) home.insertAdjacentElement('afterend', exportMenu);
    }
  }

  /* ------------------------------------------------------------------ *
   * Checks: one counter, one drawer.
   * ------------------------------------------------------------------ */
  function openCheckItems() {
    var draft = state.draft || {};
    var details = draft.details || {};
    var items = { flagged: [], owner: [], due: [], details: [], total: 0 };
    (draft.reviewFlags || []).forEach(function (flag) {
      if (flag.status === 'open' && !proposalChangeForFlag(flag)) items.flagged.push(flag);
    });
    (draft.actions || []).forEach(function (action) {
      if (!(action.owners || []).length) items.owner.push(action);
      if (dueState(action.timing).mode === 'none') items.due.push(action);
    });
    if (!String(details.meetingTitle || '').trim()) items.details.push({ field:'meetingTitle', label:'Meeting title' });
    if (!String(details.meetingDate || '').trim()) items.details.push({ field:'meetingDate', label:'Meeting date' });
    if (!(details.internalAttendees || []).concat(details.clientAttendees || []).filter(function (name) { return String(name || '').trim(); }).length) {
      items.details.push({ field:'attendees', label:'At least one attendee' });
    }
    items.total = items.flagged.length + items.owner.length + items.due.length + items.details.length;
    return items;
  }

  function plural(count, one, many) { return count + ' ' + (count === 1 ? one : many); }

  function checksSummaryText(items) {
    return [items.flagged.length ? plural(items.flagged.length, 'model check', 'model checks') : '',
      items.owner.length ? plural(items.owner.length, 'missing owner', 'missing owners') : '',
      items.due.length ? plural(items.due.length, 'missing date', 'missing dates') : '',
      items.details.length ? plural(items.details.length, 'missing detail', 'missing details') : ''].filter(Boolean).join(', ');
  }

  var checksDrawerMode = '';
  function checksDrawerOpen() {
    var drawer = document.getElementById('sideDrawer');
    return Boolean(checksDrawerMode && drawer && !drawer.hidden);
  }

  function checksExtraHtml(items) {
    var group = function (title, rows) {
      return rows.length ? '<section class="checks-group"><h3>' + escapeHtml(title) + ' <span class="checks-count">' + rows.length + '</span></h3><ul class="checks-list">' + rows.join('') + '</ul></section>' : '';
    };
    var actionRow = function (kind) {
      return function (action) {
        return '<li><span class="checks-item-text">' + escapeHtml(action.action || 'Untitled action') + '</span><button class="secondary compact" data-fix-' + kind + '="' + escapeHtml(actionOccurrence(action)) + '" type="button">Fix</button></li>';
      };
    };
    var done = ((state.draft && state.draft.reviewFlags) || []).filter(function (flag) { return flag.status && flag.status !== 'open'; });
    var doneHtml = done.length ? '<details class="checks-done"><summary>Done (' + done.length + ')</summary><ul class="checks-list">' + done.map(function (flag) {
      var status = flag.status === 'dismissed' ? 'Left out of the minutes' : flag.status === 'corrected' ? 'Note saved' : 'Checked';
      return '<li><span class="checks-item-text">' + escapeHtml(reviewFlagLabel(flag)) + '</span><span class="muted">' + status + '</span></li>';
    }).join('') + '</ul></details>' : '';
    return group('Missing owner', items.owner.map(actionRow('owner')))
      + group('Missing date', items.due.map(actionRow('due')))
      + group('Missing details', items.details.map(function (item) {
        return '<li><span class="checks-item-text">' + escapeHtml(item.label) + '</span><button class="secondary compact" data-fix-detail="' + item.field + '" type="button">Fix</button></li>';
      }))
      + (items.total ? '' : '<p class="checks-all-done">All checked. The minutes are ready to finalise.</p>')
      + doneHtml;
  }

  function finaliseConfirmHtml(items) {
    return '<div class="finalise-confirm" role="alert"><p><strong>' + plural(items.total, 'item is', 'items are') + ' still open:</strong> ' + escapeHtml(checksSummaryText(items)) + '.</p>'
      + '<p class="muted">You can finalise anyway, or review them first.</p>'
      + '<div class="finalise-confirm-actions"><button class="secondary" data-finalise-anyway type="button">Finalise anyway</button><button class="button" data-review-first type="button">Review first</button></div></div>';
  }

  function refreshChecksDrawer() {
    var items = openCheckItems();
    var confirm = document.getElementById('checksConfirm');
    if (confirm) confirm.innerHTML = checksDrawerMode === 'finalise' && items.total ? finaliseConfirmHtml(items) : '';
    var flagGroup = document.getElementById('checksFlagGroup');
    if (flagGroup) {
      flagGroup.hidden = !items.flagged.length;
      var count = flagGroup.querySelector('.checks-count');
      if (count) count.textContent = items.flagged.length;
    }
    var extra = document.getElementById('checksExtra');
    if (extra) extra.innerHTML = checksExtraHtml(items);
    var title = document.getElementById('sideDrawerTitle');
    if (title) title.textContent = checksDrawerMode === 'finalise' && items.total ? 'Finalise with open items?' : (items.total ? plural(items.total, 'item', 'items') + ' to check' : 'All checked');
  }

  // The model's checks keep today's cards: the list itself moves into the
  // drawer while it is open and goes back when it closes.
  function openChecksDrawer(mode) {
    var trigger = document.getElementById(mode === 'finalise' ? 'finaliseMinutes' : 'reviewQueueToggle');
    openDrawer({ title: '', trigger: trigger,
      html: '<div id="checksConfirm"></div><section id="checksFlagGroup" class="checks-group"><h3>Model flagged <span class="checks-count"></span></h3><div id="checksFlagSlot"></div></section><div id="checksExtra"></div>' });
    checksDrawerMode = mode || 'checks';
    document.getElementById('sideDrawer').classList.add('checks-drawer');
    var list = document.getElementById('flagList');
    var slot = document.getElementById('checksFlagSlot');
    if (list && slot) slot.appendChild(list);
    refreshChecksDrawer();
    document.getElementById('reviewQueueToggle').setAttribute('aria-expanded', 'true');
  }

  function restoreFlagList() {
    var list = document.getElementById('flagList');
    var home = document.querySelector('#reviewFlags .review-flags-body');
    if (list && home && list.parentElement !== home) home.appendChild(list);
    checksDrawerMode = '';
    var drawer = document.getElementById('sideDrawer');
    if (drawer) drawer.classList.remove('checks-drawer');
    var pill = document.getElementById('reviewQueueToggle');
    if (pill) pill.setAttribute('aria-expanded', 'false');
  }

  // Finds the place in the document a model check is about.
  function documentElementForFlag(flag) {
    var target = flagTarget(flag);
    if (!target || target.ambiguous) return null;
    if (target.field === 'summary') return document.querySelector('#finalDocument [data-kind="summary"]');
    if (target.elementId === 'objectivesList') return document.querySelector('#finalDocument .final-objectives');
    if (target.elementId === 'meetingDate') return document.querySelector('#documentMeta [data-field="meetingDate"]');
    if (target.stage === 3) {
      var actions = state.draft.actions || [];
      for (var index = 0; index < actions.length; index += 1) {
        if (actionDomId(actions[index], index) === target.elementId) return document.querySelector('#finalDocument tr[data-doc-action="' + actionOccurrence(actions[index]).replace(/"/g, '\\"') + '"]');
      }
      return null;
    }
    if (target.stage === 2 && !target.retained) {
      var found = null;
      (state.draft.discussion || []).forEach(function (topic, topicIndex) {
        var topicId = topic.id || 'topic-' + topicIndex;
        ['points', 'decisions', 'openQuestions'].forEach(function (field) {
          (topic[field] || []).forEach(function (item, itemIndex) {
            if (!found && (item.reviewFlagIds || []).indexOf(flag.id) >= 0) found = item.id || (topicId + '-' + field + '-' + itemIndex);
          });
        });
      });
      var element = found && document.querySelector('#finalDocument [data-kind="discussion"][data-record-id="' + String(found).replace(/"/g, '\\"') + '"]');
      return element ? (element.closest('li') || element) : null;
    }
    return null;
  }

  function pulseInDocument(element) {
    element.scrollIntoView({ block: 'center', behavior: 'smooth' });
    element.classList.remove('doc-pulse');
    void element.offsetWidth;
    element.classList.add('doc-pulse');
    window.setTimeout(function () { element.classList.remove('doc-pulse'); }, 1800);
  }

  // Open model checks marked in the document with an amber bar.
  var docFlaggedKeys = new Set();
  function computeDocFlaggedKeys() {
    var keys = new Set();
    var draft = state.draft || {};
    var open = (draft.reviewFlags || []).filter(function (flag) { return flag.status === 'open' && !proposalChangeForFlag(flag); });
    if (!open.length) return keys;
    var openIds = new Set(open.map(function (flag) { return flag.id; }));
    (draft.discussion || []).forEach(function (topic, topicIndex) {
      var topicId = topic.id || 'topic-' + topicIndex;
      ['points', 'decisions', 'openQuestions'].forEach(function (field) {
        (topic[field] || []).forEach(function (item, itemIndex) {
          if ((item.reviewFlagIds || []).some(function (id) { return openIds.has(id); })) keys.add('discussion|' + (item.id || topicId + '-' + field + '-' + itemIndex));
        });
      });
    });
    var actionIds = (draft.actions || []).map(function (action, index) { return actionDomId(action, index); });
    open.forEach(function (flag) {
      var target = flagTarget(flag);
      if (!target || target.ambiguous) return;
      if (target.field === 'summary') keys.add('summary|executive-summary');
      else if (target.stage === 3) {
        var at = actionIds.indexOf(target.elementId);
        if (at >= 0) keys.add('action|' + actionOccurrence(draft.actions[at]));
      }
    });
    return keys;
  }

  function documentMetaHtml(editable) {
    var details = (state.draft && state.draft.details) || {};
    var chip = function (field, value, options) {
      if (!editable) return '<span class="meta-chip">' + escapeHtml(options.displayValue || value || options.empty) + '</span>';
      return '<span class="meta-chip">' + finalTextEditor('details', 'meeting-details', field, value, options) + '</span>';
    };
    var typeLabel = meetingTypeLabel(details.meetingType) || 'Meeting type not set';
    var typeControl = '<span class="meta-chip">' + escapeHtml(typeLabel) + '</span>';
    if (editable) {
      var current = meetingTypeLabel(details.meetingType || '');
      var source = document.getElementById('meetingType');
      var labels = source ? Array.from(source.options).map(function (option) { return option.value; }).filter(Boolean) : [];
      if (current && labels.indexOf(current) < 0) labels.push(current);
      typeControl = '<span class="meta-chip"><select class="meta-select" data-doc-meeting-type aria-label="Meeting type"><option value="">Meeting type not set</option>'
        + labels.map(function (label) { return '<option' + (label === current ? ' selected' : '') + '>' + escapeHtml(label) + '</option>'; }).join('') + '</select></span>';
    }
    return chip('meetingDate', details.meetingDate || '', {singleLine:true,inputType:'date',label:'Edit meeting date',displayValue:formatUkDate(details.meetingDate),empty:'Date not set'})
      + '<span class="meta-sep" aria-hidden="true">·</span>'
      + chip('meetingLocation', details.meetingLocation || '', {singleLine:true,label:'Edit meeting location',empty:'Location not set'})
      + '<span class="meta-sep" aria-hidden="true">·</span>'
      + typeControl;
  }

  function setEditStructure(on) {
    if (documentFinalised()) return;
    var top = window.scrollY;
    try { window.localStorage.setItem(editStructureKey(), on ? '1' : '0'); } catch (error) { /* private mode */ }
    readEditors();
    activeFinalEdit = null;
    if (on) showStep(structureStep === MAX_STEP ? 2 : structureStep, { persist: false });
    else { renderFinal(); showStep(MAX_STEP, { persist: false }); }
    renderDocumentMode();
    if (!on) renderFinal();
    // The page keeps its place: toggling is not navigation.
    window.scrollTo({ top: top, behavior: 'auto' });
  }

  function renderPageHeading() {
    var title = document.getElementById('pageTitle');
    if (!title) return;
    var method = document.getElementById('generationMethod');
    if (method) method.hidden = true;
    renderBetaFlow();
    var details = state.draft && state.draft.details;
    var text = state.draft && details && String(details.meetingTitle || '').trim()
      ? details.meetingTitle.trim() : 'Meeting Minutes Agent';
    if (inDocumentMode()) title.innerHTML = finalTextEditor('details', 'meeting-details', 'meetingTitle', text, {singleLine:true,label:'Edit meeting title'});
    else title.textContent = text;
  }

  var DEFAULT_MEETING_LOCATION = 'Microsoft Teams';

  function readDetails() {
    if (!state.draft) return {};
    var internalAttendees = attendeeNames('internal');
    var clientAttendees = attendeeNames('client');
    state.draft.details = {
      meetingTitle: document.getElementById('meetingTitle').value.trim(),
      meetingDate: document.getElementById('meetingDate').value,
      meetingLocation: document.getElementById('meetingLocation').value.trim() || DEFAULT_MEETING_LOCATION,
      meetingType: meetingTypeValue(document.getElementById('meetingType').value),
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
    setFieldValue('meetingLocation', details.meetingLocation || DEFAULT_MEETING_LOCATION);
    setMeetingTypeField(details.meetingType || '');
    renderAttendeeGroup('internal', details.internalAttendees || []);
    renderAttendeeGroup('client', details.clientAttendees || []);
    setClientAttendeeVisibility((details.clientAttendees || []).some(function (name) { return String(name || '').trim(); }));
    setFieldValue('clientAttendeeLabelSelect', details.clientAttendeeLabel === 'External' ? 'External' : 'Client');
    document.getElementById('clientAttendeeHeading').textContent = details.clientAttendeeLabel === 'External' ? 'External' : 'Client';
  }

  async function prepareFile(file) {
    if (!file) return;
    if (!/\.docx$/i.test(file.name)) return setStatus('Choose a Word .docx transcript.', true);
    await betaAccessReady;
    var form = new FormData(); form.append('file', file);
    if (betaFlowEnabled) form.append('generationProvider', 'parallel-specialists-v1');
    // Do not call this an upload until the server has accepted and persisted
    // it. The confirmation is the durable acknowledgement, not a response to
    // merely selecting a file in the browser.
    uploadZone.hidden = true;
    setBusy(true, 'Reading the Word document and preparing the transcript...');
    try {
      var duplicateCheck = {duplicates: []};
      try {
        var duplicateController = new AbortController();
        var duplicateTimer = window.setTimeout(function () { duplicateController.abort(); }, 1500);
        try {
          duplicateCheck = await jsonRequest('/api/meeting-minutes-agent/check-duplicate', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({fileName: file.name, fileSize: file.size}),
            signal: duplicateController.signal
          });
        } finally {
          window.clearTimeout(duplicateTimer);
        }
      } catch (duplicateError) {
        // The duplicate check is a convenience guard, not a reason to block a
        // valid upload if an older deployment or a transient request failure
        // leaves the check endpoint unavailable.
        duplicateCheck = {duplicates: []};
      }
      if (duplicateCheck.duplicates && duplicateCheck.duplicates.length) {
        var proceed = await confirmDuplicateUpload(duplicateCheck.duplicates[0]);
        if (!proceed) {
          uploadZone.hidden = false;
          fileInput.value = '';
          setStatus('Duplicate upload cancelled.', false);
          return;
        }
      }
      var payload = await jsonRequest('/api/meeting-minutes-agent/prepare', { method: 'POST', body: form });
      uploadedDraftId = String(payload.draft && payload.draft.draftId || '');
      forgetPreviousDraft();
      adoptDraft(payload.draft);
      var resumeUrl = new URL(payload.resumeUrl || ('/meeting-minutes-agent?draftId=' + encodeURIComponent(state.draft.draftId)), window.location.origin);
      var projectParams = new URLSearchParams(window.location.search);
      if (/^[1-9]\d*$/.test(projectParams.get('projectId') || '')) {
        resumeUrl.searchParams.set('projectId', projectParams.get('projectId'));
        if (projectParams.get('projectName')) resumeUrl.searchParams.set('projectName', projectParams.get('projectName'));
        resumeUrl.searchParams.set('engine', betaFlowEnabled ? 'parallel' : 'original');
      }
      // This is the preference for the next upload. A saved draft always uses
      // its own persisted provider, including when reopened with this URL.
      if (betaFlowEnabled) resumeUrl.searchParams.set('engine', 'parallel');
      history.replaceState(null, '', resumeUrl.pathname + resumeUrl.search);
      showUploadConfirmation(file.name, (state.draft.sourceUnits || []).length, false, true);
      setStatus('Transcript uploaded and processing has started in the background.', false, 'details');
    } catch (error) {
      hideUploadConfirmation();
      uploadZone.hidden = false;
      fileInput.value = '';
      setStatus(error.message, true);
    }
    finally { setBusy(false); }
  }

  // A new upload is a separate draft. Nothing from the one on screen carries
  // over: not its step (a finished draft would open the new one on Review),
  // not its unsaved empty rows, not its open editors or notices.
  function forgetPreviousDraft() {
    [actionEditorState.pendingRows, actionEditorState.customOwners, actionEditorState.editingOwners,
      actionEditorState.editingTiming, discussionEditorState.pendingTopics, discussionEditorState.pendingRecords,
      discussionEditorState.collapsedTopics].forEach(function (bucket) {
      Object.keys(bucket).forEach(function (key) { delete bucket[key]; });
    });
    completedGenerationNotice = null;
    activeFinalEdit = null;
    state.draft = null;
    state.currentStep = 0;
  }

  function confirmDuplicateUpload(duplicate) {
    var dialog = document.getElementById('duplicateUploadDialog');
    var message = document.getElementById('duplicateUploadMessage');
    var link = document.getElementById('duplicateUploadLink');
    if (!dialog || !message || !link) return Promise.resolve(true);
    var title = String(duplicate.title || 'an existing meeting');
    message.textContent = '“' + String(duplicate.fileName || 'This transcript') + '” matches an existing Library item: ' + title + '.';
    link.href = duplicate.resumeUrl || '/jobs';
    return new Promise(function (resolve) {
      function complete() {
        dialog.removeEventListener('close', complete);
        resolve(dialog.returnValue === 'proceed');
      }
      dialog.addEventListener('close', complete);
      dialog.showModal();
    });
  }

  function recordDomId(kind, id, fallback) {
    var key = String(id || fallback || '').replace(/[^a-zA-Z0-9_-]+/g, '-');
    return 'minutes-' + kind + '-' + key;
  }

  // Promotion and demotion move the same record. Keep bounded predecessor
  // history as metadata alongside its existing evidence and review links.
  function preserveDiscussionMergeHistory(source, target) {
    var history = Array.from(new Set((Array.isArray(source.mergedFromIds) ? source.mergedFromIds : []).slice(0, 1000)
      .filter(function (id) { return typeof id === 'string' && id.length <= 220; })
      .map(function (id) { return id.trim(); })
      .filter(function (id) { return id && id !== target.id && !/[\u0000-\u001f\u007f]/.test(id); })));
    if (history.length) target.mergedFromIds = history;
    if (Array.isArray(source.filingOrigins)) target.filingOrigins = cloneEditorValue(source.filingOrigins);
    if (source.filingMergeProtected === true) target.filingMergeProtected = true;
    return target;
  }

  function orderedUnassignedSupportingDetails(pool, sourceUnits) {
    return window.MeetingMinutesFilingOrder.orderedEntries(pool, sourceUnits);
  }

  // Filing/promoting a retained version creates another occurrence. Existing
  // rows keep their identities; only an actual collision needs a fresh one.
  function uniqueDiscussionDetail(detail) {
    var used = new Set(), domKeys = new Set();
    function key(id) { return String(id || '').replace(/[^a-zA-Z0-9_-]+/g, '-'); }
    function visit(record) {
      if (!record || record === detail) return;
      if (record.id) { used.add(String(record.id)); domKeys.add(key(record.id)); }
      (record.supportingDetails || []).forEach(visit);
    }
    (state.draft.discussion || []).forEach(function (topic) {
      ['points','decisions','openQuestions'].forEach(function (kind) { (topic[kind] || []).forEach(visit); });
    });
    (state.draft.unassignedSupportingDetails || []).forEach(visit);
    (detail.supportingDetails || []).forEach(visit);
    var id = String(detail.id || '').trim(), fresh = id;
    function collision(value) { return used.has(value) || domKeys.has(key(value)); }
    if (!fresh || collision(fresh)) {
      var stem = (id || 'discussion-detail').slice(0, 48), number = 1;
      do { fresh = stem + '-occurrence-' + number++; } while (collision(fresh));
    }
    var next = preserveDiscussionMergeHistory(detail, Object.assign({}, detail, { id:fresh }));
    if (fresh !== id && id && (next.mergedFromIds || []).length < 1000) {
      next.mergedFromIds = Array.from(new Set([].concat(next.mergedFromIds || [], id)));
    }
    return next;
  }

  function topicSupportingDetails(topic, topicIndex) {
    return '';
  }

  function reviewFlagLabel(flag) {
    var labels = { uncertain_fact:'Uncertain detail', unclear_reference:'Reference to check', ownership:'Owner to check', attribution:'Attribution to check', timing:'Timing to check', unresolved_decision:'Open decision', missing_evidence:'Check this against the transcript', possible_missed_follow_up:'Possible missed follow-up' };
    var kind = String(flag && flag.kind || '');
    if (kind === 'timing' && flag && flag.temporalField === 'executiveSummary') return 'Summary timing to check';
    if (kind === 'timing' && flag && flag.temporalField === 'meetingObjectives') return 'Objective timing to check';
    return labels[kind] || (kind ? kind.replace(/_/g, ' ').replace(/\b\w/g, function (letter) { return letter.toUpperCase(); }) : 'Source check needed');
  }

  function earlierActionWordingForFlag(flag, target) {
    var wording = String(flag && flag.actionWordingAtCheck || '').trim();
    return wording && target && target.stage === 3 && !target.ambiguous
      && wording !== String(target.text || '').trim() ? wording : '';
  }

  // Historical summary/objective flags were written against an older internal
  // authority label. Keep saved explanations intact; adapt presentation only.
  function reviewFlagDisplayMessage(flag, target) {
    var message = String(flag && flag.message || 'Review this item against the transcript.');
    var summaryOrObjective = flag && (flag.temporalField === 'executiveSummary'
      || flag.temporalField === 'meetingObjectives')
      || /\b(?:executive summary|meeting objective)\b/i.test(message);
    if (summaryOrObjective) {
      // The old form quoted the whole summary/objective after the colon. Drop
      // that repeated paragraph from the display while retaining the useful
      // diagnostic that follows it.
      message = message.replace(/:\s*[“"][\s\S]*?(?:[”"]\s*\.|\.\s*[”"])\s*/, ': ');
      message = message.replace(/\b(?:the\s+)?approved minutes\b/gi, 'the current Discussion and Actions');
    }
    // Provenance is captured when the check is created, never inferred from
    // similar wording. Shared/ambiguous targets retain their original display.
    var checkedWording = earlierActionWordingForFlag(flag, target);
    if (checkedWording) {
      message = 'This check was raised against earlier action wording: “' + checkedWording
        + '” Review it against the current action shown above. Original explanation: ' + message;
    }
    return message;
  }

  function retainedWarningState(id) {
    var flag = ((state.draft && state.draft.reviewFlags) || []).find(function (item) { return item.id === id; });
    return {
      hidden: Boolean(flag && flag.status && flag.status !== 'open'),
      label: reviewFlagLabel(flag),
      message: flag && typeof flag.message === 'string' && flag.message.trim()
        ? reviewFlagDisplayMessage(flag) : 'The explanation for this retained warning is unavailable. Check this detail against its source before including it.'
    };
  }

  function retainedWarningNotices(detail, ownerKey) {
    return Array.from(new Set(detail.reviewFlagIds || [])).filter(function (id) {
      return typeof id === 'string' && id;
    }).map(function (id) {
      var notice = retainedWarningState(id);
      // The full explanation can quote the paragraph. Keep it available in a
      // disclosure rather than repeating that paragraph in the visible list.
      return '<details class="review-notice" data-retained-warning="' + escapeHtml(id)
        + '" data-keep-open="' + escapeHtml(disclosureKey([id], 'retained-warning:' + ownerKey))
        + '"' + (notice.hidden ? ' hidden' : '') + '><summary>' + escapeHtml(notice.label)
        + '</summary><p data-retained-warning-message>' + escapeHtml(notice.message) + '</p></details>';
    }).join('');
  }

  function refreshRetainedWarningNotices() {
    document.querySelectorAll('[data-retained-warning]').forEach(function (node) {
      var notice = retainedWarningState(node.dataset.retainedWarning);
      node.hidden = notice.hidden;
      node.querySelector('summary').textContent = notice.label;
      node.querySelector('[data-retained-warning-message]').textContent = notice.message;
    });
  }

  function unassignedSupportingDetailsPanel(discussion) {
    var pool = (state.draft && state.draft.unassignedSupportingDetails) || [];
    if (!Array.isArray(pool) || !pool.length) return '';
    var destinations = (discussion || []).flatMap(function (topic, topicIndex) {
      return ['points', 'decisions', 'openQuestions'].flatMap(function (field) {
        return (topic[field] || []).map(function (item, itemIndex) {
          if (!String(item.text || '').trim()) return '';
          var excerpt = String(item.text || '').trim();
          var label = String(topic.topic || 'Untitled topic').slice(0, 60) + ' — ' + excerpt.slice(0, 90) + (excerpt.length > 90 ? '…' : '');
          return '<option value="' + topicIndex + ':' + field + ':' + itemIndex + '">' + escapeHtml(label) + '</option>';
        }).filter(Boolean);
      });
    }).join('');
    var topicOptions = (discussion || []).map(function (topic, index) {
      return '<option value="' + index + '">' + escapeHtml(topic.topic || 'Untitled topic') + '</option>';
    }).join('');
    var review = state.draft.filingReview;
    var currentSuggestions = review && review.basis === window.MeetingMinutesFilingOrder.suggestionBasis(state.draft)
      ? review.suggestions || [] : [];
    function occurrence(entry, showText, number) {
      var suggested = currentSuggestions.find(function (item) { return item.index === entry.index; });
      var suggestion = '';
      if (suggested) {
        var hostTopic = discussion[suggested.topicIndex];
        var host = hostTopic && (hostTopic[suggested.field] || [])[suggested.itemIndex];
        if (host) suggestion = '<p class="muted">Suggested location: ' + escapeHtml(hostTopic.topic || 'Untitled topic')
          + ' — ' + escapeHtml(host.text) + '</p><button class="secondary compact" data-use-filing-suggestion="' + entry.index
          + '" type="button">File under suggested paragraph</button>';
      }
      var detail = entry.detail, index = entry.index;
      var detailId = detail.id || ('unassigned-' + index);
      var reviewKey = ((review && review.occurrences) || []).find(function (entry) { return entry.index === index; });
      var leaveOut = reviewKey && reviewKey.key ? '<button class="secondary compact" data-leave-out-supporting="' + index + '" data-optional-key="' + escapeHtml(reviewKey.key) + '" type="button">Leave out of minutes</button>' : '';
      var control = destinations
        ? '<label>File under<select data-supporting-destination aria-label="File this detail under a discussion item"><option value="">Choose a discussion item…</option>' + destinations + '</select></label><button class="secondary compact" data-file-supporting="' + index + '" type="button" disabled>File detail</button>'
        : '<p class="muted">Add a discussion point, decision or open question first, then choose where to file this detail.</p>';
      var warnings = retainedWarningNotices(detail, 'unassigned-' + detailId + '-' + index);
      var promote = '<label>Add as a discussion point in<select data-unassigned-topic><option value="">Choose a topic…</option>'
        + topicOptions + '<option value="new">New topic…</option></select></label>'
        + '<input data-unassigned-new-topic aria-label="New topic heading" placeholder="Heading for a new topic" maxlength="220" hidden>'
        + '<button class="secondary compact" data-promote-unassigned="' + index + '" type="button" disabled>Move to discussion point</button>';
      return '<article class="omitted-detail" data-unassigned-supporting-row="' + index + '" data-filing-key="' + escapeHtml(JSON.stringify(detail))
        + '" id="' + escapeHtml(recordDomId('unassigned-supporting', detailId + '-' + index, index)) + '"><div class="omitted-detail-copy">'
        + (showText ? '<p>' + escapeHtml(detail.text || '') + '</p>' : '<p class="muted">Occurrence ' + number + '</p>') + warnings
        + '</div><div class="omitted-detail-actions">' + leaveOut + suggestion + control + promote
        + evidenceBlock(detail.evidenceIds, 'unassigned-' + detailId + '-' + index) + '</div></article>';
    }
    return '<section class="omitted-topic" data-needs-filing><h3>Optional retained material (' + pool.length + ' entries)</h3><p class="muted">These entries are not included in the main minutes. File or add an entry only if you want to include it.</p><div class="omitted-detail-list">'
      + window.MeetingMinutesFilingOrder.groupedEntries(pool, state.draft.sourceUnits).map(function (group) {
        if (group.entries.length === 1) return occurrence(group.entries[0], true, 1);
        return '<section data-identical-filing-group><p>' + escapeHtml(group.text) + '</p><details data-keep-open="filing-group-'
          + group.entries[0].index + '"><summary>' + group.entries.length
          + ' retained occurrences — review sources and file separately</summary>'
          + group.entries.map(function (entry, index) { return occurrence(entry, false, index + 1); }).join('') + '</details></section>';
      }).join('') + '</div></section>';
  }

  function excludedDetailsPanel() {
    var entries = (state.draft && state.draft.excludedSupportingDetails) || [];
    if (!entries.length) return '';
    return '<details data-excluded-details data-keep-open="excluded-details"><summary>Left out of minutes (' + entries.length + ')</summary><p class="muted">Your choices are saved. These records and sources remain available to restore.</p>'
      + entries.map(function (entry) { return '<article class="omitted-detail" id="minutes-excluded-' + escapeHtml(entry.key) + '"><div class="omitted-detail-copy"><p>' + escapeHtml(entry.record.text) + '</p>' + retainedWarningNotices(entry.record, 'excluded-' + entry.key)
        + '</div><div class="omitted-detail-actions"><button class="secondary compact" data-restore-excluded="' + escapeHtml(entry.key) + '" type="button">Restore optional detail</button>' + '<details class="review-evidence"><summary>Source when left out</summary>' + (entry.sources || []).map(function (unit) { return '<p><strong>' + escapeHtml(unit.speaker || unit.id) + '</strong> ' + escapeHtml(unit.text) + '</p>'; }).join('') + '</details></div></article>'; }).join('') + '</details>';
  }

  function omittedDetailsPanel(discussion) {
    var grouped = (discussion || []).map(function (topic, topicIndex) {
      var rows = ['points', 'decisions', 'openQuestions'].flatMap(function (field) {
        return (topic[field] || []).flatMap(function (item, itemIndex) {
          return (item.supportingDetails || []).map(function (detail, detailIndex) {
            return { field:field, item:item, itemIndex:itemIndex, detail:detail, detailIndex:detailIndex };
          });
        });
      });
      return { topic:topic, topicIndex:topicIndex, rows:rows };
    }).filter(function (group) { return group.rows.length; });
    var unassigned = unassignedSupportingDetailsPanel(discussion);
    var pool = (state.draft && state.draft.unassignedSupportingDetails) || [];
    var count = grouped.reduce(function (total, group) { return total + group.rows.length; }, 0) + (Array.isArray(pool) ? pool.length : 0);
    var excluded = excludedDetailsPanel();
    if (!count && !excluded) return '';
    return '<details id="omittedDetailsPanel" class="omitted-details-panel" data-keep-open="omitted-details"><summary class="omitted-details-summary">Optional additional details (' + count + ')</summary><div class="omitted-details-body"><p class="muted omitted-details-intro">These details are not included in the main minutes. You can add anything useful; there is no need to include every entry. Any linked warnings still need checking before including the detail.</p><div class="omitted-topic-list">' + grouped.map(function (group) {
      return '<section class="omitted-topic"><h3>' + escapeHtml(group.topic.topic || 'Untitled topic') + '</h3><div class="omitted-detail-list">' + group.rows.map(function (row) {
        var detailId = row.detail.id || (group.topicIndex + '-' + row.field + '-' + row.itemIndex + '-' + row.detailIndex);
        return '<article class="omitted-detail" id="' + escapeHtml(recordDomId('supporting', detailId, detailId)) + '"><div class="omitted-detail-copy"><p>' + escapeHtml(row.detail.text || '') + '</p>' + retainedWarningNotices(row.detail, 'supporting-' + detailId + '-' + group.topicIndex + '-' + row.field + '-' + row.itemIndex + '-' + row.detailIndex) + (row.detail.placementStatus === 'unresolved' ? '<p class="muted">Placement needs review.</p>' : '') + '</div><div class="omitted-detail-actions"><button class="secondary compact" data-promote-supporting="' + row.detailIndex + '" data-parent-field="' + row.field + '" data-topic-index="' + group.topicIndex + '" data-item-index="' + row.itemIndex + '" type="button">Add to minutes</button>' + evidenceBlock(row.detail.evidenceIds, String(detailId)) + '</div></article>';
      }).join('') + '</div></section>';
    }).join('') + unassigned + excluded + '</div></div></details>';
  }

  // Offered only when there is somewhere to merge to.
  function mergeTopicControl(discussion, index) {
    var others = discussion.map(function (other, otherIndex) {
      return otherIndex === index ? null : { index: otherIndex, topic: other.topic || 'Untitled topic' };
    }).filter(Boolean);
    if (!others.length) return '';
    return '<label class="merge-topic"><span>Merge into</span><select data-merge-topic="' + index + '" aria-label="Merge this topic into another">'
      + '<option value="">Choose a topic…</option>'
      + others.map(function (other) {
        return '<option value="' + other.index + '">' + escapeHtml(other.topic.slice(0, 60)) + '</option>';
      }).join('')
      + '</select></label>';
  }

  // "Move to" works with a tap, so moving a row between topics does not
  // depend on drag and drop, which phones do not support.
  function moveRecordControl(row, topicIndex) {
    var discussion = (state.draft && state.draft.discussion) || [];
    var others = discussion.map(function (other, otherIndex) {
      return otherIndex === topicIndex ? null : { index: otherIndex, topic: other.topic || 'Untitled topic' };
    }).filter(Boolean);
    if (!others.length) return '';
    return '<label class="merge-topic move-record-topic"><span>Move to topic</span><select data-move-record-topic="' + escapeHtml(row.field) + '" data-topic-index="' + topicIndex + '" data-item-index="' + row.itemIndex + '" aria-label="Move this item to another topic">'
      + '<option value="">Choose a topic…</option>'
      + others.map(function (other) {
        return '<option value="' + other.index + '">' + escapeHtml(other.topic.slice(0, 60)) + '</option>';
      }).join('')
      + '</select></label>';
  }

  function discussionPropositions(topic, topicIndex) {
    var labels = { points: 'Discussion', decisions: 'Decision', openQuestions: 'Open question' };
    var rows = ['points', 'decisions', 'openQuestions'].flatMap(function (field) {
      return (topic[field] || []).map(function (item, itemIndex) { return {field:field,item:item,itemIndex:itemIndex}; });
    });
    return '<div class="record-section proposition-section"><div class="record-list proposition-list">' + (rows.map(function (row) {
      var label = labels[row.field];
      var targetId = recordDomId('discussion', row.item.id, topicIndex + '-' + row.field + '-' + row.itemIndex);
      var kindButtons = ['points', 'decisions', 'openQuestions'].filter(function (field) { return field !== row.field; }).map(function (field) {
        return '<button class="secondary quiet" data-change-kind="' + field + '" data-record-kind="' + row.field + '" data-topic-index="' + topicIndex + '" data-item-index="' + row.itemIndex + '" type="button">' + escapeHtml(KIND_CHANGE_LABELS[field]) + '</button>';
      }).join('');
      var actions = moveRecordControl(row, topicIndex) + kindButtons + (rows.length > 1 ? '<button class="secondary quiet" data-demote-record="' + row.field + '" data-topic-index="' + topicIndex + '" data-item-index="' + row.itemIndex + '" type="button" title="Leave this out of the minutes but keep it under Review additional details.">Move to additional details</button>' : '') + '<button class="secondary quiet" data-move-record-new-topic="' + row.field + '" data-topic-index="' + topicIndex + '" data-item-index="' + row.itemIndex + '" type="button">Move to new topic</button><button class="delete quiet" data-remove-record="' + row.field + '" data-topic-index="' + topicIndex + '" data-item-index="' + row.itemIndex + '" type="button">Remove</button>';
      var grip = '<button type="button" class="record-grip" draggable="true"'
        + ' data-record-grip="' + topicIndex + '" data-grip-field="' + row.field + '" data-grip-index="' + row.itemIndex + '"'
        + ' aria-label="Reorder this ' + escapeHtml(label.toLowerCase()) + '. Drag, or use the arrow keys."'
        + ' title="Drag to reorder or move to another topic"><svg class="ic" aria-hidden="true"><use href="#i-grip"/></svg></button>';
      return '<div id="' + escapeHtml(targetId) + '" class="record-row proposition-row" data-record-row data-row-topic="' + topicIndex + '" data-row-field="' + escapeHtml(row.field) + '" data-row-index="' + row.itemIndex + '">' + grip + '<div class="proposition-kind ' + escapeHtml(row.field) + '">' + escapeHtml(label) + '</div><textarea rows="1" data-record-field="' + row.field + '" data-topic-index="' + topicIndex + '" data-item-index="' + row.itemIndex + '" aria-label="' + escapeHtml(label) + '">' + escapeHtml(row.item.text || '') + '</textarea>' + recordMenu(row.item, actions) + '</div>';
    }).join('') || '<p class="muted record-empty">No meeting content recorded.</p>') + '</div>' + topicSupportingDetails(topic, topicIndex) + '</div>';
  }

  // One tap adds a plain discussion point, which is what is wanted most of the
  // time. A point becomes a decision or open question from its own menu.
  var KIND_CHANGE_LABELS = { points: 'Make it a discussion point', decisions: 'Make it a decision', openQuestions: 'Make it an open question' };

  function recordAddButton(topicIndex) {
    return '<button class="secondary quiet compact record-add-point" data-add-record="points" data-topic-index="' + topicIndex + '" type="button"><svg class="ic" aria-hidden="true"><use href="#i-plus"/></svg>Add point</button>';
  }

  function topicHeadingsShown() {
    return includedSectionState().topicHeadings;
  }

  function renderDiscussion() {
    if (generationRunning('discussion')) {
      document.getElementById('omittedDetailsReview').innerHTML = '';
      document.getElementById('discussionListBar').innerHTML = '';
      document.getElementById('discussionList').innerHTML = '<div class="generation-skeleton" aria-hidden="true"><span></span><span></span><span></span></div>';
      return;
    }
    var discussion = (state.draft && state.draft.discussion) || [];
    document.getElementById('omittedDetailsReview').innerHTML = omittedDetailsPanel(discussion);
    var allCollapsed = discussion.length > 0 && discussion.every(function (topic, index) {
      return Boolean(discussionEditorState.collapsedTopics[String(topic.id || ('topic-' + index))]);
    });
    // Collapsing every card leaves a short list of topic titles: the quickest
    // way to see the shape of the minutes and rename topics, above all on a phone.
    var showHeadings = topicHeadingsShown();
    var listBar = discussion.length
      ? '<div class="discussion-list-bar"><label class="topic-headings-switch"><input type="checkbox" data-topic-headings-switch' + (showHeadings ? ' checked' : '') + '> Show topic titles in minutes</label>'
        + (discussion.length > 1 ? '<button class="secondary quiet compact" data-toggle-all-topics="' + (allCollapsed ? 'expand' : 'collapse') + '" type="button">' + (allCollapsed ? 'Expand all' : 'Collapse all') + '</button>' : '')
        + (state.draft && state.draft.canRestoreCombinedDiscussion ? '<button class="secondary quiet compact" data-restore-combined-discussion type="button">' + (state.draft.canRestorePairedDiscussionActions ? 'Restore original discussion and action wording' : 'Restore combined paragraphs') + '</button>' : '')
        + '</div>'
      : '';
    document.getElementById('discussionListBar').innerHTML = listBar;
    document.getElementById('discussionList').innerHTML = discussion.map(function (topic, index) {
      var topicId = String(topic.id || ('topic-' + index));
      var collapsed = Boolean(discussionEditorState.collapsedTopics[topicId]);
      var rows = ['points','decisions','openQuestions'].reduce(function (total, field) { return total + (topic[field] || []).length; }, 0);
      var flagIds = new Set(linkedReviewFlagIds(topic));
      var checks = ((state.draft && state.draft.reviewFlags) || []).filter(function (flag) { return flag.status === 'open' && flagIds.has(flag.id); }).length;
      var meta = rows + ' item' + (rows === 1 ? '' : 's') + (checks ? ' · ' + checks + ' to review' : '');
      var headingHidden = !showHeadings || topic.hideHeading === true;
      var headingToggle = showHeadings
        ? '<button class="secondary quiet" data-toggle-topic-heading="' + index + '" type="button">' + (topic.hideHeading ? 'Show title in minutes' : 'Hide title in minutes') + '</button>'
        : '';
      return '<article id="' + escapeHtml(recordDomId('topic', topicId, index)) + '" class="discussion-card' + (collapsed ? ' is-collapsed' : '') + (rows === 1 ? ' is-single' : '') + (headingHidden ? ' is-heading-hidden' : '') + '" data-topic-card="' + escapeHtml(topicId) + '"><div class="card-head"><button class="topic-collapse" data-toggle-topic="' + escapeHtml(topicId) + '" type="button" aria-expanded="' + String(!collapsed) + '" aria-label="' + (collapsed ? 'Expand' : 'Collapse') + ' topic" title="' + (collapsed ? 'Expand' : 'Collapse') + ' topic"><span aria-hidden="true">›</span></button><label class="topic-field"><textarea rows="1" data-topic-index="' + index + '" data-topic aria-label="Discussion topic (tap to rename)" placeholder="Topic" title="Tap to rename">' + escapeHtml(topic.topic || '') + '</textarea><small class="topic-count">' + escapeHtml(meta) + (headingHidden ? ' · title hidden' : '') + '</small></label><details class="topic-menu" data-menu><summary class="secondary quiet" aria-label="Topic actions" title="Topic actions">•••</summary><div class="topic-menu-popover" data-menu-popover>' + mergeTopicControl(discussion, index) + headingToggle + '<button class="delete quiet" data-delete-topic="' + index + '" type="button">Remove topic</button></div></details></div><div class="discussion-card-body"' + (collapsed ? ' hidden' : '') + '>' + discussionPropositions(topic, index) + recordAddButton(index) + '</div></article>';
    }).join('') || '<p class="muted">No discussion content has been generated.</p>';
    autoGrow(document.getElementById('discussionList'));
    restoreDisclosures(document.getElementById('omittedDetailsReview'));
    restoreDisclosures(document.getElementById('discussionList'));
  }

  function readDiscussion() {
    if (!state.draft) return [];
    document.querySelectorAll('[data-topic]').forEach(function (input) {
      var topic = state.draft.discussion[Number(input.dataset.topicIndex)];
      if (topic && topic.topic !== input.value.trim()) {
        topic.topic = input.value.trim();
        topic.reviewerAuthored = true;
      }
    });
    document.querySelectorAll('[data-record-field]').forEach(function (area) {
      var topic = state.draft.discussion[Number(area.dataset.topicIndex)];
      var list = topic && topic[area.dataset.recordField];
      var record = list && list[Number(area.dataset.itemIndex)];
      if (record && record.text !== area.value.trim()) {
        record.text = area.value.trim();
        record.reviewerAuthored = true;
      }
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

  // A model-facing ID can repeat in an older draft. Occurrence IDs identify
  // individual rows without changing the original IDs or their evidence.
  function ensureActionOccurrences(draft) {
    var rows = (draft.actions || []).concat(draft.removedActions || []);
    var counts = Object.create(null);
    rows.forEach(function (action) {
      var key = typeof action.occurrenceId === 'string' ? action.occurrenceId : '';
      if (/^[A-Za-z0-9_-]{1,128}$/.test(key)) counts[key] = (counts[key] || 0) + 1;
    });
    // A repeated occurrence token is ambiguous too. Retain neither claim to it,
    // so a stale checked reference cannot silently select the first row.
    var used = new Set(Object.keys(counts));
    rows.forEach(function (action) {
      var key = typeof action.occurrenceId === 'string' ? action.occurrenceId : '';
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(key) || counts[key] !== 1) {
        do {
          key = 'action-occurrence-' + (window.crypto && window.crypto.randomUUID
            ? window.crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2));
        } while (used.has(key));
        action.occurrenceId = key;
      }
      used.add(key);
    });
  }

  function transferActionOccurrences(draft) {
    if (!state.draft) return;
    function signature(row) {
      function ordered(value, top) {
        if (Array.isArray(value)) return value.map(function (item) { return ordered(item, false); });
        if (!value || typeof value !== 'object') return value;
        var result = Object.create(null);
        Object.keys(value).sort().forEach(function (key) {
          if (!(top && key === 'occurrenceId')) result[key] = ordered(value[key], false);
        });
        return result;
      }
      return JSON.stringify(ordered(row, true));
    }
    var prior = (state.draft.actions || []).concat(state.draft.removedActions || []);
    var incoming = (draft.actions || []).concat(draft.removedActions || []);
    var priorBySignature = Object.create(null);
    var incomingCounts = Object.create(null);
    prior.forEach(function (row) {
      var key = signature(row);
      (priorBySignature[key] || (priorBySignature[key] = [])).push(row);
    });
    incoming.forEach(function (row) {
      var key = signature(row);
      incomingCounts[key] = (incomingCounts[key] || 0) + 1;
    });
    incoming.forEach(function (row) {
      if (row.occurrenceId) return;
      var key = signature(row);
      var matches = priorBySignature[key] || [];
      if (matches.length === 1 && incomingCounts[key] === 1) row.occurrenceId = actionOccurrence(matches[0]);
    });
  }

  function actionOccurrence(action) {
    return String(action && action.occurrenceId || '');
  }

  function actionIndexForOccurrence(key) {
    if (!key || !state.draft) return -1;
    var matches = (state.draft.actions || []).map(function (action, index) {
      return actionOccurrence(action) === key ? index : -1;
    }).filter(function (index) { return index >= 0; });
    return matches.length === 1 ? matches[0] : -1;
  }

  function actionDomId(action, index, kind) {
    var id = String(action && action.id || '');
    var unique = /^[A-Za-z0-9_-]+$/.test(id) && ((state.draft && state.draft.actions) || []).filter(function (row) {
      return String(row.id || '') === id || actionOccurrence(row) === id;
    }).length === 1;
    return recordDomId(kind || 'action', unique ? id : actionOccurrence(action), index);
  }

  function ownerEditor(action, index) {
    var owners = action.owners || [];
    var actionId = actionOccurrence(action);
    var editing = Boolean(actionEditorState.editingOwners[actionId]);
    if (!editing) {
      return '<button type="button" class="field-display owner-summary" data-edit-owners data-action-index="' + index + '" data-action-id="' + escapeHtml(actionId) + '" aria-label="Edit owners">' + escapeHtml(owners.join(', ') || 'No owner assigned') + '</button>';
    }
    var taken = owners.map(function (owner) { return owner.toLowerCase(); });
    var available = participantNames().filter(function (name) { return taken.indexOf(name.toLowerCase()) < 0; });
    var chips = owners.map(function (owner) {
      return '<span class="owner-chip" data-owner-chip data-action-index="' + index + '" data-owner="' + escapeHtml(owner) + '">' + escapeHtml(owner) + '<button type="button" data-remove-owner data-action-index="' + index + '" data-action-id="' + escapeHtml(actionId) + '" data-owner="' + escapeHtml(owner) + '" aria-label="Remove owner ' + escapeHtml(owner) + '">&times;</button></span>';
    }).join('') || '<span class="muted">Not stated</span>';
    var options = available.map(function (name) {
      return '<option value="' + escapeHtml(name) + '">' + escapeHtml(name) + '</option>';
    }).join('');
    var ownerDraft = actionEditorState.customOwners[actionId] || {};
    return '<div class="owner-editor"><div class="owner-chips">' + chips + '</div><div class="owner-add"><select data-add-owner data-action-index="' + index + '" data-action-id="' + escapeHtml(actionId) + '" aria-label="Add an attendee as owner"><option value="">Choose owner...</option>' + options + '<option value="__other">Someone else...</option></select><input data-owner-other data-action-index="' + index + '" data-action-id="' + escapeHtml(actionId) + '" value="' + escapeHtml(ownerDraft.value || '') + '" placeholder="Name" aria-label="Add another owner by name"' + (ownerDraft.visible ? '' : ' hidden') + '><button type="button" class="secondary quiet compact" data-finish-owner-edit data-action-id="' + escapeHtml(actionId) + '">Done</button></div></div>';
  }

  function timingSourceTitle(timing) {
    if (!timing || !timing.exactDate || !timing.wording) return '';
    return ' title="From “' + escapeHtml(timing.wording) + '”"';
  }

  function timingEditor(timing, index, actionId) {
    actionId = String(actionId || ('action-' + index));
    if (!actionEditorState.editingTiming[actionId]) {
      return '<button type="button" class="field-display timing-summary" data-edit-timing data-action-index="' + index + '" data-action-id="' + escapeHtml(actionId) + '" aria-label="Edit timing"' + timingSourceTitle(timing) + '>' + escapeHtml(timingText(timing)) + '</button>';
    }
    var kinds = [['not_stated', 'Not stated'], ['target', 'Target'], ['deadline', 'Deadline'], ['dependency', 'Dependency']];
    if (isParallelDraft()) kinds.push(['stated', 'As stated']);
    var options = kinds.map(function (pair) {
      return '<option value="' + pair[0] + '"' + (timing.kind === pair[0] ? ' selected' : '') + '>' + pair[1] + '</option>';
    }).join('');
    return '<div class="timing-editor"><select data-timing-kind data-action-index="' + index + '" aria-label="Timing type">' + options + '</select><label><span>As said in the meeting</span><input data-timing-wording data-action-index="' + index + '" value="' + escapeHtml(timing.wording || '') + '" placeholder="e.g. this week" aria-label="Original timing wording"></label><label class="timing-date-field"><span>Exact date (optional)</span><input data-timing-date data-action-index="' + index + '" type="date" data-initial-date="' + escapeHtml(timing.exactDate || '') + '" value="' + escapeHtml(timing.exactDate || '') + '" aria-label="Exact date"></label><button type="button" class="secondary quiet compact" data-finish-timing-edit data-action-id="' + escapeHtml(actionId) + '">Done</button></div>';
  }

  function renderActions() {
    if (generationRunning('actions')) {
      var generation = state.draft.generation || {};
      var preview = Array.isArray(generation.previewActions) ? generation.previewActions : [];
      // The server filters this display copy against the preview with the same
      // deliverable-aware rule used at final publication. Older in-flight
      // generations do not carry it, so retain the previous fallback.
      var prior = Array.isArray(generation.previewSavedActions)
        ? generation.previewSavedActions
        : Array.isArray(state.draft.actions) ? state.draft.actions : [];
      var intro = preview.length
        ? 'These are early possible actions from the transcript, shown so you have something useful to review while the agent finishes its checks. They may change, merge or disappear. The finished action list will replace this preview automatically, and editing will then unlock.'
        : prior.length
          ? 'These saved actions remain visible while a refreshed version is prepared.'
          : 'Early possible actions will appear here as soon as the first checks finish.';
      var readOnlyRows = function (items, className) { return items.map(function (item) {
        return '<tr class="preview-action-row ' + className + '"><td data-label="Action"><div>' + escapeHtml(item.action || '') + '</div><div class="action-tools">' + evidenceBlock(item.evidenceIds) + '</div></td><td data-label="Owners"><div class="preview-action-meta">' + escapeHtml((item.owners || []).join(', ') || 'Not stated') + '</div></td><td data-label="Timing"><div class="preview-action-meta">' + escapeHtml(timingDisplayText(item.timing)) + '</div></td></tr>';
      }).join(''); };
      var sections = '';
      if (preview.length) sections += '<tr class="generation-section-row working-preview-section"><th colspan="3"><span class="working-preview-heading"><span class="working-preview-dot" aria-hidden="true"></span><span><strong>Working preview</strong><small>Temporary — final checks still running</small></span></span></th></tr>' + readOnlyRows(preview, 'preview-current');
      if (prior.length) sections += '<tr class="generation-section-row saved-actions-heading"><th colspan="3">Previously saved actions</th></tr>' + readOnlyRows(prior, 'preview-saved');
      document.getElementById('actionsBody').innerHTML = '<tr class="generation-row"><td colspan="3"><p class="generating">' + escapeHtml(intro) + '</p></td></tr>' + sections;
      return;
    }
    var actions = (state.draft && state.draft.actions) || [];
    var emptyActionsMessage = (function () {
      var generation = state.draft && state.draft.generation;
      if (generation && generation.stage === 'actions' && generation.status === 'failed') {
        return 'Actions could not be generated. Try again.';
      }
      if (stageGeneratedAt(state.draft, 'actions')) {
        return 'No confirmed actions were identified in this meeting.';
      }
      return 'Actions have not been generated yet.';
    })();
    document.getElementById('actionsBody').innerHTML = actions.map(function (item, index) {
      var timing = item.timing || {kind:'not_stated',wording:'',exactDate:''};
      var targetId = actionDomId(item, index);
      var transcriptId = actionTranscriptId(item, index);
      var transcriptKey = disclosureKey(item.evidenceIds, 'action-transcript:' + actionOccurrence(item));
      var transcriptOpen = Boolean(openDisclosures[transcriptKey]);
      // No "•••" menu on an action row: it only repeated the row's own
      // source and remove controls under a heading,
      // and two remove buttons that do the same thing read as two things.
      var kept = isActionKept(item);
      // The textarea is always editable, so a separate Edit control would do
      // nothing a click in the field does not already do.
      // Source, review and removal share one "…" menu; removal is last and red.
      var decisions = '<div class="row-decisions">'
        + (kept ? '<span class="row-reviewed" title="Marked reviewed">' + icon('check') + '<span class="visually-hidden">Reviewed</span></span>' : '')
        + rowMenu('Action ' + (index + 1) + ' options',
          '<button type="button" class="secondary quiet row-transcript" data-open-action-transcript="' + index + '" aria-controls="' + escapeHtml(transcriptId) + '" aria-expanded="' + (transcriptOpen ? 'true' : 'false') + '"><span data-transcript-toggle-label>' + (transcriptOpen ? 'Hide source' : 'View source') + '</span></button>'
          + '<button type="button" class="secondary quiet row-keep' + (kept ? ' is-kept' : '') + '" data-keep-action="' + index + '" aria-pressed="' + (kept ? 'true' : 'false') + '">' + (kept ? 'Reviewed ✓' : 'Mark reviewed') + '</button>'
          + '<button type="button" class="delete quiet row-reject" data-reject-action="' + index + '">Remove action</button>')
        + '</div>';
      var transcriptPanel = '<details id="' + escapeHtml(transcriptId) + '" class="action-transcript-panel" data-action-transcript-panel data-keep-open="' + escapeHtml(transcriptKey) + '"><summary class="visually-hidden">Transcript passage</summary><div class="evidence-panel">' + evidenceHtml(item.evidenceIds) + '</div></details>';
      // Reordering: the handle is the drag source and also takes arrow keys, so
      // the order can be changed without a mouse.
      var grip = '<button type="button" class="action-grip" data-action-grip="' + index + '" draggable="true"'
        + ' aria-label="Reorder action ' + (index + 1) + '. Drag, or use the arrow keys."'
        + ' title="Drag to reorder"><svg class="ic" aria-hidden="true"><use href="#i-grip"/></svg></button>';
      return '<tr id="' + escapeHtml(targetId) + '" class="action-row' + (kept ? ' action-kept' : '') + '" data-action-row="' + index + '" data-action-id="' + escapeHtml(item.id || '') + '" data-action-occurrence-id="' + escapeHtml(actionOccurrence(item)) + '"><td data-label="Action"><div class="action-main">' + grip + '<textarea rows="1" data-action-index="' + index + '" data-action aria-label="Action ' + (index + 1) + '">' + escapeHtml(item.action || '') + '</textarea></div>' + decisions + transcriptPanel + '</td><td data-label="Owners">' + ownerEditor(item, index) + '</td><td data-label="Timing">' + timingEditor(timing, index, actionOccurrence(item)) + '</td></tr>';
    }).join('') || '<tr class="empty-actions-row"><td colspan="3" class="muted">' + escapeHtml(emptyActionsMessage) + '</td></tr>';
    if (state.draft && state.draft.canRestoreCombinedActions) {
      document.getElementById('actionsBody').insertAdjacentHTML('beforeend', '<tr><td colspan="3"><button class="secondary quiet compact" data-restore-combined-actions type="button">' + (state.draft.canRestorePhaseActions ? 'Restore original action wording' : 'Restore separate actions') + '</button></td></tr>');
    }
    renderParallelProposals();
    autoGrow(document.getElementById('actionsBody'));
    restoreDisclosures(document.getElementById('actionsBody'));
    renderActionReview();
  }

  function keptActionIds() {
    if (!state.draft) return [];
    if (!Array.isArray(state.draft.keptActionIds)) state.draft.keptActionIds = [];
    return state.draft.keptActionIds;
  }

  function removedActions() {
    if (!state.draft) return [];
    if (!Array.isArray(state.draft.removedActions)) state.draft.removedActions = [];
    return state.draft.removedActions;
  }

  function keptActionOccurrenceIds() {
    if (!state.draft) return [];
    if (!Array.isArray(state.draft.keptActionOccurrenceIds)) state.draft.keptActionOccurrenceIds = [];
    return state.draft.keptActionOccurrenceIds;
  }

  function unambiguousLegacyActionId(action) {
    var id = String(action && action.id || '');
    var rows = (state.draft.actions || []).concat(state.draft.removedActions || []);
    return id && rows.filter(function (row) { return String(row.id || '') === id; }).length === 1 ? id : '';
  }

  function isActionKept(action) {
    var key = actionOccurrence(action);
    var legacy = unambiguousLegacyActionId(action);
    return Boolean(key && keptActionOccurrenceIds().indexOf(key) !== -1)
      || Boolean(legacy && keptActionIds().indexOf(legacy) !== -1);
  }

  function renderActionReview() {
    var bar = document.getElementById('actionReviewBar');
    var panel = document.getElementById('removedActionsPanel');
    if (!bar || !panel || !state.draft) return;
    var actions = state.draft.actions || [];
    var removed = removedActions();
    bar.hidden = !actions.length && !removed.length;
    bar.innerHTML = '<span class="review-count review-count-open"><strong>' + actions.length + '</strong> action' + (actions.length === 1 ? '' : 's') + '</span>';

    panel.hidden = !removed.length;
    var summary = document.getElementById('removedActionsSummary');
    if (summary) summary.textContent = removed.length === 1 ? '1 removed action' : removed.length + ' removed actions';
    var list = document.getElementById('removedActionsList');
    if (list) list.innerHTML = removed.map(function (item, index) {
      var owners = (item.owners || []).join(', ');
      return '<div class="removed-action"><div class="removed-action-text">' + escapeHtml(item.action || '')
        + (owners ? '<span class="muted"> - ' + escapeHtml(owners) + '</span>' : '')
        + '</div><button type="button" class="secondary" data-restore-action="' + index + '">Put back</button></div>';
    }).join('');
  }

  function rerenderActions() {
    var snapshot = captureFocus();
    var wasRendering = rendering;
    rendering = true;
    try { renderActions(); } finally { rendering = wasRendering; }
    restoreFocus(snapshot);
  }

  function actionEditFingerprint(action) {
    var timing = action.timing || {};
    return JSON.stringify([action.action || '', action.owners || [], timing.kind || 'not_stated', timing.wording || '', timing.exactDate || '']);
  }

  function editedTiming(action, kind, wording, dateControl) {
    var prior = action.timing || {};
    // A date input cannot represent an invalid historical value. Opening its
    // editor must not silently clear that value before the reviewer edits it.
    var date = dateControl ? dateControl.value : '';
    if (dateControl && !date && dateControl.dataset.initialDate && !dateControl.dataset.dateEdited) {
      date = dateControl.dataset.initialDate;
    }
    var next = Object.assign({}, prior, { kind: kind, wording: wording, exactDate: date });
    if (JSON.stringify([prior.kind || 'not_stated', prior.wording || '', prior.exactDate || ''])
      === JSON.stringify([next.kind, next.wording, next.exactDate])) return prior;
    delete action.timingDecision;
    return window.MeetingMinutesTiming.normaliseTimingValue(next, {
      mode: 'preserve', reviewerAuthored: true,
      meetingDate: ((state.draft || {}).details || {}).meetingDate || ''
    });
  }

  function readActions() {
    if (!state.draft) return [];
    // Scoped to each row: the previous version issued four document-wide
    // querySelectorAll calls per action, on every keystroke.
    document.querySelectorAll('#actionsBody [data-action-row]').forEach(function (row) {
      var action = state.draft.actions[Number(row.dataset.actionRow)];
      if (!action) return;
      var before = actionEditFingerprint(action);
      var area = row.querySelector('[data-action]');
      if (area) action.action = area.value.trim();
      var ownerChips = row.querySelectorAll('[data-owner-chip]');
      if (ownerChips.length) action.owners = Array.from(ownerChips).map(function (chip) { return chip.dataset.owner; }).filter(Boolean);
      var kind = row.querySelector('[data-timing-kind]');
      var wording = row.querySelector('[data-timing-wording]');
      var date = row.querySelector('[data-timing-date]');
      if (kind) action.timing = editedTiming(action, kind.value, wording ? wording.value.trim() : '', date);
      if (before !== actionEditFingerprint(action)) action.reviewerAuthored = true;
    });
    return state.draft.actions;
  }

  function rememberPendingActions() {
    if (!state.draft) return;
    (state.draft.actions || []).forEach(function (action) {
      if (/^manual-action-/.test(String(action.id || '')) && !String(action.action || '').trim()) {
        actionEditorState.pendingRows[actionOccurrence(action)] = JSON.parse(JSON.stringify(action));
      } else if (actionOccurrence(action)) delete actionEditorState.pendingRows[actionOccurrence(action)];
    });
  }

  function linkedReviewFlagIds(value) {
    if (!value || typeof value !== 'object') return [];
    var own = Array.isArray(value.reviewFlagIds) ? value.reviewFlagIds : [];
    var nested = Array.isArray(value) ? value : Object.keys(value).map(function (key) { return value[key]; });
    return own.concat(nested.flatMap(linkedReviewFlagIds));
  }

  var ITEM_REMOVED_NOTE = 'The item was removed.';

  function sharedEvidenceCount(left, right) {
    var wanted = new Set(left || []);
    return (right || []).filter(function (id) { return wanted.has(id); }).length;
  }

  // Some older and recovered drafts contain a useful warning and a correctly
  // evidenced Action, but not the reviewFlagIds link between them. Recover the
  // link conservatively from the warning type, evidence and quoted wording so
  // the reviewer is never left with a warning that leads nowhere.
  function inferredActionForFlag(flag) {
    if (!flag || !['ownership', 'timing', 'possible_missed_follow_up'].includes(flag.kind)) return null;
    if (flag.temporalField) return null;
    var message = String(flag.message || '').toLowerCase();
    var ranked = ((state.draft && state.draft.actions) || []).map(function (action, index) {
      var timing = action.timing || {};
      var score = sharedEvidenceCount(flag.evidenceIds, action.evidenceIds) * 4;
      var field = flag.kind === 'timing' ? 'timing' : flag.kind === 'ownership' ? 'owners' : 'action';
      if (timing.wording && message.includes(String(timing.wording).toLowerCase())) score += 8;
      if (timing.exactDate && message.includes(String(timing.exactDate).toLowerCase())) score += 8;
      if ((action.owners || []).some(function (owner) { return message.includes(String(owner).toLowerCase()); })) score += 5;
      var actionWords = String(action.action || '').toLowerCase().split(/\s+/).filter(function (word) { return word.length > 4; });
      score += Math.min(4, actionWords.filter(function (word) { return message.includes(word); }).length);
      return { action: action, index: index, score: score, field: field };
    }).filter(function (candidate) { return candidate.score >= 4; }).sort(function (left, right) { return right.score - left.score; });
    if (!ranked.length || (ranked[1] && ranked[1].score === ranked[0].score)) return null;
    return ranked[0];
  }

  function proposalChangeForFlag(flag) {
    var proposal = state.draft && state.draft.pendingProposal;
    var changes = proposal && Array.isArray(proposal.changes) ? proposal.changes : [];
    if (!flag || !changes.length) return null;
    var exact = changes.find(function (change) { return String(flag.id || '') === 'proposal-review-' + change.id; });
    if (exact) return exact;
    if (flag.kind !== 'possible_missed_follow_up') return null;
    var message = String(flag.message || '').toLowerCase();
    var candidates = changes.filter(function (change) {
      var record = change.after || change.before || {};
      var recordText = String(record.action || record.text || record.topic || '').toLowerCase();
      return sharedEvidenceCount(flag.evidenceIds, record.evidenceIds) > 0
        && (!recordText || message.includes(recordText.slice(0, 80)));
    });
    return candidates.length === 1 ? candidates[0] : null;
  }

  function proposalDomId(change) {
    return recordDomId('proposal', change && change.id, 'change');
  }

  function resolveDeletedTargetFlags(flagIds) {
    if (!state.draft || !flagIds || !flagIds.length) return;
    var stillLinked = new Set(linkedReviewFlagIds([
      state.draft.discussion || [], state.draft.actions || []
    ]));
    var removed = new Set(flagIds);
    state.draft.reviewFlags = (state.draft.reviewFlags || []).map(function (flag) {
      if (!removed.has(flag.id) || stillLinked.has(flag.id)) return flag;
      // Marked so the server can tell it from a reviewer's own dismissal and
      // reopen it if the same item is added again.
      return Object.assign({}, flag, { status: 'dismissed', correctionNote: ITEM_REMOVED_NOTE });
    });
  }

  function restorePendingActions(draft) {
    var actions = Array.isArray(draft.actions) ? draft.actions : [];
    Object.keys(actionEditorState.pendingRows).forEach(function (id) {
      if (!actions.some(function (action) { return actionOccurrence(action) === id; })) actions.push(actionEditorState.pendingRows[id]);
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
    action.reviewerAuthored = true;
    return true;
  }

  function flagTarget(flag) {
    var flagId = String(flag && flag.id || '');
    if (!flagId || !state.draft) return null;
    if (flag.temporalField === 'executiveSummary') return {
      stage: 4, elementId: 'executiveSummary', label: 'Executive summary',
      text: state.draft.executiveSummary || '', field: 'summary'
    };
    if (flag.temporalField === 'meetingObjectives') return {
      stage: 4, elementId: 'objectivesList', label: 'Meeting objectives',
      text: (state.draft.meetingObjectives || []).map(function (item) { return typeof item === 'string' ? item : item.text || ''; }).join('; '),
      field: 'text'
    };
    if (flag.temporalField === 'timedStepCoverage') return null;
    if (flagId === 'meeting-date-source-check') return {
      stage: 0, elementId: 'meetingDate', label: 'Meeting date',
      text: (state.draft.details || {}).meetingDate || 'Not stated', field: 'meetingDate'
    };
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
            text: item.text || '',
            field: 'text'
          };
        }
      }
    }
    // A flag can belong to a line in supporting context.
    for (var ti = 0; ti < (state.draft.discussion || []).length; ti += 1) {
      var ctxTopic = state.draft.discussion[ti];
      for (var fi = 0; fi < 3; fi += 1) {
        var ctxField = ['points', 'decisions', 'openQuestions'][fi];
        for (var ii = 0; ii < (ctxTopic[ctxField] || []).length; ii += 1) {
          var parentItem = ctxTopic[ctxField][ii];
          for (var di = 0; di < (parentItem.supportingDetails || []).length; di += 1) {
            var detail = parentItem.supportingDetails[di];
            if ((detail.reviewFlagIds || []).indexOf(flagId) >= 0) return {
              stage: 2,
              elementId: recordDomId('supporting', detail.id, ti + '-' + ctxField + '-' + ii + '-' + di),
              label: 'Supporting context', retained: true,
              text: detail.text || '',
              field: 'text'
            };
          }
        }
      }
    }
    var unfiledTargets = (state.draft.unassignedSupportingDetails || []).map(function (detail, index) {
      return { detail: detail, index: index };
    }).filter(function (entry) { return (entry.detail.reviewFlagIds || []).indexOf(flagId) >= 0; });
    if (unfiledTargets.length > 1) return { ambiguous: true, retained: true, label: 'Several retained details',
      text: unfiledTargets.map(function (entry) { return entry.detail.text || ''; }).join('; ') };
    if (unfiledTargets.length === 1) {
      var unfiled = unfiledTargets[0];
      return { stage: 2, elementId: recordDomId('unassigned-supporting',
        (unfiled.detail.id || ('unassigned-' + unfiled.index)) + '-' + unfiled.index, unfiled.index),
        label: 'Retained detail', retained: true, text: unfiled.detail.text || '', field: 'text' };
    }
    var excludedTargets = (state.draft.excludedSupportingDetails || []).filter(function (entry) { return (entry.record.reviewFlagIds || []).indexOf(flagId) >= 0; });
    if (excludedTargets.length === 1) return { stage:2,retained:true,elementId:'minutes-excluded-' + excludedTargets[0].key,
      label:'Detail left out by reviewer',text:excludedTargets[0].record.text,field:'text' };
    if (excludedTargets.length > 1) return { ambiguous:true,retained:true,label:'Several left-out details',text:excludedTargets.map(function (entry) { return entry.record.text; }).join('; ') };
    var linkedActions = (state.draft.actions || []).map(function (action, index) {
      return { action: action, index: index };
    }).filter(function (entry) { return (entry.action.reviewFlagIds || []).indexOf(flagId) >= 0; });
    // A shared warning is not evidence that the first linked row is its target.
    if (linkedActions.length > 1) return {
      ambiguous: true, label: 'Several actions',
      text: linkedActions.map(function (entry) { return entry.action.action || ''; }).join('\n')
    };
    if (linkedActions.length === 1) {
      var action = linkedActions[0].action;
      var actionIndex = linkedActions[0].index;
      return {
        stage: 3,
        elementId: actionDomId(action, actionIndex),
        label: 'Action',
        text: action.action || '',
        field: flag.kind === 'timing' ? 'timing' : flag.kind === 'ownership' ? 'owners' : 'action'
      };
    }
    // A missed-content warning can describe an Action that deliberately has
    // not entered the register yet. Route it to the generated-change record instead of
    // pretending there ought to be a current Action to edit.
    var proposed = proposalChangeForFlag(flag);
    if (proposed) {
      var proposedRecord = proposed.after || proposed.before || {};
      return {
        elementId: proposalDomId(proposed),
        label: proposed.after ? 'Proposed item' : 'Removal',
        text: proposedRecord.action || proposedRecord.text || proposedRecord.topic || '',
        field: 'proposal',
        proposal: true
      };
    }
    // Missing-work/coverage notices are not field errors on an existing row.
    // Shared evidence alone must not manufacture a published-action link.
    if (flag.kind === 'possible_missed_follow_up') return null;
    var inferred = inferredActionForFlag(flag);
    if (inferred) return {
      stage: 3,
      elementId: actionDomId(inferred.action, inferred.index),
      label: inferred.field === 'timing' ? 'Action timing' : inferred.field === 'owners' ? 'Action owner' : 'Action',
      text: inferred.action.action || '',
      field: inferred.field,
      inferred: true
    };
    return null;
  }

  function flagsTargetingAction(action, index) {
    var elementId = actionDomId(action, index);
    return ((state.draft && state.draft.reviewFlags) || []).filter(function (flag) {
      var target = flagTarget(flag);
      return target && target.elementId === elementId;
    }).map(function (flag) { return flag.id; });
  }

  function reviewFlagCategory(flag, target) {
    if (['not_applied_noop','not_applied_duplicate','not_outstanding'].indexOf(flag.reviewDisposition) >= 0 && !flag.reviewerAuthored && !flag.correctionNote) return 'optional';
    if (target && !target.retained && !target.proposal) return 'corrections';
    if (flag.reviewDisposition === 'coverage_unresolved' || /^action-materialization-/.test(String(flag.id || '')) || flag.temporalField === 'timedStepCoverage') return 'coverage';
    if (target && (target.retained || target.proposal) || flag.kind === 'possible_missed_follow_up') return 'optional';
    return 'corrections';
  }

  function reviewQueueCounts() {
    var counts = {flags:0,total:0,primary:0,optional:0,coverage:0,items:0};
    ((state.draft && state.draft.reviewFlags) || []).forEach(function (flag) {
      if (flag.status !== 'open' || proposalChangeForFlag(flag)) return;
      counts.flags++;var kind = reviewFlagCategory(flag,flagTarget(flag));
      if (kind === 'corrections') counts.primary++;else counts[kind]++;
    });
    counts.total = counts.flags;
    counts.items = document.querySelectorAll('#flagList [data-review-category="corrections"] [data-review-occurrence]').length || counts.primary;
    return counts;
  }

  function updateReviewQueueSummary() {
    var counts = reviewQueueCounts();
    var panel = document.getElementById('reviewFlags');
    panel.hidden = counts.total === 0;
    var other = counts.optional + counts.coverage;
    document.getElementById('flagCount').textContent = counts.primary
      ? (other ? counts.items + ' item' + (counts.items === 1 ? '' : 's') + ' to check · ' + other + ' other check' + (other === 1 ? '' : 's')
        : counts.items === counts.flags ? counts.flags + ' check' + (counts.flags === 1 ? '' : 's') : counts.items + ' item' + (counts.items === 1 ? '' : 's') + ' · ' + counts.flags + ' checks')
      : counts.coverage ? counts.coverage + ' coverage notice' + (counts.coverage === 1 ? '' : 's') + (counts.optional ? ' · ' + counts.optional + ' optional' : '')
        : counts.optional ? counts.optional + ' optional check' + (counts.optional === 1 ? '' : 's') : 'Review complete';
    document.getElementById('reviewQueueToggle').title = counts.flags + ' total checks. ' + counts.primary + ' concern possible corrections; ' + counts.optional + ' concern optional material; ' + counts.coverage + ' concern coverage.';
    updateReviewQueueToggle(counts);
    if (inDocumentMode()) {
      // One answer to "am I done?": model checks, missing owners and dates,
      // and empty required details, added up.
      var open = openCheckItems();
      var pill = document.getElementById('reviewQueueToggle');
      document.getElementById('flagCount').textContent = open.total ? open.total + ' to check' : 'All checked';
      pill.hidden = false;
      pill.dataset.state = open.total ? 'warning' : 'done';
      pill.title = open.total ? checksSummaryText(open) : 'Nothing left to check.';
      pill.setAttribute('aria-expanded', String(checksDrawerOpen()));
      if (checksDrawerOpen()) refreshChecksDrawer();
    }
    var intro = document.getElementById('reviewQueueIntro');
    if (intro) {
      intro.hidden = !counts.flags;
      intro.textContent = 'Start with checks on the current minutes. Possible additions and processing notices are separate below. Each check keeps its own source, note and decision.';
    }
    updateFinishingBar();
  }

  // The review queue opens from the status bar rather than from a chip of its
  // own: the chip used to hold a whole row by itself, because the strip it was
  // meant to sit beside is fixed to the bottom of the screen.
  function updateReviewQueueToggle(counts) {
    var toggle = document.getElementById('reviewQueueToggle');
    var panel = document.getElementById('reviewFlags');
    if (!toggle || !panel) return;
    var open = Boolean(panel.open && !panel.hidden);
    toggle.hidden = counts.total === 0;
    toggle.dataset.state = counts.primary || counts.coverage ? 'warning' : 'clear';
    toggle.setAttribute('aria-expanded', String(open));
    var row = panel.closest('.workflow-utilities');
    if (row) row.classList.toggle('is-open', open);
  }

  function reviewCandidateForFlag(flag, target) {
    if (target && target.text) return target.text;
    var cited = evidenceContext(flag && flag.evidenceIds).filter(function (unit) { return unit.cited; });
    return cited.map(function (unit) { return unit.text || ''; }).filter(Boolean).join(' ').slice(0, 800);
  }

  function conciseReviewMessage(message) {
    var value = String(message || 'Review this item against the transcript.').trim();
    var withoutQuotedPassage = value.replace(/[:\s]*[“"][\s\S]*$/, '').trim();
    if (withoutQuotedPassage && withoutQuotedPassage !== value) {
      return /[.!?]$/.test(withoutQuotedPassage) ? withoutQuotedPassage : withoutQuotedPassage + '.';
    }
    return value;
  }

  function reviewMessageAddsDetail(message, label) {
    var normalise = function (value) {
      return String(value || '').trim().toLowerCase().replace(/[.!?]+$/, '').trim();
    };
    var detail = normalise(message);
    var kind = normalise(label);
    if (!detail || detail === kind) return false;
    return ['cannot verify', 'unable to verify', 'not verified', 'review this item against the transcript', 'check against the transcript'].indexOf(detail) === -1;
  }

  function identicalReviewKey(flag) {
    if (!flag || flag.status !== 'open' || flag.reviewerAuthored || flag.correctionNote) return '';
    function stable(value) { return Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
      ? Object.keys(value).sort().reduce(function (out, key) { out[key] = stable(value[key]); return out; }, {}) : value; }
    var copy = Object.assign({}, flag); delete copy.id;
    return JSON.stringify(stable(copy));
  }

  function reviewTargetKey(flag) {
    var links = 0;
    function visit(record) { if ((record.reviewFlagIds || []).indexOf(flag.id) >= 0) links++; (record.supportingDetails || []).forEach(visit); }
    (state.draft.actions || []).forEach(visit); (state.draft.unassignedSupportingDetails || []).forEach(visit);
    (state.draft.excludedSupportingDetails || []).forEach(function (entry) { visit(entry.record); });
    (state.draft.discussion || []).forEach(function (topic) { ['points','decisions','openQuestions'].forEach(function (field) { (topic[field] || []).forEach(visit); }); });
    if (links !== 1) return '';
    var target = flagTarget(flag);
    if (!target || target.ambiguous || !target.elementId || Array.from(document.querySelectorAll('[id]')).filter(function (node) { return node.id === target.elementId; }).length !== 1) return '';
    return [target.stage, target.elementId, target.field].join('|');
  }

  function coverageComparisonHtml(flag) {
    if (reviewFlagCategory(flag, null) !== 'coverage') return '';
    var sourceCounts = new Map();
    sourceUnits().forEach(function (unit) { sourceCounts.set(unit.id, (sourceCounts.get(unit.id) || 0) + 1); });
    var ids = new Set((flag.evidenceIds || []).filter(function (id) { return sourceCounts.get(id) === 1; }));
    var domCounts = new Map();
    document.querySelectorAll('[id]').forEach(function (node) { domCounts.set(node.id, (domCounts.get(node.id) || 0) + 1); });
    var related = ((state.draft && state.draft.actions) || []).map(function (action, index) {
      return { action: action, elementId: actionDomId(action, index) };
    }).filter(function (item) {
      return item.action.action && domCounts.get(item.elementId) === 1
        && (item.action.evidenceIds || []).some(function (id) { return ids.has(id); });
    });
    if (!related.length) return '';
    return '<details class="flag-review-reason" data-coverage-related-actions><summary>Drafted actions sharing source lines (' + related.length + ')</summary>'
      + '<p>These source links are for comparison. They do not establish that the work is covered.</p><ul>'
      + related.map(function (item) {
        return '<li><button class="secondary compact" type="button" data-view-coverage-action="' + escapeHtml(item.elementId)
          + '" data-target-step="3" data-target-selector=":scope">' + escapeHtml(item.action.action) + '</button></li>';
      }).join('') + '</ul></details>';
  }

  function renderFlags() {
    var flags = (state.draft && state.draft.reviewFlags) || [];
    var open = flags.filter(function (flag) { return flag.status === 'open' && !proposalChangeForFlag(flag); });
    var panel = document.getElementById('reviewFlags');
    var wasHidden = panel.hidden;
    if (open.length && wasHidden) panel.open = false;
    function renderCheck(flag, index, showTarget, sharedSource) {
      if (flag.status !== 'open') return '';
      if (proposalChangeForFlag(flag)) return '';
      var label = reviewFlagLabel(flag);
      var target = flagTarget(flag);
      var uncertainCoverage = !target && reviewFlagCategory(flag, target) === 'coverage';
      var displayMessage = target && target.proposal
        ? 'The agent found a possible addition that is not in the minutes yet.'
        : reviewFlagDisplayMessage(flag, target);
      var candidateText = reviewCandidateForFlag(flag, target);
      var candidateLabel = target
        ? (target.proposal ? 'Proposed minutes text' : (target.retained ? 'Not in the main minutes · ' : 'In the minutes · ') + target.label)
        : uncertainCoverage ? 'Passage with unverified action coverage' : 'Transcript detail to consider';
      var body = '';
      if (candidateText && showTarget) {
        body += '<div class="flag-target' + (!target ? ' transcript-candidate' : '') + '"><span>' + escapeHtml(candidateLabel) + '</span><blockquote>' + escapeHtml(candidateText) + '</blockquote>';
      }
      if (target && !target.ambiguous && showTarget) {
        var selector = target.field === 'timing' ? '[data-edit-timing]' : target.field === 'owners' ? '[data-edit-owners]' : target.field === 'proposal' ? 'summary' : 'textarea,input';
        var stepAttribute = target.stage == null ? '' : ' data-target-step="' + target.stage + '"';
        body += (candidateText ? '' : '<div class="flag-target"><span>' + escapeHtml(candidateLabel) + '</span>')
          + '<button class="secondary compact" data-view-flag-target="' + escapeHtml(target.elementId) + '" data-target-selector="' + escapeHtml(selector) + '"' + stepAttribute + ' type="button">' + (target.retained ? 'Open retained detail' : inDocumentMode() ? 'Show in document' : 'Open in minutes') + '</button></div>';
      } else if (showTarget && target && target.ambiguous) {
        body += '<p>' + (target.retained ? 'This check is linked to several retained details. Review those entries before including them.' : 'This check is linked to several actions. Review those rows directly.') + '</p></div>';
      } else if (showTarget && candidateText) {
        body += uncertainCoverage
          ? '<p>Coverage is uncertain. Check the source before deciding whether anything needs adding.</p></div>'
          : '<p>This is not currently represented in the minutes. Add or correct the relevant item if it belongs.</p></div>';
      } else if (showTarget) {
        body += uncertainCoverage
          ? '<div class="review-route-missing"><span>Coverage is uncertain. Check the source before deciding whether anything needs adding.</span></div>'
          : '<div class="review-route-missing"><span>Nothing in the current minutes is linked to this check. Add or correct the relevant item if it belongs.</span></div>';
      }
      if (showTarget && uncertainCoverage) body += coverageComparisonHtml(flag);
      var reviewMessage = earlierActionWordingForFlag(flag, target)
        ? displayMessage : conciseReviewMessage(displayMessage);
      body += reviewMessageAddsDetail(reviewMessage, label)
        ? '<details class="flag-review-reason"><summary><span>Why this was highlighted</span><span class="flag-kind">' + escapeHtml(label) + '</span></summary><div class="flag-message">' + escapeHtml(reviewMessage) + '</div></details>'
        : '<div class="flag-review-summary"><span class="flag-kind">' + escapeHtml(label) + '</span></div>';
      var actions = '';
      // A linked proposal has its own add/leave-out decision. Showing warning
      // controls here as well made it look as though "checked" would add it.
      if (!target || !target.proposal) {
        body += '<details class="review-note"><summary>Add a note</summary><div><input data-flag-correction="' + index + '" value="' + escapeHtml(flag.correctionNote || '') + '" placeholder="What did you check or change?" aria-label="Review note"><button class="secondary" data-flag-index="' + index + '" data-flag-status="corrected" type="button">Save note &amp; mark checked</button></div></details>';
        actions = '<button class="button" data-flag-index="' + index + '" data-flag-status="confirmed" type="button">Mark checked</button><button class="secondary" data-flag-index="' + index + '" data-flag-status="dismissed" type="button">Does not belong in minutes</button>';
      }
      // Collapsed by default: the passage is often longer than the warning it
      // supports, and a reviewer who trusts the quoted line never opens it.
      var evidenceLines = evidenceContext(flag.evidenceIds).length;
      var evidence = '<details class="review-evidence" data-keep-open="' + escapeHtml(disclosureKey(flag.evidenceIds, 'flag-' + flag.id)) + '"><summary class="review-evidence-head"><strong>Source passage</strong><span class="muted">'
        + (evidenceLines ? evidenceLines + ' line' + (evidenceLines === 1 ? '' : 's') : 'none linked')
        + '</span></summary><div class="review-evidence-body">' + evidenceHtml(flag.evidenceIds) + '</div></details>';
      return '<div class="flag review-queue-item" data-review-flag-id="' + escapeHtml(flag.id) + '"><div class="review-item-layout' + (sharedSource ? ' shared-source-check' : '') + '"><div class="review-item-main">' + body + (actions ? '<div class="flag-actions">' + actions + '</div>' : '') + '</div>' + (sharedSource ? '' : evidence) + '</div></div>';
    }
    var groups = new Map(), categories = { corrections: [], optional: [], coverage: [] }, targetCounts = new Map();
    document.querySelectorAll('[id]').forEach(function (node) { targetCounts.set(node.id, (targetCounts.get(node.id) || 0) + 1); });
    var sourceCounts = new Map(), flagCounts = new Map();
    sourceUnits().forEach(function (unit) { sourceCounts.set(unit.id, (sourceCounts.get(unit.id) || 0) + 1); });
    flags.forEach(function (flag) { flagCounts.set(flag.id, (flagCounts.get(flag.id) || 0) + 1); });
    function uniformSourceKey(flag, target, category) {
      var unambiguousTarget = target && !target.ambiguous && target.elementId
        && targetCounts.get(target.elementId) === 1;
      var optionalUntargetedCheck = !target && category === 'optional'
        && flag.kind === 'possible_missed_follow_up'
        && flag.reviewDisposition === 'not_applied_addition'
        && !flag.temporalField;
      if ((!unambiguousTarget && !optionalUntargetedCheck)
        || flag.reviewerAuthored || flag.correctionNote || !flag.id || flagCounts.get(flag.id) !== 1) return '';
      var ids = flag.evidenceIds;
      if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length
        || ids.some(function (id) { return typeof id !== 'string' || sourceCounts.get(id) !== 1; })) return '';
      return JSON.stringify(ids.slice().sort());
    }
    flags.forEach(function (flag, index) {
      if (flag.status !== 'open' || proposalChangeForFlag(flag)) return;
      var target = flagTarget(flag), category = reviewFlagCategory(flag, target);
      var sharedSourceKey = uniformSourceKey(flag, target, category);
      // A unique DOM occurrence is a presentation key, never a merge proof.
      // Shared source text is presentation only. Every check keeps its own
      // explanation, note and decision; ambiguous targets stay separate.
      var key = sharedSourceKey
        ? (target ? category + '|' + target.stage + '|' + target.elementId + '|' + target.field + '|uniform-source|' + sharedSourceKey : 'optional-source|' + sharedSourceKey)
        : target && !target.ambiguous && target.elementId && targetCounts.get(target.elementId) === 1
        ? category + '|' + target.stage + '|' + target.elementId + '|' + target.field
        : 'flag|' + index;
      var group = groups.get(key);
      if (!group) { group = { category: category, entries: [], sharedSource: Boolean(sharedSourceKey), sharedOptionalSource: Boolean(sharedSourceKey && !target) }; groups.set(key, group); categories[category].push(group); }
      group.entries.push({ flag: flag, index: index });
    });
    function renderGroup(group) {
      var sharedSource = group.sharedSource && group.entries.length > 1;
      var bundles = [], byKey = new Map();
      group.entries.forEach(function (entry) {
        var targetKey = reviewTargetKey(entry.flag), key = targetKey && identicalReviewKey(entry.flag);
        key = key ? targetKey + '|' + key : 'individual|' + entry.index;
        var bundle = byKey.get(key);
        if (!bundle) { bundle = []; byKey.set(key, bundle); bundles.push(bundle); }
        bundle.push(entry);
      });
      var first = true;
      return '<section class="review-occurrence" data-review-occurrence' + (sharedSource ? ' data-shared-source' : '') + (sharedSource && group.sharedOptionalSource ? ' data-shared-optional-source' : '') + '><div class="review-occurrence-checks">'
        + (group.entries.length > 1 ? '<p class="muted">' + group.entries.length + (sharedSource ? ' independent checks share this source passage. Decide each separately.</p>' : ' checks for this item — each keeps its own decision.</p>') : '')
        + bundles.map(function (bundle) {
          var entry = bundle[0], html = renderCheck(entry.flag, entry.index, first, sharedSource); first = false;
          if (bundle.length === 1) return html;
          return html + '<div class="flag-actions"><button class="secondary" type="button" data-confirm-identical-flags="' + escapeHtml(JSON.stringify(bundle.map(function (entry) { return entry.flag.id; })))
            + '" data-identical-review-key="' + escapeHtml(identicalReviewKey(entry.flag)) + '" data-identical-review-target="' + escapeHtml(reviewTargetKey(entry.flag)) + '">Mark all ' + bundle.length + ' identical checks as checked</button></div>'
            + '<details class="review-evidence" data-identical-review-copies data-keep-open="identical-checks:' + escapeHtml(entry.flag.id) + '"><summary>' + bundle.length + ' identical checks for this item — individual controls</summary>'
            + bundle.slice(1).map(function (copy) { return renderCheck(copy.flag, copy.index, false); }).join('') + '</details>';
        }).join('') + (sharedSource
          ? '<details class="review-evidence" data-shared-source-evidence data-keep-open="' + escapeHtml(disclosureKey(group.entries[0].flag.evidenceIds, 'shared-optional-source')) + '"><summary class="review-evidence-head"><strong>Shared source passage</strong></summary><div class="review-evidence-body">' + evidenceHtml(group.entries[0].flag.evidenceIds) + '</div></details>'
          : '') + '</div></section>';
    }
    function section(kind, heading, description, optional) {
      var rows = categories[kind]; if (!rows.length) return '';
      var count = rows.reduce(function (n, row) { return n + row.entries.length; }, 0);
      var itemCount = rows.reduce(function (n, row) { return n + (row.sharedSource ? row.entries.length : 1); }, 0);
      var title = heading + ' (' + itemCount + ' item' + (itemCount === 1 ? '' : 's') + ', ' + count + ' check' + (count === 1 ? '' : 's') + ')';
      var body = '<p class="muted">' + escapeHtml(description) + '</p>' + rows.map(renderGroup).join('');
      return optional ? '<details class="review-category" data-review-category="' + kind + '" data-keep-open="review-category:' + kind + '"><summary>' + escapeHtml(title) + '</summary>' + body + '</details>'
        : '<section class="review-category" data-review-category="' + kind + '"><h3>' + escapeHtml(title) + '</h3>' + body + '</section>';
    }
    document.getElementById('flagList').innerHTML = section('corrections', 'Check the current minutes', 'Check these possible problems against their sources. Unlinked checks keep their source passages below.', false)
      + section('optional', 'Possible additions and retained material', 'These items are not included in the main minutes. Review them if you want to add or change something; leaving an item here does not add it.', true)
      + section('coverage', 'Processing and coverage notices', 'The agent could not establish complete coverage for these passages. These notices do not prove that an action is missing. Sources and individual checks remain available.', true);
    restoreDisclosures(document.getElementById('flagList'));
    refreshRetainedWarningNotices();
    updateReviewQueueSummary();
  }

  function formatUkDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return value || '';
    return window.MeetingMinutesTiming.formatCalendarDate(value) || '';
  }

  function timingText(timing) {
    return window.MeetingMinutesTiming.formatTimingLabel(timing || {}, { emptyLabel: 'No date agreed' });
  }

  function timingDisplayText(timing) {
    return timingText(timing);
  }

  function finalEditMatches(kind, id, field) {
    return activeFinalEdit && activeFinalEdit.kind === kind && String(activeFinalEdit.id || '') === String(id || '') && activeFinalEdit.field === field;
  }

  function finalTextEditor(kind, id, field, value, options) {
    options = options || {};
    if (!finalEditMatches(kind, id, field) || options.deferred) {
      var displayValue = options.displayValue == null ? value : options.displayValue;
      var actionIndex = kind === 'action' ? actionIndexForOccurrence(id) : -1;
      var recordId = actionIndex >= 0 ? state.draft.actions[actionIndex].id : id;
      var occurrenceAttribute = kind === 'action' ? ' data-action-occurrence-id="' + escapeHtml(id) + '"' : '';
      var edited = editedFields().indexOf(fieldEditKey(kind, id, field)) >= 0;
      var flagged = inDocumentMode() && field !== 'owners' && field !== 'timing' && docFlaggedKeys.has(kind + '|' + id);
      var hint = flagged ? 'Flagged for a check' + (edited ? ' · Edited by you' : '') : edited ? 'Edited by you' : 'Click to edit';
      return '<button class="final-editable' + (options.block ? ' block' : '') + (edited ? ' user-edited' : '') + (flagged ? ' model-flagged' : '') + (displayValue ? '' : ' is-empty') + '" data-final-edit data-kind="' + escapeHtml(kind) + '" data-record-id="' + escapeHtml(recordId || '') + '"' + occurrenceAttribute + ' data-field="' + escapeHtml(field) + '" type="button" title="' + hint + '">' + escapeHtml(displayValue || options.empty || 'Not stated') + '</button>';
    }
    var control = options.singleLine
      ? '<input data-final-editor-value value="' + escapeHtml(value || '') + '"' + (options.inputType ? ' type="' + options.inputType + '"' : '') + ' aria-label="' + escapeHtml(options.label || 'Edit value') + '">'
      : '<textarea data-final-editor-value rows="' + (options.rows || 2) + '" aria-label="' + escapeHtml(options.label || 'Edit text') + '">' + escapeHtml(value || '') + '</textarea>';
    return '<span class="final-inline-editor' + (options.block ? ' block' : '') + '" data-final-editor data-original="' + escapeHtml(value || '') + '">' + control + finalEditButtons() + '</span>';
  }

  function finalTimingDisplay(action) {
    return '<button class="final-editable final-editable-cell" data-final-edit data-kind="action" data-record-id="' + escapeHtml(action.id) + '" data-action-occurrence-id="' + escapeHtml(actionOccurrence(action)) + '" data-field="timing" type="button" title="Click to edit timing">' + escapeHtml(timingText(action.timing || {})) + '</button>';
  }

  function finalEditButtons() {
    return '<span class="final-edit-actions"><button class="quiet" data-final-cancel type="button">Cancel</button><button class="secondary" data-final-save type="button">Save</button></span>';
  }

  // The editor for an action's field, laid out in a row of its own under the
  // action. The cells are too narrow to type in: the timing editor squeezed
  // into the Timing cell showed "Ta", "straig" and "dc".
  function finalActionEditorRow(action, field) {
    var editorLabel = field === 'owners' ? 'Edit action owners' : field === 'timing' ? 'Edit action timing' : 'Edit action wording';
    var editorAttributes = ' data-final-editor role="group" aria-label="' + escapeHtml(editorLabel) + '"';
    var body;
    if (field === 'timing') {
      var timing = action.timing || {};
      var statedOption = isParallelDraft() ? '<option value="stated"' + (timing.kind === 'stated' ? ' selected' : '') + '>As stated</option>' : '';
      body = '<span class="final-inline-editor timing"' + editorAttributes + '>'
        + '<label><span class="lbl">Type</span><select data-final-timing-kind aria-label="Timing type"><option value="not_stated"' + (timing.kind === 'not_stated' ? ' selected' : '') + '>Not stated</option><option value="target"' + (timing.kind === 'target' ? ' selected' : '') + '>Target</option><option value="deadline"' + (timing.kind === 'deadline' ? ' selected' : '') + '>Deadline</option><option value="dependency"' + (timing.kind === 'dependency' ? ' selected' : '') + '>Dependency</option>' + statedOption + '</select></label>'
        + '<label><span class="lbl">As said in the meeting</span><input data-final-timing-wording value="' + escapeHtml(timing.wording || '') + '" placeholder="e.g. by Friday, once the report is back" aria-label="Timing as said"></label>'
        + '<label><span class="lbl">Exact date (optional)</span><input data-final-timing-date type="date" data-initial-date="' + escapeHtml(timing.exactDate || '') + '" value="' + escapeHtml(timing.exactDate || '') + '" aria-label="Exact date"></label>'
        + finalEditButtons() + '</span>';
    } else if (field === 'owners') {
      var selectedOwners = Array.isArray(activeFinalEdit && activeFinalEdit.ownerSelection)
        ? activeFinalEdit.ownerSelection : (action.owners || []);
      var selectedKeys = selectedOwners.map(function (owner) { return String(owner).toLowerCase(); });
      var ownerChips = selectedOwners.map(function (owner) {
        return '<span class="owner-chip">' + escapeHtml(owner)
          + '<button type="button" data-final-remove-owner="' + escapeHtml(owner) + '" aria-label="Remove owner ' + escapeHtml(owner) + '">&times;</button></span>';
      }).join('') || '<span class="muted">No owner selected</span>';
      var availableOwners = participantNames().filter(function (name) {
        return selectedKeys.indexOf(name.toLowerCase()) < 0;
      });
      var ownerOptions = (availableOwners.length ? '<option value="__all">All participants</option>' : '')
        + availableOwners.map(function (name) {
        return '<option value="' + escapeHtml(name) + '">' + escapeHtml(name) + '</option>';
      }).join('');
      body = '<span class="final-inline-editor"' + editorAttributes + '>'
        + '<div class="final-owner-picker"><span class="lbl">Owners</span><div class="owner-chips">' + ownerChips + '</div>'
        + '<label><span class="visually-hidden">Add an attendee as owner</span><select data-final-add-owner aria-label="Add an attendee as owner"><option value="">Choose a participant...</option>' + ownerOptions + '</select></label></div>'
        + finalEditButtons() + '</span>';
    } else {
      body = '<span class="final-inline-editor"' + editorAttributes + '>'
        + '<textarea data-final-editor-value rows="3" aria-label="Edit action">' + escapeHtml(action.action || '') + '</textarea>'
        + finalEditButtons() + '</span>';
    }
    return '<tr class="final-editor-row"><td colspan="' + (inDocumentMode() ? 4 : 3) + '">' + body + '</td></tr>';
  }

  // A meeting nobody from the client side attended is an internal meeting, not
  // one with an empty guest list, so the row is left out rather than shown as
  // "Not stated".
  function finalAttendeesHtml(details) {
    var rows = ['<strong>Internal attendees:</strong> '
      + escapeHtml((details.internalAttendees || []).join(', ') || 'Not stated')];
    var client = (details.clientAttendees || []).filter(function (name) { return String(name || '').trim(); });
    if (client.length) {
      rows.push('<strong>' + escapeHtml(details.clientAttendeeLabel === 'External' ? 'External' : 'Client')
        + ' attendees:</strong> ' + escapeHtml(client.join(', ')));
    }
    return '<p>' + rows.join('<br>') + '</p>';
  }

  function renderFinal() {
    var draft = state.draft || {}; var details = draft.details || {};
    var include = includedSectionState();
    var docMode = inDocumentMode();
    docFlaggedKeys = docMode ? computeDocFlaggedKeys() : new Set();
    var objectives = include.meetingObjectives ? (draft.meetingObjectives || []).map(function(item,index){return typeof item === 'string' ? {id:'objective-'+index,text:item} : item;}).filter(function(item){return item && (item.text || finalEditMatches('objective', item.id, 'text'));}) : [];
    var addObjective = docMode ? '<button class="quiet doc-add doc-only" data-doc-add-objective type="button">Add objective</button>' : '';
    var summaryHtml = (objectives.length || (docMode && include.meetingObjectives) ? '<section><h3>Meeting objectives</h3>' + (objectives.length ? '<ul class="final-objectives">' + objectives.map(function (item) { return '<li>' + finalTextEditor('objective', item.id, 'text', item.text, {singleLine:docMode,label:'Edit meeting objective',empty:'New objective'}) + '</li>'; }).join('') + '</ul>' : '') + addObjective + '</section>' : '')
      + (include.executiveSummary && draft.executiveSummary ? '<section>' + sectionHeading('Executive summary', 'summary', summaryTranscriptItem()) + staleLinkHtml('summary') + finalTextEditor('summary', 'executive-summary', 'text', draft.executiveSummary, {block:true,rows:3,label:'Edit executive summary'}) + '</section>' : '');
    var topicCount = (draft.discussion || []).length;
    var finalDiscussion = (draft.discussion || []).map(function (topic, topicIndex) {
      var topicId = topic.id || 'topic-' + topicIndex;
      var rows = [{key:'points',label:'',noun:'point'}, {key:'decisions',label:'Decision:',noun:'decision'}, {key:'openQuestions',label:'Open question:',noun:'question'}]
        .flatMap(function (group) { return (topic[group.key] || []).map(function (item,itemIndex) { return {id:item.id || topicId+'-'+group.key+'-'+itemIndex,label:group.label,text:item.text,record:item,field:group.key,index:itemIndex,noun:group.noun}; }); });
      var heading;
      if (docMode) heading = docTopicHeading(topic, topicIndex, topicId, rows.length, topicCount);
      else heading = topicHeadingsShown() && !topic.hideHeading ? '<h4>' + finalTextEditor('topic', topicId, 'topic', topic.topic, {singleLine:true,label:'Edit topic heading'}) + '</h4>' : '';
      return heading + (rows.length ? '<ul class="final-propositions">' + rows.map(function (item) {
        var menu = docMode && !finalEditMatches('discussion', item.id, 'text')
          ? rowMenu(item.noun.charAt(0).toUpperCase() + item.noun.slice(1) + ' options', transcriptMenuItem(item.record) + '<button class="delete quiet" data-doc-remove-record="' + topicIndex + '|' + item.field + '|' + item.index + '" type="button">Remove ' + item.noun + '</button>')
          : '';
        return '<li' + (docMode ? ' class="doc-point"' : '') + '><div class="final-proposition-content' + (finalEditMatches('discussion', item.id, 'text') ? ' is-editing' : '') + '">' + (item.label ? '<strong class="final-kind-label">' + escapeHtml(item.label) + '</strong>' : '') + finalTextEditor('discussion', item.id, 'text', item.text, {block:true,rows:3,label:'Edit meeting sentence'}) + '</div>' + menu + '</li>'; }).join('') + '</ul>' : '');
    }).join('');
    var actionsHtml = docMode ? (draft.actions || []).map(docActionRowHtml).join('') || '<tr><td colspan="4">No actions recorded.</td></tr>' : (draft.actions || []).map(function (action) {
      var editing = ['action', 'owners', 'timing'].filter(function (field) { return finalEditMatches('action', actionOccurrence(action), field); })[0] || '';
      var cell = function (field, html) { return '<td' + (editing === field ? ' class="final-editing-cell"' : '') + '>' + html + '</td>'; };
      return '<tr' + (editing ? ' class="is-editing"' : '') + '>'
        + cell('action', finalTextEditor('action', actionOccurrence(action), 'action', action.action, {block:true,label:'Edit action',deferred:true}))
        + cell('owners', finalTextEditor('action', actionOccurrence(action), 'owners', (action.owners || []).join(', '), {singleLine:true,label:'Edit owners',empty:'Not stated',deferred:true}))
        + cell('timing', finalTimingDisplay(action))
        + '</tr>'
        + (editing ? finalActionEditorRow(action, editing) : '');
    }).join('') || '<tr><td colspan="3">No actions recorded.</td></tr>';
    var documentHead = inDocumentMode()
      ? '<div class="print-only"><h2>' + escapeHtml(details.meetingTitle || 'Meeting minutes') + '</h2>' + finalDetailsLines(details, true) + '</div>'
        + (finalHintDismissed() ? '' : '<p class="final-edit-hint" data-final-hint>Click any text to edit. <button type="button" class="link-button" data-dismiss-final-hint>Got it</button></p>')
      : '<p class="final-edit-hint">Click any text to edit.</p><h2>' + finalTextEditor('details', 'meeting-details', 'meetingTitle', details.meetingTitle || 'Meeting minutes', {singleLine:true,label:'Edit meeting title'}) + '</h2>' + finalDetailsLines(details);
    var headingsSwitch = docMode ? '<label class="doc-topic-headings doc-only"><input type="checkbox" data-doc-topic-headings' + (topicHeadingsShown() ? ' checked' : '') + '> Show topic titles in minutes</label>' : '';
    var actionsHead = docMode
      ? '<tr><th class="doc-col-action">Action</th><th class="doc-col-owner">Owner</th><th class="doc-col-due">Due</th><th class="doc-only doc-row-menu"><span class="visually-hidden">Options</span></th></tr>'
      : '<tr><th>Action</th><th>Owners</th><th>Timing</th></tr>';
    var addAction = docMode ? '<button class="quiet doc-add doc-only" data-doc-add-action type="button">Add action</button>' : '';
    document.getElementById('finalDocument').innerHTML = documentHead + (docMode ? '<section class="final-attendees"><h3>Attendees</h3>' + docAttendeesHtml(details) + '<div class="preview-only">' + finalAttendeesHtml(details) + '</div></section>' : finalAttendeesHtml(details)) + summaryHtml + '<section>' + sectionHeading('Meeting content', 'discussion') + staleLinkHtml('discussion') + headingsSwitch + (finalDiscussion || '<p>No meeting content recorded.</p>') + '</section><section>' + sectionHeading('Actions', 'actions') + staleLinkHtml('actions') + '<div class="actions-wrap"><table class="actions-table' + (docMode ? ' doc-actions-table' : '') + '"><thead>' + actionsHead + '</thead><tbody>' + actionsHtml + '</tbody></table></div>' + addAction + '</section>';
    renderPageHeading();
    var meta = document.getElementById('documentMeta');
    if (meta && documentReady()) meta.innerHTML = documentMetaHtml(inDocumentMode() && !documentReadOnly());
    renderDocumentReadOnly();
    var editor = document.querySelector('#finalDocument [data-final-editor] input, #finalDocument [data-final-editor] textarea, #finalDocument [data-final-editor] select, #documentHeader [data-final-editor] input');
    if (editor) { editor.focus({preventScroll:true}); if (editor.select) editor.select(); fitFinalTextarea(editor); }
    if (docMode) updateReviewQueueSummary();
  }

  function renderDocumentReadOnly() {
    if (!documentReadOnly()) return;
    document.querySelectorAll('#finalDocument button, #finalDocument input, #finalDocument select, #finalDocument textarea, #documentHeader [data-final-edit], #documentHeader [data-doc-meeting-type]').forEach(function (control) {
      control.disabled = true;
    });
    document.querySelectorAll('#finalDocument details').forEach(function (menu) {
      menu.open = false;
      var summary = menu.querySelector('summary');
      if (summary) { summary.tabIndex = -1; summary.setAttribute('aria-disabled', 'true'); }
    });
  }

  // A textarea in the document grows with its text instead of scrolling.
  function fitFinalTextarea(element) {
    if (!element || element.tagName !== 'TEXTAREA') return;
    element.rows = 1;
    element.style.height = 'auto';
    element.style.height = (element.scrollHeight + 2) + 'px';
  }

  /* ------------------------------------------------------------------ *
   * Actions table in the document: Action (edited in place), Owner (picked
   * from the attendees), Due (Date, Relative, Dependent or None) and a menu.
   * ------------------------------------------------------------------ */
  var RELATIVE_DUE = ['This week', 'Next week', 'Before next meeting'];
  var docPickerOpen = '';
  var docDueMode = {};

  // Read the stored timing kind without changing its meaning for layout.
  // Long target/deadline wording stays in a note beneath the action; wording
  // without a classified due kind remains available for review.
  function dueState(timing) {
    timing = timing || {};
    var kind = timing.kind || 'not_stated';
    var wording = String(timing.wording || '').replace(/\s+/g, ' ').trim();
    var date = String(timing.exactDate || '').trim();
    if (kind === 'not_stated' || (!wording && !date)) return { mode:'none', note:'' };
    if (date) return { mode:'date', date:date, label:formatUkDate(date) || date, note:wording.length > 32 ? wording : '' };
    if (kind === 'dependency') return { mode:'dependent', text:wording, label:'Depends on: ' + wording, note:'' };
    var preset = RELATIVE_DUE.filter(function (item) { return item.toLowerCase() === wording.toLowerCase(); })[0];
    if (preset) return { mode:'relative', text:preset, label:preset, note:'' };
    if (kind === 'target' || kind === 'deadline') return { mode:'relative', text:wording, custom:true,
      label:wording.length > 32 ? 'See timing note' : wording, note:wording.length > 32 ? wording : '' };
    return { mode:'none', note:wording };
  }

  function amberMarker(text) {
    return '<span class="amber-flag"><span class="amber-dot" aria-hidden="true"></span>' + escapeHtml(text) + '</span>';
  }

  function docActionRowHtml(action) {
    var occ = actionOccurrence(action);
    var kept = isActionKept(action);
    var due = dueState(action.timing);
    var note = due.note ? '<button type="button" class="due-note" data-due-note aria-expanded="false" title="Show the full note">Timing note: “' + escapeHtml(due.note) + '”</button>' : '';
    var reviewed = kept ? '<span class="row-reviewed doc-reviewed doc-only" title="Marked reviewed">' + icon('check') + '<span class="visually-hidden">Reviewed</span></span>' : '';
    var menu = rowMenu('Action options', transcriptMenuItem(action).replace(/(?:View|Check) transcript/, 'View source')
      + '<button class="secondary quiet" data-doc-keep-action="' + escapeHtml(occ) + '" aria-pressed="' + (kept ? 'true' : 'false') + '" type="button">' + (kept ? 'Reviewed ✓' : 'Mark reviewed') + '</button>'
      + '<button class="delete quiet" data-doc-remove-action="' + escapeHtml(occ) + '" type="button">Remove action</button>');
    return '<tr data-doc-action="' + escapeHtml(occ) + '"' + (kept ? ' class="is-reviewed"' : '') + '>'
      + '<td class="doc-action-cell">' + reviewed + finalTextEditor('action', occ, 'action', action.action, {block:true,label:'Edit action',empty:'New action'}) + note + '</td>'
      + '<td class="doc-owner-cell">' + ownerPickerHtml(action, occ) + '</td>'
      + '<td class="doc-due-cell">' + duePickerHtml(action, occ, due) + '</td>'
      + '<td class="doc-only doc-row-menu">' + menu + '</td></tr>';
  }

  function ownerPickerHtml(action, occ) {
    var details = (state.draft && state.draft.details) || {};
    var owners = action.owners || [];
    var lower = owners.map(function (name) { return name.toLowerCase(); });
    var shown = owners.length
      ? '<span class="owner-chips-static">' + owners.map(function (name) { return '<span class="owner-chip-static">' + escapeHtml(name) + '</span>'; }).join('') + '</span>'
      : amberMarker('No owner assigned');
    var option = function (name) {
      var on = lower.indexOf(name.toLowerCase()) >= 0;
      return '<button type="button" class="secondary quiet picker-option" role="menuitemcheckbox" aria-checked="' + on + '" data-owner-toggle="' + escapeHtml(name) + '" data-occ="' + escapeHtml(occ) + '"><span class="picker-tick" aria-hidden="true">' + (on ? '✓' : '') + '</span>' + escapeHtml(name) + '</button>';
    };
    var internal = (details.internalAttendees || []).filter(Boolean);
    var client = (details.clientAttendees || []).filter(Boolean);
    var known = internal.concat(client).map(function (name) { return name.toLowerCase(); });
    var others = owners.filter(function (name) { return known.indexOf(name.toLowerCase()) < 0; });
    var group = function (label, names) { return names.length ? '<div class="record-menu-label">' + escapeHtml(label) + '</div>' + names.map(option).join('') : ''; };
    var key = 'owner:' + occ;
    return '<details class="doc-picker owner-picker" data-menu data-picker="' + escapeHtml(key) + '"' + (docPickerOpen === key ? ' open' : '') + '>'
      + '<summary aria-label="Owner: ' + escapeHtml(owners.join(', ') || 'none') + '. Change owner" title="Change owner">' + shown + '</summary>'
      + '<div class="record-menu-popover doc-picker-popover" data-menu-popover role="menu">'
      + group('Internal', internal) + group(attendeeGroupLabel('client', details), client) + group('Other', others)
      + '<div class="picker-add"><input data-owner-new data-occ="' + escapeHtml(occ) + '" placeholder="Add new…" aria-label="Add a new owner"><button type="button" class="secondary" data-owner-add="' + escapeHtml(occ) + '">Add</button></div>'
      + '<button type="button" class="secondary quiet picker-option" data-owner-none="' + escapeHtml(occ) + '"' + (owners.length ? '' : ' aria-checked="true"') + ' role="menuitemradio"><span class="picker-tick" aria-hidden="true">' + (owners.length ? '' : '✓') + '</span>No owner</button>'
      + '</div></details>';
  }

  function duePickerHtml(action, occ, due) {
    var key = 'due:' + occ;
    var mode = docDueMode[occ] || due.mode;
    var shown = due.mode === 'none' ? amberMarker('No date agreed') : dueShownHtml(due);
    var segment = function (value, label) {
      return '<button type="button" class="segment" data-due-mode="' + value + '" data-occ="' + escapeHtml(occ) + '" aria-pressed="' + (mode === value) + '">' + label + '</button>';
    };
    var body = '';
    if (mode === 'date') body = '<label class="picker-field"><span class="visually-hidden">Due date</span><input type="date" data-due-date data-occ="' + escapeHtml(occ) + '" value="' + escapeHtml(due.mode === 'date' ? due.date : '') + '"></label>';
    else if (mode === 'relative') {
      var custom = due.mode === 'relative' && due.custom;
      body = '<label class="picker-field"><span class="visually-hidden">When</span><select data-due-relative data-occ="' + escapeHtml(occ) + '"><option value="">Choose…</option>'
        + RELATIVE_DUE.map(function (item) { return '<option' + (due.mode === 'relative' && due.text === item ? ' selected' : '') + '>' + item + '</option>'; }).join('')
        + '<option value="__custom"' + (custom || docDueMode[occ + ':custom'] ? ' selected' : '') + '>Custom…</option></select></label>'
        + (custom || docDueMode[occ + ':custom'] ? '<div class="picker-add"><input data-due-text="relative" data-occ="' + escapeHtml(occ) + '" value="' + escapeHtml(custom ? due.text : '') + '" placeholder="e.g. end of month" aria-label="Custom due"><button type="button" class="secondary" data-due-save="relative" data-occ="' + escapeHtml(occ) + '">Save</button></div>' : '');
    } else if (mode === 'dependent') {
      body = '<div class="picker-add"><input data-due-text="dependent" data-occ="' + escapeHtml(occ) + '" value="' + escapeHtml(due.mode === 'dependent' ? due.text : '') + '" placeholder="e.g. before we pay" aria-label="Depends on"><button type="button" class="secondary" data-due-save="dependent" data-occ="' + escapeHtml(occ) + '">Save</button></div>';
    }
    return '<details class="doc-picker due-picker" data-menu data-picker="' + escapeHtml(key) + '"' + (docPickerOpen === key ? ' open' : '') + '>'
      + '<summary aria-label="Due: ' + escapeHtml(due.mode === 'none' ? 'no date agreed' : due.mode === 'dependent' ? 'depends on ' + dependencyText(due.text) : due.mode === 'relative' ? due.label + ' (rough timing)' : due.label) + '. Change due" title="Change due">' + shown + '</summary>'
      + '<div class="record-menu-popover doc-picker-popover due-popover" data-menu-popover>'
      + '<div class="segmented" role="group" aria-label="Due type">' + segment('date', 'Date') + segment('relative', 'Relative') + segment('dependent', 'Dependent') + segment('none', 'None') + '</div>'
      + body + (due.mode === 'relative' || due.mode === 'dependent' ? '<p class="due-hint">No fixed date yet. Choose Date if one is agreed.</p>' : '')
      + '</div></details>';
  }

  // Due reads as one small grey caption line with an icon, so "finish up
  // this week" or a dependency looks deliberate without competing with the
  // action text. "Due" before a date only shows on narrow screens, where the
  // column heading is hidden.
  var DUE_KIND = {
    date:{ icon:'calendar', text:'Due' },
    relative:{ icon:'clock', text:'Rough timing:' },
    dependent:{ icon:'link', text:'Depends on:' }
  };
  function dueShownHtml(due) {
    var kind = DUE_KIND[due.mode];
    var label = due.mode === 'dependent' ? dependencyText(due.text) : due.label;
    // Free wording (from the transcript or typed in) is quoted, so it reads
    // as what was said rather than as the app's own sentence. Preset choices
    // like "Next week" and "See timing note" stay unquoted.
    var quoted = due.mode === 'dependent' || (due.mode === 'relative' && due.custom && !due.note);
    return '<span class="due-line due-line-' + due.mode + '">' + icon(kind.icon)
      + '<span class="due-kind">' + kind.text + '</span> '
      + '<span class="due-label">' + (quoted ? '“' : '') + escapeHtml(label) + (quoted ? '”' : '') + '</span></span>';
  }
  // Transcript wording often repeats the kicker ("dependent on the access…").
  function dependencyText(text) {
    var trimmed = String(text || '').replace(/^\s*(?:depend(?:s|ent|ing)\s+(?:up)?on)\s*:?\s*/i, '');
    return trimmed || String(text || '');
  }

  function setActionDue(occ, mode, value) {
    var action = state.draft.actions[actionIndexForOccurrence(occ)];
    if (!action) return;
    var prior = action.timing || {};
    var next = mode === 'none' ? { kind:'not_stated', wording:'', exactDate:'' }
      : mode === 'date' ? { kind:prior.kind === 'deadline' ? 'deadline' : 'target', wording:'', exactDate:value }
      : mode === 'relative' ? { kind:'target', wording:value, exactDate:'' }
      : { kind:'dependency', wording:value, exactDate:'' };
    delete action.timingDecision;
    action.timing = window.MeetingMinutesTiming.normaliseTimingValue(next, {
      mode:'preserve', reviewerAuthored:true, meetingDate:((state.draft || {}).details || {}).meetingDate || ''
    });
    action.reviewerAuthored = true;
    delete docDueMode[occ]; delete docDueMode[occ + ':custom'];
    docPickerOpen = '';
    markFieldEdited('action', occ, 'timing');
    commitDocumentChange(mode === 'none' ? 'Action due cleared' : 'Action due set');
    var summary = document.querySelector('[data-picker="due:' + occ + '"] > summary');
    if (summary) summary.focus({ preventScroll:true });
  }

  function setActionOwners(occ, owners, focusSelector) {
    var action = state.draft.actions[actionIndexForOccurrence(occ)];
    if (!action) return;
    action.owners = owners;
    action.reviewerAuthored = true;
    markFieldEdited('action', occ, 'owners');
    docPickerOpen = 'owner:' + occ;
    commitDocumentChange('Action owners edited');
    var focus = focusSelector && document.querySelector(focusSelector);
    if (focus) focus.focus({ preventScroll:true });
  }

  function onDocumentPickerClick(event) {
    var target;
    if ((target = event.target.closest('[data-due-note]'))) {
      var open = target.classList.toggle('expanded');
      target.setAttribute('aria-expanded', open ? 'true' : 'false');
      return true;
    }
    if ((target = event.target.closest('[data-owner-toggle]'))) {
      var occ = target.dataset.occ, name = target.dataset.ownerToggle;
      var action = state.draft.actions[actionIndexForOccurrence(occ)];
      if (!action) return true;
      var owners = (action.owners || []).slice();
      var at = owners.map(function (owner) { return owner.toLowerCase(); }).indexOf(name.toLowerCase());
      if (at >= 0) owners.splice(at, 1); else owners.push(name);
      setActionOwners(occ, owners, '[data-picker="owner:' + occ + '"] [data-owner-toggle="' + name.replace(/"/g, '\\"') + '"]');
      return true;
    }
    if ((target = event.target.closest('[data-owner-none]'))) {
      setActionOwners(target.dataset.ownerNone, []);
      docPickerOpen = '';
      var ownerSummary = document.querySelector('[data-picker="owner:' + target.dataset.ownerNone + '"]');
      if (ownerSummary) { ownerSummary.open = false; ownerSummary.querySelector('summary').focus({ preventScroll:true }); }
      return true;
    }
    if ((target = event.target.closest('[data-owner-add]'))) { addNewOwner(target.dataset.ownerAdd); return true; }
    if ((target = event.target.closest('[data-due-mode]'))) {
      if (target.dataset.dueMode === 'none') { setActionDue(target.dataset.occ, 'none', ''); return true; }
      docDueMode[target.dataset.occ] = target.dataset.dueMode;
      docPickerOpen = 'due:' + target.dataset.occ;
      renderFinal();
      var field = document.querySelector('[data-picker="due:' + target.dataset.occ + '"] .picker-field input, [data-picker="due:' + target.dataset.occ + '"] .picker-field select, [data-picker="due:' + target.dataset.occ + '"] [data-due-text]');
      if (field) field.focus({ preventScroll:true });
      return true;
    }
    if ((target = event.target.closest('[data-due-save]'))) { saveDueText(target.dataset.occ, target.dataset.dueSave); return true; }
    return false;
  }

  function addNewOwner(occ) {
    var input = document.querySelector('[data-owner-new][data-occ="' + occ + '"]');
    var name = input ? input.value.replace(/\s+/g, ' ').trim() : '';
    if (!name) return;
    var action = state.draft.actions[actionIndexForOccurrence(occ)];
    if (!action) return;
    var owners = (action.owners || []).slice();
    if (owners.map(function (owner) { return owner.toLowerCase(); }).indexOf(name.toLowerCase()) < 0) owners.push(name);
    setActionOwners(occ, owners, '[data-owner-new][data-occ="' + occ + '"]');
  }

  function saveDueText(occ, mode) {
    var input = document.querySelector('[data-due-text="' + mode + '"][data-occ="' + occ + '"]');
    var value = input ? input.value.replace(/\s+/g, ' ').trim() : '';
    if (value) setActionDue(occ, mode, value);
  }

  function onDocumentPickerChange(event) {
    var target = event.target;
    if (target.matches('[data-due-date]')) { if (target.value) setActionDue(target.dataset.occ, 'date', target.value); return true; }
    if (target.matches('[data-due-relative]')) {
      if (target.value === '__custom') {
        docDueMode[target.dataset.occ + ':custom'] = true;
        docPickerOpen = 'due:' + target.dataset.occ;
        renderFinal();
        var custom = document.querySelector('[data-due-text="relative"][data-occ="' + target.dataset.occ + '"]');
        if (custom) custom.focus({ preventScroll:true });
      } else if (target.value) setActionDue(target.dataset.occ, 'relative', target.value);
      return true;
    }
    return false;
  }

  function attendeeGroupLabel(key, details) {
    return key === 'internal' ? 'Internal' : (details.clientAttendeeLabel === 'External' ? 'External' : 'Client');
  }

  // Attendees in the document: one chip per person with the name (edited in
  // place), a toggle for the group and a remove button.
  function docAttendeesHtml(details) {
    var group = function (key) {
      var label = attendeeGroupLabel(key, details);
      var other = attendeeGroupLabel(key === 'internal' ? 'client' : 'internal', details);
      var names = details[key + 'Attendees'] || [];
      var chips = names.map(function (name, index) {
        var id = key + ':' + index;
        var editing = finalEditMatches('attendee', id, 'name');
        var tools = editing ? '' : '<button class="chip-toggle" data-doc-attendee-move="' + id + '" type="button" title="Move to ' + other + '" aria-label="' + escapeHtml(name) + ' is ' + label.toLowerCase() + '. Move to ' + other.toLowerCase() + '">' + label + '</button>'
          + '<button class="chip-remove" data-doc-remove-attendee="' + id + '" type="button" title="Remove ' + escapeHtml(name) + '" aria-label="Remove ' + escapeHtml(name) + '">&times;</button>';
        return '<span class="doc-attendee-chip' + (editing ? ' is-editing' : '') + '">' + finalTextEditor('attendee', id, 'name', name, {singleLine:true,label:'Edit attendee name',empty:'New attendee'}) + tools + '</span>';
      }).join('');
      return '<div class="doc-attendee-group" data-group="' + key + '"><span class="doc-attendee-label">' + label + '</span><div class="doc-attendee-chips">' + chips
        + '<button class="quiet doc-add" data-doc-add-attendee="' + key + '" type="button">Add attendee</button></div></div>';
    };
    return '<div class="doc-attendees doc-only">' + group('internal') + group('client') + '</div>';
  }

  // A topic's header line in the document: title, point count and a menu.
  // The count and menu sit on the right and never move while the title is
  // being edited.
  function docTopicHeading(topic, topicIndex, topicId, count, topicCount) {
    var globalOn = topicHeadingsShown();
    var hidden = !globalOn || topic.hideHeading === true;
    var headingItem = '<button class="secondary quiet" data-doc-topic-heading="' + topicIndex + '" type="button"' + (globalOn ? '' : ' disabled title="Topic titles are hidden for the whole document. Turn on Show topic titles in minutes first."') + '>' + (topic.hideHeading ? 'Show title in minutes' : 'Hide title in minutes') + '</button>';
    var moves = (topicIndex > 0 ? '<button class="secondary quiet" data-doc-topic-move="' + topicIndex + '" data-dir="-1" type="button">Move up</button>' : '')
      + (topicIndex < topicCount - 1 ? '<button class="secondary quiet" data-doc-topic-move="' + topicIndex + '" data-dir="1" type="button">Move down</button>' : '');
    var menu = rowMenu('Topic options', headingItem + moves + '<button class="delete quiet" data-doc-remove-topic="' + topicIndex + '" type="button">Remove topic</button>');
    return '<div class="doc-topic-head' + (hidden ? ' is-hidden' : '') + '"><h4>' + finalTextEditor('topic', topicId, 'topic', topic.topic, {singleLine:true,label:'Edit topic heading',empty:'Untitled topic'}) + '</h4>'
      + (hidden ? '<span class="hidden-tag doc-only" title="Not shown in the minutes">hidden</span>' : '')
      + '<span class="topic-meta doc-only">' + count + (count === 1 ? ' point' : ' points') + '</span><span class="doc-only">' + menu + '</span></div>';
  }

  // A section heading in the document, with its own "…" menu.
  function sectionHeading(title, stage, extraItems) {
    if (!inDocumentMode()) return '<h3>' + escapeHtml(title) + '</h3>';
    var items = (extraItems || '') + (stage ? '<button class="secondary quiet" data-regenerate-section="' + stage + '" type="button">Regenerate section…</button>' : '');
    var menu = items ? '<details class="doc-menu section-menu" data-menu><summary class="secondary quiet" aria-label="' + escapeHtml(title) + ' options" title="' + escapeHtml(title) + ' options">•••</summary><div class="doc-menu-popover" data-menu-popover>' + items + '</div></details>' : '';
    return '<div class="section-head"><h3>' + escapeHtml(title) + '</h3>' + menu + '</div>';
  }

  function summaryTranscriptItem() {
    var draft = state.draft || {};
    var ids = Array.from(new Set((draft.executiveSummaryEvidenceIds || []).concat((draft.meetingObjectives || []).flatMap(function (o) { return (o && o.evidenceIds) || []; }))));
    return transcriptMenuItem({ evidenceIds: ids, text: draft.executiveSummary || '' }).replace('Check transcript', 'View transcript');
  }

  function finalHintDismissed() {
    try { return window.localStorage.getItem('mma-final-hint-dismissed') === '1'; } catch (error) { return false; }
  }

  function finalDetailsLines(details, readOnly) {
    var field = function (name, options) {
      return readOnly ? escapeHtml(options.displayValue || details[name] || 'Not stated')
        : finalTextEditor('details', 'meeting-details', name, details[name] || '', options);
    };
    return '<p><strong>Date:</strong> ' + field('meetingDate', {singleLine:true,inputType:'date',label:'Edit meeting date',displayValue:formatUkDate(details.meetingDate),empty:'Not stated'})
      + '<br><strong>Location:</strong> ' + field('meetingLocation', {singleLine:true,label:'Edit meeting location',empty:'Not stated'})
      + '<br><strong>Meeting type:</strong> ' + escapeHtml(meetingTypeLabel(details.meetingType) || 'Not stated') + '</p>';
  }

  function renderParallelControls() {
    var parallel = isParallelDraft(), running = parallel && generationRunning();
    var summaryEvidence = document.getElementById('parallelSummaryEvidence');
    if (parallel && !summaryEvidence) {
      summaryEvidence = document.createElement('div'); summaryEvidence.id = 'parallelSummaryEvidence';
      document.getElementById('executiveSummary').insertAdjacentElement('afterend',summaryEvidence);
    }
    if (summaryEvidence) {
      summaryEvidence.hidden = !parallel;
      summaryEvidence.innerHTML = parallel ? evidenceBlock(Array.from(new Set((state.draft.executiveSummaryEvidenceIds || []).concat(
        (state.draft.meetingObjectives || []).flatMap(function(o){return o.evidenceIds || [];})
      )))) : '';
    }
    ['discussionInstruction','actionsInstruction'].forEach(function(id) {
      var element = document.getElementById(id);
      if (element && element.closest('details')) element.closest('details').hidden = parallel;
    });
    ['regenerateDiscussion','regenerateActions','generateSummary'].forEach(function(id) {
      var button = document.getElementById(id);
      if (parallel && button) { button.textContent = 'Generate another draft'; button.title = 'Create a new saved draft; keep this version and its edits.'; }
    });
    document.querySelectorAll('#detailsEditor input,#detailsEditor textarea,#detailsEditor select').forEach(function(element) {
      if (running && !element.disabled) { element.dataset.parallelLocked = 'true'; element.disabled = true; }
      else if (!running && element.dataset.parallelLocked) { delete element.dataset.parallelLocked; element.disabled = false; }
    });
  }

  function renderParallelProposals() {
    if (!isParallelDraft()) return;
    var proposals = (state.draft.parallelActionProposals || []).filter(function(a) { return a.status === 'open'; });
    if (!proposals.length) return;
    var html = '<tr class="empty-actions-row"><td colspan="3"><strong>Possible follow-ups — not yet included as actions</strong></td></tr>';
    html += proposals.map(function(a) {
      return '<tr class="parallel-proposal-row"><td data-label="Action">' + escapeHtml(a.action) + '<p class="muted">' + escapeHtml(a.reason) + '</p>'
        + evidenceBlock(a.evidenceIds)
        + '<button type="button" class="secondary" data-parallel-proposal="' + escapeHtml(a.id) + '" data-decision="accept">Add action</button> '
        + '<button type="button" class="quiet" data-parallel-proposal="' + escapeHtml(a.id) + '" data-decision="dismiss">Dismiss</button></td>'
        + '<td data-label="Owners">' + escapeHtml((a.owners || []).join(', ') || 'Not stated') + '</td><td data-label="Timing">' + escapeHtml(timingDisplayText(a.timing)) + '</td></tr>';
    }).join('');
    document.getElementById('actionsBody').insertAdjacentHTML('beforeend', html);
  }

  document.addEventListener('click', async function(event) {
    var button = event.target.closest('[data-parallel-proposal]');
    if (!button || !isParallelDraft()) return;
    try {
      await saveDraftNow();
      var payload = await jsonRequest(draftUrl('/parallel-proposals/' + encodeURIComponent(button.dataset.parallelProposal)), {
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:state.draft.revision,decision:button.dataset.decision})
      });
      adoptDraft(payload.draft);
      setStatus(button.dataset.decision === 'accept' ? 'Suggested action added for review.' : 'Suggestion dismissed.',false,'actions');
    } catch(error) { setStatus(error.message,true,'actions'); }
  });

  function renderFinalSaveState() {
    var complete = Boolean(state.draft && state.draft.status === 'complete');
    var button = document.getElementById('saveMinutes');
    var confirmation = document.getElementById('finalSaveConfirmation');
    if (button) {
      button.hidden = complete;
      button.disabled = complete;
      button.innerHTML = icon('save') + (complete ? 'Final minutes saved' : 'Save final minutes');
    }
    if (confirmation) confirmation.hidden = !complete;
  }

  function renderAll() {
    var snapshot = captureFocus();
    rendering = true;
    document.body.classList.toggle('has-draft', Boolean(state.draft));
    renderPageHeading();
    uploadZone.hidden = Boolean(state.draft);
    detailsEditor.hidden = !state.draft;
    document.getElementById('saveStrip').hidden = !state.draft;
    if (state.draft) {
      renderDetails(); renderSteer(); renderDiscussion(); renderActions(); renderSummary(); renderFlags();
      renderParallelControls();
      renderActionsPrewarm();
      var activeGenerationStage = state.draft.generation && state.draft.generation.status === 'running'
        ? state.draft.generation.stage : '';
      var disabledControls = {
        startDiscussion: Boolean(activeGenerationStage)
          || (!stageHasContent('discussion') && stagePreparingInBackground('discussion')),
        generateActions: Boolean(activeGenerationStage)
          || (!stageHasContent('actions') && stagePreparingInBackground('actions')),
        addDiscussion: activeGenerationStage === 'discussion',
        applyDiscussionEdit: Boolean(activeGenerationStage),
        generateSummary: Boolean(activeGenerationStage),
        addAction: activeGenerationStage === 'actions' || (isParallelDraft() && Boolean(activeGenerationStage)),
        regenerateDiscussion: Boolean(activeGenerationStage),
        regenerateActions: Boolean(activeGenerationStage),
        applyActionsEdit: Boolean(activeGenerationStage),
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
      renderStaleNotice();
      updateStageAdvanceLabels();
      renderFinalSaveState();
    } else document.getElementById('staleNotice').hidden = true;
    // The Review page's document is built on entry; a draft resumed on Review
    // (or re-rendered while it is open) must build it too.
    if (inDocumentMode()) state.currentStep = MAX_STEP;
    renderDocumentMode();
    if (state.draft && state.currentStep === MAX_STEP) renderFinal();
    showStep(state.draft ? state.currentStep : 0, { persist: false });
    renderGenerationProgress();
    rendering = false;
    restoreFocus(snapshot);
    maybeOpenPreparedDiscussion();
    maybeOpenPreparedSummary();
  }

  // Stages the server can finish on its own, and the fields each one owns.
  var BACKGROUND_STAGES = {
    discussion: ['discussion', 'unassignedSupportingDetails'],
    actions: ['actions'],
    summary: ['executiveSummary', 'meetingObjectives']
  };

  // When the server last ran a stage. A run that found nothing still ran: an
  // Actions run on a meeting where nobody takes anything on writes an empty
  // list, and that write must be adopted like any other or the tab sits a
  // revision behind until its next save is refused as "updated elsewhere".
  function stageGeneratedAt(draft, stage) {
    var generated = draft && draft.generatedStages;
    return generated && typeof generated === 'object' ? String(generated[stage] || '') : '';
  }

  function stageContentKey(draft, stage) {
    return BACKGROUND_STAGES[stage].map(function (field) {
      var fallback = field === 'unassignedSupportingDetails' ? [] : null;
      return JSON.stringify(draft && draft[field] != null ? draft[field] : fallback);
    }).concat([stageGeneratedAt(draft, stage)]).join('|');
  }

  function stageHasRows(draft, stage) {
    if (stage === 'summary') {
      return Boolean(String((draft && draft.executiveSummary) || '').trim())
        || Boolean(((draft && draft.meetingObjectives) || []).length);
    }
    return Boolean(((draft && draft[stage]) || []).length)
      || (stage === 'discussion' && Boolean(((draft && draft.unassignedSupportingDetails) || []).length));
  }

  // Nothing to look at and no run behind it: the tab holds nothing here.
  function stageIsEmpty(draft, stage) {
    return !stageHasRows(draft, stage) && !stageGeneratedAt(draft, stage);
  }

  // The server finishes stages the reviewer has not reached yet and writes them
  // into the draft, so the work survives a closed tab. That advances the
  // revision underneath an open tab, whose next save would otherwise fail the
  // revision check and warn about a change the reviewer never made.
  //
  // Take the newer revision only when the whole difference is background work
  // arriving in stages this tab has nothing in. Anything else - an edit from
  // another tab, a stage that lost content, a renamed meeting - is a real
  // conflict, and the reviewer decides that one rather than us.
  function backgroundStagesToAdopt(serverDraft) {
    if (!state.draft || !serverDraft) return null;
    if (String(serverDraft.draftId || '') !== String(state.draft.draftId || '')) return null;
    if (!(Number(serverDraft.revision) > Number(state.draft.revision))) return null;
    var adopt = [];
    var stages = Object.keys(BACKGROUND_STAGES);
    for (var i = 0; i < stages.length; i += 1) {
      var stage = stages[i];
      if (stageContentKey(serverDraft, stage) === stageContentKey(state.draft, stage)) continue;
      if (!stageIsEmpty(state.draft, stage)) return null;
      if (stageIsEmpty(serverDraft, stage)) return null;
      adopt.push(stage);
    }
    return adopt.length ? adopt : null;
  }

  function adoptBackgroundStages(serverDraft, stages) {
    stages.forEach(function (stage) {
      BACKGROUND_STAGES[stage].forEach(function (field) { state.draft[field] = serverDraft[field]; });
    });
    if (serverDraft.generatedStages) state.draft.generatedStages = serverDraft.generatedStages;
    state.draft.revision = serverDraft.revision;
    state.draft.updatedAt = serverDraft.updatedAt;
    if (serverDraft.staleStages) state.draft.staleStages = serverDraft.staleStages;
    if (serverDraft.reviewFlags) state.draft.reviewFlags = serverDraft.reviewFlags;
  }

  // True when nothing is typed, queued or in flight, so what is on screen is
  // exactly the saved revision and adopting a newer one cannot lose an edit.
  function editorsSettled() {
    return Boolean(state.draft) && !generationRunning() && !saveInFlight && !savePending
      && !pendingGenerationEdits && !hasTransientEditorState();
  }

  async function applyPendingProposalAutomatically() {
    if (automaticProposalInFlight || !state.draft) return false;
    var proposal = state.draft.pendingProposal;
    if (!proposal || !Array.isArray(proposal.changes) || !proposal.changes.length) return false;
    automaticProposalInFlight = true;
    var proposalStage = proposal.stage || currentStageName();
    draftWritesInFlight += 1;
    try {
      setSaveStatus('Applying the latest generated changes...', 'generating');
      var payload = await withBackgroundMerge(function () {
        return jsonRequest(draftUrl('/proposal'), {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({revision: state.draft.revision, decision: 'accept', automatic: true, changeIds: []})
        });
      });
      adoptDraft(payload.draft, {skipAutomaticProposal: true});
      if (payload.draft && payload.draft.lastUndo) showUndoToast(payload.draft.lastUndo.label);
      setStatus(proposalStage === 'actions' ? 'Actions updated automatically.' : 'The latest generated changes were applied automatically.', false, proposalStage);
      return true;
    } catch (error) {
      // Keep the draft visible if the automatic merge is temporarily blocked;
      // the warning is actionable without exposing the old proposal controls.
      setStatus('The latest generated changes could not be applied automatically. ' + error.message, true, proposalStage);
      return false;
    } finally {
      automaticProposalInFlight = false;
      endDraftWrite();
    }
  }

  function adoptDraft(draft, options) {
    if (!draft) return;
    var replacingExistingDraft = Boolean(state.draft);
    // Only the upload itself shows the confirmation (prepareFile re-shows it
    // after adopting); a draft opened from the Library starts without it.
    if (!replacingExistingDraft) hideUploadConfirmation();
    rememberPendingActions();
    rememberPendingDiscussion();
    var reload = document.getElementById('reloadDraft');
    reload.hidden = true;
    delete reload.dataset.progressCheck;
    reload.textContent = 'Reload saved version';
    transferActionOccurrences(draft);
    ensureActionOccurrences(draft);
    var unfinishedOwnerKeys = Object.keys(actionEditorState.customOwners).filter(function (key) {
      var entry = actionEditorState.customOwners[key];
      return entry && (entry.visible || entry.value);
    });
    if (unfinishedOwnerKeys.some(function (key) {
      return (draft.actions || []).filter(function (row) { return actionOccurrence(row) === key; }).length !== 1;
    })) {
      setSaveStatus('The saved actions changed while an owner entry was unfinished. Finish or cancel that entry before reloading.', 'local-only');
      return;
    }
    state.draft = restorePendingActions(restorePendingDiscussion(draft));
    ensureActionOccurrences(state.draft);
    // Responses to saves and background work must not navigate the reviewer.
    // On the initial load, restore the separately persisted selected screen;
    // older drafts fall back to their furthest unlocked step.
    if (!replacingExistingDraft) {
      var remembered = rememberedStep(draft.draftId);
      state.currentStep = Math.max(0, Math.min(MAX_STEP, remembered != null ? remembered
        : Number(draft.selectedStep == null ? draft.currentStep : draft.selectedStep) || 0));
    }
    renderAll();
    // A reload in the middle of a run must not look dead.
    if (generationRunning()) {
      generationPollKey = [state.draft.draftId, state.draft.generation.stage, state.draft.generation.startedAt].join('|');
      pollGeneration(true);
    }
    else pollActionPrewarm();
    if (generationRunning()) {
      setSaveStatus(generationSaveText(), pendingGenerationEdits ? 'waiting' : 'generating');
    } else if (hasTransientEditorState()) {
      setSaveStatus(EMPTY_ROW_NOTICE, 'local-only');
    } else {
      setSaveStatus(savedStatusText(draft.updatedAt), 'saved');
    }
    if (!(options && options.skipAutomaticProposal) && state.draft.pendingProposal && (state.draft.pendingProposal.changes || []).length) {
      window.setTimeout(applyPendingProposalAutomatically, 0);
    }
  }

  function rememberStep(draftId, step) {
    try { window.localStorage.setItem('mma-step:' + draftId, String(step)); } catch (error) { /* private mode */ }
  }

  function rememberedStep(draftId) {
    var value = null;
    try { value = window.localStorage.getItem('mma-step:' + draftId); } catch (error) { value = null; }
    return value === null || value === '' || isNaN(Number(value)) ? null : Number(value);
  }

  function readEditors() {
    if (!state.draft) return;
    readDetails(); readSteer(); readDiscussion(); readActions(); readSummary();
    state.draft.currentStep = Math.max(Number(state.draft.currentStep || 0), state.currentStep);
    state.draft.selectedStep = state.currentStep;
  }

  function draftPatchBody(statusValue, reviewDecisionLabel) {
    var body = {
      revision: state.draft.revision,
      // Tells the server this client speaks the six-step numbering. A tab loaded
      // before the deploy will not send it, and its currentStep is then ignored
      // rather than being read as a screen it did not mean.
      payloadVersion: 5,
      details: state.draft.details,
      steer: state.draft.steer || '',
      discussion: state.draft.discussion,
      unassignedSupportingDetails: state.draft.unassignedSupportingDetails || [],
      excludedSupportingDetails: (state.draft.excludedSupportingDetails || []).map(function (entry) { return { key:entry.key }; }),
      actions: state.draft.actions,
      executiveSummary: state.draft.executiveSummary || '',
      meetingObjectives: state.draft.meetingObjectives || [],
      reviewFlags: state.draft.reviewFlags,
      staleStages: state.draft.staleStages || [],
      currentStep: Math.max(Number(state.draft.currentStep || 0), state.currentStep),
      selectedStep: state.currentStep,
      includeSections: state.draft.includeSections || { meetingObjectives: true, executiveSummary: true, topicHeadings: true },
      keptActionIds: state.draft.keptActionIds || [],
      keptActionOccurrenceIds: state.draft.keptActionOccurrenceIds || [],
      removedActions: state.draft.removedActions || []
    };
    if (statusValue) body.status = statusValue;
    if (reviewDecisionLabel) body.reviewDecisionLabel = reviewDecisionLabel;
    return body;
  }

  function draftUrl(suffix) {
    return '/api/meeting-minutes-agent/drafts/' + encodeURIComponent(state.draft.draftId) + (suffix || '');
  }

  function editingInside(containerId) {
    var container = document.getElementById(containerId);
    var active = document.activeElement;
    return Boolean(container && active && active !== document.body && container.contains(active)
      && active.matches('textarea,input,select,[contenteditable]'));
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
      // Never rebuild the section the reviewer is typing in: rebuilding it
      // destroys the focused field, so every later keystroke was lost.
      if (!editingInside('discussionList')) renderDiscussion();
      if (!editingInside('actionsBody')) renderActions();
      return;
    }
    savePending = true;
    setSaveStatus('Saving…', 'dirty');
    // Held until the operation finishes, then sent against the revision it
    // produced rather than the one it replaced.
    if (draftWritesInFlight) return;
    saveTimer = window.setTimeout(function () { saveDraftNow(); }, SAVE_DEBOUNCE_MS);
  }

  // Absorb the one revision conflict the reviewer should never be asked about:
  // a stage the server finished in the background while this tab held nothing
  // in it. Take that work, then send again with the revision it produced.
  // Exactly one retry - a second conflict is a real one and gets the banner.
  //
  // `send` must build its own body, so the retry carries the new revision.
  // Undo and redo deliberately do not use this: they restore a snapshot taken
  // before the background work existed, so silently folding it in first would
  // change what undo means.
  // Every draft write is revision-guarded, so two must never be in flight
  // against the same revision. An autosave scheduled while an operation runs
  // waits for it instead of racing it into a conflict the reviewer then has to
  // read about - the same rule already applied to generation, which is just the
  // longest-running case of it.
  var draftWritesInFlight = 0;

  function endDraftWrite() {
    draftWritesInFlight = Math.max(0, draftWritesInFlight - 1);
    if (!draftWritesInFlight && savePending) { savePending = false; saveDraftNow(); }
  }

  async function withBackgroundMerge(send) {
    try {
      return await send();
    } catch (error) {
      var stages = error.currentDraft ? backgroundStagesToAdopt(error.currentDraft) : null;
      if (!stages) throw error;
      adoptBackgroundStages(error.currentDraft, stages);
      return await send();
    }
  }

  async function saveDraftNow(statusValue) {
    if (!state.draft) return null;
    clearTimeout(saveTimer);
    savePending = false;
    if (saveInFlight) { saveQueued = true; await saveInFlight; if (!saveQueued) return state.draft; saveQueued = false; }
    readEditors();
    var requestEditVersion = editVersion;
    var reviewDecisionLabel = pendingReviewDecisionLabel;
    setSaveStatus('Saving…', 'saving');
    saveInFlight = withBackgroundMerge(function () {
      return jsonRequest(draftUrl(), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draftPatchBody(statusValue, reviewDecisionLabel))
      });
    }).then(function (payload) {
      if (reviewDecisionLabel && pendingReviewDecisionLabel === reviewDecisionLabel) pendingReviewDecisionLabel = '';
      if (editVersion !== requestEditVersion || hasTransientDocumentState()) {
        // A newer keystroke landed while this request was in flight. Advance the
        // revision but do not replace the newer editor values with the response.
        state.draft.revision = payload.draft.revision;
        state.draft.updatedAt = payload.draft.updatedAt;
        state.draft.lastUndo = payload.draft.lastUndo;
        if (reviewDecisionLabel) showUndoToast(reviewDecisionLabel);
        if (hasTransientDocumentState()) setSaveStatus('Finish the current entry to save it.', 'local-only');
        else if (hasTransientEditorState()) setSaveStatus(EMPTY_ROW_NOTICE, 'local-only');
        else setSaveStatus('Saving…', 'dirty');
        return state.draft;
      }
      pendingGenerationEdits = false;
      adoptDraft(payload.draft);
      if (reviewDecisionLabel) showUndoToast(reviewDecisionLabel);
      return state.draft;
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
    }).finally(function () { saveInFlight = null; settleStepNavigationScroll(); });
    return saveInFlight;
  }

  // Use the editor's existing revision-guarded save path for the project
  // handoff, including edits typed while an earlier autosave was in flight.
  window.MeetingMinutesAgent = {
    saveForProjectUpdate: async function () {
      if (!state.draft) throw new Error('Open saved meeting minutes first.');
      if (activeFinalEdit) throw new Error('Finish or cancel the current minutes edit before creating the project update.');
      if (hasTransientEditorState()) throw new Error('Finish or remove unfinished rows and owner entries before creating the project update.');
      if (generationRunning() || draftWritesInFlight || automaticProposalInFlight
        || (state.draft.pendingProposal && (state.draft.pendingProposal.changes || []).length)) {
        throw new Error('Wait for the minutes to finish updating before creating the project update.');
      }
      var draftId = String(state.draft.draftId);
      var version;
      do {
        version = editVersion;
        await saveDraftNow();
        if (!state.draft || String(state.draft.draftId) !== draftId) throw new Error('The open minutes changed. Try again from the current draft.');
        if (activeFinalEdit) throw new Error('Finish or cancel the current minutes edit before creating the project update.');
        if (hasTransientEditorState()) throw new Error('Finish or remove unfinished rows and owner entries before creating the project update.');
        if (generationRunning() || draftWritesInFlight || automaticProposalInFlight
          || (state.draft.pendingProposal && (state.draft.pendingProposal.changes || []).length)) {
          throw new Error('Wait for the minutes to finish updating before creating the project update.');
        }
      } while (version !== editVersion || savePending || saveQueued || saveInFlight);
      clearTimeout(saveTimer);
      return { id: draftId, revision: state.draft.revision };
    }
  };

  // Kicks a stage off server-side and returns straight away, so the reviewer can
  // read while it runs. The server keeps going even if this tab closes.
  var pendingRegenerationStage = '';

  // A button that reads "Generate actions" while the server is already doing
  // that work contradicts the status directly above it. Reflect all three real
  // states: no work started, work under way, and saved work ready to open.
  function updateStageAdvanceLabels() {
    [['startDiscussion', 'discussion', 'Generate discussion', 'Preparing Discussion…', 'Continue to Discussion'],
      ['generateActions', 'actions', 'Generate actions', 'Preparing Actions…', 'Continue to Actions']
    ].forEach(function (entry) {
      var button = document.getElementById(entry[0]);
      var label = button && button.querySelector('[data-stage-advance-label]');
      if (!label) return;
      var text = stageHasContent(entry[1]) ? entry[4]
        : stagePreparingInBackground(entry[1]) ? entry[3] : entry[2];
      if (label.textContent !== text) label.textContent = text;
      button.disabled = Boolean(state.draft && state.draft.generation && state.draft.generation.status === 'running')
        || (!stageHasContent(entry[1]) && stagePreparingInBackground(entry[1]));
    });
  }

  // The furthest step the reviewer may open. Content that exists is reachable,
  // however it got there: a stage finished in the background advances no step
  // counter, and a tab greyed out over work that is sitting right there is the
  // flow appearing broken on the first click.
  function furthestUnlockedStep() {
    var draft = state.draft || {};
    var furthest = Math.max(Number(draft.currentStep || 0), state.currentStep);
    ['discussion', 'actions', 'summary'].forEach(function (stage) {
      if (stageHasContent(stage)) furthest = Math.max(furthest, STAGE_STEP[stage]);
    });
    // Reaching Summary means the minutes exist, so Review is reachable too.
    if (furthest >= STAGE_STEP.summary && stageHasContent('summary')) furthest = MAX_STEP;
    return Math.min(MAX_STEP, furthest);
  }

  // What a finished stage has to say for itself.
  function stageReadyText(stage) {
    if (stage === 'discussion') return 'Discussion ready.';
    if (stage === 'actions') return 'Actions ready.';
    return '';
  }

  function isParallelDraft(draft) { return Boolean((draft || state.draft) && (draft || state.draft).generationProvider === 'parallel-specialists-v1'); }

  function stageHasContent(stage) {
    if (!state.draft) return false;
    if (isParallelDraft() && stageGeneratedAt(state.draft, stage)) return true;
    if (stage === 'discussion') return (state.draft.discussion || []).length > 0;
    // A completed Actions review with zero confirmed rows is still content:
    // it unlocks the screen, avoids re-running extraction, and lets the empty
    // state explain that the result was intentional rather than a failure.
    if (stage === 'actions') return (state.draft.actions || []).length > 0
      || Boolean(stageGeneratedAt(state.draft, 'actions'));
    if (stage === 'summary') return Boolean(String(state.draft.executiveSummary || '').trim() || (state.draft.meetingObjectives || []).length);
    return false;
  }

  // "Generate discussion" and "Generate actions" are the forward buttons of
  // their screens. Since stages are now finished in the background before the
  // reviewer reaches them, the work is usually already there by the time one is
  // pressed - and being asked whether to regenerate it, instead of being taken
  // to it, is not what the button says it does. Only an explicit regenerate
  // (the stale-stage Update, or Create summary from the summary screen itself)
  // asks the question.
  function requestBackgroundStage(stage, options) {
    if (!stageHasContent(stage)) { startBackgroundStage(stage); return; }
    if (!(options && options.regenerate)) { showStep(STAGE_STEP[stage], { scroll: true }); return; }
    pendingRegenerationStage = stage;
    var dialog = document.getElementById('regenerationDialog');
    var regenerationCopy = {
      discussion: {
        title: 'Regenerate discussion?',
        message: 'Your current discussion stays visible while the agent works. Anything you edited remains unchanged; the latest generated result will be applied automatically when ready.',
        confirm: 'Regenerate discussion'
      },
      actions: {
        title: 'Regenerate actions?',
        message: 'Your current action list stays visible while the agent works. Anything you edited remains unchanged; the latest generated result will be applied automatically when ready.',
        confirm: 'Regenerate actions'
      },
      summary: {
        title: 'Regenerate meeting summary?',
        message: 'This will create new meeting objectives and a new executive summary. Your current version stays visible while the agent works, then the new version will replace it.',
        confirm: 'Regenerate summary'
      }
    }[stage];
    if (isParallelDraft()) regenerationCopy = {title:'Generate another draft?', message:'This creates a complete new draft from the transcript and current meeting details. This saved draft and all your edits remain in the Library.', confirm:'Generate another draft'};
    document.getElementById('regenerationTitle').textContent = regenerationCopy.title;
    document.getElementById('regenerationMessage').textContent = regenerationCopy.message;
    document.getElementById('confirmRegeneration').textContent = regenerationCopy.confirm;
    dialog.showModal();
  }

  async function startBackgroundStage(stage) {
    if (!state.draft) return;
    try { await saveDraftNow(); } catch (error) { setStatus(error.message, true); return; }
    draftWritesInFlight += 1;
    try {
      var selectedStep = stage === 'actions' ? state.currentStep : STAGE_STEP[stage];
      var payload = await withBackgroundMerge(function () {
        return jsonRequest(draftUrl('/generate-background'), {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({stage:stage,revision:state.draft.revision,selectedStep:selectedStep})});
      });
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
    finally { endDraftWrite(); }
  }

  function showProgressCheck(error, stage) {
    var reload = document.getElementById('reloadDraft');
    if (reload) {
      reload.hidden = false;
      reload.dataset.progressCheck = 'true';
      reload.textContent = 'Check progress';
    }
    setStatus('Progress could not be checked just now. It will be checked again automatically.', true, stage);
  }

  function clearProgressCheck() {
    var reload = document.getElementById('reloadDraft');
    if (!reload || reload.dataset.progressCheck !== 'true') return;
    reload.hidden = true;
    delete reload.dataset.progressCheck;
    reload.textContent = 'Reload saved version';
  }

  function pollGeneration(immediate) {
    clearTimeout(generationTimer);
    if (generationPollController) {
      generationPollController.abort();
      generationPollController = null;
    }
    if (document.hidden || !state.draft || !generationRunning()) return;
    generationTimer = window.setTimeout(async function () {
      if (!state.draft || document.hidden) return;
      var expectedDraftId = state.draft.draftId;
      var expectedGeneration = state.draft.generation || {};
      var expectedKey = [expectedDraftId, expectedGeneration.stage, expectedGeneration.startedAt].join('|');
      var controller = new AbortController();
      generationPollController = controller;
      try {
        var payload = await jsonRequest(draftUrl('/generation'), {signal: controller.signal});
        if (generationPollController === controller) generationPollController = null;
        clearProgressCheck();
        var currentGeneration = state.draft && state.draft.generation;
        var currentKey = [state.draft && state.draft.draftId, currentGeneration && currentGeneration.stage, currentGeneration && currentGeneration.startedAt].join('|');
        if (!state.draft || state.draft.draftId !== expectedDraftId || currentKey !== expectedKey) return;
        var activeStage = (state.draft.generation && state.draft.generation.stage) || 'discussion';
        state.draft.generation = payload.generation;
        if (payload.speculation !== undefined) state.draft.speculation = payload.speculation;
        if (payload.generation && ['queued', 'running', 'retrying'].includes(payload.generation.status)) {
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
          var parallelResult = isParallelDraft(completedDraft);
          completedDraft.details = localDraft.details;
          completedDraft.steer = localDraft.steer;
          if (!parallelResult && (activeStage !== 'discussion' || (pendingGenerationEdits && (localDraft.discussion || []).length))) {
            completedDraft.discussion = localDraft.discussion;
          }
          if (!parallelResult && activeStage !== 'actions') completedDraft.actions = localDraft.actions;
          if (!parallelResult && activeStage !== 'summary') {
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
          if (activeStage === 'discussion' && state.currentStep === 0 && !generationFailed
            && String(state.draft.draftId || '') === uploadedDraftId) {
            showUploadConfirmation(state.draft.fileName, (state.draft.sourceUnits || []).length, false, false, true);
          }
        }
        if (payload.generation && payload.generation.status === 'failed') {
          setStatus(payload.generation.error || 'The agent could not finish. Try generating again.', true, activeStage);
        } else {
          var keptEdits = activeStage === 'actions' && state.draft.pendingProposal && state.draft.pendingProposal.source === 'regeneration';
          setStatus(keptEdits
            ? 'Your edited Actions were kept. The regenerated Actions will be applied automatically.'
            : state.draft.qualityNotice || stageReadyText(activeStage), !keptEdits && Boolean(state.draft.qualityNotice), activeStage);
        }
        generationPollKey = '';
        var saveAfterGeneration = pendingGenerationEdits || pendingGenerationNavigation;
        pendingGenerationNavigation = false;
        if (saveAfterGeneration) scheduleSave();
        else if (hasTransientEditorState()) setSaveStatus(EMPTY_ROW_NOTICE, 'local-only');
        else setSaveStatus(savedStatusText(state.draft.updatedAt), 'saved');
      } catch (error) {
        if (generationPollController === controller) generationPollController = null;
        if (error.name === 'AbortError') return;
        if (!state.draft || state.draft.draftId !== expectedDraftId) return;
        showProgressCheck(error, expectedGeneration.stage);
        generationTimer = window.setTimeout(function () { pollGeneration(true); }, GENERATION_RETRY_MS);
      }
    }, immediate ? 0 : GENERATION_POLL_MS);
  }

  async function runAgent(stage, instruction) {
    if (!state.draft) return false;
    var applicationWaitMessage = 'Generated changes are still being applied. Try your edit again when they finish.';
    if (automaticProposalInFlight) { setStatus(applicationWaitMessage, false, stage); return false; }
    try { await saveDraftNow(); } catch (error) { setStatus(error.message, true); return false; }
    // Saving can discover a proposal and schedule its automatic application.
    // Keep this instruction until that earlier revision-changing write settles.
    if (automaticProposalInFlight || (state.draft.pendingProposal && (state.draft.pendingProposal.changes || []).length)) {
      setStatus(applicationWaitMessage, false, stage);
      return false;
    }
    setBusy(true, 'The agent is preparing your requested changes...', stage);
    draftWritesInFlight += 1;
    try {
      var payload; var totalAttempts = agentRetryDelaysSeconds.length + 1;
      for (var attempt = 0; attempt < totalAttempts; attempt += 1) {
        if (attempt > 0) await waitForAgentRetry(agentRetryDelaysSeconds[attempt - 1], attempt + 1, totalAttempts, stage);
        try {
          payload = await withBackgroundMerge(function () {
            return jsonRequest('/api/meeting-minutes-agent/generate', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({stage:stage,draftId:state.draft.draftId,revision:state.draft.revision,instruction:instruction || ''})});
          });
          break;
        } catch (error) {
          if (!(error.code === 'M365_AGENT_USAGE_LIMIT' && error.retryable) || attempt === totalAttempts - 1) throw error;
        }
      }
      adoptDraft(payload.draft, {skipAutomaticProposal: true});
      if (state.draft.pendingProposal && (state.draft.pendingProposal.changes || []).length) {
        // This path owns application, so do not also queue it from adoptDraft.
        // Only a confirmed application can consume the edit instruction.
        if (await applyPendingProposalAutomatically() !== true) return false;
      } else setStatus('Your requested changes were applied.', false, stage);
      return true;
    } catch (error) { setStatus(error.message, true, stage); return false; }
    finally { setBusy(false); endDraftWrite(); }
  }

  async function redoLastReviewDecision() {
    if (!state.draft || !state.draft.lastRedo) return;
    try {
      if (saveTimer || saveInFlight || pendingReviewDecisionLabel) await saveDraftNow();
    } catch (error) { return setStatus(error.message, true, currentStageName()); }
    setBusy(true, 'Redoing...', currentStageName());
    draftWritesInFlight += 1;
    try {
      var payload = await jsonRequest(draftUrl('/redo'), {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:state.draft.revision})});
      activeFinalEdit = null;
      endUndoGroup();
      adoptDraft(payload.draft);
      setStatus('Change redone.', false, currentStageName());
    } catch (error) { setStatus(error.message, true, currentStageName()); }
    finally { setBusy(false); endDraftWrite(); }
  }

  async function undoLastReviewDecision() {
    if (!state.draft || !state.draft.lastUndo) return;
    try {
      if (saveTimer || saveInFlight || pendingReviewDecisionLabel) await saveDraftNow();
    } catch (error) { return setStatus(error.message, true, currentStageName()); }
    setBusy(true, 'Undoing the last review decision...', currentStageName());
    draftWritesInFlight += 1;
    try {
      var payload = await jsonRequest(draftUrl('/undo'), {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:state.draft.revision})});
      activeFinalEdit = null;
      endUndoGroup();
      adoptDraft(payload.draft);
      document.getElementById('undoToast').hidden = true;
      setStatus('Last review decision undone.', false, currentStageName());
    } catch (error) { setStatus(error.message, true, currentStageName()); }
    finally { setBusy(false); endDraftWrite(); }
  }

  async function restoreCombinedDiscussion() {
    if (!state.draft || !state.draft.canRestoreCombinedDiscussion) return;
    try { await saveDraftNow(); } catch (error) { return setStatus(error.message, true, 'discussion'); }
    if (!state.draft.canRestoreCombinedDiscussion) return;
    var pairedRestore = state.draft.canRestorePairedDiscussionActions;
    setBusy(true, pairedRestore ? 'Restoring original discussion and action wording...' : 'Restoring the original paragraphs...', 'discussion');
    draftWritesInFlight += 1;
    try {
      var payload = await jsonRequest(draftUrl('/restore-combined-discussion'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: state.draft.revision, ...(pairedRestore ? { restorePairedActions: true } : {}) })
      });
      activeFinalEdit = null;
      endUndoGroup();
      adoptDraft(payload.draft);
      setStatus(pairedRestore ? 'Original discussion and action wording restored.' : 'Original paragraphs restored.', false, 'discussion');
    } catch (error) { setStatus(error.message, true, 'discussion'); }
    finally { setBusy(false); endDraftWrite(); }
  }

  async function restoreCombinedActions() {
    if (!state.draft || !state.draft.canRestoreCombinedActions) return;
    try { await saveDraftNow(); } catch (error) { return setStatus(error.message, true, 'actions'); }
    var restoringPhase = state.draft.canRestorePhaseActions;
    setBusy(true, restoringPhase ? 'Restoring original action wording...' : 'Restoring separate actions...', 'actions');
    draftWritesInFlight += 1;
    try {
      var payload = await jsonRequest(draftUrl('/restore-combined-actions'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: state.draft.revision })
      });
      activeFinalEdit = null; endUndoGroup(); adoptDraft(payload.draft);
      setStatus(restoringPhase ? 'Original action wording restored.' : 'Separate actions restored.', false, 'actions');
    } catch (error) { setStatus(error.message, true, 'actions'); }
    finally { setBusy(false); endDraftWrite(); }
  }

  document.getElementById('actionsBody').addEventListener('click', function (event) {
    if (event.target.closest('[data-restore-combined-actions]')) restoreCombinedActions();
  });

  async function downloadExport(kind) {
    var isPdf = kind === 'pdf';
    try { await saveDraftNow(); } catch (error) { return setStatus(error.message, true); }
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

  function fetchSavedDraft(draftId, options) {
    return jsonRequest('/api/meeting-minutes-agent/drafts/' + encodeURIComponent(draftId), options);
  }

  async function loadDraft(draftId) {
    setBusy(true, 'Loading your saved draft...');
    try {
      var payload = await fetchSavedDraft(draftId);
      adoptDraft(payload.draft);
      // A draft reopened after a failed run says why, rather than looking idle.
      var failed = state.draft.generation && state.draft.generation.status === 'failed' ? state.draft.generation : null;
      if (failed) setStatus(failed.error || 'The agent could not finish. Try generating again.', true, failed.stage);
      else setStatus('', false);
    }
    catch (error) { setStatus(error.message, true); }
    finally { setBusy(false); }
  }

  /* ------------------------------------------------------------ events */
  // Shown only after the server has persisted the upload. The pending state
  // confirms that server-side processing has started; the ready state is used
  // when the prepared draft is already available to continue reviewing.
  function showUploadConfirmation(fileName, unitCount, preparing, processing, discussionReady) {
    var panel = document.getElementById('uploadConfirmation');
    if (!panel) return;
    var detail = document.getElementById('uploadConfirmationDetail');
    var count = Number(unitCount || 0);
    detail.textContent = discussionReady
      ? 'Discussion is ready. Actions are being prepared.'
      : preparing
      ? 'Uploading the transcript securely...'
      : processing
        ? 'Transcript uploaded — processing has started in the background.'
      : (fileName ? '"' + fileName + '" was read successfully' : 'The transcript was read successfully')
        + (count ? ', with ' + count + ' passage' + (count === 1 ? '' : 's') + ' of speech ready to work from.' : '.');
    var pending = document.getElementById('uploadConfirmationPending');
    var ready = document.getElementById('uploadConfirmationReady');
    if (pending) pending.hidden = !(preparing || processing);
    if (ready) ready.hidden = Boolean(preparing) || Boolean(processing);
    var continueButton = document.getElementById('uploadConfirmationContinue');
    if (continueButton) continueButton.textContent = discussionReady ? 'Review discussion' : 'Check the meeting details';
    panel.hidden = false;
  }

  function hideUploadConfirmation() {
    var panel = document.getElementById('uploadConfirmation');
    if (panel) panel.hidden = true;
  }

  document.getElementById('uploadConfirmationContinue').addEventListener('click', function () {
    hideUploadConfirmation();
    if (stageHasContent('discussion')) {
      showStep(STAGE_STEP.discussion, { scroll: true });
      return;
    }
    var title = document.getElementById('meetingTitle');
    if (title) { title.focus({ preventScroll: true }); title.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  });

  uploadZone.addEventListener('click', function (event) { if (event.target.id !== 'chooseFile') fileInput.click(); });
  document.getElementById('chooseFile').addEventListener('click', function (event) { event.stopPropagation(); fileInput.click(); });
  uploadZone.addEventListener('keydown', function (event) { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); fileInput.click(); } });
  ['dragenter','dragover'].forEach(function (name) { uploadZone.addEventListener(name, function (event) { event.preventDefault(); uploadZone.classList.add('dragover'); }); });
  ['dragleave','drop'].forEach(function (name) { uploadZone.addEventListener(name, function (event) { event.preventDefault(); uploadZone.classList.remove('dragover'); }); });
  uploadZone.addEventListener('drop', function (event) { if (event.dataTransfer && event.dataTransfer.files.length) prepareFile(event.dataTransfer.files[0]); });
  fileInput.addEventListener('change', function () { prepareFile(fileInput.files[0]); });
  async function askToChooseAnotherTranscript() {
    // Make the Library promise in the dialog true before offering to leave.
    // saveDraftNow also reads the active editor, so the latest field is part
    // of the resumable draft rather than only visible in this tab.
    try {
      await saveDraftNow();
      document.getElementById('newTranscriptDialog').showModal();
    } catch (error) {
      setStatus('Save this draft before choosing another transcript. ' + error.message, true, currentStageName());
    }
  }

  document.getElementById('replaceTranscript').addEventListener('click', askToChooseAnotherTranscript);
  document.getElementById('confirmNewTranscript').addEventListener('click', function () {
    document.getElementById('newTranscriptDialog').close('confirm');
    fileInput.value = '';
    fileInput.click();
  });

  detailsEditor.addEventListener('click', function (event) {
    var add = event.target.closest('[data-add-attendee]');
    var move = event.target.closest('[data-move-attendee]');
    var remove = event.target.closest('[data-remove-attendee]');
    if (add) {
      var group = add.dataset.addAttendee;
      if (group === 'client') setClientAttendeeVisibility(true);
      document.getElementById(group + 'Attendees').insertAdjacentHTML('beforeend', attendeeChip('', group));
      var addedInputs = document.querySelectorAll('[data-attendee-name="' + group + '"]');
      if (addedInputs.length) addedInputs[addedInputs.length - 1].focus();
      return;
    }
    if (move) {
      var chip = move.closest('.attendee-chip');
      var input = chip && chip.querySelector('[data-attendee-name]');
      var destination = move.dataset.moveAttendee === 'internal' ? 'client' : 'internal';
      if (destination === 'client') setClientAttendeeVisibility(true);
      document.getElementById(destination + 'Attendees').insertAdjacentHTML('beforeend', attendeeChip(input ? input.value : '', destination));
      chip.remove();
    } else if (remove) {
      var removedChip = remove.closest('.attendee-chip');
      var removedInput = removedChip && removedChip.querySelector('[data-attendee-name]');
      var removedName = removedInput ? removedInput.value.trim() : '';
      removedChip.remove();
    }
    if (move || remove) {
      setClientAttendeeVisibility(attendeeNames('client').length > 0);
      readDetails(); rerenderActions();
      // A named person is undoable from the toast; an empty chip just goes.
      if (remove && removedName) queueReviewDecision(removedLabel(removedName)); else scheduleSave();
    }
  });

  document.getElementById('clientAttendeeLabelSelect').addEventListener('change', function (event) {
    document.getElementById('clientAttendeeHeading').textContent = event.target.value === 'External' ? 'External' : 'Client';
  });
  document.getElementById('mobileStepSelect').addEventListener('change', function (event) {
    var step = Number(event.target.value);
    if (step === MAX_STEP) { readEditors(); activeFinalEdit=null; renderFinal(); }
    showStep(step, { scroll: true, restore: true });
  });
  ['includeObjectives', 'includeSummary'].forEach(function (id) {
    var box = document.getElementById(id);
    if (!box) return;
    box.addEventListener('change', function () {
      if (!state.draft) return;
      var include = includedSectionState();
      include[id === 'includeObjectives' ? 'meetingObjectives' : 'executiveSummary'] = box.checked;
      state.draft.includeSections = include;
      markUndoStep(box.checked ? 'include section' : 'exclude section', '');
      renderIncludedSections();
      renderSummary();
      scheduleSave();
    });
  });

  document.getElementById('startDiscussion').addEventListener('click', function () { readSteer(); requestBackgroundStage('discussion'); });
  document.getElementById('toSummary').addEventListener('click', function () { readActions(); showStep(4, { scroll: true }); });
  document.getElementById('generateSummary').addEventListener('click', function () { requestBackgroundStage('summary', { regenerate: true }); });
  // Redoing a stage is still available, as the secondary thing it is, now that
  // the forward button no longer stops to ask.
  document.getElementById('regenerateDiscussion').addEventListener('click', function () { requestBackgroundStage('discussion', { regenerate: true }); });
  document.getElementById('regenerateActions').addEventListener('click', function () { requestBackgroundStage('actions', { regenerate: true }); });
  document.getElementById('addObjective').addEventListener('click', function () {
    readSummary();
    state.draft.meetingObjectives = (state.draft.meetingObjectives || []).concat({id:'objective-'+Date.now(),text:'',evidenceIds:[]});
    markUndoStep('add objective', '');
    renderSummary();
    var fields = document.querySelectorAll('[data-objective-index]');
    if (fields.length) fields[fields.length - 1].focus();
  });
  document.getElementById('objectivesList').addEventListener('click', function (event) {
    var button = event.target.closest('[data-remove-objective]');
    if (!button) return;
    readSummary();
    var removedObjective = state.draft.meetingObjectives.splice(Number(button.dataset.removeObjective), 1)[0];
    renderSummary();
    queueReviewDecision(removedLabel(typeof removedObjective === 'string' ? removedObjective : removedObjective && removedObjective.text));
  });
  document.getElementById('generateActions').addEventListener('click', function () { requestBackgroundStage('actions'); });
  document.getElementById('regenerationDialog').addEventListener('close', function (event) {
    if (event.target.returnValue !== 'confirm' || !pendingRegenerationStage) { pendingRegenerationStage = ''; return; }
    var stage = pendingRegenerationStage;
    pendingRegenerationStage = '';
    startBackgroundStage(stage);
  });
  document.getElementById('viewGeneratedStage').addEventListener('click', function () {
    var generation = state.draft && state.draft.generation;
    var stage = generation ? generation.stage : completedGenerationNotice && completedGenerationNotice.stage;
    if (stage && STAGE_STEP[stage] != null) showStep(STAGE_STEP[stage], { scroll:true });
  });
  document.getElementById('applyDiscussionEdit').addEventListener('click', function () { var input=document.getElementById('discussionInstruction'); if (!input.value.trim()) return setStatus('Describe the discussion edits you want.',true,'discussion'); runAgent('discussion',input.value.trim()).then(function(ok){if(ok)input.value='';}); });
  document.getElementById('applyActionsEdit').addEventListener('click', function () { var input=document.getElementById('actionsInstruction'); if (!input.value.trim()) return setStatus('Describe the action edits you want.',true,'actions'); runAgent('actions',input.value.trim()).then(function(ok){if(ok)input.value='';}); });
  document.getElementById('addDiscussion').addEventListener('click', function () {
    readDiscussion();
    var topic = {id:'manual-topic-'+Date.now(),topic:'',points:[],decisions:[],openQuestions:[],reviewerAuthored:true};
    state.draft.discussion.push(topic);
    discussionEditorState.pendingTopics[topic.id] = cloneEditorValue(topic);
    markUndoStep('add discussion topic', '');
    renderDiscussion();
    setSaveStatus('New topic is kept in this tab until you add meeting content.', 'local-only');
    var field = document.querySelector('[data-topic-index="' + (state.draft.discussion.length - 1) + '"][data-topic]');
    if (field) field.focus({ preventScroll:true });
  });

  /* ------------------------------------------------------------------ *
   * Reordering discussion records, including between topics.
   * A record keeps its kind when it moves: a decision dropped into another
   * topic is still a decision. Changing kind is what "Move to context" and
   * the add menu are for, and silently converting one on a drop would be a
   * surprise the reviewer did not ask for.
   * ------------------------------------------------------------------ */
  var recordDragFrom = null;

  function clearRecordDropMarks() {
    document.querySelectorAll('.record-row.drop-target,.record-row.is-dragging,.discussion-card.drop-target')
      .forEach(function (node) { node.classList.remove('drop-target', 'is-dragging'); });
  }

  function moveDiscussionRecord(from, to) {
    if (!state.draft || !from || !to) return false;
    var topics = state.draft.discussion || [];
    var source = topics[from.topic] && topics[from.topic][from.field];
    var targetTopic = topics[to.topic];
    if (!source || !targetTopic || !source[from.index]) return false;
    if (from.topic === to.topic && from.field === to.field && to.index === from.index) return false;
    readDiscussion();
    var moved = source.splice(from.index, 1)[0];
    if (!Array.isArray(targetTopic[from.field])) targetTopic[from.field] = [];
    var destination = targetTopic[from.field];
    // Removing the row first, then inserting at the target index, leaves the
    // record exactly at that index. Adjusting for the shift double-counts it.
    var at = to.field === from.field && typeof to.index === 'number' ? to.index : destination.length;
    destination.splice(Math.min(at, destination.length), 0, moved);
    renderDiscussion();
    scheduleSave();
    return true;
  }

  function gripTarget(grip) {
    return { topic: Number(grip.dataset.recordGrip), field: grip.dataset.gripField, index: Number(grip.dataset.gripIndex) };
  }

  function rowTarget(row) {
    return { topic: Number(row.dataset.rowTopic), field: row.dataset.rowField, index: Number(row.dataset.rowIndex) };
  }

  document.getElementById('discussionList').addEventListener('dragstart', function (event) {
    var grip = event.target.closest('[data-record-grip]');
    if (!grip) return;
    recordDragFrom = gripTarget(grip);
    var row = grip.closest('[data-record-row]');
    if (row) row.classList.add('is-dragging');
    if (event.dataTransfer) { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', 'record'); }
  });

  document.getElementById('discussionList').addEventListener('dragover', function (event) {
    if (!recordDragFrom) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    var row = event.target.closest('[data-record-row]');
    var card = event.target.closest('[data-topic-card]');
    document.querySelectorAll('.record-row.drop-target,.discussion-card.drop-target')
      .forEach(function (node) { node.classList.remove('drop-target'); });
    // A row marks the exact position; anywhere else on a card means the end of
    // that topic, which is how a record gets into an empty one.
    if (row) row.classList.add('drop-target');
    else if (card) card.classList.add('drop-target');
  });

  document.getElementById('discussionList').addEventListener('drop', function (event) {
    if (!recordDragFrom) return;
    event.preventDefault();
    var row = event.target.closest('[data-record-row]');
    var card = event.target.closest('[data-topic-card]');
    var from = recordDragFrom;
    recordDragFrom = null;
    clearRecordDropMarks();
    if (row) moveDiscussionRecord(from, rowTarget(row));
    else if (card) {
      var topicIndex = Array.prototype.indexOf.call(document.querySelectorAll('[data-topic-card]'), card);
      if (topicIndex >= 0) moveDiscussionRecord(from, { topic: topicIndex, field: null, index: null });
    }
  });

  document.getElementById('discussionList').addEventListener('dragend', function () {
    recordDragFrom = null;
    clearRecordDropMarks();
  });

  document.getElementById('discussionList').addEventListener('keydown', function (event) {
    var grip = event.target.closest('[data-record-grip]');
    if (!grip) return;
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    // Arrows move a record within its own kind in its own topic; crossing
    // topics without a mouse is what "Move to new topic" already does.
    var from = gripTarget(grip);
    var to = { topic: from.topic, field: from.field, index: from.index + (event.key === 'ArrowUp' ? -1 : 1) };
    var rows = ((state.draft.discussion || [])[from.topic] || {})[from.field] || [];
    if (to.index < 0 || to.index >= rows.length) return;
    if (moveDiscussionRecord(from, to)) {
      var next = document.querySelector('[data-record-grip="' + to.topic + '"][data-grip-field="' + to.field + '"][data-grip-index="' + to.index + '"]');
      if (next) next.focus();
    }
  });

  document.getElementById('discussionScreen').addEventListener('change', function (event) {
    var topicChoice = event.target.closest('[data-unassigned-topic]');
    if (topicChoice) {
      var container = topicChoice.closest('[data-unassigned-supporting-row]');
      container.querySelector('[data-unassigned-new-topic]').hidden = topicChoice.value !== 'new';
      container.querySelector('[data-promote-unassigned]').disabled = !topicChoice.value;
      return;
    }
    var destination = event.target.closest('[data-supporting-destination]');
    if (!destination) return;
    var row = destination.closest('[data-unassigned-supporting-row]');
    var button = row && row.querySelector('[data-file-supporting]');
    if (button) button.disabled = !destination.value;
  });

  document.getElementById('discussionScreen').addEventListener('click', function (event) {
    if (event.target.closest('[data-restore-combined-discussion]')) { restoreCombinedDiscussion(); return; }
    var leaveOut = event.target.closest('[data-leave-out-supporting]');
    var restoreExcluded = event.target.closest('[data-restore-excluded]');
    if (leaveOut || restoreExcluded) {
      readDiscussion();
      var pool = state.draft.unassignedSupportingDetails || [], archived = state.draft.excludedSupportingDetails || [];
      var occurrences = state.draft.filingReview && state.draft.filingReview.occurrences || [];
      if (leaveOut) {
        var index = Number(leaveOut.dataset.leaveOutSupporting), row = leaveOut.closest('[data-unassigned-supporting-row]'), detail = pool[index];
        var key = leaveOut.dataset.optionalKey;
        if (!detail || row.dataset.filingKey !== JSON.stringify(detail) || !occurrences.some(function (entry) { return entry.index === index && entry.key === key; })) { renderDiscussion(); return; }
        if (archived.length >= 500) { setStatus('Restore an optional detail before leaving out another.',true,'discussion'); return; }
        archived = archived.concat([{key:key,record:cloneEditorValue(detail),sources:(state.draft.sourceUnits||[]).filter(function (unit) { return (detail.evidenceIds||[]).indexOf(unit.id)>=0; }).map(cloneEditorValue)}]);pool.splice(index,1);
        occurrences = occurrences.filter(function (entry) { return entry.index !== index; }).map(function (entry) { return {index:entry.index > index ? entry.index-1 : entry.index,key:entry.key}; });
      } else {
        var key = restoreExcluded.dataset.restoreExcluded, entry = archived.find(function (item) { return item.key === key; });
        if (!entry) return;
        pool.push(cloneEditorValue(entry.record));occurrences = occurrences.concat([{index:pool.length-1,key:key}]);
        archived = archived.filter(function (item) { return item.key !== key; });
      }
      state.draft.unassignedSupportingDetails = pool;state.draft.excludedSupportingDetails = archived;
      if (state.draft.filingReview) state.draft.filingReview.occurrences = occurrences;
      markUndoStep(leaveOut ? 'leave optional detail out' : 'restore optional detail','');
      renderDiscussion();renderFlags();scheduleSave();return;
    }
    var promoteUnassigned = event.target.closest('[data-promote-unassigned]');
    var useSuggestion = event.target.closest('[data-use-filing-suggestion]');
    if (promoteUnassigned || useSuggestion) {
      var trigger = promoteUnassigned || useSuggestion;
      var sourceRow = trigger.closest('[data-unassigned-supporting-row]');
      var sourceIndex = Number(promoteUnassigned ? trigger.dataset.promoteUnassigned : trigger.dataset.useFilingSuggestion);
      readDiscussion();
      var sourcePool = state.draft.unassignedSupportingDetails || [], sourceDetail = sourcePool[sourceIndex];
      if (!sourceDetail || sourceRow.dataset.filingKey !== JSON.stringify(sourceDetail)) { renderDiscussion(); return; }
      var destinationTopic, destinationParent, newHeading = '';
      if (useSuggestion) {
        var suggestionState = state.draft.filingReview;
        if (!suggestionState || suggestionState.basis !== window.MeetingMinutesFilingOrder.suggestionBasis(state.draft)) { renderDiscussion(); return; }
        var selectedSuggestion = (suggestionState.suggestions || []).find(function (item) { return item.index === sourceIndex; });
        if (!selectedSuggestion) { renderDiscussion(); return; }
        destinationTopic = state.draft.discussion[selectedSuggestion.topicIndex];
        destinationParent = destinationTopic && (destinationTopic[selectedSuggestion.field] || [])[selectedSuggestion.itemIndex];
        if (!destinationParent) { renderDiscussion(); return; }
      } else {
        var choice = sourceRow.querySelector('[data-unassigned-topic]').value;
        if (choice === 'new') {
          newHeading = sourceRow.querySelector('[data-unassigned-new-topic]').value.trim();
          if (!newHeading) { sourceRow.querySelector('[data-unassigned-new-topic]').focus(); return; }
        } else if (/^\d+$/.test(choice)) destinationTopic = state.draft.discussion[Number(choice)];
        if (!destinationTopic && !newHeading) return;
      }
      var movedDetail = Object.assign({}, uniqueDiscussionDetail(sourceDetail), { reviewerAuthored: true });
      if (sourceDetail.originalTopic || sourceDetail.placementReason) {
        var origin = { id: sourceDetail.id, originalTopic: sourceDetail.originalTopic || '', placementReason: sourceDetail.placementReason || '' };
        var origins = movedDetail.filingOrigins || [];
        if (!origins.some(function (item) { return JSON.stringify(item) === JSON.stringify(origin); })) {
          if (origins.length >= 1000) { setStatus('This detail has too much history to move safely.', true, 'discussion'); return; }
          movedDetail.filingOrigins = origins.concat([origin]);
        }
      }
      delete movedDetail.placementStatus; delete movedDetail.placementReason;
      if (newHeading) {
        destinationTopic = { id: 'manual-topic-' + Date.now(), topic: newHeading, reviewerAuthored: true, points: [], decisions: [], openQuestions: [] };
        state.draft.discussion.push(destinationTopic);
      }
      if (destinationParent) destinationParent.supportingDetails = (destinationParent.supportingDetails || []).concat([movedDetail]);
      else { movedDetail.supportingDetails = movedDetail.supportingDetails || []; destinationTopic.points.push(movedDetail); }
      sourcePool.splice(sourceIndex, 1);
      markUndoStep(destinationParent ? 'file suggested additional detail' : 'move retained detail to discussion', '');
      renderDiscussion(); scheduleSave(); return;
    }
    var fileDetail = event.target.closest('[data-file-supporting]');
    if (fileDetail) {
      if (!state.draft) return;
      var unassignedRow = fileDetail.closest('[data-unassigned-supporting-row]');
      var destination = unassignedRow && unassignedRow.querySelector('[data-supporting-destination]');
      var parts = destination && destination.value.split(':');
      if (!parts || parts.length !== 3 || !/^(points|decisions|openQuestions)$/.test(parts[1])) return;
      readDiscussion();
      var topic = (state.draft.discussion || [])[Number(parts[0])];
      var parent = topic && (topic[parts[1]] || [])[Number(parts[2])];
      var pool = state.draft.unassignedSupportingDetails || [];
      var poolIndex = Number(fileDetail.dataset.fileSupporting);
      var detail = pool[poolIndex];
      if (!parent || !String(parent.text || '').trim() || !detail || unassignedRow.dataset.filingKey !== JSON.stringify(detail)) { renderDiscussion(); return; }
      var filedDetail = Object.assign({}, uniqueDiscussionDetail(detail), { reviewerAuthored: true });
      delete filedDetail.placementStatus;
      delete filedDetail.placementReason;
      parent.supportingDetails = (parent.supportingDetails || []).concat([filedDetail]);
      pool.splice(poolIndex, 1);
      markUndoStep('file additional detail', '');
      renderDiscussion();
      scheduleSave();
      return;
    }
    var toggleAll=event.target.closest('[data-toggle-all-topics]');
    if(toggleAll){
      var collapseAll=toggleAll.dataset.toggleAllTopics==='collapse';
      (state.draft.discussion||[]).forEach(function(topic,index){
        discussionEditorState.collapsedTopics[String(topic.id||('topic-'+index))]=collapseAll;
      });
      readDiscussion();
      renderDiscussion();
      var nextToggle=document.querySelector('[data-toggle-all-topics]');
      if(nextToggle)nextToggle.focus({preventScroll:true});
      return;
    }
    var headingToggle=event.target.closest('[data-toggle-topic-heading]');
    if(headingToggle){
      readDiscussion();
      var headingTopic=state.draft.discussion[Number(headingToggle.dataset.toggleTopicHeading)];
      if(!headingTopic) return;
      headingTopic.hideHeading=!headingTopic.hideHeading;
      markUndoStep(headingTopic.hideHeading?'hide topic title':'show topic title','');
      renderDiscussion();
      scheduleSave();
      return;
    }
    var changeKind=event.target.closest('[data-change-kind]');
    if(changeKind){
      readDiscussion();
      var kindTopic=state.draft.discussion[Number(changeKind.dataset.topicIndex)];
      var kindFrom=changeKind.dataset.recordKind, kindTo=changeKind.dataset.changeKind;
      var kindRecord=kindTopic && (kindTopic[kindFrom]||[]).splice(Number(changeKind.dataset.itemIndex),1)[0];
      if(!kindRecord) return;
      kindRecord.reviewerAuthored=true;
      if(!Array.isArray(kindTopic[kindTo])) kindTopic[kindTo]=[];
      kindTopic[kindTo].push(kindRecord);
      var kindPending=kindRecord.id && discussionEditorState.pendingRecords[kindRecord.id];
      if(kindPending) kindPending.field=kindTo;
      if(discussionRecordHasContent(kindRecord)) markDownstreamStale();
      markUndoStep('change discussion item type','');
      renderDiscussion();
      scheduleSave();
      return;
    }
    var toggle=event.target.closest('[data-toggle-topic]');
    if(toggle){
      var toggleId=toggle.dataset.toggleTopic;
      discussionEditorState.collapsedTopics[toggleId]=!discussionEditorState.collapsedTopics[toggleId];
      renderDiscussion();
      return;
    }
    var add=event.target.closest('[data-add-record]');
    var remove=event.target.closest('[data-remove-record]');
    var demote=event.target.closest('[data-demote-record]');
    var promote=event.target.closest('[data-promote-supporting]');
    var moveNew=event.target.closest('[data-move-record-new-topic]');
    var topicButton=event.target.closest('[data-delete-topic]');
    if(!add && !remove && !demote && !promote && !moveNew && !topicButton) return;
    readDiscussion();
    // Only a change to real content makes the Actions outdated. Adding a blank
    // row, or deleting a row or topic that never had any text, changes nothing
    // the Actions were built from and must not ask for a regeneration.
    var material = Boolean(demote || promote || moveNew);
    var removedReviewContent = false;
    var addedRecord = null;
    var movedTopicIndex = -1;
    if(add){
      var addTopic=state.draft.discussion[Number(add.dataset.topicIndex)];
      addedRecord={id:'manual-'+Date.now(),text:'',evidenceIds:[],reviewFlagIds:[],supportingDetails:[],reviewerAuthored:true};
      addTopic[add.dataset.addRecord].push(addedRecord);
      discussionEditorState.pendingRecords[addedRecord.id]={topicId:addTopic.id,field:add.dataset.addRecord,record:cloneEditorValue(addedRecord)};
    }
    if(remove){
      var removedRecord=state.draft.discussion[Number(remove.dataset.topicIndex)][remove.dataset.removeRecord].splice(Number(remove.dataset.itemIndex),1)[0];
      material = material || discussionRecordHasContent(removedRecord);
      removedReviewContent = discussionRecordHasContent(removedRecord);
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
        target.supportingDetails=(target.supportingDetails||[]).concat([preserveDiscussionMergeHistory(demoted,{id:demoted.id,text:demoted.text,evidenceIds:demoted.evidenceIds||[],reviewFlagIds:demoted.reviewFlagIds||[],reviewerAuthored:true})],demoted.supportingDetails||[]);
        demoteList.splice(Number(demote.dataset.itemIndex),1);
      }
    }
    if(promote){
      var promoteTopic=state.draft.discussion[Number(promote.dataset.topicIndex)];
      var promoteList=promoteTopic && promoteTopic[promote.dataset.parentField];
      var parent=promoteList && promoteList[Number(promote.dataset.itemIndex)];
      var promoted=parent && (parent.supportingDetails||[]).splice(Number(promote.dataset.promoteSupporting),1)[0];
      if(promoted){
        var promotedIdentity=uniqueDiscussionDetail(promoted);
        promoteTopic.points.push(preserveDiscussionMergeHistory(promotedIdentity,{id:promotedIdentity.id,text:promoted.text,evidenceIds:promoted.evidenceIds||[],reviewFlagIds:promoted.reviewFlagIds||[],supportingDetails:promoted.supportingDetails||[],reviewerAuthored:true}));
      }
    }
    if(moveNew){
      var sourceIndex=Number(moveNew.dataset.topicIndex);
      var sourceTopic=state.draft.discussion[sourceIndex];
      var sourceField=moveNew.dataset.moveRecordNewTopic;
      var movedRecord=sourceTopic && (sourceTopic[sourceField]||[]).splice(Number(moveNew.dataset.itemIndex),1)[0];
      if(movedRecord){
        var newTopic={id:'manual-topic-'+Date.now(),topic:'New topic',points:[],decisions:[],openQuestions:[],reviewerAuthored:true};
        newTopic[sourceField].push(movedRecord);
        state.draft.discussion.splice(sourceIndex+1,0,newTopic);
        movedTopicIndex=sourceIndex+1;
      }
    }
    // Removing a topic needs no confirmation: the toast's Undo puts it back.
    if(topicButton){
      var removedTopic=state.draft.discussion.splice(Number(topicButton.dataset.deleteTopic),1)[0];
      material = material || discussionTopicHasContent(removedTopic);
      removedReviewContent = discussionTopicHasContent(removedTopic);
      forgetPendingDiscussion(removedTopic);
      resolveDeletedTargetFlags(linkedReviewFlagIds(removedTopic));
    }
    if(material) markDownstreamStale();
    if (add) markUndoStep('add discussion item', '');
    else if (demote) markUndoStep('move discussion to context', '');
    else if (promote) markUndoStep('include supporting detail', '');
    else if (moveNew) markUndoStep('move discussion to new topic', '');
    renderDiscussion();
    if(movedTopicIndex>=0){
      var movedTopicField=document.querySelector('[data-topic-index="'+movedTopicIndex+'"][data-topic]');
      if(movedTopicField){movedTopicField.focus({preventScroll:true});movedTopicField.select();}
    }
    if(addedRecord){
      rememberPendingDiscussion();
      setSaveStatus('New discussion row is kept in this tab until you enter its text.', 'local-only');
      var addedField=document.getElementById(recordDomId('discussion',addedRecord.id));
      if(addedField){var editor=addedField.querySelector('textarea');if(editor)editor.focus({preventScroll:true});}
      return;
    }
    if (remove && removedReviewContent) queueReviewDecision(removedLabel(removedRecord.text));
    else if (topicButton && removedReviewContent) queueReviewDecision(removedLabel(removedTopic.topic || 'Untitled topic'));
    else { if (remove || topicButton) markUndoStep(remove ? 'remove discussion item' : 'remove discussion topic', ''); scheduleSave(); }
  });

  // The Removed section sits outside the actions table, so it needs its own
  // listener; a click there is the one-step undo for a rejection.
  document.getElementById('removedActionsList').addEventListener('click', function (event) {
    var restoreButton = event.target.closest('[data-restore-action]');
    if (!restoreButton || !state.draft) return;
    readActions();
    var back = removedActions().splice(Number(restoreButton.dataset.restoreAction), 1)[0];
    if (back) {
      var restored = Object.assign({}, back, { reviewerAuthored: true });
      delete restored.removedAt;
      state.draft.actions.push(restored);
      ensureActionOccurrences(state.draft);
    }
    rerenderActions(); queueReviewDecision('Action put back');
  });

  /* ------------------------------------------------------------------ *
   * Reordering actions.
   * The register comes out in the order the passes produced it, which is not
   * always the order the work happens in. Dragging is the obvious gesture, so
   * the handle is the drag source; it also takes ArrowUp/ArrowDown, because a
   * drag-only control cannot be operated from the keyboard at all.
   * ------------------------------------------------------------------ */
  var dragFromIndex = null;

  function moveAction(from, to) {
    if (!state.draft) return false;
    var rows = state.draft.actions || [];
    if (from === to || from < 0 || to < 0 || from >= rows.length || to >= rows.length) return false;
    readActions();
    rows.splice(to, 0, rows.splice(from, 1)[0]);
    markUndoStep('reorder actions', '');
    rerenderActions();
    scheduleSave();
    return true;
  }

  function focusGrip(index) {
    var grip = document.querySelector('[data-action-grip="' + index + '"]');
    if (grip) grip.focus();
  }

  document.getElementById('actionsBody').addEventListener('dragstart', function (event) {
    var grip = event.target.closest('[data-action-grip]');
    if (!grip) return;
    dragFromIndex = Number(grip.dataset.actionGrip);
    var row = grip.closest('[data-action-row]');
    if (row) row.classList.add('is-dragging');
    // Firefox will not start a drag without data on the transfer.
    if (event.dataTransfer) { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(dragFromIndex)); }
  });

  document.getElementById('actionsBody').addEventListener('dragover', function (event) {
    if (dragFromIndex === null) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    var row = event.target.closest('[data-action-row]');
    document.querySelectorAll('.action-row.drop-target').forEach(function (node) { node.classList.remove('drop-target'); });
    if (row && Number(row.dataset.actionRow) !== dragFromIndex) row.classList.add('drop-target');
  });

  document.getElementById('actionsBody').addEventListener('drop', function (event) {
    if (dragFromIndex === null) return;
    event.preventDefault();
    var row = event.target.closest('[data-action-row]');
    var to = row ? Number(row.dataset.actionRow) : null;
    var from = dragFromIndex;
    dragFromIndex = null;
    document.querySelectorAll('.action-row.drop-target,.action-row.is-dragging').forEach(function (node) { node.classList.remove('drop-target', 'is-dragging'); });
    if (to !== null) moveAction(from, to);
  });

  document.getElementById('actionsBody').addEventListener('dragend', function () {
    dragFromIndex = null;
    document.querySelectorAll('.action-row.drop-target,.action-row.is-dragging').forEach(function (node) { node.classList.remove('drop-target', 'is-dragging'); });
  });

  document.getElementById('actionsBody').addEventListener('keydown', function (event) {
    var grip = event.target.closest('[data-action-grip]');
    if (!grip) return;
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    var from = Number(grip.dataset.actionGrip);
    var to = from + (event.key === 'ArrowUp' ? -1 : 1);
    if (moveAction(from, to)) focusGrip(to);
  });

  document.getElementById('actionsBody').addEventListener('click', function (event) {
    var transcriptButton = event.target.closest('[data-open-action-transcript]');
    if (transcriptButton) {
      var transcriptRow = transcriptButton.closest('[data-action-row]');
      var transcriptPanel = transcriptRow && transcriptRow.querySelector('[data-action-transcript-panel]');
      if (transcriptPanel) {
        var opening = !transcriptPanel.open;
        transcriptPanel.open = opening;
        transcriptButton.setAttribute('aria-expanded', opening ? 'true' : 'false');
        var toggleLabel = transcriptButton.querySelector('[data-transcript-toggle-label]');
        if (toggleLabel) toggleLabel.textContent = opening ? 'Hide source' : 'View source';
        closeMenus(null);
        if (opening) transcriptPanel.scrollIntoView({ block: 'nearest' });
      }
      return;
    }
    var editOwners = event.target.closest('[data-edit-owners]');
    if (editOwners) {
      readActions();
      actionEditorState.editingOwners[editOwners.dataset.actionId] = true;
      rerenderActions();
      var ownerSelect = document.querySelector('#actionsBody [data-action-row="' + editOwners.dataset.actionIndex + '"] [data-add-owner]');
      if (ownerSelect) ownerSelect.focus({ preventScroll: true });
      return;
    }
    var editTiming = event.target.closest('[data-edit-timing]');
    if (editTiming) {
      readActions();
      actionEditorState.editingTiming[editTiming.dataset.actionId] = true;
      rerenderActions();
      var timingSelect = document.querySelector('#actionsBody [data-action-row="' + editTiming.dataset.actionIndex + '"] [data-timing-kind]');
      if (timingSelect) timingSelect.focus({ preventScroll: true });
      return;
    }
    var finishOwners = event.target.closest('[data-finish-owner-edit]');
    if (finishOwners) {
      readActions();
      delete actionEditorState.editingOwners[finishOwners.dataset.actionId];
      renderActions(); scheduleSave();
      return;
    }
    var finishTiming = event.target.closest('[data-finish-timing-edit]');
    if (finishTiming) {
      readActions();
      delete actionEditorState.editingTiming[finishTiming.dataset.actionId];
      renderActions(); scheduleSave();
      return;
    }
    var removeOwner = event.target.closest('[data-remove-owner]');
    if (removeOwner) {
      readActions();
      var owned = state.draft.actions[actionIndexForOccurrence(removeOwner.dataset.actionId)];
      if (owned) {
        owned.owners = (owned.owners || []).filter(function (name) { return name !== removeOwner.dataset.owner; });
        owned.reviewerAuthored = true;
      }
      markUndoStep('remove owner', '');
      rerenderActions(); scheduleSave();
      return;
    }
    var keepButton = event.target.closest('[data-keep-action]');
    if (keepButton) {
      readActions();
      var keptElement = keepButton.closest('[data-action-occurrence-id]');
      var keptRow = state.draft.actions[actionIndexForOccurrence(keptElement && keptElement.dataset.actionOccurrenceId)];
      if (keptRow) {
        var wasKept = isActionKept(keptRow);
        var ids = keptActionOccurrenceIds();
        var key = actionOccurrence(keptRow);
        var at = ids.indexOf(key);
        if (at !== -1) ids.splice(at, 1);
        var legacy = unambiguousLegacyActionId(keptRow);
        var legacyAt = legacy ? keptActionIds().indexOf(legacy) : -1;
        if (legacyAt !== -1) keptActionIds().splice(legacyAt, 1);
        if (!wasKept) ids.push(key);
        markUndoStep(wasKept ? 'Action marked as unchecked' : 'Action marked as checked', '');
      }
      rerenderActions(); scheduleSave();
      return;
    }
    var button = event.target.closest('[data-delete-action]') || event.target.closest('[data-reject-action]');
    if (!button) return;
    readActions();
    var removedElement = button.closest('[data-action-occurrence-id]');
    var removedIndex = actionIndexForOccurrence(removedElement && removedElement.dataset.actionOccurrenceId);
    if (removedIndex < 0) return;
    var removedText = state.draft.actions[removedIndex].action;
    removeActionAt(removedIndex);
    renderActions(); queueReviewDecision(removedLabel(removedText));
  });

  // Takes an action out of the list, keeping it under Removed so it can be put
  // back, and closes any review checks that pointed at it.
  function removeActionAt(removedIndex) {
    var actionToRemove = state.draft.actions[removedIndex];
    var removedLegacyId = unambiguousLegacyActionId(actionToRemove);
    var inferredFlagIds = flagsTargetingAction(actionToRemove, removedIndex);
    var removedAction = state.draft.actions.splice(removedIndex,1)[0];
    resolveDeletedTargetFlags(linkedReviewFlagIds(removedAction).concat(inferredFlagIds));
    // Keep the row so it can be put back from the Removed section rather than
    // retyped. Newest first, because the last rejection is the likely undo.
    if (removedAction) removedActions().unshift(Object.assign({}, JSON.parse(JSON.stringify(removedAction)), {
      removedAt: new Date().toISOString()
    }));
    if (removedAction) {
      var removedKey = actionOccurrence(removedAction);
      var keptAt = keptActionOccurrenceIds().indexOf(removedKey);
      if (keptAt !== -1) keptActionOccurrenceIds().splice(keptAt, 1);
      var legacyKeptAt = removedLegacyId ? keptActionIds().indexOf(removedLegacyId) : -1;
      if (legacyKeptAt !== -1) keptActionIds().splice(legacyKeptAt, 1);
      delete actionEditorState.pendingRows[removedKey];
      delete actionEditorState.customOwners[removedKey];
      delete actionEditorState.editingOwners[removedKey];
      delete actionEditorState.editingTiming[removedKey];
    }
    return removedAction;
  }

  // Merging is mechanical: every row moves, in its own kind, and the emptied
  // topic goes. Nothing is inferred, so nothing can be inferred wrongly.
  document.getElementById('discussionList').addEventListener('change', function (event) {
    var select = event.target.closest('[data-merge-topic]');
    if (!select || !select.value) return;
    var from = Number(select.dataset.mergeTopic);
    var into = Number(select.value);
    if (from === into) return;
    // Read the editors first: readDiscussion can replace the array, so every
    // reference has to be taken after it, not before.
    readDiscussion();
    var discussion = (state.draft && state.draft.discussion) || [];
    var source = discussion[from];
    var target = discussion[into];
    if (!source || !target || source === target) return;
    ['points', 'decisions', 'openQuestions'].forEach(function (field) {
      // A row the reviewer is still typing into is held against its topic id.
      // Re-home those rather than forgetting them, or the merge would take an
      // unfinished line with it.
      (source[field] || []).forEach(function (record) {
        var pending = record && record.id && discussionEditorState.pendingRecords[record.id];
        if (pending) pending.topicId = target.id;
      });
      target[field] = (target[field] || []).concat(source[field] || []);
    });
    // The emptied topic must stop being pending, or the next save response
    // restores it and the merge silently undoes itself.
    if (source.id) delete discussionEditorState.pendingTopics[source.id];
    discussion.splice(from, 1);
    renderDiscussion();
    // Same path as any other reviewer decision that changes content: it saves,
    // and it is one undoable step.
    queueReviewDecision('Topics merged');
    setStatus('Merged into "' + (target.topic || 'Untitled topic') + '".', false, 'discussion');
  });

  document.getElementById('discussionListBar').addEventListener('change', function (event) {
    var box = event.target.closest('[data-topic-headings-switch]');
    if (!box || !state.draft) return;
    readDiscussion();
    var include = includedSectionState();
    include.topicHeadings = box.checked;
    state.draft.includeSections = include;
    markUndoStep(box.checked ? 'show topic titles' : 'hide topic titles', '');
    renderDiscussion();
    scheduleSave();
  });

  document.getElementById('discussionList').addEventListener('change', function (event) {
    var select = event.target.closest('[data-move-record-topic]');
    if (!select || !select.value) return;
    var from = { topic: Number(select.dataset.topicIndex), field: select.dataset.moveRecordTopic, index: Number(select.dataset.itemIndex) };
    var into = Number(select.value);
    var target = ((state.draft && state.draft.discussion) || [])[into];
    if (!target || into === from.topic) return;
    var record = (((state.draft.discussion[from.topic] || {})[from.field]) || [])[from.index];
    var pending = record && record.id && discussionEditorState.pendingRecords[record.id];
    if (pending) pending.topicId = target.id;
    // Show where the row went, or it vanishes into a closed card.
    var targetId = String(target.id || ('topic-' + into));
    delete discussionEditorState.collapsedTopics[targetId];
    if (!moveDiscussionRecord(from, { topic: into, field: null, index: null })) return;
    markDownstreamStale();
    markUndoStep('move discussion item', '');
    setStatus('Moved to "' + (target.topic || 'Untitled topic') + '".', false, 'discussion');
  });

  document.getElementById('actionsBody').addEventListener('change', function (event) {
    var select = event.target.closest('[data-add-owner]');
    if (!select || !select.value) return;
    var index = actionIndexForOccurrence(select.dataset.actionId);
    if (index < 0) return;
    if (select.value === '__other') {
      var other = select.parentElement.querySelector('[data-owner-other]');
      actionEditorState.customOwners[select.dataset.actionId] = { visible:true, value:'' };
      select.value = '';
      if (other) { other.hidden = false; other.focus(); }
      setSaveStatus('Custom owner entry is kept in this tab until you finish it.', 'local-only');
      return;
    }
    if (addOwner(index, select.value)) { markUndoStep('add owner', ''); rerenderActions(); scheduleSave(); }
    else select.value = '';
  });

  function commitOtherOwner(input) {
    if (!input) return;
    var actionId = input.dataset.actionId;
    if (!input.value.trim()) {
      delete actionEditorState.customOwners[actionId];
      input.hidden = true;
      return;
    }
    var index = actionIndexForOccurrence(actionId);
    if (index < 0) return;
    var added = addOwner(index, input.value);
    input.value = '';
    delete actionEditorState.customOwners[actionId];
    if (!added) return;
    renderActions();
    // The field this was typed into is hidden again by the re-render, so focus
    // has to be placed deliberately or it falls back to <body> and the tab
    // order restarts at the top of the page.
    var select = document.querySelector('#actionsBody [data-action-row="' + index + '"] [data-add-owner]');
    if (select) select.focus({ preventScroll: true });
    markUndoStep('add owner', '');
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

  document.getElementById('staleStageActions').addEventListener('click', function (event) {
    var button = event.target.closest('[data-update-stale-stage]');
    if (button) requestBackgroundStage(button.dataset.updateStaleStage, { regenerate: true });
  });

  document.getElementById('addAction').addEventListener('click', function () {
    readActions();
    var action = {id:'manual-action-'+Date.now(),action:'',owners:[],timing:{kind:'not_stated',wording:'',exactDate:''},evidenceIds:[],reviewFlagIds:[],reviewerAuthored:true};
    state.draft.actions.push(action);
    ensureActionOccurrences(state.draft);
    actionEditorState.pendingRows[actionOccurrence(action)] = JSON.parse(JSON.stringify(action));
    markUndoStep('add action', '');
    renderActions();
    setSaveStatus('New action row is kept in this tab until you enter the action.', 'local-only');
    var field = document.querySelector('#' + actionDomId(action, state.draft.actions.indexOf(action)) + ' [data-action]');
    if (field) field.focus({ preventScroll:true });
  });

  function findFinalDiscussionRecord(id) {
    for (var topicIndex = 0; topicIndex < (state.draft.discussion || []).length; topicIndex += 1) {
      var topic = state.draft.discussion[topicIndex];
      var topicId = topic.id || 'topic-' + topicIndex;
      for (var fieldIndex = 0; fieldIndex < 3; fieldIndex += 1) {
        var field = ['points','decisions','openQuestions'][fieldIndex];
        var itemIndex = (topic[field] || []).findIndex(function (item, index) { return String(item.id || (topicId+'-'+field+'-'+index)) === String(id); });
        if (itemIndex >= 0) return topic[field][itemIndex];
      }
    }
    return null;
  }

  function finalEditKey(edit) { return edit ? fieldEditKey(edit.kind, edit.id, edit.field) : ''; }
  function editableKeyOf(element) {
    var data = element.dataset;
    return fieldEditKey(data.kind, data.kind === 'action' ? data.actionOccurrenceId || '' : data.recordId || '', data.field);
  }
  function documentEditables() {
    return Array.from(document.querySelectorAll('#documentHeader [data-final-edit], #finalDocument [data-final-edit]')).filter(function (element) {
      return element.offsetParent !== null;
    });
  }
  function findEditable(key) {
    return documentEditables().filter(function (element) { return editableKeyOf(element) === key; })[0] || null;
  }
  function focusEditable(key) {
    var element = key && findEditable(key);
    if (element) element.focus({ preventScroll: true });
  }

  function openFinalEditable(editable) {
    if (!editable || !state.draft || documentReadOnly()) return;
    activeFinalEdit = { kind:editable.dataset.kind,
      id:editable.dataset.kind === 'action' ? editable.dataset.actionOccurrenceId || '' : editable.dataset.recordId || '',
      field:editable.dataset.field };
    if (activeFinalEdit.kind === 'action' && actionIndexForOccurrence(activeFinalEdit.id) < 0) { activeFinalEdit = null; return; }
    if (activeFinalEdit.kind === 'action' && activeFinalEdit.field === 'owners') {
      var action = state.draft.actions[actionIndexForOccurrence(activeFinalEdit.id)];
      activeFinalEdit.ownerSelection = action ? (action.owners || []).slice() : [];
    }
    renderFinal();
  }

  // Drops a just-added empty attendee or objective that was never filled in.
  function discardNewPlaceholder(edit) {
    if (!edit || !edit.isNew || !state.draft) return;
    if (edit.kind === 'attendee') {
      var parts = String(edit.id).split(':');
      var list = (state.draft.details || {})[parts[0] + 'Attendees'] || [];
      if (!String(list[Number(parts[1])] || '').trim()) list.splice(Number(parts[1]), 1);
    } else if (edit.kind === 'action') {
      var placeholderIndex = actionIndexForOccurrence(edit.id);
      if (placeholderIndex >= 0 && !String(state.draft.actions[placeholderIndex].action || '').trim()) state.draft.actions.splice(placeholderIndex, 1);
    } else if (edit.kind === 'objective') {
      state.draft.meetingObjectives = (state.draft.meetingObjectives || []).filter(function (item) {
        return !(item && typeof item === 'object' && item.id === edit.id && !String(item.text || '').trim());
      });
    }
  }

  function cancelFinalEdit(options) {
    if (!activeFinalEdit) return;
    var edit = activeFinalEdit;
    discardNewPlaceholder(edit);
    activeFinalEdit = null;
    renderFinal();
    if (!hasTransientEditorState() && !saveInFlight && !savePending && !pendingGenerationEdits && !draftWritesInFlight
      && document.getElementById('saveStatus').dataset.state === 'local-only') setSaveStatus(savedStatusText(state.draft.updatedAt), 'saved');
    if (!options || options.focus !== false) focusEditable(finalEditKey(edit));
  }

  // Clicking away keeps what was typed; an untouched field simply closes.
  function finalEditChanged() {
    var editor = document.querySelector('#finalDocument [data-final-editor], #documentHeader [data-final-editor]');
    if (!editor) return false;
    var control = editor.querySelector('[data-final-editor-value]');
    if (!control || editor.dataset.original == null) return true;
    return control.value.trim() !== String(editor.dataset.original).trim();
  }

  // Applies a change made directly in the document: keeps the step screens in
  // step with it and saves straight away with an undoable label.
  function commitDocumentChange(label) {
    activeFinalEdit = null;
    renderDetails(); renderDiscussion(); renderActions(); renderSummary(); renderFinal();
    queueReviewDecision(label);
  }

  function applyFinalEdit(options) {
    options = options || {};
    if (!activeFinalEdit || !state.draft) return false;
    var edit = activeFinalEdit;
    var editor = document.querySelector('#finalDocument [data-final-editor], #documentHeader [data-final-editor]');
    if (!editor) return false;
    var valueControl = editor.querySelector('[data-final-editor-value]');
    var value = valueControl ? valueControl.value.trim() : '';
    if (valueControl && editor.dataset.original != null && value === String(editor.dataset.original).trim() && !edit.isNew) {
      cancelFinalEdit(options);
      return false;
    }
    var label = 'Final minutes updated';
    var editedKey = finalEditKey(edit);
    var removed = false;
    if (edit.kind === 'details') {
      // A title is required: clearing it keeps the previous one.
      if (edit.field === 'meetingTitle' && !value) { cancelFinalEdit(options); return false; }
      state.draft.details[edit.field] = value;
      label = edit.field === 'meetingTitle' ? 'Meeting title edited' : edit.field === 'meetingDate' ? 'Meeting date edited' : 'Meeting location edited';
    } else if (edit.kind === 'attendee') {
      var attendeeParts = String(edit.id).split(':');
      var attendees = state.draft.details[attendeeParts[0] + 'Attendees'] || (state.draft.details[attendeeParts[0] + 'Attendees'] = []);
      var attendeeIndex = Number(attendeeParts[1]);
      var previousName = String(attendees[attendeeIndex] || '');
      if (!value) {
        if (edit.isNew) { cancelFinalEdit(options); return false; }
        attendees.splice(attendeeIndex, 1);
        label = removedLabel(previousName); removed = true;
      } else {
        attendees[attendeeIndex] = value;
        // An owner who was renamed keeps owning their actions.
        if (previousName) (state.draft.actions || []).forEach(function (action) {
          action.owners = (action.owners || []).map(function (owner) { return owner === previousName ? value : owner; });
        });
        label = edit.isNew ? 'Attendee added' : 'Attendee renamed';
        editedKey = fieldEditKey('attendee', value, 'name');
      }
      state.draft.details.allAttendees = (state.draft.details.internalAttendees || []).concat(state.draft.details.clientAttendees || []).filter(Boolean);
    } else if (edit.kind === 'topic') {
      var topic = (state.draft.discussion || []).find(function (item, index) { return String(item.id || 'topic-'+index) === String(edit.id); });
      if (!topic || !value) { cancelFinalEdit(options); return false; }
      if (topic.topic !== value) topic.reviewerAuthored = true;
      topic.topic = value; label = 'Topic heading edited';
    } else if (edit.kind === 'discussion') {
      var record = findFinalDiscussionRecord(edit.id);
      if (!record || !value) { cancelFinalEdit(options); return false; }
      if (record.text !== value) record.reviewerAuthored = true;
      record.text = value; label = 'Meeting sentence edited';
    } else if (edit.kind === 'objective') {
      var objectiveIndex = (state.draft.meetingObjectives || []).findIndex(function (item, index) { return String(typeof item === 'string' ? 'objective-'+index : item.id) === String(edit.id); });
      if (objectiveIndex < 0) return false;
      var objective = state.draft.meetingObjectives[objectiveIndex];
      if (!value) {
        // Saving an empty objective removes it.
        if (edit.isNew) { cancelFinalEdit(options); return false; }
        state.draft.meetingObjectives.splice(objectiveIndex, 1);
        label = removedLabel(typeof objective === 'string' ? objective : objective.text); removed = true;
      } else {
        state.draft.meetingObjectives[objectiveIndex] = typeof objective === 'string' ? value : Object.assign({}, objective, {text:value});
        label = edit.isNew ? 'Meeting objective added' : 'Meeting objective edited';
      }
    } else if (edit.kind === 'summary') {
      if (!value) { cancelFinalEdit(options); return false; }
      state.draft.executiveSummary = value; label = 'Executive summary edited';
    } else if (edit.kind === 'action') {
      var action = state.draft.actions[actionIndexForOccurrence(edit.id)];
      if (!action) return false;
      var previousAction = actionEditFingerprint(action);
      if (edit.field === 'action') {
        if (!value) { cancelFinalEdit(options); return false; }
        action.action = value; label = edit.isNew ? 'Action added' : 'Action edited';
      } else if (edit.field === 'owners') {
        action.owners = (edit.ownerSelection || action.owners || []).slice();
        label = 'Action owners edited';
      } else if (edit.field === 'timing') {
        action.timing = editedTiming(action,
          editor.querySelector('[data-final-timing-kind]').value,
          editor.querySelector('[data-final-timing-wording]').value.trim(),
          editor.querySelector('[data-final-timing-date]'));
        label = 'Action timing edited';
      }
      if (previousAction === actionEditFingerprint(action)) { cancelFinalEdit(options); return false; }
      action.reviewerAuthored = true;
    }
    if (!removed) markFieldEdited.apply(null, editedKey.split('|'));
    // saveDraftNow reads the hidden stage editors before sending. Refresh them
    // so an edit made on the final document cannot be replaced by stale fields.
    commitDocumentChange(label);
    if (options.focus !== false) focusEditable(editedKey);
    return true;
  }

  // Tab saves and moves to the next piece of text (Shift+Tab, the previous).
  function moveToAdjacentEditable(key, direction) {
    var list = documentEditables();
    var at = list.findIndex(function (element) { return editableKeyOf(element) === key; });
    var next = at >= 0 ? list[at + direction] : null;
    if (next) openFinalEditable(next);
  }

  function removeDocumentRecord(spec) {
    var parts = String(spec).split('|');
    var topic = state.draft.discussion[Number(parts[0])];
    var list = topic && topic[parts[1]];
    var removedRecord = list && list.splice(Number(parts[2]), 1)[0];
    if (!removedRecord) return;
    forgetPendingDiscussion(removedRecord);
    resolveDeletedTargetFlags(linkedReviewFlagIds(removedRecord));
    if (discussionRecordHasContent(removedRecord)) markDownstreamStale();
    commitDocumentChange(removedLabel(removedRecord.text));
  }

  function onDocumentEditClick(event) {
    var target;
    if (onDocumentPickerClick(event)) return true;
    if ((target = event.target.closest('[data-doc-keep-action]'))) {
      closeMenus();
      var keptRow = state.draft.actions[actionIndexForOccurrence(target.dataset.docKeepAction)];
      if (!keptRow) return true;
      var wasKept = isActionKept(keptRow);
      var ids = keptActionOccurrenceIds();
      var keyAt = ids.indexOf(actionOccurrence(keptRow));
      if (keyAt !== -1) ids.splice(keyAt, 1);
      var legacy = unambiguousLegacyActionId(keptRow);
      var legacyAt = legacy ? keptActionIds().indexOf(legacy) : -1;
      if (legacyAt !== -1) keptActionIds().splice(legacyAt, 1);
      if (!wasKept) ids.push(actionOccurrence(keptRow));
      commitDocumentChange(wasKept ? 'Action marked as not reviewed' : 'Action marked as reviewed');
      return true;
    }
    if ((target = event.target.closest('[data-doc-add-action]'))) {
      var newAction = {id:'manual-action-'+Date.now(),action:'',owners:[],timing:{kind:'not_stated',wording:'',exactDate:''},evidenceIds:[],reviewFlagIds:[],reviewerAuthored:true};
      state.draft.actions.push(newAction);
      ensureActionOccurrences(state.draft);
      activeFinalEdit = { kind:'action', id:actionOccurrence(newAction), field:'action', isNew:true };
      renderFinal();
      return true;
    }
    if ((target = event.target.closest('[data-doc-remove-record]'))) { closeMenus(); removeDocumentRecord(target.dataset.docRemoveRecord); return true; }
    if ((target = event.target.closest('[data-doc-remove-action]'))) {
      closeMenus();
      var actionIndex = actionIndexForOccurrence(target.dataset.docRemoveAction);
      if (actionIndex < 0) return true;
      var removedText = state.draft.actions[actionIndex].action;
      removeActionAt(actionIndex);
      commitDocumentChange(removedLabel(removedText));
      return true;
    }
    if ((target = event.target.closest('[data-doc-remove-topic]'))) {
      closeMenus();
      var removedTopic = state.draft.discussion.splice(Number(target.dataset.docRemoveTopic), 1)[0];
      if (!removedTopic) return true;
      forgetPendingDiscussion(removedTopic);
      resolveDeletedTargetFlags(linkedReviewFlagIds(removedTopic));
      if (discussionTopicHasContent(removedTopic)) markDownstreamStale();
      commitDocumentChange(removedLabel(removedTopic.topic || 'Untitled topic'));
      return true;
    }
    if ((target = event.target.closest('[data-doc-topic-move]'))) {
      closeMenus();
      var from = Number(target.dataset.docTopicMove), to = from + Number(target.dataset.dir);
      var topics = state.draft.discussion;
      if (!topics[from] || !topics[to]) return true;
      var moved = topics.splice(from, 1)[0];
      topics.splice(to, 0, moved);
      commitDocumentChange('Moved “' + (moved.topic || 'Untitled topic') + '” ' + (to < from ? 'up' : 'down'));
      return true;
    }
    if ((target = event.target.closest('[data-doc-topic-heading]'))) {
      closeMenus();
      var headingTopic = state.draft.discussion[Number(target.dataset.docTopicHeading)];
      if (!headingTopic) return true;
      headingTopic.hideHeading = !headingTopic.hideHeading;
      commitDocumentChange(headingTopic.hideHeading ? 'Topic title hidden' : 'Topic title shown');
      return true;
    }
    if ((target = event.target.closest('[data-doc-remove-attendee]'))) {
      var removeParts = target.dataset.docRemoveAttendee.split(':');
      var removeList = state.draft.details[removeParts[0] + 'Attendees'] || [];
      var removedName = removeList.splice(Number(removeParts[1]), 1)[0];
      state.draft.details.allAttendees = (state.draft.details.internalAttendees || []).concat(state.draft.details.clientAttendees || []);
      commitDocumentChange(removedLabel(removedName));
      return true;
    }
    if ((target = event.target.closest('[data-doc-attendee-move]'))) {
      var moveParts = target.dataset.docAttendeeMove.split(':');
      var destination = moveParts[0] === 'internal' ? 'client' : 'internal';
      var source = state.draft.details[moveParts[0] + 'Attendees'] || [];
      var movedName = source.splice(Number(moveParts[1]), 1)[0];
      (state.draft.details[destination + 'Attendees'] || (state.draft.details[destination + 'Attendees'] = [])).push(movedName);
      commitDocumentChange('Moved ' + movedName + ' to ' + attendeeGroupLabel(destination, state.draft.details).toLowerCase() + ' attendees');
      var toggle = Array.from(document.querySelectorAll('[data-doc-attendee-move^="' + destination + ':"]')).pop();
      if (toggle) toggle.focus({ preventScroll: true });
      return true;
    }
    if ((target = event.target.closest('[data-doc-add-attendee]'))) {
      var group = target.dataset.docAddAttendee;
      var groupList = state.draft.details[group + 'Attendees'] || (state.draft.details[group + 'Attendees'] = []);
      groupList.push('');
      activeFinalEdit = { kind:'attendee', id:group + ':' + (groupList.length - 1), field:'name', isNew:true };
      renderFinal();
      return true;
    }
    if ((target = event.target.closest('[data-doc-add-objective]'))) {
      var objectiveId = 'objective-new-' + Date.now();
      state.draft.meetingObjectives = (state.draft.meetingObjectives || []).concat([{ id:objectiveId, text:'' }]);
      activeFinalEdit = { kind:'objective', id:objectiveId, field:'text', isNew:true };
      renderFinal();
      return true;
    }
    return false;
  }

  function onFinalDocumentClick(event) {
    var removeOwner = event.target.closest('[data-final-remove-owner]');
    if (removeOwner && activeFinalEdit && activeFinalEdit.field === 'owners') {
      activeFinalEdit.ownerSelection = (activeFinalEdit.ownerSelection || []).filter(function (owner) {
        return owner.toLowerCase() !== removeOwner.dataset.finalRemoveOwner.toLowerCase();
      });
      renderFinal();
      return;
    }
    var editable = event.target.closest('[data-final-edit]');
    if (editable) { openFinalEditable(editable); return; }
    if (event.target.closest('[data-final-cancel]')) { cancelFinalEdit(); return; }
    if (event.target.closest('[data-final-save]')) { applyFinalEdit(); return; }
    if (state.draft && inDocumentMode() && !documentReadOnly()) onDocumentEditClick(event);
  }
  // The document header (title, date, location) edits the same way as the body.
  document.getElementById('finalDocument').addEventListener('click', onFinalDocumentClick);
  document.getElementById('documentHeader').addEventListener('click', function (event) {
    if (event.target.closest('[data-final-edit],[data-final-cancel],[data-final-save]')) onFinalDocumentClick(event);
  });
  document.getElementById('documentHeader').addEventListener('change', function (event) {
    var select = event.target.closest('[data-doc-meeting-type]');
    if (!select || !state.draft) return;
    state.draft.details.meetingType = meetingTypeValue(select.value);
    commitDocumentChange('Meeting type changed');
  });
  document.getElementById('finalDocument').addEventListener('change', function (event) {
    if (state.draft && inDocumentMode()) onDocumentPickerChange(event);
  });
  document.getElementById('finalDocument').addEventListener('keydown', function (event) {
    if (event.key !== 'Enter') return;
    if (event.target.matches('[data-owner-new]')) { event.preventDefault(); addNewOwner(event.target.dataset.occ); }
    else if (event.target.matches('[data-due-text]')) { event.preventDefault(); saveDueText(event.target.dataset.occ, event.target.dataset.dueText); }
  });
  // A picker closed by Esc or a click elsewhere stays closed on the next render.
  document.getElementById('finalDocument').addEventListener('toggle', function (event) {
    var picker = event.target;
    if (!picker.matches || !picker.matches('[data-picker]') || picker.open) return;
    if (docPickerOpen === picker.dataset.picker) docPickerOpen = '';
    var occ = picker.dataset.picker.replace(/^due:/, '');
    if (picker.dataset.picker.indexOf('due:') === 0) { delete docDueMode[occ]; delete docDueMode[occ + ':custom']; }
  }, true);
  document.getElementById('finalDocument').addEventListener('input', function (event) {
    if (event.target.matches('textarea[data-final-editor-value]')) fitFinalTextarea(event.target);
  });
  // Clicking outside an open field saves it (or just closes it when nothing
  // changed). Clicking another piece of text opens that one straight away.
  document.addEventListener('pointerdown', function (event) {
    if (!activeFinalEdit || !state.draft) return;
    if (event.target.closest('[data-final-editor], .final-editor-row, #sideDrawer, #undoToast')) return;
    if (!document.querySelector('#finalDocument [data-final-editor], #documentHeader [data-final-editor]')) return;
    var target = event.target.closest('[data-final-edit]');
    var nextKey = target ? editableKeyOf(target) : '';
    if (finalEditChanged()) applyFinalEdit({ focus: false }); else cancelFinalEdit({ focus: false });
    if (nextKey) {
      var next = findEditable(nextKey);
      if (next) { event.preventDefault(); openFinalEditable(next); }
    }
  }, true);

  document.getElementById('finalDocument').addEventListener('change', function (event) {
    var headings = event.target.closest('[data-doc-topic-headings]');
    if (headings && state.draft) {
      var include = includedSectionState();
      include.topicHeadings = headings.checked;
      state.draft.includeSections = include;
      commitDocumentChange(headings.checked ? 'Topic titles shown' : 'Topic titles hidden');
      return;
    }
    var select = event.target.closest('[data-final-add-owner]');
    if (!select || !select.value || !activeFinalEdit || activeFinalEdit.field !== 'owners') return;
    var selected = activeFinalEdit.ownerSelection || (activeFinalEdit.ownerSelection = []);
    var additions = select.value === '__all' ? participantNames() : [select.value];
    additions.forEach(function (name) {
      if (!selected.some(function (owner) { return owner.toLowerCase() === name.toLowerCase(); })) selected.push(name);
    });
    renderFinal();
  });

  // One set of keys for every field: Esc cancels, Cmd/Ctrl+Enter saves, Enter
  // saves a single-line field, Tab saves and moves to the next field.
  function onFinalDocumentKeydown(event) {
    if (!activeFinalEdit) return;
    if (event.key === 'Escape') { event.preventDefault(); cancelFinalEdit(); return; }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); applyFinalEdit(); return; }
    var inValue = event.target.matches('[data-final-editor-value]');
    if (event.key === 'Enter' && !event.shiftKey && inValue && event.target.tagName === 'INPUT') { event.preventDefault(); applyFinalEdit(); return; }
    if (event.key === 'Tab' && inValue) {
      event.preventDefault();
      var key = finalEditKey(activeFinalEdit);
      applyFinalEdit({ focus: false });
      // A new attendee saved by Tab is followed by its own toggle, not the next field.
      moveToAdjacentEditable(key, event.shiftKey ? -1 : 1);
    }
  }
  document.getElementById('finalDocument').addEventListener('keydown', onFinalDocumentKeydown);
  document.getElementById('documentHeader').addEventListener('keydown', onFinalDocumentKeydown);

  document.getElementById('editStructureToggle').addEventListener('click', function () {
    setEditStructure(!editStructureOn() || !documentReady() ? true : false);
  });

  document.addEventListener('click', function (event) {
    var update = event.target.closest('[data-update-stale-stage]');
    if (update && !update.closest('#staleStageActions')) { requestBackgroundStage(update.dataset.updateStaleStage, { regenerate: true }); return; }
    var dismiss = event.target.closest('[data-dismiss-stale]');
    if (dismiss) { setStaleDismissed(dismiss.dataset.dismissStale, true); renderStaleNotice(); if (state.currentStep === MAX_STEP) renderFinal(); return; }
    if (event.target.closest('[data-dismiss-final-hint]')) {
      try { window.localStorage.setItem('mma-final-hint-dismissed', '1'); } catch (error) { /* private mode */ }
      var hint = document.querySelector('[data-final-hint]');
      if (hint) hint.remove();
      return;
    }
    if (event.target.closest('[data-doc-edit-structure]')) { closeMenus(null); setEditStructure(true); return; }
    if (event.target.closest('[data-doc-choose-transcript]')) { closeMenus(null); askToChooseAnotherTranscript(); return; }
    var regenerate = event.target.closest('[data-regenerate-section]');
    if (regenerate) { closeMenus(null); requestBackgroundStage(regenerate.dataset.regenerateSection, { regenerate: true }); }
  });

  function finaliseNow() {
    document.body.classList.remove('doc-preview');
    if (editStructureOn()) setEditStructure(false);
    document.getElementById('saveMinutes').click();
  }
  // Finalise never blocks: with open items it asks once, in the drawer.
  document.getElementById('finaliseMinutes').addEventListener('click', function () {
    if (documentReady() && openCheckItems().total > 0) {
      if (editStructureOn()) setEditStructure(false);
      openChecksDrawer('finalise');
      return;
    }
    finaliseNow();
  });
  document.getElementById('sideDrawer').addEventListener('click', function (event) {
    var target;
    if (event.target.closest('[data-finalise-anyway]')) { closeDrawer(); finaliseNow(); return; }
    if (event.target.closest('[data-review-first]')) {
      checksDrawerMode = 'checks'; refreshChecksDrawer();
      var first = document.querySelector('#sideDrawerBody .checks-group:not([hidden]) button');
      if (first) first.focus({ preventScroll: true });
      return;
    }
    if ((target = event.target.closest('[data-fix-owner],[data-fix-due]'))) {
      if (!leaveDocumentPreview()) return;
      var owner = target.hasAttribute('data-fix-owner');
      var occ = owner ? target.dataset.fixOwner : target.dataset.fixDue;
      closeDrawer();
      docPickerOpen = (owner ? 'owner:' : 'due:') + occ;
      renderFinal();
      var picker = document.querySelector('[data-picker="' + docPickerOpen + '"]');
      if (picker) {
        picker.closest('tr').scrollIntoView({ block: 'center' });
        var control = picker.querySelector('[data-menu-popover] button, [data-menu-popover] input');
        if (control) control.focus({ preventScroll: true });
      }
      return;
    }
    if ((target = event.target.closest('[data-fix-detail]'))) {
      if (!leaveDocumentPreview()) return;
      closeDrawer();
      var field = target.dataset.fixDetail;
      if (field === 'attendees') { var add = document.querySelector('[data-doc-add-attendee="internal"]'); if (add) { add.scrollIntoView({ block: 'center' }); add.click(); } return; }
      var editable = findEditable(fieldEditKey('details', 'meeting-details', field));
      if (editable) { editable.scrollIntoView({ block: 'center' }); openFinalEditable(editable); }
    }
  });
  document.getElementById('copyDraftLink').addEventListener('click', async function () {
    var link = window.location.origin + window.location.pathname + '?draftId=' + encodeURIComponent((state.draft && state.draft.draftId) || '');
    try { await navigator.clipboard.writeText(link); setSaveStatus('Link copied', 'saved'); }
    catch (error) { window.prompt('Copy this link', link); }
  });
  document.getElementById('reopenMinutes').addEventListener('click', async function () {
    try {
      await saveDraftNow('draft');
      document.body.classList.remove('doc-preview', 'doc-finalised');
      renderFinalSaveState(); renderDocumentMode(); renderFinal(); updateFinishingBar();
      setStatus('Reopened for editing.', false, 'review');
    } catch (error) { setStatus(error.message, true, 'review'); }
  });

  function openReviewTarget(targetButton) {
    // In the document, a check scrolls to and pulses its item; the drawer stays open.
    if (inDocumentMode() && targetButton.dataset.viewFlagTarget) {
      var card = targetButton.closest('[data-review-flag-id]');
      var flag = card && (state.draft.reviewFlags || []).filter(function (item) { return item.id === card.dataset.reviewFlagId; })[0];
      if (flag) leaveDocumentPreview();
      var inDocument = flag && documentElementForFlag(flag);
      if (inDocument) { pulseInDocument(inDocument); return; }
      closeDrawer();
    }
    var elementId = targetButton.dataset.viewReviewTarget || targetButton.dataset.viewFlagTarget || targetButton.dataset.viewCoverageAction;
    // Until the checks point into the document itself, a check that lives on
    // a step screen opens the structure view at that item.
    if (targetButton.dataset.targetStep !== undefined && inDocumentMode() && Number(targetButton.dataset.targetStep) !== MAX_STEP) {
      structureStep = Number(targetButton.dataset.targetStep);
      setEditStructure(true);
    }
    if (targetButton.dataset.targetStep !== undefined) showStep(Number(targetButton.dataset.targetStep), { scroll:true });
    window.setTimeout(function () {
        var target = document.getElementById(elementId);
        if (!target) return;
        var topicCard = target.closest('.discussion-card');
        if (topicCard && topicCard.classList.contains('is-collapsed')) {
          var toggle = topicCard.querySelector('[data-toggle-topic]');
          if (toggle) toggle.click();
          target = document.getElementById(elementId);
          if (!target) return;
        }
        // The jump to the item replaces the step's own landing position; without
        // this the autosave that follows the step change scrolls back to the top.
        for (var ancestor = target.parentElement; ancestor; ancestor = ancestor.parentElement) {
          if (ancestor.tagName === 'DETAILS') ancestor.open = true;
        }
        clearStepNavigationScroll();
        target.scrollIntoView({behavior:'smooth',block:'center'});
        target.classList.add('flag-target-highlight');
        var selector = targetButton.dataset.targetSelector || 'textarea,input';
        var editor = target.matches(selector) ? target : target.querySelector(selector);
        if (editor && targetButton.dataset.targetSelector === '[data-edit-timing]') {
          editor.click();
          target = document.getElementById(target.id);
          editor = target.querySelector('[data-timing-date]');
        }
        if (editor && targetButton.dataset.targetSelector === '[data-edit-owners]') {
          editor.click();
          target = document.getElementById(target.id);
          editor = target.querySelector('[data-add-owner]');
        }
        if (editor) editor.focus({preventScroll:true});
        window.setTimeout(function () { target.classList.remove('flag-target-highlight'); }, 2400);
    }, 0);
  }

  document.getElementById('flagList').addEventListener('click', function (event) {
    var comparisonButton = event.target.closest('[data-view-coverage-action]');
    if (comparisonButton) {
      openReviewTarget(comparisonButton);
      return;
    }
    var targetButton = event.target.closest('[data-view-flag-target]');
    if (targetButton) {
      openReviewTarget(targetButton);
      return;
    }
    var identical = event.target.closest('[data-confirm-identical-flags]');
    if (identical) {
      var ids; try { ids = JSON.parse(identical.dataset.confirmIdenticalFlags); } catch (error) { return; }
      if (!Array.isArray(ids) || ids.length < 2 || new Set(ids).size !== ids.length) return;
      var flags = state.draft.reviewFlags || [], selected = ids.map(function (id) { return flags.filter(function (flag) { return flag.id === id; }); });
      if (selected.some(function (matches) { return matches.length !== 1; })) return;
      selected = selected.map(function (matches) { return matches[0]; });
      if (selected.some(function (flag) { return identicalReviewKey(flag) !== identical.dataset.identicalReviewKey || !reviewTargetKey(flag) || reviewTargetKey(flag) !== identical.dataset.identicalReviewTarget; })) return;
      var pendingNote = flags.some(function (flag) { var index = flags.indexOf(flag), input = document.querySelector('[data-flag-correction="' + index + '"]'); return input && input.value.trim() !== (flag.correctionNote || '').trim(); });
      if (pendingNote) { setStatus('Save your individual review notes before checking these together.', true, currentStageName()); return; }
      selected.forEach(function (flag) { flag.status = 'confirmed'; });
      renderFlags(); queueReviewDecision('Identical source checks reviewed together'); return;
    }
    var button=event.target.closest('[data-flag-index]'); if(!button)return; var index=Number(button.dataset.flagIndex); var note=document.querySelector('[data-flag-correction="'+index+'"]'); state.draft.reviewFlags[index].status=button.dataset.flagStatus; if(note)state.draft.reviewFlags[index].correctionNote=note.value.trim(); renderFlags(); var decisionLabel=button.dataset.flagStatus==='dismissed'?'Review item marked not needed':button.dataset.flagStatus==='corrected'?'Review note saved and item resolved':'Review item resolved'; queueReviewDecision(decisionLabel);
  });
  document.getElementById('openFinalReview').addEventListener('click', function () { readEditors(); activeFinalEdit=null; renderFinal(); showStep(MAX_STEP, { scroll: true }); setStatus('Review the complete minutes. Click any sentence, owner or date to edit it here.',false,'review'); });
  document.getElementById('reviewQueueToggle').addEventListener('click', function () {
    if (inDocumentMode()) {
      if (checksDrawerOpen() && checksDrawerMode === 'checks') closeDrawer(); else openChecksDrawer('checks');
      return;
    }
    var panel = document.getElementById('reviewFlags');
    panel.open = !panel.open;
    updateReviewQueueSummary();
    if (panel.open) panel.scrollIntoView({ block: 'nearest' });
  });

  document.getElementById('previewDocument').addEventListener('click', function () {
    if (documentReady() && editStructureOn()) setEditStructure(false);
    if (inDocumentMode()) {
      // In the document, Preview shows the minutes read-only with Download.
      readEditors(); activeFinalEdit = null;
      document.body.classList.toggle('doc-preview');
      renderFinal(); updateFinishingBar();
      return;
    }
    if(state.currentStep===MAX_STEP){showStep(previewReturnStep,{scroll:true});return;}
    readEditors();previewReturnStep=state.currentStep;activeFinalEdit=null;renderFinal();showStep(MAX_STEP,{scroll:true});
  });
  document.getElementById('downloadDraft').addEventListener('click', function () {
    if (!draftDownloadReadiness().ready) return;
    downloadExport('docx');
  });
  document.getElementById('undoLastDecision').addEventListener('click', undoLastReviewDecision);
  document.getElementById('redoLastDecision').addEventListener('click', redoLastReviewDecision);
  document.getElementById('undoToastButton').addEventListener('click', undoLastReviewDecision);
  document.getElementById('saveMinutes').addEventListener('click', async function () {
    var button = document.getElementById('saveMinutes');
    button.disabled = true;
    button.innerHTML = icon('save') + 'Saving final minutes…';
    setStatus('Saving the final minutes and marking this transcript Complete in Library…', false, 'review');
    try {
      await saveDraftNow('complete');
      renderFinalSaveState();
      if (documentReady()) { closeDrawer(); renderFinal(); updateFinishingBar(); }
      setStatus('Final minutes saved. This transcript is marked Complete in Library.', false, 'review');
      document.getElementById('finalSaveConfirmation').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } catch (error) {
      renderFinalSaveState();
      setStatus(error.message, true, 'review');
    }
  });
  document.getElementById('reloadDraft').addEventListener('click', function () {
    if (!state.draft) return;
    if (this.dataset.progressCheck === 'true' && generationRunning()) {
      this.hidden = true;
      delete this.dataset.progressCheck;
      pollGeneration(true);
      return;
    }
    loadDraft(state.draft.draftId);
  });
  document.getElementById('downloadWord').addEventListener('click', function () { downloadExport('docx'); });
  document.getElementById('downloadPdf').addEventListener('click', function () { downloadExport('pdf'); });
  document.getElementById('printMinutes').addEventListener('click', function () { window.print(); });
  document.getElementById('newMinutes').addEventListener('click', askToChooseAnotherTranscript);
  document.querySelectorAll('[data-back]').forEach(function(button){button.addEventListener('click',function(){showStep(button.dataset.back, { scroll: true, restore: true });});});
  document.querySelectorAll('[data-step]').forEach(function(button){button.addEventListener('click',function(){if(!button.disabled){if(Number(button.dataset.step)===MAX_STEP){readEditors();activeFinalEdit=null;renderFinal();}showStep(button.dataset.step, { scroll: true, restore: true });}});});

  // Once the reviewer scrolls on their own, the step's landing position is no
  // longer theirs to be returned to: an autosave re-render in the next few
  // seconds must keep them where they have scrolled to.
  function releaseNavigationScrollOnUserScroll(event) {
    if (navigationScrollStep === null) return;
    if (event.type === 'keydown' && (!/^(PageUp|PageDown|Home|End|ArrowUp|ArrowDown| )$/.test(event.key)
      || event.target.matches('input,textarea,select,[contenteditable="true"]'))) return;
    clearStepNavigationScroll();
  }
  ['wheel', 'touchmove', 'keydown'].forEach(function (type) {
    document.addEventListener(type, releaseNavigationScrollOnUserScroll, { passive: true });
  });

  document.addEventListener('focusin', function (event) {
    if (navigationScrollStep !== state.currentStep) return;
    if (event.target.matches('input,textarea,select,button,summary,[role="button"]') && event.target.closest('[data-screen].active')) {
      clearStepNavigationScroll();
    }
  });

  document.addEventListener('input', function (event) {
    if (!state.draft || rendering) return;
    if (event.target.matches('[data-timing-date],[data-final-timing-date]')) event.target.dataset.dateEdited = 'true';
    // These controls commit through their own Save/Add action. A response to an
    // earlier save must not rebuild them while their next entry is being typed.
    if (event.target.closest('[data-final-editor]') || event.target.matches('[data-owner-new],[data-due-text]')) {
      editVersion += 1;
      setSaveStatus('Finish the current entry to save it.', 'local-only');
      return;
    }
    // Inclusion is a document-output choice. It does not alter the meeting
    // evidence or discussion content, so it must not mark downstream Actions
    // as stale merely because the checkboxes live inside Details.
    if (!event.target.matches('#includeObjectives,#includeSummary')
      && (event.target.closest('#discussionList') || event.target.closest('#detailsEditor') || event.target.id === 'meetingSteer')) {
      markDownstreamStale();
    }
    if (event.target.matches('[data-owner-other]')) {
      actionEditorState.customOwners[event.target.dataset.actionId] = { visible:true, value:event.target.value };
      setSaveStatus('Custom owner entry is kept in this tab until you finish it.', 'local-only');
      return;
    }
    if (event.target.matches('textarea,input,select') && !event.target.closest('[data-final-editor]') && !event.target.matches('#includeEvidence,#transcriptFile,#mobileStepSelect,[data-add-owner],[data-owner-other],[data-supporting-destination],[data-unassigned-topic],[data-unassigned-new-topic]')) {
      markUndoStep(undoLabelForField(event.target), undoGroupKeyForField(event.target));
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
    if (!mustKeepTabOpen(saveState)) return;
    // Only a dirty, idle draft can attempt a final keepalive save. A request
    // already in flight may be cancelled on close; a failed save, a pending
    // operation or an unfinished row needs the browser's leave warning.
    if (saveState !== 'dirty' || saveInFlight || draftWritesInFlight || pendingGenerationEdits || hasTransientEditorState()) {
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

  window.addEventListener('pagehide', function () {
    clearTimeout(generationTimer);
    clearTimeout(prewarmTimer);
    if (generationPollController) generationPollController.abort();
  });

  document.addEventListener('visibilitychange', function () {
    clearTimeout(generationTimer);
    clearTimeout(prewarmTimer);
    if (document.hidden) {
      if (generationPollController) generationPollController.abort();
      return;
    }
    if (!state.draft) return;
    if (generationRunning()) pollGeneration(true);
    else pollActionPrewarm(true);
  });

  betaAccessReady = initialiseBetaFlow();
  var requestedDraft = new URLSearchParams(window.location.search).get('draftId');
  if (requestedDraft) loadDraft(requestedDraft); else renderAll();
})();
