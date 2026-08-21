'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { measureCorpus, readBaseline, diffAgainstBaseline, describeChange } = require('../scripts/evidence_parse_baseline');

// Guards the parser against unintended change. Any edit to prepareEvidence()
// must leave every committed transcript fixture byte-identical, or regenerate
// the baseline deliberately with:
//   node scripts/evidence_parse_baseline.js --write
// so the diff shows exactly which transcripts changed and by how much.
test('prepareEvidence output is unchanged across the transcript corpus', async () => {
  const baseline = readBaseline();
  const rows = await measureCorpus();
  const changed = diffAgainstBaseline(rows, baseline);
  assert.deepEqual(changed.map((change) => change.file), [], `parse output changed:\n${changed.map(describeChange).join('\n')}`);
});

test('the corpus the baseline was built from is still present', async () => {
  const baseline = readBaseline();
  assert.ok(baseline.length >= 100, `expected the full transcript corpus, found ${baseline.length} fixtures`);
});
