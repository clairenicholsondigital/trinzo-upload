'use strict';

// Organises a compacted discussion for the reviewer. The Referee decides what
// is material; this pass decides how it reads: in the order the meeting
// happened, in a handful of real topics rather than one topic per sentence,
// with no raw transcript sentences published as minutes, with status lines
// not dressed as decisions, and with supporting context filed under the topic
// whose evidence it actually belongs to. Every rule is deterministic except
// topic-label similarity, which uses the MiniLM worker with a lexical
// fallback. Record ids, evidence ids and review-flag links are preserved.

const { encodeViaWorker, cosine } = require('./semanticDedupe');

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'those', 'these', 'then', 'than', 'their', 'there', 'will', 'would', 'could', 'should', 'are', 'was', 'were', 'has', 'have', 'been']);
const ROW_KINDS = ['points', 'decisions', 'openQuestions'];
const GENERIC_TOPIC = /^(?:discussion|general|other|misc(?:ellaneous)?|meeting|notes?|closure|closing|summary|recap(?: of .*)?|main focus areas and meeting closure)$/i;
const CLOSURE_CLAUSE = /[;,]?\s*(?:meeting\s+)?(?:thanks|closure|farewells?|goodbyes?)(?:\s+and\s+(?:thanks|closure|farewells?|goodbyes?))?\.?\s*$/i;
const CONVERSATIONAL_OPENER = /^\s*(?:so|yeah|yes|no|okay|ok|um|uh|erm|well|right|and|but|i suppose|i think|i mean)\b[\s,.]/i;
const CONVERSATIONAL_FILLER = /\b(?:i suppose|you know|i mean|kind of|sort of|wee bit|what happens in terms of)\b/i;
const DECISION_LANGUAGE = /\b(?:agree(?:d|s|ment)?|decid(?:e|ed|es|ion)|approv(?:e|ed|al)|resolved|signed off|go ahead|committed to|rule (?:established|is)|confirmed (?:that|the plan)|will (?:be|go|proceed|supply|order|brew|deliver)|is to be|are to be)\b/i;
const STATUS_LANGUAGE = /\b(?:expected|anticipated|progressing|ongoing|in progress|identified|confirmed for|remains|still|currently|planned|scheduled|proposed|noted|underway|awaiting)\b/i;
const QUESTION_MARKER = /\?|\b(?:whether|unclear|unresolved|undecided|to be (?:confirmed|decided|agreed|clarified)|awaiting (?:a )?(?:decision|confirmation|response|answer)|not yet (?:agreed|decided|confirmed|known|resolved)|open (?:point|question|item)|outstanding (?:point|question|query|item)|quer(?:y|ies)|questions? (?:raised|remains?|about|on|of|was|were)|pending|needs? (?:to be )?(?:confirm|clarif)|tbc)\b/i;
const ANSWER_OPENER = /^\s*(?:yes|yeah|yep|no|nope|okay|ok)\b/i;
const ANSWER_CLAIM = /\b(?:i(?:'ve| have)|we(?:'ve| have)|she(?:'s| has)|he(?:'s| has)|they(?:'ve| have)) (?:done|sent|put|added|updated|completed|addressed|closed|finished|amended|reviewed)\b/i;

function text(value, max = 4000) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function stem(token) {
  if (token.length > 6 && /ing$/.test(token)) return token.slice(0, -3);
  if (token.length > 5 && /ed$/.test(token)) return token.slice(0, -2);
  if (token.length > 5 && /es$/.test(token)) return token.slice(0, -2);
  if (token.length > 4 && /s$/.test(token)) return token.slice(0, -1);
  return token;
}

function contentTokens(value) {
  return new Set((text(value).toLowerCase().match(/[a-z0-9][a-z0-9'’-]{2,}/g) || [])
    .filter((token) => !STOP.has(token)).map(stem));
}

function overlap(left, right) {
  const a = contentTokens(left);
  const b = contentTokens(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

function unitIndex(units = []) {
  const bySequence = new Map();
  const byId = new Map();
  (Array.isArray(units) ? units : []).forEach((unit, index) => {
    const id = text(unit?.id, 30);
    if (!id) return;
    const sequence = Number(unit?.sequence) || index + 1;
    bySequence.set(id, sequence);
    byId.set(id, { ...unit, sequence });
  });
  return { bySequence, byId };
}

function recordSequences(record, index) {
  return (Array.isArray(record?.evidenceIds) ? record.evidenceIds : [])
    .map((id) => index.bySequence.get(text(id, 30)))
    .filter((value) => Number.isFinite(value));
}

function earliest(record, index) {
  const sequences = recordSequences(record, index);
  return sequences.length ? Math.min(...sequences) : Number.POSITIVE_INFINITY;
}

function cloneRecord(record) {
  return {
    ...record,
    evidenceIds: [...(record?.evidenceIds || [])],
    reviewFlagIds: [...(record?.reviewFlagIds || [])],
    supportingDetails: (record?.supportingDetails || []).map((detail) => ({ ...detail, evidenceIds: [...(detail?.evidenceIds || [])] }))
  };
}

function cloneTopic(topic) {
  return {
    ...topic,
    points: (topic?.points || []).map(cloneRecord),
    decisions: (topic?.decisions || []).map(cloneRecord),
    openQuestions: (topic?.openQuestions || []).map(cloneRecord)
  };
}

function topicRows(topic) {
  return ROW_KINDS.flatMap((kind) => (topic[kind] || []).map((record) => ({ kind, record })));
}

function topicWindow(topic, index) {
  const sequences = topicRows(topic).flatMap(({ record }) => recordSequences(record, index));
  if (!sequences.length) return null;
  return { start: Math.min(...sequences), end: Math.max(...sequences) };
}

// ---------------------------------------------------------------------------
// 1. Wording hygiene and client readiness
// ---------------------------------------------------------------------------

function stripClosure(value) {
  let result = text(value);
  for (let i = 0; i < 3; i += 1) {
    const next = result.replace(CLOSURE_CLAUSE, '').trim();
    if (next === result) break;
    result = next;
  }
  return result;
}

function isVerbatimUnit(value, index, evidenceIds = []) {
  const tokens = contentTokens(value);
  if (tokens.size < 8) return false;
  const candidates = (Array.isArray(evidenceIds) ? evidenceIds : [])
    .map((id) => index.byId.get(text(id, 30))).filter(Boolean);
  return candidates.some((unit) => overlap(value, unit.text) >= 0.9 && contentTokens(unit.text).size >= tokens.size * 0.8);
}

function isConversational(value) {
  return CONVERSATIONAL_OPENER.test(value) || CONVERSATIONAL_FILLER.test(value) || /\.\.\.|\w\.[A-Z]/.test(value);
}

function notClientReady(record, index) {
  const value = text(record?.text);
  if (!value) return true;
  return isVerbatimUnit(value, index, record.evidenceIds) || isConversational(value);
}

// ---------------------------------------------------------------------------
// 2. Row typing
// ---------------------------------------------------------------------------

function looksLikeStatusNotDecision(value) {
  return !DECISION_LANGUAGE.test(value) && STATUS_LANGUAGE.test(value);
}

function questionIsAnswered(record, index) {
  const cited = recordSequences(record, index).sort((a, b) => a - b)
    .map((sequence) => [...index.byId.values()].find((unit) => unit.sequence === sequence)).filter(Boolean);
  if (cited.length < 2) return false;
  const asker = text(cited[0].speaker).toLowerCase();
  return cited.slice(1).some((unit) => text(unit.speaker).toLowerCase() !== asker
    && (ANSWER_OPENER.test(unit.text) || ANSWER_CLAIM.test(unit.text)));
}

function retypeRows(topic, index) {
  const points = [...(topic.points || [])];
  const decisions = [];
  const openQuestions = [];
  for (const record of topic.decisions || []) {
    if (looksLikeStatusNotDecision(text(record.text))) points.push(record);
    else decisions.push(record);
  }
  for (const record of topic.openQuestions || []) {
    const value = text(record.text);
    if (!QUESTION_MARKER.test(value) || questionIsAnswered(record, index)) points.push(record);
    else openQuestions.push(record);
  }
  return { ...topic, points, decisions, openQuestions };
}

// ---------------------------------------------------------------------------
// 3. Demotion of rows that are not minutes
// ---------------------------------------------------------------------------

function nearestPrimary(rows, sequence) {
  let best = null;
  for (const row of rows) {
    const distance = Number.isFinite(sequence) ? Math.abs(earliest(row.record, row.index) - sequence) : Number.POSITIVE_INFINITY;
    if (!best || distance < best.distance) best = { row, distance };
  }
  return best ? best.row.record : null;
}

function demoteUnreadyRows(topics, index) {
  const orphans = [];
  const result = topics.map((topic) => {
    const rows = topicRows(topic).map((row) => ({ ...row, index }));
    const keep = { ...topic, points: [], decisions: [], openQuestions: [] };
    const demoted = [];
    for (const row of rows) {
      const flagged = Array.isArray(row.record.reviewFlagIds) && row.record.reviewFlagIds.length > 0;
      if (!flagged && notClientReady(row.record, index)) demoted.push(row);
      else keep[row.kind].push(row.record);
    }
    const remaining = topicRows(keep).map((row) => ({ ...row, index }));
    for (const row of demoted) {
      const detail = { id: row.record.id, text: text(row.record.text, 1600), evidenceIds: [...(row.record.evidenceIds || [])] };
      const host = nearestPrimary(remaining, earliest(row.record, index));
      if (host) {
        host.supportingDetails = [...(host.supportingDetails || []), ...(row.record.supportingDetails || []), detail];
      } else {
        orphans.push({ detail, extra: row.record.supportingDetails || [], sequence: earliest(row.record, index) });
      }
    }
    return keep;
  }).filter((topic) => topicRows(topic).length);
  for (const orphan of orphans) {
    const rows = result.flatMap((topic) => topicRows(topic).map((row) => ({ ...row, index })));
    const host = nearestPrimary(rows, orphan.sequence);
    if (host) host.supportingDetails = [...(host.supportingDetails || []), ...orphan.extra, orphan.detail];
  }
  return result;
}

// ---------------------------------------------------------------------------
// 4. Topic consolidation
// ---------------------------------------------------------------------------

function topicSignature(topic) {
  const rows = topicRows(topic).slice(0, 2).map(({ record }) => text(record.text, 200));
  return [text(topic.topic, 120), ...rows].filter(Boolean).join('. ');
}

async function topicSimilarities(topics, options = {}) {
  const signatures = topics.map(topicSignature);
  let vectors = null;
  try {
    vectors = typeof options.encode === 'function' ? await options.encode(signatures) : await encodeViaWorker(signatures, {});
  } catch { vectors = null; }
  return (a, b) => {
    if (vectors && vectors[a] && vectors[b]) return cosine(vectors[a], vectors[b]);
    return overlap(signatures[a], signatures[b]);
  };
}

function mergeInto(target, source) {
  for (const kind of ROW_KINDS) target[kind] = [...(target[kind] || []), ...(source[kind] || [])];
  const targetGeneric = GENERIC_TOPIC.test(text(target.topic));
  const sourceGeneric = GENERIC_TOPIC.test(text(source.topic));
  if ((targetGeneric && !sourceGeneric) || (!targetGeneric && !sourceGeneric && topicRows(source).length > topicRows(target).length)) {
    target.topic = source.topic;
  }
  return target;
}

async function consolidateTopics(topics, index, options = {}) {
  if (topics.length < 2) return topics;
  const ordered = [...topics].sort((left, right) => {
    const a = topicWindow(left, index); const b = topicWindow(right, index);
    return (a ? a.start : Number.POSITIVE_INFINITY) - (b ? b.start : Number.POSITIVE_INFINITY);
  });
  const similarity = await topicSimilarities(ordered, options);
  const adjacency = Number(options.adjacencyUnits || 2);
  const strong = Number(options.mergeSimilarity || 0.75);
  const weak = Number(options.adjacentSimilarity || 0.55);
  const windows = ordered.map((topic) => topicWindow(topic, index));
  const groupSimilarity = (left, right) => Math.max(...left.flatMap((a) => right.map((b) => similarity(a, b))));
  const groupGap = (left, right) => {
    const l = left.map((i) => windows[i]).filter(Boolean); const r = right.map((i) => windows[i]).filter(Boolean);
    if (!l.length || !r.length) return Number.POSITIVE_INFINITY;
    const lEnd = Math.max(...l.map((w) => w.end)); const lStart = Math.min(...l.map((w) => w.start));
    const rEnd = Math.max(...r.map((w) => w.end)); const rStart = Math.min(...r.map((w) => w.start));
    return Math.max(0, Math.max(rStart - lEnd, lStart - rEnd));
  };
  // First pass, in transcript order: join a topic to an earlier group when the
  // labels clearly say the same thing, or when they are adjacent in the
  // meeting and reasonably similar, or when the label is generic.
  const groups = [];
  for (let i = 0; i < ordered.length; i += 1) {
    const generic = GENERIC_TOPIC.test(text(ordered[i].topic));
    let best = -1; let bestScore = -1;
    groups.forEach((group, g) => {
      const sim = groupSimilarity(group, [i]);
      const gap = groupGap(group, [i]);
      const ok = sim >= strong || (gap <= adjacency && sim >= weak) || (generic && gap <= adjacency);
      if (ok && sim > bestScore) { bestScore = sim; best = g; }
    });
    if (best >= 0) groups[best].push(i); else groups.push([i]);
  }
  // Second pass: a reviewer wants agenda items, not one topic per sentence.
  // Fold the smallest groups into their most similar neighbour until the
  // count is proportionate to the amount of content.
  const rowsOf = (group) => group.reduce((sum, i) => sum + topicRows(ordered[i]).length, 0);
  const total = ordered.reduce((sum, topic) => sum + topicRows(topic).length, 0);
  const target = Math.min(Number(options.maxTopics || 8), Math.max(Number(options.minTopics || 4), Math.ceil(total / 2.5)));
  while (groups.length > target) {
    let smallest = 0;
    groups.forEach((group, g) => { if (rowsOf(group) < rowsOf(groups[smallest])) smallest = g; });
    let best = -1; let bestScore = -1;
    groups.forEach((group, g) => {
      if (g === smallest) return;
      const score = groupSimilarity(group, groups[smallest]) + (groupGap(group, groups[smallest]) <= adjacency ? 0.1 : 0);
      if (score > bestScore) { bestScore = score; best = g; }
    });
    if (best < 0) break;
    groups[best] = [...groups[best], ...groups[smallest]].sort((a, b) => a - b);
    groups.splice(smallest, 1);
  }
  // The merged topic takes the label of the member carrying the most
  // content (rows first, then supporting context), never a generic one.
  const weight = (topic) => topicRows(topic).reduce((sum, { record }) => sum + 3 + (record.supportingDetails || []).length, 0);
  return groups
    .sort((left, right) => Math.min(...left) - Math.min(...right))
    .map((group) => {
      const merged = group.slice(1).reduce((target, member) => mergeInto(target, ordered[member]), { ...ordered[group[0]] });
      const labelled = group.filter((i) => !GENERIC_TOPIC.test(text(ordered[i].topic)));
      const heaviest = (labelled.length ? labelled : group).reduce((best, i) => (weight(ordered[i]) > weight(ordered[best]) ? i : best));
      merged.topic = ordered[heaviest].topic;
      return merged;
    });
}

// ---------------------------------------------------------------------------
// 5. Supporting context re-homed by evidence
// ---------------------------------------------------------------------------

function rehomeSupportingDetails(topics, index, margin = 2) {
  const windows = topics.map((topic) => topicWindow(topic, index));
  for (let from = 0; from < topics.length; from += 1) {
    for (const { record } of topicRows(topics[from])) {
      const kept = [];
      for (const detail of record.supportingDetails || []) {
        const sequences = recordSequences(detail, index);
        if (!sequences.length) { kept.push(detail); continue; }
        const at = Math.min(...sequences);
        const here = windows[from];
        if (here && at >= here.start - margin && at <= here.end + margin) { kept.push(detail); continue; }
        let to = -1;
        for (let i = 0; i < topics.length; i += 1) {
          if (i === from || !windows[i]) continue;
          if (at >= windows[i].start - margin && at <= windows[i].end + margin) { to = i; break; }
        }
        if (to < 0) { kept.push(detail); continue; }
        const host = nearestPrimary(topicRows(topics[to]).map((row) => ({ ...row, index })), at);
        if (!host) { kept.push(detail); continue; }
        host.supportingDetails = [...(host.supportingDetails || []), detail];
      }
      record.supportingDetails = kept;
    }
  }
  return topics;
}

// ---------------------------------------------------------------------------
// 6. Transcript order
// ---------------------------------------------------------------------------

function sortByEvidence(topics, index) {
  const ordered = [...topics].sort((left, right) => {
    const a = topicWindow(left, index); const b = topicWindow(right, index);
    return (a ? a.start : Number.POSITIVE_INFINITY) - (b ? b.start : Number.POSITIVE_INFINITY);
  });
  for (const topic of ordered) {
    for (const kind of ROW_KINDS) {
      topic[kind] = [...(topic[kind] || [])].sort((left, right) => earliest(left, index) - earliest(right, index));
      for (const record of topic[kind]) {
        record.supportingDetails = [...(record.supportingDetails || [])].sort((left, right) => earliest(left, index) - earliest(right, index));
      }
    }
  }
  return ordered;
}

// ---------------------------------------------------------------------------

async function organiseDiscussionForReview(discussion = [], sourceUnits = [], options = {}) {
  const index = unitIndex(sourceUnits);
  let topics = (Array.isArray(discussion) ? discussion : []).map(cloneTopic);
  const before = { topics: topics.length, rows: topics.reduce((sum, topic) => sum + topicRows(topic).length, 0) };
  for (const topic of topics) {
    for (const { record } of topicRows(topic)) record.text = stripClosure(record.text);
    for (const kind of ROW_KINDS) topic[kind] = (topic[kind] || []).filter((record) => contentTokens(record.text).size >= 2);
  }
  topics = topics.map((topic) => retypeRows(topic, index));
  topics = demoteUnreadyRows(topics, index);
  topics = await consolidateTopics(topics, index, options);
  topics = rehomeSupportingDetails(topics, index);
  topics = sortByEvidence(topics, index);
  const after = { topics: topics.length, rows: topics.reduce((sum, topic) => sum + topicRows(topic).length, 0) };
  return { discussion: topics, before, after };
}

module.exports = {
  organiseDiscussionForReview,
  stripClosure,
  isVerbatimUnit,
  isConversational,
  looksLikeStatusNotDecision,
  questionIsAnswered,
  retypeRows,
  demoteUnreadyRows,
  consolidateTopics,
  rehomeSupportingDetails,
  sortByEvidence,
  unitIndex
};
