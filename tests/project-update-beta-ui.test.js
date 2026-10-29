'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const ORIGIN = 'http://project-beta.fixture';
let browser;
test.before(async () => { browser = await chromium.launch({ headless: true }); });
test.after(async () => { if (browser) await browser.close(); });

async function workspace(t, { suffix = '', user = { userId: 41, role: 'admin' }, authFailure = false, drafts = [], delayedAuth = false } = {}) {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [], requests = [];
  const auth = { user, failure: authFailure };
  let finishAuth;
  const authGate = delayedAuth ? new Promise(resolve => { finishAuth = resolve; }) : Promise.resolve();
  page.on('pageerror', error => errors.push(String(error)));
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/project-update-test') return route.fulfill({ status: 200, contentType: 'text/html', body: fs.readFileSync(path.join(ROOT, 'views/project-update-workspace.html'), 'utf8') });
    if (url.pathname.startsWith('/static/project-') && url.pathname.endsWith('.js')) return route.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(path.join(ROOT, 'public', path.basename(url.pathname)), 'utf8') });
    if (['/static/trinzo.css', '/static/trinzo-fonts.css'].includes(url.pathname)) return route.fulfill({ status: 200, contentType: 'text/css', body: fs.readFileSync(path.join(ROOT, 'public', path.basename(url.pathname)), 'utf8') });
    if (url.pathname.startsWith('/api/')) requests.push({ pathname: url.pathname, method: request.method() });
    if (url.pathname === '/api/auth/me') {
      await authGate;
      return auth.failure ? json({ error: 'Not signed in' }, 401) : json({ success: true, user: auth.user });
    }
    if (url.pathname === '/api/project-update-test/projects') return json({ ok: true, projects: [{ projectId: 23, projectName: 'Current & special project', status: 'active' }, { projectId: 24, projectName: 'Second project', status: 'active' }] });
    if (url.pathname === '/api/meeting-minutes-agent/drafts') return json({ ok: true, drafts });
    if (url.pathname.startsWith('/api/')) return json({ ok: true, context: {}, projects: [], reports: [], milestones: [], risks: [] });
    return route.fulfill({ status: 200, contentType: url.pathname.endsWith('.js') ? 'application/javascript' : 'text/plain', body: '' });
  });
  const authResponse = page.waitForResponse(response => response.url().endsWith('/api/auth/me'));
  await page.goto(`${ORIGIN}/project-update-test?stage=process&projectId=23${suffix}`);
  if (!delayedAuth) await authResponse;
  await page.waitForSelector('#openMinutesAgent');
  if (!delayedAuth) await page.waitForSelector('#openMinutesAgent[href]');
  return { page, errors, requests, auth, finishAuth };
}

async function minutesLink(page, selector = '#openMinutesAgent') {
  return new URL(await page.locator(selector).getAttribute('href'), ORIGIN);
}

test('admin can enable Beta with the keyboard, retaining the project and leaving saved data untouched', async t => {
  const { page, errors, requests } = await workspace(t);
  const toggle = page.getByRole('switch', { name: 'Beta meeting minutes' });
  await toggle.waitFor({ state: 'attached' });
  await page.waitForSelector('#projectBetaControl:not([hidden])');
  assert.equal(await toggle.isChecked(), false);
  assert.equal((await minutesLink(page)).searchParams.get('engine'), 'original');
  await toggle.focus();
  await toggle.press('Space');
  const link = await minutesLink(page);
  assert.equal(link.searchParams.get('engine'), 'parallel');
  assert.equal(link.searchParams.get('projectId'), '23');
  assert.equal(link.searchParams.get('projectName'), 'Current & special project');
  assert.equal(new URL(page.url()).searchParams.get('engine'), 'parallel');
  for (const selector of ['#switchProjectLink', '#openProjectReportsBtn']) {
    assert.equal(new URL(await page.locator(selector).getAttribute('href'), ORIGIN).searchParams.get('engine'), 'parallel', 'opening navigation in a new tab retains the choice');
  }
  assert.match(await page.locator('#projectBetaStatus').innerText(), /next upload/);
  assert.equal(await toggle.getAttribute('aria-describedby'), 'projectBetaStatus');
  assert.ok(requests.every(request => request.method === 'GET'), 'selection cannot create, regenerate or edit a draft');
  assert.deepEqual(errors, []);
});

test('saved-draft badges use actual providers even when the next-upload preference is Beta', async t => {
  const drafts = [{ draftId: '301', revision: 2, title: 'Original meeting' }, { draftId: '302', revision: 4, title: 'Beta meeting', generationProvider: 'parallel-specialists-v1' }];
  const { page, requests, errors } = await workspace(t, { suffix: '&engine=parallel', drafts });
  await page.waitForSelector('#projectBetaControl:not([hidden])');
  await page.waitForSelector('[data-open-minutes-draft="302"]');
  assert.equal(await page.locator('[data-minutes-draft="301"] .project-beta-badge').count(), 0);
  assert.equal(await page.locator('[data-minutes-draft="302"] .project-beta-badge').innerText(), 'Beta');
  for (const draft of drafts) {
    const link = await minutesLink(page, `[data-open-minutes-draft="${draft.draftId}"]`);
    assert.equal(link.searchParams.get('draftId'), draft.draftId);
    assert.equal(link.searchParams.get('engine'), 'parallel', 'preference travels without replacing the saved draft ID');
    assert.equal(link.searchParams.get('projectId'), '23');
  }
  await page.getByRole('switch', { name: 'Beta meeting minutes' }).press('Space');
  assert.equal((await minutesLink(page, '[data-open-minutes-draft="302"]')).searchParams.get('engine'), 'original');
  assert.equal(await page.locator('[data-minutes-draft="302"] .project-beta-badge').count(), 1, 'changing the next-upload choice never relabels a draft');
  assert.ok(requests.every(request => request.method === 'GET'));
  assert.deepEqual(errors, []);
});

test('choice survives stage navigation, refresh and another project, and remains scoped to the signed-in user', async t => {
  const { page, auth, errors } = await workspace(t, { suffix: '&engine=parallel' });
  await page.waitForSelector('#projectBetaControl:not([hidden])');
  await page.click('#openProjectReportsBtn');
  assert.equal(new URL(page.url()).searchParams.get('engine'), 'parallel');
  await page.click('#openProjectProcessBtn');
  assert.equal(await page.getByRole('switch', { name: 'Beta meeting minutes' }).isChecked(), true);
  await page.reload();
  await page.waitForSelector('#projectBetaControl:not([hidden])');
  assert.equal(await page.getByRole('switch', { name: 'Beta meeting minutes' }).isChecked(), true);
  await page.goto(`${ORIGIN}/project-update-test?stage=process&projectId=24`);
  await page.waitForSelector('#projectBetaControl:not([hidden])');
  assert.equal(await page.getByRole('switch', { name: 'Beta meeting minutes' }).isChecked(), true);
  assert.equal((await minutesLink(page)).searchParams.get('projectId'), '24');
  auth.user = { userId: 42, role: 'admin' };
  await page.goto(`${ORIGIN}/project-update-test?stage=process&projectId=23`);
  await page.waitForSelector('#projectBetaControl:not([hidden])');
  assert.equal(await page.getByRole('switch', { name: 'Beta meeting minutes' }).isChecked(), false, 'another account does not inherit the preference');
  auth.user = { userId: 41, role: 'admin' };
  await page.goto(`${ORIGIN}/project-update-test?stage=process&projectId=23&engine=original`);
  await page.waitForSelector('#projectBetaControl:not([hidden])');
  assert.equal(await page.getByRole('switch', { name: 'Beta meeting minutes' }).isChecked(), false, 'an explicit off choice wins over stored Beta');
  assert.deepEqual(errors, []);
});

test('an upload link cannot silently choose the original flow while its Beta permission check is pending', async t => {
  const { page, finishAuth, errors } = await workspace(t, { suffix: '&engine=parallel', delayedAuth: true, drafts: [{ draftId: '301', revision: 2 }] });
  await page.waitForSelector('[data-open-minutes-draft="301"]');
  assert.equal(await page.locator('#openMinutesAgent').getAttribute('href'), null);
  assert.equal(await page.locator('#openMinutesAgent').getAttribute('aria-disabled'), 'true');
  assert.equal(await page.locator('[data-open-minutes-draft="301"]').getAttribute('href'), null);
  await page.locator('#openMinutesAgent').dispatchEvent('click');
  assert.equal(new URL(page.url()).pathname, '/project-update-test');
  finishAuth();
  await page.waitForSelector('#projectBetaControl:not([hidden])');
  assert.equal((await minutesLink(page)).searchParams.get('engine'), 'parallel');
  assert.equal((await minutesLink(page, '[data-open-minutes-draft="301"]')).searchParams.get('engine'), 'parallel');
  assert.deepEqual(errors, []);
});

test('history navigation refreshes the next-upload choice in the persistent Process stage', async t => {
  const { page, errors } = await workspace(t, { suffix: '&engine=parallel' });
  await page.waitForSelector('#projectBetaControl:not([hidden])');
  await page.click('#openProjectReportsBtn');
  await page.click('#openProjectProcessBtn');
  await page.getByRole('switch', { name: 'Beta meeting minutes' }).press('Space');
  assert.equal(new URL(page.url()).searchParams.get('engine'), 'original');
  await page.goBack();
  for (const selector of ['#switchProjectLink', '#openProjectReportsBtn']) {
    assert.equal(new URL(await page.locator(selector).getAttribute('href'), ORIGIN).searchParams.get('engine'), 'parallel');
  }
  await page.goForward();
  for (const selector of ['#switchProjectLink', '#openProjectReportsBtn']) {
    assert.equal(new URL(await page.locator(selector).getAttribute('href'), ORIGIN).searchParams.get('engine'), 'original');
  }
  assert.equal(await page.getByRole('switch', { name: 'Beta meeting minutes' }).isChecked(), false);
  assert.equal((await minutesLink(page)).searchParams.get('engine'), 'original');
  assert.deepEqual(errors, []);
});

for (const authFailure of [false, true]) {
  test(`Beta fails closed for ${authFailure ? 'an unavailable auth check' : 'a non-admin'} despite an explicit Beta URL`, async t => {
    const { page, errors } = await workspace(t, { suffix: '&engine=parallel', user: { userId: 41, role: 'user' }, authFailure });
    assert.equal(await page.locator('#projectBetaControl').isVisible(), false);
    assert.equal((await minutesLink(page)).searchParams.get('engine'), 'original');
    assert.deepEqual(errors, []);
  });
}

test('unavailable session storage still permits an explicit choice and does not break the workspace', async t => {
  // The project selector still has its existing localStorage behavior; only the
  // new optional session preference is unavailable in this scenario.
  const { page, errors } = await workspace(t);
  await page.waitForSelector('#projectBetaControl:not([hidden])');
  await page.evaluate(() => { Storage.prototype.setItem = function () { throw new Error('Storage unavailable'); }; Storage.prototype.getItem = function () { throw new Error('Storage unavailable'); }; });
  await page.getByRole('switch', { name: 'Beta meeting minutes' }).press('Space');
  assert.equal((await minutesLink(page)).searchParams.get('engine'), 'parallel');
  assert.deepEqual(errors, []);
});

test('the Beta switch and its explanation remain usable on a narrow screen', async t => {
  const { page, errors } = await workspace(t, { suffix: '&engine=parallel' });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.waitForSelector('#projectBetaControl:not([hidden])');
  const bounds = await page.locator('#projectBetaControl').boundingBox();
  assert.ok(bounds.width > 200 && bounds.x >= 0 && bounds.x + bounds.width <= 375);
  assert.equal(await page.getByRole('switch', { name: 'Beta meeting minutes' }).isChecked(), true);
  await page.locator('label[for="projectBetaFlow"]').click();
  assert.equal(await page.getByRole('switch', { name: 'Beta meeting minutes' }).isChecked(), false);
  await page.locator('#projectBetaControl').scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/trinzo-project-beta-mobile.png' });
  assert.deepEqual(errors, []);
});
