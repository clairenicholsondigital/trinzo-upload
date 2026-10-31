'use strict';

const TimingIntegrity = require('./meetingMinutesTiming');
const { text } = require('./meetingMinutesText');
const { contentTokens } = require('./meetingMinutesRecordMatching');
const { nameParts, speakerIsOwner, OWNER_FIRST_PERSON } = require('./meetingMinutesPeopleEvidence');
const {
  evidenceWindowUnits, evidenceSupportScore, resolutionTokens, evidenceContextFor, materialTokens,
  comparisonText, evidenceWindowText
} = require('./meetingMinutesEvidenceContext');
const { predicateSupportsAction, commitmentQuoteAboutAction } = require('./meetingMinutesActionSourceMatching');
const {
  ACTION_COMMITMENT_PATTERN, ACTION_CONCRETE_INTENTION_PATTERN, NAMED_WILL_PATTERN
} = require('./meetingMinutesActionEvidence');
const { NOVELTY_STOP_WORDS } = require('./meetingMinutesEvidenceChecks');

function timingFrom(item = {}, options = {}) {
  const supplied = item.timing && typeof item.timing === 'object' ? item.timing : {};
  if (options.preserveReviewerEdits === true) return TimingIntegrity.normaliseTimingValue(supplied, { mode: 'preserve', reviewerAuthored: true });
  let wording = text(supplied.wording || item.deadline || item.target, 220);
  let kind = ['deadline', 'target', 'dependency', 'not_stated'].includes(supplied.kind) ? supplied.kind : 'not_stated';
  // "As soon as Christina is back" is a condition, not a date: whatever kind
  // was supplied, a purely conditional wording with no day or date in it is a
  // dependency.
  const conditional = /^(?:as soon as|once|after|when|following|upon|subject to|dependent on|depends on|pending)\b/i.test(wording.trim())
    && !/\b(?:today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month|january|february|march|april|may|june|july|august|september|october|november|december|\d)\b/i.test(wording);
  const urgent = /\b(?:as soon as possible|asap|as soon as you can|as soon as we can)\b/i.test(wording);
  if (conditional && !urgent && (kind === 'deadline' || kind === 'target')) kind = 'dependency';
  // "By the end of the week, hopefully" is a hope, not a deadline.
  if (kind === 'deadline' && /\b(?:hopefully|ideally|aim(?:ing)? (?:for|to)|try(?:ing)? to|should be|expected|expect(?:ing)?|possibly|maybe|all being well|fingers crossed|if (?:we|all) can)\b/i.test(wording)) kind = 'target';
  if (kind === 'not_stated' && wording) {
    kind = !urgent && /\b(?:as soon as|once|after|when|following|subject to|dependent on|depends on)\b/i.test(wording)
      ? 'dependency'
      : (/\b(?:target|aim|ideally|provisional|expected|this week|next week)\b/i.test(wording) ? 'target' : 'deadline');
  }
  wording = wording.replace(/^(?:target|deadline)\s*:\s*/i, '');
  return TimingIntegrity.normaliseTimingValue({ ...supplied, kind, wording }, {
    meetingDate: options.meetingDate,
    mode: options.timingMode === 'derive' ? 'derive' : 'preserve',
    reviewerAuthored: options.preserveReviewerEdits === true
  });
}

// Timing is otherwise entirely model-supplied, so when the model returned
// nothing for "let me order six sacks today" the same-day wording was lost for
// good. Recover only plain relative-day phrases, only from the cited units
// themselves (never a neighbouring turn), and only where that unit reads as a
// commitment rather than narration ("we discussed today").
const CITED_TIMING_PHRASE = /\b(?:today|tonight|tomorrow(?:\s+(?:morning|afternoon))?|this\s+(?:morning|afternoon|evening|week)|next\s+week|end\s+of\s+(?:this\s+|next\s+)?week|(?:this\s+|next\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+(?:morning|afternoon|evening))?)\b(?!['’]s)/i;

const CITED_TIMING_COMMITMENT_CUE = /\blet\s+(?:me|us)\b|\blet's\b/i;

// "How long is it?" asks for a duration, not a due date, and is deliberately
// not a when-question: "about two days of test time" is not a deadline.
// "Who traces it?" "That'd be me." "By when?" "Two weeks." The answer to a
// when-question sits in its own short turn, outside the cited commitment. When
// an action has no timing, a when-question inside its exchange whose reply
// (within the next two rows) names a time supplies it.
const WHEN_QUESTION = /\b(?:by when|when by|when (?:can|will|could|would|do|does|did|should|might) (?:you|that|it|we|he|she|they)|when do you (?:think|reckon|expect)|what(?:'s| is) the (?:date|deadline|timescale|timeline|timing)|what sort of time(?:scale|frame|line)|(?:any idea|roughly) when|how soon|when for|when(?:'s| is| would| will) (?:that|it|this) (?:be|due|going to|likely|for)|(?:timeline|timescale|timeframe|time frame|eta) (?:on|for) (?:that|this|it|those|these))\b/i;

// The asker can be the one who settles it: "And when do you think, Dermot?"
// ... "Okay so that's the fifteenth. I'll put it in as the fifteenth." A row
// from the asker counts only when it reads as settling the date, never when
// it is another question.
const SETTLES_TIMING = /\b(?:so that(?:'s| is)|let(?:'s| us) (?:say|call it|put|go with)|put (?:it|that) (?:in|down) (?:as|for)|call it|we(?:'ll| will) say|pencil(?:led)? (?:it |that )?in|go with|make it)\b/i;

const ANSWER_TIMING = /\b(?:today|tonight|tomorrow(?: morning| afternoon)?|this week|next week|end of (?:the |this |next )?week|(?:the )?(?:rest|remainder) of (?:the |this )?week|(?:this |next )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|a fortnight|(?:in |within )?(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d{1,2}) (?:days?|weeks?|months?)|(?:by |on )?the (?:\d{1,2}(?:st|nd|rd|th)?|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|twenty-?\w+|thirtieth|thirty-?first)|\d{1,2}(?:st|nd|rd|th)? (?:of )?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*)\b/i;

// Does the answer name what it is about before the time? "The three new DIs,
// this week" does; "Okay so that's the fifteenth" and "It'll be Friday though"
// do not - what is left once the fillers go is nothing.
const ANSWER_LEAD_FILLER = /\b(?:okay|ok|yeah|yes|yep|right|well|so|actually|probably|maybe|hopefully|ideally|erm|um|that(?:'s|’s| is| would be| will be| should be)?|it(?:'s|’s|'ll|’ll| is| will| would| should| could)?(?: be)?|i(?:'ll|’ll| will| would| can| think| reckon| would say)?|we(?:'ll|’ll| will| would| can| could)?|let(?:'s|’s| us)|put (?:it|that) (?:in|down) (?:as|for)|call it|say|go with|make it|by|on|for|the|a|an|at|in|then|about|around|roughly|be|is|was|and|of|to)\b/gi;

function answerNamesSubject(lead = '') {
  return contentTokens(String(lead || '').replace(ANSWER_LEAD_FILLER, ' ')).length > 0;
}

const UNKNOWN_TIMING_ANSWER = /\b(?:don['’]t know|do not know|no idea|not sure|couldn['’]t say|can['’]t say|hard to say|it depends|could be [^.,;]{1,40} or (?:it )?could be)\b/i;

function timingRecoveryBlocked(decision = {}) {
  return ['rejected', 'needs_rebind'].includes(decision?.status)
    || Boolean(decision?.rejectedWordings?.length || decision?.rejectedExactDates?.length);
}

function sourceRecoveredTiming(wording, options = {}) {
  return TimingIntegrity.normaliseTimingValue(timingFrom({ timing: { wording } }, options), {
    meetingDate: options.meetingDate, mode: 'derive'
  });
}

// Adding a timing is stricter than retaining a model/reviewer value for review.
// Shared citations and an owner name do not establish which work a date belongs
// to. Every inferred value needs its own source-bound work/actor proof.
function timingRecoveryIssue(options, ambiguous = false) {
  if (!Array.isArray(options.timingRecoveryIssues)) return;
  const code = ambiguous ? 'timing_inference_ambiguous' : 'timing_inference_unresolved';
  if (options.timingRecoveryIssues.some(issue => issue.code === code)) return;
  options.timingRecoveryIssues.push({ code, preserveValue: true,
    message: ambiguous
      ? 'Several source timings remain possible for this action; no single timing was added. Confirm the agreed timing.'
      : 'A source timing was not added because its link to this action and owner could not be established. Confirm this action’s own timing.' });
}

function timingRecoveryContext(options = {}) {
  return Boolean(text(options.action) && Array.isArray(options.owners) && options.owners.length);
}

function timingSourceClauses(value = '') {
  return String(value).split(/[,;]|(?<=[.!?])\s+|\b(?:and|but|then)\s+(?=(?:I['’]ll|I will|we will|[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+(?:will|shall|to))\b)/)
    .map(value => value.trim()).filter(Boolean);
}

function qualifiedTimingPhrase(phrase, clause) {
  const at = String(clause).toLowerCase().indexOf(String(phrase).toLowerCase());
  if (at < 0) return '';
  const prefix = clause.slice(0, at).match(/(?:(?:\b(?:by|before|after|within|until|from|probably|presumably|possibly|maybe|perhaps|hopefully|ideally|preferably|approximately|roughly|around|about|early|late)|\b(?:no earlier than|not before|no later than|not later than|at least|at the earliest))\s+)+$/i)?.[0] || '';
  const suffix = clause.slice(at + phrase.length).match(/^\s*(?:,?\s*(?:all being well|if possible|at least|at the latest))\b/i)?.[0] || '';
  return `${prefix}${phrase}${suffix}`.toLowerCase().replace(/\s+/g, ' ').trim();
}

function sourceBoundRecoveredTiming(phrase, units, evidenceIds, carrier, options = {}, structuralProof = false) {
  if (!timingRecoveryContext(options)) { timingRecoveryIssue(options); return null; }
  const clauses = timingSourceClauses(carrier?.text);
  for (const [clauseIndex, clause] of clauses.entries()) {
    const followingQualifier = /^(?:all being well|if possible|at least|at the latest)[.!?]*$/i.test(clauses[clauseIndex + 1] || '') ? clauses[clauseIndex + 1] : '';
    const timingClause = followingQualifier ? `${clause} ${followingQualifier}` : clause;
    const wording = qualifiedTimingPhrase(phrase, timingClause);
    if (!wording) continue;
    const timing = sourceRecoveredTiming(wording, options);
    const actorNamed = options.owners.some(owner => {
      const first = nameParts(owner)[0];
      return first && new RegExp(`\\b${first}\\s+(?:will|shall|must|is to|is going to)\\b`, 'i').test(clause);
    });
    const temporalOnly = !clause.toLowerCase().replace(phrase.toLowerCase(), ' ').replace(ANSWER_LEAD_FILLER, ' ').replace(/[^\p{L}\p{N}]+/gu, '');
    const ownPromise = speakerIsOwner(carrier.speaker, options.owners)
      && (/^\s*(?:(?:yeah|yes|okay|ok|right|well|so|sure|no problem)\s+)*(?:I(?:['’]ll| will| shall| can| must| need to| have to| am going to)\b|let me\b|leave (?:it|that|this) with me\b)/i.test(clause)
        || temporalOnly);
    if (!structuralProof && !ownPromise && !actorNamed) continue;
    // Check the actual carrying clause. A second operation/date in the same
    // source row must not satisfy the calendar check for this one. A purely
    // temporal comma continuation retains only its nearest preceding clause.
    const proofText = temporalOnly && clauseIndex > 0 ? `${clauses[clauseIndex - 1]}, ${clause}` : clause;
    const proofUnits = units.map(unit => unit.id === carrier.id ? { ...unit, text: proofText } : unit);
    const row = { action: options.action, owners: options.owners, timing, evidenceIds };
    const binding = TimingIntegrity.assessTimingSourceBinding(row, proofUnits, { meetingDate: options.meetingDate });
    if (!structuralProof && (binding.status !== 'supported' || !binding.matchedSourceIds.includes(carrier.id))) continue;
    // A date can be correctly linked yet overstate "probably Friday", omit a
    // bound/dependency, or lose a second date. Keep only a lossless expression.
    // Loaded lazily because the summary review module also consumes V2 helpers.
    const { temporalMeaningRetained } = require('./meetingMinutesTemporalReview');
    if (!temporalMeaningRetained(wording, timingClause, { meetingDate: options.meetingDate })) continue;
    const workAnchors = evidenceWindowUnits(units, evidenceIds, 0)
      .filter(unit => predicateSupportsAction(options.action, unit.text)
        && (speakerIsOwner(unit.speaker, options.owners) || options.owners.some(owner => nameParts(owner).some(name => new RegExp(`\\b${name}\\b`, 'i').test(unit.text)))))
      .sort((left, right) => evidenceSupportScore(options.action, right.text) - evidenceSupportScore(options.action, left.text))
      .slice(0, 2).map(unit => unit.id);
    return { timing, evidenceIds: [...new Set([...evidenceIds, carrier.id, ...(binding.matchedSourceIds || [])])],
      requiredEvidenceIds: [...new Set([carrier.id, ...(binding.matchedSourceIds || []), ...workAnchors])] };
  }
  timingRecoveryIssue(options);
  return null;
}

function recoveredTimingEvidence(ids, recovered) {
  if (!recovered.length) return ids;
  const merged = [...new Set([...ids, ...recovered])];
  if (merged.length <= 8) return merged;
  const selected = new Set([...new Set([...recovered, ...ids])].slice(0, 8));
  return merged.filter(id => selected.has(id));
}

function chooseRecoveredTiming(candidates, original, options = {}) {
  const byTiming = new Map();
  for (const candidate of candidates.filter(Boolean)) {
    const key = JSON.stringify(candidate.timing);
    if (!byTiming.has(key)) byTiming.set(key, candidate);
  }
  const unique = [...byTiming.values()];
  if (unique.length !== 1) {
    if (unique.length > 1) timingRecoveryIssue(options, true);
    return original;
  }
  if (Array.isArray(options.recoveredTimingEvidenceIds)) options.recoveredTimingEvidenceIds.push(...(unique[0].requiredEvidenceIds || unique[0].evidenceIds));
  return unique[0].timing;
}

function inferenceSubjectWords(value) {
  return resolutionTokens(value).filter(word => !['the', 'and', 'new', 'can', 'you', 'do', 'think', 'reckon', 'expect', 'will', 'shall', 'draft', 'write', 'written', 'create', 'prepare', 'produce', 'generate', 'send', 'hold', 'arrange', 'schedule', 'review', 'check', 'place', 'order'].includes(word));
}

function timingQuestionBound(question, rows, options) {
  if (!timingRecoveryContext(options)) return false;
  const known = evidenceContextFor(rows).speakers.filter(name => new RegExp(`\\b${nameParts(name)[0]}\\b`, 'i').test(question.text));
  const vocatives = [...String(question.text).matchAll(/(?:,\s*|^\s*(?:And\s+)?)([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s*(?=,|[?!]?$)/g)].map(match => match[1]);
  if ([...known, ...vocatives].some(name => !speakerIsOwner(name, options.owners))) return false;
  let remaining = String(question.text).replace(WHEN_QUESTION, ' ');
  for (const owner of options.owners) for (const name of nameParts(owner)) remaining = remaining.replace(new RegExp(`\\b${name}\\b`, 'gi'), ' ');
  const actionWords = new Set(inferenceSubjectWords(options.action));
  const subjects = inferenceSubjectWords(remaining).filter(word => !['date', 'deadline', 'time', 'timing', 'timescale', 'timeline', 'timeframe', 'eta', 'sort', 'soon', 'roughly', 'idea', 'finish', 'complete'].includes(word));
  if (subjects.some(word => !actionWords.has(word))) return false;
  const operation = String(question.text).match(/\bwhen\s+(?:can|will|could|would|do|does|should|might)\s+(?:you|we|he|she|they)\s+([a-z]+)/i)?.[1];
  if (operation && !/^(?:do|be|think|reckon|expect|finish|complete)$/.test(operation)
    && !predicateSupportsAction(options.action, question.text)
    && operation.toLowerCase() !== String(options.action).toLowerCase().split(/\s+/)[0]) return false;
  return true;
}

function askedTimingStructureBound(options, rows, questionAt, replyAt, evidenceIds, phrase) {
  if (!timingRecoveryContext(options)) return false;
  const question = rows[questionAt], reply = rows[replyAt], wanted = new Set(evidenceIds);
  const owners = options.owners, action = options.action;
  if (!timingQuestionBound(question, rows, options)) return false;
  const lead = String(reply.text).slice(0, String(reply.text).toLowerCase().indexOf(phrase.toLowerCase()));
  const actionWords = new Set(inferenceSubjectWords(action));
  if (answerNamesSubject(lead)) {
    // An output named by the owner can answer its own when-question without
    // repeating "create". Every named object/quantity must match, and an
    // earlier obligation must explicitly require that new output.
    if (!speakerIsOwner(reply.speaker, owners) || !/^(?:create|prepare|produce|generate|draft|write)\b/i.test(action)
      || !/\bnew\b/i.test(lead)) return false;
    const tail = String(reply.text).slice(String(reply.text).toLowerCase().indexOf(phrase.toLowerCase()) + phrase.length)
      .replace(/\b(?:all being well|if possible|at least|at the latest)\b/gi, ' ').replace(/[^\p{L}\p{N}]+/gu, '');
    if (tail) return false;
    const objects = inferenceSubjectWords(lead);
    if (!objects.length || objects.some(word => !actionWords.has(word))) return false;
    return rows.slice(Math.max(0, questionAt - 8), questionAt).some(unit => speakerIsOwner(unit.speaker, owners)
      && /\bneeds?\s+new\b/i.test(unit.text)
      && objects.filter(word => !/^\d+$|^(?:one|two|three|four|five|six|seven|eight|nine|ten)$/.test(word))
        .every(word => inferenceSubjectWords(unit.text).includes(word)));
  }
  // A requester may read a date back after an owner's explicit "I'll draft
  // that". Only this bounded, purely temporal settlement has that exception;
  // the original cited deliverable and the owner's operation are both needed.
  if (reply.speaker !== question.speaker || !SETTLES_TIMING.test(reply.text)) return false;
  const remainder = String(reply.text).replace(phrase, ' ').replace(ANSWER_LEAD_FILLER, ' ').replace(/[^\p{L}\p{N}]+/gu, '');
  if (remainder) return false;
  const ownAt = rows.slice(Math.max(0, questionAt - 3), questionAt).map((unit, offset) => ({ unit, at: Math.max(0, questionAt - 3) + offset }))
    .filter(({ unit }) => wanted.has(unit.id) && speakerIsOwner(unit.speaker, owners)
      && /\bI(?:['’]ll| will| shall)\b/i.test(unit.text) && predicateSupportsAction(action, unit.text)
      && /\b(?:write|draft|prepare|review|check|assess|send|email|share|forward|circulate|contact|call|ring|message)\s+(?:it|that|this)[.!?]*$/i.test(unit.text)).pop();
  if (!ownAt) return false;
  const anchor = rows.slice(Math.max(0, ownAt.at - 3), ownAt.at + 1).some(unit => wanted.has(unit.id)
    && commitmentQuoteAboutAction(unit.text, action, `${unit.speaker}: ${unit.text}`));
  if (!anchor) return false;
  return !rows.slice(ownAt.at + 1, replyAt).some(unit => {
    if (unit === question) return false;
    if (OWNER_FIRST_PERSON.test(unit.text) || ACTION_COMMITMENT_PATTERN.test(unit.text)
      || /\b[A-Z][a-z]+\s+(?:will|shall|must|can|is going to|is responsible for)\b/.test(unit.text)) return true;
    if (/\b(?:I|we)\s+(?:want|need|expect|ask(?:ed)?)\b/i.test(unit.text)) {
      // Reviewing "it" can remain a bridge about the same draft. A named
      // person receiving new concrete work (or an unbound reference) cannot.
      const review = String(unit.text).match(/\b(?:I|we)\s+(?:want|need|expect|ask(?:ed)?)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+to\s+(.+)$/i)?.[1];
      return !review || !/^(?:look over|review|check|read)\s+(?:it|that|this)[.!?]*$/i.test(review.trim());
    }
    return false;
  });
}

function backfillAskedTiming(timing, units = [], evidenceIds = [], options = {}) {
  if (timingRecoveryBlocked(options.timingDecision) || timing.kind !== 'not_stated') return timing;
  const window = evidenceWindowUnits(units, evidenceIds, 3);
  const all = evidenceContextFor(units).rows, candidates = [];
  for (const question of window) {
    if (!WHEN_QUESTION.test(String(question?.text || ''))) continue;
    if (!timingQuestionBound(question, all, options)) { timingRecoveryIssue(options); continue; }
    const at = all.indexOf(question);
    for (const reply of all.slice(at + 1, at + 4)) {
      const spoken = String(reply?.text || '');
      if (reply?.speaker === question?.speaker && (/\?/.test(spoken) || !SETTLES_TIMING.test(spoken))) continue;
      const phrase = spoken.match(ANSWER_TIMING);
      if (!phrase || UNKNOWN_TIMING_ANSWER.test(spoken)) continue;
      const lead = spoken.slice(0, phrase.index);
      if (options.action && answerNamesSubject(lead) && !sharesSubjectWord(options.action, spoken)) continue;
      const replyAt = all.indexOf(reply);
      const contextIds = [...new Set([...evidenceIds, ...all.slice(Math.max(0, at - 3), replyAt + 1).map(unit => unit.id)])];
      const structuralProof = askedTimingStructureBound(options, all, at, replyAt, contextIds, phrase[0]);
      candidates.push(sourceBoundRecoveredTiming(phrase[0], units, contextIds, reply, options, structuralProof));
    }
  }
  return chooseRecoveredTiming(candidates, timing, options);
}

const ASKS_WHEN = new RegExp(`${WHEN_QUESTION.source}|\\b(?:timeline|timescale|timeframe|time frame|eta|when)\\b[^.?!]{0,40}\\?`, 'i');

function sharesSubjectWord(action = '', spoken = '') {
  const words = (value) => new Set(String(value || '').toLowerCase().match(/[a-z][a-z0-9'-]{2,}/g) || []);
  const stop = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'from', 'into', 'then', 'them', 'they', 'those', 'these', 'there', 'their', 'have', 'has', 'will', 'week', 'day', 'days', 'new', 'one', 'two', 'three', 'four', 'five', 'all', 'any', 'are', 'was', 'were', 'been', 'being', 'just', 'also', 'not', 'but', 'yes', 'yeah', 'okay', 'well', 'need', 'needs', 'get', 'got', 'its', 'our', 'your', 'you', 'out', 'about', 'what', 'which', 'when', 'where', 'who', 'how', 'can', 'could', 'should', 'would']);
  const target = [...words(action)].filter((word) => !stop.has(word));
  const source = words(spoken);
  return target.some((word) => source.has(word) || source.has(`${word}s`) || (word.endsWith('s') && source.has(word.slice(0, -1))));
}

// "Let's put the follow-up in for the ninth or the tenth." "The tenth suits
// better." "Tenth." An offered choice of dates is not the timing; the one the
// meeting settled on is. When a later turn in the same exchange names exactly
// one of the offered days, that day becomes the wording.
const OFFERED_DAY_CHOICE = /\b(?:the\s+)?(\d{1,2}(?:st|nd|rd|th)?|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|twenty-?\w+|thirtieth|thirty-?first)\s+or\s+(?:the\s+)?(\d{1,2}(?:st|nd|rd|th)?|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|twenty-?\w+|thirtieth|thirty-?first)\b/i;

function resolveOfferedDateChoice(timing, units = [], evidenceIds = [], options = {}) {
  const wording = String(timing?.wording || ''), offered = wording.match(OFFERED_DAY_CHOICE);
  if (!offered || timingRecoveryBlocked(options.timingDecision)) return timing;
  if (!timingRecoveryContext(options)) { timingRecoveryIssue(options); return timing; }
  const [first, second] = [offered[1], offered[2]].map(day => day.toLowerCase());
  const rows = evidenceWindowUnits(units, evidenceIds, 3);
  const sourceOffer = rows.find(row => evidenceIds.includes(row.id) && OFFERED_DAY_CHOICE.test(row.text));
  const sourceSpan = String(sourceOffer?.text || '').match(OFFERED_DAY_CHOICE)?.[0];
  const sourceTiming = sourceSpan ? { ...timing, wording: wording.replace(OFFERED_DAY_CHOICE, sourceSpan) } : timing;
  const offerBinding = TimingIntegrity.assessTimingSourceBinding({ action: options.action, owners: options.owners, timing: sourceTiming, evidenceIds }, units, { meetingDate: options.meetingDate });
  if (offerBinding.status !== 'supported') { timingRecoveryIssue(options); return timing; }
  const says = (value, day) => new RegExp(`\\b(?:the\\s+)?${day}\\b`, 'i').test(value);
  const offerAt = rows.findIndex(row => evidenceIds.includes(row.id) && OFFERED_DAY_CHOICE.test(row.text));
  if (offerAt < 0) return timing;
  for (const row of rows.slice(offerAt + 1)) {
    const value = String(row.text || ''), picksFirst = says(value, first), picksSecond = says(value, second);
    if (picksFirst === picksSecond) {
      if (!NON_SUBSTANTIVE_TIMING_BRIDGE.test(value)) break;
      continue;
    }
    const chosen = picksFirst ? first : second;
    const remainder = value.replace(new RegExp(`\\b(?:the\\s+)?${chosen}(?:\\s+of\\s+[A-Za-z]+)?\\b`, 'i'), ' ')
      .replace(/\b(?:suits? better|works? better|works?|it is|is better|then|yes|okay|ok|yeah|yep|for me)\b/gi, ' ')
      .replace(/[^\p{L}\p{N}]+/gu, '');
    if (remainder || !speakerIsOwner(row.speaker, options.owners)) { timingRecoveryIssue(options); break; }
    const candidate = timingFrom({ timing: { wording: wording.replace(OFFERED_DAY_CHOICE, chosen) } }, options);
    if (Array.isArray(options.recoveredTimingEvidenceIds)) options.recoveredTimingEvidenceIds.push(row.id, ...offerBinding.matchedSourceIds);
    return candidate;
  }
  return timing;
}

function backfillCitedTiming(timing, units = [], evidenceIds = [], options = {}) {
  if (timingRecoveryBlocked(options.timingDecision) || timing.kind !== 'not_stated') return timing;
  const candidates = [];
  for (const unit of evidenceWindowUnits(units, evidenceIds, 0)) {
    const source = String(unit.text || '');
    if (!ACTION_COMMITMENT_PATTERN.test(source) && !ACTION_CONCRETE_INTENTION_PATTERN.test(source)
      && !NAMED_WILL_PATTERN.test(source) && !CITED_TIMING_COMMITMENT_CUE.test(source)) continue;
    for (const match of source.matchAll(new RegExp(CITED_TIMING_PHRASE.source, 'gi'))) {
      candidates.push(sourceBoundRecoveredTiming(match[0], units, evidenceIds, unit, options));
    }
  }
  return chooseRecoveredTiming(candidates, timing, options);
}

const NON_SUBSTANTIVE_TIMING_BRIDGE = /^(?:thank(?:s| you)|okay|ok|yeah|yes|yep|right|perfect|great|fine|mhm|mm)[.!?, ]*$/i;

// The timing-ownership rule is kept separate and off. It corrects the
// evaluation's example sentences, but on 131 timed actions from live meetings
// it produced no clearly correct change and several wrong ones.
function timingClauseChecksEnabled() {
  return /^(?:1|true|yes|on)$/i.test(String(process.env.MEETING_MINUTES_AGENT_TIMING_CLAUSE_V1 || '0'));
}

// Sentences and "and then"/"then" steps of the cited passage. Transcripts
// often lose the space after a full stop ("successfully.Across").
function evidenceClauses(value) {
  return String(value || '')
    .replace(/([.!?;])(?=[A-Za-z])/g, '$1 ')
    .split(/(?<=[.!?;])\s+/)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 3);
}

const TIMING_TOKEN = /^(?:today|tonight|tomorrow|week|weeks|end|next|morning|afternoon|evening|monday|tuesday|wednesday|thursday|friday|saturday|sunday|month|day|days|hopefully|before|this)$/;

// A timing phrase belongs to the step it was spoken with. "Bottomed out by
// the end of the week ... the two code changes completed by the end of next
// week": the code-change action takes the second phrase, not the first. When
// the clause holding the action's timing barely mentions the action while
// another cited clause clearly describes it, the timing is reassigned to that
// clause's own phrase, or removed when that clause states none.
function timingClauseIssue(action, timing = {}, units = [], evidenceIds = []) {
  const wording = text(timing.wording, 220).toLowerCase().replace(/\s+/g, ' ');
  // Conditions ("once I get finished", "when Christina is back") are spoken in
  // their own clause by nature; only dates and deadlines are checked.
  if (!wording || !['deadline', 'target'].includes(timing.kind) || !evidenceIds.length) return null;
  const actionTokens = [...new Set(materialTokens(comparisonText(action)))]
    .filter((token) => !TIMING_TOKEN.test(token) && !NOVELTY_STOP_WORDS.has(token));
  if (actionTokens.length < 3) return null;
  const scored = evidenceClauses(evidenceWindowText(units, evidenceIds, 1)).map((clause) => {
    const words = new Set(contentTokens(comparisonText(clause)));
    return { clause, lower: clause.toLowerCase().replace(/\s+/g, ' '), score: actionTokens.filter((token) => words.has(token)).length };
  });
  const own = scored.filter((item) => item.lower.includes(wording));
  if (!own.length) return null;
  // "Should be able to get that done next week": the clause names the work
  // only by pronoun, so the sentences just before it are part of its subject.
  const ANAPHORA = /\b(?:that|this|it|those|them|these)\b/i;
  const ownScore = Math.max(...own.map((item) => {
    if (item.score > 0 || !ANAPHORA.test(item.clause)) return item.score;
    const at = scored.indexOf(item);
    const context = scored.slice(Math.max(0, at - 2), at + 1).map((entry) => entry.clause).join(' ');
    const words = new Set(contentTokens(comparisonText(context)));
    return actionTokens.filter((token) => words.has(token)).length;
  }));
  if (ownScore > 1) return null;
  const best = scored.filter((item) => !item.lower.includes(wording)).sort((left, right) => right.score - left.score)[0];
  if (!best || best.score < 2 || best.score <= ownScore) return null;
  const phrases = [...best.clause.matchAll(new RegExp(CITED_TIMING_PHRASE.source, 'gi'))]
    .map((match) => match[0].toLowerCase().replace(/\s+/g, ' '))
    .sort((left, right) => right.length - left.length);
  const replacement = phrases[0];
  // Only a clear reassignment is acted on: another cited clause states its
  // own timing and plainly describes this action. When that clause states no
  // timing, the original is left alone; on live meetings removal guessed wrong
  // more often than right ("get that done for Wednesday", "a call with Cody
  // this evening" were the action's own timing).
  if (replacement && replacement !== wording) return { type: 'reassign', from: timing.wording, to: replacement };
  return null;
}

function dateWordingVariants(exactDate = '') {
  const match = String(exactDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return [];
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const day = Number(match[3]);
  const suffix = day % 10 === 1 && day % 100 !== 11 ? 'st' : day % 10 === 2 && day % 100 !== 12 ? 'nd' : day % 10 === 3 && day % 100 !== 13 ? 'rd' : 'th';
  const month = months[Number(match[2]) - 1];
  if (!month) return [];
  return [
    `${day}${suffix} ${month}`,
    `${day}${suffix} of ${month}`,
    `${day} ${month}`,
    `${month} ${day}${suffix}`,
    `${month} ${day}`
  ];
}

function replaceEmbeddedTiming(actionText = '', previousTiming = '', replacementTiming = '', exactDate = '') {
  const source = String(actionText || '').trim();
  const previous = String(previousTiming || '').trim();
  if (!source || !previous) return source;
  const candidates = [...new Set([previous, ...dateWordingVariants(exactDate)])]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'));
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}'’])(?:\\b(?:by|on|before|after|during|in|within|from|until|no later than)\\s+)?(?:the\\s+)?(?:${candidates.join('|')})(?![\\p{L}\\p{N}'’])`, 'iu');
  if (!pattern.test(source)) return source;
  const replacement = String(replacementTiming || '').trim();
  let revised = source.replace(pattern, replacement);
  revised = revised
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/,\s*(and|then)\b/gi, ' $1')
    .replace(/\b(and|then)\s+(?:and|then)\b/gi, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/^\s*[,;:]\s*/, '')
    .replace(/\s+([.?!])$/, '$1')
    .trim();
  return revised || source;
}

// Application-derived timing in cached action candidates is versioned separately
// from the shared source assessment policy and the Microsoft response schema.
const TIMING_INFERENCE_POLICY_VERSION = 1;

module.exports = {
  ANSWER_TIMING,
  ASKS_WHEN,
  CITED_TIMING_PHRASE,
  NON_SUBSTANTIVE_TIMING_BRIDGE,
  UNKNOWN_TIMING_ANSWER,
  answerNamesSubject,
  backfillAskedTiming,
  backfillCitedTiming,
  dateWordingVariants,
  evidenceClauses,
  recoveredTimingEvidence,
  replaceEmbeddedTiming,
  resolveOfferedDateChoice,
  sharesSubjectWord,
  sourceBoundRecoveredTiming,
  sourceRecoveredTiming,
  timingClauseChecksEnabled,
  timingClauseIssue,
  timingFrom,
  timingRecoveryBlocked,
  TIMING_INFERENCE_POLICY_VERSION
};
