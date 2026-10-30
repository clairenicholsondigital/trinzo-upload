'use strict';

const assert = require('node:assert/strict');
const { PAYLOAD_VERSION } = require('../../utils/meetingMinutesDraftStorage');

const longText = 'Calibration background for independent reviewer inspection. '
  + 'The source context remains available with its evidence and qualifications. '.repeat(27)
  + 'The final calibration qualification is retained: ZETA-TAIL.';
const detail = (id, text, evidenceIds, extra = {}) => ({ id, text, evidenceIds, reviewFlagIds: [], ...extra });
const pool = () => [
  detail('unfiled-long', longText, ['T0002'], { reviewFlagIds: ['detail-review'],
    originalTopic: 'Earlier calibration context', placementReason: 'No unique supporting parent was established.' }),
  detail('unfiled-short', 'The calibration archive contains the retained comparison record.', ['T0003'], {
    originalTopic: 'Archive', placementReason: 'The suggested target was ambiguous.' })
];
function supportingDetailDraft() {
  const sourceUnits = [
    { id: 'T0001', speaker: 'Morgan Taylor', text: 'The calibration review is complete. I will send the calibration record.' },
    { id: 'T0002', speaker: 'Morgan Taylor', text: longText },
    { id: 'T0003', speaker: 'Morgan Taylor', text: 'The calibration archive contains the retained comparison record.' }
  ];
  return { draftId: 'support-filing', revision: 1, status: 'draft', payloadVersion: PAYLOAD_VERSION,
    details: { meetingTitle: 'Calibration review', meetingType: 'General', meetingDate: '2026-10-21',
      internalAttendees: ['Morgan Taylor'], clientAttendees: [] },
    sourceUnits, preparedTranscript: sourceUnits.map(unit => `[${unit.id}] ${unit.speaker}: ${unit.text}`).join('\n'),
    discussion: [{ id: 'calibration', topic: 'Calibration review',
      points: [{ id: 'main', text: 'The calibration review is complete.', evidenceIds: ['T0001'], reviewFlagIds: [], supportingDetails: [] }],
      decisions: [], openQuestions: [] }],
    unassignedSupportingDetails: pool(),
    actions: [{ id: 'send', action: 'Send the calibration record.', owners: ['Morgan Taylor'],
      timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds: ['T0001'], reviewFlagIds: [] }],
    executiveSummary: 'The calibration record was reviewed.', meetingObjectives: [],
    reviewFlags: [{ id: 'detail-review', kind: 'unclear_reference', status: 'open',
      message: 'The calibration context has an unclear reference; confirm which calibration batch it describes.', evidenceIds: ['T0002'], correctionNote: '' }],
    changeHistory: [], redoHistory: [], staleStages: [], currentStep: 5, selectedStep: 5,
    qualityState: { preparation: { dateContext: { source: 'reviewer', meetingDate: '2026-10-21' } } } };
}
function assertPool(actual, expected) {
  assert.ok(Array.isArray(actual), 'the pool must survive as an array');
  const view = rows => rows.map(row => ({ ...row, reviewFlagIds: row.reviewFlagIds || [] }));
  assert.deepEqual(view(actual), view(expected));
}
module.exports = { longText, detail, pool, supportingDetailDraft, assertPool };
