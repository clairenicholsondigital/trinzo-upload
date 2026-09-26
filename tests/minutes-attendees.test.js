'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const { generateMeetingMinutesAgentDocx } = require('../utils/meetingMinutesAgentDocx');
const { renderStagedMinutesPdfHtml } = require('../utils/stagedMinutesPdf');

// A meeting nobody from the client side attended is an internal meeting, not a
// meeting with an empty guest list. Publishing "Client attendees: Not stated"
// states something about the meeting that is not true of it.

const SOURCE_UNITS = [{ id: 'T0001', sequence: 1, speaker: 'Jacqui Fox', timestamp: '00:10', text: 'We agreed the scope.' }];

function draftWith(details) {
  return {
    title: 'Review',
    details: { meetingTitle: 'Review', meetingDate: '2026-06-23', ...details },
    discussion: [{
      topic: 'Scope', points: [{ id: 'p1', text: 'The scope was agreed.', evidenceIds: ['T0001'] }],
      decisions: [], openQuestions: []
    }],
    actions: [], sourceUnits: SOURCE_UNITS, reviewFlags: []
  };
}

async function docxXml(details) {
  const buffer = await generateMeetingMinutesAgentDocx(draftWith(details), false);
  return (await JSZip.loadAsync(buffer)).file('word/document.xml').async('string');
}

test('Word: the client line is left out when nobody from the client side was there', async () => {
  const xml = await docxXml({ internalAttendees: ['Jacqui Fox'], clientAttendees: [] });
  assert.match(xml, /Internal attendees: Jacqui Fox/);
  assert.doesNotMatch(xml, /Client attendees/);
  assert.doesNotMatch(xml, /External attendees/);
});

test('Word: blank names do not count as attendance', async () => {
  const xml = await docxXml({ internalAttendees: ['Jacqui Fox'], clientAttendees: ['', '   '] });
  assert.doesNotMatch(xml, /Client attendees/);
});

test('Word: the client line is kept, and labelled, when there are client attendees', async () => {
  const xml = await docxXml({ internalAttendees: ['Jacqui Fox'], clientAttendees: ['Alex Reed'] });
  assert.match(xml, /Client attendees: Alex Reed/);
  const external = await docxXml({
    internalAttendees: ['Jacqui Fox'], clientAttendees: ['Alex Reed'], clientAttendeeLabel: 'External'
  });
  assert.match(external, /External attendees: Alex Reed/);
  assert.doesNotMatch(external, /Client attendees/);
});

test('Word: an internal list is still reported as not stated when it is empty', async () => {
  // Only the client row is conditional. An empty internal list is a gap in the
  // record of who was there, which is worth saying.
  const xml = await docxXml({ internalAttendees: [], clientAttendees: ['Alex Reed'] });
  assert.match(xml, /Internal attendees: Not stated/);
});

function pdfHtml(details) {
  return renderStagedMinutesPdfHtml({
    details: { meetingTitle: 'Review', meetingDate: '2026-06-23', meetingLocation: 'Teams', meetingType: 'Review', ...details },
    discussion: [{ topic: 'Scope', points: ['The scope was agreed.'] }],
    actions: []
  });
}

test('PDF: the client row is left out when nobody from the client side was there', () => {
  const html = pdfHtml({ internalAttendees: ['Jacqui Fox'], clientAttendees: [] });
  assert.match(html, /<span class="label">Internal attendees<\/span>Jacqui Fox/);
  assert.doesNotMatch(html, /Client attendees/);
});

test('PDF: the client row is kept when there are client attendees', () => {
  const html = pdfHtml({ internalAttendees: ['Jacqui Fox'], clientAttendees: ['Alex Reed'] });
  assert.match(html, /<span class="label">Client attendees<\/span>Alex Reed/);
});
