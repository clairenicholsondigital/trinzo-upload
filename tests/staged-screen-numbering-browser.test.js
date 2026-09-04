'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const { chromium } = require('playwright');

// The screen a resume link opens, checked in a browser.
//
// staged-screen-numbering.test.js proves the mapping is right; this proves it is wired to
// the screen the reviewer actually lands on. The bug was never in one function - a screen
// index was read in four places, and the page only walks the reviewer past Discussion if
// one of them still trusts a number written under the old five-screen numbering.
//
// The stages are stubbed with canned payloads on purpose: the real ones need the MiniLM
// runtime, and none of that is what decides which screen opens.

const REPO_ROOT = path.resolve(__dirname, '..');
const PAGE_PATH = path.join(REPO_ROOT, 'views', 'staged-meeting-minutes.html');

const DETAILS = {
  screens: {
    details: {
      meetingTitle: 'Weekly review',
      meetingDate: '2026-09-04',
      meetingLocation: 'Microsoft Teams',
      meetingType: 'Client update',
      participants: ['Alex Reed', 'Sam Okoro'],
      internalAttendees: ['Alex Reed'],
      clientAttendees: ['Sam Okoro']
    }
  }
};
const DISCUSSION = {
  screens: { discussion: [{ topic: 'Release readiness', points: ['The build is cut and awaiting sign-off.'] }] }
};
const ACTIONS = {
  screens: { actions: [{ owner: 'Alex Reed', action: 'Circulate the sign-off checklist.', deadline: 'Not stated' }] }
};

function startStubServer() {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  const stagesRequested = [];
  const jobs = new Map();
  let nextJobId = 0;

  app.get('/staged-meeting-minutes', (req, res) => res.type('html').send(fs.readFileSync(PAGE_PATH, 'utf8')));
  app.post('/api/staged-meeting-minutes/jobs', multer().any(), (req, res) => {
    const stage = String(req.query.stage || 'details');
    const text = String(req.body.text || req.body.storedTranscriptText || '');
    if (!text.trim()) return res.status(400).json({ success: false, error: 'stub received no transcript text' });
    stagesRequested.push(stage);
    const payload = stage === 'discussion' ? DISCUSSION : stage === 'actions' ? ACTIONS : DETAILS;
    const jobId = `screen-job-${nextJobId += 1}`;
    const transcriptSha256 = crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
    jobs.set(jobId, { stage, payload: { ...payload, stagedStage: stage, transcriptSha256 } });
    res.json({ success: true, jobId, transcriptSha256 });
  });
  app.get('/api/jobs/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ success: false, error: 'not found' });
    res.json({
      success: true,
      job: { jobId: req.params.jobId, status: 'completed', inputPayload: { stage: job.stage } },
      result: { result: job.payload }
    });
  });
  app.post('/api/staged-meeting-minutes/review-events', (req, res) => res.json({ success: true }));
  app.post('/api/staged-meeting-minutes/terminology-qa/suggestions', (req, res) => res.json({ success: true, suggestions: [] }));
  app.post('/api/staged-meeting-minutes/terminology-qa/decision', (req, res) => res.json({ success: true }));

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, stagesRequested }));
  });
}

test('a resume link opens the stage it was written for, in both numberings', { timeout: 300000 }, async () => {
  const { server, port, stagesRequested } = await startStubServer();
  // The stub server holds the event loop open, so it is closed even if the browser never
  // starts. Without that, a launch failure hangs `node --test` instead of failing it.
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    server.close();
    throw error;
  }
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  const stageOf = () => page.evaluate(() => document.body.getAttribute('data-stage'));

  try {
    await page.goto(`http://127.0.0.1:${port}/staged-meeting-minutes`);
    await page.fill('#stagedTranscriptText', 'Alex Reed: The build is cut and awaiting sign-off.\nSam Okoro: Circulate the checklist.');
    await page.click('#generateStagedMinutesBtn');
    await page.waitForFunction(() => document.getElementById('meetingTitle')?.value, null, { timeout: 60000 });

    const draftId = await page.evaluate(() => {
      const drafts = JSON.parse(localStorage.getItem('stagedMeetingMinutesJobs') || '[]');
      return drafts.length ? String(drafts[0].jobId) : '';
    });
    assert.ok(draftId, 'the draft was saved so it can be resumed');

    const resume = (search) => page.goto(
      `http://127.0.0.1:${port}/staged-meeting-minutes?draftId=${encodeURIComponent(draftId)}&${search}`
    );

    // Written before Summary was removed: 2 was Discussion, 3 was Actions, 4 was Final
    // review. Each one has to open the stage it named, not the stage now holding its index.
    await resume('screen=2');
    await page.waitForFunction(() => document.body.getAttribute('data-stage') === 'discussion');
    assert.equal(await stageOf(), 'discussion', 'old screen 2 opens Discussion, not Actions');

    await resume('screen=3');
    await page.waitForFunction(() => document.body.getAttribute('data-stage') === 'actions');
    assert.equal(await stageOf(), 'actions', 'old screen 3 opens Actions, not Final review');

    await resume('screen=4');
    await page.waitForFunction(() => document.body.getAttribute('data-stage') === 'final_review');
    assert.equal(await stageOf(), 'final_review', 'old screen 4 opens Final review');

    // Summary is gone; a draft parked on it belongs on the stage that now follows Details.
    await resume('screen=1');
    await page.waitForFunction(() => document.body.getAttribute('data-stage') === 'discussion');
    assert.equal(await stageOf(), 'discussion', 'old screen 1, the removed Summary, opens Discussion');

    // Written today: the stage is named, so the index beside it is never consulted.
    await resume('stage=actions&screen=2');
    await page.waitForFunction(() => document.body.getAttribute('data-stage') === 'actions');
    assert.equal(await stageOf(), 'actions');

    await resume('stage=discussion&screen=1');
    await page.waitForFunction(() => document.body.getAttribute('data-stage') === 'discussion');
    assert.equal(await stageOf(), 'discussion');

    // And the draft the page saves names its own stage, so it needs no mapping next time.
    // Which stage that is depends on when the draft was last written - a resume that
    // generates nothing saves nothing - so the invariant is that the name is a real stage
    // and the link agrees with it, not that it is any particular one.
    const saved = await page.evaluate((id) => {
      const drafts = JSON.parse(localStorage.getItem('stagedMeetingMinutesJobs') || '[]');
      return drafts.find((draft) => String(draft.jobId) === id) || null;
    }, draftId);
    assert.ok(saved, 'the draft is still saved after resuming it');
    assert.ok(['details', 'discussion', 'actions', 'final_review'].includes(saved.activeStage),
      `the saved draft records the stage it was left on, got ${saved.activeStage}`);
    assert.ok(String(saved.resumeUrl).includes(`stage=${saved.activeStage}`),
      'and its own resume link names that same stage');

    assert.ok(stagesRequested.includes('discussion') && stagesRequested.includes('actions'),
      'each resumed stage was generated rather than opening empty');
    assert.deepEqual(pageErrors, [], `no page errors: ${pageErrors.join(' | ')}`);
  } finally {
    await browser.close();
    server.close();
  }
});
