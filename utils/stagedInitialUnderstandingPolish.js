'use strict';

const {
  fallbackMinutesReadySummary,
  transcriptShapedSummaryIssue,
  validateGrammarRevision
} = require('./stagedExecutiveSummaryGrammar');

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function cleanLines(value, limit = 8) {
  return (Array.isArray(value) ? value : [])
    .map(clean)
    .filter(Boolean)
    .filter((item, index, all) => all.findIndex((other) => other.toLowerCase() === item.toLowerCase()) === index)
    .slice(0, limit);
}

function protectedFacts(value) {
  return new Set([
    ...(clean(value).match(/\b\d+(?:[.,:]\d+)*(?:%|st|nd|rd|th)?\b/g) || []),
    ...(clean(value).match(/\b[A-Z][A-Z0-9&/-]{1,}\b/g) || []),
    ...(clean(value).match(/\b[A-Z][a-z'’-]+(?:\s+[A-Z][a-z'’-]+)+\b/g) || [])
  ].map((item) => item.toLowerCase()));
}

const EDITORIAL_WORDS = new Set([
  'agree', 'agreed', 'align', 'clarify', 'confirm', 'coordinate', 'discuss', 'establish',
  'focused', 'further', 'identify', 'including', 'information', 'internal', 'meeting', 'necessary',
  'next', 'objective', 'objectives', 'progress', 'related', 'remain', 'required', 'review',
  'reviewed', 'summary', 'supporting', 'the', 'their', 'workstream', 'workstreams'
]);

function contentTokens(value) {
  return new Set((clean(value).toLowerCase().match(/[a-z][a-z0-9'’-]{3,}/g) || []));
}

function objectiveIssue(value) {
  const text = clean(value);
  if (!text) return 'empty_objective';
  if (text.split(/\s+/).length < 4) return 'short_fragment';
  if (/\b(?:I|we|we'd|we'll|we've|we're|our|ours|my|mine|me|us|you|your|yours|you're|you are)\b/i.test(text)) {
    return 'first_or_second_person_objective';
  }
  if (/\b[A-Z][a-z'’-]+\s+[A-Z][a-z'’-]+\s+(?:said|noted|explained|reported|thinks|thought|mean|means|want|wants)\b/i.test(text)) {
    return 'speaker_transcript_objective';
  }
  if (/\b(?:current\s+setup\s+the\s+flash|for\s+a\s+site\s+in\s+the\s+areas|quality\s+culture\s+operating|lovely,\s+that'?s\s+one\s+sorted|now,\s+the\s+annual\s+show)\b/i.test(text)) {
    return 'malformed_objective';
  }
  return '';
}

function hasPresentationIssue(notes = {}) {
  return [
    ...(Array.isArray(notes.objectives) ? notes.objectives : []),
    notes.executiveSummary
  ].some((item) => objectiveIssue(item) || transcriptShapedSummaryIssue(item));
}

function normaliseTopicObjective(topic) {
  let text = clean(topic)
    .replace(/^(?:review|clarify|confirm|coordinate|align|discuss)\s+/i, '')
    .replace(/\s+and\s+related\s+next\s+steps\.?$/i, '')
    .replace(/[.!?]+$/g, '')
    .trim();
  if (!text || objectiveIssue(text)) return '';
  text = text.charAt(0).toLowerCase() + text.slice(1);
  return `Review ${text}.`;
}

function deterministicPresentationFallback(original, reason = 'unsafe_presentation') {
  const objectives = cleanLines(original.objectives, 5)
    .filter((item) => !objectiveIssue(item));
  if (!objectives.length) {
    for (const topic of cleanLines(original.overallTopics, 8)) {
      const objective = normaliseTopicObjective(topic);
      if (objective && !objectives.some((item) => item.toLowerCase() === objective.toLowerCase())) {
        objectives.push(objective);
      }
      if (objectives.length >= 5) break;
    }
  }
  const executiveSummary = fallbackMinutesReadySummary(original.executiveSummary) || clean(original.meetingPurpose);
  if (!objectives.length || !executiveSummary || transcriptShapedSummaryIssue(executiveSummary)) {
    return { ...original, used: false, reason };
  }
  return {
    ...original,
    objectives,
    executiveSummary,
    used: true,
    reason: `deterministic_${reason}`
  };
}

function validateInitialUnderstandingRevision(original, revised) {
  const objectives = cleanLines(revised?.objectives, 5);
  const executiveSummary = clean(revised?.executiveSummary);
  if (!objectives.length || !executiveSummary) return { ok: false, reason: 'incomplete_response' };
  const sourceNeedsPresentationPolish = hasPresentationIssue(original);
  const outputObjectiveIssue = objectives.map(objectiveIssue).find(Boolean);
  if (outputObjectiveIssue) return { ok: false, reason: outputObjectiveIssue };
  const sourceText = clean([
    original.meetingTitle,
    original.meetingPurpose,
    ...original.objectives,
    ...original.overallTopics,
    original.executiveSummary
  ].join(' '));
  const revisedText = clean([...objectives, executiveSummary].join(' '));
  const sourceFacts = protectedFacts(sourceText);
  const revisedFacts = protectedFacts(revisedText);
  if ([...revisedFacts].some((fact) => !sourceFacts.has(fact))) return { ok: false, reason: 'new_protected_fact' };
  if (/\bI\b|\b(?:we|we'd|we'll|we've|we're|our|my)\b/i.test(executiveSummary)) {
    return { ok: false, reason: 'first_person_summary' };
  }
  if (/(?:^|[.!?]\s+)(?:obviously|basically|you know|because)\b/i.test(executiveSummary)) {
    return { ok: false, reason: 'conversational_summary' };
  }
  const summaryIssue = transcriptShapedSummaryIssue(executiveSummary);
  if (summaryIssue) return { ok: false, reason: summaryIssue };
  const sourceTokens = contentTokens(sourceText);
  const unsupportedTokens = [...contentTokens(revisedText)]
    .filter((token) => !sourceTokens.has(token) && !EDITORIAL_WORDS.has(token));
  const revisedTokens = contentTokens(revisedText);
  const unsupportedRatio = unsupportedTokens.length / Math.max(revisedTokens.size, 1);
  if (unsupportedRatio > (sourceNeedsPresentationPolish ? 0.42 : 0.08)) {
    return { ok: false, reason: 'new_substantive_wording' };
  }
  const summaryValidation = validateGrammarRevision(
    clean([original.meetingPurpose, ...original.overallTopics, original.executiveSummary].join(' ')),
    executiveSummary
  );
  // This pass may deliberately remove repeated/weak notes, so only the protected-fact
  // and broad semantic-overlap parts of the grammar guard apply here.
  if (summaryValidation.reason === 'new_protected_fact') return { ok: false, reason: summaryValidation.reason };
  if (summaryValidation.overlap != null && summaryValidation.overlap < (sourceNeedsPresentationPolish ? 0.2 : 0.3)) {
    return { ok: false, reason: 'meaning_changed', overlap: summaryValidation.overlap };
  }
  return { ok: true, reason: 'accepted', objectives, executiveSummary, overlap: summaryValidation.overlap };
}

async function polishInitialUnderstanding(input = {}, options = {}) {
  const original = {
    meetingTitle: clean(input.meetingTitle),
    meetingPurpose: clean(input.meetingPurpose),
    objectives: cleanLines(input.objectives, 5),
    overallTopics: cleanLines(input.overallTopics, 8),
    executiveSummary: clean(input.executiveSummary)
  };
  if (!original.objectives.length && !original.overallTopics.length) {
    return { ...original, used: false, reason: 'empty_notes' };
  }
  const apiKey = clean(options.apiKey);
  const fetchImpl = options.fetchImpl || global.fetch;
  if (!apiKey || typeof fetchImpl !== 'function') return { ...original, used: false, reason: 'unavailable' };
  const startedAt = Date.now();
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), Number(options.timeoutMs || 20000)) : null;
  try {
    const response = await fetchImpl(options.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal: controller?.signal,
      body: JSON.stringify({
        model: options.model,
        messages: [
          {
            role: 'system',
            content: 'You are a careful British English meeting-minutes editor. Improve wording only from the supplied title and notes. Never invent facts, people, decisions, actions, dates, purposes or technical detail.'
          },
          {
            role: 'user',
            content: [
              'Write 2-5 concise meeting objectives and a professional 2-3 sentence executive summary in natural British English.',
              'The executive summary must read like formal meeting minutes, not copied transcript speech or a list of notes.',
              'Synthesise and compress the supplied material. Use third-person, neutral wording and remove repetition, first-person speech, conversational fragments and plainly meaningless notes.',
              'Use only meaning present in the supplied material. If a note is unclear, omit it rather than guessing.',
              'Reuse the supplied terminology wherever possible; do not introduce new substantive concepts.',
              'Do not add actions, owners, deadlines, decisions or outcomes.',
              'Return JSON only as {"objectives":["..."],"executiveSummary":"..."}.',
              '',
              `[MEETING_TITLE] ${original.meetingTitle || 'Not stated'} [/MEETING_TITLE]`,
              `[MEETING_PURPOSE] ${original.meetingPurpose || 'Not stated'} [/MEETING_PURPOSE]`,
              `[BASIC_NOTES] ${original.overallTopics.join(' | ') || 'Not stated'} [/BASIC_NOTES]`,
              `[CURRENT_OBJECTIVES] ${original.objectives.join(' | ') || 'Not stated'} [/CURRENT_OBJECTIVES]`,
              `[CURRENT_SUMMARY] ${original.executiveSummary || 'Not stated'} [/CURRENT_SUMMARY]`
            ].join('\n')
          }
        ],
        temperature: 0,
        max_tokens: Number(options.maxTokens || 650),
        response_format: { type: 'json_object' }
      })
    });
    const raw = await response.text();
    if (!response.ok) return { ...original, used: false, reason: `http_${response.status}`, timingMs: Date.now() - startedAt };
    const body = raw ? JSON.parse(raw) : {};
    const content = body?.choices?.[0]?.message?.content;
    const parsed = typeof content === 'object' && content ? content : JSON.parse(String(content || '{}'));
    const validation = validateInitialUnderstandingRevision(original, parsed);
    return validation.ok
      ? { ...original, objectives: validation.objectives, executiveSummary: validation.executiveSummary, used: true, reason: validation.reason, overlap: validation.overlap, timingMs: Date.now() - startedAt }
      : { ...deterministicPresentationFallback(original, validation.reason), overlap: validation.overlap, timingMs: Date.now() - startedAt };
  } catch {
    return { ...deterministicPresentationFallback(original, 'request_failed'), timingMs: Date.now() - startedAt };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

module.exports = {
  deterministicPresentationFallback,
  objectiveIssue,
  polishInitialUnderstanding,
  validateInitialUnderstandingRevision
};
