#!/usr/bin/env node
require('dotenv').config();

const {
  query,
  hasDatabaseConfig,
  getDatabaseConfigError,
  ingestApprovedProjectReportVersion
} = require('../utils/db');
const { spawnProjectKnowledgeEmbedWorker } = require('../utils/knowledge');

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

function hasFlag(name) {
  return process.argv.includes(name);
}

async function main() {
  if (!hasDatabaseConfig()) throw new Error(getDatabaseConfigError());
  const dryRun = hasFlag('--dry-run');
  const projectId = Number(argValue('--project-id') || 0);
  const limit = Math.min(Math.max(Number(argValue('--limit') || 100), 1), 500);
  const params = [limit];
  let projectFilter = '';
  if (Number.isFinite(projectId) && projectId > 0) {
    params.push(projectId);
    projectFilter = `AND r.project_id = $${params.length}`;
  }
  const result = await query(
    `SELECT r.id AS report_id,
            r.project_id,
            rp.period_label,
            v.id AS report_version_id,
            v.report_payload,
            v.created_at
     FROM project_reports r
     JOIN project_report_versions v ON v.report_id = r.id
     LEFT JOIN project_reporting_periods rp ON rp.id = r.reporting_period_id
     WHERE r.report_status = 'approved'
       AND (r.approved_version_id = v.id OR r.approved_version_id IS NULL)
       ${projectFilter}
     ORDER BY v.created_at DESC, v.id DESC
     LIMIT $1`,
    params
  );
  const rows = result.rows || [];
  const summary = { ok: true, dryRun, considered: rows.length, ingestedVersions: 0, itemsCreated: 0, chunksCreated: 0, failures: [] };
  for (const row of rows) {
    if (dryRun) continue;
    const ingestion = await ingestApprovedProjectReportVersion({
      projectId: row.project_id,
      reportId: row.report_id,
      reportVersionId: row.report_version_id,
      periodLabel: row.period_label,
      payload: row.report_payload,
      createdAt: row.created_at
    });
    if (ingestion.ok) {
      summary.ingestedVersions += 1;
      summary.itemsCreated += Number(ingestion.itemsCreated || 0);
      summary.chunksCreated += Number(ingestion.chunksCreated || 0);
    } else {
      summary.failures.push({ reportVersionId: row.report_version_id, error: ingestion.error || 'Unknown ingestion error' });
    }
  }
  if (!dryRun && summary.chunksCreated > 0) {
    summary.embeddingWorker = spawnProjectKnowledgeEmbedWorker(Number.isFinite(projectId) && projectId > 0 ? ['--project-id', String(projectId)] : []);
  }
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
