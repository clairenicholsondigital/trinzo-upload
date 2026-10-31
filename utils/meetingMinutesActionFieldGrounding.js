'use strict';

const {
  evidenceContextFor, materialTokens, evidenceWindowUnits, comparisonText, evidenceWindowText
} = require('./meetingMinutesEvidenceContext');
const {
  mentionedPeople, canonicalSpeakerDisplayName, ownerIdentityTokens, ownerIdentityKey,
  normaliseOwnerIdentity, assignsWorkTo, addressedRequestTo, speakerIsOwner, actionSubjectWords,
  OWNER_FIRST_PERSON
} = require('./meetingMinutesPeopleEvidence');
const {
  sourceNamesActionWork, currentOwnerWork, ACTION_SOURCE_TOPIC_CHANGE, predicateSupportsAction,
  actionSourceSubjects, isHabitualPromise
} = require('./meetingMinutesActionSourceMatching');
const { contentTokens, COMMON_SPEECH_WORDS } = require('./meetingMinutesRecordMatching');
const {
  actionEvidenceDisposition, actionPredicateSupported, ACTION_VERB_GROUPS
} = require('./meetingMinutesActionEvidence');
const { hasTimingSignal, CALENDAR_TIMING } = require('./meetingMinutesTimingPublication');
const TimingIntegrity = require('./meetingMinutesTiming');
const { NON_SUBSTANTIVE_TIMING_BRIDGE, ASKS_WHEN } = require('./meetingMinutesActionTimingInference');

// Lexical evidence resolution favours the turn that names the deliverable
// ("Six sacks of Maris Otter, thirty-two pounds a sack") over the turn where
// the owner takes the job on ("leave that with me, I'll order six sacks
// today"). The reviewer needs the second one: it carries the ownership, the
// timing and the commitment itself. When such a turn sits within a few turns
// of the cited passage, add it to the citation. Additive only.
const COMMITMENT_ANCHOR_RADIUS = 18;

// Preserve only an already supplied, bounded assignment/ongoing-work exchange.
// This is citation provenance, not an ownership or semantic coverage verdict.
// Unrelated supplied citations still take the existing remapping path.
function connectedSuppliedActionEvidence(action, owners, units, suppliedIds) {
  const context = evidenceContextFor(units);
  const supplied = [...new Set(suppliedIds || [])].filter(id => context.known.has(id));
  if (!owners.length || !supplied.length || supplied.length > 8) return [];
  if (supplied.some(id => context.rows.filter(row => row.id === id).length !== 1)) return [];
  const namedAssignment = value => owners.some(owner => {
    if (!context.connectedActionGivenIdentities) {
      context.connectedActionGivenIdentities = new Map();
      for (const name of [...context.speakers, ...mentionedPeople(units)]) {
        const display = canonicalSpeakerDisplayName(name), first = ownerIdentityTokens(display)[0];
        if (!first) continue;
        const ids = context.connectedActionGivenIdentities.get(first) || new Set();
        ids.add(ownerIdentityKey(display)); context.connectedActionGivenIdentities.set(first, ids);
      }
    }
    const full = normaliseOwnerIdentity(owner, units);
    const first = ownerIdentityTokens(full)[0];
    if (!first || context.connectedActionGivenIdentities.get(first)?.size !== 1) return false;
    const escaped = first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return assignsWorkTo(first, value) || addressedRequestTo(first, value)
      || new RegExp(`\\b${escaped}\\b[^.!?]{0,100}\\byou(?:['’]ll|\\s+will)\\b`, 'i').test(value);
  });
  const retained = new Set();
  for (const id of supplied) {
    const at = context.indexById.get(id), anchor = context.rows[at];
    if (!sourceNamesActionWork(action, anchor.text)) continue;
    const ownAnchor = owners.some(owner => ownerIdentityKey(normaliseOwnerIdentity(owner, units)) === ownerIdentityKey(anchor.speaker));
    if (!ownAnchor && !namedAssignment(anchor.text)) continue;
    for (const otherId of supplied) {
      const other = context.indexById.get(otherId);
      if (Math.abs(other - at) > 2 || !currentOwnerWork(context.rows[other], owners, units)) continue;
      const bridge = context.rows.slice(Math.min(at, other), Math.max(at, other) + 1);
      if (bridge.some(row => ACTION_SOURCE_TOPIC_CHANGE.test(row.text))) continue;
      for (const sourceId of supplied) {
        const index = context.indexById.get(sourceId);
        if (index >= Math.min(at, other) - 2 && index <= Math.max(at, other) + 2
          && !context.rows.slice(Math.min(index, at), Math.max(index, at) + 1)
            .some(row => ACTION_SOURCE_TOPIC_CHANGE.test(row.text))) retained.add(sourceId);
      }
    }
  }
  return supplied.filter(id => retained.has(id));
}

function anchorOwnerCommitment(action, owners = [], units = [], evidenceIds = []) {
  if (!owners.length || !evidenceIds.length) return evidenceIds;
  const cited = new Set(evidenceIds);
  const actionTokens = materialTokens(action);
  if (actionTokens.length < 2) return evidenceIds;
  const evidenceContext = evidenceContextFor(units);
  const citedIndexes = evidenceIds.map((id) => evidenceContext.indexById.get(id)).filter(Number.isInteger);
  const nearby = evidenceWindowUnits(units, evidenceIds, COMMITMENT_ANCHOR_RADIUS)
    .filter((unit) => !cited.has(unit.id) && speakerIsOwner(unit.speaker, owners));
  let best = null;
  for (const unit of nearby) {
    if (!currentOwnerWork(unit, owners, units)) continue;
    const unitTokens = new Set(contentTokens(unit.text));
    const shared = actionTokens.filter((token) => unitTokens.has(token)).length;
    const predicateMatch = predicateSupportsAction(action, unit.text);
    // A later "I'll review that" can carry the commitment while the intervening
    // turns continue naming the work. An explicit different subject or a topic
    // change breaks that link; the operation alone is never sufficient.
    const at = evidenceContext.indexById.get(unit.id);
    const anaphoric = predicateMatch && !actionSourceSubjects(unit.text).size && citedIndexes.some(index => {
      const bridge = evidenceContext.rows.slice(Math.min(index, at) + 1, Math.max(index, at));
      return (sourceNamesActionWork(action, evidenceContext.rows[index].text)
        || bridge.some(row => sourceNamesActionWork(action, row.text)))
        && bridge.every(row => !ACTION_SOURCE_TOPIC_CHANGE.test(row.text)
          && (!actionSourceSubjects(row.text).size || sourceNamesActionWork(action, row.text)));
    });
    if (!sourceNamesActionWork(action, unit.text, true) && !anaphoric) continue;
    if (shared < 2 && !predicateMatch) continue;
    const disposition = actionEvidenceDisposition(action, `${unit.speaker}: ${unit.text}`);
    if (!['committed', 'accepted_request', 'conditional_commitment'].includes(disposition)) continue;
    const distance = citedIndexes.length && Number.isInteger(at)
      ? Math.min(...citedIndexes.map((index) => Math.abs(index - at))) : COMMITMENT_ANCHOR_RADIUS;
    const score = shared * 10 + Number(predicateMatch) * 8 - distance;
    if (!best || score > best.score) best = { id: unit.id, score };
  }
  if (!best) return evidenceIds;
  return [...evidenceIds, best.id].slice(0, 8);
}

// Noun-heavy turns are useful evidence for the work; short answers often carry
// its owner, acceptance and timing. Keep those supplied field anchors when
// lexical remapping prefers a different description of the same work. A timing
// answer needs a connected owner commitment/when-question exchange, rather than
// merely being a nearby date belonging to another task.
function retainSuppliedActionFieldEvidence(action, owners, units, suppliedIds, resolvedIds, timing = {}, options = {}) {
  const context = evidenceContextFor(units);
  const subjects = new Set(actionSubjectWords(action));
  const hasSubject = (value) => [...new Set(contentTokens(value))].filter((word) => subjects.has(word)).length >= 2;
  const citationText = value => comparisonText(value).replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
  const timingWording = citationText(timing?.wording || '');
  const timingWords = timingWording.split(' ').filter(Boolean);
  const orderedTimingWords = value => {
    const words = citationText(value).split(' ').filter(Boolean);
    let at = 0;
    for (const word of timingWords) {
      at = words.indexOf(word, at);
      if (at < 0) return false;
      at += 1;
    }
    return timingWords.length > 0;
  };
  const timingRelations = value => [...String(value).toLowerCase().matchAll(/\b(?:not before|no earlier than|no later than|not later than|on or before|by|before|after|within|until|once|when|subject to|at least|at most)\b/g)].map(match => match[0]).sort();
  const timingQualifications = value => [...String(value).toLowerCase().matchAll(/\b(?:hopefully|probably|presumably|possibly|maybe|perhaps|ideally|preferably|roughly|approximately|around|about)\b/g)].map(match => match[0]).sort();
  const timingFacets = value => [...new Set(citationText(value).split(' ').filter(word => /^(?:\d+|today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|early|late|mid|morning|afternoon|evening|noon|midnight|this|next|every|each|daily|weekly|monthly|yearly|hours?|days?|weeks?|months?|quarters?|years?|am|pm|utc|gmt|bst|cet|cest)$/i.test(word)))].sort();
  const contradictsNamedOwner = unit => {
    if (!owners.length) return false;
    const value = String(unit.text || '');
    const vocative = value.match(/^\s*(?:And\s+)?([A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+){0,2})\s*,/u)?.[1];
    const named = [...value.matchAll(/\b([A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+){0,2})\s+(?:will|shall|must|to)\s+/gu)].map(match => match[1]);
    if (vocative && !/^(?:Hopefully|Probably|Presumably|Possibly|Maybe|Perhaps|Ideally|Preferably|Well|Right|Okay|Thanks)$/i.test(vocative)) named.push(vocative);
    return named.some(name => !/^(?:I|We|They)$/i.test(name) && !speakerIsOwner(name, owners))
      || /\b(?:I['’]ll|I will|I shall|I am going to)\b/i.test(value) && !speakerIsOwner(unit.speaker, owners);
  };
  // A chair's recap can carry the actual timing while earlier turns describe
  // the work more fully. Retain a supplied direct quotation of that field
  // before the citation cap; its presence remains provenance, not a verdict
  // that the date/owner/operation is correct (the timing checks still decide).
  const directTimingIds = hasTimingSignal(timing?.wording || '') ? [...new Set(suppliedIds || [])].filter(id => {
    const unit = context.rows[context.indexById.get(id)];
    if (!unit || !timingWording) return false;
    if (citationText(unit.text).includes(timingWording)
      && actionPredicateSupported(action, unit.text)
      && contentTokens(unit.text).some(word => subjects.has(word))) return true;
    // The generated timing may omit intervening work words without changing
    // its date, qualification or bound. Keep this supplied field source when
    // all timing words occur in order in one clause naming this operation and
    // an object of this action. This only retains provenance: the shared
    // source-binding policy must still verify it or flag it as unresolved.
    if (contradictsNamedOwner(unit)
      || /\b(?:not|never|cannot|can't|won't|was|were|had|previously|yesterday|ago|last\s+(?:week|month|year))\b/i.test(unit.text)) return false;
    const carryingClause = String(unit.text || '').split(/[,;]|(?<=[.!?])\s+/).some(clause => {
      const timedWork = clause.match(/\bto\s+([^.;!?]+)[.!?]*$/i)?.[1];
      const workSubjects = actionSubjectWords(timedWork || '').filter(word => !timingWords.includes(word)
        && !['least', 'most', 'the', 'that', 'this', 'it', 'them', 'those', 'these'].includes(word));
      return timedWork && workSubjects.length && workSubjects.every(word => subjects.has(word))
        && orderedTimingWords(clause) && actionPredicateSupported(action, timedWork)
        && JSON.stringify(timingRelations(clause)) === JSON.stringify(timingRelations(timing.wording))
        && JSON.stringify(timingQualifications(clause)) === JSON.stringify(timingQualifications(timing.wording))
        && JSON.stringify(timingFacets(clause)) === JSON.stringify(timingFacets(timing.wording));
    });
    if (!carryingClause) return false;
    return TimingIntegrity.assessTimingSourceBinding({ action, owners, evidenceIds: [id], timing }, units, options).status !== 'unsupported';
  }) : [];
  const commitmentObjects = (value) => {
    const generic = new Set(['the', 'and', 'i\'ll', 'will', 'shall', 'can', 'could', 'myself', 'new', 'replacement', 'unit', 'one', 'this', 'that', 'them', 'these', 'those', 'let', 'leave', 'handle', 'take', 'fit', 'pop', 'put']);
    const operations = new Set(ACTION_VERB_GROUPS.flat());
    // Timing and its spoken qualification are not another object. Keep any
    // concrete object named before the time, so a financial-report promise
    // cannot borrow the valve subject just because it is nearby.
    const timingAt = String(value).search(CALENDAR_TIMING);
    const instruction = timingAt >= 0 ? String(value).slice(0, timingAt) : value;
    return actionSubjectWords(instruction)
      .filter((word) => !generic.has(word) && !operations.has(word) && !COMMON_SPEECH_WORDS.has(word));
  };
  const connectedCommitment = (index) => {
    const unit = context.rows[index];
    if (!unit || !speakerIsOwner(unit.speaker, owners)
      || !OWNER_FIRST_PERSON.test(unit.text) || isHabitualPromise(unit.text)) return false;
    if (hasSubject(unit.text)) return true;
    const objects = commitmentObjects(unit.text);
    // A nearby promise explicitly naming a different object starts another
    // task; the earlier subject in the surrounding window cannot lend its
    // identity backwards to that promise or its subsequent timing answer.
    if (objects.some((word) => !subjects.has(word))) return false;
    if (objects.length && objects.some((word) => subjects.has(word))) return true;
    return hasSubject(evidenceWindowText(units, [unit.id], 4));
  };
  const timingOnlyAnswer = (unit) => {
    if (!unit || !hasTimingSignal(unit.text)) return false;
    const remainder = String(unit.text).replace(new RegExp(CALENDAR_TIMING.source, 'gi'), ' ')
      .replace(/\b(?:probably|possibly|ideally|around|about|roughly|the|of|at|and|or|yes|yeah|okay|ok)\b/gi, ' ')
      .replace(/[^a-z]+/gi, '').trim();
    return !remainder;
  };
  const timingAnswer = (index) => {
    const unit = context.rows[index];
    const referentialTimedPromise = unit && hasTimingSignal(unit.text)
      && OWNER_FIRST_PERSON.test(unit.text) && !commitmentObjects(unit.text).length;
    if (!unit || !speakerIsOwner(unit.speaker, owners) || (!timingOnlyAnswer(unit) && !referentialTimedPromise)) return false;
    for (let before = index - 1; before >= Math.max(0, index - 3); before -= 1) {
      const prior = context.rows[before];
      if (NON_SUBSTANTIVE_TIMING_BRIDGE.test(prior.text)) continue;
      if (connectedCommitment(before)) return true;
      if (!ASKS_WHEN.test(prior.text)) return false;
      for (let at = before - 1; at >= Math.max(0, before - 3); at -= 1) {
        if (connectedCommitment(at)) return true;
        if (!NON_SUBSTANTIVE_TIMING_BRIDGE.test(context.rows[at].text)) break;
      }
      return false;
    }
    return false;
  };
  const retained = [...new Set(suppliedIds || [])].filter((id) => {
    const index = context.indexById.get(id);
    if (!Number.isInteger(index)) return false;
    return connectedCommitment(index) || timingAnswer(index);
  });
  const unrelatedAnswers = new Set((suppliedIds || []).filter((id) => {
    const index = context.indexById.get(id);
    return owners.length && Number.isInteger(index) && timingOnlyAnswer(context.rows[index]) && !timingAnswer(index);
  }));
  const connected = connectedSuppliedActionEvidence(action, owners, units, suppliedIds)
    .filter(id => !unrelatedAnswers.has(id));
  return [...new Set([...directTimingIds, ...connected, ...retained, ...(resolvedIds || []).filter((id) => !unrelatedAnswers.has(id))])].slice(0, 8);
}

module.exports = { anchorOwnerCommitment, retainSuppliedActionFieldEvidence };
