'use strict';

const { createOriginalExecution } = require('./meetingMinutesOriginalExecution');
const { createOriginalDiscovery } = require('./meetingMinutesOriginalDiscovery');
const { createOriginalSummaryStage } = require('./meetingMinutesOriginalSummary');
const { createOriginalDiscussionStage } = require('./meetingMinutesOriginalDiscussion');
const { createOriginalActionsStage } = require('./meetingMinutesOriginalActions');

// Keep one execution context per run: all stages share the real provider,
// progress, cache and deadline state. Beta retains its separate generator.
function createOriginalMinutesStages(services) {
  const createExecution = createOriginalExecution(services);
  const discover = createOriginalDiscovery(services);
  const summary = createOriginalSummaryStage();
  const discussion = createOriginalDiscussionStage(services);
  const actions = createOriginalActionsStage(services);
  return async function generateOriginalMinutesStage(draft, stage, options = {}) {
    const context = createExecution(draft, stage, options);
    if (stage === 'summary') return summary(context);
    const discovered = await discover(context);
    if (stage === 'discussion') return discussion(discovered);
    return actions(discovered);
  };
}

module.exports = { createOriginalMinutesStages };
