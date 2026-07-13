const { Pool } = require('pg');

let pgPool = null;

function getPgPool() {
  if (!pgPool) {
    pgPool = new Pool({
      connectionString: process.env.DATABASE_URL || undefined,
      host: process.env.DATABASE_URL ? undefined : process.env.PGHOST,
      port: process.env.DATABASE_URL ? undefined : Number(process.env.PGPORT || 5432),
      database: process.env.DATABASE_URL ? undefined : process.env.PGDATABASE,
      user: process.env.DATABASE_URL ? undefined : process.env.PGUSER,
      password: process.env.DATABASE_URL ? undefined : process.env.PGPASSWORD,
      max: Number(process.env.PGPOOL_MAX || 5),
      connectionTimeoutMillis: Number(process.env.PGCONNECT_TIMEOUT_MS || 5000),
      idleTimeoutMillis: Number(process.env.PGIDLE_TIMEOUT_MS || 30000)
    });
  }
  return pgPool;
}

function hasDatabaseConfig() {
  return Boolean(
    process.env.DATABASE_URL ||
    (process.env.PGHOST && process.env.PGPORT && process.env.PGDATABASE && process.env.PGUSER && process.env.PGPASSWORD)
  );
}

function getDatabaseConfigError() {
  return 'Database configuration missing. Set DATABASE_URL or PGHOST, PGPORT, PGDATABASE, PGUSER, and PGPASSWORD.';
}

async function query(sql, params = []) {
  if (!hasDatabaseConfig()) {
    throw new Error(getDatabaseConfigError());
  }
  return getPgPool().query(sql, params);
}

// pg's parameterized (extended) query protocol only allows a single statement
// per call, so anything needing more than one parameterized statement in one
// atomic unit (e.g. updating two tables together) must go through a real
// transaction like this rather than a semicolon-joined multi-statement string.
async function withTransaction(fn) {
  if (!hasDatabaseConfig()) {
    throw new Error(getDatabaseConfigError());
  }
  const client = await getPgPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function formatPgValue(value) {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

async function runPsql(sql, params = []) {
  const result = await query(sql, params);
  const results = Array.isArray(result) ? result : [result];
  return results
    .flatMap((item) => item.rows || [])
    .map((row) => Object.values(row).map(formatPgValue).join('|'))
    .join('\n')
    .trim();
}

async function testConnection() {
  const out = await runPsql('SELECT NOW()::text');
  return out.split('\n')[0] || null;
}

// toDateParam is the parameterized-query equivalent of qDate: pass the result
// as a query param and cast with ::date in the SQL text (a null param casts to
// SQL NULL cleanly). q/qJson/qDate remain for any call sites not yet migrated.
function toDateParam(value) {
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function q(value) { return `'${String(value || '').replace(/'/g, "''")}'`; }
function qJson(value) { return `'${JSON.stringify(value || {}).replace(/'/g, "''")}'::jsonb`; }
function qDate(value) {
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${q(text)}::date` : 'NULL';
}

function parseJsonLines(out) {
  return String(out || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{') || line.startsWith('['))
    .map((line) => JSON.parse(line));
}

function parseOptionalId(out) {
  const line = String(out || '').split('\n').find((item) => /^\d+$/.test(item));
  const id = Number(line);
  return Number.isFinite(id) && id > 0 ? id : null;
}

async function listProjectReports(limit = 50, filters = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const projectId = Number(filters.projectId || 0);
  const projectFilter = Number.isFinite(projectId) && projectId > 0 ? `WHERE r.project_id = ${projectId}` : '';
  const out = await runPsql(`
SELECT json_build_object(
  'reportId', r.id,
  'projectId', p.id,
  'projectName', p.project_name,
  'periodLabel', COALESCE(rp.period_label, ''),
  'fileName', COALESCE(r.file_name, ''),
  'reportName', COALESCE(NULLIF(r.file_name, ''), 'Report ' || r.id::text),
  'reportStatus', r.report_status,
  'createdAt', r.created_at,
  'updatedAt', r.updated_at,
  'latestVersionId', v.id,
  'latestVersionNumber', v.version_number,
  'overallHealth', COALESCE(v.report_payload->'projectReport'->>'overallHealth', ''),
  'summary', COALESCE(v.report_payload->'projectReport'->>'summary', '')
)::text
FROM project_reports r
JOIN projects p ON p.id = r.project_id
LEFT JOIN project_reporting_periods rp ON rp.id = r.reporting_period_id
LEFT JOIN LATERAL (
  SELECT id, version_number, report_payload
  FROM project_report_versions
  WHERE report_id = r.id
  ORDER BY version_number DESC, id DESC
  LIMIT 1
) v ON TRUE
${projectFilter}
ORDER BY r.created_at DESC, r.id DESC
LIMIT ${safeLimit};`);
  return parseJsonLines(out);
}

async function getProjectReportDetail(reportId) {
  const out = await runPsql(`
SELECT json_build_object(
  'reportId', r.id,
  'projectId', p.id,
  'projectName', p.project_name,
  'periodLabel', COALESCE(rp.period_label, ''),
  'fileName', COALESCE(r.file_name, ''),
  'reportName', COALESCE(NULLIF(r.file_name, ''), 'Report ' || r.id::text),
  'reportStatus', r.report_status,
  'createdAt', r.created_at,
  'updatedAt', r.updated_at,
  'source', (
    SELECT json_build_object(
      'sourceType', source_type,
      'fileName', COALESCE(file_name, ''),
      'transcriptText', COALESCE(transcript_text, ''),
      'transcriptLength', transcript_length,
      'transcriptSha256', COALESCE(transcript_sha256, '')
    )
    FROM project_report_sources
    WHERE report_id = r.id
    ORDER BY id DESC
    LIMIT 1
  ),
  'versions', COALESCE((
    SELECT json_agg(json_build_object(
      'versionId', id,
      'versionNumber', version_number,
      'changeType', change_type,
      'changeSummary', COALESCE(change_summary, ''),
      'savedBy', COALESCE(saved_by, ''),
      'createdAt', created_at,
      'payload', report_payload
    ) ORDER BY version_number DESC, id DESC)
    FROM project_report_versions
    WHERE report_id = r.id
  ), '[]'::json)
)::text
FROM project_reports r
JOIN projects p ON p.id = r.project_id
LEFT JOIN project_reporting_periods rp ON rp.id = r.reporting_period_id
WHERE r.id = ${Number(reportId)}
LIMIT 1;`);
  return parseJsonLines(out)[0] || null;
}

async function saveProjectReportDetail(reportId, payload = {}) {
  const id = Number(reportId);
  if (!Number.isFinite(id) || id <= 0) {
    const error = new Error('Valid report id is required.');
    error.statusCode = 400;
    throw error;
  }

  const existing = await getProjectReportDetail(id);
  if (!existing) return null;

  const latest = Array.isArray(existing.versions) && existing.versions[0] ? existing.versions[0] : {};
  const latestPayload = latest.payload && typeof latest.payload === 'object' ? latest.payload : {};
  const projectReport = payload.projectReport && typeof payload.projectReport === 'object'
    ? payload.projectReport
    : latestPayload.projectReport;
  if (!projectReport || typeof projectReport !== 'object') {
    const error = new Error('Project report payload is required.');
    error.statusCode = 400;
    throw error;
  }

  const allowedStatuses = new Set(['draft', 'in_review', 'approved', 'archived']);
  const requestedStatus = String(payload.reportStatus || projectReport.reportStatus || existing.reportStatus || 'draft').trim();
  const reportStatus = allowedStatuses.has(requestedStatus) ? requestedStatus : 'draft';
  const reportName = Object.prototype.hasOwnProperty.call(payload, 'reportName')
    ? String(payload.reportName || '').trim()
    : String(existing.reportName || existing.fileName || '').trim();
  const nextVersion = Number(latest.versionNumber || 0) + 1;
  const nextPayload = {
    ...latestPayload,
    projectReport: {
      ...projectReport,
      reportStatus,
      updatedAt: new Date().toISOString()
    }
  };

  const isApproved = reportStatus === 'approved';
  const client = await getPgPool().connect();
  let newVersionId = null;
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE project_reports
       SET report_status = $1,
           file_name = $2,
           approved_at = CASE WHEN $1 = 'approved' THEN COALESCE(approved_at, NOW()) ELSE approved_at END,
           approved_by = CASE WHEN $1 = 'approved' THEN $3 ELSE approved_by END,
           updated_at = NOW()
       WHERE id = $4`,
      [reportStatus, reportName || `Report ${id}`, payload.savedBy || 'OpenClaw', id]
    );
    const inserted = await client.query(
      `INSERT INTO project_report_versions (report_id, version_number, change_type, change_summary, saved_by, report_payload)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [id, nextVersion, isApproved ? 'approved' : 'user_edit', payload.changeSummary || 'Saved from report detail page.', payload.savedBy || 'OpenClaw', JSON.stringify(nextPayload)]
    );
    newVersionId = inserted.rows[0].id;
    if (isApproved) {
      await client.query('UPDATE project_reports SET approved_version_id = $1 WHERE id = $2', [newVersionId, id]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  const saved = await getProjectReportDetail(id);
  if (isApproved) {
    saved.knowledgeIngestion = await ingestApprovedProjectReportVersion({
      projectId: saved.projectId,
      reportId: saved.reportId,
      reportVersionId: newVersionId || Number(saved?.versions?.[0]?.versionId || 0),
      periodLabel: saved.periodLabel,
      payload: nextPayload,
      createdAt: saved.updatedAt || saved.createdAt
    });
  }
  return saved;
}

async function deleteProjectReport(reportId) {
  const id = Number(reportId);
  if (!Number.isFinite(id) || id <= 0) {
    const error = new Error('Valid report id is required.');
    error.statusCode = 400;
    throw error;
  }

  const existing = await getProjectReportDetail(id);
  if (!existing) return null;

  await runPsql(`
BEGIN;
UPDATE project_reports SET approved_version_id = NULL WHERE id = ${id};
DELETE FROM project_reports WHERE id = ${id};
COMMIT;`);

  return existing;
}

async function deleteProjectReports(reportIds = []) {
  const ids = Array.from(new Set((Array.isArray(reportIds) ? reportIds : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0)));
  if (!ids.length) {
    const error = new Error('At least one valid report id is required.');
    error.statusCode = 400;
    throw error;
  }
  if (ids.length > 100) {
    const error = new Error('Bulk delete is limited to 100 reports at a time.');
    error.statusCode = 400;
    throw error;
  }

  const idList = ids.join(',');
  const out = await runPsql(`
WITH selected AS (
  SELECT json_build_object(
    'reportId', r.id,
    'projectId', p.id,
    'projectName', p.project_name,
    'periodLabel', COALESCE(rp.period_label, ''),
    'fileName', COALESCE(r.file_name, ''),
    'reportName', COALESCE(NULLIF(r.file_name, ''), 'Report ' || r.id::text),
    'reportStatus', r.report_status,
    'createdAt', r.created_at,
    'updatedAt', r.updated_at
  ) AS report
  FROM project_reports r
  JOIN projects p ON p.id = r.project_id
  LEFT JOIN project_reporting_periods rp ON rp.id = r.reporting_period_id
  WHERE r.id IN (${idList})
), cleared AS (
  UPDATE project_reports
  SET approved_version_id = NULL
  WHERE id IN (${idList})
  RETURNING id
), deleted AS (
  DELETE FROM project_reports
  WHERE id IN (${idList})
  RETURNING id
)
SELECT json_build_object(
  'requestedIds', ARRAY[${idList}],
  'deletedCount', (SELECT COUNT(*) FROM deleted),
  'reports', COALESCE((SELECT json_agg(report ORDER BY (report->>'reportId')::int) FROM selected), '[]'::json)
)::text;
`);
  return parseJsonLines(out)[0] || { requestedIds: ids, deletedCount: 0, reports: [] };
}

async function listProjectMilestones(limit = 100, filters = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 250);
  const projectId = Number(filters.projectId || 0);
  const projectFilter = Number.isFinite(projectId) && projectId > 0 ? `AND m.project_id = ${projectId}` : '';
  const out = await runPsql(`
SELECT json_build_object(
  'milestoneId', m.id,
  'projectId', p.id,
  'projectName', p.project_name,
  'periodLabel', COALESCE(rp.period_label, ''),
  'category', m.category,
  'milestoneName', m.milestone_name,
  'description', COALESCE(m.description, ''),
  'baselineFinishDate', m.baseline_finish_date,
  'forecastFinishDate', m.forecast_finish_date,
  'isOfficial', m.is_official,
  'officialLabel', COALESCE(m.official_label, ''),
  'officialAt', m.official_at,
  'sortOrder', m.sort_order,
  'latestAssessment', latest.assessment
)::text
FROM project_core_milestones m
JOIN projects p ON p.id = m.project_id
LEFT JOIN project_reporting_periods rp ON rp.id = m.reporting_period_id
LEFT JOIN LATERAL (
  SELECT json_build_object(
    'status', a.status,
    'trend', a.trend,
    'confidence', a.confidence,
    'summary', COALESCE(a.summary, ''),
    'forecastFinishDate', a.forecast_finish_date,
    'reportVersionId', a.report_version_id,
    'createdAt', v.created_at
  ) AS assessment
  FROM project_report_milestone_assessments a
  JOIN project_report_versions v ON v.id = a.report_version_id
  JOIN project_reports r ON r.id = v.report_id
  WHERE a.milestone_id = m.id
    AND r.report_status <> 'archived'
  ORDER BY v.created_at DESC, a.id DESC
  LIMIT 1
) latest ON TRUE
WHERE m.is_active = TRUE
${projectFilter}
ORDER BY p.project_name, rp.start_date DESC NULLS LAST, m.sort_order, m.id
LIMIT ${safeLimit};`);
  return parseJsonLines(out);
}

async function getProjectMilestoneDetail(milestoneId) {
  const out = await runPsql(`
SELECT json_build_object(
  'milestoneId', m.id,
  'projectId', p.id,
  'projectName', p.project_name,
  'periodLabel', COALESCE(rp.period_label, ''),
  'category', m.category,
  'milestoneName', m.milestone_name,
  'description', COALESCE(m.description, ''),
  'baselineFinishDate', m.baseline_finish_date,
  'forecastFinishDate', m.forecast_finish_date,
  'isOfficial', m.is_official,
  'officialLabel', COALESCE(m.official_label, ''),
  'officialAt', m.official_at,
  'sortOrder', m.sort_order,
  'assessments', COALESCE((
    SELECT json_agg(json_build_object(
      'assessmentId', a.id,
      'reportVersionId', a.report_version_id,
      'reportId', v.report_id,
      'status', a.status,
      'trend', a.trend,
      'confidence', a.confidence,
      'summary', COALESCE(a.summary, ''),
      'forecastFinishDate', a.forecast_finish_date,
      'createdAt', v.created_at,
      'evidence', COALESCE((
        SELECT json_agg(json_build_object(
          'evidenceText', evidence_text,
          'speaker', COALESCE(speaker, ''),
          'turnIndex', turn_index,
          'confidence', confidence
        ) ORDER BY id)
        FROM project_report_evidence
        WHERE report_version_id = a.report_version_id
          AND linked_type = 'milestone'
          AND linked_id = m.id
      ), '[]'::json)
    ) ORDER BY v.created_at DESC, a.id DESC)
    FROM project_report_milestone_assessments a
    JOIN project_report_versions v ON v.id = a.report_version_id
    WHERE a.milestone_id = m.id
  ), '[]'::json)
)::text
FROM project_core_milestones m
JOIN projects p ON p.id = m.project_id
LEFT JOIN project_reporting_periods rp ON rp.id = m.reporting_period_id
WHERE m.id = ${Number(milestoneId)} AND m.is_active = TRUE
LIMIT 1;`);
  return parseJsonLines(out)[0] || null;
}

async function createProjectMilestone(payload = {}) {
  const milestoneName = String(payload.milestoneName || '').trim();
  if (!milestoneName) {
    const error = new Error('Milestone name is required.');
    error.statusCode = 400;
    throw error;
  }

  const projectName = String(payload.projectName || process.env.PROJECT_UPDATE_DEFAULT_PROJECT || 'Project update test').trim() || 'Project update test';
  const periodLabel = String(payload.periodLabel || currentQuarterLabel()).trim() || currentQuarterLabel();
  const category = String(payload.category || 'Manual').trim() || 'Manual';
  const description = String(payload.description || '').trim();
  const baselineFinishDate = payload.baselineFinishDate || payload.baseline_finish_date || payload.deadline || '';
  const forecastFinishDate = payload.forecastFinishDate || payload.forecast_finish_date || payload.deadline || '';

  let projectId = parseOptionalId(
    await runPsql('SELECT id::text FROM projects WHERE project_name = $1 ORDER BY id LIMIT 1', [projectName])
  );
  if (!projectId) {
    projectId = parseOptionalId(
      await runPsql(
        `INSERT INTO projects (project_name, description, status, updated_at)
         VALUES ($1, 'Created from /project-update-test milestones.', 'active', NOW())
         RETURNING id::text`,
        [projectName]
      )
    );
  }
  if (!projectId) throw new Error('Could not create project milestone: missing project id.');

  let reportingPeriodId = parseOptionalId(
    await runPsql(
      `SELECT id::text FROM project_reporting_periods
       WHERE project_id = $1 AND period_type = 'quarter' AND period_label = $2
       ORDER BY id
       LIMIT 1`,
      [projectId, periodLabel]
    )
  );
  if (!reportingPeriodId) {
    reportingPeriodId = parseOptionalId(
      await runPsql(
        `INSERT INTO project_reporting_periods (project_id, period_type, period_label, start_date, end_date)
         VALUES ($1, 'quarter', $2, $3::date, $4::date)
         ON CONFLICT (project_id, period_type, period_label) DO UPDATE SET period_label = EXCLUDED.period_label
         RETURNING id::text`,
        [projectId, periodLabel, quarterStartDate(periodLabel), quarterEndDate(periodLabel)]
      )
    );
  }
  if (!reportingPeriodId) throw new Error('Could not create project milestone: missing reporting period id.');

  const out = await runPsql(
    `WITH existing AS (
  SELECT id
  FROM project_core_milestones
  WHERE project_id = $1 AND milestone_name = $2 AND is_active = TRUE
  ORDER BY id
  LIMIT 1
), inserted AS (
  INSERT INTO project_core_milestones (project_id, reporting_period_id, category, milestone_name, description, baseline_finish_date, forecast_finish_date, sort_order, is_active)
  SELECT $1, $3, $4, $2, $5, $6::date, $7::date,
    COALESCE((SELECT MAX(sort_order) + 1 FROM project_core_milestones WHERE project_id = $1), 0), TRUE
  WHERE NOT EXISTS (SELECT 1 FROM existing)
  RETURNING id
), updated AS (
  UPDATE project_core_milestones
  SET reporting_period_id = $3,
      category = $4,
      description = $5,
      baseline_finish_date = COALESCE($6::date, baseline_finish_date),
      forecast_finish_date = COALESCE($7::date, forecast_finish_date)
  WHERE id IN (SELECT id FROM existing)
  RETURNING id
)
SELECT id::text || '|' || created::text
FROM (
  SELECT id, TRUE AS created FROM inserted
  UNION ALL
  SELECT id, FALSE AS created FROM updated
  UNION ALL
  SELECT id, FALSE AS created FROM existing
  LIMIT 1
) selected`,
    [projectId, milestoneName, reportingPeriodId, category, description, toDateParam(baselineFinishDate), toDateParam(forecastFinishDate)]
  );

  const [milestoneId, created] = (out.split('\n').find((line) => /^\d+\|/.test(line)) || '|').split('|');
  const milestone = await getProjectMilestoneDetail(milestoneId);
  return milestone ? { ...milestone, created: created === 't' || created === 'true' } : null;
}

async function updateProjectMilestone(milestoneId, payload = {}) {
  const id = Number(milestoneId);
  if (!Number.isFinite(id) || id <= 0) {
    const error = new Error('Valid milestone id is required.');
    error.statusCode = 400;
    throw error;
  }

  const existing = await getProjectMilestoneDetail(id);
  if (!existing) return null;

  const baselineFinishDate = Object.prototype.hasOwnProperty.call(payload, 'baselineFinishDate')
    ? payload.baselineFinishDate
    : (Object.prototype.hasOwnProperty.call(payload, 'baseline_finish_date') ? payload.baseline_finish_date : existing.baselineFinishDate);
  const forecastFinishDate = Object.prototype.hasOwnProperty.call(payload, 'forecastFinishDate')
    ? payload.forecastFinishDate
    : (Object.prototype.hasOwnProperty.call(payload, 'forecast_finish_date') ? payload.forecast_finish_date : existing.forecastFinishDate);
  const description = Object.prototype.hasOwnProperty.call(payload, 'description')
    ? String(payload.description || '').trim()
    : existing.description;
  await runPsql(
    `UPDATE project_core_milestones
     SET baseline_finish_date = $1::date,
         forecast_finish_date = $2::date,
         description = $3
     WHERE id = $4 AND is_active = TRUE`,
    [toDateParam(baselineFinishDate), toDateParam(forecastFinishDate), description, id]
  );

  return getProjectMilestoneDetail(id);
}

async function deleteProjectMilestone(milestoneId) {
  const id = Number(milestoneId);
  if (!Number.isFinite(id) || id <= 0) {
    const error = new Error('Valid milestone id is required.');
    error.statusCode = 400;
    throw error;
  }

  const existing = await getProjectMilestoneDetail(id);
  if (!existing) return null;

  await runPsql(`UPDATE project_core_milestones SET is_active = FALSE WHERE id = ${id} AND is_active = TRUE;`);
  return existing;
}

async function deactivateProjectMilestones(milestoneIds = []) {
  const ids = Array.from(new Set((Array.isArray(milestoneIds) ? milestoneIds : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0)));
  if (!ids.length) {
    const error = new Error('At least one valid milestone id is required.');
    error.statusCode = 400;
    throw error;
  }
  if (ids.length > 100) {
    const error = new Error('Bulk milestone inactivation is limited to 100 milestones at a time.');
    error.statusCode = 400;
    throw error;
  }

  const idList = ids.join(',');
  const out = await runPsql(`
WITH selected AS (
  SELECT json_build_object(
    'milestoneId', m.id,
    'projectId', p.id,
    'projectName', p.project_name,
    'periodLabel', COALESCE(rp.period_label, ''),
    'category', m.category,
    'milestoneName', m.milestone_name,
    'description', COALESCE(m.description, ''),
    'baselineFinishDate', m.baseline_finish_date,
    'forecastFinishDate', m.forecast_finish_date,
    'isOfficial', m.is_official,
    'officialLabel', COALESCE(m.official_label, ''),
    'officialAt', m.official_at,
    'sortOrder', m.sort_order
  ) AS milestone
  FROM project_core_milestones m
  JOIN projects p ON p.id = m.project_id
  LEFT JOIN project_reporting_periods rp ON rp.id = m.reporting_period_id
  WHERE m.id IN (${idList}) AND m.is_active = TRUE
), updated AS (
  UPDATE project_core_milestones
  SET is_active = FALSE
  WHERE id IN (${idList}) AND is_active = TRUE
  RETURNING id
)
SELECT json_build_object(
  'requestedIds', ARRAY[${idList}],
  'deactivatedCount', (SELECT COUNT(*) FROM updated),
  'milestones', COALESCE((SELECT json_agg(milestone ORDER BY (milestone->>'milestoneId')::int) FROM selected), '[]'::json)
)::text;
`);
  return parseJsonLines(out)[0] || { requestedIds: ids, deactivatedCount: 0, milestones: [] };
}



function normaliseProjectTrend(value) {
  const trend = String(value || '').trim().toLowerCase();
  return ['improving', 'stable', 'deteriorating', 'replanned', 'new_update', 'new_risk', 'resolved', 'unknown'].includes(trend)
    ? trend
    : 'unknown';
}

function projectContextItemKey(value, fallback = 'item') {
  const key = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return key || fallback;
}

function projectContextScopedItemKey(value, fallback = 'item') {
  const key = projectContextItemKey(value, fallback);
  const suffix = projectContextItemKey(fallback, 'item');
  return suffix && key !== suffix ? `${key}_${suffix}` : key;
}

function truthy(value) {
  if (Array.isArray(value)) return value.some((item) => truthy(item));
  if (value == null) return false;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function normaliseProjectRef(projectRef = '') {
  if (projectRef && typeof projectRef === 'object') {
    return {
      projectId: Number(projectRef.projectId || 0),
      projectName: String(projectRef.projectName || projectRef.name || '').trim()
    };
  }
  return { projectId: 0, projectName: String(projectRef || '').trim() };
}

async function listProjectOptions(limit = 100) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const out = await runPsql(`
SELECT json_build_object(
  'projectId', p.id,
  'projectName', p.project_name,
  'clientName', COALESCE(p.client_name, ''),
  'description', COALESCE(p.description, ''),
  'status', p.status,
  'updatedAt', p.updated_at,
  'createdAt', p.created_at,
  'activeMilestoneCount', (SELECT COUNT(*) FROM project_core_milestones m WHERE m.project_id = p.id AND m.is_active = TRUE),
  'activeRiskCount', (SELECT COUNT(*) FROM project_core_risks r WHERE r.project_id = p.id AND r.is_active = TRUE),
  'reportCount', (SELECT COUNT(*) FROM project_reports pr WHERE pr.project_id = p.id)
)::text
FROM projects p
ORDER BY p.updated_at DESC NULLS LAST, p.created_at DESC NULLS LAST, p.project_name, p.id
LIMIT ${safeLimit};`);
  return parseJsonLines(out);
}

function normaliseProjectStatus(value) {
  const status = String(value || 'active').trim().toLowerCase();
  return ['active', 'paused', 'completed', 'archived'].includes(status) ? status : 'active';
}

function projectRowToJson(row = {}) {
  return {
    projectId: Number(row.id),
    projectName: row.project_name || '',
    clientName: row.client_name || '',
    description: row.description || '',
    status: row.status || 'active',
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    activeMilestoneCount: Number(row.active_milestone_count || 0),
    activeRiskCount: Number(row.active_risk_count || 0),
    reportCount: Number(row.report_count || 0)
  };
}

async function getProjectManagementDetail(projectId) {
  const id = Number(projectId);
  if (!Number.isFinite(id) || id <= 0) return null;
  const result = await query(
    `SELECT
       p.id,
       p.project_name,
       COALESCE(p.client_name, '') AS client_name,
       COALESCE(p.description, '') AS description,
       p.status,
       p.created_at,
       p.updated_at,
       (SELECT COUNT(*) FROM project_core_milestones m WHERE m.project_id = p.id AND m.is_active = TRUE) AS active_milestone_count,
       (SELECT COUNT(*) FROM project_core_risks r WHERE r.project_id = p.id AND r.is_active = TRUE) AS active_risk_count,
       (SELECT COUNT(*) FROM project_reports pr WHERE pr.project_id = p.id) AS report_count
     FROM projects p
     WHERE p.id = $1
     LIMIT 1`,
    [id]
  );
  return result.rows[0] ? projectRowToJson(result.rows[0]) : null;
}

async function createProject(payload = {}) {
  const projectName = String(payload.projectName || payload.project_name || '').trim();
  if (!projectName) {
    const error = new Error('Project name is required.');
    error.statusCode = 400;
    throw error;
  }
  const clientName = String(payload.clientName || payload.client_name || '').trim();
  const description = String(payload.description || '').trim();
  const status = normaliseProjectStatus(payload.status);
  const result = await query(
    `INSERT INTO projects (project_name, client_name, description, status, updated_at)
     VALUES ($1, NULLIF($2, ''), NULLIF($3, ''), $4, NOW())
     RETURNING id`,
    [projectName, clientName, description, status]
  );
  return getProjectManagementDetail(result.rows[0].id);
}

async function updateProject(projectId, payload = {}) {
  const id = Number(projectId);
  if (!Number.isFinite(id) || id <= 0) {
    const error = new Error('Valid project id is required.');
    error.statusCode = 400;
    throw error;
  }
  const projectName = String(payload.projectName || payload.project_name || '').trim();
  if (!projectName) {
    const error = new Error('Project name is required.');
    error.statusCode = 400;
    throw error;
  }
  const clientName = String(payload.clientName || payload.client_name || '').trim();
  const description = String(payload.description || '').trim();
  const status = normaliseProjectStatus(payload.status);
  const result = await query(
    `UPDATE projects
     SET project_name = $1,
         client_name = NULLIF($2, ''),
         description = NULLIF($3, ''),
         status = $4,
         updated_at = NOW()
     WHERE id = $5
     RETURNING id`,
    [projectName, clientName, description, status, id]
  );
  if (!result.rowCount) {
    const error = new Error('Project not found.');
    error.statusCode = 404;
    throw error;
  }
  return getProjectManagementDetail(id);
}

async function deleteProject(projectId) {
  const existing = await getProjectManagementDetail(projectId);
  if (!existing) return null;
  await query('DELETE FROM projects WHERE id = $1', [existing.projectId]);
  return existing;
}

async function resolveProjectForContext(projectRef = '') {
  const ref = normaliseProjectRef(projectRef);
  const fallbackName = process.env.PROJECT_UPDATE_DEFAULT_PROJECT || 'Project update test';
  const name = ref.projectName || fallbackName;

  if (Number.isFinite(ref.projectId) && ref.projectId > 0) {
    const project = parseJsonLines(await runPsql(
      `SELECT json_build_object(
  'projectId', id,
  'projectName', project_name,
  'clientName', COALESCE(client_name, ''),
  'description', COALESCE(description, ''),
  'status', status,
  'createdAt', created_at,
  'updatedAt', updated_at
)::text
FROM projects
WHERE id = $1
LIMIT 1`,
      [Number(ref.projectId)]
    ))[0] || null;
    return {
      project,
      projectName: project?.projectName || name,
      projectResolution: { matchedBy: project ? 'id' : 'id_not_found', candidates: project ? 1 : 0, projectId: project?.projectId || ref.projectId }
    };
  }

  const candidates = parseJsonLines(await runPsql(
    `SELECT json_build_object(
  'projectId', p.id,
  'projectName', p.project_name,
  'clientName', COALESCE(p.client_name, ''),
  'description', COALESCE(p.description, ''),
  'status', p.status,
  'createdAt', p.created_at,
  'updatedAt', p.updated_at,
  'activeMilestoneCount', (SELECT COUNT(*) FROM project_core_milestones m WHERE m.project_id = p.id AND m.is_active = TRUE),
  'activeRiskCount', (SELECT COUNT(*) FROM project_core_risks r WHERE r.project_id = p.id AND r.is_active = TRUE),
  'reportCount', (SELECT COUNT(*) FROM project_reports pr WHERE pr.project_id = p.id)
)::text
FROM projects p
WHERE p.project_name = $1
ORDER BY
  (SELECT COUNT(*) FROM project_core_milestones m WHERE m.project_id = p.id AND m.is_active = TRUE) DESC,
  (SELECT COUNT(*) FROM project_core_risks r WHERE r.project_id = p.id AND r.is_active = TRUE) DESC,
  (SELECT COUNT(*) FROM project_reports pr WHERE pr.project_id = p.id) DESC,
  p.updated_at DESC NULLS LAST,
  p.created_at DESC NULLS LAST,
  p.id`,
    [name]
  ));
  const project = candidates[0] || null;
  return {
    project,
    projectName: name,
    projectResolution: {
      matchedBy: project ? 'name' : 'none',
      candidates: candidates.length,
      projectId: project?.projectId || null,
      ambiguous: candidates.length > 1,
      candidateProjectIds: candidates.slice(0, 10).map((item) => item.projectId)
    }
  };
}

async function getProjectIdForContext(projectRef) {
  const resolved = await resolveProjectForContext(projectRef);
  return Number(resolved.project?.projectId || 0) || null;
}

async function getProjectContext(projectName = '', limit = 5) {
  const safeLimit = Math.min(Math.max(Number(limit) || 5, 1), 20);
  const { project, projectName: name, projectResolution } = await resolveProjectForContext(projectName);
  if (!project) {
    return {
      projectName: name,
      found: false,
      projectResolution,
      activeMilestones: [],
      recentReports: [],
      activeRisks: [],
      healthHistory: [],
      milestoneHistory: [],
      riskSuggestions: [],
      latestSnapshot: null,
      generatedAt: new Date().toISOString()
    };
  }
  const projectId = Number(project.projectId);

  const activeMilestones = parseJsonLines(await runPsql(`
SELECT json_build_object(
  'milestoneId', m.id,
  'milestoneName', m.milestone_name,
  'comparisonKey', regexp_replace(lower(m.milestone_name), '[^a-z0-9]+', '_', 'g'),
  'category', m.category,
  'description', COALESCE(m.description, ''),
  'baselineFinishDate', m.baseline_finish_date,
  'forecastFinishDate', m.forecast_finish_date,
  'isOfficial', m.is_official,
  'officialLabel', COALESCE(m.official_label, ''),
  'officialAt', m.official_at,
  'latestAssessment', latest.assessment,
  'previousAssessment', previous.assessment
)::text
FROM project_core_milestones m
LEFT JOIN LATERAL (
  SELECT json_build_object(
    'assessmentId', a.id,
    'reportVersionId', a.report_version_id,
    'reportId', v.report_id,
    'status', a.status,
    'trend', a.trend,
    'confidence', a.confidence,
    'summary', COALESCE(a.summary, ''),
    'forecastFinishDate', a.forecast_finish_date,
    'createdAt', v.created_at
  ) AS assessment
  FROM project_report_milestone_assessments a
  JOIN project_report_versions v ON v.id = a.report_version_id
  WHERE a.milestone_id = m.id
  ORDER BY v.created_at DESC, a.id DESC
  LIMIT 1
) latest ON TRUE
LEFT JOIN LATERAL (
  SELECT json_build_object(
    'assessmentId', a.id,
    'reportVersionId', a.report_version_id,
    'reportId', v.report_id,
    'status', a.status,
    'trend', a.trend,
    'confidence', a.confidence,
    'summary', COALESCE(a.summary, ''),
    'forecastFinishDate', a.forecast_finish_date,
    'createdAt', v.created_at
  ) AS assessment
  FROM project_report_milestone_assessments a
  JOIN project_report_versions v ON v.id = a.report_version_id
  JOIN project_reports r ON r.id = v.report_id
  WHERE a.milestone_id = m.id
    AND r.report_status <> 'archived'
    AND (latest.assessment IS NULL OR a.id <> ((latest.assessment->>'assessmentId')::BIGINT))
  ORDER BY v.created_at DESC, a.id DESC
  LIMIT 1
) previous ON TRUE
WHERE m.project_id = ${projectId} AND m.is_active = TRUE
ORDER BY m.sort_order, m.id;`));

  const activeRisks = parseJsonLines(await runPsql(`
SELECT json_build_object(
  'riskId', id,
  'projectId', project_id,
  'category', category,
  'riskTitle', risk_title,
  'description', COALESCE(description, ''),
  'mitigation', COALESCE(mitigation, ''),
  'isOfficial', is_official,
  'officialLabel', COALESCE(official_label, ''),
  'officialAt', official_at,
  'createdAt', created_at
)::text
FROM project_core_risks
WHERE project_id = ${projectId} AND is_active = TRUE
ORDER BY id;`));

  const recentReports = parseJsonLines(await runPsql(`
SELECT json_build_object(
  'reportId', r.id,
  'reportVersionId', v.id,
  'versionNumber', v.version_number,
  'periodLabel', COALESCE(rp.period_label, ''),
  'fileName', COALESCE(r.file_name, ''),
  'reportStatus', r.report_status,
  'createdAt', r.created_at,
  'updatedAt', r.updated_at,
  'versionCreatedAt', v.created_at,
  'overallHealth', COALESCE(v.report_payload->'projectReport'->>'overallHealth', ''),
  'overallHealthRag', COALESCE(v.report_payload->'projectReport'->>'overallHealthRag', ''),
  'summary', COALESCE(v.report_payload->'projectReport'->>'summary', ''),
  'comparisonSnapshot', COALESCE(v.report_payload->'projectReport'->'comparisonSnapshot', '{}'::jsonb)
)::text
FROM project_reports r
LEFT JOIN project_reporting_periods rp ON rp.id = r.reporting_period_id
JOIN LATERAL (
  SELECT id, version_number, report_payload, created_at
  FROM project_report_versions
  WHERE report_id = r.id
  ORDER BY version_number DESC, id DESC
  LIMIT 1
) v ON TRUE
WHERE r.project_id = ${projectId}
  AND r.report_status <> 'archived'
ORDER BY v.created_at DESC, r.id DESC
LIMIT ${safeLimit};`));

  const healthHistory = parseJsonLines(await runPsql(`
SELECT json_build_object(
  'area', h.area,
  'status', h.status,
  'trend', h.trend,
  'confidence', h.confidence,
  'rationale', COALESCE(h.rationale, ''),
  'reportVersionId', h.report_version_id,
  'reportId', v.report_id,
  'createdAt', v.created_at
)::text
FROM project_report_health h
JOIN project_report_versions v ON v.id = h.report_version_id
JOIN project_reports r ON r.id = v.report_id
WHERE r.project_id = ${projectId}
  AND r.report_status <> 'archived'
ORDER BY v.created_at DESC, h.area
LIMIT ${safeLimit * 5};`));

  const milestoneHistory = parseJsonLines(await runPsql(`
SELECT json_build_object(
  'milestoneId', m.id,
  'milestoneName', m.milestone_name,
  'comparisonKey', regexp_replace(lower(m.milestone_name), '[^a-z0-9]+', '_', 'g'),
  'status', a.status,
  'trend', a.trend,
  'confidence', a.confidence,
  'summary', COALESCE(a.summary, ''),
  'forecastFinishDate', a.forecast_finish_date,
  'reportVersionId', a.report_version_id,
  'reportId', v.report_id,
  'createdAt', v.created_at
)::text
FROM project_report_milestone_assessments a
JOIN project_core_milestones m ON m.id = a.milestone_id
JOIN project_report_versions v ON v.id = a.report_version_id
JOIN project_reports r ON r.id = v.report_id
WHERE r.project_id = ${projectId}
  AND r.report_status <> 'archived'
ORDER BY v.created_at DESC, a.id DESC
LIMIT ${safeLimit * 25};`));

  const riskSuggestions = parseJsonLines(await runPsql(`
SELECT json_build_object(
  'riskSuggestionId', s.id,
  'riskTitle', s.risk_title,
  'description', COALESCE(s.description, ''),
  'suggestedMitigation', COALESCE(s.suggested_mitigation, ''),
  'confidence', s.confidence,
  'reviewStatus', s.review_status,
  'reportVersionId', s.report_version_id,
  'reportId', v.report_id,
  'createdAt', v.created_at
)::text
FROM project_ai_risk_suggestions s
JOIN project_report_versions v ON v.id = s.report_version_id
JOIN project_reports r ON r.id = v.report_id
WHERE r.project_id = ${projectId}
  AND r.report_status <> 'archived'
ORDER BY v.created_at DESC, s.id DESC
LIMIT ${safeLimit * 10};`));

  const latestSnapshot = parseJsonLines(await runPsql(`
SELECT json_build_object(
  'snapshotId', id,
  'sourceReportVersionId', source_report_version_id,
  'snapshotType', snapshot_type,
  'isOfficial', is_official,
  'officialLabel', COALESCE(official_label, ''),
  'officialAt', official_at,
  'summary', COALESCE(summary, ''),
  'createdBy', COALESCE(created_by, ''),
  'createdAt', created_at,
  'contextPayload', context_payload
)::text
FROM project_context_snapshots
WHERE project_id = ${projectId}
ORDER BY created_at DESC, id DESC
LIMIT 1;`))[0] || null;

  return {
    ...project,
    found: true,
    projectResolution,
    activeMilestones,
    activeRisks,
    recentReports,
    healthHistory,
    milestoneHistory,
    riskSuggestions,
    latestSnapshot,
    generatedAt: new Date().toISOString()
  };
}

async function createProjectContextSnapshot(projectName = '', payload = {}) {
  const context = await getProjectContext(projectName, payload.limit || 5);
  if (!context.found) {
    const error = new Error('Project not found for context snapshot.');
    error.statusCode = 404;
    throw error;
  }
  const sourceReportVersionId = Number(payload.sourceReportVersionId || context.recentReports?.[0]?.reportVersionId || 0);
  const snapshotType = ['generated', 'manual', 'imported'].includes(String(payload.snapshotType || 'generated')) ? String(payload.snapshotType || 'generated') : 'generated';
  const summary = String(payload.summary || `Context snapshot for ${context.projectName}`).trim();
  const createdBy = String(payload.createdBy || 'OpenClaw').trim();
  const contextPayload = payload.contextPayload && typeof payload.contextPayload === 'object'
    ? payload.contextPayload
    : context;

  const isOfficial = truthy(payload.isOfficial);
  const out = await runPsql(
    `INSERT INTO project_context_snapshots (project_id, source_report_version_id, snapshot_type, context_payload, summary, created_by, is_official, official_label, official_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $7 THEN NOW() ELSE NULL END)
     RETURNING id::text`,
    [
      Number(context.projectId),
      sourceReportVersionId > 0 ? sourceReportVersionId : null,
      snapshotType,
      JSON.stringify(contextPayload || {}),
      summary,
      createdBy,
      isOfficial,
      payload.officialLabel || ''
    ]
  );
  const snapshotId = parseOptionalId(out);
  if (!snapshotId) throw new Error('Could not create project context snapshot.');

  const items = [];
  for (const milestone of context.activeMilestones || []) {
    const latest = milestone.latestAssessment || {};
    const previous = milestone.previousAssessment || {};
    items.push({
      itemType: 'milestone',
      itemKey: milestone.comparisonKey || projectContextScopedItemKey(milestone.milestoneName, `milestone_${milestone.milestoneId}`),
      itemLabel: milestone.milestoneName,
      status: latest.status || '',
      previousStatus: previous.status || '',
      trend: latest.trend || 'unknown',
      confidence: latest.confidence,
      evidence: latest.summary ? [{ text: latest.summary }] : [],
      metadata: { milestoneId: milestone.milestoneId, forecastFinishDate: latest.forecastFinishDate || milestone.forecastFinishDate || null }
    });
  }
  const latestHealthByArea = new Map();
  for (const health of context.healthHistory || []) {
    if (!latestHealthByArea.has(health.area)) latestHealthByArea.set(health.area, health);
  }
  for (const [area, health] of latestHealthByArea.entries()) {
    items.push({
      itemType: 'health_area',
      itemKey: area,
      itemLabel: area,
      status: health.status || '',
      previousStatus: '',
      trend: health.trend || 'unknown',
      confidence: health.confidence,
      evidence: health.rationale ? [{ text: health.rationale }] : [],
      metadata: { reportVersionId: health.reportVersionId, reportId: health.reportId }
    });
  }
  for (const risk of (context.activeRisks || []).slice(0, 20)) {
    items.push({
      itemType: 'risk',
      itemKey: projectContextScopedItemKey(risk.riskTitle, `core_risk_${risk.riskId}`),
      itemLabel: risk.riskTitle,
      status: 'active',
      previousStatus: '',
      trend: 'stable',
      confidence: 1,
      evidence: risk.description ? [{ text: risk.description }] : [],
      metadata: { riskId: risk.riskId, category: risk.category || '', mitigation: risk.mitigation || '', source: 'core_risk' }
    });
  }
  for (const risk of (context.riskSuggestions || []).slice(0, 20)) {
    items.push({
      itemType: 'risk',
      itemKey: projectContextScopedItemKey(risk.riskTitle, `risk_${risk.riskSuggestionId}`),
      itemLabel: risk.riskTitle,
      status: risk.reviewStatus || '',
      previousStatus: '',
      trend: risk.reviewStatus === 'pending' ? 'new_risk' : 'stable',
      confidence: risk.confidence,
      evidence: risk.description ? [{ text: risk.description }] : [],
      metadata: { riskSuggestionId: risk.riskSuggestionId, mitigation: risk.suggestedMitigation || '' }
    });
  }

  for (const item of items) {
    await runPsql(
      `INSERT INTO project_context_snapshot_items
       (snapshot_id, item_type, item_key, item_label, status, previous_status, trend, confidence, evidence, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        snapshotId,
        item.itemType,
        item.itemKey,
        item.itemLabel,
        item.status,
        item.previousStatus,
        normaliseProjectTrend(item.trend),
        clampConfidence(item.confidence, 0.5),
        JSON.stringify(item.evidence || {}),
        JSON.stringify(item.metadata || {})
      ]
    );
  }

  return getProjectContextSnapshot(snapshotId);
}

async function getProjectContextSnapshot(snapshotId) {
  const id = Number(snapshotId);
  if (!Number.isFinite(id) || id <= 0) {
    const error = new Error('Valid snapshot id is required.');
    error.statusCode = 400;
    throw error;
  }
  const snapshot = parseJsonLines(await runPsql(`
SELECT json_build_object(
  'snapshotId', s.id,
  'projectId', p.id,
  'projectName', p.project_name,
  'sourceReportVersionId', s.source_report_version_id,
  'snapshotType', s.snapshot_type,
  'summary', COALESCE(s.summary, ''),
  'createdBy', COALESCE(s.created_by, ''),
  'createdAt', s.created_at,
  'contextPayload', s.context_payload,
  'items', COALESCE((
    SELECT json_agg(json_build_object(
      'itemId', i.id,
      'itemType', i.item_type,
      'itemKey', i.item_key,
      'itemLabel', COALESCE(i.item_label, ''),
      'status', COALESCE(i.status, ''),
      'previousStatus', COALESCE(i.previous_status, ''),
      'trend', i.trend,
      'confidence', i.confidence,
      'evidence', i.evidence,
      'metadata', i.metadata,
      'createdAt', i.created_at
    ) ORDER BY i.item_type, i.id)
    FROM project_context_snapshot_items i
    WHERE i.snapshot_id = s.id
  ), '[]'::json)
)::text
FROM project_context_snapshots s
JOIN projects p ON p.id = s.project_id
WHERE s.id = ${id}
LIMIT 1;`))[0] || null;
  return snapshot;
}

async function saveUploadedJob({ fileName, mimeType, transcriptText }) {
  const title = fileName || 'Uploaded transcript';
  const description = 'Auto-created from uploaded transcript.';
  const transcript = transcriptText || '';
  const payload = { fileName, mimeType, status: 'uploaded' };

  const out = await runPsql(
    `WITH inserted_meeting AS (
  INSERT INTO meetings (meeting_title, meeting_description, source)
  VALUES ($1, $2, 'trinzo-upload')
  RETURNING id, created_at
), inserted_autosave AS (
  INSERT INTO meeting_autosaves (meeting_id, transcript_text, transcript_length, payload)
  SELECT id, $3, LENGTH($3), $4::jsonb
  FROM inserted_meeting
)
SELECT id::text || '|' || created_at::text FROM inserted_meeting`,
    [title, description, transcript, JSON.stringify(payload)]
  );
  const [meetingId, createdAt] = (out.split('\n')[0] || '').split('|');
  return { meetingId: Number(meetingId), createdAt };
}

async function saveMeetingMinutes(payload) {
  const meetingTitle = payload?.meetingTitle || 'Uploaded transcript review';
  const meetingDescription = payload?.meetingDescription || 'Auto-created from uploaded transcript.';
  const transcriptText = payload?.transcriptText || '';
  const autosavePayload = payload?.payload || {};
  const source = payload?.payload?.source || 'trinzo-upload';

  const out = await runPsql(
    `WITH inserted_meeting AS (
  INSERT INTO meetings (meeting_title, meeting_description, source, status, webhook_status, last_activity_at)
  VALUES ($1, $2, $3, 'queued', 'not_sent', NOW())
  RETURNING id
), inserted_autosave AS (
  INSERT INTO meeting_autosaves (meeting_id, transcript_text, transcript_length, payload)
  SELECT id, $4, LENGTH($4), $5::jsonb
  FROM inserted_meeting
), inserted_job AS (
  INSERT INTO meeting_jobs (meeting_id, job_type, status, attempts, max_attempts, run_after, created_at, updated_at)
  SELECT id, 'agent_extract', 'queued', 0, 3, NOW(), NOW(), NOW()
  FROM inserted_meeting
  RETURNING id, meeting_id
)
SELECT meeting_id::text || '|' || id::text FROM inserted_job`,
    [meetingTitle, meetingDescription, source, transcriptText, JSON.stringify(autosavePayload || {})]
  );
  const row = out.split('\n').find((line) => /^\d+\|\d+$/.test(line));
  const [meetingId, jobId] = (row || '|').split('|');
  return { meetingId: Number(meetingId), jobId: Number(jobId), status: 'queued' };
}

async function saveMeetingMinutesFeedback(payload = {}) {
  const route = String(payload.route || '/meeting-minutes-final').slice(0, 255);
  const feedbackType = String(payload.feedbackType || 'general').slice(0, 50);
  const message = String(payload.message || '').slice(0, 2000);
  const contactName = payload.contactName ? String(payload.contactName).slice(0, 120) : '';
  const contactEmail = payload.contactEmail ? String(payload.contactEmail).slice(0, 254) : '';
  const userAgent = payload.userAgent ? String(payload.userAgent).slice(0, 500) : '';
  const metadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};

  await runPsql(meetingMinutesFeedbackSchemaSql());
  const out = await runPsql(
    `INSERT INTO meeting_minutes_feedback (route, feedback_type, message, contact_name, contact_email, user_agent, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id::text, created_at::text`,
    [route, feedbackType, message, contactName, contactEmail, userAgent, JSON.stringify(metadata || {})]
  );
  const row = out.split('\n').find((line) => /^\d+\|/.test(line));
  const [id, createdAt] = (row || '|').split('|');
  return { feedbackId: Number(id), createdAt };
}

function meetingMinutesFeedbackSchemaSql() {
  return `
CREATE TABLE IF NOT EXISTS meeting_minutes_feedback (
  id BIGSERIAL PRIMARY KEY,
  route TEXT NOT NULL,
  feedback_type TEXT NOT NULL DEFAULT 'general',
  message TEXT NOT NULL,
  contact_name TEXT,
  contact_email TEXT,
  user_agent TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_meeting_minutes_feedback_created_at ON meeting_minutes_feedback (created_at DESC);
ALTER TABLE meeting_minutes_feedback ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'submitted';
ALTER TABLE meeting_minutes_feedback ADD COLUMN IF NOT EXISTS claire_comments TEXT NOT NULL DEFAULT '';
ALTER TABLE meeting_minutes_feedback ADD COLUMN IF NOT EXISTS fix_details TEXT NOT NULL DEFAULT '';
ALTER TABLE meeting_minutes_feedback ADD COLUMN IF NOT EXISTS fixed_at TIMESTAMPTZ;
ALTER TABLE meeting_minutes_feedback ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_meeting_minutes_feedback_status ON meeting_minutes_feedback (status);`;
}

async function listMeetingMinutesFeedback(limit = 100) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 250);
  const out = await runPsql(`${meetingMinutesFeedbackSchemaSql()}
SELECT json_build_object(
  'id', id,
  'route', route,
  'feedbackType', feedback_type,
  'message', message,
  'contactName', COALESCE(contact_name, ''),
  'status', COALESCE(status, 'submitted'),
  'claireComments', COALESCE(claire_comments, ''),
  'fixDetails', COALESCE(fix_details, ''),
  'selectedSnippet', COALESCE(metadata->>'selectedSnippet', ''),
  'createdAt', created_at,
  'editedAt', edited_at,
  'fixedAt', fixed_at
)::text
FROM meeting_minutes_feedback
ORDER BY created_at DESC, id DESC
LIMIT ${safeLimit};`);
  return parseJsonLines(out);
}

async function getMeetingMinutesFeedback(feedbackId) {
  const id = Number(feedbackId);
  if (!Number.isFinite(id) || id <= 0) return null;
  const out = await runPsql(`${meetingMinutesFeedbackSchemaSql()}
SELECT json_build_object(
  'id', id,
  'route', route,
  'feedbackType', feedback_type,
  'message', message,
  'contactName', COALESCE(contact_name, ''),
  'contactEmail', COALESCE(contact_email, ''),
  'userAgent', COALESCE(user_agent, ''),
  'status', COALESCE(status, 'submitted'),
  'claireComments', COALESCE(claire_comments, ''),
  'fixDetails', COALESCE(fix_details, ''),
  'metadata', metadata,
  'selectedSnippet', COALESCE(metadata->>'selectedSnippet', ''),
  'createdAt', created_at,
  'editedAt', edited_at,
  'fixedAt', fixed_at
)::text
FROM meeting_minutes_feedback
WHERE id = ${id}
LIMIT 1;`);
  const rows = parseJsonLines(out);
  return rows[0] || null;
}

async function updateMeetingMinutesFeedback(feedbackId, payload = {}) {
  const id = Number(feedbackId);
  if (!Number.isFinite(id) || id <= 0) return null;
  const allowedStatuses = new Set(['submitted', 'working_on_it', 'resolved']);
  const status = allowedStatuses.has(String(payload.status || '').trim()) ? String(payload.status).trim() : 'submitted';
  const claireComments = String(payload.claireComments || '').slice(0, 4000);
  const fixDetails = String(payload.fixDetails || '').slice(0, 4000);
  await runPsql(meetingMinutesFeedbackSchemaSql());
  const out = await runPsql(
    `UPDATE meeting_minutes_feedback
     SET status = $1,
         claire_comments = $2,
         fix_details = $3,
         fixed_at = CASE WHEN $1 = 'resolved' THEN COALESCE(fixed_at, NOW()) ELSE NULL END,
         edited_at = NOW()
     WHERE id = $4
     RETURNING id::text`,
    [status, claireComments, fixDetails, id]
  );
  const updatedId = parseOptionalId(out);
  return updatedId ? getMeetingMinutesFeedback(updatedId) : null;
}

async function deleteMeetingMinutesFeedback(feedbackId) {
  const id = Number(feedbackId);
  if (!Number.isFinite(id) || id <= 0) return false;
  await runPsql(meetingMinutesFeedbackSchemaSql());
  const out = await runPsql('DELETE FROM meeting_minutes_feedback WHERE id = $1 RETURNING id::text', [id]);
  return Boolean(parseOptionalId(out));
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
  const out = await runPsql(
    `WITH candidate AS (
  SELECT id
  FROM meeting_jobs
  WHERE status = 'queued'
    AND job_type <> 'meeting_minutes_generate'
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
    locked_by = $1,
    updated_at = NOW()
FROM candidate
WHERE j.id = candidate.id
RETURNING j.id::text, j.meeting_id::text, j.job_type, j.status, j.attempts::text, j.max_attempts::text`,
    [lockedBy]
  );
  const line = out.split('\n').find(Boolean);
  if (!line) return null;
  const [id, meetingId, jobType, status, attempts, maxAttempts] = line.split('|');
  return { id: Number(id), meetingId: Number(meetingId), jobType, status, attempts: Number(attempts), maxAttempts: Number(maxAttempts) };
}

async function markJobCompleted(jobId, meetingId, resultPayload) {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE meeting_jobs
       SET status = 'completed', result_payload = $1, error_message = NULL, locked_at = NULL, locked_by = NULL, updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(resultPayload || {}), Number(jobId)]
    );
    await client.query(
      `UPDATE meetings
       SET status = CASE WHEN status = 'webhook_pending' THEN status ELSE 'processed' END, processing_completed_at = NOW(), last_activity_at = NOW()
       WHERE id = $1`,
      [Number(meetingId)]
    );
  });
}

async function markJobFailure(job, errorMessage) {
  const shouldRetry = job.attempts < job.maxAttempts;
  await withTransaction(async (client) => {
    if (shouldRetry) {
      await client.query(
        `UPDATE meeting_jobs
         SET status = 'queued', error_message = $1, locked_at = NULL, locked_by = NULL, run_after = NOW() + INTERVAL '2 minutes', updated_at = NOW()
         WHERE id = $2`,
        [errorMessage, Number(job.id)]
      );
      await client.query(
        `UPDATE meetings SET status = 'queued', last_error = $1, last_activity_at = NOW() WHERE id = $2`,
        [errorMessage, Number(job.meetingId)]
      );
    } else {
      await client.query(
        `UPDATE meeting_jobs
         SET status = 'failed', error_message = $1, locked_at = NULL, locked_by = NULL, updated_at = NOW()
         WHERE id = $2`,
        [errorMessage, Number(job.id)]
      );
      await client.query(
        `UPDATE meetings SET status = 'failed', last_error = $1, last_activity_at = NOW() WHERE id = $2`,
        [errorMessage, Number(job.meetingId)]
      );
    }
  });
  return shouldRetry;
}

async function queueWebhookJob(meetingId, payload) {
  const jobId = await withTransaction(async (client) => {
    await client.query(
      `UPDATE meetings SET webhook_status = 'pending', status = 'webhook_pending', last_activity_at = NOW() WHERE id = $1`,
      [Number(meetingId)]
    );
    const inserted = await client.query(
      `INSERT INTO meeting_jobs (meeting_id, job_type, status, attempts, max_attempts, run_after, result_payload, created_at, updated_at)
       VALUES ($1, 'webhook_send', 'queued', 0, 3, NOW(), $2, NOW(), NOW())
       RETURNING id`,
      [Number(meetingId), JSON.stringify(payload || {})]
    );
    return inserted.rows[0].id;
  });
  return { jobId, webhookStatus: 'pending' };
}

async function ensureMeetingJobQueueSchema() {
  await query(`
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS webhook_status TEXT NOT NULL DEFAULT 'not_sent';
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS webhook_sent_at TIMESTAMPTZ;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS webhook_response JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS last_error TEXT NOT NULL DEFAULT '';
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS processing_completed_at TIMESTAMPTZ;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE meetings DROP CONSTRAINT IF EXISTS meetings_status_check;
ALTER TABLE meetings ADD CONSTRAINT meetings_status_check
  CHECK (status IN (
    'draft',
    'uploaded',
    'queued',
    'processing',
    'agent_completed',
    'webhook_pending',
    'webhook_sent',
    'completed',
    'processed',
    'failed',
    'cancelled'
  ));
ALTER TABLE meetings DROP CONSTRAINT IF EXISTS meetings_webhook_status_check;
ALTER TABLE meetings ADD CONSTRAINT meetings_webhook_status_check
  CHECK (webhook_status IN ('not_sent', 'pending', 'sent', 'failed'));

CREATE TABLE IF NOT EXISTS meeting_jobs (
  id BIGSERIAL PRIMARY KEY,
  meeting_id BIGINT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  run_after TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  locked_by TEXT NOT NULL DEFAULT '',
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  input_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  result_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_message TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE meeting_jobs ADD COLUMN IF NOT EXISTS stage TEXT NOT NULL DEFAULT 'queued';
ALTER TABLE meeting_jobs ADD COLUMN IF NOT EXISTS progress_percent INT NOT NULL DEFAULT 0;
ALTER TABLE meeting_jobs ADD COLUMN IF NOT EXISTS status_message TEXT NOT NULL DEFAULT '';
ALTER TABLE meeting_jobs ADD COLUMN IF NOT EXISTS cancel_requested BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE meeting_jobs DROP CONSTRAINT IF EXISTS meeting_jobs_job_type_check;
ALTER TABLE meeting_jobs ADD CONSTRAINT meeting_jobs_job_type_check
  CHECK (job_type IN ('agent_extract', 'webhook_send', 'document_generate', 'meeting_minutes_generate'));
CREATE INDEX IF NOT EXISTS idx_meeting_jobs_status_run_after ON meeting_jobs (status, run_after, created_at);
CREATE INDEX IF NOT EXISTS idx_meeting_jobs_type_status ON meeting_jobs (job_type, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_meetings_status_activity ON meetings (status, last_activity_at DESC);
`);
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function meetingJobFromRow(row, includeResult = false) {
  if (!row) return null;
  const inputPayload = parseJsonObject(row.input_payload || row.inputPayload);
  const resultPayload = parseJsonObject(row.result_payload || row.resultPayload);
  const job = {
    jobId: Number(row.job_id || row.jobId || row.id),
    meetingId: Number(row.meeting_id || row.meetingId),
    jobType: row.job_type || row.jobType || '',
    status: row.status || '',
    stage: row.stage || '',
    progressPercent: Number(row.progress_percent || row.progressPercent || 0),
    statusMessage: row.status_message || row.statusMessage || '',
    attempts: Number(row.attempts || 0),
    maxAttempts: Number(row.max_attempts || row.maxAttempts || 0),
    cancelRequested: row.cancel_requested === true || row.cancel_requested === 't' || row.cancelRequested === true,
    errorMessage: row.error_message || row.errorMessage || '',
    lockedBy: row.locked_by || row.lockedBy || '',
    runAfter: row.run_after || row.runAfter || null,
    startedAt: row.started_at || row.startedAt || null,
    completedAt: row.completed_at || row.completedAt || null,
    createdAt: row.created_at || row.createdAt || null,
    updatedAt: row.updated_at || row.updatedAt || null,
    meetingTitle: row.meeting_title || row.meetingTitle || '',
    meetingStatus: row.meeting_status || row.meetingStatus || '',
    source: row.source || '',
    fileName: inputPayload.fileName || row.file_name || row.fileName || '',
    transcriptLength: Number(row.transcript_length || row.transcriptLength || inputPayload.transcriptLength || 0),
    inputPayload
  };
  if (includeResult) job.resultPayload = resultPayload;
  return job;
}

async function queueMeetingMinutesGeneration(payload = {}) {
  await ensureMeetingJobQueueSchema();
  const transcriptText = String(payload.transcriptText || '');
  const fileName = String(payload.fileName || '').trim();
  const source = String(payload.source || 'meeting-minutes-final').slice(0, 100);
  const title = String(payload.meetingTitle || fileName || 'Meeting minutes job').trim().slice(0, 500);
  const description = String(payload.meetingDescription || 'Queued meeting minutes generation.').slice(0, 2000);
  const inputPayload = {
    source,
    fileName,
    transcriptLength: transcriptText.length,
    transcriptSha256: payload.transcriptSha256 || '',
    includeDiagnostics: Boolean(payload.includeDiagnostics),
    includeTranscriptMetadata: Boolean(payload.includeTranscriptMetadata),
    skipRewrite: Boolean(payload.skipRewrite),
    includeProjectStatusEvidence: Boolean(payload.includeProjectStatusEvidence),
    queuedBy: payload.queuedBy || '',
    queuedAt: new Date().toISOString()
  };

  const result = await withTransaction(async (client) => {
    const meeting = await client.query(
      `INSERT INTO meetings (meeting_title, meeting_description, source, status, webhook_status, last_activity_at)
       VALUES ($1, $2, $3, 'queued', 'not_sent', NOW())
       RETURNING id`,
      [title, description, source]
    );
    const meetingId = meeting.rows[0].id;
    await client.query(
      `INSERT INTO meeting_autosaves (meeting_id, transcript_text, transcript_length, payload)
       VALUES ($1, $2, LENGTH($2), $3::jsonb)`,
      [meetingId, transcriptText, JSON.stringify({ source, fileName, autosaveKind: 'queued_minutes_generation' })]
    );
    const job = await client.query(
      `INSERT INTO meeting_jobs (
         meeting_id, job_type, status, stage, progress_percent, status_message,
         attempts, max_attempts, run_after, input_payload, created_at, updated_at
       )
       VALUES ($1, 'meeting_minutes_generate', 'queued', 'queued', 0, 'Queued for detailed minutes generation.', 0, 3, NOW(), $2::jsonb, NOW(), NOW())
       RETURNING id`,
      [meetingId, JSON.stringify(inputPayload)]
    );
    return { meetingId: Number(meetingId), jobId: Number(job.rows[0].id) };
  });

  return {
    ...result,
    status: 'queued',
    stage: 'queued',
    progressPercent: 0,
    statusMessage: 'Queued for detailed minutes generation.'
  };
}

async function listMeetingMinutesJobs(limit = 50) {
  await ensureMeetingJobQueueSchema();
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const result = await query(
    `SELECT
       j.id AS job_id, j.meeting_id, j.job_type, j.status, j.stage, j.progress_percent,
       j.status_message, j.attempts, j.max_attempts, j.cancel_requested,
       j.error_message, j.locked_by, j.run_after, j.started_at, j.completed_at,
       j.created_at, j.updated_at, j.input_payload, m.meeting_title, m.status AS meeting_status,
       m.source,
       COALESCE(a.transcript_length, 0) AS transcript_length
     FROM meeting_jobs j
     JOIN meetings m ON m.id = j.meeting_id
     LEFT JOIN LATERAL (
       SELECT transcript_length
       FROM meeting_autosaves
       WHERE meeting_id = m.id
       ORDER BY saved_at DESC, id DESC
       LIMIT 1
     ) a ON TRUE
     WHERE j.job_type = 'meeting_minutes_generate'
     ORDER BY
       CASE j.status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 WHEN 'failed' THEN 2 ELSE 3 END,
       j.created_at DESC
     LIMIT $1`,
    [safeLimit]
  );
  return result.rows.map((row) => meetingJobFromRow(row));
}

async function getMeetingMinutesJob(jobId, options = {}) {
  await ensureMeetingJobQueueSchema();
  const result = await query(
    `SELECT
       j.id AS job_id, j.meeting_id, j.job_type, j.status, j.stage, j.progress_percent,
       j.status_message, j.attempts, j.max_attempts, j.cancel_requested,
       j.error_message, j.locked_by, j.run_after, j.started_at, j.completed_at,
       j.created_at, j.updated_at, j.input_payload, j.result_payload,
       m.meeting_title, m.status AS meeting_status, m.source,
       COALESCE(a.transcript_length, 0) AS transcript_length,
       ${options.includeTranscript ? 'COALESCE(a.transcript_text, \'\')' : '\'\''} AS transcript_text
     FROM meeting_jobs j
     JOIN meetings m ON m.id = j.meeting_id
     LEFT JOIN LATERAL (
       SELECT transcript_text, transcript_length
       FROM meeting_autosaves
       WHERE meeting_id = m.id
       ORDER BY saved_at DESC, id DESC
       LIMIT 1
     ) a ON TRUE
     WHERE j.id = $1 AND j.job_type = 'meeting_minutes_generate'
     LIMIT 1`,
    [Number(jobId)]
  );
  const job = meetingJobFromRow(result.rows[0], true);
  if (job && options.includeTranscript) job.transcriptText = result.rows[0].transcript_text || '';
  return job;
}

async function claimNextMeetingMinutesJob(lockedBy = 'meeting-minutes-worker') {
  await ensureMeetingJobQueueSchema();
  const result = await query(
    `WITH candidate AS (
       SELECT id
       FROM meeting_jobs
       WHERE job_type = 'meeting_minutes_generate'
         AND status = 'queued'
         AND cancel_requested = FALSE
         AND (run_after IS NULL OR run_after <= NOW())
         AND attempts < max_attempts
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE meeting_jobs j
     SET status = 'running',
         stage = 'starting',
         progress_percent = GREATEST(progress_percent, 5),
         status_message = 'Starting detailed minutes generation.',
         attempts = COALESCE(attempts, 0) + 1,
         locked_at = NOW(),
         locked_by = $1,
         started_at = COALESCE(started_at, NOW()),
         updated_at = NOW()
     FROM candidate
     WHERE j.id = candidate.id
     RETURNING j.id`,
    [lockedBy]
  );
  const id = result.rows[0]?.id;
  if (!id) return null;
  return getMeetingMinutesJob(id, { includeTranscript: true });
}

async function updateMeetingMinutesJobProgress(jobId, stage, progressPercent, statusMessage) {
  await ensureMeetingJobQueueSchema();
  await query(
    `UPDATE meeting_jobs
     SET stage = $1,
         progress_percent = LEAST(99, GREATEST(0, $2)),
         status_message = $3,
         updated_at = NOW()
     WHERE id = $4 AND job_type = 'meeting_minutes_generate'`,
    [String(stage || 'running'), Number(progressPercent || 0), String(statusMessage || ''), Number(jobId)]
  );
}

async function markMeetingMinutesJobCompleted(jobId, meetingId, resultPayload) {
  await ensureMeetingJobQueueSchema();
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE meeting_jobs
       SET status = 'completed',
           stage = 'completed',
           progress_percent = 100,
           status_message = 'Minutes are ready for review.',
           result_payload = $1::jsonb,
           error_message = '',
           locked_at = NULL,
           locked_by = '',
           completed_at = NOW(),
           updated_at = NOW()
       WHERE id = $2 AND job_type = 'meeting_minutes_generate'`,
      [JSON.stringify(resultPayload || {}), Number(jobId)]
    );
    await client.query(
      `UPDATE meetings
       SET status = 'processed',
           processing_completed_at = NOW(),
           last_error = '',
           last_activity_at = NOW()
       WHERE id = $1`,
      [Number(meetingId)]
    );
  });
}

async function markMeetingMinutesJobFailure(job, errorMessage) {
  await ensureMeetingJobQueueSchema();
  const shouldRetry = Number(job.attempts || 0) < Number(job.maxAttempts || 0);
  await withTransaction(async (client) => {
    if (shouldRetry) {
      await client.query(
        `UPDATE meeting_jobs
         SET status = 'queued',
             stage = 'retry_wait',
             progress_percent = 0,
             status_message = 'Generation failed; queued for retry.',
             error_message = $1,
             locked_at = NULL,
             locked_by = '',
             run_after = NOW() + INTERVAL '2 minutes',
             updated_at = NOW()
         WHERE id = $2`,
        [String(errorMessage || 'Meeting minutes generation failed.'), Number(job.jobId || job.id)]
      );
      await client.query(
        `UPDATE meetings SET status = 'queued', last_error = $1, last_activity_at = NOW() WHERE id = $2`,
        [String(errorMessage || 'Meeting minutes generation failed.'), Number(job.meetingId)]
      );
    } else {
      await client.query(
        `UPDATE meeting_jobs
         SET status = 'failed',
             stage = 'failed',
             progress_percent = 0,
             status_message = 'Generation failed.',
             error_message = $1,
             locked_at = NULL,
             locked_by = '',
             completed_at = NOW(),
             updated_at = NOW()
         WHERE id = $2`,
        [String(errorMessage || 'Meeting minutes generation failed.'), Number(job.jobId || job.id)]
      );
      await client.query(
        `UPDATE meetings SET status = 'failed', last_error = $1, last_activity_at = NOW() WHERE id = $2`,
        [String(errorMessage || 'Meeting minutes generation failed.'), Number(job.meetingId)]
      );
    }
  });
  return shouldRetry;
}

async function retryMeetingMinutesJob(jobId) {
  await ensureMeetingJobQueueSchema();
  const result = await query(
    `UPDATE meeting_jobs
     SET status = 'queued',
         stage = 'queued',
         progress_percent = 0,
         status_message = 'Queued for retry.',
         error_message = '',
         cancel_requested = FALSE,
         attempts = 0,
         run_after = NOW(),
         locked_at = NULL,
         locked_by = '',
         completed_at = NULL,
         updated_at = NOW()
     WHERE id = $1
       AND job_type = 'meeting_minutes_generate'
       AND status IN ('failed','completed','queued')
     RETURNING id`,
    [Number(jobId)]
  );
  if (!result.rows[0]) return null;
  return getMeetingMinutesJob(jobId, { includeResult: true });
}

async function cancelMeetingMinutesJob(jobId) {
  await ensureMeetingJobQueueSchema();
  const result = await query(
    `UPDATE meeting_jobs
     SET cancel_requested = TRUE,
         status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
         stage = CASE WHEN status = 'queued' THEN 'cancelled' ELSE stage END,
         status_message = CASE WHEN status = 'queued' THEN 'Cancelled before processing.' ELSE 'Cancellation requested.' END,
         updated_at = NOW()
     WHERE id = $1
       AND job_type = 'meeting_minutes_generate'
       AND status IN ('queued','running')
     RETURNING id`,
    [Number(jobId)]
  );
  if (!result.rows[0]) return null;
  return getMeetingMinutesJob(jobId, { includeResult: true });
}

async function deleteMeetingMinutesJob(jobId) {
  await ensureMeetingJobQueueSchema();
  const result = await query(
    `WITH target AS (
       SELECT meeting_id
       FROM meeting_jobs
       WHERE id = $1
         AND job_type = 'meeting_minutes_generate'
         AND status IN ('completed','failed','cancelled')
       LIMIT 1
     )
     DELETE FROM meetings m
     USING target
     WHERE m.id = target.meeting_id
     RETURNING m.id`,
    [Number(jobId)]
  );
  return Boolean(result.rows[0]);
}

async function updateMeetingMinutesJobResult(jobId, resultPayload) {
  await ensureMeetingJobQueueSchema();
  const result = await query(
    `UPDATE meeting_jobs
     SET result_payload = $1::jsonb,
         status_message = 'Minutes edited and ready for review.',
         updated_at = NOW()
     WHERE id = $2
       AND job_type = 'meeting_minutes_generate'
       AND status = 'completed'
     RETURNING id`,
    [JSON.stringify(resultPayload || {}), Number(jobId)]
  );
  if (!result.rows[0]) return null;
  return getMeetingMinutesJob(jobId, { includeResult: true });
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
  await runPsql(
    `UPDATE meetings
     SET meeting_title = $1, meeting_date = $2::date, meeting_location = $3, meeting_description = $4, updated_at = NOW()
     WHERE id = $5`,
    [payload?.meetingTitle || '', payload?.meetingDate ? payload.meetingDate : null, payload?.meetingLocation || '', payload?.meetingDescription || '', Number(meetingId)]
  );
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

const PROJECT_KNOWLEDGE_ITEM_TYPES = new Set(['note', 'report_summary', 'key_update', 'milestone_summary', 'risk', 'evidence', 'decision', 'background_doc']);

function normaliseKnowledgeItemType(value, fallback = 'note') {
  const itemType = String(value || fallback).trim();
  return PROJECT_KNOWLEDGE_ITEM_TYPES.has(itemType) ? itemType : fallback;
}

function chunkKnowledgeText(text, options = {}) {
  const cleaned = String(text || '').replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
  if (!cleaned) return [];
  const chunkSize = Math.max(Number(options.chunkSize || 1200), 400);
  const overlap = Math.min(Math.max(Number(options.overlap || 150), 0), Math.floor(chunkSize / 2));
  if (cleaned.length <= chunkSize) return [cleaned];

  const chunks = [];
  let start = 0;
  while (start < cleaned.length) {
    let end = Math.min(start + chunkSize, cleaned.length);
    if (end < cleaned.length) {
      const window = cleaned.slice(start, end);
      const paragraphBreak = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'));
      const sentenceBreak = Math.max(window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! '));
      const boundary = paragraphBreak > chunkSize * 0.55 ? paragraphBreak + 1 : (sentenceBreak > chunkSize * 0.55 ? sentenceBreak + 1 : -1);
      if (boundary > 0) end = start + boundary;
    }
    const chunk = cleaned.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= cleaned.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

async function replaceKnowledgeChunks(client, itemId, projectId, content, metadata = {}) {
  const chunks = chunkKnowledgeText(content);
  await client.query('DELETE FROM project_knowledge_chunks WHERE item_id = $1', [itemId]);
  for (let index = 0; index < chunks.length; index += 1) {
    await client.query(
      `INSERT INTO project_knowledge_chunks (item_id, project_id, chunk_index, chunk_text, embedding_status, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [itemId, projectId, index, chunks[index], chunks[index].trim() ? 'queued' : 'skipped_empty', JSON.stringify(metadata || {})]
    );
  }
  if (!chunks.length) {
    await client.query(
      `INSERT INTO project_knowledge_chunks (item_id, project_id, chunk_index, chunk_text, embedding_status, metadata)
       VALUES ($1, $2, 0, '', 'skipped_empty', $3::jsonb)`,
      [itemId, projectId, JSON.stringify(metadata || {})]
    );
  }
  return chunks.length;
}

async function createProjectKnowledgeItem(input = {}) {
  const projectId = Number(input.projectId || 0);
  if (!Number.isFinite(projectId) || projectId <= 0) {
    const error = new Error('Valid projectId is required.');
    error.statusCode = 400;
    throw error;
  }
  const title = String(input.title || '').trim();
  const content = String(input.content || '').trim();
  if (!title || !content) {
    const error = new Error('Knowledge title and content are required.');
    error.statusCode = 400;
    throw error;
  }
  const maxChars = Number(process.env.PROJECT_KNOWLEDGE_MAX_CONTENT_CHARS || 200 * 1024);
  if (content.length > maxChars) {
    const error = new Error(`Knowledge content is too large. Maximum length is ${maxChars} characters.`);
    error.statusCode = 413;
    throw error;
  }
  const itemType = normaliseKnowledgeItemType(input.itemType || input.item_type, 'background_doc');
  const metadata = input.metadata && typeof input.metadata === 'object' ? input.metadata : {};
  const isOfficial = input.isOfficial !== false;
  const client = await getPgPool().connect();
  try {
    await client.query('BEGIN');
    const itemRes = await client.query(
      `INSERT INTO project_knowledge_items
       (project_id, title, content, summary, item_type, source_report_id, source_report_version_id, status, is_official, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
       RETURNING id, project_id, title, item_type, status, is_official, created_at, updated_at`,
      [projectId, title, content, String(input.summary || ''), itemType, input.sourceReportId || null, input.sourceReportVersionId || null, input.status || 'active', isOfficial, JSON.stringify(metadata)]
    );
    const item = itemRes.rows[0];
    const chunkCount = await replaceKnowledgeChunks(client, item.id, projectId, content, metadata);
    await client.query('COMMIT');
    return { ...cameliseKnowledgeItem(item), chunkCount };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function cameliseKnowledgeItem(row = {}) {
  return {
    itemId: row.id,
    projectId: row.project_id,
    title: row.title,
    itemType: row.item_type,
    status: row.status,
    isOfficial: row.is_official,
    sourceReportId: row.source_report_id || null,
    sourceReportVersionId: row.source_report_version_id || null,
    metadata: row.metadata || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    embeddingCounts: row.embedding_counts || row.embeddingCounts || { queued: 0, processing: 0, embedded: 0, failed: 0, skipped_empty: 0 },
    chunkCount: Number(row.chunk_count || row.chunkCount || 0)
  };
}

async function listProjectKnowledgeItems(filters = {}) {
  const projectId = Number(filters.projectId || 0);
  const conditions = [];
  const params = [];
  if (Number.isFinite(projectId) && projectId > 0) {
    params.push(projectId);
    conditions.push(`i.project_id = $${params.length}`);
  }
  if (filters.itemType) {
    params.push(normaliseKnowledgeItemType(filters.itemType, 'note'));
    conditions.push(`i.item_type = $${params.length}`);
  }
  if (filters.status) {
    params.push(String(filters.status));
    conditions.push(`i.status = $${params.length}`);
  } else {
    conditions.push(`i.status = 'active'`);
  }
  const limit = Math.min(Math.max(Number(filters.limit || 50), 1), 100);
  params.push(limit);
  const result = await query(
    `SELECT i.id, i.project_id, i.title, i.item_type, i.status, i.is_official,
            i.source_report_id, i.source_report_version_id, i.metadata, i.created_at, i.updated_at,
            COUNT(c.id)::int AS chunk_count,
            jsonb_build_object(
              'queued', COUNT(*) FILTER (WHERE c.embedding_status = 'queued'),
              'processing', COUNT(*) FILTER (WHERE c.embedding_status = 'processing'),
              'embedded', COUNT(*) FILTER (WHERE c.embedding_status = 'embedded'),
              'failed', COUNT(*) FILTER (WHERE c.embedding_status = 'failed'),
              'skipped_empty', COUNT(*) FILTER (WHERE c.embedding_status = 'skipped_empty')
            ) AS embedding_counts
     FROM project_knowledge_items i
     LEFT JOIN project_knowledge_chunks c ON c.item_id = i.id
     ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
     GROUP BY i.id
     ORDER BY i.is_official DESC, i.updated_at DESC, i.id DESC
     LIMIT $${params.length}`,
    params
  );
  return result.rows.map(cameliseKnowledgeItem);
}


async function getProjectKnowledgeStatus(filters = {}) {
  const projectId = Number(filters.projectId || 0);
  const params = [];
  const where = [];
  if (Number.isFinite(projectId) && projectId > 0) {
    params.push(projectId);
    where.push(`c.project_id = $${params.length}`);
  }
  const result = await query(
    `SELECT c.embedding_status,
            COUNT(*)::int AS count,
            MIN(c.embedding_enqueued_at) AS oldest_enqueued_at,
            MAX(c.embedding_processed_at) AS latest_processed_at
     FROM project_knowledge_chunks c
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     GROUP BY c.embedding_status`,
    params
  );
  const counts = { queued: 0, processing: 0, embedded: 0, failed: 0, skipped_empty: 0 };
  let oldestQueuedAt = null;
  let latestProcessedAt = null;
  for (const row of result.rows) {
    counts[row.embedding_status] = Number(row.count || 0);
    if (row.embedding_status === 'queued' && row.oldest_enqueued_at) oldestQueuedAt = row.oldest_enqueued_at;
    if (row.latest_processed_at && (!latestProcessedAt || new Date(row.latest_processed_at) > new Date(latestProcessedAt))) latestProcessedAt = row.latest_processed_at;
  }
  const oldestQueuedAgeSeconds = oldestQueuedAt ? Math.max(0, Math.round((Date.now() - new Date(oldestQueuedAt).getTime()) / 1000)) : 0;
  const itemResult = await query(
    `SELECT COUNT(*)::int AS active_items
     FROM project_knowledge_items i
     ${Number.isFinite(projectId) && projectId > 0 ? 'WHERE i.project_id = $1 AND i.status = \'active\'' : "WHERE i.status = 'active'"}`,
    Number.isFinite(projectId) && projectId > 0 ? [projectId] : []
  );
  return {
    projectId: Number.isFinite(projectId) && projectId > 0 ? projectId : null,
    activeItems: Number(itemResult.rows[0]?.active_items || 0),
    embeddingCounts: counts,
    oldestQueuedAt,
    oldestQueuedAgeSeconds,
    latestProcessedAt
  };
}

async function updateProjectKnowledgeItem(itemId, patch = {}) {
  const id = Number(itemId);
  if (!Number.isFinite(id) || id <= 0) {
    const error = new Error('Valid knowledge item id is required.');
    error.statusCode = 400;
    throw error;
  }
  const existing = await query('SELECT * FROM project_knowledge_items WHERE id = $1 LIMIT 1', [id]);
  if (!existing.rows[0]) return null;
  const current = existing.rows[0];
  const title = Object.prototype.hasOwnProperty.call(patch, 'title') ? String(patch.title || '').trim() : current.title;
  const contentChanged = Object.prototype.hasOwnProperty.call(patch, 'content');
  const content = contentChanged ? String(patch.content || '').trim() : current.content;
  const status = Object.prototype.hasOwnProperty.call(patch, 'status') ? String(patch.status || 'active') : current.status;
  const itemType = Object.prototype.hasOwnProperty.call(patch, 'itemType') ? normaliseKnowledgeItemType(patch.itemType, current.item_type) : current.item_type;
  const metadata = patch.metadata && typeof patch.metadata === 'object' ? patch.metadata : current.metadata;
  const client = await getPgPool().connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(
      `UPDATE project_knowledge_items
       SET title = $2, content = $3, status = $4, item_type = $5, metadata = $6::jsonb, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id, title, content, status, itemType, JSON.stringify(metadata || {})]
    );
    let chunkCount = 0;
    if (contentChanged) {
      chunkCount = await replaceKnowledgeChunks(client, id, current.project_id, content, metadata);
    }
    await client.query('COMMIT');
    return { ...cameliseKnowledgeItem(updated.rows[0]), chunkCount };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function archiveProjectKnowledgeItem(itemId, options = {}) {
  const id = Number(itemId);
  if (!Number.isFinite(id) || id <= 0) return null;
  if (options.hard) {
    const deleted = await query('DELETE FROM project_knowledge_items WHERE id = $1 RETURNING id', [id]);
    return deleted.rows[0] || null;
  }
  const updated = await query(
    `UPDATE project_knowledge_items SET status = 'archived', updated_at = NOW() WHERE id = $1 RETURNING *`,
    [id]
  );
  return updated.rows[0] ? cameliseKnowledgeItem(updated.rows[0]) : null;
}

function collectKnowledgeItemsFromReport(report = {}, source = {}) {
  const items = [];
  const metadataBase = {
    periodLabel: source.periodLabel || '',
    overallHealth: report.overallHealth || '',
    event_date: source.eventDate || source.createdAt || new Date().toISOString()
  };
  if (report.summary) {
    items.push({ itemType: 'report_summary', title: `Report summary - ${metadataBase.periodLabel || source.reportVersionId}`, content: String(report.summary), metadata: metadataBase });
  }
  for (const [index, update] of (Array.isArray(report.keyUpdates) ? report.keyUpdates : []).entries()) {
    const text = typeof update === 'string' ? update : (update?.text || update?.summary || '');
    if (text) items.push({ itemType: 'key_update', title: `Key update ${index + 1} - ${metadataBase.periodLabel || source.reportVersionId}`, content: String(text), metadata: { ...metadataBase, index } });
  }
  for (const milestone of (Array.isArray(report.milestones) ? report.milestones : [])) {
    if (milestone?.transcript_update_status && milestone.transcript_update_status !== 'updated_from_transcript') continue;
    const title = milestone?.milestone || milestone?.milestoneName || 'Milestone update';
    const content = [milestone?.delivery_status || milestone?.status, milestone?.summary || milestone?.normalised_evidence_summary, ...(Array.isArray(milestone?.next_steps) ? milestone.next_steps : [])].filter(Boolean).join('\n');
    if (content) items.push({ itemType: 'milestone_summary', title, content, metadata: { ...metadataBase, comparisonKey: milestone?.comparison_key || milestone?.comparisonKey || '' } });
  }
  for (const risk of (Array.isArray(report.risks) ? report.risks : [])) {
    const title = risk?.riskTitle || risk?.title || 'Project risk';
    const content = [risk?.description, risk?.suggestedMitigation || risk?.mitigation].filter(Boolean).join('\nMitigation: ');
    if (content) items.push({ itemType: 'risk', title, content, metadata: metadataBase });
  }
  const evidence = [];
  for (const area of Object.values(report.healthAreas || {})) {
    if (Array.isArray(area?.evidence)) evidence.push(...area.evidence);
  }
  for (const milestone of (Array.isArray(report.milestones) ? report.milestones : [])) {
    if (milestone?.excerpt) evidence.push({ text: milestone.excerpt, confidence: milestone.confidence || milestone.milestone_match_confidence });
  }
  evidence
    .filter((item) => item?.text)
    .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))
    .slice(0, Number(process.env.PROJECT_KNOWLEDGE_EVIDENCE_CAP || 10))
    .forEach((item, index) => items.push({ itemType: 'evidence', title: `Evidence ${index + 1} - ${metadataBase.periodLabel || source.reportVersionId}`, content: String(item.text), metadata: { ...metadataBase, confidence: item.confidence || null, speaker: item.speaker || '', turnIndex: item.turn_index || item.turnIndex || null } }));
  return items;
}

async function ingestApprovedProjectReportVersion({ projectId, reportId, reportVersionId, periodLabel, payload, createdAt }) {
  const report = payload?.projectReport || payload || {};
  const versionId = Number(reportVersionId || 0);
  if (!Number.isFinite(versionId) || versionId <= 0 || !Number(projectId)) {
    return { ok: false, itemsCreated: 0, error: 'Missing project/report version id.' };
  }
  const candidates = collectKnowledgeItemsFromReport(report, { reportVersionId: versionId, periodLabel, createdAt });
  const client = await getPgPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE project_knowledge_items SET status = $2, updated_at = NOW() WHERE source_report_version_id = $1', [versionId, 'archived']);
    let itemsCreated = 0;
    let chunksCreated = 0;
    for (const item of candidates) {
      const insert = await client.query(
        `INSERT INTO project_knowledge_items
         (project_id, title, content, summary, item_type, source_report_id, source_report_version_id, status, is_official, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'active',FALSE,$8::jsonb)
         ON CONFLICT (source_report_version_id, item_type, title) WHERE source_report_version_id IS NOT NULL
         DO UPDATE SET content = EXCLUDED.content, summary = EXCLUDED.summary, status = 'active', metadata = EXCLUDED.metadata, updated_at = NOW()
         RETURNING id`,
        [projectId, item.title, item.content, '', item.itemType, reportId || null, versionId, JSON.stringify(item.metadata || {})]
      );
      chunksCreated += await replaceKnowledgeChunks(client, insert.rows[0].id, projectId, item.content, item.metadata || {});
      itemsCreated += 1;
    }
    await client.query('COMMIT');
    return { ok: true, itemsCreated, chunksCreated };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    return { ok: false, itemsCreated: 0, error: error.message };
  } finally {
    client.release();
  }
}

async function saveProjectUpdateDraft({ projectId: requestedProjectId, projectName, periodLabel, fileName, sourceType, transcriptText, result }) {
  const report = result?.projectReport || {};
  const segments = Array.isArray(result?.segments) ? result.segments : [];
  const reportMilestones = Array.isArray(report?.milestones) ? report.milestones : [];
  const risks = Array.isArray(report?.risks) ? report.risks : [];
  const healthAreas = report?.healthAreas && typeof report.healthAreas === 'object' ? report.healthAreas : {};
  const name = projectName || 'Project update test';
  const label = periodLabel || currentQuarterLabel();
  const source = ['text', 'docx', 'txt', 'csv'].includes(sourceType) ? sourceType : 'text';
  const transcript = transcriptText || '';
  const maxPersistedTranscriptChars = Number(process.env.PROJECT_UPDATE_MAX_PERSISTED_TRANSCRIPT_CHARS || 2 * 1024 * 1024);
  if (transcript.length > maxPersistedTranscriptChars) {
    const error = new Error(`Transcript is too large to persist. Maximum persisted text length is ${maxPersistedTranscriptChars} characters.`);
    error.statusCode = 413;
    throw error;
  }
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
  const itemKey = (item) => String(item?.comparison_key || item?.milestone || item?.milestoneName || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const segmentForDraft = (milestoneDraft, index) => {
    const draftKey = itemKey(milestoneDraft);
    return segments.find((item) => itemKey(item) === draftKey) || segments[index] || {};
  };
  const milestoneDraftFor = (segment, index) => {
    const segmentKey = itemKey(segment);
    return reportMilestones[index]
      || reportMilestones.find((item) => itemKey(item) === segmentKey)
      || {};
  };

  let projectId = Number(requestedProjectId || 0);
  if (Number.isFinite(projectId) && projectId > 0) {
    const existingById = parseOptionalId(await runPsql('SELECT id::text FROM projects WHERE id = $1 LIMIT 1', [projectId]));
    if (!existingById) {
      const error = new Error('Selected project was not found.');
      error.statusCode = 404;
      throw error;
    }
    projectId = existingById;
  } else {
    projectId = parseOptionalId(
      await runPsql('SELECT id::text FROM projects WHERE project_name = $1 ORDER BY id LIMIT 1', [name]),
    );
  }
  if (!projectId) {
    projectId = parseId(
      await runPsql(
        `INSERT INTO projects (project_name, description, status, updated_at)
         VALUES ($1, 'Created from /project-update-test workflow.', 'active', NOW())
         RETURNING id::text`,
        [name]
      ),
      'project'
    );
  }

  let reportingPeriodId = parseOptionalId(
    await runPsql(
      `SELECT id::text FROM project_reporting_periods
       WHERE project_id = $1 AND period_type = 'quarter' AND period_label = $2
       ORDER BY id
       LIMIT 1`,
      [projectId, label]
    )
  );
  if (!reportingPeriodId) {
    reportingPeriodId = parseId(
      await runPsql(
        `INSERT INTO project_reporting_periods (project_id, period_type, period_label, start_date, end_date)
         VALUES ($1, 'quarter', $2, $3::date, $4::date)
         ON CONFLICT (project_id, period_type, period_label) DO UPDATE SET period_label = EXCLUDED.period_label
         RETURNING id::text`,
        [projectId, label, quarterStartDate(label), quarterEndDate(label)]
      ),
      'reporting period'
    );
  }

  const duplicateSource = parseJsonLines(await runPsql(
    `SELECT json_build_object(
  'reportId', r.id,
  'reportVersionId', v.id,
  'transcriptSha256', s.transcript_sha256
)::text
FROM project_report_sources s
JOIN project_reports r ON r.id = s.report_id
LEFT JOIN LATERAL (
  SELECT id FROM project_report_versions WHERE report_id = r.id ORDER BY version_number DESC, id DESC LIMIT 1
) v ON TRUE
WHERE r.project_id = $1
  AND r.reporting_period_id = $2
  AND s.transcript_sha256 = $3
  AND r.report_status <> 'archived'
ORDER BY s.id DESC
LIMIT 1`,
    [projectId, reportingPeriodId, transcriptSha]
  ))[0] || null;
  if (duplicateSource) {
    return {
      saved: false,
      reason: 'duplicate transcript already saved for this project and period',
      duplicate: true,
      projectId,
      reportingPeriodId,
      reportId: duplicateSource.reportId,
      reportVersionId: duplicateSource.reportVersionId,
      periodLabel: label,
      transcriptSha256: transcriptSha
    };
  }

  const reportId = parseId(
    await runPsql(
      `INSERT INTO project_reports (project_id, reporting_period_id, file_name, report_status, include_in_global_analysis, updated_at)
       VALUES ($1, $2, $3, 'draft', FALSE, NOW())
       RETURNING id::text`,
      [projectId, reportingPeriodId, fileName || '']
    ),
    'report'
  );
  const reportVersionId = parseId(
    await runPsql(
      `INSERT INTO project_report_versions (report_id, version_number, change_type, change_summary, saved_by, report_payload)
       VALUES ($1, 1, 'ai_generated', 'Initial AI-generated draft from /project-update-test.', 'OpenClaw', $2)
       RETURNING id::text`,
      [reportId, JSON.stringify(result || {})]
    ),
    'report version'
  );
  await runPsql(
    `INSERT INTO project_report_sources (report_id, source_type, file_name, transcript_text, transcript_length, transcript_sha256)
     VALUES ($1, $2, $3, $4, LENGTH($4), $5)`,
    [reportId, source, fileName || '', transcript, transcriptSha]
  );

  for (const item of healthValues) {
    await runPsql(
      `INSERT INTO project_report_health (report_version_id, area, status, trend, confidence, rationale)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [reportVersionId, item.area, item.status, item.trend, clampConfidence(item.confidence), item.rationale]
    );
  }

  const milestoneRows = reportMilestones.length ? reportMilestones : segments;
  const milestoneCount = milestoneRows.length;
  for (let index = 0; index < milestoneCount; index += 1) {
    const milestoneDraft = reportMilestones.length ? (milestoneRows[index] || {}) : milestoneDraftFor(segments[index] || {}, index);
    const segment = reportMilestones.length ? segmentForDraft(milestoneDraft, index) : (segments[index] || {});
    const milestoneName = milestoneDraft.milestone || segment.milestone || `Milestone ${index + 1}`;
    const baselineFinishDate = milestoneDraft.baseline_finish_date || milestoneDraft.baselineDeadline || milestoneDraft.deadline;
    const forecastFinishDate = milestoneDraft.forecast_finish_date || milestoneDraft.forecastDeadline || milestoneDraft.deadline;
    const deliveryStatus = segment.delivery_status || milestoneDraft.delivery_status || milestoneDraft.status;
    const trend = normaliseProjectTrend(milestoneDraft.trend || segment.trend || 'stable');
    const confidence = segment.delivery_status_confidence || milestoneDraft.delivery_status_confidence || segment.confidence || milestoneDraft.confidence;
    const summary = segment.normalised_evidence_summary || milestoneDraft.normalised_evidence_summary || segment.excerpt || milestoneDraft.excerpt || segment.status_resolution_note || '';
    const milestoneOut = await runPsql(
      `WITH existing AS (
  SELECT id FROM project_core_milestones
  WHERE project_id = $1 AND milestone_name = $2 AND is_active = TRUE
  ORDER BY id
  LIMIT 1
), inserted AS (
  INSERT INTO project_core_milestones (project_id, reporting_period_id, category, milestone_name, baseline_finish_date, forecast_finish_date, sort_order, is_active)
  SELECT $1, $3, 'Transcript', $2, $4::date, $5::date, $6, TRUE
  WHERE NOT EXISTS (SELECT 1 FROM existing)
  RETURNING id
), updated AS (
  UPDATE project_core_milestones
  SET baseline_finish_date = COALESCE($4::date, baseline_finish_date),
      forecast_finish_date = COALESCE($5::date, forecast_finish_date)
  WHERE id IN (SELECT id FROM existing)
  RETURNING id
)
SELECT id::text FROM inserted
UNION ALL
SELECT id::text FROM updated
UNION ALL
SELECT id::text FROM existing
LIMIT 1`,
      [projectId, milestoneName, reportingPeriodId, toDateParam(baselineFinishDate), toDateParam(forecastFinishDate), index]
    );
    const milestoneId = Number(milestoneOut.split('\n').find((item) => /^\d+$/.test(item)));
    await runPsql(
      `INSERT INTO project_report_milestone_assessments
       (report_version_id, milestone_id, status, trend, confidence, summary, forecast_finish_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7::date)`,
      [reportVersionId, milestoneId, toMilestoneAssessmentStatus(deliveryStatus), trend, clampConfidence(confidence), summary, toDateParam(forecastFinishDate)]
    );
    const evidence = Array.isArray(segment.semantic_evidence) && segment.semantic_evidence.length
      ? segment.semantic_evidence
      : (segment.evidence || []).slice(0, 3).map((text) => ({ text, confidence: segment.confidence || 0.5 }));
    for (const evidenceItem of evidence.slice(0, 3)) {
      const turnIndex = Number.isFinite(Number(evidenceItem.turnIndex)) ? Number(evidenceItem.turnIndex) : null;
      await runPsql(
        `INSERT INTO project_report_evidence
         (report_version_id, linked_type, linked_id, evidence_text, speaker, turn_index, confidence)
         VALUES ($1, 'milestone', $2, $3, $4, $5, $6)`,
        [reportVersionId, milestoneId, evidenceItem.text || '', evidenceItem.speaker || '', turnIndex, clampConfidence(evidenceItem.score || evidenceItem.confidence || segment.confidence)]
      );
    }
  }

  for (const risk of risks.slice(0, 10)) {
    await runPsql(
      `INSERT INTO project_ai_risk_suggestions
       (report_version_id, risk_title, description, suggested_mitigation, confidence, review_status)
       VALUES ($1, $2, $3, $4, $5, 'pending')`,
      [reportVersionId, risk.riskTitle || 'Project risk', risk.description || '', risk.suggestedMitigation || '', clampConfidence(risk.confidence)]
    );
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



async function markProjectContextOfficial(projectName = '', label = '') {
  const ref = normaliseProjectRef(projectName);
  const name = ref.projectName || process.env.PROJECT_UPDATE_DEFAULT_PROJECT || 'Project update test';
  const officialLabel = String(label || 'Official baseline').trim() || 'Official baseline';
  const projectId = await getProjectIdForContext(ref.projectId ? ref : name);
  if (!projectId) {
    const error = new Error('Project not found.');
    error.statusCode = 404;
    throw error;
  }

  const milestoneOut = await runPsql(
    `UPDATE project_core_milestones
     SET is_official = TRUE,
         official_label = $1,
         official_at = COALESCE(official_at, NOW()),
         is_active = TRUE
     WHERE project_id = $2 AND is_active = TRUE
     RETURNING id::text`,
    [officialLabel, projectId]
  );
  const riskOut = await runPsql(
    `UPDATE project_core_risks
     SET is_official = TRUE,
         official_label = $1,
         official_at = COALESCE(official_at, NOW()),
         is_active = TRUE
     WHERE project_id = $2 AND is_active = TRUE
     RETURNING id::text`,
    [officialLabel, projectId]
  );

  const snapshot = await createProjectContextSnapshot(ref.projectId ? { projectId, projectName: name } : name, {
    snapshotType: 'manual',
    summary: `${officialLabel} official context snapshot`,
    createdBy: 'OpenClaw',
    isOfficial: true,
    officialLabel
  });

  return {
    projectId,
    projectName: name,
    officialLabel,
    officialMilestones: milestoneOut.split('\n').filter((line) => /^\d+$/.test(line)).length,
    officialRisks: riskOut.split('\n').filter((line) => /^\d+$/.test(line)).length,
    officialSnapshotId: snapshot?.snapshotId || null,
    context: await getProjectContext(ref.projectId ? { projectId, projectName: name } : name, 5)
  };
}

async function cleanupProjectUpdateTestContext(projectName = '', options = {}) {
  const ref = normaliseProjectRef(projectName);
  const name = ref.projectName || process.env.PROJECT_UPDATE_DEFAULT_PROJECT || 'Project update test';
  const deleteNonOfficialSnapshots = options.deleteNonOfficialSnapshots !== false;
  const archiveReports = options.archiveReports !== false;
  const projectId = await getProjectIdForContext(ref.projectId ? ref : name);
  if (!projectId) {
    const error = new Error('Project not found.');
    error.statusCode = 404;
    throw error;
  }

  const milestoneOut = await runPsql(`
UPDATE project_core_milestones
SET is_active = FALSE
WHERE project_id = ${projectId}
  AND is_active = TRUE
  AND COALESCE(is_official, FALSE) = FALSE
RETURNING id::text;`);
  const riskOut = await runPsql(`
UPDATE project_core_risks
SET is_active = FALSE
WHERE project_id = ${projectId}
  AND is_active = TRUE
  AND COALESCE(is_official, FALSE) = FALSE
RETURNING id::text;`);

  const knowledgeOut = await runPsql(`
UPDATE project_knowledge_items
SET status = 'archived', updated_at = NOW()
WHERE project_id = ${projectId}
  AND status <> 'archived'
  AND COALESCE(is_official, FALSE) = FALSE
RETURNING id::text;`);

  let reportOut = '';
  if (archiveReports) {
    reportOut = await runPsql(`
UPDATE project_reports
SET report_status = 'archived', updated_at = NOW()
WHERE project_id = ${projectId}
  AND report_status <> 'archived'
RETURNING id::text;`);
  }

  let snapshotOut = '';
  if (deleteNonOfficialSnapshots) {
    snapshotOut = await runPsql(`
DELETE FROM project_context_snapshots
WHERE project_id = ${projectId}
  AND COALESCE(is_official, FALSE) = FALSE
RETURNING id::text;`);
  }

  return {
    projectId,
    projectName: name,
    deactivatedMilestones: milestoneOut.split('\n').filter((line) => /^\d+$/.test(line)).length,
    deactivatedRisks: riskOut.split('\n').filter((line) => /^\d+$/.test(line)).length,
    archivedReports: reportOut.split('\n').filter((line) => /^\d+$/.test(line)).length,
    archivedKnowledgeItems: knowledgeOut.split('\n').filter((line) => /^\d+$/.test(line)).length,
    deletedSnapshots: snapshotOut.split('\n').filter((line) => /^\d+$/.test(line)).length,
    context: await getProjectContext(ref.projectId ? { projectId, projectName: name } : name, 5)
  };
}


async function markWebhookSuccess(jobId, meetingId, webhookResponse) {
  const responseJson = JSON.stringify(webhookResponse || {});
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE meeting_jobs SET status='completed', result_payload=$1, error_message=NULL, locked_at=NULL, locked_by=NULL, updated_at=NOW() WHERE id=$2`,
      [responseJson, Number(jobId)]
    );
    await client.query(
      `UPDATE meetings SET webhook_status='sent', webhook_sent_at=NOW(), webhook_response=$1, status='completed', last_error='', processing_completed_at=NOW(), last_activity_at=NOW() WHERE id=$2`,
      [responseJson, Number(meetingId)]
    );
  });
}

async function markWebhookFailure(job, errorMessage) {
  const shouldRetry = job.attempts < job.maxAttempts;
  await withTransaction(async (client) => {
    if (shouldRetry) {
      await client.query(
        `UPDATE meeting_jobs SET status='queued', error_message=$1, locked_at=NULL, locked_by=NULL, run_after=NOW()+INTERVAL '2 minutes', updated_at=NOW() WHERE id=$2`,
        [errorMessage, Number(job.id)]
      );
    } else {
      await client.query(
        `UPDATE meeting_jobs SET status='failed', error_message=$1, locked_at=NULL, locked_by=NULL, updated_at=NOW() WHERE id=$2`,
        [errorMessage, Number(job.id)]
      );
    }
    await client.query(
      `UPDATE meetings SET webhook_status='failed', status='failed', last_error=$1, last_activity_at=NOW() WHERE id=$2`,
      [errorMessage, Number(job.meetingId)]
    );
  });
  return shouldRetry;
}

async function createAuthUser({ email, fullName, passwordSalt, passwordHash }) {
  const out = await runPsql(
    'INSERT INTO auth_users (email, full_name, password_salt, password_hash) VALUES ($1, $2, $3, $4) RETURNING id::text, email, full_name',
    [email.toLowerCase(), fullName || '', passwordSalt, passwordHash]
  );
  const [id, userEmail, name] = (out.split('\n').find(Boolean) || '||').split('|');
  return { id: Number(id), email: userEmail, fullName: name };
}

async function findAuthUserByEmail(email) {
  const out = await runPsql(
    'SELECT id::text, email, full_name, password_salt, password_hash, is_active::text FROM auth_users WHERE email = $1 LIMIT 1',
    [String(email || '').toLowerCase()]
  );
  const line = out.split('\n').find(Boolean);
  if (!line) return null;
  const [id, userEmail, fullName, passwordSalt, passwordHash, isActive] = line.split('|');
  return { id: Number(id), email: userEmail, fullName, passwordSalt, passwordHash, isActive: isActive === 't' || isActive === 'true' };
}

async function touchAuthLastLogin(userId) {
  await runPsql('UPDATE auth_users SET last_login_at = NOW(), updated_at = NOW() WHERE id = $1', [Number(userId)]);
}

async function createPasswordResetToken(userId, resetToken) {
  await runPsql(
    "INSERT INTO auth_password_reset_tokens (user_id, reset_token, expires_at) VALUES ($1, $2, NOW() + INTERVAL '30 minutes')",
    [Number(userId), resetToken]
  );
}

async function consumePasswordResetToken(resetToken) {
  const out = await runPsql(
    `UPDATE auth_password_reset_tokens
     SET used_at = NOW()
     WHERE id = (
       SELECT id FROM auth_password_reset_tokens
       WHERE reset_token = $1 AND used_at IS NULL AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1
     )
     RETURNING user_id::text`,
    [resetToken]
  );
  const line = out.split('\n').find(Boolean);
  return line ? { userId: Number(line) } : null;
}

async function updateAuthPassword(userId, salt, hash) {
  await runPsql(
    'UPDATE auth_users SET password_salt = $1, password_hash = $2, updated_at = NOW() WHERE id = $3',
    [salt, hash, Number(userId)]
  );
}

module.exports = {
  testConnection,
  listMeetings,
  getMeetingById,
  deleteMeetingById,
  updateMeetingById,
  saveUploadedJob,
  saveMeetingMinutes,
  saveMeetingMinutesFeedback,
  listMeetingMinutesFeedback,
  getMeetingMinutesFeedback,
  updateMeetingMinutesFeedback,
  deleteMeetingMinutesFeedback,
  saveProjectUpdateDraft,
  createProjectKnowledgeItem,
  listProjectKnowledgeItems,
  updateProjectKnowledgeItem,
  archiveProjectKnowledgeItem,
  getProjectKnowledgeStatus,
  ingestApprovedProjectReportVersion,
  chunkKnowledgeText,
  listProjectOptions,
  createProject,
  updateProject,
  deleteProject,
  listProjectReports,
  getProjectReportDetail,
  saveProjectReportDetail,
  deleteProjectReport,
  deleteProjectReports,
  listProjectMilestones,
  getProjectMilestoneDetail,
  createProjectMilestone,
  updateProjectMilestone,
  deleteProjectMilestone,
  deactivateProjectMilestones,
  getProjectContextSnapshot,
  createProjectContextSnapshot,
  getProjectContext,
  cleanupProjectUpdateTestContext,
  markProjectContextOfficial,
  getMeetingStatus,
  ensureMeetingJobQueueSchema,
  queueMeetingMinutesGeneration,
  listMeetingMinutesJobs,
  getMeetingMinutesJob,
  claimNextMeetingMinutesJob,
  updateMeetingMinutesJobProgress,
  markMeetingMinutesJobCompleted,
  markMeetingMinutesJobFailure,
  retryMeetingMinutesJob,
  cancelMeetingMinutesJob,
  deleteMeetingMinutesJob,
  updateMeetingMinutesJobResult,
  claimNextJob,
  markJobCompleted,
  markJobFailure,
  queueWebhookJob,
  markWebhookSuccess,
  markWebhookFailure,
  hasDatabaseConfig,
  getDatabaseConfigError,
  query,
  runPsql,
  createAuthUser,
  findAuthUserByEmail,
  touchAuthLastLogin,
  createPasswordResetToken,
  consumePasswordResetToken,
  updateAuthPassword
};
