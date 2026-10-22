'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../utils/meetingMinutesAgentV2');
const { stagedEvaluation: api } = require('../routes/api');
const { collectUnassignedSupportingDetails } = require('../utils/meetingMinutesSupportingDetails');

const detail = (id, text, evidenceIds, extra = {}) => ({ id, text, evidenceIds, ...extra });

test('atomic unfiled handoff retains three levels of text, evidence and reviewer provenance', () => {
  const long = 'Independent calibration qualification and supporting source observations. '.repeat(28) + 'FINAL-QUALIFICATION.';
  const grandchild = detail('grandchild', long, ['T0003', 'T0004'], { reviewerAuthored: true, reviewFlagIds: ['deep-review'] });
  const child = detail('child', 'The calibration archive contains the complete comparison record.', ['T0002'], { supportingDetails: [grandchild] });
  const parent = detail('parent', 'The calibration source requires independent confirmation.', ['T0001'], { supportingDetails: [child] });
  const before = structuredClone(parent);
  const retained = collectUnassignedSupportingDetails(parent, { originalTopic: 'Calibration source', placementReason: 'no_subject_match' });
  assert.deepEqual(retained.map(record => record.id), ['parent', 'child', 'grandchild']);
  assert.equal(retained[2].text, long);
  assert.ok(retained[2].text.length > 1600);
  assert.deepEqual(retained[2].evidenceIds, ['T0003', 'T0004']);
  assert.deepEqual(retained[2].reviewFlagIds, ['deep-review']);
  assert.equal(retained[2].reviewerAuthored, true);
  assert.equal(retained[2].originalTopic, 'Calibration source');
  assert.deepEqual(parent, before);
});

test('a child present in both the record and atomic handoff context is retained once with its descendants', () => {
  const grandchild = detail('grandchild', 'The independent comparison remains in the calibration archive.', ['T0003']);
  const child = detail('child', 'The supplier certificate requires an independent check.', ['T0002'], { supportingDetails: [grandchild] });
  const parent = detail('parent', 'Calibration qualification is awaiting clarification.', ['T0001'], { supportingDetails: [child] });
  const retained = collectUnassignedSupportingDetails(parent, {
    originalTopic: 'Calibration qualification', placementReason: 'ambiguous_subject_match', supportingDetails: [child]
  });
  assert.deepEqual(retained.map(record => record.id), ['parent', 'child', 'grandchild']);
  assert.equal(retained.length, 3);
  assert.deepEqual(retained.map(record => record.evidenceIds), [['T0001'], ['T0002'], ['T0003']]);
});

test('a registry-only warning on newly unfiled context survives reconciliation, payload and publication', () => {
  const text = 'The cooling assembly contains an unresolved supplier reference.';
  const sourceUnits = [{ id: 'T0001', speaker: 'Morgan Lee', text }];
  const warningId = 'new-unfiled-only-source-check';
  const parsed = V.normaliseAgentResult({
    discussion: [{ id: 'source', topic: 'Cooling assembly', points: [
      { id: 'unfiled-source', text, evidenceIds: ['T0001'], reviewFlagIds: [warningId] }
    ], decisions: [], openQuestions: [] }],
    reviewFlags: [{ id: warningId, kind: 'unclear_reference', status: 'open',
      message: 'Confirm which supplier this additional source detail describes.', evidenceIds: ['T0001'] }]
  }, sourceUnits, 'discussion');
  const pool = collectUnassignedSupportingDetails(parsed.discussion[0].points[0], {
    originalTopic: 'Cooling assembly', placementReason: 'explicit_target_missing'
  });
  // The definition is no longer present in this final-pass input. It must be
  // recovered from the same registry used by discovery and recovery parsing.
  const reconciled = V.reconcileRecordFlags({ discussion: [], supportingDetails: pool }, []);
  assert.equal(reconciled.recovered, 1);
  assert.equal(reconciled.flags.find(flag => flag.id === warningId)?.status, 'open');
  const draft = { sourceUnits, discussion: [], actions: [], unassignedSupportingDetails: pool,
    reviewFlags: reconciled.flags, details: { meetingTitle: 'Cooling review', meetingDate: '2026-10-21' } };
  const payload = api.meetingAgentDraftPayload(draft);
  const visible = api.publicMeetingAgentDraft({ ...draft, ...payload });
  assert.deepEqual(visible.unassignedSupportingDetails[0].reviewFlagIds, [warningId]);
  assert.equal(visible.reviewFlags.find(flag => flag.id === warningId)?.status, 'open');
  assert.equal(visible.unassignedSupportingDetails[0].text, text);
});
