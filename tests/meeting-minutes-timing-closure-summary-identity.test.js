'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { summaryTemporalCheckItems, applySummaryTemporalCheckResults } = require('../utils/meetingMinutesTemporalReview');

const current = { discussion: [{ points: [
  { text: 'Morgan will review the inspection report Friday.', evidenceIds: ['T0001'] },
  { text: 'Morgan will send the supplier invoice Tuesday.', evidenceIds: ['T0002'] },
  { text: 'Riley will review the inspection report Friday.', evidenceIds: ['T0003'] },
  { text: 'Morgan will send the inspection report Tuesday.', evidenceIds: ['T0004'] }
] }], actions: [] };
const original = 'Morgan will review the inspection report Monday.';
function apply(corrected, field = 'executiveSummary') {
  const values = { executiveSummary: field === 'executiveSummary' ? original : '',
    meetingObjectives: field === 'meetingObjectives' ? [{ id: 'o1', text: original }] : [] };
  const items = summaryTemporalCheckItems(values, current);
  return { values, result: applySummaryTemporalCheckResults(values, items, [{ id: items[0].id,
    verdict: 'corrected', problemQuote: original, evidenceQuote: corrected, correctedText: corrected }]) };
}

test('a source-proved timing correction retains the original task in summary and objectives', () => {
  for (const field of ['executiveSummary', 'meetingObjectives']) {
    const corrected = 'Morgan will review the inspection report Friday.';
    const { result } = apply(corrected, field);
    assert.equal(result.accounting.complete, true);
    assert.equal(field === 'executiveSummary' ? result.values.executiveSummary : result.values.meetingObjectives[0].text, corrected);
  }
});

test('valid quotes for a different approved task cannot replace the original summary or objective', () => {
  for (const field of ['executiveSummary', 'meetingObjectives']) {
    for (const corrected of ['Morgan will send the supplier invoice Tuesday.',
      'Morgan will send the inspection report Tuesday.', 'Riley will review the inspection report Friday.']) {
      const { result, values } = apply(corrected, field);
      assert.deepEqual(result.values, values);
      assert.equal(result.accounting.complete, false);
      assert.ok(result.flags.some(flag => flag.temporalField === field));
    }
  }
});
