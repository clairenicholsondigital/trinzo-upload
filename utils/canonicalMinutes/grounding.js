'use strict';

const { isReviewerAuthored } = require('./state');

// Evidence-provenance gate.
//
// One invariant, enforced across the whole staged pipeline: every emitted item
// (objective, topic, discussion point, decision, risk, action) must be grounded
// in the CURRENT transcript — it must carry at least one evidenceId that
// resolves to an event in this transcript's evidence set, and it must not cite
// any evidenceId from outside it. Ungrounded or foreign-referenced items are
// dropped and reported.
//
// This prevents stale or foreign evidence references from crossing transcript
// boundaries. It does not claim semantic entailment: wording quality and
// factual support remain the responsibility of the extractive/editorial stage.
// The gate is deliberately source-agnostic and runs before content is shown or
// persisted.

function currentEvidenceIdSet(evidence) {
  return new Set((evidence && Array.isArray(evidence.events) ? evidence.events : []).map((event) => event.id));
}

// Provenance-valid == cites no foreign id AND cites at least one current id.
//
// Those are two guarantees, and only the first is about leakage. Refusing an item that
// cites nothing is a completeness proxy: an LLM that invented a passage cites nothing to
// support it. A reviewer is not an LLM. They may state something the extractor never
// selected an event for, and the confirmed-fact repair inserts exactly such an item -
// which this then deleted, after the preservation check had already passed, so the flag
// written for that case never fired and the reviewer saw a generic "dropped 1 item".
//
// So the foreign-id test is never relaxed - a confirmed payload replayed against a
// re-uploaded transcript is precisely the leakage case - and only the cites-something
// test yields, and only for text the reviewer wrote.
function isGrounded(evidenceIds, idSet, options = {}) {
  const ids = Array.isArray(evidenceIds) ? evidenceIds : [];
  if (ids.some((id) => !idSet.has(id))) return false;
  if (ids.length) return true;
  return Boolean(options.reviewerAuthored);
}

function groundCollection(items, idSet, dropped, kind) {
  return (Array.isArray(items) ? items : []).filter((item) => {
    if (isGrounded(item && item.evidenceIds, idSet, { reviewerAuthored: isReviewerAuthored(item) })) return true;
    dropped.push({ kind, item });
    return false;
  });
}

function groundDiscussionCard(card, idSet, dropped) {
  const points = (Array.isArray(card && card.points) ? card.points : []).filter((point) => {
    // Point objects carry their own evidenceIds; a bare string inherits the
    // card's grounding (already verified by the caller).
    if (typeof point === 'string') return true;
    if (isGrounded(point && point.evidenceIds, idSet, { reviewerAuthored: isReviewerAuthored(point) })) return true;
    dropped.push({ kind: 'discussion_point', item: point });
    return false;
  });
  return { ...card, points };
}

// Filters a stage proposal in place-safe fashion, returning a grounded copy.
// Only keys present on the proposal are touched, so it is safe to pass any of
// the context / content / actions stage outputs.
function groundProposal(proposal, evidence) {
  if (!proposal || typeof proposal !== 'object') return proposal;
  const idSet = currentEvidenceIdSet(evidence);
  const dropped = [];
  const grounded = { ...proposal };
  if (Array.isArray(proposal.objectives)) grounded.objectives = groundCollection(proposal.objectives, idSet, dropped, 'objective');
  if (Array.isArray(proposal.topics)) grounded.topics = groundCollection(proposal.topics, idSet, dropped, 'topic');
  if (Array.isArray(proposal.decisions)) grounded.decisions = groundCollection(proposal.decisions, idSet, dropped, 'decision');
  if (Array.isArray(proposal.risks)) grounded.risks = groundCollection(proposal.risks, idSet, dropped, 'risk');
  if (Array.isArray(proposal.actions)) grounded.actions = groundCollection(proposal.actions, idSet, dropped, 'action');
  if (Array.isArray(proposal.discussion)) {
    grounded.discussion = proposal.discussion
      .map((card) => {
        if (!isGrounded(card && card.evidenceIds, idSet, { reviewerAuthored: isReviewerAuthored(card) })) {
          dropped.push({ kind: 'discussion_card', item: card });
          return null;
        }
        return groundDiscussionCard(card, idSet, dropped);
      })
      .filter((card) => card && card.points.length);
  }
  if (dropped.length) {
    grounded.warnings = [
      ...(Array.isArray(proposal.warnings) ? proposal.warnings : []),
      {
        type: 'ungrounded_content_dropped',
        severity: 'warning',
        blocking: false,
        droppedCount: dropped.length,
        message: `Dropped ${dropped.length} item(s) not grounded in this transcript's evidence.`
      }
    ];
    grounded._groundingDropped = dropped;
  }
  return grounded;
}

module.exports = { groundProposal, currentEvidenceIdSet, isGrounded };
