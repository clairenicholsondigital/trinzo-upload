const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const {
  renderMinutesForProjectUpdate,
  minutesHaveContent,
  minutesActionsForProjectReport,
  applyMinutesActionsToProjectReport
} = require('../utils/minutesForProjectUpdate');

const minutes = {
  details: { meetingTitle: 'Project Apollo weekly update', meetingDate: '14 October 2026' },
  executiveSummary: 'Infrastructure is on track; data profiling may slip by a week.',
  discussion: [
    { topic: 'Cloud infrastructure', points: ['The landing zone is built and on track to complete by next fortnight.'] },
    { topic: 'Data migration', points: ['There is a risk the data profiling phase slips a week, review at 10:30 on Friday.'] }
  ],
  actions: [
    { owner: 'Lewis Grant', action: 'Log the data profiling bottleneck as a risk', deadline: 'Friday 17 October' },
    { owner: 'Not stated', action: 'Share the plan', deadline: 'Not stated' }
  ]
};

test('renders every line as a speaker turn the analyser can parse', () => {
  const text = renderMinutesForProjectUpdate(minutes);
  const lines = text.split('\n');
  assert.ok(lines.every((line) => /^[A-Z][A-Za-z ]+: /.test(line)), text);
  assert.ok(!/\d:\d{2}/.test(text), 'clock times would be read as transcript timestamps');
  assert.match(text, /^Minutes: Data migration: There is a risk/m);
  assert.match(text, /^Lewis Grant: Action: I will log the data profiling bottleneck as a risk\. Owner: Lewis Grant\. Due: Friday 17 October\.$/m);
});

test('can leave actions out of the analyser text', () => {
  const text = renderMinutesForProjectUpdate(minutes, { includeActions: false });
  assert.doesNotMatch(text, /Action:/);
  assert.match(text, /Cloud infrastructure/);
});

test('maps reviewed minutes actions into the project report shape', () => {
  const actions = minutesActionsForProjectReport(minutes.actions);
  assert.deepEqual(actions.map((a) => [a.action, a.meetingActionPointOwner, a.deadline]), [
    ['Log the data profiling bottleneck as a risk.', 'Lewis Grant', 'Friday 17 October'],
    ['Share the plan.', 'Owner not specified', '']
  ]);
  const result = { projectReport: { actions: [{ action: 'Complete by next fortnight.' }] } };
  applyMinutesActionsToProjectReport(result, actions);
  assert.equal(result.projectReport.actions.length, 2);
  assert.equal(result.projectReport.actionsSource, 'meeting_minutes_agent');
  const untouched = { projectReport: { actions: [{ action: 'Keep me.' }] } };
  applyMinutesActionsToProjectReport(untouched, []);
  assert.equal(untouched.projectReport.actions[0].action, 'Keep me.');
});

test('knows when minutes are still empty', () => {
  assert.equal(minutesHaveContent({ discussion: [], actions: [] }), false);
  assert.equal(minutesHaveContent({ discussion: [{ topic: 'x', points: [] }], actions: [{ action: ' ' }] }), false);
  assert.equal(minutesHaveContent(minutes), true);
});

test('the project-update analyser reads rendered minutes as turns', () => {
  const text = renderMinutesForProjectUpdate(minutes, { includeActions: false });
  const script = `import sys, json\nsys.path.insert(0, ${JSON.stringify(path.join(__dirname, '..', 'scripts'))})\nfrom python_llm import parse_turns\nprint(json.dumps([t.speaker for t in parse_turns(sys.stdin.read())]))`;
  const speakers = JSON.parse(execFileSync('python3', ['-c', script], { input: text, encoding: 'utf8' }));
  assert.equal(speakers.length, text.split('\n').length);
  assert.ok(speakers.every((speaker) => speaker === 'Minutes'));
});
