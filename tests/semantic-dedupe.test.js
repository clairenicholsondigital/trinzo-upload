'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { duplicateGroups, cosine, DEDUPE_THRESHOLD } = require('../utils/canonicalMinutes/semanticDedupe');

// Semantic near-duplicate detection, pinned without the worker. The threshold decision is
// the load-bearing part: calibrated on live pairs from the reviewer-named fixtures,
// related-but-DISTINCT rows reach 0.708 (Tom's thirty-second-intro cap beside dropping
// the 'nervous' comment - two facets, each carrying unique content), while true
// restatements sit at 0.9+. The bar must sit above every observed distinct pair, so this
// pass removes only near-restatements and judgement calls stay on the screen.

test('the threshold sits above the highest observed distinct pair', () => {
  assert.ok(DEDUPE_THRESHOLD > 0.708, `distinct pairs reach 0.708; got ${DEDUPE_THRESHOLD}`);
  assert.ok(DEDUPE_THRESHOLD < 0.916, 'true restatements at 0.916 must still merge');
});

test('injected vectors group only above the threshold', async () => {
  // Unit vectors: a and b identical (cosine 1), c orthogonal (cosine 0).
  const vectors = [[1, 0], [1, 0], [0, 1]];
  const { groups, pairs } = await duplicateGroups(['send the report', 'send the report now', 'ring the engineer'], { vectors });
  assert.deepEqual(groups, [[0, 1]]);
  assert.equal(pairs[0].via, 'semantic');
});

test('without vectors the lexical fallback decides - behaviour is never worse than today', async () => {
  const { groups, semantic, pairs } = await duplicateGroups(
    ['Send the code of conduct to the audit team', 'Send the code of conduct to the audit team today', 'Ring the refrigeration engineer'],
    { vectors: null }
  );
  assert.equal(semantic, false);
  assert.deepEqual(groups, [[0, 1]], 'nearDuplicate (0.72 min-set overlap) still fires');
  assert.equal(pairs[0].via, 'lexical');
});

test('cosine handles malformed vectors without throwing', () => {
  assert.equal(cosine(null, [1, 0]), 0);
  assert.equal(cosine([1, 0], [1]), 0);
  assert.equal(cosine([], []), 0);
});

test('every match is recorded as an auditable pair', async () => {
  const vectors = [[1, 0], [0.9, 0.436], [0, 1]];
  const { pairs } = await duplicateGroups(['a b c d', 'a b c e', 'x y z w'], { vectors, threshold: 0.85 });
  assert.equal(pairs.length, 1);
  assert.ok(pairs[0].score >= 0.85);
});

test('empty and blank texts never group', async () => {
  const { groups } = await duplicateGroups(['', '   ', 'real point here'], { vectors: null });
  assert.deepEqual(groups, []);
});
