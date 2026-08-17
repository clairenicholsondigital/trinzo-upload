'use strict';

const { validateGrammarRevision } = require('./stagedExecutiveSummaryGrammar');

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
  'identify', 'meeting', 'next', 'objective', 'objectives', 'progress', 'related', 'review',
  'reviewed', 'summary', 'the', 'their', 'workstream', 'workstreams'
]);

function contentTokens(value) {
  return new Set((clean(value).toLowerCase().match(/[a-z][a-z0-9'’-]{3,}/g) || []));
}

function validateInitialUnderstandingRevision(original, revised) {
  const objectives = cleanLines(revised?.objectives, 5);
  const executiveSummary = clean(revised?.executiveSummary);
  if (!objectives.length || !executiveSummary) return { ok: false, reason: 'incomplete_response' };
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
  const sourceTokens = contentTokens(sourceText);
  const unsupportedTokens = [...contentTokens(revisedText)]
    .filter((token) => !sourceTokens.has(token) && !EDITORIAL_WORDS.has(token));
  if (unsupportedTokens.length) return { ok: false, reason: 'new_substantive_wording' };
  const summaryValidation = validateGrammarRevision(
    clean([original.meetingPurpose, ...original.overallTopics, original.executiveSummary].join(' ')),
    executiveSummary
  );
  // This pass may deliberately remove repeated/weak notes, so only the protected-fact
  // and broad semantic-overlap parts of the grammar guard apply here.
  if (summaryValidation.reason === 'new_protected_fact') return { ok: false, reason: summaryValidation.reason };
  if (summaryValidation.overlap != null && summaryValidation.overlap < 0.45) {
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
              'Write 2-5 concise meeting objectives and one short executive summary in natural British English.',
              'Remove repetition, conversational fragments and notes that are plainly not meaningful meeting subjects.',
              'Use only meaning present in the supplied material. If a note is unclear, omit it rather than guessing.',
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
      : { ...original, used: false, reason: validation.reason, overlap: validation.overlap, timingMs: Date.now() - startedAt };
  } catch {
    return { ...original, used: false, reason: 'request_failed', timingMs: Date.now() - startedAt };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

module.exports = { polishInitialUnderstanding, validateInitialUnderstandingRevision };
