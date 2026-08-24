'use strict';

const {
  fallbackMinutesReadySummary,
  transcriptShapedSummaryIssue,
  validateGrammarRevision
} = require('./stagedExecutiveSummaryGrammar');
const { packEntryIds, packCitedText, evidenceEntriesFor } = require('./canonicalMinutes/evidenceCitations');
const { canHeadlineTopic } = require('./canonicalMinutes/publishability');
const { isPublishableTopicLabel, labelNamesAWorkstream } = require('./canonicalMinutes/topicEditorial');

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function cleanLines(value, limit = 8) {
  return (Array.isArray(value) ? value : [])
    .map(clean)
    .filter(Boolean)
    .filter((item, index, all) => all.findIndex((other) => other.toLowerCase() === item.toLowerCase()) === index)
    .slice(0, limit);
}

// Objectives can express the same workstream with different editorial verbs
// (for example, "Clarify X and related next steps" and "Review X").  Exact
// string de-duplication cannot spot that.  Keep this deliberately lexical and
// conservative: it removes only the standard objective framing that Trinzo
// itself adds, then compares the remaining workstream wording.
function objectiveSemanticKey(value) {
  return clean(value)
    .toLowerCase()
    .replace(/^(?:(?:review|clarify|confirm|coordinate|align|discuss|identify|agree)(?:\s+and\s+)?)+\s+/i, '')
    .replace(/\s+and\s+(?:the\s+)?related\s+next\s+steps\.?$/i, '')
    .replace(/\s+and\s+next\s+steps\.?$/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function dedupeObjectives(value, limit = 8) {
  const seen = new Set();
  return cleanLines(value, Math.max(limit * 2, 8)).filter((item) => {
    const key = objectiveSemanticKey(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, limit);
}

function protectedFacts(value) {
  return new Set([
    ...(clean(value).match(/\b\d+(?:[.,:]\d+)*(?:%|st|nd|rd|th)?\b/g) || []),
    ...(clean(value).match(/\b[A-Z][A-Z0-9&/-]{1,}\b/g) || []),
    ...(clean(value).match(/\b[A-Z][a-z'’-]+(?:\s+[A-Z][a-z'’-]+)+\b/g) || [])
  ].map((item) => item.toLowerCase()));
}

const EDITORIAL_WORDS = new Set([
  'agree', 'agreed', 'align', 'clarify', 'confirm', 'coordinate', 'discuss', 'establish',
  'focused', 'further', 'identify', 'including', 'information', 'internal', 'meeting', 'necessary',
  'next', 'objective', 'objectives', 'progress', 'related', 'remain', 'required', 'review',
  'reviewed', 'summary', 'supporting', 'the', 'their', 'workstream', 'workstreams'
]);

function contentTokens(value) {
  return new Set((clean(value).toLowerCase().match(/[a-z][a-z0-9'’-]{3,}/g) || []));
}

// Verbs that assert something happened. The protected-fact gate covers names, numbers
// and acronyms; nothing anywhere covered a fabricated "agreed". A field using one of
// these must cite at least one entry containing an agreement or completion cue - coarse,
// cue-presence rather than proposition-level, and still the only verb-level check in the
// system.
const OUTCOME_VERB = /\b(?:agreed|decided|approved|confirmed|signed[- ]off|committed to|completed|finalised|resolved)\b/i;
const OUTCOME_CUE = /\b(?:agree|agreed|decid|approv|sign[- ]?off|confirm|happy with|works for me|done|sorted|completed|finalis|resolved|will do|that's fine|go ahead)\b/i;

function unsupportedOutcomeVerb(text, citedText) {
  if (!OUTCOME_VERB.test(clean(text))) return false;
  return !OUTCOME_CUE.test(clean(citedText));
}

function objectiveIssue(value) {
  const text = clean(value);
  if (!text) return 'empty_objective';
  if (text.split(/\s+/).length < 4) return 'short_fragment';
  if (/\b(?:I|we|we'd|we'll|we've|we're|our|ours|my|mine|me|us|you|your|yours|you're|you are)\b/i.test(text)) {
    return 'first_or_second_person_objective';
  }
  if (/\b[A-Z][a-z'’-]+\s+[A-Z][a-z'’-]+\s+(?:said|noted|explained|reported|thinks|thought|mean|means|want|wants)\b/i.test(text)) {
    return 'speaker_transcript_objective';
  }
  if (/\b(?:current\s+setup\s+the\s+flash|for\s+a\s+site\s+in\s+the\s+areas|quality\s+culture\s+operating|lovely,\s+that'?s\s+one\s+sorted|now,\s+the\s+annual\s+show)\b/i.test(text)) {
    return 'malformed_objective';
  }
  return '';
}

function presentationTextIssue(value, field = 'text') {
  const text = clean(value);
  if (!text) return `${field}_empty`;
  return objectiveIssue(text) || transcriptShapedSummaryIssue(text) || '';
}

function hasPresentationIssue(notes = {}) {
  return [
    notes.meetingPurpose,
    ...(Array.isArray(notes.objectives) ? notes.objectives : []),
    notes.executiveSummary
  ].some((item) => objectiveIssue(item) || transcriptShapedSummaryIssue(item));
}

function normaliseTopicObjective(topic) {
  let text = clean(topic)
    .replace(/^(?:review|clarify|confirm|coordinate|align|discuss)\s+/i, '')
    .replace(/\s+and\s+related\s+next\s+steps\.?$/i, '')
    .replace(/[.!?]+$/g, '')
    .trim();
  if (!text || objectiveIssue(text)) return '';
  text = text.charAt(0).toLowerCase() + text.slice(1);
  return `Review ${text}.`;
}

function deterministicPresentationFallback(original, reason = 'unsafe_presentation') {
  const objectives = dedupeObjectives(original.objectives, 8)
    .filter((item) => !objectiveIssue(item));
  for (const topic of cleanLines(original.overallTopics, 8)) {
    const objective = normaliseTopicObjective(topic);
    const key = objectiveSemanticKey(objective);
    if (objective && key && !objectives.some((item) => objectiveSemanticKey(item) === key)) {
      objectives.push(objective);
    }
    if (objectives.length >= 8) break;
  }
  const purposeIsSafe = !presentationTextIssue(original.meetingPurpose, 'purpose');
  const fallbackPurpose = purposeIsSafe
    ? clean(original.meetingPurpose)
    : objectives[0] || cleanLines(original.overallTopics, 8).map(normaliseTopicObjective).find(Boolean) || '';
  const executiveSummary = fallbackMinutesReadySummary(original.executiveSummary) || clean(original.meetingPurpose);
  if (!fallbackPurpose || !objectives.length || !executiveSummary || transcriptShapedSummaryIssue(executiveSummary)) {
    return { ...original, used: false, reason };
  }
  return {
    ...original,
    meetingPurpose: fallbackPurpose,
    objectives,
    executiveSummary,
    used: true,
    reason: `deterministic_${reason}`
  };
}

// The cited-revision validator: partial acceptance per field, every acceptance earned
// against the evidence the field cites. A failing objective is dropped and the rest
// kept; a failing purpose or summary keeps the deterministic original for that field
// only. fieldOutcomes makes every decision visible - the failure mode this whole area
// keeps re-teaching is the invisible one.
function validateCitedRevision(original, revised, evidencePack, options = {}) {
  const sourceText = clean([
    original.meetingTitle,
    original.meetingPurpose,
    ...original.objectives,
    ...original.overallTopics,
    original.executiveSummary
  ].join(' '));
  const allowedIds = packEntryIds(evidencePack);
  const fieldOutcomes = {
    purpose: 'accepted',
    summary: 'accepted',
    objectives: { accepted: 0, rejected: 0, reasons: [] },
    topics: { accepted: 0, rejected: 0, reasons: [] }
  };

  const shapeIssue = (text, isSummary) => {
    if (!text) return 'empty';
    if (/\bI\b|\b(?:we|we'd|we'll|we've|we're|our|my)\b/i.test(text)) return 'first_person_summary';
    if (/(?:^|[.!?]\s+)(?:obviously|basically|you know|because)\b/i.test(text)) return 'conversational_summary';
    const transcriptShaped = transcriptShapedSummaryIssue(text);
    if (transcriptShaped) return transcriptShaped;
    if (isSummary && text.split(/(?<=[.!?])\s+/).filter(Boolean).length > 5) return 'summary_too_long';
    return '';
  };

  const purposeField = fieldOf(revised?.meetingPurpose);
  const purposeIssue = shapeIssue(purposeField.text, false) || citedFieldIssue(purposeField, evidencePack, sourceText, allowedIds, options);
  let meetingPurpose = purposeField.text;
  if (purposeIssue) {
    fieldOutcomes.purpose = purposeIssue;
    meetingPurpose = clean(original.meetingPurpose);
  }

  const summaryField = fieldOf(revised?.executiveSummary);
  const summaryIssue = shapeIssue(summaryField.text, true) || citedFieldIssue(summaryField, evidencePack, sourceText, allowedIds, options);
  let executiveSummary = summaryField.text;
  if (summaryIssue) {
    fieldOutcomes.summary = summaryIssue;
    executiveSummary = clean(original.executiveSummary);
  }

  const objectiveFields = (Array.isArray(revised?.objectives) ? revised.objectives : []).map(fieldOf);
  const acceptedObjectives = [];
  for (const field of objectiveFields) {
    const issue = objectiveIssue(field.text) || citedFieldIssue(field, evidencePack, sourceText, allowedIds, options);
    if (issue) {
      fieldOutcomes.objectives.rejected += 1;
      fieldOutcomes.objectives.reasons.push(issue);
      continue;
    }
    fieldOutcomes.objectives.accepted += 1;
    acceptedObjectives.push(field.text);
  }
  // Topic headings, named by the model and held to the heading bar as well as the citation
  // bar.
  //
  // Headings used to come from a closed list of twenty-three concepts, so a meeting could
  // only be about something the list already knew: a residents' association arguing about
  // visitor parking was headed "Budget and commercial matters" because somebody said "cost"
  // once, and an audit kick-off that spent the morning on hotels, SBOMs and surveillance
  // findings had no heading for any of them. Naming what a stretch of conversation is about
  // is the one job in this pipeline that a language model does better than counting words -
  // measured, distributional naming on raw speech tops out around sixty per cent precision,
  // and a wrong heading is the same wrong line on four screens.
  //
  // So the model proposes them and they are checked twice. Once as claims, by exactly the
  // gates every other cited field goes through - the ids must resolve, protected facts and
  // outcome verbs are read against the cited turns. Once as headings, by the same
  // predicates the deterministic labels have always had to pass, so a heading that has
  // become a sentence or a list of attendees is refused whoever wrote it.
  const topicFields = (Array.isArray(revised?.overallTopics) ? revised.overallTopics : []).map(fieldOf);
  const acceptedTopics = [];
  for (const field of topicFields) {
    const heading = clean(field.text);
    const issue = !heading ? 'empty'
      : !canHeadlineTopic(heading) ? 'not_a_heading'
        : !isPublishableTopicLabel(heading) ? 'not_client_ready'
          : !labelNamesAWorkstream(heading) ? 'not_a_subject'
            : citedFieldIssue(field, evidencePack, sourceText, allowedIds, options);
    if (issue) {
      fieldOutcomes.topics.rejected += 1;
      fieldOutcomes.topics.reasons.push(issue);
      continue;
    }
    if (acceptedTopics.some((item) => item.text.toLowerCase() === heading.toLowerCase())) continue;
    fieldOutcomes.topics.accepted += 1;
    acceptedTopics.push({ text: heading, evidenceIds: field.evidenceIds });
  }

  // Survivors first, then the deterministic floor fills back to eight. A rejected cited
  // objective is the model's loss, not the meeting's: on the Eakin weekly three cited
  // objectives failed and the field shipped five where the floor had eight - punishing
  // the reviewer for the model's bad citations. The floor lines were already validated
  // deterministic output; they do not need the model's permission to stand.
  //
  // The top-up dedupes by token set, not by the ordinary semantic key: the model
  // paraphrases by reordering - "the behaviour of the mute button" beside "the mute
  // button behaviour" - and the lexical key reads those as different objectives.
  // Subset, not equality: the model swaps connectives - "incorporating the QR code"
  // beside the floor's "with the QR code" - and the two token sets differ by exactly the
  // swapped word. A floor line whose content tokens all appear in an accepted line is
  // the same objective wearing a different preposition.
  // Connectives of four-plus letters ("with", "from", "that") survive contentTokens and
  // defeat the subset test - "with the QR code" vs "incorporating the QR code" differs
  // by exactly one such word. They carry no content, so the comparison ignores them.
  const CONNECTIVES = new Set(['with', 'from', 'into', 'onto', 'that', 'this', 'then', 'than', 'over', 'under', 'about', 'using']);
  const comparisonTokens = (text) => [...contentTokens(text)].filter((token) => !CONNECTIVES.has(token));
  const acceptedSets = acceptedObjectives.map((text) => new Set(comparisonTokens(text)));
  const floorTopUp = original.objectives.filter((item) => {
    const tokens = comparisonTokens(item);
    return !acceptedSets.some((set) => tokens.every((token) => set.has(token)));
  });
  const objectives = dedupeObjectives([...acceptedObjectives, ...floorTopUp], 8);

  // Nothing survived: the whole revision is refused and the caller falls back. Anything
  // survived: the survivors ship, with the outcomes carried for telemetry.
  // "Anything survived" means the MODEL contributed something - the floor top-up is not
  // the model surviving, and counting it made this branch unreachable.
  const anyAccepted = fieldOutcomes.purpose === 'accepted'
    || fieldOutcomes.summary === 'accepted'
    || acceptedObjectives.length > 0;
  // The turns each accepted field drew on, carried out so the reviewer can see the
  // evidence instead of deleting it. The model narrated ids into the prose because it
  // had no other way to show its working; this is the other way.
  const quotesFor = (field) => {
    const entries = evidenceEntriesFor({ evidence: (evidencePack[0] || {}).evidence || [] });
    const cited = new Set((field.evidenceIds || []).map(clean));
    return entries
      .filter((entry) => cited.has(clean(entry.id)))
      .map((entry) => ({ id: clean(entry.id), speaker: clean(entry.speaker), text: clean(entry.text) }))
      .filter((entry) => entry.text);
  };
  if (!anyAccepted) return { ok: false, reason: 'no_cited_field_survived', fieldOutcomes };
  return {
    ok: true,
    reason: 'accepted_cited',
    meetingPurpose: meetingPurpose || clean(original.meetingPurpose),
    objectives: objectives.length ? objectives : dedupeObjectives(original.objectives, 8),
    executiveSummary: executiveSummary || clean(original.executiveSummary),
    overallTopics: acceptedTopics,
    fieldOutcomes,
    evidenceQuotes: {
      purpose: fieldOutcomes.purpose === 'accepted' ? quotesFor(purposeField) : [],
      executiveSummary: fieldOutcomes.summary === 'accepted' ? quotesFor(summaryField) : []
    }
  };
}

// Evidence ids written into the prose itself: "...building the closing slide with the QR
// code and link (evt_0224), developing three backup questions (evt_0227)...". The model
// is asked to cite in the structured field and cites there too, but it also narrates the
// ids, and the reviewer is then left deleting them by hand from every sentence.
//
// The ids are lifted out rather than discarded: an id the model bothered to write inline
// is a citation it is making, so it joins the field's evidenceIds and still has to
// survive validation. The prose loses the clutter; the grounding loses nothing.
const INLINE_CITATION = /\s*[([]\s*(evt_[0-9a-z_]+(?:\s*[,;]\s*evt_[0-9a-z_]+)*)\s*[)\]]/gi;

// The section labels this module puts in its own prompt. The model is asked to read
// [BASIC_NOTES] and write prose; sometimes it writes the label instead - a residents'
// association got "a review of budget and commercial matters (BASIC_NOTES)" on its summary
// screen. That is our word, in our brackets, and the reader has no idea what it means.
// Handled the same way as a stray evt_0224: removed on the way out rather than argued
// about, because the closed set of things we ourselves wrote into the prompt is exactly
// the set we can strip without touching anything the meeting said.
const PROMPT_SECTION_LABEL = /[[(\s]*\/?(?:BASIC_NOTES|CURRENT_OBJECTIVES|CURRENT_SUMMARY|MEETING_PURPOSE|MEETING_TITLE|BOUNDED_EVIDENCE|RETURN_SCHEMA)[\])]*/g;

function stripInlineCitations(text) {
  const ids = [];
  const stripped = String(text || '').replace(PROMPT_SECTION_LABEL, ' ').replace(INLINE_CITATION, (match, group) => {
    for (const id of String(group).split(/[,;]/)) {
      const trimmed = clean(id);
      if (trimmed) ids.push(trimmed);
    }
    return '';
  });
  // Tidy the punctuation the removal leaves behind: "the link ." and "questions ,".
  return { text: clean(stripped).replace(/\s+([.,;:])/g, '$1').replace(/\(\s*\)/g, '').replace(/\s{2,}/g, ' ').trim(), ids };
}

// The model may return the old flat shape ({meetingPurpose: "..."}) or the cited shape
// ({meetingPurpose: {text, evidenceIds}}). Normalise both; citations are empty for flat.
function fieldOf(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? { text: clean(value.text), evidenceIds: Array.isArray(value.evidenceIds) ? value.evidenceIds : [] }
    : { text: clean(value), evidenceIds: [] };
  const { text, ids } = stripInlineCitations(raw.text);
  return { text, evidenceIds: [...new Set([...raw.evidenceIds.map(clean).filter(Boolean), ...ids])] };
}

// Per-field checks against the evidence the field cites. This is the discussion model:
// not "does the wording resemble the input fields" but "do the cited turns contain it".
// Returns '' or a reason.
// Minutes-framing vocabulary, admissible in cited fields without counting as new
// substance. Every word here is subject-free - it can describe any meeting and can carry
// none of a specific one, so it cannot smuggle foreign content past the ratio. The
// protected-fact and outcome-verb gates, not this list, are what police substance.
const CITED_FRAMING_WORDS = new Set([
  'across', 'against', 'ahead', 'area', 'areas', 'arrangements', 'awaiting', 'behaviour', 'changes',
  'checked', 'completion', 'concentrated', 'covered', 'covering', 'discussed', 'evidence',
  'expected', 'final', 'focus', 'focused', 'focusing', 'issues', 'item', 'items', 'largely',
  'outstanding', 'plans', 'potential', 'practical', 'progress', 'regular', 'remaining',
  'responsibilities', 'session', 'status', 'team', 'tested', 'testing', 'timeline',
  'timeframe', 'timetable', 'track', 'update', 'updates', 'validation', 'went', 'within', 'work',
  'working', 'workstreams'
]);

// Whether a word the model wrote is a form of a word the meeting actually used.
//
// The vocabulary gate compared surface strings, so "rehearsing" was new substance beside
// "rehearse", "discussions" beside "discussed", "presenter's" beside "presenter" and
// "management" beside "manage". On a real webinar rehearsal that alone put nineteen of
// the summary's forty-one words in the unsupported column - ratio 0.463 against a 0.45
// threshold - and a correct, cited, well-written summary was thrown away for using
// English inflection. What replaced it on screen was raw transcript.
//
// A shared root of at least five characters covering three quarters of the shorter word
// is the general form of the question the gate meant to ask - is this concept in the
// meeting - as opposed to the one it was asking, which was whether the model happened to
// pick the same ending. It is deliberately not a word list: a list has to be extended
// once per meeting, which is exactly the maintenance this is meant to end.
const MIN_SHARED_ROOT = 5;

function sharedRootLength(left, right) {
  const limit = Math.min(left.length, right.length);
  let shared = 0;
  while (shared < limit && left[shared] === right[shared]) shared += 1;
  return shared;
}

function isInflectionOf(token, universeTokens) {
  if (token.length < MIN_SHARED_ROOT) return false;
  const bare = token.replace(/['\u2019]s$/, '');
  for (const candidate of universeTokens) {
    if (candidate.length < MIN_SHARED_ROOT) continue;
    const shared = sharedRootLength(bare, candidate);
    if (shared >= MIN_SHARED_ROOT && shared >= 0.75 * Math.min(bare.length, candidate.length)) return true;
  }
  return false;
}

const UNSUPPORTED_TOKEN_LIMIT = 0.65;

function citedFieldIssue(field, pack, sourceText, allowedIds, options = {}) {
  if (!field.evidenceIds.length) return 'missing_citation';
  // One unresolvable token does not undo the citations that do resolve.
  //
  // A summary cited six real turns and the string "BASIC_NOTES" - a section label lifted
  // from our own prompt, not an invented event - and the whole field was rejected, so the
  // reviewer got raw transcript instead of an accurate summary anchored in six places.
  // Rejecting outright reads like strictness but buys nothing: an id that resolves to
  // nothing contributes nothing to the evidence a claim is checked against, so it can be
  // dropped rather than treated as a disqualification. A field whose citations ALL fail
  // to resolve is still uncited, and still rejected.
  const resolvedIds = field.evidenceIds.filter((id) => allowedIds.has(clean(id)));
  if (!resolvedIds.length) return 'invalid_citation';
  const citedText = packCitedText(pack, resolvedIds);
  // Claim-level gates stay tight against the turns the field actually cites: a number or
  // a standard or an "agreed" has to be in the evidence offered for THIS sentence.
  const claimUniverse = `${sourceText} ${citedText}`.toLowerCase();
  const facts = protectedFacts(field.text);
  if ([...facts].some((fact) => !claimUniverse.includes(fact))) return 'new_protected_fact';
  if (unsupportedOutcomeVerb(field.text, citedText)) return 'unsupported_outcome_verb';
  // The vocabulary gate asks a different question - is this prose about this meeting - and
  // its honest scope is therefore the meeting, not the handful of turns a sentence happened
  // to cite. Judged against its citations, a five-sentence narrative had to draw four
  // fifths of its words from 575 characters; on a small meeting the words it was rejected
  // for were "furthermore", "were", "which", "noted", "discussion", "overall". That is
  // register, not substance, and no threshold on that scale separates the two.
  //
  // The gate the comment below describes - wholesale off-topic prose - survives a universe
  // of the whole meeting perfectly well, because prose about a different meeting still
  // shares little vocabulary with this one. What does not survive is the pretence that the
  // gate was policing fabrication: that is the job of the two checks above, which still
  // read only the cited turns, and which are unchanged.
  const vocabularyUniverse = `${sourceText} ${options.meetingText || ''} ${packCitedText(pack, [...allowedIds])}`.toLowerCase();
  const universeTokens = contentTokens(vocabularyUniverse);
  const fieldTokens = [...contentTokens(field.text)];
  const unsupported = fieldTokens.filter((token) => !universeTokens.has(token)
    && !EDITORIAL_WORDS.has(token)
    && !CITED_FRAMING_WORDS.has(token)
    && !isInflectionOf(token, universeTokens));
  // 0.65, measured against what the gate is for, on a universe that is now the meeting
  // rather than a handful of cited turns. With the honest universe, correct summaries of
  // small meetings still measured 0.46-0.53, and the words they were failing on were
  // "furthermore", "were", "which", "noted", "discussion", "overall", "regarding" - the
  // register any summary is written in, not substance from anywhere. Prose about a
  // DIFFERENT meeting measures around 0.9 on the same scale, which is the separation the
  // test beside this pins: a real summary against its own meeting is accepted, the same
  // summary against another meeting is rejected. That gap, not the digit, is the gate.
  //
  // The history is worth keeping, because the digit has moved twice and both times for
  // the same underlying reason. At 0.15 it rejected the
  // exact register the reviewer asked for - "focused", "discussed", "areas", "ensure" -
  // because a narrative ABOUT evidence necessarily uses narrative words that are in
  // neither the evidence nor the input fields. And a token ratio never reliably caught
  // single-claim fabrication anyway: two invented nouns in a twelve-token sentence is
  // 0.17. What it can catch is wholesale off-topic prose, where the majority of the
  // vocabulary comes from nowhere - and 0.45 still catches that. The real security for
  // cited fields is the three gates above: protected facts against cited turns, outcome
  // verbs against agreement cues, and citations that must resolve.
  //
  if (unsupported.length / Math.max(fieldTokens.length, 1) > UNSUPPORTED_TOKEN_LIMIT) return 'new_substantive_wording';
  return '';
}

function validateInitialUnderstandingRevision(original, revised, evidencePack = null, options = {}) {
  if (Array.isArray(evidencePack) && evidencePack.length) {
    return validateCitedRevision(original, revised, evidencePack, options);
  }
  const originalPurposeIssue = presentationTextIssue(original.meetingPurpose, 'purpose');
  const meetingPurpose = clean(fieldOf(revised?.meetingPurpose).text) || (originalPurposeIssue ? '' : clean(original.meetingPurpose));
  const objectives = dedupeObjectives((revised?.objectives || []).map((item) => fieldOf(item).text), 5);
  const executiveSummary = clean(fieldOf(revised?.executiveSummary).text);
  if (!meetingPurpose || !objectives.length || !executiveSummary) return { ok: false, reason: 'incomplete_response' };
  const sourceNeedsPresentationPolish = hasPresentationIssue(original);
  const outputPurposeIssue = presentationTextIssue(meetingPurpose, 'purpose');
  if (outputPurposeIssue) return { ok: false, reason: outputPurposeIssue };
  const outputObjectiveIssue = objectives.map(objectiveIssue).find(Boolean);
  if (outputObjectiveIssue) return { ok: false, reason: outputObjectiveIssue };
  const sourceText = clean([
    original.meetingTitle,
    original.meetingPurpose,
    ...original.objectives,
    ...original.overallTopics,
    original.executiveSummary
  ].join(' '));
  const revisedText = clean([meetingPurpose, ...objectives, executiveSummary].join(' '));
  const sourceFacts = protectedFacts(sourceText);
  const revisedFacts = protectedFacts(revisedText);
  if ([...revisedFacts].some((fact) => !sourceFacts.has(fact))) return { ok: false, reason: 'new_protected_fact' };
  if (/\bI\b|\b(?:we|we'd|we'll|we've|we're|our|my)\b/i.test(`${meetingPurpose} ${executiveSummary}`)) {
    return { ok: false, reason: 'first_person_summary' };
  }
  if (/(?:^|[.!?]\s+)(?:obviously|basically|you know|because)\b/i.test(`${meetingPurpose}. ${executiveSummary}`)) {
    return { ok: false, reason: 'conversational_summary' };
  }
  const summaryIssue = transcriptShapedSummaryIssue(executiveSummary);
  if (summaryIssue) return { ok: false, reason: summaryIssue };
  const sourceTokens = contentTokens(sourceText);
  const unsupportedTokens = [...contentTokens(revisedText)]
    .filter((token) => !sourceTokens.has(token) && !EDITORIAL_WORDS.has(token));
  const revisedTokens = contentTokens(revisedText);
  const unsupportedRatio = unsupportedTokens.length / Math.max(revisedTokens.size, 1);
  if (unsupportedRatio > (sourceNeedsPresentationPolish ? 0.42 : 0.08)) {
    return { ok: false, reason: 'new_substantive_wording' };
  }
  const summaryValidation = validateGrammarRevision(
    clean([original.meetingPurpose, ...original.overallTopics, original.executiveSummary].join(' ')),
    executiveSummary
  );
  // This pass may deliberately remove repeated/weak notes, so only the protected-fact
  // and broad semantic-overlap parts of the grammar guard apply here.
  if (summaryValidation.reason === 'new_protected_fact') return { ok: false, reason: summaryValidation.reason };
  // Closed deliberately, growth side only: validateGrammarRevision returns early on any
  // length change outside 0.45-1.3x WITHOUT an overlap property, and the null-guarded
  // overlap check below then never ran - so a summary that GREW past 1.3x silently
  // skipped both gates. Growth without citations is what the pack-less path exists to
  // prevent. Shrinkage stays sanctioned: this pass may deliberately remove repeated and
  // weak notes, which is compression below the grammar guard's floor.
  const summaryGrowthSource = clean([original.meetingPurpose, ...original.overallTopics, original.executiveSummary].join(' '));
  if (summaryGrowthSource && executiveSummary.length / summaryGrowthSource.length > 1.3) {
    return { ok: false, reason: 'length_changed' };
  }
  if (summaryValidation.overlap != null && summaryValidation.overlap < (sourceNeedsPresentationPolish ? 0.2 : 0.3)) {
    return { ok: false, reason: 'meaning_changed', overlap: summaryValidation.overlap };
  }
  return { ok: true, reason: 'accepted', meetingPurpose, objectives, executiveSummary, overlap: summaryValidation.overlap };
}

async function polishInitialUnderstanding(input = {}, options = {}) {
  const original = {
    meetingTitle: clean(input.meetingTitle),
    meetingPurpose: clean(input.meetingPurpose),
    objectives: dedupeObjectives(input.objectives, 8),
    overallTopics: cleanLines(input.overallTopics, 8),
    executiveSummary: clean(input.executiveSummary)
  };
  const evidencePack = Array.isArray(options.evidencePack) && options.evidencePack.length ? options.evidencePack : null;
  if (!original.objectives.length && !original.overallTopics.length) {
    return { ...original, used: false, reason: 'empty_notes' };
  }
  const apiKey = clean(options.apiKey);
  const fetchImpl = options.fetchImpl || global.fetch;
  if (!apiKey || typeof fetchImpl !== 'function') return { ...original, used: false, reason: 'unavailable' };
  const startedAt = Date.now();
  const attemptTimeoutMs = Number(options.timeoutMs || 20000);
  let controller = null;
  let timeout = null;
  const openAttemptWindow = () => {
    if (timeout) clearTimeout(timeout);
    controller = typeof AbortController === 'function' ? new AbortController() : null;
    timeout = controller ? setTimeout(() => controller.abort(), attemptTimeoutMs) : null;
  };
  openAttemptWindow();
  // One retry, for the failure where the model does not manage to emit valid JSON.
  //
  // The router answers that with 422 json_generation_failed, which is not a bad request -
  // the same prompt succeeds on the next attempt - and the reviewer's whole summary screen
  // fell back to deterministic text because one sampling run produced a broken brace. It
  // cost a client meeting its minutes in the measured set of thirteen. Retrying a
  // structural formatting failure once is the ordinary handling for a stochastic decoder;
  // it is bounded at one, it shares the existing abort controller so the timeout still
  // governs, and every other status still fails through untouched, because a 401 or a 500
  // will say the same thing twice.
  const requestOnce = (pack) => fetchImpl(options.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    signal: controller?.signal,
    body: JSON.stringify({
      model: options.model,
      messages: [
      {
        role: 'system',
        content: 'You are a careful British English meeting-minutes editor. Improve wording only from the supplied title and notes. Never invent facts, people, decisions, actions, dates, purposes or technical detail.'
      },
      {
        role: 'user',
        content: [
        ...(pack ? [
          // The enriched contract: the model may draw concrete detail from the
          // bounded evidence below, and must cite the ids it drew from per field.
          // The validators then check every claim against exactly the turns it
          // cites - the discussion stage's model, applied to the summary.
          'Write a meeting purpose of one to two sentences, four to eight concise meeting objectives, and a professional three to five sentence executive summary in natural British English.',
          'The purpose says why the meeting was held. The executive summary reads like formal meeting minutes and says what the meeting covered and where the main threads got to.',
          'Use the supplied evidence entries to add concrete detail that is directly supported, and cite the evidenceIds you used for each field.',
          'Put the ids ONLY in the evidenceIds arrays. Never write an id such as evt_0224 inside the purpose, an objective or the summary - the reader sees that text and it is not for them.',
          "Write 'agreed', 'decided' or 'confirmed' only when a cited entry says so; otherwise write 'discussed', 'reviewed' or 'tested'.",
          'Third person, neutral. No first-person speech, no conversational fragments, no invented names, numbers or dates.',
          'Also name the meeting\'s topics: four to eight short subject headings for what this meeting was about, each cited. A heading names a subject as it would appear in minutes - "Audit scope, timing and logistics", "Visitor parking enforcement" - and is not a sentence, not a question, not a list of attendees, and never says what happened.',
          'Return JSON only as {"meetingPurpose":{"text":"...","evidenceIds":["..."]},"objectives":[{"text":"...","evidenceIds":["..."]}],"overallTopics":[{"text":"...","evidenceIds":["..."]}],"executiveSummary":{"text":"...","evidenceIds":["..."]}}.',
          '',
          'BOUNDED_EVIDENCE:',
          JSON.stringify(pack)
        ] : [
          'Write one concise meeting purpose, 2-5 concise meeting objectives and a professional 2-3 sentence executive summary in natural British English.',
          'The meeting purpose must explain why the meeting happened in one clean sentence.',
          'The executive summary must read like formal meeting minutes, not copied transcript speech or a list of notes.',
          'Synthesise and compress the supplied material. Use third-person, neutral wording and remove repetition, first-person speech, conversational fragments and plainly meaningless notes.',
          'Use only meaning present in the supplied material. If a note is unclear, omit it rather than guessing.',
          'Reuse the supplied terminology wherever possible; do not introduce new substantive concepts.',
          'Do not add actions, owners, deadlines, decisions or outcomes.',
          'Return JSON only as {"meetingPurpose":"...","objectives":["..."],"executiveSummary":"..."}.'
        ]),
        '',
        `[MEETING_TITLE] ${original.meetingTitle || 'Not stated'} [/MEETING_TITLE]`,
        `[MEETING_PURPOSE] ${original.meetingPurpose || 'Not stated'} [/MEETING_PURPOSE]`,
        `[BASIC_NOTES] ${original.overallTopics.join(' | ') || 'Not stated'} [/BASIC_NOTES]`,
        `[CURRENT_OBJECTIVES] ${original.objectives.join(' | ') || 'Not stated'} [/CURRENT_OBJECTIVES]`,
        `[CURRENT_SUMMARY] ${original.executiveSummary || 'Not stated'} [/CURRENT_SUMMARY]`
        ].join('\n')
      }
      ],
      temperature: 0,
      max_tokens: Number(options.maxTokens || 650),
      response_format: { type: 'json_object' }
    })
  });
  try {
    let attemptPack = evidencePack;
    let response = await requestOnce(attemptPack);
    let raw = await response.text();
    if (!response.ok && response.status === 422 && /json_generation_failed|could not produce valid JSON/i.test(raw)) {
      // A second attempt needs a second window. Sharing the first one meant the retry
      // inherited whatever was left of a thirty-second budget after a seventeen-second
      // failure, aborted, and turned a recoverable formatting failure into a request
      // failure - the same lost summary, one round trip later. Worst case is now two full
      // windows, which is the honest cost of retrying at all, and it is paid only on a
      // 422.
      openAttemptWindow();
      // The second attempt drops the evidence pack and asks for the simpler shape.
      //
      // Repeating a request the decoder has already failed to satisfy tends to fail the
      // same way - on one client meeting it did, twice - and the fallback from there is
      // deterministic text. Asking instead for the smaller schema degrades along the axis
      // that is failing: the reviewer loses the evidence-grounded detail and keeps written
      // English, which is the better half to keep. It stays two round trips.
      attemptPack = null;
      response = await requestOnce(attemptPack);
      raw = await response.text();
    }
    if (!response.ok) { if (process.env.POLISH_DEBUG) console.error('  HTTP ' + response.status + ' body=' + String(raw).slice(0, 600)); return { ...original, used: false, reason: `http_${response.status}`, timingMs: Date.now() - startedAt }; }
    const body = raw ? JSON.parse(raw) : {};
    const content = body?.choices?.[0]?.message?.content;
    const parsed = typeof content === 'object' && content ? content : JSON.parse(String(content || '{}'));
    const validation = validateInitialUnderstandingRevision(original, parsed, attemptPack, { meetingText: clean(options.meetingText) });
    return validation.ok
      ? { ...original, meetingPurpose: validation.meetingPurpose, objectives: validation.objectives, executiveSummary: validation.executiveSummary, namedTopics: validation.overallTopics || [], used: true, reason: validation.reason, overlap: validation.overlap, fieldOutcomes: validation.fieldOutcomes, evidenceQuotes: validation.evidenceQuotes || null, cited: Boolean(attemptPack), timingMs: Date.now() - startedAt }
      : { ...deterministicPresentationFallback(original, validation.reason), overlap: validation.overlap, fieldOutcomes: validation.fieldOutcomes, timingMs: Date.now() - startedAt };
  } catch {
    return { ...deterministicPresentationFallback(original, 'request_failed'), timingMs: Date.now() - startedAt };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

module.exports = {
  dedupeObjectives,
  deterministicPresentationFallback,
  objectiveSemanticKey,
  objectiveIssue,
  polishInitialUnderstanding,
  validateInitialUnderstandingRevision, stripInlineCitations };
