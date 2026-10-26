'use strict';

const { isReviewerAuthored } = require('./state');
const { enquiryFrame } = require('./contactEnquiry');
const { contactActionFrame } = require('./contactActionGrammar');
const { actionIsLosslesslyCovered, actionIsSafelyCovered, exactActionIdentityConflict, sameActionText, conflictingTimings, actionContainmentConflict } = require('./actionDuplicateCoverage');

// One commitment written twice. The action list is assembled from two
// discovery legs, a recovery pass, the referee's reconstruction and the
// critic, so the same piece of work regularly arrives in two wordings:
// "Complete implementation of the remaining language support requiring
// additional font-driver work" beside "Review and resolve the remaining
// language character-support issues by generating the required font
// drivers". The earlier rules read the lead verb as the deliverable and the
// surface form as the words, so those two never met.
//
// This reads the pair the way a minute-taker does. Blocks first: two named
// people are two commitments (a hand-off chain: "Jenny prepares the list,
// Bernard sends it"); an action that waits on the other's deliverable is the
// next step, not a copy; a different recipient is a different errand. Then
// the levers, any one of which is enough: the same nouns from the same
// transcript lines; strong meaning match on the same lines; strong meaning
// match with the same nouns and a compatible kind of work; or one action's
// object contained in the other's. Nouns are compared after splitting
// hyphens, stripping inflection and dropping people's names, so "font-driver"
// meets "font drivers" and "requiring" meets "required".

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'those', 'these', 'then', 'than', 'their', 'there',
  'will', 'would', 'could', 'should', 'about', 'after', 'before', 'once', 'when', 'where', 'which', 'while', 'also', 'any', 'all',
  'are', 'was', 'were', 'has', 'have', 'had', 'been', 'being', 'its', 'our', 'your', 'his', 'her', 'them', 'they', 'you', 'not',
  'via', 'per', 'out', 'off', 'onto', 'over', 'if', 'whether', 'so', 'as', 'in', 'on', 'at', 'by', 'of', 'to', 'up', 'an', 'is', 'it', 'be', 'do', 'such', 'each', 'both', 'some', 'more', 'most', 'other', 'required', 'requiring',
  'necessary', 'relevant', 'related', 'appropriate', 'additional', 'remaining', 'further', 'new', 'existing', 'current']);
// Kinds of work that are interchangeable wordings of doing the thing.
const VERB_CLASS = [
  ['do', /^(?:complete|finish|finalis|finaliz|implement|resolve|fix|repair|address|sort|deliver|close|action|progress|carry|undertake|perform|execute|conduct|get|make|put|set|restore|correct|remediate|do|start|begin|commence|kick|launch|run|pilot|trial|roll|fit|install|apply|load|upload|download|place)$/],
  ['review', /^(?:review|check|assess|inspect|evaluate|analys|audit|look|read|examine|verify|validate|test|confirm|clarify|determine|establish|investigate|explore|consider)$/],
  ['send', /^(?:send|share|provide|forward|circulate|email|issue|submit|distribute|supply|pass|give|upload|post|return)$/],
  ['write', /^(?:create|produce|prepare|draft|develop|build|write|compile|document|generate|record|add|update|revise|amend|edit|rewrite|populate|capture|define|specify|scope|outline|agree|decide)$/],
  ['contact', /^(?:contact|ring|call|phone|speak|talk|reach|ask|chase|follow|liaise|arrange|schedule|book|organise|organize|coordinate|hold|meet|raise)$/],
  ['obtain', /^(?:obtain|request|procure|acquire|gather|collect|source|order|purchase|buy|secure)$/]
];
const DEPENDENCY = /\b(?:once|after|when|as soon as|following|until|subject to|pending)\b(.+)$/i;
const RECIPIENT = /\b(?:to|with)\s+(?:the\s+)?(.+?)(?=\s+\b(?:for|by|before|after|so\s+that|in\s+order\s+to|once|when)\b|[.;,]|$)/i;
// Who receives ("to Jacqui", "with the client team") versus where it goes
// ("into the technical file", "onto Cognidocs"). A different person is a
// different errand outright; a different place only keeps the loose routes
// (nouns, meaning) from firing, since "the chart colours" can be restored "to
// the intended scheme" and set "back" in one and the same job.
const PERSON_WORD = /\b(?:team|client|customer|auditor|group|committee|board|everyone|everybody|all|colleagues|staff|management|supplier|vendor|provider|organisers?|organizers?)\b/i;
const DESTINATION = /\b(?:into|onto|to|in|on)\s+(?:the\s+|a\s+|an\s+)?([a-z][a-z-]+(?:\s+[a-z][a-z-]+){0,2})(?=\s+\b(?:for|by|before|after|so\s+that|once|when|and)\b|[.;,]|$)/i;
const CONTACT_DESTINATION = new RegExp(DESTINATION.source.replace('into|onto|to|in|on', 'into|onto|to|in|on|at'), DESTINATION.flags);

function stem(token) {
  token = token.replace(/^re(?=(?:open|send|share|run|test|check|submit|start|book|schedule|issue|do|draft|write|order|confirm|visit|assess|review)$)/, '');
  return token.replace(/(?:ising|izing|ising|ations?|ation|ising)$/, (m) => (m.startsWith('ation') ? 'at' : 'is'))
    .replace(/(?:ies)$/, 'y').replace(/(?:ing|ed|es|s|ly)$/, '').replace(/(?:e)$/, '');
}
function words(value) {
  return String(value || '').toLowerCase().replace(/(\w)[-\/](\w)/g, '$1 $2').replace(/[’']/g, '').match(/[a-z0-9]{2,}/g) || [];
}

// A deliberately narrow source-bound paraphrase proof. This is not a general
// semantic matcher: it only admits an untimed pair owned by the same person,
// citing at least one of the same source units, with the same operation family,
// no conflicting recipient/destination or quantities, and enough shared
// object vocabulary to identify one occurrence. The shared citation is the
// occurrence boundary; without it, similar work remains separate.
const SOURCE_PARAPHRASE_STOP = new Set([
  ...STOP, 'again', 'also', 'complete', 'completing', 'completed', 'document',
  'documents', 'documentation', 'material', 'part', 'referenced', 'reviewed',
  'using', 'output', 'summary', 'report', 'reporting', 'change', 'changes',
  'comments', 'responses', 'feedback', 'revised', 'requesting', 'obtain'
]);
function sourceParaphraseTokens(value = '') {
  return new Set(words(value).map(stem).filter(token => token.length > 2 && !SOURCE_PARAPHRASE_STOP.has(token)));
}
function sourceParaphraseEvidence(left = {}, right = {}, sourceUnits = []) {
  const known = new Set((Array.isArray(sourceUnits) ? sourceUnits : []).map(unit => String(unit.id)));
  const rightIds = new Set((right.evidenceIds || []).map(String));
  return (left.evidenceIds || []).map(String).filter(id => rightIds.has(id) && (!known.size || known.has(id)));
}
function sourceAwareParaphraseDuplicate(left = {}, right = {}, options = {}) {
  if (!options.sourceUnits?.length || isReviewerAuthored(left) || isReviewerAuthored(right)) return false;
  if (exactOwners(left) !== exactOwners(right) || conflictingTimings(left, right)) return false;
  if (left.timing?.kind !== 'not_stated' || right.timing?.kind !== 'not_stated') return false;
  const sharedEvidence = sourceParaphraseEvidence(left, right, options.sourceUnits);
  if (!sharedEvidence.length || conflictingRecipients(left.action, right.action)
    || conflictingDestinations(left.action, right.action) || differentFigures(left.action, right.action)) return false;
  const leftVerb = verbClass(leadVerb(left.action));
  const rightVerb = verbClass(leadVerb(right.action));
  const sameReviewObject = /\breview\b/i.test(left.action) && /\breview\b/i.test(right.action);
  if (leftVerb && rightVerb && leftVerb !== rightVerb && !sameReviewObject) return false;
  if (dependsOn(left.action, right.action) || dependsOn(right.action, left.action)) return false;
  const leftTokens = sourceParaphraseTokens(left.action);
  const rightTokens = sourceParaphraseTokens(right.action);
  const shared = [...leftTokens].filter(token => rightTokens.has(token));
  const union = new Set([...leftTokens, ...rightTokens]);
  return shared.length >= 3 && shared.length / Math.max(union.size, 1) >= 0.34;
}
function sourceAwarePreferred(left = {}, right = {}) {
  const score = record => {
    const tokens = sourceParaphraseTokens(record.action);
    const numbers = words(record.action).filter(token => /\d/.test(token)).length;
    return tokens.size + Math.min(3, numbers) * 2 + Math.min(3, (record.evidenceIds || []).length) * 0.1;
  };
  return score(right) > score(left) ? right : left;
}
// Wording length is not completeness: a verbose review can omit a short,
// concrete requirement in another version. Compare detail words only after a
// pair has passed the separate deliverable/ownership/timing checks.
function commitmentDetailsCovered(part = {}, whole = {}, options = {}) {
  const scope = new Set(['not', 'if', 'whether', 'after', 'before', 'once', 'when', 'while', 'until', 'following']);
  const qualifiers = new Set(['new', 'current', 'existing', 'remaining', 'additional', 'further', 'other',
    'required', 'requiring', 'necessary', 'relevant', 'related', 'appropriate', 'any', 'all', 'each',
    'both', 'some', 'more', 'most', 'our', 'your', 'his', 'her', 'their']);
  const editingPredicates = new Set(['add', 'amend', 'capture', 'compile', 'create', 'develop', 'document',
    'draft', 'edit', 'prepare', 'produce', 'record', 'revise', 'rewrite', 'update', 'write']);
  const detail = (record) => {
    // Only remove instruction predicates. A "test report" or "review
    // checklist" contains an essential noun modifier, not another operation.
    let body = String(record.action || record.text || '');
    if (options.preserveLeadingWord !== true) body = body
      .replace(/^\s*(?:please\s+)?review\s+and\s+(?=(?:update|revise|amend|edit)\b)/i, '')
      .replace(/^\s*(?:please\s+)?([a-z-]+)\b\s*/i,
        (match, verb) => editingPredicates.has(verb.toLowerCase()) ? '' : match);
    body = body.replace(/\b(?:and|then)\s+(?:then\s+)?([a-z-]+)\b(?=\s+(?:a|an|the|this|that|these|those|our|your|their)\b)/gi,
        (match, verb) => editingPredicates.has(verb.toLowerCase()) ? ' ' : match);
    return new Set(words(body).filter((word) => !STOP.has(word) || scope.has(word)
      || (options.preserveLeadingWord === true && qualifiers.has(word))).map(stem));
  };
  const required = detail(part); const present = detail(whole);
  return required.size > 0 && [...required].every((word) => present.has(word));
}
function verbClass(token) {
  const base = stem(token);
  for (const [name, re] of VERB_CLASS) if (re.test(base) || re.test(token)) return name;
  return '';
}
function leadVerb(value) {
  return words(String(value || '').replace(/^\s*(?:please\s+)?/i, ''))[0] || '';
}
function namesIn(value) {
  return new Set((String(value || '').match(/\b[A-Z][a-z’']+(?:\s+[A-Z][a-z’']+)*\b/g) || []).flatMap((n) => words(n)));
}
// The object of the action: everything after the lead verb, without people's
// names, the waiting condition and function words; stemmed.
function objectTokens(value, extraNames = new Set()) {
  const body = String(value || '').replace(/^\s*(?:please\s+)?[A-Za-z]+(?:-[a-z]+)?\s+/, '').replace(DEPENDENCY, '');
  const names = new Set([...namesIn(value), ...extraNames]);
  return new Set(words(body).filter((w) => !STOP.has(w) && !names.has(w)).map(stem).filter((w) => w.length >= 2 && !STOP.has(w)));
}
function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0; for (const t of a) if (b.has(t)) shared += 1;
  return shared / Math.min(a.size, b.size);
}
function containment(a, b) {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  if (!small.size) return 0;
  let shared = 0; for (const t of small) if (large.has(t)) shared += 1;
  return shared / small.size;
}
function ownerSet(record) {
  return new Set((record?.owners || []).map((o) => String(o).trim().toLowerCase()).filter(Boolean));
}
function ownersCompatible(a, b) {
  const x = ownerSet(a), y = ownerSet(b);
  if (!x.size || !y.size) return true;
  for (const o of x) if (y.has(o)) return true;
  // "David Didsbury" and "David" are one person.
  for (const o of x) for (const p of y) { const fo = o.split(/\s+/)[0], fp = p.split(/\s+/)[0]; if (fo === fp) return true; }
  return false;
}
function dependsOn(waiting, step) {
  const clause = String(waiting || '').match(DEPENDENCY)?.[1] || '';
  if (!clause) return false;
  // Both waiting on the same thing is one commitment stated twice, not a chain.
  if (DEPENDENCY.test(String(step || ''))) return false;
  const stepObj = objectTokens(step);
  const clauseObj = new Set(words(clause).filter((w) => !STOP.has(w)).map(stem));
  const own = objectTokens(String(waiting).replace(DEPENDENCY, ''));
  let inClause = 0; for (const t of stepObj) if (clauseObj.has(t)) inClause += 1;
  let inOwn = 0; for (const t of stepObj) if (own.has(t)) inOwn += 1;
  return inClause > 0 && inOwn / Math.max(1, stepObj.size) < 0.34;
}
function recipients(value) {
  const contact = contactActionFrame(value);
  if (contact) return new Set(words(contact.recipient).filter(w => !STOP.has(w)).map(stem));
  const m = String(value || '').match(RECIPIENT);
  if (!m) return new Set();
  const phrase = m[1];
  const isPerson = /^[A-Z]/.test(phrase.trim()) || PERSON_WORD.test(phrase);
  return isPerson ? new Set(words(phrase).filter((w) => !STOP.has(w)).map(stem)) : new Set();
}
function conflictingRecipients(a, b) {
  const left = contactActionFrame(a), right = contactActionFrame(b);
  // Exact names, not shared first names or shared purpose words. Do not invent
  // an alias between a short name and a different explicitly named person.
  if (left && right) return left.recipient !== right.recipient;
  const x = recipients(a), y = recipients(b);
  if (!x.size || !y.size) return false;
  for (const t of x) if (y.has(t)) return false;
  return true;
}
function destinations(value) {
  const contact = contactActionFrame(value);
  const m = (contact ? contact.destinationText : String(value || '')).replace(DEPENDENCY, '').match(contact ? CONTACT_DESTINATION : DESTINATION);
  return new Set(m ? words(m[1]).filter((w) => !STOP.has(w)).map(stem) : []);
}
function conflictingDestinations(a, b) {
  const left = contactActionFrame(a), right = contactActionFrame(b);
  // "North Warehouse" and "South Warehouse" are not the same place because
  // both contain "warehouse". Keep complete explicit spatial phrases guarded.
  if (left?.namedDestinations.length && right?.namedDestinations.length
    && JSON.stringify(left.namedDestinations) !== JSON.stringify(right.namedDestinations)) return true;
  const x = destinations(a), y = destinations(b);
  if (!x.size || !y.size) return false;
  for (const t of x) if (y.has(t)) return false;
  return true;
}
function sharedEvidence(a, b) {
  const x = new Set((a?.evidenceIds || []).map(String)); const y = (b?.evidenceIds || []).map(String);
  if (!x.size || !y.length) return { count: 0, ratio: 0 };
  const count = y.filter((id) => x.has(id)).length;
  return { count, ratio: count / Math.min(x.size, y.length) };
}
// A figure one side names and the other does not ("three casks" / "six
// casks") marks a different deliverable unless it is a date or a time.
function differentFigures(a, b) {
  const figs = (v) => new Set((String(v || '').toLowerCase().match(/\b\d+(?:\.\d+)?\b/g) || []).filter((n) => !/^(?:20\d\d|1[0-9]|2[0-9]|3[01]|[1-9])$/.test(n) || Number(n) > 31));
  const x = figs(a), y = figs(b);
  if (!x.size || !y.size) return false;
  for (const n of x) if (y.has(n)) return false;
  return true;
}
// A specific thing named the same way in both: two consecutive content words
// ("chart colours", "font drivers", "risk analysis").
function sharedBigram(a, b, names = new Set()) {
  const grams = (v) => { const w = words(v).filter((t) => !STOP.has(t) && !names.has(t)).map(stem); const g = new Set(); for (let i = 0; i + 1 < w.length; i += 1) if (w[i].length >= 3 && w[i + 1].length >= 3) g.add(`${w[i]} ${w[i + 1]}`); return g; };
  const x = grams(String(a).replace(DEPENDENCY, '')), y = grams(String(b).replace(DEPENDENCY, ''));
  for (const g of x) if (y.has(g)) return true;
  return false;
}
function clauses(value) {
  const parts = String(value || '').split(/\s*;\s*|\s*,\s*(?:and\s+|then\s+)?(?=[A-Za-z]+\s)|\s+and\s+then\s+/).map((c) => c.trim()).filter(Boolean);
  // "Submit the application and confirm that the towpath has reopened": an
  // "and" followed by a verb of its own starts another piece of work.
  const out = [];
  for (const part of parts) {
    const sub = part.split(/\s+and\s+(?=[a-z]+\b)/i);
    let current = sub[0];
    for (const next of sub.slice(1)) { if (verbClass(leadVerb(next))) { out.push(current); current = next; } else current = `${current} and ${next}`; }
    out.push(current);
  }
  return out.map((c) => c.trim()).filter((c) => c.split(/\s+/).length >= 3);
}

const QUANTITY = /^(?:\d+(?:\.\d+)?|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|both|half|dozen)$/;
const NEGATION = /\b(?:not|never|without|no|cannot|can't|don't|doesn't|won't|mustn't)\b/i;
const VERSION_QUALIFIER = /\b(?:new|old|current|existing|previous|former|latest|original)\b/g;
const EXPLICIT_SCOPE = /\b(?:if|unless|after|before|once|when|until|pending|following|subject to|provided(?: that)?|as soon as|whether|by|during|within|on|at)\b[^.;]*/gi;
// Only an explicit temporal "by" phrase qualifies. "By Morgan" remains
// ordinary scope, not a deadline that can be donated to another wording.
const BY_DEADLINE = /\bby\s+(?=(?:(?:the|this|next)\s+)?(?:\d|monday\b|tuesday\b|wednesday\b|thursday\b|friday\b|saturday\b|sunday\b|today\b|tomorrow\b|tonight\b|noon\b|midday\b|midnight\b|end\b|close\b|first\b|second\b|third\b|fourth\b|fifth\b|sixth\b|seventh\b|eighth\b|ninth\b|tenth\b|eleventh\b|twelfth\b|thirteenth\b|fourteenth\b|fifteenth\b|sixteenth\b|seventeenth\b|eighteenth\b|nineteenth\b|twentieth\b|thirtieth\b|twenty\b|thirty\b))[^.;,]*?(?=\s+(?:and|then|if|unless|after|before|once|when|until|pending|following|subject to|provided|whether)\b|[.;,]|$)/gi;
function comparisonAction(record = {}) {
  return String(record.action || record.text || '').normalize('NFKC').toLowerCase()
    .replace(/[’]/g, "'").replace(/\s+/g, ' ').trim().replace(/[.!;]+$/, '')
    .replace(/^review\s+and\s+(?=(?:update|revise|amend|edit)\b)/, '');
}
function exactOwners(record = {}) {
  return [...new Set((record.owners || []).map(owner => String(owner).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()).filter(Boolean))].sort().join('|');
}
function deadlineScope(record = {}) {
  const text = comparisonAction(record);
  const enquiry = enquiryFrame(record.action || record.text);
  if (enquiry) return { deadlines: [], body: `check with ${enquiry.recipient} regarding ${enquiry.purpose}` };
  return { deadlines: text.match(BY_DEADLINE) || [], body: text.replace(BY_DEADLINE, '').replace(/\s+/g, ' ').trim() };
}
function quantityPhrases(record = {}) {
  const parts = deadlineScope(record).body.split(/[,;]|\b(?:and|or|then)\b/);
  return parts.flatMap(part => {
    const tokens = part.match(/[a-z]+(?:'[a-z]+)?|\d+(?:\.\d+)?/g) || [];
    return tokens.flatMap((token, index) => QUANTITY.test(token) ? [tokens.slice(index).join(' ')] : []);
  });
}
function sameValues(left, right) {
  const a = [...left].sort(); const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

// These comparisons must retain relationships, not just a bag of nouns. Keep
// single-letter identifiers, relation words and Unicode measurement symbols;
// the older noun matcher intentionally omits them and is not a coverage proof.
function orderedDetailWords(value = '') {
  return (String(value).normalize('NFKC').toLowerCase().replace(/[’']/g, '')
    .match(/[\p{L}\p{N}]+(?:\.[\p{N}]+)?|[£€$%‰°<>≤≥]/gu) || [])
    .filter(word => !/^(?:the|an|and)$/.test(word))
    .map(word => /^(?:from|to|for|of|as|in|on|at|by|over|under|against|between|into|onto|with|without|or|is|are)$/.test(word)
      || word.length < 3 ? word : stem(word));
}
function orderedWithin(required, retained) {
  let at = 0;
  for (const token of retained) if (token === required[at]) at += 1;
  return required.length > 0 && at === required.length;
}
function nominalInstructionBody(value = '') {
  // A single nominal "specification of [object]" can also be written
  // "[object] specification". Do not reorder any nested relation or clause.
  const body = String(value);
  const nominal = body.match(/^([\p{L}]+)\s+of\s+(?:the\s+)?([\p{L}\p{N}\s-]+)$/u);
  return nominal && !/\b(?:and|or|of|from|to|for|as|in|on|at|by|over|under|against|between|with|without|if|after|before|when|until)\b/.test(nominal[2])
    ? `${nominal[2]} ${nominal[1]}` : body;
}
function protectedMeaningConflict(left = {}, right = {}, options = {}) {
  const a = comparisonAction(left); const b = comparisonAction(right);
  // SI prefixes and symbols are case-sensitive (mL is not ML). Check them
  // before any otherwise valid case-insensitive exact-wording shortcut.
  const unitNotation = record => [...new Set(String(record.action || record.text || '').normalize('NFKC')
    .match(/(?<![\p{L}])(?:[yzafpnumcdhkMGTPEZYµμ]?(?:mol|cd|Hz|Pa|Wb|m|g|s|A|K|N|J|W|C|V|F|S|T|H|L|l|B|b))(?![\p{L}])/gu) || [])];
  const leftUnits = unitNotation(left); const rightUnits = unitNotation(right);
  if (leftUnits.length && rightUnits.length && !sameValues(leftUnits, rightUnits)) return true;
  if (a === b) return false;
  if (actionIsSafelyCovered(left, right) || actionIsSafelyCovered(right, left)) return false;
  const signatures = record => {
    const raw = String(record.action || record.text || '').normalize('NFKC');
    const value = comparisonAction(record);
    const numbers = '(?:\\d|zero\\b|one\\b|two\\b|three\\b|four\\b|five\\b|six\\b|seven\\b|eight\\b|nine\\b|ten\\b|eleven\\b|twelve\\b|twenty\\b|thirty\\b|forty\\b|fifty\\b|hundred\\b)';
    const bounds = new RegExp(`\\b(?:up to|at least|at most|more than|less than|fewer than|no more than|no less than|under|over|above|below|approximately|around|about|roughly)\\b(?=\\s+${numbers})|[<>≤≥~]`, 'g');
    return {
      units: [...new Set(raw.match(/[£€$%‰]|°\s*[\p{L}]+/gu) || [])],
      // Preserve the spelling/case of concise identifiers and unit notation.
      identifiers: [...new Set((raw.match(/[\p{L}\p{N}]+/gu) || []).filter((word, index) => index > 0
        && (word.length === 1 && /\p{L}/u.test(word) && word !== 'a'
          || /^[\p{Lu}\p{N}]+$/u.test(word) && /\p{L}/u.test(word)
          || /^\p{Ll}+\p{Lu}/u.test(word))))],
      scope: (value.match(/\b(?:except|excluding|other than|apart from)\b[^,;.]*/g) || [])
        .concat(value.match(/\b(?:all|any|each|both|some|every|only|solely|or|either|alternatively|instead)\b/g) || [], value.match(bounds) || []),
      polarity: value.match(/\b(?:not|never|without|no|cannot|can't|don't|doesn't|won't|mustn't)\b|\bnon[-\s]/g) || []
    };
  };
  const x = signatures(left); const y = signatures(right);
  if (Object.keys(x).some(key => key === 'identifiers'
    ? !x[key].every(value => y[key].includes(value)) && !y[key].every(value => x[key].includes(value))
    : !sameValues(x[key], y[key]))) return true;
  // When an instruction binds objects to roles, sources, destinations,
  // comparisons or project names, shuffled words cannot establish retention.
  if (options.scopeOnly !== true && options.allowAdditionalScope !== true) {
    const body = record => orderedDetailWords(nominalInstructionBody(instructionBody(record)));
    const frameA = instructionFrame(left); const frameB = instructionFrame(right);
    const normalized = frameA && frameB && frameA.operation === frameB.operation;
    const required = normalized ? frameA.tokens : body(left); const retained = normalized ? frameB.tokens : body(right);
    const explicitRelation = /\b(?:from|as|against|between|over|under|inside|outside|above|below|behind|beside|around|near|through|across|beneath|underneath)\b/.test(`${a} ${b}`)
      || /^(?:fit|install|place|position|connect)\b/.test(a) && /\b(?:in|on|into|onto)\b/.test(`${a} ${b}`);
    const namedEntities = record => (String(record.action || '').match(/\b[A-Z][a-z’']*\b/g) || []).slice(1);
    const leftNames = namedEntities(left); const rightNames = namedEntities(right);
    const leftShared = leftNames.filter(name => rightNames.includes(name));
    const rightShared = rightNames.filter(name => leftNames.includes(name));
    if (leftShared.length >= 2 && leftShared.join('|') !== rightShared.join('|')) return true;
    if ((explicitRelation || sameValues(required, retained))
      && !orderedWithin(required, retained) && !orderedWithin(retained, required)) return true;
  }
  return false;
}

// A bounded alternate description of one instruction. This is deliberately
// independent of embedding scores: a shared citation and similar nouns do not
// authorize removing an operation, recipient, condition, number or date.
// We only compare a single imperative (or the equivalent document/content
// construction), retain every detail token, and keep the richer existing text.
const DOCUMENT_NOUN = '(?:letter|email|memo|report|notice|brief|document|message|note|instructions|announcement|summary)';
const DOCUMENT_CONTENT_VERB = '(?:explain|describe|detail|document|summarise|summarize)';
const VARIANT_NEGATION = /\b(?:not|never|without|no|cannot|can't|don't|doesn't|won't|mustn't)\b/i;
const VARIANT_TEMPORAL_OR_GATE = /\b(?:if|unless|after|before|once|when|until|pending|following|subject to|provided(?: that)?|as soon as|whether|then|otherwise|by|during|within|on|at)\b[^.;]*/gi;
const RELATIVE_DESCRIPTION = /\b(?:that\s+(?:is|are)\s+|which\s+(?:is|are)\s+)?(?:used|provided|produced|generated|supplied)\s+by\b/gi;
const COMMUNICATION_VERB = /^(?:write|email|send|share|provide|forward|circulate|submit)\b/;
const ADDITIONAL_IMPERATIVE = /(?:[,;]\s*(?:and\s+|then\s+)?|\band\s+)(?:add|archive|book|build|circulate|collect|compile|complete|copy|create|delete|deliver|draft|email|file|fix|install|notify|order|prepare|print|publish|record|remove|repair|replace|restore|review|revise|schedule|send|share|submit|test|update|upload|write)\b/i;
function communicationPresentation(record = {}) {
  let value = comparisonAction(record);
  if (!COMMUNICATION_VERB.test(value)) return { value, repeated: false };
  // These isolated correctness adverbs describe presentation quality, not the
  // object being requested. Never strip an adjective phrase such as "properly
  // calibrated sensors", or a substantive modifier such as "securely".
  value = value.replace(/,\s*(?:properly|correctly|accurately)\s*,\s*/g, ', ');
  const leadRepeat = /^(?:write|email|send|share|provide|forward|circulate|submit)\s+again\b/.test(value);
  const recipientRepeat = value.match(/^[a-z-]+\s+to\s+(.+?)\s+again\s*,/);
  const repeated = leadRepeat || Boolean(recipientRepeat && !/\b(?:about|regarding|concerning|that|which)\b/.test(recipientRepeat[1]));
  if (repeated) value = value.replace(/\bagain\s*(,?)/, (match, comma) => comma ? ',' : ' ').replace(/\s+/g, ' ').trim();
  return { value, repeated };
}
function communicationRecipient(record = {}) {
  const value = communicationPresentation(record).value;
  return COMMUNICATION_VERB.test(value)
    ? value.match(/^[a-z-]+\s+to\s+(?:the\s+)?(.+?)(?=\s+(?:about|regarding|concerning)\b|,|$)/)?.[1]?.trim() || '' : '';
}
function instructionFrame(record = {}) {
  if (/(?:^|\W)'[^']*\s+[^']*'(?=\W|$)/.test(comparisonAction(record))) return null;
  const presentation = communicationPresentation(record);
  const original = presentation.value;
  if (!original || VARIANT_NEGATION.test(original) || /["“”:]/.test(original)
    || /\b(?:or|either|alternatively|instead)\b/.test(original) || ADDITIONAL_IMPERATIVE.test(original)) return null;
  // Reordering compound predicates could attach an object/date to the wrong
  // step. The existing exact-clause path, not this path, owns compounds.
  if (clauses(original).slice(1).some(clause => verbClass(leadVerb(clause))) || operationKeys({ action: original }).size !== 1) return null;
  const verb = leadVerb(original);
  let operation = /^(?:fit|install)$/.test(verb) ? 'install' : `verb:${verb}`;
  let body = instructionBody({ action: original });
  let artifact = '';
  const writing = original.match(new RegExp(`^(?:draft|write|prepare|create|produce)\\s+(.+?\\b${DOCUMENT_NOUN})\\s+(?:explaining|describing|detailing|documenting|summarising|summarizing)\\s+(.+)$`, 'i'));
  const content = original.match(new RegExp(`^${DOCUMENT_CONTENT_VERB}\\s+(.+)\\s+in\\s+(.+?\\b${DOCUMENT_NOUN})$`, 'i'));
  if (writing || content) {
    operation = 'write-content';
    artifact = writing ? writing[1] : content[2];
    body = `${artifact} ${writing ? writing[2] : content[1]}`;
  }
  if (!verbClass(verb) && !writing && !content) return null;
  const stripped = original.replace(RELATIVE_DESCRIPTION, 'described via');
  const scopes = (stripped.match(VARIANT_TEMPORAL_OR_GATE) || []).map(value => value.replace(/\s+/g, ' ').trim());
  const tokens = orderedDetailWords(nominalInstructionBody(body));
  return { original, operation, body, artifact, scopes, tokens, repeated: presentation.repeated };
}
function quantityValues(record = {}) {
  return new Set((comparisonAction(record).match(/[a-z]+|\d+(?:\.\d+)?/g) || []).filter(token => QUANTITY.test(token)));
}
function retainedQuantityTransition(part = {}, whole = {}) {
  const required = quantityValues(part); const retained = quantityValues(whole);
  if (sameValues(quantityPhrases(part), quantityPhrases(whole))) return true;
  // An explicit old -> new value is richer than the same instruction naming
  // only its new value. This is directional; neither competing starting values
  // nor competing targets can be hidden by the additional context.
  const transition = record => comparisonAction(record).match(/\bfrom\s+([£€$]?\s*(?:\d+(?:\.\d+)?|[a-z]+))\s+to\s+([£€$]?\s*(?:\d+(?:\.\d+)?|[a-z]+))\b/);
  if (transition(part)) return false;
  const changed = transition(whole);
  if (!changed) return false;
  const values = changed.slice(1).map(value => value.replace(/[£€$\s]/g, ''));
  return values.every(value => QUANTITY.test(value)) && required.size === 1 && required.has(values[1])
    && retained.size === new Set(values).size && values.every(value => retained.has(value));
}
function commitmentVariantCovered(part = {}, whole = {}) {
  if (isReviewerAuthored(part) || isReviewerAuthored(whole)) return false;
  if (protectedMeaningConflict(part, whole)) return false;
  const owner = exactOwners(part);
  if (!owner || owner !== exactOwners(whole) || conflictingTimings(part, whole)) return false;
  const timed = record => Boolean(record.timing?.kind && record.timing.kind !== 'not_stated');
  if (timed(part) && !timed(whole)) return false;
  const evidence = new Set(part.evidenceIds || []);
  if (!(whole.evidenceIds || []).some(id => evidence.has(id))) return false;
  const a = instructionFrame(part); const b = instructionFrame(whole);
  if (!a || !b || a.operation !== b.operation || !sameValues(a.scopes, b.scopes)) return false;
  if (a.repeated && !b.repeated) return false;
  const recipient = communicationRecipient(part);
  const sameCommunicationRecipient = recipient && recipient === communicationRecipient(whole);
  if (conflictingRecipients(part.action, whole.action)
    || (!sameCommunicationRecipient && conflictingDestinations(part.action, whole.action))) return false;
  if (!retainedQuantityTransition(part, whole)) return false;
  const leftVersions = new Set(a.original.match(VERSION_QUALIFIER) || []);
  const rightVersions = new Set(b.original.match(VERSION_QUALIFIER) || []);
  if (leftVersions.size && rightVersions.size && !sameValues(leftVersions, rightVersions)) return false;
  return a.tokens.length >= 2 && orderedWithin(a.tokens, b.tokens);
}

function reconcileCommitmentVariants(left = {}, right = {}) {
  const repeated = communicationPresentation(left).repeated || communicationPresentation(right).repeated;
  const preserveRepeat = record => {
    if (!repeated || communicationPresentation(record).repeated || !COMMUNICATION_VERB.test(comparisonAction(record))) return record;
    return { ...record, action: String(record.action).replace(/^(\s*[a-z-]+)\b/i, '$1 again') };
  };
  const completeLeft = preserveRepeat(left); const completeRight = preserveRepeat(right);
  const leftCovered = commitmentVariantCovered(left, completeRight);
  const rightCovered = commitmentVariantCovered(right, completeLeft);
  if (!leftCovered && !rightCovered) return null;
  const [winner, loser] = leftCovered && (!rightCovered || String(completeRight.action || '').length > String(completeLeft.action || '').length)
    ? [completeRight, left] : [completeLeft, right];
  const record = {
    ...winner,
    evidenceIds: [...new Set([...(winner.evidenceIds || []), ...(loser.evidenceIds || [])])],
    reviewFlagIds: [...new Set([...(winner.reviewFlagIds || []), ...(loser.reviewFlagIds || [])])]
  };
  for (const key of ['_unsupportedEvidenceIds', '_weakEvidenceIds', '_timingConflicts']) {
    if (Array.isArray(winner[key]) || Array.isArray(loser[key])) record[key] = [...new Set([...(winner[key] || []), ...(loser[key] || [])])];
  }
  for (const key of ['_timingPublicationIssue', '_timingClauseNote']) {
    if (!record[key] && loser[key]) record[key] = loser[key];
  }
  return {
    record,
    reason: 'one bounded instruction retains every operation, detail, scope and timing',
    absorbedIds: [loser.id].filter(Boolean)
  };
}
// This guard does not nominate duplicates. It prevents an existing relation
// matcher from discarding explicit scope merely because its nouns overlap.
function commitmentScopeConflict(left = {}, right = {}, options = {}) {
  if (protectedMeaningConflict(left, right, { ...options, scopeOnly: true })) return true;
  if (actionIsSafelyCovered(left, right) || actionIsSafelyCovered(right, left)) return false;
  if (commitmentVariantCovered(left, right) || commitmentVariantCovered(right, left)) return false;
  const a = comparisonAction(left); const b = comparisonAction(right);
  if (!sameValues(quantityPhrases(left), quantityPhrases(right))) return true;
  if ((NEGATION.test(a) || NEGATION.test(b)) && a !== b) return true;
  const leftVersions = new Set(a.match(VERSION_QUALIFIER) || []);
  const rightVersions = new Set(b.match(VERSION_QUALIFIER) || []);
  if (leftVersions.size && rightVersions.size && !sameValues(leftVersions, rightVersions)) return true;
  const leftDeadline = deadlineScope(left); const rightDeadline = deadlineScope(right);
  if (leftDeadline.deadlines.length && rightDeadline.deadlines.length
    && !sameValues(leftDeadline.deadlines, rightDeadline.deadlines)) return true;
  const scopes = value => value.match(EXPLICIT_SCOPE) || [];
  const leftScopes = scopes(leftDeadline.body); const rightScopes = scopes(rightDeadline.body);
  if (options.allowAdditionalScope === true && (!leftScopes.length || !rightScopes.length)) return false;
  return !sameValues(leftScopes, rightScopes);
}
function operationKey(verb) {
  const value = stem(verb);
  if (/^(?:test|run|rerun)$/.test(verb)) return 'testing';
  if (/^(?:verify|validate)$/.test(verb)) return 'verification';
  if (/^(?:start|begin|commence|kick|launch)$/.test(verb)) return 'start';
  if (/^(?:complete|finish|finalise|finalize|close)$/.test(verb)) return 'completion';
  if (/^(?:fit|install)$/.test(verb)) return 'installation';
  if (/^(?:fix|repair)$/.test(verb)) return 'repair';
  const kind = verbClass(verb);
  // "Do" is useful for nominating related candidates, but repair, replace,
  // implement and install are not interchangeable obligations.
  return kind && kind !== 'do' ? kind : `word:${value}`;
}
function operationKeys(record = {}) {
  const source = comparisonAction(record);
  const matches = source.matchAll(/(?:^|[,;:]\s*(?:(?:and|then)\s+)*|\b(?:and|then)\s+)([a-z-]+)\b/g);
  return new Set([...matches].flatMap(match => {
    const verb = match[1];
    return match.index === 0 || verbClass(verb) ? [operationKey(verb)] : [];
  }));
}
function instructionBody(record = {}) {
  return comparisonAction(record).replace(/^(?:please\s+)?[a-z-]+\s+(?:the\s+)?/, '');
}
function causativeServiceEquivalent(left = {}, right = {}) {
  const body = record => comparisonAction(record).match(/^(?:get|have)\s+(.+?\s+[a-z]+ed(?:\s+(?:before|after|by|once|when|at|on|in)\b.*)?)$/)?.[1] || '';
  const a = body(left); return Boolean(a && a === body(right));
}

function commitmentClausesRetained(part = {}, whole = {}) {
  const required = operationKeys(part);
  const requiredClauses = clauses(comparisonAction(part));
  if (requiredClauses.length <= 1 || [...required].every(key => key === 'write')) return true;
  const retainedClauses = clauses(comparisonAction(whole));
  const used = new Set();
  for (const clause of requiredClauses) {
    // Bind each operation's object and recipient together. Pooling the words
    // from two sends would accept the same objects sent to swapped people.
    const at = retainedClauses.findIndex((candidate, index) => !used.has(index)
      && operationKey(leadVerb(clause)) === operationKey(leadVerb(candidate))
      && commitmentDetailsCovered({ action: instructionBody({ action: clause }) },
        { action: instructionBody({ action: candidate }) }, { preserveLeadingWord: true }));
    if (at < 0) return false;
    used.add(at);
  }
  return true;
}
// Directional retention only. Callers must first nominate the pair using their
// existing relation matcher; neither word inclusion nor an embedding is an
// independent reason to delete an action.
function commitmentCanBeRepresented(part = {}, whole = {}) {
  if (protectedMeaningConflict(part, whole)) return false;
  if (actionIsSafelyCovered(part, whole)) return true;
  if (commitmentVariantCovered(part, whole)) return true;
  if (isReviewerAuthored(part) || isReviewerAuthored(whole)) return false;
  // The existing bounded review-and-edit wording is one editing workflow.
  // Other compounds still require the exact clause/timing-scope protection.
  if (actionContainmentConflict(part, whole) && comparisonAction(part) !== comparisonAction(whole)) return false;
  const owners = exactOwners(part);
  if (!owners || owners !== exactOwners(whole) || conflictingTimings(part, whole)) return false;
  const timed = record => Boolean(record.timing?.kind && record.timing.kind !== 'not_stated');
  if (timed(part) && !timed(whole)) return false;
  if (commitmentScopeConflict(part, whole)) return false;
  if (conflictingRecipients(part.action, whole.action) || conflictingDestinations(part.action, whole.action)) return false;
  const requiredDeadlines = deadlineScope(part).deadlines;
  const retainedDeadlines = deadlineScope(whole).deadlines;
  if (!requiredDeadlines.every(deadline => retainedDeadlines.includes(deadline))) return false;
  // A deadline for a step cannot become a deadline for a wider workflow even
  // when another pass copied the same structured timing onto the compound.
  if ((timed(part) || timed(whole)) && instructionBody(part) !== instructionBody(whole)) return false;
  if (causativeServiceEquivalent(part, whole)) return true;
  const required = operationKeys(part); const retained = operationKeys(whole);
  if (!required.size || ![...required].every(key => retained.has(key))) return false;
  if (!commitmentClausesRetained(part, whole)) return false;
  return commitmentDetailsCovered({ ...part, action: instructionBody(part) }, { ...whole, action: instructionBody(whole) },
    { preserveLeadingWord: true });
}

/**
 * @param {object} a action record {action, owners, evidenceIds, timing}
 * @param {object} b action record
 * @param {object} options {cosine?: number} MiniLM cosine of the two texts, when the caller has it
 * @returns {{duplicate: boolean, reason: string}}
 */
function commitmentDuplicate(a = {}, b = {}, options = {}) {
  const ta = String(a.action || a.text || ''), tb = String(b.action || b.text || '');
  if (!ta || !tb) return { duplicate: false, reason: 'empty' };
  if (isReviewerAuthored(a) || isReviewerAuthored(b)) return { duplicate: false, reason: 'reviewer wording' };
  if (exactActionIdentityConflict(a, b)) return { duplicate: false, reason: 'different owners or timing' };
  if (conflictingTimings(a, b)) return { duplicate: false, reason: 'different timing' };
  if (!ownersCompatible(a, b)) return { duplicate: false, reason: 'different owners' };
  if (sourceAwareParaphraseDuplicate(a, b, options)) {
    return { duplicate: true, reason: 'same source-bound occurrence with compatible paraphrase' };
  }
  if (protectedMeaningConflict(a, b)) return { duplicate: false, reason: 'different explicit scope' };
  if (sameActionText(a, b)) return { duplicate: true, reason: 'identical' };
  if (reconcileCommitmentVariants(a, b)) {
    return { duplicate: true, reason: 'one bounded instruction retains every operation, detail, scope and timing' };
  }
  if (!ownersCompatible(a, b)) return { duplicate: false, reason: 'different owners' };
  if (commitmentScopeConflict(a, b)) return { duplicate: false, reason: 'different explicit scope' };
  if (actionContainmentConflict(a, b)) return { duplicate: false, reason: 'clause scope or responsibility is not preserved' };
  if (actionIsLosslesslyCovered(a, b) || actionIsLosslesslyCovered(b, a)) {
    return { duplicate: true, reason: 'complete clause preserved with the same owner and timing' };
  }
  if (!ownersCompatible(a, b)) return { duplicate: false, reason: 'different owners' };
  if (!commitmentCanBeRepresented(a, b) && !commitmentCanBeRepresented(b, a)) {
    return { duplicate: false, reason: 'the survivor would lose obligation details or operations' };
  }
  if (dependsOn(ta, tb) || dependsOn(tb, ta)) return { duplicate: false, reason: 'one waits on the other' };
  if (conflictingRecipients(ta, tb)) return { duplicate: false, reason: 'different recipients' };
  if (differentFigures(ta, tb)) return { duplicate: false, reason: 'different figures' };
  const names = new Set([...namesIn(ta), ...namesIn(tb), ...(a.owners || []), ...(b.owners || [])].flatMap((n) => words(n)));
  const oa = objectTokens(ta, names), ob = objectTokens(tb, names);
  const nouns = overlap(oa, ob);
  const contained = containment(oa, ob);
  const ev = sharedEvidence(a, b);
  const cos = Number.isFinite(options.cosine) ? options.cosine : null;
  const va = verbClass(leadVerb(ta)), vb = verbClass(leadVerb(tb));
  const sameKind = !va || !vb || va === vb;
  const elsewhere = conflictingDestinations(ta, tb);
  // Same nouns from the same lines. A different kind of work on those nouns
  // ("start the testing" / "define the testing", "obtain a quote" / "confirm
  // the cover") needs the meaning to agree strongly as well; the same kind
  // needs it only not to disagree.
  const meaningOk = cos == null || cos >= (sameKind ? 0.5 : 0.62);
  if (!elsewhere && ev.count >= 1 && nouns >= 0.5 && meaningOk) return { duplicate: true, reason: `same nouns (${nouns.toFixed(2)}) on shared lines` };
  if (!elsewhere && ev.count >= 2 && cos != null && cos >= 0.6) return { duplicate: true, reason: `meaning ${cos.toFixed(2)} on ${ev.count} shared lines` };
  if (!elsewhere && cos != null && cos >= 0.72 && nouns >= 0.34 && sameKind) return { duplicate: true, reason: `meaning ${cos.toFixed(2)}, nouns ${nouns.toFixed(2)}, same kind of work` };
  if (ev.count >= 1 && va && vb && va === vb && nouns >= 0.34 && meaningOk && sharedBigram(ta, tb, names)) return { duplicate: true, reason: 'same specific thing named on shared lines, same kind of work' };
  if (contained >= 0.8 && Math.min(oa.size, ob.size) >= 2 && (ev.count >= 1 || (cos != null && cos >= 0.5))) {
    // "Start the electrical compliance testing" sits inside "... and define
    // the required electrical compliance testing": same nouns, different work.
    const [short, long] = oa.size <= ob.size ? [ta, tb] : [tb, ta];
    const shortKind = verbClass(leadVerb(short));
    const so = objectTokens(short, names);
    const holder = clauses(long).map((c) => ({ c, k: verbClass(leadVerb(c)), n: overlap(so, objectTokens(c, names)) })).sort((x, y) => y.n - x.n)[0];
    const holderKind = holder && holder.n > 0 ? holder.k : verbClass(leadVerb(long));
    if (!shortKind || !holderKind || shortKind === holderKind) return { duplicate: true, reason: `object contained (${contained.toFixed(2)})` };
  }
  // A clause of a compound action that is itself the other action.
  if (ev.count >= 1) {
    const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
    const so = objectTokens(short, names);
    const shortKind = verbClass(leadVerb(short));
    for (const clause of clauses(long)) {
      if (clause === long) continue;
      const clauseKind = verbClass(leadVerb(clause));
      // "update the risk file" inside a compound is not "complete tidying up
      // the risk file": the clause has to be the same kind of work too.
      if (shortKind && clauseKind && shortKind !== clauseKind) continue;
      const co = objectTokens(clause, names);
      if (so.size >= 2 && co.size >= 2 && overlap(so, co) >= 0.6) return { duplicate: true, reason: 'a clause of the compound is the other action' };
    }
  }
  return { duplicate: false, reason: `nouns ${nouns.toFixed(2)}, shared lines ${ev.count}, meaning ${cos == null ? '-' : cos.toFixed(2)}` };
}

// Merge duplicates in an action list. Keeps the fuller record (owner, timing,
// evidence, then wording length), unions evidence and flags, and reports
// what went where. `cosines` is an optional Map keyed `${i}|${j}`.
function mergeCommitmentDuplicates(actions = [], options = {}) {
  const list = Array.isArray(actions) ? actions : [];
  const cosineOf = (i, j) => (options.cosines ? options.cosines.get(`${Math.min(i, j)}|${Math.max(i, j)}`) : undefined);
  const weight = (r) => (r.owners || []).length * 4 + Number(Boolean(r.timing && r.timing.kind && r.timing.kind !== 'not_stated')) * 2
    + Math.min(6, (r.evidenceIds || []).length) + Math.min(30, String(r.action || '').split(/\s+/).length) / 30;
  const kept = []; const merged = [];
  list.forEach((action, index) => {
    const at = kept.findIndex((k) => commitmentDuplicate(k.record, action, {
      cosine: cosineOf(k.index, index), sourceUnits: options.sourceUnits
    }).duplicate);
    if (at < 0) { kept.push({ record: action, index }); return; }
    const existing = kept[at].record;
    const sourceAware = sourceAwareParaphraseDuplicate(existing, action, options);
    if (sourceAware) {
      const winner = sourceAwarePreferred(existing, action);
      kept[at] = { index: winner === action ? index : kept[at].index, record: {
        ...winner,
        evidenceIds: [...new Set([...(winner.evidenceIds || []), ...(existing.evidenceIds || []), ...(action.evidenceIds || [])])],
        reviewFlagIds: [...new Set([...(winner.reviewFlagIds || []), ...(existing.reviewFlagIds || []), ...(action.reviewFlagIds || [])])]
      } };
      merged.push({ removed: String((winner === action ? existing : action).action || '').slice(0, 160),
        into: String(winner.action || '').slice(0, 160), reason: 'same source-bound occurrence with compatible paraphrase' });
      return;
    }
    const reconciled = reconcileCommitmentVariants(existing, action);
    if (reconciled) {
      kept[at] = { index: reconciled.record.id === action.id ? index : kept[at].index, record: reconciled.record };
      merged.push({ removed: String(reconciled.absorbedIds.includes(action.id) ? action.action : existing.action).slice(0, 160),
        into: String(reconciled.record.action || '').slice(0, 160), reason: reconciled.reason });
      return;
    }
    const verdict = commitmentDuplicate(existing, action, { cosine: cosineOf(kept[at].index, index) });
    // When one action is a step of the other ("Load the documents for Grace
    // to review" inside "Load ... then download and put them in the tech
    // file"), the compound is the one that keeps both steps; dropping it for
    // the fuller-looking single step loses the second step for good.
    const steps = (r) => 1 + (String(r.action || '').match(/\b(?:then|after that|followed by|and (?:then )?(?:download|send|share|upload|update|review|confirm|check|put|insert|place|forward|circulate|submit|return|report|book|arrange|schedule|prepare|draft|write|complete|finalise|finalize|issue|raise|log|record|add|remove|test|run|deploy|release|publish|notify|inform|chase|escalate)\b)/gi) || []).length;
    const actionCovered = commitmentCanBeRepresented(action, existing);
    const existingCovered = commitmentCanBeRepresented(existing, action);
    const actionDetailsCovered = commitmentDetailsCovered(action, existing);
    const existingDetailsCovered = commitmentDetailsCovered(existing, action);
    const [winner, loser] = actionCovered !== existingCovered
      ? (actionCovered ? [existing, action] : [action, existing])
      : actionDetailsCovered !== existingDetailsCovered
      ? (actionDetailsCovered ? [existing, action] : [action, existing])
      : steps(action) !== steps(existing)
      ? (steps(action) > steps(existing) ? [action, existing] : [existing, action])
      : (weight(action) > weight(existing) ? [action, existing] : [existing, action]);
    if (!commitmentCanBeRepresented(loser, winner)) { kept.push({ record: action, index }); return; }
    kept[at] = { index: winner === action ? index : kept[at].index, record: {
      ...winner,
      owners: winner.owners && winner.owners.length ? winner.owners : (loser.owners || []),
      timing: winner.timing && winner.timing.kind && winner.timing.kind !== 'not_stated' ? winner.timing : (loser.timing || winner.timing),
      evidenceIds: [...new Set([...(winner.evidenceIds || []), ...(loser.evidenceIds || [])])],
      reviewFlagIds: [...new Set([...(winner.reviewFlagIds || []), ...(loser.reviewFlagIds || [])])]
    } };
    merged.push({ removed: String(loser.action || '').slice(0, 160), into: String(winner.action || '').slice(0, 160), reason: verdict.reason });
  });
  return { actions: kept.map((k) => k.record), merged };
}

module.exports = { commitmentDuplicate, mergeCommitmentDuplicates, commitmentDetailsCovered, commitmentCanBeRepresented, commitmentScopeConflict, commitmentClausesRetained, commitmentVariantCovered, reconcileCommitmentVariants, sourceAwareParaphraseDuplicate, sourceAwarePreferred, objectTokens, verbClass, dependsOn, conflictingRecipients, conflictingDestinations };
