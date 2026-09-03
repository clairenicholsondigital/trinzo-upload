const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const serverSource = fs.readFileSync(path.join(repoRoot, 'server.js'), 'utf8');
const original = fs.readFileSync(path.join(repoRoot, 'views/staged-meeting-minutes.html'), 'utf8');
const finetune = fs.readFileSync(path.join(repoRoot, 'views/staged-meeting-minutes-finetune.html'), 'utf8');

test('the finetune route serves an independent authenticated view', () => {
  assert.match(
    serverSource,
    /app\.get\('\/staged-meeting-minutes-finetune', authRoutes\.requireAuth, \(req, res\) => \{\s*sendView\(res, 'staged-meeting-minutes-finetune\.html'\)/
  );
  assert.notEqual(finetune, original);
  assert.match(finetune, /<title>Finetune \| Staged Meeting Transcript to Minutes Tool<\/title>/);
  assert.match(finetune, /<h1>Finetune Meeting Transcript to Minutes Tool<\/h1>/);
});

test('the duplicated page keeps the staged APIs but resumes on its own route', () => {
  assert.match(finetune, /fetchJson\('\/api\/staged-meeting-minutes\/jobs\?stage='/);
  assert.match(finetune, /fetchJson\('\/api\/staged-meeting-minutes\/review-events'/);
  assert.match(finetune, /resumeUrl: '\/staged-meeting-minutes-finetune\?draftId='/);
  assert.doesNotMatch(finetune, /resumeUrl: '\/staged-meeting-minutes\?draftId='/);
});

test('finetune drafts cannot overwrite drafts from the existing page', () => {
  assert.match(finetune, /STAGED_DRAFTS_KEY = 'stagedMeetingMinutesFinetuneJobs'/);
  assert.match(finetune, /STAGED_TRANSCRIPTS_KEY = 'stagedMeetingMinutesFinetuneTranscripts'/);
  assert.match(finetune, /draftId = 'staged-finetune-review-' \+ randomId/);
  assert.match(original, /STAGED_DRAFTS_KEY = 'stagedMeetingMinutesJobs'/);
  assert.doesNotMatch(original, /stagedMeetingMinutesFinetune/);
});

test('the existing staged page remains pointed at the existing route', () => {
  assert.match(original, /resumeUrl: '\/staged-meeting-minutes\?draftId='/);
  assert.doesNotMatch(original, /Finetune workflow sandbox/);
});
