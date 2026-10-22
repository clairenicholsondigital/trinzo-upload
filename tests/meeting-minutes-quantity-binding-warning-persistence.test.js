'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../utils/meetingMinutesAgentV2');
const A = require('../routes/api').stagedEvaluation;
const { generateMeetingMinutesAgentDocx } = require('../utils/meetingMinutesAgentDocx');
const JSZip = require('jszip');

function unresolvedDraft() {
  const sourceUnits = V.normaliseSourceUnits([
    { id: 'T0001', speaker: 'Chair', text: 'Document preparation starts next Tuesday.' },
    { id: 'T0002', speaker: 'Chair', text: 'We will be on premises for three days.' }
  ]);
  const { discussion, flags } = V.filterUnsupportedQuantifiedDiscussion([{
    id: 'schedule-topic', topic: 'Preparation and inspection',
    points: [{ id: 'schedule', text: 'Document preparation starts next Tuesday. The on-premises inspection is planned for three days.',
      evidenceIds: ['T0001', 'T0002'], reviewFlagIds: [] }], decisions: [], openQuestions: []
  }], sourceUnits);
  assert.equal(flags.length, 1, 'source binding remains unresolved rather than being silently certified');
  return { sourceUnits, discussion, actions: [], reviewFlags: flags,
    qualityState: { discussion: { topicArrangementVersion: 1 } } };
}

test('an internally identified unresolved quantity binding survives save, publication and evidence export', async () => {
  const draft = unresolvedDraft();
  const original = structuredClone(draft);
  const flag = draft.reviewFlags[0];
  assert.match(flag.id, /^flag-quantity-binding-/);
  assert.equal(V.isUsefulReviewFlag(flag), true);
  const saved = A.meetingAgentDraftPayload(draft);
  for (const output of [saved, A.publicMeetingAgentDraft(saved), A.meetingAgentDraftForDocx(saved)]) {
    const persisted = output.reviewFlags.find(item => item.id === flag.id);
    assert.ok(persisted, 'an unresolved warning must remain visible');
    assert.equal(persisted.status, 'open');
    assert.equal(persisted.message, flag.message);
    assert.deepEqual(persisted.evidenceIds, flag.evidenceIds);
    assert.ok(JSON.stringify(output.discussion).includes(flag.id), 'the warning remains attached to its claim');
  }
  const evidencePdf = A.meetingAgentDraftForPdf(saved, true);
  assert.deepEqual(evidencePdf.reviewFlags.find(item => item.id === flag.id), saved.reviewFlags[0],
    'the evidence PDF adapter carries the same unresolved warning');
  const word = await JSZip.loadAsync(await generateMeetingMinutesAgentDocx(A.meetingAgentDraftForDocx(saved), true));
  const xml = await word.file('word/document.xml').async('string');
  assert.ok(xml.includes(flag.message), 'the actual evidence Word document contains the unresolved warning');
  assert.deepEqual(draft, original);
});

test('quantity-binding warnings retain reviewer resolution and the warning filter still retires completed wording history', () => {
  const draft = unresolvedDraft();
  const original = draft.reviewFlags[0];
  draft.reviewFlags = [{ ...original, status: 'corrected', correctionNote: 'Confirmed the inspection duration with the chair.' },
    V.normaliseFlag({ id: 'flag-wording-history', kind: 'uncertain_fact', message: 'The unsupported duration wording was corrected against the source.' }),
    V.normaliseFlag({ id: 'flag-ordinary-pending', kind: 'uncertain_fact', message: 'Document access had not yet been confirmed.' })];
  const saved = A.meetingAgentDraftPayload(draft);
  const visible = A.publicMeetingAgentDraft(saved);
  assert.equal(visible.reviewFlags.find(flag => flag.id === original.id).status, 'corrected');
  assert.equal(visible.reviewFlags.find(flag => flag.id === original.id).correctionNote, draft.reviewFlags[0].correctionNote);
  assert.ok(!visible.reviewFlags.some(flag => ['flag-wording-history', 'flag-ordinary-pending'].includes(flag.id)));
});
