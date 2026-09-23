'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyTranscriptPhraseCorrections } = require('../utils/domainTerms');

test('a confirmed phrase is corrected in the transcript the models read', () => {
  const spoken = "you will just need to reference that it's his name because it's for from Abbott Rate's point of view";
  const result = applyTranscriptPhraseCorrections(spoken);
  assert.match(result.text, /Abbott corporate rate's point of view/);
  assert.equal(result.applied[0].count, 1);
  // Lower case and spacing variants, and nothing else touched.
  assert.match(applyTranscriptPhraseCorrections('booked at the abbott  rate').text, /abbott corporate rate/i);
  assert.equal(applyTranscriptPhraseCorrections('The Abbott audit starts on Monday.').applied.length, 0);
});

test('correcting twice changes nothing the second time', () => {
  const once = applyTranscriptPhraseCorrections("from Abbott rate's point of view").text;
  assert.equal(applyTranscriptPhraseCorrections(once).text, once);
  assert.equal(applyTranscriptPhraseCorrections(once).applied.length, 0);
});
