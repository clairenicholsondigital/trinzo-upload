'use strict';

// "Process / pipeline planning" was correctly removed from the reviewer-facing vocabulary in
// favour of General. Retain its measured prompt profile internally when the meeting identity
// itself clearly names that subject. Shared by the queued stage and the scorecard so the two
// cannot drift apart again.
function stagedGenerationMeetingType(selectedMeetingType, meetingIdentity) {
  const selected = String(selectedMeetingType || '');
  const identity = String(meetingIdentity || '');
  if (selected === 'General' && /\bimporter[\s_-]*obligations?\b/i.test(identity)) return 'Importer obligations review';
  if (selected === 'General' && /(?:lead[\s_-]*generation|generation[\s_-]*pipeline|pipeline[\s_-]*(?:planning|review))/i.test(identity)) return 'Process / pipeline planning';
  if (selected === 'General' && /\b(?:project|consultancy|retainer)\b.*\b(?:check[\s_-]*in|weekly|status|review)\b/i.test(identity)) return 'Project / consultancy check-in';
  return selected;
}

module.exports = {
  stagedGenerationMeetingType
};
