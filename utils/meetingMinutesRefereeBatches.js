'use strict';

const { batchRefereeCandidates } = require('./refereeNormaliser');

function meetingAgentRefereeBatches(candidates = [], batchSize = 5) {
  return batchRefereeCandidates(candidates, Math.max(1, Math.min(8, Number(batchSize) || 5)));
}

function meetingAgentRefereeBatchPlan(stage, candidates = [], batchSize = 6, globalDiscussion = false) {
  const rows = Array.isArray(candidates) ? candidates : [];
  if (stage === 'discussion' && globalDiscussion && rows.length) {
    return { mode: 'global', batches: [rows] };
  }
  return { mode: 'batched', batches: meetingAgentRefereeBatches(rows, batchSize) };
}

async function meetingAgentRunOrderedConcurrent(items = [], worker, concurrencyLimit = items.length || 1) {
  const rows = Array.isArray(items) ? [...items] : [];
  const limit = Math.max(1, Math.min(rows.length || 1, Number(concurrencyLimit) || 1));
  const values = new Array(rows.length);
  const errors = new Array(rows.length);
  let nextIndex = 0;
  let active = 0;
  let maximumConcurrent = 0;
  const runNext = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= rows.length) return;
      active += 1;
      maximumConcurrent = Math.max(maximumConcurrent, active);
      try {
        values[index] = await worker(rows[index], index);
      } catch (error) {
        errors[index] = error;
      } finally {
        active -= 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, rows.length) }, () => runNext()));
  const firstErrorIndex = errors.findIndex(Boolean);
  if (firstErrorIndex >= 0) {
    const error = errors[firstErrorIndex];
    error.orderedConcurrentTaskIndex = firstErrorIndex;
    error.maximumConcurrent = maximumConcurrent;
    throw error;
  }
  return { values, maximumConcurrent, concurrencyLimit: limit };
}

function shouldStopMeetingAgentRefereeBatches(primaryError, repairError) {
  if (!primaryError?.code || primaryError.code !== repairError?.code) return false;
  return new Set([
    'invalid_referee_output',
    'power_automate_empty_response',
    'power_automate_timeout',
    'power_automate_unreachable'
  ]).has(primaryError.code);
}

module.exports = {
  meetingAgentRefereeBatches,
  meetingAgentRefereeBatchPlan,
  meetingAgentRunOrderedConcurrent,
  shouldStopMeetingAgentRefereeBatches,
};
