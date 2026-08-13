'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { actionHasConcreteObject, applyOperationalPhaseTiming, attachTemporalContext, composeDecision, consolidate, deriveRoleDecisions } = require('../utils/canonicalMinutes/canonicalResolver');
const { deadlineFrom } = require('../utils/canonicalMinutes/stages');

test('generic consolidation groups paraphrases by owner and shared entity anchor', () => {
  const events = new Map([
    ['a', { id: 'a', turnIndex: 2 }],
    ['b', { id: 'b', turnIndex: 7 }]
  ]);
  const result = consolidate([
    { owner: 'Alex Morgan', action: 'Contact Morgan with the revised delivery date', evidenceIds: ['a'] },
    { owner: 'Alex Morgan', action: 'Square Morgan off today', evidenceIds: ['b'] }
  ], {
    textOf: (item) => item.action,
    ownerOf: (item) => item.owner,
    qualityOf: (item) => item.action.length,
    eventById: events,
    anchorGrouping: true,
    anchorTurnDistance: 12
  });
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].evidenceIds, ['a', 'b']);
});

test('generic consolidation does not group the same entity across different owners', () => {
  const result = consolidate([
    { owner: 'Alex Morgan', action: 'Contact Morgan today', evidenceIds: ['a'] },
    { owner: 'Blair Jones', action: 'Send Morgan the report', evidenceIds: ['b'] }
  ], {
    textOf: (item) => item.action,
    ownerOf: (item) => item.owner,
    qualityOf: () => 1,
    eventById: new Map([['a', { turnIndex: 1 }], ['b', { turnIndex: 2 }]]),
    anchorGrouping: true
  });
  assert.equal(result.length, 2);
});

test('decision composition normalises schedules and conditional policies', () => {
  const events = new Map([
    ['schedule', { text: "Decision: release stays on Friday, provided the note is ready." }],
    ['policy', { text: 'We only pause if the error rate exceeds two per cent.' }]
  ]);
  assert.equal(composeDecision({ text: '', evidenceIds: ['schedule'] }, events), 'Keep release scheduled for Friday');
  assert.equal(composeDecision({ text: '', evidenceIds: ['policy'] }, events), 'Pause only if the error rate exceeds two per cent');
});

test('action completeness rejects temporal fragments without a task object', () => {
  assert.equal(actionHasConcreteObject('Still message you at five minutes'), false);
  assert.equal(actionHasConcreteObject('Send the revised report at five'), true);
});

test('temporal attachment links a duration action to a nearby non-action milestone', () => {
  const evidence = { events: [
    { id: 'milestone', turnIndex: 3, speaker: 'Chair', text: 'Decision is launch Thursday at ten.', roles: ['decision_candidate'] },
    { id: 'policy', turnIndex: 3, speaker: 'Chair', text: 'We only pause above two per cent.', roles: [] },
    { id: 'action', turnIndex: 5, speaker: 'Analyst', text: "I'll monitor it for the first hour.", roles: ['action_candidate'] }
  ] };
  const profile = { events: { milestone: { temporalRoleProbabilities: { deadline_previous: 0.2 } } } };
  const [result] = attachTemporalContext([
    { owner: 'Analyst', action: 'Monitor the dashboard for the first hour', deadline: 'Not stated', evidenceIds: ['action'] }
  ], evidence, profile, deadlineFrom);
  assert.equal(result.deadline, 'first hour after Thursday at ten');
});

test('distributed recaps inherit preparation and execution phases generically', () => {
  const evidence = { events: [
    { id: 'heading', text: 'Actions.', speaker: 'Chair' },
    { id: 'asset', text: 'Build the final slide.', speaker: 'Designer' },
    { id: 'host', text: 'I am handling the opening and handovers.', speaker: 'Chair' },
    { id: 'milestone', text: 'The live workshop starts at eleven.', speaker: 'Chair' }
  ] };
  const topology = { mode: 'distributed_recap', evidenceWindow: { startEventId: 'heading', endEventId: 'milestone' } };
  const result = applyOperationalPhaseTiming([
    { action: 'Build the final slide', deadline: 'Not stated', evidenceIds: ['asset'] },
    { action: 'Handle the opening and handovers', deadline: 'Not stated', evidenceIds: ['host'] }
  ], evidence, topology);
  assert.equal(result[0].deadline, 'before the live session');
  assert.equal(result[1].deadline, 'during the live session');
});

test('role aggregation derives a canonical role only when both responsibilities are explicit', () => {
  const evidence = { participants: ['Alex Morgan'], events: [
    { id: 'open', speaker: 'Alex Morgan', text: 'I am handling the opening.' },
    { id: 'close', speaker: 'Alex Morgan', text: 'I think I close with the final summary.' }
  ] };
  assert.deepEqual(deriveRoleDecisions(evidence), [{ text: 'Use Alex Morgan as host and closer', evidenceIds: ['open', 'close'], deterministic: true }]);
});
