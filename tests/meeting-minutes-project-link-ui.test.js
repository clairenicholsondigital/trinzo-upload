'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const ORIGIN = 'http://project-minutes.fixture';
const LINK_SOURCE = fs.readFileSync(path.join(ROOT, 'public/meeting-minutes-project-link.js'), 'utf8');
const PROCESS_SOURCE = fs.readFileSync(path.join(ROOT, 'public/project-stage-process.js'), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
let browser;

test.before(async () => { browser = await chromium.launch({ headless: true }); });
test.after(async () => { if (browser) await browser.close(); });

async function isolatedPage(t, url = '/meeting-minutes-agent?draftId=202&projectId=17&projectName=Current%20project') {
  const context = await browser.newContext();
  t.after(() => context.close());
  await context.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><main><section class="hero">Minutes</section></main>' }));
  const page = await context.newPage();
  await page.goto(ORIGIN + url);
  return page;
}

test('project context belongs to the explicit URL and unlink survives refresh', async t => {
  const page = await isolatedPage(t, '/meeting-minutes-agent?draftId=202');
  await page.evaluate(() => sessionStorage.setItem('trinzo.minutesProjectLink', JSON.stringify({ projectId: '99', projectName: 'Unrelated project' })));
  await page.addScriptTag({ content: LINK_SOURCE });
  assert.equal(await page.locator('#projectLinkBanner').count(), 0);
  await page.goto(ORIGIN + '/meeting-minutes-agent?draftId=202&projectId=17&projectName=Current%20project#review');
  await page.addScriptTag({ content: LINK_SOURCE });
  assert.match(await page.locator('#projectLinkBanner').innerText(), /Current project/);
  await page.click('#unlinkProject');
  const unlinked = new URL(page.url());
  assert.equal(unlinked.searchParams.get('projectId'), null);
  assert.equal(unlinked.searchParams.get('projectName'), null);
  assert.equal(unlinked.searchParams.get('draftId'), '202');
  assert.equal(unlinked.hash, '#review');
  await page.reload();
  await page.addScriptTag({ content: LINK_SOURCE });
  assert.equal(await page.locator('#projectLinkBanner').count(), 0);
});

test('a pending save and queue stay locked across the refresh timer and only queue the saved revision', async t => {
  const page = await isolatedPage(t);
  await page.evaluate(() => {
    window.calls = [];
    window.MeetingMinutesAgent = { saveForProjectUpdate: () => new Promise(resolve => { window.finishSave = () => resolve({ id: '202', revision: 9 }); }) };
    window.fetch = (url, options) => {
      if (String(url).includes('/project-link')) return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      window.calls.push({ url, body: JSON.parse(options.body) });
      return new Promise(resolve => { window.finishQueue = () => resolve({ ok: true, json: async () => ({ ok: true, jobId: 'stub-job', jobUrl: '/jobs/stub-job' }) }); });
    };
  });
  await page.addScriptTag({ content: LINK_SOURCE });
  await page.click('#createProjectUpdateFromMinutes');
  await page.waitForTimeout(2100);
  assert.equal(await page.locator('#createProjectUpdateFromMinutes').isDisabled(), true);
  assert.equal(await page.locator('#unlinkProject').isDisabled(), true);
  assert.equal(await page.evaluate(() => window.calls.length), 0, 'the queue waits for the save');
  await page.evaluate(() => { document.getElementById('createProjectUpdateFromMinutes').click(); window.finishSave(); });
  await page.waitForFunction(() => window.calls.length === 1);
  await page.waitForTimeout(2100);
  assert.equal(await page.locator('#createProjectUpdateFromMinutes').isDisabled(), true);
  await page.evaluate(() => document.getElementById('createProjectUpdateFromMinutes').dispatchEvent(new Event('click')));
  assert.deepEqual(await page.evaluate(() => window.calls[0].body), { draftId: '202', revision: 9, projectId: '17', projectName: 'Current project' });
  assert.equal(await page.evaluate(() => window.calls.length), 1);
  await page.evaluate(() => window.finishQueue());
  await page.waitForFunction(() => !document.getElementById('createProjectUpdateFromMinutes').disabled);
  assert.equal(await page.locator('#projectLinkBanner a').first().getAttribute('href'), '/jobs/stub-job');
});

test('save errors, changed drafts and queue errors do not send stale minutes or inject error markup', async t => {
  const page = await isolatedPage(t);
  await page.evaluate(() => {
    window.calls = 0;
    window.MeetingMinutesAgent = { saveForProjectUpdate: async () => { throw new Error('Save conflict: reload first.'); } };
    window.fetch = async (url) => {
      if (String(url).includes('/project-link')) return { ok: true, json: async () => ({ ok: true }) };
      window.calls += 1; return { ok: false, status: 409, json: async () => ({ error: '<img src=x onerror=alert(1)>' }) }; };
  });
  await page.addScriptTag({ content: LINK_SOURCE });
  await page.click('#createProjectUpdateFromMinutes');
  await page.waitForFunction(() => !document.getElementById('createProjectUpdateFromMinutes').disabled);
  assert.match(await page.locator('#projectLinkBanner').innerText(), /Save conflict/);
  assert.equal(await page.evaluate(() => window.calls), 0);
  await page.evaluate(() => { window.MeetingMinutesAgent.saveForProjectUpdate = async () => ({ id: '203', revision: 9 }); });
  await page.click('#createProjectUpdateFromMinutes');
  await page.waitForFunction(() => !document.getElementById('createProjectUpdateFromMinutes').disabled);
  assert.equal(await page.evaluate(() => window.calls), 0, 'another draft is not substituted');
  await page.evaluate(() => { window.MeetingMinutesAgent.saveForProjectUpdate = async () => ({ id: '202', revision: 9 }); });
  await page.click('#createProjectUpdateFromMinutes');
  await page.waitForFunction(() => !document.getElementById('createProjectUpdateFromMinutes').disabled);
  assert.equal(await page.evaluate(() => window.calls), 1);
  assert.match(await page.locator('#projectLinkBanner').innerText(), /<img/);
  assert.equal(await page.locator('#projectLinkBanner img').count(), 0);
});

test('project Process links carry the selected project and submission carries its listed revision', async t => {
  const page = await isolatedPage(t, '/project-update-test?stage=process&projectId=23');
  await page.evaluate(() => {
    document.body.innerHTML = '<main id="process"></main>';
    window.calls = [];
    sessionStorage.setItem('trinzo.minutesProjectLink', JSON.stringify({ projectId: '99', projectName: 'Wrong old project' }));
    const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    window.ProjectWorkspace = {
      escapeHtml, asArray: value => Array.isArray(value) ? value : [], displayDate: value => value, friendlyLabel: value => value,
      request: async (url, options) => {
        if (url.startsWith('/api/meeting-minutes-agent/drafts')) return { drafts: [{ draftId: '202', revision: 8, title: 'Reviewed minutes', resumeUrl: '/meeting-minutes-agent?draftId=202&projectId=99' }] };
        if (url === 'from-minutes') { window.calls.push(JSON.parse(options.body)); return new Promise(resolve => { window.finishQueue = () => resolve({ ok: true, jobId: 'stub-job' }); }); }
        return { context: {} };
      }
    };
  });
  await page.addScriptTag({ content: PROCESS_SOURCE });
  await page.evaluate(() => window.ProjectStages.process.mount(document.getElementById('process'), { projectId: 23, project: { projectName: 'Current & correct' } }));
  await page.waitForSelector('[data-minutes-draft="202"] a');
  const href = new URL(await page.locator('[data-minutes-draft="202"] a').getAttribute('href'), ORIGIN);
  assert.equal(href.searchParams.get('draftId'), '202');
  assert.equal(href.searchParams.get('projectId'), '23');
  assert.equal(href.searchParams.get('projectName'), 'Current & correct');
  await page.click('[data-create-from-minutes="202"]');
  await page.evaluate(() => document.querySelector('[data-create-from-minutes="202"]').dispatchEvent(new Event('click')));
  assert.deepEqual(await page.evaluate(() => window.calls), [{ draftId: '202', revision: 8, projectId: 23, projectName: 'Current & correct' }]);
  await page.evaluate(() => window.finishQueue());
  await page.waitForFunction(() => !document.querySelector('[data-create-from-minutes="202"]').disabled);
  await page.click('[data-minutes-draft="202"] a');
  await page.addScriptTag({ content: LINK_SOURCE });
  assert.match(await page.locator('#projectLinkBanner').innerText(), /Current & correct/);
  assert.doesNotMatch(await page.locator('#projectLinkBanner').innerText(), /Wrong old project/);
});

function draftFixture() {
  return {
    draftId: '202', revision: 1, currentStep: 3, selectedStep: 0, updatedAt: '2026-10-21T12:00:00Z', title: 'Saved title',
    details: { meetingTitle: 'Saved title', meetingDate: '2026-10-01', meetingLocation: 'Teams', meetingType: 'Review', clientAttendeeLabel: 'Client', internalAttendees: ['Alex Reed'], clientAttendees: [], allAttendees: ['Alex Reed'] },
    sourceUnits: [{ id: 'T0001', speaker: 'Alex Reed', text: 'I will send the inspection report, presumably early next week.' }],
    discussion: [{ id: 'topic-1', topic: 'Inspection', points: [{ id: 'point-1', text: 'The inspection report was approved.', evidenceIds: ['T0001'], reviewFlagIds: [] }], decisions: [], openQuestions: [] }],
    actions: [{ id: 'action-1', action: 'Send the inspection report.', owners: ['Alex Reed'], timing: { kind: 'target', wording: 'presumably early next week', exactDate: '' }, evidenceIds: ['T0001'], reviewFlagIds: [] }],
    reviewFlags: [], meetingObjectives: [], executiveSummary: '', includeSections: { meetingObjectives: false, executiveSummary: false, topicHeadings: true },
    generation: null, pendingProposal: null, staleStages: [], qualityNotice: '', denoise: {}, steer: '', actionsPrewarm: null, speculation: null
  };
}

async function fullAgentPage(t, { conflict = false, holdFirstSave = false, upload = false } = {}) {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage(), requests = [], errors = [];
  let draft = draftFixture(), releaseSave;
  const firstSave = new Promise(resolve => { releaseSave = resolve; });
  const html = fs.readFileSync(path.join(ROOT, 'views/meeting-minutes-agent.html'), 'utf8');
  page.on('pageerror', error => errors.push(String(error)));
  await context.route('**/*', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    const json = body => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (pathname === '/meeting-minutes-agent') return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    const files = { '/static/meeting-minutes-agent.js': 'public/meeting-minutes-agent.js', '/static/meeting-minutes-project-link.js': 'public/meeting-minutes-project-link.js', '/static/meeting-minutes-timing.js': 'utils/meetingMinutesTiming.js' };
    if (files[pathname]) return route.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(path.join(ROOT, files[pathname]), 'utf8') });
    if (pathname === '/api/meeting-minutes-agent/check-duplicate') return json({ ok: true, duplicates: [] });
    if (pathname === '/api/meeting-minutes-agent/prepare') return json({ ok: true, draft, resumeUrl: '/meeting-minutes-agent?draftId=202' });
    if (pathname === '/api/meeting-minutes-agent/drafts/202') {
      if (request.method() === 'PATCH') {
        const patch = request.postDataJSON();
        requests.push({ type: 'save', patch: copy(patch) });
        if (holdFirstSave && requests.filter(item => item.type === 'save').length === 1) await firstSave;
        if (conflict) return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'Draft changed elsewhere. Reload before creating an update.', currentDraft: { ...draft, revision: 2 } }) });
        draft = { ...draft, ...patch, revision: draft.revision + 1 };
      }
      return json({ ok: true, draft });
    }
    if (pathname === '/api/project-update-test/from-minutes') {
      requests.push({ type: 'queue', body: request.postDataJSON(), savedTitle: draft.details.meetingTitle, savedRevision: draft.revision });
      return json({ ok: true, jobId: 'stub-job', jobUrl: '/jobs/stub-job' });
    }
    return route.fulfill({ status: 200, contentType: pathname.endsWith('.js') ? 'application/javascript' : pathname.endsWith('.css') ? 'text/css' : 'application/json', body: /\.(?:js|css)$/.test(pathname) ? '' : '{}' });
  });
  await page.goto(ORIGIN + '/meeting-minutes-agent?' + (upload ? '' : 'draftId=202&') + 'projectId=17&projectName=Current%20project');
  if (!upload) await page.waitForSelector('#saveStrip:not([hidden])');
  return { page, requests, errors, releaseSave, getDraft: () => copy(draft) };
}

test('the actual agent bridge saves a rapid edit before queuing and preserves timing presentation', async t => {
  const { page, requests, errors } = await fullAgentPage(t);
  await page.fill('#meetingTitle', 'Latest reviewed title');
  await page.click('#createProjectUpdateFromMinutes');
  await page.waitForFunction(() => document.querySelector('#projectLinkBanner').textContent.includes('Project update queued'));
  const queued = requests.find(item => item.type === 'queue');
  assert.equal(requests[0].type, 'save');
  assert.equal(queued.savedTitle, 'Latest reviewed title');
  assert.equal(queued.body.revision, queued.savedRevision);
  assert.equal(queued.body.draftId, '202');
  await page.click('[data-step="3"]');
  assert.equal(await page.locator('#actionsBody [data-edit-timing]').innerText(), 'Target: presumably early next week');
  assert.deepEqual(errors, []);
});

test('the actual bridge saves a newer edit made during an in-flight save before queuing', async t => {
  const { page, requests, errors, releaseSave } = await fullAgentPage(t, { holdFirstSave: true });
  await page.fill('#meetingTitle', 'First reviewed title');
  await page.click('#createProjectUpdateFromMinutes');
  await page.waitForFunction(() => document.getElementById('saveStatus').dataset.state === 'saving');
  await page.fill('#meetingTitle', 'Newer reviewed title');
  releaseSave();
  await page.waitForFunction(() => document.querySelector('#projectLinkBanner').textContent.includes('Project update queued'));
  const queued = requests.find(item => item.type === 'queue');
  assert.ok(requests.filter(item => item.type === 'save').length >= 2);
  assert.equal(queued.savedTitle, 'Newer reviewed title');
  assert.equal(queued.body.revision, queued.savedRevision);
  assert.equal(requests.at(-1).type, 'queue');
  assert.deepEqual(errors, []);
});

test('the bridge also waits for an autosave already in flight before saving newer edits', async t => {
  const { page, requests, errors, releaseSave } = await fullAgentPage(t, { holdFirstSave: true });
  await page.fill('#meetingTitle', 'Autosave already started');
  await page.waitForFunction(() => document.getElementById('saveStatus').dataset.state === 'saving');
  assert.equal(requests.filter(item => item.type === 'save').length, 1);
  await page.fill('#meetingTitle', 'Newer edit during autosave');
  await page.click('#createProjectUpdateFromMinutes');
  assert.equal(requests.some(item => item.type === 'queue'), false);
  releaseSave();
  await page.waitForFunction(() => document.querySelector('#projectLinkBanner').textContent.includes('Project update queued'));
  const queued = requests.find(item => item.type === 'queue');
  assert.ok(requests.filter(item => item.type === 'save').length >= 2);
  assert.equal(queued.savedTitle, 'Newer edit during autosave');
  assert.equal(queued.body.revision, queued.savedRevision);
  assert.deepEqual(errors, []);
});

test('a real agent save conflict prevents the project update request', async t => {
  const { page, requests } = await fullAgentPage(t, { conflict: true });
  await page.fill('#meetingTitle', 'Unsaved title');
  await page.click('#createProjectUpdateFromMinutes');
  await page.waitForFunction(() => !document.getElementById('createProjectUpdateFromMinutes').disabled);
  assert.equal(requests.some(item => item.type === 'queue'), false);
  assert.match(await page.locator('#projectLinkBanner').innerText(), /Draft changed elsewhere/);
  assert.equal(await page.locator('#meetingTitle').inputValue(), 'Unsaved title');
});

test('upload keeps explicit project context in the resume URL and after refresh', async t => {
  const { page, errors } = await fullAgentPage(t, { upload: true });
  await page.setInputFiles('#transcriptFile', { name: 'inspection-review.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('PK') });
  await page.waitForURL(url => url.searchParams.get('draftId') === '202');
  assert.equal(new URL(page.url()).searchParams.get('projectId'), '17');
  assert.equal(new URL(page.url()).searchParams.get('projectName'), 'Current project');
  await page.reload();
  await page.waitForSelector('#projectLinkBanner');
  assert.match(await page.locator('#projectLinkBanner').innerText(), /Current project/);
  assert.deepEqual(errors, []);
});

test('opening linked minutes tags that draft with the project once, and retries after a failure', async t => {
  const page = await isolatedPage(t);
  await page.evaluate(() => {
    window.linkCalls = [];
    window.failNextLink = true;
    window.fetch = async (url, options) => {
      if (String(url).includes('/project-link')) {
        window.linkCalls.push({ url, body: JSON.parse(options.body) });
        if (window.failNextLink) { window.failNextLink = false; return { ok: false, status: 500, json: async () => ({}) }; }
        return { ok: true, json: async () => ({ ok: true }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    };
  });
  await page.addScriptTag({ content: LINK_SOURCE });
  await page.waitForFunction(() => window.linkCalls.length === 2, null, { timeout: 5000 });
  await page.waitForTimeout(2200);
  const calls = await page.evaluate(() => window.linkCalls);
  assert.equal(calls.length, 2, 'one failed attempt, one successful retry, then no more');
  assert.equal(calls[1].url, '/api/meeting-minutes-agent/drafts/202/project-link');
  assert.deepEqual(calls[1].body, { projectId: '17' });
});

test('Process lists this project\'s minutes by default, can show all, and links an existing duplicate update', async t => {
  const page = await isolatedPage(t, '/project-update-test?stage=process&projectId=23');
  await page.evaluate(() => {
    document.body.innerHTML = '<main id="process"></main>';
    window.draftRequests = [];
    const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    window.ProjectWorkspace = {
      escapeHtml, asArray: value => Array.isArray(value) ? value : [], displayDate: value => value, friendlyLabel: value => value,
      request: async (url) => {
        if (url.startsWith('/api/meeting-minutes-agent/drafts')) {
          window.draftRequests.push(url);
          return url.includes('projectId=23')
            ? { drafts: [] }
            : { drafts: [{ draftId: '301', revision: 2, title: 'Other meeting' }] };
        }
        if (url === 'from-minutes') {
          const error = new Error('A project update from these exact minutes already exists.');
          error.payload = { duplicate: true, kind: 'report', existingUrl: '/project-update-test/reports/88' };
          throw error;
        }
        return { context: {} };
      }
    };
  });
  await page.addScriptTag({ content: PROCESS_SOURCE });
  await page.evaluate(() => window.ProjectStages.process.mount(document.getElementById('process'), { projectId: 23, project: { projectName: 'Current' } }));
  await page.waitForFunction(() => /No minutes for this project yet/.test(document.getElementById('minutesDraftList').textContent));
  assert.equal(await page.evaluate(() => window.draftRequests[0]), '/api/meeting-minutes-agent/drafts?limit=10&projectId=23');
  await page.click('#toggleAllMinutes');
  await page.waitForSelector('[data-create-from-minutes="301"]');
  assert.equal(await page.evaluate(() => window.draftRequests.at(-1)), '/api/meeting-minutes-agent/drafts?limit=10');
  await page.click('[data-create-from-minutes="301"]');
  await page.waitForSelector('#fromMinutesStatus a');
  assert.equal(await page.locator('#fromMinutesStatus a').getAttribute('href'), '/project-update-test/reports/88');
  assert.match(await page.locator('#fromMinutesStatus').innerText(), /already exists/);
});
