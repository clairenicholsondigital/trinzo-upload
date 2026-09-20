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
const { isPersonalAside, removePersonalAsides } = require('./discussionContentPolicy');

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'those', 'these', 'then', 'than', 'their', 'there', 'will', 'would', 'could', 'should', 'are', 'was', 'were', 'has', 'have', 'been']);
const ROW_KINDS = ['points', 'decisions', 'openQuestions'];
const GENERIC_TOPIC = /^(?:discussion|general|other|misc(?:ellaneous)?|meeting|notes?|closure|closing|summary|recap(?: of .*)?|main focus areas and meeting closure)$/i;
const CLOSURE_WORDS = '(?:thanks|closure|closing\\s+remarks|farewells?|goodbyes?)';
const CLOSURE_VERB = '(?:(?:the\\s+)?meeting\\s+(?:was\\s+)?(?:concluded|closed|ended|wrapped\\s+up))';
const CLOSURE_CLAUSE = new RegExp(
  '(?:[;,]?\\s*(?:' + CLOSURE_VERB + '(?:\\s+with)?\\s+|(?:the\\s+)?meeting\\s+)|[;,]\\s*)' + CLOSURE_WORDS + '(?:\\s+(?:and|with)\\s+' + CLOSURE_WORDS + ')?\\.?\\s*$'
  + '|[;,]\\s*' + CLOSURE_VERB + '\\.?\\s*$', 'i');
const CONVERSATIONAL_OPENER = /^\s*(?:so|yeah|yes|no|okay|ok|um|uh|erm|well|right|and|but|i suppose|i think|i mean)\b[\s,.]/i;
const CONVERSATIONAL_FILLER = /\b(?:i suppose|you know|i mean|kind of|sort of|wee bit|what happens in terms of)\b/i;
const DECISION_LANGUAGE = /\b(?:agree(?:d|s|ment)?|decid(?:e|ed|es)|decisions?|approv(?:e|ed|al)|resolved|signed off|go ahead|committed to|rule (?:established|is)|confirmed (?:that|the plan)|will (?:be|go|proceed|supply|order|brew|deliver)|is to be|are to be)\b/i;
const STATUS_LANGUAGE = /\b(?:reviewed|inquir(?:es|ed|y)|asks?|asked|queries|expected|anticipated|progressing|ongoing|in progress|identified|confirmed for|remains|still|currently|planned|scheduled|proposed|noted|underway|awaiting)\b/i;
const QUESTION_MARKER = /\?|\b(?:whether|unclear|unresolved|undecided|to be (?:confirmed|decided|agreed|clarified)|awaiting (?:a )?(?:decision|confirmation|response|answer)|not yet (?:agreed|decided|confirmed|known|resolved)|open (?:point|question|item)|outstanding (?:point|question|query|item)|quer(?:y|ies)|questions? (?:raised|remains?|about|on|of|was|were)|pending|needs? (?:to be )?(?:confirm|clarif)|tbc)\b/i;
const ANSWER_OPENER = /^\s*(?:yes|yeah|yep|no|nope|okay|ok)\b/i;
const ANSWER_CLAIM = /\b(?:i(?:'ve| have)|we(?:'ve| have)|she(?:'s| has)|he(?:'s| has)|they(?:'ve| have)) (?:done|sent|put|added|updated|completed|addressed|closed|finished|amended|reviewed)\b/i;
const DIRECT_ANSWER = /\b(?:(?:it|that) was me|i (?:did|ordered|sent|made|handled|owned|prepared|completed|reviewed|booked|arranged)\b|(?:he|she|they|we) (?:did|ordered|sent|made|handled|owned|prepared|completed|reviewed|booked|arranged)\b)/i;
const EMBEDDED_QUESTION_CLAUSE = /(?:[;,]\s*)questions?\s+(?:on|about|of|was|were|regarding)\b[^.;?]*(?:[.?]|$)/i;
const NOTE_STYLE_START = /^(?:need to\b|(?:current|existing|planned|expected|required|proposed)\b[^.;]{3,140};|[A-Z][^.;]{1,100}\s+to\s+(?:arrange|check|confirm|contact|email|prepare|provide|reorder|review|send|share|update)\b)/;
const UNRESOLVED_ROLE = /\b(?:the speaker|the presenter|the attendee|the participant)\b/i;
const ROUTINE_INTRODUCTION = /\b(?:meeting (?:started|opened|began) with (?:attendee )?introductions?|attendees? introduced themselves|presence of .{0,80}(?:was|were) noted)\b/i;

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

// Never leave a sentence hanging on a connective ("…acceptability and").
const DANGLING_END = /\b(?:and|or|but|with|to|of|for|the|a|an|on|in|at|by|from)\s*$/i;
function stripClosure(value) {
  let result = text(value);
  for (let i = 0; i < 3; i += 1) {
    const next = result.replace(CLOSURE_CLAUSE, '').trim();
    if (next === result || !next || DANGLING_END.test(next)) break;
    result = next;
  }
  return result;
}

function isVerbatimUnit(value, index, evidenceIds = []) {
  const tokens = contentTokens(value);
  if (tokens.size < 4) return false;
  const candidates = (Array.isArray(evidenceIds) ? evidenceIds : [])
    .map((id) => index.byId.get(text(id, 30))).filter(Boolean);
  const normal = (input) => text(input).toLowerCase().replace(/[’]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
  return candidates.some((unit) => {
    const sourceTokens = contentTokens(unit.text);
    const exact = normal(value) === normal(unit.text);
    // Short transcript turns used to bypass this gate entirely. Exact matching
    // is safe at four words; fuzzy matching remains reserved for longer rows.
    return exact || (tokens.size >= 8 && overlap(value, unit.text) >= 0.9 && sourceTokens.size >= tokens.size * 0.8);
  });
}

const INQUIRY_ONLY = /^[A-Z][\w'’-]+(?: [A-Z][\w'’-]+)? (?:inquires|enquires|asks|queries|questions|checks) (?:about|on|if|whether|for|regarding)\b/;

function isConversational(value) {
  if (CONVERSATIONAL_OPENER.test(value) || CONVERSATIONAL_FILLER.test(value) || /\.\.\.|\w\.[A-Z]/.test(value)) return true;
  if (NOTE_STYLE_START.test(value) || UNRESOLVED_ROLE.test(value) || ROUTINE_INTRODUCTION.test(value)) return true;
  // "Jacqui inquires about PMS progress from Ciaran." records that a question
  // was asked, not what was said; it reads as context, not a minute.
  return INQUIRY_ONLY.test(value) && contentTokens(value).size <= 8;
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
  return Boolean(answeredQuestionEvidence(record, index).length);
}

function answeredQuestionEvidence(record, index) {
  const ordered = [...index.byId.values()].sort((a, b) => a.sequence - b.sequence);
  const cited = new Set(recordSequences(record, index));
  const questions = ordered.filter((unit) => cited.has(unit.sequence)
    && (QUESTION_MARKER.test(unit.text) || /\b(?:who|what|when|where|why|how)\b/i.test(unit.text)));
  const answerIds = [];
  for (const question of questions) {
    const position = ordered.findIndex((unit) => unit.sequence === question.sequence);
    const answer = ordered.slice(position + 1, position + 5).find((unit) =>
      ANSWER_OPENER.test(unit.text) || ANSWER_CLAIM.test(unit.text) || DIRECT_ANSWER.test(unit.text));
    if (answer) answerIds.push(answer.id);
  }
  return [...new Set(answerIds)];
}

function removeAnsweredQuestionClauses(topic, index) {
  const clean = (record) => {
    if (!EMBEDDED_QUESTION_CLAUSE.test(text(record?.text))) return record;
    const answerIds = answeredQuestionEvidence(record, index);
    if (!answerIds.length) return record;
    const cleaned = text(record.text).replace(EMBEDDED_QUESTION_CLAUSE, '').replace(/[;,]\s*$/, '').trim();
    if (contentTokens(cleaned).size < 2) return record;
    return { ...record, text: cleaned, evidenceIds: [...new Set([...(record.evidenceIds || []), ...answerIds])] };
  };
  return {
    ...topic,
    points: (topic.points || []).map(clean),
    decisions: (topic.decisions || []).map(clean),
    openQuestions: topic.openQuestions || []
  };
}

const RESPONSIBILITY_LANGUAGE = /\b(?:will|shall|is responsible for|takes? responsibility|owns?|will handle|will lead|will close|will present|will deliver|will run|will take)\b/i;
const FIRST_PERSON_RESPONSIBILITY = /\b(?:i(?:'ll| will| shall| can| am going to|'m going to)|my (?:job|action|responsibility) is|i (?:think i )?(?:take|own|handle|lead|close|present|deliver|run|review|send|prepare|build|restore))\b/i;
const TASK_STOP = new Set(['final', 'proper', 'actual', 'including', 'with', 'then', 'also', 'segment', 'responsibility', 'you', 'your', 'their', 'some']);

function namedResponsibilityOwner(record, index) {
  if (!RESPONSIBILITY_LANGUAGE.test(text(record?.text))) return null;
  const value = text(record.text).toLowerCase();
  const people = [...new Set([...index.byId.values()].map((unit) => text(unit.speaker, 180)).filter(Boolean))];
  const leading = people.filter((person) => {
    const full = person.toLowerCase(); const first = full.split(/\s+/)[0];
    return value.startsWith(`${full} `) || value.startsWith(`${first} `);
  });
  if (leading.length === 1) return leading[0];
  const matches = people.filter((person) => {
    const full = person.toLowerCase(); const first = full.split(/\s+/)[0];
    return value.includes(full) || new RegExp(`^${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(value);
  });
  return matches.length === 1 ? matches[0] : null;
}

function responsibilityTaskTokens(record, owner) {
  const ownerWords = new Set(contentTokens(owner));
  return new Set([...contentTokens(record?.text)].filter((token) => !ownerWords.has(token)
    && !TASK_STOP.has(token) && !/^(?:will|shall|take|responsib|own|handle|lead)$/.test(token)));
}

function responsibilitySupport(record, owner, index) {
  const target = responsibilityTaskTokens(record, owner);
  return (record.evidenceIds || []).map((id) => index.byId.get(text(id, 30))).filter(Boolean)
    .filter((unit) => text(unit.speaker).toLowerCase() === owner.toLowerCase()
      && FIRST_PERSON_RESPONSIBILITY.test(unit.text)
      && (() => {
        const source = responsibilityTaskTokens({ text: unit.text }, owner);
        let shared = 0; for (const token of target) if (source.has(token)) shared += 1;
        return shared / Math.max(1, Math.min(target.size, source.size)) >= 0.4;
      })()).length;
}

// When two rows assign the same responsibility to different people, retain a
// uniquely supported first-person commitment. If neither side wins cleanly,
// leave both for the later reviewer checks rather than guessing.
function removeContradictoryResponsibilities(topic, index) {
  const rows = topicRows(topic);
  const removed = new Set();
  for (let left = 0; left < rows.length; left += 1) {
    if (removed.has(rows[left].record)) continue;
    const leftOwner = namedResponsibilityOwner(rows[left].record, index);
    if (!leftOwner) continue;
    for (let right = left + 1; right < rows.length; right += 1) {
      if (removed.has(rows[right].record)) continue;
      const rightOwner = namedResponsibilityOwner(rows[right].record, index);
      if (!rightOwner || rightOwner.toLowerCase() === leftOwner.toLowerCase()) continue;
      const a = responsibilityTaskTokens(rows[left].record, leftOwner);
      const b = responsibilityTaskTokens(rows[right].record, rightOwner);
      let shared = 0; for (const token of a) if (b.has(token)) shared += 1;
      const sharedEvidence = (rows[left].record.evidenceIds || []).some((id) => (rows[right].record.evidenceIds || []).includes(id));
      if (!shared || (!sharedEvidence && shared / Math.max(1, Math.min(a.size, b.size)) < 0.35)) continue;
      const leftSupport = responsibilitySupport(rows[left].record, leftOwner, index);
      const rightSupport = responsibilitySupport(rows[right].record, rightOwner, index);
      if (leftSupport === rightSupport) continue;
      removed.add(leftSupport > rightSupport ? rows[right].record : rows[left].record);
    }
  }
  if (!removed.size) return topic;
  return {
    ...topic,
    points: (topic.points || []).filter((record) => !removed.has(record)),
    decisions: (topic.decisions || []).filter((record) => !removed.has(record)),
    openQuestions: (topic.openQuestions || []).filter((record) => !removed.has(record))
  };
}

// A point that states an agreement in so many words, and whose cited
// passage records the agreement, is a decision. Deliberately narrow: plans,
// intentions and "will be" statements stay points; only explicit agreement
// language is promoted.
const EXPLICIT_DECISION = /\b(?:(?:we|they|the team|it was|was|were|has been|have been|had)\s+(?:formally\s+)?(?:agreed|decided|approved)|agreed (?:to|that|on)|decided (?:to|that|on)|decision (?:to|was|is|made)|(?:was|were|has been|have been|is) approved|approved (?:the|to|that)|signed off|opted to|chose to)\b/i;
const AGREEMENT_CUE = /\b(?:agreed|agree|decided|(?:made|taken|make) the decision|let'?s (?:go|do)|go (?:with|ahead)|sounds good|that'?s fine|happy with that|signed off|approved?|confirmed|yes,? (?:let'?s|we'?ll|do it|go))\b/i;

function correctnessChecksEnabled() {
  return /^(?:1|true|yes|on)$/i.test(String(process.env.MEETING_MINUTES_AGENT_CORRECTNESS_V1 || '0'));
}

function evidenceRecordsAgreement(record, index) {
  return (Array.isArray(record?.evidenceIds) ? record.evidenceIds : [])
    .map((id) => index.byId.get(text(id, 30)))
    .some((unit) => unit && AGREEMENT_CUE.test(text(unit.text)));
}

function isExplicitDecision(record, index) {
  const value = text(record?.text);
  return EXPLICIT_DECISION.test(value) && !QUESTION_MARKER.test(value)
    && !looksLikeStatusNotDecision(value) && evidenceRecordsAgreement(record, index);
}

function retypeRows(topic, index) {
  const promote = correctnessChecksEnabled();
  const points = [];
  const decisions = [];
  for (const record of topic.points || []) {
    if (promote && !(record.reviewFlagIds || []).length && isExplicitDecision(record, index)) decisions.push(record);
    else points.push(record);
  }
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

// Distance to the row's NEAREST cited line, not its earliest. A row citing
// T0118-T0121 plus one stray T0020 is not "at" line 20: measuring from the
// earliest put every later detail next to it, which is how one row in run 9
// collected nineteen supporting lines.
function nearestPrimary(rows, sequence) {
  let best = null;
  for (const row of rows) {
    const sequences = recordSequences(row.record, row.index);
    const distance = Number.isFinite(sequence) && sequences.length
      ? Math.min(...sequences.map((value) => Math.abs(value - sequence)))
      : Number.POSITIVE_INFINITY;
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
      // A warning must not make raw transcript wording publishable. Other
      // conversational rows remain visible when a reviewer must resolve them.
      if (isVerbatimUnit(row.record.text, index, row.record.evidenceIds)
        || (!flagged && notClientReady(row.record, index))) demoted.push(row);
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

const GENERIC_LABEL_TOKEN = new Set(['status', 'update', 'updates', 'plan', 'plans', 'planning', 'review', 'reviews', 'discussion', 'order', 'orders', 'meeting', 'item', 'items', 'point', 'points', 'next', 'steps', 'general', 'overview', 'progress', 'summary', 'recap', 'topic', 'topics', 'issue', 'issues', 'query', 'queries', 'inquiry', 'confirmation', 'commitment', 'requirements', 'timeline', 'timelines', 'management', 'process', 'document', 'documents', 'documentation']);

function distinctiveLabelTokens(label) {
  return new Set((text(label).match(/[A-Za-z][A-Za-z0-9'’-]+/g) || [])
    .filter((token) => (token.length >= 3 || /^[A-Z]{2,}$/.test(token)))
    .map((token) => stem(token.toLowerCase()))
    .filter((token) => !STOP.has(token) && !GENERIC_LABEL_TOKEN.has(token)));
}

function shareDistinctiveToken(left, right) {
  const a = distinctiveLabelTokens(left);
  for (const token of distinctiveLabelTokens(right)) if (a.has(token)) return true;
  return false;
}

async function topicSimilarities(topics, options = {}) {
  const signatures = topics.map(topicSignature);
  const labels = topics.map((topic) => text(topic.topic, 120));
  let vectors = null;
  let labelVectors = null;
  try {
    const encode = typeof options.encode === 'function' ? options.encode : (values) => encodeViaWorker(values, {});
    vectors = await encode(signatures);
    labelVectors = await encode(labels);
  } catch { vectors = null; labelVectors = null; }
  const signature = (a, b) => {
    if (vectors && vectors[a] && vectors[b]) return cosine(vectors[a], vectors[b]);
    return overlap(signatures[a], signatures[b]);
  };
  const label = (a, b) => {
    if (labelVectors && labelVectors[a] && labelVectors[b]) return cosine(labelVectors[a], labelVectors[b]);
    return overlap(labels[a], labels[b]);
  };
  // Two labels about the same thing usually share the thing's name; a
  // moderate embedding match plus a shared distinctive word is treated as
  // the same subject ("Festival commitment" / "Festival order").
  const kin = (a, b) => shareDistinctiveToken(labels[a], labels[b]) && label(a, b) >= Number(options.labelSimilarity || 0.4);
  return Object.assign(signature, { label, kin });
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
  // A row is anchored where it starts in the transcript. Adjacency is the
  // distance between the closest anchors of two groups, so a row that cites
  // context from across the meeting does not make its topic "next to"
  // everything.
  const anchors = ordered.map((topic) => topicRows(topic).map(({ record }) => earliest(record, index)).filter(Number.isFinite));
  const groupSimilarity = (left, right) => Math.max(...left.flatMap((a) => right.map((b) => similarity(a, b))));
  const groupGap = (left, right) => {
    const l = left.flatMap((i) => anchors[i]); const r = right.flatMap((i) => anchors[i]);
    if (!l.length || !r.length) return Number.POSITIVE_INFINITY;
    return Math.min(...l.flatMap((a) => r.map((b) => Math.abs(a - b))));
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
      const kin = group.some((member) => similarity.kin(member, i));
      const ok = sim >= strong || kin || (gap <= adjacency && sim >= weak) || (generic && gap <= adjacency);
      if (ok && sim > bestScore) { bestScore = sim; best = g; }
    });
    if (best >= 0) groups[best].push(i); else groups.push([i]);
  }
  // Second pass: a reviewer wants agenda items, not one topic per sentence.
  // Fold the smallest groups into the group nearest to them in the meeting
  // (similarity breaks ties) until the count is proportionate to the amount
  // of content. Chronological neighbours keep the minutes in meeting order
  // even when the label match is weak.
  const rowsOf = (group) => group.reduce((sum, i) => sum + topicRows(ordered[i]).length, 0);
  const total = ordered.reduce((sum, topic) => sum + topicRows(topic).length, 0);
  const target = Math.min(Number(options.maxTopics || 8), Math.max(Number(options.minTopics || 4), Math.ceil(total / 2)));
  // A topic-count target is a presentation preference, not evidence that two
  // subjects belong together. Only legacy callers which explicitly request a
  // hard cap may fold unrelated chronological neighbours.
  while (options.forceTopicCap === true && groups.length > target) {
    let smallest = 0;
    groups.forEach((group, g) => { if (rowsOf(group) < rowsOf(groups[smallest])) smallest = g; });
    let best = -1; let bestScore = -1;
    groups.forEach((group, g) => {
      if (g === smallest) return;
      const gap = groupGap(group, groups[smallest]);
      const score = (Number.isFinite(gap) ? 1000 - Math.min(gap, 999) : 0) + groupSimilarity(group, groups[smallest]);
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

// A supporting line that is a copy of the transcript line it cites is not
// context, it is the raw speech - "Andrew is off at the moment, so we'll get
// the.Bottomed out by the end of the week..." - and three of run 8's twelve
// context rows were of this kind. The same test already screens primary rows.
// It keys on the line's OWN source, never on what its parent cites, so a
// paraphrase carrying a distinctive fact cannot be caught by it.
function dropVerbatimSupporting(topics, index) {
  for (const topic of topics) {
    for (const { record } of topicRows(topic)) {
      if (!Array.isArray(record.supportingDetails) || !record.supportingDetails.length) continue;
      record.supportingDetails = record.supportingDetails
        .filter((detail) => !isVerbatimUnit(detail?.text, index, detail?.evidenceIds || []));
    }
  }
  return topics;
}

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
        // The narrowest topic whose window contains the line, not the first.
        // A topic with one stray citation spans the whole meeting and would
        // otherwise swallow every homeless detail.
        let to = -1;
        let span = Number.POSITIVE_INFINITY;
        for (let i = 0; i < topics.length; i += 1) {
          if (i === from || !windows[i]) continue;
          if (at < windows[i].start - margin || at > windows[i].end + margin) continue;
          const width = windows[i].end - windows[i].start;
          if (width < span) { span = width; to = i; }
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
  topics = topics.map((topic) => removeAnsweredQuestionClauses(topic, index));
  topics = topics.map((topic) => retypeRows(topic, index));
  topics = topics.map((topic) => removeContradictoryResponsibilities(topic, index));
  // A transcript may contain friendly observations about somebody needing a
  // break or looking tired. They are neither minutes nor supporting context,
  // even when an AI has rewritten them into a grammatical sentence.
  topics = removePersonalAsides(topics);
  topics = demoteUnreadyRows(topics, index);
  topics = await consolidateTopics(topics, index, options);
  topics = dropVerbatimSupporting(topics, index);
  topics = rehomeSupportingDetails(topics, index);
  topics = sortByEvidence(topics, index);
  const after = { topics: topics.length, rows: topics.reduce((sum, topic) => sum + topicRows(topic).length, 0) };
  return { discussion: topics, before, after };
}

module.exports = {
  organiseDiscussionForReview,
  stripClosure,
  isPersonalAside,
  removePersonalAsides,
  isVerbatimUnit,
  dropVerbatimSupporting,
  isConversational,
  looksLikeStatusNotDecision,
  questionIsAnswered,
  answeredQuestionEvidence,
  removeAnsweredQuestionClauses,
  removeContradictoryResponsibilities,
  retypeRows,
  isExplicitDecision,
  demoteUnreadyRows,
  consolidateTopics,
  rehomeSupportingDetails,
  sortByEvidence,
  unitIndex
};
