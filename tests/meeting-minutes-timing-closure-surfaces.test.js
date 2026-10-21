'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../utils/meetingMinutesTiming');
const { generateMeetingMinutesAgentDocx } = require('../utils/meetingMinutesAgentDocx');
const { minutesActionsForProjectReport } = require('../utils/minutesForProjectUpdate');
const { meetingAgentDraftForPdf } = require('../routes/api').stagedEvaluation;
const JSZip = require('jszip');
const V = require('../utils/meetingMinutesAgentV2');

test('a critic can identify unsupported ISO precision without erasing verbatim broad or recurring timing', () => {
  for (const wording of ['every Friday', 'in two to three weeks']) {
    const units = [{ id: 'T0001', speaker: 'Morgan', text: `I will review the inspection report ${wording}.` }];
    const action = { id: 'review', action: 'Review the inspection report.', owners: ['Morgan'], evidenceIds: ['T0001'],
      timing: { kind: 'target', wording, exactDate: '2026-06-19' } };
    const options = { meetingDate: '2026-06-17' };
    const items = V.timingCheckItems([action], units, options);
    const checked = V.applyTimingCheckResults([action], items, [{ id: items[0].id, verdict: 'misread',
      timingQuote: wording, stepQuote: 'review the inspection report', correctTiming: '', reason: 'The ISO date adds precision absent from the source.' }], options);
    assert.equal(checked.actions[0].timing.wording, wording);
    assert.equal(checked.actions[0].timing.exactDate, '');
    assert.equal(checked.accounting.counts.corrected, 1);
    assert.equal(checked.accounting.complete, true);
    assert.ok(checked.flags.some(flag => /exact date.*removed/i.test(flag.message)));
  }
});

test('calendar precision and complete timing wording survive JSON, ordinary export and the project adapter', async () => {
  const values = [
    ['every Friday', ''], ['17 March last year', '2025-03-17'], ['04/05/2026', ''],
    ['within five working days', ''], ['for two weeks', ''], ['not before Friday', ''],
    ['after receipt of the draft', ''], ['Friday at 10:30 BST', '2026-06-19'],
    ['Friday at 10:30 UTC', '2026-06-19'], ['this week', ''],
    ['Preferred: Wednesday; fallback: Friday', '']
  ];
  const actions = values.map(([wording, exactDate], index) => {
    const timing = T.normaliseTimingValue({ kind: 'target', wording, exactDate: '' }, { mode: 'derive', meetingDate: '2026-06-17' });
    assert.equal(timing.exactDate, exactDate, wording);
    return { id: `work-${index}`, action: `Review inspection report ${index + 1}.`, owners: ['Morgan'], timing, evidenceIds: [] };
  });
  const draft = JSON.parse(JSON.stringify({ details: { meetingDate: '2026-06-17' }, discussion: [], sourceUnits: [], actions }));
  const expected = draft.actions.map(action => T.formatTimingLabel(action.timing));
  const pdf = meetingAgentDraftForPdf(draft);
  assert.deepEqual(pdf.actions.map(action => action.deadline), expected);
  assert.deepEqual(minutesActionsForProjectReport(pdf.actions).map(action => action.deadline), expected);
  const docx = await generateMeetingMinutesAgentDocx(draft, false);
  const zip = await JSZip.loadAsync(docx);
  const xml = await zip.file('word/document.xml').async('string');
  for (const [wording] of values) assert.ok(xml.includes(wording), `ordinary Word export omitted ${wording}`);
  assert.ok(xml.includes('17 Mar 2025'), 'historical year must remain historical');
});

test('a missing meeting anchor cannot borrow the current server date or convert a zone', () => {
  for (const wording of ['today', 'tomorrow', 'Friday at 23:30 BST', '28 November this year', '28 November last year']) {
    const value = T.normaliseTimingValue({ kind: 'target', wording, exactDate: '' }, { mode: 'derive', meetingDate: '' });
    assert.equal(value.wording, wording);
    assert.equal(value.exactDate, '');
  }
});
