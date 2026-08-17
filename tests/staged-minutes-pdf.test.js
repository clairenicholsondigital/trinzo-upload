const assert = require('node:assert/strict');
const test = require('node:test');

const { normaliseMinutes, renderStagedMinutesPdfHtml, stagedMinutesPdfFilename } = require('../utils/stagedMinutesPdf');

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
  assert.match(html, /Send the plan/);
  assert.doesNotMatch(html, /<script/i);
  assert.equal(stagedMinutesPdfFilename(minutes), 'Client-Audit.pdf');
});

test('staged PDF normalisation drops empty rows and supplies display fallbacks', () => {
  const result = normaliseMinutes({ actions: [{ action: '' }], discussion: [{ points: [] }] });
  assert.equal(result.details.meetingTitle, 'Meeting minutes');
  assert.deepEqual(result.actions, []);
  assert.deepEqual(result.discussion, []);
});
