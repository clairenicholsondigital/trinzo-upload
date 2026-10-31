'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const S = require('../utils/meetingMinutesSupportingDetails');
const MinutesSource = require('../utils/meetingMinutesSource');
const MinutesResultNormalization = require('../utils/meetingMinutesResultNormalization');
const MinutesText = require('../utils/meetingMinutesText');
const { filingProvenance } = require('../utils/meetingMinutesFilingProvenance');
const row = (extra = {}) => ({ id: 'discovery-a', text: 'The supplier provided the revised calibration certificate.',
  evidenceIds: ['T0001', 'T0002'], reviewFlagIds: ['check'], supportingDetails: [],
  primaryEvidenceIds: ['T0002'], discoveryDisposition: 'supporting', ...extra });
const collect = (r, topic = 'Equipment') => S.collectUnassignedSupportingDetails(r,
  { originalTopic: topic, placementReason: 'no_subject_match' });
const plain = (id = 'copy-b', extra = {}) => ({ id, text: row().text,
  evidenceIds: ['T0002', 'T0001'], reviewFlagIds: ['check'], ...extra });

test('capture preserves complete discovery metadata before exact consolidation and reload', () => {
  const input = row(), before = structuredClone(input), captured = collect(input);
  assert.equal(captured[0].filingMergeProtected, undefined);
  assert.deepEqual(captured[0].filingOrigins[0].generatedRecord, input);
  const merged = S.mergeUnassignedSupportingDetails(captured, collect(plain(), 'Inspection'));
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].mergedFromIds, ['copy-b']);
  assert.equal(merged[0].filingOrigins.length, 2);
  assert.deepEqual(merged[0].filingOrigins[0].generatedRecord, input);
  assert.deepEqual(S.normalizeUnassignedSupportingDetails(JSON.parse(JSON.stringify(merged))), merged);
  assert.deepEqual(input, before);
});

test('a known candidate envelope is archived with its nested original record', () => {
  const original = row();
  const envelope = { id: 'candidate-b', candidateId: 'candidate-b', text: original.text,
    evidenceIds: original.evidenceIds, reviewFlagIds: original.reviewFlagIds, priority: 4,
    recordType: 'discussion_point', sourcePass: 'staged', topic: 'Inspection',
    dispositionHint: 'supporting', record: original };
  const merged = S.mergeUnassignedSupportingDetails(collect(original), collect(envelope));
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].filingOrigins.map(o => o.generatedRecord), [original, envelope]);
  const copy = filingProvenance(merged[0]);
  copy.filingOrigins[1].generatedRecord.record.primaryEvidenceIds.push('T0001');
  assert.deepEqual(merged[0].filingOrigins[1].generatedRecord.record.primaryEvidenceIds, ['T0002']);
});

for (const [label, extra] of [
  ['unknown metadata', { note: 'Do not consolidate me' }],
  ['reviewer authorship', { reviewerAuthored: true }],
  ['existing protection', { filingMergeProtected: true }],
  ['reviewer identity', { id: 'reviewer-a' }],
  ['manual identity', { id: 'manual-a' }],
  ['invalid primary citations', { primaryEvidenceIds: ['T9999'] }],
  ['malformed primary citations', { primaryEvidenceIds: ['T0001', null] }],
  ['unrecognized disposition', { discoveryDisposition: 'reject' }],
  ['real descendants', { supportingDetails: [{ ...plain('child'), text: 'A separate qualification must remain.' }] }],
  ['malformed descendants', { supportingDetails: {} }]
]) test('generated archive cannot bypass ' + label, () => {
  const records = S.mergeUnassignedSupportingDetails(collect(row(extra)), collect(plain()));
  assert.ok(records.length >= 2);
  assert.ok(records.some(r => r.filingMergeProtected || r.reviewerAuthored || /^(manual-|reviewer-)/.test(r.id)));
});

for (const [label, extra] of [
  ['different evidence', { evidenceIds: ['T0001'] }],
  ['different warnings', { reviewFlagIds: ['other-check'] }],
  ['different wording', { text: 'The supplier may provide a revised calibration certificate.' }]
]) test('exact consolidation still rejects ' + label, () => {
  assert.equal(S.mergeUnassignedSupportingDetails(collect(row()), collect(plain('other', extra))).length, 2);
});

test('direct normalization never unlocks previously protected or raw generated metadata', () => {
  assert.equal(S.normalizeUnassignedSupportingDetails([row(), plain()]).length, 2);
  const archived = collect(row())[0]; archived.filingMergeProtected = true;
  assert.equal(S.mergeUnassignedSupportingDetails([archived], [plain()]).length, 2);
});

test('invalid archive identity and nested candidate recursion remain protected', () => {
  const archived = collect(row())[0];
  archived.filingOrigins[0].generatedRecord.id = 'other-id';
  assert.equal(S.normalizeUnassignedSupportingDetails([archived])[0].filingMergeProtected, true);
  const r = row(), inner = { ...r, candidateId: r.id, priority: 1, sourcePass: 'staged', recordType: 'discussion_point', topic: 'Equipment', record: r };
  const outer = { ...inner, id: 'outer', candidateId: 'outer', record: inner };
  assert.equal(collect(outer)[0].filingMergeProtected, true);
});

test('archive capacity overflow keeps entries separate without truncating history', () => {
  const captured = collect(row())[0];
  captured.filingOrigins = Array.from({ length: 90 }, (_, i) => ({ ...structuredClone(captured.filingOrigins[0]),
    originalTopic: 'Context ' + i, generatedRecord: row({ text: 'Source-supported qualification. '.repeat(45) }) }));
  const records = S.mergeUnassignedSupportingDetails([captured], [plain()]);
  assert.equal(records.length, 2);
  assert.equal(records[0].filingOrigins.length, 90);
  assert.equal(records[0].filingMergeProtected, true);
});

test('filing, promotion, save/reload and restoration retain every archived source record', () => {
  const original = row(), merged = S.mergeUnassignedSupportingDetails(collect(original), collect(plain()))[0];
  const units = MinutesSource.normaliseSourceUnits(original.evidenceIds.map(id => ({ id, text: original.text })));
  const originalPool = structuredClone([merged]);
  for (const promoted of [false, true]) {
    const filed = { ...structuredClone(merged), reviewerAuthored: true };
    const point = promoted ? filed : { id: 'parent', text: original.text, evidenceIds: original.evidenceIds, supportingDetails: [filed] };
    const saved = MinutesResultNormalization.normaliseAgentResult({ discussion: [{ topic: 'Equipment', points: [point] }], actions: [] }, units,
      'discussion', { preserveReviewerEdits: true, enforceEvidence: false, dedupeActions: false, mergeTopics: false });
    const retained = promoted ? saved.discussion[0].points[0] : saved.discussion[0].points[0].supportingDetails[0];
    assert.deepEqual(retained.filingOrigins, merged.filingOrigins);
    assert.deepEqual(retained.mergedFromIds, merged.mergedFromIds);
    assert.deepEqual(S.normalizeUnassignedSupportingDetails(JSON.parse(JSON.stringify(originalPool))), originalPool);
    assert.equal(S.withoutRepresentedUnassignedDetails([merged], saved.discussion).length, 0);
    const stripped = structuredClone(saved.discussion);
    const target = promoted ? stripped[0].points[0] : stripped[0].points[0].supportingDetails[0];
    delete target.filingOrigins;
    assert.equal(S.withoutRepresentedUnassignedDetails([merged], stripped).length, 1);
  }
});

test('glossary, colloquial-time and date formatting never rewrite archived original records', () => {
  const original = row({ text: 'The supplier scheduled the meds app review for monday, July 1st at half two.' });
  const retained = collect(original)[0], origins = structuredClone(retained.filingOrigins);
  const dates = require('../utils/spokenForms').normaliseDatePhrasesDeep;
  const formatted = MinutesText.normaliseKnownTermsDeep(dates({ discussion: [{ points: [retained] }] }));
  assert.notEqual(formatted.discussion[0].points[0].text, original.text);
  assert.deepEqual(formatted.discussion[0].points[0].filingOrigins, origins);
});
