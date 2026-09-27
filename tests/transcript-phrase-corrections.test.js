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

// Found across the twenty benchmark transcripts on 2026-09-27.
const fix = (value) => applyTranscriptPhraseCorrections(value).text;

test('standards numbers Teams mishears are put right where the sentence names the subject', () => {
  assert.equal(fix('So, in relation to the um, IEC, AC, cricky, I can\'t remember what it was, IEC AC1001, um.'), 'So, in relation to the um, IEC, AC, cricky, I can\'t remember what it was, IEC 81001-5-1, um.');
  assert.equal(fix('the review of the IEC 6061-1 standard compared to MDD documentation'), 'the review of the IEC 60601-1 standard compared to MDD documentation');
  assert.equal(fix('review of the MDD documentation in relation to IEC 6060 and the testing'), 'review of the MDD documentation in relation to IEC 60601-1 and the testing');
  assert.equal(fix('the big 60601-1 comparison'), 'the big 60601-1 comparison', 'a correct number is left alone');
  assert.equal(fix('the risk rationale for the EUMDR'), 'the risk rationale for the EU MDR');
});

test('organisations and systems heard as other words', () => {
  assert.equal(fix('The legal manufacturer, which is Data Inc. as far as Europe\'s concerned'), 'The legal manufacturer, which is DITA as far as Europe\'s concerned');
  assert.equal(fix("And this is DJ Inc.'s responsibility, Orla"), "And this is DITA's responsibility, Orla");
  assert.equal(fix('come up with MedEnvoy and DT Inc. too'), 'come up with MedEnvoy and DITA too');
  assert.equal(fix('the goods then go on to Dublin, to Deta here in Dublin'), 'the goods then go on to Dublin, to DITA here in Dublin');
  assert.equal(fix("Cody's the one working with Met Envoy, not me."), "Cody's the one working with MedEnvoy, not me.");
  assert.equal(fix('med envoy are asking the same thing'), 'MedEnvoy are asking the same thing');
  assert.equal(fix('registered within you to med and that lies with that med envoy'), 'registered within EUDAMED and that lies with that MedEnvoy');
  assert.equal(fix('put it on Udimed'), 'put it on EUDAMED');
  assert.equal(fix('when we upload to Cogni Docs or share the file'), 'when we upload to Cognidocs or share the file');
  assert.equal(fix('share for complaints, Kappa, deviations'), 'share for complaints, CAPA, deviations');
  assert.equal(fix('things like the S-BOM'), 'things like the SBOM');
  assert.equal(fix('OReilly, you\'re not in the addressee list.'), "O'Reilly, you're not in the addressee list.");
});

test('codes and figures', () => {
  assert.equal(fix('focus on TFO3 this week.'), 'focus on TF03 this week.');
  assert.equal(fix('used as part UDIDI, but'), 'used as part UDI-DI, but');
  assert.equal(fix('how do you justify A1 in 100 or one in the loop?'), 'how do you justify a 1 in 100 or one in the loop?');
});

test('"cheque" is "check" as a verb, and stays a cheque as money', () => {
  assert.equal(fix('a folder for Louise just to cheque through'), 'a folder for Louise just to check through');
  assert.equal(fix("And I'll cheque in with Rebecca"), "And I'll check in with Rebecca");
  assert.equal(fix('we should just do a cheque that we have captured this'), 'we should just do a check that we have captured this');
  assert.equal(fix('the only requirement we\'ve got to cheque with the standard'), 'the only requirement we\'ve got to check with the standard');
  assert.equal(fix('Wesley paid by cheque last year and wants a cheque for fifty.'), 'Wesley paid by cheque last year and wants a cheque for fifty.');
  const port = applyTranscriptPhraseCorrections('Port luck.to consider a port lock to be used.');
  assert.equal(port.text, 'Port lock.to consider a port lock to be used.', 'a sentence-initial capital survives');
  assert.equal(port.applied[0].to, 'Port lock', 'the log shows the words written, not a template');
  assert.equal(fix('shared their own labeling and packaging'), 'shared their own labelling and packaging');
});

test('every new correction is idempotent', () => {
  const spoken = 'IEC AC1001, IEC 6061-1, EUMDR, Data Inc., Met Envoy, you to med, Cogni Docs, Kappa, S-BOM, OReilly, TFO3, UDIDI, A1 in 100, just to cheque through, Port luck, labeling';
  const once = fix(spoken);
  assert.equal(fix(once), once);
  assert.equal(applyTranscriptPhraseCorrections(once).applied.length, 0);
});

test('correcting twice changes nothing the second time', () => {
  const once = applyTranscriptPhraseCorrections("from Abbott rate's point of view").text;
  assert.equal(applyTranscriptPhraseCorrections(once).text, once);
  assert.equal(applyTranscriptPhraseCorrections(once).applied.length, 0);
});
