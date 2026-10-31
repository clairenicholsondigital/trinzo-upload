'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compactDiscussionPropositions, consolidateSupportingDetails, dedupeSupportingDetailsSemantically, limitSupportingDetails, prioritySupportingDetail, promotePrioritySupportingDetails } = require('../utils/meetingMinutesDiscussionSelection');
const { mergePublishedActionEvidence } = require('../utils/meetingMinutesActionDuplicatePolicy');

test('bare status reassurance is consolidated into a fuller context item about the same subject', () => {
  const details = consolidateSupportingDetails({
    text: 'The delivery programme was reviewed.', evidenceIds: ['T0001'],
    supportingDetails: [
      { id: 'dated', text: 'Translation review is scheduled for next week.', evidenceIds: ['T0010'] },
      { id: 'status', text: 'On track for the translation review.', evidenceIds: ['T0011'] },
      { id: 'other', text: 'Interface testing is on track.', evidenceIds: ['T0012'] },
      { id: 'timed-status', text: 'Packaging review is on track for completion next Thursday.', evidenceIds: ['T0013'] }
    ]
  });
  assert.deepEqual(details.map((detail) => detail.id), ['timed-status', 'dated', 'other']);
});

test('priority risk and delivery status details become primary minutes before extras are capped', () => {
  const discussion = [{
    id: 'topic-1', topic: 'Delivery review', decisions: [], openQuestions: [],
    points: [{
      id: 'main', text: 'The delivery programme was reviewed.', evidenceIds: ['T0001'],
      supportingDetails: [
        { id: 'risk', text: 'The unresolved interface defect remains a high risk to the release.', evidenceIds: ['T0002'] },
        { id: 'status', text: 'Electrical compliance testing is on track for completion next Thursday.', evidenceIds: ['T0003'] },
        { id: 'context-1', text: 'The test team is using the revised protocol.', evidenceIds: ['T0004'] },
        { id: 'context-2', text: 'The protocol is stored in the quality folder.', evidenceIds: ['T0005'] },
        { id: 'context-3', text: 'The folder is available to the wider project team.', evidenceIds: ['T0006'] }
      ]
    }]
  }];
  const promoted = promotePrioritySupportingDetails(discussion);
  assert.equal(promoted.promoted, 2);
  assert.deepEqual(promoted.discussion[0].points.slice(1).map((row) => row.id), ['risk', 'status']);
  const limited = limitSupportingDetails(promoted.discussion, 1, 2);
  assert.equal(limited[0].points[0].supportingDetails.length, 1);
  assert.equal(limited[0].points.slice(1).every((row) => row.supportingDetails.length === 0), true);
});

test('priority detail promotion is capped per topic and leaves the remaining evidence nested', () => {
  const details = [
    { id: 'risk', text: 'The unresolved interface defect remains a material risk to release.', evidenceIds: ['T002'] },
    { id: 'status', text: 'Electrical compliance testing is on track for completion next Thursday.', evidenceIds: ['T003'] },
    { id: 'delay', text: 'Delivery of the venue drawings is behind schedule.', evidenceIds: ['T004'] },
    { id: 'decision', text: 'The budget decision was deferred until revised forecasts arrive.', evidenceIds: ['T005'] }
  ];
  const discussion = [{
    id: 'topic-1', topic: 'Supplier risks', decisions: [], openQuestions: [],
    points: [{
      id: 'main', text: 'The supplier position was reviewed.', evidenceIds: ['T001'],
      supportingDetails: details
    }]
  }];
  const promoted = promotePrioritySupportingDetails(discussion);
  assert.equal(promoted.promoted, 2);
  assert.deepEqual(promoted.discussion[0].points.slice(1).map((row) => row.id), ['risk', 'status']);
  assert.deepEqual(promoted.discussion[0].points[0].supportingDetails.map((row) => row.id), ['delay', 'decision']);
});

test('priority detail promotion keeps a near-restatement nested beneath its primary point', () => {
  const discussion = [{
    id: 'topic-1', topic: 'USB cybersecurity', decisions: [], openQuestions: [],
    points: [{
      id: 'main', text: 'The USB cybersecurity risk assessment remains in progress.', evidenceIds: ['T0100'],
      supportingDetails: [{
        id: 'detail', text: 'Cybersecurity risk assessment work for USB access remains in progress.', evidenceIds: ['T0101']
      }]
    }]
  }];
  const promoted = promotePrioritySupportingDetails(discussion);
  assert.equal(promoted.promoted, 0);
  assert.deepEqual(promoted.discussion[0].points[0].supportingDetails.map((row) => row.id), ['detail']);
});

test('explicit no-decision and deferral outcomes are promoted from supporting detail', () => {
  assert.equal(prioritySupportingDetail('No final option was selected during the meeting.'), true);
  assert.equal(prioritySupportingDetail('The decision was deferred until the enforcement costs are available.'), true);
  const discussion = [{
    id: 'topic-1', topic: 'Parking controls', decisions: [], openQuestions: [],
    points: [{
      id: 'main', text: 'Several parking-control approaches were considered.', evidenceIds: ['T0050'],
      supportingDetails: [
        { id: 'no-decision', text: 'No final option was selected during the meeting.', evidenceIds: ['T0051'] },
        { id: 'deferred', text: 'The decision was deferred until the enforcement costs are available.', evidenceIds: ['T0052'] },
        { id: 'minor', text: 'The examples were discussed in a different order.', evidenceIds: ['T0053'] }
      ]
    }]
  }];
  const promoted = promotePrioritySupportingDetails(discussion);
  assert.ok(promoted.promoted >= 1);
  assert.ok(promoted.discussion[0].points.slice(1).some((row) => ['no-decision', 'deferred'].includes(row.id)));
});

test('material performance metrics move from additional details into the minutes', () => {
  const discussion = [{
    id: 'topic-1', topic: 'Service performance', decisions: [], openQuestions: [],
    points: [{
      id: 'main', text: 'Service performance was reviewed.', evidenceIds: ['T0100'],
      supportingDetails: [
        { id: 'metric', text: 'Ticket volumes decreased 12% month on month; average resolution time improved to 6.2 hours from 7.9; customer satisfaction is 4.4 out of 5.', evidenceIds: ['T0101'] },
        { id: 'aside', text: 'The team also discussed the usual reporting format.', evidenceIds: ['T0102'] }
      ]
    }]
  }];
  const promoted = promotePrioritySupportingDetails(discussion);
  assert.equal(promoted.promoted, 1);
  assert.equal(promoted.discussion[0].points[1].id, 'metric');
  assert.deepEqual(promoted.discussion[0].points[0].supportingDetails.map((row) => row.id), ['aside']);
});

test('discussion compaction keeps otherwise similar claims with different dates separate', () => {
  const discussion = [{ topic: 'Travel documents', points: [
    { id: 'p9', text: 'Passport details are required by 9 July.', evidenceIds: ['T0009'] },
    { id: 'p10', text: 'Passport details are required by 10 July.', evidenceIds: ['T0010'] }
  ], decisions: [
    { id: 'synthetic', text: 'Passport details are required by 9th or 10th July.', evidenceIds: ['T0009', 'T0010'] }
  ], openQuestions: [] }];
  const compact = compactDiscussionPropositions(discussion, [], [
    { id: 'T0009', speaker: 'Alex', text: 'Send the first passport details by 9 July.' },
    { id: 'T0010', speaker: 'Sam', text: 'The remaining passport details are due by 10 July.' }
  ]);
  assert.equal(compact[0].points.length, 2);
  assert.equal(compact[0].decisions.length, 0);
});

test('authoritative referee supporting detail stays collapsed even when materially worded', () => {
  const units = [
    { id: 'T0001', sequence: 1, speaker: 'Alex', text: 'The release decision is pending.', classification: 'keep' },
    { id: 'T0002', sequence: 2, speaker: 'Priya', text: 'The significant risk is supplier approval.', classification: 'keep' }
  ];
  const discussion = [{
    topic: 'Release',
    points: [{ id: 'core', text: 'The release decision is pending.', evidenceIds: ['T0001'], supportingDetails: [] }],
    decisions: [], openQuestions: []
  }];
  const compact = compactDiscussionPropositions(discussion, [], units, {
    promoteMaterialSupporting: false,
    supportingCandidates: [{
      mergeTarget: 'core',
      candidate: { candidateId: 'risk', topic: 'Release', text: 'The significant risk is supplier approval.', evidenceIds: ['T0002'] }
    }]
  });
  assert.equal(compact[0].points.length, 1);
  assert.equal(compact[0].points[0].supportingDetails.length, 1);
});

test('compact discussion chooses a decision once and preserves companion facts as context', () => {
  const units = [
    { id: 'T0001', sequence: 1, speaker: 'Alex', text: 'The release remains blocked by supplier approval.', classification: 'keep' },
    { id: 'T0002', sequence: 2, speaker: 'Priya', text: 'We agreed the release will wait for supplier approval.', classification: 'keep' }
  ];
  const compact = compactDiscussionPropositions([{ topic: 'Release approval',
    points: [{ id: 'p1', text: 'The release remains blocked by supplier approval.', evidenceIds: ['T0001'] }],
    decisions: [{ id: 'd1', text: 'The release will wait for supplier approval.', evidenceIds: ['T0002'] }],
    openQuestions: [{ id: 'q1', text: 'Whether the release could proceed before supplier approval was unresolved.', evidenceIds: ['T0001'] }]
  }], [], units);
  assert.equal(compact.length, 1);
  assert.equal(compact[0].decisions.length, 1);
  assert.equal(compact[0].points.length, 0);
  assert.equal(compact[0].openQuestions.length, 0);
  assert.deepEqual(compact[0].decisions[0].evidenceIds, ['T0001', 'T0002']);
  assert.ok(compact[0].decisions[0].supportingDetails.length >= 1);
});

test('compact discussion clusters the same proposition across generated topic labels', () => {
  const units = [
    { id: 'T0001', sequence: 1, speaker: 'Alex', text: 'The release is blocked until supplier approval.', classification: 'keep' },
    { id: 'T0002', sequence: 2, speaker: 'Priya', text: 'Supplier approval remains the blocker for release.', classification: 'keep' }
  ];
  const compact = compactDiscussionPropositions([
    { topic: 'Release plan', points: [{ id: 'p1', text: 'The release is blocked until supplier approval.', evidenceIds: ['T0001'] }], decisions: [], openQuestions: [] },
    { topic: 'Supplier status', points: [], decisions: [], openQuestions: [{ id: 'q1', text: 'Supplier approval remains the blocker for release.', evidenceIds: ['T0002'] }] }
  ], [], units);
  const visible = compact.flatMap((topic) => [...topic.points, ...topic.decisions, ...topic.openQuestions]);
  assert.equal(visible.length, 1);
  assert.deepEqual(visible[0].evidenceIds, ['T0001', 'T0002']);
});

test('an ordinary recovered question stays review context without a guessed parent or extra visible row', () => {
  const units = [
    { id: 'T0050', sequence: 50, speaker: 'Alex', text: 'The supplier access approach is being reviewed.', classification: 'keep' },
    { id: 'T0051', sequence: 51, speaker: 'Priya', text: 'Which portal might be used?', classification: 'keep' }
  ];
  const collected = [];
  const compact = compactDiscussionPropositions(
    [{ topic: 'Supplier access', points: [{ id: 'p1', text: 'The supplier access approach is being reviewed.', evidenceIds: ['T0050'] }], decisions: [], openQuestions: [] }],
    [{ topic: 'Supplier access', points: [], decisions: [], openQuestions: [{ id: 'q1', text: 'Which portal might be used?', evidenceIds: ['T0051'] }] }],
    units,
    { onUnassignedSupportingDetail(detail, context) { collected.push({ detail, context }); return true; } }
  );
  const visible = compact.flatMap(topic => [...topic.points, ...topic.decisions, ...topic.openQuestions]);
  assert.deepEqual(visible.map(record => record.id), ['p1']);
  assert.equal(visible[0].text, 'The supplier access approach is being reviewed.');
  assert.deepEqual(visible[0].supportingDetails, []);
  // A topic label and adjacent citations do not prove which proposition owns
  // the question. Its full wording and evidence remain available for review.
  assert.deepEqual(collected, [{
    detail: { id: 'q1', text: 'Which portal might be used?', evidenceIds: ['T0051'] },
    context: { originalTopic: 'Supplier access', placementReason: 'no_subject_match' }
  }]);
});

test('a distinct material supporting detail is promoted into the visible minutes', () => {
  const units = [
    { id: 'T0060', sequence: 60, speaker: 'Alex', text: 'The release approach was reviewed.', classification: 'keep' },
    { id: 'T0061', sequence: 61, speaker: 'Priya', text: 'Regulatory approval remains unresolved and blocks the release.', classification: 'keep' }
  ];
  const compact = compactDiscussionPropositions(
    [{ topic: 'Release', points: [{
      id: 'p1', text: 'The release approach was reviewed.', evidenceIds: ['T0060'],
      supportingDetails: [{ id: 's1', text: 'Regulatory approval remains unresolved and blocks the release.', evidenceIds: ['T0061'] }]
    }], decisions: [], openQuestions: [] }],
    [], units
  );
  const visible = compact.flatMap((topic) => [...topic.points, ...topic.decisions, ...topic.openQuestions]);
  assert.equal(visible.length, 2);
  assert.ok(visible.some((record) => record.text === 'Regulatory approval remains unresolved and blocks the release.'));
  assert.equal(compact[0].points.find((record) => record.id === 'p1').supportingDetails.length, 0);
});

test('raw conversational fragments are not visible discussion propositions', () => {
  const units = [
    { id: 'T0062', sequence: 62, speaker: 'Alex', text: 'So we may get a chance to look at it.', classification: 'keep' },
    { id: 'T0063', sequence: 63, speaker: 'Priya', text: 'The review depends on supplier access.', classification: 'keep' }
  ];
  const compact = compactDiscussionPropositions([{ topic: 'Review', points: [
    { id: 'raw', text: 'So we may get a chance to look at it.', evidenceIds: ['T0062'] },
    { id: 'formal', text: 'The review depends on supplier access.', evidenceIds: ['T0063'] }
  ], decisions: [], openQuestions: [] }], [], units);
  const visible = compact.flatMap((topic) => [...topic.points, ...topic.decisions, ...topic.openQuestions]);
  assert.deepEqual(visible.map((record) => record.id), ['formal']);
});

test('direct second-person questions are not emitted as formal discussion propositions', () => {
  const source = [
    { id: 'T0001', speaker: 'Alex', text: 'Can you put them back?', classification: 'keep' },
    { id: 'T0002', speaker: 'Priya', text: 'Whether the charts should be restored remained unresolved.', classification: 'keep' }
  ];
  const result = compactDiscussionPropositions([{
    topic: 'Presentation content',
    points: [
      { id: 'fragment', text: 'Can you put them back?', evidenceIds: ['T0001'] },
      { id: 'formal', text: 'Whether the charts should be restored remained unresolved.', evidenceIds: ['T0002'] }
    ],
    decisions: [], openQuestions: []
  }], [], source);
  assert.deepEqual(result.flatMap((topic) => topic.points.map((point) => point.text)), [
    'Whether the charts should be restored remained unresolved.'
  ]);
});

test('compact discussion does not merge conflicting quantities', () => {
  const units = [
    { id: 'T0100', sequence: 100, speaker: 'Alex', text: 'Three alarms are in scope.', classification: 'keep' },
    { id: 'T0101', sequence: 101, speaker: 'Alex', text: 'Five alarms remain for the later release.', classification: 'keep' }
  ];
  const compact = compactDiscussionPropositions([{ topic: 'Alarm scope', points: [
    { id: 'p1', text: 'Three alarms are in scope.', evidenceIds: ['T0100'] },
    { id: 'p2', text: 'Five alarms remain for the later release.', evidenceIds: ['T0101'] }
  ], decisions: [], openQuestions: [] }], [], units);
  assert.equal(compact[0].points.length, 2);
});

test('ordinary corroborated recovery remains lossless review context without another visible row', () => {
  const units = [
    { id: 'T0200', sequence: 200, speaker: 'Alex', text: 'Supplier approval is the current release blocker.', classification: 'keep' },
    { id: 'T0201', sequence: 201, speaker: 'Priya', text: 'The supplier normally sends a weekly status note.', classification: 'keep' }
  ];
  const collected = [];
  const compact = compactDiscussionPropositions(
    [{ topic: 'Release', points: [{ id: 'p1', text: 'Supplier approval is the current release blocker.', evidenceIds: ['T0200'] }], decisions: [], openQuestions: [] }],
    [{ topic: 'Release', points: [{ id: 'p2', text: 'The supplier normally sends a weekly status note.', evidenceIds: ['T0201'] }], decisions: [], openQuestions: [] }],
    units,
    { onUnassignedSupportingDetail(detail, context) { collected.push({ detail, context }); return true; } }
  );
  const visible = compact.flatMap(topic => [...topic.points, ...topic.decisions, ...topic.openQuestions]);
  assert.deepEqual(visible.map(record => record.id), ['p1']);
  assert.equal(visible[0].text, 'Supplier approval is the current release blocker.');
  assert.deepEqual(visible[0].supportingDetails, []);
  // Sharing only "supplier" does not establish a subject match. The review
  // collector keeps the complete recovered fact, including its source.
  assert.deepEqual(collected, [{
    detail: { id: 'p2', text: 'The supplier normally sends a weekly status note.', evidenceIds: ['T0201'] },
    context: { originalTopic: 'Release', placementReason: 'no_subject_match' }
  }]);
});

test('collapsed context removes shorter evidence-overlapping restatements', () => {
  const units = [{ id: 'T0250', sequence: 250, speaker: 'Alex', text: "The council has not inspected the fence for three months, a whole panel is down and Bertie's dog escaped through it last week.", classification: 'keep' }];
  const compact = compactDiscussionPropositions([{ topic: 'Fence hazard', points: [{
    id: 'p1', text: 'A boundary fence panel was down and a dog escaped through it last week, creating a safety hazard.', evidenceIds: ['T0250'],
    supportingDetails: [
      { id: 's1', text: 'A whole fence panel is down.', evidenceIds: ['T0250'] },
      { id: 's2', text: "Bertie's dog escaped through it last week.", evidenceIds: ['T0250'] },
      { id: 's3', text: 'The council had not inspected the fence for three months.', evidenceIds: ['T0250'] }
    ]
  }], decisions: [], openQuestions: [] }], [], units);
  assert.deepEqual(compact[0].points[0].supportingDetails.map((detail) => detail.id), ['s3']);
});

test('referee-classified supporting candidates remain recoverable under the closest proposition', () => {
  const units = [
    { id: 'T0300', sequence: 300, speaker: 'Alex', text: 'The release is blocked until supplier approval.', classification: 'keep' },
    { id: 'T0301', sequence: 301, speaker: 'Priya', text: 'The supplier provides a weekly progress note.', classification: 'keep' }
  ];
  const compact = compactDiscussionPropositions(
    [{ topic: 'Supplier approval', points: [{ id: 'P1', text: 'The release is blocked until supplier approval.', evidenceIds: ['T0300'] }], decisions: [], openQuestions: [] }],
    [], units,
    { supportingCandidates: [{ candidate: {
      candidateId: 'support-1', topic: 'Supplier approval', text: 'The supplier provides a weekly progress note.', evidenceIds: ['T0301']
    }, mergeTarget: 'P1' }] }
  );
  assert.equal(compact[0].points[0].supportingDetails.length, 1);
  assert.equal(compact[0].points[0].supportingDetails[0].text, 'The supplier provides a weekly progress note.');
});

test('compact visible propositions require valid source evidence', () => {
  const units = [{ id: 'T0400', sequence: 400, speaker: 'Alex', text: 'Supplier approval remains pending.', classification: 'keep' }];
  const compact = compactDiscussionPropositions([{ topic: 'Approval', points: [
    { id: 'good', text: 'Supplier approval remains pending.', evidenceIds: ['T0400'] },
    { id: 'bad', text: 'The release was approved.', evidenceIds: ['T9999'] }
  ], decisions: [], openQuestions: [] }], [], units);
  assert.equal(compact[0].points.length, 1);
  assert.equal(compact[0].points[0].id, 'good');
});

test('evidence reconciliation never hides a visible owner, timing or wording change', () => {
  const published = [{
    id: 'report-action', action: 'Send the report.', owners: ['Priya Shah'],
    timing: { kind: 'target', wording: 'This week', exactDate: '' }, evidenceIds: ['T0010'], reviewFlagIds: []
  }];
  const changed = [
    { ...published[0], owners: ['Alex Smith'], evidenceIds: ['T0010', 'T0011'] },
    { ...published[0], timing: { kind: 'deadline', wording: 'Friday', exactDate: '' }, evidenceIds: ['T0010', 'T0012'] },
    { ...published[0], action: 'Send the revised report.', evidenceIds: ['T0010', 'T0013'] }
  ];
  for (const candidate of changed) {
    const reconciled = mergePublishedActionEvidence(published, [candidate]);
    assert.deepEqual(reconciled[0].evidenceIds, ['T0010']);
  }
});

test('an owner follow-up the referee filed as a decision is shown as a discussion point, not a decision', () => {
  const units = [
    { id: 'T0080', sequence: 80, speaker: 'Mick', text: "I'll ring the refrigeration engineer today and get the chiller serviced before the fifteenth.", classification: 'keep' },
    { id: 'T0081', sequence: 81, speaker: 'Dan', text: 'Agreed, we order six sacks of Maris Otter to cover the shortfall.', classification: 'keep' }
  ];
  const compact = compactDiscussionPropositions([{ topic: 'Chiller',
    points: [],
    decisions: [
      { id: 'd1', text: 'Mick to contact the refrigeration engineer today to service the chiller before the fifteenth.', evidenceIds: ['T0080'] },
      { id: 'd2', text: 'Decision to order six additional sacks of Maris Otter malt to cover the shortfall.', evidenceIds: ['T0081'] }
    ],
    openQuestions: []
  }], [], units);
  const decisions = compact.flatMap((topic) => topic.decisions).map((record) => record.text);
  const points = compact.flatMap((topic) => topic.points).map((record) => record.text);
  assert.ok(points.some((text) => /^Mick to contact/.test(text)));
  assert.ok(decisions.some((text) => /^Decision to order/.test(text)));
  assert.ok(!decisions.some((text) => /^Mick to contact/.test(text)));
});

test('supporting context is deduplicated across the whole draft, not per parent row', () => {
  const units = [
    { id: 'T0090', sequence: 90, speaker: 'Ravi', text: 'I will order the full thirteen kilos of hops Monday morning so they arrive before the fifteenth.', classification: 'keep' },
    { id: 'T0091', sequence: 91, speaker: 'Mick', text: 'If the chiller fails mid-ferment we could lose the whole twelve hundred litres.', classification: 'keep' }
  ];
  const discussion = [{ topic: 'Brew plan', points: [
    { id: 'p1', text: 'Ravi will order the full hop bill of thirteen kilos on Monday morning.', evidenceIds: ['T0090'] },
    { id: 'p2', text: 'A chiller failure during the IPA ferment risks the whole twelve hundred litre batch.', evidenceIds: ['T0091'] }
  ], decisions: [], openQuestions: [] }];
  const supportingCandidates = [
    { candidate: { candidateId: 'c1', text: 'The full hop order of thirteen kilos is to be placed on Monday morning to ensure delivery before the fifteenth.', evidenceIds: ['T0090'], topic: 'Hops' }, mergeTarget: 'p1' },
    { candidate: { candidateId: 'c2', text: 'Thirteen kilos of hops are to be ordered Monday morning to ensure delivery before the fifteenth.', evidenceIds: ['T0090'], topic: 'Hops' }, mergeTarget: 'p2' },
    { candidate: { candidateId: 'c3', text: 'Failure of the chiller mid-ferment risks losing the entire twelve hundred litres.', evidenceIds: ['T0091'], topic: 'Chiller' }, mergeTarget: 'p2' },
    { candidate: { candidateId: 'c4', text: 'If the chiller fails mid-ferment the entire twelve hundred litres could be lost.', evidenceIds: ['T0091'], topic: 'Chiller' }, mergeTarget: 'p1' }
  ];
  const compact = compactDiscussionPropositions(discussion, [], units, { supportingCandidates });
  const details = compact.flatMap((topic) => topic.points).flatMap((record) => record.supportingDetails || []).map((detail) => detail.text);
  assert.ok(details.length <= 2, `expected at most one hop detail and one chiller detail, got ${JSON.stringify(details)}`);
  assert.ok(details.filter((text) => /thirteen kilos/i.test(text)).length <= 1);
  assert.ok(details.filter((text) => /chiller/i.test(text)).length <= 1);
});

test('semantic supporting dedupe drops restatements but preserves extra quantities and all primaries', async () => {
  const discussion = [{ topic: 'Chiller', points: [
    { id: 'p1', text: 'A chiller failure during the IPA ferment risks the whole batch.', evidenceIds: ['T0001'], supportingDetails: [
      { id: 'c1', text: 'If the chiller fails mid-ferment the entire twelve hundred litres could be lost.', evidenceIds: ['T0001'] },
      { id: 'c2', text: 'The IPA needs holding at nineteen degrees.', evidenceIds: ['T0002'] }
    ] },
    { id: 'p2', text: 'The last IPA batch was muted on aroma.', evidenceIds: ['T0003'], supportingDetails: [
      { id: 'c3', text: 'Failure of the chiller mid-ferment poses a risk of losing the entire batch.', evidenceIds: ['T0001'] },
      { id: 'c4', text: 'There was feedback that the previous IPA was flat on the nose.', evidenceIds: ['T0003'] }
    ] }
  ], decisions: [], openQuestions: [] }];
  // Text order handed to the grouper is primaries first (p1, p2) then details
  // (c1, c2, c3, c4). Even identical vectors do not prove that p1's "whole
  // batch" retains c1's extra twelve-hundred-litre quantity. c3 and c4 are
  // genuine restatements; c2 remains distinct.
  const vectors = [[1, 0, 0], [0, 1, 0], [1, 0, 0], [0, 0, 1], [1, 0, 0], [0, 1, 0]];
  const result = await dedupeSupportingDetailsSemantically(discussion, { vectors, threshold: 0.8 });
  const [p1, p2] = result[0].points;
  assert.deepEqual(p1.supportingDetails.map((detail) => detail.id), ['c1', 'c2']);
  assert.deepEqual(p1.supportingDetails[0], {
    id: 'c1', text: 'If the chiller fails mid-ferment the entire twelve hundred litres could be lost.', evidenceIds: ['T0001']
  });
  assert.deepEqual(p2.supportingDetails.map((detail) => detail.id), []);
  assert.deepEqual(result[0].points.map(record => ({ id: record.id, text: record.text, evidenceIds: record.evidenceIds })), [
    { id: 'p1', text: 'A chiller failure during the IPA ferment risks the whole batch.', evidenceIds: ['T0001'] },
    { id: 'p2', text: 'The last IPA batch was muted on aroma.', evidenceIds: ['T0003'] }
  ], 'primary rows and their source evidence are unchanged by the supporting dedupe');

  // With no vectors and the worker unreachable the lexical fallback decides;
  // a grouper failure leaves the discussion untouched.
  const untouched = await dedupeSupportingDetailsSemantically([{ topic: 'X', points: [
    { id: 'q1', text: 'Alpha.', evidenceIds: ['T0001'], supportingDetails: [{ id: 'd1', text: 'Beta gamma delta.', evidenceIds: ['T0001'] }, { id: 'd2', text: 'Epsilon zeta eta.', evidenceIds: ['T0001'] }] }
  ], decisions: [], openQuestions: [] }], { vectors: null });
  assert.equal(untouched[0].points[0].supportingDetails.length, 2);
});

test('one additional detail repeating its primary is removed without needing a semantic match', async () => {
  const discussion = [{ topic: 'Design review', points: [
    { id: 'p1', text: 'The design owner is necessary to fully assess issues, including risk management files.', evidenceIds: ['T0400'], supportingDetails: [
      { id: 'd1', text: 'The design owner is required to assess the risk management files fully.', evidenceIds: ['T0400'] }
    ] }
  ], decisions: [], openQuestions: [] }];
  const result = await dedupeSupportingDetailsSemantically(discussion, { vectors: null });
  assert.deepEqual(result[0].points[0].supportingDetails, []);
});
