'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const MinutesActionPromotion = require('../utils/meetingMinutesActionPromotion');
const MinutesDiscussionSelection = require('../utils/meetingMinutesDiscussionSelection');
const MinutesPublication = require('../utils/meetingMinutesPublication');
const MinutesFinalActionPreservation = require('../utils/meetingMinutesFinalActionPreservation');
const { mergeCommitmentDuplicates } = require('../utils/canonicalMinutes/commitmentDuplicates');

const action = (text, extra = {}) => ({
  id: 'work', action: text, owners: ['Morgan Lee'], evidenceIds: ['T0001'],
  reviewFlagIds: [], timing: { kind: 'target', wording: 'next week', exactDate: '2026-11-06' }, ...extra
});

test('splitting cannot donate a combined instruction deadline to every independent step', () => {
  const flags = [];
  const input = action('Update the inspection checklist, review the supplier questionnaire, and arrange the planning call.');
  const before = structuredClone(input);
  const rows = MinutesActionPromotion.splitCompoundActionList([input], '', { flags });
  assert.equal(rows.length, 3);
  assert.ok(rows.every(row => row.timing.kind === 'not_stated'));
  assert.ok(flags.length, 'the original timing uncertainty must remain reviewable');
  assert.ok(flags.every(flag => /next week/.test(flag.message)));
  assert.deepEqual(input, before);
});

test('a source-bound deadline stays on its own step even when absent from generated prose', () => {
  const input = action('Update the inspection checklist, review the supplier questionnaire, and arrange the planning call.', {
    evidenceIds: ['T0001', 'T0002']
  });
  const sourceUnits = [
    { id: 'T0001', speaker: 'Morgan Lee', text: 'I will update the inspection checklist and review the supplier questionnaire.' },
    { id: 'T0002', speaker: 'Morgan Lee', text: 'I will arrange the planning call next week.' }
  ];
  const rows = MinutesActionPromotion.splitCompoundActionList([input], '', { sourceUnits });
  assert.deepEqual(rows.map(row => row.timing.kind), ['not_stated', 'not_stated', 'target']);
  assert.equal(rows[2].timing.exactDate, '2026-11-06');
});

test('an explicit common deadline can apply to all of the listed work', () => {
  const sourceUnits = [{ id: 'T0001', speaker: 'Morgan Lee', text: 'I will update the inspection checklist and review the supplier questionnaire; both tasks are due next week.' }];
  const rows = MinutesActionPromotion.splitCompoundActionList([action('Update the inspection checklist, and review the supplier questionnaire.')], '', { sourceUnits });
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.timing.wording === 'next week'));
});

test('timing for an unrelated cited task cannot be borrowed by a split instruction', () => {
  const sourceUnits = [{ id: 'T0001', speaker: 'Morgan Lee', text: 'The maintenance inspection is next week.' }];
  const flags = [];
  const rows = MinutesActionPromotion.splitCompoundActionList([action('Update the access policy, and arrange the planning call.')], '', { sourceUnits, flags });
  assert.ok(rows.every(row => row.timing.kind === 'not_stated'));
  assert.ok(flags.length);
});

test('final splitting preserves reviewer-authored wording and field choices', () => {
  const input = action('Update the inspection checklist, and arrange the planning call.', { reviewerAuthored: true });
  assert.deepEqual(MinutesActionPromotion.splitCompoundActionList([input]), [input]);
});

test('a shared subject word is not proof that a deadline belongs to that deliverable', () => {
  const sourceUnits = [{ id: 'T0001', speaker: 'Morgan Lee', text: 'The maintenance inspection is next week.' }];
  const flags = [];
  const rows = MinutesActionPromotion.splitCompoundActionList([action('Update the inspection checklist, and arrange the planning call.')], '', { sourceUnits, flags });
  assert.ok(rows.every(row => row.timing.kind === 'not_stated'));
  assert.equal(flags.length, 1);
});

test('source timing can distinguish two operations on the same document', () => {
  const sourceUnits = [{ id: 'T0001', speaker: 'Morgan Lee', text: 'I will send the budget report next week.' }];
  const rows = MinutesActionPromotion.splitCompoundActionList([action('Review the budget report, and send the budget report.')], '', { sourceUnits });
  assert.deepEqual(rows.map(row => row.timing.kind), ['not_stated', 'target']);
});

test('a named refusal or another person’s assignment cannot establish this owner’s timing', () => {
  for (const text of [
    'Morgan Lee will not arrange the planning call next week.',
    'Morgan Lee says Priya Shah will arrange the planning call next week.'
  ]) {
    const flags = [];
    const rows = MinutesActionPromotion.splitCompoundActionList([action('Update the access policy, and arrange the planning call.')], '', {
      sourceUnits: [{ id: 'T0001', speaker: 'Morgan Lee', text }], flags
    });
    assert.ok(rows.every(row => row.timing.kind === 'not_stated'), text);
    assert.equal(flags.length, 1);
  }
});

test('a qualified common deadline is not spread over an explicitly later step', () => {
  const flags = [];
  const rows = MinutesActionPromotion.splitCompoundActionList([action('Update the inspection checklist, and arrange the planning call.')], '', {
    sourceUnits: [{ id: 'T0001', speaker: 'Morgan Lee', text: 'Both tasks are due next week, but the planning call will follow later after the inspection checklist.' }], flags
  });
  assert.ok(rows.every(row => row.timing.kind === 'not_stated'));
  assert.equal(flags.length, 1);
});

test('a reversed speaker display name does not lose a genuinely bound deadline', () => {
  const rows = MinutesActionPromotion.splitCompoundActionList([action('Update the access policy, and arrange the planning call.')], '', {
    sourceUnits: [{ id: 'T0001', speaker: 'Lee, Morgan', text: 'I will arrange the planning call next week.' }]
  });
  assert.deepEqual(rows.map(row => row.timing.kind), ['not_stated', 'target']);
});

test('accepted resource allocation survives supporting-detail promotion and ordinary publication', () => {
  const sourceUnits = [{ id: 'T0001', speaker: 'Morgan Lee', text: 'We have agreed to earmark the surplus for accessibility upgrades.' }];
  const input = [{ id: 'topic', topic: 'Income', points: [{ id: 'parent', text: 'The admission charge will increase.',
    evidenceIds: ['T0001'], supportingDetails: [{ id: 'allocation', text: 'The surplus is earmarked for accessibility upgrades.', evidenceIds: ['T0001'] }]
  }], decisions: [], openQuestions: [] }];
  const result = MinutesDiscussionSelection.promotePrioritySupportingDetails(input, 6, 2, sourceUnits);
  assert.equal(result.promoted, 1);
  assert.equal(result.discussion[0].points[1].text, input[0].points[0].supportingDetails[0].text);
  const draft = { details: {}, sourceUnits, discussion: result.discussion, actions: [], reviewFlags: [] };
  assert.ok(MinutesPublication.meetingAgentDraftForDocx(draft).discussion.some(topic => topic.points.some(row => row.id === 'allocation')));
  assert.deepEqual(input[0].points[0].supportingDetails.map(row => row.id), ['allocation']);
});

test('final approved-work preservation enriches a known variant instead of restoring a duplicate', () => {
  const base = action('Explain the admission price increase to £18 in the renewal notice.', {
    timing: { kind: 'not_stated', wording: '', exactDate: '' }
  });
  const full = { ...base, id: 'full', action: 'Explain the admission price increase from £15 to £18 in the renewal notice.', reviewFlagIds: ['check-one'] };
  const result = MinutesFinalActionPreservation.reconcileFinalApprovedActions([base], [base, full]);
  assert.equal(result.actions.length, 1);
  assert.match(result.actions[0].action, /from £15 to £18/);
  assert.ok(result.actions[0].reviewFlagIds.includes('check-one'));
  assert.equal(result.restored.length, 0);
  assert.deepEqual(MinutesFinalActionPreservation.reconcileFinalApprovedActions(result.actions, [base, full]), result);
  const merged = mergeCommitmentDuplicates([base, full]);
  assert.equal(MinutesFinalActionPreservation.reconcileFinalApprovedActions(merged.actions, [base, full]).actions.length, 1);
});

test('publication cannot revive a source-reviewed exclusion through a supporting copy', () => {
  const excluded = { id: 'aside', text: 'A personal preference was presented as a plan.', evidenceIds: ['T0001'], supportingDetails: [] };
  const draft = { details: {}, sourceUnits: [{ id: 'T0001', text: 'That was just a joke.' }], actions: [], reviewFlags: [],
    qualityState: { discussion: { fidelityWithheldRows: [{ record: excluded }] } },
    discussion: [{ id: 'topic', topic: 'Planning', points: [
      { ...excluded, id: 'another-source-copy' },
      { id: 'real', text: 'Supplier confirmation remains pending.', evidenceIds: ['T0002'], supportingDetails: [{ ...excluded, id: 'context-copy' }] }
    ], decisions: [], openQuestions: [] }]
  };
  const result = MinutesPublication.meetingAgentPublicationContent(draft);
  assert.deepEqual(result.discussion[0].points.map(row => row.id), ['real']);
  assert.deepEqual(result.discussion[0].points[0].supportingDetails, []);
  assert.equal(draft.discussion[0].points.length, 2, 'publication does not mutate the stored original');
});

test('final survival cannot suppress a distinct approved instruction through a loose deliverable match', () => {
  for (const [left, right] of [
    ['Confirm the approved budget is £30.', 'Confirm the approved budget is $30.'],
    ['Review all equipment reports.', 'Review all equipment reports except the Orion report.'],
    ['Record Morgan as owner of Orion and Dana as owner of Vega.', 'Record Morgan as owner of Vega and Dana as owner of Orion.'],
    ['Send equipment from warehouse Delta to warehouse Echo.', 'Send equipment from warehouse Echo to warehouse Delta.'],
    ['Confirm the status of Orion against Vega.', 'Confirm the status of Vega against Orion.'],
    ['Confirm the flow rate is 30 mL.', 'Confirm the flow rate is 30 ML.'],
    ['Confirm the error limit is 10.', 'Confirm the error limit is 10%.'],
    ['Review ten equipment reports.', 'Review up to ten equipment reports.'],
    ['Confirm the refundable deposit is £30.', 'Confirm the non-refundable deposit is £30.'],
    ['Review the q report.', 'Review the r report.']
  ]) {
    const pair = [action(left, { id: 'left' }), action(right, { id: 'right' })];
    for (const [published, approved] of [pair, [...pair].reverse()]) {
      const result = MinutesFinalActionPreservation.reconcileFinalApprovedActions([published], [approved]);
      assert.equal(result.actions.length, 2, `${published.action} / ${approved.action}`);
      assert.deepEqual(result.restored, [approved]);
    }
  }
});

test('a reviewer may explicitly retain text previously withheld from generated minutes', () => {
  const row = { id: 'manual', text: 'The reviewer confirmed the travel restriction.', evidenceIds: ['T0001'], supportingDetails: [], reviewerAuthored: true };
  const draft = { details: {}, sourceUnits: [], actions: [], reviewFlags: [], qualityState: {
    discussion: { fidelityWithheldRows: [{ record: row }] }
  }, discussion: [{ id: 'topic', topic: 'Logistics', points: [row], decisions: [], openQuestions: [] }] };
  assert.equal(MinutesPublication.meetingAgentPublicationContent(draft).discussion[0].points[0].text, row.text);
});

test('a manual supporting child does not protect a different withheld generated sibling', () => {
  const excluded = { id: 'aside', text: 'The committee approved a separate leisure itinerary.', evidenceIds: ['T0001'], supportingDetails: [] };
  const manual = { id: 'manual', text: 'Reviewer requested separate confirmation.', evidenceIds: ['T0003'], supportingDetails: [], reviewerAuthored: true };
  const draft = { details: {}, sourceUnits: [], actions: [], reviewFlags: [],
    qualityState: { discussion: { fidelityWithheldRows: [{ record: excluded }] } },
    discussion: [{ id: 'topic', topic: 'Planning', points: [{ id: 'parent',
      text: 'Supplier confirmation remains pending.', evidenceIds: ['T0002'], supportingDetails: [manual, excluded]
    }], decisions: [], openQuestions: [] }]
  };
  const result = MinutesPublication.meetingAgentPublicationContent(draft);
  assert.deepEqual(result.discussion[0].points[0].supportingDetails, [manual]);
  assert.equal(draft.discussion[0].points[0].supportingDetails.length, 2);
});
