'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareEvidence, parseTurns } = require('../utils/canonicalMinutes/evidence');

// A meeting recorded half in a supported style and half in a handle style the
// parser does not recognise. Before this behaviour existed, the handle lines
// were absorbed into the previous speaker's turn, so Priya's commitment was
// reported as Mark's action and nothing anywhere said otherwise.
const MIXED_CONVENTIONS = [
  'Claire Nicholson 00:12',
  'We opened by agreeing the budget review closes on Friday.',
  'Mark Kelleher 00:45',
  'I will circulate the figures tomorrow morning.',
  '00:12:30 priya.raman: The security audit found three critical findings we must remediate before launch.',
  '00:13:10 priya.raman: I will own remediation and report back on Thursday with a full plan.',
  '00:14:00 tom_oneill: The regulator deadline is the fifteenth and slipping it triggers a penalty.'
].join('\n');

test('an unrecognised speaker handle is not absorbed into the previous speaker', () => {
  const evidence = prepareEvidence(MIXED_CONVENTIONS);
  const mark = evidence.turns.filter((turn) => turn.speaker === 'Mark Kelleher');
  assert.equal(mark.length, 1);
  assert.equal(mark[0].text, 'I will circulate the figures tomorrow morning.');
  assert.ok(!mark.some((turn) => /remediation|security audit|regulator/i.test(turn.text)),
    'content from an unrecognised handle must not be attributed to the previous speaker');
});

test('content behind an unrecognised handle is kept, marked unattributed', () => {
  const evidence = prepareEvidence(MIXED_CONVENTIONS);
  const unattributed = evidence.turns.filter((turn) => turn.attributionConfidence === 0);
  assert.equal(unattributed.length, 3);
  assert.ok(unattributed.every((turn) => turn.speaker === 'Not stated'));
  const kept = unattributed.map((turn) => turn.text).join(' ');
  assert.match(kept, /security audit/);
  assert.match(kept, /own remediation and report back on Thursday/);
  assert.match(kept, /regulator deadline/);
});

test('the handle and its timestamp are stripped from the turn body', () => {
  const evidence = prepareEvidence(MIXED_CONVENTIONS);
  const unattributed = evidence.turns.filter((turn) => turn.attributionConfidence === 0);
  assert.ok(unattributed.every((turn) => !/priya\.raman|tom_oneill|\d{2}:\d{2}:\d{2}/.test(turn.text)),
    'a handle we cannot resolve is still a header, not meeting content');
});

test('an unattributed speaker never becomes a participant', () => {
  const evidence = prepareEvidence(MIXED_CONVENTIONS);
  assert.deepEqual(evidence.participants, ['Claire Nicholson', 'Mark Kelleher']);
});

test('events carry the attribution doubt of the turn they came from', () => {
  const evidence = prepareEvidence(MIXED_CONVENTIONS);
  const commitment = evidence.events.find((event) => /own remediation/i.test(event.text));
  assert.equal(commitment.speaker, 'Not stated');
  assert.equal(commitment.attributionConfidence, 0);
  assert.ok(commitment.roles.includes('action_candidate'),
    'the commitment is still recognised as an action; only its owner is unknown');
});

test('turns the parser reads confidently carry no attribution caveat', () => {
  const evidence = prepareEvidence(MIXED_CONVENTIONS);
  const attributed = evidence.turns.filter((turn) => turn.speaker !== 'Not stated');
  assert.equal(attributed.length, 2);
  assert.ok(attributed.every((turn) => !('attributionConfidence' in turn)),
    'confident turns keep exactly the shape they had before this behaviour existed');
});

test('prose openings are not mistaken for speaker handles', () => {
  const prose = [
    'Alex Morgan: We reviewed the rollout plan this morning.',
    'agenda: the billing portal and the legacy read-only window',
    'note: support will need extra cover during the first week',
    'Alex Morgan: We agreed to phase the launch by region.'
  ].join('\n');
  const turns = parseTurns(prose);
  assert.ok(!turns.some((turn) => turn.speaker === 'Not stated'),
    'document labels must not be read as unrecognised speakers');
});

test('a wholly lowercase-handled transcript still yields its content', () => {
  const turns = parseTurns([
    'priya.raman: The security audit found three critical findings.',
    'tom_oneill: The regulator deadline is the fifteenth.'
  ].join('\n'));
  assert.equal(turns.length, 2);
  assert.ok(turns.every((turn) => turn.attributionConfidence === 0));
});
