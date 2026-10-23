'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const ORIGIN = 'http://project-agenda.fixture';
const PROCESS_SOURCE = fs.readFileSync(path.join(ROOT, 'public/project-stage-process.js'), 'utf8');
let browser;

test.before(async () => { browser = await chromium.launch({ headless: true }); });
test.after(async () => { if (browser) await browser.close(); });

async function agendaFor(t, context) {
  const browserContext = await browser.newContext();
  t.after(() => browserContext.close());
  await browserContext.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><main></main>' }));
  const page = await browserContext.newPage();
  await page.goto(ORIGIN + '/project-update-test?stage=process&projectId=19');
  await page.evaluate((agendaContext) => {
    document.body.innerHTML = '<button class="stage-tab" data-stage="setup" type="button">Setup</button><main id="process"></main>';
    window.setupClicks = 0;
    document.querySelector('.stage-tab').addEventListener('click', () => { window.setupClicks += 1; });
    const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    window.ProjectWorkspace = {
      escapeHtml, asArray: value => Array.isArray(value) ? value : [], displayDate: value => value, friendlyLabel: value => value,
      request: async (url) => (url.startsWith('/api/') ? { drafts: [] } : { context: agendaContext })
    };
  }, context);
  await page.addScriptTag({ content: PROCESS_SOURCE });
  await page.evaluate(() => window.ProjectStages.process.mount(document.getElementById('process'), { projectId: 19, project: { projectName: 'Example' } }));
  await page.click('[data-process-panel="agenda"]');
  await page.waitForSelector('#meetingAgenda .agenda-step');
  return page;
}

test('agenda without milestones is labelled as generic and points to Setup', async t => {
  const page = await agendaFor(t, { activeMilestones: [], activeRisks: [] });
  const notice = page.locator('#meetingAgenda .generic-agenda-notice');
  assert.equal(await notice.count(), 1);
  assert.match(await notice.innerText(), /Generic agenda/);
  assert.equal(await notice.locator('a').getAttribute('href'), '?stage=setup&projectId=19');
  // The agenda itself is unchanged: same four steps.
  assert.equal(await page.locator('#meetingAgenda .agenda-step').count(), 4);
  await notice.locator('a').click();
  assert.equal(await page.evaluate(() => window.setupClicks), 1);
});

test('agenda with milestones has no generic notice', async t => {
  const page = await agendaFor(t, { activeMilestones: [{ milestoneName: 'Design sign-off' }], activeRisks: [] });
  assert.equal(await page.locator('#meetingAgenda .generic-agenda-notice').count(), 0);
  assert.equal(await page.locator('#meetingAgenda .agenda-step').count(), 4);
});
