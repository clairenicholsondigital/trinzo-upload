'use strict';
const fs = require('node:fs'), path = require('node:path'), express = require('express');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '../..');
const copy = value => JSON.parse(JSON.stringify(value));
function draft() {
  return {
    draftId: 'review-ui', revision: 1, currentStep: 5, selectedStep: 2,
    details: { meetingTitle: 'Equipment review', meetingDate: '2026-10-23', meetingType: 'General',
      internalAttendees: ['Nora Patel'], clientAttendees: [] },
    sourceUnits: [{ id: 'T0001', sequence: 1, speaker: 'Nora Patel', timestamp: '',
      text: 'The calibration certificate needs checking before circulation.' }],
    discussion: [{ id: 'topic', topic: 'Equipment review', points: [{
      id: 'parent', text: 'The equipment review is complete.', evidenceIds: ['T0001'], reviewFlagIds: [], supportingDetails: [
        { id: 'attached-a', text: 'The calibration certificate needs checking.', evidenceIds: ['T0001'],
          reviewFlagIds: ['attached-warning'], mergedFromIds: ['earlier-attached'], supportingDetails: [] },
        { id: 'attached-b', text: 'The inspection reference needs checking.', evidenceIds: ['T0001'],
          reviewFlagIds: ['attached-warning'], supportingDetails: [] }
      ]
    }], decisions: [], openQuestions: [] }],
    unassignedSupportingDetails: [
      { id: 'unfiled-a', text: 'The retained qualification is available.', evidenceIds: ['T0001'],
        reviewFlagIds: ['pool-warning'], originalTopic: 'Equipment', placementReason: 'no_subject_match', mergedFromIds: ['earlier-unfiled'] },
      { id: 'unfiled-b', text: 'The retained qualification is available.', evidenceIds: ['T0001'],
        reviewFlagIds: ['second-pool-warning'], originalTopic: 'Equipment', placementReason: 'no_subject_match' }
    ],
    actions: [{ id: 'action', occurrenceId: 'action-occurrence-ui', action: 'Circulate the equipment report.', owners: ['Nora Patel'], evidenceIds: ['T0001'],
      timing: { kind: 'not_stated', wording: '', exactDate: '' }, reviewFlagIds: [] }],
    executiveSummary: 'The equipment review is complete.', meetingObjectives: [{ text: 'Review the equipment.', evidenceIds: ['T0001'] }],
    reviewFlags: [
      { id: 'attached-warning', kind: 'timing', status: 'open', correctionNote: '',
        message: 'Check the timing in "The calibration certificate needs checking." against <img id="unsafe-warning" src=x onerror="window.unsafeWarning=true"> & its source.', evidenceIds: ['T0001'] },
      { id: 'pool-warning', kind: 'unclear_reference', status: 'open', correctionNote: '',
        message: 'Check which qualification was retained.', evidenceIds: ['T0001'] },
      { id: 'second-pool-warning', kind: 'uncertain_fact', status: 'open', correctionNote: '',
        message: 'Check the independent retained occurrence.', evidenceIds: ['T0001'] }
    ],
    generation: null, pendingProposal: null, staleStages: [], changeHistory: [], redoHistory: [], denoise: {}, steer: '',
    includeSections: { meetingObjectives: true, executiveSummary: true, topicHeadings: true }
  };
}
async function fixture(initial = draft()) {
  const app = express(); app.use(express.json({ limit: '4mb' }));
  let saved = copy(initial); const patches = [], undo = [], redo = [], errors = [], requests = [];
  const decorate = () => ({ ...copy(saved),
    lastUndo: undo.length ? { id: 'undo-' + undo.length, label: undo.at(-1).label } : null,
    lastRedo: redo.length ? { id: 'redo-' + redo.length, label: redo.at(-1).label } : null });
  app.get('/meeting-minutes-agent', (_req, res) => res.type('html').send(fs.readFileSync(path.join(ROOT, 'views/meeting-minutes-agent.html'), 'utf8')));
  app.get('/static/trinzo.js', (_req, res) => res.type('application/javascript').send(''));
  app.get('/static/meeting-minutes-timing.js', (_req, res) => res.type('application/javascript').send(fs.readFileSync(path.join(ROOT, 'utils/meetingMinutesTiming.js'), 'utf8')));
  app.use('/static', express.static(path.join(ROOT, 'public')));
  app.get('/api/meeting-minutes-agent/drafts/:id', (_req, res) => res.json({ ok: true, draft: decorate() }));
  app.get('/api/meeting-minutes-agent/drafts/:id/generation', (_req, res) => res.json({ ok: true, generation: null }));
  app.patch('/api/meeting-minutes-agent/drafts/:id', (req, res) => {
    if (req.body.revision !== saved.revision) return res.status(409).json({ error: 'Updated in another tab', currentDraft: decorate() });
    patches.push(copy(req.body));
    if (req.body.reviewDecisionLabel) { undo.push({ label: req.body.reviewDecisionLabel, snapshot: copy(saved) }); redo.length = 0; }
    const body = copy(req.body); delete body.reviewDecisionLabel;
    saved = { ...saved, ...body, revision: saved.revision + 1 };
    res.json({ ok: true, draft: decorate() });
  });
  for (const operation of ['undo', 'redo']) app.post('/api/meeting-minutes-agent/drafts/:id/' + operation, (req, res) => {
    if (req.body.revision !== saved.revision) return res.status(409).json({ error: 'Stale revision' });
    const from = operation === 'undo' ? undo : redo, to = operation === 'undo' ? redo : undo;
    const previous = from.pop(); if (!previous) return res.status(409).json({ error: 'No history' });
    to.push({ label: previous.label, snapshot: copy(saved) });
    saved = { ...copy(previous.snapshot), revision: saved.revision + 1 };
    res.json({ ok: true, draft: decorate() });
  });
  app.use((req, res) => { if (req.method !== 'GET') requests.push({ method: req.method, path: req.path }); res.status(404).json({ error: 'Unexpected request' }); });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto('http://127.0.0.1:' + server.address().port + '/meeting-minutes-agent?draftId=' + saved.draftId);
    await page.waitForSelector('#discussionList .discussion-card', { state: 'attached' });
    await page.evaluate(() => document.fonts.ready);
    return { page, patches, errors, requests, saved: () => copy(saved),
      async close() { await browser.close(); await new Promise(resolve => server.close(resolve)); } };
  } catch (error) { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); throw error; }
}
async function settled(page) { await page.waitForFunction(() => document.querySelector('#saveStatus').dataset.state === 'saved'); }
module.exports = { fixture, draft, copy, settled };
