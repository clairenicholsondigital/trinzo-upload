const test = require('node:test');
const assert = require('node:assert');
const { meetingAgentAuditPublishCandidates, meetingMinutesAuditPublishEnabled } = require('../routes/api').stagedEvaluation;

const units = [
  { id: 'T0036', speaker: 'Jacqui Fox', text: 'The alarm changes are mostly done apart from the mute button flash sequence.' },
  { id: 'T0039', speaker: 'Jacqui Fox', text: "So Janine, and I think Adil, you're involved in that as well next week, just to look at that from a clinician side point, and is that change acceptable." },
  { id: 'T0105', speaker: 'Ciaran Ryan', text: 'focus on TFO3 this week.' }
];

test('the completeness check is off unless its flag is set', () => {
  const previous = process.env.MEETING_MINUTES_AGENT_AUDIT_PUBLISH_V1;
  try {
    delete process.env.MEETING_MINUTES_AGENT_AUDIT_PUBLISH_V1;
    assert.equal(meetingMinutesAuditPublishEnabled(), false);
    process.env.MEETING_MINUTES_AGENT_AUDIT_PUBLISH_V1 = '1';
    assert.equal(meetingMinutesAuditPublishEnabled(), true);
  } finally {
    if (previous === undefined) delete process.env.MEETING_MINUTES_AGENT_AUDIT_PUBLISH_V1;
    else process.env.MEETING_MINUTES_AGENT_AUDIT_PUBLISH_V1 = previous;
  }
});

test('a found action with a named owner is a candidate to publish', () => {
  const found = [{
    action: 'Review the mute button flash sequence change from a clinical point of view and confirm it is acceptable.',
    owners: ['Janine', 'Adil Kauim'], evidenceIds: ['T0036', 'T0039']
  }];
  const out = meetingAgentAuditPublishCandidates(found, [], [], units);
  assert.equal(out.length, 1);
});

test('an ownerless finding is never a candidate: it stays a proposal', () => {
  const found = [{ action: 'Review alarm changes and the outstanding mute button point.', owners: [], evidenceIds: ['T0036'] }];
  assert.deepEqual(meetingAgentAuditPublishCandidates(found, [], [], units), []);
});

test('a finding already published is not offered again', () => {
  const text = 'Review the mute button flash sequence change from a clinical point of view and confirm it is acceptable.';
  const found = [{ action: text, owners: ['Janine'], evidenceIds: ['T0039'] }];
  const published = [{ action: text, owners: ['Janine'], evidenceIds: ['T0039'] }];
  assert.deepEqual(meetingAgentAuditPublishCandidates(found, [], published, units), []);
});

test('meeting admin found by the completeness check is not published', () => {
  const found = [{ action: 'Share the screen so everyone can see the tracker.', owners: ['Jacqui Fox'], evidenceIds: ['T0036'] }];
  assert.deepEqual(meetingAgentAuditPublishCandidates(found, [], [], units), []);
});
