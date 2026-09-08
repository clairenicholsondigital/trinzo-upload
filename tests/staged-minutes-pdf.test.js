const assert = require('node:assert/strict');
const test = require('node:test');

const { formatUkDate, normaliseMinutes, renderStagedMinutesPdfHtml, stagedMinutesPdfFilename } = require('../utils/stagedMinutesPdf');

test('staged PDF renderer uses reviewed content and escapes it safely', () => {
  const minutes = {
    details: {
      meetingTitle: 'Client <Audit>', meetingDate: '2026-08-17', meetingLocation: 'Teams', meetingType: 'Project review',
      internalAttendees: ['Jacqui Fox'], clientAttendees: ['Alex & Co'], clientAttendeeLabel: 'Client'
    },
    summary: { objectives: ['Confirm scope'], executiveSummary: 'Reviewed & agreed.' },
    discussion: [{ topic: 'Scope', points: ['Product <classification>'] }],
    actions: [{ owner: 'Jacqui Fox', action: 'Send the plan', deadline: 'Friday' }]
  };
  const html = renderStagedMinutesPdfHtml(minutes);
  assert.match(html, /Client &lt;Audit&gt;/);
  assert.match(html, /Alex &amp; Co/);
  assert.match(html, /17 August 2026/);
  assert.match(html, /Project review/);
  assert.match(html, /Send the plan/);
  assert.match(html, /font-family:'Roboto'/);
  assert.match(html, /data:font\/woff2;base64,/);
  assert.doesNotMatch(html, /Arial/);
  assert.doesNotMatch(html, /<script/i);
  assert.equal(stagedMinutesPdfFilename(minutes), 'Client-Audit.pdf');
});

test('staged PDF formats ISO dates for UK readers without changing existing prose dates', () => {
  assert.equal(formatUkDate('2026-06-17'), '17 June 2026');
  assert.equal(formatUkDate('17 June 2026'), '17 June 2026');
});

test('staged PDF normalisation drops empty rows and supplies display fallbacks', () => {
  const result = normaliseMinutes({ actions: [{ action: '' }], discussion: [{ points: [] }] });
  assert.equal(result.details.meetingTitle, 'Meeting minutes');
  assert.deepEqual(result.actions, []);
  assert.deepEqual(result.discussion, []);
});

test('staged PDF preserves attendees from legacy combined participant fields', () => {
  const result = normaliseMinutes({
    details: { meetingTitle: 'Legacy draft', participants: ['Jacqui Fox', 'Orla Skally'] }
  });
  assert.deepEqual(result.details.internalAttendees, ['Jacqui Fox', 'Orla Skally']);
  assert.deepEqual(result.details.clientAttendees, []);
});

test('PDF renderer supports agent decisions, open questions and an optional evidence appendix', () => {
  const html = renderStagedMinutesPdfHtml({
    details: { meetingTitle: 'Agent review', internalAttendees: ['Jacqui Fox'], clientAttendees: ['Niamh Lynch'], clientAttendeeLabel: 'External' },
    discussion: [{
      topic: 'Audit plan', points: [{ text: 'The audit schedule was reviewed.' }],
      decisions: [{ text: 'The audit will begin on Monday.' }],
      openQuestions: [{ text: 'Confirm secure document access.' }]
    }],
    actions: [{ owner: 'Jacqui Fox', action: 'Send the audit plan.', deadline: 'Deadline: Friday' }],
    evidenceAppendix: [{ id: 'T0012', speaker: 'Jacqui Fox', timestamp: '00:03:15', text: 'I will send the plan by Friday.' }],
    reviewFlags: [{ status: 'open', message: 'Confirm the document-access method.' }]
  });
  assert.match(html, /External attendees/);
  assert.match(html, /The audit will begin on Monday/);
  assert.match(html, /Confirm secure document access/);
  assert.match(html, /Evidence appendix/);
  assert.match(html, /T0012 · Jacqui Fox · 00:03:15/);
  assert.match(html, /Confirm the document-access method/);
});
