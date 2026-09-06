'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { splitActionTiers } = require('../utils/stagedMiniLmTrooper');

// The pipeline decides the tier; this only checks that the split is faithful and that a
// run without sampling (no tier field) still publishes every row as an action.

test('tier 2 rows go to the raised panel, everything else stays an action', () => {
  const split = splitActionTiers([
    { action: 'Share the risk analysis', tier: 1, support: 3 },
    { action: 'Work out transport', tier: 2, support: 1 },
    { action: 'Send the code of conduct' }
  ]);
  assert.deepEqual(split.actions.map((row) => row.action), ['Share the risk analysis', 'Send the code of conduct']);
  assert.deepEqual(split.raisedActions.map((row) => row.action), ['Work out transport']);
});

test('a missing or malformed list yields empty screens rather than a crash', () => {
  assert.deepEqual(splitActionTiers(undefined), { actions: [], raisedActions: [] });
});
