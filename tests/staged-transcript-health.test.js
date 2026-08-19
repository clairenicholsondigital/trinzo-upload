'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assessStagedTranscriptHealth, stagedTranscriptHealthFlag } = require('../utils/stagedTranscriptHealth');

test('substantive multi-speaker transcript is healthy', () => {
  const transcript = [
    'Alice Jones: The team reviewed the release plan and the remaining validation evidence.',
    'Bob Smith: The clinical review is complete and the electrical testing remains scheduled for Friday.',
    'Alice Jones: The software evidence still needs review before the release decision.',
    'Bob Smith: I will circulate the testing report when the final results are available.',
    'Alice Jones: The team also reviewed training readiness and the launch support plan.',
    'Bob Smith: The support team has confirmed coverage for the first week after launch.'
  ].join('\n');
  const health = assessStagedTranscriptHealth(transcript);
  assert.equal(health.state, 'healthy');
  assert.equal(stagedTranscriptHealthFlag(health), null);
});

test('deliberately shortened but substantive transcript remains usable', () => {
  const transcript = [
    'Alice Jones: The release remains scheduled for Friday.',
    'Bob Smith: I will circulate the final validation report tomorrow.',
    'Alice Jones: The team reviewed the remaining launch dependency.'
  ].join('\n');
  const health = assessStagedTranscriptHealth(transcript);
  assert.equal(health.state, 'sparse_but_usable');
  assert.equal(stagedTranscriptHealthFlag(health).blocking, false);
});

test('chatter-heavy transcript is sparse but usable rather than structurally broken', () => {
  const transcript = [
    'Alice Jones: Hello.', 'Bob Smith: Yeah.', 'Alice Jones: Okay.', 'Bob Smith: Perfect.',
    'Alice Jones: The team briefly reviewed the launch plan and agreed to continue next week.',
    'Bob Smith: Thanks everyone.'
  ].join('\n');
  const health = assessStagedTranscriptHealth(transcript);
  assert.equal(health.state, 'sparse_but_usable');
  assert.ok(health.reasons.includes('chatter_or_fragment_heavy'));
});

test('unparseable transcript is structurally unreliable', () => {
  const health = assessStagedTranscriptHealth('A block of text with no recognisable speaker attribution or transcript structure.');
  assert.equal(health.state, 'structurally_unreliable');
  assert.equal(stagedTranscriptHealthFlag(health).blocking, true);
});

test('timestamp gaps do not affect transcript health', () => {
  const compact = 'Alice Jones 0:01 The team reviewed validation evidence.\nBob Smith 0:15 I will send the report tomorrow.';
  const gapped = 'Alice Jones 0:01 The team reviewed validation evidence.\nBob Smith 48:15 I will send the report tomorrow.';
  const left = assessStagedTranscriptHealth(compact);
  const right = assessStagedTranscriptHealth(gapped);
  assert.equal(left.state, right.state);
  assert.equal(left.evidenceEventCount, right.evidenceEventCount);
});
