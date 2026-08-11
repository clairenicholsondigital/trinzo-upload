const assert = require('node:assert/strict');
const test = require('node:test');

const {
  assertStagedSourceIdentity,
  assertStagedTranscriptHash
} = require('../utils/stagedIdentity');

test('accepts a source job from the same draft and transcript', () => {
  assert.doesNotThrow(() => assertStagedSourceIdentity(
    { draftId: 'abbott-draft', transcriptSha256: 'abbott-hash' },
    { draftId: 'abbott-draft', transcriptSha256: 'abbott-hash' }
  ));
});

test('rejects an Eakin source job attached to an Abbott draft', () => {
  assert.throws(
    () => assertStagedSourceIdentity(
      { draftId: 'abbott-draft', transcriptSha256: 'abbott-hash' },
      { draftId: 'eakin-draft', transcriptSha256: 'eakin-hash' }
    ),
    (error) => error.statusCode === 409 && error.code === 'STAGED_TRANSCRIPT_IDENTITY_MISMATCH'
  );
});

test('rejects a different transcript reused under the same draft id', () => {
  assert.throws(
    () => assertStagedSourceIdentity(
      { draftId: 'reused-draft', transcriptSha256: 'abbott-hash' },
      { draftId: 'reused-draft', transcriptSha256: 'eakin-hash' }
    ),
    (error) => error.statusCode === 409 && error.code === 'STAGED_TRANSCRIPT_IDENTITY_MISMATCH'
  );
});

test('rejects a queued job whose stored transcript differs from its input fingerprint', () => {
  assert.throws(
    () => assertStagedTranscriptHash('eakin-hash', 'abbott-hash', 'queued job transcript'),
    (error) => error.statusCode === 409 && error.code === 'STAGED_TRANSCRIPT_IDENTITY_MISMATCH'
  );
});
