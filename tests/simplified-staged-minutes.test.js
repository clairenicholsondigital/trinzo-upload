'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const simplified = require('../utils/simplifiedStagedMinutes');
const api = require('../routes/api');

function prepared(topics) {
  return {
    ok: true,
    model: 'test-model',
    embeddingModel: 'all-MiniLM-L6-v2',
    counts: { retain: 8, uncertain: 3, remove: 2 },
    totalUnitCount: 13,
    keptUnitCount: 11,
    removedUnitCount: 2,
    removedRatio: 2 / 13,
    rawLength: 1000,
    preparedLength: 800,
    preparedTranscript: 'Andrew Kane: The debug command remains to be verified.',
    evidenceByTopic: topics.map((topic, index) => ({
      topic,
      evidence: [{ id: `line_${index + 1}_unit_0`, speaker: index === 0 ? 'Andrew Kane' : 'Rebecca Cuckoo', text: index === 0 ? 'I will verify the debug command on Wednesday.' : `Evidence for ${topic}.` }]
    }))
  };
}

function response(content, delay = 0) {
  return new Promise((resolve) => setTimeout(() => resolve({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 10 } })
  }), delay));
}

test('topic generation accepts four to eight workstream headings and rejects action buckets', async () => {
  const fetchImpl = async () => response({ topics: ['Debug verification', 'Language support', 'Electrical compliance', 'Risk management', 'Follow-up actions'] });
  const result = await simplified.generateTopics('transcript', { apiKey: 'test', fetchImpl, prepared: prepared([]) });
  assert.deepEqual(result.topics, ['Debug verification', 'Language support', 'Electrical compliance', 'Risk management']);
});

test('discussion runs once per topic and preserves confirmed topic order', async () => {
  const topics = ['Debug verification', 'Language support', 'Electrical compliance', 'Risk management'];
  let calls = 0;
  const fetchImpl = async (_url, options) => {
    calls += 1;
    const prompt = JSON.parse(options.body).messages[1].content;
    const topicIndex = topics.findIndex((topic) => prompt.includes(`confirmed topic: ${topic}`));
    return response({ discussionPoints: [{ text: `${topics[topicIndex]} was discussed factually. [line_${topicIndex + 1}_unit_0]`, evidenceIds: [`line_${topicIndex + 1}_unit_0`] }] }, (topics.length - topicIndex) * 2);
  };
  const result = await simplified.generateDiscussion('transcript', topics, { apiKey: 'test', fetchImpl, prepared: prepared(topics) });
  assert.equal(calls, topics.length);
  assert.deepEqual(result.discussion.map((item) => item.topic), topics);
  assert.deepEqual(result.discussion.map((item) => item.points.length), [1, 1, 1, 1]);
  assert.ok(result.discussion.every((item) => !item.points[0].includes('[line_')));
});

test('actions run once per topic, merge duplicates, and reject unsupported owner and deadline claims', async () => {
  const topics = ['Debug verification', 'Language support', 'Electrical compliance', 'Risk management'];
  let calls = 0;
  const testPrepared = prepared(topics);
  testPrepared.evidenceByTopic[1].evidence[0].text = 'We will load the translated language files after verification.';
  const fetchImpl = async (_url, options) => {
    calls += 1;
    const prompt = JSON.parse(options.body).messages[1].content;
    const topicIndex = topics.findIndex((topic) => prompt.includes(`confirmed topic: ${topic}`));
    if (topicIndex === 0) return response({ actions: [{ owner: 'Andrew Kane', action: 'Verify the debug command', deadline: 'Wednesday', evidenceIds: ['line_1_unit_0'] }] });
    if (topicIndex === 1) return response({ actions: [{ owner: 'Invented Person', action: 'Load the translated language files', deadline: 'Friday', evidenceIds: ['line_2_unit_0'] }] });
    return response({ actions: [] });
  };
  const result = await simplified.generateActions('transcript', topics, { apiKey: 'test', fetchImpl, prepared: testPrepared });
  assert.equal(calls, topics.length);
  assert.equal(result.actions.length, 2);
  assert.deepEqual(result.actions[0], {
    owner: 'Andrew Kane', action: 'Verify the debug command.', deadline: 'Wednesday'
  });
  assert.equal(result.actions[1].owner, 'Not stated');
  assert.equal(result.actions[1].deadline, 'Not stated');
});

test('denoiser safety validation fails open for parser failure and unsafe removal', () => {
  assert.throws(
    () => simplified._private.validatePreparedResult({ ok: false, reason: 'no_speaker_units' }),
    (error) => error.code === 'unsafe_denoising_result' && /no_speaker_units/.test(error.message)
  );
  assert.throws(
    () => simplified._private.validatePreparedResult({ ok: true, totalUnitCount: 10, keptUnitCount: 4, removedUnitCount: 6, preparedTranscript: 'x'.repeat(200) }),
    (error) => error.code === 'unsafe_denoising_result' && error.details.removedRatio === 0.6
  );
});

test('malformed per-topic response triggers the whole-stage canonical fallback', async () => {
  const legacy = { pipeline: 'canonical_staged_v2', screens: { discussion: [{ topic: 'Legacy', points: ['Safe fallback.'] }] } };
  const output = await api.stagedEvaluation.applySimplifiedStagedOverride(
    'discussion', legacy, { text: 'transcript' }, { summary: { overallTopics: ['Topic'] }, discussion: [] },
    {
      generateDiscussion: async () => simplified.generateDiscussion('transcript', ['Topic'], {
        apiKey: 'test',
        prepared: prepared(['Topic']),
        fetchImpl: async () => response({ unexpected: [] })
      })
    }
  );
  assert.equal(output.telemetry.fallback, true);
  assert.deepEqual(output.result, legacy);
});

test('stage override retains the canonical stage when simplified generation fails', async () => {
  const legacy = { pipeline: 'canonical_staged_v2', screens: { discussion: [{ topic: 'Legacy', points: ['Safe fallback.'] }] } };
  const output = await api.stagedEvaluation.applySimplifiedStagedOverride(
    'discussion', legacy, { text: 'transcript' }, { summary: { overallTopics: ['Topic'] }, discussion: [] },
    { generateDiscussion: async () => { throw new Error('malformed response'); } }
  );
  assert.equal(output.telemetry.fallback, true);
  assert.deepEqual(output.result, legacy);
});

test('T761-shaped output keeps debug and traceability separate and prevents cross-topic leakage', async () => {
  const topics = [
    'Alarm system changes and clinical review',
    'Debug and software verification',
    'Software change control, versioning and traceability',
    'Language implementation and character support',
    'Electrical compliance testing',
    'Cybersecurity, device access and risk assessment',
    'Standards and regulatory applicability',
    'Supporting technical records and Cognidocs'
  ];
  const t761 = prepared(topics);
  t761.evidenceByTopic[0].evidence[0].text = 'The mute-button LED behaviour remained uncertain pending verification.';
  t761.evidenceByTopic[1].evidence[0].text = 'David asked for the debug command result to be physically verified before writing the test script.';
  t761.evidenceByTopic[2].evidence[0].text = 'David was reviewing the 17 changes, while Rebecca would incorporate the findings into the technical-file summary.';
  t761.evidenceByTopic[7].evidence[0].text = 'Andrew was asked to assess whether the fan-logic records belonged in Cognidocs.';
  const fetchImpl = async (_url, options) => {
    const prompt = JSON.parse(options.body).messages[1].content;
    const topicIndex = topics.findIndex((topic) => prompt.includes(`confirmed topic: ${topic}`));
    return response({ discussionPoints: [{ text: t761.evidenceByTopic[topicIndex].evidence[0].text, evidenceIds: [`line_${topicIndex + 1}_unit_0`] }] });
  };
  const result = await simplified.generateDiscussion('transcript', topics, { apiKey: 'test', fetchImpl, prepared: t761 });
  const byTopic = Object.fromEntries(result.discussion.map((item) => [item.topic, item.points.join(' ')]));
  assert.match(byTopic[topics[0]], /remained uncertain/i);
  assert.doesNotMatch(byTopic[topics[0]], /language|electrical/i);
  assert.match(byTopic[topics[1]], /debug command.*physically verified/i);
  assert.match(byTopic[topics[2]], /David was reviewing.*Rebecca would incorporate/i);
  assert.doesNotMatch(byTopic[topics[2]], /fan-logic|Cognidocs/i);
  assert.match(byTopic[topics[7]], /fan-logic.*Cognidocs/i);
});
