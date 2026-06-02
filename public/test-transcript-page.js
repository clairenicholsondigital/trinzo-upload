function buildTranscriptTestPage(config) {
  const state = {
    result: null,
    loading: false
  };

  const root = document.getElementById('transcriptTestRoot');
  root.innerHTML = `
    <section class="panel">
      <h1>${config.title}</h1>
      <p class="intro">${config.intro}</p>
      <div class="field">
        <label for="transcriptFile">Transcript file</label>
        <input id="transcriptFile" type="file" accept=".txt,.docx,.csv,text/plain,text/csv,application/vnd.openxmlformats-officedocument.wordprocessingml.document" />
        <small>Supports pasted text and .txt uploads. .docx and .csv are accepted when extraction is available.</small>
      </div>
      <div class="field">
        <label for="transcriptText">Paste transcript text</label>
        <textarea id="transcriptText" placeholder="Paste transcript here..."></textarea>
        <small>If both a file and pasted text are provided, pasted text takes priority.</small>
      </div>
      <div class="actions">
        <button id="goBtn" type="button">${config.buttonText}</button>
        <button id="clearBtn" class="secondary" type="button">Clear / reset</button>
      </div>
      <div id="message" class="message hidden"></div>
    </section>

    <section id="summaryPanel" class="panel hidden">
      <h2>Summary</h2>
      <div id="summaryGrid" class="summary-grid"></div>
    </section>

    <section id="debugPanel" class="panel hidden">
      <h2>Numbers experiment provenance</h2>
      <div id="debugSummary" class="summary-grid"></div>
      <pre id="debugOutput"></pre>
    </section>

    <section id="jsonPanel" class="panel hidden">
      <div class="json-heading">
        <h2>Raw JSON response</h2>
        <button id="copyBtn" class="secondary" type="button">Copy JSON</button>
      </div>
      <pre id="jsonOutput"></pre>
    </section>
  `;

  const fileInput = document.getElementById('transcriptFile');
  const textInput = document.getElementById('transcriptText');
  const goBtn = document.getElementById('goBtn');
  const clearBtn = document.getElementById('clearBtn');
  const copyBtn = document.getElementById('copyBtn');
  const message = document.getElementById('message');
  const summaryPanel = document.getElementById('summaryPanel');
  const summaryGrid = document.getElementById('summaryGrid');
  const jsonPanel = document.getElementById('jsonPanel');
  const jsonOutput = document.getElementById('jsonOutput');
  const debugPanel = document.getElementById('debugPanel');
  const debugSummary = document.getElementById('debugSummary');
  const debugOutput = document.getElementById('debugOutput');

  function setMessage(text, type) {
    message.textContent = text || '';
    message.className = text ? `message ${type || ''}` : 'message hidden';
  }

  function setLoading(isLoading) {
    state.loading = isLoading;
    goBtn.disabled = isLoading;
    clearBtn.disabled = isLoading;
    fileInput.disabled = isLoading;
    textInput.disabled = isLoading;
    goBtn.textContent = isLoading ? 'Working...' : config.buttonText;
  }

  function displaySummary(result) {
    const items = config.summary(result || {});
    summaryGrid.innerHTML = items.map((item) => `
      <div class="summary-item">
        <div class="summary-label">${item.label}</div>
        <div class="summary-value">${item.value}</div>
      </div>
    `).join('');
    summaryPanel.classList.remove('hidden');
  }

  function displayJson(payload) {
    state.result = payload;
    jsonOutput.textContent = JSON.stringify(payload, null, 2);
    jsonPanel.classList.remove('hidden');
  }

  function displayDebugPanel(result, responsePayload) {
    if (!config.debugPanel) return;

    const debug = result && result.numberExperimentDebug ? result.numberExperimentDebug : {};
    const details = {
      transcriptMetadata: responsePayload.transcriptMetadata || null,
      discussionPointDetails: result && Array.isArray(result.discussionPointDetails) ? result.discussionPointDetails : [],
      decisionDetails: result && Array.isArray(result.decisionDetails) ? result.decisionDetails : [],
      statusReviewPoints: debug.statusReviewPoints || [],
      statusReviewWorkstreams: debug.statusReviewWorkstreams || [],
      finalDiscussionPoints: debug.finalDiscussionPoints || [],
      topicClusters: debug.topicClusters || []
    };

    const digest = responsePayload.transcriptMetadata && responsePayload.transcriptMetadata.transcriptSha256
      ? responsePayload.transcriptMetadata.transcriptSha256
      : 'not requested';
    const detailCounts = [
      { label: 'Input digest', value: digest },
      { label: 'Characters', value: String((responsePayload.transcriptMetadata && responsePayload.transcriptMetadata.transcriptLength) || responsePayload.transcriptLength || 0) },
      { label: 'Discussion details', value: String(details.discussionPointDetails.length) },
      { label: 'Decision details', value: String(details.decisionDetails.length) },
      { label: 'Status points', value: String(details.statusReviewPoints.length) }
    ];

    debugSummary.innerHTML = detailCounts.map((item) => `
      <div class="summary-item">
        <div class="summary-label">${item.label}</div>
        <div class="summary-value">${item.value}</div>
      </div>
    `).join('');
    debugOutput.textContent = JSON.stringify(details, null, 2);
    debugPanel.classList.remove('hidden');
  }

  async function submitTranscript() {
    const pastedText = textInput.value.trim();
    const file = fileInput.files[0];

    if (!pastedText && !file) {
      setMessage('Paste transcript text or choose a transcript file first.', 'error');
      return;
    }

    setLoading(true);
    setMessage('Analysing transcript with local Python logic...', 'info');
    summaryPanel.classList.add('hidden');
    jsonPanel.classList.add('hidden');
    debugPanel.classList.add('hidden');

    try {
      const options = { method: 'POST' };
      if (pastedText) {
        options.headers = { 'Content-Type': 'application/json' };
        options.body = JSON.stringify({ text: pastedText });
      } else {
        const formData = new FormData();
        formData.append('file', file);
        options.body = formData;
      }

      const endpoint = config.includeTranscriptMetadata
        ? `${config.endpoint}${config.endpoint.includes('?') ? '&' : '?'}includeTranscriptMetadata=1`
        : config.endpoint;
      const response = await fetch(endpoint, options);
      const payload = await response.json().catch(() => null);

      if (!response.ok || !payload || payload.ok === false) {
        const detailText = payload && payload.details ? ` ${JSON.stringify(payload.details)}` : '';
        throw new Error((payload && payload.error ? payload.error : `Request failed with status ${response.status}.`) + detailText);
      }

      setMessage(`Done. Analysed ${payload.transcriptLength || 0} characters from ${payload.source || 'transcript'}.`, 'success');
      displaySummary(payload.result);
      displayDebugPanel(payload.result, payload);
      displayJson(payload.result);
    } catch (error) {
      setMessage(error.message || 'Transcript analysis failed.', 'error');
    } finally {
      setLoading(false);
    }
  }

  function resetPage() {
    fileInput.value = '';
    textInput.value = '';
    state.result = null;
    setMessage('', '');
    summaryPanel.classList.add('hidden');
    jsonPanel.classList.add('hidden');
    debugPanel.classList.add('hidden');
    debugOutput.textContent = '';
    debugSummary.innerHTML = '';
    jsonOutput.textContent = '';
  }

  async function copyJson() {
    if (!state.result) return;
    await navigator.clipboard.writeText(JSON.stringify(state.result, null, 2));
    setMessage('JSON copied to clipboard.', 'success');
  }

  goBtn.addEventListener('click', submitTranscript);
  clearBtn.addEventListener('click', resetPage);
  copyBtn.addEventListener('click', copyJson);
}

function listValue(value) {
  if (Array.isArray(value)) return value.join(', ') || '—';
  return value || '—';
}

function meetingMinutesSummary(result) {
  const participants = result.participants || {};
  const clientParticipants = result['participants.client'] || participants.client || [];
  const trinzoParticipants = result['participants.trinzo'] || participants.trinzo || [];
  const actionCount = Array.isArray(result.meetingActionPoint)
    ? result.meetingActionPoint.length
    : Array.isArray(result.nextSteps)
      ? result.nextSteps.length
      : 0;
  return [
    { label: 'Title', value: result.meetingTitle || '—' },
    { label: 'Date', value: result.meetingDate || '—' },
    { label: 'Client participants', value: listValue(clientParticipants) },
    { label: 'Trinzo participants', value: listValue(trinzoParticipants) },
    { label: 'Action count', value: String(actionCount) }
  ];
}

function projectUpdateSummary(result) {
  const segments = Array.isArray(result.segments) ? result.segments : [];
  const counts = segments.reduce((acc, segment) => {
    const status = String(segment.rag_status || 'unknown').toLowerCase();
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
  const changedCount = Array.isArray(result.changes) ? result.changes.length : Number(result.summary && result.summary.changed_count) || 0;
  return [
    { label: 'Milestone count', value: String(segments.length) },
    { label: 'Green', value: String(counts.green || 0) },
    { label: 'Amber', value: String(counts.amber || 0) },
    { label: 'Red', value: String(counts.red || 0) },
    { label: 'Changed', value: String(changedCount) }
  ];
}

function buildTranscriptComparisonPage(config) {
  const state = {
    payload: null,
    loading: false
  };

  const root = document.getElementById('transcriptComparisonRoot');
  root.innerHTML = `
    <section class="panel">
      <h1>${config.title}</h1>
      <p class="intro">${config.intro}</p>
      <div class="field">
        <label for="comparisonTranscriptFile">Transcript file</label>
        <input id="comparisonTranscriptFile" type="file" accept=".txt,.docx,.csv,text/plain,text/csv,application/vnd.openxmlformats-officedocument.wordprocessingml.document" />
        <small>Supports pasted text and .txt uploads. .docx and .csv are accepted when extraction is available.</small>
      </div>
      <div class="field">
        <label for="comparisonTranscriptText">Paste transcript text</label>
        <textarea id="comparisonTranscriptText" placeholder="Paste transcript here..."></textarea>
        <small>If both a file and pasted text are provided, pasted text takes priority.</small>
      </div>
      <div class="actions">
        <button id="comparisonGoBtn" type="button">${config.buttonText}</button>
        <button id="comparisonClearBtn" class="secondary" type="button">Clear / reset</button>
      </div>
      <div id="comparisonMessage" class="message hidden"></div>
    </section>

    <section id="comparisonSummaryPanel" class="panel hidden">
      <h2>Summary</h2>
      <div id="comparisonSummaryGrid" class="summary-grid"></div>
    </section>

    <section id="comparisonOutputsPanel" class="panel hidden">
      <h2>Outputs</h2>
      <p class="note">Baseline is the current numbers extractor. MiniLM is the experimental sidecar variant. The baseline remains the production-safe output.</p>
      <div class="output-grid">
        <div>
          <div class="json-heading">
            <h2>Baseline numbers output</h2>
            <button id="copyBaselineBtn" class="secondary" type="button">Copy baseline</button>
          </div>
          <pre id="baselineOutput"></pre>
        </div>
        <div>
          <div class="json-heading">
            <h2>MiniLM variant output</h2>
            <button id="copyMinilmBtn" class="secondary" type="button">Copy MiniLM</button>
          </div>
          <pre id="minilmOutput"></pre>
        </div>
      </div>
    </section>

    <section id="comparisonDiffPanel" class="panel hidden">
      <div class="json-heading">
        <h2>Diff and diagnostics</h2>
        <button id="copyDiffBtn" class="secondary" type="button">Copy diff</button>
      </div>
      <pre id="diffOutput"></pre>
    </section>
  `;

  const fileInput = document.getElementById('comparisonTranscriptFile');
  const textInput = document.getElementById('comparisonTranscriptText');
  const goBtn = document.getElementById('comparisonGoBtn');
  const clearBtn = document.getElementById('comparisonClearBtn');
  const copyBaselineBtn = document.getElementById('copyBaselineBtn');
  const copyMinilmBtn = document.getElementById('copyMinilmBtn');
  const copyDiffBtn = document.getElementById('copyDiffBtn');
  const message = document.getElementById('comparisonMessage');
  const summaryPanel = document.getElementById('comparisonSummaryPanel');
  const summaryGrid = document.getElementById('comparisonSummaryGrid');
  const outputsPanel = document.getElementById('comparisonOutputsPanel');
  const diffPanel = document.getElementById('comparisonDiffPanel');
  const baselineOutput = document.getElementById('baselineOutput');
  const minilmOutput = document.getElementById('minilmOutput');
  const diffOutput = document.getElementById('diffOutput');

  function setMessage(text, type) {
    message.textContent = text || '';
    message.className = text ? `message ${type || ''}` : 'message hidden';
  }

  function setLoading(isLoading) {
    state.loading = isLoading;
    goBtn.disabled = isLoading;
    clearBtn.disabled = isLoading;
    fileInput.disabled = isLoading;
    textInput.disabled = isLoading;
    goBtn.textContent = isLoading ? 'Working...' : config.buttonText;
  }

  function comparisonSummaryItems(payload) {
    const result = payload && payload.result ? payload.result : {};
    const baseline = result.baseline || {};
    const minilm = result.minilm || {};
    const comparison = result.comparison || {};
    const baselineCounts = comparison.baselineCounts || {};
    const minilmCounts = comparison.minilmCounts || {};
    const modelStatus = minilm.modelAvailable ? 'available' : `unavailable: ${minilm.modelReason || 'unknown reason'}`;
    return [
      { label: 'Baseline actions', value: String(baselineCounts.actions || 0) },
      { label: 'MiniLM actions', value: String(minilmCounts.actions || 0) },
      { label: 'Baseline decisions', value: String(baselineCounts.decisions || 0) },
      { label: 'MiniLM decisions', value: String(minilmCounts.decisions || 0) },
      { label: 'Baseline discussion', value: String(baselineCounts.discussionPoints || 0) },
      { label: 'MiniLM discussion', value: String(minilmCounts.discussionPoints || 0) },
      { label: 'Model status', value: modelStatus },
      { label: 'Runtime ms', value: String((result.timingMs && result.timingMs.total) || 0) }
    ];
  }

  function displayPayload(payload) {
    state.payload = payload;
    const items = comparisonSummaryItems(payload);
    summaryGrid.innerHTML = items.map((item) => `
      <div class="summary-item">
        <div class="summary-label">${item.label}</div>
        <div class="summary-value">${item.value}</div>
      </div>
    `).join('');
    summaryPanel.classList.remove('hidden');

    const result = payload.result || {};
    baselineOutput.textContent = JSON.stringify(result.baseline || {}, null, 2);
    minilmOutput.textContent = JSON.stringify(result.minilm || {}, null, 2);
    diffOutput.textContent = JSON.stringify({
      comparison: result.comparison || {},
      timingMs: result.timingMs || {},
      transcriptMetadata: payload.transcriptMetadata || null
    }, null, 2);

    outputsPanel.classList.remove('hidden');
    diffPanel.classList.remove('hidden');
  }

  async function submitTranscript() {
    const pastedText = textInput.value.trim();
    const file = fileInput.files[0];

    if (!pastedText && !file) {
      setMessage('Paste transcript text or choose a transcript file first.', 'error');
      return;
    }

    setLoading(true);
    setMessage('Running baseline numbers output and MiniLM variant side by side...', 'info');
    summaryPanel.classList.add('hidden');
    outputsPanel.classList.add('hidden');
    diffPanel.classList.add('hidden');

    try {
      const options = { method: 'POST' };
      if (pastedText) {
        options.headers = { 'Content-Type': 'application/json' };
        options.body = JSON.stringify({ text: pastedText });
      } else {
        const formData = new FormData();
        formData.append('file', file);
        options.body = formData;
      }

      const endpoint = `${config.endpoint}?includeTranscriptMetadata=1`;
      const response = await fetch(endpoint, options);
      const payload = await response.json().catch(() => null);

      if (!response.ok || !payload || payload.ok === false) {
        const detailText = payload && payload.details ? ` ${JSON.stringify(payload.details)}` : '';
        throw new Error((payload && payload.error ? payload.error : `Request failed with status ${response.status}.`) + detailText);
      }

      setMessage(`Done. Compared ${payload.transcriptLength || 0} characters from ${payload.source || 'transcript'}.`, 'success');
      displayPayload(payload);
    } catch (error) {
      setMessage(error.message || 'Transcript comparison failed.', 'error');
    } finally {
      setLoading(false);
    }
  }

  function resetPage() {
    fileInput.value = '';
    textInput.value = '';
    state.payload = null;
    setMessage('', '');
    summaryPanel.classList.add('hidden');
    outputsPanel.classList.add('hidden');
    diffPanel.classList.add('hidden');
    baselineOutput.textContent = '';
    minilmOutput.textContent = '';
    diffOutput.textContent = '';
  }

  async function copyValue(value, label) {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setMessage(`${label} copied to clipboard.`, 'success');
  }

  goBtn.addEventListener('click', submitTranscript);
  clearBtn.addEventListener('click', resetPage);
  copyBaselineBtn.addEventListener('click', () => copyValue(baselineOutput.textContent, 'Baseline output'));
  copyMinilmBtn.addEventListener('click', () => copyValue(minilmOutput.textContent, 'MiniLM output'));
  copyDiffBtn.addEventListener('click', () => copyValue(diffOutput.textContent, 'Diff output'));
}

function buildTranscriptMinilmOnlyPage(config) {
  const state = {
    payload: null,
    loading: false
  };

  const root = document.getElementById('transcriptMinilmOnlyRoot');
  root.innerHTML = `
    <section class="panel">
      <h1>${config.title}</h1>
      <p class="intro">${config.intro}</p>
      <div class="field">
        <label for="minilmOnlyTranscriptFile">Transcript file</label>
        <input id="minilmOnlyTranscriptFile" type="file" accept=".txt,.docx,.csv,text/plain,text/csv,application/vnd.openxmlformats-officedocument.wordprocessingml.document" />
        <small>Supports pasted text and .txt uploads. .docx and .csv are accepted when extraction is available.</small>
      </div>
      <div class="field">
        <label for="minilmOnlyTranscriptText">Paste transcript text</label>
        <textarea id="minilmOnlyTranscriptText" placeholder="Paste transcript here..."></textarea>
        <small>If both a file and pasted text are provided, pasted text takes priority.</small>
      </div>
      <div class="actions">
        <button id="minilmOnlyGoBtn" type="button">${config.buttonText}</button>
        <button id="minilmOnlyClearBtn" class="secondary" type="button">Clear / reset</button>
      </div>
      <div id="minilmOnlyMessage" class="message hidden"></div>
    </section>

    <section id="minilmOnlySummaryPanel" class="panel hidden">
      <h2>Summary</h2>
      <div id="minilmOnlySummaryGrid" class="summary-grid"></div>
    </section>

    <section id="minilmOnlyOutputPanel" class="panel hidden">
      <div class="json-heading">
        <h2>MiniLM-only output</h2>
        <button id="copyMinilmOnlyOutputBtn" class="secondary" type="button">Copy output</button>
      </div>
      <pre id="minilmOnlyOutput"></pre>
    </section>

    <section id="minilmOnlyDiagnosticsPanel" class="panel hidden">
      <div class="json-heading">
        <h2>Diagnostics</h2>
        <button id="copyMinilmOnlyDiagnosticsBtn" class="secondary" type="button">Copy diagnostics</button>
      </div>
      <pre id="minilmOnlyDiagnostics"></pre>
    </section>
  `;

  const fileInput = document.getElementById('minilmOnlyTranscriptFile');
  const textInput = document.getElementById('minilmOnlyTranscriptText');
  const goBtn = document.getElementById('minilmOnlyGoBtn');
  const clearBtn = document.getElementById('minilmOnlyClearBtn');
  const copyOutputBtn = document.getElementById('copyMinilmOnlyOutputBtn');
  const copyDiagnosticsBtn = document.getElementById('copyMinilmOnlyDiagnosticsBtn');
  const message = document.getElementById('minilmOnlyMessage');
  const summaryPanel = document.getElementById('minilmOnlySummaryPanel');
  const summaryGrid = document.getElementById('minilmOnlySummaryGrid');
  const outputPanel = document.getElementById('minilmOnlyOutputPanel');
  const diagnosticsPanel = document.getElementById('minilmOnlyDiagnosticsPanel');
  const outputNode = document.getElementById('minilmOnlyOutput');
  const diagnosticsNode = document.getElementById('minilmOnlyDiagnostics');

  function setMessage(text, type) {
    message.textContent = text || '';
    message.className = text ? `message ${type || ''}` : 'message hidden';
  }

  function setLoading(isLoading) {
    state.loading = isLoading;
    goBtn.disabled = isLoading;
    clearBtn.disabled = isLoading;
    fileInput.disabled = isLoading;
    textInput.disabled = isLoading;
    goBtn.textContent = isLoading ? 'Working...' : config.buttonText;
  }

  function displayPayload(payload) {
    state.payload = payload;
    const result = payload.result || {};
    const items = [
      { label: 'Model status', value: result.modelAvailable ? 'available' : `unavailable: ${result.modelReason || 'unknown reason'}` },
      { label: 'Discussion points', value: String((result.counts && result.counts.discussionPoints) || 0) },
      { label: 'Decisions', value: String((result.counts && result.counts.decisions) || 0) },
      { label: 'Actions', value: String((result.counts && result.counts.actions) || 0) },
      { label: 'Runtime ms', value: String((result.timingMs && result.timingMs.total) || 0) },
      { label: 'Transcript chars', value: String(payload.transcriptLength || 0) }
    ];
    summaryGrid.innerHTML = items.map((item) => `
      <div class="summary-item">
        <div class="summary-label">${item.label}</div>
        <div class="summary-value">${item.value}</div>
      </div>
    `).join('');
    summaryPanel.classList.remove('hidden');

    outputNode.textContent = JSON.stringify(result.output || {}, null, 2);
    diagnosticsNode.textContent = JSON.stringify({
      mode: result.mode || 'minilm_only',
      diagnostics: result.diagnostics || {},
      timingMs: result.timingMs || {},
      transcriptMetadata: payload.transcriptMetadata || null
    }, null, 2);
    outputPanel.classList.remove('hidden');
    diagnosticsPanel.classList.remove('hidden');
  }

  async function submitTranscript() {
    const pastedText = textInput.value.trim();
    const file = fileInput.files[0];

    if (!pastedText && !file) {
      setMessage('Paste transcript text or choose a transcript file first.', 'error');
      return;
    }

    setLoading(true);
    setMessage('Running MiniLM-only transcript extraction...', 'info');
    summaryPanel.classList.add('hidden');
    outputPanel.classList.add('hidden');
    diagnosticsPanel.classList.add('hidden');

    try {
      const options = { method: 'POST' };
      if (pastedText) {
        options.headers = { 'Content-Type': 'application/json' };
        options.body = JSON.stringify({ text: pastedText });
      } else {
        const formData = new FormData();
        formData.append('file', file);
        options.body = formData;
      }

      const endpoint = `${config.endpoint}?includeTranscriptMetadata=1`;
      const response = await fetch(endpoint, options);
      const payload = await response.json().catch(() => null);

      if (!response.ok || !payload || payload.ok === false) {
        const detailText = payload && payload.details ? ` ${JSON.stringify(payload.details)}` : '';
        throw new Error((payload && payload.error ? payload.error : `Request failed with status ${response.status}.`) + detailText);
      }

      setMessage(`Done. Ran MiniLM-only extraction on ${payload.transcriptLength || 0} characters.`, 'success');
      displayPayload(payload);
    } catch (error) {
      setMessage(error.message || 'MiniLM-only transcript analysis failed.', 'error');
    } finally {
      setLoading(false);
    }
  }

  function resetPage() {
    fileInput.value = '';
    textInput.value = '';
    state.payload = null;
    setMessage('', '');
    summaryPanel.classList.add('hidden');
    outputPanel.classList.add('hidden');
    diagnosticsPanel.classList.add('hidden');
    outputNode.textContent = '';
    diagnosticsNode.textContent = '';
  }

  async function copyValue(value, label) {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setMessage(`${label} copied to clipboard.`, 'success');
  }

  goBtn.addEventListener('click', submitTranscript);
  clearBtn.addEventListener('click', resetPage);
  copyOutputBtn.addEventListener('click', () => copyValue(outputNode.textContent, 'MiniLM-only output'));
  copyDiagnosticsBtn.addEventListener('click', () => copyValue(diagnosticsNode.textContent, 'MiniLM-only diagnostics'));
}
