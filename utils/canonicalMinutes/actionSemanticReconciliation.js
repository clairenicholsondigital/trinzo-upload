'use strict';

const crypto = require('node:crypto');
const { sourceOperationReviewValid } = require('../meetingMinutesSemanticSourceVerification');
const { isReviewerAuthored } = require('./state');
const { enquiryFrame, sameEnquiryPair, enquiryPurposeRetained } = require('./contactEnquiry');
const { convertSpokenNumbers } = require('../spokenNumbers');
const { normaliseUkCurrency } = require('./textNormalisation');
const { numberedIdentifiers, quantityTokens, unitTokens } = require('../meetingMinutesNumericTokens');
const { actionProvenanceSignature, validOccurrenceId } = require('../meetingMinutesActionIdentity');
const { isActionOnlySemanticScope } = require('../meetingMinutesSemanticPolicy');
const comparisonNumbers = value => normaliseUkCurrency(convertSpokenNumbers(String(value || '')).text);
const { actionIsSafelyCovered, conflictingTimings } = require('./actionDuplicateCoverage');
const { commitmentVariantCovered, commitmentCanBeRepresented, conflictingRecipients,
  conflictingDestinations, dependsOn } = require('./commitmentDuplicates');

const VERSION = 'action-reconciliation-v1';
const RELATIONS = new Set(['equivalent', 'left_covered_by_right', 'right_covered_by_left',
  'distinct', 'partial_overlap', 'unresolved']);
const MERGES = new Set(['equivalent', 'left_covered_by_right', 'right_covered_by_left']);
const canonical = value => String(value || '').normalize('NFKC').replace(/[’]/g, "'")
  .replace(/\s+/g, ' ').trim().toLowerCase();
const stable = value => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort()
    .filter(key => value[key] !== undefined).map(key => [key, stable(value[key])])) : value;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const clone = value => structuredClone(value);
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
const unique = values => [...new Set(values)];
const owners = row => unique((row.owners || []).map(canonical).filter(Boolean)).sort();
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const limit = (value, fallback) => Number.isInteger(value) && value >= 0 ? value : fallback;
const STOP = new Set(('a an the and to of for in on at with that this it its them their our your my i will shall '
  + 'please is are be been being as from by into onto').split(' '));
function words(value) {
  return canonical(value).replace(/(\w)-(\w)/g, '$1 $2').match(/[\p{L}\p{N}]+(?:\.[\p{N}]+)?|[£€$%°<>≤≥]/gu) || [];
}
function stem(word) {
  return word.length > 4 ? word.replace(/ies$/, 'y').replace(/(?:ing|ed|es|s)$/, '') : word;
}
function contentWords(value) { return unique(words(value).filter(word => !STOP.has(word)).map(stem)); }
function subset(left, right) { return left.every(value => right.includes(value)); }
const OPERATION_GROUPS = [
  ['send', /^(?:send|share|provide|forward|circulate|email|distribute|supply|give)$/],
  ['edit', /^(?:update|revise|amend|edit)$/],
  ['review', /^(?:review|check|assess|inspect|evaluate|analyse|analyze|examine|read)$/],
  ['test', /^(?:test|rerun)$/], ['approve', /^(?:approve|authorize|authorise)$/],
  ['communicate-content', /^(?:explain|notify|inform|announce|include)$/],
  ['buy', /^(?:buy|purchase|procure)$/], ['install', /^(?:fit|install)$/]
];
function operation(value) {
  const enquiry = enquiryFrame(value);
  if (enquiry) return enquiry.operation;
  const verb = words(value)[0] || '';
  return OPERATION_GROUPS.find(([, pattern]) => pattern.test(verb))?.[0] || verb;
}
function instructionClauses(value) {
  return String(value || '').split(/;\s*|,\s*(?:and\s+|then\s+)?(?=(?:send|share|provide|review|check|test|approve|write|update|create|buy|fit|install|sign|take)\b)/i)
    .map(text => text.trim()).filter(Boolean);
}
function operationSequence(value) {
  const enquiry = enquiryFrame(value);
  if (enquiry) return [enquiry.operation];
  return unique([...String(value || '').matchAll(/(?:^|[;,]\s*(?:(?:and|then)\s+)?|\b(?:and|then)\s+)(send|share|provide|forward|circulate|review|check|assess|test|approve|write|update|revise|amend|edit|create|buy|purchase|fit|install|sign|take|address)\b/gi)]
    .map(match => operation(match[1]))).sort();
}
function sourceRows(input) {
  return (Array.isArray(input) ? input : []).map(row => clone(row));
}
function packetBody(packet) { const { packetHash: ignored, ...body } = packet; return body; }
function governingScopes(value) {
  const text = canonical(value); const scopes = [];
  const pattern = /\b(?:if|unless|after|before|once|when|until|pending|following|subject to|provided(?: that)?|as soon as|otherwise|without|except|only|not|never)\b[^.;]*/g;
  for (const match of text.matchAll(pattern)) {
    // The requested description still belongs to the complete object mapping;
    // it does not tell the actor to wait for a preceding task.
    if (/^when\b/.test(match[0]) && /\bwhat\s+(?:happens?|occurs?)\s*$/.test(text.slice(0, match.index))) continue;
    scopes.push(match[0]);
  }
  return scopes;
}
function protectedFacets(row) {
  const value = canonical(comparisonNumbers(row.action));
  return {
    owners: owners(row),
    timing: row.timing || { kind: 'not_stated', wording: '', exactDate: '' },
    timingStatus: row.timingDecision?.status || '',
    conditions: unique([...governingScopes(value), ...governingScopes(row.timing?.wording)])
      .filter((scope, _index, all) => !all.some(other => other !== scope && other.startsWith(`${scope} `))).sort(),
    modality: value.match(/\b(?:maybe|perhaps|probably|possibly|presumably|ideally|tentatively|aiming|try|best efforts?|subject to|if required|if needed)\b/g) || [],
    quantities: quantityTokens(value),
    bounds: value.match(/\b(?:up to|at least|at most|more than|less than|fewer than|under|over|above|below|approximately|around|about|roughly)\b|[<>≤≥]/g) || [],
    relations: value.match(/\b(?:from|against|between|as a|as an)\s+[^.;]*/g) || [],
    identifiers: unique([...(String(row.action || '').match(/\b[A-Z][A-Z0-9_-]+\b|\b[A-Z]\b/g) || []),
      ...numberedIdentifiers(row.action)]),
    quantifiers: value.match(/\b(?:all|both|each|any|every|only|solely|either|or)\b/g) || [],
    versions: value.match(/\b(?:new|old|current|existing|previous|former|latest|original)\b/g) || [],
    units: unitTokens(row.action),
    disposition: String(row.disposition || row.lifecycleStatus || '')
  };
}
function timingDetailCovered(part, whole) {
  const a = part.timing || {}; const b = whole.timing || {};
  if (!a.kind || a.kind === 'not_stated' || a.kind !== b.kind
    || String(a.exactDate || '') !== String(b.exactDate || '')) return false;
  const left = canonical(a.wording); const right = canonical(b.wording);
  if (a.kind === 'dependency' && !equal(protectedFacets(part).conditions, protectedFacets(whole).conditions)) return false;
  // Preserve the complete contextual phrase; never reinterpret a quoted name
  // or a dependency. TemporalReview owns atoms, bounds, recurrence and hedges.
  if (!left || !right || !right.includes(left) || /["“”:()[\]{}]|(?:^|\W)'[^']+'(?=\W|$)/.test(`${left} ${right}`)) return false;
  const { temporalMeaningRetained } = require('../meetingMinutesTemporalReview');
  return temporalMeaningRetained(left, right) && temporalMeaningRetained(right, left);
}
function hardConflicts(part, whole) {
  const a = protectedFacets(part); const b = protectedFacets(whole); const reasons = [];
  if (!a.owners.length || !equal(a.owners, b.owners)) reasons.push('different_or_missing_owners');
  if (conflictingTimings(part, whole) && !timingDetailCovered(part, whole)) reasons.push('different_timing');
  const timed = row => row.timing?.kind && row.timing.kind !== 'not_stated';
  if (timed(part) && !timed(whole)) reasons.push('timing_would_be_lost');
  if (Boolean(timed(part)) !== Boolean(timed(whole))) reasons.push('unresolved_timing_binding');
  if (!equal(a.conditions, b.conditions)) reasons.push('different_condition_or_dependency');
  if (!equal(a.modality, b.modality)) reasons.push('different_modality');
  if (a.disposition !== b.disposition) reasons.push('different_disposition');
  const calendarLike = /\b(?:today|tomorrow|yesterday|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|daily|weekly|fortnightly|monthly|quarterly|annually|yearly|morning|afternoon|evening|noon|midnight|(?:this|next|last|previous|every|each)\s+(?:day|week|month|quarter|year))\b|\d{1,2}:\d{2}/i;
  if (calendarLike.test(String(part.action)) || calendarLike.test(String(whole.action))) {
    const { temporalMeaningRetained } = require('../meetingMinutesTemporalReview');
    if (!temporalMeaningRetained(part.action, whole.action) || !temporalMeaningRetained(whole.action, part.action)) {
      reasons.push('different_inline_temporal_occurrence');
    }
  }
  if (operation(part.action) !== operation(whole.action)) reasons.push('different_operation');
  if (!subset(operationSequence(part.action), operationSequence(whole.action))) reasons.push('operation_would_be_lost');
  const enquiryA = enquiryFrame(part.action), enquiryB = enquiryFrame(whole.action);
  if (enquiryA && enquiryB) {
    if (enquiryA.recipient !== enquiryB.recipient) reasons.push('different_recipient');
    if (!enquiryPurposeRetained(part.action,whole.action)) reasons.push('enquiry_purpose_detail_would_be_lost');
    // Topic prepositions belong to the source-verified purpose, not a
    // delivery destination. No purpose equivalence is inferred here.
  } else {
    if (conflictingRecipients(part.action, whole.action)) reasons.push('different_recipient');
    if (conflictingDestinations(part.action, whole.action)) reasons.push('different_destination');
  }
  if (dependsOn(part.action, whole.action) || dependsOn(whole.action, part.action)) reasons.push('separate_dependency_step');
  // Missing quantities can be extra detail only in the covering direction.
  // Competing values, units, bounds or relationships remain blocked.
  for (const field of ['quantities', 'units', 'bounds', 'relations', 'identifiers', 'quantifiers', 'versions']) {
    if (!subset(a[field], b[field]) || field === 'quantities' && a[field].length && !equal(a[field], b[field])) {
      reasons.push(`${field}_would_change_or_be_lost`);
    }
  }
  const leftRejected = part.timingDecision?.rejectedExactDates || [];
  const rejectedWordings = part.timingDecision?.rejectedWordings || [];
  if (whole.timing?.exactDate && leftRejected.includes(whole.timing.exactDate)) reasons.push('rejected_date_would_return');
  if (whole.timing?.wording && rejectedWordings.some(wording => canonical(wording) === canonical(whole.timing.wording))) {
    reasons.push('rejected_wording_would_return');
  }
  if ((leftRejected.length || rejectedWordings.length) && !whole.timingDecision) {
    reasons.push('timing_rejection_history_without_survivor_decision');
  }
  const statuses = ['rejected', 'unresolved', 'needs_rebind'];
  if (statuses.includes(a.timingStatus) && !statuses.includes(b.timingStatus)) reasons.push('timing_status_would_be_upgraded');
  return unique(reasons);
}
function mechanicalCoverage(part, whole) {
  const conflicts = hardConflicts(part, whole);
  if (conflicts.length) return { covered: false, reasons: conflicts };
  const covered = actionIsSafelyCovered(part, whole) || commitmentVariantCovered(part, whole)
    || commitmentCanBeRepresented(part, whole);
  return { covered: Boolean(covered), reasons: covered ? [] : ['directional_wording_not_proved'] };
}

// A small nomination class for reordered wording, not a proof of equivalence.
// Unknown metadata, reviewer work and qualified occurrences stay protected.
const BOUNDED_FIELDS = new Set(['id', 'action', 'owners', 'timing', 'evidenceIds', 'occurrenceId', 'reviewFlagIds', 'timingDecision']);
function boundedSurvivorPair(left, right) {
  const eligible = row => row && Object.keys(row).every(key => BOUNDED_FIELDS.has(key))
    && !isReviewerAuthored(row) && row.owners?.length === 1 && String(row.owners[0]).trim()
    && row.timing?.kind === 'not_stated' && !row.timing.wording && !row.timing.exactDate
    && !row.reviewFlagIds?.length && row.evidenceIds?.length > 0 && row.evidenceIds.length <= 8
    && !row.timingDecision?.rejectedExactDates?.length && !row.timingDecision?.rejectedWordings?.length
    && (!row.timingDecision || row.timingDecision.reason === 'no_timing_value'
      && row.timingDecision.binding?.status === 'not_stated')
    && !/[\d"“”:;()[\]{}?]|\b(?:if|unless|after|before|once|when|until|pending|following|without|not|never|only|either|or|maybe|perhaps|probably|possibly|presumably|ideally|tentatively|today|tomorrow|yesterday|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|days?|weeks?|months?|years?|hours?|minutes?|seconds?|daily|weekly|fortnightly|monthly|quarterly|annually|yearly|morning|afternoon|evening|noon|midnight|asap|soon|immediately)\b/i.test(row.action)
    && !/[.!?]/.test(String(row.action).replace(/[.!?]+$/, ''))
    && !/\b(?:and|then)\s+(?:send|share|provide|forward|circulate|review|check|assess|test|approve|write|update|revise|amend|edit|create|buy|purchase|fit|install|sign|take|address)\b/i.test(row.action)
    && instructionClauses(row.action).length === 1 && operationSequence(row.action).length === 1;
  if (!eligible(left) || !eligible(right) || words(left.action)[0] !== words(right.action)[0]
    || !equal(owners(left), owners(right))
    || !(left.evidenceIds || []).some(id => right.evidenceIds.includes(id))
    || new Set([...left.evidenceIds, ...right.evidenceIds]).size > 8
    || hardConflicts(left, right).length || hardConflicts(right, left).length) return false;
  const a = contentWords(words(left.action).slice(1).join(' '));
  const b = contentWords(words(right.action).slice(1).join(' '));
  const common = a.filter(word => b.includes(word)).length;
  return common >= 3 && common / Math.max(a.length, b.length) >= 0.8;
}

function prepareActionReconciliation(input = {}) {
  const actions = Array.isArray(input.actions) ? input.actions : [];
  const sourceUnits = sourceRows(input.sourceUnits);
  const protectedIds = new Set(input.protectedOccurrenceIds || []);
  const serials = new Map();
  const rows = actions.map((action, index) => {
    const record = clone(action); const recordHash = hash(record);
    const serial = serials.get(recordHash) || 0; serials.set(recordHash, serial + 1);
    const evidence = new Set(record.evidenceIds || []);
    return { ref: `witness-${recordHash.slice(0, 24)}-${serial}`, index, recordHash, action: record,
      facets: protectedFacets(record), clauses: instructionClauses(record.action),
      clauseDescriptors: instructionClauses(record.action).map(text => ({ text,
        operation: words(text)[0] || '', object: words(text).slice(1).join(' ') })),
      protected: isReviewerAuthored(record)
        || Boolean(record.occurrenceId && protectedIds.has(record.occurrenceId)),
      witnesses: sourceUnits.filter(unit => evidence.has(unit.id)).map(unit => ({ sourceId: unit.id,
        sourceHash: hash(unit), text: String(unit.text || ''), speaker: String(unit.speaker || '') })) };
  });
  const candidates = []; const unresolved = []; const maxCandidates = Math.min(limit(input.maxCandidates, 64),
    ['bounded_existing_survivors','contact_and_existing_survivors'].includes(input.scope) ? 2 : Infinity);
  const ordered = [...rows].sort((a, b) => a.ref.localeCompare(b.ref));
  // Preserve contact checks' existing priority within the unchanged pair budget.
  const classes = input.scope === 'contact_and_existing_survivors' ? ['contact_enquiries', 'bounded_existing_survivors'] : [input.scope];
  for (const nominationClass of classes) for (let i = 0; i < ordered.length; i += 1) for (let j = i + 1; j < ordered.length; j += 1) {
    const left = ordered[i]; const right = ordered[j];
    if (left.protected || right.protected) continue;
    const contact = sameEnquiryPair(left.action, right.action);
    if (nominationClass === 'contact_enquiries' && !contact) continue;
    if (nominationClass === 'bounded_existing_survivors'
      && (input.scope === 'contact_and_existing_survivors' && contact || !boundedSurvivorPair(left.action, right.action))) continue;
    if (input.scope !== undefined && !isActionOnlySemanticScope(input.scope)) continue;
    const leftWords = contentWords(left.action.action); const rightWords = contentWords(right.action.action);
    const common = leftWords.filter(word => rightWords.includes(word)).length;
    const sharedEvidence = (left.action.evidenceIds || []).some(id => (right.action.evidenceIds || []).includes(id));
    if (!sharedEvidence && common / Math.max(1, Math.min(leftWords.length, rightWords.length)) < 0.35) continue;
    if (!common) continue;
    const pair = { candidateId: `pair-${hash([left.ref, right.ref]).slice(0, 24)}`,
      leftRef: left.ref, rightRef: right.ref,
      nomination: { sharedEvidence, commonContentWords: common },
      leftIntoRight: mechanicalCoverage(left.action, right.action),
      rightIntoLeft: mechanicalCoverage(right.action, left.action) };
    if (candidates.length < maxCandidates) candidates.push(pair);
    else unresolved.push({ candidateId: pair.candidateId, refs: [left.ref, right.ref], reason: 'candidate_budget_exhausted' });
  }
  const packet = { version: VERSION, sourceHash: hash(sourceUnits), inputHash: hash(actions),
    meetingDate: String(input.meetingDate || ''), sourceUnits, rows, candidates, unresolved,
    policy: { evidenceLimit: limit(input.evidenceLimit, 8), flagLimit: limit(input.flagLimit, 24) },
    ...(isActionOnlySemanticScope(input.scope) ? { scope: input.scope } : {}) };
  return freeze({ ...packet, packetHash: hash(packet) });
}
function validateEnvelope(packet, envelope) {
  if (!packet || packet.version !== VERSION || packet.packetHash !== hash(packetBody(packet))) return 'invalid_or_changed_packet';
  if (!envelope || envelope.version !== VERSION || envelope.sourceHash !== packet.sourceHash
    || envelope.inputHash !== packet.inputHash || envelope.packetHash !== packet.packetHash) return 'stale_or_missing_envelope';
  if (!Array.isArray(envelope.decisions) || envelope.decisions.length !== packet.candidates.length) return 'incomplete_decision_accounting';
  const ids = new Set(packet.candidates.map(item => item.candidateId)); const seen = new Set();
  for (const decision of envelope.decisions) {
    if (!decision || !ids.has(decision.candidateId) || seen.has(decision.candidateId)
      || !RELATIONS.has(decision.relation)) return 'invalid_decision_accounting';
    seen.add(decision.candidateId);
  }
  return '';
}
function checkedSpans(packet, sourceSpans) {
  if (!Array.isArray(sourceSpans) || !sourceSpans.length) return null;
  const spans = []; const seen = new Set();
  for (const span of sourceSpans) {
    const unitId = span?.unitId ?? span?.sourceId;
    const sources = packet.sourceUnits.filter(unit => unit.id === unitId);
    if (span?.unitId && span?.sourceId && span.unitId !== span.sourceId) return null;
    if (sources.length !== 1 || typeof span.quote !== 'string' || span.quote.trim().length < 8) return null;
    const text = String(sources[0].text || '');
    // The action contract retains the complete source unit so a quote cannot
    // be clipped after a negation or prerequisite. Transport uses these exact
    // immutable unit boundaries too.
    if (span.quote !== text) return null;
    if (span.start !== undefined || span.end !== undefined) {
      if (!Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < 0 || span.end <= span.start
        || text.slice(span.start, span.end) !== span.quote) return null;
    } else if (!text.includes(span.quote)) return null;
    const key = `${unitId}|${span.start ?? text.indexOf(span.quote)}|${span.quote}`;
    if (seen.has(key)) return null;
    seen.add(key); spans.push({ unit: sources[0], quote: span.quote });
  }
  return spans;
}
function semanticCoverage(packet, proof, original, survivor) {
  const semantic = proof.semanticProof;
  if (!semantic || semantic.originalAction !== original.action.action || semantic.survivorAction !== survivor.action.action
    || !equal(semantic.originalFacets, original.facets || protectedFacets(original.action))
    || !equal(semantic.survivorFacets, survivor.facets || protectedFacets(survivor.action))) return 'missing_or_stale_semantic_facets';
  const clauses = instructionClauses(original.action.action);
  if (!Array.isArray(semantic.clauses) || semantic.clauses.length !== clauses.length) return 'incomplete_clause_mapping';
  const used = new Set();
  for (const mapping of semantic.clauses) {
    const index = clauses.findIndex((clause, at) => !used.has(at) && clause === mapping?.originalClause);
    if (index < 0 || typeof mapping.survivorClause !== 'string' || !mapping.survivorClause.trim()
      || !String(survivor.action.action).includes(mapping.survivorClause)) return 'invalid_clause_mapping';
    used.add(index);
    if (operation(mapping.originalClause) !== operation(mapping.survivorClause)) return 'different_clause_operation';
    for (const facet of ['operation', 'object']) {
      const item = mapping.facets?.[facet]; const spans = checkedSpans(packet, item?.sourceSpans);
      const originalWords = words(mapping.originalClause); const survivorWords = words(mapping.survivorClause);
      const originalValue = facet === 'operation' ? originalWords[0] : originalWords.slice(1).join(' ');
      const survivorValue = facet === 'operation' ? survivorWords[0] : survivorWords.slice(1).join(' ');
      if (!item || canonical(item.original) !== canonical(originalValue) || canonical(item.survivor) !== canonical(survivorValue)
        || !spans) return `invalid_${facet}_mapping`;
      const sourceTokens = contentWords(spans.map(span => span.quote).join(' '));
      if (facet === 'object') {
        for (const value of [originalValue, survivorValue]) {
          const tokens = contentWords(value);
          if (!tokens.length || tokens.filter(token => sourceTokens.includes(token)).length < Math.min(2, tokens.length)) {
            return 'object_without_direct_source_anchors';
          }
        }
      } else if (!spans.some(span => words(span.quote).some(word => operation(word) === operation(originalValue)))
        && !sourceOperationReviewValid(mapping.sourceOperationReview, packet, original, survivor, mapping, index)) {
        return 'operation_without_direct_source_anchor_or_independent_review';
      }
    }
  }
  return '';
}
function validateCoverage(packet, proof, original, survivor) {
  if (!proof || proof.originalRef !== original.ref || proof.survivorRef !== survivor.ref
    || !Array.isArray(proof.sourceSpans) || !proof.sourceSpans.length) return 'missing_original_coverage';
  const spans = checkedSpans(packet, proof.sourceSpans);
  if (!spans) return 'invalid_source_span';
  // Lexical grounding is a conservative necessary check, not a semantic oracle.
  // A real quote or the model's claim of equivalence alone authorizes nothing.
  const sourceWords = contentWords(spans.map(span => span.quote).join(' '));
  for (const witness of [original, survivor]) {
    if (!proof.semanticProof && !subset(contentWords(witness.action.action), sourceWords)) return 'wording_not_directly_source_grounded';
    if (!owners(witness.action).every(owner => spans.some(span => canonical(span.unit.speaker) === owner
      || canonical(span.quote).includes(owner)))) return 'owner_not_source_grounded';
  }
  const sourceComparison = comparisonNumbers(spans.map(span => span.quote).join(' '));
  const sourceFacets = protectedFacets({ action: sourceComparison });
  for (const witness of [original, survivor]) {
    const predicate = words(witness.action.action)[0];
    if (predicate && spans.some(span => [...span.quote.matchAll(/\b(?:not|never|cannot|can't|won't|mustn't|don't|doesn't)\s+(?:to\s+)?([a-z-]+)\b/gi)]
      .some(match => operation(match[1]) === operation(predicate)))) {
      return 'source_negates_operation';
    }
    const facets = protectedFacets(witness.action);
    if (!subset(facets.quantities, sourceFacets.quantities)) return 'quantity_without_direct_source_support';
    if (!subset(facets.units, sourceFacets.units)) return 'unit_without_direct_source_support';
  }
  if (conflictingTimings(original.action, survivor.action) && timingDetailCovered(original.action, survivor.action)
    && !canonical(spans.map(span => span.quote).join(' ')).includes(canonical(survivor.action.timing.wording))) {
    return 'timing_context_without_direct_source_support';
  }
  const conflicts = hardConflicts(original.action, survivor.action);
  if (conflicts.length) return conflicts.join(',');
  if (proof.semanticProof) return semanticCoverage(packet, proof, original, survivor);
  return mechanicalCoverage(original.action, survivor.action).covered ? '' : 'missing_semantic_coverage_proof';
}
function validateReconciliationReceipt(receipt, original, survivor, sourceUnits) {
  if (!receipt || receipt.version !== VERSION || receipt.sourceHash !== hash(sourceRows(sourceUnits))
    || receipt.originalHash !== hash(original) || receipt.survivorHash !== hash(survivor)
    || receipt.receiptHash !== hash(Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'receiptHash')))) return false;
  if (!Array.isArray(receipt.coverage)) return false;
  const proof = receipt.coverage.find(item => item?.originalRef === receipt.originalRef);
  return !validateCoverage({ sourceUnits: sourceRows(sourceUnits) }, proof,
    { ref: receipt.originalRef, action: original }, { ref: receipt.survivorRef, action: survivor });
}
function rebindReconciliationReceipt(receipt, beforeSurvivor, afterSurvivor, sourceUnits) {
  if (!validateReconciliationReceipt(receipt, receipt?.original, beforeSurvivor, sourceUnits)
    || actionProvenanceSignature(beforeSurvivor) !== actionProvenanceSignature(afterSurvivor)
    || typeof afterSurvivor?.id !== 'string' || !afterSurvivor.id
    || !validOccurrenceId(afterSurvivor.occurrenceId)) return null;
  if (hash(beforeSurvivor) === hash(afterSurvivor)) return freeze(clone(receipt));
  const { receiptHash: previousReceiptHash, ...previous } = receipt;
  const next = { ...clone(previous), previousReceiptHash, survivor: clone(afterSurvivor), survivorHash: hash(afterSurvivor),
    identityMapping: { before: { id: beforeSurvivor.id, occurrenceId: beforeSurvivor.occurrenceId || '' },
      after: { id: afterSurvivor.id, occurrenceId: afterSurvivor.occurrenceId } } };
  return freeze({ ...next, receiptHash: hash(next) });
}
function proofSourceIds(coverage = []) {
  const ids = [];
  const visit = value => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value.sourceSpans)) value.sourceSpans.forEach(span => ids.push(span.unitId ?? span.sourceId));
    for (const [key, item] of Object.entries(value)) if (key !== 'sourceSpans') visit(item);
  };
  visit(coverage);
  return unique(ids.filter(Boolean));
}
function buildDeterministicEnvelope(packet) {
  const byRef = new Map(packet.rows.map(row => [row.ref, row]));
  const decisions = packet.candidates.map(candidate => {
    const left = byRef.get(candidate.leftRef); const right = byRef.get(candidate.rightRef);
    const directions = [right, left].filter(survivor => [left, right]
      .every(original => mechanicalCoverage(original.action, survivor.action).covered))
      .sort((a, b) => String(b.action.action).length - String(a.action.action).length || a.ref.localeCompare(b.ref));
    for (const survivor of directions) {
      const coverage = [left, right].map(original => ({ originalRef: original.ref, survivorRef: survivor.ref,
        sourceSpans: packet.sourceUnits.filter(unit => unique([
          ...(original.action.evidenceIds || []), ...(survivor.action.evidenceIds || [])
        ]).includes(unit.id)).map(unit => ({ unitId: unit.id, start: 0, end: String(unit.text || '').length, quote: String(unit.text || '') })) }));
      if (coverage.every(proof => !validateCoverage(packet, proof, byRef.get(proof.originalRef), survivor))) {
        return { candidateId: candidate.candidateId, relation: 'equivalent', survivorRef: survivor.ref, coverage };
      }
    }
    return { candidateId: candidate.candidateId, relation: 'unresolved' };
  });
  return { version: packet.version, sourceHash: packet.sourceHash, inputHash: packet.inputHash,
    packetHash: packet.packetHash, decisions };
}
function applyActionReconciliation(packet, envelope, options = {}) {
  const fallback = (reason) => ({ actions: clone((packet?.rows || []).map(row => row.action)),
    witnesses: clone(packet?.rows || []), ledger: (packet?.candidates || []).map(candidate => ({
      candidateId: candidate.candidateId, leftRef: candidate.leftRef, rightRef: candidate.rightRef,
      status: 'blocked', reasons: [reason] })), receipts: [],
    unresolved: [...clone(packet?.unresolved || []), { reason }],
    stats: { inputCount: packet?.rows?.length || 0, outputCount: packet?.rows?.length || 0, merged: 0,
      candidateCount: packet?.candidates?.length || 0, assessed: 0, complete: false } });
  const envelopeError = validateEnvelope(packet, envelope);
  if (envelopeError) return fallback(envelopeError);
  if (options.actions && hash(options.actions) !== packet.inputHash
    || options.sourceUnits && hash(sourceRows(options.sourceUnits)) !== packet.sourceHash
    || options.meetingDate !== undefined && String(options.meetingDate) !== packet.meetingDate) return fallback('stale_current_state');
  const byRef = new Map(packet.rows.map(row => [row.ref, row]));
  const decisions = new Map(envelope.decisions.map(decision => [decision.candidateId, decision]));
  const authorized = new Map(); const ledger = []; const unresolved = clone(packet.unresolved);
  const pairKey = (a, b) => [a, b].sort().join('|');
  for (const candidate of packet.candidates) {
    const decision = decisions.get(candidate.candidateId);
    const entry = { candidateId: candidate.candidateId, leftRef: candidate.leftRef, rightRef: candidate.rightRef,
      relation: decision.relation, status: 'retained', reasons: [] };
    ledger.push(entry);
    if (!MERGES.has(decision.relation)) {
      if (decision.relation === 'unresolved' || decision.relation === 'partial_overlap') {
        unresolved.push({ candidateId: candidate.candidateId, refs: [candidate.leftRef, candidate.rightRef], reason: decision.relation });
      }
      continue;
    }
    const refs = [candidate.leftRef, candidate.rightRef];
    const survivor = byRef.get(decision.survivorRef);
    const forced = decision.relation === 'left_covered_by_right' ? candidate.rightRef
      : decision.relation === 'right_covered_by_left' ? candidate.leftRef : '';
    if (!survivor || !refs.includes(survivor.ref) || forced && forced !== survivor.ref
      || !Array.isArray(decision.coverage) || decision.coverage.length !== 2
      || decision.coverage.some(proof => !proof || typeof proof !== 'object' || !refs.includes(proof.originalRef))
      || new Set(decision.coverage.map(proof => proof.originalRef)).size !== 2) entry.reasons.push('invalid_survivor_or_coverage');
    else for (const ref of refs) {
      const original = byRef.get(ref);
      if (original.protected || survivor.protected) { entry.reasons.push('reviewer_or_kept_row'); continue; }
      const proof = decision.coverage.find(item => item.originalRef === ref);
      const sourceError = validateCoverage(packet, proof, original, survivor);
      if (sourceError) entry.reasons.push(sourceError);
      entry.reasons.push(...hardConflicts(original.action, survivor.action));
    }
    entry.reasons = unique(entry.reasons);
    if (entry.reasons.length) {
      entry.status = 'blocked'; unresolved.push({ candidateId: candidate.candidateId, refs, reason: entry.reasons.join(',') });
    } else {
      entry.status = 'authorized'; entry.survivorRef = survivor.ref;
      authorized.set(pairKey(...refs), { survivorRef: survivor.ref, decision, entry });
    }
  }
  // Build groups only when EVERY original has a direct authorized edge to the
  // same exact survivor. Never take transitive closure, or rematch pooled data.
  const groups = new Map(packet.rows.map(row => [row.ref, new Set([row.ref])]));
  const representative = new Map(packet.rows.map(row => [row.ref, row.ref]));
  for (const edge of [...authorized.values()].sort((a, b) => a.entry.candidateId.localeCompare(b.entry.candidateId))) {
    const left = representative.get(edge.entry.leftRef); const right = representative.get(edge.entry.rightRef);
    if (left === right) continue;
    const members = new Set([...groups.get(left), ...groups.get(right)]);
    const target = edge.survivorRef;
    if (![...members].every(ref => ref === target || authorized.get(pairKey(ref, target))?.survivorRef === target)) {
      edge.entry.reasons.push('no_direct_final_survivor_proof'); continue;
    }
    const originals = [...members].map(ref => byRef.get(ref).action);
    const proofEvidence = [...members].filter(ref => ref !== target)
      .flatMap(ref => proofSourceIds(authorized.get(pairKey(ref, target)).decision.coverage));
    const evidenceIds = unique([...originals.flatMap(row => row.evidenceIds || []), ...proofEvidence]);
    const reviewFlagIds = unique(originals.flatMap(row => row.reviewFlagIds || []));
    if (['_timingPublicationIssue', '_timingClauseNote'].some(field => unique(originals.map(row => row[field]).filter(Boolean)).length > 1)) {
      edge.entry.reasons.push('conflicting_warning_metadata'); continue;
    }
    if (evidenceIds.length > packet.policy.evidenceLimit || reviewFlagIds.length > packet.policy.flagLimit) {
      edge.entry.reasons.push('metadata_capacity_exceeded'); continue;
    }
    groups.delete(left); groups.delete(right); groups.set(target, members);
    members.forEach(ref => representative.set(ref, target));
  }
  const receipts = []; const outputs = new Map();
  for (const [survivorRef, members] of groups) {
    const survivor = byRef.get(survivorRef); let action = clone(survivor.action);
    if (members.size > 1) {
      const orderedMembers = [...members].sort();
      const originals = orderedMembers.map(ref => byRef.get(ref).action);
      const proofEvidence = orderedMembers.filter(ref => ref !== survivorRef)
        .flatMap(ref => proofSourceIds(authorized.get(pairKey(ref, survivorRef)).decision.coverage));
      action.evidenceIds = unique([...originals.flatMap(row => row.evidenceIds || []), ...proofEvidence]).sort();
      action.reviewFlagIds = unique(originals.flatMap(row => row.reviewFlagIds || [])).sort();
      // Rejections remain active guards for future timing checks, not merely
      // private recovery history. Keep the elected assessment and status intact.
      if (action.timingDecision) for (const field of ['rejectedExactDates', 'rejectedWordings']) {
        if (originals.some(row => Array.isArray(row.timingDecision?.[field]))) {
          action.timingDecision[field] = unique(originals.flatMap(row => Array.isArray(row.timingDecision?.[field])
            ? row.timingDecision[field] : [])).sort();
        }
      }
      for (const field of ['_unsupportedEvidenceIds', '_weakEvidenceIds', '_timingConflicts']) {
        if (originals.some(row => Array.isArray(row[field]))) action[field] = unique(originals.flatMap(row => row[field] || []));
      }
      for (const field of ['_timingPublicationIssue', '_timingClauseNote']) {
        if (!action[field]) {
          const value = originals.map(row => row[field]).find(Boolean);
          if (value) action[field] = value;
        }
      }
      const lineage = orderedMembers.map(ref => ({ ref, recordHash: byRef.get(ref).recordHash,
        original: clone(byRef.get(ref).action) }));
      for (const originalRef of orderedMembers) {
        if (originalRef === survivorRef) continue;
        const proof = authorized.get(pairKey(originalRef, survivorRef));
        const receipt = { version: VERSION, sourceHash: packet.sourceHash, inputHash: packet.inputHash,
          originalRef, survivorRef, originalHash: byRef.get(originalRef).recordHash, survivorHash: hash(action),
          original: clone(byRef.get(originalRef).action), survivor: clone(action), lineage,
          coverage: clone(proof.decision.coverage), candidateId: proof.entry.candidateId };
        receipts.push(freeze({ ...receipt, receiptHash: hash(receipt) }));
      }
    }
    outputs.set(survivorRef, action);
  }
  const emitted = new Set(); const actions = [];
  packet.rows.forEach(row => {
    const ref = representative.get(row.ref);
    if (!emitted.has(ref)) { emitted.add(ref); actions.push(outputs.get(ref)); }
  });
  for (const entry of ledger) if (entry.status === 'authorized') {
    if (representative.get(entry.leftRef) === representative.get(entry.rightRef)) entry.status = 'merged';
    else { entry.status = 'blocked'; unresolved.push({ candidateId: entry.candidateId,
      refs: [entry.leftRef, entry.rightRef], reason: entry.reasons.join(',') || 'no_direct_final_survivor_proof' }); }
  }
  return { actions, witnesses: clone(packet.rows), ledger, unresolved, receipts, stats: { inputCount: packet.rows.length, outputCount: actions.length,
    merged: packet.rows.length - actions.length, candidateCount: packet.candidates.length,
    assessed: packet.candidates.length, complete: unresolved.length === 0 } };
}
module.exports = { VERSION, prepareActionReconciliation, applyActionReconciliation,
  validateReconciliationReceipt, rebindReconciliationReceipt, validateEnvelope, buildDeterministicEnvelope, mechanicalCoverage };
