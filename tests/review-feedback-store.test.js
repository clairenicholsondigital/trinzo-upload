const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createReviewFeedback,
  listReviewFeedback,
  reviewScreenshotPath,
  summariseReviewFeedback,
  updateReviewFeedbackStatus
} = require('../utils/reviewFeedbackStore');

test('review feedback store saves screenshot metadata and groups private files', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trinzo-review-feedback-'));
  process.env.REVIEW_FEEDBACK_DATA_DIR = tempDir;

  const entry = await createReviewFeedback({
    project: 'trinzo',
    comment: 'The final review label is confusing.',
    priority: 'high',
    tags: 'staged, labels',
    pageUrl: 'https://trinzo.virtual-hub.online/staged-meeting-minutes?review=1',
    pagePath: '/staged-meeting-minutes',
    pageTitle: 'Staged Meeting Minutes',
    viewportWidth: 1440,
    viewportHeight: 900,
    screenshotDataUrl: 'data:image/png;base64,aGVsbG8='
  }, {
    email: 'reviewer@example.com',
    fullName: 'Reviewer'
  });

  assert.equal(entry.status, 'open');
  assert.equal(entry.priority, 'high');
  assert.deepEqual(entry.tags, ['staged', 'labels']);
  assert.equal(entry.reviewerEmail, 'reviewer@example.com');

  const saved = await listReviewFeedback();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].comment, 'The final review label is confusing.');
  assert.match(saved[0].screenshotFile, /^[a-f0-9-]+\.png$/i);

  const screenshotPath = reviewScreenshotPath(saved[0].screenshotFile);
  assert.equal(await fs.readFile(screenshotPath, 'utf8'), 'hello');

  const updated = await updateReviewFeedbackStatus(entry.id, 'fixed');
  assert.equal(updated.status, 'fixed');

  await fs.rm(tempDir, { recursive: true, force: true });
  delete process.env.REVIEW_FEEDBACK_DATA_DIR;
});

test('review feedback store rejects empty comments and non-image payloads', async () => {
  await assert.rejects(
    () => createReviewFeedback({ screenshotDataUrl: 'data:image/png;base64,aGVsbG8=' }),
    /Add a comment/
  );
  await assert.rejects(
    () => createReviewFeedback({ comment: 'Broken', screenshotDataUrl: 'not an image' }),
    /PNG or JPEG/
  );
});

test('review feedback summary counts only open priorities and tags', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trinzo-review-feedback-summary-'));
  process.env.REVIEW_FEEDBACK_DATA_DIR = tempDir;

  const first = await createReviewFeedback({
    comment: 'First open item', priority: 'high', tags: 'Actions, wording',
    screenshotDataUrl: 'data:image/png;base64,aGVsbG8='
  });
  await createReviewFeedback({
    comment: 'Second open item', priority: 'urgent', tags: 'actions, mobile',
    screenshotDataUrl: 'data:image/png;base64,aGVsbG8='
  });
  const closed = await createReviewFeedback({
    comment: 'Closed item', priority: 'high', tags: 'actions, closed-only',
    screenshotDataUrl: 'data:image/png;base64,aGVsbG8='
  });
  await updateReviewFeedbackStatus(closed.id, 'closed');

  assert.equal(first.status, 'open');
  assert.deepEqual(await summariseReviewFeedback(), {
    totalSnippets: 3,
    openCount: 2,
    openByPriority: { low: 0, normal: 0, high: 1, urgent: 1 },
    tagCounts: { actions: 3, 'closed-only': 1, mobile: 1, wording: 1 },
    openTagCounts: { actions: 2, mobile: 1, wording: 1 }
  });

  await fs.rm(tempDir, { recursive: true, force: true });
  delete process.env.REVIEW_FEEDBACK_DATA_DIR;
});
