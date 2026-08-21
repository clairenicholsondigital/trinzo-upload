'use strict';

function clean(value) {
  return String(value || '').replace(/&apos;/g, "'").replace(/\s+/g, ' ').trim();
}

const CLOCK_TIMESTAMP = String.raw`(?:\d{1,2}:)?\d{1,2}:\d{2}(?::\d{2})?`;
const VERBOSE_TEAMS_TIMESTAMP = String.raw`(?:(?:\d+\s+hours?\s+)?\d+\s+minutes?(?:\s+\d+\s+seconds?)?|\d+\s+seconds?)`;
const TEAMS_TIMESTAMP = String.raw`(?:${CLOCK_TIMESTAMP}|${VERBOSE_TEAMS_TIMESTAMP})(?:${CLOCK_TIMESTAMP})?`;

// The sentinel the rest of the pipeline already uses for an owner nobody
// claimed. Reusing it means an unattributed turn cannot become an action owner
// anywhere downstream without a new code path having to opt in.
const UNATTRIBUTED_SPEAKER = 'Not stated';

// A turn longer than this is currently discarded outright rather than split.
// Named so that coverage reporting can say a monologue was dropped instead of
// leaving the reader to wonder where it went.
const MAX_TURN_CHARS = 5000;

// Thresholds for recovering speech nobody labelled. Deliberately conservative:
// a passage must be long enough to be worth reading, carry several sentences,
// and average out at prose length rather than form-field length. Measured
// against the committed corpus these admit exactly one transcript — the
// undiarised recording — and leave the other 114 untouched.
const MIN_RECOVERABLE_SPEECH_CHARS = 200;
const MIN_SPEECH_TERMINATORS = 3;
const MAX_CHARS_PER_SENTENCE = 400;

// prepareEvidence splits turns into sentence events on this boundary; reused so
// an over-long recovered line breaks where a sentence actually ends.
const SENTENCE_BOUNDARY = /(?<=[.!?])(?:\s+|(?=[A-Z]))/;

// Teams renders some display names surname-first as "Last, First M" (optional
// middle initial). Normalise these generically to "First Last" so the same
// person is never presented in two forms — e.g. as a normalised attendee AND as
// a raw action owner in the owner dropdown. This is a general name-shape rule,
// not a per-person alias table.
function normaliseSpeakerName(name) {
  const value = clean(name);
  const surnameFirst = value.match(/^([A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+),\s*([A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+)(?:\s+[A-Z]\.?)?$/);
  return surnameFirst ? `${surnameFirst[2]} ${surnameFirst[1]}` : value;
}

// The speaker-header grammar, in one place. Exported so that diagnostics can
// measure how much of a transcript is header versus content using exactly the
// grammar the parser applies, rather than a copy that silently drifts from it.
function buildSpeakerHeaderPattern() {
  const speakerName = String.raw`(?:[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+\s*,\s*[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+(?:[ \t]+[A-Z])?|[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+(?:[ \t]+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+){0,3})`;
  return new RegExp(String.raw`(?:^|\n)[ \t]*(${speakerName})(?:[ \t]+|[ \t]*[-–][ \t]*|[ \t]*\n[ \t]*)(${TEAMS_TIMESTAMP})[ \t]*|(?:^|\n|(?<=[.!?]))[ \t]*(${speakerName}):[ \t]*`, 'gm');
}

const IGNORED_HEADERS = /^(?:date|location|duration|transcript|recording|meeting|speakers|attendees|decision confirmed)$/i;

// Document labels that open a line the same way a speaker handle does. Applied
// only to the unsupported-handle path below: widening the list the supported
// grammar uses would change transcripts that already parse, which belongs in
// its own change rather than riding along with this one.
const NON_SPEAKER_LINE_LABELS = /^(?:note|notes|action|actions|agenda|apologies|present|absent|summary|update|topic|decision|decisions|risk|risks|owner|deadline|next steps)$/i;

// Line-initial "handle: text" openings that the supported grammar above does
// not recognise — lowercase, dotted, underscored or numbered handles such as
// "priya.raman:", "tom_oneill:" or "SPEAKER_02:", optionally behind a
// timestamp. These are plausible speaker conventions, so the line almost
// certainly starts a new turn; we simply cannot say whose.
function buildUnsupportedHeaderPattern() {
  return new RegExp(String.raw`(?:^|\n)[ \t]*(?:${TEAMS_TIMESTAMP}[ \t]+)?([A-Za-z][A-Za-zÀ-ÖØ-öø-ÿ0-9'’._-]{0,39}):[ \t]+`, 'gm');
}

// A handle the supported grammar would have caught if it were a plain
// capitalised name, distinguished by a marker no English sentence opener
// carries: an internal dot or underscore, a digit, or being wholly lowercase.
function looksLikeUnsupportedSpeakerHandle(handle) {
  if (IGNORED_HEADERS.test(handle) || NON_SPEAKER_LINE_LABELS.test(handle)) return false;
  return /[._]/.test(handle) || /\d/.test(handle) || handle === handle.toLowerCase();
}

// The points at which the transcript changes speaker, in source order, each
// carrying the span of the header itself. Exported because measuring what the
// parser did not read means knowing exactly where it cut; a second copy of this
// logic would report coverage for a parser other than the one that ran.
function findSpeakerCuts(transcriptText) {
  const source = String(transcriptText || '').replace(/\r/g, '');
  const attributed = [...source.matchAll(buildSpeakerHeaderPattern())]
    .map((match) => ({ index: match.index, length: match[0].length, speakerName: clean(match[1] || match[3]), attributed: true }))
    .filter((match) => !IGNORED_HEADERS.test(match.speakerName));
  // Cut at unsupported headers too, so their text is never absorbed into the
  // previous speaker's turn. Wrong owner becomes blank owner: blank is honest.
  const unattributed = [...source.matchAll(buildUnsupportedHeaderPattern())]
    .filter((match) => looksLikeUnsupportedSpeakerHandle(match[1]))
    .map((match) => ({ index: match.index, length: match[0].length, speakerName: UNATTRIBUTED_SPEAKER, attributed: false }))
    .filter((candidate) => !attributed.some((match) => candidate.index < match.index + match.length && candidate.index >= match.index));
  return [...attributed, ...unattributed].sort((a, b) => a.index - b.index);
}

// Everything between one cut and the next becomes a turn, so unread content is
// never scattered: it is the passage before the first recognised speaker, or a
// monologue too long to keep.
function findUnreadRegions(transcriptText) {
  const source = String(transcriptText || '').replace(/\r/g, '');
  const cuts = findSpeakerCuts(source);
  const regions = [];
  const openingText = source.slice(0, cuts.length ? cuts[0].index : source.length);
  if (clean(openingText)) {
    regions.push({ kind: cuts.length ? 'before_first_speaker' : 'no_speakers_recognised', index: 0, text: openingText });
  }
  cuts.forEach((cut, index) => {
    const next = cuts[index + 1];
    const start = cut.index + cut.length;
    const text = source.slice(start, next ? next.index : source.length);
    if (clean(text).length > MAX_TURN_CHARS) regions.push({ kind: 'turn_too_long', index: start, speaker: cut.speakerName, text });
  });
  return regions;
}

// Does this passage read as speech nobody labelled, or as document furniture?
// The two are separated decisively by sentence punctuation. The undiarised
// recording in the corpus runs one terminator every 33 characters across 28KB;
// the structured minutes header that also goes unread has none at all in 374
// characters, and segmenting that into discussion would put "Meeting Title" and
// an attendee list into the minutes as things people said.
function looksLikeUnlabelledSpeech(text) {
  const value = clean(text);
  if (value.length < MIN_RECOVERABLE_SPEECH_CHARS) return false;
  const terminators = (value.match(/[.!?]/g) || []).length;
  if (terminators < MIN_SPEECH_TERMINATORS) return false;
  return value.length / terminators <= MAX_CHARS_PER_SENTENCE;
}

// Segmentation does not need to know who spoke. Sentences and utterances exist
// in the text whether or not anyone is named, so a recording with no diarisation
// still yields discussion — attributed to nobody, which is the honest answer.
// Source lines are kept as the unit because they carry the recorder's own
// segmentation; only a line past the turn limit is broken up further.
function recoverUnlabelledTurns(transcriptText) {
  const recovered = [];
  for (const region of findUnreadRegions(transcriptText)) {
    if (region.kind === 'turn_too_long') continue; // an attributed monologue, not unlabelled speech
    if (!looksLikeUnlabelledSpeech(region.text)) continue;
    for (const line of region.text.split('\n')) {
      const text = clean(line);
      if (!text) continue;
      if (text.length <= MAX_TURN_CHARS) { recovered.push(text); continue; }
      let buffer = '';
      for (const sentence of text.split(SENTENCE_BOUNDARY)) {
        if (buffer && `${buffer} ${sentence}`.length > MAX_TURN_CHARS) { recovered.push(buffer); buffer = ''; }
        buffer = buffer ? `${buffer} ${sentence}` : sentence;
      }
      if (buffer) recovered.push(buffer);
    }
  }
  return recovered.map((text) => ({ speaker: UNATTRIBUTED_SPEAKER, text, attributionConfidence: 0 }));
}

function parseTurns(transcriptText) {
  const turns = [];
  const source = String(transcriptText || '').replace(/\r/g, '');
  const matches = findSpeakerCuts(source);
  matches.forEach((match, index) => {
    const next = matches[index + 1];
    const text = clean(source.slice(match.index + match.length, next ? next.index : source.length));
    const speaker = match.attributed ? normaliseSpeakerName(match.speakerName) : UNATTRIBUTED_SPEAKER;
    // attributionConfidence is present only when attribution failed, so turns
    // the parser has always read correctly keep exactly the shape they had.
    if (text && text.length <= MAX_TURN_CHARS) turns.push({ id: `turn_${turns.length + 1}`, index: turns.length, speaker, text, ...(match.attributed ? {} : { attributionConfidence: 0 }) });
  });
  return turns;
}

function parseStructuredMinutes(transcriptText) {
  const source = String(transcriptText || '').replace(/\r/g, '');
  const participantMatch = source.match(/Participants\s+Trinzo:\s*([\s\S]*?)\n\s*Meeting Minutes\b/i);
  const participants = participantMatch
    ? participantMatch[1].split(/\n+/).map(clean).filter((line) => line && !/^(?:Client|Trinzo):?$/i.test(line) && !/\((?:absent|apologies)[^)]*\)/i.test(line))
      .filter((line) => /^[A-Z][A-Za-z'’.-]+(?:\s+[A-Z][A-Za-z'’.-]+){0,3}$/.test(line))
    : [];
  const actionSection = source.match(/Next steps\s+Actions\s+Owner\s+Deadline\s*([\s\S]*)$/i);
  if (!actionSection) return { participants, turns: [] };
  const compact = clean(actionSection[1]);
  const rowPattern = /(.+?)\s+([A-Z][A-Za-z'’.-]+(?:\/[A-Z][A-Za-z'’.-]+)*)\s+(\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)(?:\s+[‘’']?\d{2,4})?)(?=\s|$)/g;
  const turns = [];
  for (const match of compact.matchAll(rowPattern)) {
    const action = clean(match[1]);
    const deadline = clean(match[3]);
    if (!action || action.split(/\s+/).length > 40) continue;
    for (const ownerToken of match[2].split('/')) {
      const owner = ownerToken;
      const ownerPrefix = new RegExp(`^${ownerToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+to\\s+`, 'i');
      const actionText = action.replace(ownerPrefix, '');
      turns.push({ speaker: owner, text: `I will ${actionText} by ${deadline}.`, structuredSource: 'actions_owner_deadline_table' });
    }
  }
  return { participants, turns };
}

function sentenceRole(text) {
  const value = clean(text);
  const roles = [];
  if (/\b(?:i['’]?ll|i will|i can|i need to|can you|please|action|follow[- ]?up|owns? the|you['’]?re|my job is)\b/i.test(value) || /^(?:[A-Z][A-Za-z'’.-]+)\s+to\s+[a-z]/.test(value) || /\b(?:still not finalised|is still missing|document is absent|follow-up feedback is still pending)\b/i.test(value)) roles.push('action_candidate');
  const decisionLanguage = /\b(?:decid(?:e|ed|ing)|decision|agreed|approved|confirmed|we go with|we stay with|release stays|no further testing)\b/i.test(value);
  const descriptiveApproval = /\b(?:latest|previously|already)\s+approved\s+(?:versions?|documents?|references?|plans?)\b/i.test(value) && !/\b(?:decision|agreed|confirmed|we approved)\b/i.test(value);
  if (decisionLanguage && !descriptiveApproval) roles.push('decision_candidate');
  if (/\b(?:risk|dependency|depends on|blocker|if .* (?:slip|lapse|fail|drop|exceed|miss)|watch item|not-secure warning|connection (?:dies|drops)|dead air|overrun)\b/i.test(value)) roles.push('risk_candidate');
  if (/\b(?:already|completed|finished|closed|sent .* yesterday|signed .* yesterday|done and dusted)\b/i.test(value)) roles.push('completed_history');
  if (/\b(?:might|maybe|could consider|if we have time|if legal|potential future|haven['’]?t approved|we should)\b/i.test(value)) roles.push('hypothetical');
  if (/\b(?:no action|cancelled|rejected|not going to|instead)\b/i.test(value)) roles.push('negative_or_superseding');
  return roles;
}

function prepareEvidence(transcriptText) {
  const parsedTurns = parseTurns(transcriptText);
  // Fallback only, and unreachable for any transcript the parser already reads:
  // a region qualifies only if the header grammar found nothing there and the
  // text reads as speech. Recovered speech always precedes the first recognised
  // speaker, so it goes first and source order is preserved.
  const recoveredTurns = recoverUnlabelledTurns(transcriptText);
  const structured = parseStructuredMinutes(transcriptText);
  const turns = [...recoveredTurns, ...parsedTurns, ...structured.turns].map((turn, index) => ({ ...turn, id: `turn_${index + 1}`, index }));
  const invalidSpeakers = /^(?:yes|yeah|right|same|also|okay|great|no|well|and|client|trinzo|speakers|participants|attendees|not stated)$/i;
  const participants = [...new Set([...structured.participants, ...turns.filter((turn) => !turn.structuredSource).map((turn) => turn.speaker)].filter((name) => !invalidSpeakers.test(name)))];
  const events = [];
  for (const turn of turns) {
    const sentences = turn.text.split(/(?<=[.!?])(?:\s+|(?=[A-Z]))/).map(clean).filter(Boolean);
    sentences.forEach((text, sentenceIndex) => events.push({
      id: `evt_${String(events.length + 1).padStart(4, '0')}`,
      turnId: turn.id,
      turnIndex: turn.index,
      sentenceIndex,
      speaker: turn.speaker,
      text,
      roles: sentenceRole(text),
      structuredSource: turn.structuredSource || null,
      ...(turn.attributionConfidence === 0 ? { attributionConfidence: 0 } : {})
    }));
  }
  events.forEach((event, index) => {
    event.previousText = index > 0 ? events[index - 1].text : '';
    event.nextText = index + 1 < events.length ? events[index + 1].text : '';
    event.contextText = `[PREVIOUS]\n${event.previousText}\n[CURRENT]\n${event.text}\n[NEXT]\n${event.nextText}`;
  });
  return { turns, participants, events };
}

module.exports = { clean, normaliseSpeakerName, buildSpeakerHeaderPattern, findSpeakerCuts, findUnreadRegions, looksLikeUnlabelledSpeech, recoverUnlabelledTurns, MAX_TURN_CHARS, UNATTRIBUTED_SPEAKER, parseTurns, parseStructuredMinutes, prepareEvidence };
