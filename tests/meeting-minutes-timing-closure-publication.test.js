'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../routes/api').stagedEvaluation;
const { promoteMaterialTimingDetails } = require('../utils/meetingMinutesTemporalPublication');

test('courtesy cleanup retains required content and a separately timed supporting step', () => {
  const sourceUnits = [{ id: 'T0001', speaker: 'Morgan', text: "I'll write to the housing office properly this time, copy the adviser and include a photo and the reference number." },
    { id: 'T0002', speaker: 'Morgan', text: "I'll take the photo tomorrow; the letter goes this week." }];
  for (const action of [
    'Write to the housing office, copy the adviser and include a photo.',
    'Write to the housing office and include the reference number.',
    'Take the photo tomorrow and include it with the letter.'
  ]) {
    const row = { id: 'letter', action, owners: ['Morgan'], evidenceIds: ['T0001', 'T0002'] };
    assert.equal(api.stripMinorCommunicationCourtesy(row, sourceUnits).action, action);
  }
});

test('a material deadline is visible in ordinary publication without losing its source or changing parent prose', () => {
  const text = 'Existing devices must be entered in the product register by 28 November 2026.';
  const sourceUnits = [{ id: 'T0001', text: 'Existing devices must be entered in the product register by 28 November this year.' }];
  const discussion = [{ topic: 'Product registration', points: [{ id: 'parent', text: 'Registration requirements were reviewed.',
    evidenceIds: ['T0001'], supportingDetails: [{ id: 'deadline', text, evidenceIds: ['T0001'] }] }] }];
  const before = structuredClone(discussion);
  const promoted = promoteMaterialTimingDetails(discussion, sourceUnits, { meetingDate: '2026-06-17' });
  assert.deepEqual(discussion, before);
  assert.equal(promoted.promoted, 1);
  assert.equal(promoted.discussion[0].points[0].text, discussion[0].points[0].text);
  assert.equal(promoted.discussion[0].points[1].text, text);
  assert.deepEqual(promoted.discussion[0].points[1].evidenceIds, ['T0001']);
  assert.equal(promoteMaterialTimingDetails(promoted.discussion, sourceUnits, { meetingDate: '2026-06-17' }).promoted, 0);
  const draft = { details: { meetingDate: '2026-06-17' }, discussion, sourceUnits, actions: [],
    qualityState: { preparation: { dateContext: { source: 'reviewer', meetingDate: '2026-06-17' } } } };
  const publication = api.meetingAgentDraftForPdf(draft);
  assert.ok(publication.discussion.flatMap(topic => topic.points).includes(text));
});

test('deadline promotion cannot strengthen a qualified source, borrow a date or reshape reviewer content', () => {
  const value = 'Existing devices must be entered in the product register by 28 November 2026.';
  const topic = (extra = {}) => [{ points: [{ id: 'p', text: 'Requirements were discussed.', supportingDetails: [
    { id: 'd', text: value, evidenceIds: ['T0001'], ...extra }
  ] }] }];
  for (const source of [
    'The supplier conference is on 28 November 2026.',
    'Perhaps existing devices might need to be entered in the product register by 28 November 2026.',
    'Existing devices are not required to be entered in the product register by 28 November 2026.',
    'Existing devices must be deleted from the product register by 28 November 2026.',
    'Existing devices must be entered in the product register by 29 November 2026.'
  ]) assert.equal(promoteMaterialTimingDetails(topic(), [{ id: 'T0001', text: source }], { meetingDate: '2026-06-17' }).promoted, 0);
  const source = [{ id: 'T0001', text: value }];
  assert.equal(promoteMaterialTimingDetails(topic({ reviewerAuthored: true }), source).promoted, 0);
  assert.equal(promoteMaterialTimingDetails([{ ...topic()[0], reviewerAuthored: true }], source).promoted, 0);
  const wrongGroup = topic();
  wrongGroup[0].points[0].supportingDetails[0].text = value.replace('Existing', 'New');
  assert.equal(promoteMaterialTimingDetails(wrongGroup, [{ id: 'T0001', text: 'New devices must be registered immediately; existing devices must be entered in the product register by 28 November 2026.' }]).promoted, 0,
    'a deadline for a different product group in the same turn is not authority');
});

test('a real apology cannot remove an attachment or timed copying requirement', () => {
  const sourceUnits = [{ id: 'T0001', speaker: 'Morgan', text: "Sorry, I forgot to copy her on that email." },
    { id: 'T0002', speaker: 'Morgan', text: "I will copy her tomorrow and include a photo." }];
  for (const action of ['Write the letter and include a photo.', 'Copy her tomorrow and include a photo.']) {
    const row = { action, evidenceIds: ['T0001', 'T0002'] };
    assert.equal(api.stripMinorCommunicationCourtesy(row, sourceUnits).action, action);
  }
  const onlyAttachment = { action: 'Include the inspection photo with the letter.', evidenceIds: ['T0001'] };
  assert.equal(api.stripMinorCommunicationCourtesy(onlyAttachment, sourceUnits).action, onlyAttachment.action);
});
