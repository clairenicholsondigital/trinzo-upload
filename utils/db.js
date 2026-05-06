const { execFile } = require('node:child_process');

function hasDatabaseConfig() {
  return Boolean(
    process.env.DATABASE_URL ||
    (process.env.PGHOST && process.env.PGPORT && process.env.PGDATABASE && process.env.PGUSER && process.env.PGPASSWORD)
  );
}

function getDatabaseConfigError() {
  return 'Database configuration missing. Set DATABASE_URL or PGHOST, PGPORT, PGDATABASE, PGUSER, and PGPASSWORD.';
}

function runPsql(sql) {
  return new Promise((resolve, reject) => {
    if (!hasDatabaseConfig()) {
      reject(new Error(getDatabaseConfigError()));
      return;
    }

    const args = process.env.DATABASE_URL
      ? [process.env.DATABASE_URL, '-At', '-F', '|', '-c', sql]
      : ['-d', process.env.PGDATABASE || 'postgres', '-At', '-F', '|', '-c', sql];

    execFile('psql', args, { env: process.env }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || error.message).trim()));
        return;
      }
      resolve((stdout || '').trim());
    });
  });
}

async function testConnection() {
  const out = await runPsql('SELECT NOW()::text');
  return out.split('\n')[0] || null;
}

function q(value) { return `'${String(value || '').replace(/'/g, "''")}'`; }
function qJson(value) { return `'${JSON.stringify(value || {}).replace(/'/g, "''")}'::jsonb`; }

async function saveUploadedJob({ fileName, mimeType, transcriptText }) {
  const title = fileName || 'Uploaded transcript';
  const description = 'Auto-created from uploaded transcript.';
  const transcript = transcriptText || '';
  const payload = JSON.stringify({ fileName, mimeType, status: 'uploaded' }).replace(/'/g, "''");

  const sql = `
WITH inserted_meeting AS (
  INSERT INTO meetings (meeting_title, meeting_description, source)
  VALUES (${q(title)}, ${q(description)}, 'trinzo-upload')
  RETURNING id, created_at
), inserted_autosave AS (
  INSERT INTO meeting_autosaves (meeting_id, transcript_text, transcript_length, payload)
  SELECT id, ${q(transcript)}, LENGTH(${q(transcript)}), '${payload}'::jsonb
  FROM inserted_meeting
)
SELECT id::text || '|' || created_at::text FROM inserted_meeting;`;

  const out = await runPsql(sql);
  const [meetingId, createdAt] = (out.split('\n')[0] || '').split('|');
  return { meetingId: Number(meetingId), createdAt };
}

async function saveMeetingMinutes(payload) {
  const meetingTitle = payload?.meetingTitle || 'Uploaded transcript review';
  const meetingDescription = payload?.meetingDescription || 'Auto-created from uploaded transcript.';
  const transcriptText = payload?.transcriptText || '';
  const autosavePayload = payload?.payload || {};
  const source = payload?.payload?.source || 'trinzo-upload';

  const sql = `
BEGIN;
WITH inserted_meeting AS (
  INSERT INTO meetings (meeting_title, meeting_description, source, status, webhook_status, last_activity_at)
  VALUES (${q(meetingTitle)}, ${q(meetingDescription)}, ${q(source)}, 'queued', COALESCE(NULLIF(webhook_status,''), 'not_sent'), NOW())
  RETURNING id
), inserted_autosave AS (
  INSERT INTO meeting_autosaves (meeting_id, transcript_text, transcript_length, payload)
  SELECT id, ${q(transcriptText)}, LENGTH(${q(transcriptText)}), ${qJson(autosavePayload)}
  FROM inserted_meeting
), inserted_job AS (
  INSERT INTO meeting_jobs (meeting_id, job_type, status, attempts, max_attempts, run_after, created_at, updated_at)
  SELECT id, 'agent_extract', 'queued', 0, 3, NOW(), NOW(), NOW()
  FROM inserted_meeting
  RETURNING id, meeting_id
)
SELECT meeting_id::text || '|' || id::text FROM inserted_job;
COMMIT;`;
  const out = await runPsql(sql);
  const row = out.split('\n').find((line) => /^\d+\|\d+$/.test(line));
  const [meetingId, jobId] = (row || '|').split('|');
  return { meetingId: Number(meetingId), jobId: Number(jobId), status: 'queued' };
}

async function getMeetingStatus(meetingId) {
  const sql = `
SELECT m.id::text, COALESCE(m.status,''), COALESCE(m.webhook_status,'not_sent'), COALESCE(m.last_error,''), COALESCE(m.last_activity_at::text,''),
COALESCE(j.id::text,''), COALESCE(j.job_type,''), COALESCE(j.status,''), COALESCE(j.attempts::text,'0'), COALESCE(j.error_message,'')
FROM meetings m
LEFT JOIN LATERAL (
  SELECT id, job_type, status, attempts, error_message
  FROM meeting_jobs
  WHERE meeting_id = m.id
  ORDER BY created_at DESC, id DESC
  LIMIT 1
) j ON TRUE
WHERE m.id = ${Number(meetingId)}
LIMIT 1;`;
  const out = await runPsql(sql);
  const line = out.split('\n').find(Boolean);
  if (!line) return null;
  const [id, status, webhookStatus, lastError, lastActivityAt, jobId, jobType, jobStatus, attempts, errorMessage] = line.split('|');
  return {
    meeting: { id: Number(id), status, webhookStatus, lastError, lastActivityAt },
    latestJob: jobId ? { id: Number(jobId), jobType, status: jobStatus, attempts: Number(attempts || 0), errorMessage } : null
  };
}

async function claimNextJob(lockedBy = 'manual-runner') {
  const sql = `
WITH candidate AS (
  SELECT id
  FROM meeting_jobs
  WHERE status = 'queued'
    AND (run_after IS NULL OR run_after <= NOW())
    AND attempts < max_attempts
  ORDER BY created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
UPDATE meeting_jobs j
SET status = 'running',
    attempts = COALESCE(attempts, 0) + 1,
    locked_at = NOW(),
    locked_by = ${q(lockedBy)},
    updated_at = NOW()
FROM candidate
WHERE j.id = candidate.id
RETURNING j.id::text, j.meeting_id::text, j.job_type, j.status, j.attempts::text, j.max_attempts::text;`;
  const out = await runPsql(sql);
  const line = out.split('\n').find(Boolean);
  if (!line) return null;
  const [id, meetingId, jobType, status, attempts, maxAttempts] = line.split('|');
  return { id: Number(id), meetingId: Number(meetingId), jobType, status, attempts: Number(attempts), maxAttempts: Number(maxAttempts) };
}

async function markJobCompleted(jobId, meetingId, resultPayload) {
  const sql = `
BEGIN;
UPDATE meeting_jobs
SET status = 'completed', result_payload = ${qJson(resultPayload)}, error_message = NULL, locked_at = NULL, locked_by = NULL, updated_at = NOW()
WHERE id = ${Number(jobId)};
UPDATE meetings SET status = CASE WHEN status = 'webhook_pending' THEN status ELSE 'processed' END, processing_completed_at = NOW(), last_activity_at = NOW() WHERE id = ${Number(meetingId)};
COMMIT;`;
  await runPsql(sql);
}

async function markJobFailure(job, errorMessage) {
  const shouldRetry = job.attempts < job.maxAttempts;
  const sql = shouldRetry ? `
BEGIN;
UPDATE meeting_jobs
SET status = 'queued', error_message = ${q(errorMessage)}, locked_at = NULL, locked_by = NULL, run_after = NOW() + INTERVAL '2 minutes', updated_at = NOW()
WHERE id = ${Number(job.id)};
UPDATE meetings SET status = 'queued', last_error = ${q(errorMessage)}, last_activity_at = NOW() WHERE id = ${Number(job.meetingId)};
COMMIT;` : `
BEGIN;
UPDATE meeting_jobs
SET status = 'failed', error_message = ${q(errorMessage)}, locked_at = NULL, locked_by = NULL, updated_at = NOW()
WHERE id = ${Number(job.id)};
UPDATE meetings SET status = 'failed', last_error = ${q(errorMessage)}, last_activity_at = NOW() WHERE id = ${Number(job.meetingId)};
COMMIT;`;
  await runPsql(sql);
  return shouldRetry;
}

async function queueWebhookJob(meetingId, payload) {
  const sql = `
BEGIN;
UPDATE meetings SET webhook_status = 'pending', status = 'webhook_pending', last_activity_at = NOW() WHERE id = ${Number(meetingId)};
INSERT INTO meeting_jobs (meeting_id, job_type, status, attempts, max_attempts, run_after, result_payload, created_at, updated_at)
VALUES (${Number(meetingId)}, 'webhook_send', 'queued', 0, 3, NOW(), ${qJson(payload)}, NOW(), NOW())
RETURNING id::text;
COMMIT;`;
  const out = await runPsql(sql);
  const jobId = Number((out.split('\n').find((line) => /^\d+$/.test(line)) || '').trim());
  return { jobId, webhookStatus: 'pending' };
}


function parseJsonArray(value) {
  if (!value) return [];
  try { return JSON.parse(value); } catch { return []; }
}

async function listMeetings() {
  const sql = `
SELECT id::text, meeting_title, COALESCE(meeting_date::text, ''), COALESCE(meeting_location, ''), COALESCE(meeting_description, ''), created_at::text
FROM meetings
ORDER BY created_at DESC;`;
  const out = await runPsql(sql);
  return out.split('\n').filter(Boolean).map((line) => {
    const [id, meetingTitle, meetingDate, meetingLocation, meetingDescription, createdAt] = line.split('|');
    return { id: Number(id), meetingTitle, meetingDate, meetingLocation, meetingDescription, createdAt };
  });
}

async function getMeetingById(meetingId) {
  const sql = `SELECT id::text, COALESCE(meeting_title,''), COALESCE(meeting_date::text,''), COALESCE(meeting_location,''), COALESCE(meeting_description,''), created_at::text FROM meetings WHERE id = ${Number(meetingId)} LIMIT 1;`;
  const out = await runPsql(sql);
  const line = out.split('\n').find(Boolean);
  if (!line) return null;
  const [id, meetingTitle, meetingDate, meetingLocation, meetingDescription, createdAt] = line.split('|');
  return { id: Number(id), meetingTitle, meetingDate, meetingLocation, meetingDescription, createdAt };
}

async function deleteMeetingById(meetingId) {
  const out = await runPsql(`DELETE FROM meetings WHERE id = ${Number(meetingId)} RETURNING id::text;`);
  return Boolean(out.split('\n').find((line) => /^\d+$/.test(line)));
}

async function updateMeetingById(meetingId, payload) {
  await runPsql(`UPDATE meetings SET meeting_title=${q(payload?.meetingTitle || '')}, meeting_date=${payload?.meetingDate ? q(payload.meetingDate) : 'NULL'}, meeting_location=${q(payload?.meetingLocation || '')}, meeting_description=${q(payload?.meetingDescription || '')}, updated_at = NOW() WHERE id = ${Number(meetingId)};`);
  return { meetingId: Number(meetingId) };
}



async function markWebhookSuccess(jobId, meetingId, webhookResponse) {
  const sql = `BEGIN;
UPDATE meeting_jobs SET status='completed', result_payload=${qJson(webhookResponse)}, error_message=NULL, locked_at=NULL, locked_by=NULL, updated_at=NOW() WHERE id=${Number(jobId)};
UPDATE meetings SET webhook_status='sent', webhook_sent_at=NOW(), webhook_response=${qJson(webhookResponse)}, status='completed', last_error='', processing_completed_at=NOW(), last_activity_at=NOW() WHERE id=${Number(meetingId)};
COMMIT;`;
  await runPsql(sql);
}

async function markWebhookFailure(job, errorMessage) {
  const shouldRetry = job.attempts < job.maxAttempts;
  const sql = shouldRetry ? `BEGIN;
UPDATE meeting_jobs SET status='queued', error_message=${q(errorMessage)}, locked_at=NULL, locked_by=NULL, run_after=NOW()+INTERVAL '2 minutes', updated_at=NOW() WHERE id=${Number(job.id)};
UPDATE meetings SET webhook_status='failed', status='failed', last_error=${q(errorMessage)}, last_activity_at=NOW() WHERE id=${Number(job.meetingId)};
COMMIT;` : `BEGIN;
UPDATE meeting_jobs SET status='failed', error_message=${q(errorMessage)}, locked_at=NULL, locked_by=NULL, updated_at=NOW() WHERE id=${Number(job.id)};
UPDATE meetings SET webhook_status='failed', status='failed', last_error=${q(errorMessage)}, last_activity_at=NOW() WHERE id=${Number(job.meetingId)};
COMMIT;`;
  await runPsql(sql);
}
module.exports = {
  testConnection,
  listMeetings,
  getMeetingById,
  deleteMeetingById,
  updateMeetingById,
  saveUploadedJob,
  saveMeetingMinutes,
  getMeetingStatus,
  claimNextJob,
  markJobCompleted,
  markJobFailure,
  queueWebhookJob,
  markWebhookSuccess,
  markWebhookFailure,
  hasDatabaseConfig,
  getDatabaseConfigError,
  runPsql
};
