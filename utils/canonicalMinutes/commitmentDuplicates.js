'use strict';

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

function stem(token) {
  token = token.replace(/^re(?=(?:open|send|share|run|test|check|submit|start|book|schedule|issue|do|draft|write|order|confirm|visit|assess|review)$)/, '');
  return token.replace(/(?:ising|izing|ising|ations?|ation|ising)$/, (m) => (m.startsWith('ation') ? 'at' : 'is'))
    .replace(/(?:ies)$/, 'y').replace(/(?:ing|ed|es|s|ly)$/, '').replace(/(?:e)$/, '');
}
function words(value) {
  return String(value || '').toLowerCase().replace(/(\w)[-\/](\w)/g, '$1 $2').replace(/[’']/g, '').match(/[a-z0-9]{2,}/g) || [];
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
  const m = String(value || '').match(RECIPIENT);
  if (!m) return new Set();
  const phrase = m[1];
  const isPerson = /^[A-Z]/.test(phrase.trim()) || PERSON_WORD.test(phrase);
  return isPerson ? new Set(words(phrase).filter((w) => !STOP.has(w)).map(stem)) : new Set();
}
function conflictingRecipients(a, b) {
  const x = recipients(a), y = recipients(b);
  if (!x.size || !y.size) return false;
  for (const t of x) if (y.has(t)) return false;
  return true;
}
function destinations(value) {
  const m = String(value || '').replace(DEPENDENCY, '').match(DESTINATION);
  return new Set(m ? words(m[1]).filter((w) => !STOP.has(w)).map(stem) : []);
}
function conflictingDestinations(a, b) {
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

/**
 * @param {object} a action record {action, owners, evidenceIds, timing}
 * @param {object} b action record
 * @param {object} options {cosine?: number} MiniLM cosine of the two texts, when the caller has it
 * @returns {{duplicate: boolean, reason: string}}
 */
function commitmentDuplicate(a = {}, b = {}, options = {}) {
  const ta = String(a.action || a.text || ''), tb = String(b.action || b.text || '');
  if (!ta || !tb) return { duplicate: false, reason: 'empty' };
  if (ta.trim().toLowerCase() === tb.trim().toLowerCase()) return { duplicate: true, reason: 'identical' };
  if (!ownersCompatible(a, b)) return { duplicate: false, reason: 'different owners' };
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
    const at = kept.findIndex((k) => commitmentDuplicate(k.record, action, { cosine: cosineOf(k.index, index) }).duplicate);
    if (at < 0) { kept.push({ record: action, index }); return; }
    const existing = kept[at].record;
    const verdict = commitmentDuplicate(existing, action, { cosine: cosineOf(kept[at].index, index) });
    // When one action is a step of the other ("Load the documents for Grace
    // to review" inside "Load ... then download and put them in the tech
    // file"), the compound is the one that keeps both steps; dropping it for
    // the fuller-looking single step loses the second step for good.
    const steps = (r) => 1 + (String(r.action || '').match(/\b(?:then|after that|followed by|and (?:then )?(?:download|send|share|upload|update|review|confirm|check|put|insert|place|forward|circulate|submit|return|report|book|arrange|schedule|prepare|draft|write|complete|finalise|finalize|issue|raise|log|record|add|remove|test|run|deploy|release|publish|notify|inform|chase|escalate)\b)/gi) || []).length;
    const [winner, loser] = steps(action) !== steps(existing)
      ? (steps(action) > steps(existing) ? [action, existing] : [existing, action])
      : (weight(action) > weight(existing) ? [action, existing] : [existing, action]);
    kept[at] = { index: winner === action ? index : kept[at].index, record: {
      ...winner,
      owners: winner.owners && winner.owners.length ? winner.owners : (loser.owners || []),
      timing: winner.timing && winner.timing.kind && winner.timing.kind !== 'not_stated' ? winner.timing : (loser.timing || winner.timing),
      evidenceIds: [...new Set([...(winner.evidenceIds || []), ...(loser.evidenceIds || [])])].slice(0, 12),
      reviewFlagIds: [...new Set([...(winner.reviewFlagIds || []), ...(loser.reviewFlagIds || [])])]
    } };
    merged.push({ removed: String(loser.action || '').slice(0, 160), into: String(winner.action || '').slice(0, 160), reason: verdict.reason });
  });
  return { actions: kept.map((k) => k.record), merged };
}

module.exports = { commitmentDuplicate, mergeCommitmentDuplicates, objectTokens, verbClass, dependsOn, conflictingRecipients, conflictingDestinations };
