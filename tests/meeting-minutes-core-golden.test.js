const assert = require('node:assert/strict');
const test = require('node:test');

const {
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
