'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const api = require('../routes/api');

function sequenceFixture() {
  return {
    state: {
      details: { meetingTitle: 'Release review', meetingDate: '2026-08-27', meetingType: 'General Review', internalAttendees: ['Alex Smith'], clientAttendees: [] },
      summary: { meetingPurpose: 'Review release readiness.', objectives: ['Review readiness'], executiveSummary: 'Release readiness was reviewed.', overallTopics: ['Release verification'] },
      discussion: [{ topic: 'Release verification', points: ['Verification remained open.'] }],
      actions: [{ owner: 'Alex Smith', action: 'Complete release verification.', deadline: 'Friday' }]
    },
    visibleOutput: { meetingTitle: 'Release review', discussionPoints: ['Release verification: Verification remained open.'] },
    trace: [
      { stage: 'details', validationFlags: [] },
      { stage: 'summary', validationFlags: [] },
      { stage: 'discussion', validationFlags: [{ type: 'editorial_check', severity: 'info', message: 'Check wording.' }] },
      { stage: 'actions', validationFlags: [] }
    ]
  };
}

test('UI mirror returns the browser screen order and exact staged screen data', () => {
  const sequence = sequenceFixture();
  const output = api.stagedEvaluation.buildStagedUiMirror(sequence, { source: 'text', fileName: 'meeting.txt', transcriptLength: 500 });
  assert.equal(output.contractVersion, 'staged-meeting-minutes-ui-mirror-v1');
  assert.deepEqual(output.ui.screenOrder, ['details', 'summary', 'discussion', 'actions', 'finalReview']);
  assert.equal(output.ui.activeScreenKey, 'finalReview');
  assert.deepEqual(output.ui.screens[0].data, sequence.state.details);
  assert.deepEqual(output.ui.screens[1].data, sequence.state.summary);
  assert.deepEqual(output.ui.screens[2].data, sequence.state.discussion);
  assert.deepEqual(output.ui.screens[3].data, sequence.state.actions);
  assert.deepEqual(output.ui.screens[4].data.actions, sequence.state.actions);
  assert.equal(output.ui.screens[2].editorialChecks[0].message, 'Check wording.');
  assert.equal(Object.prototype.hasOwnProperty.call(output, 'diagnostics'), false);
});

test('UI mirror diagnostics are explicit opt-in', () => {
  const sequence = sequenceFixture();
  const output = api.stagedEvaluation.buildStagedUiMirror(sequence, {}, { includeDiagnostics: true });
  assert.deepEqual(output.diagnostics.trace, sequence.trace);
});

test('UI mirror route is authenticated and uses the real staged sequence', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'api.js'), 'utf8');
  assert.match(source, /router\.post\('\/staged-meeting-minutes\/ui-mirror', requireAuth, withTestUpload/);
  assert.match(source, /const sequence = await runStagedSequenceForEvaluation\(transcript\.text/);
  assert.match(source, /buildStagedUiMirror\(sequence/);
  assert.match(source, /if \(stage === 'actions'\) input\.confirmedDiscussion = state\.discussion/);
});
