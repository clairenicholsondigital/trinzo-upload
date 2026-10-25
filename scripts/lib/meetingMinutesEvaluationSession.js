'use strict';

const { captureSemanticPolicy, normaliseSemanticPolicy } = require('../../utils/meetingMinutesSemanticPolicy');

// Private evaluations bypass the job queue, which normally captures this
// snapshot. Capture once, or reuse the reference run's saved snapshot for a
// paired comparison. Never change legacy/resumed production policy semantics.
function createEvaluationSession({ env = process.env, referencePolicy } = {}) {
  const semanticPolicy = referencePolicy === undefined
    ? captureSemanticPolicy(env) : normaliseSemanticPolicy(referencePolicy);
  return Object.freeze({
    semanticPolicy,
    generateStage(generate, draft, stage, options = {}) {
      if (options.semanticPolicy !== undefined) throw new Error('Use the evaluation session policy for every stage.');
      return generate({ ...draft, _semanticPolicy: semanticPolicy }, stage, { ...options, semanticPolicy });
    }
  });
}

module.exports = { createEvaluationSession };
