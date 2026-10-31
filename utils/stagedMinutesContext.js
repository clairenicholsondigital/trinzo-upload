'use strict';

const { isMalformedStagedLine } = require('./stagedEditorial');
const { knownPersonName, normaliseDirectoryNameSpellings } = require('./entityNormalization');
const { applyTranscriptPhraseCorrections } = require('./domainTerms');
const settingsStore = require('./settingsStore');

function stagedKnownAttendeeKey(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’‘`]/g, "'")
    .replace(/[^a-z'\s-]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// The known people come from the Settings page People list (see
// utils/settingsStore.js). The lookups below are rebuilt whenever that list
// changes.
let stagedPeopleRegistryCache = { version: -1 };

function stagedPeopleRegistry() {
  const version = settingsStore.version();
  if (stagedPeopleRegistryCache.version === version) return stagedPeopleRegistryCache;
  const people = settingsStore.getPeople();
  const bucketByName = new Map(people.map((person) => [
    stagedKnownAttendeeKey(person.name),
    { bucket: person.side === 'client' ? 'client' : 'internal', name: person.name }
  ]));
  const personByFirstName = new Map();
  for (const person of people) {
    const firstName = stagedKnownAttendeeKey(person.name).split(/\s+/)[0];
    if (!firstName) continue;
    personByFirstName.set(firstName, personByFirstName.has(firstName) ? null : person.name);
  }
  // Speaker labels are rewritten silently through these aliases. A spelling
  // that keeps the person's first name ("Rebecca Cuckoo") is left to the
  // first-name correction instead, which tells the reviewer what was changed.
  const aliases = new Map();
  for (const person of people) {
    const firstName = stagedKnownAttendeeKey(person.name).split(/\s+/)[0];
    for (const spelling of person.spellings || []) {
      const spellingKey = stagedKnownAttendeeKey(spelling);
      if (spellingKey.split(/\s+/)[0] === firstName) continue;
      aliases.set(spellingKey, person.name);
    }
  }
  stagedPeopleRegistryCache = { version, bucketByName, personByFirstName, aliases };
  return stagedPeopleRegistryCache;
}

function canonicalStagedAttendeeAlias(value) {
  const cleaned = String(value || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  return stagedPeopleRegistry().aliases.get(stagedKnownAttendeeKey(cleaned)) || cleaned;
}

function normaliseStagedKnownAttendeeAliasesInText(value) {
  // Every transcript entry point runs through here, so confirmed phrase
  // corrections reach the models, the denoiser and the evidence panel alike.
  return applyTranscriptPhraseCorrections(normaliseDirectoryNameSpellings(String(value || ''))).text;
}

function canonicalKnownStagedPersonName(value) {
  const cleaned = cleanStagedGeneratedLine(canonicalStagedAttendeeAlias(value || ''));
  if (!cleaned) return '';
  // Other spellings, misspellings and "Surname, First" forms of the people on the
  // Settings page People list resolve to their proper name, so they land in the
  // right bucket rather than unresolved.
  const listed = knownPersonName(cleaned);
  if (listed) return listed;
  const exact = stagedPeopleRegistry().bucketByName.get(stagedKnownAttendeeKey(cleaned));
  if (exact?.name) return exact.name;
  if (/^[A-Za-zÀ-ÖØ-öø-ÿ'’.-]+$/.test(cleaned)) {
    const byFirstName = stagedPeopleRegistry().personByFirstName.get(stagedKnownAttendeeKey(cleaned));
    if (byFirstName) return byFirstName;
  }
  // A transcription that gets the first name right and invents the surname.
  //
  // Teams wrote "Rebecca Cuckoo" 388 times across this corpus where the attendee is
  // Rebecca Gill, and the existing check only WARNED about it
  // (possible_attendee_name_mismatch) - the correction was detected and never applied, so
  // the invented surname travelled into owners, discussion prose and the final document.
  // The first name is the anchor and the known-people registry is the authority.
  //
  // The ambiguity guard is already built into that registry: it stores null when two known
  // people share a first name, so a shared first name resolves to nothing and the
  // transcript's own spelling stands rather than one person being renamed into another.
  const parts = stagedKnownAttendeeKey(cleaned).split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    const byFirstName = stagedPeopleRegistry().personByFirstName.get(parts[0]);
    if (byFirstName) return byFirstName;
  }
  return cleaned;
}

const TEAMS_PERSON_NAME_PATTERN = "[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+(?:\\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+){1,4}";

const TEAMS_CLOCK_TIMESTAMP_PATTERN = "(?:\\d{1,2}:)?\\d{1,2}:\\d{2}";

const TEAMS_VERBOSE_TIMESTAMP_PATTERN = "(?:(?:\\d+\\s+hours?\\s+)?\\d+\\s+minutes?(?:\\s+\\d+\\s+seconds?)?|\\d+\\s+seconds?)";

const TEAMS_TIMESTAMP_PATTERN = `(?:${TEAMS_CLOCK_TIMESTAMP_PATTERN}|${TEAMS_VERBOSE_TIMESTAMP_PATTERN})(?:${TEAMS_CLOCK_TIMESTAMP_PATTERN})?`;

const TEAMS_HEADER_DATE_PATTERN = "\\b(?:20\\d{6}|20\\d{2}[-/]\\d{1,2}[-/]\\d{1,2}|\\d{1,2}[/-]\\d{1,2}[/-]20\\d{2}|\\d{1,2}\\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\\s+20\\d{2})\\b";

function buildPreparedTranscriptForStagedAI(text) {
  const phraseCorrections = applyTranscriptPhraseCorrections(text).applied;
  if (phraseCorrections.length) console.log(JSON.stringify({
    event: 'meeting_agent_transcript_phrase_corrections', corrections: phraseCorrections
  }));
  const raw = normaliseStagedKnownAttendeeAliasesInText(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = raw.split('\n');
  const prepared = [];
  const removedReasons = {
    teamsHeader: 0,
    transcriptionEvent: 0,
    blankLine: 0,
    timestampOnly: 0
  };
  const turnLinePattern = new RegExp(`^\\s*(${TEAMS_PERSON_NAME_PATTERN})\\s+(${TEAMS_TIMESTAMP_PATTERN})\\s*(.*)$`, 'i');
  const eventLinePattern = new RegExp(`^\\s*${TEAMS_PERSON_NAME_PATTERN}\\s+(?:started|stopped)\\s+transcription\\b`, 'i');

  lines.forEach((line, index) => {
    const trimmed = String(line || '').trim();
    if (!trimmed) {
      removedReasons.blankLine += 1;
      return;
    }

    if (index < 8) {
      if (/\b(?:meeting transcript|transcript|recording)\b/i.test(trimmed)) {
        removedReasons.teamsHeader += 1;
        return;
      }
      if (new RegExp(TEAMS_HEADER_DATE_PATTERN, 'i').test(trimmed)) {
        removedReasons.teamsHeader += 1;
        return;
      }
      if (/^\d+\s*(?:h|hr|hrs|hour|hours|m|min|mins|minute|minutes)(?:\s+\d+\s*(?:m|min|mins|s|sec|secs|second|seconds))?$/i.test(trimmed)) {
        removedReasons.teamsHeader += 1;
        return;
      }
    }

    if (eventLinePattern.test(trimmed)) {
      removedReasons.transcriptionEvent += 1;
      return;
    }

    if (new RegExp(`^${TEAMS_TIMESTAMP_PATTERN}$`, 'i').test(trimmed)) {
      removedReasons.timestampOnly += 1;
      return;
    }

    const turnMatch = trimmed.match(turnLinePattern);
    if (turnMatch) {
      const speaker = canonicalStagedAttendeeAlias(turnMatch[1]).replace(/\s+/g, ' ').trim();
      const spoken = String(turnMatch[3] || '').replace(/\s+/g, ' ').trim();
      prepared.push(spoken ? `${speaker}: ${spoken}` : `${speaker}:`);
      return;
    }

    prepared.push(trimmed.replace(/\s+/g, ' '));
  });

  const preparedText = prepared.join('\n').trim();
  const removedLineCount = Object.values(removedReasons).reduce((sum, value) => sum + value, 0);
  return {
    text: preparedText || raw.trim(),
    rawLength: raw.length,
    preparedLength: preparedText.length || raw.trim().length,
    removedLineCount,
    removedReasons
  };
}

function cleanStagedGeneratedLine(value) {
  return capitaliseStagedDateMonths(String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/^[-*]\s*/, '')
    .trim());
}

const STAGED_PUBLIC_TIMESTAMP_PATTERN = '(?:\\d{1,2}:)?\\d{1,2}[:.]\\d{2}(?::\\d{2})?';

const STAGED_PUBLIC_SPEAKER_PATTERN = "[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]*,?(?:\\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]*,?){0,5}";

const STAGED_MONTH_NAMES = {
  january: 'January',
  february: 'February',
  march: 'March',
  april: 'April',
  may: 'May',
  june: 'June',
  july: 'July',
  august: 'August',
  september: 'September',
  october: 'October',
  november: 'November',
  december: 'December'
};

function capitaliseStagedDateMonths(value) {
  return String(value || '').replace(
    /\b(\d{1,2})(st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december)\b/ig,
    (match, day, suffix, month) => `${day}${suffix || ''} ${STAGED_MONTH_NAMES[String(month).toLowerCase()] || month}`
  );
}

function hasStagedSpeakerTurnPrefix(value) {
  const text = cleanStagedGeneratedLine(value);
  if (!text) return false;
  return [
    new RegExp(`^\\s*${STAGED_PUBLIC_SPEAKER_PATTERN}\\s*:\\s*`, 'u'),
    new RegExp(`^\\s*${STAGED_PUBLIC_SPEAKER_PATTERN}\\s+${STAGED_PUBLIC_TIMESTAMP_PATTERN}\\s*:?\\s*`, 'u'),
    new RegExp(`^\\s*${STAGED_PUBLIC_TIMESTAMP_PATTERN}\\s+${STAGED_PUBLIC_SPEAKER_PATTERN}\\s*:?\\s*`, 'u')
  ].some((pattern) => pattern.test(text));
}

function stripStagedTranscriptArtefacts(value) {
  let text = cleanStagedGeneratedLine(value)
    .replace(new RegExp(`(?:\\[\\s*${STAGED_PUBLIC_TIMESTAMP_PATTERN}\\s*\\]|\\(\\s*${STAGED_PUBLIC_TIMESTAMP_PATTERN}\\s*\\))`, 'g'), ' ');
  if (!text) return '';
  for (let index = 0; index < 3; index += 1) {
    text = text
      .replace(new RegExp(`^\\s*${STAGED_PUBLIC_SPEAKER_PATTERN}\\s*:\\s*`, 'u'), '')
      .replace(new RegExp(`^\\s*${STAGED_PUBLIC_SPEAKER_PATTERN}\\s+${STAGED_PUBLIC_TIMESTAMP_PATTERN}\\s*:?\\s*`, 'u'), '')
      .replace(new RegExp(`^\\s*${STAGED_PUBLIC_TIMESTAMP_PATTERN}\\s+${STAGED_PUBLIC_SPEAKER_PATTERN}\\s*:?\\s*`, 'u'), '')
      .replace(new RegExp(`^\\s*${STAGED_PUBLIC_TIMESTAMP_PATTERN}\\s*:?\\s*`, 'u'), '')
      .replace(/([.!?])(?=[A-Z])/g, '$1 ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return text.replace(/^([a-z])/, (match) => match.toUpperCase());
}

function cleanStagedDiscussionText(value) {
  if (hasStagedSpeakerTurnPrefix(value)) return '';
  return stripStagedTranscriptArtefacts(value)
    .replace(/\bNo specific discussion points were explicitly detailed[^.?!]*[.?!]?/ig, '')
    .replace(/\bNo substantive discussion(?: was| points were)?[^.?!]*[.?!]?/ig, '')
    .replace(/\bnot discussed in the transcript[^.?!]*[.?!]?/ig, '')
    .replace(/\b(?:yeah|yes|no|okay|ok|absolutely|presumably|perfect|right)[.!?,\s]+(?:yeah|yes|no|okay|ok|absolutely|presumably|perfect|right)[.!?,\s]*/ig, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isNoEvidenceDiscussionText(value) {
  const text = cleanStagedGeneratedLine(value);
  if (!text) return true;
  return /\b(?:no specific discussion points|no substantive discussion|not discussed in the transcript|no transcript evidence|no evidence|generation issue|(?:trooper[_ ]?)?api[_ ]key is not configured|rewriter is not configured)\b/i.test(text);
}

function isLowValueStagedDiscussionText(value) {
  const cleaned = cleanStagedDiscussionText(value);
  const text = cleaned.toLowerCase();
  if (!text) return true;
  if (/^(?:yeah|yes|no|okay|ok|absolutely|presumably|perfect|right)[.!?,\s]*(?:yeah|yes|no|okay|ok|absolutely|presumably|perfect|right)?[.!?,\s]*$/.test(text)) return true;
  if (/\b([A-Z][a-z]+)\s+said\s+that\s+\1\b/.test(cleaned)) return true;
  if (isMalformedStagedLine(cleaned)) return true;
  if (text.split(/\s+/).length < 5) return true;
  return false;
}

function uniqueCleanDiscussionItems(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const cleaned = cleanStagedDiscussionText(value);
    const key = cleaned.toLowerCase();
    if (!cleaned || isNoEvidenceDiscussionText(cleaned) || isLowValueStagedDiscussionText(cleaned) || seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
  }
  return result;
}

function cleanStagedActionText(value) {
  let action = cleanStagedGeneratedLine(value)
    .replace(/\s+/g, ' ')
    .trim();
  action = action.replace(/^have a catch[- ]?up meeting\b/i, 'Arrange a catch-up meeting');
  action = action.replace(/^catch up\b/i, 'Arrange a catch-up');
  return action;
}

// buildStagedGenerationContext was the 60-line entry point of the pre-canonical staged path, deleted in the
// Phase 5 consolidation when its last caller (runStagedSequenceForEvaluation) moved to
// canonicalStagedResponse - the pipeline the reviewer actually sees. Its shared helpers
// remain where other paths still use them.

function transcriptForStagedAI(transcript, inputPayload = {}) {
  const prepared = transcript?.preparedTranscript || inputPayload?.preparedTranscript;
  if (prepared && typeof prepared === 'object' && String(prepared.text || '').trim()) {
    return {
      text: String(prepared.text || ''),
      source: `${transcript.source || 'staged-meeting-minutes'}-prepared`,
      fileName: transcript.fileName || '',
      preparedTranscriptTelemetry: transcript.preparedTranscriptTelemetry || inputPayload.preparedTranscriptTelemetry || prepared.telemetry || null
    };
  }
  const generated = buildPreparedTranscriptForStagedAI(transcript.text);
  return {
    text: generated.text,
    source: `${transcript.source || 'staged-meeting-minutes'}-prepared`,
    fileName: transcript.fileName || '',
    preparedTranscriptTelemetry: {
      rawLength: generated.rawLength,
      preparedLength: generated.preparedLength,
      removedLineCount: generated.removedLineCount,
      removedReasons: generated.removedReasons,
      source: 'deterministic_stage_1_prep_fallback'
    }
  };
}

// buildStagedSummaryResponse was the 53-line entry point of the pre-canonical staged path, deleted in the
// Phase 5 consolidation when its last caller (runStagedSequenceForEvaluation) moved to
// canonicalStagedResponse - the pipeline the reviewer actually sees. Its shared helpers
// remain where other paths still use them.

function stagedTopicTokenSet(value) {
  const ignored = new Set(['meeting', 'review', 'update', 'discussion', 'point', 'points', 'status', 'topic', 'project', 'document', 'documentation', 'management', 'workstream', 'client']);
  return new Set(
    String(value || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 4 && !ignored.has(word))
  );
}

function stagedTokenSimilarity(left, right) {
  const leftTokens = stagedTopicTokenSet(left);
  const rightTokens = stagedTopicTokenSet(right);
  if (!leftTokens.size || !rightTokens.size) return 0;
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }
  return overlap / Math.max(leftTokens.size, rightTokens.size);
}

function cleanStagedEvidenceSnippet(value) {
  const cleaned = stripStagedTranscriptArtefacts(value);
  if (!cleaned || isNoEvidenceDiscussionText(cleaned) || isLowValueStagedDiscussionText(cleaned)) return '';
  const words = cleaned.split(/\s+/);
  if (words.length < 5) return '';
  return cleaned;
}

module.exports = {
  stagedKnownAttendeeKey,
  stagedPeopleRegistry,
  canonicalStagedAttendeeAlias,
  normaliseStagedKnownAttendeeAliasesInText,
  canonicalKnownStagedPersonName,
  TEAMS_PERSON_NAME_PATTERN,
  TEAMS_TIMESTAMP_PATTERN,
  TEAMS_HEADER_DATE_PATTERN,
  buildPreparedTranscriptForStagedAI,
  cleanStagedGeneratedLine,
  stripStagedTranscriptArtefacts,
  cleanStagedDiscussionText,
  isNoEvidenceDiscussionText,
  isLowValueStagedDiscussionText,
  uniqueCleanDiscussionItems,
  cleanStagedActionText,
  transcriptForStagedAI,
  stagedTokenSimilarity,
  cleanStagedEvidenceSnippet
};
