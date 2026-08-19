'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewGeneratedContent } = require('../utils/terminologyQa');

test('terminology QA suggests explicit aliases and acronym capitalisation after generation', () => {
  const suggestions = reviewGeneratedContent({
    stage: 'discussion',
    content: [{ topic: 'Quality system', points: ['The Kappa investigation will update the qms.'] }],
    scope: { type: 'project', key: 'T819' }
  });
  assert.ok(suggestions.some((item) => item.original === 'Kappa' && item.replacement === 'CAPA'));
  assert.ok(suggestions.some((item) => item.original === 'qms' && item.replacement === 'QMS'));
});

test('terminology QA marks configured transcript corrections for automatic application', () => {
  const suggestions = reviewGeneratedContent({
    stage: 'discussion',
    content: [{
      topic: 'Regulatory terms',
      points: [
        'Udemed and Udimed evidence was reviewed for existing products.',
        'The Meds app audit scope included S-BOM and Kappa evidence.'
      ]
    }],
    scope: { type: 'project', key: 'T819' }
  });
  const automatic = suggestions.filter((item) => item.autoApply).map((item) => `${item.original}->${item.replacement}`);
  assert.ok(automatic.includes('Udemed->EUDAMED'));
  assert.ok(automatic.includes('Udimed->EUDAMED'));
  assert.ok(automatic.includes('Meds app->MDSAP'));
  assert.ok(automatic.includes('S-BOM->SBOM'));
  assert.ok(automatic.includes('Kappa->CAPA'));
});

test('terminology QA auto-corrects plural Kappas to CAPAs regardless of transcript capitalisation', () => {
  const suggestions = reviewGeneratedContent({
    stage: 'discussion',
    content: [{
      topic: 'Quality system',
      points: [
        'Review late kappas and root cause analysis.',
        'KAPPAS were raised as a backlog concern.'
      ]
    }],
    scope: { type: 'project', key: 'QIP' }
  });
  const automatic = suggestions.filter((item) => item.autoApply).map((item) => `${item.original}->${item.replacement}`);
  assert.ok(automatic.includes('kappas->CAPAs'));
  assert.ok(automatic.includes('KAPPAS->CAPAs'));
});

test('terminology QA applies shared corrections to action review candidates', () => {
  const suggestions = reviewGeneratedContent({
    stage: 'actions',
    content: {
      actions: [],
      actionCandidates: [
        { suggestedAction: 'Review the Kappa investigation evidence', action: 'Review the Kappa investigation evidence' }
      ]
    },
    scope: { type: 'project', key: 'T796' }
  });
  const candidateCorrection = suggestions.find((item) => item.fieldPath === 'actionCandidates.0.action');
  assert.equal(candidateCorrection?.original, 'Kappa');
  assert.equal(candidateCorrection?.replacement, 'CAPA');
  assert.equal(candidateCorrection?.autoApply, true);
});

test('terminology QA applies plural CAPA correction to action review candidates', () => {
  const suggestions = reviewGeneratedContent({
    stage: 'actions',
    content: {
      actions: [],
      actionCandidates: [
        { suggestedAction: 'Review the late Kappas before the audit', action: 'Review the late Kappas before the audit' }
      ]
    },
    scope: { type: 'project', key: 'QIP' }
  });
  const candidateCorrection = suggestions.find((item) => item.fieldPath === 'actionCandidates.0.action');
  assert.equal(candidateCorrection?.original, 'Kappas');
  assert.equal(candidateCorrection?.replacement, 'CAPAs');
  assert.equal(candidateCorrection?.autoApply, true);
});

test('terminology QA does not fuzzy-suggest QMS as PMS', () => {
  const suggestions = reviewGeneratedContent({
    stage: 'summary',
    content: { objectives: ['Review QMS alignment'], executiveSummary: 'The QMS manual remains under review.', overallTopics: [] },
    scope: { type: 'project', key: 'T819' }
  });
  assert.equal(suggestions.some((item) => item.original === 'QMS' && item.replacement === 'PMS'), false);
});

test('terminology QA conservatively resolves a unique attendee owner variant', () => {
  const suggestions = reviewGeneratedContent({
    stage: 'actions',
    content: [{ owner: 'Jacqui Foks', action: 'Send the report', deadline: 'Friday' }],
    attendees: ['Jacqui Fox', 'Mark Kelleher'],
    scope: { type: 'project', key: 'Audit' }
  });
  assert.equal(suggestions.find((item) => item.fieldPath === 'actions.0.owner')?.replacement, 'Jacqui Fox');
});

test('rejected mappings are not repeatedly surfaced in the same scope', () => {
  const suggestions = reviewGeneratedContent({
    stage: 'summary',
    content: { objectives: ['Review Kappa'], executiveSummary: '', overallTopics: [] },
    rejected: [{ originalText: 'Kappa', suggestedText: 'CAPA' }],
    scope: { type: 'project', key: 'Audit' }
  });
  assert.equal(suggestions.some((item) => item.replacement === 'CAPA'), false);
});

test('attendee-name transcript variants are auto-corrected only in person-shaped contexts', () => {
  const actionSuggestions = reviewGeneratedContent({
    stage: 'actions',
    content: [{ owner: 'Jacqui Fox', action: 'Schedule a weekly recurrence call with Oral to check in', deadline: 'Not stated' }],
    attendees: ['Jacqui Fox', 'Orla Skally', 'Colm O\'Rourke'],
    scope: { type: 'project', key: 'T819' }
  });
  const oral = actionSuggestions.find((item) => item.fieldPath === 'actions.0.action' && item.original === 'Oral');
  assert.equal(oral?.replacement, 'Orla');
  assert.equal(oral?.autoApply, true);

  const medicalSuggestions = reviewGeneratedContent({
    stage: 'discussion',
    content: [{ topic: 'Treatment', points: ['The device may be used with oral medication.'] }],
    attendees: ['Orla Skally'],
    scope: { type: 'project', key: 'Clinical' }
  });
  assert.equal(medicalSuggestions.some((item) => item.original.toLowerCase() === 'oral' && item.replacement === 'Orla'), false);
});

test('accepted project mapping is reusable without altering source evidence', () => {
  const content = { objectives: [], executiveSummary: 'Review the Med Envoy handoff.', overallTopics: [] };
  const before = JSON.stringify(content);
  const suggestions = reviewGeneratedContent({
    stage: 'summary', content,
    learned: [{ originalText: 'Med Envoy', suggestedText: 'MedEnvoy' }],
    scope: { type: 'project', key: 'T819' }
  });
  assert.equal(suggestions[0].replacement, 'MedEnvoy');
  assert.equal(suggestions[0].autoApply, true);
  assert.equal(JSON.stringify(content), before);
});
