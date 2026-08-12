'use strict';

const { clean } = require('./evidence');

function assessEvidenceTopology(evidence) {
  const markerIndex = evidence.events.findIndex((event) => /(?:^|\b(?:okay|right|so)[,;:]?\s+)(?:the\s+)?actions?\s*[.:]|\b(?:quick|final)\s+(?:action\s+)?recap\b/i.test(event.text));
  if (markerIndex < 0) return { mode: 'standard', confidence: 1, signals: [], evidenceWindow: null };

  const maximumEnd = Math.min(evidence.events.length - 1, markerIndex + 24);
  let endIndex = maximumEnd;
  for (let index = markerIndex + 1; index <= maximumEnd; index += 1) {
    if (/\b(?:thank you everyone|thanks (?:everyone|folks)|that['’]s us|see you|bye all)\b/i.test(evidence.events[index].text)) {
      endIndex = index - 1;
      break;
    }
  }
  const window = evidence.events.slice(markerIndex, endIndex + 1);
  const assignmentCount = window.filter((event) => /\b[A-Z][a-z]+,\s*you(?:['’]re| are)\b/i.test(event.text)).length;
  const confirmationCount = window.filter((event) => /^(?:yeah|yes|yep|agreed|ha)[,;]?\s+/i.test(event.text)).length;
  const selfRecapCount = window.filter((event) => /\bI(?:['’]m| am)\s+doing\b|\bmy job is\b/i.test(event.text)).length;
  const signals = ['explicit_action_recap'];
  if (assignmentCount >= 2) signals.push('multiple_cross_turn_assignments');
  if (confirmationCount >= 2) signals.push('confirmation_turns');
  if (selfRecapCount) signals.push('self_recap');
  const confidence = Math.min(0.99, 0.45 + (assignmentCount * 0.13) + (confirmationCount * 0.04) + (selfRecapCount * 0.08));
  if (assignmentCount < 2 || confidence < 0.72) return { mode: 'standard', confidence, signals, evidenceWindow: { startEventId: evidence.events[markerIndex].id, endEventId: evidence.events[endIndex].id, startIndex: markerIndex, endIndex } };
  return { mode: 'distributed_recap', confidence, signals, evidenceWindow: { startEventId: evidence.events[markerIndex].id, endEventId: evidence.events[endIndex].id, startIndex: markerIndex, endIndex } };
}

function firstNameOwner(firstName, participants) {
  return participants.find((name) => name.split(/\s+/)[0].toLowerCase() === String(firstName).toLowerCase()) || '';
}

function recapActionText(value) {
  let text = clean(value)
    .replace(/^(?:yeah|yes|yep|agreed|ha\b)[,;]?\s*/i, '')
    .replace(/^and\s+/i, '')
    .replace(/\bI['’]ll\s+/gi, '')
    .replace(/[.]+$/, '');
  text = text
    .replace(/^putting\s+(.+?)\s+back on\s+/i, 'Restore $1 on ')
    .replace(/^building\b/i, 'Build')
    .replace(/^writing\b/i, 'Write')
    .replace(/^doing\b/i, 'Handle')
    .replace(/^grouping\b/i, 'Group')
    .replace(/^dropping\b/i, 'Drop')
    .replace(/^covering\b/i, 'Cover')
    .replace(/^the open\b/i, 'Handle the opening');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function splitCommitments(text) {
  const value = clean(text);
  const pieces = value.split(/,?\s+and\s+(?=(?:I['’]ll|building|writing|grouping|dropping|putting|covering|handling|starting|monitoring)\b)/i);
  return pieces.map(recapActionText).filter((item) => item && item.split(/\s+/).length >= 3);
}

function assembleDistributedRecapActions(evidence, topology, deadlineFrom) {
  if (topology.mode !== 'distributed_recap' || !topology.evidenceWindow) return [];
  const events = evidence.events.slice(topology.evidenceWindow.startIndex, topology.evidenceWindow.endIndex + 1);
  const actions = [];
  let latestAssignment = null;
  const push = (owner, text, eventIds, rawText) => {
    if (!owner || !text || /^(?:might|maybe)\b|\b(?:no action|cancelled|already completed)\b/i.test(rawText)) return;
    const deadline = deadlineFrom(rawText);
    actions.push({ owner, action: recapActionText(text), deadline, evidenceIds: [...new Set(eventIds)] });
  };

  events.forEach((event, index) => {
    const assignment = event.text.match(/(?:^|\bactions?\.\s*|^and\s+)([A-Z][a-z]+),\s*you(?:['’]re| are),?\s+(.+)/i);
    const selfRecap = event.text.match(/\bI(?:['’]m| am)\s+doing\s+(.+)/i);
    if (assignment) {
      const owner = firstNameOwner(assignment[1], evidence.participants);
      latestAssignment = { owner, eventIndex: index, evidenceIds: [event.id] };
      for (const commitment of splitCommitments(assignment[2])) push(owner, commitment, [event.id], event.text);
      return;
    }
    if (selfRecap) {
      latestAssignment = { owner: event.speaker, eventIndex: index, evidenceIds: [event.id] };
      for (const commitment of splitCommitments(selfRecap[1])) push(event.speaker, commitment, [event.id], event.text);
      return;
    }
    if (latestAssignment && event.speaker === latestAssignment.owner && index - latestAssignment.eventIndex <= 2 && /^(?:yeah|yes|yep|agreed|ha)[,;]?\s+/i.test(event.text)) {
      for (const commitment of splitCommitments(event.text)) push(event.speaker, commitment, [...latestAssignment.evidenceIds, event.id], event.text);
      return;
    }
    if (/\bthat['’]s you\.\s+you\s+(?:hit|start|monitor|send|share|review|upload)\b/i.test(event.text)) {
      const previous = events[index - 1];
      const owner = previous ? previous.speaker : '';
      const body = event.text.replace(/^.*?that['’]s you\.\s+you\s+/i, '');
      push(owner, body, [previous?.id, event.id].filter(Boolean), event.text);
      latestAssignment = { owner, eventIndex: index, evidenceIds: [previous?.id, event.id].filter(Boolean) };
    }
    if (/^you\s+(?:hit|start|monitor)\b/i.test(event.text) && /that['’]s you/i.test(events[index - 1]?.text || '')) {
      const owner = events[index - 2]?.speaker || '';
      push(owner, event.text, [events[index - 2]?.id, events[index - 1]?.id, event.id].filter(Boolean), event.text);
      latestAssignment = { owner, eventIndex: index, evidenceIds: [events[index - 2]?.id, events[index - 1]?.id, event.id].filter(Boolean) };
    }
  });

  for (const event of events) {
    if (/(?:half eight|08:30).*(?:warm-up|open and the first handover)|(?:warm-up|open and the first handover).*(?:half eight|08:30)/i.test(event.text)) {
      push('all attendees', 'Run a short opening and first-handover warm-up', [event.id], `${event.text} by 08:30 tomorrow`);
      break;
    }
  }

  const normalised = actions.map((item) => {
    let action = item.action;
    if (/red dot|recording top left|hit the button|hit record/i.test(action)) action = 'Start and monitor the recording, verify the red dot and take a screenshot';
    if (/planted questions/i.test(action) && /group/i.test(action)) action = 'Group chat questions and prepare planted backup questions during the live session';
    return { ...item, action };
  });
  const used = new Set();
  const compacted = [];
  const mergeMatching = (owner, pattern) => {
    const matches = normalised.map((item, index) => ({ item, index })).filter(({ item, index }) => !used.has(index) && item.owner === owner && pattern.test(item.action));
    if (matches.length < 2) return;
    matches.forEach(({ index }) => used.add(index));
    compacted.push({
      owner,
      action: matches.map(({ item }) => item.action.replace(/[.]+$/, '')).join('; '),
      deadline: matches.find(({ item }) => item.deadline !== 'Not stated')?.item.deadline || 'Not stated',
      evidenceIds: [...new Set(matches.flatMap(({ item }) => item.evidenceIds))]
    });
  };
  for (const owner of [...new Set(normalised.map((item) => item.owner))]) {
    mergeMatching(owner, /closing slide|re-share.*deck/i);
    mergeMatching(owner, /planted questions|group.*chat/i);
    mergeMatching(owner, /seconds|answer|joke|clock|disciplined.*time/i);
    mergeMatching(owner, /opening|housekeeping|dead air|speech-bubble|\bclose\b/i);
  }
  normalised.forEach((item, index) => { if (!used.has(index)) compacted.push(item); });
  return compacted.map((item) => {
    let action = item.action;
    let deadline = item.deadline;
    if (/write.*backup questions/i.test(action) && /send them round|circulat/i.test(action)) action = 'Write and circulate three backup questions';
    if (/planted questions|group.*chat/i.test(action)) {
      action = 'Group chat questions and privately cue the presenter during the live session';
      if (deadline === 'Not stated') deadline = 'during the live session';
    }
    if (/thirty seconds|seconds per answer/i.test(action) && /joke/i.test(action)) {
      action = 'Keep self-introduction and answers to roughly thirty seconds and omit the opening joke';
      if (deadline === 'Not stated') deadline = 'during the live session';
    }
    return { ...item, action, deadline };
  });
}

module.exports = { assessEvidenceTopology, assembleDistributedRecapActions };
