'use strict';

// The Glossary on the Settings page: wrong spellings Teams writes are
// corrected to the term in the minutes.

const test = require('node:test');
const assert = require('node:assert/strict');

const settingsStore = require('../utils/settingsStore');
const { DEFAULT_TERMS } = require('../utils/settingsDefaults');
const { normaliseDomainTerms, autoCorrections } = require('../utils/domainTerms');
const { normaliseKnownTerms } = require('../utils/meetingMinutesAgentV2');
const { reviewGeneratedContent } = require('../utils/terminologyQa');
const { validateTerm } = require('../utils/settingsDb');

test.afterEach(() => settingsStore.resetToDefaults());

test('the built-in glossary keeps the corrections that were hardcoded', () => {
  assert.equal(normaliseDomainTerms('Udimed and udemed'), 'EUDAMED and EUDAMED');
  assert.equal(normaliseDomainTerms('Deta Inc, DD Inc and T Inc'), 'DITA, DITA and DITA');
  assert.equal(normaliseDomainTerms('Medsap or meds-app'), 'MDSAP or MDSAP');
  assert.equal(normaliseDomainTerms('Two Kappas and a kappa'), 'Two CAPAs and a CAPA');
  assert.equal(normaliseDomainTerms('The labeling was labeled'), 'The labelling was labelled');
  assert.equal(normaliseDomainTerms('relabeled at Data Inc'), 'relabeled at Data Inc');
  const glossary = new Map(DEFAULT_TERMS.map((term) => [term.term, term]));
  assert.equal(glossary.get('CAPA').meaning, 'Corrective and Preventive Action');
  assert.ok(glossary.size >= 80);
});

test('a wrong spelling added on the page is corrected in new minutes', () => {
  assert.equal(normaliseKnownTerms('Send it to Med Envoy.'), 'Send it to Med Envoy.');
  settingsStore.setSettings({
    terms: [...DEFAULT_TERMS, { term: 'MedEnvoy', meaning: 'EU authorised representative', heardAs: ['Med Envoy', 'Med Envoi'] }]
  });
  assert.equal(normaliseKnownTerms('Send it to Med Envoy.'), 'Send it to MedEnvoy.');
  assert.equal(normaliseKnownTerms('send it to med-envoi'), 'send it to MedEnvoy');
  assert.equal(normaliseDomainTerms('Send it to MedEnvoy.'), 'Send it to MedEnvoy.');
  assert.ok(autoCorrections().some((item) => item.original === 'Med Envoy' && item.replacement === 'MedEnvoy'));
  const suggestions = reviewGeneratedContent({ stage: 'summary', content: { executiveSummary: 'Med Envoy will file it.' } });
  assert.ok(suggestions.some((item) => item.replacement === 'MedEnvoy' && item.autoApply), JSON.stringify(suggestions));
});

test('removing a wrong spelling on the page stops the correction', () => {
  settingsStore.setSettings({ terms: DEFAULT_TERMS.filter((term) => term.term !== 'CAPA') });
  assert.equal(normaliseDomainTerms('a kappa'), 'a kappa');
});

test('the Glossary form rejects unsafe or clashing entries', () => {
  const others = [{ term: 'CAPA', heardAs: ['Kappa'] }];
  assert.throws(() => validateTerm({ term: '' }, others), /Add the term/);
  assert.throws(() => validateTerm({ term: 'capa' }, others), /already in the glossary/);
  assert.throws(() => validateTerm({ term: 'Kappa' }, others), /wrong spelling of CAPA/);
  assert.throws(() => validateTerm({ term: 'DITA', heardAs: ['kappa'] }, others), /already used for CAPA/);
  assert.throws(() => validateTerm({ term: 'DITA', heardAs: ['TI'] }, others), /too short/);
  assert.throws(() => validateTerm({ term: 'DITA', heardAs: ['-Deta'] }, others), /start and end with a letter/);
  assert.deepEqual(
    validateTerm({ term: ' MedEnvoy ', meaning: ' EU rep ', heardAs: 'Med Envoy\nmed envoy\nMedEnvoy' }, others),
    { term: 'MedEnvoy', meaning: 'EU rep', heardAs: ['Med Envoy'] }
  );
});

test('glossary validation rejects spellings that the correction matcher treats as equivalent', () => {
  const others = [{ term: 'Cognidocs', heardAs: ['call me docs'] }];
  for (const spelling of ['call-me-docs', 'callmedocs', 'CALL ME-DOCS']) {
    assert.throws(
      () => validateTerm({ term: 'OtherSystem', heardAs: [spelling] }, others),
      /already used for Cognidocs/,
      spelling
    );
  }
  assert.throws(
    () => validateTerm({ term: 'callmedocs' }, others),
    /wrong spelling of Cognidocs/
  );
  assert.throws(
    () => validateTerm({ term: 'OtherSystem', heardAs: ['cogni docs'] }, others),
    /already used for Cognidocs/
  );
});

test('glossary validation also reserves the plural forms generated for acronym corrections', () => {
  const others = [{ term: 'CAPA', heardAs: ['Kappa'] }];
  for (const spelling of ['Kappas', 'CAPAs']) {
    assert.throws(
      () => validateTerm({ term: 'OtherTerm', heardAs: [spelling] }, others),
      /already used for CAPA/,
      spelling
    );
  }
  assert.throws(() => validateTerm({ term: 'Kappas' }, others), /wrong spelling of CAPA/);
  assert.throws(
    () => validateTerm({ term: 'OTHERTERM', heardAs: ['Kappa'] }, [{ term: 'CAPA', heardAs: ['Kappas'] }]),
    /already used for CAPA/
  );
});
