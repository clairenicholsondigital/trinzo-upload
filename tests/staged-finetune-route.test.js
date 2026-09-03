const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const serverSource = fs.readFileSync(path.join(repoRoot, 'server.js'), 'utf8');
const original = fs.readFileSync(path.join(repoRoot, 'views/staged-meeting-minutes.html'), 'utf8');
const finetune = fs.readFileSync(path.join(repoRoot, 'views/staged-meeting-minutes-finetune.html'), 'utf8');

const apiSource = fs.readFileSync(path.join(repoRoot, 'routes/api.js'), 'utf8');
const trialUtility = fs.readFileSync(path.join(repoRoot, 'utils/finetuneMeetingActions.js'), 'utf8');

test('the finetune route serves an independent authenticated trial view', () => {
  assert.match(
    serverSource,
    /app\.get\('\/staged-meeting-minutes-finetune', authRoutes\.requireAuth, \(req, res\) => \{\s*sendView\(res, 'staged-meeting-minutes-finetune\.html'\)/
  );
  assert.notEqual(finetune, original);
  assert.match(finetune, /<title>Finetuned Meeting Actions Trial \| Trinzo<\/title>/);
  assert.match(finetune, /MiniLM denoiser v3/);
  assert.match(finetune, /Trooper discussion/);
  assert.match(finetune, /Chunked action review/);
});

test('the trial page calls only its isolated action endpoint', () => {
  assert.match(finetune, /fetch\('\/api\/staged-meeting-minutes-finetune\/actions'/);
  assert.doesNotMatch(finetune, /fetchJson\('\/api\/staged-meeting-minutes\/jobs/);
  assert.doesNotMatch(finetune, /STAGED_DRAFTS_KEY/);
});

test('the API trial is authenticated and uses the v3 denoiser before Trooper', () => {
  assert.match(apiSource, /router\.post\('\/staged-meeting-minutes-finetune\/actions', requireAuth, withTestUpload/);
  assert.match(trialUtility, /prepareTranscript\(transcriptText, \[\]\)/);
  assert.match(trialUtility, /runTrooperPipeline\(prepared\.preparedTranscript\)/);
  assert.match(trialUtility, /prepareTranscript\(transcriptText, \[\]\)/);
});

test('the experimental page does not share client-side draft storage', () => {
  assert.match(original, /STAGED_DRAFTS_KEY = 'stagedMeetingMinutesJobs'/);
  assert.doesNotMatch(finetune, /localStorage/);
});

test('the existing staged page remains pointed at the existing route', () => {
  assert.match(original, /resumeUrl: '\/staged-meeting-minutes\?draftId='/);
  assert.doesNotMatch(original, /Finetune workflow sandbox/);
});
