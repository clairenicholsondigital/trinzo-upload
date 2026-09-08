'use strict';

const crypto = require('crypto');

const SCHEMA_VERSION = 2;
const FLAG_KINDS = new Set([
  'uncertain_fact', 'unclear_reference', 'ownership', 'timing',
  'unresolved_decision', 'missing_evidence', 'possible_missed_follow_up'
]);
const KNOWN_INTERNAL_ATTENDEE_KEYS = new Set([
  'colm o’rourke', 'jacqui fox', 'david didsbury', 'conor flynn', 'claire nicholson',
  'mark kelleher', 'john-paul hughes', 'jenny gough', 'stuart smith', 'orla skally'
].map((name) => name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[’‘`]/g, "'").toLowerCase()));
const MDSAP_SPOKEN_FORM = /\bmeds[\s-]*app\b/i;

function normaliseKnownTerms(value) {
  return String(value == null ? '' : value).replace(/\bmeds[\s-]*app\b/gi, 'MDSAP');
}

function normaliseKnownTermsDeep(value) {
  if (typeof value === 'string') return normaliseKnownTerms(value);
  if (Array.isArray(value)) return value.map(normaliseKnownTermsDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normaliseKnownTermsDeep(item)]));
  }
  return value;
}

function isAutomaticTerminologyFlag(flag = {}) {
  return MDSAP_SPOKEN_FORM.test(String(flag.message || flag.text || ''));
}

function text(value, max = 2000) {
  return normaliseKnownTerms(value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function stableId(prefix, value, index = 0) {
  return `${prefix}-${crypto.createHash('sha1').update(`${index}|${text(value, 4000)}`).digest('hex').slice(0, 10)}`;
}

function sanitiseDetails(candidate = {}) {
  const names = (value) => [...new Set((Array.isArray(value) ? value : [])
    .map((name) => text(name, 180)).filter(Boolean))].slice(0, 100);
  const attendeeKey = (name) => text(name, 180).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[’‘`]/g, "'").toLowerCase();
  const suppliedAll = names(candidate.allAttendees || candidate.participants);
  let internalAttendees = names(candidate.internalAttendees);
  let clientAttendees = names(candidate.clientAttendees);
  if (!internalAttendees.length && !clientAttendees.length) {
    internalAttendees = suppliedAll.filter((name) => KNOWN_INTERNAL_ATTENDEE_KEYS.has(attendeeKey(name)));
    clientAttendees = suppliedAll.filter((name) => !KNOWN_INTERNAL_ATTENDEE_KEYS.has(attendeeKey(name)));
  } else {
    const assigned = new Set([...internalAttendees, ...clientAttendees].map(attendeeKey));
    clientAttendees.push(...suppliedAll.filter((name) => !assigned.has(attendeeKey(name))));
  }
  const internalKeys = new Set(internalAttendees.map(attendeeKey));
  clientAttendees = clientAttendees.filter((name) => !internalKeys.has(attendeeKey(name)));
  const allAttendees = names([...suppliedAll, ...internalAttendees, ...clientAttendees]);
  return {
    meetingTitle: text(candidate.meetingTitle, 300),
    meetingDate: /^\d{4}-\d{2}-\d{2}$/.test(text(candidate.meetingDate, 20)) ? text(candidate.meetingDate, 20) : '',
    meetingLocation: text(candidate.meetingLocation, 200),
    meetingType: text(candidate.meetingType, 200),
    clientAttendeeLabel: candidate.clientAttendeeLabel === 'External' ? 'External' : 'Client',
    internalAttendees,
    clientAttendees,
    allAttendees
  };
}

function normaliseSourceUnits(units = []) {
  return (Array.isArray(units) ? units : []).slice(0, 10000).map((unit, index) => ({
    id: /^T\d{4,}$/.test(text(unit?.id, 30)) ? text(unit.id, 30) : `T${String(index + 1).padStart(4, '0')}`,
    sequence: index + 1,
    speaker: text(unit?.speaker, 180) || 'Speaker',
    timestamp: /^\d{1,2}:\d{2}(?::\d{2})?$/.test(text(unit?.timestamp, 20)) ? text(unit.timestamp, 20) : '',
    text: text(unit?.text || unit?.cleanedText, 5000),
    classification: unit?.classification === 'remove' ? 'remove' : (unit?.classification === 'uncertain' ? 'uncertain' : 'keep'),
    confidence: Math.max(0, Math.min(1, Number(unit?.confidence || 0))),
    restored: unit?.restored === true
  })).filter((unit) => unit.text);
}

function includedUnit(unit) {
  return unit.classification !== 'remove' || unit.restored === true;
}

function preparedTranscriptFromUnits(units = []) {
  return normaliseSourceUnits(units).filter(includedUnit).map((unit) => {
    const stamp = unit.timestamp ? ` ${unit.timestamp}` : '';
    return `[${unit.id}] ${unit.speaker}${stamp}: ${unit.text}`;
  }).join('\n');
}

function contentTokens(value) {
  const stop = new Set(['about', 'after', 'again', 'also', 'been', 'being', 'could', 'from', 'have', 'into', 'just', 'more', 'only', 'over', 'said', 'that', 'their', 'there', 'they', 'this', 'with', 'would']);
  return [...new Set(text(value, 10000).toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) || [])].filter((token) => !stop.has(token));
}

function tokenOverlap(left, right) {
  const a = contentTokens(left);
  const b = new Set(contentTokens(right));
  if (!a.length || !b.size) return 0;
  return a.filter((token) => b.has(token)).length / Math.min(a.length, b.size);
}

function evidenceIdsFor(value, units = [], supplied = []) {
  const known = new Set(units.map((unit) => unit.id));
  const valid = [...new Set((Array.isArray(supplied) ? supplied : []).map((id) => text(id, 30)).filter((id) => known.has(id)))];
  if (valid.length) return valid.slice(0, 8);
  return units
    .filter(includedUnit)
    .map((unit) => ({ id: unit.id, score: tokenOverlap(value, unit.text) }))
    .filter((item) => item.score >= 0.34)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((item) => item.id);
}

function salientDetailInventory(units = []) {
  const patterns = [
    ['quantity', /\b(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:languages?|alarms?|devices?|products?|tests?|documents?|weeks?|days?|items?|versions?|samples?)\b/i],
    ['standard_reference', /\b(?:BS\s+EN\s+|EN\s+|IEC\s+|ISO\s+|ASTM\s+)?\d{3,5}(?:[-–]\d+)*(?::\d{4})?\b/i],
    ['alarm_behaviour', /\b(?:alarm|audible|mute|silenc|sound|audio|volume|beep)\b/i],
    ['approval_status', /\b(?:approved?|accepted?|signed?\s*off|pending approval|not approved|rejected?)\b/i],
    ['blocker_dependency', /\b(?:block(?:ed|er|ing)?|depend(?:s|ent|ency)?|waiting for|subject to|before .* can|once .* (?:is|has been)|cannot .* until|pending)\b/i]
  ];
  const result = [];
  for (const unit of normaliseSourceUnits(units).filter(includedUnit)) {
    for (const [kind, pattern] of patterns) {
      if (!pattern.test(unit.text)) continue;
      result.push({ id: stableId('detail', `${kind}|${unit.id}`), kind, text: unit.text, evidenceIds: [unit.id] });
      break;
    }
  }
  return result.slice(0, 80);
}

function normaliseFlag(flag = {}, index = 0) {
  const kind = FLAG_KINDS.has(flag.kind) ? flag.kind : 'uncertain_fact';
  const message = text(flag.message || flag.text || 'Review this item against the transcript.', 500);
  return {
    id: text(flag.id, 80) || stableId('flag', `${kind}|${message}`, index),
    kind,
    message,
    evidenceIds: [...new Set((Array.isArray(flag.evidenceIds) ? flag.evidenceIds : []).map((id) => text(id, 30)).filter(Boolean))].slice(0, 8),
    status: ['open', 'confirmed', 'corrected', 'dismissed'].includes(flag.status) ? flag.status : 'open',
    correctionNote: text(flag.correctionNote, 500)
  };
}

function normalisePoint(value, units, prefix, index) {
  const candidate = typeof value === 'string' ? { text: value } : (value || {});
  const pointText = text(candidate.text || candidate.point || candidate.value, 1600);
  if (!pointText) return null;
  const suppliedIds = (Array.isArray(candidate.evidenceIds) ? candidate.evidenceIds : []).map((id) => text(id, 30)).filter(Boolean);
  const knownIds = new Set(units.map((unit) => unit.id));
  const evidenceIds = evidenceIdsFor(pointText, units, candidate.evidenceIds);
  return {
    id: text(candidate.id, 80) || stableId(prefix, pointText, index),
    text: pointText,
    evidenceIds,
    reviewFlagIds: [...new Set((Array.isArray(candidate.reviewFlagIds) ? candidate.reviewFlagIds : []).map((id) => text(id, 80)).filter(Boolean))],
    _unsupportedEvidenceIds: suppliedIds.filter((id) => !knownIds.has(id))
  };
}

function normalisePointList(values, units, prefix) {
  return (Array.isArray(values) ? values : []).map((value, index) => normalisePoint(value, units, prefix, index)).filter(Boolean).slice(0, 50);
}

function normaliseDiscussion(candidate = {}, units = []) {
  return (Array.isArray(candidate.discussion) ? candidate.discussion : []).slice(0, 80).map((item, index) => {
    const topic = text(item?.topic, 220) || 'Discussion';
    return {
      id: text(item?.id, 80) || stableId('topic', topic, index),
      topic,
      points: normalisePointList(item?.points, units, `point-${index}`),
      decisions: normalisePointList(item?.decisions, units, `decision-${index}`),
      openQuestions: normalisePointList(item?.openQuestions, units, `question-${index}`)
    };
  }).filter((item) => item.points.length || item.decisions.length || item.openQuestions.length);
}

function splitOwners(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(/\s*(?:,|&|\band\b)\s*/i);
  return [...new Set(source.map((owner) => text(owner, 180)).filter((owner) => owner && !/^not stated$/i.test(owner)))].slice(0, 12);
}

function timingFrom(item = {}) {
  const supplied = item.timing && typeof item.timing === 'object' ? item.timing : {};
  let wording = text(supplied.wording || item.deadline || item.target, 220);
  let kind = ['deadline', 'target', 'not_stated'].includes(supplied.kind) ? supplied.kind : 'not_stated';
  if (kind === 'not_stated' && wording) {
    kind = /\b(?:target|aim|ideally|provisional|expected|this week|next week)\b/i.test(wording) ? 'target' : 'deadline';
  }
  wording = wording.replace(/^(?:target|deadline)\s*:\s*/i, '');
  const exactDate = /^\d{4}-\d{2}-\d{2}$/.test(text(supplied.exactDate, 20)) ? text(supplied.exactDate, 20) : '';
  return { kind: wording || exactDate ? kind : 'not_stated', wording, exactDate };
}

function isIdeaOnlyContemplation(value) {
  const action = text(value, 2000).toLowerCase();
  if (!/\b(?:think|thinking|consider|considering)\s+(?:about|through|of)\b/.test(action)) return false;
  if (!/\b(?:idea|ideas|thought|thoughts|possibilit(?:y|ies)|options?)\b/.test(action)) return false;
  return !/\b(?:analysis|assessment|decision|document|draft|plan|recommendation|report|specification|test results?|written proposal)\b/.test(action);
}

function actionSimilarity(left, right) {
  return tokenOverlap(left.action, right.action);
}

function ownersCompatible(left, right) {
  if (!left.owners.length || !right.owners.length) return true;
  const a = new Set(left.owners.map((owner) => owner.toLowerCase()));
  const b = new Set(right.owners.map((owner) => owner.toLowerCase()));
  return a.size === b.size && [...a].every((owner) => b.has(owner));
}

function normaliseActions(candidate = {}, units = []) {
  const rows = (Array.isArray(candidate.actions) ? candidate.actions : []).slice(0, 250).map((item, index) => {
    const action = text(item?.action, 1600);
    if (!action || isIdeaOnlyContemplation(action)) return null;
    const suppliedIds = (Array.isArray(item?.evidenceIds) ? item.evidenceIds : []).map((id) => text(id, 30)).filter(Boolean);
    const knownIds = new Set(units.map((unit) => unit.id));
    const evidenceIds = evidenceIdsFor(action, units, item?.evidenceIds);
    return {
      id: text(item?.id, 80) || stableId('action', action, index),
      action,
      owners: splitOwners(item?.owners || item?.owner),
      timing: timingFrom(item),
      evidenceIds,
      reviewFlagIds: [...new Set((Array.isArray(item?.reviewFlagIds) ? item.reviewFlagIds : []).map((id) => text(id, 80)).filter(Boolean))],
      _unsupportedEvidenceIds: suppliedIds.filter((id) => !knownIds.has(id))
    };
  }).filter(Boolean);
  const merged = [];
  for (const row of rows) {
    const duplicate = merged.find((existing) => actionSimilarity(existing, row) >= 0.78 && ownersCompatible(existing, row));
    if (!duplicate) {
      merged.push(row);
      continue;
    }
    duplicate.evidenceIds = [...new Set([...duplicate.evidenceIds, ...row.evidenceIds])].slice(0, 8);
    duplicate._unsupportedEvidenceIds = [...new Set([
      ...(duplicate._unsupportedEvidenceIds || []),
      ...(row._unsupportedEvidenceIds || [])
    ])];
    if (!duplicate.owners.length) duplicate.owners = row.owners;
    if (duplicate.timing.kind === 'not_stated' && row.timing.kind !== 'not_stated') duplicate.timing = row.timing;
  }
  return merged;
}

function unresolvedReferenceFlags(units = []) {
  const standardLike = /\b(?:standard|IEC|ISO|EN|BS|ASTM|six(?:ty)?[- ]?oh[- ]?one|eight[- ]?ten[- ]?oh[- ]?one|twenty[- ]?seven)\b/i;
  const uncertainty = /\b(?:something|whatever|I think|maybe|roughly|approximately|or so|not sure|can't remember|cannot remember)\b/i;
  return normaliseSourceUnits(units).filter(includedUnit).filter((unit) => standardLike.test(unit.text) && uncertainty.test(unit.text)).map((unit, index) => normaliseFlag({
    kind: 'unclear_reference',
    message: `Confirm the standard reference exactly as spoken: “${unit.text.slice(0, 220)}”`,
    evidenceIds: [unit.id]
  }, index));
}

function normaliseAgentResult(candidate = {}, units = [], stage = '') {
  const discussion = normaliseDiscussion(candidate, units);
  const actions = normaliseActions(candidate, units);
  const flags = (Array.isArray(candidate.reviewFlags) ? candidate.reviewFlags : []).filter((flag) => !isAutomaticTerminologyFlag(flag)).map(normaliseFlag);
  const records = [
    ...discussion.flatMap((topic) => [...topic.points, ...topic.decisions, ...topic.openQuestions]),
    ...actions
  ];
  const unitById = new Map(normaliseSourceUnits(units).map((unit) => [unit.id, unit]));
  for (const action of actions) {
    const evidenceText = action.evidenceIds.map((id) => {
      const unit = unitById.get(id);
      return unit ? `${unit.speaker} ${unit.text}` : '';
    }).join(' ');
    const unsupportedOwners = action.owners.filter((owner) => {
      const words = contentTokens(owner);
      const haystack = contentTokens(evidenceText);
      return words.length && !words.every((word) => haystack.includes(word));
    });
    if (unsupportedOwners.length) {
      action.owners = action.owners.filter((owner) => !unsupportedOwners.includes(owner));
      const flag = normaliseFlag({
        kind: 'ownership',
        message: `Confirm or correct unsupported action ownership: ${unsupportedOwners.join(', ')}.`,
        evidenceIds: action.evidenceIds
      }, flags.length);
      flags.push(flag);
      action.reviewFlagIds.push(flag.id);
    }
    if (action.timing.kind !== 'not_stated') {
      const wordingSupported = action.timing.wording && (
        evidenceText.toLowerCase().includes(action.timing.wording.toLowerCase()) ||
        tokenOverlap(action.timing.wording, evidenceText) >= 0.5
      );
      let exactDateSupported = false;
      if (action.timing.exactDate) {
        const [year, month, day] = action.timing.exactDate.split('-');
        const monthNames = ['', 'jan(?:uary)?', 'feb(?:ruary)?', 'mar(?:ch)?', 'apr(?:il)?', 'may', 'jun(?:e)?', 'jul(?:y)?', 'aug(?:ust)?', 'sep(?:tember)?', 'oct(?:ober)?', 'nov(?:ember)?', 'dec(?:ember)?'];
        exactDateSupported = new RegExp(`\\b0?${Number(day)}(?:st|nd|rd|th)?\\b[\\s\\S]{0,20}\\b${monthNames[Number(month)]}\\b[\\s\\S]{0,20}\\b${year}\\b`, 'i').test(evidenceText)
          || evidenceText.includes(action.timing.exactDate);
      }
      if (!wordingSupported && !exactDateSupported) {
        const unsupportedTiming = action.timing.wording || action.timing.exactDate;
        action.timing = { kind: 'not_stated', wording: '', exactDate: '' };
        const flag = normaliseFlag({
          kind: 'timing',
          message: `Confirm or correct unsupported action timing: ${unsupportedTiming}.`,
          evidenceIds: action.evidenceIds
        }, flags.length);
        flags.push(flag);
        action.reviewFlagIds.push(flag.id);
      }
    }
  }
  for (const [index, record] of records.entries()) {
    if (record._unsupportedEvidenceIds?.length) {
      const flag = normaliseFlag({
        kind: 'missing_evidence',
        message: `The agent cited unsupported source ${record._unsupportedEvidenceIds.join(', ')}; verify this record against the linked transcript evidence.`,
        evidenceIds: record.evidenceIds
      }, flags.length + index);
      flags.push(flag);
      record.reviewFlagIds.push(flag.id);
    }
    delete record._unsupportedEvidenceIds;
    if (record.evidenceIds.length) continue;
    const flag = normaliseFlag({ kind: 'missing_evidence', message: 'No sufficiently close source passage was found for this generated item.' }, flags.length + index);
    flags.push(flag);
    record.reviewFlagIds.push(flag.id);
  }
  if (stage === 'discussion') flags.push(...unresolvedReferenceFlags(units));
  return { schemaVersion: SCHEMA_VERSION, discussion, actions, reviewFlags: uniqueFlags(flags) };
}

function uniqueFlags(flags = []) {
  const seen = new Set();
  return flags.filter((flag) => {
    const key = `${flag.kind}|${flag.message}|${flag.evidenceIds.join(',')}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function coverageFlags(inventory = [], result = {}) {
  const output = JSON.stringify({ discussion: result.discussion || [], actions: result.actions || [] });
  return inventory.filter((item) => tokenOverlap(item.text, output) < 0.28).slice(0, 12).map((item, index) => normaliseFlag({
    kind: item.kind === 'standard_reference' ? 'unclear_reference' : 'uncertain_fact',
    message: `Check whether this important transcript detail should appear in the minutes: “${item.text.slice(0, 220)}”`,
    evidenceIds: item.evidenceIds
  }, index));
}

function surroundingEvidence(units = [], ids = []) {
  const rows = normaliseSourceUnits(units);
  const wanted = new Set(ids);
  const indexes = rows.map((unit, index) => wanted.has(unit.id) ? index : -1).filter((index) => index >= 0);
  const include = new Set(indexes.flatMap((index) => [index - 1, index, index + 1]).filter((index) => index >= 0 && index < rows.length));
  return [...include].sort((a, b) => a - b).map((index) => ({ ...rows[index], cited: wanted.has(rows[index].id) }));
}

function buildProposal(stage, before = [], after = []) {
  const oldRows = Array.isArray(before) ? before : [];
  const newRows = Array.isArray(after) ? after : [];
  const changes = [];
  const length = Math.max(oldRows.length, newRows.length);
  for (let index = 0; index < length; index += 1) {
    const previous = oldRows[index] || null;
    const next = newRows[index] || null;
    if (JSON.stringify(previous) === JSON.stringify(next)) continue;
    changes.push({
      id: stableId('change', `${stage}|${JSON.stringify(previous)}|${JSON.stringify(next)}`, index),
      type: !previous ? 'add' : (!next ? 'remove' : 'modify'),
      before: previous,
      after: next,
      index
    });
  }
  return { id: stableId('proposal', `${stage}|${Date.now()}`), stage, createdAt: new Date().toISOString(), changes };
}

function applyProposal(before = [], proposal = {}, acceptedIds = []) {
  const accepted = new Set(acceptedIds);
  const rows = [...(Array.isArray(before) ? before : [])];
  const selected = (proposal.changes || []).filter((change) => accepted.has(change.id)).sort((a, b) => b.index - a.index);
  for (const change of selected) {
    if (change.type === 'remove') rows.splice(change.index, 1);
    else if (change.type === 'add') rows.splice(change.index, 0, change.after);
    else rows[change.index] = change.after;
  }
  return rows;
}

module.exports = {
  SCHEMA_VERSION,
  text,
  sanitiseDetails,
  normaliseSourceUnits,
  preparedTranscriptFromUnits,
  salientDetailInventory,
  normaliseAgentResult,
  normaliseFlag,
  coverageFlags,
  surroundingEvidence,
  buildProposal,
  applyProposal,
  isIdeaOnlyContemplation,
  normaliseKnownTerms,
  normaliseKnownTermsDeep,
  isAutomaticTerminologyFlag
};
