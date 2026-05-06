require('dotenv').config();

const express = require('express');
const multer = require('multer');
const mammoth = require('mammoth');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const PORT = process.env.PORT || 3978;
const fetch = require('node-fetch');
app.use(express.json({ limit: '25mb' }));


app.get('/', (req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Trinzo meeting minutes test</title>
<style>
body { font-family: Arial, sans-serif; background: #0f172a; color: #fff; margin: 0; padding: 2rem; }
.container { max-width: 920px; margin: 0 auto; }
.card { background: #111827; border-radius: 18px; padding: 1.5rem; border: 1px solid #334155; }
h1 { margin-top: 0; }
p { color: #cbd5e1; line-height: 1.5; }
input[type=file] { width: 100%; margin: 1rem 0; padding: 0.8rem; background: #020617; border: 1px solid #334155; border-radius: 12px; color: #fff; }
button { background: #14b8a6; border: none; color: #04111d; padding: 0.9rem 1.2rem; border-radius: 12px; cursor: pointer; font-size: 1rem; font-weight: 700; margin-right: 0.5rem; margin-bottom: 0.5rem; }
button.secondary { background: #6366f1; color: #fff; }
button:disabled { opacity: 0.55; cursor: not-allowed; }
.status { margin-top: 1rem; color: #93c5fd; }
pre { background: #020617; padding: 1rem; border-radius: 12px; overflow-x: auto; white-space: pre-wrap; margin-top: 1rem; border: 1px solid #1e293b; }
.small { font-size: 0.9rem; color: #94a3b8; }
</style>
</head>
<body>
<div class="container">
  <div class="card">
    <h1>Trinzo meeting minutes test</h1>
    <p>Upload a Word or TXT transcript. Use “Extract text only” to test file parsing, or “Process with Trinzo Copilot” to send chunks to the agent.</p>

    <input type="file" id="fileInput" accept=".docx,.txt,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document" />

    <button onclick="extractOnly()">Extract text only</button>
    <button class="secondary" onclick="processMeeting()">Process with Trinzo Copilot</button>

    <div class="status" id="status"></div>
    <p class="small" id="meta"></p>
    <pre id="output"></pre>
  </div>
</div>

<script>
function getFileOrWarn() {
  const input = document.getElementById('fileInput');
  const status = document.getElementById('status');

  if (!input.files.length) {
    status.textContent = 'Choose a Word or TXT file first.';
    return null;
  }

  return input.files[0];
}

async function postFile(endpoint) {
  const file = getFileOrWarn();
  const status = document.getElementById('status');
  const output = document.getElementById('output');
  const meta = document.getElementById('meta');

  if (!file) return;

  const formData = new FormData();
  formData.append('file', file);

  status.textContent = endpoint === '/api/process-meeting'
    ? 'Processing with Trinzo Copilot. This can take a little while for long transcripts...'
    : 'Extracting text...';

  output.textContent = '';
  meta.textContent = 'File: ' + file.name + ' | Size: ' + file.size + ' bytes';

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      body: formData
    });

    const data = await response.json();

    status.textContent = response.ok ? 'Complete' : 'Failed';
    output.textContent = JSON.stringify(data, null, 2);
  } catch (error) {
    status.textContent = 'Request failed';
    output.textContent = String(error);
  }
}

function extractOnly() {
  postFile('/api/upload');
}

function processMeeting() {
  postFile('/api/process-meeting');
}
</script>
</body>
</html>`);
});


app.post('/api/messages', async (req, res) => {
  res.json({
    type: 'message',
    text: 'Hello from your VPS Microsoft 365 agent'
  });
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        ok: false,
        error: 'No file uploaded. Use form-data field name: file'
      });
    }

    const fileName = req.file.originalname || '';
    const mimeType = req.file.mimetype || '';
    let extractedText = '';

    if (fileName.toLowerCase().endsWith('.docx')) {
      const result = await mammoth.extractRawText({ buffer: req.file.buffer });
      extractedText = result.value || '';
    } else if (fileName.toLowerCase().endsWith('.txt') || mimeType.startsWith('text/')) {
      extractedText = req.file.buffer.toString('utf8');
    } else {
      extractedText = '[File received, but this starter only extracts .txt and .docx files.]';
    }

    res.json({
      ok: true,
      fileName,
      mimeType,
      sizeBytes: req.file.size,
      extractedTextPreview: extractedText.slice(0, 3000),
      extractedTextLength: extractedText.length
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      ok: false,
      error: error.message || 'Upload failed'
    });
  }
});
app.post('/api/copilot-ask', async (req, res) => {
  try {
    const prompt = req.body?.prompt;

    if (!prompt) {
      return res.status(400).json({
        ok: false,
        error: 'Missing prompt'
      });
    }

    const tokenResponse = await fetch(
      process.env.COPILOT_TOKEN_ENDPOINT,
      {
        method: 'GET'
      }
    );

    const tokenData = await tokenResponse.json();

    console.log('TOKEN RESPONSE');
    console.log(tokenData);

    return res.json({
      ok: true,
      tokenData
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});





app.post('/api/copilot-chat', async (req, res) => {
  try {
    const prompt = req.body?.prompt;

    if (!prompt) {
      return res.status(400).json({
        ok: false,
        error: 'Missing prompt'
      });
    }

    // STEP 1: GENERATE DIRECT LINE TOKEN USING SECRET
    const tokenResponse = await fetch(
      'https://europe.directline.botframework.com/v3/directline/tokens/generate',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.DIRECTLINE_SECRET}`
        }
      }
    );

    const tokenData = await tokenResponse.json();

    const token = tokenData.token;

    if (!token) {
      return res.status(500).json({
        ok: false,
        error: 'No token returned',
        tokenData
      });
    }

    const baseUrl =
      'https://europe.directline.botframework.com/v3/directline';

    // STEP 2: START CONVERSATION
    const startConversationResponse = await fetch(
      `${baseUrl}/conversations`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );

    const conversationData =
      await startConversationResponse.json();

    const conversationId =
      conversationData.conversationId;

    if (!conversationId) {
      return res.status(500).json({
        ok: false,
        error: 'No conversationId returned',
        conversationData
      });
    }

    // STEP 3: SEND MESSAGE
    const sendResponse = await fetch(
      `${baseUrl}/conversations/${conversationId}/activities`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          type: 'message',
          from: {
            id: 'trinzo-test-user'
          },
          text: prompt
        })
      }
    );

    const sendData = await sendResponse.json();

    // STEP 4: WAIT
    await new Promise(resolve => setTimeout(resolve, 9000));

    // STEP 5: GET ACTIVITIES
    const activitiesResponse = await fetch(
      `${baseUrl}/conversations/${conversationId}/activities`,
      {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );

    const activitiesData =
      await activitiesResponse.json();

    const botMessages =
      (activitiesData.activities || [])
        .filter(activity => {
          return (
            activity.type === 'message' &&
            activity.from &&
            activity.from.id !== 'trinzo-test-user' &&
            activity.text
          );
        })
        .map(activity => activity.text);

    return res.json({
      ok: true,
      conversationId,
      sendData,
      botMessages,
      activitiesData
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});



app.post('/api/process-meeting', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        ok: false,
        error: 'No file uploaded'
      });
    }

    const fileName = req.file.originalname || '';

    let transcriptText = '';

    if (fileName.toLowerCase().endsWith('.docx')) {
      const result = await mammoth.extractRawText({
        buffer: req.file.buffer
      });

      transcriptText = result.value || '';
    } else {
      transcriptText = req.file.buffer.toString('utf8');
    }

    if (!transcriptText.trim()) {
      return res.status(400).json({
        ok: false,
        error: 'No transcript text extracted'
      });
    }

    // CHUNKING
    const CHUNK_SIZE = 6000;

    const chunks = [];

    for (let i = 0; i < transcriptText.length; i += CHUNK_SIZE) {
      chunks.push(
        transcriptText.slice(i, i + CHUNK_SIZE)
      );
    }

    const allResponses = [];

    for (let i = 0; i < chunks.length; i++) {

      console.log(
        'Processing chunk',
        i + 1,
        'of',
        chunks.length,
        '| chars:',
        chunks[i].length
      );

      // GENERATE TOKEN
      const tokenResponse = await fetch(
        'https://europe.directline.botframework.com/v3/directline/tokens/generate',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.DIRECTLINE_SECRET}`
          }
        }
      );

      const tokenData = await tokenResponse.json();

      const token = tokenData.token;

      const baseUrl =
        'https://europe.directline.botframework.com/v3/directline';

      // START CONVERSATION
      const conversationResponse = await fetch(
        `${baseUrl}/conversations`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`
          }
        }
      );

      const conversationData =
        await conversationResponse.json();

      const conversationId =
        conversationData.conversationId;

      const prompt = `
You are extracting meeting minutes.

Return ONLY valid JSON.

Schema:
{
  "meetingTitle": "",
  "meetingDate": "",
  "meetingDescription": "",
  "meetingObjectives": [],
  "clientAttendees": [],
  "participantsTrinzo": [],
  "meetingItems": [
    {
      "itemTopic": "",
      "discussionPoints": []
    }
  ],
  "nextSteps": [
    {
      "meetingActionPoint": "",
      "meetingActionPointOwner": "",
      "meetingActionPointDeadline": ""
    }
  ]
}

Transcript chunk ${i + 1} of ${chunks.length}:

${chunks[i]}
`;

      // SEND MESSAGE
      await fetch(
        `${baseUrl}/conversations/${conversationId}/activities`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            type: 'message',
            from: {
              id: 'trinzo-meeting-parser'
            },
            text: prompt
          })
        }
      );

      // WAIT
      await new Promise(resolve => setTimeout(resolve, 9000));

      // GET REPLIES
      const activitiesResponse = await fetch(
        `${baseUrl}/conversations/${conversationId}/activities`,
        {
          headers: {
            Authorization: `Bearer ${token}`
          }
        }
      );

      const activitiesData =
        await activitiesResponse.json();

      const botMessages =
        (activitiesData.activities || [])
          .filter(activity => {
            return (
              activity.type === 'message' &&
              activity.from &&
              activity.from.id !== 'trinzo-meeting-parser' &&
              activity.text
            );
          })
          .map(activity => activity.text);

      allResponses.push({
        chunk: i + 1,
        response: botMessages
      });

      // COOL DOWN BETWEEN CHUNKS
      if (i < chunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 6000));
      }
    }

    return res.json({
      ok: true,
      fileName,
      chunkCount: chunks.length,
      responses: allResponses
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});


app.listen(PORT, '0.0.0.0', () => {
  console.log('Agent listening on port ' + PORT);
});
