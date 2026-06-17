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

async function listProjectReports(limit = 50) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
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

  await runPsql(`
BEGIN;
UPDATE project_reports
SET report_status = ${q(reportStatus)},
    file_name = ${q(reportName || `Report ${id}`)},
    updated_at = NOW()
WHERE id = ${id};
INSERT INTO project_report_versions (report_id, version_number, change_type, change_summary, saved_by, report_payload)
VALUES (${id}, ${nextVersion}, 'user_edit', ${q(payload.changeSummary || 'Saved from report detail page.')}, ${q(payload.savedBy || 'OpenClaw')}, ${qJson(nextPayload)});
COMMIT;`);

  return getProjectReportDetail(id);
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

async function listProjectMilestones(limit = 100) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 250);
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
  WHERE a.milestone_id = m.id
  ORDER BY v.created_at DESC, a.id DESC
  LIMIT 1
) latest ON TRUE
WHERE m.is_active = TRUE
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
    await runPsql(`SELECT id::text FROM projects WHERE project_name = ${q(projectName)} ORDER BY id LIMIT 1;`)
  );
  if (!projectId) {
    projectId = parseOptionalId(
      await runPsql(`INSERT INTO projects (project_name, description, status, updated_at)
        VALUES (${q(projectName)}, 'Created from /project-update-test milestones.', 'active', NOW())
        RETURNING id::text;`)
    );
  }
  if (!projectId) throw new Error('Could not create project milestone: missing project id.');

  let reportingPeriodId = parseOptionalId(
    await runPsql(`SELECT id::text FROM project_reporting_periods
      WHERE project_id = ${projectId} AND period_type = 'quarter' AND period_label = ${q(periodLabel)}
      ORDER BY id
      LIMIT 1;`)
  );
  if (!reportingPeriodId) {
    reportingPeriodId = parseOptionalId(
      await runPsql(`INSERT INTO project_reporting_periods (project_id, period_type, period_label, start_date, end_date)
        VALUES (${projectId}, 'quarter', ${q(periodLabel)}, ${q(quarterStartDate(periodLabel))}::date, ${q(quarterEndDate(periodLabel))}::date)
        ON CONFLICT (project_id, period_type, period_label) DO UPDATE SET period_label = EXCLUDED.period_label
        RETURNING id::text;`)
    );
  }
  if (!reportingPeriodId) throw new Error('Could not create project milestone: missing reporting period id.');

  const out = await runPsql(`
WITH existing AS (
  SELECT id
  FROM project_core_milestones
  WHERE project_id = ${projectId} AND milestone_name = ${q(milestoneName)} AND is_active = TRUE
  ORDER BY id
  LIMIT 1
), inserted AS (
  INSERT INTO project_core_milestones (project_id, reporting_period_id, category, milestone_name, description, baseline_finish_date, forecast_finish_date, sort_order, is_active)
  SELECT ${projectId}, ${reportingPeriodId}, ${q(category)}, ${q(milestoneName)}, ${q(description)}, ${qDate(baselineFinishDate)}, ${qDate(forecastFinishDate)},
    COALESCE((SELECT MAX(sort_order) + 1 FROM project_core_milestones WHERE project_id = ${projectId}), 0), TRUE
  WHERE NOT EXISTS (SELECT 1 FROM existing)
  RETURNING id
), updated AS (
  UPDATE project_core_milestones
  SET reporting_period_id = ${reportingPeriodId},
      category = ${q(category)},
      description = ${q(description)},
      baseline_finish_date = COALESCE(${qDate(baselineFinishDate)}, baseline_finish_date),
      forecast_finish_date = COALESCE(${qDate(forecastFinishDate)}, forecast_finish_date)
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
) selected;`);

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
  await runPsql(`
UPDATE project_core_milestones
SET baseline_finish_date = ${qDate(baselineFinishDate)},
    forecast_finish_date = ${qDate(forecastFinishDate)},
    description = ${q(description)}
WHERE id = ${id} AND is_active = TRUE;`);

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

async function getProjectContext(projectName = '', limit = 5) {
  const safeLimit = Math.min(Math.max(Number(limit) || 5, 1), 20);
  const name = String(projectName || process.env.PROJECT_UPDATE_DEFAULT_PROJECT || 'Project update test').trim() || 'Project update test';
  const projectOut = await runPsql(`
SELECT json_build_object(
  'projectId', id,
  'projectName', project_name,
  'clientName', COALESCE(client_name, ''),
  'description', COALESCE(description, ''),
  'status', status,
  'createdAt', created_at,
  'updatedAt', updated_at
)::text
FROM projects
WHERE project_name = ${q(name)}
ORDER BY id
LIMIT 1;`);
  const project = parseJsonLines(projectOut)[0] || null;
  if (!project) {
    return {
      projectName: name,
      found: false,
      activeMilestones: [],
      recentReports: [],
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
  WHERE a.milestone_id = m.id
    AND (latest.assessment IS NULL OR a.id <> ((latest.assessment->>'assessmentId')::BIGINT))
  ORDER BY v.created_at DESC, a.id DESC
  LIMIT 1
) previous ON TRUE
WHERE m.project_id = ${projectId} AND m.is_active = TRUE
ORDER BY m.sort_order, m.id;`));

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
ORDER BY v.created_at DESC, s.id DESC
LIMIT ${safeLimit * 10};`));

  const latestSnapshot = parseJsonLines(await runPsql(`
SELECT json_build_object(
  'snapshotId', id,
  'sourceReportVersionId', source_report_version_id,
  'snapshotType', snapshot_type,
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
    activeMilestones,
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

  const out = await runPsql(`
INSERT INTO project_context_snapshots (project_id, source_report_version_id, snapshot_type, context_payload, summary, created_by)
VALUES (${Number(context.projectId)}, ${sourceReportVersionId > 0 ? sourceReportVersionId : 'NULL'}, ${q(snapshotType)}, ${qJson(contextPayload)}, ${q(summary)}, ${q(createdBy)})
RETURNING id::text;`);
  const snapshotId = parseOptionalId(out);
  if (!snapshotId) throw new Error('Could not create project context snapshot.');

  const items = [];
  for (const milestone of context.activeMilestones || []) {
    const latest = milestone.latestAssessment || {};
    const previous = milestone.previousAssessment || {};
    items.push({
      itemType: 'milestone',
      itemKey: milestone.comparisonKey || projectContextItemKey(milestone.milestoneName, `milestone_${milestone.milestoneId}`),
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
  for (const risk of (context.riskSuggestions || []).slice(0, 20)) {
    items.push({
      itemType: 'risk',
      itemKey: projectContextItemKey(risk.riskTitle, `risk_${risk.riskSuggestionId}`),
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
    await runPsql(`INSERT INTO project_context_snapshot_items
      (snapshot_id, item_type, item_key, item_label, status, previous_status, trend, confidence, evidence, metadata)
      VALUES (${snapshotId}, ${q(item.itemType)}, ${q(item.itemKey)}, ${q(item.itemLabel)}, ${q(item.status)}, ${q(item.previousStatus)}, ${q(normaliseProjectTrend(item.trend))}, ${clampConfidence(item.confidence, 0.5)}, ${qJson(item.evidence)}, ${qJson(item.metadata)});`);
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

async function saveMeetingMinutesFeedback(payload = {}) {
  const route = String(payload.route || '/meeting-minutes-final').slice(0, 255);
  const feedbackType = String(payload.feedbackType || 'general').slice(0, 50);
  const message = String(payload.message || '').slice(0, 2000);
  const contactName = payload.contactName ? String(payload.contactName).slice(0, 120) : '';
  const contactEmail = payload.contactEmail ? String(payload.contactEmail).slice(0, 254) : '';
  const userAgent = payload.userAgent ? String(payload.userAgent).slice(0, 500) : '';
  const metadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};

  const sql = `
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
INSERT INTO meeting_minutes_feedback (route, feedback_type, message, contact_name, contact_email, user_agent, metadata)
VALUES (${q(route)}, ${q(feedbackType)}, ${q(message)}, ${q(contactName)}, ${q(contactEmail)}, ${q(userAgent)}, ${qJson(metadata)})
RETURNING id::text, created_at::text;`;

  const out = await runPsql(sql);
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
  const fixedAtSql = status === 'resolved' ? 'COALESCE(fixed_at, NOW())' : 'NULL';
  const out = await runPsql(`${meetingMinutesFeedbackSchemaSql()}
UPDATE meeting_minutes_feedback
SET status = ${q(status)},
    claire_comments = ${q(claireComments)},
    fix_details = ${q(fixDetails)},
    fixed_at = ${fixedAtSql},
    edited_at = NOW()
WHERE id = ${id}
RETURNING id::text;`);
  const updatedId = parseOptionalId(out);
  return updatedId ? getMeetingMinutesFeedback(updatedId) : null;
}

async function deleteMeetingMinutesFeedback(feedbackId) {
  const id = Number(feedbackId);
  if (!Number.isFinite(id) || id <= 0) return false;
  const out = await runPsql(`${meetingMinutesFeedbackSchemaSql()}
DELETE FROM meeting_minutes_feedback
WHERE id = ${id}
RETURNING id::text;`);
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
  const reportMilestones = Array.isArray(report?.milestones) ? report.milestones : [];
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
  const milestoneDraftFor = (segment, index) => {
    const segmentKey = String(segment?.comparison_key || segment?.milestone || '').toLowerCase();
    return reportMilestones[index]
      || reportMilestones.find((item) => String(item?.comparison_key || item?.milestone || '').toLowerCase() === segmentKey)
      || {};
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

  const milestoneCount = Math.max(segments.length, reportMilestones.length);
  for (let index = 0; index < milestoneCount; index += 1) {
    const segment = segments[index] || {};
    const milestoneDraft = milestoneDraftFor(segment, index);
    const milestoneName = milestoneDraft.milestone || segment.milestone || `Milestone ${index + 1}`;
    const baselineFinishDate = milestoneDraft.baseline_finish_date || milestoneDraft.baselineDeadline || milestoneDraft.deadline;
    const forecastFinishDate = milestoneDraft.forecast_finish_date || milestoneDraft.forecastDeadline || milestoneDraft.deadline;
    const deliveryStatus = segment.delivery_status || milestoneDraft.delivery_status || milestoneDraft.status;
    const trend = normaliseProjectTrend(milestoneDraft.trend || segment.trend || 'stable');
    const confidence = segment.delivery_status_confidence || milestoneDraft.delivery_status_confidence || segment.confidence || milestoneDraft.confidence;
    const summary = segment.normalised_evidence_summary || milestoneDraft.normalised_evidence_summary || segment.excerpt || milestoneDraft.excerpt || segment.status_resolution_note || '';
    const milestoneOut = await runPsql(`
WITH existing AS (
  SELECT id FROM project_core_milestones
  WHERE project_id = ${projectId} AND milestone_name = ${q(milestoneName)} AND is_active = TRUE
  ORDER BY id
  LIMIT 1
), inserted AS (
  INSERT INTO project_core_milestones (project_id, reporting_period_id, category, milestone_name, baseline_finish_date, forecast_finish_date, sort_order, is_active)
  SELECT ${projectId}, ${reportingPeriodId}, 'Transcript', ${q(milestoneName)}, ${qDate(baselineFinishDate)}, ${qDate(forecastFinishDate)}, ${index}, TRUE
  WHERE NOT EXISTS (SELECT 1 FROM existing)
  RETURNING id
), updated AS (
  UPDATE project_core_milestones
  SET baseline_finish_date = COALESCE(${qDate(baselineFinishDate)}, baseline_finish_date),
      forecast_finish_date = COALESCE(${qDate(forecastFinishDate)}, forecast_finish_date)
  WHERE id IN (SELECT id FROM existing)
  RETURNING id
)
SELECT id::text FROM inserted
UNION ALL
SELECT id::text FROM updated
UNION ALL
SELECT id::text FROM existing
LIMIT 1;`);
    const milestoneId = Number(milestoneOut.split('\n').find((item) => /^\d+$/.test(item)));
    await runPsql(`INSERT INTO project_report_milestone_assessments
      (report_version_id, milestone_id, status, trend, confidence, summary, forecast_finish_date)
      VALUES (${reportVersionId}, ${milestoneId}, ${q(toMilestoneAssessmentStatus(deliveryStatus))}, ${q(trend)}, ${clampConfidence(confidence)}, ${q(summary)}, ${qDate(forecastFinishDate)});`);
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
  return { id: Number(id), email: userEmail, fullName, passwordSalt, passwordHash, isActive: isActive === 't' || isActive === 'true' };
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
  saveMeetingMinutesFeedback,
  listMeetingMinutesFeedback,
  getMeetingMinutesFeedback,
  updateMeetingMinutesFeedback,
  deleteMeetingMinutesFeedback,
  saveProjectUpdateDraft,
  listProjectReports,
  getProjectReportDetail,
  saveProjectReportDetail,
  deleteProjectReport,
  listProjectMilestones,
  getProjectMilestoneDetail,
  createProjectMilestone,
  updateProjectMilestone,
  deleteProjectMilestone,
  getProjectContextSnapshot,
  createProjectContextSnapshot,
  getProjectContext,
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
