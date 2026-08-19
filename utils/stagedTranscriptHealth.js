'use strict';

const { prepareEvidence } = require('./canonicalMinutes/evidence');
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

  let state = 'healthy';
  const reasons = [];
  if (!turns.length || !events.length || !participants.length) {
    state = 'structurally_unreliable';
    reasons.push('speaker_turns_not_reliably_parsed');
  } else if (events.length < 3) {
    state = 'structurally_unreliable';
    reasons.push('too_little_parsed_evidence');
  } else {
    if (substantiveEvents.length < 6) reasons.push('limited_substantive_evidence');
    if (noiseRatio > 0.55) reasons.push('chatter_or_fragment_heavy');
    if (participants.length > 1 && speakerDominance > 0.92) reasons.push('single_speaker_dominance');
    if (reasons.length) state = 'sparse_but_usable';
  }

  return {
    state,
    reasons,
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

function stagedTranscriptHealthFlag(health) {
  if (!health || health.state === 'healthy') return null;
  if (health.state === 'structurally_unreliable') {
    return {
      type: 'transcript_structure_unreliable',
      severity: 'warning',
      blocking: true,
      resolutionKey: 'transcript-health:structure',
      message: 'The transcript does not contain enough recognisable speaker turns to generate reliable later stages. Check the uploaded file or paste a clearer transcript before continuing.'
    };
  }
  return {
    type: 'transcript_sparse_but_usable',
    severity: 'warning',
    blocking: false,
    resolutionKey: 'transcript-health:sparse',
    message: 'This transcript contains limited substantive discussion or a high proportion of short conversational fragments. You can continue, but check the topics and follow-ups particularly carefully.'
  };
}

module.exports = { assessStagedTranscriptHealth, stagedTranscriptHealthFlag };
