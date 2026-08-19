const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_SCREENSHOT_BYTES = 12 * 1024 * 1024;
const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data', 'review-feedback');

function feedbackDataDir() {
  return process.env.REVIEW_FEEDBACK_DATA_DIR || DEFAULT_DATA_DIR;
}

function feedbackFile() {
  return path.join(feedbackDataDir(), 'feedback.json');
}

function screenshotsDir() {
  return path.join(feedbackDataDir(), 'screenshots');
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function cleanString(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function cleanTags(value) {
  return String(value || '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function parseScreenshotDataUrl(value) {
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(String(value || ''));
  if (!match) {
    const error = new Error('The screenshot must be a PNG or JPEG data URL.');
    error.statusCode = 400;
    throw error;
  }

  const image = Buffer.from(match[2], 'base64');
  if (!image.length || image.length > MAX_SCREENSHOT_BYTES) {
    const error = new Error('The screenshot is empty or too large.');
    error.statusCode = 400;
    throw error;
  }

  return {
    extension: match[1] === 'jpeg' ? 'jpg' : 'png',
    image
  };
}

async function listReviewFeedback({ limit = 100 } = {}) {
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  const entries = await readJson(feedbackFile(), []);
  return entries.slice(0, safeLimit);
}

async function createReviewFeedback(payload = {}, reviewer = {}) {
  const comment = cleanString(payload.comment, 4000);
  if (!comment) {
    const error = new Error('Add a comment before saving.');
    error.statusCode = 400;
    throw error;
  }

  const screenshot = parseScreenshotDataUrl(payload.screenshotDataUrl);
  const id = crypto.randomUUID();
  const screenshotFile = `${id}.${screenshot.extension}`;
  const entry = {
    id,
    project: cleanString(payload.project || 'trinzo', 80) || 'trinzo',
    comment,
    priority: cleanString(payload.priority || 'normal', 20) || 'normal',
    tags: cleanTags(payload.tags),
    pageUrl: cleanString(payload.pageUrl, 4000),
    pagePath: cleanString(payload.pagePath, 2000),
    pageTitle: cleanString(payload.pageTitle, 500),
    viewportWidth: Number(payload.viewportWidth) || 0,
    viewportHeight: Number(payload.viewportHeight) || 0,
    scrollX: Number(payload.scrollX) || 0,
    scrollY: Number(payload.scrollY) || 0,
    userAgent: cleanString(payload.userAgent, 1000),
    reviewerEmail: cleanString(reviewer.email, 320),
    reviewerName: cleanString(reviewer.fullName, 200),
    status: 'open',
    createdAt: new Date().toISOString(),
    updatedAt: null,
    screenshotFile
  };

  await fs.mkdir(screenshotsDir(), { recursive: true });
  await fs.writeFile(path.join(screenshotsDir(), screenshotFile), screenshot.image);
  const entries = await readJson(feedbackFile(), []);
  await fs.writeFile(feedbackFile(), JSON.stringify([entry, ...entries], null, 2));
  return entry;
}

async function updateReviewFeedbackStatus(feedbackId, status) {
  const allowedStatuses = new Set(['open', 'reviewing', 'fixed', 'closed']);
  const nextStatus = cleanString(status, 20);
  if (!allowedStatuses.has(nextStatus)) {
    const error = new Error('Choose a valid feedback status.');
    error.statusCode = 400;
    throw error;
  }

  const entries = await readJson(feedbackFile(), []);
  const index = entries.findIndex((entry) => entry.id === feedbackId);
  if (index === -1) return null;
  entries[index] = {
    ...entries[index],
    status: nextStatus,
    updatedAt: new Date().toISOString()
  };
  await fs.writeFile(feedbackFile(), JSON.stringify(entries, null, 2));
  return entries[index];
}

function reviewScreenshotPath(fileName) {
  if (!/^[a-f0-9-]+\.(?:png|jpg)$/i.test(String(fileName || ''))) return null;
  return path.join(screenshotsDir(), fileName);
}

module.exports = {
  createReviewFeedback,
  listReviewFeedback,
  reviewScreenshotPath,
  updateReviewFeedbackStatus
};
