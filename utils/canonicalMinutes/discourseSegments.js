'use strict';

// Where a meeting changes subject, and how discussion records are grouped by
// it. Discovery names one topic per anchor, and an anchor is an equal slice
// of the transcript, so a topic label is written 32 times for 32 captions and
// half the published topics are singletons. Naming has to happen at the level
// of a subject: segment the transcript first, have the model name each
// segment, then file every record under the segment its evidence sits in.
//
// Two signals mark a boundary. Hard: the chair's own agenda language ("And
// then we move on to the languages", "Okay, back to last week", "the next one
// was around", "Second question is around"). Soft: a drop in lexical cohesion,
// TextTiling-style, on MiniLM embeddings of the units - the mean vector of the
// k units before a gap against the k after it, cut at the deepest valleys.
// Without the embedding worker the hard markers and even spacing stand in.
// No meeting-specific vocabulary anywhere.

const { encodeViaWorker, cosine } = require('./semanticDedupe');

// Markers count only near the start of a unit, where a chair opens an item;
// "I went back to Colm yesterday" and "we're back to normal" are not shifts.
// A marker may follow one short sentence ("Okay, and then where is my other
// questions? Second question is around...").
const OPENER = String.raw`^(?:[^.?!]{0,80}[.?!]\s+)?\s*(?:(?:okay|ok|so|and|right|and then|and so|then|um|erm|yeah)[,.]?\s*){0,3}`;
const SHIFT_MARKER = new RegExp([
  OPENER + String.raw`(?:\w+\s+){0,3}(?:moving|move|let'?s move|we(?:'ll)? move|we can move|shall we move) on\b`,
  OPENER + String.raw`(?:(?:going|coming|to go) )?back to\b(?! (?:you|me|us|him|her|them|normal|that|it|the same))`,
  OPENER + String.raw`(?:\w+\s+){0,4}(?:the )?(?:next|second|third|fourth|other|last|final) (?:one|thing|item|point|question|topic|bit|area)s?\b`,
  OPENER + String.raw`(?:the\s+)?first\s+(?:thing|item|point|question|topic)\b`,
  OPENER + String.raw`(?:one more thing|another thing|the other thing|anything else|any other business|aob)\b`,
  OPENER + String.raw`(?:in terms of|in relation to|on the \w+ (?:side|front))\b`,
  OPENER + String.raw`(?:\w+,\s*)?(?:how are we (?:getting on|doing) (?:with|on)|what(?:'s| is) the (?:status|position|latest) (?:on|with)|where are we (?:with|on))\b`,
  String.raw`^\s*(?:right[,;:]?\s+)?(?:now[,;:]\s+|while\s+we(?:['’]?re|\s+are)\s+on\b[^,;:]{0,50}[,;:]\s+)(?:the\s+)?[a-z0-9]`,
  String.raw`^\s*(?:oh[,;:]?\s+)?(?:can|could|may)\s+i\s+(?:raise|bring\s+up|ask\s+about)\b`,
  String.raw`^\s*(?:okay[,;:]?\s+|right[,;:]?\s+)?go\s+on\s+then[,;:]?\s+(?:do|with|on)\b`,
  String.raw`^\s*(?:okay[,;:]?\s+|right[,;:]?\s+)?(?:the\s+)?(?:big|main)\s+one\b`
].join('|'), 'i');

const text = (value, max = 4000) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);

function meanVector(vectors) {
  const dims = vectors[0].length;
  const out = new Array(dims).fill(0);
  for (const v of vectors) for (let i = 0; i < dims; i += 1) out[i] += v[i];
  return out.map((x) => x / vectors.length);
}

async function embedUnits(texts, options) {
  if (typeof options.encode === 'function') return options.encode(texts);
  const out = new Array(texts.length).fill(null);
  for (let i = 0; i < texts.length; i += 64) {
    const batch = texts.slice(i, i + 64);
    const vectors = await encodeViaWorker(batch, { timeoutMs: Number(options.timeoutMs || 8000) });
    if (!vectors) return null;
    vectors.forEach((v, j) => { out[i + j] = v; });
  }
  return out;
}

/**
 * Split prepared transcript rows into subject segments.
 * @returns {Promise<Array<{start:number,end:number,ids:string[],hard:boolean}>>} half-open [start,end) over `units`
 */
async function discourseSegments(units = [], options = {}) {
  const rows = Array.isArray(units) ? units : [];
  const n = rows.length;
  if (n < 8) return n ? [{ start: 0, end: n, ids: rows.map((r) => r.id), hard: false }] : [];
  const k = Number(options.blockSize || 6);
  const minLen = Number(options.minSegment || 5);
  // Two is a floor, not a quota for agenda cards. The former floor of five
  // forced short or single-subject meetings into several tiny passages even
  // when the embedding valleys were weak. Explicit chairing markers can still
  // create as many real sections as the conversation contains.
  const target = Math.max(Number(options.minSegments || 2),
    Math.min(Number(options.maxSegments || 14), Math.round(n / Number(options.unitsPerSegment || 16))));

  const hard = new Set();
  rows.forEach((row, i) => { if (i >= minLen && SHIFT_MARKER.test(String(row?.text || ''))) hard.add(i); });
  const chosen = new Set(hard);

  const texts = rows.map((r) => `${r?.speaker ? `${r.speaker}: ` : ''}${text(r?.text, 600)}`);
  let vec = null;
  try { vec = await embedUnits(texts, options); } catch { vec = null; }
  const depth = new Array(n).fill(0);
  if (vec && vec.some(Boolean)) {
    const cohesion = new Array(n).fill(1);
    for (let i = 1; i < n; i += 1) {
      const left = vec.slice(Math.max(0, i - k), i).filter(Boolean);
      const right = vec.slice(i, Math.min(n, i + k)).filter(Boolean);
      if (!left.length || !right.length) continue;
      cohesion[i] = cosine(meanVector(left), meanVector(right));
    }
    for (let i = 1; i < n; i += 1) {
      let l = cohesion[i]; for (let j = i - 1; j >= 1 && cohesion[j] >= l; j -= 1) l = cohesion[j];
      let r = cohesion[i]; for (let j = i + 1; j < n && cohesion[j] >= r; j += 1) r = cohesion[j];
      depth[i] = (l - cohesion[i]) + (r - cohesion[i]);
    }
  } else {
    // No embeddings: space the remaining cuts evenly between the hard ones.
    for (let i = 1; i < n; i += 1) depth[i] = (i % Math.max(minLen, Math.round(n / target)) === 0) ? 1 : 0;
  }
  const ranked = depth.map((d, i) => [d, i]).filter(([, i]) => i >= minLen && i <= n - minLen).sort((a, b) => b[0] - a[0]);
  const farEnough = (i) => [...chosen].every((b) => Math.abs(b - i) >= minLen);
  for (const [d, i] of ranked) {
    if (chosen.size >= target - 1) break; // target counts segments; cuts are one fewer
    if (d <= 0 || !farEnough(i)) continue;
    chosen.add(i);
  }
  const segments = [];
  let start = 0;
  for (const cut of [...[...chosen].sort((a, b) => a - b), n]) {
    if (cut - start <= 0) continue;
    segments.push({ start, end: cut, ids: rows.slice(start, cut).map((r) => r.id), hard: hard.has(start) });
    start = cut;
  }
  for (let i = segments.length - 1; i > 0; i -= 1) {
    if (segments[i].end - segments[i].start < minLen) {
      segments[i - 1].end = segments[i].end; segments[i - 1].ids.push(...segments[i].ids); segments.splice(i, 1);
    }
  }
  return segments;
}

// Segments as anchors for the discovery prompt, so the model names each one.
function segmentAnchors(units = [], segments = [], options = {}) {
  const maxChars = Number(options.maxChars || 48000);
  const budget = Math.floor(maxChars / Math.max(1, segments.length));
  return segments.map((seg) => {
    const rows = units.slice(seg.start, seg.end);
    const perUnit = Math.max(70, Math.floor(budget / Math.max(1, rows.length)));
    const window = rows.map((u) => `[${u.id}] ${u.speaker || ''}: ${text(u.text, perUnit)}`).join('\n');
    return {
      anchorId: `DS-${seg.ids[0]}-${seg.ids[seg.ids.length - 1]}`,
      evidenceIds: seg.ids.slice(0, 12),
      window: text(window, budget),
      cues: 'discussion_fact',
      priority: 1
    };
  });
}

// One label per segment from the naming reply; '' where the model gave none.
function segmentLabels(result = {}, anchors = []) {
  const rows = Array.isArray(result?.anchorResults) ? result.anchorResults : [];
  return anchors.map((anchor) => {
    const row = rows.find((item) => String(item?.anchorId || '') === anchor.anchorId);
    return row ? text(row.topic, 120) : '';
  });
}

// File each discovered record under the label of the segment holding most of
// its evidence. Records whose segment has no label keep their own topic.
function regroupDiscussionBySegments(discussion = [], units = [], segments = [], labels = []) {
  const posOf = new Map(units.map((u, i) => [u?.id, i]));
  const segmentOf = (id) => { const p = posOf.get(id); return p == null ? -1 : segments.findIndex((s) => p >= s.start && p < s.end); };
  const topics = new Map();
  let moved = 0;
  const kinds = ['points', 'decisions', 'openQuestions'];
  for (const topic of Array.isArray(discussion) ? discussion : []) {
    for (const kind of kinds) {
      for (const record of topic?.[kind] || []) {
        const votes = new Map();
        for (const id of record?.evidenceIds || []) { const s = segmentOf(id); if (s >= 0) votes.set(s, (votes.get(s) || 0) + 1); }
        const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
        const label = best && labels[best[0]] ? labels[best[0]] : text(topic?.topic, 240) || 'Discussion';
        if (best && labels[best[0]] && label !== topic?.topic) moved += 1;
        // Topic-level fields travel with the first topic that feeds a label.
        if (!topics.has(label)) topics.set(label, { ...(topic || {}), id: `topic-${topics.size + 1}`, topic: label, points: [], decisions: [], openQuestions: [] });
        topics.get(label)[kind].push(record);
      }
    }
  }
  return { discussion: [...topics.values()], moved };
}

module.exports = { discourseSegments, segmentAnchors, segmentLabels, regroupDiscussionBySegments, SHIFT_MARKER };
