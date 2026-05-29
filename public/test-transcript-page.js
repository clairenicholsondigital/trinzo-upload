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

      const response = await fetch(config.endpoint, options);
      const payload = await response.json().catch(() => null);

      if (!response.ok || !payload || payload.ok === false) {
        const detailText = payload && payload.details ? ` ${JSON.stringify(payload.details)}` : '';
        throw new Error((payload && payload.error ? payload.error : `Request failed with status ${response.status}.`) + detailText);
      }

      setMessage(`Done. Analysed ${payload.transcriptLength || 0} characters from ${payload.source || 'transcript'}.`, 'success');
      displaySummary(payload.result);
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
  const actionCount = Array.isArray(result.nextSteps) ? result.nextSteps.length : 0;
  return [
    { label: 'Title', value: result.meetingTitle || '—' },
    { label: 'Date', value: result.meetingDate || '—' },
    { label: 'Client participants', value: listValue(participants.client) },
    { label: 'Trinzo participants', value: listValue(participants.trinzo) },
    { label: 'Unknown participants', value: listValue(participants.unknown) },
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
