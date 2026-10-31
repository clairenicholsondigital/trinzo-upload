'use strict';

const { meetingMinutesAgentText } = require('./meetingMinutesPlainText');
const { isReviewerAuthored } = require('./canonicalMinutes/state');
const { hybridContentTokenOverlap } = require('./meetingMinutesRecordMatching');
const { applyTopicHeadings, applyIncludedSections, includedSections } = require('./includedSections');
const { timingLabel: meetingAgentTimingLabel } = require('./meetingMinutesAgentDocx');
const parallelMinutes = require('./meetingMinutesParallel');
const { normaliseDatePhrasesDeep } = require('./spokenForms');
const { normaliseKnownTermsDeep: normaliseMeetingAgentKnownTermsDeep } = require('./meetingMinutesText');
const { orderedFilingSupportingDetails } = require('./meetingMinutesSupportingDetails');
const optionalReview = require('./meetingMinutesOptionalReview');
const { normaliseSourceUnits } = require('./meetingMinutesSource');
const {
  removeShortTopicEchoes, removePersonalAsides, balanceDiscussionTopics, repairStructuralTopicHeadings
} = require('./canonicalMinutes/discussionOrganiser');
const { promoteMaterialTimingDetails } = require('./meetingMinutesTemporalPublication');
const {
  meetingAgentTimingAnchor, sanitiseDetails: sanitiseMeetingAgentDetails
} = require('./meetingMinutesDraftContext');
const { timingForPublication: meetingAgentTimingForPublication } = require('./meetingMinutesTimingPublication');
const { reviewMeetingCalendarDates } = require('./meetingMinutesDateReview');
const { mergeMeetingAgentFlags } = require('./meetingMinutesReviewFlags');
const { normaliseUkCurrency } = require('./canonicalMinutes/textNormalisation');
const { convertSpokenNumbers } = require('./spokenNumbers');
const { isActionCategoryTopicCard } = require('./canonicalMinutes/topicEditorial');

function meetingAgentObjectives(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => meetingMinutesAgentText(typeof item === 'string' ? item : item?.text, 400))
    .filter(Boolean)
    .slice(0, 20);
}

// Number words belong in transcript evidence as spoken, but the minutes themselves use
// figures. Keep this boundary deliberately narrow: only reviewer-facing minute fields are
// formatted, never meeting metadata, attendee names, sourceUnits, flags or quoted evidence.
// convertSpokenNumbers is conservative around names, dates, ordinals and bare one-to-nine
// prose, and is idempotent, so legacy drafts and newly saved drafts can share this path.
function normaliseMeetingAgentMinuteNumbers(draft = {}) {
  // Currency presentation belongs at the same narrow reviewer-facing boundary
  // as spoken-number presentation. This also repairs an already-saved draft on
  // read without rewriting transcript evidence, metadata or provenance.
  const numberText = (value) => normaliseUkCurrency(
    convertSpokenNumbers(String(value == null ? '' : value)).text
  );
  const minuteRecord = (record) => {
    if (typeof record === 'string') return numberText(record);
    if (!record || typeof record !== 'object') return record;
    return {
      ...record,
      text: numberText(record.text),
      ...(Array.isArray(record.supportingDetails)
        ? { supportingDetails: record.supportingDetails.map(minuteRecord) }
        : {})
    };
  };
  const minuteTopic = (topic) => {
    if (!topic || typeof topic !== 'object') return topic;
    return {
      ...topic,
      topic: numberText(topic.topic),
      ...Object.fromEntries(['points', 'decisions', 'openQuestions']
        .filter((key) => Array.isArray(topic[key]))
        .map((key) => [key, topic[key].map(minuteRecord)]))
    };
  };
  return {
    ...draft,
    executiveSummary: numberText(draft.executiveSummary),
    meetingObjectives: (Array.isArray(draft.meetingObjectives) ? draft.meetingObjectives : []).map((objective) =>
      typeof objective === 'string' ? numberText(objective)
        : objective && typeof objective === 'object' ? { ...objective, text: numberText(objective.text) }
          : objective),
    discussion: (Array.isArray(draft.discussion) ? draft.discussion : []).map(minuteTopic),
    actions: (Array.isArray(draft.actions) ? draft.actions : []).map((action) => ({
      ...action,
      action: numberText(action?.action),
      ...(action?.timing && typeof action.timing === 'object'
        ? { timing: { ...action.timing, wording: numberText(action.timing.wording) } }
        : {})
    }))
  };
}

// Older Library drafts predate the current generated-discussion gate. Apply the
// same narrow action-bucket test when presenting them so an action recap does
// not remain visible forever merely because it was saved by an earlier run.
// Explicitly manual/reviewer-authored cards remain the reviewer's own content.
function hasMeetingAgentReviewerContent(record) {
  return isReviewerAuthored(record) || ['points', 'decisions', 'openQuestions', 'supportingDetails']
    .some((kind) => (record?.[kind] || []).some(hasMeetingAgentReviewerContent));
}

// A source-reviewed exclusion must survive later context promotion and topic
// regrouping. Match the original wording and evidence, not an ordinal ID which
// another discovery pass may reuse. Reviewer content remains authoritative.
function removeWithheldGeneratedDiscussion(discussion = [], withheld = []) {
  const exclusions = (Array.isArray(withheld) ? withheld : []).filter(item => item?.record?.text);
  if (!exclusions.length) return discussion;
  const wording = record => meetingMinutesAgentText(record?.text, 1600).toLowerCase().replace(/[.!?]+$/, '');
  const blocked = record => exclusions.some(item => wording(item.record) === wording(record)
    && (item.record.evidenceIds || item.evidenceIds || []).some(id => (record.evidenceIds || []).includes(id)));
  const cleanRecord = record => {
    if (isReviewerAuthored(record)) return record;
    if (blocked(record) && !hasMeetingAgentReviewerContent(record)) return null;
    return { ...record, supportingDetails: (record.supportingDetails || []).map(cleanRecord).filter(Boolean) };
  };
  return (Array.isArray(discussion) ? discussion : []).map(topic => {
    if (isReviewerAuthored(topic)) return topic;
    return { ...topic, ...Object.fromEntries(['points', 'decisions', 'openQuestions']
      .map(kind => [kind, (topic[kind] || []).map(cleanRecord).filter(Boolean)])) };
  }).filter(topic => hasMeetingAgentReviewerContent(topic)
    || ['points', 'decisions', 'openQuestions'].some(kind => topic[kind]?.length));
}

function removeGeneratedActionCategoryDiscussion(discussion = []) {
  return (Array.isArray(discussion) ? discussion : []).filter((topic) =>
    hasMeetingAgentReviewerContent(topic)
      || /^manual-topic-/.test(String(topic?.id || ''))
      || !isActionCategoryTopicCard(topic));
}

// All output formats start from the same publication content. This is the
// existing display policy; new generated-text cleanup happens before storage.
function meetingAgentPublicationContent(draft = {}) {
  if (parallelMinutes.isParallel(draft)) return parallelMinutes.publication(draft);
  draft = normaliseMeetingAgentMinuteNumbers(draft);
  draft = { ...draft, discussion: removeWithheldGeneratedDiscussion(
    draft.discussion, draft.qualityState?.discussion?.fidelityWithheldRows
  ) };
  const cleanedDiscussion = removeShortTopicEchoes(removePersonalAsides(draft.discussion), draft.sourceUnits);
  const balancedDiscussion = Number(draft.qualityState?.discussion?.topicArrangementVersion || 0) >= 1
    ? cleanedDiscussion
    : balanceDiscussionTopics(cleanedDiscussion, draft.sourceUnits);
  const eligibleDiscussion = removeMinorCommunicationCourtesyDiscussion(
    removeHeadingFragmentsFromDiscussion(removeGeneratedActionCategoryDiscussion(balancedDiscussion)), draft.sourceUnits
  );
  const publicationDiscussion = promoteMaterialTimingDetails(eligibleDiscussion, draft.sourceUnits || [], {
    meetingDate: meetingAgentTimingAnchor(draft)
  }).discussion;
  const publicationActions = (Array.isArray(draft.actions) ? draft.actions : [])
    .map((action) => stripMinorCommunicationCourtesy(action, draft.sourceUnits))
    .filter(Boolean);
  const content = normaliseMeetingAgentKnownTermsDeep(normaliseDatePhrasesDeep({
    details: sanitiseMeetingAgentDetails(draft.details),
    executiveSummary: draft.executiveSummary || '',
    meetingObjectives: draft.meetingObjectives || [],
    discussion: repairStructuralTopicHeadings(publicationDiscussion, draft.sourceUnits || []),
    actions: publicationActions.map((action) => ({ ...action, timing: meetingAgentTimingForPublication(action.timing) }))
  }));
  const context = draft.qualityState?.preparation?.dateContext;
  const trustedAnchor = context && ['transcript_header', 'transcript_metadata', 'reviewer'].includes(context.source)
    ? meetingAgentTimingAnchor(draft) : '';
  const { flags: calendarFlags, ...calendarContent } = reviewMeetingCalendarDates(content, draft.sourceUnits || [], { meetingDate: trustedAnchor });
  return { ...calendarContent, reviewFlags: mergeMeetingAgentFlags(draft.reviewFlags || [], calendarFlags) };
}

function meetingAgentDraftForDocx(draft = {}) {
  const content = meetingAgentPublicationContent(draft);
  return {
    ...draft, ...content,
    discussion: applyTopicHeadings(draft, content.discussion),
    ...applyIncludedSections(draft, content),
    reviewFlags: content.reviewFlags
  };
}

function meetingAgentDraftForPdf(draft = {}, includeEvidence = false) {
  const content = meetingAgentPublicationContent(draft);
  const { details, discussion: publicationDiscussion, actions: publicationActions } = content;
  const include = includedSections(draft);
  const executiveSummary = include.executiveSummary ? content.executiveSummary : '';
  const meetingObjectives = include.meetingObjectives ? meetingAgentObjectives(content.meetingObjectives) : [];
  const discussion = applyTopicHeadings(draft, publicationDiscussion).map((topic) => ({
    topic: topic?.topic || 'Discussion',
    hideHeading: topic.hideHeading,
    points: [
      ...(Array.isArray(topic?.points) ? topic.points : []).map((item) => item?.text || item),
      ...(Array.isArray(topic?.decisions) ? topic.decisions : []).map((item) => `Decision — ${item?.text || item}`),
      ...(Array.isArray(topic?.openQuestions) ? topic.openQuestions : []).map((item) => `Open question — ${item?.text || item}`)
    ].filter(Boolean),
    decisions: [],
    openQuestions: []
  }));
  const actions = publicationActions.map((action) => ({
    owner: (Array.isArray(action?.owners) ? action.owners : []).join(', ') || 'Not stated',
    action: action?.action || '',
    deadline: meetingAgentTimingLabel(action?.timing)
  }));
  const publication = parallelMinutes.isParallel(draft)
    ? { executiveSummary, meetingObjectives, discussion, actions }
    : normaliseDatePhrasesDeep({ executiveSummary, meetingObjectives, discussion, actions });
  const minutes = { details, ...publication, preserveSummaryParagraphs: true };
  if (!includeEvidence) return parallelMinutes.isParallel(draft) ? minutes : normaliseMeetingAgentKnownTermsDeep(minutes);
  const unassignedDetails = orderedFilingSupportingDetails(optionalReview.active(draft.unassignedSupportingDetails || [], draft), draft.sourceUnits || []);
  minutes.supportingDetails = [
    ...publicationDiscussion.flatMap((topic) =>
      [...(topic?.points || []), ...(topic?.decisions || []), ...(topic?.openQuestions || [])].flatMap((record) =>
        (record?.supportingDetails || []).map((detail) => ({ topic: topic?.topic || 'Discussion', text: detail?.text || '' })))),
    ...unassignedDetails.map(detail => ({ topic: 'Needs filing', text: detail.text }))
  ].filter((detail) => detail.text);
  const evidenceIds = new Set();
  if (parallelMinutes.isParallel(draft)) {
    for (const id of draft.executiveSummaryEvidenceIds || []) evidenceIds.add(id);
    for (const item of [...(draft.meetingObjectives || []),...(draft.parallelActionProposals || []),...(content.reviewFlags || [])])
      for (const id of item.evidenceIds || []) evidenceIds.add(id);
    minutes.supportingDetails.push(...(draft.parallelActionProposals || []).map(item=>({
      topic:'Suggested follow-up ('+item.status+')',
      text:item.action+' — Owners: '+((item.owners || []).join(', ') || 'Not stated')+'; '+meetingAgentTimingLabel(item.timing)+'. '+item.reason
    })));
  }
  for (const topic of publicationDiscussion) {
    for (const record of [...(topic?.points || []), ...(topic?.decisions || []), ...(topic?.openQuestions || [])]) {
      for (const id of record?.evidenceIds || []) evidenceIds.add(id);
      for (const detail of record?.supportingDetails || []) for (const id of detail?.evidenceIds || []) evidenceIds.add(id);
    }
  }
  for (const action of publicationActions) {
    for (const id of action?.evidenceIds || []) evidenceIds.add(id);
  }
  for (const detail of unassignedDetails) for (const id of detail.evidenceIds) evidenceIds.add(id);
  minutes.evidenceAppendix = normaliseSourceUnits(draft.sourceUnits).filter((unit) => evidenceIds.has(unit.id));
  minutes.reviewFlags = parallelMinutes.isParallel(draft) ? content.reviewFlags.map(flag=>({...flag,message:flag.message+(flag.correctionNote?' Reviewer note: '+flag.correctionNote:'')})) : content.reviewFlags;
  return parallelMinutes.isParallel(draft) ? minutes : normaliseMeetingAgentKnownTermsDeep(minutes);
}

const MINOR_COPY_COURTESY = /\b(?:cc(?:'d|ed|ing)?|copy|copied|copying|include|add)\b[^.]{0,100}\b(?:email|mail|correspondence|thread|recipient|her|him|them|you)\b/i;

const COURTESY_CORRECTION = /\b(?:sorry|apolog(?:y|ise|ize|ised|ized|ising|izing)|my mistake|our mistake|our bad|forgot|forget|didn't|did not|should have|don['’]?t worry|do not worry)\b/i;

const STRONG_COURTESY_CORRECTION = /\b(?:apolog(?:y|ise|ize|ised|ized|ising|izing)|my mistake|our mistake|our bad|forgot|forget|didn't|did not|should have|don['’]?t worry|do not worry)\b/i;

const PERSON_NAME_WORD = "[A-Z][\\p{L}'’.-]+";

const PERSON_NAME = `${PERSON_NAME_WORD}(?:\\s+${PERSON_NAME_WORD}){0,2}`;

const RECEIPT_ACKNOWLEDGEMENT = new RegExp(
  `^${PERSON_NAME}\\s+(?:acknowledg(?:e|es|ed)|confirm(?:s|ed)?)\\s+(?:safe\\s+)?receipt(?:\\s+of\\s+(?:the\\s+)?(?:email|message|credentials?|account details|access details|login details))?[.!]?$`,
  'iu'
);

const OFF_RECORD_REQUEST = new RegExp(
  `^(?:${PERSON_NAME}\\s+)?(?:asks?|requests?|asked|requested)\\s+(?:for\\s+)?(?:a\\s+)?(?:comment|conversation|discussion|remark)\\s+off[- ]the[- ]record[.!]?$`,
  'iu'
);

const ADMINISTRATIVE_TAIL = new RegExp(
  `(?:[,;]|\\s+and|\\s+then)\\s*(?:${PERSON_NAME}\\s+)?(?:acknowledg(?:e|es|ed)|confirm(?:s|ed)?)\\s+(?:safe\\s+)?receipt(?:\\s+of\\s+(?:the\\s+)?(?:email|message|credentials?|account details|access details|login details))?[.!]?$`,
  'iu'
);

function stripAdministrativeAsideText(value = '') {
  const source = meetingMinutesAgentText(value, 1600).trim();
  if (!source || RECEIPT_ACKNOWLEDGEMENT.test(source) || OFF_RECORD_REQUEST.test(source)) return '';
  const withoutTail = source.replace(ADMINISTRATIVE_TAIL, '').replace(/[\s,;:-]+$/, '').trim();
  if (withoutTail !== source) return /[.?!]$/.test(withoutTail) ? withoutTail : `${withoutTail}.`;
  // Keep the confirmed work, not the narration about a minor addressing or
  // distribution error which preceded it.
  const correction = source.match(/^acknowledg(?:e|ement|ing)\s+of\s+(?:an?\s+)?(?:email|distribution|addressing|recipient|copying|cc)\s+(?:error|mistake)(?:\s+with\s+apolog(?:y|ies))?\s+and\s+confirmation\s+that\s+(.+)$/i);
  if (!correction?.[1]) return source;
  const substantive = correction[1].trim();
  return `${substantive.charAt(0).toUpperCase()}${substantive.slice(1)}`;
}

function minorCommunicationCourtesy(record = {}, sourceUnits = []) {
  const wording = meetingMinutesAgentText(record?.action || record?.text, 1600);
  if (!wording || !/(?:\bcc\b|\bcopy|\bcopied|\bcopying|\bapolog|\bsorry|\bmistake)/i.test(wording)) return false;
  const units = normaliseSourceUnits(sourceUnits);
  const indexes = new Set((record.evidenceIds || []).map((id) => units.findIndex((unit) => unit.id === id)).filter((index) => index >= 0));
  const citedRows = [...indexes].sort((a, b) => a - b).map((index) => units[index].text);
  const passageIndexes = new Set([...indexes].flatMap((index) => [index - 2, index - 1, index, index + 1, index + 2])
    .filter((index) => index >= 0 && index < units.length));
  const passageRows = [...passageIndexes].sort((a, b) => a - b).map((index) => units[index].text);
  const passage = passageRows.join(' ');
  const citedCopyingRemark = citedRows.some((text) => MINOR_COPY_COURTESY.test(text));
  const correctionInCopyingRemark = citedRows.some((text) => MINOR_COPY_COURTESY.test(text) && COURTESY_CORRECTION.test(text));
  return citedCopyingRemark && MINOR_COPY_COURTESY.test(`${wording} ${passage}`)
    && (correctionInCopyingRemark || STRONG_COURTESY_CORRECTION.test(passage));
}

function stripMinorCommunicationCourtesy(record = {}, sourceUnits = []) {
  if (hasMeetingAgentReviewerContent(record)) return record;
  const field = record.action != null ? 'action' : 'text';
  const value = meetingMinutesAgentText(record[field], 1600);
  let cleaned = stripAdministrativeAsideText(value);
  if (!cleaned) return null;
  const timingWords = /\b(?:today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|deadline|by|before|after|within|until|this week|next week|this month|next month)\b/i;
  const timedCopying = (record.timing?.kind !== 'not_stated' && Boolean(record.timing?.wording || record.timing?.exactDate))
    || timingWords.test(cleaned)
    || (Array.isArray(sourceUnits) ? sourceUnits : []).some(unit => (record.evidenceIds || []).includes(unit.id)
      && String(unit.text || '').split(/[.!?;]/).some(clause => /\b(?:cc|copy|copied|copying|include|add)\b/i.test(clause) && timingWords.test(clause)));
  if (!timedCopying && minorCommunicationCourtesy(record, sourceUnits)) {
    // An attachment, named content requirement or separately timed copying
    // step is substantive work, even beside a genuine copying apology.
    if (/^\s*(?:apologise|apologize|say sorry|cc|copy)\b/i.test(cleaned)) return null;
    const onlyCopyingApology = /^[\p{L}\s'’.-]{1,80}\s+apolog(?:ised|ized|ises|izes|ising|izing)\s+for\s+(?:not\s+)?(?:copying|cc['’]?ing)\b[^.!?;]*[.!?]?$/iu.test(cleaned)
      && !/\b(?:and|then|will|would|shall|should|must)\b/i.test(cleaned);
    if (onlyCopyingApology) return null;
    const withoutCourtesy = cleaned.replace(/\s*,?\s+(?:and|then)\s+(?:cc|copy)\b[^.;]{0,180}[.]?$/i, '')
      .replace(/[\s,;:-]+$/, '').trim();
    // An unrecognised courtesy clause is not grounds to delete the substantive
    // instruction it accompanies. Retain the row when safe separation fails.
    if (!withoutCourtesy || withoutCourtesy === cleaned) return record;
    cleaned = withoutCourtesy;
  }
  return cleaned === value ? record
    : { ...record, [field]: /[.?!]$/.test(cleaned) ? cleaned : `${cleaned}.` };
}

function removeMinorCommunicationCourtesyDiscussion(discussion = [], sourceUnits = []) {
  return (Array.isArray(discussion) ? discussion : []).map((topic) => {
    if (isReviewerAuthored(topic)) return topic;
    const next = { ...topic };
    for (const kind of ['points', 'decisions', 'openQuestions']) {
      next[kind] = (topic[kind] || []).map((record) => stripMinorCommunicationCourtesy(record, sourceUnits))
        .filter(Boolean).map((record) => ({
          ...record,
          supportingDetails: (record.supportingDetails || [])
            .map((detail) => stripMinorCommunicationCourtesy(detail, sourceUnits)).filter(Boolean)
        }));
    }
    return next;
  }).filter((topic) => topic.points.length || topic.decisions.length || topic.openQuestions.length);
}

function looksLikeStandaloneHeadingFragment(value = '', topic = '') {
  const text = meetingMinutesAgentText(value, 300).trim();
  if (!text || /[.?!]$/.test(text) || /[$£€%\d]/.test(text)) return false;
  const words = text.match(/[\p{L}][\p{L}'’/-]*/gu) || [];
  if (words.length < 2 || words.length > 6) return false;
  const titleCase = words.filter((word) => /^\p{Lu}/u.test(word)).length / words.length >= 0.8;
  const repeatsTopic = topic && hybridContentTokenOverlap(text, topic) >= 0.8;
  return titleCase || repeatsTopic;
}

function removeHeadingFragmentsFromDiscussion(discussion = []) {
  return (Array.isArray(discussion) ? discussion : []).map((topic) => {
    if (isReviewerAuthored(topic)) return topic;
    const next = { ...topic };
    for (const kind of ['points', 'decisions', 'openQuestions']) {
      next[kind] = (topic[kind] || []).filter((record) =>
        hasMeetingAgentReviewerContent(record) || !looksLikeStandaloneHeadingFragment(record?.text, topic?.topic)).map((record) => ({
          ...record,
          supportingDetails: (record.supportingDetails || []).filter((detail) =>
            isReviewerAuthored(record) || isReviewerAuthored(detail) || (completeDiscussionSuggestionText(detail?.text || detail)
            && !looksLikeStandaloneHeadingFragment(detail?.text || detail, topic?.topic)))
        }));
    }
    return next;
  }).filter((topic) => topic.points.length || topic.decisions.length || topic.openQuestions.length);
}

const DISCUSSION_PROPOSITION_PREDICATE = /\b(?:am|is|are|was|were|be|been|being|has|have|had|will|would|shall|should|can|could|may|might|must|remain(?:s|ed)?|include(?:s|d)?|require(?:s|d)?|depend(?:s|ed)?|use(?:s|d)?|contain(?:s|ed)?|provide(?:s|d)?|support(?:s|ed)?|cover(?:s|ed)?|continue(?:s|d)?|start(?:s|ed)?|end(?:s|ed)?|need(?:s|ed)?|allow(?:s|ed)?|prevent(?:s|ed)?|indicate(?:s|d)?|show(?:s|ed)?|mean(?:s|t)?|agree(?:s|d)?|decid(?:e|es|ed)|confirm(?:s|ed)?|approv(?:e|es|ed)|identif(?:y|ies|ied)|report(?:s|ed)?|note(?:s|d)?|review(?:s|ed)?|discuss(?:es|ed)|complete(?:s|d)?|pass(?:es|ed)?|block(?:s|ed)?|delay(?:s|ed)?|move(?:s|d)?|plan(?:s|ned)?|schedul(?:e|es|ed)|expect(?:s|ed)?|accept(?:s|ed)?|load(?:s|ed)?|finish(?:es|ed)|fail(?:s|ed)?|pending|underway|available|unresolved)\b/i;

function completeDiscussionSuggestionText(value = '') {
  const source = meetingMinutesAgentText(value, 1600).trim();
  const words = source.match(/[\p{L}\p{N}][\p{L}\p{N}'’/-]*/gu) || [];
  // Suggestions are optional editorial changes, so they can meet a stricter
  // presentation bar than extraction candidates: a complete sentence or
  // question must carry terminal punctuation. Headings characteristically do
  // not, even when one of their nouns can also be read as a verb.
  if (words.length < 3 || !/[.?!]$/.test(source)) return false;
  return /\?$/.test(source) || DISCUSSION_PROPOSITION_PREDICATE.test(source);
}

module.exports = {
  completeDiscussionSuggestionText,
  hasMeetingAgentReviewerContent,
  looksLikeStandaloneHeadingFragment,
  meetingAgentDraftForDocx,
  meetingAgentDraftForPdf,
  meetingAgentPublicationContent,
  minorCommunicationCourtesy,
  normaliseMeetingAgentMinuteNumbers,
  removeHeadingFragmentsFromDiscussion,
  removeMinorCommunicationCourtesyDiscussion,
  removeWithheldGeneratedDiscussion,
  stripMinorCommunicationCourtesy
};
