'use strict';

// The legacy analyser produces segments, not the editable project-report
// contract. Keep its own evidence with each row; do not infer context matches
// or manufacture a positive headline when its health assessment is absent.
function buildFallbackProjectReport(result = {}) {
  const segments = Array.isArray(result.segments) ? result.segments.filter(row => row && typeof row === 'object' && !Array.isArray(row)) : [];
  const health = result.project_health_summary || {};
  const statuses = { green: 'on_track', amber: 'at_risk', red: 'off_track', blue: 'completed', unknown: 'unknown' };
  const rag = Object.hasOwn(statuses, health.overall_health) ? health.overall_health : 'unknown';
  const reason = typeof health.overall_health_reason === 'string' ? health.overall_health_reason.trim() : '';
  const summary = reason || 'Project health has not yet been assessed. Review the backup analysis and supporting minutes before approving.';
  // A status without an explanation is not a sufficient headline assessment.
  const assessedRag = reason ? rag : 'unknown';
  const keyUpdates = [...new Set(segments.map(row => row.normalised_evidence_summary || row.excerpt).filter(value => typeof value === 'string' && value.trim()))];
  return {
    reportStatus: 'draft',
    overallHealth: statuses[assessedRag],
    overallHealthRag: assessedRag,
    summary,
    keyUpdates,
    milestones: segments.filter(row => row && typeof row === 'object').map(row => ({ ...row })),
    risks: (Array.isArray(health.key_blockers) ? health.key_blockers : []).map(item => ({
      riskTitle: `${item.milestone || 'Workstream'} needs attention`,
      description: item.reason || '',
      relatedMilestone: item.milestone || ''
    })),
    actions: Array.isArray(result.actions) ? result.actions : [],
    healthAreas: Object.fromEntries(['scope', 'schedule', 'financial', 'resources', 'other_issue_risk'].map(area => [area, {
      status: area === 'schedule' ? statuses[assessedRag] : 'unknown',
      trend: 'unknown',
      confidence: 0,
      evidence: [],
      evidenceNotes: area === 'schedule' ? summary : 'Not assessed by the backup analyser.'
    }]))
  };
}

module.exports = { buildFallbackProjectReport };
