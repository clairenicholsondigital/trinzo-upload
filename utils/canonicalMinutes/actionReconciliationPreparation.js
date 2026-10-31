'use strict';
// Actual preparation and nomination authority shared by receipt and review consumers.
const crypto = require('node:crypto');
const diagnostics = require('../meetingMinutesActionDiagnostics');
const contained = require('./containedRequirementShape');
const exactRepeat = require('./exactInstructionRepeat');
const dependency = require('./qualifiedDependencyShape');
const contactPurpose = require('./contactParaphraseShape');
const { missingRequiredLiteralWording } = require('../meetingMinutesLiteralWording');
const { isReviewerAuthored } = require('./state');
const { enquiryFrame, sameEnquiryPair, enquiryPurposeRetained } = require('./contactEnquiry');
const { convertSpokenNumbers } = require('../spokenNumbers');
const { normaliseUkCurrency } = require('./textNormalisation');
const { numberedIdentifiers, quantityTokens, unitTokens } = require('../meetingMinutesNumericTokens');
const { isActionOnlySemanticScope } = require('../meetingMinutesSemanticPolicy');
const { actionIsSafelyCovered, conflictingTimings } = require('./actionDuplicateCoverage');
const { commitmentVariantCovered, commitmentCanBeRepresented, conflictingRecipients,
  conflictingDestinations, dependsOn } = require('./commitmentDuplicates');

const comparisonNumbers = value => normaliseUkCurrency(convertSpokenNumbers(String(value || '')).text);
const VERSION = 'action-reconciliation-v1';
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
  return String(value || '').split(/;\s*|,\s*(?:and\s+|then\s+)?(?=(?:send|share|provide|review|check|test|approve|write|update|create|prepare|buy|fit|install|sign|take)\b)/i)
    .map(text => text.trim()).filter(Boolean);
}
function operationSequence(value) {
  const enquiry = enquiryFrame(value);
  if (enquiry) return [enquiry.operation];
  return unique([...String(value || '').matchAll(/(?:^|[;,]\s*(?:(?:and|then)\s+)?|\b(?:and|then)\s+)(send|share|provide|forward|circulate|review|check|confirm|assess|test|approve|write|update|revise|amend|edit|create|prepare|buy|purchase|fit|install|sign|take|address)\b/gi)]
    .map(match => operation(match[1]))).sort();
}
function sourceRows(input) {
  return (Array.isArray(input) ? input : []).map(row => clone(row));
}
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
  if (missingRequiredLiteralWording(part.action,whole.action).length) reasons.push('required_literal_wording_would_be_lost');
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
const BOUNDED_FIELDS = new Set(['id', 'action', 'owners', 'timing', 'evidenceIds', 'occurrenceId', 'reviewFlagIds', 'timingDecision']);
function boundedSurvivorPair(left, right) {
  const reject = (reason, details = {}) => { diagnostics.nomination(left, right, 'bounded_existing_survivors', reason, details); return false; };
  const eligible = row => {
    if (!row) return 'missing_record';
    if (!Object.keys(row).every(key => BOUNDED_FIELDS.has(key))) return 'unsupported_record_fields';
    if (isReviewerAuthored(row)) return 'reviewer_authored';
    if (row.owners?.length !== 1 || !String(row.owners[0]).trim()) return 'missing_or_multiple_owners';
    if (!(row.timing?.kind === 'not_stated' && !row.timing.wording && !row.timing.exactDate)) return 'structured_timing';
    if (row.reviewFlagIds?.length) return 'protected_review_flags';
    if (!(row.evidenceIds?.length > 0 && row.evidenceIds.length <= 8)) return 'missing_or_excessive_sources';
    if (row.timingDecision?.rejectedExactDates?.length || row.timingDecision?.rejectedWordings?.length) return 'rejected_timing_history';
    if (!((!row.timingDecision || row.timingDecision.reason === 'no_timing_value'
      && row.timingDecision.binding?.status === 'not_stated'))) return 'timing_binding';
    if (/[\d"“”:;()[\]{}?]|\b(?:if|unless|after|before|once|when|until|pending|following|without|not|never|only|either|or|maybe|perhaps|probably|possibly|presumably|ideally|tentatively|today|tomorrow|yesterday|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|days?|weeks?|months?|years?|hours?|minutes?|seconds?|daily|weekly|fortnightly|monthly|quarterly|annually|yearly|morning|afternoon|evening|noon|midnight|asap|soon|immediately)\b/i.test(row.action)) return 'qualified_or_unsupported_wording';
    if (/[.!?]/.test(String(row.action).replace(/[.!?]+$/, ''))) return 'multiple_sentences';
    if (/\b(?:and|then)\s+(?:send|share|provide|forward|circulate|review|check|assess|test|approve|write|update|revise|amend|edit|create|prepare|buy|purchase|fit|install|sign|take|address)\b/i.test(row.action)) return 'compound_operations';
    if (!(instructionClauses(row.action).length === 1 && operationSequence(row.action).length === 1)) return 'multiple_clauses_or_operations';
    return '';
  };
  const leftReason = eligible(left); if (leftReason) return reject(leftReason, { side: 'left' });
  const rightReason = eligible(right); if (rightReason) return reject(rightReason, { side: 'right' });
  if (words(left.action)[0] !== words(right.action)[0]) return reject('different_opening_verbs');
  if (!equal(owners(left), owners(right))) return reject('different_owners');
  if (!(left.evidenceIds || []).some(id => right.evidenceIds.includes(id))) return reject('no_shared_source');
  if (new Set([...left.evidenceIds, ...right.evidenceIds]).size > 8) return reject('source_capacity');
  const forward = hardConflicts(left, right); if (forward.length) return reject('protected_meaning_conflict', { direction: 'left_into_right', blockers: forward });
  const reverse = hardConflicts(right, left); if (reverse.length) return reject('protected_meaning_conflict', { direction: 'right_into_left', blockers: reverse });
  const a = contentWords(words(left.action).slice(1).join(' '));
  const b = contentWords(words(right.action).slice(1).join(' '));
  const common = a.filter(word => b.includes(word)).length;
  const sameBoundedOpening = a.length >= 4 && b.length >= 4
    && equal(a.slice(0, 3), b.slice(0, 3))
    && equal(unique(left.evidenceIds).sort(), unique(right.evidenceIds).sort());
  const accepted = common >= 3 && (common / Math.max(a.length, b.length) >= 0.8 || sameBoundedOpening);
  if (!accepted) return reject('insufficient_wording_overlap');
  return true;
}
function prepareActionReconciliation(input = {}) {
  const actions = Array.isArray(input.actions) ? input.actions : [];
  const sourceUnits = sourceRows(input.sourceUnits);
  const protectedIds = new Set(input.protectedOccurrenceIds || []);
  const protectedActionIds = new Set(input.protectedActionIds || []);
  const serials = new Map();
  const rows = actions.map((action, index) => {
    const record = clone(action); const recordHash = hash(record);
    const serial = serials.get(recordHash) || 0; serials.set(recordHash, serial + 1);
    const evidence = new Set(record.evidenceIds || []);
    return { ref: `witness-${recordHash.slice(0, 24)}-${serial}`, index, recordHash, action: record,
      facets: protectedFacets(record), clauses: instructionClauses(record.action),
      clauseDescriptors: instructionClauses(record.action).map(text => ({ text,
        operation: words(text)[0] || '', object: words(text).slice(1).join(' ') })),
      protected: isReviewerAuthored(record) || protectedActionIds.has(record.id)
        || Boolean(record.occurrenceId && protectedIds.has(record.occurrenceId)),
      witnesses: sourceUnits.filter(unit => evidence.has(unit.id)).map(unit => ({ sourceId: unit.id,
        sourceHash: hash(unit), text: String(unit.text || ''), speaker: String(unit.speaker || '') })) };
  });
  const candidates = []; const unresolved = []; const maxCandidates = Math.min(limit(input.maxCandidates, 64),
    ['contained_requirements','qualified_dependencies'].includes(input.scope) ? 1 : ['bounded_existing_survivors','contact_and_existing_survivors'].includes(input.scope) ? 2 : Infinity);
  const ordered = [...rows].sort((a, b) => a.ref.localeCompare(b.ref));
  // Preserve contact checks' existing priority within the unchanged pair budget.
  const classes = input.scope === 'contact_and_existing_survivors' ? ['contact_enquiries', 'bounded_existing_survivors'] : [input.scope];
  if(input.containedRequirements===true && input.scope!=='contained_requirements')classes.push('contained_requirements');
  if(input.qualifiedDependencies===true && input.scope!=='qualified_dependencies')classes.push('qualified_dependencies');
  if(input.contactParaphrases===true)classes.push('contact_paraphrases');
  if(input.contactReviews===true)classes.push('contact_reviews');
  // Qualified repeats use spare capacity only, after every established class.
  // A new nomination must not displace a previously supported comparison.
  if(input.containedRequirements===true)classes.push('qualified_repeats');
  if(input.containedRequirements===true&&input.exactInstructionRepeats===true)classes.push('exact_instruction_repeats');
  let containedCount=0,dependencyCount=0,contactPurposeCount=0,exactCount=0;
  for (const nominationClass of classes) {
   const selection=nominationClass==='exact_instruction_repeats'
    ?[...rows].sort((a,b)=>exactRepeat.orderKey(a.action).localeCompare(exactRepeat.orderKey(b.action))):ordered;
   for (let i = 0; i < selection.length; i += 1) for (let j = i + 1; j < selection.length; j += 1) {
    const left = selection[i]; const right = selection[j];
    const skipped = (reason, details) => diagnostics.nomination(left.action, right.action, nominationClass, reason, details);
    if (left.protected || right.protected) { skipped('protected_reviewer_or_kept_occurrence'); continue; }
    const contactDirection=nominationClass==='contact_paraphrases'&&input.contactParaphrases===true
      ?contactPurpose.direction(left.action,right.action,rows.map(row=>row.action)):nominationClass==='contact_reviews'&&input.contactReviews===true
        ?contactPurpose.direction(left.action,right.action,rows.map(row=>row.action),true):null;
    if(['contact_paraphrases','contact_reviews'].includes(nominationClass)&&(!contactDirection||contactPurposeCount>=1)) { skipped(!contactDirection?'contact_shape_not_supported':'contact_class_budget_exhausted'); continue; }
    if(nominationClass==='contact_reviews'&&!contactPurpose.reviewShape(contactDirection.parent,contactDirection.child)) { skipped('review_arrangement_shape_not_supported'); continue; }
    const contact = sameEnquiryPair(left.action, right.action);
    const containedClasses=['contained_requirements','qualified_repeats','exact_instruction_repeats'];
    const proposedContained=containedClasses.includes(nominationClass)&&input.containedRequirements===true
      ?contained.direction(left.action,right.action,rows.map(row=>row.action)):null;
    const containedDirection=proposedContained
      && (proposedContained.kind==='exact_instruction_repeat'?'exact_instruction_repeats':proposedContained.kind==='qualified_repeat'?'qualified_repeats':'contained_requirements')===nominationClass ? proposedContained : null;
    if(containedClasses.includes(nominationClass)&&(!containedDirection||(nominationClass==='exact_instruction_repeats'?exactCount:containedCount)>=1)) { skipped(!containedDirection?'contained_shape_not_supported':'contained_class_budget_exhausted'); continue; }
    const dependencyDirection=nominationClass==='qualified_dependencies'&&input.qualifiedDependencies===true
      ?dependency.direction(left.action,right.action,rows.map(row=>row.action)):null;
    if(nominationClass==='qualified_dependencies'&&(!dependencyDirection||dependencyCount>=1)) { skipped(!dependencyDirection?'dependency_shape_not_supported':'dependency_class_budget_exhausted'); continue; }
    if (nominationClass === 'contact_enquiries' && !contact) { skipped('enquiry_shape_not_supported'); continue; }
    if (nominationClass === 'bounded_existing_survivors'
      && (input.scope === 'contact_and_existing_survivors' && contact || !boundedSurvivorPair(left.action, right.action))) continue;
    if (input.scope !== undefined && !isActionOnlySemanticScope(input.scope)) { skipped('unsupported_policy_scope'); continue; }
    const leftWords = contentWords(left.action.action); const rightWords = contentWords(right.action.action);
    const common = leftWords.filter(word => rightWords.includes(word)).length;
    const sharedEvidence = (left.action.evidenceIds || []).some(id => (right.action.evidenceIds || []).includes(id));
    if (!sharedEvidence && common / Math.max(1, Math.min(leftWords.length, rightWords.length)) < 0.35) { skipped('insufficient_source_and_wording_overlap'); continue; }
    if (!common) { skipped('no_common_content'); continue; }
    const pair = { candidateId: `pair-${hash([left.ref, right.ref]).slice(0, 24)}`,
      leftRef: left.ref, rightRef: right.ref,
      nomination: { sharedEvidence, commonContentWords: common },
      ...(contactDirection?{contactParaphrase:{survivorRef:contactDirection.parent===left.action?left.ref:right.ref}}:{}),
      ...(containedDirection?{containedRequirement:{survivorRef:containedDirection.parent===left.action?left.ref:right.ref}}:{}),
      ...(dependencyDirection?{qualifiedDependency:{survivorRef:dependencyDirection.parent===left.action?left.ref:right.ref}}:{}),
      leftIntoRight: mechanicalCoverage(left.action, right.action),
      rightIntoLeft: mechanicalCoverage(right.action, left.action) };
    if(candidates.some(candidate=>candidate.candidateId===pair.candidateId))continue;
    if (candidates.length < maxCandidates) { skipped('nominated', { candidateId: pair.candidateId }); candidates.push(pair);if(containedDirection){if(nominationClass==='exact_instruction_repeats')exactCount++;else containedCount++;}if(dependencyDirection)dependencyCount++;if(contactDirection)contactPurposeCount++; }
    else { skipped('candidate_budget_exhausted', { candidateId: pair.candidateId }); unresolved.push({ candidateId: pair.candidateId, refs: [left.ref, right.ref], reason: 'candidate_budget_exhausted' }); }
  }
  }
  const packet = { version: VERSION, sourceHash: hash(sourceUnits), inputHash: hash(actions),
    meetingDate: String(input.meetingDate || ''), sourceUnits, rows, candidates, unresolved,
    policy: { evidenceLimit: limit(input.evidenceLimit, 8), flagLimit: limit(input.flagLimit, 24),...(input.containedRequirements===true?{containedRequirements:true}:{}),...(input.containedRequirements===true&&input.exactInstructionRepeats===true?{exactInstructionRepeats:true}:{}),...(input.qualifiedDependencies===true?{qualifiedDependencies:true}:{}),...(input.contactParaphrases===true?{contactParaphrases:true}:{}),...(input.contactReviews===true?{contactReviews:true}:{}) },
    ...(isActionOnlySemanticScope(input.scope) ? { scope: input.scope } : {}) };
  return freeze({ ...packet, packetHash: hash(packet) });
}

module.exports = { comparisonNumbers, VERSION, canonical, stable, hash, clone, freeze, unique, owners, equal, limit, STOP, words, stem, contentWords, subset, OPERATION_GROUPS, operation, instructionClauses, operationSequence, sourceRows, governingScopes, protectedFacets, timingDetailCovered, hardConflicts, mechanicalCoverage, BOUNDED_FIELDS, boundedSurvivorPair, prepareActionReconciliation };
