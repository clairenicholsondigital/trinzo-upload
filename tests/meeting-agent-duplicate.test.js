const test = require('node:test');
const assert = require('node:assert/strict');

const { normaliseMeetingAgentFileName, matchingMeetingAgentDrafts } = require('../utils/meetingAgentDuplicate');

test('duplicate upload matching is case-insensitive for filename and exact for size', () => {
  const matches = matchingMeetingAgentDrafts([
    { draftId: '12', title: 'Existing minutes', fileName: 'Weekly Review.docx', uploadSizeBytes: 2048, createdAt: '2026-10-01' },
    { draftId: '13', title: 'Different size', fileName: 'Weekly Review.docx', uploadSizeBytes: 2049 },
    { draftId: '14', title: 'Different file', fileName: 'Other.docx', uploadSizeBytes: 2048 }
  ], { fileName: ' weekly review.DOCX ', fileSize: 2048 });

  assert.deepEqual(matches, [{
    draftId: '12',
    title: 'Existing minutes',
    fileName: 'Weekly Review.docx',
    createdAt: '2026-10-01',
    updatedAt: null,
    resumeUrl: '/meeting-minutes-agent?draftId=12'
  }]);
  assert.equal(normaliseMeetingAgentFileName(' A.DOCX '), 'a.docx');
});

test('invalid metadata produces no duplicate matches', () => {
  assert.deepEqual(matchingMeetingAgentDrafts([{ draftId: '1', fileName: 'a.docx', uploadSizeBytes: 0 }], { fileName: '', fileSize: 0 }), []);
  assert.deepEqual(matchingMeetingAgentDrafts([{ draftId: '1', fileName: 'a.docx', uploadSizeBytes: 0 }], { fileName: 'a.docx', fileSize: -1 }), []);
});
