'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveActionRecords } = require('../utils/canonicalMinutes/actionResolution');
const { deadlineFrom } = require('../utils/canonicalMinutes/stages');

function event(id, speaker, text, turnIndex) {
  return { id, speaker, text, turnIndex };
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

test('recognises common milestone deadlines without treating historical prose as dates', () => {
  assert.equal(deadlineFrom('I will finish it by the end of this week.'), 'the end of this week');
  assert.equal(deadlineFrom('Send it once David confirms.'), 'once David confirms');
  assert.equal(deadlineFrom('Monitor the dashboard for the first hour after the Thursday 10:00 launch.'), 'the first hour after the Thursday 10:00 launch');
  assert.equal(deadlineFrom('Update the run sheet tomorrow morning once Marta confirms.'), 'tomorrow morning');
  assert.equal(deadlineFrom('We discussed it before the workshop last year.'), 'Not stated');
});
