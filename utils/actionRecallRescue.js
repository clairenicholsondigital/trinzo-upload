'use strict';

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function buildActionRecallWindows(units, options = {}) {
  const rows = (Array.isArray(units) ? units : []).filter((row) => clean(row?.id) && clean(row?.text));
  const size = Math.max(3, Number(options.size || 5));
  const overlap = Math.min(size - 1, Math.max(0, Number(options.overlap ?? 3)));
  const step = Math.max(1, size - overlap);
  const windows = [];
  for (let start = 0; start < rows.length; start += step) {
    const evidence = rows.slice(start, start + size);
    if (!evidence.length) break;
    windows.push({
      id: `recall_${start + 1}_${start + evidence.length}`,
      start,
      evidenceIds: evidence.map((row) => clean(row.id)),
      evidence: evidence.map((row) => ({ id: clean(row.id), speaker: clean(row.speaker), text: clean(row.text) })),
      text: evidence.map((row) => `${clean(row.speaker)}: ${clean(row.text)}`).join('\n')
    });
    if (start + size >= rows.length) break;
  }
  return windows;
}

function overlapRatio(left, right) {
  const a = new Set(left || []);
  const b = new Set(right || []);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const id of a) if (b.has(id)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

function selectUncoveredRecallWindows(windows, decisions, publishedActions, limit = 8) {
  const covered = new Set((publishedActions || []).flatMap((row) => row.evidenceIds || []));
  const byId = new Map((decisions || []).map((row) => [clean(row?.id), row]));
  const ranked = (windows || []).filter((window) => {
    const decision = byId.get(window.id);
    const coveredCount = window.evidenceIds.filter((id) => covered.has(id)).length;
    return decision?.rescue === true && coveredCount / Math.max(1, window.evidenceIds.length) < 0.6;
  }).sort((left, right) => Number(byId.get(right.id)?.actionProbability || 0) - Number(byId.get(left.id)?.actionProbability || 0));
  const selected = [];
  for (const window of ranked) {
    if (selected.some((prior) => overlapRatio(prior.evidenceIds, window.evidenceIds) >= 0.6)) continue;
    selected.push(window);
    if (selected.length >= limit) break;
  }
  return selected;
}

module.exports = { buildActionRecallWindows, selectUncoveredRecallWindows, overlapRatio };
