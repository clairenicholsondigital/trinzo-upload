'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const fetch = require('node-fetch');

const DEFAULT_MODEL = path.join(__dirname, '..', 'artifacts', 'meeting-minutes-usefulness-v3', 'classifier.joblib');
const DEFAULT_URL = 'https://eu.router.trooper.ai/v1/chat/completions';
const DEFAULT_TROOPER_MODEL = 'eu_liv_000099';
const preparedCache = new Map();

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function uniqueStrings(values, limit = 20) {
  const output = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const text = clean(value);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    output.push(text);
    if (output.length >= limit) break;
  }
  return output;
}

function assertTrooperConfigured(options = {}) {
  if (!clean(options.apiKey || process.env.TROOPER_API_KEY)) {
    throw new Error('TROOPER_API_KEY is not configured.');
  }
}

function spawnJson(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || path.join(__dirname, '..'),
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timeoutMs = Number(options.timeoutMs || 120000);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        const error = new Error(`MiniLM staged preparation failed (${code ?? signal}).`);
        error.details = stderr.slice(0, 2000);
        reject(error);
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        const wrapped = new Error('MiniLM staged preparation returned invalid JSON.');
        wrapped.details = stdout.slice(0, 2000);
        reject(wrapped);
      }
    });
  });
}

async function prepareTranscript(transcriptText, topics = [], options = {}) {
  const text = String(transcriptText || '');
  const topicList = uniqueStrings(topics, 8);
  const key = crypto.createHash('sha256').update(`${text}\n${JSON.stringify(topicList)}`).digest('hex');
  if (!options.skipCache && preparedCache.has(key)) return { ...preparedCache.get(key), cacheHit: true };
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'staged-simplified-'));
  const transcriptPath = path.join(tempDir, 'transcript.txt');
  try {
    await fs.writeFile(transcriptPath, text, 'utf8');
    const result = await spawnJson(
      process.env.PYTHON_BIN || 'python3',
      [
        path.join(__dirname, '..', 'scripts', 'staged_simplified_minilm.py'),
        transcriptPath,
        '--model', process.env.STAGED_SIMPLIFIED_MINILM_MODEL || DEFAULT_MODEL,
        '--topics-json', JSON.stringify(topicList),
        '--remove-threshold', String(process.env.STAGED_SIMPLIFIED_REMOVE_THRESHOLD || '0.85'),
        '--topic-threshold', String(process.env.STAGED_SIMPLIFIED_TOPIC_THRESHOLD || '0.25')
      ],
      { timeoutMs: Number(process.env.STAGED_SIMPLIFIED_MINILM_TIMEOUT_MS || 120000) }
    );
    const removedRatio = validatePreparedResult(result);
    const value = { ...result, removedRatio, cacheHit: false };
    if (!options.skipCache) {
      preparedCache.set(key, value);
      if (preparedCache.size > 24) preparedCache.delete(preparedCache.keys().next().value);
    }
    return value;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function validatePreparedResult(result = {}) {
  const removedRatio = Number(result.totalUnitCount || 0)
    ? Number(result.removedUnitCount || 0) / Number(result.totalUnitCount)
    : 1;
  if (!result.ok || Number(result.keptUnitCount || 0) < 3 || clean(result.preparedTranscript).length < 100 || removedRatio > 0.55) {
    const error = new Error(result.reason || 'MiniLM denoising failed its fail-open safety checks.');
    error.code = 'unsafe_denoising_result';
    error.details = { removedRatio, keptUnitCount: result.keptUnitCount || 0 };
    throw error;
  }
  return removedRatio;
}

function extractJson(content) {
  if (content && typeof content === 'object') return content;
  const text = String(content || '').replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

async function callTrooper(prompt, options = {}) {
  const apiKey = clean(options.apiKey || process.env.TROOPER_API_KEY);
  if (!apiKey) throw new Error('TROOPER_API_KEY is not configured.');
  const fetchImpl = options.fetchImpl || fetch;
  const controller = new AbortController();
  const timeoutMs = Number(options.timeoutMs || process.env.STAGED_SIMPLIFIED_TROOPER_TIMEOUT_MS || 120000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetchImpl(options.url || process.env.TROOPER_CHAT_COMPLETIONS_URL || DEFAULT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: options.model || process.env.TROOPER_MODEL || DEFAULT_TROOPER_MODEL,
        messages: [
          { role: 'system', content: 'You organise evidence-grounded meeting minutes. Return valid JSON only.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.1,
        max_tokens: Number(options.maxTokens || 1800),
        response_format: { type: 'json_object' }
      }),
      signal: controller.signal
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Trooper simplified staged request failed with status ${response.status}.`);
    const output = extractJson(body?.choices?.[0]?.message?.content);
    if (!output) throw new Error('Trooper simplified staged request returned invalid JSON.');
    return { output, usage: body.usage || null, timingMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}

function validTopic(value) {
  const text = clean(value).replace(/^\d+[.)]\s*/, '');
  if (!text || text.length > 100 || text.split(/\s+/).length > 14) return '';
  if (/\b(?:actions?|follow[- ]?ups?|next steps?|meeting logistics|introductions?|agenda|recap)\b/i.test(text)) return '';
  if (/^(?:general|administrative|miscellaneous|other)(?:\s|$)|\b(?:general updates?|administrative updates?|status updates?|key priorities|document mention|summary document mention)\b/i.test(text)) return '';
  return text.replace(/[.?!]+$/, '');
}

async function generateTopics(transcriptText, options = {}) {
  assertTrooperConfigured(options);
  const prepared = options.prepared || await prepareTranscript(transcriptText, [], options);
  const prompt = [
    'Identify 4 to 8 substantive workstream topics suitable as headings in an official meeting-minutes discussion table.',
    'Use the full denoised transcript. Consolidate related turns into one workstream, keep distinct technical/regulatory workstreams separate, and include threads developed across different parts of the meeting.',
    'Make the headings mutually distinct. Do not create two broad headings for the same change-control or documentation workstream; distinguish separate standards, verification, traceability, testing, risk, access-control and technical-record work only when the transcript supports them.',
    'Exclude greetings, logistics, demonstrations without substantive meaning, generic action recaps, and headings called Actions, Follow-ups or Next steps.',
    'Use concise subject headings, not sentences, decisions, actions, speaker names or transcript-specific quotations. Do not invent a topic.',
    'Return JSON only: {"topics":["..."]}.',
    '',
    'DENOISED TRANSCRIPT:',
    prepared.preparedTranscript
  ].join('\n');
  const call = await callTrooper(prompt, { ...options, maxTokens: 700 });
  const topics = uniqueStrings((call.output.topics || []).map(validTopic).filter(Boolean), 8);
  if (topics.length < 4) throw new Error(`Simplified topic generation returned ${topics.length} valid topics.`);
  return {
    topics,
    telemetry: {
      denoiser: denoiserTelemetry(prepared),
      topicCount: topics.length,
      calls: 1,
      tokenUsage: call.usage,
      timingMs: call.timingMs
    }
  };
}

function evidenceRows(prepared, topic) {
  const row = (prepared.evidenceByTopic || []).find((item) => clean(item.topic).toLowerCase() === clean(topic).toLowerCase());
  return Array.isArray(row?.evidence) ? row.evidence : [];
}

function discussionPrompt(topic, evidence) {
  return [
    `Write 1 to 3 concise formal meeting-minutes discussion points for the confirmed topic: ${topic}`,
    'Use only the supplied evidence. Combine evidence only when it concerns the same point.',
    'Preserve uncertainty, questions, disagreement, conditional reasoning and responsibility attribution. Never turn a possibility, proposed control, question or assumption into a confirmed fact.',
    'Do not create actions, decisions, owners, deadlines or safety conclusions. Do not copy transcript fragments, timestamps, filler, speaker narration or evidence IDs into the public text.',
    'Each point must cite one or more supplied evidence IDs. Return JSON only:',
    '{"discussionPoints":[{"text":"...","evidenceIds":["line_1_unit_0"]}]}',
    '',
    'EVIDENCE:',
    JSON.stringify(evidence)
  ].join('\n');
}

function discussionInventoryPrompt(evidence) {
  return [
    'Create a complete first-pass inventory of substantive discussion points from the supplied denoised transcript evidence.',
    'Do not group or categorise the points yet. A later step will do that without being allowed to remove them.',
    'Aim to represent every substantive evidence item in this chunk. Return separate points for distinct responsibilities, documents, systems, tests, decisions, questions or workstreams.',
    'Cover open work, current position, completed changes that matter to the record, decisions, dependencies, risks, uncertainty and material questions.',
    'Do not omit a substantive point merely because it does not fit another point. Combine only evidence about the same underlying matter.',
    'Write factual third-person meeting-minutes prose. Preserve uncertainty, questions, conditional reasoning and responsibility attribution exactly; do not upgrade them into facts.',
    'Do not create actions, deadlines or conclusions that are not stated.',
    'Exclude greetings, transcription notices, filler, meeting administration, thanks, farewells, jokes, metaphors, teasing and isolated fragments that do not describe substantive meeting work.',
    'Each point must cite one or more supplied evidence IDs. Return JSON only:',
    '{"discussionPoints":[{"text":"...","evidenceIds":["line_1_unit_0"]}]}',
    '',
    'DENOISED TRANSCRIPT EVIDENCE:',
    JSON.stringify(evidence)
  ].join('\n');
}

function inventoryChunks(units = [], maxRows = 28, maxChars = 7000) {
  const chunks = [];
  let current = [];
  let chars = 0;
  for (const unit of Array.isArray(units) ? units : []) {
    const size = clean(unit?.text).length + clean(unit?.speaker).length + 80;
    if (current.length && (current.length >= maxRows || chars + size > maxChars)) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(unit);
    chars += size;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function discussionGroupingPrompt(points) {
  return [
    'Organise the supplied factual meeting-minutes points into 4 to 10 useful, substantive topic groups.',
    'This is classification only: do not rewrite, merge, omit or invent any point. Assign every supplied point ID exactly once.',
    'Use concise concrete workstream headings. Consolidate related items, but keep materially different documents, systems, testing, risk, regulatory, usability and contractor work separate when supported.',
    'Do not use headings such as General, Status update, Key priorities, Mention, Actions, Follow-ups, Meeting administration or Miscellaneous.',
    'If a point is incidental or cannot responsibly be assigned, put its ID in unassignedPointIds instead of inventing a topic.',
    'Return JSON only:',
    '{"groups":[{"topic":"...","pointIds":["point_1"]}],"unassignedPointIds":["point_9"]}',
    '',
    'POINTS:',
    JSON.stringify(points)
  ].join('\n');
}

async function generateDiscussionInventory(transcriptText, options = {}) {
  assertTrooperConfigured(options);
  const prepared = options.prepared || await prepareTranscript(transcriptText, [], options);
  const chunks = inventoryChunks(prepared.units);
  if (!chunks.length) throw new Error('Simplified discussion inventory had no retained transcript evidence.');
  const calls = await Promise.all(chunks.map((evidence) => callTrooper(
    discussionInventoryPrompt(evidence),
    { ...options, maxTokens: 2400 }
  )));
  const points = [];
  const seenPoints = new Set();
  calls.forEach((call, callIndex) => {
    if (!Array.isArray(call.output.discussionPoints)) {
      throw new Error(`Malformed discussion inventory response returned for chunk ${callIndex + 1}.`);
    }
    const evidence = chunks[callIndex];
    for (const candidate of call.output.discussionPoints) {
      const text = cleanPublicDiscussionPoint(candidate?.text);
      const cited = citedEvidence(candidate, evidence);
      const pointKey = text.toLowerCase();
      if (!text || !cited.ids.length || seenPoints.has(pointKey)) continue;
      seenPoints.add(pointKey);
      points.push({ id: `point_${points.length + 1}`, text, evidenceIds: cited.ids });
    }
  });
  if (!seenPoints.size) throw new Error('Simplified discussion inventory returned no grounded points.');
  const groupingCall = await callTrooper(discussionGroupingPrompt(points.map(({ id, text }) => ({ id, text }))), { ...options, maxTokens: 1200 });
  if (!Array.isArray(groupingCall.output.groups)) throw new Error('Malformed discussion grouping response.');
  const pointById = new Map(points.map((point) => [point.id, point]));
  const assigned = new Set();
  const groups = [];
  for (const candidate of groupingCall.output.groups) {
    const topic = validTopic(candidate?.topic);
    if (!topic || /^unassigned$/i.test(topic)) continue;
    const groupedPoints = uniqueStrings(candidate?.pointIds, points.length)
      .filter((id) => pointById.has(id) && !assigned.has(id))
      .map((id) => { assigned.add(id); return pointById.get(id); });
    if (!groupedPoints.length) continue;
    groups.push({
      topic,
      points: groupedPoints.map((point) => point.text),
      topicId: crypto.createHash('sha1').update(topic).digest('hex').slice(0, 12),
      evidenceIds: uniqueStrings(groupedPoints.flatMap((point) => point.evidenceIds), 80),
      pointRefs: groupedPoints.map((point) => ({ evidenceIds: point.evidenceIds })),
      suggested: true
    });
  }
  const unassigned = points.filter((point) => !assigned.has(point.id));
  groups.push({
    topic: 'Unassigned',
    points: unassigned.map((point) => point.text),
    topicId: 'unassigned',
    evidenceIds: uniqueStrings(unassigned.flatMap((point) => point.evidenceIds), 80),
    pointRefs: unassigned.map((point) => ({ evidenceIds: point.evidenceIds })),
    suggested: false
  });
  const unassignedCount = unassigned.length;
  return {
    discussion: groups,
    organizer: {
      mode: 'discussion_first',
      pointCount: seenPoints.size,
      groupCount: groups.filter((card) => card.topic !== 'Unassigned').length,
      unassignedCount
    },
    telemetry: {
      denoiser: denoiserTelemetry(prepared),
      mode: 'discussion_inventory',
      retainedEvidenceCount: prepared.units.length,
      pointCount: seenPoints.size,
      groupCount: groups.length,
      unassignedCount,
      calls: calls.length + 1,
      perChunk: calls.map((call, index) => ({
        chunk: index + 1,
        evidenceCount: chunks[index].length,
        timingMs: call.timingMs,
        tokenUsage: call.usage || null
      })),
      grouping: { timingMs: groupingCall.timingMs, tokenUsage: groupingCall.usage || null },
      tokenUsage: [...calls.map((call) => call.usage), groupingCall.usage].filter(Boolean),
      timingMs: calls.reduce((sum, call) => sum + Number(call.timingMs || 0), 0) + Number(groupingCall.timingMs || 0)
    }
  };
}

function actionPrompt(topics, evidence) {
  return [
    'Read the complete denoised meeting transcript evidence and extract all explicit or strongly supported outstanding follow-up actions suitable for official meeting minutes.',
    'Scan the full evidence; do not rely on a closing recap or restrict retrieval to the reviewer topic groups.',
    'Identify action threads that develop across multiple turns or different parts of the meeting and combine related fragments into one clear action when the combined evidence supports the same follow-up.',
    'Treat repeated references, clarifications, dependencies, proposed next steps and later recaps as supporting evidence for the same action thread.',
    'Treat an unresolved prerequisite as an action when the discussion makes clear that a verification, review, investigation, documentation or other concrete step still needs to happen before work can be completed, even when phrased conversationally.',
    'Treat clearly ongoing work as an action when the evidence shows that a concrete deliverable or step remains to be completed.',
    'Before returning, audit every evidence row for current work, accepted proposals, requested follow-ups and unfinished concrete steps so that quieter workstreams are not omitted.',
    'Keep actions separate when owner, deliverable, verb, document, system, standard or deadline differs.',
    'When one person accepts a proposal and separately commits to follow up, return the proposer’s task and the follow-up as separate actions and cite all supporting turns.',
    'Do not turn completed-only history, rejected or unaccepted hypothetical suggestions, general discussion, speculative possibilities or meeting administration into actions.',
    'An action may be supported by a direct commitment, named assignment, accepted request or proposal, explicit action recap, clearly ongoing work, or a concrete unresolved prerequisite.',
    'Begin each action with a clear verb. Include an owner or deadline only when the cited evidence explicitly supports it; otherwise use Not stated.',
    'Each action must cite one or more supplied evidence IDs. Return JSON only:',
    '{"actions":[{"owner":"Not stated","action":"...","deadline":"Not stated","evidenceIds":["line_1_unit_0"]}]}',
    '',
    'REVIEWER TOPIC GROUPS (context only; they are not an exhaustive retrieval boundary):',
    JSON.stringify(uniqueStrings(topics, 24)),
    '',
    'EVIDENCE:',
    JSON.stringify(evidence)
  ].join('\n');
}

function citedEvidence(candidate, evidence) {
  const allowed = new Map(evidence.map((item) => [clean(item.id), item]));
  const ids = uniqueStrings(candidate?.evidenceIds, 12).map((id) => {
    if (allowed.has(id)) return id;
    const repaired = id.replace(/^(line_\d+)_(\d+)$/i, '$1_unit_$2');
    return allowed.has(repaired) ? repaired : '';
  }).filter(Boolean);
  return { ids, rows: ids.map((id) => allowed.get(id)) };
}

function normalisePerson(value) {
  return clean(value).toLowerCase().replace(/[^a-zà-öø-ÿ'’ -]/g, '');
}

function ownerIsSupported(owner, rows) {
  const proposed = normalisePerson(owner);
  if (!proposed || proposed === 'not stated') return proposed === 'not stated';
  if (proposed === 'all') {
    return rows.some((row) => /\bwe\s*(?:['’]ll|will|shall|need to|must|have to|are going to|are (?:currently )?(?:working|updating|preparing|reviewing|rewriting|finalising|resolving|progressing|completing|testing|developing|incorporating|converting|applying))\b/i.test(clean(row.text)));
  }
  const first = proposed.split(/\s+/)[0];
  const directlySupported = rows.some((row) => {
    const speaker = normalisePerson(row.speaker);
    const text = clean(row.text);
    if (speaker === proposed || speaker.split(/\s+/)[0] === first) {
      return /\b(?:i|we)\s*(?:['’]ll|will|shall|can|need to|must|have to|am going to|are going to|am (?:currently )?(?:working|updating|preparing|reviewing|rewriting|finalising|resolving|progressing|completing|testing|developing|incorporating|converting|applying|trying)|are (?:currently )?(?:working|updating|preparing|reviewing|rewriting|finalising|resolving|progressing|completing|testing|developing|incorporating|converting|applying|trying)|have (?:started|begun)|started|began)\b/i.test(text)
        || /\bshould\s+i\s+[a-z]/i.test(text);
    }
    return new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b\\s+(?:to|will|must|needs? to|can|is going to|is (?:currently )?(?:working|updating|preparing|reviewing|rewriting|finalising|resolving|progressing|completing|testing|developing|incorporating|converting|applying)|has (?:started|begun)|has (?:also )?been (?:working|updating|preparing|reviewing|rewriting|finalising|resolving|progressing|completing|testing|developing|incorporating|converting|applying|making)|was (?:working|updating|preparing|reviewing|rewriting|finalising|resolving|progressing|completing|testing|developing|incorporating|converting|applying))\\b`, 'i').test(text);
  });
  if (directlySupported) return true;
  const proposedByOwner = rows.some((row) => {
    const speaker = normalisePerson(row.speaker);
    return (speaker === proposed || speaker.split(/\s+/)[0] === first) && /\bshould\s+i\s+[a-z]/i.test(clean(row.text));
  });
  return proposedByOwner && rows.some((row) => /^(?:yes|yeah|yep|absolutely|correct|please do|do that|that(?:'s| is) fine)\b/i.test(clean(row.text)));
}

function actionCommitmentSupported(rows) {
  const directlySupported = rows.some((row) => {
    const text = clean(row.text);
    return /\b(?:I|we)\s*(?:['’]ll|will|shall|need to|must|have to|am going to|are going to)\b/i.test(text)
      || /\b[A-Z][A-Za-z'’.-]+\s+(?:to|will|shall|must|needs? to|is going to)\s+[a-z]/.test(text)
      || /\b(?:can|could|will|would)\s+you\s+[a-z]/i.test(text)
      || /\b(?:action|next step|follow[- ]?up)\b[^.!?]{0,100}\b(?:is|are|to|will|needs? to)\b/i.test(text)
      || /\b(?:I\s+am|I'm|we\s+are|we're|they're|she's|he's|[A-Z][A-Za-z'’.-]+\s+is)\s+(?:currently\s+)?(?:working|updating|preparing|reviewing|rewriting|finalising|resolving|progressing|completing|testing|developing|incorporating|converting|applying|trying)\b/i.test(text)
      || /\b(?:I|we|you|he|she|they|[A-Z][A-Za-z'’.-]+)\s+(?:am|are|is|was|were|have been|has been)\s+(?:also\s+|currently\s+)?(?:working|updating|preparing|reviewing|rewriting|finalising|resolving|progressing|completing|testing|developing|incorporating|converting|applying|trying|making)\b/i.test(text)
      || /\b(?:I|we|[A-Z][A-Za-z'’.-]+)\s+(?:have|has)\s+(?:started|begun)\b/i.test(text)
      || /\b(?:I|we|they|[A-Z][A-Za-z'’.-]+)\s+(?:started|began)\b/i.test(text)
      || /\b(?:still|further|additional|remaining)\b[^.!?]{0,100}\b(?:needs? to|must|requires?|to be)\b/i.test(text)
      || /\b(?:needs? to|must)\s+(?:happen|be (?:checked|verified|reviewed|investigated|documented|resolved|completed|finished|updated|tested|incorporated|converted|provided|shared))\b/i.test(text)
      || /^(?:yeah,?\s+)?(?:just\s+)?(?:send|share|check|review|verify|update|finish|complete|prepare|provide|put|follow up)\b/i.test(text)
      || /\bwork\s+in\s+progress\b/i.test(text);
  });
  if (directlySupported) return true;
  const hasProposal = rows.some((row) => /\b(?:should\s+i|shall\s+i|do\s+you\s+want\s+me\s+to)\s+[a-z]/i.test(clean(row.text)));
  const hasAcceptance = rows.some((row) => /^(?:yes|yeah|yep|absolutely|correct|please do|do that|that(?:'s| is) fine)\b/i.test(clean(row.text)));
  return hasProposal && hasAcceptance;
}

function publishableActionText(value) {
  const text = clean(value);
  if (!text || text.split(/\s+/).length < 3 || text.split(/\s+/).length > 32) return '';
  if (/^(?:just\s+)?(?:send|write)\s+(?:an?\s+)?(?:e-?mail|message)\.?$/i.test(text)) return '';
  if (/\b(?:track the actions?|review the meeting|schedule the (?:meeting|call)|add .* to the (?:meeting|call))\b/i.test(text)) return '';
  if (/\b(?:learn the languages?|put \d+ .* files? in|look at the languages?)\b/i.test(text)) return '';
  if (/(?:\b(?:and|or|to|that)\b|\bshould be)\.?$/i.test(text)) return '';
  return text;
}

function cleanPublicDiscussionPoint(value) {
  return clean(value)
    .replace(/\s*\[(?:line_\d+_unit_\d+)(?:\s*,\s*line_\d+_unit_\d+)*\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function deadlineIsSupported(deadline, rows) {
  const value = clean(deadline);
  if (!value || /^not stated$/i.test(value)) return true;
  const corpus = rows.map((row) => clean(row.text).toLowerCase()).join(' ');
  const exact = value.toLowerCase().replace(/^(?:by|on)\s+/, '');
  if (corpus.includes(exact)) return true;
  const tokens = exact.match(/\b(?:today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|\d{1,2}(?:st|nd|rd|th)?|january|february|march|april|may|june|july|august|september|october|november|december|20\d{2})\b/gi) || [];
  return tokens.length > 0 && tokens.every((token) => corpus.includes(token.toLowerCase()));
}

function actionTokens(value) {
  return new Set(clean(value).toLowerCase().match(/[a-z][a-z0-9'’-]{2,}/g) || []);
}

function duplicateAction(left, right) {
  const a = actionTokens(left.action);
  const b = actionTokens(right.action);
  if (!a.size || !b.size) return false;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  const evidenceOverlap = new Set(left.evidenceIds || []).size > 0
    && (right.evidenceIds || []).some((id) => (left.evidenceIds || []).includes(id));
  return (shared / Math.min(a.size, b.size) >= 0.7 || (evidenceOverlap && shared / Math.min(a.size, b.size) >= 0.35))
    && (left.owner === right.owner || left.owner === 'Not stated' || right.owner === 'Not stated');
}

function actionEvidenceChunks(evidence, size = 32, overlap = 8) {
  if (!Array.isArray(evidence) || !evidence.length) return [];
  if (evidence.length <= size) return [evidence];
  const chunks = [];
  const step = Math.max(1, size - overlap);
  for (let start = 0; start < evidence.length; start += step) {
    chunks.push(evidence.slice(start, start + size));
    if (start + size >= evidence.length) break;
  }
  return chunks;
}

async function generateDiscussion(transcriptText, topics, options = {}) {
  assertTrooperConfigured(options);
  const topicList = uniqueStrings(topics, 8);
  if (!topicList.length) throw new Error('Simplified discussion generation needs confirmed topics.');
  const prepared = options.prepared || await prepareTranscript(transcriptText, topicList, options);
  const calls = await Promise.all(topicList.map(async (topic) => {
    const evidence = evidenceRows(prepared, topic).slice(0, 40);
    const call = await callTrooper(discussionPrompt(topic, evidence), { ...options, maxTokens: 900 });
    if (!Array.isArray(call.output.discussionPoints)) {
      throw new Error(`Malformed discussion response returned for ${topic}.`);
    }
    const points = [];
    const pointRefs = [];
    for (const candidate of Array.isArray(call.output.discussionPoints) ? call.output.discussionPoints : []) {
      const text = cleanPublicDiscussionPoint(candidate?.text);
      const cited = citedEvidence(candidate, evidence);
      if (!text || !cited.ids.length) continue;
      points.push(text);
      pointRefs.push({ evidenceIds: cited.ids });
      if (points.length >= 3) break;
    }
    if (!points.length) throw new Error(`No grounded discussion points returned for ${topic}.`);
    return { topic, points, topicId: crypto.createHash('sha1').update(topic).digest('hex').slice(0, 12), evidenceIds: uniqueStrings(pointRefs.flatMap((item) => item.evidenceIds), 40), pointRefs, usage: call.usage, timingMs: call.timingMs };
  }));
  const discussion = calls.map(({ usage, timingMs, ...card }) => card).filter((card) => card.points.length);
  if (!discussion.length) throw new Error('Simplified discussion generation returned no grounded cards.');
  return {
    discussion,
    telemetry: {
      denoiser: denoiserTelemetry(prepared),
      topicCount: topicList.length,
      calls: calls.length,
      perTopic: calls.map((item) => ({
        topic: item.topic,
        success: true,
        evidenceCount: item.evidenceIds.length,
        outputCount: item.points.length,
        timingMs: item.timingMs,
        tokenUsage: item.usage || null
      })),
      tokenUsage: calls.map((item) => item.usage).filter(Boolean),
      timingMs: Math.max(0, ...calls.map((item) => Number(item.timingMs || 0)))
    }
  };
}

async function generateActions(transcriptText, topics, options = {}) {
  assertTrooperConfigured(options);
  const topicList = uniqueStrings(topics, 24);
  const prepared = options.prepared || await prepareTranscript(transcriptText, [], options);
  const evidence = Array.isArray(prepared.units) ? prepared.units.filter((unit) => clean(unit?.id) && clean(unit?.text)) : [];
  if (!evidence.length) throw new Error('Simplified action generation needs denoised transcript evidence.');

  // Reviewer groups help Trooper understand the meeting, but they must never hide an
  // action whose source point was omitted or placed in a different discussion group.
  // Overlapping chronological windows prevent long responses from silently dropping
  // workstreams near the end while preserving action threads that cross a boundary.
  const evidenceChunks = actionEvidenceChunks(evidence);
  const calls = await Promise.all(evidenceChunks.map(async (chunk, index) => {
    const call = await callTrooper(actionPrompt(topicList, chunk), { ...options, maxTokens: 1800 });
    if (!Array.isArray(call.output.actions)) throw new Error(`Malformed whole-transcript action response for evidence window ${index + 1}.`);
    return { ...call, evidence: chunk, index };
  }));

  const rejected = { invalidText: 0, missingEvidence: 0, unsupportedCommitment: 0 };
  const accepted = [];
  for (const call of calls) {
    for (const candidate of call.output.actions.slice(0, 40)) {
      const action = publishableActionText(clean(candidate?.action).replace(/[.]+$/, ''));
      if (!action) {
        rejected.invalidText += 1;
        continue;
      }
      const cited = citedEvidence(candidate, call.evidence);
      if (!cited.ids.length) {
        rejected.missingEvidence += 1;
        continue;
      }
      if (!actionCommitmentSupported(cited.rows)) {
        rejected.unsupportedCommitment += 1;
        continue;
      }
      const proposedOwner = clean(candidate.owner) || 'Not stated';
      const proposedDeadline = clean(candidate.deadline) || 'Not stated';
      accepted.push({
        owner: ownerIsSupported(proposedOwner, cited.rows) ? proposedOwner : 'Not stated',
        action: action.charAt(0).toUpperCase() + action.slice(1) + '.',
        deadline: deadlineIsSupported(proposedDeadline, cited.rows) ? proposedDeadline : 'Not stated',
        evidenceIds: cited.ids
      });
    }
  }
  const actions = [];
  for (const candidate of accepted) {
    const existing = actions.find((item) => duplicateAction(item, candidate));
    if (!existing) actions.push(candidate);
    else {
      existing.evidenceIds = uniqueStrings([...(existing.evidenceIds || []), ...(candidate.evidenceIds || [])], 20);
      if (existing.owner === 'Not stated' && candidate.owner !== 'Not stated') existing.owner = candidate.owner;
      if (existing.deadline === 'Not stated' && candidate.deadline !== 'Not stated') existing.deadline = candidate.deadline;
    }
  }
  return {
    actions: actions.map(({ owner, action, deadline }) => ({ owner, action, deadline })),
    telemetry: {
      denoiser: denoiserTelemetry(prepared),
      topicCount: topicList.length,
      mode: 'whole_transcript_action_sweep',
      calls: calls.length,
      actionCount: actions.length,
      evidenceCount: evidence.length,
      evidenceWindowCount: evidenceChunks.length,
      rawCandidateCount: calls.reduce((sum, item) => sum + item.output.actions.length, 0),
      acceptedCandidateCount: accepted.length,
      rejected,
      perWindow: calls.map((item) => ({
        window: item.index + 1,
        evidenceCount: item.evidence.length,
        rawCandidateCount: item.output.actions.length,
        timingMs: item.timingMs,
        tokenUsage: item.usage || null
      })),
      tokenUsage: calls.map((item) => item.usage).filter(Boolean),
      timingMs: Math.max(0, ...calls.map((item) => Number(item.timingMs || 0)))
    }
  };
}

function denoiserTelemetry(prepared) {
  return {
    used: true,
    model: prepared.model,
    embeddingModel: prepared.embeddingModel,
    counts: prepared.counts,
    totalUnitCount: prepared.totalUnitCount,
    keptUnitCount: prepared.keptUnitCount,
    removedUnitCount: prepared.removedUnitCount,
    removedRatio: prepared.removedRatio,
    rawLength: prepared.rawLength,
    preparedLength: prepared.preparedLength,
    cacheHit: Boolean(prepared.cacheHit)
  };
}

function clearPreparedCache() {
  preparedCache.clear();
}

module.exports = {
  prepareTranscript,
  generateTopics,
  generateDiscussion,
  generateDiscussionInventory,
  generateActions,
  ownerIsSupported,
  actionCommitmentSupported,
  publishableActionText,
  cleanPublicDiscussionPoint,
  deadlineIsSupported,
  duplicateAction,
  clearPreparedCache,
  _private: { callTrooper, validTopic, uniqueStrings, evidenceRows, validatePreparedResult, inventoryChunks, actionEvidenceChunks }
};
