const { normaliseStagedKnownAttendeeAliasesInText, stagedKnownAttendeeKey, stagedPeopleRegistry, canonicalKnownStagedPersonName, canonicalStagedAttendeeAlias, TEAMS_PERSON_NAME_PATTERN, TEAMS_TIMESTAMP_PATTERN, TEAMS_HEADER_DATE_PATTERN } = require('./stagedMinutesContext');
const { firstString } = require('./meetingMinutesPlainText');
const { suggestMeetingTypeFromEvidence } = require('./canonicalMinutes/meetingTypeSuggestion');
const { prepareEvidence } = require('./canonicalMinutes/evidence');
const { normaliseDomainTermsDeep } = require('./domainTerms');

function normaliseDateInput(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const compactMatch = text.match(/\b(20\d{2})(\d{2})(\d{2})\b/);
  if (compactMatch) {
    return `${compactMatch[1]}-${compactMatch[2]}-${compactMatch[3]}`;
  }
  const isoMatch = text.match(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2].padStart(2, '0')}-${isoMatch[3].padStart(2, '0')}`;
  }
  const ukMatch = text.match(/\b(\d{1,2})[/-](\d{1,2})[/-](20\d{2})\b/);
  if (ukMatch) {
    return `${ukMatch[3]}-${ukMatch[2].padStart(2, '0')}-${ukMatch[1].padStart(2, '0')}`;
  }
  const namedMatch = text.match(/\b(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(20\d{2})\b/i);
  if (namedMatch) {
    const monthIndex = [
      'january',
      'february',
      'march',
      'april',
      'may',
      'june',
      'july',
      'august',
      'september',
      'october',
      'november',
      'december'
    ].indexOf(namedMatch[2].toLowerCase());
    if (monthIndex >= 0) {
      return `${namedMatch[3]}-${String(monthIndex + 1).padStart(2, '0')}-${namedMatch[1].padStart(2, '0')}`;
    }
  }
  return '';
}

function formatReadableUkDate(value) {
  const normalised = normaliseDateInput(value);
  const match = normalised.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return '';
  const months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December'
  ];
  return `${Number(match[3])} ${months[Number(match[2]) - 1]} ${match[1]}`;
}

function titleCaseMeetingText(value) {
  return String(value || '')
    .split(' ')
    .map((word) => {
      if (!word) return '';
      if (/[A-Z]{2,}|\d/.test(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ')
    .replace(/\bApi\b/g, 'API')
    .replace(/\bPms\b/g, 'PMS');
}

function cleanStagedMeetingTitleCandidate(value, options = {}) {
  let title = String(value || '').trim();
  if (!title) return '';

  title = title
    .replace(/\.[A-Za-z0-9]{2,5}$/g, '')
    .replace(/\b(?:microsoft\s+teams|ms\s+teams)\b/gi, '')
    .replace(/\b(?:meeting\s+transcript|transcript|recording)\b/gi, '')
    .replace(/\b(?:started|stopped)\s+transcription\b/gi, '');

  const compactDateMatch = title.match(/\b(20\d{2})(\d{2})(\d{2})(?:[_-]?\d{4,6})?\b/);
  const readableDate = compactDateMatch ? formatReadableUkDate(`${compactDateMatch[1]}-${compactDateMatch[2]}-${compactDateMatch[3]}`) : '';

  title = title
    .replace(/\b20\d{6}(?:[_-]?\d{4,6})?\b/g, '')
    .replace(/\b\d{1,2}[:.]\d{2}(?::\d{2})?\b/g, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b(?:meeting\s+transcript|transcript|recording)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+\.\s*$/g, '')
    .trim();

  title = titleCaseMeetingText(title);
  if (readableDate && options.includeReadableDate !== false && !title.includes(readableDate)) {
    title = `${title} - ${readableDate}`;
  }

  title = title.replace(/\s+-\s+-\s+/g, ' - ').trim();
  if (/^(?:meeting\s+overview|untitled\s+meeting|meeting|overview|transcript|recording|staged\s+review\s+draft)$/i.test(title)) return '';
  return title;
}

// What kind of meeting this is, decided from what it was called.
//
// Three of these tests used to read `combined`, which includes the whole transcript body,
// and a meeting-type decision taken from the body is a decision taken from something
// somebody happened to say. "Right, let's run through the AI programme items quickly"
// made "Daily AI Check In" a webinar rehearsal, and the profile then published "Rehearse
// the webinar flow, content, handovers and technical setup so the live session can run
// smoothly" as its purpose - about a meeting that did not happen, and unflagged, because
// only the inferred purposes carry a flag. Seven meetings in the committed corpus were
// framed this way.
//
// The title is what a meeting is called; the body is what was said in it. Only the first
// answers "what kind of meeting is this", so every test now reads titleHint.
function inferStagedMeetingType(text, fileName = '', meetingTitle = '') {
  const titleHint = `${fileName || ''} ${meetingTitle || ''}`.replace(/[_-]+/g, ' ');
  if (/\binternal\b.*\b(?:follow ?up|review from client call|debrief)\b/i.test(titleHint)) return 'General';
  if (/\bimporter(?:['’]s)?\s+(?:obligations?|responsibilit(?:y|ies)|requirements?)\b/i.test(titleHint)) return 'Importer obligations review';
  if (/\baudit\b.*\b(?:kick ?off|planning|preparation|readiness)\b/i.test(titleHint)) return 'Audit kick-off / planning';
  // Recurring software reviews have their own discussion profile; ordinary release reviews
  // still fall through because recurrence remains required.
  const isSoftwareWeekly = /\b(?:sw|software)\b.*\b(?:weekly|check ?in)\b/i.test(titleHint);
  const isTechnicalFile = /\btech(?:nical)? file\b.*\b(?:weekly|check ?in|review|status)\b/i.test(titleHint);
  if (isSoftwareWeekly && isTechnicalFile) return 'Software and technical-file weekly review';
  if (isSoftwareWeekly) return 'Software weekly review';
  if (isTechnicalFile && /\bconsultancy\b/i.test(titleHint)) return 'Technical file consultancy review';
  if (isTechnicalFile) return 'Technical file review';
  if (/\b(?:process|pipeline|lead generation)\b.*\b(?:planning|review|design)\b|\b(?:planning|review|design)\b.*\b(?:process|pipeline)\b/i.test(titleHint)) return 'General';
  if (/\b(webinar|rehearsal|dry run|run-through|run through)\b/i.test(titleHint)) return 'Webinar rehearsal';
  // Ordinary project reviews discuss decisions, and filenames often use "decision" for
  // an agenda item or document. Only an explicit decision-making meeting identity should
  // override General here; the evidence fallback below handles titles that say nothing.
  if (/\b(?:decision(?:[ -]making)?[ -](?:meeting|review|session)|approval[ -](?:meeting|review|session)|sign[ -]?off(?:[ -](?:meeting|review|session))?|go[ /-]?no[ -]?go)\b/i.test(titleHint)) return 'Decision meeting';
  return 'General';
}

function extractLineAfterLabel(text, labels) {
  const labelPattern = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const match = String(text || '').match(new RegExp(`(?:^|\\n)\\s*(?:${labelPattern})\\s*(?:[:\\-]|\\s+)\\s*([^\\n]{1,180})`, 'i'));
  return match ? match[1].trim() : '';
}

function extractNamesFromLine(value) {
  return String(value || '')
    .split(/,|;|\band\b|\/|\|/i)
    .map((item) => item.trim().replace(/^[-*]\s*/, ''))
    .filter((item) => item && item.length < 80)
    .slice(0, 12);
}

function isLikelyPersonName(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 80) return false;
  if (!/^[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+(?:\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+){1,4}$/.test(text)) return false;
  return !/\b(Meeting|Transcript|Client|Review|Weekly|Started|Stopped|Transcription)\b/i.test(text);
}

function uniqueNames(names) {
  const seen = new Set();
  const unique = [];
  for (const name of names) {
    const cleaned = String(name || '').replace(/\s+/g, ' ').trim();
    const key = cleaned.toLowerCase();
    if (!isLikelyPersonName(cleaned) || seen.has(key)) continue;
    seen.add(key);
    unique.push(cleaned);
  }
  return unique.slice(0, 40);
}

function bucketKnownStagedAttendees(names) {
  const internal = [];
  const client = [];
  const unknown = [];
  for (const rawName of uniqueNames(names)) {
    // canonicalKnownStagedPersonName, not just the literal alias map: the alias map only
    // knows spellings somebody wrote down in advance ("Smith, Stuart M"), while the
    // registry can repair a first-name match with an invented surname. Without this the
    // action OWNER read "Rebecca Gill" and the attendee list on the details screen still
    // read "Rebecca Cuckoo" - the same person, spelled two ways on two screens of the
    // same document.
    const canonicalName = canonicalKnownStagedPersonName(rawName) || canonicalStagedAttendeeAlias(rawName);
    const known = stagedPeopleRegistry().bucketByName.get(stagedKnownAttendeeKey(canonicalName));
    if (known?.bucket === 'internal') {
      internal.push(known.name);
    } else if (known?.bucket === 'client') {
      client.push(known.name);
    } else {
      unknown.push(canonicalName);
    }
  }
  return {
    internal: uniqueNames(internal),
    client: uniqueNames(client),
    unknown: uniqueNames(unknown)
  };
}

function extractTeamsTranscriptHeader(lines) {
  const headerLines = Array.isArray(lines) ? lines.map((line) => String(line || '').trim()).filter(Boolean).slice(0, 8) : [];
  const titleLine = headerLines.find((line) => /\b(?:meeting transcript|transcript|recording)\b/i.test(line)) || headerLines[0] || '';
  const dateLine = headerLines.find((line) => new RegExp(TEAMS_HEADER_DATE_PATTERN, 'i').test(line)) || '';
  const durationLine = headerLines.find((line) => /\b\d+\s*(?:h|hr|hrs|hour|hours|m|min|mins|minute|minutes)\b/i.test(line)) || '';
  const dateMatch = dateLine.match(new RegExp(TEAMS_HEADER_DATE_PATTERN, 'i'));

  return {
    meetingTitle: cleanStagedMeetingTitleCandidate(titleLine, { includeReadableDate: false }),
    meetingDate: normaliseDateInput(dateMatch ? dateMatch[0] : dateLine),
    duration: durationLine,
    source: titleLine || dateLine ? 'microsoft_teams_header' : ''
  };
}

function extractTeamsTranscriptStructure(text) {
  const transcript = normaliseStagedKnownAttendeeAliasesInText(text);
  const firstLines = transcript
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 12);
  const header = extractTeamsTranscriptHeader(firstLines);
  const speakerTurnCounts = new Map();
  const eventSpeakers = [];
  let turnCount = 0;

  const addSpeaker = (name, isTurn = false) => {
    const cleaned = canonicalStagedAttendeeAlias(name).replace(/\s+/g, ' ').trim();
    if (!isLikelyPersonName(cleaned)) return;
    if (isTurn) {
      speakerTurnCounts.set(cleaned, (speakerTurnCounts.get(cleaned) || 0) + 1);
      turnCount += 1;
    } else {
      eventSpeakers.push(cleaned);
    }
  };

  const turnLinePattern = new RegExp(`^\\s*(${TEAMS_PERSON_NAME_PATTERN})\\s+${TEAMS_TIMESTAMP_PATTERN}(?=\\s|[A-Za-z*]|$)`, 'i');
  const eventLinePattern = new RegExp(`^\\s*(${TEAMS_PERSON_NAME_PATTERN})\\s+(?:started|stopped)\\s+transcription\\b`, 'i');

  for (const line of transcript.split(/\r?\n/)) {
    const turnMatch = line.match(turnLinePattern);
    if (turnMatch) {
      addSpeaker(turnMatch[1], true);
      continue;
    }
    const eventMatch = line.match(eventLinePattern);
    if (eventMatch) {
      addSpeaker(eventMatch[1], false);
    }
  }

  const flattenedPattern = new RegExp(`\\b\\d{4,}\\s+\\d{4,}\\s+(${TEAMS_PERSON_NAME_PATTERN})\\s+${TEAMS_TIMESTAMP_PATTERN}(?=\\s|[A-Za-z*]|$)`, 'g');
  let match;
  while ((match = flattenedPattern.exec(transcript)) !== null) {
    addSpeaker(match[1], true);
  }

  return {
    header,
    speakers: uniqueNames([...speakerTurnCounts.keys(), ...eventSpeakers]),
    speakerTurnCounts: Object.fromEntries([...speakerTurnCounts.entries()].sort((a, b) => b[1] - a[1])),
    eventSpeakers: uniqueNames(eventSpeakers),
    turnCount
  };
}

function extractTeamsSpeakerNames(text) {
  const structured = extractTeamsTranscriptStructure(text);
  if (structured.speakers.length) return structured.speakers;
  const transcript = normaliseStagedKnownAttendeeAliasesInText(text);
  const names = [];
  const linePattern = /^\s*([A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+(?:\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+){1,4})\s+(?:\d{1,2}:)?\d{1,2}:\d{2}(?=\s|[A-Za-z*]|$)/gm;
  const flattenedPattern = /\b\d{4,}\s+\d{4,}\s+([A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+(?:\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+){1,4})\s+(?:\d{1,2}:)?\d{1,2}:\d{2}(?=\s|[A-Za-z*]|$)/g;
  let match;

  while ((match = linePattern.exec(transcript)) !== null) {
    names.push(match[1]);
  }

  while ((match = flattenedPattern.exec(transcript)) !== null) {
    names.push(match[1]);
  }

  return uniqueNames(names);
}

function extractStagedDetailsFromTranscript(transcriptText, fileName = '') {
  const text = normaliseStagedKnownAttendeeAliasesInText(transcriptText);
  const firstLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 30);
  const firstChunk = firstLines.join('\n');
  const meetingTitle = firstString(
    cleanStagedMeetingTitleCandidate(extractLineAfterLabel(firstChunk, ['meeting title', 'title', 'subject'])),
    cleanStagedMeetingTitleCandidate(firstLines.find((line) => /meeting|review|workshop|sync|update|transcript/i.test(line) && !/:$/.test(line))),
    cleanStagedMeetingTitleCandidate(fileName),
    'Untitled meeting'
  );
  const rawDate = firstString(
    extractLineAfterLabel(firstChunk, ['meeting date', 'date']),
    (firstChunk.match(/\b(?:20\d{6}|20\d{2}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[/-]\d{1,2}[/-]20\d{2}|\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+20\d{2})\b/i) || [])[0],
    (String(fileName || '').match(/\b20\d{6}\b/) || [])[0]
  );
  const rawLocation = extractLineAfterLabel(firstChunk, ['location', 'venue', 'platform']);
  const rawOrganisation = extractLineAfterLabel(firstChunk, ['organisation', 'organization', 'client', 'company']);
  const attendeesLine = extractLineAfterLabel(firstChunk, ['attendees', 'participants', 'present']);
  const clientLine = extractLineAfterLabel(firstChunk, ['client attendees', 'client participants']);
  const trinzoLine = extractLineAfterLabel(firstChunk, ['trinzo attendees', 'internal attendees', 'trinzo participants', 'internal participants']);
  const teamsStructure = extractTeamsTranscriptStructure(text);
  const teamsHeader = teamsStructure.header || {};
  const teamsSpeakers = teamsStructure.speakers.length ? teamsStructure.speakers : extractTeamsSpeakerNames(text);
  const explicitClientAttendees = extractNamesFromLine(clientLine);
  const explicitInternalAttendees = extractNamesFromLine(trinzoLine);
  const unlabelledAttendees = extractNamesFromLine(attendeesLine);
  const explicitClientBuckets = bucketKnownStagedAttendees(explicitClientAttendees);
  const explicitInternalBuckets = bucketKnownStagedAttendees(explicitInternalAttendees);
  const unlabelledBuckets = bucketKnownStagedAttendees(unlabelledAttendees);
  const speakerBuckets = bucketKnownStagedAttendees(teamsSpeakers);
  const internalAttendees = uniqueNames([
    ...explicitInternalBuckets.internal,
    ...explicitInternalBuckets.unknown,
    ...explicitClientBuckets.internal,
    ...unlabelledBuckets.internal,
    ...speakerBuckets.internal
  ]);
  const clientAttendees = uniqueNames([
    ...explicitClientBuckets.client,
    ...explicitClientBuckets.unknown,
    ...explicitInternalBuckets.client,
    ...unlabelledBuckets.client,
    ...speakerBuckets.client
  ]);
  const unresolvedAttendees = uniqueNames([
    ...unlabelledBuckets.unknown,
    ...speakerBuckets.unknown
  ]).filter((name) => !internalAttendees.includes(name) && !clientAttendees.includes(name));
  const headerDate = teamsHeader.meetingDate || '';
  const headerTitle = teamsHeader.meetingTitle || '';
  const attendeeNameWarnings = teamsSpeakers.flatMap((name) => {
    const parts = stagedKnownAttendeeKey(name).split(/\s+/).filter(Boolean);
    if (parts.length < 2 || stagedPeopleRegistry().bucketByName.has(stagedKnownAttendeeKey(name))) return [];
    const knownFirstName = stagedPeopleRegistry().personByFirstName.get(parts[0]);
    if (!knownFirstName) return [];
    // The message has to describe what the document now says, not what the transcript
    // said. This flag used to read "Check attendee name X, the surname differs" while the
    // attendee list already showed the corrected name - so the reviewer was asked to fix
    // something that was not there, against a name that appeared nowhere on the screen.
    // Now the correction is applied, the flag reports the decision and offers the way back.
    const corrected = canonicalKnownStagedPersonName(name);
    if (corrected && stagedKnownAttendeeKey(corrected) !== stagedKnownAttendeeKey(name)) {
      return [{
        type: 'attendee_name_corrected',
        severity: 'info',
        blocking: false,
        message: `The transcript says “${name}”, which is not a known participant. It has been recorded as “${corrected}” because the first name matches. Edit the attendee if that is wrong.`
      }];
    }
    return [{ type: 'possible_attendee_name_mismatch', severity: 'warning', blocking: false, message: `Check attendee name “${name}”. The first name matches known participant “${knownFirstName}”, but the transcript surname differs.` }];
  });
  const attendeeAffiliationFlags = unresolvedAttendees.length ? [{
    type: 'attendee_affiliation_unconfirmed',
    severity: 'warning',
    blocking: false,
    message: `Internal or client affiliation was not stated for ${unresolvedAttendees.join(', ')}. Review the attendee lists before finalising.`
  }] : [];

  // The title decides the type when it can. When it cannot - the title-only inference
  // returned the default - ask the discussion, gated on recurrence and dominance, and
  // offer the answer as a pre-selected suggestion the reviewer can overrule. The evidence
  // trail travels with the payload so the suggestion is auditable, and the flag makes it
  // visible: a pre-selected dropdown with no note is indistinguishable from a default.
  const titleOnlyType = inferStagedMeetingType(text, fileName, headerTitle || meetingTitle);
  let meetingTypeSuggestion = null;
  if (titleOnlyType === 'General') {
    try {
      meetingTypeSuggestion = suggestMeetingTypeFromEvidence(prepareEvidence(text));
    } catch {
      meetingTypeSuggestion = null;
    }
  }
  const suggestedType = meetingTypeSuggestion && meetingTypeSuggestion.accepted ? meetingTypeSuggestion.type : null;
  const typeSuggestionFlags = suggestedType ? [{
    type: 'meeting_type_suggested',
    severity: 'warning',
    blocking: false,
    resolutionKey: 'meeting-type-suggested',
    message: `The meeting type was set to "${suggestedType}" from the discussion itself - ${meetingTypeSuggestion.supportedHints.length} of that type's topic areas recur across ${meetingTypeSuggestion.totalMatchedEvents} moments in the transcript, while the title alone reads as a general project review. Change it if that is not what this meeting was.`
  }] : [];

  return normaliseDomainTermsDeep({
    ok: true,
    staged: true,
    stagedStage: 'details',
    screens: {
      details: {
        meetingTitle: (headerTitle || meetingTitle).slice(0, 180),
        meetingDate: headerDate || normaliseDateInput(rawDate),
        meetingLocation: rawLocation || (/\b(?:microsoft\s+teams|teams meeting)\b/i.test(text) ? 'Microsoft Teams' : ''),
        organisation: rawOrganisation,
        meetingType: suggestedType || titleOnlyType,
        meetingTypeSuggestion,
        internalAttendees,
        clientAttendees,
        // teamsSpeakers carries the transcript's own spelling, so a name repaired in the
        // bucketed lists reappeared here beside its broken twin: "Rebecca Gill" and
        // "Rebecca Cuckoo" both listed as attendees of the same meeting. Canonicalise
        // before the union so the dedupe can actually see they are one person.
        allAttendees: uniqueNames([
          ...internalAttendees,
          ...clientAttendees,
          ...unresolvedAttendees,
          ...teamsSpeakers.map((name) => canonicalKnownStagedPersonName(name) || name)
        ])
      }
    },
    validationFlags: [...attendeeNameWarnings, ...attendeeAffiliationFlags, ...typeSuggestionFlags],
    telemetryPreview: {
      stage: 'details',
      transcriptLength: text.length,
      screenCount: 1,
      attendeeExtraction: {
        source: teamsStructure.speakers.length ? 'microsoft_teams_speaker_turns' : 'explicit_or_fallback',
        speakerCount: teamsSpeakers.length,
        unresolvedAffiliationCount: unresolvedAttendees.length,
        turnCount: teamsStructure.turnCount,
        eventSpeakerCount: teamsStructure.eventSpeakers.length,
        knownInternalAttendeeCount: internalAttendees.length,
        knownClientAttendeeCount: clientAttendees.filter((name) => stagedPeopleRegistry().bucketByName.get(stagedKnownAttendeeKey(name))?.bucket === 'client').length,
        headerSource: teamsHeader.source || '',
        dateSource: headerDate ? 'microsoft_teams_header' : 'explicit_or_filename'
      }
    }
  });
}

module.exports = {
  extractStagedDetailsFromTranscript,
  normaliseDateInput,
  extractTeamsTranscriptHeader,
  isLikelyPersonName,
  uniqueNames,
  extractTeamsSpeakerNames,
  inferStagedMeetingType
};
