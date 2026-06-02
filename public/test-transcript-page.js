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

      const endpoint = config.endpoint;
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
    loading: false,
    improving: false,
    schemaOutput: null,
    extractedText: ''
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
        ${config.improveEndpoint ? '<button id="minilmOnlyImproveBtn" class="secondary" type="button" disabled>Improve minutes</button>' : ''}
        <button id="minilmOnlyClearBtn" class="secondary" type="button">Clear / reset</button>
      </div>
      <div id="minilmOnlyMessage" class="message hidden"></div>
    </section>

    <section id="minilmOnlyOutputPanel" class="panel hidden">
      <div class="json-heading">
        <h2>Minutes output</h2>
        <button id="copyMinilmOnlyOutputBtn" class="secondary" type="button">Copy schema JSON</button>
      </div>
      <div id="minilmOnlyOutput"></div>
      <div class="panel-actions">
        <button id="finaliseBtn" type="button" class="hidden">Confirm & Send to SharePoint</button>
      </div>
    </section>

    <section id="minilmOnlyDiagnosticsPanel" class="panel hidden">
      <div class="accordion">
        <details>
          <summary>Details</summary>
          <div class="accordion-body">
            <div class="accordion">
              <details>
                <summary>Summary</summary>
                <div class="accordion-body">
                  <div id="minilmOnlySummaryGrid" class="summary-grid"></div>
                </div>
              </details>
              <details>
                <summary>Raw output</summary>
                <div class="accordion-body">
                  <div class="json-heading">
                    <span class="note">Current raw MiniLM-only payload</span>
                    <button id="copyMinilmOnlyRawBtn" class="secondary" type="button">Copy raw output</button>
                  </div>
                  <pre id="minilmOnlyRawOutput"></pre>
                </div>
              </details>
              <details>
                <summary>Diagnostics</summary>
                <div class="accordion-body">
                  <div class="json-heading">
                    <span class="note">Current diagnostics, timings, and transcript metadata</span>
                    <button id="copyMinilmOnlyDiagnosticsBtn" class="secondary" type="button">Copy diagnostics</button>
                  </div>
                  <pre id="minilmOnlyDiagnostics"></pre>
                </div>
              </details>
            </div>
          </div>
        </details>
      </div>
    </section>
  `;

  const fileInput = document.getElementById('minilmOnlyTranscriptFile');
  const textInput = document.getElementById('minilmOnlyTranscriptText');
  const goBtn = document.getElementById('minilmOnlyGoBtn');
  const improveBtn = document.getElementById('minilmOnlyImproveBtn');
  const clearBtn = document.getElementById('minilmOnlyClearBtn');
  const copyOutputBtn = document.getElementById('copyMinilmOnlyOutputBtn');
  const copyRawBtn = document.getElementById('copyMinilmOnlyRawBtn');
  const copyDiagnosticsBtn = document.getElementById('copyMinilmOnlyDiagnosticsBtn');
  const finaliseBtn = document.getElementById('finaliseBtn');
  const message = document.getElementById('minilmOnlyMessage');
  const summaryGrid = document.getElementById('minilmOnlySummaryGrid');
  const outputPanel = document.getElementById('minilmOnlyOutputPanel');
  const diagnosticsPanel = document.getElementById('minilmOnlyDiagnosticsPanel');
  const outputNode = document.getElementById('minilmOnlyOutput');
  const rawOutputNode = document.getElementById('minilmOnlyRawOutput');
  const diagnosticsNode = document.getElementById('minilmOnlyDiagnostics');
  const REVIEW_STORAGE_KEY = 'reviewData';

  let currentMeetingId = Number(localStorage.getItem('meetingId') || 0);

  function setStep(n) {
    const stepper = document.getElementById('stepper');
    if (!stepper) return;
    stepper.querySelectorAll('.step').forEach((node) => {
      node.classList.toggle('active', Number(node.dataset.step) === Number(n));
    });
  }

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function saveReviewDataToStorage(data) {
    localStorage.setItem(REVIEW_STORAGE_KEY, JSON.stringify(data || {}));
  }

  function getReviewDataFromStorage() {
    const raw = localStorage.getItem(REVIEW_STORAGE_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function setMessage(text, type) {
    message.textContent = text || '';
    message.className = text ? `message ${type || ''}` : 'message hidden';
  }

  function setLoading(isLoading) {
    state.loading = isLoading;
    goBtn.disabled = isLoading || state.improving;
    clearBtn.disabled = isLoading || state.improving;
    fileInput.disabled = isLoading || state.improving;
    textInput.disabled = isLoading || state.improving;
    if (improveBtn) {
      improveBtn.disabled = isLoading || state.improving || !(state.payload && state.payload.result && state.payload.result.output);
    }
    goBtn.textContent = isLoading ? 'Working...' : config.buttonText;
  }

  function setImproving(isImproving) {
    state.improving = isImproving;
    goBtn.disabled = isImproving || state.loading;
    clearBtn.disabled = isImproving || state.loading;
    fileInput.disabled = isImproving || state.loading;
    textInput.disabled = isImproving || state.loading;
    if (improveBtn) {
      improveBtn.disabled = isImproving || state.loading || !(state.payload && state.payload.result && state.payload.result.output);
      improveBtn.textContent = isImproving ? 'Improving...' : 'Improve minutes';
    }
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function deriveObjectives(output) {
    if (Array.isArray(output.objectives) && output.objectives.length) return output.objectives;
    if (Array.isArray(output.meetingObjectives) && output.meetingObjectives.length) return output.meetingObjectives;
    const decisions = Array.isArray(output.decisions) ? output.decisions : [];
    if (decisions.length) return decisions.slice(0, 2).map((point) => point.replace(/\.$/, ''));
    const points = Array.isArray(output.discussionPoints) ? output.discussionPoints : [];
    return points.slice(0, 2).map((point) => point.replace(/\.$/, ''));
  }

  function buildStructuredMinutesSchema(output) {
    const participants = output.participants || {};
    const actionPoints = Array.isArray(output.meetingActionPoint) ? output.meetingActionPoint : [];
    const actionOwners = Array.isArray(output.meetingActionPointOwner) ? output.meetingActionPointOwner : [];
    const actionDeadlines = Array.isArray(output.meetingActionPointDeadline) ? output.meetingActionPointDeadline : [];
    const discussionPoints = Array.isArray(output.discussionPoints) ? output.discussionPoints : [];
    return {
      meetingTitle: output.meetingTitle || '',
      meetingDate: output.meetingDate || '',
      meetingLocation: output.meetingLocation || 'Online',
      meetingObjectives: deriveObjectives(output),
      participants: {
        client: Array.isArray(participants.client) ? participants.client : [],
        trinzo: Array.isArray(participants.trinzo) ? participants.trinzo : []
      },
      itemTopic: output.itemTopic || output.meetingTitle || 'Meeting discussion',
      discussionPoints,
      meetingActionPoint: actionPoints,
      meetingActionPointOwner: actionOwners,
      meetingActionPointDeadline: actionDeadlines
    };
  }

  function displayDetailsSummary(payload, result) {
    const output = result.output || {};
    const modelStatus = Object.prototype.hasOwnProperty.call(result, 'modelAvailable')
      ? (result.modelAvailable ? 'available' : `unavailable: ${result.modelReason || 'unknown reason'}`)
      : 'not rerun';
    const items = [
      { label: 'Model status', value: modelStatus },
      { label: 'Rewrite status', value: Object.prototype.hasOwnProperty.call(result, 'rewriterAvailable') ? (result.rewriterAvailable ? 'available' : `unavailable: ${result.rewriterReason || 'unknown reason'}`) : 'not run' },
      { label: 'Discussion points', value: String((result.counts && result.counts.discussionPoints) || 0) },
      { label: 'Decisions', value: String((result.counts && result.counts.decisions) || 0) },
      { label: 'Actions', value: String((result.counts && result.counts.actions) || 0) },
      { label: 'Runtime ms', value: String((result.timingMs && result.timingMs.total) || 0) },
      { label: 'Transcript chars', value: String(payload.transcriptLength || 0) },
      { label: 'Title', value: output.meetingTitle || '—' }
    ];
    summaryGrid.innerHTML = items.map((item) => `
      <div class="summary-item">
        <div class="summary-label">${escapeHtml(item.label)}</div>
        <div class="summary-value">${escapeHtml(item.value)}</div>
      </div>
    `).join('');
  }

  function renderTextarea(id, items, placeholder) {
    const value = Array.isArray(items) ? items.join('\n') : (items || '');
    return `<textarea id="${id}" placeholder="${escapeHtml(placeholder || '')}">${escapeHtml(value)}</textarea>`;
  }

  function renderActionTable(schemaOutput) {
    const actions = Array.isArray(schemaOutput.meetingActionPoint) ? schemaOutput.meetingActionPoint : [];
    const owners = Array.isArray(schemaOutput.meetingActionPointOwner) ? schemaOutput.meetingActionPointOwner : [];
    const deadlines = Array.isArray(schemaOutput.meetingActionPointDeadline) ? schemaOutput.meetingActionPointDeadline : [];
    const rowCount = Math.max(actions.length, owners.length, deadlines.length, 1);
    return `
      <table class="schema-subtable" id="actionsTable">
        <thead>
          <tr>
            <th>Action</th>
            <th>Owner</th>
            <th>Deadline</th>
          </tr>
        </thead>
        <tbody>
          ${Array.from({ length: rowCount }).map((_, index) => `
            <tr>
              <td><input type="text" data-action-field="action" value="${escapeHtml(actions[index] || '')}" placeholder="Action" /></td>
              <td><input type="text" data-action-field="owner" value="${escapeHtml(owners[index] || '')}" placeholder="Owner" /></td>
              <td><input type="text" data-action-field="deadline" value="${escapeHtml(deadlines[index] || '')}" placeholder="Deadline" /></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      <div class="schema-inline-actions">
        <button id="addActionRowBtn" class="secondary" type="button">Add action row</button>
      </div>
    `;
  }

  function renderParticipantsTable(participants) {
    const client = Array.isArray(participants.client) ? participants.client : [];
    const trinzo = Array.isArray(participants.trinzo) ? participants.trinzo : [];
    return `
      <table class="schema-subtable">
        <thead>
          <tr>
            <th>Client</th>
            <th>Trinzo</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>${renderTextarea('participantsClientInput', client, 'One client participant per line')}</td>
            <td>${renderTextarea('participantsTrinzoInput', trinzo, 'One Trinzo participant per line')}</td>
          </tr>
        </tbody>
      </table>
    `;
  }

  function renderSchemaTable(schemaOutput) {
    return `
      <table class="schema-table">
        <tbody>
          <tr>
            <th>Meeting title</th>
            <td><input id="meetingTitleInput" type="text" value="${escapeHtml(schemaOutput.meetingTitle || '')}" placeholder="Meeting title" /></td>
          </tr>
          <tr>
            <th>Meeting date</th>
            <td><input id="meetingDateInput" type="text" value="${escapeHtml(schemaOutput.meetingDate || '')}" placeholder="Meeting date" /></td>
          </tr>
          <tr>
            <th>Meeting location</th>
            <td><input id="meetingLocationInput" type="text" value="${escapeHtml(schemaOutput.meetingLocation || '')}" placeholder="Meeting location" /></td>
          </tr>
          <tr>
            <th>Meeting objectives</th>
            <td>${renderTextarea('meetingObjectivesInput', schemaOutput.meetingObjectives, 'One objective per line')}</td>
          </tr>
          <tr>
            <th>Participants</th>
            <td>${renderParticipantsTable(schemaOutput.participants || {})}</td>
          </tr>
          <tr>
            <th>Discussion points</th>
            <td>${renderTextarea('discussionPointsInput', schemaOutput.discussionPoints, 'One discussion point per line')}</td>
          </tr>
          <tr>
            <th>Actions</th>
            <td>${renderActionTable(schemaOutput)}</td>
          </tr>
        </tbody>
      </table>
    `;
  }

  function parseLines(value) {
    return String(value || '')
      .split('\n')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function collectEditedSchemaOutput() {
    if (!state.schemaOutput) return null;
    const schema = {
      meetingTitle: document.getElementById('meetingTitleInput')?.value.trim() || '',
      meetingDate: document.getElementById('meetingDateInput')?.value.trim() || '',
      meetingLocation: document.getElementById('meetingLocationInput')?.value.trim() || '',
      meetingObjectives: parseLines(document.getElementById('meetingObjectivesInput')?.value || ''),
      participants: {
        client: parseLines(document.getElementById('participantsClientInput')?.value || ''),
        trinzo: parseLines(document.getElementById('participantsTrinzoInput')?.value || ''),
      },
      itemTopic: state.schemaOutput?.itemTopic || state.payload?.result?.output?.itemTopic || state.payload?.result?.output?.meetingTitle || 'Meeting discussion',
      discussionPoints: parseLines(document.getElementById('discussionPointsInput')?.value || ''),
      meetingActionPoint: [],
      meetingActionPointOwner: [],
      meetingActionPointDeadline: []
    };

    const actionRows = Array.from(outputNode.querySelectorAll('#actionsTable tbody tr'));
    actionRows.forEach((row) => {
      const action = row.querySelector('[data-action-field="action"]')?.value.trim() || '';
      const owner = row.querySelector('[data-action-field="owner"]')?.value.trim() || '';
      const deadline = row.querySelector('[data-action-field="deadline"]')?.value.trim() || '';
      if (!action && !owner && !deadline) return;
      schema.meetingActionPoint.push(action);
      schema.meetingActionPointOwner.push(owner || 'Owner not specified');
      schema.meetingActionPointDeadline.push(deadline);
    });
    return schema;
  }

  function buildEditableOutputFromSchema(schema) {
    const output = cloneJson((state.payload && state.payload.result && state.payload.result.output) || {});
    output.meetingTitle = schema.meetingTitle;
    output.meetingDate = schema.meetingDate;
    output.meetingLocation = schema.meetingLocation;
    output.meetingObjectives = schema.meetingObjectives;
    output.participants = {
      client: schema.participants.client,
      trinzo: schema.participants.trinzo,
    };
    output.itemTopic = schema.itemTopic;
    output.discussionPoints = schema.discussionPoints;
    output.meetingActionPoint = schema.meetingActionPoint;
    output.meetingActionPointOwner = schema.meetingActionPointOwner;
    output.meetingActionPointDeadline = schema.meetingActionPointDeadline;
    output.actions = schema.meetingActionPoint.map((action, index) => ({
      meetingActionPoint: action,
      meetingActionPointOwner: schema.meetingActionPointOwner[index] || 'Owner not specified',
      meetingActionPointDeadline: schema.meetingActionPointDeadline[index] || '',
      actionConfidence: Array.isArray(output.actions) && output.actions[index] ? output.actions[index].actionConfidence || 0 : 0,
      relatedMilestone: Array.isArray(output.actions) && output.actions[index] ? output.actions[index].relatedMilestone || 'minilm_only' : 'minilm_only',
      _evidence: Array.isArray(output.actions) && output.actions[index] ? output.actions[index]._evidence || [] : [],
    }));
    if (output.internalEvidence && typeof output.internalEvidence === 'object') {
      output.internalEvidence.actions = output.actions.map((item) => ({ text: item.meetingActionPoint, _evidence: item._evidence || [] }));
      output.internalEvidence.discussionPoints = schema.discussionPoints.map((text, index) => {
        const current = Array.isArray(output.internalEvidence.discussionPoints) ? output.internalEvidence.discussionPoints[index] : null;
        return { text, _evidence: current && Array.isArray(current._evidence) ? current._evidence : [] };
      });
    }
    return output;
  }

  function buildReviewDataFromSchema(schema) {
    return {
      meetingTitle: schema.meetingTitle || '',
      meetingDate: schema.meetingDate || '',
      meetingLocation: schema.meetingLocation || '',
      meetingDescription: '',
      meetingObjectives: Array.isArray(schema.meetingObjectives) ? schema.meetingObjectives : [],
      participants: {
        client: Array.isArray(schema.participants?.client) ? schema.participants.client : [],
        trinzo: Array.isArray(schema.participants?.trinzo) ? schema.participants.trinzo : [],
      },
      meetingMinutes: [
        {
          topic: schema.itemTopic || '',
          discussionPoints: Array.isArray(schema.discussionPoints) ? schema.discussionPoints : [],
        }
      ],
      nextSteps: (schema.meetingActionPoint || []).map((action, index) => ({
        action,
        owner: schema.meetingActionPointOwner[index] || 'Owner not specified',
        deadline: schema.meetingActionPointDeadline[index] || '',
      })),
      autosave: {
        enabled: true,
        savedAt: new Date().toISOString(),
        transcript: state.extractedText || '',
        transcriptLength: (state.extractedText || '').length,
      },
    };
  }

  function attachSchemaHandlers() {
    const addActionRowBtn = document.getElementById('addActionRowBtn');
    if (addActionRowBtn) {
      addActionRowBtn.addEventListener('click', () => {
        const tableBody = outputNode.querySelector('.schema-subtable tbody');
        if (!tableBody) return;
        tableBody.insertAdjacentHTML('beforeend', `
          <tr>
            <td><input type="text" data-action-field="action" value="" placeholder="Action" /></td>
            <td><input type="text" data-action-field="owner" value="" placeholder="Owner" /></td>
            <td><input type="text" data-action-field="deadline" value="" placeholder="Deadline" /></td>
          </tr>
        `);
      });
    }
  }

  async function finaliseWithAgent() {
    const editedSchema = collectEditedSchemaOutput();
    const payloadReviewData = editedSchema ? buildReviewDataFromSchema(editedSchema) : getReviewDataFromStorage();

    if (!payloadReviewData) {
      return setMessage(
        'No review data found. Process transcript first, then use the edit screen.',
        'error'
      );
    }

    saveReviewDataToStorage(payloadReviewData);
    setStep(5);
    setMessage('Sending approved meeting minutes to webhook...', 'info');

    try {
      if (currentMeetingId) {
        await fetch(`/api/meetings/${currentMeetingId}/webhook`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            reviewData: payloadReviewData,
            transcript: state.extractedText
          })
        });
      }

      const response = await fetch('/api/agent/finalise', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          reviewData: payloadReviewData,
          transcript: state.extractedText
        })
      });

      const data = await response.json();

      if (!response.ok || !data.ok) {
        throw new Error(data.error || 'Final webhook call failed');
      }

      setMessage('Successfully sent to SharePoint', 'success');
    } catch (err) {
      setMessage(`Final webhook call failed: ${err.message}`, 'error');
    }
  }

  function displayPayload(payload) {
    state.payload = payload;
    const result = payload.result || {};
    const output = result.output || {};
    const schemaOutput = buildStructuredMinutesSchema(output);
    state.schemaOutput = schemaOutput;

    displayDetailsSummary(payload, result);
    outputNode.innerHTML = renderSchemaTable(schemaOutput);
    attachSchemaHandlers();
    saveReviewDataToStorage(buildReviewDataFromSchema(schemaOutput));
    rawOutputNode.textContent = JSON.stringify(output, null, 2);
    diagnosticsNode.textContent = JSON.stringify({
      mode: result.mode || 'minilm_only',
      diagnostics: result.diagnostics || {},
      timingMs: result.timingMs || {},
      transcriptMetadata: payload.transcriptMetadata || null
    }, null, 2);
    outputPanel.classList.remove('hidden');
    diagnosticsPanel.classList.remove('hidden');
    if (finaliseBtn) finaliseBtn.classList.remove('hidden');
    if (improveBtn) improveBtn.disabled = !(state.payload && state.payload.result && state.payload.result.output);
  }

  async function submitTranscript() {
    const pastedText = textInput.value.trim();
    const file = fileInput.files[0];

    if (!pastedText && !file) {
      setMessage('Paste transcript text or choose a transcript file first.', 'error');
      return;
    }

    setLoading(true);
    setMessage('Running meeting minutes extraction...', 'info');
    outputPanel.classList.add('hidden');
    diagnosticsPanel.classList.add('hidden');

    try {
      const options = { method: 'POST' };
      if (pastedText) {
        state.extractedText = pastedText;
        options.headers = { 'Content-Type': 'application/json' };
        options.body = JSON.stringify({ text: pastedText });
      } else {
        const formData = new FormData();
        formData.append('file', file);
        options.body = formData;
        state.extractedText = await file.text().catch(() => '');
      }

      const endpoint = `${config.endpoint}?includeTranscriptMetadata=1`;
      const response = await fetch(endpoint, options);
      const payload = await response.json().catch(() => null);

      if (!response.ok || !payload || payload.ok === false) {
        const detailText = payload && payload.details ? ` ${JSON.stringify(payload.details)}` : '';
        throw new Error((payload && payload.error ? payload.error : `Request failed with status ${response.status}.`) + detailText);
      }

      setMessage(`Done. Created draft meeting minutes from ${payload.transcriptLength || 0} characters.`, 'success');
      displayPayload(payload);
    } catch (error) {
      setMessage(error.message || 'Meeting minutes extraction failed.', 'error');
    } finally {
      setLoading(false);
    }
  }

  async function improveMinutes() {
    if (!config.improveEndpoint || !state.payload || !state.payload.result || !state.payload.result.output) {
      return;
    }

    setImproving(true);
    setMessage('Improving extracted minutes with local LLM...', 'info');

    try {
      const editedSchema = collectEditedSchemaOutput();
      const editedOutput = editedSchema ? buildEditableOutputFromSchema(editedSchema) : state.payload.result.output;
      const response = await fetch(config.improveEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ output: editedOutput })
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok || !payload || payload.ok === false) {
        const detailText = payload && payload.details ? ` ${JSON.stringify(payload.details)}` : '';
        throw new Error((payload && payload.error ? payload.error : `Request failed with status ${response.status}.`) + detailText);
      }

      const mergedPayload = {
        ...state.payload,
        result: payload.result
      };
      if (payload.result && payload.result.rewriteSucceeded === false) {
        const failureCount = payload.result.rewriteFailureCount || 0;
        setMessage(`Local LLM improvement did not fully complete (${failureCount} rewrite item${failureCount === 1 ? '' : 's'} failed). Review diagnostics before using this output.`, 'error');
      } else {
        setMessage('Minutes improved with the local LLM layer.', 'success');
      }
      displayPayload(mergedPayload);
    } catch (error) {
      setMessage(error.message || 'Improving minutes failed.', 'error');
    } finally {
      setImproving(false);
      setLoading(state.loading);
    }
  }

  function resetPage() {
    fileInput.value = '';
    textInput.value = '';
    state.payload = null;
    state.schemaOutput = null;
    state.extractedText = '';
    setMessage('', '');
    outputPanel.classList.add('hidden');
    diagnosticsPanel.classList.add('hidden');
    outputNode.innerHTML = '';
    rawOutputNode.textContent = '';
    diagnosticsNode.textContent = '';
    summaryGrid.innerHTML = '';
    if (improveBtn) improveBtn.disabled = true;
    if (finaliseBtn) finaliseBtn.classList.add('hidden');
  }

  async function copyValue(value, label) {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setMessage(`${label} copied to clipboard.`, 'success');
  }

  goBtn.addEventListener('click', submitTranscript);
  if (improveBtn) improveBtn.addEventListener('click', improveMinutes);
  if (finaliseBtn) finaliseBtn.addEventListener('click', finaliseWithAgent);
  clearBtn.addEventListener('click', resetPage);
  copyOutputBtn.addEventListener('click', () => {
    const editedSchema = collectEditedSchemaOutput();
    copyValue(editedSchema ? JSON.stringify(editedSchema, null, 2) : '', 'MiniLM-only schema output');
  });
  copyRawBtn.addEventListener('click', () => copyValue(rawOutputNode.textContent, 'MiniLM-only raw output'));
  copyDiagnosticsBtn.addEventListener('click', () => copyValue(diagnosticsNode.textContent, 'MiniLM-only diagnostics'));
}
