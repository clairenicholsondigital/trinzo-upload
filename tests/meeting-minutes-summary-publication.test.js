'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { groundedObjectiveRecords, mergeGroundedObjectiveRecords, groundedObjectives, groundedExecutiveSummary } = require('../utils/meetingMinutesSummaryPublication');
const { normaliseSourceUnits } = require('../utils/meetingMinutesSource');
const { evidenceSupportScore } = require('../utils/meetingMinutesEvidenceContext');

const sourceUnits = normaliseSourceUnits([
  { id: 'T0001', speaker: 'Alex', timestamp: '00:01:02', text: 'We need to test all three alarms before approval.', classification: 'keep', confidence: 0.98 },
  { id: 'T0002', speaker: 'Priya', timestamp: '00:01:12', text: 'I will send the report to Alex by Friday.', classification: 'keep', confidence: 0.97 },
  { id: 'T0003', speaker: 'Alex', timestamp: '00:01:30', text: 'Maybe it is standard 60601 something; I am not sure.', classification: 'keep', confidence: 0.72 },
  { id: 'T0004', speaker: 'System', timestamp: '00:01:45', text: 'Recording stopped.', classification: 'remove', confidence: 0.99 }
]);

test('objective records retain valid source evidence', () => {
  const records = groundedObjectiveRecords([{ text: 'Review the three alarm tests before approval.', evidenceIds: ['T0001'] }], sourceUnits);
  assert.equal(records.length, 1);
  assert.equal(records[0].evidenceIds[0], 'T0001');
});

test('objective records accumulate distinct evidenced aims from later passes', () => {
  const units = normaliseSourceUnits([
    { id: 'T2000', speaker: 'Chair', text: 'Today we need to plan the audit visit.', classification: 'keep' },
    { id: 'T2050', speaker: 'Chair', text: 'The other purpose is to agree how the documents will be shared securely.', classification: 'keep' }
  ]);
  const records = mergeGroundedObjectiveRecords([
    [{ text: 'Plan the audit visit.', evidenceIds: ['T2000'] }],
    [
      { text: 'Plan the audit visit and arrangements.', evidenceIds: ['T2000'] },
      { text: 'Agree how audit documents will be shared securely.', evidenceIds: ['T2050'] }
    ]
  ], units);
  assert.equal(records.length, 2);
  assert.ok(records.some((record) => record.evidenceIds.includes('T2050')));
});

test('summary and objectives are grounded in validated content rather than filled to a quota', () => {
  assert.ok(evidenceSupportScore('Three alarms require testing.', 'We need to test all three alarms before approval.') > 0.2);
  const objectiveUnits = normaliseSourceUnits([
    { id: 'T1100', speaker: 'Alex', text: "Today's objective is to test all three alarms before approval.", classification: 'keep' }
  ]);
  assert.deepEqual(groundedObjectives(['Test all three alarms', 'Plan an unrelated office move'], objectiveUnits), ['Test all three alarms']);
  const summary = groundedExecutiveSummary(
    'Three alarms require testing before approval. The company will open a new office in Paris.',
    [{ topic: 'Testing', points: [{ text: 'Three alarms require testing before approval.' }] }],
    []
  );
  assert.match(summary, /Three alarms/);
  assert.doesNotMatch(summary, /Paris/);
});
