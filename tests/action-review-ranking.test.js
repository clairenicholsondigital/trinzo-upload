'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  enrichActionReviewCandidate,
  rankAndClusterActionReviewCandidates,
  reviewerUsefulness,
  strongestWorkstream
} = require('../utils/canonicalMinutes/actionReviewRanking');
const { buildConfirmedState } = require('../utils/canonicalMinutes/liveStages');

function options() {
  return {
    state: {
      meeting: { purpose: 'Confirm operational follow-ups and outstanding documentation needed before the next project stage.' },
      topics: [
        'Importer-obligation QMS procedure design',
        'Operational process detail',
        'Language/country requirements',
        'MedEnvoy/Cody alignment',
        'PPE declarations of conformity',
        'Further process discovery'
      ]
    },
    evidence: { events: [] }
  };
}

test('raw operational process descriptions are not prominent solely from workstream relevance', () => {
  const candidate = {
    owner: 'Not stated',
    action: "So if there's 10 units in the order, we pick a box big enough to hold 10 units, apply it to the box and the team will pick into that box using handheld devices",
    reviewDisposition: 'review_required',
    evidence: "So if there's 10 units in the order, we pick a box big enough to hold 10 units, apply it to the box and the team will pick into that box using handheld devices"
  };

  const enriched = enrichActionReviewCandidate(candidate, options());

  assert.notEqual(enriched.reviewerUsefulnessTier, 'high');
  assert.equal(enriched.actionClassification, 'incomplete_proposition');
  assert.match(enriched.suggestedAction, /10 units/i);
});

test('useful grounded requirements and follow-ups remain prominent', () => {
  const candidates = [
    {
      owner: 'Not stated',
      action: 'Provide country and language information',
      reviewDisposition: 'requirement',
      evidence: 'We need the list of countries supplied so language, IFU and label requirements can be assessed.'
    },
    {
      owner: 'Not stated',
      action: 'Confirm PPE declarations of conformity',
      reviewDisposition: 'requirement',
      evidence: 'The sunglasses declarations of conformity may need the PPE Category I risk rationale added.'
    },
    {
      owner: 'Not stated',
      action: 'Go back to Cody and ask for the project plan',
      reviewDisposition: 'review_required',
      confidenceTier: 'low',
      evidence: 'I did ask Cody for a copy of the project plan or task list from Med Envoy.'
    },
    {
      owner: 'Not stated',
      action: 'Arrange further working sessions',
      reviewDisposition: 'review_required',
      evidence: 'Further working sessions are needed to walk through the operational details before procedure drafting.'
    }
  ];

  const ranked = rankAndClusterActionReviewCandidates(candidates, options());
  const prominent = ranked.filter((candidate) => candidate.reviewerUsefulnessTier === 'high');
  const prominentText = prominent.map((candidate) => candidate.suggestedAction || candidate.action).join('\n');

  assert.match(prominentText, /country and language information/i);
  assert.match(prominentText, /PPE\/sunglasses declarations of conformity|Category I risk rationale/i);
  assert.match(prominentText, /Med Envoy project plan|task list/i);
  assert.match(prominentText, /process-discovery working sessions|operational details/i);
});

test('generic prospective speech acts remain visible for human action review', () => {
  const candidates = [
    {
      owner: 'Not stated',
      action: 'Define the criteria for the ICP fit',
      speechAct: 'required_unassigned_work',
      reviewDisposition: 'requirement',
      evidence: 'Something that needs to be defined as a team is how the criteria for the ICP fit are set.'
    },
    {
      owner: 'Not stated',
      action: 'Manually test a small slice',
      speechAct: 'collective_plan',
      explicitFutureCommitment: true,
      reviewDisposition: 'needs_assignment',
      evidence: "What we want to do is take a small slice and manually do it. Then we're going to test it."
    }
  ];
  const ranked = rankAndClusterActionReviewCandidates(candidates, options());
  assert.equal(ranked.length, 2);
  assert.ok(ranked.every((candidate) => candidate.reviewerUsefulnessTier !== 'low'));
});

test('previous follow-up wording does not hide still-needed artefact dependencies', () => {
  const enriched = enrichActionReviewCandidate({
    owner: 'Not stated',
    action: 'Follow up on the project plan or task list',
    reviewDisposition: 'review_required',
    evidence: 'I did follow up with Morgan last week for a copy of the project plan or task list, because that will help us understand the current activity and avoid duplication.'
  }, {
    state: {
      meeting: { purpose: 'Coordinate outstanding artefacts and dependencies before the next project stage.' },
      topics: ['Representative project-plan alignment', 'Open artefact dependencies']
    },
    evidence: { events: [] }
  });

  assert.equal(enriched.reviewerUsefulnessTier, 'high');
  assert.notEqual(enriched.actionClassification, 'completed_history');
});

test('generic meeting follow-ups are not rewritten into importer-obligation wording without importer evidence', () => {
  const enriched = enrichActionReviewCandidate({
    owner: 'Not stated',
    action: 'Arrange further working sessions',
    reviewDisposition: 'review_required',
    evidence: 'We can set up meetings following on from that and make sure the testing actions get tidied up nicely.'
  }, {
    state: {
      meeting: { purpose: 'Coordinate software technical-file testing follow-ups.' },
      topics: ['Testing and validation', 'Software change traceability']
    },
    evidence: { events: [] }
  });

  assert.doesNotMatch(enriched.suggestedAction, /importer-obligation|process-discovery/i);
});

test('non-DITA technical status follow-ups are not demoted by the actionability gate', () => {
  const score = reviewerUsefulness({
    owner: 'Not stated',
    action: 'Confirm USB port regression-test evidence before the release review',
    reviewDisposition: 'review_required',
    evidence: 'Can you confirm the USB port regression-test evidence before the release review?'
  }, {
    state: {
      meeting: { purpose: 'Review software release readiness and assign technical follow-ups.' },
      topics: ['USB port testing', 'Release readiness', 'Risk-management controls']
    },
    evidence: { events: [] }
  });

  assert.equal(score.reviewerUsefulnessTier, 'high');
  assert.equal(score.actionClassification, 'request');
});

test('non-prominent raw fragments remain available as lower-priority candidates', () => {
  const ranked = rankAndClusterActionReviewCandidates([
    {
      owner: 'Not stated',
      action: "So if there's 10 units in the order, we pick a box big enough to hold 10 units and use handheld devices",
      reviewDisposition: 'review_required',
      evidence: "So if there's 10 units in the order, we pick a box big enough to hold 10 units and use handheld devices"
    },
    {
      owner: 'Not stated',
      action: 'Confirm access to the QMS Manual',
      reviewDisposition: 'review_required',
      evidence: 'Can you confirm access to the QMS Manual so it can be used as the procedure reference?'
    }
  ], options());

  assert.ok(ranked.some((candidate) => /10 units/i.test(candidate.action || '') && candidate.reviewerUsefulnessTier !== 'high'));
  assert.ok(ranked.some((candidate) => /QMS Manual/i.test(candidate.suggestedAction || candidate.action || '') && candidate.reviewerUsefulnessTier === 'high'));
});

test('confirmed Discussion evidence overlap outranks lexical workstream similarity', () => {
  const candidate = {
    owner: 'Not stated',
    action: 'Flick this over',
    evidence: 'I will flick this over after the call.',
    evidenceIds: ['evt_medenvoy']
  };
  const match = strongestWorkstream(candidate, {
    state: {
      topics: [{ text: 'General follow-up', evidenceIds: [] }],
      discussion: [{
        topic: 'MedEnvoy alignment',
        topicId: 'medenvoy',
        evidenceIds: ['evt_medenvoy'],
        points: [{ text: 'The project plan or task list is the relevant artefact.', evidenceIds: ['evt_medenvoy'] }]
      }]
    },
    evidence: { events: [] }
  });

  assert.equal(match.matchType, 'evidence_overlap');
  assert.equal(match.evidenceOverlap, 1);
  assert.match(match.label, /project plan or task list/i);
});

test('confirmed Discussion handoff preserves supplied provenance without inventing it', () => {
  const state = buildConfirmedState('Amina  00:01\nI will send it.', 'review.txt', {
    discussion: [{
      topic: 'Reviewed artefact',
      topicId: 'topic_artefact',
      evidenceIds: ['evt_1'],
      points: ['Reviewer edit with provenance', 'Reviewer-added prose without provenance'],
      pointRefs: [{ evidenceIds: ['evt_1'] }, { evidenceIds: [] }]
    }]
  });

  assert.equal(state.discussion[0].topicId, 'topic_artefact');
  assert.deepEqual(state.discussion[0].evidenceIds, ['evt_1']);
  assert.deepEqual(state.discussion[0].points[0].evidenceIds, ['evt_1']);
  assert.deepEqual(state.discussion[0].points[1].evidenceIds, []);
});

test('unrelated reviewed Discussion cannot reinterpret a candidate through weak lexical similarity', () => {
  const candidate = {
    owner: 'David',
    action: 'Confirm the mute-button test evidence',
    evidence: 'David will confirm the mute-button test evidence.',
    evidenceIds: ['evt_mute']
  };
  const match = strongestWorkstream(candidate, {
    state: {
      discussion: [{
        topic: 'Clinical review',
        evidenceIds: ['evt_clinical'],
        points: [{ text: 'Clinical review of alarm behaviour remains separate.', evidenceIds: ['evt_clinical'] }]
      }]
    },
    evidence: { events: [] }
  });

  assert.notEqual(match.matchType, 'evidence_overlap');
  assert.equal(match.evidenceOverlap, 0);
});

test('Discussion context affects review relevance but never owner or deadline evidence', () => {
  const candidate = {
    owner: 'Not stated',
    deadline: 'Not stated',
    action: 'Provide the applicable product classifications',
    reviewDisposition: 'review_required',
    evidence: 'Can somebody provide the applicable product classifications?',
    evidenceIds: ['evt_classification']
  };
  const enriched = enrichActionReviewCandidate(candidate, {
    state: {
      discussion: [{
        topic: 'Product classifications',
        evidenceIds: ['evt_classification'],
        points: [{ text: 'Andrew will provide these by Friday.', evidenceIds: ['evt_classification'] }]
      }]
    },
    evidence: { events: [] }
  });

  assert.equal(enriched.workstreamRelevance.matchType, 'evidence_overlap');
  assert.equal(enriched.owner, 'Not stated');
  assert.equal(enriched.deadline, 'Not stated');
});

test('Discussion-only prose cannot create an action candidate', () => {
  const ranked = rankAndClusterActionReviewCandidates([], {
    state: {
      discussion: [{
        topic: 'Cybersecurity',
        evidenceIds: [],
        points: [{ text: 'The team should prepare a new cybersecurity report.', evidenceIds: [] }]
      }]
    },
    evidence: { events: [] }
  });

  assert.deepEqual(ranked, []);
});
