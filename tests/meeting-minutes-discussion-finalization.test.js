'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { promoteAllDiscussionDetails, finalisePromotedDiscussion, discussionStructureDiagnostics } = require('../utils/meetingMinutesDiscussionFinalization');

test('the reversible experiment promotes every surviving additional detail into discussion', () => {
  const discussion = [{
    id: 'topic-1', topic: 'Audit planning', decisions: [], openQuestions: [],
    points: [{
      id: 'main', text: 'The audit scope was reviewed.', evidenceIds: ['T0200'],
      supportingDetails: [
        { id: 'detail-1', text: 'The planning meeting is scheduled for Wednesday.', evidenceIds: ['T0201'] },
        { id: 'detail-2', text: 'The standards list will follow the confirmed scope.', evidenceIds: ['T0202'] }
      ]
    }]
  }];
  const result = promoteAllDiscussionDetails(discussion);
  assert.equal(result.promoted, 2);
  assert.deepEqual(result.discussion[0].points.map((row) => row.id), ['main', 'detail-1', 'detail-2']);
  assert.deepEqual(result.discussion[0].points[0].supportingDetails, []);
  assert.deepEqual(result.discussion[0].points.slice(1).map((row) => row.simulationParentId), ['main', 'main']);
  assert.equal(discussion[0].points[0].supportingDetails.length, 2, 'the input remains untouched');
});

test('the include-all experiment rejects raw speech and globally redundant generated details', () => {
  const discussion = [{
    id: 'topic-1', topic: 'Production selection', decisions: [], openQuestions: [],
    points: [{
      id: 'main', text: 'Cinderella was selected for this year’s production.', evidenceIds: ['T1'],
      supportingDetails: [
        { id: 'raw', text: "Right, so it's decided, we're doing Cinderella this year.", evidenceIds: ['T1'] },
        { id: 'duplicate', text: 'Cinderella was selected for the production this year.', evidenceIds: ['T1'] },
        { id: 'distinct', text: 'The performing rights application can now proceed.', evidenceIds: ['T2'] }
      ]
    }]
  }];
  const result = promoteAllDiscussionDetails(discussion);
  assert.equal(result.promoted, 1);
  assert.deepEqual(result.discussion[0].points.map((row) => row.id), ['main', 'distinct']);
});

test('the post-promotion editorial pass removes finished-body restatements and action recaps', async () => {
  const discussion = [
    {
      id: 'topic-budget', topic: 'Photography budget', decisions: [], openQuestions: [],
      points: [
        { id: 'budget-1', text: 'The photography budget is approximately £8,000.', evidenceIds: ['T0300'], supportingDetails: [] },
        { id: 'budget-2', text: 'The budget for photography is approximately £8k.', evidenceIds: ['T0300'], supportingDetails: [] }
      ]
    },
    {
      id: 'topic-recap', topic: 'Action summary and next steps', decisions: [], openQuestions: [],
      points: [{ id: 'recap-1', text: 'Gemma summarised the actions and next steps.', evidenceIds: ['T0301'], supportingDetails: [] }]
    }
  ];
  const result = await finalisePromotedDiscussion(discussion, { organise: false, people: ['Gemma Rourke'] });
  assert.equal(result.discussion.length, 1);
  assert.equal(result.discussion[0].points.length, 1);
  assert.match(result.discussion[0].points[0].text, /photography budget/i);
  assert.ok(result.dropped.some((item) => item.because === 'same wording'));
});

test('the post-promotion body cleanup preserves provenance-bearing rows and recaps', async () => {
  const discussion = [{
    id: 'topic-budget', topic: 'Photography budget', decisions: [], openQuestions: [],
    points: [
      { id: 'budget-1', text: 'The photography budget is approximately £8,000.', evidenceIds: ['T0300'], supportingDetails: [] },
      { id: 'budget-2', text: 'The budget for photography is approximately £8k.', evidenceIds: ['T0300'], supportingDetails: [], simulationSource: 'supporting_detail' },
      { id: 'recap-1', text: 'Gemma summarised the actions and next steps.', evidenceIds: ['T0301'], supportingDetails: [], simulationSource: 'supporting_detail' }
    ]
  }];
  const before = structuredClone(discussion);
  const result = await finalisePromotedDiscussion(discussion, { organise: false, people: ['Gemma Rourke'] });
  const rows = result.discussion.flatMap(topic => topic.points);
  for (const source of before[0].points.slice(1)) {
    const kept = rows.find(row => row.id === source.id);
    assert.ok(kept);
    assert.equal(kept.text, source.text);
    assert.equal(kept.simulationSource, source.simulationSource);
    assert.deepEqual(kept.evidenceIds, source.evidenceIds);
  }
  assert.deepEqual(discussion, before);
  assert.equal(result.dropped.length, 0);
});

test('discussion structure diagnostics report oversized and closely related singleton sections without changing them', () => {
  const rows = Array.from({ length: 11 }, (_, index) => ({
    id: `row-${index}`, text: `Material project fact number ${index + 1}.`, evidenceIds: [`T${index + 1}`]
  }));
  const discussion = [
    { topic: 'Contract renewal timing', points: rows, decisions: [], openQuestions: [] },
    { topic: 'Contract renewal', points: [{ id: 'single', text: 'The renewal remains under review.', evidenceIds: ['T0200'] }], decisions: [], openQuestions: [] }
  ];
  const result = discussionStructureDiagnostics(discussion);
  assert.equal(result.oversizedSections.length, 1);
  assert.equal(result.oversizedSections[0].topic, 'Contract renewal timing');
  assert.equal(result.suspiciousSingletons.length, 1);
  assert.equal(discussion[0].points.length, 11, 'diagnostics are read-only');
});

test('discussion structure diagnostics use singleton body content and flag sections from eight rows', () => {
  const discussion = [
    {
      topic: 'Delivery readiness', decisions: [], openQuestions: [],
      points: Array.from({ length: 8 }, (_, index) => ({
        id: `delivery-${index}`, text: `Supplier audit evidence item ${index + 1} remains under review.`, evidenceIds: [`D${index}`]
      }))
    },
    {
      topic: 'Outstanding item', decisions: [], openQuestions: [],
      points: [{ id: 'single-audit', text: 'The supplier audit evidence remains under review.', evidenceIds: ['D09'] }]
    }
  ];
  const result = discussionStructureDiagnostics(discussion);
  assert.equal(result.oversizedSections.length, 1);
  assert.equal(result.oversizedSections[0].pointCount, 8);
  assert.equal(result.suspiciousSingletons.length, 1);
  assert.equal(result.suspiciousSingletons[0].possibleNeighbour, 'Delivery readiness');
});

test('the post-promotion organiser cannot put accepted details back into suggestions', async () => {
  const discussion = [{
    id: 'topic-1', topic: 'Delivery planning', decisions: [], openQuestions: [],
    points: [{
      id: 'main', text: 'The delivery plan remains in preparation.', evidenceIds: ['T0400'],
      supportingDetails: [{
        id: 'detail', text: 'The delivery date remains dependent on supplier confirmation.', evidenceIds: ['T0401']
      }]
    }]
  }];
  const result = await finalisePromotedDiscussion(discussion, {
    organise: true,
    includeAllDetails: true,
    sourceUnits: [
      { id: 'T0400', text: 'The delivery plan remains in preparation.' },
      { id: 'T0401', text: 'We have not got the supplier confirmation yet, so the date is still dependent on that.' }
    ]
  });
  const records = result.discussion.flatMap((topic) => [
    ...(topic.points || []), ...(topic.decisions || []), ...(topic.openQuestions || [])
  ]);
  assert.equal(records.flatMap((record) => record.supportingDetails || []).length, 0);
  assert.ok(records.some((record) => /supplier confirmation/i.test(record.text)));
});
