(function () {
  'use strict';

  var state = { draft: null, currentStep: 0 };
  var agentRetryDelaysSeconds = [5, 15, 30];
  // 0 details, 1 (retired: focus), 2 discussion, 3 actions, 4 summary, 5 review
  // Index 1 is left reserved so drafts saved under the six-step numbering still
  // resolve to the right screen.
  var MAX_STEP = 5;
  var STAGE_STEP = { details: 0, focus: 1, discussion: 2, actions: 3, summary: 4, review: 5 };
  var GENERATION_POLL_MS = 1000;
  var generationTimer = null;
  var prewarmTimer = null;
  var completedGenerationNotice = null;
  var saveTimer = null;
  var savePending = false;
  var saveInFlight = null;
  var saveQueued = false;
  var pendingGenerationEdits = false;
  var actionsInvalidatedDuringGeneration = false;
  var generationPollKey = '';
  var navigationScrollStep = null;
  var navigationScrollToken = 0;
  var navigationScrollTimer = null;
  var navigationScrollRestore = false;
  var actionEditorState = { pendingRows: {}, customOwners: {}, editingOwners: {}, editingTiming: {} };
  var discussionEditorState = { pendingTopics: {}, pendingRecords: {}, collapsedTopics: {} };
  var pendingReviewDecisionLabel = '';
  var undoToastTimer = null;
  var activeFinalEdit = null;
  var previewReturnStep = 4;
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
    // The save strip is the one place that says whether the tab is safe to
    // close. The generation panel used to mirror it, which put the same
    // sentence on screen twice while a stage was running.
  }

  function setSaveStatus(message, kind) {
    var element = document.getElementById('saveStatus');
    if (mustKeepTabOpen(kind) && message && !/tab open/i.test(message)) message += ' Keep this tab open until it saves.';
    var strip = document.getElementById('saveStrip');
    strip.hidden = !state.draft;
    strip.dataset.state = kind || '';
    element.textContent = message || '';
    element.dataset.state = kind || '';
    refreshLeaveSafety();
    updateFinishingBar();
  }

  function updateFinishingBar() {
    if (!state.draft) return;
    // Both controls name the change they act on, so the reviewer can tell what
    // is about to happen before pressing them.
    var undo = document.getElementById('undoLastDecision');
    if (undo) {
      undo.hidden = !state.draft.lastUndo;
      undo.textContent = state.draft.lastUndo ? 'Undo: ' + state.draft.lastUndo.label : 'Undo';
      undo.title = state.draft.lastUndo ? 'Undo: ' + state.draft.lastUndo.label : '';
    }
    var redo = document.getElementById('redoLastDecision');
    if (redo) {
      redo.hidden = !state.draft.lastRedo;
      redo.textContent = state.draft.lastRedo ? 'Redo: ' + state.draft.lastRedo.label : 'Redo';
      redo.title = state.draft.lastRedo ? 'Redo: ' + state.draft.lastRedo.label : '';
    }
    var preview = document.getElementById('previewDocument');
    if (preview) {
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
  }

  function showUndoToast(label) {
    var toast = document.getElementById('undoToast');
    var message = document.getElementById('undoToastMessage');
    if (!toast || !message) return;
    clearTimeout(undoToastTimer);
    message.textContent = (label || 'Review decision') + '. ';
    toast.hidden = false;
    undoToastTimer = window.setTimeout(function () { toast.hidden = true; }, 10000);
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
    pendingReviewDecisionLabel = String(label || 'Change').slice(0, 160);
  }

  // Anything that is not typing closes the current group, so the next
  // keystroke starts a fresh step rather than joining the previous one.
  function endUndoGroup() {
    undoGroup = { key: '', at: 0 };
  }

  function queueReviewDecision(label) {
    endUndoGroup();
    pendingReviewDecisionLabel = String(label || 'Review decision').slice(0, 160);
    editVersion += 1;
    setSaveStatus('Saving review decision...', 'saving');
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

  function hasTransientEditorState() {
    return hasTransientActionState() || hasTransientDiscussionState();
  }

  // An empty row is a placeholder, not unsaved work: it is worth saying it
  // lives only in this tab, but not in three different sentences.
  var EMPTY_ROW_NOTICE = 'Empty rows stay in this tab until you type into them.';

  function generationSaveText(running) {
    if (pendingGenerationEdits) return 'Your edits save as soon as generation finishes. Keep this tab open until then.';
    if (hasTransientEditorState()) return EMPTY_ROW_NOTICE;
    return 'Everything is saved. You can close the tab' + (running === false ? '.' : ' - generation carries on without it.');
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
        var heading = screen.querySelector('h2') || screen;
        if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
        heading.focus({ preventScroll: true });
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
    return '<div class="attendee-chip"><input data-attendee-name="' + group + '" value="' + escapeHtml(name || '') + '" aria-label="' + (group === 'internal' ? 'Internal' : 'Client or external') + ' attendee name" placeholder="Enter a name"><button class="secondary attendee-move" data-move-attendee="' + group + '" type="button" aria-label="Move ' + escapeHtml(name || 'attendee') + ' to ' + destination + '"><span class="move-long">Move to ' + destination + '</span><span class="move-short">Move</span></button><button class="delete icon-only" data-remove-attendee type="button" aria-label="' + escapeHtml(removeLabel) + '" title="' + escapeHtml(removeLabel) + '">' + icon('trash') + '<span class="visually-hidden">' + escapeHtml(removeLabel) + '</span></button></div>';
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
      return '<div class="evidence-row' + (unit.cited ? ' cited' : '') + '"><div class="source-meta">'
        + '<span class="source-speaker">' + escapeHtml(unit.speaker || 'Unknown speaker') + '</span>'
        + (unit.timestamp ? '<span class="source-time">' + escapeHtml(unit.timestamp) + '</span>' : '')
        + '<span class="source-id">' + escapeHtml(unit.id) + '</span>'
        + (unit.cited ? '' : '<span class="source-kind">surrounding context</span>')
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

  function recordMenu(record, actions) {
    var sourceLabel = recordNeedsReview(record) ? 'Check transcript' : 'View transcript';
    var ownerKey = String((record && record.id) || '');
    return '<details class="record-menu"><summary class="secondary quiet" aria-label="Item options">•••</summary><div class="record-menu-popover"><span class="record-menu-label">' + sourceLabel + '</span>' + evidenceBlock(record.evidenceIds, ownerKey) + actions + '</div></details>';
  }

  function autoGrow(root) {
    (root || document).querySelectorAll('textarea').forEach(function (area) {
      area.style.height = 'auto';
      var compact = area.matches('[data-record-field],[data-action],[data-objective-index],[data-topic]');
      area.style.height = Math.max(area.scrollHeight, compact ? 36 : 52) + 'px';
    });
  }

  function actionTranscriptId(actionId, index) {
    return recordDomId('action-transcript', actionId, index);
  }

  // Where the reviewer was on each screen. Stepping out to the preview and
  // back used to land them at the top of a list they were halfway down.
  var stepScrollMemory = Object.create(null);

  function showStep(index, options) {
    var leavingStep = state.currentStep;
    state.currentStep = Math.max(0, Math.min(MAX_STEP, Number(index) || 0));
    if (leavingStep !== state.currentStep) stepScrollMemory[leavingStep] = window.scrollY;
    // A draft saved on the retired Focus step has nowhere to land; send it on
    // to Discussion rather than showing an empty screen.
    if (state.currentStep === 1) state.currentStep = 2;
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
    // Deliberate navigation is persisted independently from the furthest unlocked
    // step. During generation scheduleSave holds it until the background write is
    // complete, so reopening the draft returns to the screen the reviewer chose.
    if (!rendering && stepChanged && !(options && options.persist === false)) scheduleSave();
    // Deliberate navigation goes to the beginning of the newly opened section.
    // Autosave normally preserves the reader's position, but while this move is
    // settling it must not restore the position from the previous section.
    if (options && options.scroll) beginStepNavigationScroll(options.restore);
    renderGenerationProgress();
    updateFinishingBar();
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
    var generation = state.draft && state.draft.generation;
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
      ? (stage === 'actions' ? 'Preparing actions' : stage === 'discussion' ? 'Preparing discussion' : 'Preparing summary…')
      : (stage === 'actions' ? 'Actions are ready' : 'Generation complete');
    document.getElementById('generationProgressMessage').textContent = generation
      ? stage === 'summary' ? '' : friendlyGenerationMessage(generation.message, stage)
      : (notice.message || 'The completed draft is ready to review.');
    if (generation && STAGE_STEP[stage] === state.currentStep) status.hidden = true;
    var started = generation && new Date(generation.startedAt).getTime();
    var elapsed = started && !Number.isNaN(started) ? Math.max(0, Math.floor((Date.now() - started) / 1000)) : 0;
    document.getElementById('generationElapsed').textContent = generation
      ? 'Elapsed ' + Math.floor(elapsed / 60) + ':' + String(elapsed % 60).padStart(2, '0') + ' · ' + typicalDurationText(stage, elapsed)
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

  function renderStaleNotice() {
    var notice = document.getElementById('staleNotice');
    if (!notice || !state.draft) return;
    var stale = state.draft.staleStages || [];
    notice.hidden = !stale.length;
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
    if (!state.draft) return;
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
  }

  function backgroundWorkPreparing() {
    if (!state.draft) return false;
    var speculation = state.draft.speculation;
    var prewarm = state.draft.actionsPrewarm;
    return Boolean((speculation && speculation.status === 'preparing') || (prewarm && prewarm.status === 'preparing'));
  }

  // A stage reports ready a moment before it is written into the draft, so
  // stopping the poll the instant it turns ready would miss that write and
  // leave this tab a revision behind. Keep polling for a short while after -
  // bounded, because a superseded result never lands at all.
  var backgroundSettlePolls = 0;
  var BACKGROUND_SETTLE_POLLS = 10;

  function pollActionPrewarm() {
    clearTimeout(prewarmTimer);
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
    }, GENERATION_POLL_MS);
  }

  // Reaching an empty Summary screen is itself the request to prepare the
  // summary. Speculation can make that faster, but generation must not depend
  // on a private speculative result existing: disabled, failed or expired
  // speculation previously left the screen blank until a manual click.
  function maybeOpenPreparedSummary() {
    if (!state.draft || state.currentStep !== STAGE_STEP.summary || rendering) return;
    var draftId = String(state.draft.draftId || '');
    if (generationRunning() || autoSummaryStartedForDraft === draftId) return;
    if (String(state.draft.executiveSummary || '').trim()) return;
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
    return { meetingObjectives: raw.meetingObjectives !== false, executiveSummary: raw.executiveSummary !== false };
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
      return '<div class="record-row"><textarea data-objective-index="' + index + '" rows="1" aria-label="Objective ' + (index + 1) + '">' + escapeHtml(objectiveText) + '</textarea><div class="record-tools"><button class="delete quiet" data-remove-objective="' + index + '" type="button">Remove</button></div></div>';
    }).join('') || '<p class="muted record-empty">None yet. Generate them, or add one by hand.</p>';
    var generate = document.getElementById('generateSummary');
    generate.hidden = summaryRunning;
    generate.textContent = (draft.executiveSummary || objectives.length) ? 'Regenerate summary' : 'Create summary';
    autoGrow(document.getElementById('summaryFields'));
  }

  function renderPageHeading() {
    var title = document.getElementById('pageTitle');
    if (!title) return;
    var details = state.draft && state.draft.details;
    title.textContent = state.draft && details && String(details.meetingTitle || '').trim()
      ? details.meetingTitle.trim() : 'Meeting Minutes Agent';
  }

  function readDetails() {
    if (!state.draft) return {};
    var internalAttendees = attendeeNames('internal');
    var clientAttendees = attendeeNames('client');
    state.draft.details = {
      meetingTitle: document.getElementById('meetingTitle').value.trim(),
      meetingDate: document.getElementById('meetingDate').value,
      meetingLocation: document.getElementById('meetingLocation').value.trim(),
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
    setFieldValue('meetingLocation', details.meetingLocation || '');
    setMeetingTypeField(details.meetingType || '');
    renderAttendeeGroup('internal', details.internalAttendees || []);
    renderAttendeeGroup('client', details.clientAttendees || []);
    setFieldValue('clientAttendeeLabelSelect', details.clientAttendeeLabel === 'External' ? 'External' : 'Client');
    document.getElementById('clientAttendeeHeading').textContent = details.clientAttendeeLabel === 'External' ? 'External' : 'Client';
  }

  var DEFAULT_MEETING_LOCATION = 'Microsoft Teams';

  async function prepareFile(file) {
    if (!file) return;
    if (!/\.docx$/i.test(file.name)) return setStatus('Choose a Word .docx transcript.', true);
    var form = new FormData(); form.append('file', file);
    setBusy(true, 'Reading the Word document and preparing the transcript...');
    try {
      var payload = await jsonRequest('/api/meeting-minutes-agent/prepare', { method: 'POST', body: form });
      adoptDraft(payload.draft);
      // Trinzo meetings are held on Teams, so a fresh upload starts there. Only
      // on upload: a location the reviewer later clears stays cleared.
      if (!String((state.draft.details || {}).meetingLocation || '').trim()) {
        document.getElementById('meetingLocation').value = DEFAULT_MEETING_LOCATION;
        readDetails(); scheduleSave();
      }
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
    return '';
  }

  function omittedDetailsPanel(discussion) {
    var labels = { points: 'Discussion', decisions: 'Decision', openQuestions: 'Open question' };
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
    var count = grouped.reduce(function (total, group) { return total + group.rows.length; }, 0);
    if (!count) return '';
    return '<details id="omittedDetailsPanel" class="omitted-details-panel" data-keep-open="omitted-details"><summary class="omitted-details-summary">Review omitted details (' + count + ')</summary><div class="omitted-details-body"><p class="muted omitted-details-intro">These details were left out of the draft. Check whether anything should be included.</p><div class="omitted-topic-list">' + grouped.map(function (group) {
      return '<section class="omitted-topic"><h3>' + escapeHtml(group.topic.topic || 'Untitled topic') + '</h3><div class="omitted-detail-list">' + group.rows.map(function (row) {
        var detailId = row.detail.id || (group.topicIndex + '-' + row.field + '-' + row.itemIndex + '-' + row.detailIndex);
        return '<article class="omitted-detail" id="' + escapeHtml(recordDomId('supporting', detailId, detailId)) + '"><div class="omitted-detail-copy"><span class="omitted-detail-kind">' + escapeHtml(labels[row.field]) + '</span><p>' + escapeHtml(row.detail.text || '') + '</p></div><div class="omitted-detail-actions"><button class="secondary compact" data-promote-supporting="' + row.detailIndex + '" data-parent-field="' + row.field + '" data-topic-index="' + group.topicIndex + '" data-item-index="' + row.itemIndex + '" type="button">Add to minutes</button>' + evidenceBlock(row.detail.evidenceIds, String(detailId)) + '</div></article>';
      }).join('') + '</div></section>';
    }).join('') + '</div></div></details>';
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

  function discussionPropositions(topic, topicIndex) {
    var labels = { points: 'Discussion', decisions: 'Decision', openQuestions: 'Open question' };
    var rows = ['points', 'decisions', 'openQuestions'].flatMap(function (field) {
      return (topic[field] || []).map(function (item, itemIndex) { return {field:field,item:item,itemIndex:itemIndex}; });
    });
    return '<div class="record-section proposition-section"><div class="record-list proposition-list">' + (rows.map(function (row) {
      var label = labels[row.field];
      var targetId = recordDomId('discussion', row.item.id, topicIndex + '-' + row.field + '-' + row.itemIndex);
      var actions = (rows.length > 1 ? '<button class="secondary quiet" data-demote-record="' + row.field + '" data-topic-index="' + topicIndex + '" data-item-index="' + row.itemIndex + '" type="button">Move to context</button>' : '') + '<button class="secondary quiet" data-move-record-new-topic="' + row.field + '" data-topic-index="' + topicIndex + '" data-item-index="' + row.itemIndex + '" type="button">Move to new topic</button><button class="delete quiet" data-remove-record="' + row.field + '" data-topic-index="' + topicIndex + '" data-item-index="' + row.itemIndex + '" type="button">Remove</button>';
      var grip = '<button type="button" class="record-grip" draggable="true"'
        + ' data-record-grip="' + topicIndex + '" data-grip-field="' + row.field + '" data-grip-index="' + row.itemIndex + '"'
        + ' aria-label="Reorder this ' + escapeHtml(label.toLowerCase()) + '. Drag, or use the arrow keys."'
        + ' title="Drag to reorder or move to another topic"><svg class="ic" aria-hidden="true"><use href="#i-grip"/></svg></button>';
      return '<div id="' + escapeHtml(targetId) + '" class="record-row proposition-row" data-record-row data-row-topic="' + topicIndex + '" data-row-field="' + escapeHtml(row.field) + '" data-row-index="' + row.itemIndex + '">' + grip + '<div class="proposition-kind ' + escapeHtml(row.field) + '">' + escapeHtml(label) + '</div><textarea rows="1" data-record-field="' + row.field + '" data-topic-index="' + topicIndex + '" data-item-index="' + row.itemIndex + '" aria-label="' + escapeHtml(label) + '">' + escapeHtml(row.item.text || '') + '</textarea>' + recordMenu(row.item, actions) + '</div>';
    }).join('') || '<p class="muted record-empty">No meeting content recorded.</p>') + '</div>' + topicSupportingDetails(topic, topicIndex) + '</div>';
  }

  function recordAddMenu(topicIndex) {
    return '<details class="record-add-menu"><summary class="secondary compact record-add-toggle" aria-label="Add item" title="Add item"><svg class="ic" aria-hidden="true"><use href="#i-plus"/></svg></summary><div class="record-add-options"><button class="secondary compact" data-add-record="points" data-topic-index="' + topicIndex + '" type="button">Add discussion</button><button class="secondary compact" data-add-record="decisions" data-topic-index="' + topicIndex + '" type="button">Add decision</button><button class="secondary compact" data-add-record="openQuestions" data-topic-index="' + topicIndex + '" type="button">Add open question</button></div></details>';
  }

  function renderDiscussion() {
    if (generationRunning('discussion')) {
      document.getElementById('omittedDetailsReview').innerHTML = '';
      document.getElementById('discussionList').innerHTML = '<div class="generation-skeleton" aria-hidden="true"><span></span><span></span><span></span></div>';
      return;
    }
    var discussion = (state.draft && state.draft.discussion) || [];
    document.getElementById('omittedDetailsReview').innerHTML = omittedDetailsPanel(discussion);
    document.getElementById('discussionList').innerHTML = discussion.map(function (topic, index) {
      var topicId = String(topic.id || ('topic-' + index));
      var collapsed = Boolean(discussionEditorState.collapsedTopics[topicId]);
      var rows = ['points','decisions','openQuestions'].reduce(function (total, field) { return total + (topic[field] || []).length; }, 0);
      var flagIds = new Set(linkedReviewFlagIds(topic));
      var checks = ((state.draft && state.draft.reviewFlags) || []).filter(function (flag) { return flag.status === 'open' && flagIds.has(flag.id); }).length;
      var meta = rows + ' item' + (rows === 1 ? '' : 's') + (checks ? ' · ' + checks + ' to review' : '');
      return '<article id="' + escapeHtml(recordDomId('topic', topicId, index)) + '" class="discussion-card' + (collapsed ? ' is-collapsed' : '') + (rows === 1 ? ' is-single' : '') + '" data-topic-card="' + escapeHtml(topicId) + '"><div class="card-head"><button class="topic-collapse" data-toggle-topic="' + escapeHtml(topicId) + '" type="button" aria-expanded="' + String(!collapsed) + '" aria-label="' + (collapsed ? 'Expand' : 'Collapse') + ' topic"><span aria-hidden="true">›</span></button><label class="topic-field"><textarea rows="1" data-topic-index="' + index + '" data-topic aria-label="Discussion topic" placeholder="Topic">' + escapeHtml(topic.topic || '') + '</textarea><small class="topic-count">' + escapeHtml(meta) + '</small></label>' + recordAddMenu(index) + '<details class="topic-menu"><summary class="secondary quiet" aria-label="Topic actions">•••</summary><div class="topic-menu-popover">' + mergeTopicControl(discussion, index) + '<button class="delete quiet" data-delete-topic="' + index + '" type="button">Remove topic</button></div></details></div><div class="discussion-card-body"' + (collapsed ? ' hidden' : '') + '>' + discussionPropositions(topic, index) + '</div></article>';
    }).join('') || '<p class="muted">No discussion content has been generated.</p>';
    autoGrow(document.getElementById('discussionList'));
    restoreDisclosures(document.getElementById('omittedDetailsReview'));
    restoreDisclosures(document.getElementById('discussionList'));
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
    var actionId = String(action.id || ('action-' + index));
    var editing = Boolean(actionEditorState.editingOwners[actionId]);
    if (!editing) {
      return '<button type="button" class="field-display owner-summary" data-edit-owners data-action-index="' + index + '" data-action-id="' + escapeHtml(actionId) + '" aria-label="Edit owners">' + escapeHtml(owners.join(', ') || 'No owner assigned') + '</button>';
    }
    var taken = owners.map(function (owner) { return owner.toLowerCase(); });
    var available = participantNames().filter(function (name) { return taken.indexOf(name.toLowerCase()) < 0; });
    var chips = owners.map(function (owner) {
      return '<span class="owner-chip" data-owner-chip data-action-index="' + index + '" data-owner="' + escapeHtml(owner) + '">' + escapeHtml(owner) + '<button type="button" data-remove-owner data-action-index="' + index + '" data-owner="' + escapeHtml(owner) + '" aria-label="Remove owner ' + escapeHtml(owner) + '">&times;</button></span>';
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
    var options = kinds.map(function (pair) {
      return '<option value="' + pair[0] + '"' + (timing.kind === pair[0] ? ' selected' : '') + '>' + pair[1] + '</option>';
    }).join('');
    return '<div class="timing-editor"><select data-timing-kind data-action-index="' + index + '" aria-label="Timing type">' + options + '</select><label hidden><span>Original wording</span><input data-timing-wording data-action-index="' + index + '" value="' + escapeHtml(timing.wording || '') + '" placeholder="e.g. this week" aria-label="Original timing wording"></label><label class="timing-date-field"><input data-timing-date data-action-index="' + index + '" type="date" value="' + escapeHtml(timing.exactDate || '') + '" aria-label="Exact date"></label><button type="button" class="secondary quiet compact" data-finish-timing-edit data-action-id="' + escapeHtml(actionId) + '">Done</button></div>';
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
        ? 'You can start reading these while the final quality checks continue. Editing unlocks when the final version is ready.'
        : prior.length
          ? 'These saved actions remain visible while a refreshed version is prepared.'
          : 'Possible actions will appear here as soon as the evidence check finishes.';
      var readOnlyRows = function (items, className) { return items.map(function (item) {
        return '<tr class="preview-action-row ' + className + '"><td data-label="Action"><div>' + escapeHtml(item.action || '') + '</div><div class="action-tools">' + evidenceBlock(item.evidenceIds) + '</div></td><td data-label="Owners"><div class="preview-action-meta">' + escapeHtml((item.owners || []).join(', ') || 'Not stated') + '</div></td><td data-label="Timing"><div class="preview-action-meta">' + escapeHtml(timingDisplayText(item.timing)) + '</div></td></tr>';
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
      var transcriptId = actionTranscriptId(item.id, index);
      var transcriptKey = disclosureKey(item.evidenceIds, 'action-transcript:' + (item.id || index));
      var menu = recordMenu(item, '<button class="delete quiet" data-delete-action="' + index + '" type="button">Remove from minutes</button>');
      var kept = isActionKept(item.id);
      // The textarea is always editable, so a separate Edit control would do
      // nothing a click in the field does not already do.
      var decisions = '<div class="row-decisions">'
        + '<button type="button" class="quiet row-transcript" data-open-action-transcript="' + index + '" aria-controls="' + escapeHtml(transcriptId) + '" aria-expanded="false">View transcript</button>'
        + '<button type="button" class="quiet row-keep' + (kept ? ' is-kept' : '') + '" data-keep-action="' + index + '" aria-pressed="' + (kept ? 'true' : 'false') + '">' + (kept ? 'Checked' : 'Mark checked') + '</button>'
        + '<button type="button" class="quiet row-reject" data-reject-action="' + index + '">Remove from minutes</button>'
        + '</div>';
      var transcriptPanel = '<details id="' + escapeHtml(transcriptId) + '" class="action-transcript-panel" data-action-transcript-panel data-keep-open="' + escapeHtml(transcriptKey) + '"><summary class="visually-hidden">Transcript passage</summary><div class="evidence-panel">' + evidenceHtml(item.evidenceIds) + '</div></details>';
      // Reordering: the handle is the drag source and also takes arrow keys, so
      // the order can be changed without a mouse.
      var grip = '<button type="button" class="action-grip" data-action-grip="' + index + '" draggable="true"'
        + ' aria-label="Reorder action ' + (index + 1) + '. Drag, or use the arrow keys."'
        + ' title="Drag to reorder"><svg class="ic" aria-hidden="true"><use href="#i-grip"/></svg></button>';
      return '<tr id="' + escapeHtml(targetId) + '" class="action-row' + (kept ? ' action-kept' : '') + '" data-action-row="' + index + '" data-action-id="' + escapeHtml(item.id || '') + '"><td data-label="Action"><div class="action-main">' + grip + '<textarea rows="1" data-action-index="' + index + '" data-action aria-label="Action ' + (index + 1) + '">' + escapeHtml(item.action || '') + '</textarea>' + menu + '</div>' + decisions + transcriptPanel + '</td><td data-label="Owners">' + ownerEditor(item, index) + '</td><td data-label="Timing">' + timingEditor(timing, index, item.id) + '</td></tr>';
    }).join('') || '<tr><td colspan="3" class="muted">No actions returned. Check the transcript for commitments.</td></tr>';
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

  function isActionKept(id) {
    return Boolean(id) && keptActionIds().indexOf(id) !== -1;
  }

  function renderActionReview() {
    var bar = document.getElementById('actionReviewBar');
    var panel = document.getElementById('removedActionsPanel');
    if (!bar || !panel || !state.draft) return;
    var actions = state.draft.actions || [];
    var removed = removedActions();
    var checked = actions.filter(function (item) { return isActionKept(item.id); }).length;
    var undecided = Math.max(0, actions.length - checked);
    var proposal = state.draft.pendingProposal;
    var proposed = proposal && Array.isArray(proposal.changes)
      ? proposal.changes.filter(function (change) { return change && change.type === 'add'; }).length
      : 0;
    bar.hidden = !actions.length && !removed.length;
    bar.innerHTML = '<span class="review-count review-count-open"><strong>' + actions.length + '</strong> action' + (actions.length === 1 ? '' : 's') + ' · <strong>' + undecided + '</strong> unchecked · <strong>' + proposed + '</strong> suggestion' + (proposed === 1 ? '' : 's') + '</span>';

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
      var ownerChips = row.querySelectorAll('[data-owner-chip]');
      if (ownerChips.length) action.owners = Array.from(ownerChips).map(function (chip) { return chip.dataset.owner; }).filter(Boolean);
      var kind = row.querySelector('[data-timing-kind]');
      var wording = row.querySelector('[data-timing-wording]');
      var date = row.querySelector('[data-timing-date]');
      if (kind) action.timing = { kind: kind.value, wording: wording ? wording.value.trim() : '', exactDate: date ? date.value : '' };
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
              label: 'Supporting context',
              text: detail.text || '',
              field: 'text'
            };
          }
        }
      }
    }
    for (var actionIndex = 0; actionIndex < (state.draft.actions || []).length; actionIndex += 1) {
      var action = state.draft.actions[actionIndex];
      if ((action.reviewFlagIds || []).indexOf(flagId) >= 0) return {
        stage: 3,
        elementId: recordDomId('action', action.id, actionIndex),
        label: 'Action',
        text: action.action || '',
        field: flag.kind === 'timing' ? 'timing' : flag.kind === 'ownership' ? 'owners' : 'action'
      };
    }
    // A missed-content warning can describe an Action that deliberately has
    // not entered the register yet. Route to the pending suggestion instead of
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
    var inferred = inferredActionForFlag(flag);
    if (inferred) return {
      stage: 3,
      elementId: recordDomId('action', inferred.action.id, inferred.index),
      label: inferred.field === 'timing' ? 'Action timing' : inferred.field === 'owners' ? 'Action owner' : 'Action',
      text: inferred.action.action || '',
      field: inferred.field,
      inferred: true
    };
    return null;
  }

  function flagsTargetingAction(action, index) {
    var elementId = recordDomId('action', action && action.id, index);
    return ((state.draft && state.draft.reviewFlags) || []).filter(function (flag) {
      var target = flagTarget(flag);
      return target && target.elementId === elementId;
    }).map(function (flag) { return flag.id; });
  }

  function reviewQueueCounts() {
    var flags = ((state.draft && state.draft.reviewFlags) || []).filter(function (flag) { return flag.status === 'open'; }).length;
    var proposal = state.draft && state.draft.pendingProposal;
    var suggestions = proposal && Array.isArray(proposal.changes) ? proposal.changes.length : 0;
    return { flags: flags, suggestions: suggestions, total: flags + suggestions };
  }

  function updateReviewQueueSummary() {
    var counts = reviewQueueCounts();
    var panel = document.getElementById('reviewFlags');
    panel.hidden = counts.total === 0;
    document.getElementById('flagCount').textContent = counts.flags
      ? counts.flags + ' warning' + (counts.flags === 1 ? '' : 's') + (counts.suggestions ? ' · ' + counts.suggestions + ' suggestion' + (counts.suggestions === 1 ? '' : 's') : '')
      : counts.suggestions ? counts.suggestions + ' suggestion' + (counts.suggestions === 1 ? '' : 's') : 'Review complete';
    updateReviewQueueToggle(counts);
    var intro = document.getElementById('reviewQueueIntro');
    if (intro) intro.textContent = counts.suggestions
      ? 'Warnings and suggested changes are kept together here. Open an item to review its source and make a decision.'
      : 'Check or correct each item before sharing. Open items do not prevent export.';
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
    toggle.dataset.state = counts.flags ? 'warning' : 'clear';
    toggle.setAttribute('aria-expanded', String(open));
    var row = panel.closest('.workflow-utilities');
    if (row) row.classList.toggle('is-open', open);
  }

  function renderFlags() {
    var flags = (state.draft && state.draft.reviewFlags) || [];
    var open = flags.filter(function (flag) { return flag.status === 'open'; });
    var panel = document.getElementById('reviewFlags');
    var wasHidden = panel.hidden;
    if (open.length && wasHidden) panel.open = false;
    var flagLabels = { uncertain_fact:'Uncertain detail', unclear_reference:'Reference to check', ownership:'Owner to check', attribution:'Attribution to check', timing:'Timing to check', unresolved_decision:'Open decision', missing_evidence:'Check this against the transcript', possible_missed_follow_up:'Possible missed follow-up' };
    document.getElementById('flagList').innerHTML = flags.map(function (flag, index) {
      if (flag.status !== 'open') return '';
      var label = flagLabels[flag.kind] || flag.kind.replace(/_/g, ' ').replace(/\b\w/g, function (letter) { return letter.toUpperCase(); });
      var body = '<span class="flag-kind">Warning · ' + escapeHtml(label) + '</span><div class="flag-message">' + escapeHtml(flag.message) + '</div>';
      var target = flagTarget(flag);
      if (target) {
        var selector = target.field === 'timing' ? '[data-edit-timing]' : target.field === 'owners' ? '[data-edit-owners]' : target.field === 'proposal' ? 'summary' : 'textarea,input';
        var stepAttribute = target.stage == null ? '' : ' data-target-step="' + target.stage + '"';
        body += '<div class="flag-target"><span>' + (target.proposal ? 'Related suggestion' : 'Affected ' + escapeHtml(target.label.toLowerCase())) + '</span><blockquote>' + escapeHtml(target.text) + '</blockquote><button class="secondary compact" data-view-flag-target="' + escapeHtml(target.elementId) + '" data-target-selector="' + escapeHtml(selector) + '"' + stepAttribute + ' type="button">' + (target.proposal ? 'Review suggestion' : 'View and edit') + '</button></div>';
      } else body += '<p class="review-route-missing"><strong>No saved item or pending suggestion matches this warning.</strong> If the issue still matters, add or correct the relevant item and then resolve the warning. If its content was removed, dismiss it.</p>';
      body += '<input data-flag-correction="' + index + '" value="' + escapeHtml(flag.correctionNote || '') + '" placeholder="Add a correction note (optional)" aria-label="Correction note">';
      // One primary: "Mark as checked" is the answer a reviewer gives most often.
      var actions = '<button class="button" data-flag-index="' + index + '" data-flag-status="confirmed" type="button">Mark as checked</button><button class="secondary" data-flag-index="' + index + '" data-flag-status="corrected" type="button">Save review note</button><button class="secondary quiet" data-flag-index="' + index + '" data-flag-status="dismissed" type="button">Dismiss warning</button>';
      // Collapsed by default: the passage is often longer than the warning it
      // supports, and a reviewer who trusts the quoted line never opens it.
      var evidenceLines = evidenceContext(flag.evidenceIds).length;
      var evidence = '<details class="review-evidence" data-keep-open="' + escapeHtml(disclosureKey(flag.evidenceIds, 'flag-' + flag.id)) + '"><summary class="review-evidence-head"><strong>Source passage</strong><span class="muted">'
        + (evidenceLines ? evidenceLines + ' line' + (evidenceLines === 1 ? '' : 's') : 'none linked')
        + '</span></summary><div class="review-evidence-body">' + evidenceHtml(flag.evidenceIds) + '</div></details>';
      return '<div class="flag review-queue-item"><div class="review-item-layout"><div class="review-item-main">' + body + '<div class="flag-actions">' + actions + '</div></div>' + evidence + '</div></div>';
    }).join('');
    restoreDisclosures(document.getElementById('flagList'));
    updateReviewQueueSummary();
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

  function proposalTarget(change, stage) {
    var record = change && (change.before || change.after);
    if (!record || !record.id || change.type === 'add') return null;
    var rows = stage === 'discussion' ? (state.draft.discussion || []) : (state.draft.actions || []);
    var index = rows.findIndex(function (candidate) { return candidate.id === record.id; });
    if (index < 0) return null;
    return stage === 'discussion'
      ? { stage: 2, elementId: recordDomId('topic', record.id, index), selector: '[data-topic]' }
      : { stage: 3, elementId: recordDomId('action', record.id, index), selector: '[data-action]' };
  }

  function renderProposal() {
    var proposal = state.draft && state.draft.pendingProposal;
    var panel = document.getElementById('proposalPanel');
    var wasHidden = panel.hidden;
    panel.hidden = !proposal || !(proposal.changes || []).length;
    if (panel.hidden) { updateReviewQueueSummary(); return; }
    var changeLabels = { add:'New item', modify:'Edit', remove:'Removal' };
    document.getElementById('proposalChanges').innerHTML = proposal.changes.map(function (change) {
      var content;
      if (change.before && change.after) {
        content = '<div class="proposal-comparison"><div><div class="proposal-value-label">Before</div><pre>' + escapeHtml(proposalRecord(change.before)) + '</pre></div><div><div class="proposal-value-label">Proposed</div><pre>' + escapeHtml(proposalRecord(change.after)) + '</pre></div></div>';
      } else {
        content = '<pre>' + escapeHtml(proposalRecord(change.after || change.before)) + '</pre>';
      }
      if (change.reviewContext) {
        content += '<div class="proposal-rationale"><div><strong>Why this needs review:</strong> ' + escapeHtml(change.reviewContext.reason || '') + '</div>'
          + (change.reviewContext.label ? '<div class="commitment-chain"><span>In the transcript</span> ' + escapeHtml(change.reviewContext.label) + '</div>' : '')
          + ((change.reviewContext.evidenceIds || []).length ? evidenceBlock(change.reviewContext.evidenceIds, String(change.id || '')) : '') + '</div>';
      }
      var target = proposalTarget(change, proposal.stage);
      if (target) content += '<button class="secondary compact proposal-target" data-view-review-target="' + escapeHtml(target.elementId) + '" data-target-selector="' + escapeHtml(target.selector) + '" data-target-step="' + target.stage + '" type="button">View current item</button>';
      var semanticLabel=proposal.stage==='discussion' ? discussionProposalLabel(change) : '';
      var summary = proposalRecord(change.after || change.before);
      return '<div id="' + escapeHtml(proposalDomId(change)) + '" class="proposal-change review-queue-item"><input type="checkbox" data-proposal-change="' + escapeHtml(change.id) + '"' + (change.selected === true ? ' checked' : '') + ' aria-label="Select this suggested change"><details class="proposal-detail"><summary><span class="proposal-kind">Suggestion · ' + escapeHtml(semanticLabel || changeLabels[change.type] || 'Suggested change') + '</span><span class="proposal-summary">' + escapeHtml(summary) + '</span><span class="proposal-chevron">›</span></summary><div class="proposal-content">' + content + '</div></details></div>';
    }).join('');
    updateProposalSelection();
    updateReviewQueueSummary();
    // The queue stays collapsed when it first gains items, matching renderFlags
    // above: this runs after it, so opening here quietly overrode that and the
    // The panel stays closed until the reviewer opens the warnings or suggestions.
    if (wasHidden) document.getElementById('reviewFlags').open = false;
  }

  function updateProposalSelection() {
    var boxes = Array.from(document.querySelectorAll('[data-proposal-change]'));
    var selected = boxes.filter(function (box) { return box.checked; }).length;
    var count = document.getElementById('proposalSelectionCount');
    var apply = document.getElementById('acceptSelectedProposal');
    if (count) count.textContent = selected + ' of ' + boxes.length + ' selected';
    if (apply) { apply.textContent = 'Apply ' + selected + ' change' + (selected === 1 ? '' : 's'); apply.disabled = selected === 0; }
  }

  function formatUkDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return value || '';
    return new Intl.DateTimeFormat('en-GB', {day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}).format(new Date(value + 'T00:00:00Z'));
  }

  function timingText(timing) {
    timing = timing || {};
    if (timing.kind === 'not_stated' || (!timing.wording && !timing.exactDate)) return 'No date agreed';
    var prefix = timing.kind === 'target' ? 'Target: ' : (timing.kind === 'dependency' ? 'Dependent on: ' : 'Deadline: ');
    return prefix + (timing.exactDate ? formatUkDate(timing.exactDate) : timing.wording);
  }

  function timingDisplayText(timing) {
    return timingText(timing);
  }

  function finalEditMatches(kind, id, field) {
    return activeFinalEdit && activeFinalEdit.kind === kind && String(activeFinalEdit.id || '') === String(id || '') && activeFinalEdit.field === field;
  }

  function finalTextEditor(kind, id, field, value, options) {
    options = options || {};
    if (!finalEditMatches(kind, id, field)) {
      var displayValue = options.displayValue == null ? value : options.displayValue;
      return '<button class="final-editable' + (options.block ? ' block' : '') + '" data-final-edit data-kind="' + escapeHtml(kind) + '" data-record-id="' + escapeHtml(id || '') + '" data-field="' + escapeHtml(field) + '" type="button" title="Click to edit">' + escapeHtml(displayValue || options.empty || 'Not stated') + '</button>';
    }
    var control = options.singleLine
      ? '<input data-final-editor-value value="' + escapeHtml(value || '') + '"' + (options.inputType ? ' type="' + options.inputType + '"' : '') + ' aria-label="' + escapeHtml(options.label || 'Edit value') + '">'
      : '<textarea data-final-editor-value rows="' + (options.rows || 2) + '" aria-label="' + escapeHtml(options.label || 'Edit text') + '">' + escapeHtml(value || '') + '</textarea>';
    return '<span class="final-inline-editor" data-final-editor>' + control + '<span class="final-edit-actions"><button class="secondary quiet" data-final-cancel type="button">Cancel</button><button class="button" data-final-save type="button">Save</button></span></span>';
  }

  function finalTimingEditor(action) {
    var timing = action.timing || {};
    if (!finalEditMatches('action', action.id, 'timing')) {
      return '<button class="final-editable final-editable-cell" data-final-edit data-kind="action" data-record-id="' + escapeHtml(action.id) + '" data-field="timing" type="button" title="Click to edit timing">' + escapeHtml(timingText(timing)) + '</button>';
    }
    return '<span class="final-inline-editor timing" data-final-editor>'
      + '<label><span class="lbl">Type</span><select data-final-timing-kind><option value="not_stated"' + (timing.kind === 'not_stated' ? ' selected' : '') + '>Not stated</option><option value="target"' + (timing.kind === 'target' ? ' selected' : '') + '>Target</option><option value="deadline"' + (timing.kind === 'deadline' ? ' selected' : '') + '>Deadline</option><option value="dependency"' + (timing.kind === 'dependency' ? ' selected' : '') + '>Dependency</option></select></label>'
      + '<label><span class="lbl">As said</span><input data-final-timing-wording value="' + escapeHtml(timing.wording || '') + '" placeholder="e.g. by Friday"></label>'
      + '<label><span class="lbl">Date</span><input data-final-timing-date type="date" value="' + escapeHtml(timing.exactDate || '') + '"></label>'
      + '<span class="final-edit-actions"><button class="secondary quiet" data-final-cancel type="button">Cancel</button><button class="button" data-final-save type="button">Save</button></span></span>';
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
    var objectives = include.meetingObjectives ? (draft.meetingObjectives || []).map(function(item,index){return typeof item === 'string' ? {id:'objective-'+index,text:item} : item;}).filter(function(item){return item && item.text;}) : [];
    var summaryHtml = (objectives.length ? '<section><h3>Meeting objectives</h3><ul>' + objectives.map(function (item) { return '<li>' + finalTextEditor('objective', item.id, 'text', item.text, {label:'Edit meeting objective'}) + '</li>'; }).join('') + '</ul></section>' : '')
      + (include.executiveSummary && draft.executiveSummary ? '<section><h3>Executive summary</h3>' + finalTextEditor('summary', 'executive-summary', 'text', draft.executiveSummary, {block:true,rows:3,label:'Edit executive summary'}) + '</section>' : '');
    var finalDiscussion = (draft.discussion || []).map(function (topic, topicIndex) {
      var topicId = topic.id || 'topic-' + topicIndex;
      var rows = [{key:'points',label:''}, {key:'decisions',label:'Decision:'}, {key:'openQuestions',label:'Open question:'}]
        .flatMap(function (group) { return (topic[group.key] || []).map(function (item,itemIndex) { return {id:item.id || topicId+'-'+group.key+'-'+itemIndex,label:group.label,text:item.text}; }); });
      return '<h4>' + finalTextEditor('topic', topicId, 'topic', topic.topic, {singleLine:true,label:'Edit topic heading'}) + '</h4>' + (rows.length ? '<ul class="final-propositions">' + rows.map(function (item) { return '<li><div class="final-proposition-content">' + (item.label ? '<strong class="final-kind-label">' + escapeHtml(item.label) + '</strong>' : '') + finalTextEditor('discussion', item.id, 'text', item.text, {block:true,label:'Edit meeting sentence'}) + '</div></li>'; }).join('') + '</ul>' : '');
    }).join('');
    var actionsHtml = (draft.actions || []).map(function (action) {
      return '<tr><td>' + finalTextEditor('action', action.id, 'action', action.action, {block:true,label:'Edit action'}) + '</td><td>' + finalTextEditor('action', action.id, 'owners', (action.owners || []).join(', '), {singleLine:true,label:'Edit owners',empty:'Not stated'}) + '</td><td>' + finalTimingEditor(action) + '</td></tr>';
    }).join('') || '<tr><td colspan="3">No actions recorded.</td></tr>';
    document.getElementById('finalDocument').innerHTML = '<p class="final-edit-hint">Click any highlighted sentence, owner or date to edit it here.</p><h2>' + finalTextEditor('details', 'meeting-details', 'meetingTitle', details.meetingTitle || 'Meeting minutes', {singleLine:true,label:'Edit meeting title'}) + '</h2><p><strong>Date:</strong> ' + finalTextEditor('details', 'meeting-details', 'meetingDate', details.meetingDate || '', {singleLine:true,inputType:'date',label:'Edit meeting date',displayValue:formatUkDate(details.meetingDate),empty:'Not stated'}) + '<br><strong>Location:</strong> ' + finalTextEditor('details', 'meeting-details', 'meetingLocation', details.meetingLocation || '', {singleLine:true,label:'Edit meeting location',empty:'Not stated'}) + '<br><strong>Meeting type:</strong> ' + escapeHtml(meetingTypeLabel(details.meetingType) || 'Not stated') + '</p>' + finalAttendeesHtml(details) + summaryHtml + '<section><h3>Meeting content</h3>' + (finalDiscussion || '<p>No meeting content recorded.</p>') + '</section><section><h3>Actions</h3><div class="actions-wrap"><table class="actions-table"><thead><tr><th>Action</th><th>Owners</th><th>Timing</th></tr></thead><tbody>' + actionsHtml + '</tbody></table></div></section>';
    var editor = document.querySelector('#finalDocument [data-final-editor] input, #finalDocument [data-final-editor] textarea, #finalDocument [data-final-editor] select');
    if (editor) { editor.focus({preventScroll:true}); if (editor.select) editor.select(); }
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
        regenerateDiscussion: Boolean(activeGenerationStage),
        regenerateActions: Boolean(activeGenerationStage),
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
      renderStaleNotice();
      updateStageAdvanceLabels();
    } else document.getElementById('staleNotice').hidden = true;
    // The Review page's document is built on entry; a draft resumed on Review
    // (or re-rendered while it is open) must build it too.
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
    discussion: ['discussion'],
    actions: ['actions'],
    summary: ['executiveSummary', 'meetingObjectives']
  };

  function stageContentKey(draft, stage) {
    return BACKGROUND_STAGES[stage].map(function (field) {
      return JSON.stringify(draft && draft[field] != null ? draft[field] : null);
    }).join('|');
  }

  function stageIsEmpty(draft, stage) {
    if (stage === 'summary') {
      return !String((draft && draft.executiveSummary) || '').trim()
        && !(((draft && draft.meetingObjectives) || []).length);
    }
    return !(((draft && draft[stage]) || []).length);
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
      setSaveStatus(EMPTY_ROW_NOTICE, 'local-only');
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
      actions: state.draft.actions,
      executiveSummary: state.draft.executiveSummary || '',
      meetingObjectives: state.draft.meetingObjectives || [],
      reviewFlags: state.draft.reviewFlags,
      staleStages: state.draft.staleStages || [],
      currentStep: Math.max(Number(state.draft.currentStep || 0), state.currentStep),
      selectedStep: state.currentStep,
      includeSections: state.draft.includeSections || { meetingObjectives: true, executiveSummary: true },
      keptActionIds: state.draft.keptActionIds || [],
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
    setSaveStatus('Saving draft...', 'dirty');
    // Held until the operation finishes, then sent against the revision it
    // produced rather than the one it replaced.
    if (draftWritesInFlight) return;
    saveTimer = window.setTimeout(function () { saveDraftNow(); }, 900);
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
    setSaveStatus('Saving...', 'saving');
    saveInFlight = withBackgroundMerge(function () {
      return jsonRequest(draftUrl(), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draftPatchBody(statusValue, reviewDecisionLabel))
      });
    }).then(function (payload) {
      if (reviewDecisionLabel && pendingReviewDecisionLabel === reviewDecisionLabel) pendingReviewDecisionLabel = '';
      if (editVersion !== requestEditVersion) {
        // A newer keystroke landed while this request was in flight. Advance the
        // revision but do not replace the newer editor values with the response.
        state.draft.revision = payload.draft.revision;
        state.draft.updatedAt = payload.draft.updatedAt;
        state.draft.lastUndo = payload.draft.lastUndo;
        if (reviewDecisionLabel) showUndoToast(reviewDecisionLabel);
        setSaveStatus('Saving draft...', 'dirty');
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

  // Kicks a stage off server-side and returns straight away, so the reviewer can
  // read while it runs. The server keeps going even if this tab closes.
  var pendingRegenerationStage = '';

  // A button that reads "Generate actions" and then navigates is lying about
  // itself; one that reads "Review actions" and then generates is worse. The
  // label follows whether the stage is already there.
  function updateStageAdvanceLabels() {
    [['startDiscussion', 'discussion', 'Generate discussion', 'Continue to Discussion'],
      ['generateActions', 'actions', 'Generate actions', 'Continue to Actions']
    ].forEach(function (entry) {
      var button = document.getElementById(entry[0]);
      var label = button && button.querySelector('[data-stage-advance-label]');
      if (!label) return;
      var text = stageHasContent(entry[1]) ? entry[3] : entry[2];
      if (label.textContent !== text) label.textContent = text;
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

  // What a finished stage has to say for itself. Only mentions suggestions when
  // there are suggestions: a prompt to "check any proposed additions" above a
  // count of zero reads as a tool describing someone else's draft.
  function stageReadyText(stage) {
    var proposal = state.draft && state.draft.pendingProposal;
    var suggestions = proposal && Array.isArray(proposal.changes) ? proposal.changes.length : 0;
    var suffix = suggestions
      ? ' ' + suggestions + ' suggestion' + (suggestions === 1 ? '' : 's') + ' to check.'
      : '';
    if (stage === 'discussion') return 'Discussion ready.' + suffix;
    if (stage === 'actions') return 'Actions ready.' + suffix;
    return '';
  }

  function stageHasContent(stage) {
    if (!state.draft) return false;
    if (stage === 'discussion') return (state.draft.discussion || []).length > 0;
    if (stage === 'actions') return (state.draft.actions || []).length > 0;
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
    document.getElementById('regenerationMessage').textContent = stage === 'summary'
      ? 'Your current summary stays visible while the agent works. The refreshed summary will replace it when ready.'
      : 'Your current draft stays visible while the agent works. Anything you edited remains unchanged; new differences arrive as suggestions for you to apply or dismiss.';
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
          var keptEdits = activeStage === 'actions' && state.draft.pendingProposal && state.draft.pendingProposal.source === 'regeneration';
          setStatus(keptEdits
            ? 'Your edited Actions were kept. The regenerated Actions are shown as proposed changes: accept the ones you want.'
            : state.draft.qualityNotice || stageReadyText(activeStage), !keptEdits && Boolean(state.draft.qualityNotice), activeStage);
        }
        generationPollKey = '';
        if (pendingGenerationEdits) scheduleSave();
        else if (hasTransientEditorState()) setSaveStatus(EMPTY_ROW_NOTICE, 'local-only');
        else setSaveStatus(savedStatusText(state.draft.updatedAt), 'saved');
      } catch (error) { setStatus(error.message, true, expectedGeneration.stage); }
    }, GENERATION_POLL_MS);
  }

  async function runAgent(stage, instruction) {
    if (!state.draft) return false;
    try { await saveDraftNow(); } catch (error) { setStatus(error.message, true); return false; }
    setBusy(true, instruction ? 'The agent is preparing a change preview...' : 'The agent is reviewing the prepared transcript...', stage);
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
      adoptDraft(payload.draft);
      if (instruction) { renderProposal(); setStatus('Review the proposed changes. Nothing has been applied yet.', false, stage); }
      else {
        showStep(STAGE_STEP[stage] || 2, { scroll: true });
        setStatus(stage === 'discussion' ? stageReadyText('discussion') : 'Action draft generated. Running the separate missed-action check next.', false, stage);
        if (stage === 'actions') await auditActions(true);
      }
      return true;
    } catch (error) { setStatus(error.message, true, stage); return false; }
    finally { setBusy(false); endDraftWrite(); }
  }

  async function auditActions(automatic) {
    if (!state.draft) return;
    try { await saveDraftNow(); } catch (error) { setStatus(error.message, true); return; }
    setBusy(true, 'Checking the transcript for missed follow-up actions...', 'actions');
    draftWritesInFlight += 1;
    try {
      var payload; var totalAttempts = agentRetryDelaysSeconds.length + 1;
      for (var attempt = 0; attempt < totalAttempts; attempt += 1) {
        if (attempt > 0) await waitForAgentRetry(agentRetryDelaysSeconds[attempt - 1], attempt + 1, totalAttempts, 'actions');
        try {
          payload = await withBackgroundMerge(function () {
            return jsonRequest(draftUrl('/audit-actions'), {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:state.draft.revision})});
          });
          break;
        } catch (error) {
          if (!(error.code === 'M365_AGENT_USAGE_LIMIT' && error.retryable) || attempt === totalAttempts - 1) throw error;
        }
      }
      adoptDraft(payload.draft);
      setStatus(payload.proposal ? 'The completeness check found proposed actions. Review them before applying.' : 'The completeness check found no additional supported actions.', false, 'actions');
    } catch (error) { setStatus((automatic ? 'The action draft is available, but the completeness check failed: ' : '') + error.message, true, 'actions'); }
    finally { setBusy(false); endDraftWrite(); }
  }

  async function reviewProposal(decision, acceptAll) {
    var proposal = state.draft && state.draft.pendingProposal; if (!proposal) return;
    var proposalStage = proposal.stage || '';
    var ids = Array.from(document.querySelectorAll('[data-proposal-change]:checked')).map(function (input) { return input.dataset.proposalChange; });
    try { await saveDraftNow(); } catch (error) { setStatus(error.message, true); return; }
    setBusy(true, decision === 'reject' ? 'Rejecting proposed changes...' : 'Applying selected changes...', proposalStage);
    draftWritesInFlight += 1;
    try {
      var payload = await withBackgroundMerge(function () {
        return jsonRequest(draftUrl('/proposal'), {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:state.draft.revision,decision:decision,acceptAll:Boolean(acceptAll),changeIds:ids})});
      });
      adoptDraft(payload.draft);
      if (payload.draft && payload.draft.lastUndo) showUndoToast(payload.draft.lastUndo.label);
      var remaining = payload.draft && payload.draft.pendingProposal && (payload.draft.pendingProposal.changes || []).length;
      setStatus(decision === 'reject' ? 'All remaining suggestions were dismissed.'
        : remaining ? 'Selected changes applied. ' + remaining + ' unchecked suggestion' + (remaining === 1 ? ' remains' : 's remain') + ' in the review queue.'
          : 'Selected agent changes applied.', false, proposalStage);
    } catch (error) { setStatus(error.message, true, proposalStage); }
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

  async function loadDraft(draftId) {
    setBusy(true, 'Loading your saved draft...');
    try { var payload = await jsonRequest('/api/meeting-minutes-agent/drafts/' + encodeURIComponent(draftId)); adoptDraft(payload.draft); setStatus('', false); }
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
  // Kept for drafts saved before the Focus step was removed: the button is
  // hidden, and its index is skipped rather than renumbered so a stored
  // currentStep still points at the screen it meant.
  document.getElementById('toSteer').addEventListener('click', function () { readDetails(); showStep(2, { scroll: true }); });
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
    state.draft.meetingObjectives.splice(Number(button.dataset.removeObjective), 1);
    markUndoStep('remove objective', '');
    renderSummary();
    scheduleSave();
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
  document.getElementById('auditActions').addEventListener('click', function () { auditActions(false); });
  document.getElementById('applyDiscussionEdit').addEventListener('click', function () { var input=document.getElementById('discussionInstruction'); if (!input.value.trim()) return setStatus('Describe the discussion edits you want.',true,'discussion'); runAgent('discussion',input.value.trim()).then(function(ok){if(ok)input.value='';}); });
  document.getElementById('applyActionsEdit').addEventListener('click', function () { var input=document.getElementById('actionsInstruction'); if (!input.value.trim()) return setStatus('Describe the action edits you want.',true,'actions'); runAgent('actions',input.value.trim()).then(function(ok){if(ok)input.value='';}); });
  document.getElementById('addDiscussion').addEventListener('click', function () {
    readDiscussion();
    var topic = {id:'manual-topic-'+Date.now(),topic:'',points:[],decisions:[],openQuestions:[]};
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

  document.getElementById('discussionScreen').addEventListener('click', function (event) {
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
      addedRecord={id:'manual-'+Date.now(),text:'',evidenceIds:[],reviewFlagIds:[],supportingDetails:[]};
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
        target.supportingDetails=(target.supportingDetails||[]).concat([{id:demoted.id,text:demoted.text,evidenceIds:demoted.evidenceIds||[],reviewFlagIds:demoted.reviewFlagIds||[]}],demoted.supportingDetails||[]);
        demoteList.splice(Number(demote.dataset.itemIndex),1);
      }
    }
    if(promote){
      var promoteTopic=state.draft.discussion[Number(promote.dataset.topicIndex)];
      var promoteList=promoteTopic && promoteTopic[promote.dataset.parentField];
      var parent=promoteList && promoteList[Number(promote.dataset.itemIndex)];
      var promoted=parent && (parent.supportingDetails||[]).splice(Number(promote.dataset.promoteSupporting),1)[0];
      if(promoted) promoteList.push({id:promoted.id||('promoted-'+Date.now()),text:promoted.text,evidenceIds:promoted.evidenceIds||[],reviewFlagIds:promoted.reviewFlagIds||[],supportingDetails:[]});
    }
    if(moveNew){
      var sourceIndex=Number(moveNew.dataset.topicIndex);
      var sourceTopic=state.draft.discussion[sourceIndex];
      var sourceField=moveNew.dataset.moveRecordNewTopic;
      var movedRecord=sourceTopic && (sourceTopic[sourceField]||[]).splice(Number(moveNew.dataset.itemIndex),1)[0];
      if(movedRecord){
        var newTopic={id:'manual-topic-'+Date.now(),topic:'New topic',points:[],decisions:[],openQuestions:[]};
        newTopic[sourceField].push(movedRecord);
        state.draft.discussion.splice(sourceIndex+1,0,newTopic);
        movedTopicIndex=sourceIndex+1;
      }
    }
    // Removing a topic with content deletes all its rows at once: ask first.
    var topicToRemove=topicButton && state.draft.discussion[Number(topicButton.dataset.deleteTopic)];
    if(topicButton && discussionTopicHasContent(topicToRemove)){
      var rowCount=['points','decisions','openQuestions'].reduce(function(total,key){return total+((topicToRemove[key]||[]).length);},0);
      if(!window.confirm('Remove the topic "'+(topicToRemove.topic||'Untitled')+'" and its '+rowCount+' row'+(rowCount===1?'':'s')+'?')) topicButton=null;
    }
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
    if (remove && removedReviewContent) queueReviewDecision('Discussion item removed');
    else if (topicButton && removedReviewContent) queueReviewDecision('Discussion topic removed');
    else { if (remove || topicButton) markUndoStep(remove ? 'remove discussion item' : 'remove discussion topic', ''); scheduleSave(); }
  });

  // The Removed section sits outside the actions table, so it needs its own
  // listener; a click there is the one-step undo for a rejection.
  document.getElementById('removedActionsList').addEventListener('click', function (event) {
    var restoreButton = event.target.closest('[data-restore-action]');
    if (!restoreButton || !state.draft) return;
    readActions();
    var back = removedActions().splice(Number(restoreButton.dataset.restoreAction), 1)[0];
    if (back) state.draft.actions.push({
      id: back.id, action: back.action, owners: back.owners || [],
      timing: back.timing || {kind:'not_stated',wording:'',exactDate:''},
      evidenceIds: back.evidenceIds || [], reviewFlagIds: []
    });
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
        transcriptPanel.open = true;
        transcriptButton.setAttribute('aria-expanded', 'true');
        window.setTimeout(function () {
          transcriptPanel.scrollIntoView({ behavior: 'smooth', block: 'center' });
          var summary = transcriptPanel.querySelector('summary');
          if (summary) summary.focus({ preventScroll: true });
        }, 0);
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
      var owned = state.draft.actions[Number(removeOwner.dataset.actionIndex)];
      if (owned) owned.owners = (owned.owners || []).filter(function (name) { return name !== removeOwner.dataset.owner; });
      markUndoStep('remove owner', '');
      rerenderActions(); scheduleSave();
      return;
    }
    var keepButton = event.target.closest('[data-keep-action]');
    if (keepButton) {
      readActions();
      var keptRow = state.draft.actions[Number(keepButton.dataset.keepAction)];
      if (keptRow && keptRow.id) {
        var ids = keptActionIds();
        var at = ids.indexOf(keptRow.id);
        if (at === -1) ids.push(keptRow.id); else ids.splice(at, 1);
        markUndoStep(at === -1 ? 'mark action checked' : 'clear action check', '');
      }
      rerenderActions(); scheduleSave();
      return;
    }
    var button = event.target.closest('[data-delete-action]') || event.target.closest('[data-reject-action]');
    if (!button) return;
    readActions();
    var removedIndex = Number(button.dataset.deleteAction != null ? button.dataset.deleteAction : button.dataset.rejectAction);
    var actionToRemove = state.draft.actions[removedIndex];
    var inferredFlagIds = flagsTargetingAction(actionToRemove, removedIndex);
    var removedAction = state.draft.actions.splice(removedIndex,1)[0];
    resolveDeletedTargetFlags(linkedReviewFlagIds(removedAction).concat(inferredFlagIds));
    // Keep the row so it can be put back from the Removed section rather than
    // retyped. Newest first, because the last rejection is the likely undo.
    if (removedAction) removedActions().unshift({
      id: removedAction.id || '', action: removedAction.action || '',
      owners: removedAction.owners || [], timing: removedAction.timing || {kind:'not_stated',wording:'',exactDate:''},
      evidenceIds: removedAction.evidenceIds || [], removedAt: new Date().toISOString()
    });
    if (removedAction && removedAction.id) {
      var keptAt = keptActionIds().indexOf(removedAction.id);
      if (keptAt !== -1) keptActionIds().splice(keptAt, 1);
      delete actionEditorState.pendingRows[removedAction.id];
      delete actionEditorState.customOwners[removedAction.id];
      delete actionEditorState.editingOwners[removedAction.id];
      delete actionEditorState.editingTiming[removedAction.id];
    }
    renderActions(); queueReviewDecision('Action removed');
  });

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
    if (addOwner(index, select.value)) { markUndoStep('add owner', ''); rerenderActions(); scheduleSave(); }
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
    var action = {id:'manual-action-'+Date.now(),action:'',owners:[],timing:{kind:'not_stated',wording:'',exactDate:''},evidenceIds:[],reviewFlagIds:[]};
    state.draft.actions.push(action);
    actionEditorState.pendingRows[action.id] = JSON.parse(JSON.stringify(action));
    markUndoStep('add action', '');
    renderActions();
    setSaveStatus('New action row is kept in this tab until you enter the action.', 'local-only');
    var field = document.querySelector('#' + recordDomId('action', action.id) + ' [data-action]');
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

  function applyFinalEdit() {
    if (!activeFinalEdit || !state.draft) return false;
    var edit = activeFinalEdit;
    var editor = document.querySelector('#finalDocument [data-final-editor]');
    if (!editor) return false;
    var valueControl = editor.querySelector('[data-final-editor-value]');
    var value = valueControl ? valueControl.value.trim() : '';
    var label = 'Final minutes updated';
    if (edit.kind === 'details') {
      state.draft.details[edit.field] = value;
      label = edit.field === 'meetingTitle' ? 'Meeting title edited' : edit.field === 'meetingDate' ? 'Meeting date edited' : 'Meeting location edited';
    } else if (edit.kind === 'topic') {
      var topic = (state.draft.discussion || []).find(function (item, index) { return String(item.id || 'topic-'+index) === String(edit.id); });
      if (!topic || !value) return false;
      topic.topic = value; label = 'Topic heading edited';
    } else if (edit.kind === 'discussion') {
      var record = findFinalDiscussionRecord(edit.id);
      if (!record || !value) return false;
      record.text = value; label = 'Meeting sentence edited';
    } else if (edit.kind === 'objective') {
      var objectiveIndex = (state.draft.meetingObjectives || []).findIndex(function (item, index) { return String(typeof item === 'string' ? 'objective-'+index : item.id) === String(edit.id); });
      if (objectiveIndex < 0 || !value) return false;
      var objective = state.draft.meetingObjectives[objectiveIndex];
      state.draft.meetingObjectives[objectiveIndex] = typeof objective === 'string' ? value : Object.assign({}, objective, {text:value});
      label = 'Meeting objective edited';
    } else if (edit.kind === 'summary') {
      if (!value) return false;
      state.draft.executiveSummary = value; label = 'Executive summary edited';
    } else if (edit.kind === 'action') {
      var action = (state.draft.actions || []).find(function (item) { return String(item.id) === String(edit.id); });
      if (!action) return false;
      if (edit.field === 'action') {
        if (!value) return false;
        action.action = value; label = 'Action edited';
      } else if (edit.field === 'owners') {
        action.owners = value.split(/[,;]+/).map(function (owner) { return owner.trim(); }).filter(Boolean);
        label = 'Action owners edited';
      } else if (edit.field === 'timing') {
        action.timing = {
          kind: editor.querySelector('[data-final-timing-kind]').value,
          wording: editor.querySelector('[data-final-timing-wording]').value.trim(),
          exactDate: editor.querySelector('[data-final-timing-date]').value
        };
        label = 'Action timing edited';
      }
    }
    activeFinalEdit = null;
    // saveDraftNow reads the hidden stage editors before sending. Refresh them
    // so an edit made on the final document cannot be replaced by stale fields.
    renderDetails(); renderDiscussion(); renderActions(); renderSummary(); renderFinal();
    queueReviewDecision(label);
    return true;
  }

  document.getElementById('finalDocument').addEventListener('click', function (event) {
    var editable = event.target.closest('[data-final-edit]');
    if (editable) {
      activeFinalEdit = { kind:editable.dataset.kind, id:editable.dataset.recordId || '', field:editable.dataset.field };
      renderFinal();
      return;
    }
    if (event.target.closest('[data-final-cancel]')) { activeFinalEdit = null; renderFinal(); return; }
    if (event.target.closest('[data-final-save]')) applyFinalEdit();
  });

  document.getElementById('finalDocument').addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && activeFinalEdit) { event.preventDefault(); activeFinalEdit = null; renderFinal(); }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && activeFinalEdit) { event.preventDefault(); applyFinalEdit(); }
  });

  function openReviewTarget(targetButton) {
    if (targetButton.dataset.targetStep !== undefined) showStep(Number(targetButton.dataset.targetStep), { scroll:true });
    window.setTimeout(function () {
        var target = document.getElementById(targetButton.dataset.viewReviewTarget || targetButton.dataset.viewFlagTarget);
        if (!target) return;
        var topicCard = target.closest('.discussion-card');
        if (topicCard && topicCard.classList.contains('is-collapsed')) {
          var toggle = topicCard.querySelector('[data-toggle-topic]');
          if (toggle) toggle.click();
          target = document.getElementById(targetButton.dataset.viewReviewTarget || targetButton.dataset.viewFlagTarget);
          if (!target) return;
        }
        // The jump to the item replaces the step's own landing position; without
        // this the autosave that follows the step change scrolls back to the top.
        clearStepNavigationScroll();
        target.scrollIntoView({behavior:'smooth',block:'center'});
        target.classList.add('flag-target-highlight');
        var detail = target.querySelector('.proposal-detail');
        if (detail) detail.open = true;
        var editor = target.querySelector(targetButton.dataset.targetSelector || 'textarea,input');
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
    var targetButton = event.target.closest('[data-view-flag-target]');
    if (targetButton) {
      openReviewTarget(targetButton);
      return;
    }
    var button=event.target.closest('[data-flag-index]'); if(!button)return; var index=Number(button.dataset.flagIndex); var note=document.querySelector('[data-flag-correction="'+index+'"]'); state.draft.reviewFlags[index].status=button.dataset.flagStatus; if(note)state.draft.reviewFlags[index].correctionNote=note.value.trim(); renderFlags(); var decisionLabel=button.dataset.flagStatus==='dismissed'?'Warning dismissed':button.dataset.flagStatus==='corrected'?'Warning correction saved':'Warning confirmed'; queueReviewDecision(decisionLabel);
  });
  document.getElementById('acceptAllProposal').addEventListener('click', function () { reviewProposal('accept',true); });
  document.getElementById('acceptSelectedProposal').addEventListener('click', function () { reviewProposal('accept',false); });
  document.getElementById('rejectProposal').addEventListener('click', function () { reviewProposal('reject',false); });
  document.getElementById('proposalChanges').addEventListener('change', function (event) {
    if (event.target.matches('[data-proposal-change]')) updateProposalSelection();
  });
  document.getElementById('proposalChanges').addEventListener('click', function (event) {
    var targetButton = event.target.closest('[data-view-review-target]');
    if (targetButton) openReviewTarget(targetButton);
  });
  document.getElementById('openFinalReview').addEventListener('click', function () { readEditors(); activeFinalEdit=null; renderFinal(); showStep(MAX_STEP, { scroll: true }); setStatus('Review the complete minutes. Click any sentence, owner or date to edit it here.',false,'review'); });
  document.getElementById('reviewQueueToggle').addEventListener('click', function () {
    var panel = document.getElementById('reviewFlags');
    panel.open = !panel.open;
    updateReviewQueueSummary();
    if (panel.open) panel.scrollIntoView({ block: 'nearest' });
  });

  document.getElementById('previewDocument').addEventListener('click', function () {
    if(state.currentStep===MAX_STEP){showStep(previewReturnStep,{scroll:true});return;}
    readEditors();previewReturnStep=state.currentStep;activeFinalEdit=null;renderFinal();showStep(MAX_STEP,{scroll:true});
  });
  document.getElementById('downloadDraft').addEventListener('click', function () { downloadExport('docx'); });
  document.getElementById('undoLastDecision').addEventListener('click', undoLastReviewDecision);
  document.getElementById('redoLastDecision').addEventListener('click', redoLastReviewDecision);
  document.getElementById('undoToastButton').addEventListener('click', undoLastReviewDecision);
  document.getElementById('saveMinutes').addEventListener('click', function () { saveDraftNow('complete').then(function(){setStatus('Final minutes saved to the Library.',false,'review');}).catch(function(error){setStatus(error.message,true,'review');}); });
  document.getElementById('reloadDraft').addEventListener('click', function () {
    if (state.draft) loadDraft(state.draft.draftId);
  });
  document.getElementById('downloadWord').addEventListener('click', function () { downloadExport('docx'); });
  document.getElementById('downloadPdf').addEventListener('click', function () { downloadExport('pdf'); });
  document.getElementById('printMinutes').addEventListener('click', function () { window.print(); });
  document.getElementById('newMinutes').addEventListener('click', function () { window.location.href='/meeting-minutes-agent'; });
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
    if (event.target.matches('textarea,input,select') && !event.target.closest('[data-final-editor]') && !event.target.matches('[data-proposal-change],#includeEvidence,#transcriptFile,#mobileStepSelect,[data-add-owner],[data-owner-other]')) {
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
