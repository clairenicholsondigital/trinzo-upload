'use strict';

function clean(value) {
  return String(value || '').replace(/&apos;/g, "'").replace(/\s+/g, ' ').trim();
}

function parseTurns(transcriptText) {
  const turns = [];
  const source = String(transcriptText || '').replace(/\r/g, '');
  const header = /(?:^|\n)((?:[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+\s*,\s*[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+(?:[ \t]+[A-Z])?)|(?:[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+(?:[ \t]+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+){0,3}))(?:[ \t]+|[ \t]*[-–][ \t]*|[ \t]*\n[ \t]*)(\d{1,2}:\d{2}(?::\d{2})?)[ \t]*|(?:^|\n|(?<=[.!?]))([A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+):[ \t]*/gm;
  const ignoredHeaders = /^(?:date|location|duration|transcript|recording|meeting|speakers|attendees|decision confirmed)$/i;
  const matches = [...source.matchAll(header)].map((match) => ({ ...match, speakerName: clean(match[1] || match[3]) })).filter((match) => !ignoredHeaders.test(match.speakerName));
  matches.forEach((match, index) => {
    const next = matches[index + 1];
    const text = clean(source.slice(match.index + match[0].length, next ? next.index : source.length));
    const speaker = match.speakerName;
    if (text && text.length <= 5000) turns.push({ id: `turn_${turns.length + 1}`, index: turns.length, speaker, text });
  });
  return turns;
}

function parseStructuredMinutes(transcriptText) {
  const source = String(transcriptText || '').replace(/\r/g, '');
  const participantMatch = source.match(/Participants\s+Trinzo:\s*([\s\S]*?)\n\s*Meeting Minutes\b/i);
  const participants = participantMatch
    ? participantMatch[1].split(/\n+/).map(clean).filter((line) => line && !/^(?:Client|Trinzo):?$/i.test(line) && !/\((?:absent|apologies)[^)]*\)/i.test(line))
      .filter((line) => /^[A-Z][A-Za-z'’.-]+(?:\s+[A-Z][A-Za-z'’.-]+){0,3}$/.test(line))
    : [];
  const actionSection = source.match(/Next steps\s+Actions\s+Owner\s+Deadline\s*([\s\S]*)$/i);
  if (!actionSection) return { participants, turns: [] };
  const compact = clean(actionSection[1]);
  const rowPattern = /(.+?)\s+([A-Z][A-Za-z'’.-]+(?:\/[A-Z][A-Za-z'’.-]+)*)\s+(\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)(?:\s+[‘’']?\d{2,4})?)(?=\s|$)/g;
  const turns = [];
  for (const match of compact.matchAll(rowPattern)) {
    const action = clean(match[1]);
    const deadline = clean(match[3]);
    if (!action || action.split(/\s+/).length > 40) continue;
    for (const ownerToken of match[2].split('/')) {
      const owner = ownerToken;
      const ownerPrefix = new RegExp(`^${ownerToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+to\\s+`, 'i');
      const actionText = action.replace(ownerPrefix, '');
      turns.push({ speaker: owner, text: `I will ${actionText} by ${deadline}.`, structuredSource: 'actions_owner_deadline_table' });
    }
  }
  return { participants, turns };
}

function sentenceRole(text) {
  const value = clean(text);
  const roles = [];
  if (/\b(?:i['’]?ll|i will|i can|i need to|can you|please|action|follow[- ]?up|owns? the|you['’]?re|my job is)\b/i.test(value) || /^(?:[A-Z][A-Za-z'’.-]+)\s+to\s+[a-z]/.test(value) || /\b(?:still not finalised|is still missing|document is absent|follow-up feedback is still pending)\b/i.test(value)) roles.push('action_candidate');
  const decisionLanguage = /\b(?:decid(?:e|ed|ing)|decision|agreed|approved|confirmed|we go with|we stay with|release stays|no further testing)\b/i.test(value);
  const descriptiveApproval = /\b(?:latest|previously|already)\s+approved\s+(?:versions?|documents?|references?|plans?)\b/i.test(value) && !/\b(?:decision|agreed|confirmed|we approved)\b/i.test(value);
  if (decisionLanguage && !descriptiveApproval) roles.push('decision_candidate');
  if (/\b(?:risk|dependency|depends on|blocker|if .* (?:slip|lapse|fail|drop|exceed|miss)|watch item|not-secure warning|connection (?:dies|drops)|dead air|overrun)\b/i.test(value)) roles.push('risk_candidate');
  if (/\b(?:already|completed|finished|closed|sent .* yesterday|signed .* yesterday|done and dusted)\b/i.test(value)) roles.push('completed_history');
  if (/\b(?:might|maybe|could consider|if we have time|if legal|potential future|haven['’]?t approved|we should)\b/i.test(value)) roles.push('hypothetical');
  if (/\b(?:no action|cancelled|rejected|not going to|instead)\b/i.test(value)) roles.push('negative_or_superseding');
  return roles;
}

function prepareEvidence(transcriptText) {
  const parsedTurns = parseTurns(transcriptText);
  const structured = parseStructuredMinutes(transcriptText);
  const turns = [...parsedTurns, ...structured.turns].map((turn, index) => ({ ...turn, id: `turn_${index + 1}`, index }));
  const invalidSpeakers = /^(?:yes|yeah|right|same|also|okay|great|no|well|and|client|trinzo|speakers|participants|attendees)$/i;
  const participants = [...new Set([...structured.participants, ...turns.filter((turn) => !turn.structuredSource).map((turn) => turn.speaker)].filter((name) => !invalidSpeakers.test(name)))];
  const events = [];
  for (const turn of turns) {
    const sentences = turn.text.split(/(?<=[.!?])(?:\s+|(?=[A-Z]))/).map(clean).filter(Boolean);
    sentences.forEach((text, sentenceIndex) => events.push({
      id: `evt_${String(events.length + 1).padStart(4, '0')}`,
      turnId: turn.id,
      turnIndex: turn.index,
      sentenceIndex,
      speaker: turn.speaker,
      text,
      roles: sentenceRole(text),
      structuredSource: turn.structuredSource || null
    }));
  }
  return { turns, participants, events };
}

module.exports = { clean, parseTurns, parseStructuredMinutes, prepareEvidence };
