'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../routes/api').stagedEvaluation;

const row = (id, text, evidenceIds = ['T0001']) => ({ id, text, evidenceIds, supportingDetails: [] });
const topic = points => ({ id: 'inspection', topic: 'Inspection planning', points, decisions: [], openQuestions: [] });
const allRecords = result => {
  const discussion = Array.isArray(result) ? result : result.discussion;
  return discussion.flatMap(t => ['points', 'decisions', 'openQuestions']
    .flatMap(key => (t[key] || []).flatMap(record => [record, ...(record.supportingDetails || [])])))
    .concat(result.unassignedSupportingDetails || []);
};
const compactWithReviewPool = (primary, recovered, units, options = {}) => {
  const unassignedSupportingDetails = [];
  const discussion = api.compactDiscussionPropositions(primary, recovered, units, {
    ...options,
    onUnassignedSupportingDetail(detail, context) {
      unassignedSupportingDetails.push(structuredClone({ ...detail, ...context }));
      return true;
    }
  });
  return { discussion, unassignedSupportingDetails };
};
const unitsFor = values => values.map((text, index) => ({ id: `T000${index + 1}`, text, speaker: 'Morgan', classification: 'keep' }));
const compact = (primary, details, units = unitsFor([...primary.map(r => r.text), ...details.map(r => r.text)])) =>
  compactWithReviewPool([topic(primary)], [], units, {
    promoteMaterialSupporting: false,
    supportingCandidates: details.map(record => ({ candidate: {
      candidateId: record.id, recordType: 'discussion_point', sourcePass: 'primary', topic: 'Inspection planning', ...record
    } }))
  });

test('a short lead identity cannot discard a richer multi-phase temporal detail', () => {
  const identity = row('lead', 'The inspection lead is identified as Morgan.');
  const schedule = row('schedule', 'Morgan leads the inspection. Preparation starts next Monday and continues through the following week. The on-site inspection takes five days starting on the 20th, followed by report writing from the 27th through August 7th.', ['T0002']);
  const input = structuredClone(schedule);
  const result = compact([identity], [schedule], unitsFor([identity.text, schedule.text]));
  assert.ok(allRecords(result).some(r => r.id === 'schedule' && r.text === schedule.text));
  assert.deepEqual(allRecords(result).find(r => r.id === 'schedule').evidenceIds, ['T0002']);
  assert.deepEqual(result.discussion[0].points.map(r => r.id), ['lead'], 'review-only timing must not become another main claim');
  assert.equal(result.discussion[0].points[0].supportingDetails.length, 0, 'a shared lead name does not prove this richer schedule belongs under that identity row');
  assert.equal(result.unassignedSupportingDetails.length, 1);
  assert.equal(result.unassignedSupportingDetails[0].text, schedule.text, 'all preparation, on-site duration and reporting-range wording survives outside an unproved parent');
  assert.deepEqual(result.unassignedSupportingDetails[0].evidenceIds, ['T0002']);
  assert.deepEqual(schedule, input);
});

test('group compaction retains separate Monday and Tuesday claims with shared evidence', () => {
  const monday = row('monday', 'The laboratory inspection is planned for Monday.');
  const tuesday = row('tuesday', 'The laboratory inspection is planned for Tuesday.');
  const result = compact([monday, tuesday], [], unitsFor([`${monday.text} ${tuesday.text}`]));
  assert.ok(allRecords(result).some(r => r.text === monday.text));
  assert.ok(allRecords(result).some(r => r.text === tuesday.text));
  assert.ok(!allRecords(result).some(r => /Monday or Tuesday/.test(r.text)));
});

test('duration, recurrence, clock, zone and qualification differences survive supporting consolidation', () => {
  const variants = [
    ['The laboratory inspection takes five days.', 'The laboratory inspection takes six days.'],
    ['The laboratory inspection starts every Friday.', 'The laboratory inspection starts Friday.'],
    ['The laboratory inspection starts at 09:00 UTC.', 'The laboratory inspection starts at 10:00 UTC.'],
    ['The laboratory inspection starts at 09:00 UTC.', 'The laboratory inspection starts at 09:00 BST.'],
    ['The laboratory inspection may finish on Friday.', 'The laboratory inspection will finish on Friday.'],
    ['The laboratory inspection starts before approval.', 'The laboratory inspection starts after approval.']
  ];
  for (const [first, second] of variants) {
    const parent = row('parent', first);
    parent.supportingDetails = [row('variant', second)];
    const retained = api.consolidateSupportingDetails(parent);
    assert.equal(retained.length, 1, `${first} must not erase ${second}`);
    const result = compact([parent], [], unitsFor([`${first} ${second}`]));
    assert.ok(allRecords(result).some(r => r.text === first), first);
    assert.ok(allRecords(result).some(r => r.text === second), second);
  }
});

test('richer recovered temporal detail is not treated as covered by a short core row', () => {
  const primary = row('core', 'The inspection team is led by Morgan.');
  const recovered = row('later', 'The inspection team led by Morgan will prepare next Monday and work on site for five days.', ['T0002']);
  const result = compactWithReviewPool([topic([primary])], [topic([recovered])],
    unitsFor([primary.text, recovered.text]), { promoteMaterialSupporting: false });
  assert.ok(allRecords(result).some(r => r.text === recovered.text));
});

test('cluster release preserves a richer timed member after a shorter matching member', () => {
  const short = 'The inspection lead is identified as Morgan.';
  const long = 'Morgan is the inspection lead. Preparation starts Monday and the inspection takes five days from the 20th.';
  for (const texts of [[short, long], [long, short]]) {
    const released = api.refereeClusterSupportingCandidates([{ candidateId: 'core', disposition: 'core' }], [{
      candidateId: 'core', text: 'Inspection planning was discussed.', evidenceIds: ['T0001'],
      clusterMembers: texts.map((text, index) => ({ candidateId: `member${index}`, text, evidenceIds: ['T0001'],
        sourcePass: 'primary', clusterRelation: 'overflow' }))
    }]);
    assert.ok(released.some(item => item.candidate.text === long));
  }
});

test('cluster release keeps conflicting weekdays and removes a true reordered restatement', () => {
  const texts = [
    'The laboratory inspection starts on Monday morning.',
    'On Monday morning the laboratory inspection starts.',
    'The laboratory inspection starts Tuesday morning.'
  ];
  const released = api.refereeClusterSupportingCandidates([{ candidateId: 'core', disposition: 'core' }], [{
    candidateId: 'core', text: 'Inspection planning was discussed.', evidenceIds: ['T0001'],
    clusterMembers: texts.map((text, index) => ({ candidateId: `m${index}`, text, evidenceIds: ['T0001'],
      sourcePass: 'primary', clusterRelation: 'paraphrase' }))
  }]);
  assert.equal(released.filter(item => /Monday/.test(item.candidate.text)).length, 1);
  assert.equal(released.filter(item => /Tuesday/.test(item.candidate.text)).length, 1);
});

test('semantic similarity cannot erase a distinct timed detail before the fidelity checker', async () => {
  const parent = row('lead', 'The inspection lead is identified as Morgan.');
  const schedule = row('schedule', 'Morgan leads the inspection, with preparation from Monday and five on-site days starting on the 20th.');
  const monday = row('monday', 'The laboratory inspection starts Monday.');
  const tuesday = row('tuesday', 'The laboratory inspection starts Tuesday.');
  parent.supportingDetails = [schedule, monday, tuesday];
  const result = await api.dedupeSupportingDetailsSemantically([topic([parent])], {
    vectors: [[1, 0], [1, 0], [1, 0], [1, 0]], threshold: 0.8
  });
  assert.deepEqual(result[0].points[0].supportingDetails.map(r => r.id), ['schedule', 'monday', 'tuesday']);
});

test('a complete temporal restatement is still removed in compactor and semantic boundaries', async () => {
  const original = row('primary', 'The laboratory inspection starts on Monday morning.');
  const restated = row('repeat', 'On Monday morning the laboratory inspection starts.');
  const result = compact([original], [restated], unitsFor([original.text]));
  assert.equal(allRecords(result).length, 1);
  const source = structuredClone(original);
  source.supportingDetails = [restated];
  const semantically = await api.dedupeSupportingDetailsSemantically([topic([source])], {
    vectors: [[1, 0], [1, 0]], threshold: 0.8
  });
  assert.equal(semantically[0].points[0].supportingDetails.length, 0);
});

test('preserving rich timing never bypasses raw-speech or missing-evidence gates', () => {
  const raw = row('raw', 'So we should, you know, maybe come back next month with our ideas.');
  const uncited = row('uncited', 'The inspection is planned for Monday.', []);
  const result = compact([raw, uncited], [], unitsFor([raw.text]));
  assert.equal(allRecords(result).length, 0);
});

test('distinct evidenced temporal context survives exhausted per-parent and whole-draft context budgets', () => {
  const timing = [
    row('start', 'Laboratory preparation starts next Monday.', ['T0001']),
    row('visit', 'The on-site inspection takes five days starting on the 20th.', ['T0002']),
    row('range', 'Report writing follows from the 27th through August 7th.', ['T0003'])
  ];
  const source = unitsFor(timing.map(r => r.text));
  const parents = Array.from({ length: 8 }, (_, index) => ({
    ...row(`parent${index}`, `Distinct process ${index} was discussed.`),
    supportingDetails: [
      row(`context${index}a`, `The ${['reagent', 'supplier', 'facilities', 'archive', 'validation', 'temperature', 'packaging', 'training'][index]} catalogue contains detailed background material.`),
      row(`context${index}b`, `A ${['sample', 'delivery', 'maintenance', 'storage', 'calibration', 'monitoring', 'release', 'approval'][index]} handbook describes the associated procedure.`),
      ...(index === 7 ? timing : [])
    ]
  }));
  const before = structuredClone(parents);
  const limited = api.limitSupportingDetails([topic(parents)], 3, 1, source);
  const details = limited[0].points.flatMap(r => r.supportingDetails);
  for (const detail of timing) assert.ok(details.some(r => r.id === detail.id && r.text === detail.text));
  assert.equal(details.filter(r => r.id.startsWith('context')).length, 3);
  assert.equal(limited[0].points.length, parents.length, 'context preservation creates no new main claims');
  assert.deepEqual(parents, before);
});

test('timed context exemption still consolidates a complete restatement', () => {
  const monday = row('monday', 'The laboratory inspection starts on Monday morning.');
  const duplicate = row('duplicate', 'On Monday morning the laboratory inspection starts.');
  const input = [topic([{ ...row('parent', 'Inspection scheduling was discussed.'), supportingDetails: [monday, duplicate] }])];
  const result = api.limitSupportingDetails(input, 0, 0, unitsFor([monday.text]));
  assert.equal(result[0].points[0].supportingDetails.length, 1);
  assert.ok(/Monday morning/.test(result[0].points[0].supportingDetails[0].text));
});

test('raw, removed, unknown and missing evidence cannot exempt generated timing from context caps', () => {
  const source = [
    { id: 'T0001', text: 'The laboratory inspection starts Monday.', classification: 'keep' },
    { id: 'T0002', text: 'The packaging review starts Tuesday.', classification: 'remove' }
  ];
  const details = [
    row('valid', 'The laboratory inspection starts Monday.'),
    row('removed', 'The packaging review starts Tuesday.', ['T0002']),
    row('unknown', 'The reagent review starts Wednesday.', ['UNKNOWN']),
    row('mixed', 'The sample review starts Thursday.', ['T0001', 'UNKNOWN']),
    row('missing', 'The stability review starts Friday.', []),
    row('raw', 'So we should, you know, maybe come back next month with our ideas.')
  ];
  const result = api.limitSupportingDetails([topic([{ ...row('parent', 'Scheduling was discussed.'), supportingDetails: details }])], 0, 0, source);
  assert.deepEqual(result[0].points[0].supportingDetails.map(r => r.id), ['valid']);
  const restored = api.limitSupportingDetails([topic([{ ...row('parent', 'Scheduling was discussed.'),
    supportingDetails: [details[1]] }])], 0, 0, source.map(u => u.id === 'T0002' ? { ...u, restored: true } : u));
  assert.equal(restored[0].points[0].supportingDetails[0].id, 'removed');
});

test('ordinary untimed context keeps existing round-robin total and per-record limits', () => {
  const parents = [
    { ...row('one', 'Equipment records were reviewed.'), supportingDetails: [
      row('a', 'The calibration binder contains the instrument history.'), row('b', 'A supplier appendix lists compatible replacement parts.') ] },
    { ...row('two', 'Laboratory records were reviewed.'), supportingDetails: [
      row('c', 'The sample archive contains the reference results.'), row('d', 'A storage appendix describes specimen handling.') ] }
  ];
  const result = api.limitSupportingDetails([topic(parents)], 2, 1, unitsFor(['Unrelated source.']));
  assert.deepEqual(result[0].points.map(r => r.supportingDetails.length), [1, 1]);
  assert.equal(result[0].points.flatMap(r => r.supportingDetails).length, 2);
});

test('context budgeting preserves reviewer detail, parent and topic wording without source requirements', () => {
  const manual = { ...row('manual', 'The inspection might start Friday.', []), reviewerAuthored: true, reviewFlagIds: ['review-note'] };
  const parent = { ...row('parent', 'The reviewer retained this context.'), supportingDetails: [manual] };
  const authored = { ...row('authored', 'The reviewer wrote this explanation.'), reviewerAuthored: true,
    supportingDetails: [row('manual-untimed', 'A deliberately retained background explanation.', [])] };
  const reviewerTopic = { ...topic([{ ...row('topic-parent', 'A manually arranged section.'),
    supportingDetails: [row('topic-detail', 'The reviewer wanted this additional context.', [])] }]), id: 'manual-topic', reviewerAuthored: true };
  const input = [topic([parent, authored]), reviewerTopic], before = structuredClone(input);
  const result = api.limitSupportingDetails(input, 0, 0, []);
  assert.deepEqual(result[0].points[0].supportingDetails, [manual]);
  assert.deepEqual(result[0].points[1], authored);
  assert.deepEqual(result[1], reviewerTopic);
  assert.deepEqual(input, before);
});

test('a source-proved material deadline is promoted before the context cap and remains ordinary publication', () => {
  const { promoteMaterialTimingDetails } = require('../utils/meetingMinutesTemporalPublication');
  const text = 'Existing devices must be entered in the product register by 28 November 2026.';
  const units = [{ id: 'T0001', text: 'Existing devices must be entered in the product register by 28 November this year.', classification: 'keep' }];
  const discussion = [topic([{ ...row('parent', 'Registration requirements were reviewed.'), supportingDetails: [row('deadline', text)] }])];
  const promoted = promoteMaterialTimingDetails(discussion, units, { meetingDate: '2026-06-17' });
  assert.equal(promoted.promoted, 1);
  const capped = api.limitSupportingDetails(promoted.discussion, 0, 0, units);
  assert.ok(capped.flatMap(t => t.points).some(r => r.id === 'deadline' && r.text === text));
  const published = api.meetingAgentDraftForPdf({ details: { meetingDate: '2026-06-17' }, discussion: capped,
    sourceUnits: units, qualityState: { preparation: { dateContext: { source: 'reviewer', meetingDate: '2026-06-17' } } } });
  assert.ok(published.discussion.flatMap(t => t.points).includes(text));
});
