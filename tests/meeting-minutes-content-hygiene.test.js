'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  cleanGeneratedMinutesText,
  removeAccidentalPhraseRepeats,
  removeToneOnlyCommentary
} = require('../utils/meetingMinutesContentHygiene');

test('removes a repeated trailing prepositional phrase with change metadata', () => {
  for (const phrase of ['for completion', 'for final approval', 'with the supporting evidence']) {
    const input = `Send the document ${phrase} ${phrase}.`;
    const output = removeAccidentalPhraseRepeats(input);
    assert.equal(output.text, `Send the document ${phrase}.`);
    assert.deepEqual(output.changes, [{ kind: 'adjacent_phrase_repeat', before: `${phrase} ${phrase}`, after: phrase }]);
  }
});

test('repairs an incomplete restarted phrase without a general prose rewrite', () => {
  assert.equal(removeAccidentalPhraseRepeats('Obtain the report from the, from the supplier.').text,
    'Obtain the report from the supplier.');
  assert.equal(removeAccidentalPhraseRepeats('Send it to the to the review board.').text,
    'Send it to the review board.');
});

test('leaves meaningful repetition and ambiguous middle-of-clause repetitions intact', () => {
  for (const input of [
    'The issue had had an effect on delivery.',
    'Check each item one by one.',
    'Repeat the check again and again until stable.',
    'It is what it is.',
    'The team is very, very concerned.',
    'Put the control in place in place of the previous process.',
    'The request remains under review under review board rules.',
    'Assess each case on a case by case basis.',
    'They discussed it from time to time from time to time.'
  ]) assert.deepEqual(removeAccidentalPhraseRepeats(input), { text: input, changes: [] }, input);
});

test('preserves quoted repetitions and quoted commentary', () => {
  for (const input of [
    'The label says "for review for review".',
    'The label says ‘for review for review’.',
    "The label says 'for review for review'.",
    'The trainer used “lighthearted remarks” as an example.',
    '"There were some informal remarks."',
    'The example was "for review for review'
  ]) assert.deepEqual(cleanGeneratedMinutesText(input), { text: input, changes: [] }, input);
});

test('does not change names, numbers, dates, capitalisation or unrelated spacing', () => {
  const input = 'Send  three hundred and fifty forms to Lee Lee on the 23rd of July for review for review.';
  assert.equal(cleanGeneratedMinutesText(input).text,
    'Send  three hundred and fifty forms to Lee Lee on the 23rd of July for review.');
  for (const input of [
    'Submit Form Form A on 2026-08-07 at 08:30.',
    'Send the evidence to May May.',
    'Confirm the date by may by may.',
    'Use batches of one of one.',
    'Use version 2.2.2 and retain the 10:10 start.',
    "The supplier's report is due Friday.",
    'First line.\nSecond line has  two spaces.'
  ]) assert.deepEqual(cleanGeneratedMinutesText(input), { text: input, changes: [] }, input);
});

test('removes standalone reporting of tone across ordinary spelling forms', () => {
  for (const descriptor of ['lighthearted', 'light-hearted', 'light hearted', 'informal', 'casual']) {
    for (const input of [
      `There were some ${descriptor} remarks.`,
      `The conversation included ${descriptor} comments about timing.`,
      `Some ${descriptor} remarks were made during the meeting.`
    ]) {
      const output = removeToneOnlyCommentary(input);
      assert.equal(output.text, '', input);
      assert.equal(output.changes[0].kind, 'tone_only_commentary');
    }
  }
  assert.equal(removeToneOnlyCommentary('There was some banter before the meeting.').text, '');
});

test('detaches only a tone-only final clause while preserving the substantive qualification', () => {
  for (const descriptor of ['lighthearted', 'light-hearted', 'light hearted']) {
    const input = `Submission may occur late Friday or possibly Sunday night, with some ${descriptor} remarks on timing.`;
    assert.equal(removeToneOnlyCommentary(input).text,
      'Submission may occur late Friday or possibly Sunday night.');
  }
  assert.equal(removeToneOnlyCommentary('The delivery date remains provisional; there was some casual banter.').text,
    'The delivery date remains provisional; there was some casual banter.');
  assert.equal(removeToneOnlyCommentary('The delivery date remains provisional; there was some banter.').text,
    'The delivery date remains provisional.');
});

test('preserves substantive decisions and uncertainty without adopting a social-word blacklist', () => {
  for (const input of [
    'The team agreed to remove the joke from the webinar script.',
    'Remove the informal comments from the presentation before delivery.',
    'The decision to retain the joke remains provisional.',
    'The session will include lighthearted remarks to introduce the exercise.',
    'The conversation included lighthearted remarks that changed the submission deadline.',
    'The conversation included lighthearted remarks about whether the date should change.',
    'Submission is provisional, with lighthearted remarks, but approval is still required.',
    'The device does not retain the previous setting.',
    'The informal comments identified a missing approval.'
  ]) assert.deepEqual(removeToneOnlyCommentary(input), { text: input, changes: [] }, input);
});

test('preserves complaints, workplace harm, holiday cover and workload safety', () => {
  for (const input of [
    'The lighthearted remarks caused a client complaint requiring follow-up.',
    'There were informal remarks about harassment.',
    'Participants made lighthearted remarks about a colleague’s disability.',
    'The discussion included informal comments about a safety risk.',
    'Book holiday cover for the customer support team.',
    'Annual leave is scheduled while another team provides cover.',
    'Operator fatigue was recorded as a safety risk requiring shift controls.',
    'The team is overworked, putting delivery quality at risk.',
    'Managing multiple audits simultaneously is challenging due to overlapping information and mental workload; breaks and downtime are important to maintain effectiveness.'
  ]) assert.deepEqual(cleanGeneratedMinutesText(input), { text: input, changes: [] }, input);
});

test('keeps material timing or a consequence attached to a remark', () => {
  for (const input of [
    'There were lighthearted remarks before the 10:30 deadline.',
    'There were informal remarks about a delay that affects delivery.',
    'There were lighthearted remarks, which led to a complaint.',
    'The remarks caused a change to the plan.',
    'There were informal remarks about changing the deadline.'
  ]) assert.deepEqual(removeToneOnlyCommentary(input), { text: input, changes: [] }, input);
});

test('unchanged inputs remain byte-for-byte stable and composition is idempotent', () => {
  const input = 'Send the report for review for review.';
  const cleaned = cleanGeneratedMinutesText(input);
  assert.equal(cleaned.text, 'Send the report for review.');
  assert.deepEqual(cleanGeneratedMinutesText(cleaned.text), { text: cleaned.text, changes: [] });
  const repeated = cleanGeneratedMinutesText('Send it for review for review for review.');
  assert.equal(repeated.text, 'Send it for review.');
  assert.deepEqual(cleanGeneratedMinutesText(repeated.text), { text: repeated.text, changes: [] });
  assert.deepEqual(cleanGeneratedMinutesText(''), { text: '', changes: [] });
});

test('removes only standalone tone sentences from a paragraph', () => {
  for (const [input, expected] of [
    ['The review is due Friday. There were some lighthearted remarks.', 'The review is due Friday.'],
    ['There were informal remarks. The date remains provisional.', 'The date remains provisional.'],
    ['The date remains provisional. There was some banter. The team agreed to check availability.',
      'The date remains provisional. The team agreed to check availability.'],
    ['The date remains provisional. There was some banter. There were casual comments.',
      'The date remains provisional.'],
    ['  There was some banter.  The  date remains provisional.', '  The  date remains provisional.'],
    ['  There was some banter.  ', ''],
    ['The date remains provisional.\nThere were lighthearted remarks.\nThe location is unchanged.',
      'The date remains provisional.\nThe location is unchanged.']
  ]) {
    const output = removeToneOnlyCommentary(input);
    assert.equal(output.text, expected, input);
    assert.equal(output.changes.length, 1);
    assert.deepEqual(removeToneOnlyCommentary(output.text), { text: expected, changes: [] });
  }
});

test('paragraph cleanup preserves abbreviations, quotations and operational tone content', () => {
  assert.equal(removeToneOnlyCommentary('Dr. Patel will review version 2.4. There were informal remarks. The U.K. office will reply.').text,
    'Dr. Patel will review version 2.4. The U.K. office will reply.');
  for (const input of [
    'Use examples, e.g. informal comments about timing.',
    'Examples are due from A. There were some lighthearted remarks.',
    'The review is due Friday... There were some lighthearted remarks.',
    'The label says "There were some informal remarks." The review is due Friday.',
    'The deadline is Friday. The team agreed to remove the joke from the script.',
    'The date is provisional. There were informal remarks about a colleague’s disability.',
    'The date is provisional. There were lighthearted remarks about a complaint.'
  ]) assert.deepEqual(removeToneOnlyCommentary(input), { text: input, changes: [] }, input);
});
