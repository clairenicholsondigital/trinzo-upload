'use strict';

// Whether a line of generated text reads as English somebody would write.
//
// The pipeline had four quality bars for four surfaces and they did not share. The
// strongest - finaliseDiscussionPointForMinutes - applied to discussion points only;
// actions had a separate, action-shaped gate that shared exactly one predicate with it and
// had never seen a voice check, a completeness check or an ending check. A reviewer listed
// forty examples of broken wording and asked for one thing: "not expecting the exact
// wording each and every time, just not broken wording".
//
// This module is the shared half. Every rule here is grammatical: it names no meetings, no
// domains and no phrases, because a rule made of phrases has to be extended once per
// transcript and these transcripts are all different. The register to keep is the one in
// topicEditorial's coordination rule - "it knows nothing about allotments or audits, and it
// is why it can be trusted on a transcript nobody has seen".
//
// It deliberately returns a findings list rather than a boolean. Four surfaces need four
// policies over the same detectors: an unresolved "that" is fatal to an action nobody can
// act on, while a first-person aside is merely untidy and the reviewer fixes it in two
// seconds. A boolean forces one policy, which is how you end up either rejecting real
// actions or publishing broken ones. Severity is the axis that decision turns on:
//
//   mechanical   redundancy or orthographic noise; meaning survives deletion
//   voice        first or second person; meaning intact, register wrong
//   referential  points at something outside the record; meaning not recoverable
//   truncation   stops mid-constituent; not a claim at all
//
// It is dependency-free on purpose, so topicEditorial, stagedEditorial and the summary
// path can all use one implementation without inverting the dependency graph.

const clean = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();

// A speaker re-entering the constituent they abandoned: "from the, from the place on Mill
// Road". The existing single-token rules elsewhere in the codebase are the n=1 case of this
// same shape; this is the n>=2 case, which nothing detected. Deliberately anchored on
// lowercase words so a repeated proper noun across a clause boundary is not swept up.
const PHRASE_RESTART = /\b([a-z][a-z'’]*(?:\s+[a-z][a-z'’]*){1,3})\s*,?\s+\1\b/i;

// "There is another person is also staying in the hotel." Existential there-insertion
// followed by a second finite copula has no grammatical reading, which is what makes this
// safe rather than merely rare. Anything that licenses the second verb - a complementiser,
// a relative, a coordinator - means it is a normal sentence: "There is a risk that the
// chiller fails", "There are three items that are still outstanding".
const CLAUSE_LICENSER = '(?:that|which|who|whom|whose|when|where|why|how|if|whether|because|although|though|while|whilst|unless|until|since|and|or|but|than|as|what)';
const EXISTENTIAL_STACKED_VERB = new RegExp(
  `\\bthere\\s+(?:is|are|was|were|'s)\\b(?:(?!\\b${CLAUSE_LICENSER}\\b)[^,.;:!?])*?\\b(?:is|are|was|were)\\b`,
  'i'
);

// A degree pre-modifier is defined by needing something to its right, so a sentence ending
// on one was cut. This is a closed function-word class, exactly like the conjunction and
// preposition classes already used for incomplete endings.
//
// It is NOT "ends in an adverb". That rejects "properly", "annually", "immediately",
// "separately" - and "Write to the council again, properly this time" is the reviewer's own
// text. Every open-class adverb stays legal, as do "too", "so", "quite", "only", "even"
// ("break even" occurs in the corpus) and the comparatives.
const TRUNCATED_PREMODIFIER = /\b(?:very|nearly|almost|hardly|scarcely|barely|merely|extremely|such)\s*[.!?]?$/i;

// First or second person, with the escape the discussion chain already uses: a sentence
// that names a minutes subject has completed its conversion even if a pronoun survives.
const FIRST_OR_SECOND_PERSON = /\b(?:I|I'm|I’m|I've|I’ve|I'll|I’ll|I'd|I’d|me|my|mine|myself|we|we're|we’re|we've|we’ve|we'll|we’ll|we'd|we’d|us|our|ours|you|you're|you’re|you've|you’ve|your|yours|let's|let’s)\b/i;

// "Bring that to the US team" is not first person. An all-capitals token is an initialism -
// US, WE (an org), OUR - and matching it case-insensitively turns every American subsidiary
// into a pronoun. Sentence-initial capitals still count, because "We agreed..." is exactly
// what this is for.
function firstOrSecondPerson(text) {
  const match = clean(text).match(FIRST_OR_SECOND_PERSON);
  if (!match) return false;
  for (const token of clean(text).split(/\s+/)) {
    const bare = token.replace(/[^A-Za-z'’]/g, '');
    if (!bare || !FIRST_OR_SECOND_PERSON.test(bare)) continue;
    if (bare.length > 1 && bare === bare.toUpperCase() && bare !== 'I') continue;
    return true;
  }
  return false;
}

// A deictic points at something in the room. A published minute has no room, so a
// demonstrative with no antecedent inside the record leaves the reader unable to act:
// "Find that little clock top right", "Flick this over to Orla", "Bring that to the US team".
//
// Two things must survive. Complementiser "that" - "Confirm that the invoice was paid" - is
// not a demonstrative at all. And a demonstrative modifying a temporal noun is fully
// resolved by the meeting's own date: "Send the floor plan this afternoon".
const COMPLEMENTISER_AFTER_THAT = /^(?:the|a|an|it|he|she|they|we|i|you|this|these|those|there|its|his|her|their|our|your|no|any|some|all|each|every)$/i;
const TEMPORAL_NOUN = /^(?:morning|afternoon|evening|night|week|weekend|fortnight|month|year|quarter|time|times|day|days|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|session|meeting|phase|stage|round|end|point|stand-up|standup|sprint|cycle|period|term|summer|autumn|winter|spring)$/i;

function unresolvedDeixis(text) {
  const words = clean(text).split(/\s+/);
  for (let index = 0; index < words.length; index += 1) {
    const bare = words[index].replace(/[^A-Za-z'’-]/g, '');
    if (!/^(?:that|this|these|those)$/i.test(bare)) continue;
    const next = (words[index + 1] || '').replace(/[^A-Za-z'’-]/g, '');
    // "Confirm that the invoice was paid", "three items that are still outstanding", "the
    // plan is that testing is complete" - a clause follows, not a thing. A finite verb close
    // behind is what distinguishes the complementiser and the relative from the demonstrative:
    // "that little clock top right" never reaches one.
    if (/^that$/i.test(bare)) {
      if (COMPLEMENTISER_AFTER_THAT.test(next)) continue;
      const lookahead = words.slice(index + 1, index + 4).map((word) => word.replace(/[^A-Za-z'’-]/g, ''));
      if (lookahead.some((word) => FINITE_VERB.test(word))) continue;
    }
    // "this afternoon", "that quarter" - the meeting's own date resolves it.
    if (TEMPORAL_NOUN.test(next)) continue;
    // "those attending", "these outstanding items" - scan past adjectives to the head noun.
    let head = next;
    let ahead = index + 2;
    while (head && /(?:ing|ed|ly|al|ic|ive|ous|able|ible)$/i.test(head) && ahead < words.length) {
      head = (words[ahead] || '').replace(/[^A-Za-z'’-]/g, '');
      ahead += 1;
    }
    if (TEMPORAL_NOUN.test(head)) continue;
    return true;
  }
  return false;
}

// A definition that defines nothing, and an adjunct that adds nothing. Both are decided by
// comparing the sentence with itself - set containment over its own content tokens - so
// neither carries a vocabulary of its own.
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'for', 'in', 'on', 'at', 'by', 'with', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'that', 'this', 'these', 'those', 'from', 'into', 'their', 'our', 'your']);
const stem = (token) => token.toLowerCase().replace(/(?:ing|ed|es|s)$/, '');
const contentSet = (value) => new Set(
  (clean(value).toLowerCase().replace(/\([^)]*\)/g, ' ').match(/[a-z][a-z0-9'’-]{2,}/g) || [])
    .filter((token) => !STOP.has(token))
    .map(stem)
);

const DEFINITION = /^(.+?)\s+(?:is|are|was|were)\s+(?:defined|described|understood|known|referred to)\s+as\s+(.+)$/i;
const MEANS = /^(.+?)\s+(?:means|refers to)\s+(.+)$/i;
const EMPTY_ADJUNCT = /^(.+?)[,\s]+(?:whilst|while|when|by|through|via|after|before)\s+([a-z][a-z'’]*ing\b.+)$/i;
const FINITE_VERB = /\b(?:is|are|was|were|has|have|had|will|would|can|could|should|must|does|did|do)\b/i;

function tautology(text) {
  const body = clean(text).replace(/[.!?]+$/, '');
  for (const pattern of [DEFINITION, MEANS]) {
    const match = body.match(pattern);
    if (!match) continue;
    const left = contentSet(match[1]);
    const right = contentSet(match[2]);
    if (right.size >= 2 && [...right].every((token) => left.has(token))) return 'tautology';
  }
  const adjunct = body.match(EMPTY_ADJUNCT);
  if (adjunct && !FINITE_VERB.test(adjunct[2])) {
    // "Send the report once the report is signed" keeps its finite verb and is a real
    // clause; this is only the participial adjunct that restates the main one.
    const main = contentSet(adjunct[1]);
    // The adjunct's own participle is not content it contributes - "whilst looking at the
    // risk" adds nothing to "Review the risk analysis" but the word "looking".
    const tail = contentSet(adjunct[2].replace(/^[a-z][a-z'’]*ing\b/i, ''));
    if (tail.size >= 1 && [...tail].every((token) => main.has(token))) return 'empty_adjunct';
  }
  return '';
}

// The same person named twice in one sentence. This fault is manufactured by our own code:
// the pipeline substitutes a speaker's name for "I", and does it more than once in the same
// breath - "Stuart Smith knows when Stuart Smith was there last time". Keyed on the meeting's
// own roster so it is about people rather than about repeated strings, which keeps "Send the
// Abbott report to Abbott" out of scope.
function repeatedPersonName(text, people) {
  const body = clean(text);
  for (const person of Array.isArray(people) ? people : []) {
    const name = clean(person);
    if (name.split(/\s+/).length < 2) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const sentence of body.split(/(?<=[.!?])\s+/)) {
      if ((sentence.match(new RegExp(`\\b${escaped}\\b`, 'gi')) || []).length > 1) return name;
    }
  }
  return '';
}

function minutesEnglishFaults(value, options = {}) {
  const text = clean(value);
  const faults = [];
  if (!text) return faults;
  if (PHRASE_RESTART.test(text)) faults.push({ code: 'phrase_restart', severity: 'mechanical', repairable: true });
  const repeated = repeatedPersonName(text, options.people);
  if (repeated) faults.push({ code: 'repeated_person_name', severity: 'mechanical', repairable: true, name: repeated });
  const empty = tautology(text);
  if (empty) faults.push({ code: empty, severity: 'mechanical', repairable: empty === 'empty_adjunct' });
  if (EXISTENTIAL_STACKED_VERB.test(text)) faults.push({ code: 'existential_stacked_verb', severity: 'truncation', repairable: false });
  if (TRUNCATED_PREMODIFIER.test(text)) faults.push({ code: 'truncated_premodifier', severity: 'truncation', repairable: false });
  if (firstOrSecondPerson(text)) faults.push({ code: 'first_or_second_person', severity: 'voice', repairable: false });
  if (unresolvedDeixis(text)) faults.push({ code: 'unresolved_deixis', severity: 'referential', repairable: false });
  return faults;
}

// Deletions and normalisations only. Every repair here removes redundancy or restores a
// separator; none of them can change what the sentence claims.
function repairMechanicalFaults(value, options = {}) {
  let text = clean(value);
  const applied = [];
  if (PHRASE_RESTART.test(text)) {
    text = clean(text.replace(new RegExp(PHRASE_RESTART.source, 'gi'), '$1'));
    applied.push('phrase_restart');
  }
  // "Karen.and" - a full stop doing duty as a word boundary.
  if (/[a-z]\.[a-z]/.test(text)) {
    text = text.replace(/([a-z])\.([a-z])/g, '$1. $2');
    applied.push('missing_space');
  }
  const repeated = repeatedPersonName(text, options.people);
  if (repeated) {
    const surname = repeated.split(/\s+/).slice(-1)[0];
    const escaped = repeated.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let seen = 0;
    text = text.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), () => (seen++ === 0 ? repeated : surname));
    applied.push('repeated_person_name');
  }
  return { text: clean(text), applied };
}

module.exports = {
  minutesEnglishFaults,
  repairMechanicalFaults,
  unresolvedDeixis,
  tautology,
  repeatedPersonName,
  PHRASE_RESTART,
  EXISTENTIAL_STACKED_VERB,
  TRUNCATED_PREMODIFIER,
  FIRST_OR_SECOND_PERSON
};
