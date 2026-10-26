'use strict';

const { hasMilestoneCreationIntent } = require('./milestoneCreationIntent');

// Report rows include carried context and accepted semantic matches. They are
// deliberately not position-aligned with the raw extraction segments.
const milestoneKey = row => String(row?.comparison_key || row?.milestone || row?.milestoneName || '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const meaningful = row => !['', 'unknown', 'unclassified', 'none', 'general'].includes(milestoneKey(row));
const invalid = message => Object.assign(new Error(message), { statusCode: 400 });

function milestoneId(row) {
  if (row?.milestoneId === undefined || row.milestoneId === null || row.milestoneId === '') return null;
  const value = Number(row.milestoneId);
  if (!Number.isSafeInteger(value) || value < 1) throw invalid('A valid project milestone ID is required.');
  return value;
}

function evidence(row) {
  const items = Array.isArray(row?.semantic_evidence) && row.semantic_evidence.length
    ? row.semantic_evidence : Array.isArray(row?.evidence) ? row.evidence : [];
  return items.map(item => typeof item === 'string' ? { text: item, confidence: row.confidence } : item)
    .filter(item => item && typeof item.text === 'string' && item.text.trim());
}

const supported = row => evidence(row).length > 0
  || Boolean(String(row?.normalised_evidence_summary || row?.excerpt || '').trim());

function bindingsFor(result) {
  const raw = Array.isArray(result?.segments) ? result.segments : [];
  const reports = Array.isArray(result?.projectReport?.milestones) ? result.projectReport.milestones : [];
  const rows = reports.length ? reports : raw;
  return rows.map(row => {
    const targetId = milestoneId(row);
    const base = { row: { ...row }, milestoneId: targetId, source: {}, assess: false };
    if (row.transcript_update_status === 'carried_forward') return base;
    if (!targetId && !meaningful(row)) return base;

    let source;
    if (!reports.length) source = row;
    else if (row.transcript_update_status === 'updated_from_transcript' && supported(row)) source = row;
    else {
      let candidates = targetId ? raw.filter(segment => milestoneId(segment) === targetId) : [];
      if (!candidates.length && meaningful(row)) {
        candidates = raw.filter(segment => meaningful(segment) && milestoneKey(segment) === milestoneKey(row)
          && (!targetId || !milestoneId(segment) || milestoneId(segment) === targetId));
      }
      // A thin legacy row needs an unambiguous source association.
      if (candidates.length === 1) source = candidates[0];
    }
    if (!source || !supported(source)) return base;

    const merged = { ...source, ...row };
    merged.delivery_status = row.delivery_status || row.status || source.delivery_status || source.status;
    merged.normalised_evidence_summary = row.normalised_evidence_summary || row.excerpt
      || source.normalised_evidence_summary || source.excerpt || source.status_resolution_note || '';
    merged.semantic_evidence = evidence(row).length ? evidence(row) : evidence(source);
    merged.delivery_status_confidence = row.delivery_status_confidence ?? row.confidence
      ?? source.delivery_status_confidence ?? source.confidence;
    return {
      ...base, milestoneId: targetId || milestoneId(source), row: merged, source: merged,
      evidence: merged.semantic_evidence, assess: true
    };
  });
}

function resolveProjectMilestones(bindings, coreRows, options = {}) {
  const seen = new Set();
  return bindings.map(binding => {
    const active = coreRows.filter(milestone => milestone.is_active !== false);
    const matches = binding.milestoneId
      ? active.filter(milestone => Number(milestone.id) === binding.milestoneId)
      : active.filter(milestone => milestone.milestone_name === (binding.row.milestone || binding.source.milestone));
    if (binding.milestoneId && matches.length !== 1) {
      throw invalid('The milestone ID is not an active milestone in the selected project.');
    }
    if (!binding.milestoneId && matches.length > 1) {
      throw invalid('Ambiguous milestone name. Supply its project milestone ID.');
    }
    const core = matches[0];
    const name = binding.row.milestone || binding.source.milestone || '';
    if (!core && options.enforceCreationIntent) {
      const inactive = coreRows.some(milestone => milestone.is_active === false
        && milestoneKey({ milestone: milestone.milestone_name }) === milestoneKey({ milestone: name }));
      const admitted = !inactive && binding.assess && hasMilestoneCreationIntent(name, options.transcriptText);
      if (!admitted) return { ...binding, coreId: null, assess: false,
        admissionReason: inactive ? 'inactive_milestone' : 'no_source_creation_intent' };
    }
    const target = core ? 'id:' + core.id : 'name:' + (binding.row.milestone || binding.source.milestone || '');
    if (binding.assess && seen.has(target)) throw invalid('Ambiguous repeated milestone assessment.');
    if (binding.assess) seen.add(target);
    return {
      ...binding, coreId: core ? Number(core.id) : null,
      row: { ...binding.row, ...(core ? { milestone: core.milestone_name } : {}) }
    };
  });
}

module.exports = { bindingsFor, resolveProjectMilestones };
