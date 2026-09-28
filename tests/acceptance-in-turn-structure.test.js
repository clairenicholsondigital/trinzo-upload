'use strict';

// Three real exchanges from draft 1055 (Meridian) that a person reads as
// accepted work but whose cited lines carry no acceptance keyword, so the
// actions sat in the suggestions queue as "commitment not clear".
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../utils/meetingMinutesAgentV2');
const api = require('../routes/api').stagedEvaluation;

const units = [
  { id: 'T0019', speaker: 'David Didsbury', text: 'That needs fixing before anybody populates the matrix, otherwise you are going to have to redo it.' },
  { id: 'T0020', speaker: 'David Didsbury', text: 'And then the second thing is there is no rationale anywhere for the probability bands.' },
  { id: 'T0026', speaker: 'Jacqui Fox', text: 'No bother Dermot, we are on risk, we will come to you in a minute.' },
  { id: 'T0027', speaker: 'Jacqui Fox', text: 'David, so on those two points, is that something you can write up as comments in the document?' },
  { id: 'T0028', speaker: 'David Didsbury', text: 'It\'ll be Friday though, I\'m on site Wednesday and Thursday.' },
  { id: 'T0029', speaker: 'Jacqui Fox', text: 'Rebecca, does that block you on the matrix?' },
  { id: 'T0053', speaker: 'Sanjay Iyer', text: 'Four are not, and three of those four are the ones where we changed the packaging configuration in, I want to say March.' },
  { id: 'T0054', speaker: 'Sanjay Iyer', text: 'So those need new DIs, which is fine, that is just work.' },
  { id: 'T0055', speaker: 'Sanjay Iyer', text: 'The fourth one I do not understand yet.' },
  { id: 'T0062', speaker: 'Sanjay Iyer', text: 'Okay, I\'ll go back through the distributor correspondence then.' },
  { id: 'T0063', speaker: 'Jacqui Fox', text: 'And Sanjay, timeline on that?' },
  { id: 'T0064', speaker: 'Sanjay Iyer', text: 'The three new DIs, this week.' },
  { id: 'T0065', speaker: 'Sanjay Iyer', text: 'The duplicate, I genuinely don\'t know until I\'ve looked, it could be a phone call or it could be a month.' },
  { id: 'T0066', speaker: 'Jacqui Fox', text: 'I\'ll note the three as this week and leave the other one open with a note.' },
  { id: 'T0117', speaker: 'Jacqui Fox', text: 'And is there a checking step after that?' },
  { id: 'T0118', speaker: 'Ffion Hargreaves', text: 'There is, and that is a problem actually, because we normally get the local distributors to check and two of them have said they haven\'t the resource this year.' },
  { id: 'T0119', speaker: 'Ffion Hargreaves', text: 'Poland and Portugal.' },
  { id: 'T0120', speaker: 'Jacqui Fox', text: 'Park that, but flag it, because that will bite in August if we do not sort it now.' },
  { id: 'T0121', speaker: 'Jacqui Fox', text: 'Can you find out what they\'d need to do it, whether it is a money thing or a people thing.' },
  { id: 'T0123', speaker: 'Jacqui Fox', text: 'Anything anyone wants to raise that I have not covered.' }
];

const david = { action: 'Write comments in the risk management plan addressing the severity scale definitions and probability band rationale.', owners: ['David Didsbury'], evidenceIds: ['T0019', 'T0020', 'T0027', 'T0028'] };
const sanjay = { action: 'Create new DIs for the three references affected by the packaging configuration change.', owners: ['Sanjay Iyer'], evidenceIds: ['T0053'] };
const duplicate = { action: 'Review distributor correspondence to investigate the duplicate basic UDI-DI entry for the eight millimetre reference.', owners: ['Sanjay Iyer'], evidenceIds: ['T0062', 'T0065'] };
const ffion = { action: 'Determine what is required for the Poland and Portugal distributors to perform translation checks, including whether the issue is resource- or cost-related.', owners: ['Ffion Hargreaves'], evidenceIds: ['T0118'] };

test('a timing given in reply to a request is the yes', () => {
  assert.deepEqual(V.acceptanceAroundEvidenceDetail(david, units), { disposition: 'accepted_request', evidenceIds: ['T0027', 'T0028'] });
});

test('the chair handing work to the person who just raised it, unopposed, is acceptance', () => {
  assert.deepEqual(V.acceptanceAroundEvidenceDetail(ffion, units), { disposition: 'accepted_request', evidenceIds: ['T0119', 'T0121'] });
});

test('the owner answering a when-question about the same work with a time is a commitment', () => {
  assert.deepEqual(V.acceptanceAroundEvidenceDetail(sanjay, units), { disposition: 'committed', evidenceIds: ['T0063', 'T0064'] });
  // The other half of the same answer is about the DIs, not the duplicate.
  assert.equal(V.acceptanceAroundEvidence(duplicate, units), '');
});

test('the accepting rows join the citation and supply the timing', () => {
  const [row] = V.backfillActionCommitmentEvidence([sanjay], units, { meetingDate: '2026-07-01' });
  assert.deepEqual(row.evidenceIds, ['T0053', 'T0063', 'T0064']);
  assert.equal(row.timing.wording, 'this week');
  // "it could be a phone call or it could be a month" is not a timing, and
  // "The three new DIs, this week" is about other work.
  const [other] = V.backfillActionCommitmentEvidence([duplicate], units, { meetingDate: '2026-07-01' });
  assert.equal(other.timing.kind, 'not_stated');
});

test('a bare timing reply still answers a when-question for any action', () => {
  const rows = [
    { id: 'T0001', speaker: 'Mark Kelleher', text: 'I\'ll send the plan over.' },
    { id: 'T0002', speaker: 'Jacqui Fox', text: 'When can you do that?' },
    { id: 'T0003', speaker: 'Mark Kelleher', text: 'Friday.' }
  ];
  const timing = V.backfillAskedTiming({ kind: 'not_stated', wording: '', exactDate: '' }, rows, ['T0001', 'T0002'], { action: 'Send the plan.' });
  assert.equal(timing.wording, 'friday');
});

test('the disposition with context upgrades only unclear or unanswered readings', () => {
  const evidenceFor = (record) => V.surroundingEvidence(units, record.evidenceIds).filter((unit) => unit.cited)
    .map((unit) => `${unit.speaker}: ${unit.text}`).join(' ');
  assert.equal(V.actionEvidenceDisposition(david.action, evidenceFor(david)), 'unclear');
  assert.equal(api.actionDispositionWithContext(david, units, evidenceFor(david)), 'accepted_request');
  assert.equal(api.actionDispositionWithContext(sanjay, units, evidenceFor(sanjay)), 'committed');
  const status = { action: 'Update the tracker.', owners: ['Jacqui Fox'], evidenceIds: ['T0066'] };
  const statusDisposition = V.actionEvidenceDisposition(status.action, evidenceFor(status));
  assert.equal(api.actionDispositionWithContext(status, units, evidenceFor(status)), statusDisposition);
});

test('a refusal after the request blocks the handover rule', () => {
  const rows = [
    { id: 'T0001', speaker: 'Ffion Hargreaves', text: 'Two of the distributors have said they have not got the resource this year.' },
    { id: 'T0002', speaker: 'Jacqui Fox', text: 'Can you find out what they would need to do it?' },
    { id: 'T0003', speaker: 'Ffion Hargreaves', text: 'I can\'t this month, I am off from Friday.' }
  ];
  assert.equal(V.acceptanceAroundEvidence({ action: 'Find out what the distributors need to do the checks.', owners: ['Ffion Hargreaves'], evidenceIds: ['T0001'] }, rows), '');
});

test('the second discovery leg counts as a discovery source of its own', () => {
  const record = { action: 'Create new DIs for the three references affected by the packaging configuration change.', owners: ['Sanjay Iyer'], evidenceIds: ['T0053'] };
  const ledger = [
    { candidateId: 'p1', sourcePass: 'primary', recordType: 'action', text: record.action, evidenceIds: ['T0053'], record },
    { candidateId: 'p2', sourcePass: 'primary-2', recordType: 'action', text: 'Create new DIs for the three packaging-configuration references that require them.', evidenceIds: ['T0054', 'T0064'], record: { ...record, evidenceIds: ['T0054', 'T0064'] } }
  ];
  assert.deepEqual(api.hybridActionSourceInfo(record, ledger).discoverySources.sort(), ['primary', 'primary-2']);
});
