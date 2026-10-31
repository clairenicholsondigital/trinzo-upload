'use strict';

const { text } = require('./meetingMinutesText');
const { contentTokens } = require('./meetingMinutesRecordMatching');
const { evidenceContextFor } = require('./meetingMinutesEvidenceContext');
const { isReviewerAuthored } = require('./canonicalMinutes/state');
const { normaliseFlag } = require('./meetingMinutesReviewFlags');
const { actionPredicateSupported } = require('./meetingMinutesActionEvidence');

// Shared source context, action policy and review flags use their actual owners.

function canonicalSpeakerDisplayName(value) {
  const raw = text(value, 180);
  const comma = raw.indexOf(',');
  if (comma < 0) return raw;
  const family = raw.slice(0, comma).trim();
  const given = raw.slice(comma + 1).trim().split(/\s+/).filter((part) => {
    return part.replace(/[^A-Za-z0-9]/g, '').length > 1;
  }).join(' ');
  return text(`${given} ${family}`, 180) || raw;
}

// People named in the meeting who never spoke and are not listed as attendees
// (work is often assigned to them). Capitalised names in person-like positions,
// mentioned more than once.
const NOT_A_PERSON = new Set(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'teams', 'excel', 'word', 'sharepoint', 'trinzo', 'udimed', 'udamed', 'eudamed', 'mdr', 'qms', 'sop', 'ppe', 'usb', 'gui',
  'the', 'this', 'that', 'yeah', 'okay', 'sorry', 'thanks', 'hello', 'right', 'well', 'and', 'but', 'once', 'because']);
function mentionedPeople(units = []) {
  const counts = new Map();
  for (const unit of evidenceContextFor(units).rows) {
    const value = String(unit.text || '');
    const patterns = [/\b(?:with|to|for|from|ask|asked|tell|told|and|by)\s+([A-Z][a-z]{2,15})\b/g, /\b([A-Z][a-z]{2,15})\s+(?:will|is|has|can|should|to)\b/g];
    for (const pattern of patterns) {
      for (const match of value.matchAll(pattern)) {
        const name = match[1];
        if (NOT_A_PERSON.has(name.toLowerCase())) continue;
        counts.set(name, (counts.get(name) || 0) + 1);
      }
    }
  }
  return [...counts.entries()].filter(([, count]) => count >= 2).map(([name]) => name);
}

const OWNER_ONGOING_WORK = /\bi(?:'m|’m|\s+am)\s+(?:currently\s+|still\s+|just\s+|now\s+|also\s+)?(?:trying|working|looking|going\s+through|doing|chasing|sorting|reviewing|rewriting|drafting|writing|preparing|checking|testing|simulating|updating|pulling|putting\s+together|waiting\s+on|in\s+the\s+middle\s+of)\b|\bi(?:'ve|’ve|\s+have)\s+(?:just\s+|also\s+|only\s+|actually\s+)?been\s+\w+ing\b|\bi(?:'ve|’ve|\s+have)\s+(?:already\s+|just\s+|now\s+)?(?:added|started|begun|drafted|made\s+a\s+start)\b/i;
const OWNER_FIRST_PERSON = new RegExp(`${/\bi\b(?:\s+\w+){0,2}\s+(?:will|shall|can|could|need to|needs to|have to|going to|gonna|intend to|plan to|aim to)\b|\b(?:i'll|i'd|i'm going to|i'm gonna)\b|\bshould i\s+(?:just\s+)?(?:add|check|email|forward|place|pop|put|review|send|share|upload)\b|\bleave (?:it|that|this) with me\b|\bwill do\b|\blet me\b|\bi can take that\b/.source}|${OWNER_ONGOING_WORK.source}`, 'i');
const OWNER_ACCEPTS = /^\s*(?:yes|yeah|yep|okay|ok|sure|will do|absolutely|of course|perfect|no problem)\b/i;
const OWNER_SELF_ASSIGNMENT = /\bme\s+to\s+[a-z]|\bthat(?:'d| would)\s+be\s+me\b/i;
function nameParts(value) {
  return String(value || '').toLowerCase().split(/[^a-zà-öø-ÿ']+/).filter((word) => word.length >= 3);
}

// An owner is supported when somebody else names them in the cited lines (or
// one either side), or when they speak there and commit or accept ("I'll ...",
// "we need to ...", "Okay."). A chair who merely asks or comments is not an
// owner: run 8 published two actions owned by the chair, and one owned by a
// person who was not at the meeting.
// Words for the act of meeting-work rather than its subject. Sharing one of
// these says nothing about *which* work a commitment is about.
const MEETING_WORK_WORDS = new Set([
  'the', 'and', 'for', 'are', 'was', 'not', 'but', 'all', 'any', 'out', 'its', 'our', 'you', 'who',
  'how', 'why', 'one', 'two', 'new', 'update', 'updates', 'updated', 'table', 'tables', 'minutes',
  'meeting', 'set', 'core', 'area', 'areas', 'thing', 'things', 'work', 'working', 'list', 'item',
  'items', 'document', 'documents', 'file', 'files', 'call', 'calls', 'date', 'dates', 'time',
  'week', 'weeks', 'month', 'next', 'some', 'need', 'needs', 'make', 'take', 'look', 'send',
  'give', 'kind', 'step', 'down', 'through', 'each', 'then', 'here', 'has', 'had', 'will',
  'should', 'well', 'back', 'good', 'okay', 'yeah', 'know', 'think', 'going', 'gonna', 'want',
  'done', 'doing', 'start', 'first', 'second', 'review', 'reviewing', 'confirm', 'confirming',
  'ensure', 'ensuring'
]);

function actionSubjectWords(value) {
  return contentTokens(value).filter((word) => !MEETING_WORK_WORDS.has(word));
}

function sharedSubjectWords(line, actionText) {
  const subject = new Set(actionSubjectWords(actionText));
  return new Set(contentTokens(line).filter((word) => subject.has(word))).size;
}

// Run 9 published "Update the risk table ... USB ports ..." under Jacqui Fox on
// the strength of "I'll update that table for the new set of minutes" - a
// different table, one line before "So Rebecca is kind of managing that through
// with Andrew." The only words shared were "update" and "table". So a
// first-person commitment counts only when it also shares the subject.
function commitmentIsAboutAction(line, actionText) {
  const subject = new Set(actionSubjectWords(actionText));
  if (!subject.size) return true;
  return contentTokens(line).some((word) => subject.has(word));
}

// Ways one speaker hands work to a named person, beyond "X to ..." and
// "X will ...": the present tense of a plan being read back ("Jenny writes the
// list, Bernard sends it"), work described as someone's ("his priority action",
// "Sam's job") and ongoing ownership ("Sam is doing that", "Sam has been working
// through it").
// Someone else describing work as already in a named person's hands: "Sam is
// doing that", "Rebecca is kind of managing that through with Andrew", "Sam has
// been working through it". Used both to support a named owner and, spoken
// about somebody else inside the cited exchange, as the positive evidence that
// the named owner is narrating another person's work.
function narratesOwnership(name, value) {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b(?:\\s+\\w+){0,2}\\s+(?:is|'s|’s|has\\s+been)\\s+(?:kind\\s+of\\s+|sort\\s+of\\s+|just\\s+|currently\\s+|still\\s+|now\\s+)?(?:doing|handling|managing|running|progressing|driving|coordinating|working\\s+(?:on|through)|looking\\s+(?:at|after|into)|dealing\\s+with|taking\\s+care\\s+of|sorting|picking\\s+(?:that|this|it)\\s+up|on\\s+(?:it|that|this)|tracing|reviewing|writing|drafting|preparing|chasing|leading)\\b`, 'i').test(String(value || ''));
}

function assignsWorkTo(name, value) {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const text = String(value || '');
  // "David and Colm can review the standard again": a modal handed to one or
  // two named people, with the verb that follows. "can't" does not match.
  const modalVerb = String.raw`(?:can|could|should|would|will|to|need\s+to|needs\s+to)\s+(?:just\s+|then\s+|also\s+|maybe\s+|both\s+)?(?:review|check|look|send|share|update|confirm|write|draft|prepare|book|chase|circulate|trace|order|arrange|cover|run|upload|sort|resolve|complete|finish|go|put|pull|follow|take|do|have|make|get|speak|talk|reach|test|set|add|create|document|schedule|contact|email|liaise|feed)\b`;
  return new RegExp(`\\b${escaped}\\b(?:\\s+\\w+){0,3}\\s+(?:to|will|shall|is\\s+(?:responsible\\s+)?to|is\\s+responsible\\s+for|owns?|leads?|takes?)\\b`, 'i').test(text)
    || new RegExp(String.raw`\b${escaped}\b(?:\s*(?:,|and|&)\s*[A-Za-zÀ-ÿ']+(?:\s+[A-Za-zÀ-ÿ']+)?){0,2}\s+${modalVerb}`, 'i').test(text)
    || narratesOwnership(name, text)
    || new RegExp(`\\b(?:assign(?:ed)?|leave|give|hand)\\b.{0,45}\\b${escaped}\\b`, 'i').test(text)
    || new RegExp(`\\b${escaped}(?:\\s+\\w+){0,2}\\s+(?:sends|writes|does|handles|drafts|prepares|books|checks|reviews|runs|updates|traces|orders|arranges|covers|chases|circulates|confirms|leads|owns)\\b`, 'i').test(text)
    || new RegExp(`\\b${escaped}(?:'s|’s)\\s+(?:\\w+\\s+){0,2}(?:priority|job|action|task|responsibility|area)\\b`, 'i').test(text)
    || new RegExp(`\\b${escaped}\\b\\s*,\\s*(?:\\w+\\s+){0,2}your\\s+(?:\\w+\\s+){0,2}(?:focus|priority|job|action|task|responsibility)\\b`, 'i').test(text)
    || new RegExp(`\\b${escaped}\\b.{0,50}?\\byou(?:'re|’re|\\s+are)\\s+(?:(?:just\\s+)?going\\s+to|involved|responsible|leading|doing|handling|on\\s+(?:it|that|this))\\b`, 'i').test(text)
    || new RegExp(`\\b${escaped}\\b(?:\\s+\\w+){0,2}\\s+(?:is|'s|’s|has\\s+been)\\s+(?:doing|handling|working\\s+(?:on|through)|looking\\s+(?:at|after)|on\\s+(?:it|that|this)|tracing|reviewing|writing|drafting|preparing|sorting|chasing|leading)\\b`, 'i').test(text);
}

// A turn addressed to someone by name that asks them to do something:
// "Sam, can you ...", "could you, Sam ...", "Sam, you're doing ...".
function addressedRequestTo(name, value) {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const text = String(value || '');
  const asks = String.raw`(?:(?:can|could|would|will)\s+you|you\s+(?:can|could)|you(?:'re|’re|\s+are)\s+(?:doing|on|taking|handling)|your\s+(?:job|action|task))`;
  return new RegExp(String.raw`\b${escaped}\b.{0,60}?\b${asks}\b`, 'i').test(text)
    || new RegExp(String.raw`\b${asks}\b.{0,40}?\b${escaped}\b`, 'i').test(text);
}

// Transcript rows arrive split into sentences, so a +-1 row window is usually
// one side of an exchange. Evidence for ownership is read over whole speaker
// turns instead: the cited turns plus `span` turns either side.
function turnWindowRows(rows = [], citedIndexes = [], span = 2) {
  const turnOf = [];
  let turn = 0;
  rows.forEach((row, index) => {
    if (index && row?.speaker !== rows[index - 1]?.speaker) turn += 1;
    turnOf[index] = turn;
  });
  const wanted = new Set();
  for (const index of citedIndexes) {
    const centre = turnOf[index];
    if (centre == null) continue;
    for (let t = centre - span; t <= centre + span; t += 1) wanted.add(t);
  }
  return rows.filter((row, index) => wanted.has(turnOf[index]));
}

// Anywhere in the meeting: a line that hands this work to this person, or the
// person's own commitment to it, sharing at least two subject words with the
// action. This finds recaps ("David's priority action for the rest of this week
// is tracing the 17 changes") outside the cited passage.
function ownerAssignedInMeeting(owner, actionText = '', units = []) {
  const names = nameParts(owner);
  const subject = new Set(actionSubjectWords(actionText));
  if (!names.length || subject.size < 2) return false;
  // Only a person who exists in this meeting, in full: "Stuart will ..." must
  // not validate an invented "Stuart Jones".
  const identities = [...speakerIdentities(units).map((person) => person.parts), ...mentionedPeople(units).map((name) => nameParts(name))];
  const knownIdentity = identities.some((parts) => names.every((part) => parts.includes(part)))
    // A single name ("Robin") only needs to be someone the meeting talks about.
    || (names.length === 1 && evidenceContextFor(units).rows.some((row) => new RegExp(`\\b${names[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(`${row?.speaker || ''} ${row?.text || ''}`)));
  if (!knownIdentity) return false;
  const rows = evidenceContextFor(units).rows;
  const shared = (value) => contentTokens(value).filter((word) => subject.has(word)).length;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const value = String(row?.text || '');
    const continuation = [value, rows[index + 1]?.text || ''];
    // A transcript can split an assignment around a short interjection:
    // "Morgan, your focus is to resolve those" / "Yes" / "create the pages".
    // Only bridge an unfinished assignment through acknowledgement-only turns
    // back to the same speaker. A substantive intervening reply ends the link.
    if (/\b(?:those|these|that|this|to|the|your|is|are|will|can|should|must)\s*[.!?]*$/i.test(value)) {
      const acknowledgement = /^(?:(?:yes|yeah|yep|okay|ok|right|sure|understood|mhm|mm)[\s.,!]+)*(?:yes|yeah|yep|okay|ok|right|sure|understood|mhm|mm)[\s.,!]*$/i;
      for (let next = index + 1; next <= index + 3 && next < rows.length; next += 1) {
        if (rows[next].speaker === row.speaker) {
          continuation.push(rows[next].text);
          break;
        }
        if (!acknowledgement.test(String(rows[next].text || '').trim())) break;
      }
    }
    const context = continuation.join(' ');
    const speaksAsOwner = nameParts(row?.speaker).some((part) => names.includes(part));
    if (speaksAsOwner && (OWNER_FIRST_PERSON.test(value) || OWNER_SELF_ASSIGNMENT.test(value))
      && shared([rows[index - 1]?.text || '', context].join(' ')) >= 2) return true;
    if (!speaksAsOwner && names.some((name) => assignsWorkTo(name, value)) && shared(context) >= 2) return true;
    if (!speaksAsOwner && names.some((name) => addressedRequestTo(name, value)) && shared(context) >= 2) {
      const reply = rows.slice(index + 1, index + 4).find((next) => nameParts(next?.speaker).some((part) => names.includes(part)));
      if (reply && (OWNER_ACCEPTS.test(String(reply.text || '')) || OWNER_FIRST_PERSON.test(String(reply.text || '')))) return true;
    }
  }
  return false;
}

// Inside the passage the action cites, a request addressed to someone by name
// ("David, is that something you can write up?") answered by that person
// without refusing ("It'll be Friday though") is an accepted request. The
// citation already ties the request to this action, so no subject match is
// needed; the preparer can also drop the bare "I can." between the two.
const OWNER_REFUSES = /\b(?:no|nope|can't|cannot|can not|won't|not me|not able|unable|don't think i can|i couldn't)\b/i;
function addressedRequestAccepted(owner, lines = []) {
  const names = nameParts(owner);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (nameParts(line?.speaker).some((part) => names.includes(part))) continue;
    if (!names.some((name) => addressedRequestTo(name, line?.text))) continue;
    const reply = lines.slice(index + 1, index + 3).find((next) => nameParts(next?.speaker).some((part) => names.includes(part)));
    if (reply && !OWNER_REFUSES.test(String(reply.text || ''))) return true;
  }
  return false;
}

// The chair asking someone else ("could you mention it to him?") is not the
// chair taking the work on. True when the named person speaks in the passage
// only to ask others, never committing themselves.
const OWNER_REQUESTS_OTHERS = /\b(?:can|could|would|will)\s+you\b|\byou(?:'d|’d|\s+would|\s+need|\s+should|'re|’re|\s+are)\b/i;
// Needing a completed document is still receiving work, not undertaking it.
// Keep "need to complete" distinct from "need the completed ...".
const OWNER_NEEDS_OBJECT = /\bi(?:['’]ll|['’]m\s+going\s+to|\s+(?:will|shall|can|could|would|might|may|am\s+going\s+to))?\s+(?:(?:also|just|really|still)\s+){0,2}(?:need|want|require)\s+(?!\s*to\b)/i;
function ownerOnlyAsksOthers(owner, lines = []) {
  const names = nameParts(owner);
  const own = lines.filter((line) => nameParts(line?.speaker).some((part) => names.includes(part)));
  if (!own.length) return false;
  return own.every((line) => OWNER_REQUESTS_OTHERS.test(String(line.text || ''))
    && !OWNER_FIRST_PERSON.test(String(line.text || '')) && !OWNER_SELF_ASSIGNMENT.test(String(line.text || '')));
}

// The named owner asks somebody else in the exchange ("could you just maybe
// mention it to him?") and that person accepts or commits within the next two
// lines: the work went to the person who answered. Returns that person.
function handedOffTo(owner, lines = [], people = []) {
  const names = nameParts(owner);
  const isOwner = (speaker) => nameParts(speaker).some((part) => names.includes(part));
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const value = String(line?.text || '');
    if (!isOwner(line?.speaker) || !OWNER_REQUESTS_OTHERS.test(value)) continue;
    if (OWNER_FIRST_PERSON.test(value) || OWNER_SELF_ASSIGNMENT.test(value)) continue;
    const reply = lines.slice(index + 1, index + 3).find((next) => next?.speaker && !isOwner(next.speaker)
      && (OWNER_ACCEPTS.test(String(next.text || '')) || OWNER_FIRST_PERSON.test(String(next.text || ''))));
    if (!reply || OWNER_REFUSES.test(String(reply.text || ''))) continue;
    const person = people.find((candidate) => nameParts(reply.speaker).some((part) => candidate.parts.includes(part)));
    if (person) return person;
  }
  return null;
}

function ownerTakesItOn(owner, lines = [], actionText = '', people = []) {
  const names = nameParts(owner);
  if (!names.length) return true;
  // Whether anyone else is in the frame. The subject test exists to stop a
  // commitment about other work ("I'll update that table for the new set of
  // minutes") claiming an action someone else was just given - in run 9's case
  // one line after "So Rebecca is kind of managing that through with Andrew."
  // Where no one else is named, there is no rival claim to guard against, and
  // demanding a subject match strips a plain commitment: run 10 removed Ciaran
  // Ryan from TFO3 work evidenced by three consecutive lines of his own.
  const contested = people.some((person) => !person.parts.some((part) => names.includes(part))
    && lines.some((line) => personIsNamedIn(person, line?.text)));
  const mentions = (value) => names.some((name) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(value));
  const assigned = (value) => names.some((name) => assignsWorkTo(name, value));
  const isOwner = (speaker) => nameParts(speaker).some((word) => names.includes(word));
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const value = String(line?.text || '');
    if (!isOwner(line?.speaker) && mentions(value) && assigned(value)) return true;
    if (!isOwner(line?.speaker)) continue;
    const firstPerson = OWNER_FIRST_PERSON.test(value) || OWNER_SELF_ASSIGNMENT.test(value);
    const accepts = OWNER_ACCEPTS.test(value);
    if (!firstPerson && !accepts) continue;
    // The preparer splits speech into sentences, so "That document, but I'm
    // gonna..." and "focus on TFO3 this week." arrive as two lines and the
    // subject sits in the second. Only an unfinished line runs on into the next
    // one: a line closing on a full stop is its own sentence, and borrowing the
    // subject from it let run 9's "I'll update that table for the new set of
    // minutes." take its subject from "The focus still remains on risk...".
    const runsOn = (row) => Boolean(row) && /(?:\.\.\.|[^.!?])\s*$/.test(String(row.text || ''));
    const sameSpeaker = (row) => Boolean(row) && isOwner(row.speaker);
    const utterance = [line];
    if (runsOn(line) && sameSpeaker(lines[index + 1])) utterance.push(lines[index + 1]);
    if (sameSpeaker(lines[index - 1]) && runsOn(lines[index - 1])) utterance.unshift(lines[index - 1]);
    // A bare "yes/okay" proves ownership only when it answers a nearby request
    // about this work. Previously any acknowledgement in a disconnected cited
    // line could make that speaker the owner of an unrelated action.
    if (accepts && !firstPerson) {
      const requestContext = [lines[index - 2], lines[index - 1]].filter(Boolean)
        .map((row) => String(row.text || '')).join(' ');
      if (!names.some((name) => addressedRequestTo(name, requestContext))
        || !commitmentIsAboutAction(requestContext, actionText)) continue;
      return true;
    }
    if (!contested) return true;
    if (commitmentIsAboutAction(utterance.map((row) => String(row.text || '')).join(' '), actionText)) return true;
  }
  return false;
}

function applyRequesterOwnerRule(actions = [], units = []) {
  const context = evidenceContextFor(units);
  // A rival claimant need not be someone who spoke: work is regularly given to
  // a Louise or a Kevin who is only talked about.
  const people = [...speakerIdentities(units),
    ...mentionedPeople(units).map((name) => ({ label: name, parts: nameParts(name) }))]
    .filter((person, index, all) => person.parts.length
      && all.findIndex((other) => other.parts.join(' ') === person.parts.join(' ')) === index);
  const rows = context.rows;
  const flags = [];
  const checked = (Array.isArray(actions) ? actions : []).map((action) => {
    if (isReviewerAuthored(action)) return action;
    const owners = Array.isArray(action?.owners) ? action.owners : [];
    if (!owners.length) return action;
    const cited = [...new Set(action.evidenceIds || [])].map((id) => context.indexById.get(id)).filter(Number.isInteger);
    if (!cited.length) return action;
    const window = turnWindowRows(rows, cited, 2);
    const unsupported = owners.filter((owner) => !ownerTakesItOn(owner, window, action?.action, people)
      && !addressedRequestAccepted(owner, window)
      && !ownerAssignedInMeeting(owner, action?.action, units));
    if (!unsupported.length) return action;
    // Only positive evidence removes a named owner: somebody else is shown
    // taking this work on, or the named person only asked others to do it.
    // Absence of proof is not proof of absence - a plain "I'd rather ask
    // them" or a chair's read-back can sit outside any window we choose.
    // Counter-evidence must come from the same exchange: someone committing to
    // other work elsewhere in the meeting says nothing about this action.
    // Only the rival's own first-person commitment counts, in a line that is
    // itself about this work. A chair reading the actions back ("Rebecca,
    // you're going to update the risk files") or asking someone to do it is
    // describing the work, not taking it on.
    const rival = people.find((person) => !owners.some((owner) => nameParts(owner).some((part) => person.parts.includes(part)))
      && window.some((line) => {
        const value = String(line?.text || '');
        // "I'll circulate it with you, Andrew, to review" hands the next step
        // to the named owner; it is not the speaker taking that step over.
        const namesOwner = owners.some((owner) => personIsNamedIn({ parts: nameParts(owner) }, value));
        return nameParts(line?.speaker).some((part) => person.parts.includes(part))
          && (OWNER_FIRST_PERSON.test(value) || OWNER_SELF_ASSIGNMENT.test(value))
          && !OWNER_REQUESTS_OTHERS.test(value)
          && !OWNER_NEEDS_OBJECT.test(value)
          && !namesOwner
          && actionPredicateSupported(action?.action, value)
          && sharedSubjectWords(value, action?.action) >= 2;
      }));
    // Two more positive signs that the work sits with somebody else, both from
    // the cited exchange itself: a line placing it in another person's hands
    // ("So Rebecca is kind of managing that through with Andrew"), or the named
    // owner asking someone who then accepts ("could you just maybe mention it
    // to him?" / "Yes, I can do that.").
    // Read within two rows of a cited line, not across a whole long turn: a
    // chair's round-up names many people's work in one breath, and "Andrew is
    // working on that as well" fifteen rows on says nothing about this action.
    const nearCited = [...new Set(cited.flatMap((index) => [index - 2, index - 1, index, index + 1, index + 2]))]
      .map((index) => rows[index]).filter(Boolean);
    const narratedRival = rival ? null : people.find((person) => !owners.some((owner) => nameParts(owner).some((part) => person.parts.includes(part)))
      && nearCited.some((line) => narratesOwnership(person.label, line?.text)
        || person.parts.some((part) => part.length >= 4 && narratesOwnership(part, line?.text))));
    const handedOff = rival || narratedRival ? null : owners.map((owner) => handedOffTo(owner, window, people)).find(Boolean);
    const shownElsewhere = rival || narratedRival || handedOff || null;
    // Being in the cited exchange without a parsed commitment is not evidence
    // against a named owner. Four traced runs on 2026-09-27 removed ten owners
    // on that ground and every one was wrong: people mid-task ("I've added five
    // of those languages"), a plan spoken as "we'll schedule a call", a
    // chair's "David and Colm can review the standard again". Without positive
    // counter-evidence the name stays and the reviewer is asked to confirm it.
    const removed = unsupported.filter((owner) => shownElsewhere || ownerOnlyAsksOthers(owner, window));
    const unverified = unsupported.filter((owner) => !removed.includes(owner));
    const actionFlags = [];
    if (removed.length) {
      actionFlags.push(normaliseFlag({
        kind: 'ownership',
        message: shownElsewhere
          ? `Owner changed for review: the transcript shows ${shownElsewhere.label} taking this on, not ${removed.join(' or ')}. Confirm the owner.`
          : `Owner unclear: the cited evidence does not show ${removed.join(' or ')} taking this on, so it was removed. Add the person who is doing it.`,
        evidenceIds: action.evidenceIds || []
      }, flags.length + actionFlags.length));
    }
    if (unverified.length) {
      actionFlags.push(normaliseFlag({
        kind: 'ownership',
        message: `Owner to confirm: the cited lines do not clearly show ${unverified.join(' or ')} taking this on. Check the name.`,
        evidenceIds: action.evidenceIds || []
      }, flags.length + actionFlags.length));
    }
    flags.push(...actionFlags);
    return {
      ...action,
      owners: owners.filter((owner) => !removed.includes(owner)),
      reviewFlagIds: [...new Set([...(action.reviewFlagIds || []), ...actionFlags.map((flag) => flag.id)])]
    };
  });
  return { actions: checked, flags };
}

// ---- A named person must be in the row's own evidence -----------------------
// The minutes are read a row at a time, so a row reading "Rebecca has reviewed
// David's feedback" while citing only the line in which *David* does the
// reviewing tells the reader the opposite of what was said. Where a
// neighbouring line supplies the person the model cited one line short, so that
// line joins the citation. Where nothing supplies them, the wording is left
// alone and the row carries a flag: which name is right is the reviewer's call,
// not ours to guess.
const ATTRIBUTION_WINDOW = 2;
const ATTRIBUTION_SHARED_WORDS = 2;

function speakerIdentities(units = []) {
  return [...new Set(evidenceContextFor(units).rows.map((row) => row.speaker).filter(Boolean))]
    .map((label) => ({ label, parts: nameParts(label) }))
    .filter((person) => person.parts.length);
}

function personIsNamedIn(person, ...values) {
  const words = new Set(values.flatMap((value) => nameParts(value)));
  return person.parts.some((part) => words.has(part));
}

function groundRowAttributions(discussion = [], units = []) {
  const context = evidenceContextFor(units);
  const rows = context.rows;
  const people = speakerIdentities(units);
  const flags = [];
  let widened = 0;
  if (!people.length || !rows.length) return { discussion, widened, flags };

  const unsupported = (named, indexes) => {
    const words = new Set(indexes.flatMap((index) => [
      ...nameParts(rows[index]?.speaker), ...nameParts(rows[index]?.text)
    ]));
    return named.filter((person) => !person.parts.some((part) => words.has(part)));
  };

  const check = (record) => {
    const cited = [...new Set(record?.evidenceIds || [])]
      .map((id) => context.indexById.get(id)).filter(Number.isInteger);
    if (!cited.length) return record;
    const named = people.filter((person) => personIsNamedIn(person, record?.text));
    if (!named.length) return record;
    let missing = unsupported(named, cited);
    if (!missing.length) return record;

    // The line that names them usually sits a turn or two from what was cited.
    const rowWords = new Set(contentTokens(record?.text));
    const neighbours = [...new Set(cited.flatMap((index) => Array.from(
      { length: ATTRIBUTION_WINDOW * 2 + 1 }, (ignored, step) => index - ATTRIBUTION_WINDOW + step)))]
      .filter((index) => index >= 0 && index < rows.length && !cited.includes(index))
      .sort((a, b) => a - b);
    const added = [];
    for (const person of missing) {
      const source = neighbours.find((index) => personIsNamedIn(person, rows[index]?.text, rows[index]?.speaker)
        && contentTokens(rows[index]?.text).filter((word) => rowWords.has(word)).length >= ATTRIBUTION_SHARED_WORDS);
      if (Number.isInteger(source)) added.push(source);
    }
    let evidenceIds = [...new Set(record.evidenceIds || [])];
    if (added.length) {
      evidenceIds = [...new Set([...evidenceIds, ...added.map((index) => rows[index].id)])];
      widened += 1;
      missing = unsupported(named, [...new Set([...cited, ...added])]);
    }
    if (!missing.length) return { ...record, evidenceIds };
    const flag = normaliseFlag({
      kind: 'attribution',
      message: `Check who did this: the quoted evidence does not mention ${missing.map((person) => person.label).join(' or ')}. Confirm the name or reword the line.`,
      evidenceIds
    }, flags.length);
    flags.push(flag);
    return { ...record, evidenceIds, reviewFlagIds: [...new Set([...(record.reviewFlagIds || []), flag.id])] };
  };

  const checked = (Array.isArray(discussion) ? discussion : []).map((topic) => ({
    ...topic,
    points: (topic.points || []).map(check),
    decisions: (topic.decisions || []).map(check)
  }));
  return { discussion: checked, widened, flags };
}

// ---- Conflicting exclusive role assignments -------------------------------
// Discovery passes can each produce a locally plausible role statement while
// disagreeing about its holder. "A is the lead" and "B is the lead" are
// contradictory facts, not duplicates. Detect only explicit, singular role
// assignments in the same finished topic. ASR punctuation can make the source
// genuinely ambiguous, so this guard warns the reviewer and never guesses a
// winner or rewrites their wording.
const EXCLUSIVE_ROLE_QUALIFIER = '(?:audit|project|technical|software|design|workstream|meeting|team)';
const EXCLUSIVE_ROLE_NOUN = '(?:lead(?:\\s+auditor)?|chair(?:person)?|primary\\s+owner|overall\\s+owner|coordinator)';
const EXCLUSIVE_ROLE_PATTERN = new RegExp(`\\b(?:(?<qualifier>${EXCLUSIVE_ROLE_QUALIFIER})\\s+)?(?<role>${EXCLUSIVE_ROLE_NOUN})\\b`, 'i');
const NON_EXCLUSIVE_ROLE_PATTERN = /\b(?:co|joint|deputy|assistant)[ -](?:lead|chair|owner|coordinator)\b/i;
const HISTORICAL_ROLE_TRANSITION = /\b(?:previously|formerly|prior|last\s+(?:week|month|year|phase)|first\s+phase|until|before\s+the\s+handover|replaced\s+by|handed\s+over\s+to)\b/i;
const TOPIC_ROLE_QUALIFIER = /\b(audit|project|technical|software|design|workstream|meeting|team)\b/i;

function exclusiveRoleKey(roleMatch, topic = '') {
  const rawRole = String(roleMatch?.groups?.role || '').toLowerCase().replace(/\s+/g, ' ');
  const role = /chair/.test(rawRole) ? 'chair'
    : /owner/.test(rawRole) ? 'owner'
      : /coordinator/.test(rawRole) ? 'coordinator' : 'lead';
  let qualifier = String(roleMatch?.groups?.qualifier || '').toLowerCase();
  if (!qualifier && /lead auditor/.test(rawRole)) qualifier = 'audit';
  if (!qualifier) qualifier = String(topic).match(TOPIC_ROLE_QUALIFIER)?.[1]?.toLowerCase() || 'general';
  return `${qualifier}:${role}`;
}

function explicitExclusiveRoleAssignments(record = {}, topic = {}, people = []) {
  if (record?.reviewerAuthored === true || topic?.reviewerAuthored === true) return [];
  const value = text(record?.text, 1600);
  if (!value) return [];
  const clauses = value.split(/[.;!?]+|\s*,\s*(?=(?:with|while|whereas|and|but|working)\b)/i)
    .map((clause) => clause.trim()).filter(Boolean);
  const assignments = [];
  for (const clause of clauses) {
    if (NON_EXCLUSIVE_ROLE_PATTERN.test(clause) || HISTORICAL_ROLE_TRANSITION.test(clause)) continue;
    const roleMatch = clause.match(EXCLUSIVE_ROLE_PATTERN);
    if (!roleMatch) continue;
    // "a lead" is not exclusive. A qualified role or "the lead" is.
    const roleText = roleMatch[0];
    const nearbyRole = clause.slice(Math.max(0, roleMatch.index - 8), roleMatch.index + roleText.length);
    const definite = /\bthe\s+/i.test(nearbyRole) || Boolean(roleMatch.groups?.qualifier)
      || /lead\s+auditor|primary\s+owner|overall\s+owner/i.test(roleText);
    if (!definite) continue;
    const named = people.filter((person) => personIsNamedIn(person, clause));
    if (named.length !== 1) continue;
    const roleBeforePerson = new RegExp(`${EXCLUSIVE_ROLE_NOUN}[^,.]{0,60}\\b(?:is|was|will\\s+be|has\\s+been|identified\\s+as|named\\s+as|appointed\\s+as)\\b`, 'i').test(clause);
    const personBeforeRole = new RegExp(`\\b(?:is|was|will\\s+be|has\\s+been|serves?\\s+as|acts?\\s+as|identified\\s+as|named\\s+as|appointed\\s+as)\\b[^,.]{0,60}${EXCLUSIVE_ROLE_NOUN}`, 'i').test(clause);
    const leading = /\bleading\b(?!\s+to\b)/i.test(clause);
    if (!roleBeforePerson && !personBeforeRole && !leading) continue;
    assignments.push({
      roleKey: exclusiveRoleKey(roleMatch, topic?.topic),
      personKey: named[0].parts.join('|'),
      personLabel: canonicalSpeakerDisplayName(named[0].label),
      evidenceIds: [...new Set(record?.evidenceIds || [])]
    });
  }
  return assignments;
}

function flagConflictingDiscussionRoles(discussion = [], units = []) {
  const people = speakerIdentities(units);
  const cloned = (Array.isArray(discussion) ? discussion : []).map((topic) => ({
    ...topic,
    points: (topic?.points || []).map((record) => ({ ...record })),
    decisions: (topic?.decisions || []).map((record) => ({ ...record })),
    openQuestions: (topic?.openQuestions || []).map((record) => ({ ...record }))
  }));
  const flags = [];
  const conflicts = [];
  if (people.length < 2) return { discussion: cloned, flags, conflicts };

  cloned.forEach((topic, topicIndex) => {
    const assignments = [];
    for (const kind of ['points', 'decisions']) {
      (topic?.[kind] || []).forEach((record, rowIndex) => {
        for (const assignment of explicitExclusiveRoleAssignments(record, topic, people)) {
          assignments.push({ ...assignment, kind, rowIndex, record });
        }
      });
    }
    const byRole = new Map();
    for (const assignment of assignments) {
      if (!byRole.has(assignment.roleKey)) byRole.set(assignment.roleKey, []);
      byRole.get(assignment.roleKey).push(assignment);
    }
    for (const [roleKey, roleAssignments] of byRole) {
      const peopleByKey = new Map(roleAssignments.map((assignment) => [assignment.personKey, assignment.personLabel]));
      if (peopleByKey.size < 2) continue;
      const roleLabel = roleKey.split(':').join(' ');
      const personLabels = [...peopleByKey.values()].sort((left, right) => left.localeCompare(right));
      const evidenceIds = [...new Set(roleAssignments.flatMap((assignment) => assignment.evidenceIds))].slice(0, 8);
      const flag = normaliseFlag({
        kind: 'uncertain_fact',
        message: `Conflicting role assignment: this discussion assigns the same ${roleLabel} role to ${personLabels.join(' and ')}. Confirm the correct role holder against the linked transcript before publishing.`,
        evidenceIds
      }, topicIndex);
      flags.push(flag);
      for (const assignment of roleAssignments) {
        assignment.record.reviewFlagIds = [...new Set([...(assignment.record.reviewFlagIds || []), flag.id])];
      }
      conflicts.push({
        topicIndex, role: roleKey, people: personLabels,
        recordIds: [...new Set(roleAssignments.map((assignment) => text(assignment.record?.id, 80)).filter(Boolean))]
      });
    }
  });
  return { discussion: cloned, flags, conflicts };
}

function speakerIsOwner(speaker, owners = []) {
  const words = (value) => String(value || '').toLowerCase().replace(/[^\p{L}\p{N}\s'’-]/gu, ' ').split(/\s+/).filter(Boolean);
  const speakerWords = words(speaker);
  if (!speakerWords.length) return false;
  return owners.some((owner) => {
    const ownerWords = words(owner);
    if (!ownerWords.length) return false;
    if (ownerWords.join(' ') === speakerWords.join(' ')) return true;
    // "Dan" for "Dan Threlfall", either way round, but never a surname alone.
    return (ownerWords.length === 1 && ownerWords[0] === speakerWords[0])
      || (speakerWords.length === 1 && speakerWords[0] === ownerWords[0]);
  });
}

function splitOwners(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(/\s*(?:,|&|\band\b)\s*/i);
  return [...new Set(source.map((owner) => text(owner, 180)).filter((owner) => owner && !/^not stated$/i.test(owner)))].slice(0, 12);
}

function ownerIdentityTokens(value) {
  const titles = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'professor']);
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .match(/[a-z0-9]+/g)?.filter((token) => token.length > 1 && !titles.has(token)) || [];
}

function ownerIdentityKey(value) {
  return [...new Set(ownerIdentityTokens(value))].sort().join('|');
}

function normaliseOwnerIdentity(owner, units = []) {
  const raw = text(owner, 180);
  const ownerWords = ownerIdentityTokens(raw);
  if (!ownerWords.length) return raw;
  const speakers = evidenceContextFor(units).speakers;
  const exactKey = ownerIdentityKey(raw);
  let matches = speakers.filter((speaker) => ownerIdentityKey(speaker) === exactKey);
  if (!matches.length && ownerWords.length === 1) {
    matches = speakers.filter((speaker) => ownerIdentityTokens(speaker).includes(ownerWords[0]));
  }
  // Teams may alternate between "Surname, Given Initial" and "Given Surname"
  // for the same participant. Count canonical identities rather than raw labels,
  // while still refusing to expand an ambiguous first name.
  const identities = new Map();
  for (const speaker of matches) {
    const key = ownerIdentityKey(speaker);
    if (!identities.has(key)) identities.set(key, []);
    identities.get(key).push(speaker);
  }
  if (identities.size !== 1) return raw;
  const aliases = [...identities.values()][0];
  const displays = aliases.map(canonicalSpeakerDisplayName);
  // Prefer an already human-readable source label, then the deterministic
  // inversion of Teams' comma form. Either way every pass gets one spelling.
  return displays.find((name, index) => !aliases[index].includes(',')) || displays[0] || raw;
}

function ownerSupportedByEvidence(owner, evidenceText, units = []) {
  const ownerWords = contentTokens(owner);
  const evidenceWords = contentTokens(evidenceText);
  if (!ownerWords.length) return false;
  if (ownerWords.every((word) => evidenceWords.includes(word))) return true;
  // Meeting speech commonly assigns work using a first name while the agent
  // returns the person's full speaker name. Accept that expansion only when the
  // complete identity is independently present in a transcript speaker label.
  // This does not let an invented surname pass: every owner token must belong to
  // the same known speaker, and the cited evidence must still name that person.
  const knownSpeaker = evidenceContextFor(units).speakerTokens.some((speakerWords) => {
    return ownerWords.every((word) => speakerWords.includes(word));
  });
  return knownSpeaker && ownerWords.some((word) => evidenceWords.includes(word));
}

module.exports = {
  OWNER_FIRST_PERSON,
  MEETING_WORK_WORDS,
  canonicalSpeakerDisplayName,
  speakerIsOwner,
  mentionedPeople,
  nameParts,
  actionSubjectWords,
  sharedSubjectWords,
  commitmentIsAboutAction,
  narratesOwnership,
  assignsWorkTo,
  addressedRequestTo,
  turnWindowRows,
  ownerAssignedInMeeting,
  addressedRequestAccepted,
  ownerTakesItOn,
  applyRequesterOwnerRule,
  groundRowAttributions,
  flagConflictingDiscussionRoles,
  normaliseOwnerIdentity,
  ownerIdentityKey,
  ownerIdentityTokens,
  ownerSupportedByEvidence,
  splitOwners
};
