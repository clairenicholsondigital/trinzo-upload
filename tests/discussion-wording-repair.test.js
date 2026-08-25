'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { repairDiscussionWording, wordingFaults } = require('../utils/canonicalMinutes/trooperPolish');

// The same publication promise actions have, applied to discussion prose. Until this
// module a broken discussion point had no second chance anywhere: the rewrite that
// produced it was also the last pass that touched it, so "review the risk whilst looking
// at the risk" went from the model straight to the reviewer's screen.

const pack = [{
  evidence: [{ id: 'evt_9', speaker: 'Jacqui', text: 'We need to make a note and review the risk analysis document before the audit.' }]
}];

const payloadWith = (point) => ({
  stagedStage: 'discussion',
  screens: { discussion: [{ topic: 'Risk analysis', points: [point], evidenceIds: ['evt_9'], pointRefs: [{ evidenceIds: ['evt_9'] }] }] }
});

function stubReturning(text) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({ repairs: [{ index: 0, action: text }] }) } }] })
  });
}

test('a circular point is repaired into prose, and prose is not required to be imperative', async () => {
  const result = await repairDiscussionWording(payloadWith('Make a note of the discussion and review the risk whilst looking at the risk'), pack, {
    apiKey: 'test', url: 'https://example.invalid',
    fetchImpl: stubReturning('A note of the discussion was recorded and the risk analysis document reviewed.')
  });
  assert.equal(result.attempted, 1);
  assert.equal(result.repaired, 1);
  const point = result.payload.screens.discussion[0].points[0];
  assert.equal(point, 'A note of the discussion was recorded and the risk analysis document reviewed.');
  assert.deepEqual(wordingFaults(point), []);
});

test('a rewrite still in the speaker\'s voice is refused and the point survives unchanged', async () => {
  const original = 'Make a note of the discussion and review the risk whilst looking at the risk';
  const result = await repairDiscussionWording(payloadWith(original), pack, {
    apiKey: 'test', url: 'https://example.invalid',
    fetchImpl: stubReturning('We reviewed the risk and made a note.')
  });
  assert.equal(result.repaired, 0);
  const card = result.payload.screens.discussion[0];
  assert.equal(card.points.length, 1, 'a point is never dropped for its wording');
  assert.equal(card.points[0], original);
});

test('mechanical faults are fixed without spending a model call', async () => {
  const fetchImpl = async () => { throw new Error('the model must not be called for a deletion repair'); };
  const result = await repairDiscussionWording(payloadWith('The part came from the, from the supplier on Mill Road'), pack, {
    apiKey: 'test', url: 'https://example.invalid', fetchImpl
  });
  assert.equal(result.attempted, 0);
  assert.equal(result.payload.screens.discussion[0].points[0], 'The part came from the supplier on Mill Road');
});

test('a clean screen costs nothing', async () => {
  const fetchImpl = async () => { throw new Error('no call expected'); };
  const result = await repairDiscussionWording(payloadWith('The audit plan was agreed and the tracker will be shared before arrival.'), pack, {
    apiKey: 'test', url: 'https://example.invalid', fetchImpl
  });
  assert.equal(result.attempted, 0);
  assert.equal(result.repaired, 0);
});
