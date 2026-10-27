'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const cases = require('./fixtures/milestone_creation_intent.json');
const { hasMilestoneCreationIntent } = require('../utils/milestoneCreationIntent');
const { bindingsFor, resolveProjectMilestones } = require('../utils/projectMilestoneBinding');

for (const item of cases) test('source admission: ' + item.source + ' [' + item.name + ']', () => {
  assert.equal(hasMilestoneCreationIntent(item.name, item.source), item.expected);
});
const candidate = name => bindingsFor({ segments: [{ milestone: name, evidence: ['Source'], delivery_status: 'unknown' }] });
const options = transcriptText => ({ enforceCreationIntent: true, transcriptText });

test('inactive spelling/separator variants never silently reactivate or recreate', () => {
  const [binding] = resolveProjectMilestones(candidate('Validation_complete'), [
    { id: 5, milestone_name: 'Validation complete', is_active: false }
  ], options('Add a new milestone called "Validation complete".'));
  assert.equal(binding.assess, false);
  assert.equal(binding.admissionReason, 'inactive_milestone');
});
test('an active name remains assessable without new-creation wording', () => {
  const [binding] = resolveProjectMilestones(candidate('Validation complete'), [
    { id: 5, milestone_name: 'Validation complete', is_active: true }
  ], options('The work is progressing.'));
  assert.equal(binding.coreId, 5);
  assert.equal(binding.assess, true);
});
test('inactive and foreign IDs still fail rather than binding to another name', () => {
  const rows = bindingsFor({ segments: [{ milestoneId: 7, milestone: 'Validation complete', evidence: ['Source'] }] });
  assert.throws(() => resolveProjectMilestones(rows, [{ id: 7, milestone_name: 'Validation complete', is_active: false }], options('Source')), /active milestone/);
  assert.throws(() => resolveProjectMilestones(rows, [], options('Source')), /active milestone/);
});
test('model flags and invented summaries cannot bypass actual transcript intent', () => {
  const rows = bindingsFor({ segments: [{ milestone: 'Validation complete', creation_intent: true,
    evidence: ['Add a milestone called "Validation complete".'] }] });
  const [binding] = resolveProjectMilestones(rows, [], options('The files need tidying.'));
  assert.equal(binding.assess, false);
  assert.equal(binding.admissionReason, 'no_source_creation_intent');
});
test('similar but distinct names do not reactivate each other', () => {
  const [binding] = resolveProjectMilestones(candidate('Validation phase 2'), [
    { id: 5, milestone_name: 'Validation phase 1', is_active: false }
  ], options('Add a new milestone called "Validation phase 2".'));
  assert.equal(binding.assess, true);
  assert.equal(binding.coreId, null);
});
