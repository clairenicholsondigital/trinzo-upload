'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluationItems, scoreReviewerBurden } = require('../scripts/meeting_minutes_reviewer_burden');

const result = {
  id: 'fixture-one',
  discussion: [{ topic: 'Release', points: [{
    id: 'P1', text: 'The release remains blocked by approval.', evidenceIds: ['T1'],
    supportingDetails: [{ id: 'S1', text: 'Approval is reviewed weekly.', evidenceIds: ['T2'] }]
  }], decisions: [], openQuestions: [] }]
};

test('reviewer-burden fixtures distinguish visible propositions from collapsed context', () => {
  const items = evaluationItems(result);
  assert.deepEqual(items.map((item) => item.visibility), ['visible', 'supporting']);
  const report = scoreReviewerBurden([result], { adjudications: [
    { id: 'fixture-one:point:P1', category: 'avoidable_visible_excess' },
    { id: 'fixture-one:supporting:S1', category: 'valid_supporting_context' }
  ] });
  assert.equal(report.avoidableVisibleCount, 1);
  assert.equal(report.supportingCount, 1);
  assert.equal(report.recoverableSupportingCount, 1);
  assert.equal(report.unclassifiedVisible.length, 0);
});

test('unadjudicated rows stay explicit rather than being counted as success', () => {
  const report = scoreReviewerBurden([result], { adjudications: [] });
  assert.equal(report.classifiedVisibleCount, 0);
  assert.equal(report.unclassifiedVisible.length, 1);
});
