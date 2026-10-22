'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { rehomeSupportingDetails, unitIndex } = require('../utils/canonicalMinutes/discussionOrganiser');

const row = (id, text, evidenceIds, supportingDetails = []) => ({ id, text, evidenceIds, supportingDetails });
const topic = (id, title, points) => ({ id, topic: title, points, decisions: [], openQuestions: [] });
const units = [
  { id: 'T1', sequence: 1, speaker: 'Morgan Lee', text: 'The pressure inspection is complete.' },
  { id: 'T50', sequence: 50, speaker: 'Morgan Lee', text: 'Vegetarian lunch choices are available.' },
  { id: 'T100', sequence: 100, speaker: 'Morgan Lee', text: 'The pressure calibration is complete.' }
];

test('a broad citation window does not shield an unrelated detail from its unique subject parent', () => {
  const detail = row('vegetarian', 'Vegetarian lunch choices are available.', ['T50']);
  const topics = [
    topic('pressure', 'Pressure inspection', [
      row('pressure-first', 'Pressure verification is complete.', ['T1'], [detail]),
      row('pressure-last', 'Pressure calibration is complete.', ['T100'])
    ]),
    topic('catering', 'Catering arrangements', [row('lunch', 'Vegetarian lunch choices have been arranged.', ['T50'])])
  ];
  const result = rehomeSupportingDetails(topics, unitIndex(units));
  assert.deepEqual(result[0].points[0].supportingDetails, []);
  assert.equal(result[1].points[0].supportingDetails.length, 1);
  assert.equal(result[1].points[0].supportingDetails[0].text, detail.text);
  assert.deepEqual(result[1].points[0].supportingDetails[0].evidenceIds, ['T50']);
});

test('source proximity alone cannot move a detail into an unrelated topic', () => {
  const detail = row('supplier', 'Supplier insurance needs confirmation.', ['T50']);
  const topics = [
    topic('pressure', 'Pressure inspection', [row('pressure', 'Pressure verification is complete.', ['T1'], [detail])]),
    topic('catering', 'Catering arrangements', [row('lunch', 'Vegetarian lunch choices have been arranged.', ['T50'])])
  ];
  const result = rehomeSupportingDetails(topics, unitIndex(units));
  assert.equal(result[0].points[0].supportingDetails.length, 1);
  assert.deepEqual(result[1].points[0].supportingDetails, []);
  assert.equal(result[0].points[0].supportingDetails[0].placementStatus, 'unresolved');
  assert.equal(result[0].points[0].supportingDetails[0].text, detail.text);
});

test('reviewer-owned details and their parents are not refiled or annotated', () => {
  const detail = { ...row('reviewer-detail', 'Vegetarian lunch choices are available.', ['T50']), reviewerAuthored: true };
  const topics = [
    topic('pressure', 'Pressure inspection', [row('pressure', 'Pressure verification is complete.', ['T1'], [detail])]),
    topic('catering', 'Catering arrangements', [row('lunch', 'Vegetarian lunch choices have been arranged.', ['T50'])])
  ];
  const before = structuredClone(topics);
  rehomeSupportingDetails(topics, unitIndex(units));
  assert.deepEqual(topics, before);
});

const { selectSupportingDetailParent } = require('../utils/canonicalMinutes/supportingDetailPlacement');
const { demoteUnreadyRows } = require('../utils/canonicalMinutes/discussionOrganiser');
const candidate = (id, text, title = '') => ({ topic: title, record: row(id, text, ['T1']) });

test('shared citations alone cannot choose the first unrelated parent in either order', () => {
  const parents = [
    candidate('pressure', 'The cooling system passed pressure inspection.', 'Pressure inspection'),
    candidate('lunch', 'Lunches will be supplied by the cafeteria.', 'Catering')
  ];
  const detail = row('vegetarian', 'Vegetarian choices were requested.', ['T1']);
  for (const values of [parents, [...parents].reverse()]) {
    assert.deepEqual(selectSupportingDetailParent(detail, values), {
      target: null, status: 'unresolved', reason: 'no_subject_match'
    });
  }
});

test('source names, dates, amounts and generic editorial words cannot supply the subject', () => {
  const parents = [candidate('review', 'Morgan Lee will review the project on Friday for 12 hours.', 'Project review')];
  const result = selectSupportingDetailParent({ text: 'Morgan Lee requested an update on Friday for 12 hours.' }, parents, {
    sourceUnits: [{ id: 'T1', speaker: 'Morgan Lee', text: 'Review on Friday.' }]
  });
  assert.equal(result.target, null);
  assert.equal(result.reason, 'no_subject_match');
});

test('a unique subject match returns the original candidate without modifying input', () => {
  const parents = [
    candidate('pressure', 'Cooling system pressure inspection passed.', 'Pressure inspection'),
    candidate('lunch', 'Vegetarian lunch choices are arranged.', 'Catering')
  ];
  const before = structuredClone(parents);
  const result = selectSupportingDetailParent({ text: 'Vegetarian lunch choices are available.' }, parents);
  assert.equal(result.target, parents[1]);
  assert.equal(result.reason, 'subject_match');
  assert.deepEqual(parents, before);
});

test('equal subject matches stay unresolved regardless of source citation or array order', () => {
  const parents = [
    candidate('one', 'Vegetarian lunch choices are arranged.', 'Catering'),
    candidate('two', 'Vegetarian lunch choices are arranged.', 'Catering')
  ];
  parents[1].record.evidenceIds = ['T999'];
  for (const values of [parents, [...parents].reverse()]) {
    const result = selectSupportingDetailParent(row('detail', 'Vegetarian lunch choices are available.', ['T1']), values);
    assert.equal(result.target, null);
    assert.equal(result.reason, 'ambiguous_subject_match');
  }
});

test('a unique explicit target wins even when a short detail cannot prove its subject lexically', () => {
  const parents = [candidate('pressure', 'Pressure inspection passed.'), candidate('catering', 'Lunches are arranged.')];
  assert.equal(selectSupportingDetailParent({ text: 'Also vegetarian.' }, parents, { explicitTarget: 'catering' }).target, parents[1]);
});

test('a unique merged alias resolves, but duplicate aliases remain unresolved', () => {
  const parents = [candidate('survivor', 'Lunches are arranged.'), candidate('other', 'Pressure inspection passed.')];
  parents[0].record.mergedFromIds = ['former-target'];
  const options = { explicitTarget: 'former-target' };
  assert.equal(selectSupportingDetailParent({ text: 'Also vegetarian.' }, parents, options).target, parents[0]);
  assert.equal(selectSupportingDetailParent({ text: 'Also vegetarian.' }, parents, options).reason, 'explicit_target_alias');
  parents[1].record.mergedFromIds = ['former-target'];
  assert.equal(selectSupportingDetailParent({ text: 'Also vegetarian.' }, parents, options).reason, 'ambiguous_explicit_target');
});

test('exact identity takes precedence over an alias, and missing or repeated explicit IDs cannot fall back', () => {
  const exact = candidate('target', 'Pressure inspection passed.');
  const alias = candidate('other', 'Vegetarian lunch choices are available.');
  alias.record.mergedFromIds = ['target'];
  assert.equal(selectSupportingDetailParent({ text: 'Vegetarian lunch choices are available.' }, [exact, alias],
    { explicitTarget: 'target' }).target, exact);
  assert.equal(selectSupportingDetailParent({ text: 'Vegetarian lunch choices are available.' }, [exact, alias],
    { explicitTarget: 'missing' }).reason, 'explicit_target_missing');
  const duplicate = candidate('target', 'Vegetarian lunch choices are available.');
  assert.equal(selectSupportingDetailParent({ text: 'Vegetarian lunch choices are available.' }, [exact, duplicate],
    { explicitTarget: 'target' }).reason, 'ambiguous_explicit_target');
});

test('a distinctive acronym can resolve, but a bare acknowledgement remains unassigned', () => {
  const parents = [candidate('qms', 'QMS documentation needs translation.', 'QMS'), candidate('safety', 'Safety verification passed.')];
  assert.equal(selectSupportingDetailParent({ text: 'QMS translation is available.' }, parents).target, parents[0]);
  assert.equal(selectSupportingDetailParent({ text: 'Agreed for Friday.' }, parents).target, null);
});

test('fallback does not mutate reviewer-owned destinations while explicit identity remains resolvable', () => {
  const parent = candidate('manual', 'Vegetarian lunch choices are available.', 'Catering');
  parent.record.reviewerAuthored = true;
  assert.equal(selectSupportingDetailParent({ text: 'Vegetarian lunch choices are arranged.' }, [parent]).target, null);
  assert.equal(selectSupportingDetailParent({ text: 'Vegetarian lunch choices are arranged.' }, [parent],
    { explicitTarget: 'manual' }).target, parent);
});

test('repeated rehoming neither duplicates details nor changes primary prose or ordering', () => {
  const detail = row('vegetarian', 'Vegetarian lunch choices are available.', ['T50']);
  const topics = [
    topic('pressure', 'Pressure inspection', [row('pressure', 'Pressure verification is complete.', ['T1'], [detail])]),
    topic('catering', 'Catering arrangements', [row('lunch', 'Vegetarian lunch choices have been arranged.', ['T50'])])
  ];
  const primaryBefore = topics.map(t => [t.id, t.points.map(p => [p.id, p.text, p.evidenceIds])]);
  rehomeSupportingDetails(topics, unitIndex(units));
  const once = structuredClone(topics);
  rehomeSupportingDetails(topics, unitIndex(units));
  assert.deepEqual(topics, once);
  assert.deepEqual(topics.map(t => [t.id, t.points.map(p => [p.id, p.text, p.evidenceIds])]), primaryBefore);
  assert.equal(topics.flatMap(t => t.points.flatMap(p => p.supportingDetails)).length, 1);
});

test('an unresolved demotion hands full text and existing children to the collector atomically', () => {
  const raw = 'Morgan Lee asks about supplier insurance.';
  const child = row('child', 'The insurance certificate must cover public liability.', ['T100']);
  const original = row('raw', raw, ['T50'], [child]);
  const captured = [];
  const result = demoteUnreadyRows([
    topic('pressure', 'Pressure inspection', [row('pressure', 'Pressure verification is complete.', ['T1'])]),
    topic('insurance', 'Supplier insurance', [original])
  ], unitIndex(units), { onUnassignedSupportingDetail(detail, context) { captured.push({ detail, context }); return true; } });
  assert.equal(result.length, 1);
  assert.equal(result[0].points[0].id, 'pressure');
  assert.deepEqual(result[0].points[0].supportingDetails || [], []);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].detail.text, raw);
  assert.equal(captured[0].context.originalTopic, 'Supplier insurance');
  assert.deepEqual(captured[0].context.supportingDetails, [child]);
});

test('a missing or rejecting collector keeps the original row and children instead of guessing a parent', () => {
  const raw = 'Morgan Lee asks about supplier insurance.';
  for (const options of [{}, { onUnassignedSupportingDetail: () => false }]) {
    const child = row('child', 'The insurance certificate must cover public liability.', ['T100']);
    const input = [
      topic('pressure', 'Pressure inspection', [row('pressure', 'Pressure verification is complete.', ['T1'])]),
      topic('insurance', 'Supplier insurance', [row('raw', raw, ['T50'], [child])])
    ];
    const result = demoteUnreadyRows(input, unitIndex(units), options);
    assert.equal(result.length, 2);
    assert.equal(result[1].points[0].text, raw);
    assert.equal(result[1].points[0].placementStatus, 'unresolved');
    assert.deepEqual(result[1].points[0].supportingDetails, [child]);
    assert.deepEqual(result[0].points[0].supportingDetails, []);
  }
});

test('single ordinary nouns, heading words and low-coverage fragments do not establish a parent', () => {
  const cases = [
    ['Photograph the damaged entrance canopy and send the letter.', 'The annual membership increase is explained in renewal letters.', 'Membership fees'],
    ['Supplier approval procedures need regulatory assessment.', 'Installation has regulatory requirements.', 'Installation'],
    ['Cargo arrives from the factory before registration and warehouse storage.', 'Agency registration invoices are paid.', 'Agency invoices'],
    ['Cooling pressure verification has passed.', 'Vegetarian lunches are arranged.', 'Cooling pressure verification'],
    ['Pressure calibration affects insulation, control logic, wiring, shielding, connectors, ventilation and operating temperatures.', 'Pressure calibration passed.', 'Pressure inspection']
  ];
  for (const [detail, body, heading] of cases) {
    assert.equal(selectSupportingDetailParent({ text: detail }, [candidate('parent', body, heading)]).target, null, detail);
  }
});

test('spoken counts cannot become an extra subject anchor', () => {
  const result = selectSupportingDetailParent({ text: 'Product arrives at the warehouse and is held for one day.' }, [
    candidate('database', 'The database has no product entry for class one.', 'Database records')
  ]);
  assert.equal(result.target, null);
});

test('a common acronym cannot erase a numbered subject distinction', () => {
  const parents = [candidate('standard', 'ISO 13485 requirements apply.', 'Quality management')];
  assert.equal(selectSupportingDetailParent({ text: 'ISO 9001.' }, parents).target, null);
});

test('a plausible existing parent is retained instead of being outscored by a longer sentence', () => {
  const detail = row('detail', 'Pressure calibration maintenance records are complete.', ['T50']);
  const topics = [
    topic('current', 'Pressure checks', [row('parent', 'Pressure calibration checks are complete.', ['T1'], [detail])]),
    topic('competing', 'Maintenance archives', [row('longer', 'Pressure calibration maintenance records are archived.', ['T50'])])
  ];
  rehomeSupportingDetails(topics, unitIndex(units));
  assert.equal(topics[0].points[0].supportingDetails[0].id, 'detail');
  assert.deepEqual(topics[1].points[0].supportingDetails, []);
});

test('existing filing cannot hide an ambiguous explicit identity elsewhere in the draft', () => {
  const detail = { ...row('detail', 'Vegetarian lunch choices are available.', ['T50']), mergeTarget: 'duplicate' };
  const topics = [
    topic('current', 'Catering choices', [row('duplicate', 'Vegetarian lunch choices are arranged.', ['T1'], [detail])]),
    topic('other', 'Catering delivery', [row('duplicate', 'Vegetarian lunch choices are delivered.', ['T50'])])
  ];
  rehomeSupportingDetails(topics, unitIndex(units));
  assert.equal(topics[0].points[0].supportingDetails[0].placementStatus, 'unresolved');
  assert.equal(topics[0].points[0].supportingDetails[0].placementReason, 'ambiguous_explicit_target');
  assert.deepEqual(topics[1].points[0].supportingDetails, []);
});

test('an orphan handoff keeps source text longer than the review-flag limit without truncation', () => {
  const raw = 'Supplier insurance certificates cover liability, equipment, storage and operational facilities. '.repeat(12).trim();
  const source = [{ id: 'S1', sequence: 1, speaker: 'Morgan Lee', text: raw }];
  const captured = [];
  const result = demoteUnreadyRows([topic('insurance', 'Insurance records', [row('raw', raw, ['S1'])])], unitIndex(source), {
    onUnassignedSupportingDetail(detail) { captured.push(detail); return true; }
  });
  assert.equal(result.length, 0);
  assert.equal(captured[0].text, raw);
  assert.ok(captured[0].text.length > 500);
  assert.deepEqual(captured[0].evidenceIds, ['S1']);
});

test('unready rows and details authored by a reviewer stay in their chosen locations', () => {
  const raw = 'Morgan Lee asks about supplier insurance.';
  const manual = { ...row('manual', raw, ['T50']), reviewerAuthored: true };
  const ownChild = { ...row('manual-child', 'The insurance certificate must cover public liability.', ['T100']), reviewerAuthored: true };
  const withManualChild = row('raw-parent', raw, ['T50'], [ownChild]);
  const input = [topic('insurance', 'Supplier insurance', [manual, withManualChild])];
  const before = structuredClone(input);
  const result = demoteUnreadyRows(input, unitIndex(units), {
    onUnassignedSupportingDetail() { assert.fail('reviewer material must not be handed off'); }
  });
  assert.deepEqual(result, before);
});
