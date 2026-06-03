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
  VALUES (${q(meetingTitle)}, ${q(meetingDescription)}, ${q(source)}, 'queued', 'not_sent', NOW())
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

function currentQuarterLabel(date = new Date()) {
  const month = date.getUTCMonth();
  const quarter = Math.floor(month / 3) + 1;
  return `Q${quarter} ${date.getUTCFullYear()}`;
}

function quarterStartDate(label) {
  const match = String(label || '').match(/^Q([1-4])\s+(\d{4})$/i);
  if (!match) return new Date().toISOString().slice(0, 10);
  const quarter = Number(match[1]);
  const year = Number(match[2]);
  return `${year}-${String((quarter - 1) * 3 + 1).padStart(2, '0')}-01`;
}

function quarterEndDate(label) {
  const match = String(label || '').match(/^Q([1-4])\s+(\d{4})$/i);
  if (!match) return new Date().toISOString().slice(0, 10);
  const quarter = Number(match[1]);
  const year = Number(match[2]);
  const endMonth = quarter * 3;
  const endDay = new Date(Date.UTC(year, endMonth, 0)).getUTCDate();
  return `${year}-${String(endMonth).padStart(2, '0')}-${String(endDay).padStart(2, '0')}`;
}

function toMilestoneAssessmentStatus(status) {
  const value = String(status || '').toLowerCase();
  if (value === 'complete') return 'completed';
  if (['in_progress', 'scheduled', 'in_review'].includes(value)) return 'on_track';
  if (value === 'awaiting_input') return 'at_risk';
  if (value === 'delayed') return 'delayed';
  if (value === 'blocked') return 'blocked';
  if (value === 'not_started') return 'not_started';
  return 'unknown';
}

function toHealthAreaStatus(rag) {
  const value = String(rag || '').toLowerCase();
  if (value === 'green') return 'on_track';
  if (value === 'amber') return 'at_risk';
  if (value === 'red') return 'off_track';
  if (value === 'blue') return 'completed';
  return 'unknown';
}

function clampConfidence(value, fallback = 0.5) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(1, number));
}

async function saveProjectUpdateDraft({ projectName, periodLabel, fileName, sourceType, transcriptText, result }) {
  const report = result?.projectReport || {};
  const segments = Array.isArray(result?.segments) ? result.segments : [];
  const risks = Array.isArray(report?.risks) ? report.risks : [];
  const healthAreas = report?.healthAreas && typeof report.healthAreas === 'object' ? report.healthAreas : {};
  const name = projectName || 'Project update test';
  const label = periodLabel || currentQuarterLabel();
  const source = ['text', 'docx', 'txt', 'csv'].includes(sourceType) ? sourceType : 'text';
  const transcript = transcriptText || '';
  const transcriptSha = require('crypto').createHash('sha256').update(transcript, 'utf8').digest('hex');

  const healthValues = ['scope', 'schedule', 'financial', 'resources', 'other_issue_risk'].map((area) => {
    const detail = healthAreas[area] || {};
    return {
      area,
      status: detail.status || (area === 'schedule' ? toHealthAreaStatus(report.overallHealthRag) : 'unknown'),
      trend: detail.trend || 'stable',
      confidence: clampConfidence(detail.confidence, area === 'schedule' ? 0.7 : 0.45),
      rationale: Array.isArray(detail.evidence) && detail.evidence[0] ? detail.evidence[0].text : ''
    };
  });

  const parseOptionalId = (out) => {
    const line = String(out || '').split('\n').find((item) => /^\d+$/.test(item));
    const id = Number(line);
    return Number.isFinite(id) && id > 0 ? id : null;
  };
  const parseId = (out, labelName) => {
    const id = parseOptionalId(out);
    if (!Number.isFinite(id) || id <= 0) {
      throw new Error(`Could not save project update draft: missing ${labelName} id.`);
    }
    return id;
  };

  let projectId = parseOptionalId(
    await runPsql(`SELECT id::text FROM projects WHERE project_name = ${q(name)} ORDER BY id LIMIT 1;`),
  );
  if (!projectId) {
    projectId = parseId(
      await runPsql(`INSERT INTO projects (project_name, description, status, updated_at)
        VALUES (${q(name)}, 'Created from /project-update-test workflow.', 'active', NOW())
        RETURNING id::text;`),
      'project'
    );
  }

  let reportingPeriodId = parseOptionalId(
    await runPsql(`SELECT id::text FROM project_reporting_periods
      WHERE project_id = ${projectId} AND period_type = 'quarter' AND period_label = ${q(label)}
      ORDER BY id
      LIMIT 1;`)
  );
  if (!reportingPeriodId) {
    reportingPeriodId = parseId(
      await runPsql(`INSERT INTO project_reporting_periods (project_id, period_type, period_label, start_date, end_date)
        VALUES (${projectId}, 'quarter', ${q(label)}, ${q(quarterStartDate(label))}::date, ${q(quarterEndDate(label))}::date)
        ON CONFLICT (project_id, period_type, period_label) DO UPDATE SET period_label = EXCLUDED.period_label
        RETURNING id::text;`),
      'reporting period'
    );
  }

  const reportId = parseId(
    await runPsql(`INSERT INTO project_reports (project_id, reporting_period_id, file_name, report_status, include_in_global_analysis, updated_at)
      VALUES (${projectId}, ${reportingPeriodId}, ${q(fileName || '')}, 'draft', FALSE, NOW())
      RETURNING id::text;`),
    'report'
  );
  const reportVersionId = parseId(
    await runPsql(`INSERT INTO project_report_versions (report_id, version_number, change_type, change_summary, saved_by, report_payload)
      VALUES (${reportId}, 1, 'ai_generated', 'Initial AI-generated draft from /project-update-test.', 'OpenClaw', ${qJson(result)})
      RETURNING id::text;`),
    'report version'
  );
  await runPsql(`INSERT INTO project_report_sources (report_id, source_type, file_name, transcript_text, transcript_length, transcript_sha256)
    VALUES (${reportId}, ${q(source)}, ${q(fileName || '')}, ${q(transcript)}, LENGTH(${q(transcript)}), ${q(transcriptSha)});`);

  for (const item of healthValues) {
    await runPsql(`INSERT INTO project_report_health (report_version_id, area, status, trend, confidence, rationale)
      VALUES (${reportVersionId}, ${q(item.area)}, ${q(item.status)}, ${q(item.trend)}, ${clampConfidence(item.confidence)}, ${q(item.rationale)});`);
  }

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] || {};
    const milestoneName = segment.milestone || `Milestone ${index + 1}`;
    const milestoneOut = await runPsql(`
WITH existing AS (
  SELECT id FROM project_core_milestones
  WHERE project_id = ${projectId} AND milestone_name = ${q(milestoneName)} AND is_active = TRUE
  ORDER BY id
  LIMIT 1
), inserted AS (
  INSERT INTO project_core_milestones (project_id, reporting_period_id, category, milestone_name, sort_order, is_active)
  SELECT ${projectId}, ${reportingPeriodId}, 'Transcript', ${q(milestoneName)}, ${index}, TRUE
  WHERE NOT EXISTS (SELECT 1 FROM existing)
  RETURNING id
)
SELECT id::text FROM inserted
UNION ALL
SELECT id::text FROM existing
LIMIT 1;`);
    const milestoneId = Number(milestoneOut.split('\n').find((item) => /^\d+$/.test(item)));
    await runPsql(`INSERT INTO project_report_milestone_assessments
      (report_version_id, milestone_id, status, trend, confidence, summary)
      VALUES (${reportVersionId}, ${milestoneId}, ${q(toMilestoneAssessmentStatus(segment.delivery_status))}, 'stable', ${clampConfidence(segment.delivery_status_confidence || segment.confidence)}, ${q(segment.normalised_evidence_summary || segment.excerpt || segment.status_resolution_note || '')});`);
    const evidence = Array.isArray(segment.semantic_evidence) && segment.semantic_evidence.length
      ? segment.semantic_evidence
      : (segment.evidence || []).slice(0, 3).map((text) => ({ text, confidence: segment.confidence || 0.5 }));
    for (const evidenceItem of evidence.slice(0, 3)) {
      await runPsql(`INSERT INTO project_report_evidence
        (report_version_id, linked_type, linked_id, evidence_text, speaker, turn_index, confidence)
        VALUES (${reportVersionId}, 'milestone', ${milestoneId}, ${q(evidenceItem.text || '')}, ${q(evidenceItem.speaker || '')}, ${Number.isFinite(Number(evidenceItem.turnIndex)) ? Number(evidenceItem.turnIndex) : 'NULL'}, ${clampConfidence(evidenceItem.score || evidenceItem.confidence || segment.confidence)});`);
    }
  }

  for (const risk of risks.slice(0, 10)) {
    await runPsql(`INSERT INTO project_ai_risk_suggestions
      (report_version_id, risk_title, description, suggested_mitigation, confidence, review_status)
      VALUES (${reportVersionId}, ${q(risk.riskTitle || 'Project risk')}, ${q(risk.description || '')}, ${q(risk.suggestedMitigation || '')}, ${clampConfidence(risk.confidence)}, 'pending');`);
  }

  return {
    saved: true,
    projectId,
    reportingPeriodId,
    reportId,
    reportVersionId,
    periodLabel: label
  };
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

async function createAuthUser({ email, fullName, passwordSalt, passwordHash }) {
  const sql = `INSERT INTO auth_users (email, full_name, password_salt, password_hash) VALUES (${q(email.toLowerCase())}, ${q(fullName || '')}, ${q(passwordSalt)}, ${q(passwordHash)}) RETURNING id::text, email, full_name;`;
  const out = await runPsql(sql);
  const [id, userEmail, name] = (out.split('\n').find(Boolean) || '||').split('|');
  return { id: Number(id), email: userEmail, fullName: name };
}

async function findAuthUserByEmail(email) {
  const sql = `SELECT id::text, email, full_name, password_salt, password_hash, is_active::text FROM auth_users WHERE email = ${q(String(email || '').toLowerCase())} LIMIT 1;`;
  const out = await runPsql(sql);
  const line = out.split('\n').find(Boolean);
  if (!line) return null;
  const [id, userEmail, fullName, passwordSalt, passwordHash, isActive] = line.split('|');
  return { id: Number(id), email: userEmail, fullName, passwordSalt, passwordHash, isActive: isActive === 't' };
}

async function touchAuthLastLogin(userId) {
  await runPsql(`UPDATE auth_users SET last_login_at = NOW(), updated_at = NOW() WHERE id = ${Number(userId)};`);
}

async function createPasswordResetToken(userId, resetToken) {
  await runPsql(`INSERT INTO auth_password_reset_tokens (user_id, reset_token, expires_at) VALUES (${Number(userId)}, ${q(resetToken)}, NOW() + INTERVAL '30 minutes');`);
}

async function consumePasswordResetToken(resetToken) {
  const sql = `UPDATE auth_password_reset_tokens SET used_at = NOW() WHERE id = (SELECT id FROM auth_password_reset_tokens WHERE reset_token = ${q(resetToken)} AND used_at IS NULL AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1) RETURNING user_id::text;`;
  const out = await runPsql(sql);
  const line = out.split('\n').find(Boolean);
  return line ? { userId: Number(line) } : null;
}

async function updateAuthPassword(userId, salt, hash) {
  await runPsql(`UPDATE auth_users SET password_salt = ${q(salt)}, password_hash = ${q(hash)}, updated_at = NOW() WHERE id = ${Number(userId)};`);
}

module.exports = {
  testConnection,
  listMeetings,
  getMeetingById,
  deleteMeetingById,
  updateMeetingById,
  saveUploadedJob,
  saveMeetingMinutes,
  saveProjectUpdateDraft,
  getMeetingStatus,
  claimNextJob,
  markJobCompleted,
  markJobFailure,
  queueWebhookJob,
  markWebhookSuccess,
  markWebhookFailure,
  hasDatabaseConfig,
  getDatabaseConfigError,
  runPsql,
  createAuthUser,
  findAuthUserByEmail,
  touchAuthLastLogin,
  createPasswordResetToken,
  consumePasswordResetToken,
  updateAuthPassword
};
