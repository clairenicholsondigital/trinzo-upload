'use strict';

function normaliseMeetingAgentFileName(value) {
  return String(value || '').trim().toLocaleLowerCase('en-GB');
}

function matchingMeetingAgentDrafts(drafts, { fileName, fileSize } = {}) {
  const wantedName = normaliseMeetingAgentFileName(fileName);
  const wantedSize = Number(fileSize);
  if (!wantedName || !Number.isSafeInteger(wantedSize) || wantedSize < 0) return [];

  return (Array.isArray(drafts) ? drafts : [])
    .filter((draft) => normaliseMeetingAgentFileName(draft?.fileName) === wantedName)
    .filter((draft) => Number(draft?.uploadSizeBytes) === wantedSize)
    .map((draft) => ({
      draftId: String(draft.draftId || ''),
      title: String(draft.title || draft.details?.meetingTitle || 'Meeting minutes'),
      fileName: String(draft.fileName || fileName || ''),
      createdAt: draft.createdAt || null,
      updatedAt: draft.updatedAt || null,
      resumeUrl: `/meeting-minutes-agent?draftId=${encodeURIComponent(String(draft.draftId || ''))}`
    }))
    .filter((draft) => draft.draftId);
}

module.exports = { normaliseMeetingAgentFileName, matchingMeetingAgentDrafts };
