'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  enrichActionReviewCandidate,
  rankAndClusterActionReviewCandidates,
  reviewerUsefulness
} = require('../utils/canonicalMinutes/actionReviewRanking');

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
