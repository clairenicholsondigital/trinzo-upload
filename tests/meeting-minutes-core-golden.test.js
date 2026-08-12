const assert = require('node:assert/strict');
const test = require('node:test');

const {
  assessWeightedErrors,
  getMeetingMinutesCoreGoldenStatus,
  scoreCaseOutput
} = require('../utils/meetingMinutesCoreGolden');

test('core golden status reads the current staged meeting-minutes suite', async () => {
  const status = await getMeetingMinutesCoreGoldenStatus();

  assert.equal(status.ok, true);
  assert.equal(status.validation.ok, true);
  assert.equal(status.summary.caseCount, 10);
  assert.equal(status.summary.benchmarkCount, 4);
  assert.equal(status.suite.path, 'scripts/meeting-minutes-core-golden');
  assert.ok(status.cases.some((item) => item.slug === 'explicit_action_recap'));
  assert.ok(status.cases.every((item) => Object.hasOwn(item, 'status')));
});

test('core golden scorer reports human-perfect gap from normalised output', () => {
  const manifest = {
    expected_attendees: ['Priya Sethi'],
    expected_client_attendees: [],
    expected_actions: [{ owner: 'Callum Reid', action: 'Restore the animation' }],
    expected_decisions: ['Use Priya as host'],
    expected_risks: ['Screen-share transfer can create dead air']
  };
  const output = {
    attendees: ['Priya Sethi'],
    client_attendees: [],
    actions: [{ owner: 'Callum Reid', action: 'Restore the animation on the slide' }],
    decisions: ['Use Priya as host and closer'],
    risks: ['Screen-share transfer could create dead air']
  };

  const score = scoreCaseOutput(manifest, output);

  assert.equal(score.score, 100);
  assert.equal(score.actionRecall, 1);
});

test('weighted scorer treats client split as minor and unsafe actions as blockers', () => {
  const manifest = {
    expected_attendees: ['Priya Sethi', 'Tom Whitfield'],
    expected_client_attendees: [],
    expected_actions: [{ owner: 'Priya Sethi', action: 'Send the final deck' }],
    completed_history_not_action: [{ owner: 'Tom Whitfield', detail: 'Uploaded the draft deck yesterday' }],
    expected_decisions: [],
    expected_risks: ['Recording could miss the opening']
  };
  const output = {
    attendees: ['Priya Sethi', 'Tom Whitfield'],
    client_attendees: ['Priya Sethi'],
    actions: [
      { owner: 'Priya Sethi', action: 'Send the final deck' },
      { owner: 'Tom Whitfield', action: 'Uploaded the draft deck yesterday' }
    ],
    decisions: [],
    risks: ['Extra room-noise risk']
  };

  const assessment = assessWeightedErrors(manifest, output);

  assert.equal(assessment.errorTypeCounts.incorrect_client_attendee, 1);
  assert.equal(assessment.errorTypeCounts.non_action_promoted_from_completed_history_not_action, 1);
  assert.equal(assessment.errorTypeCounts.missing_key_risk, 1);
  assert.equal(assessment.errorTypeCounts.extra_risk, 1);
  assert.equal(assessment.blockingCount, 2);
  assert.equal(assessment.penalty, 34);
  assert.equal(assessment.weightedScore, 66);
});
