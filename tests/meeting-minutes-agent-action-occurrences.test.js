'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { chromium } = require('playwright');

// Row controls live in each row's "…" menu: open the menu, then click the item.
async function clickMenuItem(page, target) {
  const item = typeof target === 'string' ? page.locator(target).first() : target;
  await item.evaluate((node) => { const menu = node.closest('details[data-menu]'); if (menu) menu.open = true; });
  await item.click();
}
const { normaliseAgentResult } = require('../utils/meetingMinutesResultNormalization');
const Timing = require('../utils/meetingMinutesTiming');

const root = path.resolve(__dirname, '..');
const clone = (value) => JSON.parse(JSON.stringify(value));

function collisionDraft(id, identical = false) {
  const actions = [0, 1].map((index) => ({
    // The A4 and A6 shapes reproduce both saved collision families without
    // relying on a transcript-specific action or owner.
    id: id === 'debug' ? 'A6' : 'A4',
    action: identical ? 'Prepare the review package.' : index ? 'Prepare the second review package.' : 'Prepare the first review package.',
    owners: ['Alex Reed'],
    timing: { kind: 'target', wording: 'this week', exactDate: '' },
    evidenceIds: ['T000' + (index + 1)],
    reviewFlagIds: ['flag-' + index],
    timingDecision: { status: 'unresolved', reason: 'row-' + index }
  }));
  return {
    draftId: id, revision: 1, currentStep: 3, selectedStep: 3,
    updatedAt: '2026-10-22T12:00:00.000Z', status: 'draft',
    details: { meetingTitle: 'Occurrence safety', meetingDate: '2026-10-22', meetingLocation: 'Teams',
      meetingType: 'Review', internalAttendees: ['Alex Reed'], clientAttendees: ['Sam Okoro'],
      allAttendees: ['Alex Reed', 'Sam Okoro'] },
    sourceUnits: [
      { id: 'T0001', speaker: 'Alex Reed', text: 'Prepare the first review package this week.' },
      { id: 'T0002', speaker: 'Sam Okoro', text: 'Prepare the second review package this week.' }
    ],
    discussion: [], actions, reviewFlags: actions.map((action, index) => ({
      id: 'flag-' + index, kind: 'ownership', message: 'Check this package owner.',
      evidenceIds: action.evidenceIds, status: 'open', correctionNote: ''
    })),
    // A historic ambiguous reference must mark neither row.
    keptActionIds: [actions[0].id], removedActions: [],
    executiveSummary: '', meetingObjectives: [], staleStages: [], denoise: {},
    generation: null, pendingProposal: null,
    generatedStages: { discussion: 'done', actions: 'done', summary: 'done' }
  };
}

async function harness(id, identical = false, configure) {
  const app = express();
  app.use(express.json());
  let draft = collisionDraft(id, identical);
  draft.actions.forEach((action, index) => {
    action.timingDecision = { version: Timing.TIMING_POLICY_VERSION,
      ...Timing.timingAssessmentKey(action, draft.sourceUnits, ''),
      status: 'unresolved', checkerStatus: 'missing', reason: 'row-' + index };
  });
  if (configure) configure(draft);
  const history = [];
  const redo = [];
  const errors = [];
  app.get('/meeting-minutes-agent', (req, res) => res.type('html').send(fs.readFileSync(path.join(root, 'views/meeting-minutes-agent.html'), 'utf8')));
  app.get('/static/meeting-minutes-timing.js', (req, res) => res.type('js').send(fs.readFileSync(path.join(root, 'utils/meetingMinutesTiming.js'), 'utf8')));
  app.get('/static/meeting-minutes-filing-order.js', (req, res) => res.type('js').send(fs.readFileSync(path.join(root, 'public/meeting-minutes-filing-order.js'), 'utf8')));
  app.get('/static/meeting-minutes-agent.js', (req, res) => res.type('js').send(fs.readFileSync(path.join(root, 'public/meeting-minutes-agent.js'), 'utf8')));
  app.get('/api/meeting-minutes-agent/drafts/:id', (req, res) => res.json({ ok: true, draft }));
  app.get('/api/meeting-minutes-agent/drafts/:id/generation', (req, res) => res.json({ ok: true, generation: null }));
  app.patch('/api/meeting-minutes-agent/drafts/:id', (req, res) => {
    assert.equal(req.body.revision, draft.revision);
    if (req.body.reviewDecisionLabel) {
      history.push({ draft: clone(draft), label: req.body.reviewDecisionLabel });
      redo.length = 0;
    }
    const normalised = normaliseAgentResult({
      discussion: req.body.discussion, actions: req.body.actions, reviewFlags: req.body.reviewFlags
    }, draft.sourceUnits, '', { enforceEvidence: false, dedupeActions: false, mergeTopics: false, preserveReviewerEdits: true });
    draft = { ...draft, ...req.body, actions: normalised.actions, discussion: normalised.discussion,
      reviewFlags: normalised.reviewFlags, revision: draft.revision + 1, updatedAt: new Date().toISOString(),
      lastUndo: history.length ? { id: 'undo', label: history.at(-1).label } : null };
    res.json({ ok: true, draft });
  });
  for (const operation of ['undo', 'redo']) app.post('/api/meeting-minutes-agent/drafts/:id/' + operation, (req, res) => {
    const from = operation === 'undo' ? history : redo;
    const to = operation === 'undo' ? redo : history;
    const entry = from.pop();
    assert.ok(entry);
    to.push({ draft: clone(draft), label: entry.label });
    draft = { ...entry.draft, revision: draft.revision + 1, updatedAt: new Date().toISOString(),
      lastUndo: history.length ? { id: 'undo', label: history.at(-1).label } : null,
      lastRedo: redo.length ? { id: 'redo', label: redo.at(-1).label } : null };
    res.json({ ok: true, draft });
  });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('pageerror', (error) => errors.push(String(error)));
  page.setDefaultTimeout(10000);
  await page.goto('http://127.0.0.1:' + server.address().port + '/meeting-minutes-agent?draftId=' + id);
  await page.waitForSelector('#actionsBody [data-action-row="1"]');
  const row = (index) => page.locator('#actionsBody [data-action-row="' + index + '"]');
  const saved = () => clone(draft);
  async function mutation(run) {
    const response = page.waitForResponse((response) => response.request().method() === 'PATCH');
    await run();
    await response;
    await page.waitForFunction(() => document.querySelector('#saveStatus').dataset.state === 'saved'
      || document.querySelector('#saveStatus').dataset.state === 'local-only');
  }
  return { page, row, saved, mutation, errors, close: async () => { await browser.close(); await new Promise((resolve) => server.close(resolve)); } };
}

for (const id of ['renewal', 'debug']) test('colliding ' + id + ' custom owners stay on their occurrence through autosave and reload', { timeout: 60000 }, async () => {
  const h = await harness(id);
  try {
    const { page, row } = h;
    assert.equal(await page.locator('[data-keep-action][aria-pressed="true"]').count(), 0);
    assert.equal(new Set(await page.locator('#actionsBody [data-action-row]').evaluateAll((rows) => rows.map((row) => row.id))).size, 2);
    await row(1).locator('[data-edit-owners]').click();
    assert.equal(await page.locator('#actionsBody .owner-editor').count(), 1);
    await row(1).locator('[data-add-owner]').selectOption('__other');
    await row(1).locator('[data-owner-other]').fill('Jordan Lee');
    await h.mutation(() => row(0).locator('[data-action]').evaluate((input) => {
      input.value = 'Prepare the first review package carefully.';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }));
    assert.equal(await row(1).locator('[data-owner-other]').inputValue(), 'Jordan Lee');
    assert.equal(await row(0).locator('[data-owner-other]').count(), 0);
    await h.mutation(() => row(1).locator('[data-owner-other]').press('Enter'));
    let saved = h.saved();
    const keys = saved.actions.map((action) => action.occurrenceId);
    assert.ok(keys.every(Boolean));
    assert.equal(new Set(keys).size, 2);
    assert.deepEqual(saved.actions.map((action) => action.owners), [['Alex Reed'], ['Alex Reed', 'Jordan Lee']]);
    assert.deepEqual(saved.actions.map((action) => action.id), [id === 'debug' ? 'A6' : 'A4', id === 'debug' ? 'A6' : 'A4']);
    await row(0).locator('[data-edit-owners]').click();
    await row(0).locator('[data-add-owner]').selectOption('__other');
    await row(0).locator('[data-owner-other]').fill('Taylor Green');
    await h.mutation(() => row(0).locator('[data-owner-other]').blur());
    saved = h.saved();
    assert.deepEqual(saved.actions.map((action) => action.owners), [['Alex Reed', 'Taylor Green'], ['Alex Reed', 'Jordan Lee']]);
    assert.deepEqual(saved.actions.map((action) => action.evidenceIds), [['T0001'], ['T0002']]);
    await page.reload();
    await page.waitForSelector('#actionsBody [data-action-row="1"]');
    assert.deepEqual(await page.locator('#actionsBody [data-action-row]').evaluateAll((rows) => rows.map((row) => row.dataset.actionOccurrenceId)), keys);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('final wording, owners and timing edit exactly one colliding occurrence', { timeout: 60000 }, async () => {
  const h = await harness('final');
  try {
    const { page } = h;
    // A processed draft edits in the document itself.
    if (!(await page.locator('body.doc-mode').count())) await page.click('#editStructureToggle');
    const fields = (field) => page.locator('#finalDocument [data-kind="action"][data-field="' + field + '"]');
    await fields('action').nth(1).click();
    assert.equal(await page.locator('#finalDocument [data-final-editor]').count(), 1);
    await page.fill('#finalDocument [data-final-editor-value]', 'Prepare the reviewed second package.');
    await h.mutation(() => page.click('#finalDocument [data-final-save]'));
    assert.deepEqual(h.saved().actions.map((action) => action.action), ['Prepare the first review package.', 'Prepare the reviewed second package.']);
    await fields('owners').nth(1).click();
    await page.selectOption('#finalDocument [data-final-add-owner]', 'Sam Okoro');
    await h.mutation(() => page.click('#finalDocument [data-final-save]'));
    assert.deepEqual(h.saved().actions.map((action) => action.owners), [['Alex Reed'], ['Alex Reed', 'Sam Okoro']]);
    await fields('timing').nth(1).click();
    await page.fill('#finalDocument [data-final-timing-wording]', 'after approval');
    await page.selectOption('#finalDocument [data-final-timing-kind]', 'dependency');
    await h.mutation(() => page.click('#finalDocument [data-final-save]'));
    const saved = h.saved();
    assert.equal(saved.actions[0].timing.wording, 'this week');
    assert.equal(saved.actions[1].timing.wording, 'after approval');
    assert.deepEqual(saved.actions[0].reviewFlagIds, ['flag-0']);
    assert.ok(saved.actions[1].reviewFlagIds.includes('flag-1'));
    assert.ok(!saved.actions[1].reviewFlagIds.includes('flag-0'));
    assert.ok(!saved.actions[0].reviewFlagIds.includes('flag-1'));
    assert.equal(saved.actions[0].timingDecision.reason, 'row-0');
    assert.equal(saved.actions[1].timingDecision, undefined);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('identical rows keep separate checked, source, warning and restore identities through reorder and undo', { timeout: 60000 }, async () => {
  const h = await harness('identical', true);
  try {
    const { page, row } = h;
    await row(1).locator('[data-edit-timing]').click();
    assert.equal(await page.locator('#actionsBody .timing-editor').count(), 1);
    await row(1).locator('[data-finish-timing-edit]').click();
    // Finish triggers a save; settle it before the next explicit decision.
    await page.waitForFunction(() => document.querySelector('#saveStatus').dataset.state === 'saved');
    await h.mutation(() => clickMenuItem(page, row(1).locator('[data-keep-action]')));
    const keys = h.saved().actions.map((action) => action.occurrenceId);
    assert.deepEqual(h.saved().keptActionIds, ['A4'], 'ambiguous historical ID remains history');
    assert.deepEqual(h.saved().keptActionOccurrenceIds, [keys[1]]);
    assert.equal(await row(0).locator('[data-keep-action]').getAttribute('aria-pressed'), 'false');
    await h.mutation(() => row(1).locator('[data-action-grip]').press('ArrowUp'));
    assert.deepEqual(h.saved().actions.map((action) => action.occurrenceId), [keys[1], keys[0]]);
    assert.equal(await row(0).locator('[data-keep-action]').getAttribute('aria-pressed'), 'true');
    const undo = page.waitForResponse((response) => response.url().endsWith('/undo'));
    await page.click('#undoLastDecision'); await undo;
    await page.waitForFunction((key) => document.querySelector('#actionsBody [data-action-row="1"]').dataset.actionOccurrenceId === key, keys[1]);
    assert.equal(await row(1).locator('[data-keep-action]').getAttribute('aria-pressed'), 'true');
    const sourceIds = await page.locator('#actionsBody [data-action-transcript-panel]').evaluateAll((nodes) => nodes.map((node) => node.id));
    assert.equal(new Set(sourceIds).size, 2);
    await clickMenuItem(page, row(1).locator('[data-open-action-transcript]'));
    assert.equal(await row(1).locator('[data-action-transcript-panel]').getAttribute('open'), '');
    assert.equal(await row(0).locator('[data-action-transcript-panel]').getAttribute('open'), null);
    await page.click('#reviewQueueToggle');
    const targets = await page.locator('[data-view-flag-target]').evaluateAll((nodes) => nodes.map((node) => node.dataset.viewFlagTarget));
    assert.equal(new Set(targets).size, 2);
    assert.equal(targets[1], await row(1).getAttribute('id'));
    await page.locator('[data-view-flag-target]').nth(1).click();
    assert.equal(await row(1).locator('[data-add-owner]').evaluate((node) => node === document.activeElement), true);
    const before = h.saved().actions[1];
    await h.mutation(() => clickMenuItem(page, row(1).locator('[data-reject-action]')));
    assert.equal(h.saved().actions.length, 1);
    const removed = h.saved().removedActions[0];
    for (const field of ['id', 'occurrenceId', 'evidenceIds', 'reviewFlagIds', 'timingDecision']) assert.deepEqual(removed[field], before[field]);
    await page.click('#removedActionsSummary');
    await h.mutation(() => page.click('[data-restore-action]'));
    const restored = h.saved().actions.find((action) => action.occurrenceId === keys[1]);
    for (const field of ['id', 'occurrenceId', 'evidenceIds', 'reviewFlagIds', 'timingDecision']) assert.deepEqual(restored[field], before[field]);
    assert.equal(new Set(h.saved().actions.map((action) => action.occurrenceId)).size, 2);
    await page.reload(); await page.waitForSelector('#actionsBody [data-action-row="1"]');
    assert.equal(await page.locator('[data-keep-action][aria-pressed="true"]').count(), 0);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('unfinished custom owner follows its occurrence through reorder', { timeout: 60000 }, async () => {
  const h = await harness('reorder-draft');
  try {
    const { page, row } = h;
    await row(1).locator('[data-edit-owners]').click();
    await row(1).locator('[data-add-owner]').selectOption('__other');
    await row(1).locator('[data-owner-other]').fill('Reordered Owner');
    await h.mutation(() => row(1).locator('[data-action-grip]').evaluate((grip) => {
      grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    }));
    assert.equal(await row(0).locator('[data-owner-other]').inputValue(), 'Reordered Owner');
    assert.equal(await row(1).locator('[data-owner-other]').count(), 0);
    await h.mutation(() => row(0).locator('[data-owner-other]').press('Enter'));
    assert.deepEqual(h.saved().actions.map((action) => action.owners), [['Alex Reed', 'Reordered Owner'], ['Alex Reed']]);
    assert.deepEqual(h.saved().actions.map((action) => action.evidenceIds), [['T0002'], ['T0001']]);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('duplicate occurrence tokens and shared warnings never select a first row', { timeout: 60000 }, async () => {
  const h = await harness('malformed', false, (draft) => {
    draft.actions.forEach((action) => { action.occurrenceId = 'repeated-occurrence'; action.reviewFlagIds = ['shared-flag']; });
    draft.keptActionOccurrenceIds = ['repeated-occurrence'];
    draft.reviewFlags = [{ id: 'shared-flag', kind: 'ownership', status: 'open',
      message: 'Check both package owners.', evidenceIds: ['T0001', 'T0002'] }];
  });
  try {
    const { page } = h;
    const keys = await page.locator('#actionsBody [data-action-row]').evaluateAll((rows) => rows.map((row) => row.dataset.actionOccurrenceId));
    assert.equal(new Set(keys).size, 2);
    assert.ok(keys.every((key) => key && key !== 'repeated-occurrence'));
    assert.equal(await page.locator('[data-keep-action][aria-pressed="true"]').count(), 0);
    await page.click('#reviewQueueToggle');
    assert.equal(await page.locator('[data-view-flag-target]').count(), 0);
    assert.match(await page.textContent('#flagList'), /linked to several actions/);
    assert.doesNotMatch(await page.textContent('#flagList'), /not currently represented/);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

for (const ambiguous of [false, true]) test('legacy reload without occurrence metadata ' + (ambiguous ? 'retains ambiguous unfinished entry' : 'preserves exact unfinished entry'), { timeout: 60000 }, async () => {
  const h = await harness('legacy-response', false, ambiguous ? (draft) => {
    draft.actions[1] = clone(draft.actions[0]);
  } : undefined);
  try {
    const { page, row } = h;
    const before = await page.locator('#actionsBody [data-action-row]').evaluateAll((rows) => rows.map((row) => row.dataset.actionOccurrenceId));
    await row(1).locator('[data-edit-owners]').click();
    await row(1).locator('[data-add-owner]').selectOption('__other');
    await row(1).locator('[data-owner-other]').fill('Unfinished Owner');
    const response = page.waitForResponse((response) => response.request().method() === 'GET'
      && response.url().endsWith('/api/meeting-minutes-agent/drafts/legacy-response'));
    // Programmatic reload mimics an incoming background response without a
    // real blur, so the unfinished entry must remain local and uncommitted.
    await page.evaluate(() => document.getElementById('reloadDraft').click());
    await response;
    if (ambiguous) await page.waitForFunction(() => document.querySelector('#saveStatus').textContent.includes('saved actions changed'));
    else await page.waitForFunction(() => !document.body.classList.contains('busy'));
    assert.equal(await row(1).locator('[data-owner-other]').inputValue(), 'Unfinished Owner');
    assert.deepEqual(await page.locator('#actionsBody [data-action-row]').evaluateAll((rows) => rows.map((row) => row.dataset.actionOccurrenceId)), before);
    assert.deepEqual(h.saved().actions.map((action) => action.owners), [['Alex Reed'], ['Alex Reed']]);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('opaque occurrence identifiers do not inherit editor state from object prototypes', { timeout: 60000 }, async () => {
  const h = await harness('opaque-keys', false, (draft) => {
    draft.actions[0].occurrenceId = 'constructor';
    draft.actions[1].occurrenceId = '__proto__';
  });
  try {
    const { page, row } = h;
    assert.equal(await page.locator('#actionsBody .owner-editor').count(), 0);
    assert.equal(await page.locator('#actionsBody .timing-editor').count(), 0);
    await row(1).locator('[data-edit-owners]').click();
    assert.equal(await page.locator('#actionsBody .owner-editor').count(), 1);
    await row(1).locator('[data-add-owner]').selectOption('__other');
    await row(1).locator('[data-owner-other]').fill('Opaque Key Owner');
    await h.mutation(() => row(1).locator('[data-owner-other]').press('Enter'));
    assert.deepEqual(h.saved().actions.map((action) => action.occurrenceId), ['constructor', '__proto__']);
    assert.deepEqual(h.saved().actions.map((action) => action.owners), [['Alex Reed'], ['Alex Reed', 'Opaque Key Owner']]);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('malformed numeric occurrence does not claim a valid string occurrence or its check', { timeout: 60000 }, async () => {
  const h = await harness('numeric-key', false, (draft) => {
    draft.actions[0].occurrenceId = 123;
    draft.actions[1].occurrenceId = '123';
    draft.keptActionOccurrenceIds = ['123'];
  });
  try {
    const { page, row } = h;
    const keys = await page.locator('#actionsBody [data-action-row]').evaluateAll((rows) => rows.map((row) => row.dataset.actionOccurrenceId));
    assert.ok(keys[0] && keys[0] !== '123');
    assert.equal(keys[1], '123');
    assert.equal(await row(0).locator('[data-keep-action]').getAttribute('aria-pressed'), 'false');
    assert.equal(await row(1).locator('[data-keep-action]').getAttribute('aria-pressed'), 'true');
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
