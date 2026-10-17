'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { addReviewSnippet } = require('../utils/reviewSnippet');

const root = path.resolve(__dirname, '..');
let browser;
test.before(async () => { browser = await chromium.launch({ headless: true }); });
test.after(async () => { await browser?.close(); });

function draft(id, title, extra = {}) {
  return {
    draftId: String(id), title, status: 'draft', stageLabel: 'Discussion',
    createdAt: '2026-10-17T10:00:00Z',
    resumeUrl: `/meeting-minutes-agent?draftId=${id}`, ...extra
  };
}

function listing(drafts, total = drafts.length) {
  return { ok: true, drafts, pagination: { total, limit: 10, offset: 0 } };
}

async function json(route, payload, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
}

async function openLibrary(t, api, routePath = '/jobs', init) {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'the Library must not throw script errors'));
  // Automatic polling is covered through the same Refresh handler, under test
  // control, so deliberately delayed requests cannot create a five-second race.
  await page.addInitScript(() => { window.setInterval = () => 0; });
  if (init) await page.addInitScript(init);
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://library.test') return route.fulfill({ body: '' });
    if (url.pathname.startsWith('/api/')) return api(route, url);
    if (url.pathname.startsWith('/static/')) return route.fulfill({ body: '' });
    return route.fulfill({
      contentType: 'text/html',
      body: addReviewSnippet(fs.readFileSync(path.join(root, 'views/meeting-minutes-jobs.html'), 'utf8'))
    });
  });
  await page.goto(`http://library.test${routePath}`);
  return page;
}

test('Library renders agent drafts, escapes titles and keeps generation/resume/delete actions', async (t) => {
  const requests = [];
  const page = await openLibrary(t, async (route, url) => {
    requests.push(url.pathname);
    return json(route, listing([
      draft(1, '<img src=x onerror=alert(1)>'),
      draft(2, 'Finished meeting', { status: 'complete', stageLabel: 'Final review' }),
      draft(3, 'Background generation', { generation: { status: 'running', stage: 'actions' } })
    ]));
  }, '/jobs?type=meeting-minutes-agent', () => {
    localStorage.setItem('stagedMeetingMinutesJobs', JSON.stringify([{ jobId: 'old-local', meetingTitle: 'Hidden legacy draft' }]));
  });
  await page.locator('.jobs tbody tr').nth(2).waitFor();
  assert.equal(await page.locator('.jobs tbody tr').count(), 3);
  assert.equal(await page.locator('.jobs img').count(), 0);
  assert.equal(await page.locator('.jobs strong').first().textContent(), '<img src=x onerror=alert(1)>');
  assert.equal(await page.getByRole('link', { name: 'Open final minutes' }).getAttribute('href'), '/meeting-minutes-agent?draftId=2');
  assert.equal(await page.getByRole('link', { name: 'View progress' }).getAttribute('href'), '/meeting-minutes-agent?draftId=3');
  assert.equal(await page.getByRole('button', { name: 'Delete draft', exact: true }).count(), 3);
  assert.equal(await page.getByRole('checkbox').count(), 0);
  assert.equal(await page.getByText('Archive all', { exact: true }).count(), 0);
  assert.deepEqual(requests, ['/api/meeting-minutes-agent/drafts']);
  assert.equal(await page.locator('.queue-tab[aria-current="page"]').textContent(), 'Meeting Minutes Agent');
});

test('an older filter response cannot overwrite newer results or pagination', async (t) => {
  let older;
  const page = await openLibrary(t, async (route, url) => {
    if (url.searchParams.get('search') === 'older') { older = route; return; }
    return json(route, listing([draft(1, url.searchParams.get('search') || 'Initial')]));
  });
  await page.locator('.jobs').waitFor();
  const oldRequest = page.waitForRequest((req) => new URL(req.url()).searchParams.get('search') === 'older');
  await page.fill('#librarySearch', 'older');
  await oldRequest;
  await page.fill('#librarySearch', 'newer');
  await page.getByText('newer', { exact: true }).waitFor();
  const completed = page.waitForResponse((res) => new URL(res.url()).searchParams.get('search') === 'older');
  await json(older, listing([draft(2, 'Outdated results')], 38));
  await (await completed).finished();
  await page.waitForTimeout(50);
  assert.equal(await page.locator('.jobs strong').textContent(), 'newer');
  assert.equal(await page.locator('#libraryResultCount').textContent(), 'Showing 1–1 of 1 draft');
  assert.equal(await page.locator('#libraryNext').isDisabled(), true);
});

test('an older filter failure cannot replace a successful newer result with an error', async (t) => {
  let older;
  const page = await openLibrary(t, async (route, url) => {
    if (url.searchParams.get('search') === 'older') { older = route; return; }
    return json(route, listing([draft(1, url.searchParams.get('search') || 'Initial')]));
  });
  await page.locator('.jobs').waitFor();
  const request = page.waitForRequest((req) => new URL(req.url()).searchParams.get('search') === 'older');
  await page.fill('#librarySearch', 'older');
  await request;
  await page.fill('#librarySearch', 'newer');
  await page.getByText('newer', { exact: true }).waitFor();
  const completed = page.waitForResponse((res) => new URL(res.url()).searchParams.get('search') === 'older');
  await json(older, { ok: false, error: 'Outdated request failed' }, 503);
  await (await completed).finished();
  await page.waitForTimeout(50);
  assert.equal(await page.locator('#message').isVisible(), false);
});

for (const oldStatus of [200, 503]) {
  test(`an older refresh (${oldStatus}) cannot clear a newer filter error`, async (t) => {
    let older;
    let requests = 0;
    const page = await openLibrary(t, async (route, url) => {
      if (url.searchParams.get('search') === 'newer') return json(route, { ok: false, error: 'Current search unavailable' }, 503);
      if (++requests === 2) { older = route; return; }
      return json(route, listing([draft(1, 'Initial')]));
    });
    await page.locator('.jobs').waitFor();
    const oldRequest = page.waitForRequest((req) => req.url().includes('/drafts?'));
    await page.click('#refreshBtn');
    await oldRequest;
    await page.fill('#librarySearch', 'newer');
    await page.getByText('Current search unavailable', { exact: true }).waitFor();
    const completed = page.waitForResponse((res) => res.url().includes('/drafts?') && !res.url().includes('search='));
    await json(older, oldStatus === 200 ? listing([draft(1, 'Old response')]) : { ok: false, error: 'Old failure' }, oldStatus);
    await (await completed).finished();
    await page.waitForTimeout(50);
    assert.equal(await page.getByText('Current search unavailable', { exact: true }).isVisible(), true);
  });
}

test('filters and pagination keep API parameters and deleting the last page clamps the page', async (t) => {
  let total = 11;
  const requests = [];
  const page = await openLibrary(t, async (route, url) => {
    requests.push({ method: route.request().method(), path: url.pathname, params: Object.fromEntries(url.searchParams) });
    if (route.request().method() === 'DELETE') { total = 10; return json(route, { ok: true }); }
    const offset = Number(url.searchParams.get('offset'));
    return json(route, listing(offset >= total ? [] : [draft(offset + 1, `Meeting ${offset + 1}`)], total));
  });
  await page.getByText('Meeting 1', { exact: true }).waitFor();
  await page.selectOption('#libraryStatus', 'complete');
  await page.selectOption('#librarySort', 'title_desc');
  await page.fill('#librarySearch', 'quality & delivery');
  await page.waitForRequest((req) => new URL(req.url()).searchParams.get('search') === 'quality & delivery');
  await page.click('#libraryNext');
  await page.getByText('Meeting 11', { exact: true }).waitFor();
  assert.equal(await page.locator('#libraryPageLabel').textContent(), 'Page 2 of 2');
  const pageRequest = requests.find((req) => req.params.offset === '10');
  assert.deepEqual(pageRequest.params, { limit: '10', offset: '10', sort: 'title_desc', status: 'complete', search: 'quality & delivery' });
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Delete draft', exact: true }).click();
  await page.getByText('Meeting 1', { exact: true }).waitFor();
  assert.equal(await page.locator('#libraryPageLabel').textContent(), 'Page 1 of 1');
  assert.equal(await page.locator('#libraryPrevious').isDisabled(), true);
  assert.ok(requests.some((req) => req.method === 'DELETE' && req.path === '/api/meeting-minutes-agent/drafts/11'));
});

test('a failed draft listing does not prevent loading an existing job detail link', async (t) => {
  const page = await openLibrary(t, (route, url) => {
    if (url.pathname === '/api/jobs/42') return json(route, {
      ok: true, job: { jobId: 42, jobType: 'staged_meeting_minutes_stage', status: 'running', resumeUrl: '/staged-meeting-minutes?stageJobId=42' }
    });
    return json(route, { ok: false, error: 'Draft listing unavailable' }, 503);
  }, '/jobs/42');
  await page.getByText('Draft listing unavailable').waitFor();
  assert.equal(await page.locator('#detailPanel').isVisible(), true);
  assert.equal(await page.getByRole('link', { name: 'Resume staged review', exact: true }).getAttribute('href'), '/staged-meeting-minutes?stageJobId=42');
});

test('result-only links show API errors instead of a blank page', async (t) => {
  const page = await openLibrary(t, (route) => json(route, { ok: false, error: 'Job no longer available' }, 404), '/jobs/42/result');
  await page.waitForFunction(() => document.getElementById('message').textContent === 'Job no longer available');
  assert.equal(await page.getByText('Job no longer available', { exact: true }).isVisible(), true);
});

test('legacy result aliases and browser-saved staged detail links remain usable', async (t) => {
  const page = await openLibrary(t, (route, url) => {
    assert.equal(url.pathname, '/api/jobs/42');
    return json(route, { ok: true, job: { jobId: 42, status: 'completed', jobType: 'meeting_minutes_generate' }, result: { output: {
      meetingTitle: 'Preserved meeting', meetingDate: '2026-10-17',
      actions: [{ action: 'Send the approved minutes.', owner: 'Alex', deadline: '2026-10-20' }]
    } } });
  }, '/meeting-minutes-final/jobs/42/result');
  await page.getByRole('button', { name: 'Save edits', exact: true }).waitFor();
  assert.equal(await page.locator('#listPanel').isVisible(), false);
  assert.ok((await page.locator('#resultView').innerHTML()).includes('Send the approved minutes.'));
  const local = await openLibrary(t, (route) => json(route, listing([])), '/jobs/old-draft', () => {
    localStorage.setItem('stagedMeetingMinutesJobs', JSON.stringify([{
      jobId: 'old-draft', meetingTitle: 'Saved staged meeting', activeScreen: 3,
      createdAt: '2026-10-16T10:00:00Z'
    }]));
  });
  await local.locator('#detailPanel:not([hidden])').waitFor();
  assert.equal(await local.locator('.staged-step.current strong').textContent(), '3. Actions');
  assert.equal(await local.getByRole('link', { name: 'Resume staged review', exact: true }).getAttribute('href'), '/staged-meeting-minutes?draftId=old-draft&stage=actions&screen=2');
});
