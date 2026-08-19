(function () {
  'use strict';

  var script = document.currentScript || Array.prototype.find.call(document.scripts, function (entry) {
    return /review-snippet\.js(?:\?|$)/.test(entry.src || '');
  });

  var config = {
    endpoint: attr('endpoint', ''),
    project: attr('project', ''),
    token: attr('token', ''),
    activateParam: attr('activate-param', 'review'),
    activateValue: attr('activate-value', '1'),
    accent: attr('accent', '#ef3f67'),
    maxImageWidth: numberAttr('max-image-width', 1600)
  };

  var storageKey = 'review-snippet-enabled';
  var state = {
    enabled: false,
    tool: 'browse',
    marks: [],
    draft: null,
    capture: '',
    captureMarks: [],
    captureDraft: null,
    captureTool: 'arrow',
    selection: null,
    snipping: false,
    drawing: false,
    captureDrawing: false,
    message: '',
    busy: false,
    stream: null,
    snipStart: null
  };

  var root;
  var canvas;
  var captureCanvas;
  var selectionBox;
  var toolbar;
  var dialog;
  var messageEl;

  function attr(name, fallback) {
    if (!script) return fallback;
    var value = script.getAttribute('data-' + name);
    return value === null || value === '' ? fallback : value;
  }

  function numberAttr(name, fallback) {
    var value = Number(attr(name, String(fallback)));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  function activateRequested() {
    var url = new URL(window.location.href);
    return url.searchParams.get(config.activateParam) === config.activateValue;
  }

  function boot() {
    injectStyles();
    if (activateRequested()) {
      window.sessionStorage.setItem(storageKey, '1');
    }
    if (activateRequested() || window.sessionStorage.getItem(storageKey) === '1') {
      enable();
    }
  }

  function enable() {
    if (state.enabled) return;
    state.enabled = true;
    window.sessionStorage.setItem(storageKey, '1');
    if (!activateRequested()) {
      var url = new URL(window.location.href);
      url.searchParams.set(config.activateParam, config.activateValue);
      window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
    }
    renderShell();
    repaint();
    window.addEventListener('resize', repaint);
    window.addEventListener('keydown', onKeyDown);
  }

  function disable() {
    state.enabled = false;
    window.sessionStorage.removeItem(storageKey);
    stopStream();
    window.removeEventListener('resize', repaint);
    window.removeEventListener('keydown', onKeyDown);
    if (root) root.remove();
    root = null;
  }

  function renderShell() {
    root = document.createElement('div');
    root.className = 'rs-root';
    root.innerHTML = [
      '<canvas class="rs-canvas" aria-label="Review annotation canvas"></canvas>',
      '<div class="rs-selection" hidden></div>',
      '<div class="rs-toolbar" role="toolbar" aria-label="Review tools">',
      '<strong>Review</strong>',
      button('browse', 'Browse'),
      button('pen', 'Pen'),
      button('arrow', 'Arrow'),
      '<button type="button" data-action="undo">Undo</button>',
      '<button type="button" data-action="clear">Clear</button>',
      '<button type="button" data-action="capture" class="rs-primary">Capture</button>',
      '<button type="button" data-action="exit">Exit</button>',
      '<span class="rs-message" role="status"></span>',
      '</div>',
      '<div class="rs-dialog" role="dialog" aria-modal="true" aria-labelledby="rs-dialog-title" hidden>',
      '<div class="rs-dialog-panel">',
      '<header><div><small>Screenshot captured</small><h2 id="rs-dialog-title">Add feedback</h2></div><button type="button" data-action="close-dialog" aria-label="Close">x</button></header>',
      '<div class="rs-capture-tools">',
      button('capture-pen', 'Draw'),
      button('capture-arrow', 'Arrow'),
      '<button type="button" data-action="capture-undo">Undo</button>',
      '<button type="button" data-action="capture-clear">Clear</button>',
      '</div>',
      '<div class="rs-capture-wrap"><canvas class="rs-capture-canvas" aria-label="Captured screenshot annotation canvas"></canvas></div>',
      '<label>Comment<textarea data-field="comment" rows="4" placeholder="What needs changing?"></textarea></label>',
      '<div class="rs-field-grid">',
      '<label>Priority<select data-field="priority"><option value="low">Low</option><option value="normal" selected>Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></label>',
      '<label>Tags<input data-field="tags" placeholder="mobile, copy, layout"></label>',
      '</div>',
      '<footer><span class="rs-dialog-message"></span><button type="button" data-action="submit" class="rs-primary">Save feedback</button></footer>',
      '</div>',
      '</div>'
    ].join('');
    document.body.appendChild(root);

    canvas = root.querySelector('.rs-canvas');
    captureCanvas = root.querySelector('.rs-capture-canvas');
    selectionBox = root.querySelector('.rs-selection');
    toolbar = root.querySelector('.rs-toolbar');
    dialog = root.querySelector('.rs-dialog');
    messageEl = root.querySelector('.rs-message');

    toolbar.addEventListener('click', onToolbarClick);
    dialog.addEventListener('click', onDialogClick);
    canvas.addEventListener('pointerdown', startDrawing);
    canvas.addEventListener('pointermove', continueDrawing);
    canvas.addEventListener('pointerup', finishDrawing);
    canvas.addEventListener('pointercancel', finishDrawing);
    captureCanvas.addEventListener('pointerdown', startCaptureDrawing);
    captureCanvas.addEventListener('pointermove', continueCaptureDrawing);
    captureCanvas.addEventListener('pointerup', finishCaptureDrawing);
    captureCanvas.addEventListener('pointercancel', finishCaptureDrawing);
    setTool('browse');
  }

  function button(tool, label) {
    return '<button type="button" data-tool="' + escapeHtml(tool) + '">' + escapeHtml(label) + '</button>';
  }

  function onToolbarClick(event) {
    var buttonEl = event.target.closest('button');
    if (!buttonEl) return;
    var tool = buttonEl.getAttribute('data-tool');
    var action = buttonEl.getAttribute('data-action');
    if (tool) setTool(tool);
    if (action === 'undo') {
      state.marks.pop();
      repaint();
    }
    if (action === 'clear') {
      state.marks = [];
      repaint();
    }
    if (action === 'capture') startSnip();
    if (action === 'exit') disable();
  }

  function onDialogClick(event) {
    var buttonEl = event.target.closest('button');
    if (!buttonEl) return;
    var tool = buttonEl.getAttribute('data-tool');
    var action = buttonEl.getAttribute('data-action');
    if (tool === 'capture-pen') setCaptureTool('pen');
    if (tool === 'capture-arrow') setCaptureTool('arrow');
    if (action === 'capture-undo') {
      state.captureMarks.pop();
      repaintCapture();
    }
    if (action === 'capture-clear') {
      state.captureMarks = [];
      repaintCapture();
    }
    if (action === 'close-dialog') closeDialog();
    if (action === 'submit') submitFeedback();
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      if (!dialog.hidden) closeDialog();
      else if (state.snipping) cancelSnip();
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      state.marks.pop();
      repaint();
    }
  }

  function setTool(tool) {
    state.tool = tool;
    state.snipping = false;
    updateButtons();
    repaint();
  }

  function setCaptureTool(tool) {
    state.captureTool = tool;
    updateButtons();
  }

  function updateButtons() {
    if (!root) return;
    root.querySelectorAll('[data-tool]').forEach(function (buttonEl) {
      var value = buttonEl.getAttribute('data-tool');
      var active = value === state.tool || value === 'capture-' + state.captureTool;
      buttonEl.classList.toggle('rs-active', active);
    });
    if (canvas) {
      canvas.classList.toggle('rs-canvas-browse', state.tool === 'browse' && !state.snipping);
      canvas.classList.toggle('rs-canvas-snipping', state.snipping);
    }
  }

  function pointFromEvent(event) {
    return { x: event.clientX, y: event.clientY };
  }

  function startDrawing(event) {
    if (state.snipping) {
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      var start = pointFromEvent(event);
      state.snipStart = start;
      state.selection = { x: start.x, y: start.y, width: 0, height: 0 };
      showSelection();
      return;
    }
    if (state.tool === 'browse') return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    var point = pointFromEvent(event);
    state.drawing = true;
    state.draft = state.tool === 'pen'
      ? { type: 'pen', points: [point] }
      : { type: 'arrow', points: [point, point] };
    repaint();
  }

  function continueDrawing(event) {
    if (state.snipping && state.snipStart) {
      event.preventDefault();
      var start = state.snipStart;
      var end = pointFromEvent(event);
      state.selection = {
        x: Math.min(start.x, end.x),
        y: Math.min(start.y, end.y),
        width: Math.abs(end.x - start.x),
        height: Math.abs(end.y - start.y)
      };
      showSelection();
      return;
    }
    if (!state.drawing || !state.draft) return;
    event.preventDefault();
    var point = pointFromEvent(event);
    if (state.draft.type === 'pen') state.draft.points.push(point);
    else state.draft.points[1] = point;
    repaint();
  }

  function finishDrawing(event) {
    if (state.snipping && state.snipStart) {
      event.preventDefault();
      var selection = state.selection;
      state.snipStart = null;
      cancelSnip(false);
      if (!selection || selection.width < 20 || selection.height < 20) {
        setMessage('Drag a larger area to capture.');
        return;
      }
      captureViewport(selection);
      return;
    }
    if (!state.drawing) return;
    event.preventDefault();
    state.drawing = false;
    if (state.draft) state.marks.push(state.draft);
    state.draft = null;
    repaint();
  }

  function capturePointFromEvent(event) {
    var bounds = captureCanvas.getBoundingClientRect();
    return {
      x: ((event.clientX - bounds.left) / bounds.width) * captureCanvas.width,
      y: ((event.clientY - bounds.top) / bounds.height) * captureCanvas.height
    };
  }

  function startCaptureDrawing(event) {
    if (!state.capture) return;
    event.preventDefault();
    captureCanvas.setPointerCapture(event.pointerId);
    var point = capturePointFromEvent(event);
    state.captureDrawing = true;
    state.captureDraft = state.captureTool === 'pen'
      ? { type: 'pen', points: [point] }
      : { type: 'arrow', points: [point, point] };
    repaintCapture();
  }

  function continueCaptureDrawing(event) {
    if (!state.captureDrawing || !state.captureDraft) return;
    event.preventDefault();
    var point = capturePointFromEvent(event);
    if (state.captureDraft.type === 'pen') state.captureDraft.points.push(point);
    else state.captureDraft.points[1] = point;
    repaintCapture();
  }

  function finishCaptureDrawing(event) {
    if (!state.captureDrawing) return;
    event.preventDefault();
    state.captureDrawing = false;
    if (state.captureDraft) state.captureMarks.push(state.captureDraft);
    state.captureDraft = null;
    repaintCapture();
  }

  function startSnip() {
    state.snipping = true;
    state.tool = 'browse';
    state.selection = null;
    updateButtons();
    setMessage('Drag over the area to capture. Press Esc to cancel.');
  }

  function cancelSnip(clearMessage) {
    state.snipping = false;
    state.selection = null;
    state.snipStart = null;
    if (selectionBox) selectionBox.hidden = true;
    updateButtons();
    if (clearMessage !== false) setMessage('');
  }

  function showSelection() {
    if (!selectionBox || !state.selection) return;
    selectionBox.hidden = false;
    selectionBox.style.left = state.selection.x + 'px';
    selectionBox.style.top = state.selection.y + 'px';
    selectionBox.style.width = state.selection.width + 'px';
    selectionBox.style.height = state.selection.height + 'px';
  }

  function repaint() {
    if (!canvas) return;
    var ratio = window.devicePixelRatio || 1;
    var width = window.innerWidth;
    var height = window.innerHeight;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      canvas.style.width = width + 'px';
      canvas.style.height = height + 'px';
    }
    var context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    state.marks.forEach(function (mark) { paintMark(context, mark); });
    if (state.draft) paintMark(context, state.draft);
  }

  function repaintCapture() {
    if (!captureCanvas || !state.capture) return;
    var image = new Image();
    image.onload = function () {
      captureCanvas.width = image.naturalWidth;
      captureCanvas.height = image.naturalHeight;
      var context = captureCanvas.getContext('2d');
      if (!context) return;
      context.clearRect(0, 0, captureCanvas.width, captureCanvas.height);
      context.drawImage(image, 0, 0);
      state.captureMarks.forEach(function (mark) { paintMark(context, mark); });
      if (state.captureDraft) paintMark(context, state.captureDraft);
    };
    image.src = state.capture;
  }

  function paintMark(context, mark) {
    context.strokeStyle = config.accent;
    context.fillStyle = config.accent;
    context.lineWidth = 4;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    if (mark.type === 'pen') {
      if (!mark.points.length) return;
      context.beginPath();
      context.moveTo(mark.points[0].x, mark.points[0].y);
      mark.points.slice(1).forEach(function (point) { context.lineTo(point.x, point.y); });
      context.stroke();
      return;
    }
    var start = mark.points[0];
    var end = mark.points[1];
    var angle = Math.atan2(end.y - start.y, end.x - start.x);
    var headLength = 18;
    context.beginPath();
    context.moveTo(start.x, start.y);
    context.lineTo(end.x, end.y);
    context.stroke();
    context.beginPath();
    context.moveTo(end.x, end.y);
    context.lineTo(end.x - headLength * Math.cos(angle - Math.PI / 6), end.y - headLength * Math.sin(angle - Math.PI / 6));
    context.lineTo(end.x - headLength * Math.cos(angle + Math.PI / 6), end.y - headLength * Math.sin(angle + Math.PI / 6));
    context.closePath();
    context.fill();
  }

  async function captureViewport(selection) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      setMessage('This browser does not support screenshot capture.');
      return;
    }
    setMessage('Choose the current tab or window to capture.');
    try {
      stopStream();
      state.stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'browser' },
        audio: false
      });
      var video = document.createElement('video');
      video.srcObject = state.stream;
      video.muted = true;
      await video.play();
      await wait(120);

      var source = document.createElement('canvas');
      source.width = video.videoWidth;
      source.height = video.videoHeight;
      var sourceContext = source.getContext('2d');
      sourceContext.drawImage(video, 0, 0);
      stopStream();

      var scaleX = source.width / window.innerWidth;
      var scaleY = source.height / window.innerHeight;
      var crop = {
        x: Math.max(0, Math.round(selection.x * scaleX)),
        y: Math.max(0, Math.round(selection.y * scaleY)),
        width: Math.max(1, Math.min(source.width, Math.round(selection.width * scaleX))),
        height: Math.max(1, Math.min(source.height, Math.round(selection.height * scaleY)))
      };
      var output = document.createElement('canvas');
      var downscale = crop.width > config.maxImageWidth ? config.maxImageWidth / crop.width : 1;
      output.width = Math.round(crop.width * downscale);
      output.height = Math.round(crop.height * downscale);
      var outputContext = output.getContext('2d');
      outputContext.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, output.width, output.height);
      state.capture = output.toDataURL('image/png');
      state.captureMarks = state.marks.slice();
      state.captureDraft = null;
      state.marks = [];
      setMessage('');
      openDialog();
    } catch (error) {
      stopStream();
      setMessage(error && error.message ? error.message : 'The screenshot could not be captured.');
    }
  }

  function openDialog() {
    if (!dialog) return;
    dialog.hidden = false;
    repaint();
    repaintCapture();
    var comment = dialog.querySelector('[data-field="comment"]');
    if (comment) comment.focus();
  }

  function closeDialog() {
    if (!dialog) return;
    dialog.hidden = true;
    state.capture = '';
    state.captureMarks = [];
    state.captureDraft = null;
    setDialogMessage('');
  }

  async function submitFeedback() {
    if (state.busy) return;
    if (!config.endpoint) {
      setDialogMessage('No data-endpoint is configured.');
      return;
    }
    var comment = field('comment').trim();
    if (!comment) {
      setDialogMessage('Add a comment before saving.');
      return;
    }
    state.busy = true;
    setDialogMessage('Saving...');
    try {
      var payload = {
        project: config.project,
        comment: comment,
        priority: field('priority') || 'normal',
        tags: field('tags'),
        pageUrl: window.location.href,
        pagePath: window.location.pathname,
        pageTitle: document.title,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        userAgent: navigator.userAgent,
        screenshotDataUrl: captureCanvas.toDataURL('image/png')
      };
      var headers = { 'Content-Type': 'application/json' };
      if (config.token) headers.Authorization = 'Bearer ' + config.token;
      var response = await fetch(config.endpoint, {
        method: 'POST',
        headers: headers,
        credentials: 'include',
        body: JSON.stringify(payload)
      });
      var body = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(body.error || 'Feedback could not be saved.');
      setDialogMessage('Saved.');
      setTimeout(function () {
        closeDialog();
        setMessage('Feedback saved.');
      }, 650);
    } catch (error) {
      setDialogMessage(error && error.message ? error.message : 'Feedback could not be saved.');
    } finally {
      state.busy = false;
    }
  }

  function field(name) {
    var element = dialog && dialog.querySelector('[data-field="' + name + '"]');
    return element ? element.value || '' : '';
  }

  function setMessage(message) {
    state.message = message;
    if (messageEl) messageEl.textContent = message;
  }

  function setDialogMessage(message) {
    var element = dialog && dialog.querySelector('.rs-dialog-message');
    if (element) element.textContent = message;
  }

  function stopStream() {
    if (!state.stream) return;
    state.stream.getTracks().forEach(function (track) { track.stop(); });
    state.stream = null;
  }

  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (character) {
      return {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      }[character];
    });
  }

  function injectStyles() {
    if (document.getElementById('review-snippet-styles')) return;
    var style = document.createElement('style');
    style.id = 'review-snippet-styles';
    style.textContent = [
      '.rs-root{position:fixed;inset:0;z-index:2147483647;pointer-events:none;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#111827}',
      '.rs-canvas{position:fixed;inset:0;pointer-events:auto;touch-action:none}.rs-canvas-browse{pointer-events:none}.rs-canvas-snipping{cursor:crosshair}',
      '.rs-selection{position:fixed;border:2px solid ' + config.accent + ';background:rgba(239,63,103,.12);box-shadow:0 0 0 9999px rgba(15,23,42,.18);pointer-events:none}',
      '.rs-toolbar{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);display:flex;align-items:center;gap:6px;max-width:calc(100vw - 24px);padding:8px;border:1px solid rgba(15,23,42,.16);border-radius:12px;background:rgba(255,255,255,.96);box-shadow:0 18px 48px rgba(15,23,42,.22);pointer-events:auto}',
      '.rs-toolbar strong{font-size:13px;margin:0 5px;color:#374151}.rs-toolbar button,.rs-dialog button{border:1px solid #d1d5db;border-radius:8px;background:#fff;color:#111827;padding:7px 10px;font:600 12px/1.1 inherit;cursor:pointer;white-space:nowrap}',
      '.rs-toolbar button:hover,.rs-dialog button:hover{border-color:#9ca3af}.rs-toolbar button.rs-active,.rs-dialog button.rs-active{border-color:' + config.accent + ';box-shadow:0 0 0 2px rgba(239,63,103,.14)}',
      '.rs-toolbar .rs-primary,.rs-dialog .rs-primary{background:' + config.accent + ';border-color:' + config.accent + ';color:#fff}.rs-message{min-width:120px;max-width:260px;font-size:12px;color:#4b5563;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.rs-dialog{position:fixed;inset:0;display:grid;place-items:center;background:rgba(15,23,42,.48);pointer-events:auto;padding:18px}.rs-dialog[hidden]{display:none}',
      '.rs-dialog-panel{width:min(980px,100%);max-height:calc(100vh - 36px);display:grid;grid-template-rows:auto auto minmax(220px,1fr) auto auto auto;gap:12px;background:#fff;border-radius:12px;box-shadow:0 30px 90px rgba(15,23,42,.32);padding:16px;overflow:hidden}',
      '.rs-dialog header,.rs-dialog footer,.rs-capture-tools,.rs-field-grid{display:flex;align-items:center;gap:10px}.rs-dialog header{justify-content:space-between}.rs-dialog h2{margin:2px 0 0;font-size:20px}.rs-dialog small{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#6b7280}',
      '.rs-capture-wrap{min-height:0;overflow:auto;border:1px solid #e5e7eb;border-radius:10px;background:#f9fafb}.rs-capture-canvas{display:block;max-width:100%;height:auto;margin:auto;cursor:crosshair}',
      '.rs-dialog label{display:grid;gap:6px;font-size:12px;font-weight:700;color:#374151}.rs-dialog textarea,.rs-dialog input,.rs-dialog select{border:1px solid #d1d5db;border-radius:8px;padding:9px 10px;font:14px/1.4 inherit;color:#111827;background:#fff}.rs-field-grid{align-items:stretch}.rs-field-grid label{flex:1}',
      '.rs-dialog footer{justify-content:space-between}.rs-dialog-message{font-size:13px;color:#4b5563}',
      '@media (max-width: 720px){.rs-toolbar{left:12px;right:12px;bottom:12px;transform:none;flex-wrap:wrap}.rs-message{min-width:0;flex-basis:100%}.rs-dialog{padding:10px}.rs-dialog-panel{max-height:calc(100vh - 20px);padding:12px}.rs-field-grid{display:grid}}'
    ].join('');
    document.head.appendChild(style);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
