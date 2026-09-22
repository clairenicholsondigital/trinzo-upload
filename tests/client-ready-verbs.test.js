'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isClientReadyActionWording } = require('../routes/api').stagedEvaluation;

test('everyday imperatives for specific work are client-ready action wording', () => {
  for (const wording of [
    "Put the Thursday review in Dana's calendar.",
    'Restore the fade effect on the pricing slide.',
    'Re-share the deck once the edits are in.',
    'Message the supplier about the late delivery.',
    'Print thirty extra handouts for the session.'
  ]) assert.ok(isClientReadyActionWording(wording), wording);
  assert.ok(!isClientReadyActionWording("I'll put it in the calendar."));
});
