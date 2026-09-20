import {
  BrowserCacheLocation,
  InteractionRequiredAuthError,
  PublicClientApplication
} from '@azure/msal-browser';

const elements = {
  loading: document.querySelector('#loadingState'),
  signedOut: document.querySelector('#signedOutState'),
  signedIn: document.querySelector('#signedInState'),
  signIn: document.querySelector('#signInButton'),
  signOut: document.querySelector('#signOutButton'),
  accountName: document.querySelector('#accountName'),
  accountEmail: document.querySelector('#accountEmail'),
  dropZone: document.querySelector('#dropZone'),
  fileInput: document.querySelector('#documentFile'),
  chooseFile: document.querySelector('#chooseFileButton'),
  selectedFile: document.querySelector('#selectedFile'),
  selectedFileName: document.querySelector('#selectedFileName'),
  selectedFileSize: document.querySelector('#selectedFileSize'),
  clearFile: document.querySelector('#clearFileButton'),
  upload: document.querySelector('#uploadButton'),
  status: document.querySelector('#pageStatus'),
  transcriptStatus: document.querySelector('#transcriptStatus'),
  transcriptEvents: document.querySelector('#transcriptEvents')
};

let msalClient;
let authConfig;
let activeAccount;
let selectedFile;

function conversationStorageKey(account) {
  return `trinzo.meetingAgent.copilotConversation.${account.homeAccountId}`;
}

function showState(name) {
  elements.loading.hidden = name !== 'loading';
  elements.signedOut.hidden = name !== 'signedOut';
  elements.signedIn.hidden = name !== 'signedIn';
}

function setStatus(message = '', kind = '') {
  elements.status.textContent = message;
  elements.status.className = `status${kind ? ` ${kind}` : ''}`;
  elements.status.hidden = !message;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderSelectedFile(file) {
  selectedFile = file || null;
  elements.selectedFile.hidden = !selectedFile;
  elements.upload.disabled = !selectedFile;
  if (!selectedFile) {
    elements.fileInput.value = '';
    elements.selectedFileName.textContent = '';
    elements.selectedFileSize.textContent = '';
    return;
  }
  elements.selectedFileName.textContent = selectedFile.name;
  elements.selectedFileSize.textContent = formatBytes(selectedFile.size);
}

function validateFile(file) {
  if (!file || !file.name.toLowerCase().endsWith('.docx')) {
    throw new Error('Choose a Microsoft Word .docx file.');
  }
  if (file.size > 5 * 1024 * 1024) {
    throw new Error('The Word document is too large. Maximum size is 5 MB.');
  }
  if (!file.size) throw new Error('The selected Word document is empty.');
  return file;
}

async function apiJson(url, options = {}) {
  const response = await fetch(url, { cache: 'no-store', ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `Request failed with HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return body;
}

async function accessToken({ interactive = false } = {}) {
  if (!activeAccount) throw new Error('Sign in with Microsoft before uploading.');
  try {
    const response = await msalClient.acquireTokenSilent({
      account: activeAccount,
      scopes: authConfig.scopes
    });
    return response.accessToken;
  } catch (error) {
    if (!interactive || !(error instanceof InteractionRequiredAuthError)) throw error;
    await msalClient.acquireTokenRedirect({
      account: activeAccount,
      scopes: authConfig.scopes,
      redirectUri: authConfig.redirectUri,
      redirectStartPage: window.location.href
    });
    return '';
  }
}

async function establishSession(account) {
  activeAccount = account;
  msalClient.setActiveAccount(account);
  const token = await accessToken();
  const session = await apiJson('/api/meeting-agent/session', {
    headers: { Authorization: `Bearer ${token}` }
  });
  elements.accountName.textContent = session.user.displayName || account.name || 'Microsoft user';
  elements.accountEmail.textContent = session.user.email || account.username || '';
  showState('signedIn');
  enableTranscriptMonitoring(token).catch((error) => {
    elements.transcriptStatus.textContent = error.message || 'Automatic transcript monitoring could not be started.';
    elements.transcriptStatus.className = 'monitoring-status warning';
  });
  ensureCopilotConversation(account, token).catch((error) => {
    setStatus(error.message || 'Microsoft 365 Copilot could not start a conversation.', 'warning');
  });
}

async function enableTranscriptMonitoring(token) {
  elements.transcriptStatus.textContent = 'Starting automatic Teams transcript monitoring…';
  elements.transcriptStatus.className = 'monitoring-status working';
  const result = await apiJson('/api/meeting-agent/transcript-subscription', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }
  });
  const expires = new Date(result.subscription.expirationDateTime);
  elements.transcriptStatus.textContent = `Monitoring Teams transcripts for meetings you organise. Active until ${expires.toLocaleString()}; returning here renews it.`;
  elements.transcriptStatus.className = 'monitoring-status success';

  const eventResult = await apiJson('/api/meeting-agent/transcript-events', {
    headers: { Authorization: `Bearer ${token}` }
  });
  elements.transcriptEvents.replaceChildren();
  for (const event of eventResult.events) {
    const item = document.createElement('li');
    item.textContent = `Transcript received ${new Date(event.receivedAt).toLocaleString()}`;
    elements.transcriptEvents.append(item);
  }
  elements.transcriptEvents.hidden = eventResult.events.length === 0;
}

async function ensureCopilotConversation(account, token) {
  const storageKey = conversationStorageKey(account);
  if (localStorage.getItem(storageKey)) return;
  setStatus('Connecting your Microsoft 365 Copilot…', 'working');
  const result = await apiJson('/api/meeting-agent/conversation', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }
  });
  localStorage.setItem(storageKey, JSON.stringify({
    id: result.conversation.id,
    createdDateTime: result.conversation.createdDateTime
  }));
  setStatus('Microsoft 365 Copilot is ready.', 'success');
}

async function initialise() {
  showState('loading');
  setStatus();
  const config = await apiJson('/api/meeting-agent/config');
  authConfig = {
    ...config,
    redirectUri: new URL(config.redirectPath, window.location.origin).href
  };
  msalClient = new PublicClientApplication({
    auth: {
      clientId: authConfig.clientId,
      authority: `https://login.microsoftonline.com/${authConfig.tenantId}`,
      redirectUri: authConfig.redirectUri,
      postLogoutRedirectUri: new URL('/meeting-agent', window.location.origin).href,
      navigateToLoginRequestUrl: true
    },
    cache: {
      cacheLocation: BrowserCacheLocation.LocalStorage
    }
  });
  await msalClient.initialize();
  const redirectResult = await msalClient.handleRedirectPromise();
  const accounts = msalClient.getAllAccounts().filter((account) =>
    String(account.tenantId || '').toLowerCase() === authConfig.tenantId.toLowerCase());
  const account = redirectResult?.account || msalClient.getActiveAccount() || accounts[0];
  if (!account) {
    showState('signedOut');
    return;
  }
  try {
    await establishSession(account);
  } catch (error) {
    if (error instanceof InteractionRequiredAuthError || error.status === 401) {
      activeAccount = account;
      showState('signedOut');
      setStatus('Your Microsoft session needs to be renewed. Sign in again to continue.', 'warning');
      return;
    }
    throw error;
  }
}

elements.signIn.addEventListener('click', async () => {
  elements.signIn.disabled = true;
  setStatus();
  try {
    await msalClient.loginRedirect({
      scopes: authConfig.scopes,
      redirectUri: authConfig.redirectUri,
      redirectStartPage: window.location.href,
      prompt: activeAccount ? 'select_account' : undefined
    });
  } catch (error) {
    elements.signIn.disabled = false;
    setStatus(error.message || 'Microsoft sign-in could not be started.', 'error');
  }
});

elements.signOut.addEventListener('click', async () => {
  elements.signOut.disabled = true;
  setStatus();
  if (activeAccount) localStorage.removeItem(conversationStorageKey(activeAccount));
  await msalClient.logoutRedirect({
    account: activeAccount,
    postLogoutRedirectUri: new URL('/meeting-agent', window.location.origin).href
  });
});

elements.chooseFile.addEventListener('click', () => elements.fileInput.click());
elements.dropZone.addEventListener('click', (event) => {
  if (event.target === elements.dropZone) elements.fileInput.click();
});
elements.dropZone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    elements.fileInput.click();
  }
});
elements.fileInput.addEventListener('change', () => {
  setStatus();
  try {
    renderSelectedFile(validateFile(elements.fileInput.files[0]));
  } catch (error) {
    renderSelectedFile();
    setStatus(error.message, 'error');
  }
});
elements.clearFile.addEventListener('click', () => {
  renderSelectedFile();
  setStatus();
});

for (const eventName of ['dragenter', 'dragover']) {
  elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.add('dragover');
  });
}
for (const eventName of ['dragleave', 'drop']) {
  elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.remove('dragover');
  });
}
elements.dropZone.addEventListener('drop', (event) => {
  setStatus();
  try {
    renderSelectedFile(validateFile(event.dataTransfer.files[0]));
  } catch (error) {
    renderSelectedFile();
    setStatus(error.message, 'error');
  }
});

elements.upload.addEventListener('click', async () => {
  if (!selectedFile) return;
  elements.upload.disabled = true;
  elements.clearFile.disabled = true;
  setStatus('Uploading and checking your Word document…', 'working');
  try {
    const token = await accessToken({ interactive: true });
    if (!token) return;
    const form = new FormData();
    form.append('file', selectedFile);
    const result = await apiJson('/api/meeting-agent/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form
    });
    setStatus(`${result.file.name} was received successfully. ${result.file.extractedCharacters.toLocaleString()} characters were readable.`, 'success');
    renderSelectedFile();
  } catch (error) {
    if (error.status === 401) {
      setStatus('Your Microsoft session needs to be renewed. Sign in again and reselect the file.', 'warning');
      showState('signedOut');
    } else {
      setStatus(error.message || 'The document could not be uploaded.', 'error');
    }
  } finally {
    elements.upload.disabled = !selectedFile;
    elements.clearFile.disabled = false;
  }
});

initialise().catch((error) => {
  showState('signedOut');
  setStatus(error.message || 'The meeting agent could not start.', 'error');
});
