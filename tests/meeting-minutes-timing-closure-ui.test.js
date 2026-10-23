'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const ORIGIN = 'http://timing-closure.fixture';
const HTML = fs.readFileSync(path.join(ROOT, 'views/meeting-minutes-agent.html'), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
let browser;

test.before(async () => { browser = await chromium.launch({ headless: true }); });
test.after(async () => { if (browser) await browser.close(); });

function fixture(flag, { linkToAction = false } = {}) {
  return {
    draftId: '202', revision: 1, currentStep: 5, selectedStep: 0, updatedAt: '2026-10-21T12:00:00Z', title: 'Timing review',
    details: {
      meetingTitle: 'Timing review', meetingDate: '2026-10-21', meetingLocation: 'Teams', meetingType: 'Review',
      clientAttendeeLabel: 'Client', internalAttendees: ['Alex Reed'], clientAttendees: [], allAttendees: ['Alex Reed']
    },
    sourceUnits: [{ id: 'T0001', speaker: 'Alex Reed', text: 'I will send the inspection report Friday. The calibration review depends on access being restored.' }],
    discussion: [{ id: 'topic-1', topic: 'Access', points: [{ id: 'point-1', text: 'The calibration review depends on access being restored.', evidenceIds: ['T0001'], reviewFlagIds: [] }], decisions: [], openQuestions: [] }],
    actions: [{ id: 'action-1', action: 'Send the inspection report.', owners: ['Alex Reed'], timing: { kind: 'deadline', wording: 'Friday', exactDate: '2026-10-23' }, evidenceIds: ['T0001'], reviewFlagIds: linkToAction ? [flag.id] : [] }],
    executiveSummary: 'The inspection report will be sent Friday.',
    meetingObjectives: [{ id: 'objective-1', text: 'Complete the calibration review Friday.', evidenceIds: ['T0001'] }],
    includeSections: { meetingObjectives: true, executiveSummary: true, topicHeadings: true },
    reviewFlags: [{ status: 'open', correctionNote: '', evidenceIds: ['T0001'], ...flag }],
    generation: null, pendingProposal: null, staleStages: [], qualityNotice: '', denoise: {}, steer: '', actionsPrewarm: null, speculation: null
  };
}

async function agentPage(t, initialDraft) {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage(), errors = [], calls = [];
  let draft = copy(initialDraft);
  page.on('pageerror', error => errors.push(String(error)));
  await context.route('**/*', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    const json = body => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (pathname === '/meeting-minutes-agent') return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
    const scripts = {
      '/static/meeting-minutes-filing-order.js': 'public/meeting-minutes-filing-order.js',
      '/static/meeting-minutes-agent.js': 'public/meeting-minutes-agent.js',
      '/static/meeting-minutes-timing.js': 'utils/meetingMinutesTiming.js',
      '/static/meeting-minutes-project-link.js': 'public/meeting-minutes-project-link.js'
    };
    if (scripts[pathname]) return route.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(path.join(ROOT, scripts[pathname]), 'utf8') });
    if (pathname === '/api/meeting-minutes-agent/drafts/202') {
      if (request.method() === 'PATCH') {
        const patch = request.postDataJSON();
        calls.push({ method: 'PATCH', patch: copy(patch) });
        draft = { ...draft, ...patch, revision: draft.revision + 1 };
      }
      return json({ ok: true, draft });
    }
    if (pathname.startsWith('/api/')) {
      calls.push({ method: request.method(), pathname });
      return json({ ok: true });
    }
    return route.fulfill({ status: 200, contentType: pathname.endsWith('.js') ? 'application/javascript' : pathname.endsWith('.css') ? 'text/css' : 'application/json', body: /\.(?:js|css)$/.test(pathname) ? '' : '{}' });
  });
  await page.goto(ORIGIN + '/meeting-minutes-agent?draftId=202');
  await page.waitForSelector('#saveStrip:not([hidden])');
  await page.click('#reviewQueueToggle');
  await page.waitForSelector('#reviewFlags[open] .review-queue-item');
  return { page, errors, calls };
}

async function assertFocused(page, selector) {
  await page.waitForFunction(selector => document.activeElement?.matches(selector), selector);
  assert.equal(await page.locator(selector).evaluate(element => element === document.activeElement), true);
}

test('a summary timing warning sharing action evidence opens and focuses the summary itself', async t => {
  const { page, errors } = await agentPage(t, fixture({
    id: 'summary-date', kind: 'timing', temporalField: 'executiveSummary',
    message: 'Cannot verify Friday in the executive summary for the inspection report.'
  }));
  const card = page.locator('#flagList .review-queue-item');
  assert.match(await card.innerText(), /In the minutes · Executive summary/);
  assert.equal(await card.locator('[data-view-flag-target]').getAttribute('data-view-flag-target'), 'executiveSummary');
  await card.getByRole('button', { name: 'Open in minutes', exact: true }).click();
  await assertFocused(page, '#executiveSummary');
  assert.equal(await page.locator('[data-screen="4"]').isVisible(), true);
  assert.equal(await page.locator('#actionsBody [data-timing-date]').count(), 0, 'the unrelated action timing editor was not opened');
  assert.deepEqual(errors, []);
});

test('an objective timing scope takes priority over a stale explicit action flag link', async t => {
  const { page, errors } = await agentPage(t, fixture({
    id: 'objective-date', kind: 'timing', temporalField: 'meetingObjectives',
    message: 'Cannot verify Friday for the calibration review in the meeting objective.'
  }, { linkToAction: true }));
  const card = page.locator('#flagList .review-queue-item');
  assert.match(await card.innerText(), /In the minutes · Meeting objectives/);
  assert.equal(await card.locator('[data-view-flag-target]').getAttribute('data-view-flag-target'), 'objectivesList');
  await card.getByRole('button', { name: 'Open in minutes', exact: true }).click();
  await assertFocused(page, '#objectivesList textarea');
  assert.equal(await page.locator('[data-screen="4"]').isVisible(), true);
  assert.match(await page.locator('#objectivesList textarea').inputValue(), /calibration review/);
  assert.deepEqual(errors, []);
});

for (const temporalField of ['timedStepCoverage', 'unverifiedSourceTiming']) {
  test(`a ${temporalField} warning is not inferred as an existing action from shared evidence`, async t => {
    const { page, errors } = await agentPage(t, fixture({
      id: 'missing-timed-step', kind: 'timing', temporalField,
      message: 'Alex Reed must check the calibration review timing Friday; this step is not represented in the minutes.'
    }));
    const card = page.locator('#flagList .review-queue-item');
    assert.equal(await card.locator('[data-view-flag-target]').count(), 0);
    assert.match(await card.innerText(), /Transcript detail to consider/);
    assert.match(await card.innerText(), /not currently represented in the minutes/);
    assert.doesNotMatch(await card.innerText(), /In the minutes · Action timing/);
    await page.click('[data-step="3"]');
    assert.equal(await page.locator('#actionsBody [data-action-row]').count(), 1);
    await page.getByRole('button', { name: 'Remove action from minutes', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('#actionsBody [data-action-row]').length === 0);
    assert.equal(await page.locator('#flagList .review-queue-item').count(), 1, 'removing a different action must not silently dismiss the missing-step/source warning');
    assert.equal(await page.locator('#flagCount').innerText(), '1 check');
    assert.deepEqual(errors, []);
  });
}

test('ordinary unscoped action timing warnings still infer the action and focus its date editor', async t => {
  const { page, errors, calls } = await agentPage(t, fixture({
    id: 'action-date', kind: 'timing',
    message: 'Check Friday for Alex Reed sending the inspection report.'
  }));
  const card = page.locator('#flagList .review-queue-item');
  assert.match(await card.innerText(), /In the minutes · Action timing/);
  assert.equal(await card.locator('[data-view-flag-target]').getAttribute('data-target-step'), '3');
  await card.getByRole('button', { name: 'Open in minutes', exact: true }).click();
  await assertFocused(page, '#actionsBody [data-timing-date]');
  assert.equal(await page.locator('[data-screen="3"]').isVisible(), true);
  assert.equal(await page.locator('#actionsBody [data-timing-date]').inputValue(), '2026-10-23');
  assert.equal(calls.some(call => call.pathname?.includes('generate')), false, 'warning navigation never invokes generation');
  assert.deepEqual(errors, []);
});
