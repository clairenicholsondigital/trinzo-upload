'use strict';

function flattenHybridDiscussion(discussion = []) {
  return (Array.isArray(discussion) ? discussion : []).flatMap((topic) => [
    ...(topic?.points || []).map((record) => ({ recordType: 'discussion_point', topic: topic.topic, record })),
    ...(topic?.decisions || []).map((record) => ({ recordType: 'decision', topic: topic.topic, record })),
    ...(topic?.openQuestions || []).map((record) => ({ recordType: 'open_question', topic: topic.topic, record }))
  ]);
}

module.exports = { flattenHybridDiscussion };
