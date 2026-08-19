'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveActionRecords } = require('../utils/canonicalMinutes/actionResolution');
const { deadlineFrom } = require('../utils/canonicalMinutes/stages');

function event(id, speaker, text, turnIndex) {
  return { id, speaker, text, turnIndex };
}

function temporalProfile(entries = {}) {
  return (item) => entries[item.id] || {};
}

test('resolves an explicitly named owner and a following milestone deadline', () => {
  const evidence = {
    participants: ['Jacqui Fox', 'Orla Murphy'],
    events: [
      event('e1', 'Jacqui Fox', 'Orla, can you review the QMS manual?', 1),
      event('e2', 'Orla Murphy', 'Yep, I will do that.', 2),
      event('e3', 'Jacqui Fox', 'Before the next client call.', 3)
    ]
  };
  const [resolved] = resolveActionRecords([{ owner: 'Not stated', action: 'Review the QMS manual', deadline: 'Not stated', evidenceIds: ['e1', 'e2'] }], evidence, { deadlineFrom });
  assert.equal(resolved.owner, 'Orla Murphy');
  assert.equal(resolved.deadline, 'Before the next client call');
  assert.deepEqual(resolved.evidenceIds, ['e1', 'e2', 'e3']);
});

test('does not borrow a deadline through a new commitment boundary', () => {
  const evidence = {
    participants: ['Orla Murphy', 'David King'],
    events: [
      event('e1', 'Orla Murphy', 'I will review the QMS manual.', 1),
      event('e2', 'David King', 'I will update the risk file.', 2),
      event('e3', 'David King', 'By Friday.', 3)
    ]
  };
  const [resolved] = resolveActionRecords([{ owner: 'Orla Murphy', action: 'Review the QMS manual', deadline: 'Not stated', evidenceIds: ['e1'] }], evidence, { deadlineFrom });
  assert.equal(resolved.deadline, 'Not stated');
});

test('uses contextual temporal evidence for the matching action rather than every nearby action', () => {
  const evidence = {
    participants: ['Alice Jones', 'Dan Wu', 'Bob Smith'],
    events: [
      event('e1', 'Alice Jones', 'I will send the validation report.', 1),
      event('e2', 'Dan Wu', 'I will circulate the meeting agenda.', 2),
      { ...event('e3', 'Bob Smith', 'Before Friday?', 3), previousText: 'I will circulate the meeting agenda.' },
      event('e4', 'Dan Wu', 'Yes.', 4)
    ]
  };
  const resolved = resolveActionRecords([
    { owner: 'Alice Jones', action: 'Send the validation report', deadline: 'Not stated', evidenceIds: ['e1'] },
    { owner: 'Dan Wu', action: 'Circulate the meeting agenda', deadline: 'Not stated', evidenceIds: ['e2'] }
  ], evidence, {
    deadlineFrom,
    profileFor: temporalProfile({
      e3: { temporalRoleProbabilities: { deadline_previous: 0.72, deadline_current: 0.08, historical: 0.05, other: 0.08, none: 0.07 } }
    })
  });

  assert.equal(resolved[0].deadline, 'Not stated');
  assert.equal(resolved[1].deadline, 'Friday');
  assert.deepEqual(resolved[1].evidenceIds, ['e2', 'e3']);
});

test('keeps historical and meeting-schedule dates away from actions', () => {
  const evidence = {
    participants: ['Alice Jones', 'Bob Smith'],
    events: [
      event('e1', 'Alice Jones', 'I will send the validation report.', 1),
      event('e2', 'Bob Smith', 'We discussed that before Friday.', 2),
      event('e3', 'Bob Smith', 'The next client call is Monday.', 3)
    ]
  };
  const [resolved] = resolveActionRecords([
    { owner: 'Alice Jones', action: 'Send the validation report', deadline: 'Not stated', evidenceIds: ['e1'] }
  ], evidence, {
    deadlineFrom,
    profileFor: temporalProfile({
      e2: { temporalRoleProbabilities: { deadline_previous: 0.46, historical: 0.18, deadline_current: 0.08, other: 0.14, none: 0.14 } },
      e3: { temporalRoleProbabilities: { deadline_previous: 0.61, other: 0.12, deadline_current: 0.08, historical: 0.07, none: 0.12 } }
    })
  });

  assert.equal(resolved.deadline, 'Not stated');
  assert.deepEqual(resolved.evidenceIds, ['e1']);
});

test('preserves event-bound deadline wording from a following temporal event', () => {
  const evidence = {
    participants: ['Alice Jones', 'Bob Smith'],
    events: [
      event('e1', 'Alice Jones', 'I will update the submission pack.', 1),
      { ...event('e2', 'Bob Smith', 'Once Cody confirms.', 2), previousText: 'I will update the submission pack.' }
    ]
  };
  const [resolved] = resolveActionRecords([
    { owner: 'Alice Jones', action: 'Update the submission pack', deadline: 'Not stated', evidenceIds: ['e1'] }
  ], evidence, {
    deadlineFrom,
    profileFor: temporalProfile({
      e2: { temporalRoleProbabilities: { deadline_previous: 0.66, deadline_current: 0.09, historical: 0.05, other: 0.1, none: 0.1 } }
    })
  });

  assert.equal(resolved.deadline, 'Once Cody confirms');
  assert.deepEqual(resolved.evidenceIds, ['e1', 'e2']);
});

test('keeps longer deadline-shaped replies while rejecting declarative scheduling statements', () => {
  for (const [text, expected] of [
    ['By the end of next week.', 'the end of next week'],
    ['Within five working days of receipt.', 'Within five working days of receipt'],
    ['Before the next client review meeting.', 'Before the next client review'],
    ['When the signed approval is received.', 'When the signed approval is received'],
    ['After the report is approved.', 'After the report is approved'],
    ['Once the document is signed.', 'Once the document is signed']
  ]) {
    const evidence = {
      participants: ['Alice Jones', 'Bob Smith'],
      events: [
        event('e1', 'Alice Jones', 'I will send the validation report.', 1),
        event('e2', 'Bob Smith', text, 2)
      ]
    };
    const [resolved] = resolveActionRecords([
      { owner: 'Alice Jones', action: 'Send the validation report', deadline: 'Not stated', evidenceIds: ['e1'] }
    ], evidence, { deadlineFrom });
    assert.equal(resolved.deadline, expected, text);
  }

  const schedulingEvidence = {
    participants: ['Alice Jones', 'Bob Smith'],
    events: [
      event('e1', 'Alice Jones', 'I will send the validation report.', 1),
      event('e2', 'Bob Smith', 'Friday is the client call.', 2),
      event('e3', 'Alice Jones', 'Yes.', 3)
    ]
  };
  const [schedulingResult] = resolveActionRecords([
    { owner: 'Alice Jones', action: 'Send the validation report', deadline: 'Not stated', evidenceIds: ['e1'] }
  ], schedulingEvidence, {
    deadlineFrom,
    profileFor: temporalProfile({
      e2: { temporalRoleProbabilities: { deadline_previous: 0.62, deadline_current: 0.08, historical: 0.06, other: 0.12, none: 0.12 } }
    })
  });
  assert.equal(schedulingResult.deadline, 'Not stated');
});

test('distinguishes an action timing answer from an unrelated meeting timing answer', () => {
  const actionTimingEvidence = {
    participants: ['Alice Jones', 'Bob Smith'],
    events: [
      event('e1', 'Alice Jones', 'I will send the validation report.', 1),
      event('e2', 'Bob Smith', 'When do you need that?', 2),
      event('e3', 'Alice Jones', 'Friday.', 3)
    ]
  };
  const [actionTiming] = resolveActionRecords([
    { owner: 'Alice Jones', action: 'Send the validation report', deadline: 'Not stated', evidenceIds: ['e1'] }
  ], actionTimingEvidence, { deadlineFrom });
  assert.equal(actionTiming.deadline, 'Friday');

  const meetingTimingEvidence = {
    ...actionTimingEvidence,
    events: [
      actionTimingEvidence.events[0],
      event('e2', 'Bob Smith', 'When is the next meeting?', 2),
      event('e3', 'Alice Jones', 'Friday.', 3)
    ]
  };
  const [meetingTiming] = resolveActionRecords([
    { owner: 'Alice Jones', action: 'Send the validation report', deadline: 'Not stated', evidenceIds: ['e1'] }
  ], meetingTimingEvidence, {
    deadlineFrom,
    profileFor: temporalProfile({
      e3: { temporalRoleProbabilities: { deadline_previous: 0.62, deadline_current: 0.08, historical: 0.06, other: 0.12, none: 0.12 } }
    })
  });
  assert.equal(meetingTiming.deadline, 'Not stated');
});

test('leaves competing dates unresolved unless the transcript explicitly corrects one', () => {
  const baseEvents = [
    event('e1', 'Alice Jones', 'I will send the validation report.', 1),
    event('e2', 'Bob Smith', 'By Tuesday.', 2),
    event('e3', 'Bob Smith', 'That needs to be done by Friday.', 3)
  ];
  const profileFor = temporalProfile({
    e2: { temporalRoleProbabilities: { deadline_previous: 0.7, deadline_current: 0.08, historical: 0.05, other: 0.08, none: 0.09 } },
    e3: { temporalRoleProbabilities: { deadline_previous: 0.68, deadline_current: 0.08, historical: 0.05, other: 0.09, none: 0.1 } }
  });
  const action = { owner: 'Alice Jones', action: 'Send the validation report', deadline: 'Not stated', evidenceIds: ['e1'] };
  const [ambiguous] = resolveActionRecords([action], {
    participants: ['Alice Jones', 'Bob Smith'],
    events: baseEvents
  }, { deadlineFrom, profileFor });
  assert.equal(ambiguous.deadline, 'Not stated');

  const [corrected] = resolveActionRecords([action], {
    participants: ['Alice Jones', 'Bob Smith'],
    events: [baseEvents[0], baseEvents[1], event('e3', 'Bob Smith', 'Actually, that needs to be done by Friday.', 3)]
  }, { deadlineFrom, profileFor });
  assert.equal(corrected.deadline, 'Friday');
});

test('separates deadlines inside a shared commitment thread using owner and action evidence', () => {
  const evidence = {
    participants: ['Alice Jones', 'Dan Wu'],
    events: [
      event('e1', 'Alice Jones', 'I will send the validation report by Tuesday.', 1),
      event('e2', 'Dan Wu', 'I will circulate the meeting agenda by Friday.', 2)
    ]
  };
  const resolved = resolveActionRecords([
    { owner: 'Alice Jones', action: 'Send the validation report', deadline: 'Not stated', evidenceIds: ['e1', 'e2'] },
    { owner: 'Dan Wu', action: 'Circulate the meeting agenda', deadline: 'Not stated', evidenceIds: ['e1', 'e2'] }
  ], evidence, {
    deadlineFrom,
    profileFor: temporalProfile({
      e1: { temporalRoleProbabilities: { deadline_current: 0.72, deadline_previous: 0.05, historical: 0.04, other: 0.1, none: 0.09 } },
      e2: { temporalRoleProbabilities: { deadline_current: 0.74, deadline_previous: 0.04, historical: 0.03, other: 0.09, none: 0.1 } }
    })
  });

  assert.equal(resolved[0].deadline, 'Tuesday');
  assert.equal(resolved[1].deadline, 'Friday');
});

test('does not leak a neighbouring commitment deadline through merged supporting evidence', () => {
  const evidence = {
    participants: ['Amina Shah'],
    events: [
      event('e1', 'Amina Shah', 'I will send the validation pack.', 1),
      event('e2', 'Amina Shah', 'I will update the project plan by Friday.', 1)
    ]
  };
  const resolved = resolveActionRecords([
    {
      owner: 'Amina Shah',
      action: 'Send the validation pack',
      deadline: 'Not stated',
      evidenceIds: ['e1', 'e2'],
      representativeEvidenceIds: ['e1']
    },
    {
      owner: 'Amina Shah',
      action: 'Update the project plan',
      deadline: 'Friday',
      evidenceIds: ['e1', 'e2'],
      representativeEvidenceIds: ['e2']
    }
  ], evidence, {
    deadlineFrom,
    profileFor: temporalProfile({
      e2: { temporalRoleProbabilities: { deadline_current: 0.78, deadline_previous: 0.05, historical: 0.03, other: 0.06, none: 0.08 } }
    })
  });

  assert.equal(resolved[0].deadline, 'Not stated');
  assert.equal(resolved[1].deadline, 'Friday');
});

test('recognises common milestone deadlines without treating historical prose as dates', () => {
  assert.equal(deadlineFrom('I will finish it by the end of this week.'), 'the end of this week');
  assert.equal(deadlineFrom('Send it once David confirms.'), 'once David confirms');
  assert.equal(deadlineFrom('Monitor the dashboard for the first hour after the Thursday 10:00 launch.'), 'the first hour after the Thursday 10:00 launch');
  assert.equal(deadlineFrom('Update the run sheet tomorrow morning once Marta confirms.'), 'tomorrow morning');
  assert.equal(deadlineFrom('We discussed it before the workshop last year.'), 'Not stated');
});
