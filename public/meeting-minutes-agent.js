(function () {
  'use strict';

  var state = { fileName: '', denoisedTranscript: '', details: {}, discussion: [], actions: [], denoise: null, discussionGenerated: false, actionsGenerated: false };
  var currentStep = 0;
  var fileInput = document.getElementById('transcriptFile');
  var uploadZone = document.getElementById('uploadZone');
  var detailsEditor = document.getElementById('detailsEditor');
  var status = document.getElementById('workflowStatus');
  var agentRetryDelaysSeconds = [5, 15, 30];

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

  function setBusy(busy, message) {
    document.body.classList.toggle('busy', busy);
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
      throw error;
    }
    return payload;
  }

  function waitForAgentRetry(seconds, nextAttempt, totalAttempts) {
    return new Promise(function (resolve) {
      var remaining = seconds;
      function tick() {
        if (remaining <= 0) {
          setStatus('Retrying with a fresh agent conversation now…', false);
          resolve();
          return;
        }
        setStatus('Microsoft is temporarily busy. Retrying in ' + remaining + ' second' + (remaining === 1 ? '' : 's') + ' (attempt ' + nextAttempt + ' of ' + totalAttempts + ')…', false);
        remaining -= 1;
        window.setTimeout(tick, 1000);
      }
      tick();
    });
  }

  function showStep(index) {
    currentStep = Math.max(0, Math.min(3, Number(index) || 0));
    document.querySelectorAll('[data-screen]').forEach(function (screen) { screen.classList.toggle('active', Number(screen.dataset.screen) === currentStep); });
    document.querySelectorAll('[data-step]').forEach(function (button) {
      var step = Number(button.dataset.step);
      var unlocked = step === 0 || (step === 1 && state.discussionGenerated) || (step === 2 && state.actionsGenerated) || (step === 3 && state.actionsGenerated);
      button.disabled = !unlocked;
      button.classList.toggle('active', step === currentStep);
      button.classList.toggle('complete', step < currentStep);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function readDetails() {
    state.details = {
      meetingTitle: document.getElementById('meetingTitle').value.trim(),
      meetingDate: document.getElementById('meetingDate').value,
      meetingLocation: document.getElementById('meetingLocation').value.trim(),
      organisation: document.getElementById('organisation').value.trim(),
      meetingType: document.getElementById('meetingType').value.trim(),
      allAttendees: document.getElementById('attendees').value.split(/\r?\n/).map(function (value) { return value.trim(); }).filter(Boolean)
    };
    return state.details;
  }

  function renderDetails() {
    var details = state.details || {};
    document.getElementById('meetingTitle').value = details.meetingTitle || '';
    document.getElementById('meetingDate').value = details.meetingDate || '';
    document.getElementById('meetingLocation').value = details.meetingLocation || '';
    document.getElementById('organisation').value = details.organisation || '';
    document.getElementById('meetingType').value = details.meetingType || '';
    document.getElementById('attendees').value = (details.allAttendees || []).join('\n');
    var denoise = state.denoise || {};
    document.getElementById('denoiseSummary').textContent = denoise.totalUnitCount
      ? denoise.keptUnitCount + ' of ' + denoise.totalUnitCount + ' transcript turns retained'
      : '';
  }

  async function prepareFile(file) {
    if (!file) return;
    if (!/\.docx$/i.test(file.name)) return setStatus('Choose a Word .docx transcript.', true);
    var form = new FormData(); form.append('file', file);
    setBusy(true, 'Reading the Word document and denoising the transcript with MiniLM v3…');
    try {
      var payload = await jsonRequest('/api/meeting-minutes-agent/prepare', { method: 'POST', body: form });
      state = { fileName: payload.fileName, denoisedTranscript: payload.denoisedTranscript, details: payload.details || {}, discussion: [], actions: [], denoise: payload.denoise || null, discussionGenerated: false, actionsGenerated: false };
      uploadZone.hidden = true; detailsEditor.hidden = false; renderDetails();
      setStatus('Transcript prepared. Check the meeting details before continuing.', false);
    } catch (error) { setStatus(error.message, true); }
    finally { setBusy(false); }
  }

  function readDiscussion() {
    state.discussion = Array.from(document.querySelectorAll('.discussion-card')).map(function (card) {
      return { topic: card.querySelector('[data-topic]').value.trim(), points: card.querySelector('[data-points]').value.split(/\r?\n/).map(function (line) { return line.replace(/^\s*[-•]\s*/, '').trim(); }).filter(Boolean) };
    }).filter(function (item) { return item.topic || item.points.length; });
    return state.discussion;
  }

  function renderDiscussion() {
    var list = document.getElementById('discussionList');
    list.innerHTML = state.discussion.map(function (item, index) {
      return '<div class="discussion-card"><div class="card-head"><input data-topic value="' + escapeHtml(item.topic || '') + '" aria-label="Discussion topic"><button class="delete" data-delete-discussion="' + index + '" type="button">Remove</button></div><textarea data-points aria-label="Discussion points">' + escapeHtml((item.points || []).map(function (point) { return '• ' + point; }).join('\n')) + '</textarea></div>';
    }).join('') || '<p class="muted">No discussion points have been added.</p>';
  }

  function readActions() {
    state.actions = Array.from(document.querySelectorAll('#actionsBody tr')).map(function (row) {
      return { action: row.querySelector('[data-action]').value.trim(), owner: row.querySelector('[data-owner]').value.trim(), deadline: row.querySelector('[data-deadline]').value.trim() };
    }).filter(function (item) { return item.action; });
    return state.actions;
  }

  function participantNames() {
    var attendeeInput = document.getElementById('attendees');
    var attendees = attendeeInput
      ? attendeeInput.value.split(/\r?\n/).map(function (value) { return value.trim(); }).filter(Boolean)
      : ((state.details || {}).allAttendees || []);
    return attendees.filter(function (name, index) {
      return attendees.findIndex(function (candidate) { return candidate.toLocaleLowerCase() === name.toLocaleLowerCase(); }) === index;
    });
  }

  function exactDateValue(value) {
    var text = String(value || '').trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
  }

  function renderActions() {
    var body = document.getElementById('actionsBody');
    var participants = participantNames();
    body.innerHTML = state.actions.map(function (item, index) {
      var owner = String(item.owner || '').trim();
      if (/^not stated$/i.test(owner)) owner = '';
      var participant = participants.find(function (name) { return name.toLocaleLowerCase() === owner.toLocaleLowerCase(); });
      var customOwner = Boolean(owner && !participant);
      var ownerOptions = '<option value=""' + (!owner ? ' selected' : '') + '>Not stated</option>'
        + participants.map(function (name) { return '<option value="' + escapeHtml(name) + '"' + (participant === name ? ' selected' : '') + '>' + escapeHtml(name) + '</option>'; }).join('')
        + '<option value="__other__"' + (customOwner ? ' selected' : '') + '>Other evidenced person…</option>';
      return '<tr><td data-label="Action"><textarea data-action aria-label="Action">' + escapeHtml(item.action || '') + '</textarea></td><td data-label="Owner"><div class="owner-editor"><select data-owner-choice aria-label="Choose an action owner">' + ownerOptions + '</select><input data-owner value="' + escapeHtml(participant || owner) + '" placeholder="Enter evidenced owner" aria-label="Enter another evidenced action owner"' + (customOwner ? '' : ' hidden') + '></div></td><td data-label="Deadline"><div class="deadline-editor"><input data-deadline value="' + escapeHtml(item.deadline || '') + '" placeholder="Not stated" aria-label="Deadline wording"><input data-deadline-picker type="date" value="' + escapeHtml(exactDateValue(item.deadline)) + '" aria-label="Choose an exact deadline date"><span class="deadline-hint">Choose an exact date, or retain the evidenced wording above.</span></div></td><td><button class="delete" data-delete-action="' + index + '" type="button">Remove</button></td></tr>';
    }).join('') || '<tr><td colspan="4" class="muted">No actions have been added.</td></tr>';
  }

  async function runAgent(stage, instruction) {
    readDetails(); if (stage === 'discussion') readDiscussion(); else readActions();
    setBusy(true, instruction ? 'The agent is applying your edits…' : 'The agent is reviewing the denoised transcript…');
    try {
      var current = stage === 'discussion' ? { discussion: state.discussion } : { actions: state.actions };
      var requestOptions = {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage: stage, denoisedTranscript: state.denoisedTranscript, details: state.details, current: current, instruction: instruction || '' })
      };
      var payload;
      var totalAttempts = agentRetryDelaysSeconds.length + 1;
      for (var attempt = 0; attempt < totalAttempts; attempt += 1) {
        if (attempt > 0) await waitForAgentRetry(agentRetryDelaysSeconds[attempt - 1], attempt + 1, totalAttempts);
        try {
          payload = await jsonRequest('/api/meeting-minutes-agent/generate', requestOptions);
          break;
        } catch (error) {
          var usageLimit = error.code === 'M365_AGENT_USAGE_LIMIT' && error.retryable;
          if (!usageLimit) throw error;
          if (attempt === totalAttempts - 1) {
            throw new Error('Microsoft is still temporarily busy after four attempts. Your work has been kept; please try again shortly.');
          }
        }
      }
      if (stage === 'discussion') { state.discussion = payload.discussion || []; state.discussionGenerated = true; renderDiscussion(); showStep(1); }
      else { state.actions = payload.actions || []; state.actionsGenerated = true; renderActions(); showStep(2); }
      setStatus((instruction ? 'Agent edits applied' : (stage === 'discussion' ? 'Discussion points generated' : 'Actions generated')) + '. Review and edit every field before continuing.', false);
      return true;
    } catch (error) { setStatus(error.message, true); return false; }
    finally { setBusy(false); }
  }

  function renderFinal() {
    readDetails(); readDiscussion(); readActions();
    var details = state.details;
    document.getElementById('finalDocument').innerHTML = '<h2>' + escapeHtml(details.meetingTitle || 'Meeting minutes') + '</h2>'
      + '<p><strong>Date:</strong> ' + escapeHtml(details.meetingDate || 'Not stated') + '<br><strong>Location:</strong> ' + escapeHtml(details.meetingLocation || 'Not stated') + '<br><strong>Meeting type:</strong> ' + escapeHtml(details.meetingType || 'Not stated') + '</p>'
      + '<p><strong>Attendees:</strong> ' + escapeHtml((details.allAttendees || []).join(', ') || 'Not stated') + '</p>'
      + '<section><h3>Key discussion points</h3>' + (state.discussion.map(function (item) { return '<h4>' + escapeHtml(item.topic || 'Discussion') + '</h4><ul>' + (item.points || []).map(function (point) { return '<li>' + escapeHtml(point) + '</li>'; }).join('') + '</ul>'; }).join('') || '<p>No discussion points recorded.</p>') + '</section>'
      + '<section><h3>Actions</h3><div class="table-wrap"><table><thead><tr><th>Action</th><th>Owner</th><th>Deadline</th></tr></thead><tbody>' + (state.actions.map(function (item) { return '<tr><td>' + escapeHtml(item.action) + '</td><td>' + escapeHtml(item.owner || 'Not stated') + '</td><td>' + escapeHtml(item.deadline || 'Not stated') + '</td></tr>'; }).join('') || '<tr><td colspan="3">No actions recorded.</td></tr>') + '</tbody></table></div></section>';
  }

  uploadZone.addEventListener('click', function (event) { if (event.target.id !== 'chooseFile') fileInput.click(); });
  document.getElementById('chooseFile').addEventListener('click', function (event) { event.stopPropagation(); fileInput.click(); });
  uploadZone.addEventListener('keydown', function (event) { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); fileInput.click(); } });
  ['dragenter', 'dragover'].forEach(function (name) { uploadZone.addEventListener(name, function (event) { event.preventDefault(); uploadZone.classList.add('dragover'); }); });
  ['dragleave', 'drop'].forEach(function (name) { uploadZone.addEventListener(name, function (event) { event.preventDefault(); uploadZone.classList.remove('dragover'); }); });
  uploadZone.addEventListener('drop', function (event) { prepareFile(event.dataTransfer.files[0]); });
  fileInput.addEventListener('change', function () { prepareFile(fileInput.files[0]); });
  document.getElementById('replaceTranscript').addEventListener('click', function () { fileInput.value = ''; fileInput.click(); });
  document.getElementById('generateDiscussion').addEventListener('click', function () { runAgent('discussion', ''); });
  document.getElementById('generateActions').addEventListener('click', function () { runAgent('actions', ''); });
  document.getElementById('applyDiscussionEdit').addEventListener('click', function () { var input = document.getElementById('discussionInstruction'); if (!input.value.trim()) return setStatus('Describe the discussion edits you want.', true); runAgent('discussion', input.value.trim()).then(function (ok) { if (ok) input.value = ''; }); });
  document.getElementById('applyActionsEdit').addEventListener('click', function () { var input = document.getElementById('actionsInstruction'); if (!input.value.trim()) return setStatus('Describe the action edits you want.', true); runAgent('actions', input.value.trim()).then(function (ok) { if (ok) input.value = ''; }); });
  document.getElementById('addDiscussion').addEventListener('click', function () { readDiscussion(); state.discussion.push({ topic: '', points: [] }); renderDiscussion(); });
  document.getElementById('discussionList').addEventListener('click', function (event) { var button = event.target.closest('[data-delete-discussion]'); if (!button) return; readDiscussion(); state.discussion.splice(Number(button.dataset.deleteDiscussion), 1); renderDiscussion(); });
  document.getElementById('addAction').addEventListener('click', function () { readActions(); state.actions.push({ action: '', owner: '', deadline: '' }); renderActions(); });
  document.getElementById('actionsBody').addEventListener('click', function (event) { var button = event.target.closest('[data-delete-action]'); if (!button) return; readActions(); state.actions.splice(Number(button.dataset.deleteAction), 1); renderActions(); });
  document.getElementById('actionsBody').addEventListener('change', function (event) {
    if (event.target.matches('[data-owner-choice]')) {
      var ownerInput = event.target.closest('.owner-editor').querySelector('[data-owner]');
      var custom = event.target.value === '__other__';
      ownerInput.hidden = !custom;
      if (custom) {
        if (participantNames().some(function (name) { return name.toLocaleLowerCase() === ownerInput.value.trim().toLocaleLowerCase(); })) ownerInput.value = '';
        ownerInput.focus();
      }
      else ownerInput.value = event.target.value;
    }
    if (event.target.matches('[data-deadline-picker]') && event.target.value) {
      event.target.closest('.deadline-editor').querySelector('[data-deadline]').value = event.target.value;
    }
  });
  document.getElementById('openFinalReview').addEventListener('click', function () { renderFinal(); showStep(3); setStatus('Review the complete minutes before printing or sharing.', false); });
  document.getElementById('printMinutes').addEventListener('click', function () { window.print(); });
  document.getElementById('newMinutes').addEventListener('click', function () { window.location.reload(); });
  document.querySelectorAll('[data-back]').forEach(function (button) { button.addEventListener('click', function () { showStep(button.dataset.back); }); });
  document.querySelectorAll('[data-step]').forEach(function (button) { button.addEventListener('click', function () { if (!button.disabled) { if (Number(button.dataset.step) === 3) renderFinal(); showStep(button.dataset.step); } }); });
})();
