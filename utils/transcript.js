function extractTextFromUpload(file, mammoth) {
  const fileName = file.originalname || '';
  const mimeType = file.mimetype || '';

  if (fileName.toLowerCase().endsWith('.docx')) {
    return mammoth.extractRawText({ buffer: file.buffer }).then(result => ({
      fileName,
      mimeType,
      text: result.value || ''
    }));
  }

  if (fileName.toLowerCase().endsWith('.txt') || mimeType.startsWith('text/')) {
    return Promise.resolve({
      fileName,
      mimeType,
      text: file.buffer.toString('utf8')
    });
  }

  return Promise.resolve({
    fileName,
    mimeType,
    text: '[File received, but this starter only extracts .txt and .docx files.]'
  });
}

function chunkText(text, chunkSize) {
  const chunks = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  return chunks;
}

module.exports = {
  extractTextFromUpload,
  chunkText
};
