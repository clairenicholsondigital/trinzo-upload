'use strict';

// Generic cases only: none of these sentences come from the evaluation corpus.
const test = require('node:test');
const assert = require('node:assert/strict');
const { dedupeHybridActionRecords, distinctActionDeliverables } = require('../routes/api').stagedEvaluation;

const action = (id, text, evidenceIds, extra = {}) => ({
  id, action: text, owners: ['Sam Carter'], timing: { kind: 'not_stated' }, evidenceIds, reviewFlagIds: [], ...extra
});

test('two actions sharing one cited line but no subject stay separate', () => {
  const rows = dedupeHybridActionRecords([
    action('a', 'Finish the supplier checklist and give it to Robin.', ['T0010', 'T0040', 'T0091'],
      { timing: { kind: 'deadline', wording: 'by the tenth', exactDate: '2026-07-10' } }),
    action('b', 'Think about the format of the site visit and send Priya a written plan.', ['T0088', 'T0091'])
  ]);
  assert.equal(rows.length, 2);
  assert.ok(rows.some((row) => /supplier checklist/.test(row.action) && row.timing.kind === 'deadline'));
});

test('a step is not merged into the action that waits for it', () => {
  assert.ok(distinctActionDeliverables(
    { action: 'Fix the chart colours on the budget slide.' },
    { action: 'Re-send the deck once the chart colour fixes are done.' }
  ));
  const rows = dedupeHybridActionRecords([
    action('a', 'Fix the chart colours on the budget slide.', ['T0020', 'T0050', 'T0051']),
    action('b', 'Re-send the deck once the chart colour fixes are done.', ['T0050', 'T0051', 'T0030'])
  ]);
  assert.equal(rows.length, 2);
});

test('true rewordings of one deliverable still merge', () => {
  assert.ok(!distinctActionDeliverables(
    { action: 'Send the signed contract to the landlord.' },
    { action: 'Send the landlord the signed contract by Friday.' }
  ));
  const rows = dedupeHybridActionRecords([
    action('a', 'Send the signed contract to the landlord.', ['T0012', 'T0013']),
    action('b', 'Send the landlord the signed contract by Friday.', ['T0013'])
  ]);
  assert.equal(rows.length, 1);
});

test('a named request answered by that person committing is accepted work', () => {
  const { addressedRequestAcceptedAhead, actionCandidateInventory } = require('../utils/meetingMinutesAgentV2');
  const rows = [
    { id: 'T0001', speaker: 'Chair Person', text: 'Thursday at ten, then.' },
    { id: 'T0002', speaker: 'Chair Person', text: 'Dana, will you put that in his calendar, because he accepts things from you.' },
    { id: 'T0003', speaker: 'Dana Moss', text: "I'll do it straight after this." },
    { id: 'T0004', speaker: 'Chair Person', text: 'Great.' }
  ];
  assert.ok(addressedRequestAcceptedAhead(rows[1], rows.slice(2, 4)));
  const candidate = actionCandidateInventory(rows).find((item) => item.focusEvidenceId === 'T0002');
  assert.equal(candidate.dispositionHint, 'accepted_request');
  assert.ok(candidate.priority >= 8);
  // Someone else answering, or the addressee refusing, is not acceptance.
  assert.ok(!addressedRequestAcceptedAhead(rows[1], [{ speaker: 'Lee Hart', text: "I'll do it." }]));
  assert.ok(!addressedRequestAcceptedAhead(rows[1], [{ speaker: 'Dana Moss', text: "I can't this week, I'm away." }]));
});

test('two questions for the same person, or two edits to different slides, stay separate', () => {
  assert.ok(distinctActionDeliverables(
    { action: 'Ask Morgan whether the two supplier audits are delayed by budget or by staffing.' },
    { action: "Ask Morgan about Lee's access to the complaints folder." }));
  assert.ok(distinctActionDeliverables(
    { action: 'Restore the fade effect on the pricing slide.' },
    { action: 'Build the closing slide with the signup link and a QR code.' }));
  assert.ok(!distinctActionDeliverables(
    { action: 'Email Jo the quarterly report.' },
    { action: 'Send the quarterly report to Jo.' }));
});
