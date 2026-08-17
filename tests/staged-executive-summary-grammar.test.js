'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  polishExecutiveSummaryGrammar,
  validateGrammarRevision,
  fallbackMinutesReadySummary,
  transcriptShapedSummaryIssue
} = require('../utils/stagedExecutiveSummaryGrammar');

function trooperResponse(revisedText, inspectRequest) {
  return async (_url, request) => {
    if (inspectRequest) inspectRequest(JSON.parse(request.body));
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ revisedText }) } }]
      })
    };
  };
}

test('grammar-only polishing accepts a conservative English correction', async () => {
  const original = 'The client were not keen to to share the label, but a snapshot was retained.';
  const revised = 'The client was not keen to share the label, but a snapshot was retained.';
  let requestBody;
  const result = await polishExecutiveSummaryGrammar(original, {
    apiKey: 'test-key', model: 'test-model', url: 'https://example.invalid',
    fetchImpl: trooperResponse(revised, (body) => { requestBody = body; })
  });
  assert.equal(result.used, true);
  assert.equal(result.text, revised);
  assert.equal(requestBody.temperature, 0);
  assert.match(requestBody.messages[1].content, /grammar, punctuation, duplicated words/);
  assert.doesNotMatch(requestBody.messages[1].content, /\[TRANSCRIPT\]/);
});

test('grammar polishing rejects newly introduced facts and retains the original', async () => {
  const original = 'The label evidence remained outstanding for the client.';
  const revised = 'The label evidence remained outstanding for 12 client markets.';
  const result = await polishExecutiveSummaryGrammar(original, {
    apiKey: 'test-key', model: 'test-model', url: 'https://example.invalid',
    fetchImpl: trooperResponse(revised)
  });
  assert.equal(result.used, false);
  assert.equal(result.reason, 'new_protected_fact');
  assert.equal(result.text, original);
});

test('grammar validation rejects a substantive rewrite', () => {
  const result = validateGrammarRevision(
    'The country and language evidence was needed to assess translation and market requirements.',
    'The programme was approved and all work was completed successfully.'
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'meaning_changed');
});

test('grammar validation accepts cleanup of transcript-like executive-summary prose', () => {
  const original = 'Align internally on the client call, outstanding information gaps and next working sessions. Country and language evidence was needed to assess translation, label and market requirements. Because a lot of these company authorities will have their own databases, and so there will be information that needs to be submitted to health authorities. Obviously, that depends onhow big a customer is, or the network that you are selling to, what their demands are. Call they were not too keen to send them to to share them with us, but I had taken a snapshot of the label.';
  const revised = 'Internal alignment was required on the client call, outstanding information gaps and next working sessions. Country and language evidence was needed to assess translation, label and market requirements. Many company authorities have their own databases, so information will need to be submitted to health authorities. The requirements depend on the size of the customer or sales network and their demands. The client was not keen to share the materials, but a snapshot of the label had been taken.';
  const result = validateGrammarRevision(original, revised);
  assert.equal(result.ok, true);
  assert.ok(result.overlap >= 0.62);
});

test('grammar validation rejects transcript-shaped executive summary after copy edit', () => {
  const text = 'Align internally on the client call, outstanding information gaps, and next working sessions. Obviously, that depends on how big a customer is or the network you are selling to, and what their demands are. They were not too keen to send them to share with us, but I have taken a snapshot of the label.';
  const result = validateGrammarRevision(text, text);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'conversational_filler');
  assert.equal(transcriptShapedSummaryIssue(text), 'conversational_filler');
});

test('fallback minutes-ready summary hides unsafe transcript fragments', () => {
  const original = 'Align internally on the client call, outstanding information gaps, and next working sessions. Country and language evidence was needed to assess translation, labelling, and market requirements. Because many of these company authorities will have their own databases, there will be information that needs to be submitted to health authorities. Obviously, that depends on how big a customer is or the network you are selling to, and what their demands are. They were not too keen to send them to share with us, but I have taken a snapshot of the label.';
  const fallback = fallbackMinutesReadySummary(original);
  assert.match(fallback, /Align internally on the client call/);
  assert.match(fallback, /Country and language evidence was needed/);
  assert.match(fallback, /many of these company authorities will have their own databases/);
  assert.doesNotMatch(fallback, /\bObviously\b|\byou\b|\bI\b|to to|share with us/i);
});

test('polishing falls back if Trooper returns transcript-shaped prose', async () => {
  const original = 'Align internally on the client call, outstanding information gaps, and next working sessions. Obviously, that depends on how big a customer is or the network you are selling to, and what their demands are. They were not too keen to send them to share with us, but I have taken a snapshot of the label.';
  const result = await polishExecutiveSummaryGrammar(original, {
    apiKey: 'test-key', model: 'test-model', url: 'https://example.invalid',
    fetchImpl: trooperResponse(original)
  });
  assert.equal(result.used, false);
  assert.equal(result.reason, 'deterministic_conversational_filler');
  assert.doesNotMatch(result.text, /\bObviously\b|\byou\b|\bI\b|share with us/i);
});

test('grammar polishing fails open when the isolated call is unavailable', async () => {
  const original = 'The client were reviewing the label.';
  const result = await polishExecutiveSummaryGrammar(original, { apiKey: '' });
  assert.equal(result.used, false);
  assert.equal(result.reason, 'unavailable');
  assert.equal(result.text, original);
});
