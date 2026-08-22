'use strict';

const { clean } = require('./evidence');

// Read the meeting title as a purpose instead of quoting it as a label.
//
// The title was already the last thing standing between most meetings and no purpose at
// all, and it was printed verbatim: "Northbridge Release Planning.", "Operations Review.",
// "Daily AI Check In." True, and the reviewer's own words, but it tells them nothing they
// cannot read in the title field two rows above.
//
// English meeting titles are head-final - [cadence] [subject] [shape] - so the shape word
// sits at the end and everything before it is what the meeting was about. Map the shape to
// a verb and the title states an intention: "Plan the Northbridge release", "Review
// operations", "Check in on AI".
//
// The safety property is not that these are process words. It is what the map is keyed on.
// MODE_CONFIG is keyed on a profile id - a classification decision - and emits a whole
// sentence including subject matter, which is how six meetings were told they were
// rehearsing a webinar. This map is keyed on a token that must literally appear in the
// reviewer's own title, and it emits a verb and nothing else. Every content word in the
// output comes from the title or from this transcript. A misfire can only put the wrong
// verb in front of the right subject; it cannot introduce another meeting's nouns.

// Suffix shapes only. An infixed shape word ("Final Practice Call Before Webinar") is left
// alone rather than guessed at.
const SHAPES = [
  { pattern: /\bcheck[\s-]?ins?$/i, verb: 'Check in on', dimension: 'progress' },
  { pattern: /\bcatch[\s-]?ups?$/i, verb: 'Catch up on', dimension: 'progress' },
  { pattern: /\bstand[\s-]?ups?$/i, verb: 'Run through', dimension: 'progress' },
  { pattern: /\bfollow[\s-]?ups?$/i, verb: 'Follow up on' },
  { pattern: /\bkick[\s-]?offs?$/i, verb: 'Kick off' },
  { pattern: /\bclose[\s-]?outs?$/i, verb: 'Close out' },
  { pattern: /\bretrospectives?$/i, verb: 'Look back on' },
  { pattern: /\brehearsals?$/i, verb: 'Rehearse' },
  { pattern: /\bwalkthroughs?$/i, verb: 'Walk through' },
  { pattern: /\bworkshops?$/i, verb: 'Work through' },
  { pattern: /\bdebriefs?$/i, verb: 'Debrief on' },
  { pattern: /\bbriefings?$/i, verb: 'Brief the meeting on' },
  { pattern: /\btriages?$/i, verb: 'Triage' },
  { pattern: /\bplanning$/i, verb: 'Plan' },
  { pattern: /\bdiscussions?$/i, verb: 'Discuss' },
  { pattern: /\breviews?$/i, verb: 'Review' },
  { pattern: /\bupdates?$/i, verb: 'Update the meeting on' },
  { pattern: /\bsyncs?$/i, verb: 'Sync on' },
  { pattern: /\bprep$/i, verb: 'Prepare for' }
];

// Words that say a meeting happened, not what it was about. Stripped from the end so the
// shape word underneath is reachable: "Status Update Meeting" -> "Status Update".
const FURNITURE = /\s*\b(?:meetings?|sessions?|calls?)$/i;

// How often, not what about.
const CADENCE = /\b(?:daily|weekly|fortnightly|biweekly|monthly|quarterly|annual|yearly|regular|recurring|quick|short|final|initial|internal|external|loose|low[\s-]?substance)\b/gi;

// Words that fill a title without naming anything. Used ONLY to decide whether an object
// is thin - never stripped, because "Delivery Status Review" must stay "Review delivery
// status" rather than becoming "Review delivery".
const EMPTY_SUBJECT = new Set([
  'project', 'projects', 'status', 'progress', 'team', 'general', 'overall', 'ongoing',
  'update', 'updates', 'review', 'reviews', 'check', 'checkin', 'catch', 'plan',
  'planning', 'meeting', 'session', 'call', 'agenda', 'notes', 'minutes', 'discussion'
]);

function words(value) {
  return clean(value).split(/\s+/).filter(Boolean);
}

// Ask the transcript how a word is written. titleCaseMeetingText has already destroyed the
// original casing, so "Sales Pipeline" and "Northbridge Release" look identical - only the
// meeting itself can say which is a name and which is an ordinary noun. The same move
// repairRunTogetherWords and namesARecurringSubject already make.
function casedFromTranscript(word, events) {
  const bare = word.replace(/[^A-Za-z0-9'-]/g, '');
  if (!bare || /^[A-Z0-9]{2,}$/.test(bare)) return word;
  const lower = bare.toLowerCase();
  const texts = (Array.isArray(events) ? events : []).map((event) => String(event && event.text || ''));
  // Capitalised in the middle of a sentence is the transcript telling us this is a name.
  const seenAsName = texts.some((text) => new RegExp(`\\S\\s+${bare.charAt(0).toUpperCase()}${bare.slice(1).toLowerCase()}\\b`).test(text));
  if (seenAsName) return word.replace(bare, `${bare.charAt(0).toUpperCase()}${bare.slice(1).toLowerCase()}`);
  // Otherwise an ordinary noun, whether the meeting used it or never mentioned it. A name
  // that matters to a meeting is almost always said aloud in it, so silence is weak
  // evidence of an ordinary word - and "Review delivery status" reads properly where
  // "Review Delivery Status" reads like the name of a product.
  return word.replace(bare, lower);
}

// Short function words carry no subject either, so they must not rescue an object made
// only of meeting words: "Weekly Check In Planning" leaves the object "Check In", and
// without this "in" makes it look substantive and yields "Plan the check in".
const FUNCTION_WORD = /^(?:in|on|of|and|the|a|an|for|to|up|out|with|at|by)$/i;

function objectIsThin(objectWords) {
  const carrying = objectWords.filter((word) => !FUNCTION_WORD.test(word.replace(/[^A-Za-z]/g, '')));
  return !carrying.length || carrying.every((word) => EMPTY_SUBJECT.has(word.toLowerCase().replace(/[^a-z]/g, '')));
}

// "the Northbridge release" but not "the AI" and not "the Riverton". An article reads
// wrongly in front of a name or an initialism.
function withArticle(objectWords) {
  const phrase = objectWords.join(' ');
  const first = objectWords[0] || '';
  const isName = /^[A-Z]/.test(first) || /^[A-Z0-9]{2,}$/.test(first.replace(/[^A-Za-z0-9]/g, ''));
  return isName ? phrase : `the ${phrase}`;
}

function splitTitle(title) {
  let text = clean(title).replace(/[.\s]+$/, '');
  for (let pass = 0; pass < 2 && FURNITURE.test(text); pass += 1) text = text.replace(FURNITURE, '');
  for (const shape of SHAPES) {
    if (!shape.pattern.test(text)) continue;
    const object = clean(text.replace(shape.pattern, '')).replace(CADENCE, ' ');
    return { shape, objectWords: words(object) };
  }
  return null;
}

// The title read as a purpose, or null when there is no shape word to read it by - in
// which case the caller keeps today's verbatim-title behaviour.
//
// `enrich` supplies the object for a title that names nothing of its own ("Project Check
// In"), and is expected to return a phrase drawn from this meeting or ''.
function purposeFromTitleShape(meeting = {}, evidence = {}, enrich = () => '') {
  const split = splitTitle(meeting.title || meeting.meetingTitle);
  if (!split) return null;
  const { shape, objectWords } = split;
  const events = (evidence && evidence.events) || [];

  if (objectIsThin(objectWords)) {
    const supplied = clean(enrich());
    if (!supplied) return null;
    const dimension = shape.dimension ? `${shape.dimension} on ` : '';
    return {
      text: `${shape.verb} ${dimension}${supplied}.`,
      source: 'title_transform_enriched'
    };
  }

  const cased = objectWords.map((word) => casedFromTranscript(word, events));
  const dimension = shape.dimension ? `${shape.dimension} for ` : '';
  return {
    text: `${shape.verb} ${dimension}${dimension ? cased.join(' ') : withArticle(cased)}.`,
    source: 'title_transform'
  };
}

module.exports = { purposeFromTitleShape, splitTitle, casedFromTranscript, SHAPES };
