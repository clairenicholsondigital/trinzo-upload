'use strict';

const { captureSemanticPolicy, normaliseSemanticPolicy } = require('../../utils/meetingMinutesSemanticPolicy');
const { captureDiscussionCoveragePolicy, normaliseDiscussionCoveragePolicy } = require('../../utils/meetingMinutesDiscussionCoveragePolicy');

// Private evaluations bypass the job queue, which normally captures this
// snapshot. Capture once, or reuse the reference run's saved snapshot for a
// paired comparison. Never change legacy/resumed production policy semantics.
function createEvaluationSession({ env = process.env, referencePolicy, referenceDiscussionCoveragePolicy } = {}) {
  const semanticPolicy = referencePolicy === undefined
    ? captureSemanticPolicy(env) : normaliseSemanticPolicy(referencePolicy);
  const discussionCoveragePolicy = referenceDiscussionCoveragePolicy === undefined && referencePolicy === undefined
    ? captureDiscussionCoveragePolicy(env) : normaliseDiscussionCoveragePolicy(referenceDiscussionCoveragePolicy);
  return Object.freeze({
    semanticPolicy,
    discussionCoveragePolicy,
    generateStage(generate, draft, stage, options = {}) {
      if (options.semanticPolicy !== undefined || options.discussionCoveragePolicy !== undefined) throw new Error('Use the evaluation session policy for every stage.');
      return generate({ ...draft, _semanticPolicy: semanticPolicy, _discussionCoveragePolicy: discussionCoveragePolicy }, stage, { ...options, semanticPolicy });
    }
  });
}

module.exports = { createEvaluationSession };
