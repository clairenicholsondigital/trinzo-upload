'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { purposeFromTitleShape, splitTitle, SHAPES } = require('../utils/canonicalMinutes/titlePurpose');
const { actionObjectPhrase, subjectFromMeeting } = require('../utils/canonicalMinutes/initialUnderstanding');

// Reading the meeting title as a purpose.
//
// The title used to be printed verbatim as the purpose for most meetings - true, and the
// reviewer's own words, and telling them nothing they could not read in the title field
// two rows above. English meeting titles are head-final, so the shape word is at the end
// and everything before it is the subject.

const events = (...texts) => ({ events: texts.map((text, index) => ({ id: `e${index}`, text })) });
const meeting = events(
  'The Northbridge release is slipping and Hartwell need an answer.',
  'delivery status is amber again this week',
  'operations picked up the site work'
);

test('a shape word at the end of the title becomes the verb', () => {
  const cases = [
    ['Northbridge Release Planning', 'Plan Northbridge release.'],
    ['Delivery Status Review', 'Review the delivery status.'],
    ['Validation Close Out Review', 'Review the validation close out.'],
    ['Travel Policy Briefing', 'Brief the meeting on the travel policy.'],
    ['Elmstead Options Workshop', 'Work through the elmstead options.']
  ];
  for (const [title, expected] of cases) {
    assert.equal(purposeFromTitleShape({ title }, meeting)?.text, expected, title);
  }
});

test('a check-in is about progress, and says so', () => {
  // The request that prompted this: "daily AI check in ... would be more a purpose of
  // checking in on progress".
  assert.equal(purposeFromTitleShape({ title: 'Daily AI Check In' }, meeting)?.text, 'Check in on progress for AI.');
  assert.equal(purposeFromTitleShape({ title: 'Hartwell Site Catch Up' }, meeting)?.text, 'Catch up on progress for Hartwell site.');
});

test('an initialism keeps its capitals and takes no article', () => {
  assert.equal(purposeFromTitleShape({ title: 'AI Programme Review' }, meeting)?.text, 'Review AI programme.');
});

test('the transcript decides which title words are names', () => {
  // titleCaseMeetingText has already flattened the original casing, so "Sales Pipeline"
  // and "Northbridge Release" look identical by the time the purpose is built. Only the
  // meeting can say which is a name: a word capitalised mid-sentence is one.
  assert.match(purposeFromTitleShape({ title: 'Northbridge Release Planning' }, meeting).text, /Northbridge/);
  assert.match(purposeFromTitleShape({ title: 'Delivery Status Review' }, meeting).text, /the delivery status/);
  // A word the meeting never mentions is treated as ordinary. A name that matters to a
  // meeting is almost always said aloud in it.
  assert.equal(purposeFromTitleShape({ title: 'Sales Pipeline Review' }, meeting)?.text, 'Review the sales pipeline.');
});

test('a title with no shape word is left alone', () => {
  // The caller keeps today's verbatim-title behaviour rather than guessing a verb.
  for (const title of ['Kingswell Launch Recovery', 'Alder Product Submission', 'Ciara', '']) {
    assert.equal(purposeFromTitleShape({ title }, meeting), null, title);
  }
  // Deliberate limitation: an infixed shape word is not read, so the title stands.
  assert.equal(purposeFromTitleShape({ title: 'Final Practice Call Before Webinar' }, meeting), null);
});

test('a title that names nothing asks the meeting instead', () => {
  // "Project Check In" is entirely meeting-process words. So is "Weekly Check In
  // Planning" once the cadence is removed - the leftover "Check In" must not look
  // substantive because of the word "in", or it yields "Plan the check in".
  const noSubject = ['Project Check In', 'Status Review', 'Weekly Check In Planning', 'Catch Up'];
  for (const title of noSubject) {
    assert.equal(purposeFromTitleShape({ title }, meeting), null, `${title} without enrichment`);
    assert.equal(
      purposeFromTitleShape({ title }, meeting, () => 'the SGS submission pack').source,
      'title_transform_enriched',
      title
    );
  }
  assert.equal(
    purposeFromTitleShape({ title: 'Project Check In' }, meeting, () => 'the SGS submission pack').text,
    'Check in on progress on the SGS submission pack.'
  );
});

test('the object of an action is found by grammar, not by a list of known verbs', () => {
  // The dead actionSubject this replaces used a verb allowlist with no fix, call, update,
  // draft or chase in it, so it stripped nothing from four of these.
  const cases = [
    ['Fix the staging config by swapping the connection string', 'the staging config'],
    ['Call the venue', 'the venue'],
    ['Finish the SGS submission pack before Friday', 'the SGS submission pack'],
    // The deadline was cut off and left its preposition behind; published actions still
    // carry these.
    ['Draft and send the release note by', 'the release note'],
    // When it was due is not what it was about.
    ['Rerun the regression suite tomorrow morning', 'the regression suite'],
    ['Update the run sheet once Marta confirms', 'the run sheet']
  ];
  for (const [action, expected] of cases) assert.equal(actionObjectPhrase(action), expected, action);
});

test('an action the extractor cannot read is declined rather than guessed at', () => {
  // Producing nothing is correct behaviour, not failure.
  for (const action of ['Update our run sheet', 'Sort it', 'Circulate', '']) {
    assert.equal(actionObjectPhrase(action), '', JSON.stringify(action));
  }
});

test('a vague action is refused before its object is ever extracted', () => {
  // "Have a read around" is grammatically readable - the extractor returns "a read
  // around" - and is not a subject. Deciding that is not the extractor's job: the
  // presentation check already names the fault, and subjectFromMeeting asks it first.
  assert.equal(actionObjectPhrase('Have a read around'), 'a read around', 'grammatically extractable');
  const about = events('we should have a read around the topic', 'a read around would help', 'read around it first');
  assert.equal(subjectFromMeeting(about, ['Have a read around']), '', 'and refused as a subject');
});

test('enrichment prefers an action the meeting keeps returning to', () => {
  const about = events(
    'the SGS submission is what is holding us up',
    'we need the SGS submission pack finished',
    'once the SGS submission lands we can move'
  );
  assert.equal(subjectFromMeeting(about, ['Finish the SGS submission pack before Friday']), 'the SGS submission pack');
  // A one-off action is not what the meeting was for.
  assert.equal(subjectFromMeeting(about, ['Book the offsite venue in Galway']), '');
  assert.equal(subjectFromMeeting(about, []), '');
});

test('the shape map carries verbs and no subject matter', () => {
  // The structural guarantee. MODE_CONFIG is keyed on a classification decision and emits
  // a whole sentence, which is how six meetings were told they were rehearsing a webinar.
  // This map is keyed on a token that must appear in the reviewer's own title and emits a
  // verb, so a misfire can only put the wrong verb in front of the right subject.
  const source = fs.readFileSync(path.resolve(__dirname, '../utils/canonicalMinutes/titlePurpose.js'), 'utf8');
  const map = source.slice(source.indexOf('const SHAPES'), source.indexOf('const FURNITURE'));
  for (const word of ['audit', 'importer', 'webinar', 'software', 'client', 'invoice', 'lead', 'pipeline', 'alarm']) {
    assert.doesNotMatch(map, new RegExp(`\\b${word}`, 'i'), `the shape map must not mention "${word}"`);
  }
  for (const shape of SHAPES) {
    assert.ok(shape.pattern instanceof RegExp, 'each shape is matched by a pattern');
    assert.match(shape.pattern.source, /\$$/, 'shapes are read off the end of the title only');
    assert.ok(shape.verb.split(/\s+/).length <= 4, `verb phrase stays short: ${shape.verb}`);
  }
});

test('the map cannot be reached by a meeting type alone', () => {
  // The assertion MODE_CONFIG would fail. Its prose is keyed on a profile id, so one wrong
  // classification puts another kind of meeting's nouns in these minutes. Nothing here can
  // fire unless the word is in the title the reviewer confirmed.
  assert.equal(purposeFromTitleShape({ title: '', type: 'Webinar rehearsal' }, meeting), null);
  assert.equal(splitTitle(''), null);
});
