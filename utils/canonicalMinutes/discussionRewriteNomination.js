'use strict';

// Nomination for a claim-preserving editor, never existing-survivor deletion.
// Only original adjacent main paragraphs with a tight shared source window.
const safety = require('./discussionMergeSafety');
const { encodeViaWorker, cosine } = require('./semanticDedupe');
const { numberWordsToValue } = require('./textNormalisation');
const figures = value => [...new Set([...(value.match(/\d+(?:[.,]\d+)?/g) || []),
  ...(value.toLowerCase().match(/\b[a-z]+\b/g) || []).map(numberWordsToValue)
    .filter(value => value !== null).map(String)])].sort();
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const tokens = value => new Set((value.toLowerCase().match(/[a-z]{4,}/g) || [])
  .filter(word => !['that', 'with', 'from', 'this', 'there', 'were', 'have', 'been', 'will', 'would'].includes(word))
  .map(word => word.length > 4 && /s$/.test(word) ? word.slice(0, -1) : word));
function overlap(a, b) {
  const left = tokens(a), right = tokens(b);
  return Math.min(left.size, right.size) ? [...left].filter(word => right.has(word)).length / Math.min(left.size, right.size) : 0;
}
const negative = value => /\b(?:no|not|never|cannot|without|[a-z]+n't|declin(?:e|ed)|reject(?:ed)?|refus(?:e|ed))\b/i.test(value);
async function nominate(discussion, sourceUnits, { eligible, encode } = {}) {
  const counts = safety.identityCounts(discussion), indices = new Map(), duplicates = new Set();
  (sourceUnits || []).forEach((unit, index) => {
    if (indices.has(unit.id)) duplicates.add(unit.id);
    indices.set(unit.id, index);
  });
  const pairs = [];
  (discussion || []).forEach((topic, ti) => {
    if (safety.protectedTopic(topic)) return;
    for (let ri = 0; ri + 1 < (topic.points || []).length; ri++) {
      const a = topic.points[ri], b = topic.points[ri + 1];
      if (!eligible(a) || !eligible(b) || counts.get(a.id) !== 1 || counts.get(b.id) !== 1
        || safety.claimsCompatible(a.text, b.text)
        || !equal(figures(a.text), figures(b.text)) || negative(a.text) !== negative(b.text)
        || !equal(safety.bounds(a.text), safety.bounds(b.text))
        || !equal(safety.phases(a.text), safety.phases(b.text))) continue;
      const evidence = [...new Set([...a.evidenceIds, ...b.evidenceIds])];
      if (new Set(a.evidenceIds.filter(id => b.evidenceIds.includes(id))).size < 2
        || evidence.some(id => duplicates.has(id) || !indices.has(id))) continue;
      const positions = evidence.map(id => indices.get(id));
      if (Math.max(...positions) - Math.min(...positions) > 7) continue;
      const lexical = overlap(a.text, b.text);
      if (lexical < 0.35) continue;
      pairs.push({ rows: [{ path: [ti, 'points', ri], record: a }, { path: [ti, 'points', ri + 1], record: b }], lexical });
    }
  });
  if (!pairs.length) return [];
  const texts = [...new Set(pairs.flatMap(pair => pair.rows.map(row => row.record.text)))];
  let vectors;
  try { vectors = await (encode || (values => encodeViaWorker(values, { timeoutMs: 4000 })))(texts); } catch { /* Fail closed below. */ }
  const byText = new Map(texts.map((text, index) => [text, vectors?.[index]]));
  return pairs.map(pair => ({ ...pair, semantic: cosine(...pair.rows.map(row => byText.get(row.record.text))) }))
    .filter(pair => pair.semantic >= 0.65 || pair.lexical >= 0.82)
    .sort((a, b) => b.semantic + b.lexical - a.semantic - a.lexical || a.rows[0].path[0] - b.rows[0].path[0]
      || a.rows[0].path[2] - b.rows[0].path[2])
    .slice(0, 1);
}
module.exports = { nominate };
