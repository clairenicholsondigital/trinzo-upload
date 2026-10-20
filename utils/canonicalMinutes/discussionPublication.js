'use strict';

// Publication metadata and eligibility only. These helpers never change a
// claim, remove a citation, assign work or manufacture a missing amount.
const { numericFactsOf, convertSpokenNumbers } = require('../spokenNumbers');
const { isRawTranscriptDiscussionPoint } = require('../stagedEditorial');
const { isReviewerAuthored } = require('./state');
const { isPersonalAside, isPeripheralAside } = require('./discussionContentPolicy');

const FILLER = new Set(('a an the and or for from with that this those these then than their there we you they it its our your his her them of to on in at by as be is are was were been being have has had do does did will would could should can may might said say says noted notes reported proposed proposal question summary agreement agreed discussion discussed about into only').split(' '));
const ALLOCATION = /\b(?:ringfenc(?:e|ed|ing)|earmark(?:ed|ing)?|allocat(?:e|ed|ing|ion)|reserv(?:e|ed|ing))\b/i;
const RESOURCES = /\b(?:funds?|income|surplus|revenue|budget|proceeds|balance|extra|resources?|capacity|reserves?)\b/i;
const SPECULATIVE = /\b(?:maybe|perhaps|could|might|should|would|suggest(?:ed|ion)?|propos(?:e|ed|al)|what if|can we|shall we|not yet|unconfirmed|if approved)\b/i;
const ALLOCATION_REVIEW = /\b(?:consider(?:ing|ed)?|explor(?:e|ing|ed)|discuss(?:ion|ing|ed)?|review(?:ing|ed)?|look (?:at|into)|option|possibility)\b/i;
const REJECTED = /\b(?:not (?:agreed|approved|decided)|no (?:agreement|decision)|reject(?:ed)?|did not agree|didn't agree|do not agree|don't agree|will not|won't|only a suggestion|defer(?:red)?)\b/i;
const ACCEPTED = /\b(?:agreed|approved|decided|resolved|that's decided|that is decided|signed off|already (?:allocated|reserved|earmarked|ringfenced))\b/i;
const TOPIC_SHIFT = /\b(?:next (?:item|topic)|moving on|move on|separately|turning to|any other business)\b/i;
const QUANTIFIED_CONSTRAINT = /\b(?:funds?|balance|account|budget|reserve|cost|limit|maximum|minimum|capacity|available|remaining|shortfall|shortage|stock|at most|at least|no more than|no fewer than)\b/i;
const NEGATED = /\b(?:not|never|no|without|cannot|can't|don't|doesn't|won't)\b/i;
const ANAPHORIC_ASSENT = /^\s*(?:(?:yes|yeah|yep|okay|ok|right)[,.\s]+)?(?:(?:that(?:'s| is)|it(?:'s| is)|this is|we(?:'re| are))\s+)?(?:agreed|approved|decided|resolved|fine by me)(?:\s+then)?[.!]?\s*$/i;
const SHORT_ASSENT = /^\s*(?:yes|yeah|yep|fine by me|go on)(?:[,\s]+(?:go on|absolutely|agreed|approved))?[.!]?\s*$/i;
const ASSENT_QUESTION = /\b(?:are we agreed|do we agree|is that agreed|all agreed)\b/i;
const ROW_KINDS = ['points', 'decisions', 'openQuestions'];

function sourceIndex(value = []) {
  if (value?.byId instanceof Map) return value;
  const rows = Array.isArray(value) ? value : [];
  return { byId: new Map(rows.filter(unit => unit?.id).map((unit, position) => [String(unit.id), {
    ...unit, sequence: Number(unit.sequence) || position + 1
  }])) };
}

function words(value) {
  const normal = convertSpokenNumbers(String(value || '')).text;
  return new Set((normal.toLowerCase().replace(/[’']/g, '').match(/[a-z0-9]+/g) || [])
    .filter(word => !FILLER.has(word))
    .map(word => word.replace(/(?:ing|ed)$/, '').replace(/s$/, '').replace(/e$/, ''))
    .filter(word => word.length > 1));
}

function citedUnits(record, index) {
  return [...new Set(record?.evidenceIds || [])].map(id => index.byId.get(String(id))).filter(Boolean);
}

function primaryEvidenceIdsForRecord(record = {}, source = []) {
  const index = sourceIndex(source);
  const cited = citedUnits(record, index);
  const known = new Set(cited.map(unit => String(unit.id)));
  const explicit = [...new Set(record.primaryEvidenceIds || [])].filter(id => known.has(String(id)));
  if (explicit.length) return explicit;
  // Legacy generated rows may already contain citations donated by supporting
  // context. Prefer a clearly stronger direct lexical anchor; uncertainty
  // falls back to the original citation chronology, without changing evidence.
  const names = new Set([...index.byId.values()].flatMap(unit => String(unit.speaker || '').toLowerCase().match(/[a-z]+/g) || []));
  const claim = new Set([...words(record.text)].filter(word => !names.has(word)));
  if (claim.size < 2 || cited.length < 2) return cited.map(unit => String(unit.id));
  const ranked = cited.map(unit => {
    const tokens = words(unit.text);
    const shared = [...claim].filter(word => tokens.has(word)).length;
    return { unit, shared, coverage: shared / claim.size };
  });
  const strongest = Math.max(...ranked.map(item => item.shared));
  if (strongest < 2 || strongest / claim.size < 0.25) return cited.map(unit => String(unit.id));
  const direct = ranked.filter(item => item.shared === strongest);
  return direct.map(item => String(item.unit.id));
}

function stampPrimaryDiscussionEvidence(discussion = [], sourceUnits = []) {
  const index = sourceIndex(sourceUnits);
  return (Array.isArray(discussion) ? discussion : []).map(topic => {
    if (isReviewerAuthored(topic)) return topic;
    return { ...topic, ...Object.fromEntries(ROW_KINDS.map(kind => [kind, (topic[kind] || []).map(record => {
      if (isReviewerAuthored(record)) return record;
      return { ...record, primaryEvidenceIds: primaryEvidenceIdsForRecord(record, index) };
    })])) };
  });
}

function allocationSourceClauses(value) {
  // A transcript turn can contain several unrelated claims. Acceptance of a
  // neighbouring estimate is not acceptance of an allocation in the same turn.
  const independent = '(?:(?:we|you|they|it|this|that)\\b|(?:[a-z]+\\s+){1,8}(?:is|are|was|were|has|have|will|can|must|agreed|approved|decided|resolved)\\b|(?:have\\s+)?(?:agreed|approved|decided|resolved|earmark|allocate|reserve|ringfence)\\b)';
  return String(value || '').split(new RegExp(`[;.!?]+|\\b(?:but|whereas|while)\\b|(?:\\band\\s+|,\\s*)(?=${independent})`, 'i'))
    .map(clause => clause.trim()).filter(Boolean);
}

function matchingAllocationUnits(detail, index) {
  const destination = String(detail?.text || '').match(ALLOCATION)?.index;
  if (destination == null) return [];
  const after = String(detail.text).slice(destination).match(/\b(?:for|to)\s+(.+)$/i)?.[1];
  if (!after) return [];
  const requiredDestination = words(after);
  if (!requiredDestination.size) return [];
  return citedUnits(detail, index).flatMap(unit => {
    if (!ALLOCATION.test(unit.text) || !RESOURCES.test(unit.text) || /\?/.test(unit.text)
      || NEGATED.test(unit.text) !== NEGATED.test(detail.text)
      || SPECULATIVE.test(unit.text) || ALLOCATION_REVIEW.test(unit.text) || REJECTED.test(unit.text)) return [];
    const clauses = allocationSourceClauses(unit.text);
    return clauses.flatMap((clause, position) => {
      const available = words(clause);
      return ALLOCATION.test(clause) && RESOURCES.test(clause)
        && [...requiredDestination].every(word => available.has(word))
        ? [{ ...unit, allocationClause: clause, followingAllocationClauses: clauses.slice(position + 1) }] : [];
    });
  });
}

function acceptedAllocation(unit, index, detail) {
  if (ACCEPTED.test(unit.allocationClause)) return true;
  const destination = words(String(detail.text).slice(String(detail.text).match(ALLOCATION)?.index || 0)
    .match(/\b(?:for|to)\s+(.+)$/i)?.[1] || '');
  const after = [
    ...(unit.followingAllocationClauses || []).map(text => ({ text })),
    ...[...index.byId.values()].filter(other => other.sequence > unit.sequence && other.sequence <= unit.sequence + 4)
      .sort((left, right) => left.sequence - right.sequence)
  ];
  let assentQuestion = false;
  for (const other of after) {
    if (TOPIC_SHIFT.test(other.text) || REJECTED.test(other.text)) return false;
    const tokens = words(other.text);
    const sameDestination = destination.size > 0 && [...destination].every(word => tokens.has(word));
    const sameAllocation = sameDestination && (ALLOCATION.test(other.text) || RESOURCES.test(other.text));
    const incomeChange = /\b(?:extra|additional|surplus)\b/i.test(`${unit.text} ${detail.text}`)
      && /\b(?:fees?|charges?|prices?|subscriptions?|contributions?|income|revenue|proceeds)\b/i.test(other.text)
      && /\b(?:increase|raise|up|new|higher|rise|change)\b/i.test(other.text);
    if (ASSENT_QUESTION.test(other.text) && (sameAllocation || incomeChange)) {
      assentQuestion = true;
      continue;
    }
    if (ANAPHORIC_ASSENT.test(other.text) || (assentQuestion && SHORT_ASSENT.test(other.text))) return true;
    if (ACCEPTED.test(other.text) && sameAllocation && !ALLOCATION_REVIEW.test(other.text)
      && !/\?|\b(?:if|unless|maybe|perhaps|might|would|could)\b/i.test(other.text)) return true;
    // A new substantive subject breaks the antecedent. Approval of a nearby
    // quote or purchase cannot retrospectively approve an unrelated allocation.
    if (!sameAllocation && !/^\s*(?:okay|ok|right|thanks|thank you)[.!]?\s*$/i.test(other.text)) return false;
  }
  return false;
}

function quantityBindings(value) {
  const normal = convertSpokenNumbers(String(value || '')).text.toLowerCase();
  const bindings = [];
  for (const match of normal.matchAll(/\d+(?:\.\d+)?/g)) {
    // Bind each amount to its own nearest predicate, rather than a word or
    // amount belonging to a different clause of a compound source sentence.
    const before = normal.slice(0, match.index).split(/[;!?]|\.(?!\d)|\b(?:and|but|while|whereas)\b/).at(-1);
    const after = normal.slice(match.index + match[0].length).split(/[;!?]|\.(?!\d)|\b(?:and|but|while|whereas)\b/)[0];
    const preceding = [...before.matchAll(/\b(holds?|contains?|have|has|got|balance|available|remaining|costs?|costing|estimate|quoted?|price|requests?|requested|seeks?|seeking|limit|maximum|minimum|under|over|capacity|shortfall|shortage)\b/g)].at(-1);
    let role = '';
    const predicate = preceding?.[1] || '';
    const tail = preceding ? before.slice(preceding.index + predicate.length) : '';
    // Auxiliary 'has requested...' is classified by the nearest actual
    // predicate. A remote 'account' noun is never enough to assert a balance.
    if (/^(?:hold|holds|contain|contains|have|has|got|balance|available|remaining)$/.test(predicate)
      && tail.replace(/\b(?:only|just|about|approximately|roughly|currently|at|of|is|are|now)\b/g, '').replace(/[^a-z]/g, '').length === 0
      && /\b(?:account|funds?|balance|budget|reserve|available|remaining|left)\b/.test(`${before} ${after}`)) role = 'holding';
    else if (/^(?:cost|costs|costing|estimate|quote|quoted|price)$/.test(predicate)) role = 'cost';
    else if (/^(?:request|requests|requested|seek|seeks|seeking)$/.test(predicate)) role = 'request';
    else if (/^(?:limit|maximum|minimum|under|over)$/.test(predicate)) role = `bound:${predicate}`;
    else if (/^(?:capacity|shortfall|shortage)$/.test(predicate)) role = predicate;
    if (role) {
      const subject = preceding ? before.slice(0, preceding.index) : '';
      const identities = new Set([...words(subject)].filter(word => !/^(?:wev|iv|theyv|hes|shes|ther|said|report|not|never)$/.test(word)
        && !/^\d+$/.test(word)));
      if (role === 'holding' && !/\b(?:account|funds?|balance|budget|reserve)\b/.test(subject)) {
        const resource = `${before} ${after}`.match(/\b(?:account|funds?|balance|budget|reserves?)\b/);
        if (resource) identities.add(resource[0].replace(/s$/, ''));
      }
      bindings.push({ role, amount: match[0], identities });
    }
  }
  return bindings;
}

function isSourceSupportedMaterialDetail(detail = {}, sourceUnits = []) {
  const value = String(detail?.text || '').trim();
  if (!value || /\?/.test(value) || isReviewerAuthored(detail) || isRawTranscriptDiscussionPoint(value)
    || isPersonalAside(value) || isPeripheralAside(value)
    || SPECULATIVE.test(value) || REJECTED.test(value)) return false;
  const index = sourceIndex(sourceUnits);
  const cited = citedUnits(detail, index);
  if (!cited.length) return false;
  const claim = words(value);
  const source = cited.map(unit => unit.text).join(' ');
  const supported = words(source);
  const shared = [...claim].filter(word => supported.has(word)).length;
  if (shared < 2 || shared / Math.max(1, claim.size) < 0.5) return false;
  const amounts = numericFactsOf(value);
  const sourceAmounts = numericFactsOf(source);
  if ([...amounts].some(number => !sourceAmounts.has(number))) return false;
  const allocationTail = value.slice(value.match(ALLOCATION)?.index ?? value.length);
  if (ALLOCATION.test(value) && RESOURCES.test(value) && /\b(?:for|to)\s+\S/.test(allocationTail)) {
    if (ALLOCATION_REVIEW.test(value)) return false;
    return matchingAllocationUnits(detail, index).some(unit => acceptedAllocation(unit, index, detail));
  }
  // A reported constraint is context, not an accepted action or budget. The
  // caller promotes the existing row without rewriting its status or amount.
  const requiredBindings = quantityBindings(value);
  const sourceBindings = cited.flatMap(unit => quantityBindings(unit.text));
  return amounts.size > 0 && requiredBindings.length > 0
    && [...amounts].every(amount => requiredBindings.some(binding => binding.amount === amount))
    && requiredBindings.every(binding => sourceBindings.some(other => binding.role === other.role && binding.amount === other.amount
      && [...binding.identities].every(identity => other.identities.has(identity))))
    && QUANTIFIED_CONSTRAINT.test(value) && QUANTIFIED_CONSTRAINT.test(source)
    && NEGATED.test(value) === NEGATED.test(source)
    && !/\?/.test(source) && !SPECULATIVE.test(source) && !REJECTED.test(source);
}

module.exports = { primaryEvidenceIdsForRecord, stampPrimaryDiscussionEvidence, isSourceSupportedMaterialDetail };
