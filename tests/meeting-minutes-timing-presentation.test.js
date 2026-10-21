'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const { generateMeetingMinutesAgentDocx, timingLabel } = require('../utils/meetingMinutesAgentDocx');
const { formatTimingLabel } = require('../utils/meetingMinutesTiming');
const { meetingAgentDraftForDocx, meetingAgentDraftForPdf, publicMeetingAgentDraft } = require('../routes/api').stagedEvaluation;

const timings = [
  { kind: 'target', wording: 'presumably early next week', exactDate: '2026-09-21' },
  { kind: 'target', wording: 'Preferred: before departure; fallback: by 25 September', exactDate: '2026-09-25' },
  { kind: 'deadline', wording: 'before 24 September', exactDate: '2026-09-24' },
  { kind: 'target', wording: 'between 21 and 24 September', exactDate: '' },
  { kind: 'dependency', wording: 'once approval is received', exactDate: '' }
];

test('export labels preserve qualification, bounds and alternatives beside any valid date', () => {
  for (const timing of timings) {
    assert.equal(timingLabel(timing), formatTimingLabel(timing));
    assert.ok(timingLabel(timing).includes(timing.wording));
  }
  assert.equal(timingLabel({ kind: 'deadline', wording: '', exactDate: '2026-09-24' }), 'Deadline: 24 Sept 2026');
});

test('invalid dates cannot roll over or crash exported timing labels', () => {
  for (const exactDate of ['2026-02-30', '2026-13-01', '2025-02-29']) {
    assert.equal(timingLabel({ kind: 'target', wording: 'after approval', exactDate }), 'Target: after approval');
    assert.equal(timingLabel({ kind: 'deadline', wording: '', exactDate }), 'Not stated');
  }
  assert.equal(timingLabel({ kind: 'deadline', wording: '', exactDate: '2028-02-29' }), 'Deadline: 29 Feb 2028');
});

test('main Word and PDF actions retain the same complete timing meaning without an appendix', async () => {
  const draft = {
    details: { meetingTitle: 'Inspection planning', meetingDate: '2026-09-16' },
    discussion: [], reviewFlags: [], sourceUnits: [],
    actions: timings.map((timing, index) => ({ id: `a${index}`, action: `Complete inspection work ${index + 1}.`, owners: ['Morgan Lee'], timing, evidenceIds: [] }))
  };
  const pdf = meetingAgentDraftForPdf(draft);
  const xml = await (await JSZip.loadAsync(await generateMeetingMinutesAgentDocx(draft, false)))
    .file('word/document.xml').async('string');
  for (let index = 0; index < timings.length; index += 1) {
    assert.equal(pdf.actions[index].deadline, timingLabel(timings[index]));
    assert.ok(xml.includes(timingLabel(timings[index])));
  }
  assert.doesNotMatch(xml, /Evidence appendix/);
});

test('an invalid historical meeting date does not stop Word export or become a different date', async () => {
  const draft = { details: { meetingTitle: 'Review', meetingDate: '2026-02-30' }, discussion: [], actions: [] };
  const xml = await (await JSZip.loadAsync(await generateMeetingMinutesAgentDocx(draft, false)))
    .file('word/document.xml').async('string');
  assert.match(xml, /Date: Not stated/);
  assert.doesNotMatch(xml, /2 Mar/);
});

test('a historical invalid meeting date remains an open review issue without mutating the stored draft', () => {
  const draft = {
    draftId: 'historic-calendar-check',
    details: { meetingTitle: 'Inspection review', meetingDate: '2026-02-30' },
    sourceUnits: [], discussion: [], actions: [], reviewFlags: []
  };
  const original = JSON.parse(JSON.stringify(draft));
  const visible = publicMeetingAgentDraft(draft);
  assert.equal(visible.details.meetingDate, '');
  const dateFlag = visible.reviewFlags.find(flag => flag.id === 'meeting-date-source-check');
  assert.ok(dateFlag);
  assert.equal(dateFlag.status, 'open');
  assert.match(dateFlag.message, /not a valid calendar date/i);
  assert.deepEqual(draft, original, 'reading a Library draft must not persist or rewrite its metadata');
  assert.equal(visible.qualityState, undefined, 'private date-context provenance stays private');
});

function sourceCalendarDraft() {
  return {
    draftId: 'venue-calendar-review',
    details: { meetingTitle: 'Venue opening review', meetingDate: '2027-02-10' },
    sourceUnits: [{ id: 'T0001', speaker: 'Morgan Lee', text: 'The public opening is Sunday the twelfth of March.', classification: 'keep' }],
    discussion: [{ id: 'venue-topic', topic: 'Public opening',
      points: [{ id: 'opening-date', text: 'The public opening is on Sunday 12 March.', evidenceIds: ['T0001'], primaryEvidenceIds: ['T0001'], reviewFlagIds: [] }],
      decisions: [], openQuestions: [] }],
    actions: [], reviewFlags: [],
    qualityState: { preparation: { dateContext: { source: 'transcript_header', meetingDate: '2027-02-10', invalid: [], conflict: false } },
      discussion: { topicArrangementVersion: 1 } }
  };
}

test('public and export boundaries retain a linked conditional source-calendar warning without changing the date prose', async () => {
  const draft = sourceCalendarDraft();
  const original = JSON.parse(JSON.stringify(draft));
  const visible = publicMeetingAgentDraft(draft);
  const record = visible.discussion[0].points[0];
  assert.equal(record.text, draft.discussion[0].points[0].text);
  const flag = visible.reviewFlags.find(item => item.id.startsWith('flag-source-calendar-'));
  assert.ok(flag);
  assert.equal(flag.status, 'open');
  assert.match(flag.message, /without a year/);
  assert.match(flag.message, /confirmed meeting year \(2027\)/);
  assert.deepEqual(record.reviewFlagIds, [flag.id]);
  const wordDraft = meetingAgentDraftForDocx(draft);
  assert.equal(wordDraft.reviewFlags.find(item => item.id === flag.id).status, 'open');
  const wordXml = await (await JSZip.loadAsync(await generateMeetingMinutesAgentDocx(wordDraft, true)))
    .file('word/document.xml').async('string');
  assert.ok(wordXml.includes(record.text));
  assert.match(wordXml, /without a year/);
  const pdf = meetingAgentDraftForPdf(draft, true);
  assert.equal(pdf.reviewFlags.find(item => item.id === flag.id).status, 'open');
  assert.equal(pdf.discussion[0].points[0], record.text);
  assert.deepEqual(draft, original, 'public presentation and export must not alter the stored source or draft');
});

test('source-calendar warnings preserve a reviewer confirmation and abstain when the meeting anchor is conflicting or unknown', () => {
  const draft = sourceCalendarDraft();
  const flag = publicMeetingAgentDraft(draft).reviewFlags.find(item => item.id.startsWith('flag-source-calendar-'));
  const confirmedDraft = { ...draft, reviewFlags: [{ ...flag, status: 'confirmed', correctionNote: 'Confirmed with the venue.' }] };
  assert.equal(publicMeetingAgentDraft(confirmedDraft).reviewFlags.find(item => item.id === flag.id).status, 'confirmed');
  assert.equal(publicMeetingAgentDraft(confirmedDraft).reviewFlags.find(item => item.id === flag.id).correctionNote, 'Confirmed with the venue.');
  assert.equal(meetingAgentDraftForDocx(confirmedDraft).reviewFlags.find(item => item.id === flag.id).status, 'confirmed');
  assert.equal(meetingAgentDraftForPdf(confirmedDraft, true).reviewFlags.find(item => item.id === flag.id).status, 'confirmed');
  const conflicting = JSON.parse(JSON.stringify(draft));
  conflicting.qualityState.preparation.dateContext.conflict = true;
  assert.deepEqual(publicMeetingAgentDraft(conflicting).reviewFlags, []);
  assert.deepEqual(meetingAgentDraftForDocx(conflicting).reviewFlags, []);
  const unknown = { ...draft, qualityState: {} };
  assert.deepEqual(publicMeetingAgentDraft(unknown).reviewFlags, []);
});
