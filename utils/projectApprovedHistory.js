'use strict';

// Approved report JSON is the reviewed snapshot. Generated assessment tables
// remain extraction history; they are not a substitute for that snapshot.
function approvedProjectHistory(versions, milestones, limit = 20) {
  const healthHistory = [], milestoneHistory = [], riskSuggestions = [], recentReports = [];
  for (const sourceVersion of versions) {
    const version = { ...sourceVersion, reportId: Number(sourceVersion.reportId), reportVersionId: Number(sourceVersion.reportVersionId), versionNumber: Number(sourceVersion.versionNumber) };
    const report = version.projectReport || {};
    const { projectReport, ...metadata } = version;
    const provenance = { reportId: version.reportId, reportVersionId: version.reportVersionId, createdAt: version.versionCreatedAt };
    recentReports.push({ ...metadata, overallHealth: report.overallHealth || '', overallHealthRag: report.overallHealthRag || '', summary: report.summary || '', comparisonSnapshot: report.comparisonSnapshot || {} });
    for (const [area, detail] of Object.entries(report.healthAreas || {})) {
      if (!['scope', 'schedule', 'financial', 'resources', 'other_issue_risk'].includes(area) || !detail || typeof detail !== 'object') continue;
      healthHistory.push({ ...provenance, area, status: detail.status || 'unknown', trend: detail.trend || 'stable', confidence: detail.confidence,
        rationale: detail.evidenceNotes || (Array.isArray(detail.evidence) ? detail.evidence.map(e => typeof e === 'string' ? e : e?.text || '').filter(Boolean).join('\n') : '') });
    }
    // Stable ID first; exact unique name only for legacy approved snapshots.
    // Ambiguous/foreign IDs never fall back to a different name or row position.
    const bindings = new Map();
    for (const row of Array.isArray(report.milestones) ? report.milestones : []) {
      if (!row || typeof row !== 'object') continue;
      const hasId = row.milestoneId != null && row.milestoneId !== '';
      const candidates = milestones.filter(m => hasId ? Number(m.milestoneId) === Number(row.milestoneId)
        : m.milestoneName === (row.milestone || row.milestoneName));
      if (candidates.length !== 1) continue;
      const id = String(candidates[0].milestoneId);
      // Duplicate target rows are ambiguous, not a first/last-row vote.
      bindings.set(id, bindings.has(id) ? null : { row, milestone: candidates[0] });
    }
    for (const binding of bindings.values()) {
      if (!binding) continue;
      const { row, milestone } = binding;
      const raw = row.delivery_status || row.status || 'unknown';
      const status = ({ complete: 'completed', in_progress: 'on_track', scheduled: 'on_track', in_review: 'on_track', awaiting_input: 'at_risk' })[raw] || raw;
      milestoneHistory.push({ ...provenance, milestoneId: milestone.milestoneId, milestoneName: milestone.milestoneName, comparisonKey: milestone.comparisonKey,
        status, trend: row.trend || 'stable', confidence: row.confidence ?? row.delivery_status_confidence,
        summary: row.normalised_evidence_summary ?? row.summary ?? row.excerpt ?? '', forecastFinishDate: row.forecast_finish_date ?? row.forecastDeadline ?? null });
    }
    for (const [index, risk] of (Array.isArray(report.risks) ? report.risks : []).entries()) {
      if (!risk || typeof risk !== 'object') continue;
      riskSuggestions.push({ ...provenance, riskSuggestionId: `${version.reportVersionId}:${index}`, riskTitle: risk.riskTitle || risk.title || '',
        description: risk.description || '', suggestedMitigation: risk.suggestedMitigation || risk.mitigation || '', confidence: risk.confidence, reviewStatus: 'accepted' });
    }
  }
  for (const milestone of milestones) {
    const history = milestoneHistory.filter(a => String(a.milestoneId) === String(milestone.milestoneId));
    milestone.latestAssessment = history[0] || null;
    milestone.previousAssessment = history[1] || null;
  }
  return { recentReports: recentReports.slice(0, limit), healthHistory: healthHistory.slice(0, limit * 5), milestoneHistory: milestoneHistory.slice(0, limit * 25), riskSuggestions: riskSuggestions.slice(0, limit * 10) };
}

module.exports = { approvedProjectHistory };
