const assert = require('node:assert/strict');
const test = require('node:test');

const {
  isMalformedStagedLine,
  hasStagedDecisionEvidence,
  cardsAreDuplicates,
  dedupeStagedDiscussionCards,
  buildTightStagedObjectives,
  compactStagedDiscussionCards,
  buildStagedValidationFlags
} = require('../utils/stagedEditorial');

test('isMalformedStagedLine catches the "Potential The ..." transcription-noise pattern', () => {
  assert.equal(
    isMalformedStagedLine('Potential The discussion covered transportation availability if the final is won, requiring contingency planning.'),
    true
  );
});

test('buildTightStagedObjectives replaces boilerplate with topic-specific objectives', () => {
  const result = buildTightStagedObjectives({
    meetingTitle: 'Client Abbott T796 Audit Kick Off Sylmar',
    meetingType: 'Project review',
    topics: [
      'Hotel and Participant Arrangements',
      'Audit Timeline and Preparation Schedule',
      'Regulatory Standards and Compliance (21 CFRs, MDR, ISOs)',
      'Software Management System Deep Dive',
      'Site Access and Documentation Sharing'
    ]
  });

  assert.deepEqual(result.objectives, [
    'Confirm regulatory standards and compliance (21 CFRs, MDR, ISOs)',
    'Review software management system deep dive',
    'Agree hotel and participant arrangements and audit timeline and preparation schedule'
  ]);
  assert.equal(result.telemetry.objectiveSource, 'topic_objective_reducer');
});

test('buildTightStagedObjectives can preserve a workstream-style objective list when requested', () => {
  const result = buildTightStagedObjectives({
    meetingTitle: 'T761 Eakin Healthcare Tech File SW review',
    meetingType: 'Project review',
    maxObjectives: 7,
    topics: [
      'Alarm changes',
      'Language changes',
      'Software versioning changes',
      'Electrical safety testing',
      'Cybersecurity',
      'Document tracking',
      'Software workstream timeline delay'
    ]
  });

  assert.ok(result.objectives.length >= 5);
  assert.ok(result.objectives.some((objective) => objective.includes('alarm changes')));
  assert.ok(result.objectives.some((objective) => objective.includes('language changes')));
  assert.ok(result.objectives.some((objective) => objective.includes('software versioning changes')));
  assert.ok(result.objectives.some((objective) => objective.includes('electrical safety testing')));
  assert.ok(result.objectives.some((objective) => objective.includes('cybersecurity')));
});

test('compactStagedDiscussionCards keeps stronger topic bullets and removes repetition', () => {
  const result = compactStagedDiscussionCards([
    {
      topic: 'Audit Timeline and Preparation Schedule',
      points: [
        'The audit is confirmed as a routine surveillance audit, and the team has prior experience with the facility and its processes.',
        'The audit is a routine surveillance audit, and prior experience with the facility manufacturing processes is noted.',
        'The risk assessment must be completed to develop the audit plan, which is scheduled for Wednesday.',
        'The risk assessment will be shared before arrival, and a catch-up meeting is planned before the audit starts.',
        'The audit will involve full findings and rating, not an assessment.'
      ]
    },
    {
      topic: 'Software Management System Deep Dive',
      points: [
        'The deep dive will focus on software aspects, including unknown provenance, the Software Bill of Materials (SBOM), and managing new version rollouts.',
        'The team will prepare the SBOM for the first week, and the focus will be on software development, validation, and associated purchasing controls.',
        'The team will focus on software development, validation, and purchasing controls related to the device.',
        'The team will look at suppliers of SBOM information to assess component status.'
      ]
    }
  ], { pointLimit: 4 });

  assert.equal(result.cards.length, 2);
  assert.equal(result.cards[0].points.length, 4);
  assert.equal(result.cards[1].points.length, 3);
  assert.ok(result.telemetry.duplicatesRemoved >= 2);
  assert.ok(result.cards[0].points.some((point) => point.includes('risk assessment')));
  assert.ok(result.cards[1].points.some((point) => point.includes('SBOM')));
});

test('compactStagedDiscussionCards preserves distinct concrete details inside high-substance topics', () => {
  const result = compactStagedDiscussionCards([
    {
      topic: 'Software management system deep dive',
      points: [
        'The team will seek the SBOM to assess software provenance.',
        'The team will seek the SBOM to review suppliers and determine the nature of the software.',
        'The deep dive will focus on software development, validation, and associated purchasing controls.',
        'Access to the SBOM may be restricted until on-site, requiring secure transmission arrangements.',
        'New version rollouts resulting from complaints or field actions will be reviewed.',
        'The discussion covered software in general terms.'
      ]
    }
  ], { pointLimit: 4 });

  assert.equal(result.cards[0].points.length, 6);
  assert.ok(result.cards[0].points.some((point) => point.includes('provenance')));
  assert.ok(result.cards[0].points.some((point) => point.includes('suppliers')));
  assert.ok(result.cards[0].points.some((point) => point.includes('on-site')));
  assert.ok(result.cards[0].points.some((point) => point.includes('field actions')));
  assert.ok(result.telemetry.detailRetentionScore >= 80);
  assert.deepEqual(result.telemetry.detailRetentionWarnings, []);
});

test('compactStagedDiscussionCards gives low-substance logistics less room than technical workstreams', () => {
  const result = compactStagedDiscussionCards([
    {
      topic: 'Hotel and participant arrangements',
      points: [
        'Hotel reservation has been made under Stuart\'s name.',
        'Karen will also be staying at the hotel.',
        'Travel arrangements were discussed, including travelling together in one car.',
        'Niamh will arrange transport for herself.',
        'The team planned to connect after the hotel.'
      ]
    }
  ], { pointLimit: 4 });

  assert.equal(result.cards[0].points.length, 4);
  assert.equal(result.telemetry.truncatedRemoved, 1);
});

test('isMalformedStagedLine catches other dangling qualifiers and glued clauses', () => {
  assert.equal(isMalformedStagedLine('Possible This is a risk to the timeline'), true);
  assert.equal(isMalformedStagedLine('the plan was agreed They will review it next week'), true);
});

test('isMalformedStagedLine leaves clean minutes untouched', () => {
  assert.equal(isMalformedStagedLine('The audit will cover the applicable 21 CFR, MDSAP, MDR and ISO requirements.'), false);
  assert.equal(isMalformedStagedLine('The SBOM will be available upon arrival on site. The team confirmed the dates.'), false);
  assert.equal(isMalformedStagedLine('Stuart is finalising the risk assessment to inform the audit plan.'), false);
});

test('hasStagedDecisionEvidence distinguishes real decisions from bare labels', () => {
  assert.equal(hasStagedDecisionEvidence('It was agreed that Stuart leads the audit.'), true);
  assert.equal(hasStagedDecisionEvidence('The scope was confirmed for five days on site.'), true);
  assert.equal(hasStagedDecisionEvidence('The team talked about the hotel and the travel.'), false);
});

test('cardsAreDuplicates detects a phantom section that copies another workstream', () => {
  const auditTraining = {
    topic: 'Audit training and standards review',
    points: [
      'Audit training and preparation commence next Monday.',
      'The applicable standards will be confirmed once the audit scope is finalised.',
      'Stuart will build the scope over the next few days.'
    ]
  };
  const phantom = {
    topic: 'Analytics and review confidence',
    points: [
      'Audit training and preparation commence next Monday.',
      'The applicable standards will be confirmed once the audit scope is finalised.',
      'Stuart will build the scope over the next few days.'
    ]
  };
  assert.equal(cardsAreDuplicates(auditTraining, phantom), true);
});

test('cardsAreDuplicates keeps genuinely distinct sections', () => {
  const siteAccess = { topic: 'Site access', points: ['Five days on site.', 'Shared car travel.', 'Niamh arranging transport.'] };
  const software = { topic: 'Software management system', points: ['SBOM provided on arrival.', 'Provenance and validation reviewed.'] };
  assert.equal(cardsAreDuplicates(siteAccess, software), false);
});

test('dedupeStagedDiscussionCards drops the duplicate and reports the dropped heading', () => {
  const cards = [
    { topic: 'Audit training and standards review', points: ['Training starts next Monday.', 'Standards confirmed once scope is finalised.'] },
    { topic: 'Analytics and review confidence', points: ['Training starts next Monday.', 'Standards confirmed once scope is finalised.'] },
    { topic: 'Site access', points: ['Five days on site.', 'Niamh arranging transport.'] }
  ];
  const { cards: kept, dropped } = dedupeStagedDiscussionCards(cards);
  assert.equal(kept.length, 2);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].topic, 'Analytics and review confidence');
});

test('buildStagedValidationFlags surfaces duplicates, malformed text and omitted workstreams as advisory flags', () => {
  const flags = buildStagedValidationFlags({
    objectives: ['Confirm the risk assessment feeding the audit plan.'],
    actions: [{ owner: 'Stuart', action: 'Finalise the risk assessment to inform the audit plan.' }],
    discussion: [
      { topic: 'Site access', points: ['Five days on site.', 'Potential The discussion covered transportation availability if the final is won.'] }
    ],
    droppedDuplicates: [{ topic: 'Analytics and review confidence', duplicateOf: 'Audit training and standards review' }]
  });
  const types = flags.map((flag) => flag.type);
  assert.ok(types.includes('duplicate_section'));
  assert.ok(types.includes('malformed_text'));
  assert.ok(types.includes('possible_omitted_workstream'));
});

test('buildStagedValidationFlags stays quiet when the minutes are clean and complete', () => {
  const flags = buildStagedValidationFlags({
    objectives: ['Confirm the audit scope and logistics.'],
    actions: [{ owner: 'Jacqui', action: 'Send the Code of Conduct to Niamh.' }],
    discussion: [
      { topic: 'Audit scope and logistics', points: ['The audit scope and logistics were confirmed for the Sylmar site.'] },
      { topic: 'Code of Conduct', points: ['Jacqui will send the Code of Conduct to Niamh today.'] }
    ],
    droppedDuplicates: []
  });
  assert.deepEqual(flags, []);
});
