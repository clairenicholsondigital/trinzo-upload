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
  const summaryEmpty = baseDraft('summary-empty', false);
  summaryEmpty.currentStep = 4;
  summaryEmpty.selectedStep = 4;
  summaryEmpty.speculation = null;
  drafts.set('summary-empty', summaryEmpty);
  const prewarming = baseDraft('prewarming', false);
  prewarming.currentStep = 2;
  prewarming.selectedStep = 2;
  prewarming.actionsPrewarm = { status: 'preparing', startedAt: '2026-09-16T12:00:02.000Z', completedAt: '' };
  drafts.set('prewarming', prewarming);
  const discussionReady = baseDraft('discussion-ready', false);
  discussionReady.currentStep = 1;
  discussionReady.selectedStep = 1;
  discussionReady.discussion = [];
  discussionReady.speculation = {
    stage: 'discussion', status: 'ready', startedAt: '2026-09-16T12:00:02.000Z', completedAt: '2026-09-16T12:01:02.000Z'
  };
  drafts.set('discussion-ready', discussionReady);
  const proposals = baseDraft('proposals', false);
  proposals.pendingProposal = {
    stage: 'actions',
    changes: [{
      // The server now states every selection explicitly; unset means unticked.
      id: 'proposal-1', type: 'add', before: null, selected: true,
      after: { id: 'action-2', action: 'Confirm access to the audit folder.', owners: [], timing: { kind: 'not_stated', wording: '', exactDate: '' } },
      reviewContext: { reason: 'The owner still needs confirming.', label: 'agreed, then committed', evidenceIds: ['T0001'] }
    }]
  };
  proposals.reviewFlags.push({
    id: 'proposal-review-proposal-1', kind: 'possible_missed_follow_up',
    message: 'Possible missed action: Confirm access to the audit folder.',
    evidenceIds: ['T0001'], status: 'open', correctionNote: ''
  });
  drafts.set('proposals', proposals);
  const partialProposals = baseDraft('partial-proposals', false);
  partialProposals.pendingProposal = {
    stage: 'actions',
    changes: [{
      id: 'partial-1', type: 'add', before: null, selected: true,
      after: { id: 'partial-action-1', action: 'Confirm folder access.', owners: [], timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds: ['T0001'] },
      beforeIndex: 1, index: 1
    }, {
      id: 'partial-2', type: 'add', before: null, selected: true,
      after: { id: 'partial-action-2', action: 'Circulate the audit checklist.', owners: ['Alex Reed'], timing: { kind: 'target', wording: 'this week', exactDate: '' }, evidenceIds: ['T0001'] },
      beforeIndex: 1, index: 1
    }]
  };
  partialProposals.reviewFlags.push(
    { id: 'proposal-review-partial-1', kind: 'possible_missed_follow_up', message: 'Possible missed action: Confirm folder access.', evidenceIds: ['T0001'], status: 'open', correctionNote: '' },
    { id: 'proposal-review-partial-2', kind: 'possible_missed_follow_up', message: 'Possible missed action: Circulate the audit checklist.', evidenceIds: ['T0001'], status: 'open', correctionNote: '' }
  );
  drafts.set('partial-proposals', partialProposals);
  const unlinkedWarning = baseDraft('unlinked-warning', false);
  unlinkedWarning.sourceUnits.push({ id: 'T0002', speaker: 'Sam Okoro', timestamp: '00:20', text: 'The training attestation needs to be signed by Friday.' });
  unlinkedWarning.actions = [{
    id: 'training-action', action: 'Complete and sign the training attestation.', owners: ['Sam Okoro'],
    timing: { kind: 'deadline', wording: 'by Friday', exactDate: '2026-09-18' }, evidenceIds: ['T0002'], reviewFlagIds: []
  }];
  unlinkedWarning.reviewFlags = [{
    id: 'training-timing-flag', kind: 'timing', message: 'Confirm the Action timing “by Friday”.',
    evidenceIds: ['T0002'], status: 'open', correctionNote: ''
  }];
  drafts.set('unlinked-warning', unlinkedWarning);
  const layout = baseDraft('layout', false);
  layout.currentStep = 5;
  layout.selectedStep = 4;
  layout.meetingObjectives = [{ id: 'objective-1', text: 'Rehearse presenter transitions and webinar delivery flow before the live session.' }];
  layout.executiveSummary = 'The team confirmed the main preparation priorities and owners.';
  layout.discussion[0].topic = 'Audit preparation and document access for the upcoming site visit';
  drafts.set('layout', layout);
  const actionsCompleting = baseDraft('actions-completing', true);
  actionsCompleting.selectedStep = 2;
  actionsCompleting.staleStages = ['actions'];
  drafts.set('actions-completing', actionsCompleting);
  const navigation = baseDraft('navigation', false);
  navigation.currentStep = 5;
  navigation.selectedStep = 3;
  navigation.actions = Array.from({ length: 7 }, (_, index) => ({
    id: `navigation-action-${index + 1}`,
    action: `Complete preparation task ${index + 1} and share the outcome with the meeting attendees.`,
    owners: [index % 2 ? 'Sam Okoro' : 'Alex Reed'],
    timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds: ['T0001'], reviewFlagIds: []
  }));
  drafts.set('navigation', navigation);
  const patchCounts = new Map();
  const patchBodies = new Map();
  const reviewHistory = new Map();
  const redoHistory = new Map();

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
  app.patch('/api/meeting-minutes-agent/drafts/:id', async (req, res) => {
    if (req.params.id === 'navigation') await new Promise((resolve) => setTimeout(resolve, 250));
    patchBodies.set(req.params.id, req.body);
    const prior = drafts.get(req.params.id);
    const history = reviewHistory.get(req.params.id) || [];
    if (req.body.reviewDecisionLabel) history.push({
      label: req.body.reviewDecisionLabel,
      snapshot: JSON.parse(JSON.stringify(prior))
    });
    reviewHistory.set(req.params.id, history);
    if (req.body.reviewDecisionLabel) redoHistory.set(req.params.id, []);
    const next = {
      ...prior,
      ...req.body,
      lastRedo: req.body.reviewDecisionLabel ? null : (prior.lastRedo || null),
      revision: prior.revision + 1,
      updatedAt: new Date().toISOString(),
      currentStep: Math.max(Number(prior.currentStep || 0), Number(req.body.currentStep || 0)),
      selectedStep: Number(req.body.selectedStep == null ? req.body.currentStep : req.body.selectedStep),
      lastUndo: history.length ? { id: `undo-${history.length}`, label: history[history.length - 1].label } : null,
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
  app.post('/api/meeting-minutes-agent/drafts/:id/proposal', (req, res) => {
    const prior = drafts.get(req.params.id);
    const history = reviewHistory.get(req.params.id) || [];
    const proposal = prior.pendingProposal;
    const allIds = (proposal?.changes || []).map((change) => change.id);
    const accepted = req.body.decision === 'accept'
      ? new Set(req.body.acceptAll ? allIds : (req.body.changeIds || [])) : new Set();
    const rejected = req.body.decision === 'reject' ? new Set(allIds) : new Set();
    const acceptedAdds = (proposal?.changes || []).filter((change) => accepted.has(change.id) && change.type === 'add').map((change) => change.after);
    const remainingChanges = (proposal?.changes || []).filter((change) => !accepted.has(change.id) && !rejected.has(change.id))
      .map((change) => ({ ...change, selected: false }));
    const label = req.body.decision === 'reject' ? `${allIds.length} suggestions dismissed` : `${accepted.size} suggestion${accepted.size === 1 ? '' : 's'} applied`;
    history.push({ label, snapshot: JSON.parse(JSON.stringify(prior)) });
    reviewHistory.set(req.params.id, history);
    const next = {
      ...prior,
      actions: [...(prior.actions || []), ...acceptedAdds],
      pendingProposal: remainingChanges.length ? { ...proposal, changes: remainingChanges } : null,
      reviewFlags: (prior.reviewFlags || []).map((flag) => {
        const change = (proposal?.changes || []).find((item) => flag.id === `proposal-review-${item.id}`);
        if (!change || (!accepted.has(change.id) && !rejected.has(change.id))) return flag;
        return { ...flag, status: accepted.has(change.id) ? 'confirmed' : 'dismissed' };
      }),
      revision: prior.revision + 1,
      updatedAt: new Date().toISOString(),
      lastUndo: { id: `undo-${history.length}`, label }
    };
    drafts.set(req.params.id, next);
    res.json({ ok: true, draft: next });
  });
  app.post('/api/meeting-minutes-agent/drafts/:id/redo', (req, res) => {
    const prior = drafts.get(req.params.id);
    const redo = redoHistory.get(req.params.id) || [];
    const latest = redo.pop();
    if (!latest) return res.status(409).json({ ok: false, error: 'There is nothing to redo.' });
    redoHistory.set(req.params.id, redo);
    const history = reviewHistory.get(req.params.id) || [];
    history.push({ label: latest.label, snapshot: JSON.parse(JSON.stringify(prior)) });
    reviewHistory.set(req.params.id, history);
    const next = {
      ...latest.snapshot,
      revision: prior.revision + 1,
      updatedAt: new Date().toISOString(),
      lastUndo: { id: `undo-${history.length}`, label: latest.label },
      lastRedo: redo.length ? { id: `redo-${redo.length}`, label: redo[redo.length - 1].label } : null
    };
    drafts.set(req.params.id, next);
    res.json({ ok: true, draft: next });
  });

  app.post('/api/meeting-minutes-agent/drafts/:id/undo', (req, res) => {
    const prior = drafts.get(req.params.id);
    const history = reviewHistory.get(req.params.id) || [];
    const latest = history.pop();
    if (!latest) return res.status(409).json({ ok: false, error: 'There is nothing to undo.' });
    reviewHistory.set(req.params.id, history);
    const redo = redoHistory.get(req.params.id) || [];
    redo.push({ label: latest.label, snapshot: JSON.parse(JSON.stringify(prior)) });
    redoHistory.set(req.params.id, redo);
    const next = {
      ...latest.snapshot,
      revision: prior.revision + 1,
      updatedAt: new Date().toISOString(),
      lastUndo: history.length ? { id: `undo-${history.length}`, label: history[history.length - 1].label } : null,
      lastRedo: { id: `redo-${redo.length}`, label: latest.label }
    };
    drafts.set(req.params.id, next);
    res.json({ ok: true, draft: next });
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
    undoLabels: (reviewHistory.get(req.params.id) || []).map((entry) => entry.label),
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

    await page.click('#actionsBody [data-action-row="0"] [data-edit-timing]');
    await page.click('#actionsBody [data-action-row="0"] [data-edit-owners]');
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
    assert.match(await page.textContent('#omittedDetailsPanel'), /These details were left out of the draft/i);
    assert.match(await page.textContent('#omittedDetailsPanel'), /report incorporates the final comments/i);
    assert.equal(await page.locator('.supporting-context').count(), 0, 'omitted details use one shared review panel');
    assert.equal(await page.locator('#omittedDetailsPanel [data-promote-supporting]').count(), 1);
    assert.equal(await page.locator('#omittedDetailsPanel [data-promote-supporting]').textContent(), 'Add to minutes');
    await page.click('#omittedDetailsPanel summary');
    await page.click('#omittedDetailsPanel [data-promote-supporting]');
    assert.equal(await page.locator('#omittedDetailsPanel').count(), 0, 'adding an omitted detail removes it from the review panel');
    assert.equal(await page.locator('#minutes-discussion-support-1').count(), 1);
    assert.equal(await page.locator('#minutes-discussion-support-1 textarea').inputValue(), 'The report incorporates the final comments.');
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('keeping, rejecting and putting back an action, with live counts', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'editor');
    browser = launched.browser;
    const { page, errors } = launched;

    const bar = page.locator('#actionReviewBar');
    assert.match(await bar.textContent(), /1 action · 1 unchecked · 0 suggestions/, 'everything starts unchecked');

    // Keep marks a row as checked without changing the minutes.
    await page.click('#actionsBody [data-action-row="0"] [data-keep-action]');
    assert.match(await bar.textContent(), /1 action · 0 unchecked · 0 suggestions/);
    assert.equal(await page.locator('#actionsBody [data-action-row]').count(), 1, 'keeping removes nothing');

    // Rejecting moves the row out of the register and into Removed.
    await page.click('#actionsBody [data-action-row="0"] [data-reject-action]');
    assert.equal(await page.locator('#actionsBody [data-action-row]').count(), 0);
    assert.equal(await page.locator('#removedActionsPanel').isHidden(), false);
    assert.match(await page.textContent('#removedActionsSummary'), /1 removed action/);

    // And it can be put back rather than retyped. The section stays collapsed
    // by default so it does not crowd the register; opening it is one click.
    await page.click('#removedActionsSummary');
    await page.click('#removedActionsList [data-restore-action]');
    assert.equal(await page.locator('#actionsBody [data-action-row]').count(), 1);
    assert.equal(await page.locator('#removedActionsPanel').isHidden(), true);
    const restored = await page.inputValue('#actionsBody [data-action-row="0"] [data-action]');
    assert.ok(restored.length > 0, 'the wording comes back with the row');
    // A row put back is no longer counted as checked: it needs deciding again.
    assert.match(await bar.textContent(), /1 action · 1 unchecked · 0 suggestions/);

    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    server.close();
  }
});

test('actions can be reordered from the keyboard, and the order is saved', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'editor');
    browser = launched.browser;
    const { page, errors } = launched;

    await page.click('#addAction');
    await page.fill('#actionsBody [data-action-row="1"] [data-action]', 'Second action text.');
    const first = await page.inputValue('#actionsBody [data-action-row="0"] [data-action]');

    // A drag-only handle cannot be operated without a mouse, so it takes arrows.
    await page.focus('#actionsBody [data-action-row="0"] [data-action-grip]');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.inputValue('#actionsBody [data-action-row="1"] [data-action]'), first);
    assert.equal(await page.inputValue('#actionsBody [data-action-row="0"] [data-action]'), 'Second action text.');

    // Focus follows the row that moved, so the keys can be pressed repeatedly.
    assert.equal(await page.evaluate(() => document.activeElement.dataset.actionGrip), '1');

    await page.keyboard.press('ArrowUp');
    assert.equal(await page.inputValue('#actionsBody [data-action-row="0"] [data-action]'), first);

    // The top row cannot move above itself.
    await page.focus('#actionsBody [data-action-row="0"] [data-action-grip]');
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.inputValue('#actionsBody [data-action-row="0"] [data-action]'), first);

    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    server.close();
  }
});

test('a discussion record moves within its topic and across topics', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'topic-cleanup');
    browser = launched.browser;
    const { page, errors } = launched;
    await page.click('[data-step="2"]');

    const firstText = await page.inputValue('.discussion-card:nth-child(1) [data-record-field]');
    const secondCardCount = await page.locator('.discussion-card:nth-child(2) [data-record-field]').count();

    // Arrows move a record within its own kind; the first row cannot rise.
    await page.focus('.discussion-card:nth-child(1) [data-record-grip]');
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.inputValue('.discussion-card:nth-child(1) [data-record-field]'), firstText);

    // Dropping onto a row in another topic moves it there, keeping its kind.
    await page.evaluate(() => {
      const grip = document.querySelector('.discussion-card:nth-child(1) [data-record-grip]');
      const target = document.querySelector('.discussion-card:nth-child(2) [data-record-row]');
      const data = new DataTransfer();
      grip.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: data }));
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: data }));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: data }));
    });
    assert.equal(await page.locator('.discussion-card:nth-child(2) [data-record-field]').count(), secondCardCount + 1);
    const movedKind = await page.locator('.discussion-card:nth-child(2) [data-record-field]').first().getAttribute('data-record-field');
    assert.equal(movedKind, 'points', 'a discussion point stays a discussion point when it moves');

    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    server.close();
  }
});

test('the workflow has five steps and Details leads straight to generating', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'editor');
    browser = launched.browser;
    const { page, errors } = launched;

    assert.equal(await page.locator('.steps .step').count(), 5, 'Focus is gone from the stepper');
    assert.equal(await page.locator('.steps .step[data-step="1"]').count(), 0);
    // A draft saved on the retired index landing on Discussion rather than on
    // Actions is covered by 'a prepared Discussion is adopted automatically
    // after Details', whose fixture is saved on step 1.

    // The steer control survives the screen it used to live on.
    await page.click('[data-step="0"]');
    assert.equal(await page.locator('#meetingSteer').count(), 1);
    assert.equal(await page.locator('#meetingSteer').isHidden(), true, 'optional, so it starts collapsed');
    await page.click('.steer-optional>summary');
    assert.equal(await page.locator('#meetingSteer').isVisible(), true);

    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    server.close();
  }
});

test('an opened transcript panel survives a re-render, and each step remembers its place', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'topic-cleanup');
    browser = launched.browser;
    const { page, errors } = launched;
    await page.click('[data-step="2"]');
    await page.waitForSelector('#discussionList .discussion-card');

    // Open a transcript panel, then force the list to be rebuilt.
    const panel = page.locator('#discussionList [data-keep-open]').first();
    await panel.evaluate((node) => { node.open = true; });
    const key = await panel.getAttribute('data-keep-open');
    await page.evaluate(() => { const t = document.querySelector('[data-topic]'); if (t) { t.value = t.value + ' edited'; t.dispatchEvent(new Event('input', { bubbles: true })); } });
    await page.waitForTimeout(600);
    assert.equal(
      await page.locator('#discussionList [data-keep-open="' + key + '"]').evaluate((node) => node.open),
      true,
      'the panel a reviewer opened to read a passage stays open across a re-render'
    );

    // Leaving a screen and coming back returns to the same place.
    await page.evaluate(() => window.scrollTo(0, 220));
    await page.waitForTimeout(150);
    const before = await page.evaluate(() => window.scrollY);
    await page.click('[data-step="0"]');
    await page.waitForTimeout(300);
    await page.click('[data-step="2"]');
    await page.waitForTimeout(600);
    const after = await page.evaluate(() => window.scrollY);
    assert.ok(Math.abs(after - before) < 60, 'returned to ' + after + ' after leaving from ' + before);

    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    server.close();
  }
});

test('action View transcript opens the relevant passage by mouse and keyboard', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'editor');
    browser = launched.browser;
    const { page, errors } = launched;
    await page.click('[data-step="3"]');
    const button = page.locator('[data-action-row="0"] [data-open-action-transcript]');
    const panel = page.locator('[data-action-row="0"] [data-action-transcript-panel]');
    await button.click();
    assert.equal(await panel.evaluate((node) => node.open), true);
    assert.equal(await button.getAttribute('aria-expanded'), 'true');
    assert.ok(await panel.locator('.source-speaker').count() > 0, 'speaker is visible');
    assert.ok(await panel.locator('.source-time').count() > 0, 'timestamp is visible');

    await page.evaluate(() => {
      const node = document.querySelector('[data-action-row="0"] [data-action-transcript-panel]');
      node.open = false;
      node.querySelector('summary').blur();
    });
    await button.focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(50);
    assert.equal(await panel.evaluate((node) => node.open), true, 'keyboard activation opens the same passage');
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    server.close();
  }
});

test('independent section switches hide output without deleting saved content', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    // A fixture that has reached Summary, so that step is unlocked.
    const launched = await launchPage(port, 'layout');
    browser = launched.browser;
    const { page, errors } = launched;

    await page.click('[data-step="0"]');
    assert.equal(await page.locator('#includeObjectives').isChecked(), true, 'both are on by default');
    assert.equal(await page.locator('#includeSummary').isChecked(), true);
    const staleBeforeInclusion = await page.evaluate(async () => (await (await fetch('/test-state/layout')).json()).draft.staleStages || []);

    await page.click('[data-step="4"]');
    assert.equal(await page.locator('[data-section="executiveSummary"]').isHidden(), false);
    const longSummary = 'A long reviewer-written summary sentence that must remain readable without an internal scrollbar. '.repeat(24);
    await page.fill('#executiveSummary', longSummary);
    await page.waitForTimeout(100);
    const summaryBox = await page.locator('#executiveSummary').evaluate((node) => ({
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
      overflowY: getComputedStyle(node).overflowY
    }));
    assert.ok(summaryBox.clientHeight >= summaryBox.scrollHeight, JSON.stringify(summaryBox));
    assert.equal(summaryBox.overflowY, 'hidden');
    await page.waitForTimeout(1000);

    // Turn the executive summary off.
    await page.click('[data-step="0"]');
    await page.uncheck('#includeSummary');
    const staleAfterSummaryToggle = await page.evaluate(async () => (await (await fetch('/test-state/layout')).json()).draft.staleStages || []);
    assert.deepEqual(staleAfterSummaryToggle, staleBeforeInclusion, 'summary inclusion does not change downstream freshness');
    await page.click('[data-step="4"]');
    assert.equal(await page.locator('[data-section="executiveSummary"]').isHidden(), true,
      'an excluded section leaves the screen rather than sitting there empty');
    assert.equal(await page.locator('[data-section="meetingObjectives"]').isHidden(), false,
      'the other section is untouched');

    // The choice reaches the server, and the text goes with it.
    await page.waitForFunction(async () => {
      const state = await (await fetch('/test-state/layout')).json();
      return state.draft.includeSections && state.draft.includeSections.executiveSummary === false;
    });
    assert.equal(await page.evaluate(async () => (await (await fetch('/test-state/layout')).json()).draft.executiveSummary), longSummary.trim());

    // All four combinations remain possible and the final review honours the
    // choice without changing the underlying text.
    const combinations = [
      [true, true, true, true],
      [true, false, true, false],
      [false, true, false, true],
      [false, false, false, false]
    ];
    for (const [objectives, summary, expectObjectives, expectSummary] of combinations) {
      await page.click('[data-step="0"]');
      const objectiveBox = page.locator('#includeObjectives');
      const summaryBox = page.locator('#includeSummary');
      if ((await objectiveBox.isChecked()) !== objectives) await objectiveBox.click();
      if ((await summaryBox.isChecked()) !== summary) await summaryBox.click();
      await page.click('[data-step="5"]');
      assert.equal(await page.locator('#finalDocument h3').filter({ hasText: 'Meeting objectives' }).count() > 0, expectObjectives);
      assert.equal(await page.locator('#finalDocument h3').filter({ hasText: 'Executive summary' }).count() > 0, expectSummary);
    }

    // Turning both off leaves an explanation rather than an empty screen.
    await page.click('[data-step="0"]');
    await page.uncheck('#includeObjectives');
    await page.click('[data-step="4"]');
    assert.equal(await page.locator('#summaryAllExcluded').isHidden(), false);

    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    server.close();
  }
});

test('a typing burst is one undo step, and a second field starts another', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'editor');
    browser = launched.browser;
    const { page, errors } = launched;

    const historyCount = async () => page.evaluate(async () =>
      (await (await fetch('/test-state/editor')).json()).undoLabels.length);
    const before = await historyCount();

    // A continuous edit to one field: several autosaves, one step.
    const field = page.locator('#actionsBody [data-action-row="0"] [data-action]');
    await field.click();
    for (const word of ['Send ', 'the ', 'revised ', 'report ', 'today.']) {
      await page.keyboard.type(word, { delay: 15 });
      await page.waitForTimeout(120);
    }
    await page.waitForTimeout(900);
    const afterFirst = await historyCount();
    assert.equal(afterFirst - before, 1, 'one burst is one step, not one per autosave');
    assert.match(await page.textContent('#undoLastDecision'), /Undo: edit action/i);

    // Moving to a different field starts a new step.
    await page.click('#actionsBody [data-action-row="0"] [data-edit-timing]');
    await page.click('#actionsBody [data-action-row="0"] [data-timing-date]');
    await page.fill('#actionsBody [data-action-row="0"] [data-timing-date]', '2026-10-01');
    await page.waitForTimeout(900);
    assert.equal(await historyCount() - afterFirst, 1, 'another field is another step');
    assert.match(await page.textContent('#undoLastDecision'), /Undo: change timing/i);

    // Undo puts the date back and offers a redo.
    await page.click('#undoLastDecision');
    await page.waitForTimeout(900);
    assert.equal(await page.inputValue('#actionsBody [data-action-row="0"] [data-timing-date]'), '');
    assert.equal(await page.locator('#redoLastDecision').isHidden(), false);
    assert.match(await page.textContent('#redoLastDecision'), /Redo: change timing/i);

    // Redo reapplies it.
    await page.click('#redoLastDecision');
    await page.waitForTimeout(900);
    assert.equal(await page.inputValue('#actionsBody [data-action-row="0"] [data-timing-date]'), '2026-10-01');

    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    server.close();
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
    assert.match(await page.textContent('#actionsBody'), /final quality checks continue/i);
    assert.equal(await page.locator('#actionsBody textarea').count(), 0, 'preview remains read-only');
    assert.equal(await page.locator('#generationProgress').isVisible(), true);
    assert.match(await page.textContent('#generationPhases'), /Find possible actions.*Finish the draft/s);
    assert.equal(await page.locator('.generation-phase.done').count(), 3);
    assert.equal(await page.locator('.generation-phase.active').count(), 1);
    for (const selector of ['#addAction', '#applyActionsEdit', '#auditActions', '#toSummary']) {
      const control = page.locator(selector);
      assert.equal((await control.isHidden()) || (await control.isDisabled()), true, `${selector} is unavailable while actions run`);
    }
    assert.equal(await page.locator('#addDiscussion').isDisabled(), false, 'safe Discussion additions remain available');
    assert.match(await page.textContent('#saveStatus'), /Everything is saved.*leave and resume later/i);
    assert.doesNotMatch(await page.textContent('#saveStatus'), /Unsaved changes/i);
    assert.match(await page.textContent('#actionsBody'), /Previously saved actions/i);
    assert.match(await page.textContent('#actionsBody'), /Send the revised report/i);

    await page.waitForFunction(() => document.getElementById('workflowStatus').dataset.stage === 'actions');
    assert.equal(await page.locator('#workflowStatus').isHidden(), true, 'the progress panel replaces duplicate stage status');
    await page.click('[data-step="2"]');
    assert.equal(await page.locator('#workflowStatus').isHidden(), true);
    assert.equal(await page.locator('#generationProgress').isVisible(), true, 'generation progress remains visible across stages');
    assert.equal(await page.locator('#viewGeneratedStage').isVisible(), true);

    await page.click('[data-step="0"]');
    await page.fill('#meetingTitle', 'Edited while actions run');
    assert.match(await page.textContent('#saveStatus'), /Saving draft.*Keep this tab open/i);
    // The generation panel used to repeat this sentence; the save strip is now
    // the only place that says whether the tab is safe to close.
    assert.equal(await page.locator('#generationLeaveMessage').count(), 0);
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

// Renamed with the Focus step: the adoption it protects still happens, it just
// happens on the way out of Details now.
test('a prepared Discussion is adopted automatically after Details', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'discussion-ready');
    browser = launched.browser;
    const { page, errors } = launched;
    await page.waitForFunction(async () => {
      const state = await (await fetch('/test-state/discussion-ready')).json();
      return state.draft.generation && state.draft.generation.stage === 'discussion';
    });
    assert.equal(await page.locator('[data-screen="2"]').evaluate((node) => node.classList.contains('active')), true);
    // Neither the progress title nor the panel is asserted: with Focus gone the
    // reviewer lands here immediately, so which stage is mid-flight is a race.
    // The adoption itself is what this test is for, and the wait above plus the
    // active screen prove it happened.
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('opening an empty Summary starts generation without requiring speculation', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'summary-empty');
    browser = launched.browser;
    const { page, errors } = launched;
    await page.waitForFunction(async () => {
      const state = await (await fetch('/test-state/summary-empty')).json();
      return state.draft.generation && state.draft.generation.stage === 'summary';
    });
    assert.equal(await page.locator('[data-screen="4"]').evaluate((node) => node.classList.contains('active')), true);
    assert.match(await page.textContent('#generationProgressTitle'), /Preparing summary…/i);
    assert.equal(await page.locator('#summaryFields').isHidden(), true);
    assert.equal(await page.locator('#generateSummary').isHidden(), true);
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
    await page.click('#confirmRegeneration');
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

    await cards.last().locator('.record-add-menu>summary').click();
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
    await cards.first().locator('.record-menu>summary').click();
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
    await page.click('#discussionList .discussion-card:nth-child(2) .topic-menu>summary');
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
    await page.click('#actionsBody .record-menu>summary');
    await page.click('#actionsBody [data-delete-action]');
    assert.equal(await page.locator('#actionsBody [data-action-row]').count(), 0);
    const navigationSave = page.waitForResponse((response) => response.url().endsWith('/api/meeting-minutes-agent/drafts/editor')
      && response.request().method() === 'PATCH' && response.request().postDataJSON().selectedStep === 2);
    await page.click('[data-step="2"]');
    await actionDeleteSave;
    await navigationSave;

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
    await page.click('#discussionList .record-menu>summary');
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

test('unfinished owner text survives a background completion', { timeout: 120000 }, async () => {
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
    // The Focus step used to sit here, and this test stepped through it to check
    // the details prompt cleared. With Focus retired the only way forward is to
    // generate, which is a different subject; what this test protects is the
    // unfinished owner text below surviving a background completion.

    const completionResponse = page.waitForResponse((response) =>
      response.url().endsWith('/api/meeting-minutes-agent/drafts/summary-running/generation'));
    await page.goto(`http://127.0.0.1:${port}/meeting-minutes-agent?draftId=summary-running`);
    await page.waitForFunction(() => document.querySelector('#actionsBody tr'));
    assert.equal(await page.locator('[data-screen="3"]').evaluate((node) => node.classList.contains('active')), true);
    await page.click('#actionsBody [data-action-row="0"] [data-edit-owners]');
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
    await page.click('#discussionList .discussion-card:nth-child(2) .topic-menu>summary');
    await page.click('[data-delete-topic="1"]');
    assert.equal(await page.locator('#discussionList [data-delete-topic]').count(), 1);
    assert.equal(await page.locator('#staleNotice').isHidden(), true, 'deleting a topic that never had text is not a material edit');
    // Deleting a topic that carries real content still is.
    page.once('dialog', (dialog) => dialog.accept());
    await page.click('#discussionList .discussion-card:first-child .topic-menu>summary');
    await page.click('[data-delete-topic="0"]');
    assert.equal(await page.locator('#staleNotice').isVisible(), true);
    assert.match(await page.textContent('#staleStages'), /actions/i);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('suggested changes are compact until the reviewer asks for detail', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'proposals');
    browser = launched.browser;
    const { page, errors } = launched;
    if (!await page.locator('#reviewFlags').evaluate((node) => node.open)) await page.click('#reviewFlags>summary');
    assert.equal(await page.locator('.proposal-detail').isVisible(), true);
    assert.equal(await page.locator('.proposal-content').isHidden(), true);
    assert.match(await page.textContent('.proposal-summary'), /Confirm access to the audit folder/i);
    assert.match(await page.textContent('#proposalSelectionCount'), /1 of 1 selected/i);
    assert.match(await page.textContent('#acceptSelectedProposal'), /Apply 1 change/i);
    assert.match(await page.textContent('#proposalPanel'), /Unchecked suggestions stay/i);
    await page.click('.proposal-detail>summary');
    assert.equal(await page.locator('.proposal-content').isVisible(), true);
    await page.uncheck('[data-proposal-change]');
    assert.equal(await page.locator('#acceptSelectedProposal').isDisabled(), true);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a missing-content warning opens and highlights its exact pending suggestion', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'proposals');
    browser = launched.browser;
    const { page, errors } = launched;
    if (!await page.locator('#reviewFlags').evaluate((node) => node.open)) await page.click('#reviewFlags>summary');
    const warning = page.locator('.flag').filter({ hasText: 'Possible missed action: Confirm access to the audit folder.' });
    assert.match(await warning.textContent(), /Related suggestion/i);
    assert.equal(await warning.locator('text=No saved item or pending suggestion matches').count(), 0);
    await warning.locator('[data-view-flag-target]').click();
    const suggestion = page.locator('#minutes-proposal-proposal-1');
    await suggestion.waitFor();
    assert.equal(await suggestion.locator('.proposal-detail').evaluate((node) => node.open), true);
    assert.equal(await suggestion.locator('.proposal-detail>summary').evaluate((node) => node === document.activeElement), true);
    assert.equal(await suggestion.evaluate((node) => node.classList.contains('flag-target-highlight')), true);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('applying one proposal preserves the unchecked proposal and warning after refresh', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'partial-proposals');
    browser = launched.browser;
    const { page, errors } = launched;
    if (!await page.locator('#reviewFlags').evaluate((node) => node.open)) await page.click('#reviewFlags>summary');
    const boxes = page.locator('[data-proposal-change]');
    await boxes.nth(1).uncheck();
    const applied = page.waitForResponse((response) => response.url().endsWith('/api/meeting-minutes-agent/drafts/partial-proposals/proposal'));
    await page.click('#acceptSelectedProposal');
    await applied;
    assert.equal(await page.locator('[data-proposal-change]').count(), 1);
    assert.equal(await page.locator('[data-proposal-change]').isChecked(), false);
    assert.match(await page.textContent('.proposal-summary'), /Circulate the audit checklist/i);
    let saved = await page.evaluate(async () => (await (await fetch('/test-state/partial-proposals')).json()).draft);
    assert.deepEqual(saved.pendingProposal.changes.map((change) => change.id), ['partial-2']);
    assert.equal(saved.reviewFlags.find((flag) => flag.id === 'proposal-review-partial-1').status, 'confirmed');
    assert.equal(saved.reviewFlags.find((flag) => flag.id === 'proposal-review-partial-2').status, 'open');

    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('[data-proposal-change]').length === 1);
    assert.equal(await page.locator('[data-proposal-change]').isChecked(), false, 'unchecked state survives refresh');
    assert.match(await page.textContent('.proposal-summary'), /Circulate the audit checklist/i);
    saved = await page.evaluate(async () => (await (await fetch('/test-state/partial-proposals')).json()).draft);
    assert.equal(saved.pendingProposal.changes[0].id, 'partial-2');
    assert.equal(saved.reviewFlags.find((flag) => flag.id === 'proposal-review-partial-2').status, 'open');
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('an unlinked timing warning routes to its Action field and resolves when that Action is deleted', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'unlinked-warning');
    browser = launched.browser;
    const { page, errors } = launched;
    await page.click('#reviewFlags>summary');
    assert.match(await page.textContent('.flag-target'), /Complete and sign the training attestation/i);
    await page.click('[data-view-flag-target]');
    await page.waitForFunction(() => document.querySelector('[data-screen="3"]').classList.contains('active'));
    // The original-wording field is hidden on the Actions table now, and a
    // hidden field cannot take focus, so a timing warning routes to the
    // interpreted date instead - the visible control the warning is about.
    assert.equal(await page.locator('#minutes-action-training-action [data-timing-date]').evaluate((node) => node === document.activeElement), true);

    const savedResponse = page.waitForResponse((response) => response.url().endsWith('/api/meeting-minutes-agent/drafts/unlinked-warning')
      && response.request().method() === 'PATCH');
    await page.click('#minutes-action-training-action .record-menu>summary');
    await page.click('#minutes-action-training-action [data-delete-action]');
    await savedResponse;
    const saved = await page.evaluate(async () => (await (await fetch('/test-state/unlinked-warning')).json()).draft);
    assert.equal(saved.reviewFlags.find((flag) => flag.id === 'training-timing-flag').status, 'dismissed');
    assert.equal(await page.locator('#reviewFlags').isHidden(), true);
    await page.reload();
    await page.waitForFunction(() => document.querySelector('[data-screen="3"]').classList.contains('active'));
    assert.equal(await page.locator('#reviewFlags').isHidden(), true, 'the deleted Action warning stays resolved after refresh');
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('every warning decision exposes a durable Undo that survives refresh', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'editor');
    browser = launched.browser;
    const { page, errors } = launched;
    if (!await page.locator('#reviewFlags').evaluate((node) => node.open)) await page.click('#reviewFlags>summary');
    const warning = page.locator('.flag').filter({ hasText: 'Check the owner of this action.' });
    const saved = page.waitForResponse((response) => response.url().endsWith('/api/meeting-minutes-agent/drafts/editor')
      && response.request().method() === 'PATCH' && response.request().postDataJSON().reviewDecisionLabel === 'Warning confirmed');
    await warning.getByRole('button', { name: 'Mark as checked' }).click();
    await saved;
    assert.equal(await page.locator('#undoToast').isVisible(), true);
    assert.match(await page.textContent('#undoToastMessage'), /Warning confirmed/i);
    assert.equal(await page.locator('#undoLastDecision').isVisible(), true);

    await page.reload();
    await page.waitForFunction(() => !document.querySelector('#undoLastDecision').hidden);
    const undone = page.waitForResponse((response) => response.url().endsWith('/api/meeting-minutes-agent/drafts/editor/undo'));
    await page.click('#undoLastDecision');
    await undone;
    const restored = await page.evaluate(async () => (await (await fetch('/test-state/editor')).json()).draft);
    assert.equal(restored.reviewFlags.find((flag) => flag.id === 'flag-action').status, 'open');
    assert.match(await page.textContent('#workflowStatus'), /undone/i);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('final minutes edit source records in place and the finishing bar remains available', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'layout');
    browser = launched.browser;
    const { page, errors } = launched;
    assert.equal(await page.locator('#saveStrip').evaluate((node) => getComputedStyle(node).position), 'fixed');
    assert.match(await page.textContent('#flagCount'), /2 warnings/i);
    await page.click('#previewDocument');
    await page.waitForFunction(() => document.querySelector('[data-screen="5"]').classList.contains('active'));
    assert.match(await page.getAttribute('#previewDocument', 'aria-label'), /Back to editing/i);
    assert.equal(await page.locator('#finalDocument [data-kind="details"][data-field="meetingDate"]').textContent(), '16 Sept 2026');
    assert.equal(await page.locator('#finalDocument .final-propositions').first().evaluate((node) => getComputedStyle(node).listStyleType), 'disc');
    assert.equal(await page.locator('#finalDocument .final-kind-label').filter({ hasText: 'Discussion' }).count(), 0);

    await page.locator('#finalDocument [data-kind="discussion"][data-field="text"]').first().click();
    await page.fill('#finalDocument [data-final-editor-value]', 'The final report is ready to circulate.');
    let saved = page.waitForResponse((response) => response.url().endsWith('/api/meeting-minutes-agent/drafts/layout')
      && response.request().method() === 'PATCH' && response.request().postDataJSON().reviewDecisionLabel === 'Meeting sentence edited');
    await page.click('#finalDocument [data-final-save]');
    await saved;

    await page.locator('#finalDocument [data-kind="action"][data-field="owners"]').first().click();
    await page.fill('#finalDocument [data-final-editor-value]', 'Alex Reed, Sam Okoro');
    saved = page.waitForResponse((response) => response.url().endsWith('/api/meeting-minutes-agent/drafts/layout')
      && response.request().method() === 'PATCH' && response.request().postDataJSON().reviewDecisionLabel === 'Action owners edited');
    await page.click('#finalDocument [data-final-save]');
    await saved;

    await page.locator('#finalDocument [data-kind="action"][data-field="timing"]').first().click();
    await page.selectOption('#finalDocument [data-final-timing-kind]', 'deadline');
    await page.fill('#finalDocument [data-final-timing-wording]', 'by Friday');
    await page.fill('#finalDocument [data-final-timing-date]', '2026-09-18');
    saved = page.waitForResponse((response) => response.url().endsWith('/api/meeting-minutes-agent/drafts/layout')
      && response.request().method() === 'PATCH' && response.request().postDataJSON().reviewDecisionLabel === 'Action timing edited');
    await page.click('#finalDocument [data-final-save]');
    await saved;

    let stored = await page.evaluate(async () => (await (await fetch('/test-state/layout')).json()).draft);
    assert.equal(stored.discussion[0].points[0].text, 'The final report is ready to circulate.');
    assert.deepEqual(stored.actions[0].owners, ['Alex Reed', 'Sam Okoro']);
    assert.deepEqual(stored.actions[0].timing, { kind: 'deadline', wording: 'by Friday', exactDate: '2026-09-18' });

    await page.reload();
    await page.waitForFunction(() => document.querySelector('[data-screen="5"]').classList.contains('active'));
    assert.match(await page.textContent('#finalDocument'), /The final report is ready to circulate/i);
    assert.match(await page.textContent('#finalDocument'), /Alex Reed, Sam Okoro/i);
    assert.match(await page.textContent('#finalDocument'), /18 Sept 2026/i);
    const undone = page.waitForResponse((response) => response.url().endsWith('/api/meeting-minutes-agent/drafts/layout/undo'));
    await page.click('#undoLastDecision');
    await undone;
    stored = await page.evaluate(async () => (await (await fetch('/test-state/layout')).json()).draft);
    assert.equal(stored.actions[0].timing.kind, 'not_stated');
    assert.deepEqual(stored.actions[0].owners, ['Alex Reed', 'Sam Okoro'], 'Undo restores only the latest review decision');

    await page.click('#previewDocument');
    await page.waitForFunction(() => document.querySelector('[data-screen="4"]').classList.contains('active'));
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('save and generation panels always show the same leave-safety state', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'editor');
    browser = launched.browser;
    const { page, errors } = launched;
    await page.click('[data-step="2"]');
    await page.click('#addDiscussion');
    await page.click('#discussionList .discussion-card:nth-child(2) .topic-menu>summary');
    await page.click('[data-delete-topic="1"]');
    const messages = await page.evaluate(() => ({
      save: document.getElementById('saveStatus').textContent,
      generation: document.getElementById('generationLeaveMessage')
    }));
    assert.match(messages.save, /Keep this tab open/i);
    // One message, in one place: there is nothing left that could disagree.
    assert.equal(messages.generation, null);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('dense layouts give writing space to content rather than repeated controls', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'layout');
    browser = launched.browser;
    const { page, errors } = launched;
    const objectiveLayout = await page.evaluate(() => {
      const list = document.getElementById('objectivesList').getBoundingClientRect();
      const editor = document.querySelector('[data-objective-index]').getBoundingClientRect();
      return { listWidth: list.width, editorWidth: editor.width, editorHeight: editor.height };
    });
    assert.ok(objectiveLayout.editorWidth > objectiveLayout.listWidth * 0.8, JSON.stringify(objectiveLayout));
    assert.ok(objectiveLayout.editorHeight < 80, JSON.stringify(objectiveLayout));

    await page.click('[data-step="3"]');
    const actionLayout = await page.evaluate(() => {
      const headers = Array.from(document.querySelectorAll('.editable-actions-table th')).map((node) => node.getBoundingClientRect().width);
      const row = document.querySelector('[data-action-row="0"]');
      return {
        headers,
        timingType: row.querySelector('[data-timing-kind]') && row.querySelector('[data-timing-kind]').value,
        directOwnerControl: Boolean(row.querySelector('[data-edit-owners]')),
        directTimingControl: Boolean(row.querySelector('[data-edit-timing]'))
      };
    });
    assert.ok(actionLayout.headers[0] > actionLayout.headers[1] * 3, JSON.stringify(actionLayout));
    assert.equal(actionLayout.headers.length, 3, JSON.stringify(actionLayout));
    assert.equal(actionLayout.timingType, null);
    assert.equal(actionLayout.directOwnerControl, true);
    assert.equal(actionLayout.directTimingControl, true);
    assert.equal(await page.locator('[data-screen="3"] .toolbar .agent-edit-inline').count(), 1);
    await page.click('[data-screen="3"] .agent-edit-inline>summary');
    assert.equal(await page.locator('[data-screen="3"] .agent-edit-body').isVisible(), true);
    await page.click('[data-screen="3"] .agent-edit-inline>summary');

    await page.click('[data-step="2"]');
    assert.equal(await page.locator('.discussion-card .card-head .record-add-menu').count(), 1);
    const propHeight = await page.locator('.proposition-row').first().evaluate((node) => node.getBoundingClientRect().height);
    // The reorder handle floats in the gutter precisely so it does not push
    // this back over the line.
    assert.ok(propHeight < 60, 'proposition row height ' + propHeight);
    assert.ok(await page.locator('.review-flags-summary').evaluate((node) => node.getBoundingClientRect().width < 260));
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('phone layout reaches the work quickly and keeps editing controls compact', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${port}/meeting-minutes-agent?draftId=layout`);
    await page.waitForSelector('#discussionList .discussion-card', { state: 'attached' });

    assert.equal(await page.locator('.hero').isHidden(), true);
    assert.equal(await page.locator('.steps').isHidden(), true);
    assert.equal(await page.locator('.mobile-step-picker').isVisible(), true);
    // Five steps now that Focus is retired: details 1, discussion 2, actions 3,
    // summary 4, review 5. This fixture opens on Summary.
    assert.equal(await page.locator('#mobileStepCount').textContent(), 'Step 4 of 5');
    assert.ok(await page.locator('.nav a').first().evaluate((node) => node.getBoundingClientRect().height >= 40));
    await page.click('.review-flags-summary');
    assert.ok(await page.locator('.review-flags-body').evaluate((node) => node.getBoundingClientRect().width > 330));
    await page.click('.review-flags-summary');

    await page.selectOption('#mobileStepSelect', '2');
    const discussionLayout = await page.evaluate(() => {
      const topic = document.querySelector('.topic-field textarea');
      const card = topic.closest('.discussion-card');
      const kind = card.querySelector('.proposition-kind');
      const text = card.querySelector('[data-record-field]');
      return {
        titleVisible: topic.scrollHeight <= topic.clientHeight + 1,
        titleWidth: topic.getBoundingClientRect().width,
        cardWidth: card.getBoundingClientRect().width,
        kindAboveText: kind.getBoundingClientRect().bottom <= text.getBoundingClientRect().top + 1
      };
    });
    assert.equal(discussionLayout.titleVisible, true, JSON.stringify(discussionLayout));
    assert.ok(discussionLayout.titleWidth > discussionLayout.cardWidth * 0.8, JSON.stringify(discussionLayout));
    assert.equal(discussionLayout.kindAboveText, true, JSON.stringify(discussionLayout));

    await page.selectOption('#mobileStepSelect', '3');
    const actionLayout = await page.evaluate(() => {
      const row = document.querySelector('[data-action-row="0"]');
      const owners = row.querySelector('[data-label="Owners"]').getBoundingClientRect();
      const timing = row.querySelector('[data-label="Timing"]').getBoundingClientRect();
      return { height: row.getBoundingClientRect().height, metaAligned: Math.abs(owners.top - timing.top) < 4 };
    });
    assert.ok(actionLayout.height < 180, JSON.stringify(actionLayout));
    assert.equal(actionLayout.metaAligned, true, JSON.stringify(actionLayout));
    assert.match(await page.textContent('#auditActions'), /Check transcript for more actions/i);

    await page.selectOption('#mobileStepSelect', '4');
    assert.match(await page.textContent('#generateSummary'), /Regenerate summary/i);
    assert.ok(await page.locator('#executiveSummary').evaluate((node) => node.getBoundingClientRect().height < 150));

    await page.selectOption('#mobileStepSelect', '5');
    assert.equal(await page.locator('.final-actions>.secondary, .final-actions>.button, .final-actions>.export-menu').count(), 3);
    assert.equal(await page.locator('.export-menu-body').isHidden(), true);
    await page.click('.export-menu>summary');
    assert.equal(await page.locator('.export-menu-body').isVisible(), true);
    assert.match(await page.textContent('#saveMinutes'), /Save final minutes/i);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('step navigation wins over an in-flight autosave scroll restore', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${port}/meeting-minutes-agent?draftId=navigation`);
    await page.waitForSelector('[data-screen="3"].active [data-action-row]');

    const saveRequest = page.waitForRequest((request) => request.method() === 'PATCH' && request.url().endsWith('/drafts/navigation'));
    const saveResponse = page.waitForResponse((response) => response.request().method() === 'PATCH' && response.url().endsWith('/drafts/navigation'));
    await page.fill('[data-action-row="0"] [data-action]', 'Complete the first preparation task and circulate the confirmed outcome.');
    await saveRequest;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.click('[data-screen="3"] [data-back="2"]');
    await saveResponse;
    await page.waitForFunction(() => document.querySelector('[data-screen="2"]').classList.contains('active'));
    await page.waitForTimeout(100);

    const position = await page.evaluate(() => {
      const screen = document.querySelector('[data-screen="2"]');
      return {
        top: Math.round(screen.getBoundingClientRect().top),
        scrollY: Math.round(window.scrollY),
        maxScroll: Math.round(document.documentElement.scrollHeight - window.innerHeight),
        activeInsideScreen: screen.contains(document.activeElement),
        activeTag: document.activeElement.tagName
      };
    });
    assert.ok(position.top <= 16 || Math.abs(position.scrollY - position.maxScroll) <= 2, JSON.stringify(position));
    assert.equal(position.activeInsideScreen, true, JSON.stringify(position));
    assert.equal(position.activeTag, 'H2');
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
