const assert = require('node:assert/strict');
const test = require('node:test');

const { formatUkDate, normaliseMinutes, renderStagedMinutesPdfHtml, stagedMinutesPdfFilename } = require('../utils/stagedMinutesPdf');

test('staged PDF renderer uses reviewed content and escapes it safely', () => {
  const minutes = {
    details: {
      meetingTitle: 'Client <Audit>', meetingDate: '2026-08-17', meetingLocation: 'Teams',
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
