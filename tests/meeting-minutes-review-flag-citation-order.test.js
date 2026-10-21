'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../utils/meetingMinutesAgentV2');
const { actionTimingIssueFlag } = require('../utils/meetingMinutesTimingFlags');

// Use the real synchronous stage merge and publication helpers. A DB or
// provider call is forbidden; this regression needs only source fixtures.
process.env.MEETING_MINUTES_AGENT_SPECULATIVE_PIPELINE_V1 = '0';
const fetchPath = require.resolve('node-fetch');
const originalFetch = require(fetchPath);
let externalCalls = 0;
const forbidden = () => { externalCalls += 1; throw new Error('External calls are forbidden in citation-order regressions'); };
require.cache[fetchPath].exports = forbidden;
const db = require('../utils/db');
const originalDb = { ...db };
for (const [key, value] of Object.entries(db)) if (typeof value === 'function') db[key] = forbidden;
const api = require('../routes/api').stagedEvaluation;
Object.assign(db, originalDb);
require.cache[fetchPath].exports = originalFetch;
test.after(() => assert.equal(externalCalls, 0));

const copy = value => JSON.parse(JSON.stringify(value));
const units = [
  { id: 'T0001', speaker: 'Morgan', text: 'I will review the inspection report.' },
  { id: 'T0002', speaker: 'Morgan', text: 'I will review the inspection report thoroughly.' },
  { id: 'T0003', speaker: 'Morgan', text: 'The inspection report is incomplete. The laboratory summary is a controlled document.' }
];
const warning = (id, evidenceIds, extra = {}) => ({ id, kind: 'missing_evidence',
  message: 'Check the source support for the inspection review.', evidenceIds,
  status: 'open', correctionNote: '', ...extra });

function fixture(flags) {
  return { reviewFlags: flags, actions: [{ id: 'inspection', action: 'Review the inspection report.', owners: ['Morgan'],
    timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds: ['T0002', 'T0001'], reviewFlagIds: ['check-a', 'check-b'] }],
    discussion: [{ id: 'equipment', topic: 'Equipment', points: [{ id: 'report', text: 'The inspection report is incomplete.',
      evidenceIds: ['T0003'], reviewFlagIds: ['check-a'], supportingDetails: [{ id: 'laboratory',
        text: 'The laboratory summary is a controlled document.', evidenceIds: ['T0003'], reviewFlagIds: ['check-b'] }] }],
    decisions: [], openQuestions: [] }] };
}

function publish(input) {
  const normalised = V.normaliseAgentResult(input, units, 'actions', { meetingDate: '2026-10-21' });
  const draft = api.applyStageResultVirtually({ draftId: 'citation-order', revision: 1, payloadVersion: V.PAYLOAD_VERSION,
    details: { meetingTitle: 'Equipment review', meetingType: 'General', meetingDate: '2026-10-21' },
    sourceUnits: units, preparedTranscript: V.preparedTranscriptFromUnits(units), discussion: [], actions: [],
    reviewFlags: [], qualityState: {}, currentStep: 3, selectedStep: 3 }, 'actions', {
    changes: { discussion: normalised.discussion, actions: normalised.actions }, reviewFlags: normalised.reviewFlags
  });
  return { normalised, visible: api.publicMeetingAgentDraft(draft) };
}

test('fresh duplicate warnings share one visible review item regardless of citation or flag order', () => {
  for (const reverseCitations of [false, true]) for (const reverseFlags of [false, true]) {
    const flags = [warning('check-a', ['T0001', 'T0002']),
      warning('check-b', reverseCitations ? ['T0002', 'T0001'] : ['T0001', 'T0002'])];
    if (reverseFlags) flags.reverse();
    let input = fixture(flags);
    const kept = copy(flags[0]);
    for (let repeat = 0; repeat < 3; repeat += 1) {
      const before = copy(input);
      const { normalised, visible } = publish(input);
      assert.deepEqual(input, before, 'comparison must not mutate the supplied rows or citation arrays');
      for (const result of [normalised, visible]) {
        assert.equal(result.reviewFlags.length, 1, `one warning for citationOrder=${reverseCitations}, flagOrder=${reverseFlags}`);
        assert.deepEqual(result.reviewFlags[0], kept, 'the kept warning retains its original citation order and content');
        assert.deepEqual(result.actions[0].evidenceIds, ['T0002', 'T0001']);
        assert.deepEqual(result.actions[0].reviewFlagIds, [kept.id]);
        const point = result.discussion[0].points[0];
        assert.deepEqual(point.evidenceIds, ['T0003']);
        assert.deepEqual(point.reviewFlagIds, [kept.id]);
        assert.deepEqual(point.supportingDetails[0].evidenceIds, ['T0003']);
        assert.deepEqual(point.supportingDetails[0].reviewFlagIds, [kept.id], 'nested aliases must resolve to the kept warning');
      }
      input = copy({ actions: visible.actions, discussion: visible.discussion, reviewFlags: visible.reviewFlags });
    }
  }
});

test('citation-set comparison preserves different warnings and independent reviewer decisions', () => {
  const origin = { id: 'inspection', action: 'Review the inspection report.', owners: ['Morgan'],
    evidenceIds: ['T0001', 'T0002'], timing: { kind: 'not_stated', wording: '', exactDate: '' } };
  const timingIssue = row => actionTimingIssueFlag({ code: 'timing_check_unresolved' }, row,
    'Check the source support for the inspection review.').systemTimingIssue;
  const scenarios = [
    [{}, { evidenceIds: ['T0002', 'T0003'] }],
    [{}, { message: 'Check the source support for a separate decision.' }],
    [{}, { kind: 'unclear_reference' }],
    [{}, { status: 'confirmed' }],
    [{ correctionNote: 'Inspection checked.' }, { correctionNote: 'Laboratory checked.' }],
    [{ status: 'confirmed', correctionNote: 'Checked.' }, { status: 'confirmed', correctionNote: 'Checked.' }],
    [{ reviewerAuthored: true }, {}],
    [{ kind: 'timing', systemTimingIssue: timingIssue(origin) }, { kind: 'timing',
      systemTimingIssue: timingIssue({ ...origin, id: 'laboratory', action: 'Send the laboratory summary.' }) }],
    [{ kind: 'timing', temporalField: 'executiveSummary' }, { kind: 'timing', temporalField: 'meetingObjectives' }]
  ];
  for (const [first, second] of scenarios) for (const reverseFlags of [false, true]) {
    const flags = [warning('check-a', ['T0001', 'T0002'], first), warning('check-b', ['T0002', 'T0001'], second)];
    if (reverseFlags) flags.reverse();
    const input = fixture(flags);
    const before = copy(input);
    const { normalised, visible } = publish(input);
    assert.deepEqual(input, before);
    for (const result of [normalised, visible]) {
      assert.equal(result.reviewFlags.length, 2, JSON.stringify([first, second]));
      for (const flag of flags) assert.deepEqual(result.reviewFlags.find(row => row.id === flag.id), V.normaliseFlag(flag));
      assert.deepEqual(result.actions[0].reviewFlagIds, ['check-a', 'check-b']);
      assert.deepEqual(result.discussion[0].points[0].reviewFlagIds, ['check-a']);
      assert.deepEqual(result.discussion[0].points[0].supportingDetails[0].reviewFlagIds, ['check-b']);
    }
  }
});
