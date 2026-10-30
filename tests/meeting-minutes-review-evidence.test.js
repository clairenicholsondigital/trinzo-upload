'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normaliseSourceUnits } = require('../utils/meetingMinutesSource');
const { boundedReviewEvidence } = require('../utils/meetingMinutesReviewEvidence');

test('bounded packets retain defining antecedents and distant actual anchors before background', () => {
  const source = normaliseSourceUnits(Array.from({ length: 100 }, (_, i) => ({ id: `T${String(i + 1).padStart(4, '0')}`, speaker: 'Chair', text: 'The general project discussion continued.' })));
  source[72].text = 'The component register is the software inventory used for this review.';
  source[79].text = 'The component register may be shared before the audit.';
  source[98].text = 'The delivery report will be sent Friday.';
  const row = { text: 'The component register may be shared before the audit.', evidenceIds: ['T0080', 'T0099'] };
  const packet = boundedReviewEvidence(row, source, { maxUnits: 12 });
  assert.ok(packet.units.some(unit => unit.id === 'T0073'));
  assert.ok(packet.units.some(unit => unit.id === 'T0080'));
  assert.ok(packet.units.some(unit => unit.id === 'T0099'));
  assert.deepEqual(packet.coverage.omittedAnchorIds, []);
  assert.ok(packet.units.length <= 12);
});
