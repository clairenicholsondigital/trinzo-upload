'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { enrichUnderspecifiedActionObject } = require('../utils/canonicalMinutes/actionObjectResolution');

function evidence(lines) {
  return {
    events: lines.map((line, index) => ({
      id: `e${index + 1}`,
      turnIndex: index,
      speaker: line.speaker || 'Conor Flynn',
      text: line.text
    }))
  };
}

test('an underspecified slice is enriched from one explicit transcript-backed process purpose', () => {
  const source = evidence([
    { text: 'We have been working on what a good process would look like.' },
    { text: 'This is a subsection of the overall sales operating system.' },
    { text: 'This is just to generate leads of a sufficient quality to be reviewed by sales.' },
    { text: 'What we want to do is take a really small slice and manually do it.' }
  ]);
  const result = enrichUnderspecifiedActionObject({
    action: 'Manually test a small slice',
    owner: 'Not stated',
    deadline: 'Not stated',
    evidenceIds: ['e4'],
    representativeEvidenceIds: ['e4']
  }, source);
  assert.equal(result.action, 'Manually test a small slice of the proposed process for generating leads of sufficient quality');
  assert.deepEqual(result.wordingEvidenceIds, ['e1', 'e3']);
  assert.equal(result.owner, 'Not stated');
  assert.equal(result.deadline, 'Not stated');
});

test('a proposed qualifier is used only when proposal language is present near the action', () => {
  const source = evidence([
    { text: 'We have designed a workflow.' },
    { text: 'This is intended to validate supplier records.' },
    { text: 'We have come up with an idea that we want to check.' },
    { text: 'We will test a small sample.' }
  ]);
  const result = enrichUnderspecifiedActionObject({ action: 'Test a small sample', evidenceIds: ['e4'] }, source);
  assert.equal(result.action, 'Test a small sample of the proposed workflow for validating supplier records');
});

test('competing transcript purposes fail closed instead of guessing the object', () => {
  const source = evidence([
    { text: 'We have a process. This is intended to validate supplier records.' },
    { text: 'We also have a workflow. This is intended to review complaint records.' },
    { text: 'We will test a small sample.' }
  ]);
  const item = { action: 'Test a small sample', evidenceIds: ['e3'], owner: 'Not stated' };
  assert.deepEqual(enrichUnderspecifiedActionObject(item, source), item);
});

test('already specific action objects remain unchanged', () => {
  const source = evidence([
    { text: 'We have a process.' },
    { text: 'This is intended to validate supplier records.' },
    { text: 'We will test a small sample of the supplier records.' }
  ]);
  const item = { action: 'Test a small sample of the supplier records', evidenceIds: ['e3'] };
  assert.deepEqual(enrichUnderspecifiedActionObject(item, source), item);
});
