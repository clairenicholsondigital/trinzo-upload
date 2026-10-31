'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { chromium } = require('playwright');
const MinutesResultNormalization = require('../utils/meetingMinutesResultNormalization');
const { rehomeSupportingDetails, unitIndex } = require('../utils/canonicalMinutes/discussionOrganiser');
const { collectUnassignedSupportingDetails } = require('../utils/meetingMinutesSupportingDetails');

const ROOT = path.resolve(__dirname, '..');
const LONG_DETAIL = 'Review <img id="unsafe-detail" src=x onerror="window.unsafe=true"> & "context". '
  + 'Keep every useful qualification and its source. '.repeat(48) + ' END_UNASSIGNED_DETAIL';

function record(id, text) {
  return { id, text, evidenceIds: ['T0001'], supportingDetails: [] };
}

function draft() {
  return {
    draftId: 'filing', revision: 3, updatedAt: '2026-09-16T12:00:00.000Z',
    currentStep: 5, selectedStep: 2, title: 'Filing review', steer: '', denoise: {},
    details: { meetingTitle: 'Filing review', meetingDate: '2026-09-16', meetingLocation: 'Teams',
      meetingType: 'Review', internalAttendees: ['Morgan Lee'], clientAttendees: [], allAttendees: ['Morgan Lee'] },
    discussion: [
      { id: 'topic-1', topic: 'First topic', points: [record('point-1', 'The first discussion item.')], decisions: [], openQuestions: [] },
      { id: 'topic-2', topic: 'Second <topic> & context', points: [record('point-2', 'The second discussion item.')],
        decisions: [record('decision-1', 'The board approved the review.')],
        openQuestions: [record('question-1', 'Which option should be reviewed?')] }
    ],
    unassignedSupportingDetails: [{
      id: 'unfiled-1', text: LONG_DETAIL, evidenceIds: ['T0002'], reviewFlagIds: ['review-1'],
      originalTopic: 'Former <topic>', placementStatus: 'uncertain', placementReason: 'INTERNAL_PLACEMENT_DIAGNOSTIC'
    }],
    sourceUnits: [
      { id: 'T0001', speaker: 'Morgan Lee', text: 'The first item was discussed.' },
      { id: 'T0002', speaker: 'Morgan Lee', text: 'SOURCE <script>not executable</script> & original full context.' }
    ],
    actions: [], executiveSummary: '', meetingObjectives: [], reviewFlags: [],
    generation: null, pendingProposal: null, staleStages: [],
    includeSections: { meetingObjectives: false, executiveSummary: false, topicHeadings: true }
  };
}

async function fixture(initial = draft()) {
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  let saved = structuredClone(initial);
  const patches = [];
  app.get('/meeting-minutes-agent', (_req, res) => res.type('html').send(fs.readFileSync(path.join(ROOT, 'views/meeting-minutes-agent.html'), 'utf8')));
  app.get('/static/meeting-minutes-filing-order.js', (_req, res) => res.type('application/javascript').send(fs.readFileSync(path.join(ROOT, 'public/meeting-minutes-filing-order.js'), 'utf8')));
  app.get('/static/meeting-minutes-agent.js', (_req, res) => res.type('application/javascript').send(fs.readFileSync(path.join(ROOT, 'public/meeting-minutes-agent.js'), 'utf8')));
  app.get('/static/meeting-minutes-timing.js', (_req, res) => res.type('application/javascript').send(fs.readFileSync(path.join(ROOT, 'utils/meetingMinutesTiming.js'), 'utf8')));
  app.get('/static/trinzo.js', (_req, res) => res.type('application/javascript').send(''));
  app.get('/static/trinzo-fonts.css', (_req, res) => res.type('text/css').send(''));
  app.get('/api/meeting-minutes-agent/drafts/filing', (_req, res) => res.json({ ok: true, draft: saved }));
  app.get('/api/meeting-minutes-agent/drafts/filing/generation', (_req, res) => res.json({ ok: true, generation: null, draft: saved }));
  app.patch('/api/meeting-minutes-agent/drafts/filing', (req, res) => {
    patches.push(structuredClone(req.body));
    if (req.body.revision !== saved.revision) return res.status(409).json({
      ok: false, error: 'Updated in background', currentDraft: saved
    });
    // Exercise the production editor-save normalizer: a spread-only mock can
    // hide truncation when retained context becomes a main discussion point.
    const normalized = MinutesResultNormalization.normaliseAgentResult({ ...saved, ...req.body }, saved.sourceUnits, '', {
      enforceEvidence: false, dedupeActions: false, mergeTopics: false, preserveReviewerEdits: true
    });
    saved = { ...saved, ...req.body, discussion: normalized.discussion,
      revision: saved.revision + 1, updatedAt: new Date().toISOString() };
    res.json({ ok: true, draft: saved });
  });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.setDefaultTimeout(15000);
  await page.goto('http://127.0.0.1:' + server.address().port + '/meeting-minutes-agent?draftId=filing');
  await page.waitForFunction(() => document.querySelector('#saveStatus').dataset.state === 'saved');
  return {
    page, errors, patches, saved: () => saved,
    mutate: (change) => { saved = change(structuredClone(saved)); },
    async close() { await browser.close(); await new Promise((resolve) => server.close(resolve)); }
  };
}

async function settled(page) {
  await page.waitForFunction(() => document.querySelector('#saveStatus').dataset.state === 'saved');
}

async function openPool(page) {
  await page.click('#omittedDetailsPanel > summary');
  return page.locator('[data-unassigned-supporting-row="0"]');
}

test('filing, promotion and demotion retain complete context and merge history through real save normalization', { timeout: 90000 }, async () => {
  const initial = draft();
  const history = ['earlier-context', 'T9999', 'stage_2_human_confirmation'];
  initial.unassignedSupportingDetails[0].mergedFromIds = history;
  // Start with generated context attached to an unrelated parent, then exercise
  // the real organiser-to-review-pool handoff before any browser interaction.
  initial.discussion[0].points[0].supportingDetails = initial.unassignedSupportingDetails;
  initial.unassignedSupportingDetails = [];
  rehomeSupportingDetails(initial.discussion, unitIndex(initial.sourceUnits), {
    onUnassignedSupportingDetail(detail, context) {
      initial.unassignedSupportingDetails.push(...collectUnassignedSupportingDetails(detail, context));
      return true;
    }
  });
  assert.equal(initial.discussion[0].points[0].supportingDetails.length, 0);
  assert.equal(initial.unassignedSupportingDetails.length, 1);
  assert.deepEqual(initial.unassignedSupportingDetails[0].mergedFromIds, history);
  const warning = { id: 'review-1', kind: 'uncertain_fact', stage: 'discussion', status: 'open',
    message: 'Check the qualification against the source.', evidenceIds: ['T0002'] };
  initial.reviewFlags = [warning];
  const f = await fixture(initial);
  function assertRetainedRecord() {
    const saved = f.saved();
    const rows = saved.discussion.flatMap((topic) => ['points', 'decisions', 'openQuestions']
      .flatMap((field) => topic[field].flatMap((item) => [item, ...(item.supportingDetails || [])])))
      .concat(saved.unassignedSupportingDetails);
    const matches = rows.filter((item) => item.id === 'unfiled-1');
    assert.equal(matches.length, 1, 'the same retained record occurs exactly once');
    assert.equal(matches[0].text, LONG_DETAIL);
    assert.deepEqual(matches[0].evidenceIds, ['T0002']);
    assert.deepEqual(matches[0].reviewFlagIds, ['review-1']);
    assert.deepEqual(matches[0].mergedFromIds, history);
    assert.equal(matches[0].reviewerAuthored, true);
    assert.deepEqual(saved.reviewFlags, [warning], 'conversions keep the original source warning open');
  }
  try {
    const { page } = f;
    let row = await openPool(page);
    assert.equal(await row.locator('.omitted-detail-copy > p:first-child').textContent(), LONG_DETAIL);
    assert.equal(await row.locator('.review-notice [data-retained-warning-message]').textContent(), warning.message);
    assert.equal(await row.locator('.review-notice').evaluate(node => node.open), false);
    assert.equal(await page.locator('#unsafe-detail').count(), 0);
    assert.equal(await page.evaluate(() => window.unsafe), undefined);
    assert.equal(await row.locator('[data-supporting-destination]').inputValue(), '');
    assert.equal(await row.locator('[data-file-supporting]').isDisabled(), true);
    assert.equal(await row.locator('[data-promote-supporting]').count(), 0, 'filing is not main-minute promotion');
    assert.doesNotMatch(await page.locator('#omittedDetailsPanel').textContent(), /INTERNAL_PLACEMENT_DIAGNOSTIC|Former <topic>/);
    await row.locator('.evidence-toggle').click();
    assert.match(await row.locator('.evidence-panel').textContent(), /SOURCE <script>not executable<\/script> & original full context/);

    // Choosing a destination alone neither moves text nor writes an edit.
    const patchCount = f.patches.length;
    await row.locator('[data-supporting-destination]').selectOption('1:openQuestions:0');
    assert.equal(await row.locator('[data-file-supporting]').isEnabled(), true);
    await page.waitForTimeout(1050);
    assert.equal(f.patches.length, patchCount);
    assert.equal(f.saved().unassignedSupportingDetails.length, 1);
    assert.match(await row.locator('[data-supporting-destination] option:checked').textContent(), /Second <topic> & context — Which option/);

    const saved = page.waitForResponse((res) => res.request().method() === 'PATCH');
    await row.locator('[data-file-supporting]').click();
    await saved; await settled(page);
    const body = f.patches.at(-1);
    assert.deepEqual(body.unassignedSupportingDetails, []);
    assert.equal(body.discussion[0].points[0].supportingDetails.length, 0, 'never default to first parent');
    const detail = body.discussion[1].openQuestions[0].supportingDetails[0];
    assert.equal(detail.text, LONG_DETAIL);
    assert.deepEqual(detail.evidenceIds, ['T0002']);
    assert.deepEqual(detail.reviewFlagIds, ['review-1']);
    assert.equal(detail.reviewerAuthored, true);
    assert.deepEqual(detail.mergedFromIds, history);
    assertRetainedRecord();
    assert.equal(detail.placementStatus, undefined);
    assert.equal(detail.placementReason, undefined);
    assert.equal(body.staleStages.length, 0, 'filing retained context does not change main minutes');

    await page.reload(); await page.waitForSelector('#omittedDetailsPanel');
    assert.equal(await page.locator('[data-needs-filing]').count(), 0);
    assert.match(await page.locator('#omittedDetailsPanel h3').textContent(), /Second <topic>/);
    assert.doesNotMatch(await page.locator('#omittedDetailsPanel').textContent(), /Placement needs review/);
    assert.equal(await page.locator('#discussionList').textContent().then((s) => s.includes('END_UNASSIGNED_DETAIL')), false);
    await page.click('[data-step="5"]');
    assert.doesNotMatch(await page.locator('#finalDocument').textContent(), /END_UNASSIGNED_DETAIL|Needs filing/);
    await page.click('[data-step="2"]');
    if (!(await page.locator('#omittedDetailsPanel').evaluate((node) => node.open))) await page.click('#omittedDetailsPanel > summary');
    const promotedSave = page.waitForResponse((res) => res.request().method() === 'PATCH');
    await page.click('[data-promote-supporting][data-topic-index="1"][data-parent-field="openQuestions"]');
    await promotedSave; await settled(page);
    assert.equal(f.saved().discussion[1].openQuestions[0].supportingDetails.length, 0);
    assert.equal(f.saved().discussion[1].points.at(-1).text, LONG_DETAIL);
    assert.equal(f.saved().discussion[1].points.at(-1).reviewerAuthored, true);
    assert.deepEqual(f.saved().unassignedSupportingDetails, []);
    assertRetainedRecord();
    await page.reload(); await settled(page);
    assert.equal(await page.locator('[data-record-field="points"][data-topic-index="1"][data-item-index="1"]').inputValue(), LONG_DETAIL);
    assertRetainedRecord();

    const promotedRow = page.locator('[data-record-row][data-row-topic="1"][data-row-field="points"][data-row-index="1"]');
    await promotedRow.locator('.record-menu > summary').click();
    await Promise.all([
      page.waitForResponse((res) => res.request().method() === 'PATCH'),
      promotedRow.locator('[data-demote-record]').click()
    ]);
    await settled(page);
    assert.equal(f.saved().discussion[1].points.length, 1);
    assert.equal(f.saved().discussion[1].decisions[0].supportingDetails[0].id, 'unfiled-1');
    assertRetainedRecord();
    await page.reload(); await settled(page);
    assertRetainedRecord();
    await page.click('#omittedDetailsPanel > summary');
    const demotedRow = page.locator('#minutes-supporting-unfiled-1');
    assert.equal(await demotedRow.locator('.omitted-detail-copy > p:first-child').textContent(), LONG_DETAIL);
    assert.equal(await demotedRow.locator('[data-retained-warning-message]').textContent(), warning.message);
    await demotedRow.locator('.evidence-toggle').click();
    assert.match(await demotedRow.locator('.evidence-panel').textContent(), /SOURCE <script>not executable<\/script> & original full context/);
    assert.equal(await page.locator('#unsafe-detail').count(), 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('promotion and demotion transfer only bounded valid predecessor IDs as record history', { timeout: 90000 }, async () => {
  const predecessors = Array.from({ length: 1000 }, (_, index) => 'predecessor-' + index);
  const exactLimit = 'h'.repeat(220);
  const malformed = [' previous-detail ', 'previous-detail', 'history-record', '', null, 42,
    'bad\u0000id', 'x'.repeat(221), 'T9999', 'stage_2_human_confirmation', exactLimit, ...predecessors];
  const expected = ['previous-detail', 'T9999', 'stage_2_human_confirmation', exactLimit, ...predecessors.slice(0, 989)];
  for (const operation of ['promotion', 'demotion']) {
    const initial = draft();
    initial.unassignedSupportingDetails = [];
    const detail = { id: 'history-record', text: 'Keep the original source qualification.',
      evidenceIds: ['T0002'], reviewFlagIds: ['review-1'], mergedFromIds: malformed, supportingDetails: [] };
    if (operation === 'promotion') initial.discussion[0].points[0].supportingDetails = [detail];
    else initial.discussion[0].points.push(detail);
    const f = await fixture(initial);
    try {
      const { page } = f;
      let button;
      if (operation === 'promotion') {
        await page.click('#omittedDetailsPanel > summary');
        button = page.locator('[data-promote-supporting][data-topic-index="0"][data-parent-field="points"]');
      } else {
        const row = page.locator('[data-record-row][data-row-topic="0"][data-row-index="1"]');
        await row.locator('.record-menu > summary').click();
        button = row.locator('[data-demote-record]');
      }
      await Promise.all([
        page.waitForResponse((res) => res.request().method() === 'PATCH'), button.click()
      ]);
      await settled(page);
      const parent = operation === 'promotion' ? f.patches.at(-1).discussion[0].points[1]
        : f.patches.at(-1).discussion[0].points[0].supportingDetails[0];
      assert.equal(Array.isArray(parent.mergedFromIds), true, operation + ' keeps predecessor history');
      assert.deepEqual(parent.mergedFromIds, expected, operation + ' applies the metadata budget before sending');
      assert.deepEqual(parent.evidenceIds, ['T0002'], 'historical IDs do not become citations');
      assert.deepEqual(parent.reviewFlagIds, ['review-1']);
      assert.equal(parent.reviewerAuthored, true);
      await page.reload(); await settled(page);
      const persisted = operation === 'promotion' ? f.saved().discussion[0].points[1]
        : f.saved().discussion[0].points[0].supportingDetails[0];
      assert.deepEqual(persisted.mergedFromIds, expected);
      assert.deepEqual(persisted.evidenceIds, ['T0002']);
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }
});

test('a pool-only draft remains reviewable and can gain an explicit destination', { timeout: 60000 }, async () => {
  const initial = draft();
  initial.discussion = [];
  const f = await fixture(initial);
  try {
    const { page } = f;
    await openPool(page);
    assert.equal(await page.locator('[data-supporting-destination]').count(), 0);
    assert.equal(await page.locator('[data-file-supporting]').count(), 0);
    assert.match(await page.locator('[data-needs-filing]').textContent(), /Add a discussion point, decision or open question first/);
    assert.equal(await page.locator('[data-needs-filing] .evidence-toggle').count(), 1);
    await page.click('#addDiscussion');
    await page.click('[data-add-record="points"]');
    await page.fill('[data-record-field="points"]', 'A deliberate new filing destination.');
    await page.waitForSelector('[data-supporting-destination]');
    await settled(page);
    assert.equal(await page.locator('[data-supporting-destination]').inputValue(), '', 'new parent still requires deliberate choice');
    assert.equal(f.saved().unassignedSupportingDetails[0].text, LONG_DETAIL);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('unrelated background action adoption preserves the full unfiled pool in the retry save', { timeout: 60000 }, async () => {
  const initial = draft();
  initial.selectedStep = 0;
  const f = await fixture(initial);
  try {
    const { page } = f;
    f.mutate((saved) => ({ ...saved, revision: saved.revision + 1,
      generatedStages: { actions: '2026-09-16T12:05:00Z' },
      actions: [{ id: 'new-action', action: 'Review the report.', owners: [], evidenceIds: [] }]
    }));
    await page.fill('#meetingTitle', 'Edited title during background completion');
    await page.waitForFunction(() => document.querySelector('#saveStatus').dataset.state === 'saved');
    await page.waitForFunction(() => document.querySelector('#meetingTitle').value === 'Edited title during background completion');
    assert.equal(f.saved().unassignedSupportingDetails[0].text, LONG_DETAIL);
    assert.equal(f.saved().actions[0].id, 'new-action');
    assert.equal(f.patches.at(-1).unassignedSupportingDetails[0].text, LONG_DETAIL);
    assert.equal(f.patches.some((p) => p.revision === 4), true, 'retry uses adopted background revision');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a changed server pool causes a real conflict rather than an automatic overwrite', { timeout: 60000 }, async () => {
  const initial = draft();
  initial.discussion = [];
  initial.unassignedSupportingDetails = [];
  // A separate retained detail keeps the initial review panel available to the fixture.
  initial.discussion = [{ id: 'empty-topic', topic: '', points: [], decisions: [], openQuestions: [] }];
  const fInitial = structuredClone(initial);
  fInitial.unassignedSupportingDetails = draft().unassignedSupportingDetails;
  fInitial.selectedStep = 0;
  const f = await fixture(fInitial);
  try {
    // This case uses the current pool as reviewer-held content: a server that
    // removes it must cause a genuine conflict, never an empty-stage overwrite.
    f.mutate((saved) => ({ ...saved, revision: saved.revision + 1,
      unassignedSupportingDetails: [], actions: [{ id: 'new-action', action: 'Review the report.', owners: [] }]
    }));
    await f.page.fill('#meetingTitle', 'Local title retained');
    const conflict = await f.page.evaluate(async () => {
      try { await window.MeetingMinutesAgent.saveForProjectUpdate(); return ''; }
      catch (error) { return error.message; }
    });
    assert.equal(conflict, 'Updated in background');
    await f.page.waitForFunction(() => document.querySelector('#saveStatus').dataset.state === 'error');
    assert.equal(await f.page.locator('#meetingTitle').inputValue(), 'Local title retained');
    assert.equal(f.patches[0].unassignedSupportingDetails[0].text, LONG_DETAIL);
    assert.equal(f.patches.length, 1, 'changed review pool is not silently adopted as background work');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('background discussion adoption includes new pool-only results rather than treating them as empty', { timeout: 60000 }, async () => {
  const initial = draft();
  initial.selectedStep = 0;
  initial.discussion = [];
  initial.unassignedSupportingDetails = [];
  const f = await fixture(initial);
  try {
    f.mutate((saved) => ({ ...saved, revision: saved.revision + 1,
      generatedStages: { discussion: '2026-09-16T12:05:00Z' },
      unassignedSupportingDetails: draft().unassignedSupportingDetails
    }));
    await f.page.fill('#meetingTitle', 'Title preserved with new retained context');
    await settled(f.page);
    assert.equal(f.saved().details.meetingTitle, 'Title preserved with new retained context');
    assert.equal(f.saved().unassignedSupportingDetails[0].text, LONG_DETAIL);
    assert.deepEqual(f.saved().discussion, []);
    assert.equal(f.patches.length, 2, 'one revision conflict is retried after stage adoption');
    assert.equal(f.patches[1].unassignedSupportingDetails[0].text, LONG_DETAIL);
    await f.page.click('[data-step="2"]');
    await f.page.click('#omittedDetailsPanel > summary');
    await f.page.waitForSelector('[data-needs-filing]');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('legacy absence of an empty pool does not block unrelated background completion', { timeout: 60000 }, async () => {
  const initial = draft();
  initial.selectedStep = 0;
  delete initial.unassignedSupportingDetails;
  const f = await fixture(initial);
  try {
    f.mutate((saved) => ({ ...saved, revision: saved.revision + 1,
      unassignedSupportingDetails: [],
      actions: [{ id: 'background-action', action: 'Review the report.', owners: [] }]
    }));
    await f.page.fill('#meetingTitle', 'Legacy draft still saves');
    await settled(f.page);
    assert.equal(f.saved().details.meetingTitle, 'Legacy draft still saves');
    assert.equal(f.saved().actions[0].id, 'background-action');
    assert.deepEqual(f.patches.at(-1).unassignedSupportingDetails, []);
    assert.equal(f.patches.length, 2);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('an existing uncertain placement keeps its parent and shows a plain review notice', { timeout: 60000 }, async () => {
  const initial = draft();
  initial.unassignedSupportingDetails = [];
  initial.discussion[0].points[0].supportingDetails = [{
    id: 'existing-unresolved', text: 'A retained calibration qualification.',
    evidenceIds: ['T0002'], placementStatus: 'unresolved', placementReason: 'INTERNAL_REASON_NOT_FOR_DISPLAY'
  }];
  const f = await fixture(initial);
  try {
    await f.page.click('#omittedDetailsPanel > summary');
    const row = f.page.locator('#minutes-supporting-existing-unresolved');
    assert.match(await row.textContent(), /Placement needs review/);
    assert.doesNotMatch(await row.textContent(), /INTERNAL_REASON_NOT_FOR_DISPLAY/);
    assert.equal(await row.locator('[data-promote-supporting]').count(), 1);
    assert.equal(await f.page.locator('#omittedDetailsPanel h3').textContent(), 'First topic');
    assert.equal(f.saved().discussion[0].points[0].supportingDetails[0].id, 'existing-unresolved');
    assert.equal(f.saved().discussion[1].points[0].supportingDetails.length, 0);
    assert.equal(f.patches.length, 0, 'rendering does not silently refile existing details');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('generated filing archive survives browser filing, promotion, demotion and reload', { timeout: 90000 }, async () => {
  const S = require('../utils/meetingMinutesSupportingDetails');
  const initial = draft();
  const generated = { id: 'generated-one', text: 'The calibration archive contains the revised supplier certificate.',
    evidenceIds: ['T0002'], reviewFlagIds: [], primaryEvidenceIds: ['T0002'],
    discoveryDisposition: 'supporting', supportingDetails: [] };
  const copy = { id: 'generated-two', text: generated.text, evidenceIds: ['T0002'], reviewFlagIds: [] };
  initial.sourceUnits[1].text = generated.text;
  initial.unassignedSupportingDetails = S.mergeUnassignedSupportingDetails(
    S.collectUnassignedSupportingDetails(generated, { originalTopic: 'Equipment', placementReason: 'no_subject_match' }),
    S.collectUnassignedSupportingDetails(copy, { originalTopic: 'Inspection', placementReason: 'no_subject_match' }));
  assert.equal(initial.unassignedSupportingDetails.length, 1);
  const expected = structuredClone(initial.unassignedSupportingDetails[0]);
  const f = await fixture(initial);
  const check = () => {
    const rows = f.saved().discussion.flatMap(t => ['points','decisions','openQuestions']
      .flatMap(k => t[k].flatMap(r => [r,...(r.supportingDetails || [])])))
      .concat(f.saved().unassignedSupportingDetails);
    const retained = rows.filter(r => r.id === expected.id);
    assert.equal(retained.length, 1);
    assert.deepEqual(retained[0].filingOrigins, expected.filingOrigins);
    assert.deepEqual(retained[0].mergedFromIds, expected.mergedFromIds);
    assert.equal(retained[0].text, expected.text);
  };
  try {
    const { page } = f;
    const row = await openPool(page);
    await row.locator('[data-supporting-destination]').selectOption('0:points:0');
    await Promise.all([page.waitForResponse(r => r.request().method() === 'PATCH'), row.locator('[data-file-supporting]').click()]);
    await settled(page);check();
    await page.reload();await settled(page);check();
    await page.click('#omittedDetailsPanel > summary');
    await Promise.all([page.waitForResponse(r => r.request().method() === 'PATCH'),
      page.locator('[data-promote-supporting][data-topic-index="0"][data-parent-field="points"]').click()]);
    await settled(page);check();
    const promoted = page.locator('[data-record-row][data-row-topic="0"][data-row-field="points"][data-row-index="1"]');
    await promoted.locator('.record-menu > summary').click();
    await Promise.all([page.waitForResponse(r => r.request().method() === 'PATCH'), promoted.locator('[data-demote-record]').click()]);
    await settled(page);check();await page.reload();await settled(page);check();
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
