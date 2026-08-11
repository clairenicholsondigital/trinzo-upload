'use strict';

function cleanIdentity(value) {
  return String(value || '').trim();
}

function stagedIdentityError(message) {
  const error = new Error(message);
  error.statusCode = 409;
  error.code = 'STAGED_TRANSCRIPT_IDENTITY_MISMATCH';
  return error;
}

function assertStagedTranscriptHash(expectedHash, actualHash, context = 'staged transcript') {
  const expected = cleanIdentity(expectedHash).toLowerCase();
  const actual = cleanIdentity(actualHash).toLowerCase();
  if (!expected) return;
  if (!actual || expected !== actual) {
    throw stagedIdentityError(
      `The ${context} does not match this draft. Start a new staged draft from the transcript upload step.`
    );
  }
}

function assertStagedSourceIdentity(requested = {}, source = {}) {
  const requestedDraftId = cleanIdentity(requested.draftId);
  const sourceDraftId = cleanIdentity(source.draftId);
  if (requestedDraftId && requestedDraftId !== sourceDraftId) {
    throw stagedIdentityError(
      'The selected source job belongs to a different staged draft. Start a new staged draft from the transcript upload step.'
    );
  }

  assertStagedTranscriptHash(
    requested.transcriptSha256,
    source.transcriptSha256,
    'selected source job transcript'
  );
}

module.exports = {
  assertStagedSourceIdentity,
  assertStagedTranscriptHash
};
