'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const { chromium } = require('playwright');

// The staged review, driven in a real browser.
//
// Everything else in the suite calls pipeline functions and reads return values, which
// means the page itself - four thousand lines of front-end code that renders what those
// functions return - had no coverage at all. The reviewer-corrections work changed what
// every screen receives, and none of it had ever been rendered before a person saw it.
//
// The boundary is drawn at HTTP: the REAL page, served whole, in a real Chromium, against
// endpoints stubbed in this file - but stubbed with payloads produced by the REAL
// pipeline, not hand-written JSON. Auth and the job queue are outside the boundary; the
// shape of every payload the page consumes is inside it.

const REPO_ROOT = path.resolve(__dirname, '..');
const PAGE_PATH = path.join(REPO_ROOT, 'views', 'staged-meeting-minutes.html');
const TRANSCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'transcript-tests', '001_status_review', 'transcript.txt');

function startStubServer(options = {}) {
  const api = require('../routes/api').stagedEvaluation;
  const { runCanonicalLiveStage } = require('../utils/canonicalMinutes/liveStages');

  const app = express();
  app.use(express.json({ limit: '5mb' }));
  const jobs = new Map();
  const recordedReviewEvents = [];
  let nextJobId = 1;

  app.get('/staged-meeting-minutes', (req, res) => {
    res.type('html').send(fs.readFileSync(PAGE_PATH, 'utf8'));
  });

  // The page posts FormData; parse fields only (the test pastes text, it uploads no file).
  const form = multer();
  app.post('/api/staged-meeting-minutes/jobs', form.any(), (req, res) => {
    const stage = String(req.query.stage || 'details');
    // The page sends the transcript in a field named `text` - and this stub originally
    // read `transcriptText`, which meant every stage ran on an EMPTY transcript and the
    // whole test passed anyway: the empty-path purpose ("A clear purpose ... was not
    // stated") is a non-empty string, confirmed topics survive with no evidence, and the
    // panel renders counts of them. A rendering assertion on the objectives list is what
    // finally caught it. The stub asserts against emptiness now, so a field rename in
    // the page fails here as itself rather than as a quietly hollow test.
    const text = String(req.body.text || req.body.transcriptText || req.body.storedTranscriptText || '');
    if (stage !== 'details' || req.body.text) {
      if (!text.trim()) return res.status(400).json({ success: false, error: 'stub received no transcript text' });
    }
    const parse = (value) => { try { return JSON.parse(value); } catch { return undefined; } };
    const confirmed = {
      details: parse(req.body.confirmedDetails),
      summary: parse(req.body.confirmedSummary),
      discussion: parse(req.body.confirmedDiscussion),
      actions: parse(req.body.confirmedActions)
    };
    const transcriptSha256 = crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);

    let payload;
    if (stage === 'details') {
      payload = api.extractStagedDetailsFromTranscript(text, '');
    } else if (stage === 'discussion' && options.narrativeDiscussion) {
      payload = {
        stagedStage: 'discussion',
        screens: {
          discussion: [{
            topic: 'Discussion',
            narrative: true,
            points: [
              'The alarm behaviour remained under review, including the unresolved mute-button indication.',
              'The software documentation was reviewed in the context of the outstanding verification work.'
            ],
            pointRefs: [{ evidenceIds: ['line_1_unit_0'] }, { evidenceIds: ['line_2_unit_0'] }]
          }]
        },
        validationFlags: []
      };
    } else {
      // The live stage, not canonicalStagedResponse: the LLM polish is a network call and
      // this test must be deterministic and offline.
      payload = runCanonicalLiveStage(text, {
        stage,
        fileName: '',
        confirmed,
        includeEvidencePack: stage === 'actions'
      });
    }
    payload = { ...payload, transcriptSha256 };
    const jobId = `e2e-job-${nextJobId += 1}`;
    jobs.set(jobId, { stage, payload });
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

  app.post('/api/staged-meeting-minutes/review-events', (req, res) => {
    recordedReviewEvents.push(req.body || {});
    res.json({ success: true });
  });
  app.post('/api/staged-meeting-minutes/organize-discussion', (req, res) => {
    const card = Array.isArray(req.body.confirmedDiscussion) ? req.body.confirmedDiscussion[0] : null;
    const points = Array.isArray(card?.points) ? card.points : [];
    const refs = Array.isArray(card?.pointRefs) ? card.pointRefs : [];
    res.json({
      ok: true,
      screens: {
        discussion: points.map((point, index) => ({
          topic: index === 0 ? 'Alarm verification' : 'Software documentation',
          points: [point],
          pointRefs: [refs[index] || { evidenceIds: [] }]
        }))
      }
    });
  });
  app.post('/api/staged-meeting-minutes/terminology-qa/suggestions', (req, res) => res.json({ success: true, suggestions: [] }));
  app.post('/api/staged-meeting-minutes/terminology-qa/decision', (req, res) => res.json({ success: true }));
  app.post('/api/staged-meeting-minutes/pdf', (req, res) => {
    res.type('application/pdf').send(Buffer.from('%PDF-1.4 e2e stub'));
  });

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, recordedReviewEvents });
    });
  });
}

test('a reviewer can walk the staged flow and see their corrections acknowledged', { timeout: 600000 }, async () => {
  const transcriptText = fs.readFileSync(TRANSCRIPT_PATH, 'utf8');

  // Warm the MiniLM profile before the browser exists. Under a cold cache the whole
  // suite competes for CPU and a first profile can take minutes; paid here it costs the
  // test's own budget, and every stage the page requests then hits the cache. Without
  // this the browser's wait raced the profiler and lost only when the suite ran cold -
  // a failure that passed in isolation, which is the worst kind.
  const { runCanonicalLiveStage } = require('../utils/canonicalMinutes/liveStages');
  runCanonicalLiveStage(transcriptText, { stage: 'summary', fileName: 'pasted-transcript.txt', confirmed: {} });

  const { server, port, recordedReviewEvents } = await startStubServer();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  // The suite runs this alongside tests that spawn MiniLM profilers on every core, and a
  // starved renderer can hold an ordinary click past Playwright's 30s default. The
  // default is for pages that misbehave; this one is just running on a busy machine.
  page.setDefaultTimeout(180000);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  try {
    await page.goto(`http://127.0.0.1:${port}/staged-meeting-minutes`);

    // Screen 0: paste the transcript and generate details.
    await page.fill('#stagedTranscriptText', transcriptText);
    await page.click('#generateStagedMinutesBtn');
    await page.waitForFunction(() => document.getElementById('meetingTitle')?.value, null, { timeout: 120000 });
    const title = await page.inputValue('#meetingTitle');
    assert.ok(title, 'the details stage fills the meeting title');

    // Continue to the summary. Generation runs through the stubbed queue and the real
    // pipeline; the purpose field must arrive populated, not blank.
    await page.click('#nextScreenBtn');
    await page.waitForFunction(() => document.getElementById('meetingPurpose')?.value, null, { timeout: 300000 });
    const generatedPurpose = await page.inputValue('#meetingPurpose');
    assert.ok(generatedPurpose.length > 0, 'a purpose is shown');
    assert.doesNotMatch(generatedPurpose, /Coordinate the meeting's main workstreams/, 'the deleted pipeline sentence stays deleted');

    // The per-workstream objectives actually render - the enrichment work raised the cap
    // to eight, and a list that is produced but not displayed is the class of gap this
    // test exists for. This transcript yields several; the exact count is the pipeline's
    // business, the rendering is this test's.
    const objectiveLines = (await page.inputValue('#objectives')).split('\n').filter(Boolean);
    assert.ok(objectiveLines.length >= 1, `objectives render as lines (got ${objectiveLines.length})`);

    // The editorial flags render in the browser, not only in the payload: the purpose on
    // this meeting is inferred, so its non-blocking flag must be visible - the same
    // machinery that shows meeting_type_suggested and summary_machine_composed.
    await page.waitForSelector('#stageValidationFlags:not([hidden])', { timeout: 30000 });
    const flagText = await page.textContent('#stageValidationFlags');
    assert.match(flagText, /purpose/i, `the purpose-inferred flag is shown to the reviewer: ${flagText.slice(0, 120)}`);

    // Summary no longer asks the reviewer to predict the meeting's topic structure.
    // The reviewer corrects the purpose, then organises the factual points on Discussion.
    const reviewerPurpose = 'Check in on the AI programme and unblock the stalled items.';
    await page.fill('#meetingPurpose', reviewerPurpose);
    assert.equal(await page.locator('#overallTopics').count(), 0, 'the Summary topics field is not shown');

    // Continue to the discussion.
    await page.click('#nextScreenBtn');
    await page.waitForFunction(() => document.body.getAttribute('data-stage') === 'discussion', null, { timeout: 300000 });

    await page.waitForSelector('.discussion-card', { timeout: 30000 });
    assert.ok(await page.locator('.discussion-card').count() >= 2, 'suggested groups and Unassigned render');
    assert.ok(await page.locator('.discussion-topic-input[value="Unassigned"]').count(), 'Unassigned remains visible');
    const reviewerTopic = 'What we owe the client next';
    const firstTopic = page.locator('.discussion-topic-input:not([readonly])').first();
    await firstTopic.fill(reviewerTopic);
    await firstTopic.dispatchEvent('input');
    assert.equal(await page.locator('.discussion-card-title').first().textContent(), reviewerTopic);

    const firstPoint = page.locator('.discussion-point-item').first();
    if (await firstPoint.count()) {
      await firstPoint.locator('.discussion-point-move').selectOption('Unassigned');
      await page.waitForFunction(() => {
        const unassigned = Array.from(document.querySelectorAll('.discussion-card')).find((card) => card.querySelector('.discussion-topic-input')?.value === 'Unassigned');
        return Boolean(unassigned && unassigned.querySelector('.discussion-point-item'));
      });
    }

    // And the purpose box still holds their words, not a regeneration.
    assert.equal(await page.inputValue('#meetingPurpose'), reviewerPurpose);

    // No JavaScript error anywhere along the way - the check that was impossible headless.
    assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(' | ')}`);

    // The analytics the page actually sent carry the purpose source - asserted on what
    // reached the server, not on what the page might have built.
    const deadline = Date.now() + 15000;
    while (!recordedReviewEvents.length && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(recordedReviewEvents.length > 0, 'the page posted at least one review event during the flow');
    const withSource = recordedReviewEvents.filter((event) => 'purposeSource' in event);
    assert.ok(withSource.length > 0, 'a posted review event carries purposeSource');
  } finally {
    await browser.close();
    server.close();
  }

  // recordedReviewEvents is best-effort here (the page batches sends), but any that did
  // arrive must be well-formed.
  for (const event of recordedReviewEvents) {
    assert.ok(event.draftId, 'a review event names its draft');
  }
});

test('contextual discussion paragraphs are reviewed whole before optional topic organisation', async () => {
  const transcriptText = fs.readFileSync(TRANSCRIPT_PATH, 'utf8');
  const { server, port } = await startStubServer({ narrativeDiscussion: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  try {
    await page.goto(`http://127.0.0.1:${port}/staged-meeting-minutes`);
    await page.fill('#stagedTranscriptText', transcriptText);
    await page.click('#generateStagedMinutesBtn');
    await page.waitForFunction(() => document.getElementById('meetingTitle')?.value, null, { timeout: 120000 });
    await page.click('#nextScreenBtn');
    await page.waitForFunction(() => document.getElementById('meetingPurpose')?.value, null, { timeout: 300000 });
    await page.click('#nextScreenBtn');
    await page.waitForSelector('#discussionNarrativeInput', { timeout: 300000 });
    assert.equal(await page.locator('#discussionOrganizerControls').isHidden(), true);
    assert.equal(await page.locator('#discussionNarrativeControls').isVisible(), true);
    const reviewedFirstParagraph = 'The reviewer-confirmed alarm paragraph keeps enough context to explain the unresolved mute-button indication.';
    await page.fill('#discussionNarrativeInput', `${reviewedFirstParagraph}\n\nThe software documentation remained linked to the outstanding verification work.`);
    await page.click('#organizeDiscussionBtn');
    await page.waitForSelector('.discussion-card');
    assert.equal(await page.locator('.discussion-point-input').first().inputValue(), reviewedFirstParagraph);
    assert.equal(await page.locator('#discussionOrganizerControls').isVisible(), true);
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
    server.close();
  }
});
