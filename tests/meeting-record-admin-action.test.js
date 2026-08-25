'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { meetingRecordAdminAction } = require('../utils/canonicalMinutes/semanticStages');

// An action whose object is the meeting record itself.
//
// "I'll update that table for the new set of minutes" is a genuine commitment - the
// speaker really does say it, and the referent fix correctly stopped it becoming "the
// ports table". It still has no place as a row IN those minutes: it is the minute-taker
// describing their own admin, and every reviewer deletes it.
//
// This is a category, not a phrase list. The object is the document being produced, which
// is the same kind of self-reference isTranscriptMetaText already screens out for
// "started transcription".

test('writing the meeting record is admin, not a deliverable', () => {
  assert.equal(meetingRecordAdminAction('Update the table for the new set of minutes'), true);
  assert.equal(meetingRecordAdminAction('Update that table for the new set of minutes'), true);
  assert.equal(meetingRecordAdminAction('Tidy up the minutes before Friday'), true);
});

test('doing something WITH the record afterwards is real work', () => {
  // Somebody owes somebody else these, so they belong in the table. The dispatch verbs are
  // an explicit exemption rather than an oversight.
  assert.equal(meetingRecordAdminAction('Circulate the minutes to the client'), false);
  assert.equal(meetingRecordAdminAction('Send the minutes to Orla'), false);
  assert.equal(meetingRecordAdminAction('Approve the minutes'), false);
});

test('a table that is not the meeting record is untouched', () => {
  // The rule keys on the OBJECT being the record, never on the verb alone - otherwise
  // every "update the..." action in the corpus would disappear.
  assert.equal(meetingRecordAdminAction('Update the tracker table with the latest status'), false);
  assert.equal(meetingRecordAdminAction('Update the risk management plan and matrix'), false);
  assert.equal(meetingRecordAdminAction('Write the summary document'), false);
});

test('a word that merely contains a keyword does not trigger it', () => {
  // Word boundaries matter here for a reason worth recording: these regexes were first
  // written through several layers of shell escaping and ended up containing real
  // backspace bytes instead of \b, so every one of them silently matched nothing.
  assert.equal(meetingRecordAdminAction('Update the shareholder register'), false);
});

test('empty and malformed input is refused rather than throwing', () => {
  assert.equal(meetingRecordAdminAction(''), false);
  assert.equal(meetingRecordAdminAction(null), false);
  assert.equal(meetingRecordAdminAction(undefined), false);
});
