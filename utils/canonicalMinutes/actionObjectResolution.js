'use strict';

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

const SCOPE_NOUNS = [
  'process', 'workflow', 'pipeline', 'procedure', 'method', 'approach',
  'framework', 'model', 'system', 'plan'
];

const PURPOSE_VERBS = [
  'generate', 'qualify', 'review', 'assess', 'test', 'produce', 'prepare',
  'create', 'develop', 'build', 'process', 'analyse', 'analyze', 'validate',
  'manage', 'track', 'document', 'update'
];

function underspecifiedMeasure(action) {
  const text = clean(action);
  if (/\b(?:slice|subset|sample|part|portion|piece)\s+of\b/i.test(text)) return null;
  return text.match(/\b(?:a|an|the)?\s*(?:(?:small|limited|initial|representative|test|trial)\s+)?(?:slice|subset|sample|part|portion|piece)\b/i);
}

function gerund(verb) {
  const value = clean(verb).toLowerCase();
  if (/ie$/.test(value)) return `${value.slice(0, -2)}ying`;
  if (/e$/.test(value) && !/(?:ee|ye)$/.test(value)) return `${value.slice(0, -1)}ing`;
  return `${value}ing`;
}

function purposeFromEvent(event) {
  const text = clean(event?.text);
  const verbs = PURPOSE_VERBS.join('|');
  const match = text.match(new RegExp(`\\b(?:this|that|it)\\s+(?:is|was|would be)\\s+(?:just\\s+|mainly\\s+|intended\\s+|designed\\s+|used\\s+)?to\\s+(${verbs})\\s*([a-z][^.;!?]{1,110})`, 'i'));
  if (!match) return null;
  let object = clean(match[2])
    .replace(/^(?:the|a|an)\s+/i, '')
    .split(/\s+(?:so that|in order to|which|who|where|to be)\b/i)[0]
    .split(/\s+/)
    .slice(0, 7)
    .join(' ')
    .replace(/\bof a sufficient quality\b/i, 'of sufficient quality')
    .replace(/[,;:]+$/g, '');
  if (!object || /^(?:it|that|this|them|something|anything|what we want)$/i.test(object)) return null;
  return { event, verb: match[1].toLowerCase(), object };
}

function scopesFromEvent(event) {
  const text = clean(event?.text);
  return SCOPE_NOUNS.filter((noun) => new RegExp(`\\b${noun}\\b`, 'i').test(text)).map((noun) => ({ event, noun }));
}

function scopePriority(noun) {
  const index = SCOPE_NOUNS.indexOf(noun);
  return index < 0 ? 0 : (SCOPE_NOUNS.length - index) / SCOPE_NOUNS.length;
}

function candidateScopes(events, sourceIndex) {
  const start = Math.max(0, sourceIndex - 30);
  const prior = events.slice(start, sourceIndex);
  const purposes = prior.map(purposeFromEvent).filter(Boolean);
  return purposes.flatMap((purpose) => {
    const purposeIndex = events.indexOf(purpose.event);
    return events.slice(Math.max(start, purposeIndex - 4), purposeIndex + 1)
      .flatMap(scopesFromEvent)
      .map((scope) => {
        const scopeIndex = events.indexOf(scope.event);
        const pairDistance = purposeIndex - scopeIndex;
        const sourceDistance = sourceIndex - purposeIndex;
        const sameSpeaker = clean(scope.event.speaker) && clean(scope.event.speaker) === clean(purpose.event.speaker);
        return {
          ...purpose,
          noun: scope.noun,
          evidenceIds: [...new Set([scope.event.id, purpose.event.id].filter(Boolean))],
          score: 1
            + (scopePriority(scope.noun) * 0.16)
            + (sameSpeaker ? 0.08 : 0)
            - (pairDistance * 0.025)
            - (sourceDistance * 0.006)
        };
      });
  });
}

function enrichUnderspecifiedActionObject(item, evidence) {
  const action = clean(item?.action);
  if (!underspecifiedMeasure(action)) return item;
  const events = Array.isArray(evidence?.events) ? evidence.events : [];
  const sourceIds = [
    ...(Array.isArray(item?.representativeEvidenceIds) ? item.representativeEvidenceIds : []),
    ...(Array.isArray(item?.evidenceIds) ? item.evidenceIds : [])
  ];
  const sourceIndices = sourceIds.map((id) => events.findIndex((event) => event.id === id)).filter((index) => index >= 0);
  if (!sourceIndices.length) return item;
  const sourceIndex = Math.min(...sourceIndices);
  const ranked = candidateScopes(events, sourceIndex)
    .sort((left, right) => right.score - left.score || events.indexOf(right.event) - events.indexOf(left.event));
  const best = ranked[0];
  if (!best) return item;
  const competing = ranked.find((candidate) => candidate !== best
    && `${candidate.verb}|${candidate.object}` !== `${best.verb}|${best.object}`);
  if (competing && best.score - competing.score < 0.12) return item;
  const qualifier = /\b(?:idea|proposal|proposed|what we want to do|come up with)\b/i.test(
    events.slice(Math.max(0, sourceIndex - 6), sourceIndex + 1).map((event) => event.text).join(' ')
  ) ? 'proposed ' : '';
  const enrichedAction = `${action} of the ${qualifier}${best.noun} for ${gerund(best.verb)} ${best.object}`
    .replace(/\s+/g, ' ')
    .trim();
  return {
    ...item,
    action: enrichedAction.charAt(0).toUpperCase() + enrichedAction.slice(1),
    wordingEvidenceIds: [...new Set([...(item.wordingEvidenceIds || []), ...best.evidenceIds])]
  };
}

module.exports = { enrichUnderspecifiedActionObject, underspecifiedMeasure, purposeFromEvent };
