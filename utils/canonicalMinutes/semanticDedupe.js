'use strict';

// Semantic near-duplicate detection for published rows and points.
//
// The lexical dedupe (min-set overlap >= 0.6) cannot see paraphrases: "Provide the
// applicable classifications and an overview of the products" and "Provide overall view
// of products" share too few tokens to trip it, and the corroboration filter KEEPS a
// deterministic row when a proposal overlaps it at only 0.34 - so the 0.34-0.6 band
// publishes the same commitment twice, once in each wording. That band is where the
// reviewer's duplicates live.
//
// MiniLM cosine was validated for exactly this shape in the scorecard's semantic tier
// (zero false fires across 373 cross-meeting control pairs at 0.6), and the resident
// trinzo-minilm-worker serves /encode with the model already loaded. On any worker
// failure the caller falls back to the lexical rule, so behaviour without the worker is
// today's behaviour, never worse.

const { clean } = require('./evidence');
// Required lazily: trooperPolish requires this module for `cosine`, so a top-level
// require here would be circular and would resolve `nearDuplicate` to undefined -
// silently disabling the lexical fallback exactly when the worker is down.
const lexicalNearDuplicate = (left, right) => require('./trooperPolish').nearDuplicate(left, right);

const WORKER_URL = () => (process.env.MINUTES_MINILM_WORKER_URL || 'http://127.0.0.1:8767').replace(/\/$/, '');

// Grouping threshold, calibrated on live pairs from the four reviewer-named fixtures
// (2026-08-26). Related-but-DISTINCT rows reach 0.566 ("Group the chat questions" vs
// "Write three backup questions") and 0.708 (Tom's thirty-second-intro cap vs dropping
// the 'nervous' comment - two facets, each carrying unique content, where a merge loses
// information). True restatements sit at 0.9+ ("...anticipated to be completed by July
// 23rd" vs "...scheduled to finish on 23rd July" = 0.916). 0.80 sits above every
// observed distinct pair: this pass removes only near-restatements, and judgement calls
// stay on the screen for the reviewer.
const DEDUPE_THRESHOLD = Number(process.env.DEDUPE_THRESHOLD || 0.8);

async function encodeViaWorker(texts, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(options.timeoutMs || 4000));
    const response = await fetchImpl(`${WORKER_URL()}/encode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts }),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!response.ok) return null;
    const body = await response.json();
    const embeddings = body?.embeddings;
    if (!embeddings || typeof embeddings !== 'object') return null;
    return texts.map((text) => embeddings[text] || null);
  } catch {
    return null;
  }
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const norm = Math.sqrt(na) * Math.sqrt(nb);
  return norm ? dot / norm : 0;
}

// Groups indexes of near-duplicate texts. Greedy and order-stable: each text joins the
// first earlier group whose SEED it matches, so the outcome does not depend on comparison
// order beyond the input order itself. `pairs` records every match with its score so the
// caller can print them - a merge that cannot be audited is a merge that hides a bug.
async function duplicateGroups(texts, options = {}) {
  const cleaned = texts.map((text) => clean(text));
  const vectors = options.vectors !== undefined ? options.vectors : await encodeViaWorker(cleaned, options);
  const threshold = Number(options.threshold || DEDUPE_THRESHOLD);
  const groups = [];
  const groupOf = new Array(cleaned.length).fill(-1);
  const pairs = [];
  const matches = (i, j) => {
    if (vectors && vectors[i] && vectors[j]) {
      const score = cosine(vectors[i], vectors[j]);
      if (score >= threshold) { pairs.push({ a: i, b: j, score: Number(score.toFixed(3)), via: 'semantic' }); return true; }
      return false;
    }
    if (lexicalNearDuplicate(cleaned[i], cleaned[j])) { pairs.push({ a: i, b: j, score: null, via: 'lexical' }); return true; }
    return false;
  };
  for (let i = 0; i < cleaned.length; i += 1) {
    if (!cleaned[i]) { continue; }
    let placed = false;
    for (const group of groups) {
      if (matches(group[0], i)) { group.push(i); groupOf[i] = groups.indexOf(group); placed = true; break; }
    }
    if (!placed) { groupOf[i] = groups.length; groups.push([i]); }
  }
  return { groups: groups.filter((group) => group.length > 1), groupOf, pairs, semantic: Boolean(vectors) };
}

// Splits one near-duplicate group into clusters that may actually merge, honouring
// owners. Two rows with different REAL owners are different commitments whatever the
// words say - that rule already held. What did not hold: ownerless rows were attached
// wholesale to the FIRST named cluster, so with two named owners in a group an ownerless
// row merged into an arbitrary one - and the survivor's owner then spoke for content
// that may belong to the other person.
//
// Now an ownerless row joins a named cluster only on evidence: the group's `pairs`
// (every scored match duplicateGroups recorded) must link it to a member of that
// cluster. duplicateGroups matches members against the group SEED, so the pair graph is
// a star - which means the link exists exactly when the seed is involved; with more than
// one named owner and no direct link, the row is left unmerged. A visible near-duplicate
// beats a silent wrong-owner absorption, and an unmerged ownerless row costs nothing
// downstream - "Not stated" passes every owner gate.
//
// With exactly ONE named owner in the group the ownerless rows attach to it, which is
// both today's behaviour and the only owner the content could belong to.
function splitDedupeGroupsByOwner(members, ownerOf, pairs = []) {
  const named = new Map();
  const unowned = [];
  for (const index of members) {
    const owner = String(ownerOf(index) || 'Not stated');
    if (owner === 'Not stated') { unowned.push(index); continue; }
    if (!named.has(owner)) named.set(owner, []);
    named.get(owner).push(index);
  }
  if (!named.size) return unowned.length ? [unowned] : [];
  const clusters = [...named.values()].map((indexes) => [...indexes]);
  const clusterOf = new Map();
  clusters.forEach((cluster, at) => cluster.forEach((index) => clusterOf.set(index, at)));
  for (const index of unowned) {
    if (named.size === 1) { clusters[0].push(index); continue; }
    let best = null;
    for (const pair of pairs) {
      const partner = pair.a === index ? pair.b : (pair.b === index ? pair.a : null);
      if (partner === null || !clusterOf.has(partner)) continue;
      if (!best || (pair.score ?? 0) > (best.score ?? 0)) best = { cluster: clusterOf.get(partner), score: pair.score };
    }
    if (best) clusters[best.cluster].push(index);
    // No link and several possible owners: the row stays on the screen, unmerged.
  }
  return clusters;
}

module.exports = { encodeViaWorker, duplicateGroups, cosine, splitDedupeGroupsByOwner, DEDUPE_THRESHOLD };
