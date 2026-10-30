'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createInitialMinutesProcessor } = require('../utils/meetingMinutesProcessing');
const { PROVIDER } = require('../utils/meetingMinutesParallel');

function fixture(overrides = {}) {
  const events = [], queued = [];
  const processor = createInitialMinutesProcessor({
    bootId: 'fixture-boot', hybridEnabled: () => true,
    schedule: callback => queued.push(callback),
    saveDraft: async (draft, req, changes) => { events.push(['saved', req.authUser.userId]); return { ...draft, ...changes, revision: draft.revision + 1 }; },
    runOriginalStage: async (...args) => events.push(['original', ...args]),
    parallelRunner: { start: async (...args) => { events.push(['beta', ...args]); return args[0]; } },
    ...overrides
  });
  return { processor, events, queued };
}
const req = { authUser: { userId: 'owner' } };

test('Original persists its running draft before scheduling discussion processing', async () => {
  const { processor, events, queued } = fixture();
  const draft = { draftId: '17', revision: 3, currentStep: 4, selectedStep: 4 };
  const saved = await processor.start(draft, req);
  assert.deepEqual(events, [['saved', 'owner']]);
  assert.equal(saved.revision, 4); assert.equal(saved.currentStep, 0); assert.equal(saved.selectedStep, 0);
  assert.equal(saved.generation.stage, 'discussion'); assert.equal(saved.generation.status, 'running');
  assert.equal(saved.generation.bootId, 'fixture-boot'); assert.equal(saved.generation.pass, 'starting');
  assert.equal(queued.length, 1); queued[0](); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events[1], ['original', '17', 'owner', 'discussion']);
  assert.equal(draft.currentStep, 4, 'the supplied snapshot remains unchanged');
});

test('Beta delegates the same saved provider snapshot without entering Original processing', async () => {
  const { processor, events, queued } = fixture();
  const draft = { draftId: '18', revision: 1, generationProvider: PROVIDER };
  assert.equal(await processor.start(draft, req), draft);
  assert.deepEqual(events, [['beta', draft, 'owner']]); assert.deepEqual(queued, []);
});

test('a failed save cannot launch untracked Original work', async () => {
  const { processor, events, queued } = fixture({ saveDraft: async () => { throw Error('Save failed'); } });
  await assert.rejects(processor.start({ draftId: '17' }, req), /Save failed/);
  assert.deepEqual(events, []); assert.deepEqual(queued, []);
});

test('non-hybrid Original keeps its empty pass metadata and reports background failures separately', async () => {
  const errors = [];
  const { processor, queued } = fixture({ hybridEnabled: () => false,
    runOriginalStage: async () => { throw Error('Generation failed'); },
    logError: (...args) => errors.push(args)
  });
  const saved = await processor.start({ draftId: '17', revision: 1 }, req);
  assert.equal(saved.generation.pass, ''); assert.equal(saved.generation.message, '');
  queued[0](); await new Promise(resolve => setImmediate(resolve));
  assert.equal(errors[0][0], '[meeting-minutes-agent/initial-background] failed');
  assert.equal(errors[0][1].message, 'Generation failed'); assert.equal(saved.revision, 2);
});
