'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normaliseAgentResult } = require('../utils/meetingMinutesResultNormalization');
const { boundedReviewEvidence } = require('../utils/meetingMinutesReviewEvidence');

const wording = 'The inspection review remains scheduled for Friday.';
const units = Array.from({ length: 13 }, (_, index) => ({
  id: `T${String(index + 1).padStart(4, '0')}`, sequence: index + 1,
  speaker: 'Morgan', text: wording
}));
const first = {
  id: 'first', text: wording, discoveryDisposition: 'supporting',
  evidenceIds: ['T0001', 'T0002', 'T0003', 'T0008'], primaryEvidenceIds: ['T0008'],
  supportingDetails: [], reviewFlagIds: ['first-warning']
};
const second = {
  id: 'second', text: wording, discoveryDisposition: 'core',
  evidenceIds: units.slice(8, 12).map(unit => unit.id), primaryEvidenceIds: ['T0012'],
  supportingDetails: [], reviewFlagIds: ['second-warning']
};
const warnings = ['first-warning', 'second-warning'].map(id => ({
  id, kind: 'missing_evidence', status: 'open', message: `Confirm the source references for ${id}.`,
  evidenceIds: [id === 'first-warning' ? 'T0008' : 'T0012']
}));
function normalise(rows, options = {}, category = 'points', source = units, reviewFlags = warnings) {
  return normaliseAgentResult({
    discussion: [{ id: 'topic', topic: 'Inspection schedule', points: [], decisions: [], openQuestions: [], [category]: rows }],
    reviewFlags
  }, source, 'discussion', options);
}

test('duplicate discussion merges retain both primary anchors inside the existing citation budget', () => {
  const candidate = structuredClone([first, second]);
  const original = structuredClone(candidate);
  const result = normalise(candidate);
  const rows = result.discussion[0].points;
  assert.equal(rows.length, 1);
  const kept = rows[0];
  assert.equal(kept.id, first.id);
  assert.equal(kept.text, wording);
  assert.equal(kept.discoveryDisposition, first.discoveryDisposition, 'ranking policy remains unchanged');
  assert.deepEqual(kept.primaryEvidenceIds, ['T0008', 'T0012']);
  assert.equal(kept.evidenceIds.length, 8);
  assert.ok(kept.evidenceIds.includes('T0008'));
  assert.ok(kept.evidenceIds.includes('T0012'));
  assert.deepEqual(kept.reviewFlagIds, ['first-warning', 'second-warning']);
  assert.ok(result.reviewFlags.some(flag => flag.id === 'second-warning'));
  assert.deepEqual(candidate, original, 'source discovery records must not be mutated');
  const packet = boundedReviewEvidence(kept, units);
  assert.ok(packet.coverage.requestedAnchorIds.includes('T0012'));
  assert.ok(packet.units.some(unit => unit.id === 'T0012'));
});

test('the same provenance preservation applies to decisions, questions and merged topic cards', () => {
  for (const category of ['decisions', 'openQuestions']) {
    const result = normalise([first, second], {}, category);
    assert.deepEqual(result.discussion[0][category][0].primaryEvidenceIds, ['T0008', 'T0012']);
    assert.ok(result.discussion[0][category][0].reviewFlagIds.includes('second-warning'));
  }
  const result = normaliseAgentResult({ discussion: [
    { topic: 'Inspection schedule', points: [first] },
    { topic: 'Inspection schedule', points: [second] }
  ], reviewFlags: warnings }, units, 'discussion');
  assert.equal(result.discussion.length, 1);
  assert.deepEqual(result.discussion[0].points[0].primaryEvidenceIds, ['T0008', 'T0012']);
});

test('an incoming duplicate cannot introduce an unknown or uncited primary anchor', () => {
  const incoming = { ...second, evidenceIds: ['T0012'], primaryEvidenceIds: ['T0012', 'T0013', 'T9999'] };
  const kept = normalise([first, incoming]).discussion[0].points[0];
  assert.deepEqual(kept.primaryEvidenceIds, ['T0008', 'T0012']);
  assert.ok(!kept.evidenceIds.includes('T0013'));
  assert.ok(!kept.evidenceIds.includes('T9999'));
  assert.ok(kept.primaryEvidenceIds.every(id => kept.evidenceIds.includes(id)));
});

test('invalid citations on a merged-away point still produce a linked source warning', () => {
  const incoming = { ...second, evidenceIds: ['T0012', 'T9999'] };
  const result = normalise([first, incoming]);
  const warning = result.reviewFlags.find(flag => /lines that do not exist \(T9999\)/.test(flag.message));
  assert.ok(warning, 'merging must not hide invalid-source diagnostics');
  assert.ok(result.discussion[0].points[0].reviewFlagIds.includes(warning.id));
  assert.ok(!result.discussion[0].points[0].evidenceIds.includes('T9999'));
});

test('an exact repeated supporting detail retains its source and warning links', () => {
  const supportingText = 'The laboratory remains available during the inspection.';
  const source = [...units,
    { id: 'T0020', sequence: 20, speaker: 'Morgan', text: supportingText },
    { id: 'T0021', sequence: 21, speaker: 'Morgan', text: supportingText }
  ];
  const detail = (id, evidenceId, flag) => ({ id, text: supportingText, evidenceIds: [evidenceId], reviewFlagIds: [flag] });
  const result = normalise([
    { ...first, supportingDetails: [detail('detail-first', 'T0020', 'detail-warning-first')] },
    { ...second, supportingDetails: [detail('detail-second', 'T0021', 'detail-warning-second')] }
  ], {}, 'points', source, [...warnings, ...['first', 'second'].map(suffix => ({
    id: `detail-warning-${suffix}`, kind: 'missing_evidence', message: `Check the ${suffix} laboratory reference.`, evidenceIds: ['T0020']
  }))]);
  const details = result.discussion[0].points[0].supportingDetails;
  assert.equal(details.length, 1);
  assert.equal(details[0].id, 'detail-first');
  assert.equal(details[0].text, supportingText);
  assert.deepEqual(details[0].evidenceIds, ['T0020', 'T0021']);
  assert.deepEqual(details[0].reviewFlagIds, ['detail-warning-first', 'detail-warning-second']);
});

test('identical warning aliases are also repointed inside a retained supporting detail', () => {
  const detail = (id, flag) => ({ id, text: wording, evidenceIds: ['T0001'], reviewFlagIds: [flag] });
  const repeatedWarnings = ['detail-first-flag', 'detail-second-flag'].map(id => ({
    id, kind: 'missing_evidence', message: 'Confirm this inspection passage.', evidenceIds: ['T0001']
  }));
  const result = normalise([
    { ...first, supportingDetails: [detail('detail-first', 'detail-first-flag')] },
    { ...second, supportingDetails: [detail('detail-second', 'detail-second-flag')] }
  ], {}, 'points', units, [...warnings, ...repeatedWarnings]);
  const flags = new Set(result.reviewFlags.map(flag => flag.id));
  const refs = result.discussion[0].points[0].supportingDetails[0].reviewFlagIds;
  assert.deepEqual(refs, ['detail-first-flag']);
  assert.ok(refs.every(id => flags.has(id)), 'every retained reference must have a surviving flag');
});

test('repeated normalisation is stable and reviewer saves do not merge their rows', () => {
  const once = normalise([first, second]);
  const twice = normaliseAgentResult(once, units, 'discussion');
  assert.deepEqual(twice.discussion, once.discussion);
  assert.deepEqual(twice.reviewFlags, once.reviewFlags);
  const reviewed = normalise([
    { ...first, reviewerAuthored: true }, { ...second, reviewerAuthored: true }
  ], { preserveReviewerEdits: true });
  assert.equal(reviewed.discussion[0].points.length, 2);
  assert.deepEqual(reviewed.discussion[0].points.map(point => point.id), ['first', 'second']);
  assert.ok(reviewed.discussion[0].points.every(point => point.reviewerAuthored));
});

test('ordinary uncapped source order and distinct points retain existing behaviour', () => {
  const left = { ...first, evidenceIds: ['T0001'], primaryEvidenceIds: [] };
  const right = { ...second, evidenceIds: ['T0002'], primaryEvidenceIds: [] };
  const kept = normalise([left, right]).discussion[0].points[0];
  assert.deepEqual(kept.evidenceIds, ['T0001', 'T0002']);
  const other = { id: 'other', text: 'The warehouse ventilation filter needs replacement.', evidenceIds: ['T0030'] };
  const source = [...units, { id: 'T0030', sequence: 30, speaker: 'Taylor', text: other.text }];
  const result = normalise([first, other], {}, 'points', source);
  assert.deepEqual(result.discussion[0].points.map(point => point.id), ['first', 'other']);
  assert.ok(!result.discussion[0].points[0].evidenceIds.includes('T0030'));
});

test('citation overflow retains legacy merge choices before and after JSON round trips', () => {
  const full = 'The inspection schedule remains confirmed for the laboratory Friday.';
  const near = 'The inspection schedule remains pending for the laboratory Monday.';
  const source = units.map(unit => ({ ...unit, text: `${full} ${near}` }));
  const fullFirst = { ...first, text: full, evidenceIds: units.slice(0, 8).map(unit => unit.id) };
  const fullSecond = { ...second, text: full };
  for (const [id, expectedIds] of [['T0007', ['first']], ['T0012', ['first', 'third']]]) {
    const result = normalise([
      fullFirst, fullSecond, { id: 'third', text: near, evidenceIds: [id] }
    ], {}, 'points', source);
    assert.deepEqual(result.discussion[0].points.map(point => point.id), expectedIds);
    assert.deepEqual(result.discussion[0].points[0].evidenceIds, fullFirst.evidenceIds,
      'overflow prioritization is deliberately deferred to avoid changing matching');
    const repeated = normaliseAgentResult(JSON.parse(JSON.stringify(result)), source, 'discussion');
    assert.deepEqual(repeated.discussion[0].points.map(point => point.id), expectedIds);
  }
});
