'use strict';

const { clean } = require('./evidence');

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'for', 'of', 'on', 'in', 'by', 'at',
  'it', 'that', 'this', 'we', 'i', 'you', 'will', 'shall', 'do', 'take',
  'agreed', 'decision', 'item', 'thing', 'there', 'with', 'from'
]);

const TOKEN_ALIASES = Object.freeze({
  accepted: 'accept', accepting: 'accept', approved: 'approve', approving: 'approve',
  confirmed: 'confirm', confirming: 'confirm', concluded: 'select', selected: 'select',
  chose: 'select', chosen: 'select', went: 'select', replied: 'contact', reply: 'contact',
  tell: 'contact', told: 'contact', message: 'contact', emailed: 'contact', email: 'contact',
  called: 'contact', call: 'contact', grouped: 'group', grouping: 'group',
  monitoring: 'monitor', monitored: 'monitor', questions: 'question', risks: 'risk'
});

function tokens(value) {
  return clean(value).toLowerCase().match(/[a-z0-9]+/g)
    ?.map((token) => TOKEN_ALIASES[token] || token)
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token)) || [];
}

function tokenOverlap(left, right) {
  const a = new Set(tokens(left));
  const b = new Set(tokens(right));
  if (!a.size || !b.size) return 0;
  return [...a].filter((token) => b.has(token)).length / Math.min(a.size, b.size);
}

function entityAnchors(value) {
  const source = clean(value);
  const proper = source.match(/\b[A-Z][a-z][A-Za-z'’.-]*\b/g) || [];
  const numbers = source.toLowerCase().match(/\b(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|twenty|thirty|forty|fifty|hundred|per cent|percent)\b/g) || [];
  return new Set([...proper.map((item) => item.toLowerCase()), ...numbers]);
}

function sharesAnchor(left, right) {
  const a = entityAnchors(left);
  const b = entityAnchors(right);
  return [...a].some((anchor) => b.has(anchor));
}

function relationProbability(profile, leftEventId, rightEventId, label) {
  if (!leftEventId || !rightEventId) return 0;
  const direct = profile?.relations?.[`${leftEventId}|${rightEventId}`];
  const reverse = profile?.relations?.[`${rightEventId}|${leftEventId}`];
  return Number((direct || reverse)?.[label] || 0);
}

function topicIds(profile, evidenceIds) {
  const ids = new Set(evidenceIds || []);
  return new Set((profile?.topics || []).filter((topic) => {
    if (Number(topic.cohesion || 0) < 0.72 || (topic.evidenceIds || []).length < 2) return false;
    const substantive = (topic.evidenceIds || []).filter((id) => {
      const role = profile?.events?.[id]?.discourseRoleProbabilities || {};
      return Number(role.canonical_assertion || 0) >= Number(role.acceptance || 0);
    });
    return substantive.length >= 2 && (topic.evidenceIds || []).some((id) => ids.has(id));
  }).map((topic) => topic.id));
}

function sameGroup(left, right, options) {
  if (options.ownerOf && clean(options.ownerOf(left)).toLowerCase() !== clean(options.ownerOf(right)).toLowerCase()) return false;
  const leftText = options.textOf(left);
  const rightText = options.textOf(right);
  if (tokenOverlap(leftText, rightText) >= Number(options.lexicalThreshold || 0.55)) return true;
  const learnedRelation = (left.evidenceIds || []).some((leftId) => (right.evidenceIds || []).some((rightId) => relationProbability(options.profile, leftId, rightId, 'same_item') >= 0.62));
  if (learnedRelation) return true;
  const leftTopics = topicIds(options.profile, left.evidenceIds);
  if ([...topicIds(options.profile, right.evidenceIds)].some((id) => leftTopics.has(id))) return true;
  if (!options.anchorGrouping || !sharesAnchor(leftText, rightText)) return false;
  const leftSources = (left.evidenceIds || []).map((id) => options.eventById?.get(id)).filter(Boolean);
  const rightSources = (right.evidenceIds || []).map((id) => options.eventById?.get(id)).filter(Boolean);
  const turnDistance = Math.min(...leftSources.flatMap((a) => rightSources.map((b) => Math.abs(Number(a.turnIndex) - Number(b.turnIndex)))), Infinity);
  return turnDistance <= Number(options.anchorTurnDistance || 24);
}

function consolidate(items, options) {
  const groups = [];
  for (const item of items) {
    const matches = groups.filter((group) => group.some((candidate) => sameGroup(candidate, item, options)));
    if (!matches.length) groups.push([item]);
    else {
      const primary = matches[0];
      primary.push(item);
      for (const secondary of matches.slice(1)) {
        primary.push(...secondary);
        groups.splice(groups.indexOf(secondary), 1);
      }
    }
  }
  return groups.map((group) => {
    const representative = [...group].sort((left, right) => options.qualityOf(right) - options.qualityOf(left))[0];
    return {
      ...representative,
      representativeEvidenceIds: [...(representative.evidenceIds || [])],
      evidenceIds: [...new Set(group.flatMap((item) => item.evidenceIds || []))]
    };
  });
}

function capitalise(value) {
  const text = clean(value).replace(/[.]+$/, '');
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

function actionHasConcreteObject(value) {
  const ignored = new Set([
    'contact', 'send', 'share', 'review', 'add', 'put', 'get', 'make', 'keep',
    'still', 'today', 'tomorrow', 'monday', 'tuesday', 'wednesday', 'thursday',
    'friday', 'saturday', 'sunday', 'minute', 'minutes', 'hour', 'hours',
    'morning', 'afternoon', 'evening', 'tonight', 'later', 'before', 'after',
    'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
    'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'twenty',
    'thirty', 'forty', 'fifty', 'hundred'
  ]);
  return tokens(value).some((token) => !ignored.has(token) && !/^\d+$/.test(token));
}

function composeDecision(item, eventById) {
  const sources = (item.representativeEvidenceIds || item.evidenceIds || []).map((id) => eventById.get(id)).filter(Boolean);
  const source = [...sources].sort((left, right) => clean(right.text).length - clean(left.text).length)[0];
  const text = clean(source?.text || item.text).replace(/^(?:yeah|yes|okay|right|so|good)[,;:\s]+/i, '').replace(/[.]+$/, '');
  if (/\b(?:haven['’]t|have not|not)\s+(?:approved|agreed|decided|confirmed)\b/i.test(text)) return '';
  let match = text.match(/\b(?:decision\s*(?:is|:)|we\s+(?:have\s+)?(?:decided|agreed)\s+(?:to\s+)?)(.+)$/i);
  if (match) {
    const clause = clean(match[1]);
    const scheduled = clause.match(/^(.+?)\s+stays?\s+on\s+(.+?)(?:,|$)/i);
    if (scheduled) return capitalise(`Keep ${scheduled[1]} scheduled for ${scheduled[2]}`);
    return capitalise(clause);
  }
  match = text.match(/\bwe\s+(?:only\s+)?(pause|stop|proceed|continue|launch|release)\s+(.+)$/i);
  if (match) return capitalise(`${match[1]} ${/\bonly\b/i.test(text) ? 'only ' : ''}${match[2]}`);
  match = text.match(/\bwe\s+(?:stay|stayed)\s+with\s+(.+)$/i);
  if (match) return capitalise(`Stay with ${match[1]}`);
  match = text.match(/\bwe\s+(?:approve|approved)\s+(.+)$/i);
  if (match) return capitalise(`Approve ${match[1]}`);
  match = text.match(/\bwe\s+(?:accept|accepted|are accepting)\s+(.+)$/i);
  if (match) return capitalise(`Accept ${match[1]}`);
  match = text.match(/\b(?:we\s+)?(?:confirm|confirmed)\s+(.+)$/i);
  if (match) return capitalise(`Confirm ${match[1].replace(/,?\s+and\s+(?:there|it|nothing)\b.*$/i, '')}`);
  match = text.match(/\b(?:concluded|selected|chose|went with)\s+(.+?)(?:,|\s+in the end\b|$)/i);
  if (match) {
    const option = clean(match[1]);
    const compared = text.match(/\b([a-z][a-z0-9-]+)\s+[A-Z]\s+and\s+\1\s+([A-Z])\b/i);
    const selection = compared && new RegExp(`^${compared[2]}$`, 'i').test(option) ? `${compared[1]} ${option}` : option;
    return capitalise(`Confirm selection of ${selection}`);
  }
  match = text.match(/\bclosed decision[,;:]?\s+(.+?)(?:,|$)/i);
  if (match) return capitalise(`Confirm ${match[1]}`);
  return capitalise(item.text);
}

function composeRisk(item, evidence, profile) {
  if (!/^(?:it|that|there|yes|yeah|nothing)\b/i.test(clean(item.text))) return item.text;
  const byId = new Map(evidence.events.map((event) => [event.id, event]));
  const sources = (item.representativeEvidenceIds || item.evidenceIds || []).map((id) => byId.get(id)).filter(Boolean);
  if (!sources.length) return item.text;
  const firstIndex = Math.min(...sources.map((event) => evidence.events.indexOf(event)).filter((index) => index >= 0));
  const contextDependent = sources.some((event) => {
    const context = profile?.events?.[event.id]?.contextDependencyProbabilities || {};
    return Number(context.needs_previous || 0) >= 0.12 || Number(context.modifies_previous || 0) >= 0.3;
  });
  const deictic = sources.some((event) => /\b(?:that|it|there|watch item)\b/i.test(event.text));
  if (!contextDependent || !deictic || firstIndex <= 0) return item.text;
  const previous = evidence.events.slice(Math.max(0, firstIndex - 4), firstIndex).reverse().find((event) => {
    const semantic = profile?.events?.[event.id] || {};
    const substantive = tokens(event.text).filter((token) => !['nothing', 'action', 'aware', 'normal'].includes(token)).length >= 3;
    const concreteStart = !/^(?:it|that|there|yes|yeah|nothing|right|okay)\b/i.test(clean(event.text));
    return substantive && concreteStart && (Number(semantic.scores?.risk || 0) >= 0.2 || Number(semantic.evidenceProbabilities?.risk_dependency || 0) >= 0.12);
  });
  const lastIndex = Math.max(...sources.map((event) => evidence.events.indexOf(event)).filter((index) => index >= 0));
  const following = evidence.events.slice(lastIndex + 1, lastIndex + 4).find((event) => {
    const semantic = profile?.events?.[event.id] || {};
    const explicitState = /\b(?:within spec|out of spec|accepted|documented|open|closed|mitigated|monitor(?:ed|ing)?)\b/i.test(event.text);
    return explicitState || Number(semantic.scores?.risk || 0) >= 0.18 || Number(semantic.evidenceProbabilities?.risk_dependency || 0) >= 0.12;
  });
  const parts = [previous?.text, item.text, following?.text].filter(Boolean).map((text) => clean(text).replace(/[.]+$/, ''));
  return parts.length > 1 ? capitalise(parts.join('; ')) : item.text;
}

function attachTemporalContext(items, evidence, profile, deadlineFrom) {
  const byId = new Map(evidence.events.map((event) => [event.id, event]));
  return items.map((item) => {
    if (item.deadline && item.deadline !== 'Not stated') return item;
    const duration = clean(item.action).match(/\bfor\s+(?:the\s+)?((?:first|next|initial)\s+(?:(?:\w+)\s+){0,2}(?:minutes?|hours?|days?|weeks?))\b/i);
    if (!duration) return item;
    const sources = (item.evidenceIds || []).map((id) => byId.get(id)).filter(Boolean);
    const sourceIndices = sources.map((event) => evidence.events.indexOf(event)).filter((index) => index >= 0);
    if (!sourceIndices.length) return item;
    const start = Math.min(...sourceIndices);
    const end = Math.max(...sourceIndices);
    const candidates = evidence.events.slice(Math.max(0, start - 4), Math.min(evidence.events.length, end + 5)).filter((event) => {
      if ((item.evidenceIds || []).includes(event.id)) return false;
      const temporal = profile?.events?.[event.id]?.temporalRoleProbabilities || {};
      const attachment = profile?.events?.[event.id]?.discourseRoleProbabilities || {};
      const explicit = deadlineFrom(event.text) !== 'Not stated';
      const conflictingAction = event.roles?.includes('action_candidate') && !sources.some((source) => source.speaker === event.speaker);
      return !conflictingAction && explicit && (Number(temporal.deadline_previous || 0) >= 0.12 || Number(temporal.deadline_current || 0) >= 0.12 || Number(attachment.temporal_attachment || 0) >= 0.08);
    });
    const ranked = candidates.map((event) => {
      const index = evidence.events.indexOf(event);
      const sameSpeaker = sources.some((source) => source.speaker === event.speaker) ? 0.15 : 0;
      const distance = Math.min(...sourceIndices.map((sourceIndex) => Math.abs(sourceIndex - index)));
      const shared = tokenOverlap(item.action, `${event.previousText || ''} ${event.text}`);
      return { event, score: sameSpeaker + shared - (distance * 0.04) };
    }).sort((left, right) => right.score - left.score);
    if (!ranked.length || ranked[0].score < -0.16) return item;
    const event = ranked[0].event;
    const precise = clean(event.text).match(/\b((?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+at\s+(?:\d{1,2}(?::\d{2})?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve))\b/i)?.[1];
    return { ...item, deadline: `${duration[1]} after ${precise || deadlineFrom(event.text)}`, evidenceIds: [...new Set([...(item.evidenceIds || []), event.id])] };
  });
}

function applyOperationalPhaseTiming(items, evidence, topology) {
  if (topology?.mode !== 'distributed_recap' || !topology.evidenceWindow) return items;
  const start = evidence.events.findIndex((event) => event.id === topology.evidenceWindow.startEventId);
  const end = evidence.events.findIndex((event) => event.id === topology.evidenceWindow.endEventId);
  if (start < 0 || end < start) return items;
  const recap = evidence.events.slice(start, end + 1);
  const milestone = recap.find((event) => /\b(?:live|launch|session|event|meeting|workshop|webinar)\b/i.test(event.text) && /\b(?:at|starts?|begins?|on)\b/i.test(event.text));
  if (!milestone) return items;
  const milestoneLabel = /\blive\b/i.test(milestone.text) ? 'the live session'
    : clean(milestone.text).match(/\b(?:the\s+)?([a-z-]+\s+(?:session|event|meeting|workshop|webinar))\b/i)?.[1] || 'the scheduled session';
  return items.map((item) => {
    if (item.deadline && item.deadline !== 'Not stated') return item;
    const sourceEvents = (item.evidenceIds || []).map((id) => evidence.events.find((event) => event.id === id)).filter(Boolean);
    const sourceText = sourceEvents.map((event) => event.text).join(' ');
    const action = clean(item.action);
    const firstPersonStart = sourceEvents.find((event) => /\b(?:the\s+)?second\s+I\s+(?:open\s+my\s+mouth|start\s+(?:talking|speaking))\b/i.test(event.text));
    if (firstPersonStart && /\b(?:record|recording|capture|stream)\b/i.test(action)) {
      return { ...item, deadline: `from ${firstPersonStart.speaker.split(/\s+/)[0]}'s first words` };
    }
    const speakingStart = sourceText.match(/\b(?:the\s+)?second\s+([A-Z][a-z]+)\s+(?:opens?\s+(?:their|his|her)\s+mouth|starts?\s+(?:talking|speaking))\b/i);
    if (speakingStart && /\b(?:record|recording|capture|stream)\b/i.test(action)) {
      return { ...item, deadline: `from ${speakingStart[1]}'s first words` };
    }
    const execution = /\b(?:open(?:ing)?|host(?:ing)?|housekeeping|handover|moderate|facilitate|present|monitor|watch|cue|chat)\b/i.test(action);
    const preparation = /\b(?:build(?:ing)?|creat(?:e|ing)|prepar(?:e|ing)|restor(?:e|ing)|put(?:ting)?\b.*\bback|updat(?:e|ing)|writ(?:e|ing)|draft(?:ing)?|circulat(?:e|ing)|re-shar(?:e|ing)|reshar(?:e|ing)|send(?:ing)?|finalis(?:e|ing)|finish(?:ing)?)\b/i.test(action);
    if (execution && !preparation) return { ...item, deadline: `during ${milestoneLabel}` };
    if (preparation) return { ...item, deadline: `before ${milestoneLabel}` };
    return item;
  });
}

function deriveRoleDecisions(evidence, existingDecisions = []) {
  const roleFamilies = [
    {
      first: /\bI\b[^.]{0,50}\b(?:open\s+it|(?:do|handle|cover|take|handling|covering|doing)\s+(?:the\s+)?open(?:ing)?)\b/i,
      second: /\bI\b[^.]{0,50}\b(?:clos(?:e|ing)|(?:do|handle|cover|take|handling|covering|doing)\s+(?:the\s+)?clos(?:e|ing))\b/i,
      description: (speaker) => `Use ${speaker} as host and closer`
    }
  ];
  const derived = [];
  for (const speaker of evidence.participants || []) {
    const events = evidence.events.filter((event) => event.speaker === speaker);
    for (const family of roleFamilies) {
      const first = events.find((event) => family.first.test(event.text));
      const second = events.find((event) => family.second.test(event.text));
      if (!first || !second) continue;
      const text = family.description(speaker);
      if (!existingDecisions.some((item) => tokenOverlap(item.text || item, text) >= 0.6)) {
        derived.push({ text, evidenceIds: [...new Set([first.id, second.id])], deterministic: true });
      }
    }
  }
  return derived;
}

module.exports = { actionHasConcreteObject, applyOperationalPhaseTiming, attachTemporalContext, composeDecision, composeRisk, consolidate, deriveRoleDecisions, entityAnchors, tokenOverlap };
