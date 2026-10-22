'use strict';

const crypto = require('node:crypto');
const { isReviewerAuthored } = require('./state');
const { numberWordsToValue } = require('./textNormalisation');

const VERSION = 'discussion-reconciliation-v1';
const FACETS = Object.freeze(['subject', 'predicate', 'object', 'actors', 'recipients', 'quantities',
  'units', 'polarity', 'modality', 'conditions', 'dependencies', 'temporalOccurrence', 'questionAnswerRole', 'causality']);
const RELATIONS = new Set(['equivalent', 'left_covered_by_right', 'right_covered_by_left', 'distinct', 'partial_overlap', 'unresolved']);
const FIELDS = ['points', 'decisions', 'openQuestions'];
// Reported inquiries are still questions when generation files them as points
// and supplies declarative punctuation. Protect the whole mixed row/children.
const QUESTION_ROLE = /\?|\b(?:whether|asks?|asked|asking|questions?|questioned|queries|queried|inquires?|enquires?|wonders?|wondered|unclear|unresolved|undecided|to be (?:confirmed|decided|agreed|clarified)|awaiting (?:a )?(?:decision|confirmation|response|answer)|not yet (?:agreed|decided|confirmed|known|resolved))\b/i;
const CAUSAL = /\b(?:because|caus(?:e|es|ed|ing)|due to|result(?:s|ed|ing)? (?:in|from)|leads? to|led to)\b/i;
const GATES = /\b(?:if|unless|after|before|once|when|until|pending|following|subject to|provided that|as soon as|without|except)\b[^.;?!]*/gi;
const POLARITY = /\b(?:not|never|no|without|cannot|\w+n['’]t)\b/gi;
const MODAL = /\b(?:not|never|no|cannot|can't|don't|doesn't|won't|mustn't|may|might|could|would|should|must|will|proposed|planned|tentative|tentatively|possible|possibly|probably|likely|estimated|approximately|roughly|only|all|each|every|some|both|either|or)\b/gi;
const CALENDAR = /\b(?:today|tomorrow|yesterday|tonight|next|previous|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)\b/gi;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined)
    .map(key => [key, stable(value[key])]));
}
const hash = value => crypto.createHash('sha256').update(JSON.stringify(stable(value)) ?? '<undefined>').digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const normal = value => String(value || '').normalize('NFKC').replace(/[’]/g, "'").replace(/\s+/g, ' ').trim();
const exactText = value => normal(value).replace(/[.!;]+$/, '').trim();
const unique = values => [...new Set(values || [])];
const ownKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => keys.includes(key));
const subset = (required, present) => required.every(value => present.includes(value));
function orderedWithin(required, present) {
  let at = 0;
  for (const value of present) if (value === required[at]) at += 1;
  return at === required.length;
}

function clauses(text) {
  const result = [];
  const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
  for (const sentence of segmenter.segment(String(text || ''))) {
    // Semicolons delimit complete comparison witnesses without changing text.
    let offset = sentence.index;
    for (const part of sentence.segment.split(/(?<=;)/u)) {
      const leading = part.match(/^\s*/)[0].length;
      const content = part.trim();
      if (content) result.push({ clauseId: 'clause-' + result.length,
        start: offset + leading, end: offset + leading + content.length, text: content });
      offset += part.length;
    }
  }
  return result;
}

// These are rejection guards, never a candidate or deletion rule. Literal
// protected detail must survive in order; arbitrary paraphrases require more
// than a score, a shared source ID or the model repeating "preserved".
function protectedFacets(text) {
  let body = normal(text);
  // A clock range is a single ordered interval. Keep both endpoints while
  // distinguishing it from event gates such as "until approval arrives".
  // Only explicit AM/PM endpoints qualify; ambiguous shorthand stays literal.
  const ranges = [];
  const clock = '(1[0-2]|0?[1-9])(?::([0-5]\\d))?\\s*(AM|PM)';
  const minutes = (hour, minute, period) => String((Number(hour) % 12 + (period.toLowerCase() === 'pm' ? 12 : 0)) * 60 + Number(minute || 0));
  body = body.replace(new RegExp('\\b' + clock + '\\s*(?:start\\s+)?(?:to|until|[–—-])\\s*' + clock + '(?:\\s+(?:finish|end))?\\b', 'gi'),
    (match, firstHour, firstMinute, firstPeriod, lastHour, lastMinute, lastPeriod) => {
      const start = minutes(firstHour, firstMinute, firstPeriod), end = minutes(lastHour, lastMinute, lastPeriod);
      ranges.push(start + ':' + end);
      return ' ';
    });
  const clocks = [];
  body = body.replace(/\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(AM|PM)\b/gi, (match, hour, minute, period) => {
    clocks.push(minutes(hour, minute, period));
    return ' ';
  });
  const numbers = body.match(/\d+(?:[.,]\d+)?/g) || [];
  const tokens = body.toLowerCase().match(/[a-z]+(?:-[a-z]+)*/g) || [];
  for (let at = 0; at < tokens.length; at += 1) {
    if (numberWordsToValue(tokens[at]) === null) continue;
    let end = at + 1;
    while (end < tokens.length && numberWordsToValue(tokens.slice(at, end + 1).join(' ')) !== null) end += 1;
    numbers.push(String(numberWordsToValue(tokens.slice(at, end).join(' '))));
    at = end - 1;
  }
  return {
    future: /\b(?:will|shall|going to)\b/i.test(body),
    bounds: unique([...body.matchAll(/\b(?:at least|at most|more than|less than|fewer than|no more than|no less than|under|over|above|below|approximately|around|about|roughly)\b(?=\s*[£€$]?\s*([\p{L}\p{N}-]+))|[<>≤≥~]/giu)]
      .filter(match => !match[1] || /^\d/.test(match[1]) || numberWordsToValue(match[1]) !== null).map(match => match[0].toLowerCase())),
    polarity: unique((body.match(POLARITY) || []).map(value => value.toLowerCase())),
    numbers: numbers.map(value => String(Number(value.replace(',', '.')))),
    clocks, ranges,
    units: unique(body.match(/[£€$%‰]|°\s*[\p{L}]+|(?<![\p{L}])(?:[yzafpnumcdhkMGTPEZYµμ]?(?:mol|Hz|Pa|Wb|m|g|s|A|K|N|J|W|C|V|F|S|T|H|L|l|B|b))(?![\p{L}])/gu) || []),
    identifiers: unique(body.match(/\b(?:[A-Z]{2,}[A-Z0-9-]*|[A-Za-z]+-\d[A-Za-z0-9-]*|[a-z]+[A-Z][A-Za-z0-9]*)\b/g) || []),
    gates: (body.match(GATES) || []).map(value => normal(value).toLowerCase()),
    modality: unique((body.match(MODAL) || []).map(value => value.toLowerCase())),
    calendar: unique((body.match(CALENDAR) || []).map(value => value.toLowerCase())),
    causal: CAUSAL.test(body)
  };
}
function retainedProtected(from, to) {
  const a = protectedFacets(from), b = protectedFacets(to);
  if ((a.causal || b.causal) && exactText(from) !== exactText(to)) return false;
  if (a.future !== b.future || !subset(a.polarity, b.polarity) || !subset(b.polarity, a.polarity)) return false;
  return orderedWithin(a.numbers, b.numbers) && orderedWithin(a.clocks, b.clocks) && orderedWithin(a.ranges, b.ranges)
    // A comma can add qualifications after an unchanged gate. Its complete
    // original wording must still be present; changed event/scope text fails.
    && a.gates.every(gate => b.gates.some(retained => retained === gate || retained.startsWith(gate + ',')))
    && ['bounds', 'units', 'identifiers', 'modality', 'calendar'].every(key => subset(a[key], b[key]));
}

function snapshotRows(discussion, options) {
  const rows = [];
  const protectedPaths = new Set((options.protectedPaths || []).map(path => JSON.stringify(path)));
  const protectedIds = new Set((options.protectedRecordIds || []).map(String));
  function visit(record, path, context, parentProtected) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return;
    const text = typeof record.text === 'string' ? record.text : '';
    const recordHash = hash(record);
    const ref = 'discussion-' + hash([path, recordHash]).slice(0, 24);
    const reviewer = parentProtected || isReviewerAuthored(record) || protectedPaths.has(JSON.stringify(path))
      || protectedIds.has(String(record.id || ''));
    const reason = reviewer ? 'reviewer_or_protected_context' : context.kind === 'openQuestions' || QUESTION_ROLE.test(text)
      ? 'question_role' : !text.trim() ? 'missing_text' : '';
    const row = { ref, path, recordHash, text, original: clone(record), ...context,
      clauses: clauses(text), protectedFacets: protectedFacets(text), protectedReason: reason,
      hasChildren: Array.isArray(record.supportingDetails) && record.supportingDetails.length > 0 };
    rows.push(row);
    (record.supportingDetails || []).forEach((detail, index) => visit(detail,
      [...path, 'supportingDetails', index],
      { ...context, displayRole: 'supporting', parentRef: ref, parentText: text }, Boolean(reason)));
  }
  (discussion || []).forEach((topic, topicIndex) => {
    if (!topic || typeof topic !== 'object') return;
    for (const kind of FIELDS) (Array.isArray(topic[kind]) ? topic[kind] : []).forEach((record, index) => visit(record,
      [topicIndex, kind, index], { topicIndex, topicId: String(topic.id || ''), topic: String(topic.topic || ''),
        kind, displayRole: 'main', parentRef: null, parentText: '' }, isReviewerAuthored(topic)));
  });
  return rows;
}
function validSources(units) {
  const map = new Map(), repeated = new Set();
  for (const unit of units || []) {
    const id = String(unit?.id || '');
    if (!id || typeof unit.text !== 'string') continue;
    if (map.has(id)) repeated.add(id);
    map.set(id, unit);
  }
  for (const id of repeated) map.delete(id);
  return map;
}
function sourceSpanValid(span, sources) {
  if (!ownKeys(span, ['unitId', 'start', 'end', 'quote'])) return false;
  const unit = sources.get(span.unitId);
  return Boolean(unit && typeof span.quote === 'string' && span.quote.trim()
    && Number.isInteger(span.start) && Number.isInteger(span.end) && span.start >= 0
    && span.end === span.start + span.quote.length && span.end <= unit.text.length
    && unit.text.slice(span.start, span.end) === span.quote
    // Partial substrings can hide the negation or condition before a quote.
    && clauses(unit.text).some(clause => clause.start === span.start + span.quote.match(/^\s*/)[0].length)
    && clauses(unit.text).some(clause => clause.end === span.end - span.quote.match(/\s*$/)[0].length));
}
function sharesPropositionAnchors(from, to) {
  const anchors = unique((from.match(/[\p{L}\p{N}]{4,}/gu) || []).map(value => value.toLowerCase()));
  const retainedText = normal(to).toLowerCase();
  const sharedAnchors = anchors.filter(anchor => retainedText.includes(anchor)).length;
  const facets = protectedFacets(from);
  const quantitative = facets.numbers.length + facets.clocks.length + facets.ranges.length * 2;
  return sharedAnchors + quantitative >= Math.min(2, anchors.length + quantitative);
}
function semanticDirectionPossible(from, to) {
  return removableInto(from, to) && from.clauses.length > 0 && from.clauses.every(original =>
    to.clauses.some(retained => retainedProtected(original.text, retained.text)
      && sharesPropositionAnchors(original.text, retained.text)));
}
function nomination(left, right) {
  const sharedEvidence = (left.original.evidenceIds || []).filter(id => (right.original.evidenceIds || []).includes(id)).length;
  const parent = left.parentRef === right.ref || right.parentRef === left.ref;
  const anchors = value => new Set((normal(value).toLowerCase().match(/[\p{L}\p{N}]{5,}/gu) || []));
  const a = anchors(left.text), b = anchors(right.text);
  const sharedAnchors = [...a].filter(value => b.has(value)).length;
  return { eligible: parent || sharedEvidence > 0 || sharedAnchors >= 2,
    priority: (parent ? 1000 : 0) + sharedEvidence * 10 + sharedAnchors + Number(left.topicIndex === right.topicIndex) };
}
function independent(row) {
  return !/^(?:it|this|that|these|those|they|he|she|yes|no|also|however|therefore|then|otherwise)\b/i.test(row.text.trim());
}
function eligiblePair(left, right) {
  return !left.protectedReason && !right.protectedReason && left.kind === right.kind;
}
function removableInto(from, to) {
  return !from.hasChildren && (from.displayRole !== 'main' || to.displayRole === 'main')
    && !(to.path.length > from.path.length && from.path.every((value, index) => to.path[index] === value));
}
function exactCoverage(from, to, sources) {
  if (!removableInto(from, to) || from.topicIndex !== to.topicIndex || !independent(from)) return false;
  const wanted = exactText(from.text);
  if (!wanted || !to.clauses.some(clause => exactText(clause.text) === wanted)) return false;
  return (from.original.evidenceIds || []).some(id => (to.original.evidenceIds || []).includes(id)
    && sources.has(id) && exactText(sources.get(id).text) === wanted);
}
function packetPayload(packet) {
  const { packetHash, ...payload } = packet;
  return payload;
}
function prepareDiscussionReconciliation(discussion = [], options = {}) {
  const sourceUnits = clone(options.sourceUnits || []);
  const rows = snapshotRows(discussion, options);
  const sources = validSources(sourceUnits);
  for (const row of rows) {
    if (!row.protectedReason && ((row.original._unsupportedEvidenceIds || []).length
      || (row.original.evidenceIds || []).some(id => !sources.has(id)))) row.protectedReason = 'invalid_source_reference';
  }
  const maxCandidates = Number.isInteger(options.maxCandidates) && options.maxCandidates >= 0 ? options.maxCandidates : 128;
  const candidates = [], pendingCandidates = [], deterministicDecisions = [], unresolved = [];
  let notNominatedPairs = 0;
  let totalPairs = 0;
  for (let i = 0; i < rows.length; i += 1) for (let j = i + 1; j < rows.length; j += 1) {
    const left = rows[i], right = rows[j];
    if (!eligiblePair(left, right)) continue;
    totalPairs += 1;
    const candidate = { candidateId: 'discussion-pair-' + hash([left.ref, right.ref]).slice(0, 24),
      leftRef: left.ref, rightRef: right.ref };
    const leftCovered = exactCoverage(left, right, sources), rightCovered = exactCoverage(right, left, sources);
    if (leftCovered || rightCovered) {
      const survivor = leftCovered && !rightCovered ? right : left;
      const removed = survivor === left ? right : left;
      deterministicDecisions.push({ ...candidate, survivorRef: survivor.ref, removedRef: removed.ref,
        relation: survivor === right ? 'left_covered_by_right' : 'right_covered_by_left', via: 'exact_complete_proposition' });
    } else {
      const named = nomination(left, right);
      if (!named.eligible) { notNominatedPairs += 1; continue; }
      const eligibleDirections = [];
      if (semanticDirectionPossible(left, right)) eligibleDirections.push('left_covered_by_right');
      if (semanticDirectionPossible(right, left)) eligibleDirections.push('right_covered_by_left');
      if (!eligibleDirections.length) unresolved.push({ ...candidate, eligibleDirections, reason: 'mechanically_blocked_pair' });
      else pendingCandidates.push({ ...candidate, eligibleDirections, priority: named.priority });
    }
  }
  pendingCandidates.sort((a, b) => b.priority - a.priority || a.candidateId.localeCompare(b.candidateId));
  for (const candidate of pendingCandidates) {
    if (candidates.length < maxCandidates) candidates.push(candidate);
    else unresolved.push({ ...candidate, reason: 'candidate_budget' });
  }
  const packet = { version: VERSION, inputHash: hash(discussion), sourceHash: hash(sourceUnits),
    policyVersion: String(options.policyVersion || VERSION), sourceUnits, rows, candidates, deterministicDecisions, unresolved,
    limits: { evidence: Number.isInteger(options.evidenceLimit) ? options.evidenceLimit : 8,
      reviewFlags: Number.isInteger(options.reviewFlagLimit) ? options.reviewFlagLimit : 24 },
    stats: { rows: rows.length, protectedRows: rows.filter(row => row.protectedReason).length,
      totalPairs, notNominatedPairs, deterministicPairs: deterministicDecisions.length, preparedCandidates: candidates.length,
      unassessedCandidates: unresolved.length } };
  return { ...packet, packetHash: hash(packet) };
}

function propositionTermsRetained(original, retained) {
  // A source citation and a model clause map cannot cover an omitted concrete
  // fact. Keep the initial automatic semantic route bounded to complete
  // content-term retention; unknown paraphrases remain reviewable.
  const terms = value => {
    let body = normal(value).toLowerCase();
    // The protected-facet guard already proves both ordered clock endpoints.
    // Remove only that complete explicit interval's presentation scaffolding.
    body = body.replace(/\b(?:1[0-2]|0?[1-9])(?::[0-5]\d)?\s*(?:am|pm)\s*(?:start\s+)?(?:to|until|[–—-])\s*(?:1[0-2]|0?[1-9])(?::[0-5]\d)?\s*(?:am|pm)(?:\s+(?:finish|end))?\b/g, ' clockinterval ');
    body = body.replace(/\b(hours|schedule|availability)\s+(?:run|runs|are|is)\s+(?:from\s+)?clockinterval\b/g, '$1 clockinterval');
    // A bounded nominal approval construction has a known role-preserving
    // active form. Arbitrary word reorderings do not: reversing actor and
    // recipient, or source and destination, retains the same bag of words.
    body = body.replace(/^([\p{L}\s'-]+?)\s+received\s+([\p{L}\s'-]+?)\s+approval[.!]?$/u,
      (_, subject, actor) => actor + ' approve ' + subject);
    body = body.replace(/\bapproval\b/g, 'approve').replace(/\bapproved\b/g, 'approve');
    // Relational words (to/from/by/for) bind roles, and auxiliary verbs can
    // distinguish temporal state. Only articles are presentation scaffolding.
    const stop = new Set(['a', 'an', 'the']);
    return (body.match(/[\p{L}]+/gu) || []).filter(word => !stop.has(word))
      .map(word => word.length > 5 ? word.replace(/ies$/, 'y').replace(/(?:ing|ed|s)$/, '') : word);
  };
  return orderedWithin(terms(original), terms(retained));
}

function validateCoverage(coverage, from, to, sources) {
  if (!ownKeys(coverage, ['fromRef', 'toRef', 'preservedFacets', 'protectedFacets', 'clauseMap', 'sourceSpans'])
    || coverage.fromRef !== from.ref || coverage.toRef !== to.ref
    || !Array.isArray(coverage.preservedFacets) || coverage.preservedFacets.length !== FACETS.length
    || new Set(coverage.preservedFacets).size !== FACETS.length || !subset(FACETS, coverage.preservedFacets)
    || hash(coverage.protectedFacets) !== hash(from.protectedFacets)
    || !Array.isArray(coverage.sourceSpans) || !coverage.sourceSpans.length
    || !coverage.sourceSpans.every(span => sourceSpanValid(span, sources))
    || !Array.isArray(coverage.clauseMap) || coverage.clauseMap.length !== from.clauses.length) return false;
  const seen = new Set();
  for (const mapping of coverage.clauseMap) {
    if (!ownKeys(mapping, ['fromClauseId', 'toClauseIds', 'sourceSpans'])) return false;
    const original = from.clauses.find(clause => clause.clauseId === mapping.fromClauseId);
    if (!original || seen.has(original.clauseId) || !Array.isArray(mapping.toClauseIds) || !mapping.toClauseIds.length
      || new Set(mapping.toClauseIds).size !== mapping.toClauseIds.length
      || !Array.isArray(mapping.sourceSpans) || !mapping.sourceSpans.length
      || !mapping.sourceSpans.every(span => sourceSpanValid(span, sources)
        && coverage.sourceSpans.some(overall => hash(overall) === hash(span)))) return false;
    const retained = mapping.toClauseIds.map(id => to.clauses.find(clause => clause.clauseId === id));
    if (retained.some(clause => !clause) || !retainedProtected(original.text, retained.map(clause => clause.text).join(' '))
      || !propositionTermsRetained(original.text, retained.map(clause => clause.text).join(' '))) return false;
    // A source quote must carry a meaningful lexical anchor from the original
    // proposition as well. This is an additional rejection check, not proof
    // that an arbitrary same-topic quote establishes semantic entailment.
    const anchors = unique((original.text.match(/[\p{L}\p{N}]{4,}/gu) || []).map(value => value.toLowerCase()));
    if (!sharesPropositionAnchors(original.text, retained.map(clause => clause.text).join(' '))
      || !anchors.some(anchor => mapping.sourceSpans.some(span => normal(span.quote).toLowerCase().includes(anchor)))) return false;
    seen.add(original.clauseId);
  }
  return seen.size === from.clauses.length;
}
function validatedSemantic(packet, envelope, sources) {
  const fail = reason => ({ edges: [], assessedDistinct: [], assessedCandidates: 0,
    unresolved: packet.candidates.map(candidate => ({ ...candidate, reason })) });
  if (!envelope) return fail('semantic_assessment_missing');
  if (!ownKeys(envelope, ['version', 'packetHash', 'sourceHash', 'inputHash', 'decisions'])
    || envelope.version !== VERSION || envelope.packetHash !== packet.packetHash
    || envelope.inputHash !== packet.inputHash || envelope.sourceHash !== packet.sourceHash
    || !Array.isArray(envelope.decisions) || envelope.decisions.length !== packet.candidates.length) return fail('invalid_semantic_envelope');
  const rows = new Map(packet.rows.map(row => [row.ref, row])), byId = new Map(packet.candidates.map(candidate => [candidate.candidateId, candidate]));
  const seen = new Set(), edges = [], unresolved = [], assessedDistinct = [];
  for (const decision of envelope.decisions) {
    const candidate = byId.get(decision?.candidateId);
    if (!candidate || seen.has(candidate.candidateId)
      || !ownKeys(decision, ['candidateId', 'relation', 'survivorRef', 'coverage'])
      || !RELATIONS.has(decision.relation)) return fail('invalid_semantic_accounting');
    seen.add(candidate.candidateId);
    if (['distinct', 'partial_overlap', 'unresolved'].includes(decision.relation)) {
      if (decision.survivorRef || decision.coverage?.length) return fail('invalid_nonmerge_decision');
      if (decision.relation === 'distinct') assessedDistinct.push(candidate.candidateId);
      else unresolved.push({ ...candidate, reason: decision.relation });
      continue;
    }
    const left = rows.get(candidate.leftRef), right = rows.get(candidate.rightRef);
    const winner = rows.get(decision.survivorRef), loser = winner === left ? right : left;
    if (!winner || ![left, right].includes(winner)
      || decision.relation === 'left_covered_by_right' && winner !== right
      || decision.relation === 'right_covered_by_left' && winner !== left
      || !candidate.eligibleDirections.includes(winner === right ? 'left_covered_by_right' : 'right_covered_by_left')
      || !removableInto(loser, winner)
      || !Array.isArray(decision.coverage) || decision.coverage.length !== 2
      || new Set(decision.coverage.map(item => item?.fromRef)).size !== 2
      || ![left, right].every(row => validateCoverage(decision.coverage.find(item => item?.fromRef === row.ref), row, winner, sources))) {
      unresolved.push({ ...candidate, reason: 'unproved_complete_proposition_coverage' });
      continue;
    }
    edges.push({ ...candidate, survivorRef: winner.ref, removedRef: loser.ref, relation: decision.relation, via: 'source_bound_semantic', coverage: clone(decision.coverage) });
  }
  return { edges, unresolved, assessedDistinct, assessedCandidates: seen.size };
}

function atPath(root, path) { return path.reduce((value, key) => value?.[key], root); }
function applyDiscussionReconciliation(discussion = [], packet = {}, envelope = null, options = {}) {
  const unchanged = reason => ({ discussion: clone(discussion), ledger: [], unresolved: [{ reason }],
    stats: { appliedGroups: 0, removedRows: 0, semanticCandidates: packet.candidates?.length || 0 } });
  if (packet.version !== VERSION || packet.packetHash !== hash(packetPayload(packet))
    || packet.inputHash !== hash(discussion) || packet.sourceHash !== hash(options.sourceUnits || [])
    || packet.policyVersion !== String(options.policyVersion || VERSION)) return unchanged('stale_or_changed_packet');
  const rows = new Map(packet.rows.map(row => [row.ref, row]));
  const semantic = validatedSemantic(packet, envelope, validSources(options.sourceUnits || []));
  const edges = [...packet.deterministicDecisions, ...semantic.edges];
  const groups = new Map();
  for (const edge of edges) {
    if (!groups.has(edge.survivorRef)) groups.set(edge.survivorRef, []);
    if (!groups.get(edge.survivorRef).some(prior => prior.removedRef === edge.removedRef)) groups.get(edge.survivorRef).push(edge);
  }
  const index = new Map(packet.rows.map((row, at) => [row.ref, at]));
  const ordered = [...groups].sort(([a, x], [b, y]) => y.length - x.length
    || Number(rows.get(a).displayRole !== 'main') - Number(rows.get(b).displayRole !== 'main') || index.get(a) - index.get(b));
  const result = clone(discussion), ledger = [], unresolved = [...packet.unresolved, ...semantic.unresolved];
  const finalTargets = new Map();
  const removed = new Set(), reservedSurvivors = new Set();
  for (const [survivorRef, proposals] of ordered) {
    if (removed.has(survivorRef)) continue;
    const survivor = rows.get(survivorRef), selected = proposals.filter(edge => !removed.has(edge.removedRef) && !reservedSurvivors.has(edge.removedRef));
    if (!selected.length) continue;
    const members = [survivor, ...selected.map(edge => rows.get(edge.removedRef))];
    const evidenceIds = unique(members.flatMap(row => row.original.evidenceIds || []));
    const flags = unique(members.flatMap(row => row.original.reviewFlagIds || []));
    const sourceIds = unique(selected.flatMap(edge => (edge.coverage || []).flatMap(coverage => coverage.sourceSpans.map(span => span.unitId))));
    const combinedEvidence = unique([...evidenceIds, ...sourceIds]);
    if (combinedEvidence.length > packet.limits.evidence || flags.length > packet.limits.reviewFlags) {
      unresolved.push({ survivorRef, memberRefs: members.map(row => row.ref), reason: 'source_or_warning_limit' });
      continue;
    }
    const target = atPath(result, survivor.path);
    target.evidenceIds = combinedEvidence;
    if (members.some(row => Array.isArray(row.original.reviewFlagIds))) target.reviewFlagIds = flags;
    for (const key of ['primaryEvidenceIds', '_unsupportedEvidenceIds', '_weakEvidenceIds']) {
      if (members.some(row => Array.isArray(row.original[key]))) {
        const values = unique(members.flatMap(row => row.original[key] || []));
        target[key] = key === 'primaryEvidenceIds' ? values.filter(id => combinedEvidence.includes(id)) : values;
      }
    }
    finalTargets.set(survivorRef, target);
    reservedSurvivors.add(survivorRef);
    for (const edge of selected) removed.add(edge.removedRef);
    ledger.push({ version: VERSION, policyVersion: packet.policyVersion, inputHash: packet.inputHash,
      sourceHash: packet.sourceHash, survivorRef, survivorHash: survivor.recordHash,
      finalSurvivorHash: hash(target), originalRows: members.map(row => ({ ref: row.ref, path: row.path, recordHash: row.recordHash, record: clone(row.original) })),
      representations: clone(selected), removedRefs: selected.map(edge => edge.removedRef) });
  }
  // Filter by original paths only after every group has been validated, so
  // indexes, eligibility and evidence never change underneath later decisions.
  const removedPaths = new Set([...removed].map(ref => JSON.stringify(rows.get(ref).path)));
  function filterDetails(record, path) {
    if (!record || typeof record !== 'object' || !Array.isArray(record.supportingDetails)) return;
    record.supportingDetails.forEach((detail, at) => filterDetails(detail, [...path, 'supportingDetails', at]));
    record.supportingDetails = record.supportingDetails.filter((_, at) => !removedPaths.has(JSON.stringify([...path, 'supportingDetails', at])));
  }
  result.forEach((topic, ti) => {
    for (const kind of FIELDS) {
      if (!Array.isArray(topic?.[kind])) continue;
      topic[kind].forEach((record, at) => filterDetails(record, [ti, kind, at]));
      topic[kind] = topic[kind].filter((_, at) => !removedPaths.has(JSON.stringify([ti, kind, at])));
    }
  });
  for (const entry of ledger) entry.finalSurvivorHash = hash(finalTargets.get(entry.survivorRef));
  return { discussion: result, ledger, unresolved,
    stats: { ...packet.stats, assessedCandidates: semantic.assessedCandidates, distinctCandidates: semantic.assessedDistinct.length,
      appliedGroups: ledger.length, removedRows: removed.size,
      semanticMerged: ledger.reduce((total, group) => total + group.representations.filter(edge => edge.via === 'source_bound_semantic').length, 0) } };
}

module.exports = { VERSION, FACETS, prepareDiscussionReconciliation, applyDiscussionReconciliation };
