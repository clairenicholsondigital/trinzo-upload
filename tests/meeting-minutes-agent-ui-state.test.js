'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { chromium } = require('playwright');

const REPO_ROOT = path.resolve(__dirname, '..');
const PAGE_PATH = path.join(REPO_ROOT, 'views', 'meeting-minutes-agent.html');
const CLIENT_PATH = path.join(REPO_ROOT, 'public', 'meeting-minutes-agent.js');

function baseDraft(id, running = false) {
  return {
    draftId: id,
    revision: 3,
    updatedAt: '2026-09-16T12:00:00.000Z',
    currentStep: 3,
    selectedStep: 3,
    title: 'UI state test',
    details: {
      meetingTitle: 'UI state test', meetingDate: '2026-09-16', meetingLocation: 'Teams',
      meetingType: 'Review', clientAttendeeLabel: 'Client',
      internalAttendees: ['Alex Reed'], clientAttendees: ['Sam Okoro'], allAttendees: ['Alex Reed', 'Sam Okoro']
    },
    steer: '', denoise: {}, staleStages: [], qualityNotice: '',
    sourceUnits: [{ id: 'T0001', speaker: 'Alex Reed', timestamp: '00:10', text: 'Alex will send the revised report.' }],
    discussion: [{
      id: 'topic-1', topic: 'Report review',
      points: [{
        id: 'discussion-1', text: 'The revised report is ready for circulation.', evidenceIds: ['T0001'],
        reviewFlagIds: ['flag-1'],
        supportingDetails: [{ id: 'support-1', text: 'The report incorporates the final comments.', evidenceIds: ['T0001'] }]
      }], decisions: [], openQuestions: []
    }],
    actions: [{
      id: 'action-1', action: 'Send the revised report.', owners: ['Alex Reed'],
      timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds: ['T0001'], reviewFlagIds: ['flag-action']
    }],
    executiveSummary: '', meetingObjectives: [], pendingProposal: null,
    reviewFlags: [{
      id: 'flag-1', kind: 'missing_evidence', message: 'Check the source support for this generated sentence.',
      evidenceIds: ['T0001'], status: 'open', correctionNote: ''
    }, {
      id: 'flag-action', kind: 'ownership', message: 'Check the owner of this action.',
      evidenceIds: ['T0001'], status: 'open', correctionNote: ''
    }],
    generation: running ? {
      stage: 'actions', status: 'running', startedAt: '2026-09-16T12:00:01.000Z',
      pass: 'critic', message: 'Verifying the draft…',
      completedPasses: ['primary', 'recovery', 'referee-batch-1', 'referee'],
      previewActions: [{
        id: 'preview-action-1', action: 'Send the evidence-checked report.', owners: ['Alex Reed'],
        timing: { kind: 'target', wording: 'this week', exactDate: '' }, evidenceIds: ['T0001'], reviewFlagIds: []
      }],
      previewUpdatedAt: '2026-09-16T12:01:01.000Z', callTimings: [], degradedSources: [], error: ''
    } : null
  };
}

function startStubServer() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  const drafts = new Map([
    ['editor', baseDraft('editor', false)],
    ['running', baseDraft('running', true)]
  ]);
  const topicCleanup = baseDraft('topic-cleanup', false);
  topicCleanup.discussion.push({
    id: 'topic-2', topic: 'Second topic', points: [{
      id: 'discussion-2', text: 'A second generated sentence needs review.', evidenceIds: ['T0001'],
      reviewFlagIds: ['flag-topic'], supportingDetails: []
    }], decisions: [], openQuestions: []
  });
  topicCleanup.reviewFlags.push({
    id: 'flag-topic', kind: 'missing_evidence', message: 'Check the second topic.',
    evidenceIds: ['T0001'], status: 'open', correctionNote: ''
  });
  drafts.set('topic-cleanup', topicCleanup);
  const summaryRunning = baseDraft('summary-running', false);
  summaryRunning.currentStep = 4;
  summaryRunning.selectedStep = 3;
  summaryRunning.generation = {
    stage: 'summary', status: 'running', startedAt: '2026-09-16T12:00:01.000Z',
    message: 'Preparing the summary…', completedPasses: [], callTimings: [], degradedSources: [], error: ''
  };
  drafts.set('summary-running', summaryRunning);
  const prewarming = baseDraft('prewarming', false);
  prewarming.currentStep = 2;
  prewarming.selectedStep = 2;
  prewarming.actionsPrewarm = { status: 'preparing', startedAt: '2026-09-16T12:00:02.000Z', completedAt: '' };
  drafts.set('prewarming', prewarming);
  const actionsCompleting = baseDraft('actions-completing', true);
  actionsCompleting.selectedStep = 2;
  actionsCompleting.staleStages = ['actions'];
  drafts.set('actions-completing', actionsCompleting);
  const patchCounts = new Map();
  const patchBodies = new Map();

  app.get('/meeting-minutes-agent', (req, res) => res.type('html').send(fs.readFileSync(PAGE_PATH, 'utf8')));
  app.get('/static/meeting-minutes-agent.js', (req, res) => res.type('application/javascript').send(fs.readFileSync(CLIENT_PATH, 'utf8')));
  app.get('/static/trinzo.js', (req, res) => res.type('application/javascript').send(''));
  app.get('/static/trinzo-fonts.css', (req, res) => res.type('text/css').send(''));
  app.post('/api/meeting-minutes-agent/prepare', (req, res) => {
    const prepared = baseDraft('prepared', false);
    prepared.currentStep = 0;
    prepared.selectedStep = 0;
    drafts.set('prepared', prepared);
    res.json({ ok: true, draft: prepared, resumeUrl: '/meeting-minutes-agent?draftId=prepared' });
  });
  app.get('/api/meeting-minutes-agent/drafts/:id', (req, res) => res.json({ ok: true, draft: drafts.get(req.params.id) }));
  app.patch('/api/meeting-minutes-agent/drafts/:id', (req, res) => {
    patchBodies.set(req.params.id, req.body);
    const prior = drafts.get(req.params.id);
    const next = {
      ...prior,
      ...req.body,
      revision: prior.revision + 1,
      updatedAt: new Date().toISOString(),
      currentStep: Math.max(Number(prior.currentStep || 0), Number(req.body.currentStep || 0)),
      selectedStep: Number(req.body.selectedStep == null ? req.body.currentStep : req.body.selectedStep),
      // Match production normalisation: incomplete structured rows are not persisted.
      actions: (req.body.actions || prior.actions).filter((action) => String(action.action || '').trim()),
      discussion: (req.body.discussion || prior.discussion).map((topic) => ({
        ...topic,
        points: (topic.points || []).filter((record) => String(record.text || '').trim()),
        decisions: (topic.decisions || []).filter((record) => String(record.text || '').trim()),
        openQuestions: (topic.openQuestions || []).filter((record) => String(record.text || '').trim())
      })).filter((topic) => topic.points.length || topic.decisions.length || topic.openQuestions.length)
    };
    drafts.set(req.params.id, next);
    patchCounts.set(req.params.id, (patchCounts.get(req.params.id) || 0) + 1);
    res.json({ ok: true, draft: next });
  });
  app.post('/api/meeting-minutes-agent/drafts/:id/generate-background', (req, res) => {
    const prior = drafts.get(req.params.id);
    const generation = {
      stage: req.body.stage, status: 'running', startedAt: new Date().toISOString(),
      pass: 'starting', message: 'Preparing independent quality checks…',
      completedPasses: [], previewActions: [], callTimings: [], degradedSources: [], error: ''
    };
    const next = {
      ...prior, revision: prior.revision + 1, updatedAt: new Date().toISOString(), generation,
      currentStep: Math.max(Number(prior.currentStep || 0), req.body.stage === 'actions' ? 3 : 2),
      selectedStep: Number(req.body.selectedStep)
    };
    drafts.set(req.params.id, next);
    res.status(202).json({ ok: true, generation, draft: next });
  });
  app.get('/api/meeting-minutes-agent/drafts/:id/generation', (req, res) => {
    let draft = drafts.get(req.params.id);
    if (req.params.id === 'actions-completing' && draft.generation) {
      draft = {
        ...draft, revision: draft.revision + 1, updatedAt: new Date().toISOString(),
        generation: null, staleStages: [],
        actions: [{
          id: 'action-final', action: 'Send the final checked report.', owners: ['Alex Reed'],
          timing: { kind: 'target', wording: 'this week', exactDate: '' }, evidenceIds: ['T0001'], reviewFlagIds: []
        }]
      };
      drafts.set(req.params.id, draft);
      return res.json({ ok: true, generation: null, actionsPrewarm: null, draft });
    }
    if (req.params.id === 'summary-running' && draft.generation) {
      draft = {
        ...draft, revision: draft.revision + 1, updatedAt: new Date().toISOString(),
        generation: null, executiveSummary: 'The report was confirmed for circulation.'
      };
      drafts.set(req.params.id, draft);
      return res.json({ ok: true, generation: null, draft });
    }
    res.json({ ok: true, generation: draft.generation, actionsPrewarm: draft.actionsPrewarm || null });
  });
  app.get('/test-state/:id', (req, res) => res.json({
    patches: patchCounts.get(req.params.id) || 0,
    draft: drafts.get(req.params.id),
    lastPatch: patchBodies.get(req.params.id) || null
  }));

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function launchPage(port, draftId) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${port}/meeting-minutes-agent?draftId=${draftId}`);
  await page.waitForFunction(() => document.querySelector('#actionsBody tr'));
  return { browser, page, errors };
}

test('action editor keeps blank rows, custom-owner text and linked flag targets across autosave renders', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'editor');
    browser = launched.browser;
    const { page, errors } = launched;

    await page.click('#addAction');
    assert.equal(await page.locator('#actionsBody [data-action-row]').count(), 2);
    assert.match(await page.textContent('#saveStatus'), /kept in this tab/i);
    assert.equal(await page.locator('#resumeLaterLink').isHidden(), true, 'no resume-later invitation while an unfinished row exists');

    // Force an autosave which returns a server-normalised draft without the
    // blank row. The local editor row must remain available for entry.
    await page.fill('#actionsBody [data-action-row="0"] [data-action]', 'Send the revised report promptly.');
    await page.waitForFunction(async () => (await (await fetch('/test-state/editor')).json()).patches >= 1);
    assert.equal(await page.locator('#actionsBody [data-action-row]').count(), 2);
    // The autosave succeeded, but the blank row still lives only in this tab:
    // the status must keep saying so and the resume link must stay hidden.
    assert.match(await page.textContent('#saveStatus'), /Keep this tab open/i);
    assert.equal(await page.locator('#resumeLaterLink').isHidden(), true, 'resume link stays hidden after an autosave while an unfinished row exists');

    await page.selectOption('#actionsBody [data-action-row="0"] [data-add-owner]', '__other');
    const customOwner = page.locator('#actionsBody [data-action-row="0"] [data-owner-other]');
    await customOwner.fill('Jordan Lee');
    // Trigger an unrelated autosave without blurring the custom-owner field.
    await page.evaluate(() => {
      const timing = document.querySelector('#actionsBody [data-action-row="0"] [data-timing-wording]');
      timing.value = 'this week';
      timing.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(async () => (await (await fetch('/test-state/editor')).json()).patches >= 2);
    assert.equal(await customOwner.isVisible(), true);
    assert.equal(await customOwner.inputValue(), 'Jordan Lee');

    await page.click('#reviewFlags summary');
    assert.match(await page.textContent('.flag-target blockquote'), /revised report is ready/i);
    await page.click('[data-view-flag-target]');
    await page.waitForFunction(() => document.querySelector('[data-screen="2"]').classList.contains('active'));
    assert.equal(await page.locator('#minutes-discussion-discussion-1').count(), 1);
    assert.match(await page.textContent('.supporting-context'), /report incorporates the final comments/i);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('action generation has an honest waiting state and stage-scoped status', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'running');
    browser = launched.browser;
    const { page, errors } = launched;

    assert.match(await page.textContent('#actionsBody'), /evidence-checked report/i);
    assert.match(await page.textContent('#actionsBody'), /final missed-action checks continue/i);
    assert.equal(await page.locator('#actionsBody textarea').count(), 0, 'preview remains read-only');
    assert.equal(await page.locator('#generationProgress').isVisible(), true);
    assert.match(await page.textContent('#generationPhases'), /Find possible actions.*Final missed-action check/s);
    assert.equal(await page.locator('.generation-phase.done').count(), 3);
    assert.equal(await page.locator('.generation-phase.active').count(), 1);
    for (const selector of ['#addAction', '#applyActionsEdit', '#auditActions', '#toSummary']) {
      assert.equal(await page.locator(selector).isDisabled(), true, `${selector} is disabled while actions run`);
    }
    assert.equal(await page.locator('#addDiscussion').isDisabled(), false, 'safe Discussion additions remain available');
    assert.match(await page.textContent('#saveStatus'), /Everything is saved.*leave and resume later/i);
    assert.doesNotMatch(await page.textContent('#saveStatus'), /Unsaved changes/i);
    assert.match(await page.textContent('#actionsBody'), /Previously saved actions/i);
    assert.match(await page.textContent('#actionsBody'), /Send the revised report/i);

    await page.waitForFunction(() => document.getElementById('workflowStatus').dataset.stage === 'actions');
    assert.equal(await page.locator('#workflowStatus').isVisible(), true);
    await page.click('[data-step="2"]');
    assert.equal(await page.locator('#workflowStatus').isHidden(), true);
    assert.equal(await page.locator('#generationProgress').isVisible(), true, 'generation progress remains visible across stages');
    assert.equal(await page.locator('#viewGeneratedStage').isVisible(), true);

    await page.click('[data-step="0"]');
    await page.fill('#meetingTitle', 'Edited while actions run');
    assert.match(await page.textContent('#saveStatus'), /Unsaved edits are waiting to save.*Keep this tab open/i);
    assert.match(await page.textContent('#generationLeaveMessage'), /Keep this tab open/i);
    assert.equal(await page.locator('#resumeLaterLink').isHidden(), true);
    assert.match(await page.textContent('#staleStages'), /actions/i);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Discussion shows Actions prewarming while the reviewer works', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'prewarming');
    browser = launched.browser;
    const { page, errors } = launched;
    assert.equal(await page.locator('[data-screen="2"]').evaluate((node) => node.classList.contains('active')), true);
    assert.equal(await page.locator('#actionsPrewarmNotice').isVisible(), true);
    assert.match(await page.textContent('#actionsPrewarmNotice'), /Preparing Actions in the background/i);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('successful Actions regeneration clears its outdated warning and stays clear after refresh', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'actions-completing');
    browser = launched.browser;
    const { page, errors } = launched;
    assert.match(await page.textContent('#actionsBody'), /Evidence-checked preview/i);
    assert.match(await page.textContent('#actionsBody'), /Previously saved actions/i);
    assert.match(await page.textContent('#actionsBody'), /Send the revised report/i);
    await page.waitForFunction(() => /Send the final checked report/i.test(document.getElementById('actionsBody').textContent));
    assert.equal(await page.locator('#staleNotice').isHidden(), true);
    await page.reload();
    await page.waitForFunction(() => /Send the final checked report/i.test(document.getElementById('actionsBody').textContent));
    assert.equal(await page.locator('#staleNotice').isHidden(), true);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('starting Actions keeps the reviewer on Discussion and exposes background progress', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'editor');
    browser = launched.browser;
    const { page, errors } = launched;
    await page.click('[data-step="2"]');
    const started = page.waitForResponse((response) =>
      response.url().endsWith('/api/meeting-minutes-agent/drafts/editor/generate-background'));
    await page.click('#generateActions');
    const response = await started;
    assert.equal(response.request().postDataJSON().selectedStep, 2);
    assert.equal(await page.locator('[data-screen="2"]').evaluate((node) => node.classList.contains('active')), true);
    assert.equal(await page.locator('[data-step="3"]').isDisabled(), false);
    assert.equal(await page.locator('#generationProgress').isVisible(), true);
    assert.match(await page.textContent('#generationProgressTitle'), /Preparing actions/i);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('unfinished topics and discussion rows survive autosave responses while explicit deletion clears linked warnings', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'editor');
    browser = launched.browser;
    const { page, errors } = launched;
    await page.click('[data-step="2"]');

    await page.click('#addDiscussion');
    let cards = page.locator('#discussionList .discussion-card');
    assert.equal(await cards.count(), 2);
    const newTopic = cards.last();
    assert.equal(await newTopic.locator('[data-topic]').inputValue(), '');
    assert.match(await page.textContent('#saveStatus'), /kept in this tab/i);

    // An unrelated edit saves and the server omits the empty topic. The local
    // editor must be restored so the reviewer can carry on typing.
    const topicSave = page.waitForResponse((response) =>
      response.url().endsWith('/api/meeting-minutes-agent/drafts/editor')
        && response.request().method() === 'PATCH');
    await cards.first().locator('[data-topic]').fill('Report review updated');
    await topicSave;
    cards = page.locator('#discussionList .discussion-card');
    assert.equal(await cards.count(), 2);
    assert.equal(await cards.last().locator('[data-topic]').inputValue(), '');

    const namedTopicSave = page.waitForResponse((response) =>
      response.url().endsWith('/api/meeting-minutes-agent/drafts/editor')
        && response.request().method() === 'PATCH');
    await cards.last().locator('[data-topic]').fill('New topic in progress');
    await namedTopicSave;
    cards = page.locator('#discussionList .discussion-card');
    assert.equal(await cards.last().locator('[data-topic]').inputValue(), 'New topic in progress');

    await cards.last().locator('[data-add-record="points"]').click();
    cards = page.locator('#discussionList .discussion-card');
    assert.equal(await cards.last().locator('[data-record-field="points"]').count(), 1);
    assert.equal(await cards.last().locator('[data-record-field="points"]').inputValue(), '');

    const rowSave = page.waitForResponse((response) =>
      response.url().endsWith('/api/meeting-minutes-agent/drafts/editor')
        && response.request().method() === 'PATCH');
    await cards.first().locator('[data-record-field="points"]').fill('The revised report is ready for circulation now.');
    await rowSave;
    cards = page.locator('#discussionList .discussion-card');
    assert.equal(await cards.last().locator('[data-record-field="points"]').count(), 1);
    assert.equal(await cards.last().locator('[data-record-field="points"]').inputValue(), '');

    const completedRowSave = page.waitForResponse((response) =>
      response.url().endsWith('/api/meeting-minutes-agent/drafts/editor')
        && response.request().method() === 'PATCH');
    await cards.last().locator('[data-record-field="points"]').fill('The team reviewed the new topic.');
    await completedRowSave;
    const saved = await page.evaluate(async () => (await (await fetch('/test-state/editor')).json()).draft);
    assert.equal(saved.discussion.some((topic) => topic.topic === 'New topic in progress'
      && topic.points.some((record) => record.text === 'The team reviewed the new topic.')), true);

    // The original sentence carries flag-1. Removing the sentence should close
    // that warning now that the target no longer exists.
    const deleteSave = page.waitForResponse((response) =>
      response.url().endsWith('/api/meeting-minutes-agent/drafts/editor')
        && response.request().method() === 'PATCH');
    await cards.first().locator('[data-remove-record="points"]').click();
    await deleteSave;
    const afterDelete = await page.evaluate(async () => (await (await fetch('/test-state/editor')).json()).draft);
    assert.equal(afterDelete.reviewFlags.find((flag) => flag.id === 'flag-1').status, 'dismissed');
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('deleting a topic dismisses warnings belonging to its nested records', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'topic-cleanup');
    browser = launched.browser;
    const { page, errors } = launched;
    await page.click('[data-step="2"]');
    const deleteSave = page.waitForResponse((response) =>
      response.url().endsWith('/api/meeting-minutes-agent/drafts/topic-cleanup')
        && response.request().method() === 'PATCH');
    page.once('dialog', (dialog) => dialog.accept());
    await page.click('[data-delete-topic="1"]');
    await deleteSave;
    const saved = await page.evaluate(async () => (await (await fetch('/test-state/topic-cleanup')).json()).draft);
    assert.equal(saved.discussion.some((topic) => topic.id === 'topic-2'), false);
    assert.equal(saved.reviewFlags.find((flag) => flag.id === 'flag-topic').status, 'dismissed');
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('selected stage and deletions survive save responses, navigation and reopening', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'editor');
    browser = launched.browser;
    const { page, errors } = launched;

    const actionDeleteSave = page.waitForResponse((response) =>
      response.url().endsWith('/api/meeting-minutes-agent/drafts/editor')
        && response.request().method() === 'PATCH');
    await page.click('#actionsBody [data-delete-action]');
    assert.equal(await page.locator('#actionsBody [data-action-row]').count(), 0);
    await page.click('[data-step="2"]');
    await actionDeleteSave;

    const stateAfterActionDelete = await page.evaluate(async () => await (await fetch('/test-state/editor')).json());
    const savedAfterActionDelete = stateAfterActionDelete.draft;
    assert.equal(stateAfterActionDelete.lastPatch.actions.length, 0);
    assert.equal(savedAfterActionDelete.actions.length, 0);
    assert.equal(savedAfterActionDelete.currentStep, 3, 'furthest unlocked stage remains Actions');
    assert.equal(savedAfterActionDelete.selectedStep, 2, 'selected Discussion stage is stored separately');
    assert.equal(savedAfterActionDelete.reviewFlags.find((flag) => flag.id === 'flag-action').status, 'dismissed');

    await page.reload();
    await page.waitForFunction(() => document.querySelector('[data-screen="2"]').classList.contains('active'));
    assert.equal(await page.locator('[data-step="3"]').isDisabled(), false, 'Actions remains unlocked after reopening');

    const discussionDeleteSave = page.waitForResponse((response) =>
      response.url().endsWith('/api/meeting-minutes-agent/drafts/editor')
        && response.request().method() === 'PATCH');
    await page.click('[data-remove-record]');
    await discussionDeleteSave;
    const savedAfterDiscussionDelete = await page.evaluate(async () => (await (await fetch('/test-state/editor')).json()).draft);
    assert.equal(savedAfterDiscussionDelete.discussion.some((topic) =>
      (topic.points || []).some((point) => point.id === 'discussion-1')), false);
    assert.equal(savedAfterDiscussionDelete.reviewFlags.find((flag) => flag.id === 'flag-1').status, 'dismissed');
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('details status clears on Focus and unfinished owner text survives a background completion', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));

    await page.goto(`http://127.0.0.1:${port}/meeting-minutes-agent`);
    await page.locator('#transcriptFile').setInputFiles({
      name: 'transcript.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: Buffer.from('stub')
    });
    await page.waitForFunction(() => /Check the meeting details/i.test(document.getElementById('workflowStatus').textContent));
    await page.click('#toSteer');
    assert.equal(await page.locator('#workflowStatus').isHidden(), true);

    const completionResponse = page.waitForResponse((response) =>
      response.url().endsWith('/api/meeting-minutes-agent/drafts/summary-running/generation'));
    await page.goto(`http://127.0.0.1:${port}/meeting-minutes-agent?draftId=summary-running`);
    await page.waitForFunction(() => document.querySelector('#actionsBody tr'));
    assert.equal(await page.locator('[data-screen="3"]').evaluate((node) => node.classList.contains('active')), true);
    await page.selectOption('#actionsBody [data-action-row="0"] [data-add-owner]', '__other');
    const owner = page.locator('#actionsBody [data-action-row="0"] [data-owner-other]');
    await owner.fill('Jordan Lee');

    const completed = await completionResponse;
    assert.match(JSON.stringify(await completed.json()), /confirmed for circulation/);
    assert.deepEqual(errors, []);
    await page.waitForTimeout(500);
    const completionState = await page.evaluate(() => ({
      status: document.getElementById('workflowStatus').textContent,
      summary: document.getElementById('executiveSummary').value,
      save: document.getElementById('saveStatus').textContent
    }));
    assert.match(completionState.summary, /confirmed for circulation/, JSON.stringify(completionState));
    assert.equal(await page.locator('[data-screen="3"]').evaluate((node) => node.classList.contains('active')), true);
    assert.equal(await owner.isVisible(), true);
    assert.equal(await owner.inputValue(), 'Jordan Lee');
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('editing the discussion with nothing running marks the existing Actions outdated', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'editor');
    browser = launched.browser;
    const { page, errors } = launched;
    assert.equal(await page.locator('#staleNotice').isHidden(), true, 'no warning before any edit');
    await page.click('[data-step="2"]');
    await page.fill('#discussionList [data-record-field]', 'The revised report is ready for circulation next week.');
    assert.equal(await page.locator('#staleNotice').isVisible(), true, 'a material discussion edit warns immediately');
    assert.match(await page.textContent('#staleStages'), /actions/i);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('adding and deleting a blank discussion topic does not mark the Actions outdated', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'editor');
    browser = launched.browser;
    const { page, errors } = launched;
    await page.click('[data-step="2"]');
    await page.click('#addDiscussion');
    assert.equal(await page.locator('#staleNotice').isHidden(), true, 'a blank topic is not a material edit');
    await page.click('[data-delete-topic="1"]');
    assert.equal(await page.locator('#discussionList [data-delete-topic]').count(), 1);
    assert.equal(await page.locator('#staleNotice').isHidden(), true, 'deleting a topic that never had text is not a material edit');
    // Deleting a topic that carries real content still is.
    page.once('dialog', (dialog) => dialog.accept());
    await page.click('[data-delete-topic="0"]');
    assert.equal(await page.locator('#staleNotice').isVisible(), true);
    assert.match(await page.textContent('#staleStages'), /actions/i);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
