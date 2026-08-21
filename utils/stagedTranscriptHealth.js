'use strict';

const { prepareEvidence } = require('./canonicalMinutes/evidence');
const { measureParseCoverage, describeUnreadRegion, isPartiallyParsed } = require('./canonicalMinutes/parseCoverage');
const {
  isTranscriptMetaText,
  isCorrectionOrAcknowledgementFragment,
  canStandAloneAsMinutesEvidence
} = require('./canonicalMinutes/publishability');

function round(value) {
  return Number(Number(value || 0).toFixed(3));
}

function assessStagedTranscriptHealth(transcriptText) {
  const evidence = prepareEvidence(transcriptText);
  const events = evidence.events || [];
  const turns = evidence.turns || [];
  const participants = evidence.participants || [];
  const noiseEvents = events.filter((event) => {
    const text = event.text || '';
    return isTranscriptMetaText(text)
      || isCorrectionOrAcknowledgementFragment(text)
      || text.split(/\s+/).filter(Boolean).length <= 3;
  });
  const substantiveEvents = events.filter((event) => canStandAloneAsMinutesEvidence(event.text));
  const bySpeaker = turns.reduce((counts, turn) => {
    counts[turn.speaker] = (counts[turn.speaker] || 0) + 1;
    return counts;
  }, {});
  const dominantTurnCount = Math.max(0, ...Object.values(bySpeaker));
  const noiseRatio = round(noiseEvents.length / Math.max(events.length, 1));
  const substantiveRatio = round(substantiveEvents.length / Math.max(events.length, 1));
  const speakerDominance = round(dominantTurnCount / Math.max(turns.length, 1));

  const parseCoverage = measureParseCoverage(transcriptText, evidence);

  // A recording with no diarisation has no participants to find, but its
  // discussion is still there and still worth minuting. Missing participants
  // stays fatal for genuinely unparseable input; it is not fatal when the
  // parser recovered the speech and is saying plainly that nobody was named.
  const recoveredUnattributed = turns.some((turn) => turn.attributionConfidence === 0);

  let state = 'healthy';
  const reasons = [];
  if (!turns.length || !events.length || (!participants.length && !recoveredUnattributed)) {
    state = 'structurally_unreliable';
    reasons.push('speaker_turns_not_reliably_parsed');
  } else if (events.length < 3) {
    state = 'structurally_unreliable';
    reasons.push('too_little_parsed_evidence');
  } else {
    if (substantiveEvents.length < 6) reasons.push('limited_substantive_evidence');
    if (noiseRatio > 0.55) reasons.push('chatter_or_fragment_heavy');
    if (participants.length > 1 && speakerDominance > 0.92) reasons.push('single_speaker_dominance');
    // A transcript can parse into perfectly well-formed turns and still have
    // lost most of the meeting: what the parser did not recognise is simply
    // absent from the evidence, so nothing downstream can notice its absence.
    if (isPartiallyParsed(parseCoverage)) reasons.push('transcript_partially_parsed');
    if (parseCoverage.unattributedTurnCount) reasons.push('some_speakers_unidentified');
    if (reasons.length) state = 'sparse_but_usable';
  }

  return {
    state,
    reasons,
    parseCoverage,
    parsedTurnCount: turns.length,
    evidenceEventCount: events.length,
    substantiveEventCount: substantiveEvents.length,
    noiseEventCount: noiseEvents.length,
    participantCount: participants.length,
    substantiveRatio,
    noiseRatio,
    speakerDominance
  };
}

// A sentence about the speakers we could not name, added to whichever flag is
// shown. An unidentified speaker is not a defect in the meeting; it is a limit
// on what the minutes can claim, and the reviewer is the one who can fix it.
function unidentifiedSpeakerNote(health) {
  const count = (health.parseCoverage || {}).unattributedTurnCount || 0;
  if (!count) return '';
  if (count >= (health.parsedTurnCount || 0)) {
    return ' The discussion below was read from a recording with no speaker labels, so nothing in it is attributed and any follow-ups need an owner assigning by hand.';
  }
  return ` ${count} turn${count === 1 ? ' was' : 's were'} recorded in a speaker format this transcript does not label, so ${count === 1 ? 'its' : 'their'} follow-ups have no owner set — assign one where you can.`;
}

function stagedTranscriptHealthFlag(health) {
  if (!health || health.state === 'healthy') return null;
  const coverage = health.parseCoverage || {};
  const unread = (coverage.unreadRegions || [])[0];
  const unreadNote = unread ? ` What was not read: ${describeUnreadRegion(unread)}.` : '';

  if (health.state === 'structurally_unreliable') {
    return {
      type: 'transcript_structure_unreliable',
      severity: 'warning',
      blocking: true,
      resolutionKey: 'transcript-health:structure',
      message: `The transcript does not contain enough recognisable speaker turns to generate reliable later stages. Check the uploaded file or paste a clearer transcript before continuing.${unreadNote}`
    };
  }

  // Partial coverage outranks generic sparseness in the wording: "we read 62%
  // of your meeting" is a more actionable thing to be told than "this looks
  // thin", and the reviewer can decide whether to fix the file before editing.
  if ((health.reasons || []).includes('transcript_partially_parsed')) {
    return {
      type: 'transcript_partially_parsed',
      severity: 'warning',
      blocking: false,
      resolutionKey: 'transcript-health:coverage',
      message: `Only ${Math.round((coverage.coverage || 0) * 100)}% of this transcript was read into the minutes, so anything below is drawn from part of the meeting rather than all of it.${unreadNote}${unidentifiedSpeakerNote(health)} You can continue, but a cleaner export of the recording will produce better minutes.`
    };
  }

  if ((health.reasons || []).includes('some_speakers_unidentified') && (health.reasons || []).length === 1) {
    return {
      type: 'transcript_speakers_unidentified',
      severity: 'warning',
      blocking: false,
      resolutionKey: 'transcript-health:attribution',
      message: `${(coverage.unattributedTurnCount || 0) >= (health.parsedTurnCount || 0) ? '' : 'This transcript mixes speaker formats.'}${unidentifiedSpeakerNote(health)}`.trim()
    };
  }

  return {
    type: 'transcript_sparse_but_usable',
    severity: 'warning',
    blocking: false,
    resolutionKey: 'transcript-health:sparse',
    message: `This transcript contains limited substantive discussion or a high proportion of short conversational fragments. You can continue, but check the topics and follow-ups particularly carefully.${unidentifiedSpeakerNote(health)}`
  };
}

module.exports = { assessStagedTranscriptHealth, stagedTranscriptHealthFlag };
