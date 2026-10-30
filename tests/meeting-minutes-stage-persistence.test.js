'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { meetingAgentStagePersistenceChanges } = require('../utils/meetingMinutesStagePersistence');
const { baseDraft, results } = require('./fixtures/meeting-minutes-stage-persistence');
const { supportingDetailDraft, pool, assertPool } = require('./fixtures/meeting-minutes-supporting-detail-persistence');
const copy = value => JSON.parse(JSON.stringify(value));

function applyStage(state, source, stage) {
  const scoped = meetingAgentStagePersistenceChanges(source, state, stage, results[stage].changes);
  assert.deepEqual(scoped.conflictFields, []);
  return { ...state, ...scoped.changes, revision: state.revision + 1 };
}

for (const order of [
  ['summary', 'discussion', 'actions'],
  ['discussion', 'summary', 'actions'],
  ['actions', 'discussion', 'summary']
]) {
  test(`stage-owned results survive ${order.join(' -> ')} completion`, () => {
    const source = baseDraft();
    let state = structuredClone(source);
    for (const stage of order) state = applyStage(state, source, stage);
    assert.equal(state.discussion[0].topic, 'Generated discussion');
    assert.equal(state.actions[0].action, 'Generated action');
    assert.equal(state.executiveSummary, 'Generated summary');
    assert.equal(state.meetingObjectives[0].text, 'Summary objective');
    assert.deepEqual(new Set(Object.keys(state.qualityState)), new Set(['discussion', 'actions', 'summary']));
  });
}

test('unrelated newer reviewer edits survive a generated stage save', () => {
  const source = baseDraft();
  const fresh = { ...structuredClone(source), revision: 2, details: { meetingTitle: 'Reviewer title' } };
  const scoped = meetingAgentStagePersistenceChanges(source, fresh, 'actions', results.actions.changes);
  const saved = { ...fresh, ...scoped.changes };
  assert.deepEqual(scoped.conflictFields, []);
  assert.equal(saved.details.meetingTitle, 'Reviewer title');
  assert.equal(saved.actions[0].action, 'Generated action');
});

test('actions may remove a strict discussion duplicate only while discussion is unchanged', () => {
  const source = baseDraft();
  const generatedDiscussion = [{ topic: 'Generated discussion', points: [{ id: 'P1', text: 'Context remains.' }] }];
  const resultChanges = { ...results.actions.changes, discussion: generatedDiscussion };
  const unchanged = meetingAgentStagePersistenceChanges(source, structuredClone(source), 'actions', resultChanges);
  assert.deepEqual(unchanged.changes.discussion, generatedDiscussion);

  const reviewerDiscussion = [{ topic: 'Reviewer discussion', points: [{ id: 'P2', text: 'Keep this edit.' }] }];
  const fresh = { ...structuredClone(source), discussion: reviewerDiscussion };
  const edited = meetingAgentStagePersistenceChanges(source, fresh, 'actions', resultChanges);
  assert.deepEqual(edited.conflictFields, []);
  assert.equal(Object.prototype.hasOwnProperty.call(edited.changes, 'discussion'), false);
});


test('discussion persistence treats absent and empty pools alike but detects genuine reviewer changes', () => {
  const source = copy(supportingDetailDraft());
  delete source.unassignedSupportingDetails;
  const fresh = { ...copy(source), unassignedSupportingDetails: [] };
  const generated = { discussion: copy(source.discussion), unassignedSupportingDetails: [pool()[1]] };
  const compatible = meetingAgentStagePersistenceChanges(source, fresh, 'discussion', generated);
  assert.deepEqual(compatible.conflictFields, []);
  assertPool(compatible.changes.unassignedSupportingDetails, [pool()[1]]);
  const edited = { ...copy(fresh), unassignedSupportingDetails: [pool()[0]] };
  const conflict = meetingAgentStagePersistenceChanges(source, edited, 'discussion', generated);
  assert.deepEqual(conflict.conflictFields, ['unassignedSupportingDetails']);
  assert.deepEqual(conflict.changes, {});
  assertPool(edited.unassignedSupportingDetails, [pool()[0]]);
});
