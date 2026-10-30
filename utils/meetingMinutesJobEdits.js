'use strict';

// Retain the saved result envelope and the first pre-edit output for historical jobs.
function buildMeetingMinutesJobEditedPayload(job, editedRows, rawEditedMeta, actorEmail) {
  const safeRows = editedRows.slice(0, 500).map((row) => ({
    type: String(row?.type || 'Note').slice(0, 80),
    topic: String(row?.topic || '').slice(0, 300),
    itemType: String(row?.itemType || '').slice(0, 80),
    owner: String(row?.owner || '').slice(0, 300),
    deadline: String(row?.deadline || '').slice(0, 300),
    text: String(row?.text || '').slice(0, 10000),
    detail: String(row?.detail || '').slice(0, 10000),
    evidence: String(row?.evidence || '').slice(0, 10000)
  })).filter((row) => row.text.trim());

  const currentPayload = job.resultPayload && typeof job.resultPayload === 'object' ? job.resultPayload : {};
  const currentResult = currentPayload.result && typeof currentPayload.result === 'object' ? currentPayload.result : {};
  const currentOutput = currentResult.output && typeof currentResult.output === 'object' ? currentResult.output : {};
  const editedMeta = rawEditedMeta && typeof rawEditedMeta === 'object' ? rawEditedMeta : {};
  const currentParticipants = currentOutput.participants && typeof currentOutput.participants === 'object' ? currentOutput.participants : {};
  const safeMeta = {
    meetingTitle: String(editedMeta.meetingTitle ?? currentOutput.meetingTitle ?? currentOutput.title ?? '').slice(0, 300),
    meetingDate: String(editedMeta.meetingDate ?? currentOutput.meetingDate ?? currentOutput.date ?? '').slice(0, 120),
    meetingLocation: String(editedMeta.meetingLocation ?? currentOutput.meetingLocation ?? currentOutput.location ?? '').slice(0, 300),
    meetingType: String(editedMeta.meetingType ?? currentOutput.meetingType ?? '').slice(0, 120),
    meetingObjectives: Array.isArray(editedMeta.meetingObjectives)
      ? editedMeta.meetingObjectives.map((value) => String(value || '').slice(0, 1000).trim()).filter(Boolean).slice(0, 100)
      : Array.isArray(currentOutput.meetingObjectives)
        ? currentOutput.meetingObjectives.map((value) => String(value || '').slice(0, 1000).trim()).filter(Boolean).slice(0, 100)
        : [],
    participants: {
      client: Array.isArray(editedMeta.participants?.client)
        ? editedMeta.participants.client.map((value) => String(value || '').slice(0, 200).trim()).filter(Boolean).slice(0, 100)
        : Array.isArray(currentParticipants.client || currentOutput['participants.client'])
          ? (currentParticipants.client || currentOutput['participants.client']).map((value) => String(value || '').slice(0, 200).trim()).filter(Boolean).slice(0, 100)
          : [],
      trinzo: Array.isArray(editedMeta.participants?.trinzo)
        ? editedMeta.participants.trinzo.map((value) => String(value || '').slice(0, 200).trim()).filter(Boolean).slice(0, 100)
        : Array.isArray(currentParticipants.trinzo || currentOutput['participants.trinzo'])
          ? (currentParticipants.trinzo || currentOutput['participants.trinzo']).map((value) => String(value || '').slice(0, 200).trim()).filter(Boolean).slice(0, 100)
          : []
    }
  };
  const discussionRows = safeRows.filter((row) => row.type.toLowerCase() === 'discussion');
  const actionRows = safeRows.filter((row) => row.type.toLowerCase() === 'action');
  const discussionTopicMap = new Map();
  for (const row of discussionRows) {
    const topic = row.topic || 'Discussion';
    if (!discussionTopicMap.has(topic)) {
      discussionTopicMap.set(topic, {
        topicId: topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'discussion',
        topic,
        summary: '',
        outcome: '',
        items: []
      });
    }
    const itemType = (row.itemType || 'discussion').toLowerCase().replace(/[\s-]+/g, '_');
    discussionTopicMap.get(topic).items.push({
      type: itemType,
      text: row.text,
      ...(row.owner ? { owner: row.owner } : {}),
      ...(row.deadline ? { deadline: row.deadline } : {}),
      ...(row.detail ? { detail: row.detail } : {}),
      ...(row.evidence ? { evidence: row.evidence } : {})
    });
  }
  const editedDiscussionTopics = Array.from(discussionTopicMap.values());
  const editedMeetingMinutes = editedDiscussionTopics.map((topic) => ({
    topic: topic.topic,
    discussionPoints: topic.items.map((item) => item.text).filter(Boolean)
  })).filter((topic) => topic.discussionPoints.length);
  const editedActions = actionRows.map((row) => ({
    meetingActionPoint: row.text,
    meetingActionPointOwner: row.owner || 'Not stated',
    meetingActionPointDeadline: row.deadline || row.detail || 'Not stated',
    ...(row.topic ? { topic: row.topic } : {}),
    ...(row.detail ? { detail: row.detail } : {}),
    ...(row.evidence ? { evidence: row.evidence } : {})
  }));
  const editedOutput = {
    ...currentOutput,
    meetingTitle: safeMeta.meetingTitle,
    meetingDate: safeMeta.meetingDate,
    meetingLocation: safeMeta.meetingLocation,
    meetingType: safeMeta.meetingType,
    meetingObjectives: safeMeta.meetingObjectives,
    participants: safeMeta.participants,
    discussionTopics: editedDiscussionTopics,
    meetingMinutes: editedMeetingMinutes,
    discussionPoints: discussionRows.map((row) => row.text),
    actions: editedActions,
    meetingActionPoint: editedActions.map((row) => row.meetingActionPoint),
    meetingActionPointOwner: editedActions.map((row) => row.meetingActionPointOwner),
    meetingActionPointDeadline: editedActions.map((row) => row.meetingActionPointDeadline),
    nextSteps: editedActions.map((row) => ({
      action: row.meetingActionPoint,
      owner: row.meetingActionPointOwner,
      deadline: row.meetingActionPointDeadline
    })),
    editedMeta: safeMeta,
    editedRows: safeRows,
    humanEdited: true,
    humanEditedAt: new Date().toISOString(),
    humanEditedBy: actorEmail || 'OpenClaw'
  };

  const nextPayload = {
    ...currentPayload,
    humanEdited: true,
    humanEditedAt: editedOutput.humanEditedAt,
    humanEditedBy: editedOutput.humanEditedBy,
    result: {
      ...currentResult,
      originalOutput: currentResult.originalOutput || currentOutput,
      output: editedOutput
    }
  };
  return nextPayload;
}

module.exports = { buildMeetingMinutesJobEditedPayload };
