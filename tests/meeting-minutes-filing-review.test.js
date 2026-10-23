'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { filingSuggestions, filingReviewFlags } = require('../utils/meetingMinutesFilingReview');
const { groupedEntries, suggestionBasis } = require('../public/meeting-minutes-filing-order');
const { withoutRepresentedUnassignedDetails } = require('../utils/meetingMinutesSupportingDetails');
const { normaliseAgentResult } = require('../utils/meetingMinutesAgentV2');
const api = require('../routes/api').stagedEvaluation;
const record = (id, extra = {}) => ({ id, text: 'The calibration certificate covers pressure measurements.',
  evidenceIds: ['T0001'], reviewFlagIds: [], ...extra });
const fixture = () => ({ sourceUnits: [{ id: 'T0001', speaker: 'Alex Green', text: 'The calibration certificate covers pressure measurements.' }],
  discussion: [{ id: 'topic', topic: 'Calibration evidence', points: [record('main')], decisions: [], openQuestions: [] }],
  unassignedSupportingDetails: [record('retained')], reviewFlags: [], actions: [] });

test('grouping exact text preserves each occurrence and its independent provenance without mutating input', () => {
  const rows = [record('a', { filingMergeProtected: true }), record('b', { evidenceIds: ['T0002'], reviewFlagIds: ['warning'] }),
    record('c', { text: 'The calibration certificate does not cover pressure measurements.' })];
  const before = structuredClone(rows), groups = groupedEntries(rows, []);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].entries.map(entry => entry.index), [0, 1]);
  assert.deepEqual(groups[0].entries[1].detail, rows[1]);
  assert.deepEqual(rows, before);
});
for (const extra of [{ reviewerAuthored: true }, { confirmedTopic: true }, { source: 'stage_2_human_confirmation' }, { id: 'manual-a' }]) {
  test('reviewer-owned occurrences keep independent display positions: ' + JSON.stringify(extra), () => {
    assert.equal(groupedEntries([record('a'), record('b', extra)], []).length, 2);
  });
}
test('wording differences including case, conditions and quantities are never collapsed', () => {
  const texts = ['Pressure is 5 bar.', 'Pressure is 6 bar.', 'pressure is 5 bar.', 'Pressure is 5 bar after approval.'];
  assert.equal(groupedEntries(texts.map((text, i) => record(String(i), { text })), []).length, 4);
});
test('filing a selected occurrence cannot silently remove another source subset', () => {
  const first = record('first', { evidenceIds: ['T0001', 'T0002'] });
  const second = record('second');
  const discussion = [{ points: [{ ...first, reviewerAuthored: true }], decisions: [], openQuestions: [] }];
  assert.deepEqual(withoutRepresentedUnassignedDetails([second], discussion).map(row => [row.id, row.text, row.evidenceIds]), [[second.id, second.text, second.evidenceIds]]);
  assert.deepEqual(withoutRepresentedUnassignedDetails([first], discussion), []);
});
test('suggestions use the existing unique subject rule, without altering the draft', () => {
  const draft = fixture(), before = structuredClone(draft), result = filingSuggestions(draft);
  assert.deepEqual(result.suggestions, [{ index: 0, topicIndex: 0, field: 'points', itemIndex: 0 }]);
  assert.equal(result.basis, suggestionBasis(draft));
  assert.deepEqual(draft, before);
  draft.discussion[0].points[0].text += ' Changed.';
  assert.notEqual(result.basis, suggestionBasis(draft));
});
for (const change of [
  d => d.discussion[0].points.push(record('other')),
  d => { d.unassignedSupportingDetails[0].reviewFlagIds = ['missing']; },
  d => { d.discussion[0].reviewerAuthored = true; },
  d => { d.discussion[0].points[0].reviewerAuthored = true; },
  d => { d.unassignedSupportingDetails[0].reviewerAuthored = true; },
  d => { d.unassignedSupportingDetails[0].evidenceIds = ['MISSING']; },
  d => { d.discussion[0].points[0].supportingDetails = Array(50).fill(record('child')); }
]) test('ambiguous, warned, locked or incomplete inputs receive no suggestion: ' + change.toString(), () => {
  const draft = fixture(); change(draft); assert.deepEqual(filingSuggestions(draft).suggestions, []);
});
test('warning recovery uses durable definitions, preserves current resolution and does not invent the old explanation', () => {
  const draft = fixture(); draft.unassignedSupportingDetails[0].reviewFlagIds = ['saved', 'missing'];
  const saved = { id: 'saved', kind: 'missing_evidence', message: 'Check pressure qualification.', status: 'open', evidenceIds: ['T0001'] };
  draft.passCache = [{ result: { reviewFlags: [saved, { id: 'private', message: 'Not linked.' }] } }];
  const flags = filingReviewFlags(draft);
  assert.deepEqual(flags[0], saved);
  assert.equal(flags.length, 2); assert.match(flags[1].message, /explanation.*unavailable/);
  const resolved = { ...saved, status: 'confirmed' };
  assert.deepEqual(filingReviewFlags(draft, [resolved])[0], resolved);
  assert.deepEqual(draft.reviewFlags, []);
});
test('public projection recovers warnings and suggestions without exposing private pass evidence or persisting suggestions', () => {
  const draft = fixture(); draft.unassignedSupportingDetails[0].reviewFlagIds = ['missing'];
  const visible = api.publicMeetingAgentDraft(draft);
  assert.match(visible.reviewFlags.find(flag => flag.id === 'missing').message, /unavailable/);
  assert.deepEqual(visible.filingReview.suggestions, []);
  assert.equal(visible.passCache, undefined);
  const payload = api.meetingAgentDraftPayload(visible);
  assert.equal(payload.filingReview, undefined);
  assert.ok(payload.reviewFlags.some(flag => flag.id === 'missing'));
});
test('directly promoted reviewer context keeps full text, all supplied valid citations and placement history', () => {
  const units = Array.from({ length: 14 }, (_, i) => ({ id: 'T' + String(i + 1).padStart(4, '0'), text: 'Calibration certificate and pressure measurements were discussed.' }));
  const point = record('moved', { text: 'Retained wording '.repeat(150), evidenceIds: units.map(unit => unit.id),
    reviewerAuthored: true, filingOrigins: [{ id: 'original', originalTopic: 'Calibration', placementReason: 'no_subject_match' }],
    mergedFromIds: ['predecessor'] });
  const result = normaliseAgentResult({ discussion: [{ topic: 'Calibration', points: [point] }] }, units, 'discussion',
    { enforceEvidence: false, mergeTopics: false, preserveReviewerEdits: true }).discussion[0].points[0];
  assert.equal(result.text, point.text.trim());
  assert.deepEqual(result.evidenceIds, point.evidenceIds);
  assert.deepEqual(result.filingOrigins, point.filingOrigins);
  assert.deepEqual(result.mergedFromIds, point.mergedFromIds);
});
