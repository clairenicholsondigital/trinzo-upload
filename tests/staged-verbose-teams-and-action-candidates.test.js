'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const router = require('../routes/api');
const { prepareEvidence } = require('../utils/canonicalMinutes/evidence');

const {
  extractStagedDetailsFromTranscript,
  buildPreparedTranscriptForStagedAI,
  buildStagedActionsResponse
} = router.stagedEvaluation;

test('staged details recognise verbose Teams timestamp speaker turns', () => {
  const transcript = [
    'Quarterly planning transcript',
    '',
    'Conor Flynn',
    '0 minutes 3 seconds0:03',
    'Conor Flynn 0 minutes 3 seconds',
    'Can you review the quarterly priorities and send the key AI project points today?',
    '',
    'Ciara Griffin',
    '0 minutes 17 seconds0:17',
    'Ciara Griffin 0 minutes 17 seconds',
    'Yes, I can do that.'
  ].join('\n');

  const details = extractStagedDetailsFromTranscript(transcript, 'Transcript.docx');
  assert.deepEqual(details.screens.details.allAttendees, ['Conor Flynn', 'Ciara Griffin']);
  assert.equal(details.telemetryPreview.attendeeExtraction.source, 'microsoft_teams_speaker_turns');
  assert.equal(details.telemetryPreview.attendeeExtraction.speakerCount, 2);

  const prepared = buildPreparedTranscriptForStagedAI(transcript);
  assert.match(prepared.text, /Conor Flynn:/);
  assert.match(prepared.text, /Ciara Griffin:/);
});

test('indented Teams turns and prepared full-name turns produce the same canonical evidence', () => {
  const raw = [
    'Review Lean Generation Pipeline-Meeting Transcript',
    '  Conor Flynn   0:03gets information to Keon and Liam for the proposed lead generation process.',
    '  Keon Fox   0:58Okay.',
    '  Jack Cunningham   5:53The team needs to define the ICP fit criteria before the pilot.'
  ].join('\n');
  const prepared = buildPreparedTranscriptForStagedAI(raw).text;
  const rawEvidence = prepareEvidence(raw);
  const preparedEvidence = prepareEvidence(prepared);

  assert.deepEqual(rawEvidence.participants, ['Conor Flynn', 'Keon Fox', 'Jack Cunningham']);
  assert.deepEqual(preparedEvidence.participants, rawEvidence.participants);
  assert.equal(rawEvidence.turns.length, 3);
  assert.equal(preparedEvidence.turns.length, rawEvidence.turns.length);
  assert.equal(preparedEvidence.events.length, rawEvidence.events.length);
  assert.match(prepared, /Conor Flynn:/);
});

test('actions stage surfaces review candidates when follow-ups are plausible but not safe to publish', () => {
  const transcriptText = [
    'Review Lean Generation Pipeline-20260812_140304-Meeting Transcript',
    '12 August 2026, 01:03pm',
    '9m 42s',
    'Kathryn Cullen started transcription',
    'Conor Flynn   0:03 We need a way to be able to qualify client delivery leads before they are put in front of sales.',
    'Conor Flynn   1:22 We do a four-week pilot where we have a mix of manual and AI in order to test the volume and quality of leads.',
    'Jack Cunningham   5:53 Something that would need to be defined as a team is exactly how we set the criteria for the ICP fit.'
  ].join('\n');
  const req = {
    body: {
      confirmedDetails: {
        meetingTitle: 'Review Lean Generation Pipeline',
        meetingDate: '2026-08-12',
        meetingLocation: 'Microsoft Teams',
        meetingType: 'Project review',
        participants: ['Conor Flynn', 'Jack Cunningham']
      },
      confirmedSummary: {
        objectives: ['Review lead generation process design'],
        overallTopics: ['Lead Generation Process Design'],
        executiveSummary: 'The team reviewed lead generation process design.'
      },
      confirmedDiscussion: []
    }
  };
  const minilmContext = {
    ok: true,
    output: { actions: [] },
    diagnostics: {},
    evidenceClassifier: {
      ok: true,
      executed: true,
      modelAvailable: true,
      counts: { action_commitment: 2, document_control_task: 1 },
      actions: [],
      items: [
        {
          speaker: 'Conor Flynn',
          text: 'We need a way to be able to qualify client delivery leads before they are put in front of sales.',
          evidenceType: 'document_control_task',
          commitmentState: 'possible_action'
        },
        {
          speaker: 'Conor Flynn',
          text: 'We do a four-week pilot where we have a mix of manual and AI in order to test the volume and quality of leads.',
          evidenceType: 'action_commitment',
          commitmentState: 'possible_action'
        },
        {
          speaker: 'Jack Cunningham',
          text: 'Something that would need to be defined as a team is exactly how we set the criteria for the ICP fit.',
          evidenceType: 'document_control_task',
          commitmentState: 'possible_action'
        }
      ],
      diagnostics: {}
    }
  };

  const result = buildStagedActionsResponse(req, { text: transcriptText, source: 'test', fileName: 'transcript.docx' }, minilmContext, transcriptText);
  assert.deepEqual(result.screens.actions, []);
  assert.equal(result.actionReviewCandidates.length, 3);
  assert.ok(!result.validationFlags.some((flag) => flag.type === 'no_actions_detected'));
  const flag = result.validationFlags.find((item) => item.type === 'action_review_candidates');
  assert.ok(flag);
  assert.equal(flag.repairCandidates.length, 3);
  const actions = flag.repairCandidates.map((candidate) => candidate.action).join('\n');
  assert.match(actions, /client delivery leads should be qualified/i);
  assert.match(actions, /four-week pilot/i);
  assert.match(actions, /ICP fit criteria/i);
});
