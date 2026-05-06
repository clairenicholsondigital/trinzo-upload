function extractTextFromUpload(file, mammoth) {
  const fileName = file.originalname || '';
  const mimeType = file.mimetype || '';
  const lowered = fileName.toLowerCase();

  if (lowered.endsWith('.docx')) {
    return mammoth.extractRawText({ buffer: file.buffer }).then((result) => ({
      fileName,
      mimeType,
      text: result.value || '',
      unsupported: false
    }));
  }

  if (lowered.endsWith('.txt') || mimeType.startsWith('text/')) {
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

module.exports = {
  extractTextFromUpload
};
