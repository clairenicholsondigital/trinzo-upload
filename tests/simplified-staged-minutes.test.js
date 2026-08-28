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
    units: topics.map((topic, index) => ({ id: `line_${index + 1}_unit_0`, speaker: index === 0 ? 'Andrew Kane' : 'Rebecca Cuckoo', text: index === 0 ? 'I will verify the debug command on Wednesday.' : `Evidence for ${topic}.` })),
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

test('topic generation accepts four to eight workstream headings and rejects action or generic buckets', async () => {
  const fetchImpl = async () => response({ topics: ['Debug verification', 'Language support', 'Electrical compliance', 'Risk management', 'Follow-up actions', 'General updates'] });
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

test('discussion-first inventory groups grounded points without requiring confirmed topics', async () => {
  const inventoryPrepared = prepared(['Unused']);
  inventoryPrepared.units = [
    { id: 'line_1_unit_0', speaker: 'Andrew Kane', text: 'The language symbols remain under review.' },
    { id: 'line_2_unit_0', speaker: 'Christina McLean', text: 'I will put the revised procedure in the review folder.' }
  ];
  const fetchImpl = async (_url, options) => {
    const prompt = JSON.parse(options.body).messages[1].content;
    assert.match(prompt, /CONFIRMED MEETING CONTEXT/);
    assert.match(prompt, /Technical file review/);
    assert.match(prompt, /Confirm software verification and traceability readiness/);
    assert.match(prompt, /not transcript evidence/i);
    assert.match(prompt, /omit an unexpected but substantive matter/i);
    if (prompt.includes('Organise the supplied factual')) return response({
      groups: [{ topic: 'Language support', pointIds: ['point_1'] }],
      unassignedPointIds: ['point_2']
    });
    return response({ discussionPoints: [
      { text: 'Language-symbol issues remained under review.', evidenceIds: ['line_1_unit_0'] },
      { text: 'Christina would place the revised procedure in the review folder.', evidenceIds: ['line_2_unit_0'] }
    ] });
  };
  const result = await simplified.generateDiscussionInventory('transcript', {
    apiKey: 'test', fetchImpl, prepared: inventoryPrepared,
    meetingContext: {
      meetingType: 'Technical file review',
      meetingPurpose: 'Confirm software verification and traceability readiness.'
    }
  });
  assert.deepEqual(result.discussion.map((card) => card.topic), ['Language support', 'Unassigned']);
  assert.equal(result.organizer.pointCount, 2);
  assert.equal(result.organizer.unassignedCount, 1);
  assert.deepEqual(result.discussion[1].pointRefs[0].evidenceIds, ['line_2_unit_0']);
  assert.deepEqual(result.telemetry.contextApplied, { meetingType: true, meetingPurpose: true });
});

test('blank meeting context leaves simplified prompts unchanged', async () => {
  const inventoryPrepared = prepared([]);
  inventoryPrepared.units = [{ id: 'line_1_unit_0', speaker: 'Alex Smith', text: 'Release evidence remained under review.' }];
  const prompts = [];
  const fetchImpl = async (_url, options) => {
    const prompt = JSON.parse(options.body).messages[1].content;
    prompts.push(prompt);
    if (prompt.includes('Organise the supplied factual')) return response({ groups: [{ topic: 'Release evidence', pointIds: ['point_1'] }], unassignedPointIds: [] });
    return response({ discussionPoints: [{ text: 'Release evidence remained under review.', evidenceIds: ['line_1_unit_0'] }] });
  };
  const result = await simplified.generateDiscussionInventory('transcript', {
    apiKey: 'test', fetchImpl, prepared: inventoryPrepared, meetingContext: { meetingType: ' ', meetingPurpose: '' }
  });
  assert.ok(prompts.every((prompt) => !prompt.includes('CONFIRMED MEETING CONTEXT')));
  assert.deepEqual(result.telemetry.contextApplied, { meetingType: false, meetingPurpose: false });
});

test('actions scan all denoised evidence even when reviewer-organised groups omit it', async () => {
  const actionPrepared = prepared([]);
  actionPrepared.units = [
    { id: 'line_8_unit_0', speaker: 'Andrew Kane', text: 'The language symbols remain under review.' },
    { id: 'line_9_unit_0', speaker: 'Christina McLean', text: 'I will put the revised GSOP in the folder.' }
  ];
  const fetchImpl = async (_url, options) => {
    const prompt = JSON.parse(options.body).messages[1].content;
    if (prompt.includes('conservative final editor')) {
      return response({ decisions: [{ id: 'action_1', keep: true, reason: 'explicit_commitment' }] });
    }
    assert.match(prompt, /line_8_unit_0/);
    assert.match(prompt, /line_9_unit_0/);
    return response({ actions: [{ owner: 'Christina McLean', action: 'Put the revised GSOP in the folder', deadline: 'Not stated', evidenceIds: ['line_9_unit_0'] }] });
  };
  const result = await simplified.generateActions('transcript', ['Contractor records'], {
    apiKey: 'test', fetchImpl, prepared: actionPrepared,
    discussionGroups: [{ topic: 'Contractor records', evidenceIds: ['line_9_unit_0'], pointRefs: [{ evidenceIds: ['line_9_unit_0'] }] }]
  });
  assert.deepEqual(result.actions, [{ owner: 'Christina McLean', action: 'Put the revised GSOP in the folder.', deadline: 'Not stated' }]);
});

test('actions use one whole-transcript call and reject unsupported owner and deadline claims', async () => {
  const topics = ['Debug verification', 'Language support', 'Electrical compliance', 'Risk management'];
  let calls = 0;
  const testPrepared = prepared(topics);
  testPrepared.units[1].text = 'We will load the translated language files after verification.';
  const fetchImpl = async (_url, options) => {
    calls += 1;
    const prompt = JSON.parse(options.body).messages[1].content;
    if (prompt.includes('conservative final editor')) {
      return response({ decisions: [
        { id: 'action_1', keep: true, reason: 'explicit_commitment' },
        { id: 'action_2', keep: true, reason: 'explicit_commitment' }
      ] });
    }
    assert.match(prompt, /REVIEWER TOPIC GROUPS/);
    assert.match(prompt, /CONFIRMED MEETING CONTEXT/);
    assert.match(prompt, /Project review/);
    assert.match(prompt, /Review release readiness/);
    assert.match(prompt, /infer an action from it/i);
    assert.ok(topics.every((topic) => prompt.includes(topic)));
    return response({ actions: [
      { owner: 'Andrew Kane', action: 'Verify the debug command', deadline: 'Wednesday', evidenceIds: ['line_1_unit_0'] },
      { owner: 'Invented Person', action: 'Load the translated language files', deadline: 'Friday', evidenceIds: ['line_2_0'] }
    ] });
  };
  const result = await simplified.generateActions('transcript', topics, {
    apiKey: 'test', fetchImpl, prepared: testPrepared,
    meetingContext: { meetingType: 'Project review', meetingPurpose: 'Review release readiness.' }
  });
  assert.equal(calls, 2);
  assert.equal(result.telemetry.mode, 'whole_transcript_action_sweep');
  assert.equal(result.actions.length, 2);
  assert.deepEqual(result.actions[0], {
    owner: 'Andrew Kane', action: 'Verify the debug command.', deadline: 'Wednesday'
  });
  assert.equal(result.actions[1].owner, 'Not stated');
  assert.equal(result.actions[1].deadline, 'Not stated');
  assert.deepEqual(result.telemetry.contextApplied, { meetingType: true, meetingPurpose: true });
});

test('shared staged workflow passes reviewer-confirmed type and purpose to discussion and actions', async () => {
  const seen = [];
  const transcript = { text: 'A sufficiently long transcript for the staged workflow test.', source: 'test', fileName: 'test.txt' };
  const confirmedDetails = { meetingType: 'Reviewer edited technical review' };
  const confirmedSummary = { meetingPurpose: 'Reviewer edited purpose.', overallTopics: [] };
  await api.stagedEvaluation.stagedWorkflowResponse('discussion', transcript, { confirmedDetails, confirmedSummary }, {
    generateDiscussionInventory: async (_text, options) => {
      seen.push({ stage: 'discussion', context: options.meetingContext });
      return { discussion: [{ topic: 'Release evidence', points: ['Evidence was reviewed.'] }], telemetry: { tokenUsage: [] } };
    }
  });
  await api.stagedEvaluation.stagedWorkflowResponse('actions', transcript, {
    confirmedDetails,
    confirmedSummary,
    confirmedDiscussion: [{ topic: 'Release evidence', points: ['Evidence was reviewed.'] }]
  }, {
    generateActions: async (_text, _topics, options) => {
      seen.push({ stage: 'actions', context: options.meetingContext });
      return { actions: [{ owner: 'Not stated', action: 'Verify the evidence.', deadline: 'Not stated' }], telemetry: { tokenUsage: [] } };
    }
  });
  assert.deepEqual(seen, [
    { stage: 'discussion', context: { meetingType: 'Reviewer edited technical review', meetingPurpose: 'Reviewer edited purpose.' } },
    { stage: 'actions', context: { meetingType: 'Reviewer edited technical review', meetingPurpose: 'Reviewer edited purpose.' } }
  ]);
});

test('a 422 action window is split and retried without falling back the whole stage', async () => {
  const actionPrepared = prepared([]);
  actionPrepared.units = Array.from({ length: 16 }, (_, index) => ({
    id: `line_${index + 1}_unit_0`,
    speaker: 'Alex Smith',
    text: `I will verify release item ${index + 1} tomorrow.`
  }));
  let calls = 0;
  const fetchImpl = async (_url, options) => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 422, json: async () => ({ error: 'json_generation_failed' }) };
    const prompt = JSON.parse(options.body).messages[1].content;
    if (prompt.includes('conservative final editor')) {
      return response({ decisions: [{ id: 'action_1', keep: true, reason: 'explicit_commitment' }] });
    }
    const evidenceId = prompt.match(/line_\d+_unit_0/)?.[0];
    return response({ actions: [{ owner: 'Alex Smith', action: `Verify the release item supported by ${evidenceId}`, deadline: 'tomorrow', evidenceIds: [evidenceId] }] });
  };
  const result = await simplified.generateActions('transcript', ['Release verification'], {
    apiKey: 'test', fetchImpl, prepared: actionPrepared
  });
  assert.equal(calls, 4);
  assert.equal(result.telemetry.evidenceWindowCount, 1);
  assert.equal(result.telemetry.perWindow.length, 2);
  assert.ok(result.telemetry.perWindow.every((window) => window.splitDepth === 1));
  assert.equal(result.actions.length, 1, 'overlapping split results are still deduplicated after recovery');
});

test('one conservative editor pass removes discussion-shaped candidates and keeps supported outstanding work', async () => {
  const actionPrepared = prepared([]);
  actionPrepared.units = [
    { id: 'line_1_unit_0', speaker: 'Alex Smith', text: 'We need to verify the release evidence before the file can be closed.' },
    { id: 'line_2_unit_0', speaker: 'Alex Smith', text: 'I completed the release notes last week.' }
  ];
  let calls = 0;
  const fetchImpl = async (_url, options) => {
    calls += 1;
    const prompt = JSON.parse(options.body).messages[1].content;
    if (prompt.includes('conservative final editor')) {
      assert.match(prompt, /Verify the release evidence/);
      assert.match(prompt, /Archive obsolete notes/);
      return response({ decisions: [
        { id: 'action_1', keep: true, reason: 'unresolved_prerequisite' },
        { id: 'action_2', keep: false, reason: 'completed_history' }
      ] });
    }
    return response({ actions: [
      { owner: 'Not stated', action: 'Verify the release evidence', deadline: 'Not stated', evidenceIds: ['line_1_unit_0'] },
      { owner: 'Not stated', action: 'Archive obsolete notes', deadline: 'Not stated', evidenceIds: ['line_1_unit_0', 'line_2_unit_0'] }
    ] });
  };
  const result = await simplified.generateActions('transcript', ['Release verification'], { apiKey: 'test', fetchImpl, prepared: actionPrepared });
  assert.equal(calls, 2);
  assert.deepEqual(result.actions, [{ owner: 'Not stated', action: 'Verify the release evidence.', deadline: 'Not stated' }]);
  assert.equal(result.telemetry.editor.attempted, true);
  assert.equal(result.telemetry.editor.used, true);
  assert.equal(result.telemetry.editor.reason, '');
  assert.equal(result.telemetry.editor.inputCount, 2);
  assert.equal(result.telemetry.editor.keptCount, 1);
  assert.equal(result.telemetry.editor.removedCount, 1);
  assert.deepEqual(result.telemetry.editor.tokenUsage, { total_tokens: 10 });
});

test('malformed action editor response fails open and reports the degradation', async () => {
  const actionPrepared = prepared([]);
  actionPrepared.units = [{ id: 'line_1_unit_0', speaker: 'Alex Smith', text: 'I will verify the release evidence.' }];
  const fetchImpl = async (_url, options) => {
    const prompt = JSON.parse(options.body).messages[1].content;
    if (prompt.includes('conservative final editor')) return response({ unexpected: [] });
    return response({ actions: [
      { owner: 'Alex Smith', action: 'Verify the release evidence', deadline: 'Not stated', evidenceIds: ['line_1_unit_0'] }
    ] });
  };
  const result = await simplified.generateActions('transcript', ['Release verification'], { apiKey: 'test', fetchImpl, prepared: actionPrepared });
  assert.equal(result.actions.length, 1);
  assert.equal(result.telemetry.editor.attempted, true);
  assert.equal(result.telemetry.editor.used, false);
  assert.match(result.telemetry.editor.reason, /no decisions array/i);
});

test('production publication pass uses the local MiniLM classifier and preserves the UI action shape', async () => {
  const actionPrepared = prepared([]);
  actionPrepared.units = [
    { id: 'line_1_unit_0', speaker: 'Alex Smith', text: 'We need to verify the release evidence before closure.' },
    { id: 'line_2_unit_0', speaker: 'Alex Smith', text: 'We will archive the old notes.' }
  ];
  const fetchImpl = async () => response({ actions: [
    { owner: 'Not stated', action: 'Verify the release evidence', deadline: 'Not stated', evidenceIds: ['line_1_unit_0'] },
    { owner: 'Not stated', action: 'Archive the old notes', deadline: 'Not stated', evidenceIds: ['line_2_unit_0'] }
  ] });
  const result = await simplified.generateActions('transcript', ['Release verification'], {
    apiKey: 'test', fetchImpl, prepared: actionPrepared, useActionSuitabilityFilter: true,
    actionSuitabilityRunner: async (candidates) => ({
      ok: true, modelSchemaVersion: 2, embeddingModel: 'all-MiniLM-L6-v2', threshold: 0.16,
      decisions: candidates.map((candidate, index) => ({ id: candidate.id, keep: index === 0, showProbability: index === 0 ? 0.81 : 0.08 }))
    })
  });
  assert.deepEqual(result.actions, [{ owner: 'Not stated', action: 'Verify the release evidence.', deadline: 'Not stated' }]);
  assert.equal(result.telemetry.editor.provider, 'minilm');
  assert.equal(result.telemetry.editor.removedCount, 1);
  assert.equal(result.telemetry.calls, 1, 'the local classifier does not add a Trooper call');
  assert.deepEqual(Object.keys(result.actions[0]), ['owner', 'action', 'deadline']);
});

test('action publication gate accepts ongoing work, unresolved prerequisites and accepted proposals', () => {
  assert.equal(simplified.actionCommitmentSupported([
    { speaker: 'Andrew Kane', text: 'I am currently working on the electrical compliance testing.' }
  ]), true);
  assert.equal(simplified.ownerIsSupported('Andrew Kane', [
    { speaker: 'Jacqui Fox', text: 'Andrew has been making the language code changes.' }
  ]), true);
  assert.equal(simplified.actionCommitmentSupported([
    { speaker: 'Rebecca Cuckoo', text: 'There are further updates that need to happen before the risk file is complete.' }
  ]), true);
  assert.equal(simplified.actionCommitmentSupported([
    { speaker: 'Christina McLean', text: 'Should I put the revised GSOP in the folder for Louise?' },
    { speaker: 'Jacqui Fox', text: 'Yes, absolutely.' }
  ]), true);
  assert.equal(simplified.ownerIsSupported('Christina McLean', [
    { speaker: 'Christina McLean', text: 'Should I put the revised GSOP in the folder for Louise?' },
    { speaker: 'Jacqui Fox', text: 'Yes, absolutely.' }
  ]), true);
  assert.equal(simplified.actionCommitmentSupported([
    { speaker: 'Andrew Kane', text: 'I completed the electrical testing last week.' }
  ]), false);
  assert.equal(simplified.actionCommitmentSupported([
    { speaker: 'Ciaran Ryan', text: 'We started yesterday and the team are trying to convert the documents.' }
  ]), true);
  assert.deepEqual(
    simplified._private.actionEvidenceChunks(Array.from({ length: 70 }, (_, index) => index)).map((chunk) => chunk.length),
    [32, 32, 22]
  );
  assert.equal(simplified.publishableActionText('Send an email'), '');
  assert.equal(simplified.duplicateAction(
    { owner: 'Not stated', action: 'Complete feedback and rewrite the documents', evidenceIds: ['line_1_unit_0'] },
    { owner: 'Kevin', action: 'Review and rewrite documents', evidenceIds: ['line_1_unit_0'] }
  ), true);
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
      generateDiscussionInventory: async () => simplified.generateDiscussionInventory('transcript', {
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
    { generateDiscussionInventory: async () => { throw new Error('malformed response'); } }
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
