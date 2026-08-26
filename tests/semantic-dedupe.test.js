'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { duplicateGroups, cosine, splitDedupeGroupsByOwner, DEDUPE_THRESHOLD } = require('../utils/canonicalMinutes/semanticDedupe');

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

// splitDedupeGroupsByOwner: the fixture-06 danger shape. "Andrew: Confirm the nebulizer
// flow-rate specification" and "David and Colm: Review ISO 27427 once Andrew confirms it"
// share nearly all their vocabulary - a semantic group WILL contain both - and they are
// two commitments the human minutes list separately. Different real owners never merge.

test('two named owners in one group never merge with each other', () => {
  const owners = ['Andrew', 'David and Colm'];
  const clusters = splitDedupeGroupsByOwner([0, 1], (index) => owners[index], [{ a: 0, b: 1, score: 0.84, via: 'semantic' }]);
  assert.deepEqual(clusters.map((cluster) => [...cluster].sort()), [[0], [1]]);
});

test('an ownerless row joins the cluster of its scored partner, not cluster 0', () => {
  const owners = ['Andrew', 'David', 'Not stated'];
  // The ownerless row's only scored link is to David (index 1).
  const clusters = splitDedupeGroupsByOwner([0, 1, 2], (index) => owners[index], [
    { a: 1, b: 2, score: 0.9, via: 'semantic' }
  ]);
  const withOwnerless = clusters.find((cluster) => cluster.includes(2));
  assert.ok(withOwnerless.includes(1), 'ownerless row must sit with David, its evidenced partner');
  assert.ok(!withOwnerless.includes(0), 'not with Andrew, who merely came first');
});

test('an ownerless row with no scored link and several named owners stays unmerged', () => {
  const owners = ['Andrew', 'David', 'Not stated'];
  const clusters = splitDedupeGroupsByOwner([0, 1, 2], (index) => owners[index], []);
  assert.ok(!clusters.some((cluster) => cluster.includes(2)), 'a visible near-duplicate beats a silent wrong-owner absorption');
});

test('with exactly one named owner the ownerless rows attach to it', () => {
  const owners = ['Rebecca', 'Not stated', 'Not stated'];
  const clusters = splitDedupeGroupsByOwner([0, 1, 2], (index) => owners[index], []);
  assert.deepEqual(clusters.map((cluster) => [...cluster].sort()), [[0, 1, 2]]);
});

test('ownerless-only groups still merge as one cluster', () => {
  const clusters = splitDedupeGroupsByOwner([0, 1], () => 'Not stated', []);
  assert.deepEqual(clusters, [[0, 1]]);
});
