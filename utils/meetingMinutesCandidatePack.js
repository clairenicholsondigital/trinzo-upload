'use strict';

// Candidate selection and packing shared by provider prompts and V2 compatibility exports.

function candidatePromptPack(candidates = [], options = {}) {
  const source = (Array.isArray(candidates) ? candidates : []).filter((candidate) => candidate?.context);
  const rows = options.compact === true ? source.map((candidate) => ({
    candidateId: candidate.candidateId,
    focusEvidenceId: candidate.focusEvidenceId,
    evidenceIds: candidate.evidenceIds,
    ...(candidate.kindHints ? { kindHints: candidate.kindHints } : {}),
    ...(candidate.cueKinds ? { cueKinds: candidate.cueKinds } : {}),
    ...(candidate.dispositionHint ? { dispositionHint: candidate.dispositionHint } : {}),
    priority: candidate.priority,
    sequence: candidate.sequence,
    focusText: candidate.focusText
  })) : source;
  const maxCandidates = Math.max(1, Number(options.maxCandidates || 160));
  const maxChars = Math.max(1000, Number(options.maxChars || 60000));
  if (!rows.length) return [];
  const selected = [];
  const selectedIds = new Set();
  let chars = 2;
  const add = (candidate) => {
    if (!candidate || selectedIds.has(candidate.candidateId) || selected.length >= maxCandidates) return false;
    const size = JSON.stringify(candidate).length + 1;
    if (chars + size > maxChars) return false;
    selected.push(candidate);
    selectedIds.add(candidate.candidateId);
    chars += size;
    return true;
  };

  // First retain the strongest decision/acceptance/detail anchors. Then fill the
  // remaining budget evenly across the whole transcript, preventing a long
  // opening discussion from crowding out late workstreams.
  const highPriority = rows.filter((candidate) => Number(candidate.priority || 0) >= 5)
    .sort((left, right) => (left.sequence || 0) - (right.sequence || 0));
  const prioritySlots = Math.min(highPriority.length, Math.max(1, Math.floor(maxCandidates / 2)));
  for (let index = 0; index < prioritySlots; index += 1) {
    add(highPriority[Math.floor(index * highPriority.length / prioritySlots)]);
  }
  const remaining = rows.filter((candidate) => !selectedIds.has(candidate.candidateId));
  const slots = Math.max(0, maxCandidates - selected.length);
  if (slots && remaining.length) {
    const ordered = [];
    for (let index = 0; index < Math.min(slots, remaining.length); index += 1) {
      ordered.push(remaining[Math.floor(index * remaining.length / Math.min(slots, remaining.length))]);
    }
    ordered.forEach(add);
  }
  return selected.sort((left, right) => (left.sequence || 0) - (right.sequence || 0));
}

module.exports = {
  candidatePromptPack
};
