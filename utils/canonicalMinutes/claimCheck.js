'use strict';

// Does the record actually say what its evidence says?
//
// Two reviewer-reported rows survived every wording, grounding and dedupe pass because
// nothing in the pipeline asked that question:
//
//   "Compute a firm decision on the mute aspect"   <- "if we, in the meantime, we can
//                                                     compute a firm on that mute aspect"
//   "David Didsbury misinterpreted the software."  <- "Or I misinterpreted the software."
//                                                     "...but I might have misinterpreted"
//
// Both are grammatical, so the detectors pass them. Both cite real turns, so grounding
// passes them. Both are unique, so dedupe passes them. And both assert more than their
// evidence supports: a garbled conditional became an instruction, and a speaker's
// tentative self-correction became a flat statement that a named person made an error.
//
// Only the DETERMINISTIC half of this module is wired in. checkClaims below - asking the
// model whether each record is supported by its evidence - was built, measured, and NOT
// shipped, because on a controlled four-row test it got the two that mattered exactly
// backwards: it KEPT "Compute a firm decision on the mute aspect" (the garbled row) and
// DROPPED "Confirm the mute button behaviour and its effect on the flash" (the correct
// one), reasoning that the evidence said Andrew still needed to LOOK at the mute
// behaviour rather than that he would confirm it. Defensible reasoning, wrong outcome -
// and a pass that deletes correct content is far worse than one that leaves a bad row.
//
// It is kept here rather than deleted because the idea is sound and the failure is
// specific: the check needs a way to distinguish "the evidence describes an earlier stage
// of this work" from "the evidence does not support this at all". Anyone re-enabling it
// must first show it passes that four-row test.
//
// The deterministic rule below has no such problem: it needs no judgement, and it was
// verified live - "David Didsbury misinterpreted the software." is gone from the output.

const { clean } = require('./evidence');

const DEFAULT_URL = 'https://eu.router.trooper.ai/v1/chat/completions';
const DEFAULT_MODEL = 'gpt-4o-mini';
const ROWS_PER_CALL = 8;

// A named person's cognitive error is not minutes content, whatever the evidence says.
//
// "Or I misinterpreted the software" is a speaker walking back their own guess mid-
// conversation. Published as "David Didsbury misinterpreted the software." it is three
// things at once: inaccurate (he said he MIGHT have), unkind (it records a named person's
// mistake in a client document), and pointless (no decision, action or fact about the
// work). Deterministic because it needs no judgement - minutes record what was decided,
// done or established, never who misunderstood what.
//
// Uncertainty about the WORK is untouched: "There was uncertainty regarding the alarm LED
// behaviour" is real minutes content. The rule needs a person as the subject.
const PERSON_ERROR = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+(?:had\s+)?(?:misinterpreted|misunderstood|misread|got\s+(?:it|that)\s+wrong|was\s+(?:wrong|mistaken|incorrect)|had\s+misinterpreted)\b/;

function personErrorAssertion(value) {
  return PERSON_ERROR.test(clean(value));
}

function promptFor(rows) {
  return [
    '[CMD: task=claim_check; format=json]',
    'For each record below you are given the record as it would be published in meeting minutes, and the transcript evidence it was drawn from.',
    'Answer whether the evidence supports the record AS WRITTEN.',
    '',
    'Answer "unsupported" when ANY of these is true:',
    '  - the record states as fact something the speaker only wondered, suggested or hedged',
    '    ("I might have misinterpreted" is not "X misinterpreted");',
    '  - the record is an instruction but the evidence records no commitment or request;',
    '  - the record does not express a coherent task or fact. Judge the RECORD on its own',
    '    terms here, not whether its words appear in the evidence. A transcription error',
    '    copied faithfully is still nonsense: if the verb cannot take its object, or a',
    '    reader could not act on or understand the record without guessing what was meant,',
    '    it is unsupported EVEN THOUGH the same words appear in the transcript.',
    'Answer "supported" for everything else, including records that are merely terse or',
    'plainly worded. Being unpolished is not being unsupported.',
    '',
    'Return JSON only as {"checks":[{"index":0,"verdict":"supported"|"unsupported"}]}.',
    '',
    'RECORDS:',
    JSON.stringify(rows.map((row) => ({ index: row.index, record: row.text, evidence: row.evidence })))
  ].join('\n');
}

async function checkClaims(items, options = {}) {
  const rows = (Array.isArray(items) ? items : []).filter((item) => clean(item.text) && clean(item.evidence));
  const unsupported = new Set();
  if (!rows.length) return { unsupported, reason: '' };
  const apiKey = clean(options.apiKey ?? process.env.TROOPER_API_KEY);
  const fetchImpl = options.fetchImpl || fetch;
  if (!apiKey || typeof fetchImpl !== 'function') return { unsupported, reason: 'unavailable' };

  let reason = '';
  for (let at = 0; at < rows.length; at += ROWS_PER_CALL) {
    const chunk = rows.slice(at, at + ROWS_PER_CALL);
    try {
      const response = await fetchImpl(clean(options.url ?? process.env.TROOPER_CHAT_COMPLETIONS_URL) || DEFAULT_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: clean(options.model ?? process.env.TROOPER_MODEL) || DEFAULT_MODEL,
          messages: [
            { role: 'system', content: 'You check meeting-minute records against their transcript evidence. Return valid JSON only.' },
            { role: 'user', content: promptFor(chunk) }
          ],
          temperature: 0,
          max_tokens: 700,
          response_format: { type: 'json_object' }
        })
      });
      if (!response.ok) { reason = `http_${response.status}`; continue; }
      const body = await response.json();
      const content = body?.choices?.[0]?.message?.content;
      const output = typeof content === 'object' ? content : JSON.parse(String(content || '{}'));
      for (const check of Array.isArray(output?.checks) ? output.checks : []) {
        // Only an explicit "unsupported" removes anything. Anything else - a missing
        // verdict, an unexpected string, an index that was never sent - leaves the row.
        if (String(check?.verdict || '').toLowerCase() !== 'unsupported') continue;
        const index = Number(check?.index);
        if (Number.isInteger(index) && chunk.some((row) => row.index === index)) unsupported.add(index);
      }
    } catch (error) {
      reason = error?.message || 'request_failed';
    }
  }
  return { unsupported, reason };
}

module.exports = { checkClaims, personErrorAssertion, promptFor, PERSON_ERROR };
