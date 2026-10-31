const crypto = require('crypto');

const MAX_TRANSCRIPT_CHARS = 2 * 1024 * 1024;

function extractTextFromUpload(file, mammoth) {
  const fileName = file.originalname || '';
  const mimeType = file.mimetype || '';
  const lowered = fileName.toLowerCase();

  if (lowered.endsWith('.docx')) {
    return mammoth.extractRawText({ buffer: file.buffer }).then(
      (result) => ({
        fileName,
        mimeType,
        text: result.value || '',
        unsupported: false
      }),
      () => {
        const error = new Error('Could not read this .docx file. It may be corrupted or in an unsupported format.');
        error.statusCode = 400;
        throw error;
      }
    );
  }

  if (lowered.endsWith('.txt') || lowered.endsWith('.csv') || mimeType.startsWith('text/')) {
    return Promise.resolve({
      fileName,
      mimeType,
      text: file.buffer.toString('utf8'),
      unsupported: false
    });
  }

  return Promise.resolve({
    fileName,
    mimeType,
    text: '',
    unsupported: true
  });
}

function validateTranscriptText(text) {
  if (!text || !text.trim()) {
    const error = new Error('Transcript text is empty. Paste text or upload a non-empty transcript file.');
    error.statusCode = 400;
    throw error;
  }

  if (text.length > MAX_TRANSCRIPT_CHARS) {
    const error = new Error(`Transcript is too large. Maximum supported text length is ${MAX_TRANSCRIPT_CHARS} characters.`);
    error.statusCode = 413;
    throw error;
  }
}

function transcriptMetadata(text) {
  return {
    transcriptLength: text.length,
    transcriptSha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
  };
}

module.exports = {
  extractTextFromUpload,
  validateTranscriptText,
  transcriptMetadata
};
