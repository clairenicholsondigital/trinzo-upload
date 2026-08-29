'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const simplified = require('../utils/simplifiedStagedMinutes');
const api = require('../routes/api');
const { buildActionRecallWindows, mergeSelectedActionWindows } = require('../utils/actionRecallRescue');

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
    if (prompt.includes('Organise the supplied factual')) {
      assert.match(prompt, /CONFIRMED MEETING CONTEXT/);
      assert.match(prompt, /Technical file review/);
      assert.match(prompt, /Confirm software verification and traceability readiness/);
      assert.match(prompt, /not transcript evidence/i);
      assert.match(prompt, /omit an unexpected but substantive matter/i);
      return response({
        groups: [{ topic: 'Language support', pointIds: ['point_1'] }],
        unassignedPointIds: ['point_2']
      });
    }
    assert.doesNotMatch(prompt, /CONFIRMED MEETING CONTEXT/);
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
  assert.deepEqual(result.telemetry.contextApplied, { meetingType: true, meetingPurpose: true, scope: 'grouping_only' });
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
  assert.deepEqual(result.telemetry.contextApplied, { meetingType: false, meetingPurpose: false, scope: 'grouping_only' });
});

test('discussion narrative returns contextual paragraphs without sentence-level topic assignment', async () => {
  const narrativePrepared = prepared([]);
  narrativePrepared.units = [
    { id: 'line_1_unit_0', speaker: 'Jacqui Fox', text: 'I will add myself to the clinical review call about the alarm configuration.' },
    { id: 'line_2_unit_0', speaker: 'Andrew Kane', text: 'The mute-button LED behaviour still needs to be verified.' }
  ];
  const fetchImpl = async (_url, options) => {
    const prompt = JSON.parse(options.body).messages[1].content;
    assert.match(prompt, /coherent, highly factual Discussion paragraphs/i);
    assert.match(prompt, /Do not turn the transcript into isolated sentence-level facts/i);
    assert.match(prompt, /she would add herself to that/i);
    assert.match(prompt, /COMPLETE DENOISED TRANSCRIPT EVIDENCE/);
    return response({ paragraphs: [{
      text: 'The team discussed the alarm configuration and the unresolved mute-button LED behaviour. Jacqui Fox said she would join the clinical review call, while the actual LED behaviour still required verification.',
      evidenceIds: ['line_1_unit_0', 'line_2_unit_0']
    }] });
  };
  const result = await simplified.generateDiscussionNarrative('transcript', {
    apiKey: 'test', fetchImpl, prepared: narrativePrepared,
    meetingContext: { meetingType: 'Technical file review', meetingPurpose: 'Review alarm changes.' }
  });
  assert.equal(result.telemetry.mode, 'contextual_discussion_narrative');
  assert.equal(result.discussion.length, 1);
  assert.equal(result.discussion[0].topic, 'Discussion');
  assert.equal(result.discussion[0].narrative, true);
  assert.equal(result.discussion[0].points.length, 1);
  assert.deepEqual(result.discussion[0].pointRefs[0].evidenceIds, ['line_1_unit_0', 'line_2_unit_0']);
  assert.deepEqual(
    simplified._private.narrativeEvidenceChunks(Array.from({ length: 131 }, (_, index) => ({ speaker: 'Alex', text: `Evidence ${index}` }))).map((chunk) => chunk.length),
    [130, 1]
  );
  assert.doesNotMatch(simplified.cleanPublicDiscussionPoint('A supported paragraph. [line_293_unit_1, line_293_2]'), /line_293/i);
  assert.doesNotMatch(simplified.cleanPublicDiscussionPoint('A supported paragraph (line_293_unit_1, line_293_unit_2).'), /line_293/i);
});

test('discussion narrative scales its paragraph budget for medium and long meetings', () => {
  const medium = simplified._private.narrativeParagraphPlan(Array.from({ length: 30 }, (_, index) => ({
    id: `line_${index + 1}_unit_0`, speaker: 'Alex Smith', text: 'A substantive workstream update remained under detailed review. '.repeat(4)
  })));
  assert.equal(medium.chunks.length, 2);
  assert.deepEqual(medium.chunks.map((chunk) => chunk.length), [15, 15]);
  assert.deepEqual([medium.paragraphMin, medium.paragraphMax], [4, 6]);

  const long = simplified._private.narrativeParagraphPlan(Array.from({ length: 120 }, (_, index) => ({
    id: `line_${index + 1}_unit_0`, speaker: 'Alex Smith', text: 'A substantive workstream update remained under detailed review. '.repeat(4)
  })));
  assert.equal(long.chunks.length, 4);
  assert.deepEqual([long.paragraphMin, long.paragraphMax], [8, 12]);
  assert.equal(long.chunks.flat().length, 120);
  assert.deepEqual(long.chunks.flat().map((unit) => unit.id), Array.from({ length: 120 }, (_, index) => `line_${index + 1}_unit_0`));
});

test('optional discussion organisation classifies reviewed paragraphs without rewriting them', async () => {
  const paragraphs = [
    { id: 'paragraph_1', text: 'The exact reviewed alarm paragraph remains unchanged.', evidenceIds: ['line_1_unit_0'] },
    { id: 'paragraph_2', text: 'The exact reviewed software paragraph remains unchanged.', evidenceIds: ['line_2_unit_0'] }
  ];
  const fetchImpl = async (_url, options) => {
    const prompt = JSON.parse(options.body).messages[1].content;
    assert.match(prompt, /classification only/i);
    assert.match(prompt, /Do not rewrite, split, merge, shorten or omit/i);
    return response({ groups: [
      { topic: 'Alarm configuration', paragraphIds: ['paragraph_1'] },
      { topic: 'Software verification', paragraphIds: ['paragraph_2'] }
    ] });
  };
  const result = await simplified.organizeDiscussionParagraphs(paragraphs, { apiKey: 'test', fetchImpl });
  assert.deepEqual(result.discussion.map((card) => card.topic), ['Alarm configuration', 'Software verification']);
  assert.deepEqual(result.discussion.flatMap((card) => card.points), paragraphs.map((paragraph) => paragraph.text));
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

test('evidence-first actions select and merge MiniLM windows before one Trooper synthesis pass', async () => {
  const actionPrepared = prepared([]);
  actionPrepared.units = [
    { id: 'line_1_unit_0', speaker: 'Alex Smith', text: 'I will verify the release evidence tomorrow.' },
    { id: 'line_2_unit_0', speaker: 'Alex Smith', text: 'The release evidence concerns the new package.' },
    { id: 'line_3_unit_0', speaker: 'Jo Brown', text: 'The package was discussed.' },
    { id: 'line_4_unit_0', speaker: 'Jo Brown', text: 'There was no other update.' },
    { id: 'line_5_unit_0', speaker: 'Jo Brown', text: 'The current status was noted.' },
    { id: 'line_6_unit_0', speaker: 'Jo Brown', text: 'The meeting continued.' },
    { id: 'line_7_unit_0', speaker: 'Jo Brown', text: 'The session ended.' }
  ];
  let trooperCalls = 0;
  const fetchImpl = async (_url, options) => {
    trooperCalls += 1;
    const prompt = JSON.parse(options.body).messages[1].content;
    assert.match(prompt, /local classifier selected this evidence/i);
    assert.match(prompt, /apparently garbled or nonsensical phrase/i);
    assert.match(prompt, /cited evidence must itself name the action object/i);
    assert.match(prompt, /silently inspect every supplied evidence row/i);
    assert.match(prompt, /line_1_unit_0/);
    assert.doesNotMatch(prompt, /line_7_unit_0/);
    return response({ actions: [{ owner: 'Alex Smith', action: 'Verify the release evidence', deadline: 'tomorrow (implied)', evidenceIds: ['line_1_unit_0'] }] });
  };
  const result = await simplified.generateActionsEvidenceFirst('transcript', {
    apiKey: 'test', fetchImpl, prepared: actionPrepared,
    actionRecallRunner: async (windows) => ({
      ok: true, threshold: 0.46,
      decisions: windows.map((window, index) => ({ id: window.id, rescue: index === 0, actionProbability: index === 0 ? 0.9 : 0.1 }))
    })
  });
  assert.equal(trooperCalls, 1);
  assert.deepEqual(result.actions, [{ owner: 'Alex Smith', action: 'Verify the release evidence.', deadline: 'tomorrow' }]);
  assert.equal(result.telemetry.mode, 'minilm_evidence_then_trooper');
  assert.equal(result.telemetry.selector.selectedWindowCount, 1);
});

test('evidence-first actions publish nothing and skip Trooper when MiniLM selects no windows', async () => {
  const actionPrepared = prepared([]);
  actionPrepared.units = Array.from({ length: 7 }, (_, index) => ({ id: `line_${index + 1}_unit_0`, speaker: 'Alex Smith', text: `Background point ${index + 1}.` }));
  const result = await simplified.generateActionsEvidenceFirst('transcript', {
    apiKey: 'test', prepared: actionPrepared,
    fetchImpl: async () => { throw new Error('Trooper must not run.'); },
    actionRecallRunner: async (windows) => ({ ok: true, decisions: windows.map((window) => ({ id: window.id, rescue: false, actionProbability: 0.1 })) })
  });
  assert.deepEqual(result.actions, []);
  assert.equal(result.telemetry.calls, 0);
});

test('evidence-first actions batch long selected evidence within the same synthesis stage', async () => {
  const actionPrepared = prepared([]);
  actionPrepared.units = Array.from({ length: 90 }, (_, index) => ({
    id: `line_${index + 1}_unit_0`, speaker: 'Alex Smith', text: `I will verify release evidence item ${index + 1}.`
  }));
  let calls = 0;
  const result = await simplified.generateActionsEvidenceFirst('transcript', {
    apiKey: 'test', prepared: actionPrepared, primaryActionEvidenceBatchSize: 80,
    actionRecallRunner: async (windows) => ({ ok: true, decisions: windows.map((window) => ({ id: window.id, rescue: true })) }),
    fetchImpl: async (_url, options) => {
      calls += 1;
      const prompt = JSON.parse(options.body).messages[1].content;
      const ids = [...prompt.matchAll(/line_\d+_unit_0/g)].map((match) => match[0]);
      const id = ids.at(-1);
      return response({ actions: [{ owner: 'Alex Smith', action: `Verify release evidence batch ${calls}`, deadline: 'Not stated', evidenceIds: [id] }] });
    }
  });
  assert.equal(calls, 2);
  assert.equal(result.telemetry.evidenceBatchCount, 2);
  assert.equal(result.telemetry.acceptedCandidateCount, 2);
  assert.equal(result.actions.length, 1);
});

test('selected action windows merge overlapping evidence without duplicating rows', () => {
  const windows = buildActionRecallWindows(Array.from({ length: 9 }, (_, index) => ({ id: `line_${index + 1}`, speaker: 'Alex', text: `Point ${index + 1}` })));
  const decisions = windows.map((window, index) => ({ id: window.id, rescue: index < 2 }));
  const packs = mergeSelectedActionWindows(windows, decisions);
  assert.equal(packs.length, 1);
  assert.deepEqual(packs[0].evidence.map((row) => row.id), ['line_1', 'line_2', 'line_3', 'line_4', 'line_5', 'line_6', 'line_7']);
});

test('evidence-first grounding rejects process descriptions and keeps supported plans', () => {
  assert.equal(simplified._private.evidenceFirstCommitmentSupported([
    { speaker: 'Alex Smith', text: 'It needs to look at the output and clean up the noise.' }
  ]), false);
  assert.equal(simplified._private.evidenceFirstCommitmentSupported([
    { speaker: 'Alex Smith', text: 'Check that the information is correct.' }
  ]), false);
  assert.equal(simplified._private.evidenceFirstCommitmentSupported([
    { speaker: 'Alex Smith', text: 'The remaining evidence still needs to be verified.' }
  ]), true);
  assert.equal(simplified._private.evidenceFirstCommitmentSupported([
    { speaker: 'Alex Smith', text: 'What we want to do is test a small manual sample.' },
    { speaker: 'Alex Smith', text: "We're going to test it." }
  ]), true);
  assert.equal(simplified._private.evidenceFirstCommitmentSupported([
    { speaker: 'Alex Smith', text: "So shall we all just have a think about it and maybe come back next month with our best idea, and we'll take it from there." }
  ]), false);
  assert.equal(simplified._private.evidenceFirstCommitmentSupported([
    { speaker: 'Alex Smith', text: 'The criteria would need to be defined before the process can operate.' }
  ]), true);
  assert.equal(simplified._private.evidenceFirstCommitmentSupported([
    { speaker: 'Alex Smith', text: 'We do a four-week pilot to test volume and quality.' }
  ]), true);
  assert.equal(simplified._private.evidenceFirstCommitmentSupported([
    { speaker: 'Jacqui Fox', text: 'David is working through the code changes and traceability evidence.' }
  ]), true);
});

test('shared staged workflow passes reviewer-confirmed type and purpose to discussion and actions', async () => {
  const seen = [];
  const transcript = { text: 'A sufficiently long transcript for the staged workflow test.', source: 'test', fileName: 'test.txt' };
  const confirmedDetails = { meetingType: 'Reviewer edited technical review' };
  const confirmedSummary = { meetingPurpose: 'Reviewer edited purpose.', overallTopics: [] };
  await api.stagedEvaluation.stagedWorkflowResponse('discussion', transcript, { confirmedDetails, confirmedSummary }, {
    generateDiscussionNarrative: async (_text, options) => {
      seen.push({ stage: 'discussion', context: options.meetingContext });
      return { discussion: [{ topic: 'Discussion', points: ['Evidence was reviewed in context.'], narrative: true }], telemetry: { tokenUsage: [] } };
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

test('production defaults to conservative publication without running recall rescue', async () => {
  const actionPrepared = prepared([]);
  actionPrepared.units = [{ id: 'line_1_unit_0', speaker: 'Alex Smith', text: 'I will verify the release evidence.' }];
  let recallCalls = 0;
  const result = await simplified.generateActions('transcript', ['Release verification'], {
    apiKey: 'test', prepared: actionPrepared,
    fetchImpl: async () => response({ actions: [{ owner: 'Alex Smith', action: 'Verify the release evidence', deadline: 'Not stated', evidenceIds: ['line_1_unit_0'] }] }),
    useActionSuitabilityFilter: true,
    actionRecallRunner: async () => { recallCalls += 1; return { ok: true, decisions: [] }; },
    actionSuitabilityRunner: async (candidates) => ({
      ok: true, threshold: 0.35,
      decisions: candidates.map((candidate) => ({ id: candidate.id, keep: true, showProbability: 0.8 }))
    })
  });
  assert.equal(recallCalls, 0);
  assert.equal(result.telemetry.recallRescue.attempted, false);
  assert.equal(result.telemetry.recallRescue.reason, 'disabled');
});

test('deployment uses the calibrated conservative action threshold without adding a model pass', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'utils', 'simplifiedStagedMinutes.js'), 'utf8');
  assert.match(source, /DEFAULT_ACTION_SUITABILITY_THRESHOLD = 0\.60/);
  assert.match(source, /STAGED_ACTION_SUITABILITY_THRESHOLD \|\| DEFAULT_ACTION_SUITABILITY_THRESHOLD/);
});

test('only borderline actions with concrete uncertainty are marked for wording review', async () => {
  const actionPrepared = prepared([]);
  actionPrepared.units = [
    { id: 'line_1_unit_0', speaker: 'Alex Smith', text: 'If that is required, I will update it, but the exact change is unclear.' },
    { id: 'line_2_unit_0', speaker: 'Alex Smith', text: 'I will verify the release evidence before closure.' },
    { id: 'line_3_unit_0', speaker: 'Alex Smith', text: 'I will issue the final report tomorrow.' }
  ];
  const result = await simplified.generateActions('transcript', ['Release verification'], {
    apiKey: 'test', prepared: actionPrepared,
    fetchImpl: async () => response({ actions: [
      { owner: 'Alex Smith', action: 'Update the change', deadline: 'Not stated', evidenceIds: ['line_1_unit_0'] },
      { owner: 'Alex Smith', action: 'Verify the release evidence', deadline: 'Not stated', evidenceIds: ['line_2_unit_0'] },
      { owner: 'Alex Smith', action: 'Issue the final report', deadline: 'tomorrow', evidenceIds: ['line_3_unit_0'] }
    ] }),
    useActionSuitabilityFilter: true,
    actionSuitabilityRunner: async (candidates) => ({
      ok: true, threshold: 0.35,
      decisions: candidates.map((candidate, index) => ({
        id: candidate.id, keep: true, showProbability: [0.39, 0.39, 0.82][index]
      }))
    })
  });
  assert.equal(result.actions[0].wordingUnresolved, true);
  assert.equal(Object.hasOwn(result.actions[1], 'wordingUnresolved'), false, 'a concrete unresolved verification is not highlighted by itself');
  assert.equal(Object.hasOwn(result.actions[2], 'wordingUnresolved'), false, 'high-confidence wording is not highlighted');
});

test('recall classifier nominates an uncovered window for targeted recovery before the publication gate', async () => {
  const actionPrepared = prepared([]);
  actionPrepared.units = [
    { id: 'line_1_unit_0', speaker: 'Alex Smith', text: 'I will verify the release evidence tomorrow.' },
    { id: 'line_2_unit_0', speaker: 'Jo Jones', text: 'The language file remains incomplete.' },
    { id: 'line_3_unit_0', speaker: 'Jo Jones', text: 'I will load the translated language file next week.' },
    { id: 'line_4_unit_0', speaker: 'Alex Smith', text: 'That is all from me.' },
    { id: 'line_5_unit_0', speaker: 'Jo Jones', text: 'Thanks.' }
  ];
  let targetedCalls = 0;
  const fetchImpl = async (_url, options) => {
    const prompt = JSON.parse(options.body).messages[1].content;
    if (prompt.includes('bounded transcript window only')) {
      targetedCalls += 1;
      return response({ actions: [{ owner: 'Jo Jones', action: 'Load the translated language file', deadline: 'next week', evidenceIds: ['line_3_unit_0'] }] });
    }
    return response({ actions: [{ owner: 'Alex Smith', action: 'Verify the release evidence', deadline: 'tomorrow', evidenceIds: ['line_1_unit_0'] }] });
  };
  const result = await simplified.generateActions('transcript', ['Release verification'], {
    apiKey: 'test', fetchImpl, prepared: actionPrepared, useActionRecallRescue: true, useActionSuitabilityFilter: true,
    actionRecallRunner: async (windows) => ({
      ok: true, modelSchemaVersion: 1, embeddingModel: 'all-MiniLM-L6-v2', threshold: 0.46,
      decisions: windows.map((window) => ({ id: window.id, rescue: true, actionProbability: 0.82 }))
    }),
    actionSuitabilityRunner: async (candidates) => ({
      ok: true, modelSchemaVersion: 2, embeddingModel: 'all-MiniLM-L6-v2', threshold: 0.16,
      decisions: candidates.map((candidate) => ({ id: candidate.id, keep: true, showProbability: 0.9 }))
    })
  });
  assert.equal(targetedCalls, 1);
  assert.deepEqual(result.actions, [
    { owner: 'Alex Smith', action: 'Verify the release evidence.', deadline: 'tomorrow' },
    { owner: 'Jo Jones', action: 'Load the translated language file.', deadline: 'next week' }
  ]);
  assert.equal(result.telemetry.recallRescue.selectedCount, 1);
  assert.equal(result.telemetry.recallRescue.recoveredCount, 1);
  assert.equal(result.telemetry.editor.inputCount, 2);
});

test('malformed recall-classifier output skips rescue without failing the existing action path', async () => {
  const actionPrepared = prepared([]);
  actionPrepared.units = [
    { id: 'line_1_unit_0', speaker: 'Alex Smith', text: 'I will verify the release evidence.' },
    { id: 'line_2_unit_0', speaker: 'Alex Smith', text: 'The rest is background.' },
    { id: 'line_3_unit_0', speaker: 'Alex Smith', text: 'No further update.' }
  ];
  const fetchImpl = async () => response({ actions: [{ owner: 'Alex Smith', action: 'Verify the release evidence', deadline: 'Not stated', evidenceIds: ['line_1_unit_0'] }] });
  const result = await simplified.generateActions('transcript', ['Release verification'], {
    apiKey: 'test', fetchImpl, prepared: actionPrepared, useActionRecallRescue: true,
    actionRecallRunner: async () => ({ ok: true, decisions: [] })
  });
  assert.deepEqual(result.actions, [{ owner: 'Alex Smith', action: 'Verify the release evidence.', deadline: 'Not stated' }]);
  assert.equal(result.telemetry.recallRescue.used, false);
  assert.match(result.telemetry.recallRescue.reason, /did not decide every window/i);
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
  assert.equal(simplified.publishableActionText('Make changes to the coding and languages'), '');
  assert.equal(simplified.publishableActionText('Pop the relevant item into a folder for review'), '');
  assert.equal(simplified.publishableActionText('Check whether anything else is missing'), '');
  assert.equal(simplified.publishableActionText('Focus solely on protocol preparation for masking problems'), '');
  assert.equal(simplified.publishableActionText('Go through how to distribute the study'), '');
  assert.equal(simplified.publishableActionText('Resolve symbol issues for four items'), '');
  assert.equal(simplified.publishableActionText('Conduct thinking in parallel about sales meetings'), '');
  assert.equal(simplified.publishableActionText('Bring the information to the leadership team'), '');
  assert.equal(simplified.publishableActionText('Bring the collected information to the leadership team'), '');
  assert.equal(simplified.publishableActionText('Get Colm and Grace to go through how to distribute the study'), 'Ask Colm and Grace to review how to distribute the study');
  assert.equal(simplified.publishableActionText('Have a call to review the response and load documents'), '');
  assert.equal(simplified.publishableActionText('Schedule a call with Kevin to review the procedures'), 'Schedule a call with Kevin to review the procedures');
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

// A date the meeting said out loud rather than wrote down.
//
// "The date's locked, the twenty-eighth of September" is how the race committee fixes a
// date, and the deadline column wants "28 September". The literal substring check missed
// it and the calendar-token fallback only knows digits and month names, so a date stated
// plainly in the meeting was published as "Not stated".
test('a deadline spoken as words is supported by the transcript that spoke it', () => {
  const rows = [{ text: "So the date's locked, the twenty-eighth of September, and we said fifteen pounds entry, that hasn't changed?" }];
  assert.equal(simplified.deadlineIsSupported('28 September', rows), true);
  assert.equal(simplified.deadlineIsSupported('28th September', rows), true);
  assert.equal(simplified.deadlineIsSupported('The twenty-eighth of September', rows), true);
});

test('the spoken-date reading never invents support for a date nobody gave', () => {
  const rows = [{ text: "So the date's locked, the twenty-eighth of September, and we said fifteen pounds entry." }];
  for (const absent of ['31 December', 'Next Tuesday', '15 March 2027', 'By the end of Q3', '27 September']) {
    assert.equal(simplified.deadlineIsSupported(absent, rows), false, `${absent} is not in the transcript`);
  }
});

test('relative deadlines the meeting actually used still pass', () => {
  // The widened reading is additive; none of the phrasings that already worked may stop.
  const rows = [{ text: "I'll get the road-closure application in this week, no later, and confirm the towpath's reopened." },
    { text: 'And I will cheque in with Rebecca before the end of this week.' },
    { text: 'We anticipate that the completion of all of that testing will be done by this second last week of July.' }];
  for (const phrase of ['This week', 'Before the end of this week', 'Second last week of July', 'End of July']) {
    assert.equal(simplified.deadlineIsSupported(phrase, rows), true, `${phrase} must still pass`);
  }
});

// The reviewer's spelling has to reach the stages that never watched them fix it.
//
// The details screen shows the transcript's spelling and offers the known name as a swap.
// The simplified discussion and actions stages read the raw transcript and are handed only
// the meeting type and purpose, so accepting "Rebecca Gill" on screen 1 produced an
// attendee list saying Gill and an actions table saying Cuckoo in the same document.
const fsNames = require('node:fs');
const pathNames = require('node:path');
const transcriptFor = (name) => fsNames.readFileSync(
  pathNames.resolve(__dirname, `../scripts/staged-scorecard-fixtures/${name}/transcript.txt`), 'utf8'
);

test('a surname the reviewer settled is carried into the simplified stages', () => {
  const corrections = api.stagedEvaluation.reviewerSpeakerNameCorrections(
    transcriptFor('07_t761_eakin_tech_file_weekly'),
    ['Jacqui Fox', 'David Didsbury', 'Andrew Kane', 'Rebecca Gill']
  );
  assert.equal(corrections.get('Rebecca Cuckoo'), 'Rebecca Gill');
  const actions = api.stagedEvaluation.applyReviewerNamesDeep(
    [{ owner: 'Rebecca Cuckoo', action: 'Send the purchased standards.', deadline: 'Not stated' }], corrections
  );
  assert.equal(actions[0].owner, 'Rebecca Gill');
});

test('a spelling the reviewer kept is left exactly alone', () => {
  const corrections = api.stagedEvaluation.reviewerSpeakerNameCorrections(
    transcriptFor('07_t761_eakin_tech_file_weekly'),
    ['Jacqui Fox', 'David Didsbury', 'Andrew Kane', 'Rebecca Cuckoo']
  );
  assert.equal(corrections.size, 0, 'the reviewer decided nothing, so nothing changes');
});

test('two attendees sharing a first name are never merged', () => {
  // Jo Bennett takes first aid and Jo Marsh takes marshals; a first name that resolves to
  // two people resolves to neither.
  const corrections = api.stagedEvaluation.reviewerSpeakerNameCorrections(
    transcriptFor('12_race_committee_two_jos'),
    ['Deepa Sharma', 'Jo Bennett', 'Jo Marsh', 'Alan Pryce']
  );
  assert.equal(corrections.size, 0);
});

test('someone mentioned in the room but never speaking in it is not absorbed', () => {
  // "Andrew Barr" sent the 17 changes and is not Andrew Kane. Anchoring the mapping to
  // transcript speakers is what keeps the two apart.
  const corrections = api.stagedEvaluation.reviewerSpeakerNameCorrections(
    transcriptFor('07_t761_eakin_tech_file_weekly'),
    ['Jacqui Fox', 'David Didsbury', 'Andrew Kane', 'Rebecca Gill']
  );
  const prose = api.stagedEvaluation.applyReviewerNamesDeep(
    'Rebecca Cuckoo confirmed that Andrew Barr sent the 17 changes.', corrections
  );
  assert.match(prose, /Rebecca Gill/);
  assert.match(prose, /Andrew Barr/, 'a non-speaker keeps his own name');
});

test('a recorder that writes the name backwards still resolves to one person', () => {
  // Teams labels the Abbott audit lead "Smith, Stuart M". The details screen resolves that
  // alias to "Stuart Smith"; the simplified stages read the transcript as recorded, so
  // seven of ten action owners said "Smith, Stuart M" against an attendee list saying
  // Stuart Smith. The first-name anchor cannot connect them - "smith" is not "stuart".
  const corrections = api.stagedEvaluation.reviewerSpeakerNameCorrections(
    transcriptFor('01_abbott_audit_kickoff'), ['Jacqui Fox', 'Stuart Smith', 'Niamh Lynch']
  );
  assert.equal(corrections.get('Smith, Stuart M'), 'Stuart Smith');
  const owners = api.stagedEvaluation.applyReviewerNamesDeep(
    [{ owner: 'Smith, Stuart M', action: 'Share the audit findings tracker.' }], corrections
  );
  assert.equal(owners[0].owner, 'Stuart Smith');
});

test('a meeting of strangers to the roster rewrites nothing', () => {
  // The residents association is on no roster and needed no corrections; a transcript the
  // reviewer has not touched must come through exactly as it was said.
  const corrections = api.stagedEvaluation.reviewerSpeakerNameCorrections(
    transcriptFor('13_parking_no_decision'),
    ['Trevor Nutall', 'Angela Rimmer', 'Baljit Sanghera', 'Sandra Wexford', 'Rex Fournier']
  );
  assert.equal(corrections.size, 0);
});

// An unresolved placeholder is the model saying it could not finish the sentence.
test('a bracketed placeholder is never published as an action', () => {
  for (const text of [
    'Speak to [unspecified party] next week.',
    'Confirm the plan with [name] tomorrow.',
    'Send the pack to <the client> on Friday.',
    'Update the TODO document next week.',
    'Chase the supplier TBC before Friday.'
  ]) {
    assert.equal(simplified.publishableActionText(text), '', `${text} is unfinished`);
  }
});

test('the placeholder rule leaves real action wording alone', () => {
  // Including a numeric comparison, which is why the angle-bracket form needs a letter
  // after the "<" rather than matching any "<...>" span.
  for (const text of [
    'Order the full hop bill, including thirteen kilos across both brews.',
    'Reduce the dose to <5 grams per litre and above >2 kilos total.',
    'Email them today to confirm the fifteen casks for the twenty-second, with our terms.',
    'Ring the refrigeration engineer to service the glycol chiller.'
  ]) {
    assert.ok(simplified.publishableActionText(text), `${text} must survive`);
  }
});

// A date that has already been and gone is not a deadline.
test('a deadline in the past is not supported by the meeting that mentioned it', () => {
  const rows = [{ speaker: 'Jacqui Fox', text: 'I did ask Cody to get an overview and did follow up with him last week.' }];
  for (const past of ['Last week', 'By last week', 'Yesterday', 'Last Monday', 'Three weeks ago', '2 days ago']) {
    assert.equal(simplified.deadlineIsSupported(past, rows), false, `${past} has already gone`);
  }
});

test('a real deadline containing the words "last week" survives', () => {
  // "Second last week of July" is an expected deadline in this corpus and contains "last
  // week" inside it. Whole-value anchoring is the entire safety of the past-date rule.
  for (const real of ['Second last week of July', 'The last week of July', 'Last week of August']) {
    assert.equal(simplified.deadlineAlreadyPassed(real), false, `${real} is still to come`);
  }
  assert.equal(simplified.deadlineAlreadyPassed('Not stated'), false);
});
