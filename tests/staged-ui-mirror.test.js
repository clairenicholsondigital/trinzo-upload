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
  assert.equal(output.contractVersion, 'staged-meeting-minutes-ui-mirror-v2');
  assert.deepEqual(output.ui.screenOrder, ['details', 'summary', 'discussion', 'actions', 'finalReview']);
  assert.equal(output.ui.activeScreenKey, 'finalReview');
  assert.deepEqual(output.ui.screens[0].data, sequence.state.details);
  assert.equal(Object.prototype.hasOwnProperty.call(output.ui.screens[1].data, 'overallTopics'), false);
  assert.deepEqual(output.ui.screens[1].visibleFields, ['meetingPurpose', 'objectives', 'executiveSummary']);
  assert.deepEqual(output.ui.screens[2].data, sequence.state.discussion);
  assert.equal(output.ui.screens[2].organizer.mode, 'discussion_first');
  assert.equal(output.ui.screens[2].organizer.operations.movePoint, true);
  assert.equal(output.ui.screens[2].organizer.automationSubmitField, 'confirmedDiscussion');
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

test('shared workflow serves simplified Actions directly with self-consistent telemetry', async () => {
  const actions = [{ owner: 'Alex Smith', action: 'Complete release verification.', deadline: 'Friday' }];
  const output = await api.stagedEvaluation.stagedWorkflowResponse(
    'actions',
    { text: 'Alex Smith: I will complete release verification by Friday. '.repeat(4), source: 'test', fileName: 'release.txt' },
    {
      confirmedSummary: { overallTopics: ['Release verification'] },
      confirmedDiscussion: [{ topic: 'Release verification', points: ['Verification remained open.'] }]
    },
    {
      generateActions: async () => ({
        actions,
        telemetry: {
          topicCount: 1,
          calls: 1,
          actionCount: 1,
          tokenUsage: [{ prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 }]
        }
      })
    }
  );
  assert.equal(output.pipeline, 'simplified_staged_minilm_trooper_v1');
  assert.deepEqual(output.screens.actions, actions);
  assert.deepEqual(output.pipelineHealth.actionAccounting, { supplied: 1, published: 1 });
  assert.deepEqual(output.telemetryPreview.trooper.usage, { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 });
  assert.equal(output.telemetryPreview.simplifiedPipeline.fallback, false);
});

test('shared workflow invokes canonical only after simplified validation fails', async () => {
  let fallbackCalls = 0;
  const output = await api.stagedEvaluation.stagedWorkflowResponse(
    'discussion',
    { text: 'Alex Smith: Release verification remains open. '.repeat(4), source: 'test', fileName: 'release.txt' },
    { confirmedSummary: { overallTopics: ['Release verification'] } },
    {
      generateDiscussionInventory: async () => { throw new Error('invalid simplified response'); },
      canonicalFallback: async (_stage, _transcript, input) => {
        fallbackCalls += 1;
        assert.equal(input._skipSimplifiedOverride, true);
        return {
          pipeline: 'canonical_staged_v2',
          screens: { discussion: [{ topic: 'Release verification', points: ['Canonical fallback.'] }] },
          pipelineHealth: { served: 'full' },
          telemetryPreview: { trooper: { usage: { total_tokens: 50 } } }
        };
      }
    }
  );
  assert.equal(fallbackCalls, 1);
  assert.equal(output.pipeline, 'canonical_staged_v2');
  assert.equal(output.pipelineHealth.simplifiedPipeline.fallback, true);
  assert.match(output.telemetryPreview.simplifiedPipeline.reason, /invalid simplified response/);
});

test('browserless sequence passes the same confirmed screens through the shared stage runner', async () => {
  const calls = [];
  const stageRunner = async (stage, _transcript, input) => {
    calls.push({ stage, input });
    if (stage === 'summary') return {
      pipeline: 'shared-test', screens: { summary: { meetingPurpose: 'Review release readiness.', objectives: [], executiveSummary: 'Readiness was reviewed.', overallTopics: ['Release verification'], topicRefs: [] } }, validationFlags: []
    };
    if (stage === 'discussion') return {
      pipeline: 'shared-test', screens: { discussion: [{ topic: 'Release verification', points: ['Verification remained open.'] }] }, validationFlags: []
    };
    return {
      pipeline: 'shared-test', screens: { actions: [{ owner: 'Alex Smith', action: 'Complete release verification.', deadline: 'Friday' }] }, validationFlags: []
    };
  };
  const sequence = await api.stagedEvaluation.runStagedSequenceForEvaluation(
    'Alex Smith 0:01 Release verification remains open.\nAlex Smith 0:05 I will complete it by Friday.',
    { fileName: 'release.txt', stageRunner }
  );
  assert.deepEqual(calls.map((item) => item.stage), ['summary', 'discussion', 'actions']);
  assert.deepEqual(calls[1].input.confirmedSummary.overallTopics, ['Release verification']);
  assert.deepEqual(calls[2].input.confirmedDiscussion, sequence.state.discussion);
  assert.deepEqual(sequence.state.actions, [{ owner: 'Alex Smith', action: 'Complete release verification.', deadline: 'Friday' }]);
});

test('browserless sequence applies reviewer-organised discussion before generating actions', async () => {
  const reviewed = [{
    topic: 'Reviewer topic',
    points: ['The reviewer moved this point.'],
    topicId: 'reviewer-topic',
    evidenceIds: ['line_1_unit_0'],
    pointRefs: [{ evidenceIds: ['line_1_unit_0'] }]
  }];
  let actionsInput;
  await api.stagedEvaluation.runStagedSequenceForEvaluation(
    'Alex Smith 0:01 I will complete the review.',
    {
      confirmedDiscussion: reviewed,
      stageRunner: async (stage, _transcript, input) => {
        if (stage === 'summary') return { screens: { summary: { objectives: [], executiveSummary: 'Review.', overallTopics: [] } }, validationFlags: [] };
        if (stage === 'discussion') return { screens: { discussion: [{ topic: 'Suggested', points: ['Generated point.'] }] }, validationFlags: [] };
        actionsInput = input;
        return { screens: { actions: [] }, validationFlags: [] };
      }
    }
  );
  assert.deepEqual(actionsInput.confirmedDiscussion, reviewed);
});
