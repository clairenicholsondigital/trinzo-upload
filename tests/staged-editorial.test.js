const assert = require('node:assert/strict');
const test = require('node:test');

const {
  isMalformedStagedLine,
  hasStagedDecisionEvidence,
  cardsAreDuplicates,
  dedupeStagedDiscussionCards,
  buildTightStagedObjectives,
  compactStagedDiscussionCards,
  reshapeStagedDiscussionCardsForHumanMinutes,
  isRawTranscriptDiscussionPoint,
  finaliseDiscussionPointForMinutes,
  buildStagedValidationFlags,
  stagedFinalActionQualityIssue,
  normaliseFinalStagedActionCandidate,
  normaliseAndValidateActionOwner
} = require('../utils/stagedEditorial');

test('action owners must resolve to a transcript participant', () => {
  const participants = ['Rebecca Gill', 'Andrew Kane'];
  assert.deepEqual(normaliseAndValidateActionOwner("It's", participants), { owner: 'Not stated', status: 'rejected_fragment' });
  assert.deepEqual(normaliseAndValidateActionOwner('Rebecca Cuckoo', participants), { owner: 'Not stated', status: 'not_participant' });
  assert.deepEqual(normaliseAndValidateActionOwner('Andrew', participants), { owner: 'Andrew Kane', status: 'repaired_unambiguous' });
  assert.deepEqual(normaliseAndValidateActionOwner('Not stated', participants), { owner: 'Not stated', status: 'accepted' });
});

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
    'Agree audit timeline and preparation schedule and site access and documentation sharing'
  ]);
  assert.ok(result.objectives.every((objective) => !/hotel|participant arrangements/i.test(objective)));
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

test('dedupe keeps separate workstreams that share only review timing boilerplate', () => {
  const result = dedupeStagedDiscussionCards([
    {
      topic: 'Clinical review timing for Wednesday was discussed',
      points: ['Clinical review timing for Wednesday was discussed.']
    },
    {
      topic: 'Change request review and approval timing for Wednesday was discussed',
      points: ['Change request review and approval timing for Wednesday was discussed.']
    }
  ]);

  assert.equal(result.cards.length, 2);
  assert.deepEqual(result.dropped, []);
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

test('reshapeStagedDiscussionCardsForHumanMinutes preserves process-heavy detail in a minutes order', () => {
  const result = reshapeStagedDiscussionCardsForHumanMinutes([
    {
      topic: 'Process Overview',
      points: [
        'The discussion covered movement of goods from Japanese suppliers into Europe.',
        'Products are purchased by DITA Inc directly from Japanese suppliers.',
        'Goods are shipped to the Netherlands as the first point of entry into the EU.',
        'Goods are released and transported to Ireland.',
        'Products are stored in the warehouse on site in Park West.',
        'Customer orders are entered in NetSuite and reviewed by Customer Service.',
        'Operators pick items using handheld barcode scanners.',
        'DHL is used as the courier for direct customer-store shipments.'
      ]
    }
  ]);

  assert.equal(result.length, 1);
  assert.equal(result[0].points.length, 8);
  assert.ok(result[0].points[0].startsWith('Products are purchased'));
  assert.ok(result[0].points.some((point) => point.includes('NetSuite')));
  assert.ok(result[0].points.some((point) => point.includes('DHL')));
  assert.ok(!result[0].points.some((point) => /^The discussion covered/i.test(point)));
});

test('reshapeStagedDiscussionCardsForHumanMinutes normalises client-facing DITA terminology', () => {
  const result = reshapeStagedDiscussionCardsForHumanMinutes([
    {
      topic: 'UDI and Udimed Responsibilities',
      points: [
        'The discussion covered Udimed registration responsibilities for existing products.',
        'John-Paul noted the DoC\'s for sunglasses need to include MDR and PPE compliance.'
      ]
    }
  ]);

  assert.equal(result[0].topic, 'UDI and regulatory data');
  assert.ok(result[0].points.some((point) => point.includes('EUDAMED registration responsibilities')));
  assert.ok(result[0].points.some((point) => point.includes('DoCs for sunglasses')));
});

test('finaliseDiscussionPointForMinutes removes raw transcript fragments without inventing a replacement', () => {
  const raw = 'Well, it should confirm what the first change was, because the documentation that we have currently from going from version one to 102.';
  assert.equal(isRawTranscriptDiscussionPoint(raw), true);
  assert.equal(finaliseDiscussionPointForMinutes(raw, 'Language File Updates and Character Support'), '');
  assert.equal(finaliseDiscussionPointForMinutes('Priya Shah 12:41 We were going to look at that one next.', 'Delivery plan'), '');
  assert.equal(finaliseDiscussionPointForMinutes('I mean, you know, we were kind of waiting for that.', 'Delivery plan'), '');
});

test('finaliseDiscussionPointForMinutes rejects the leaked T761 reported-speech fragments', () => {
  const topic = 'Language File Updates and Character Support';
  assert.equal(finaliseDiscussionPointForMinutes(
    "David said that They, they ask for the devices to the device, and the team has changed the software versions and we don't really have, the current documentation.",
    topic
  ), '');
  assert.equal(finaliseDiscussionPointForMinutes(
    'David said that it gives it, but it gives it the degree of granularity that it needs for the MDR device file history.',
    topic
  ), '');
});

test('finaliseDiscussionPointForMinutes neutralises safe reported speech and drops incomplete DITA fragments', () => {
  const topic = 'Regulatory documentation and DoCs';
  assert.equal(finaliseDiscussionPointForMinutes('Jenny said that new products have to go into EUDAMED immediately.', topic), 'New products have to go into EUDAMED immediately.');
  assert.equal(finaliseDiscussionPointForMinutes('Jenny asked whether the warehouse was automated or fully manual.', topic), 'The discussion considered whether the warehouse was automated or fully manual.');
  assert.equal(finaliseDiscussionPointForMinutes('Jacqui said that as the team worked through the process, they probably identified some key questions that they.', topic), '');
  assert.equal(finaliseDiscussionPointForMinutes('Jacqui said that in the work that the team is doing.', topic), '');
  assert.equal(finaliseDiscussionPointForMinutes('Jenny said that , Jenny know what, as an importer, there should be a link between the two.', topic), '');
});

test('reshapeStagedDiscussionCardsForHumanMinutes flags removed raw and malformed discussion points', () => {
  const result = reshapeStagedDiscussionCardsForHumanMinutes([
    {
      topic: 'Language File Updates and Character Support',
      points: [
        'The language-file work focused on confirming character and symbol support for Arabic, Vietnamese and Greek.',
        'Well, it should confirm what the first change was, because the documentation that we have currently from going from version one to 102.',
        'the review was complete They would share it after the meeting',
        'Confirm the LED flash behaviour upon mute activation.'
      ]
    }
  ]);

  assert.equal(result.length, 1);
  assert.deepEqual(result[0].points, [
    'The language-file work focused on confirming character and symbol support for Arabic, Vietnamese and Greek.'
  ]);
  assert.ok(result[0].qualityFlags.includes('raw_transcript_discussion_points_removed'));
  assert.ok(result[0].qualityFlags.includes('malformed_discussion_points_removed'));
  assert.ok(result[0].qualityFlags.includes('action_only_discussion_points_removed'));
});

test('client-clean discussion filtering is topic-agnostic and preserves formal minutes', () => {
  const cases = [
    ['Finance review', 'Okay, so we were sort of going to check that one.', ''],
    ['Warehouse operations', '[12:04] Morgan Lee: I think you had some questions about that.', ''],
    ['Clinical review', 'The the assessment remains open.', ''],
    ['Finance review', 'The budget review remains open pending the supplier estimate.', 'The budget review remains open pending the supplier estimate.'],
    ['Warehouse operations', 'Morgan Lee confirmed that barcode scanning is used during picking.', 'Morgan Lee confirmed that barcode scanning is used during picking.']
  ];
  for (const [topic, input, expected] of cases) {
    assert.equal(finaliseDiscussionPointForMinutes(input, topic), expected, input);
  }
});

test('isMalformedStagedLine catches other dangling qualifiers and glued clauses', () => {
  assert.equal(isMalformedStagedLine('Possible This is a risk to the timeline'), true);
  assert.equal(isMalformedStagedLine('the plan was agreed They will review it next week'), true);
});

test('isMalformedStagedLine rejects browser-observed QMS transcript fragments', () => {
  assert.equal(isMalformedStagedLine('From directly from the supplier in Japan, and there is a buy-sell.'), true);
  assert.equal(isMalformedStagedLine("It's minimal impact to the organization when these are rolled out."), true);
  assert.equal(isMalformedStagedLine('The QMS procedures reflect the applicable regulatory requirements.'), false);
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
    droppedDuplicates: [{ topic: 'Analytics and review confidence', duplicateOf: 'Audit training and standards review' }],
    droppedMisattributed: [{ topic: 'Cybersecurity Review of USB Port', droppedPointCount: 5 }]
  });
  const types = flags.map((flag) => flag.type);
  assert.ok(types.includes('duplicate_section'));
  assert.ok(types.includes('misattributed_discussion_evidence'));
  assert.ok(types.includes('malformed_text'));
  assert.ok(types.includes('possible_omitted_workstream'));
  const omitted = flags.find((flag) => flag.type === 'possible_omitted_workstream');
  assert.deepEqual(omitted.discussionSuggestion, {
    topic: 'the risk assessment feeding the audit plan',
    point: 'Confirm the risk assessment feeding the audit plan.',
    source: 'objective'
  });
});

test('buildStagedValidationFlags surfaces discussion finaliser cleanup', () => {
  const flags = buildStagedValidationFlags({
    discussion: [
      {
        topic: 'Language File Updates and Character Support',
        points: ['The language-file work focused on character support.'],
        qualityFlags: ['raw_transcript_discussion_points_removed', 'malformed_discussion_points_removed']
      }
    ]
  });
  const types = flags.map((flag) => flag.type);
  assert.ok(types.includes('raw_transcript_discussion_points_removed'));
  assert.ok(types.includes('malformed_discussion_points_removed'));
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

test('normaliseFinalStagedActionCandidate keeps the DITA action set client-ready', () => {
  const actions = [
    { owner: 'Orla Skally', action: 'Review the QMS Manual', deadline: 'Not stated' },
    { owner: 'Orla Skally', action: 'Follow up with Cody for the MedEnvoy project plan or task list', deadline: 'Not stated' },
    { owner: 'Orla Skally', action: 'Share a copy of the new label with Jenny for review', deadline: 'Not stated' },
    { owner: 'Orla Skally', action: 'Share the country and language list for the Declarations of Conformity', deadline: 'Not stated' },
    { owner: 'John-Paul Hughes', action: 'Review the DoCs for sunglasses for MDR and PPE compliance', deadline: 'Not stated' },
    { owner: 'Jacqui Fox', action: 'Review the HPRA invoice fee', deadline: 'Not stated' }
  ];

  assert.deepEqual(actions.map(normaliseFinalStagedActionCandidate), actions);
});

test('normaliseFinalStagedActionCandidate rewrites transcript-shaped opportunity wording', () => {
  const action = normaliseFinalStagedActionCandidate({
    owner: 'Not stated',
    action: 'Then give David the opportunity to review the outputs of that testing and update any final documents',
    deadline: 'Not stated',
    evidence: 'Electrical compliance testing is expected to complete by the end of July.'
  });

  assert.deepEqual(action, {
    owner: 'David',
    action: 'Review electrical compliance testing outputs and update the final compliance documentation',
    deadline: 'Not stated'
  });
});

test('normaliseFinalStagedActionCandidate accepts concrete continuation actions', () => {
  assert.deepEqual(
    normaliseFinalStagedActionCandidate({ owner: 'Andrew Kane', action: 'Continue the update to the 12 additional languages', deadline: 'Not stated' }),
    { owner: 'Andrew Kane', action: 'Continue the update to the 12 additional languages', deadline: 'Not stated' }
  );
  assert.deepEqual(
    normaliseFinalStagedActionCandidate({ owner: 'Rebecca Cuckoo', action: 'Continue reviewing the USB port controls', deadline: 'Not stated' }),
    { owner: 'Rebecca Cuckoo', action: 'Continue reviewing the USB port controls', deadline: 'Not stated' }
  );
});

test('normaliseFinalStagedActionCandidate canonicalises Not stated owner casing', () => {
  assert.deepEqual(
    normaliseFinalStagedActionCandidate({ owner: 'not stated', action: 'Review the QMS Manual', deadline: 'not stated' }),
    { owner: 'Not stated', action: 'Review the QMS Manual', deadline: 'Not stated' }
  );
});

test('stagedFinalActionQualityIssue rejects vague fragments while permitting an unstated owner', () => {
  assert.equal(
    stagedFinalActionQualityIssue({ owner: 'Jacqui Fox', action: 'Then review the outputs of that testing and update any final documents' }),
    'transcript_debris'
  );
  assert.equal(
    stagedFinalActionQualityIssue({ owner: 'Not stated', action: 'Review electrical compliance testing outputs' }),
    null
  );
  assert.equal(
    stagedFinalActionQualityIssue({ owner: 'All', action: 'Discuss this next time' }),
    'missing_actionable_verb'
  );
  assert.equal(
    stagedFinalActionQualityIssue({ owner: 'All', action: 'Update it' }),
    'missing_concrete_object'
  );
});
