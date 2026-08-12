'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildStagedEvidenceLedger, deadlineFromText } = require('../utils/stagedEvidenceLedger');

test('keeps a genuine no-action meeting empty while surfacing decisions and risks', () => {
  const ledger = buildStagedEvidenceLedger([
    'Amina Khan  00:01',
    'We go with option B. The supplier delay remains a risk, but no action, we just monitor it as normal.',
    'Ben Stone  00:08',
    'Agreed.'
  ].join('\n'));
  assert.deepEqual(ledger.actions, []);
  assert.ok(ledger.decisions.length >= 1);
  assert.ok(ledger.risks.length >= 1);
});

test('extracts supported owner and bounded deadlines without partial fragments', () => {
  const ledger = buildStagedEvidenceLedger([
    'Idris Moore  00:01',
    'I will send the draft by end of day tomorrow.',
    'Kate Evans  00:07',
    "I'll review it within two working days of receiving it."
  ].join('\n'));
  assert.equal(ledger.actions.length, 2);
  assert.equal(ledger.actions[0].owner, 'Idris Moore');
  assert.equal(ledger.actions[0].deadline, 'end of day tomorrow');
  assert.equal(ledger.actions[1].deadline, 'within two working days of receiving it');
  assert.equal(deadlineFromText('finish by the end of the'), 'Not stated');
  assert.equal(deadlineFromText('finish by end of next'), 'Not stated');
});

test('does not treat transcript response words as participant owners', () => {
  const ledger = buildStagedEvidenceLedger([
    'Amina Khan  00:01',
    'We go with the approved launch plan.',
    'Yes  00:03',
    "I'll monitor it."
  ].join('\n'));
  assert.equal(ledger.participants.includes('Yes'), false);
  assert.equal(ledger.actions.some((action) => action.owner === 'Yes'), false);
});
