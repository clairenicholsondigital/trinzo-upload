'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const { generateMeetingMinutesAgentDocx, timingLabel } = require('../utils/meetingMinutesAgentDocx');
const { formatTimingLabel } = require('../utils/meetingMinutesTiming');
const { meetingAgentDraftForPdf, publicMeetingAgentDraft } = require('../routes/api').stagedEvaluation;

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
