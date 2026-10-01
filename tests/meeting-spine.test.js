'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMeetingSpine, usableHeading } = require('../utils/canonicalMinutes/meetingSpine');
const { normaliseUkCurrency } = require('../utils/canonicalMinutes/textNormalisation');
const { clientReadyPresentation } = require('../utils/canonicalMinutes/trooperPolish');

function evidence(events) {
  return {
    events: events.map((text, index) => ({ id: `e${index + 1}`, text, speaker: index % 2 ? 'Niamh Lynch' : 'Jacqui Fox', turnIndex: index, roles: [] }))
  };
}

test('meeting spine ranks repeated purpose-aligned workstreams above incidental mentions', () => {
  const ev = evidence([
    'We need to prepare the Sylmar audit and confirm the audit scope and standards.',
    'Niamh will cover the specialist software audit work as a separate track.',
    'The audit scope needs to be finalised before the preparation work starts.',
    'We need external SharePoint access before the audit starts.',
    'The training attestation and code of conduct must be completed first.',
    'Cybersecurity was mentioned as one part of the software evidence.',
    'We need to agree the on-site and report-writing timetable for the audit.'
  ]);
  const spine = buildMeetingSpine({
    evidence: ev,
    meeting: { title: 'Client Abbott T796 Audit kick-off Sylmar', type: 'Audit kick-off / planning' },
    purposeProfile: 'audit_planning',
    workstreams: [
      { text: 'Audit scope, type and applicable standards', purposeDimension: 'scope', evidenceIds: ['e1', 'e3', 'e7'] },
      { text: 'Training, document access and confidentiality', purposeDimension: 'access', evidenceIds: ['e4', 'e5'] },
      { text: 'Software, cybersecurity and risk-management focus', purposeDimension: 'technical', evidenceIds: ['e6'] }
    ]
  });
  assert.equal(spine.primaryWorkstreams[0].purposeDimension, 'scope');
  assert.ok(spine.primaryWorkstreams.findIndex((item) => item.purposeDimension === 'access') < spine.primaryWorkstreams.findIndex((item) => item.purposeDimension === 'technical'));
});

test('topic heading gate rejects schedule fragments and conversational question fragments', () => {
  assert.equal(usableHeading('Wednesday, Thursday, Fridays'), false);
  assert.equal(usableHeading('And then as a consequence to that, does that mean'), false);
  assert.equal(usableHeading('Like, as the team is developing big'), false);
  assert.equal(usableHeading('Just to, just to know'), false);
  assert.equal(usableHeading('Training, document access and confidentiality'), true);
});

test('topic heading gate rejects generic meeting-closing labels', () => {
  for (const heading of [
    'Meeting closing remarks', 'Closing remarks', 'Closing comments', 'Meeting close',
    'Final remarks', 'Closing wrap-up', 'Wrap-up discussion'
  ]) assert.equal(usableHeading(heading), false, heading);
  assert.equal(usableHeading('Closing remarks on the audit findings'), true);
  assert.equal(usableHeading('Closing the supplier contract'), true);
});

test('currency wording is consistently presented as UK pound amounts', () => {
  assert.equal(normaliseUkCurrency('Ken will buy it for eight pounds.'), 'Ken will buy it for £8.');
  assert.equal(normaliseUkCurrency('The fee is twenty five pounds per plot.'), 'The fee is £25 per plot.');
  assert.equal(normaliseUkCurrency('The budget is 50 pounds.'), 'The budget is £50.');
  assert.equal(normaliseUkCurrency('The invoice is GBP 6.50.'), 'The invoice is £6.50.');
  assert.equal(normaliseUkCurrency('Eight people joined.'), 'Eight people joined.');
});

test('client-ready staged screens apply currency normalisation to generated prose', () => {
  const result = clientReadyPresentation({
    stagedStage: 'summary',
    screens: { summary: { executiveSummary: 'The repair will cost eight pounds.', objectives: ['Approve the £50 show budget.'] } }
  });
  assert.equal(result.screens.summary.executiveSummary, 'The repair will cost £8.');
  assert.deepEqual(result.screens.summary.objectives, ['Approve the £50 show budget.']);
});
