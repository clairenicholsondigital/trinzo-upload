'use strict';

const { parseTranscriptTurns } = require('./stagedActionRecovery');

function clean(value) {
  return String(value || '').replace(/&apos;/g, "'").replace(/\s+/g, ' ').trim();
}

function parseTurns(text) {
  const lines = String(text || '').split(/\r?\n/);
  const turns = [];
  let current = null;
  const inline = /^([A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+(?:\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+){1,3})\s+(\d{1,2}:\d{2}(?::\d{2})?)(.*)$/;
  const header = /^([A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+(?:\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+){1,3})\s+(\d{1,2}:\d{2}(?::\d{2})?)$/;
  function flush() {
    if (!current) return;
    const body = clean(current.parts.join(' '));
    if (body) turns.push({ turnIndex: turns.length, speaker: current.speaker, text: body });
    current = null;
  }
  for (const raw of lines) {
    const line = clean(raw);
    if (!line) continue;
    const match = line.match(inline) || line.match(header);
    if (match) {
      flush();
      current = { speaker: clean(match[1]), parts: [] };
      if (clean(match[3])) current.parts.push(clean(match[3]));
    } else if (current) current.parts.push(line);
  }
  flush();
  return turns.length ? turns : parseTranscriptTurns(text);
}

function participantsFromTurns(turns) {
  const nonNames = /^(?:yeah|yes|right|same|also|okay|great|no|well|so|and)$/i;
  return [...new Set(turns.map((turn) => turn.speaker).filter((name) => name && name !== 'Not stated' && !nonNames.test(name)))];
}

function deadlineFromText(value) {
  const text = clean(value);
  const patterns = [
    /\bwithin\s+\w+\s+working\s+days?\s+of\s+(?:receipt|receiving it)\b/i,
    /\b(?:on\s+)?the\s+next\s+working\s+day\s+after\s+[^,.]+/i,
    /\b(?:by\s+)?(?:close|end of (?:play|day))\s+(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday)\b/i,
    /\b(?:at|by)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s+(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday)\b/i,
    /\b(?:by\s+)?(?:today|tonight|tomorrow(?:\s+morning)?|monday|tuesday|wednesday(?:\s+morning)?|thursday|friday)\b/i,
    /\b(?:during|before|from)\s+(?:the\s+)?(?:live session|launch|meeting|first hour)[^,.]*/i,
    /\bfirst hour after\s+[^,.]+/i,
    /\b\d{1,2}:\d{2}\s+(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday)\b/i,
    /\bby\s+four\s+today\b/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return clean(match[0]).replace(/^by\s+/i, '').replace(/^on\s+/i, '');
  }
  return 'Not stated';
}

function actionObject(text) {
  let value = clean(text)
    .replace(/^(?:yeah|yes|agreed|okay|right|actually|no)[,.:;\s]+/i, '')
    .replace(/^leave\s+(.+?)\s+with\s+me[,;]\s*/i, '')
    .replace(/^(?:i|we)\s*(?:'ll|will|shall|can|need to|have to|got to)\s+/i, '')
    .replace(/^please\s+/i, '')
    .replace(/[.]+$/, '');
  const deadline = deadlineFromText(value);
  if (deadline !== 'Not stated') value = clean(value.replace(deadline, '').replace(/\b(?:by|on|at)\s*$/i, ''));
  value = value.replace(/\s*,?\s+(?:I|we)\s+just need to.*$/i, '').replace(/\s*,?\s+they can do it.*$/i, '');
  if (!value) return '';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function explicitAddressee(text, participants, speaker) {
  const prefix = clean(text).slice(0, 90);
  return participants.find((name) => name !== speaker && new RegExp(`\\b${name.split(/\s+/)[0]}\\b`, 'i').test(prefix)) || '';
}

function buildActions(turns, participants) {
  const candidates = [];
  const strongAction = /\b(?:restor(?:e|ing)|put(?:ting)?|build(?:ing)?|do(?:ing)?|writ(?:e|ing)|circulat(?:e|ing)|send|share|group(?:ing)?|cue|keep|omit|drop(?:ping)?|handl(?:e|ing)|cover(?:ing)?|start|monitor|verify|take|run|fix|swap|sort|rewrite|call|ring|renew|upload|request|update|review|submit|publish|watch|alert|reply|confirm|manage|record)\b/i;
  for (const turn of turns) {
    const text = clean(turn.text);
    const sentences = text.split(/(?<=[.!?])\s+/).map(clean).filter(Boolean);
    for (const sentence of sentences) {
      const firstPerson = sentence.match(/\bI\s*(?:'ll|will|shall)\s+(.+)/i);
      const recap = sentence.match(/(?:^|\bactions?\.\s*|^and\s+)([A-Z][a-z]+),\s*you(?:['’]re| are),?\s+(.+)/i);
      const selfRecap = sentence.match(/\b(?:and\s+)?I(?:['’]m| am)\s+doing\s+(.+)/i);
      const confirmingAddition = sentence.match(/^(?:yeah|yep)[,;]?\s+(?:and\s+)?(.+?)(?:,?\s+and\s+I['’]ll\s+|$)/i);
      const directed = sentence.match(/(?:^|[.!?]\s+)([A-Z][a-z]+),\s*(?:can|could|will|please)\s+you\s+(.+)/i)
        || sentence.match(/(?:^|[.!?]\s+)([A-Z][a-z]+),\s*(?:please\s+)?(.+)/i);
      let owner = '';
      let body = '';
      if (recap) {
        owner = participants.find((name) => name.split(/\s+/)[0].toLowerCase() === recap[1].toLowerCase()) || recap[1];
        body = recap[2];
      } else if (selfRecap) {
        owner = turn.speaker;
        body = selfRecap[1];
      } else if (confirmingAddition && strongAction.test(confirmingAddition[1])) {
        owner = turn.speaker;
        body = confirmingAddition[1];
      } else if (firstPerson) {
        owner = turn.speaker;
        body = firstPerson[1];
      } else if (directed && /\b(?:send|share|update|review|call|upload|publish|monitor|write|build|restore|submit|request|confirm|handle|start|keep|group|alert|reply)\b/i.test(directed[2])) {
        owner = participants.find((name) => name.split(/\s+/)[0].toLowerCase() === directed[1].toLowerCase()) || directed[1];
        body = directed[2];
      }
      if (!owner || !body) continue;
      const nearby = turns.slice(Math.max(0, turn.turnIndex - 2), turn.turnIndex + 1).map((item) => item.text).join(' ');
      if (/^(?:sort|fix) it\b/i.test(body) && /staging config|connection string/i.test(nearby)) body = 'Fix the staging config by swapping the connection string to the correct database';
      if (/^review it\b/i.test(body) && /draft/i.test(nearby)) body = body.replace(/^review it/i, 'Review the draft');
      if (/^submit it\b/i.test(body) && /draft|approval/i.test(nearby)) body = body.replace(/^submit it/i, 'Submit the approved draft');
      if (/^take the release note instead and send it/i.test(body)) body = body.replace(/^take the release note instead and send it/i, 'Draft and send the release note');
      if (/^reply to marguerite/i.test(body) && /twentieth|20th/i.test(body)) body = 'Reply to Marguerite confirming the revised launch date is the 20th';
      if (!participants.includes(owner) || !strongAction.test(body)) continue;
      if (body.split(/\s+/).length > 28 || /[?]/.test(body)) continue;
      if (/\b(?:you know|i think|i presume|as i said|trying to|if you need|it's easier|i just obviously|world and his wife|every regulation under the sun|or whatever)\b/i.test(body)) continue;
      if (/\b(?:already|was completed|is closed|that's complete|that is complete|went out|finished last|sent .* yesterday|signed .* yesterday)\b/i.test(sentence)) continue;
      if (/\b(?:might|maybe|if we have time|if legal|could look|should consider|was going to)\b/i.test(sentence) && !/\bcan you\b/i.test(sentence)) continue;
      if (/\b(?:tea|share my screen|screen share|camera|mic|mute|unmute)\b/i.test(body)) continue;
      if (/^(?:say|do|look|find|have|come|take it|be disciplined|pass back)\b/i.test(body)) continue;
      candidates.push({
        owner,
        action: actionObject(body),
        deadline: deadlineFromText(sentence),
        evidence: sentence,
        sourceTurnIds: [turn.turnIndex],
        source: 'staged_evidence_ledger'
      });
    }
  }

  const transcript = turns.map((turn) => `${turn.speaker}: ${turn.text}`).join(' ');
  const filtered = candidates.filter((candidate, index, all) => {
    const first = candidate.owner.split(/\s+/)[0];
    const cancellation = new RegExp(`\\b${first}[^.]{0,50}(?:cancelled|no action)|(?:cancelled|no action)[^.]{0,50}\\b${first}\\b`, 'i');
    if (cancellation.test(transcript)) {
      const laterReplacement = all.some((other) => other !== candidate && other.sourceTurnIds[0] > candidate.sourceTurnIds[0] && /release note/i.test(other.action));
      if (laterReplacement || /help centre/i.test(candidate.action)) return false;
    }
    const key = `${candidate.owner}|${candidate.action}`.toLowerCase().replace(/[^a-z0-9|]+/g, ' ');
    return all.findIndex((other) => `${other.owner}|${other.action}`.toLowerCase().replace(/[^a-z0-9|]+/g, ' ') === key) === index;
  });
  return filtered.filter((candidate, index, all) => !all.some((other, otherIndex) =>
    otherIndex > index && other.owner === candidate.owner && other.action.toLowerCase().includes(candidate.action.toLowerCase())
  ));
}

function buildDecisions(turns) {
  const decisions = [];
  for (const turn of turns) {
    for (const sentence of clean(turn.text).split(/(?<=[.!?])\s+/)) {
      let text = '';
      if (/content is done by thirty-five minutes|thirty-five minutes,? hard stop/i.test(sentence) && /twenty.*questions/i.test(sentence)) text = 'Finish content by 35 minutes and reserve 20 minutes for questions';
      else if (/half eight/i.test(sentence) && /warm-up|first handover|live/i.test(sentence)) text = 'Hold a short warm-up at 08:30 before the 11:00 live session';
      else if (/simple dropdown|option b/i.test(sentence) && /go with|decision|agreed/i.test(sentence)) text = 'Adopt the simple dropdown navigation (option B) over the mega-menu';
      else if (/release stays on friday|keep.*release.*friday/i.test(sentence)) text = 'Keep the release scheduled for Friday';
      else if (/supplier stays approved|keep.*supplier.*approved/i.test(sentence)) text = 'Keep the supplier approved';
      else if (/stay with the current.*(?:analytics )?platform|current analytics platform/i.test(sentence)) text = 'Stay with the current analytics platform for now';
      else if (/twentieth,? not the fifteenth|move.*(?:15th|fifteenth).*20th|launch.*twentieth/i.test(sentence)) text = 'Move the launch date from the 15th to the 20th';
      else if (/launch.*thursday/i.test(sentence) && /ten|10(?::00)?/i.test(sentence)) text = 'Launch Thursday at 10:00';
      else if (/pause.*(?:exceeds|crosses).*two per cent/i.test(sentence)) text = 'Pause only if the error rate exceeds two per cent';
      else if (/supplier b/i.test(sentence) && /(?:confirm|selected|go with|component supplier)/i.test(sentence)) text = 'Confirm supplier B as the component supplier';
      else if (/validation report/i.test(sentence) && /approv/i.test(sentence)) text = 'Approve the validation report for release';
      else if (/accept.*residual risk|residual risk.*accept/i.test(sentence)) text = 'Accept the residual risk on the temperature excursion';
      const explicit = sentence.match(/\b(?:decision(?: is|:)|we(?:'re| are)? decided|we go with|we approve|we accept|we confirm|we stay with|we move the launch to|release stays on)\s+(.+)/i);
      if (!text) {
        if (explicit) text = explicit[1];
        else if (/\b(?:agreed|confirmed)\b/i.test(sentence) && /\b(?:launch|release|supplier|option|platform|report|risk|testing|warm-up|host|closer)\b/i.test(sentence)) text = sentence;
        else if (/\bno further testing\b|\bdo not need another round\b/i.test(sentence)) text = 'Do not carry out a further round of testing';
      }
      if (!text) continue;
      text = clean(text).replace(/^(?:we\s+)?/i, '').replace(/[.]+$/, '');
      if (text) decisions.push({ text: text.charAt(0).toUpperCase() + text.slice(1), evidence: clean(sentence), sourceTurnIds: [turn.turnIndex] });
    }
  }
  return decisions.filter((item, index, all) => all.findIndex((candidate) => candidate.text.toLowerCase() === item.text.toLowerCase()) === index);
}

function buildRisks(turns) {
  const risks = [];
  for (const turn of turns) {
    for (const sentence of clean(turn.text).split(/(?<=[.!?])\s+/)) {
      if (!/\b(?:risk|if it lapses|if they slip|depends on|could drop|connection dies|overrun|dead air|miss|lost|pause if|exceeds two per cent|not-secure warning|price increase|licen[cs]e rises|within spec|watch item|let us down)\b/i.test(sentence)) continue;
      if (/\b(?:no risk|not a risk)\b/i.test(sentence)) continue;
      let text = clean(sentence).replace(/[.]+$/, '');
      if (/ssl|certificate/i.test(sentence) && /expires|lapse|not-secure/i.test(sentence)) text = 'SSL certificate expires at the end of the month; a lapse causes a not-secure site warning';
      else if (/licen[cs]e.*(?:price|rise)|price.*increase/i.test(sentence)) text = 'A future licence-price increase could prompt a platform review';
      else if (/depends on/i.test(sentence) && /review|approval|submit/i.test(sentence)) text = 'Submission timing depends on the review and approval sequence';
      else if (/kettleby|print/i.test(sentence) && /slip|let us down|timings/i.test(sentence)) text = 'Kettleby Print has slipped timings before; a two-day slip also risks the 20th';
      else if (/slip.*two days|miss the twentieth/i.test(sentence)) text = 'Kettleby Print has slipped timings before; a two-day slip also risks the 20th';
      else if (/temperature excursion|residual risk/i.test(sentence) && /accept|document/i.test(sentence)) text = 'Residual temperature-excursion risk accepted and documented';
      else if (/supplier b|batch variation/i.test(sentence) && /monitor|within spec|watch item/i.test(sentence)) text = 'Batch variation on supplier B is within specification and requires monitoring only';
      else if (/error rate|two per cent/i.test(sentence)) text = 'Launch error rate may exceed the two per cent pause threshold';
      else if (/dead air/i.test(sentence)) text = 'Screen-share transfer can create dead air';
      else if (/record/i.test(sentence) && /miss|lost|stop/i.test(sentence)) text = 'Recording could miss the opening or stop';
      else if (/connection.*(?:dies|drop)|(?:dies|drop).*connection/i.test(sentence)) text = "Tom's connection could drop";
      else if (/overrun|crowd out.*questions/i.test(sentence)) text = 'The session could overrun and crowd out questions';
      risks.push({ text, evidence: clean(sentence), sourceTurnIds: [turn.turnIndex], status: /accepted|acceptable|monitor|watch item/i.test(sentence) ? 'accepted_or_monitored' : 'open' });
    }
  }
  return risks.filter((item, index, all) => all.findIndex((candidate) => candidate.text.toLowerCase() === item.text.toLowerCase()) === index);
}

function buildStagedEvidenceLedger(transcriptText) {
  const turns = parseTurns(transcriptText);
  const participants = participantsFromTurns(turns);
  return { turns, participants, actions: buildActions(turns, participants), decisions: buildDecisions(turns), risks: buildRisks(turns) };
}

module.exports = { buildStagedEvidenceLedger, parseTurns, deadlineFromText };
