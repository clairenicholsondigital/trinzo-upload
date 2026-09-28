const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../routes/api');

function draft(overrides = {}) {
  return {
    draftId: '42', status: 'complete', updatedAt: '2026-09-28T12:00:00.000Z',
    details: {
      meetingTitle: 'Client launch review', meetingDate: '2026-09-27', meetingLocation: 'Teams',
      internalAttendees: ['Alex Reed'], clientAttendees: ['Sam Okoro'], allAttendees: ['Alex Reed', 'Sam Okoro']
    },
    sourceUnits: [
      { id: 'T1', speaker: 'Sam Okoro', timestamp: '00:10', text: 'We agreed the launch date will be 9 November.' },
      { id: 'T2', speaker: 'Alex Reed', timestamp: '00:30', text: 'I will tell the board next week.' }
    ],
    discussion: [{
      id: 'topic-1', topic: 'Go-live planning',
      points: [{ id: 'p1', text: 'The launch plan was reviewed.', evidenceIds: ['T1'] }],
      decisions: [{ id: 'd1', text: 'The launch date is 9 November.', evidenceIds: ['T1'] }],
      openQuestions: [{ id: 'q1', text: 'Does the support rota need changing?', evidenceIds: ['T1'] }]
    }],
    actions: [{
      id: 'a1', action: 'Tell the board about the new launch date.', owners: ['Alex Reed'],
      timing: { kind: 'deadline', wording: 'next week', exactDate: '' }, evidenceIds: ['T2']
    }, {
      id: 'a2', action: 'Confirm the support rota.', owners: [],
      timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds: ['T1']
    }],
    reviewFlags: [], keptActionIds: [],
    ...overrides
  };
}

test('meeting insights groups grounded meeting knowledge and retains its source', () => {
  const result = api.meetingInsights.buildMeetingInsights([draft()]);
  assert.deepEqual(result.stats, { meetings: 1, decisions: 1, actions: 2, openQuestions: 1 });
  const decision = result.results.find((entry) => entry.kind === 'decision');
  assert.equal(decision.meeting.title, 'Client launch review');
  assert.equal(decision.topic, 'Go-live planning');
  assert.equal(decision.evidence[0].text, 'We agreed the launch date will be 9 November.');
  assert.equal(decision.meeting.resumeUrl, '/meeting-minutes-agent?draftId=42');
  assert.equal(Object.hasOwn(decision.meeting, 'rawTranscript'), false);
});

test('meeting insights understands decision intent and supports person, topic and date filters', () => {
  const builder = api.meetingInsights.buildMeetingInsights;
  const asked = builder([draft()], { q: 'What did we agree about the go-live?' });
  assert.equal(asked.results[0].kind, 'decision');
  assert.match(asked.results[0].text, /9 November/);
  const decisionIntent = builder([draft()], { q: 'What decisions were made?' });
  assert.equal(decisionIntent.results[0].kind, 'decision');

  const owned = builder([draft()], { type: 'action', person: 'Alex Reed', topic: 'Go-live planning', from: '2026-09-01', to: '2026-09-30' });
  // Actions are not assigned a discussion topic unless the source draft does
  // so explicitly, preventing the index from inventing a relationship.
  assert.equal(owned.pagination.total, 0);
  const byPerson = builder([draft()], { type: 'action', person: 'Alex Reed' });
  assert.equal(byPerson.pagination.total, 1);
  assert.match(byPerson.results[0].text, /Tell the board/);
});

test('meeting insights calls out only explicit gaps as needing attention', () => {
  const result = api.meetingInsights.buildMeetingInsights([draft()]);
  const gap = result.attention.find((entry) => /support rota/i.test(entry.text) && entry.kind === 'action');
  assert.ok(gap);
  assert.equal(gap.attentionReason, 'No owner or date agreed');
  assert.ok(result.attention.some((entry) => entry.kind === 'question' && entry.attentionReason === 'Open question'));
});
