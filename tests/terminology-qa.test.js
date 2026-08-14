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

test('accepted project mapping is reusable without altering source evidence', () => {
  const content = { objectives: [], executiveSummary: 'Review the Med Envoy handoff.', overallTopics: [] };
  const before = JSON.stringify(content);
  const suggestions = reviewGeneratedContent({
    stage: 'summary', content,
    learned: [{ originalText: 'Med Envoy', suggestedText: 'MedEnvoy' }],
    scope: { type: 'project', key: 'T819' }
  });
  assert.equal(suggestions[0].replacement, 'MedEnvoy');
  assert.equal(JSON.stringify(content), before);
});
