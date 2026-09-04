'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const { chromium } = require('playwright');

// Resuming a draft at a screen that has never been generated.
//
// Four meetings were reported as reaching Discussion with an empty table. The pipeline was
// innocent: no discussion job existed for any of them, because none had ever been asked
// for. The reviewer had opened a saved draft straight at the Discussion screen - the
// session trail reads `draft_resumed, requestedScreen: 2` with no generation after it -
// and the resume path called showScreen() directly.
//
// Continue-to-next-screen has always asked stageNeedsGeneration first. The resume path
// skipped the question, so the screen rendered whatever the draft happened to hold, which
// for a stage that had never run was nothing at all: an empty table, no message, and no
// way to tell it apart from a meeting that genuinely produced no discussion.
//
// This drives the real page: generate details, reload at ?screen=2 as the Library link did
// at the time, and require that the discussion arrives.
//
// That link is also the second thing under test here. Screen 2 was Discussion when those
// reports came in, back when Summary sat between Details and Discussion; Summary has since
// been removed and screen 2 is now Actions. A link written under the old numbering has to
// keep resuming the stage it named, or resuming a saved draft walks the reviewer past the
// Discussion review instead of into it.

const REPO_ROOT = path.resolve(__dirname, '..');
const PAGE_PATH = path.join(REPO_ROOT, 'views', 'staged-meeting-minutes.html');
const TRANSCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'transcript-tests', '001_status_review', 'transcript.txt');

function startStubServer() {
  const api = require('../routes/api').stagedEvaluation;
  const { runCanonicalLiveStage } = require('../utils/canonicalMinutes/liveStages');
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  const jobs = new Map();
  const stagesRequested = [];
  let nextJobId = 1;

  app.get('/staged-meeting-minutes', (req, res) => res.type('html').send(fs.readFileSync(PAGE_PATH, 'utf8')));
  const form = multer();
  app.post('/api/staged-meeting-minutes/jobs', form.any(), (req, res) => {
    const stage = String(req.query.stage || 'details');
    const text = String(req.body.text || req.body.storedTranscriptText || '');
    if (!text.trim()) return res.status(400).json({ success: false, error: 'stub received no transcript text' });
    stagesRequested.push(stage);
    const parse = (value) => { try { return JSON.parse(value); } catch { return undefined; } };
    const confirmed = {
      details: parse(req.body.confirmedDetails),
      summary: parse(req.body.confirmedSummary),
      discussion: parse(req.body.confirmedDiscussion),
      actions: parse(req.body.confirmedActions)
    };
    const payload = stage === 'details'
      ? api.extractStagedDetailsFromTranscript(text, '')
      : runCanonicalLiveStage(text, { stage, fileName: '', confirmed, includeEvidencePack: stage === 'actions' });
    const jobId = `resume-job-${nextJobId += 1}`;
    jobs.set(jobId, { stage, payload: { ...payload, transcriptSha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16) } });
    res.json({ success: true, jobId, transcriptSha256: jobs.get(jobId).payload.transcriptSha256 });
  });
  app.get('/api/jobs/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ success: false, error: 'not found' });
    res.json({ success: true, job: { jobId: req.params.jobId, status: 'completed', inputPayload: { stage: job.stage } }, result: { result: job.payload } });
  });
  app.post('/api/staged-meeting-minutes/review-events', (req, res) => res.json({ success: true }));
  app.post('/api/staged-meeting-minutes/terminology-qa/suggestions', (req, res) => res.json({ success: true, suggestions: [] }));
  app.post('/api/staged-meeting-minutes/terminology-qa/decision', (req, res) => res.json({ success: true }));

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, stagesRequested }));
  });
}

test('a draft resumed at Discussion generates it instead of showing an empty table', { timeout: 600000 }, async () => {
  const transcriptText = fs.readFileSync(TRANSCRIPT_PATH, 'utf8');
  const { server, port, stagesRequested } = await startStubServer();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(180000);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  try {
    await page.goto(`http://127.0.0.1:${port}/staged-meeting-minutes`);
    await page.fill('#stagedTranscriptText', transcriptText);
    await page.click('#generateStagedMinutesBtn');
    await page.waitForFunction(() => document.getElementById('meetingTitle')?.value, null, { timeout: 180000 });

    // Details, and no further. Discussion is deliberately never generated in this session.
    const draftId = await page.evaluate(() => {
      const drafts = JSON.parse(localStorage.getItem('stagedMeetingMinutesJobs') || '[]');
      return drafts.length ? String(drafts[0].jobId) : '';
    });
    assert.ok(draftId, 'the draft was saved so it can be resumed');
    assert.ok(!stagesRequested.includes('discussion'), 'discussion has not been generated yet');

    // The gesture: open the saved draft straight at Discussion, through a link written in
    // the five-screen numbering, as every link saved before Summary was removed was.
    await page.goto(`http://127.0.0.1:${port}/staged-meeting-minutes?draftId=${encodeURIComponent(draftId)}&screen=2`);
    await page.waitForFunction(() => document.body.getAttribute('data-stage') === 'discussion', null, { timeout: 300000 });
    await page.waitForFunction(() => document.querySelectorAll('[data-discussion-index]').length > 0, null, { timeout: 300000 });

    const cards = await page.evaluate(() => document.querySelectorAll('[data-discussion-index]').length);
    assert.ok(cards > 0, 'the discussion screen has rows rather than an empty table');
    assert.ok(stagesRequested.includes('discussion'), 'resuming at Discussion asked for it to be generated');
    assert.ok(!stagesRequested.includes('actions'),
      'the old link resumed Discussion rather than the screen that now carries its index');

    // And a link written today names the stage, so it does not depend on that mapping.
    await page.goto(`http://127.0.0.1:${port}/staged-meeting-minutes?draftId=${encodeURIComponent(draftId)}&stage=discussion&screen=1`);
    await page.waitForFunction(() => document.body.getAttribute('data-stage') === 'discussion', null, { timeout: 300000 });
    assert.deepEqual(pageErrors, [], `no page errors: ${pageErrors.join(' | ')}`);
  } finally {
    await browser.close();
    server.close();
  }
});
