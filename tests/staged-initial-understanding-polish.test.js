'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  deterministicPresentationFallback,
  objectiveIssue,
  polishInitialUnderstanding,
  validateInitialUnderstandingRevision
} = require('../utils/stagedInitialUnderstandingPolish');

const input = {
  meetingTitle: 'Client T761 Eakin SW Weekly Checkin',
  meetingPurpose: "Coordinate the meeting's main workstreams, dependencies and next steps around alarm behaviour and controls and lovely, that's one sorted.",
  objectives: [
    'Clarify alarm behaviour and controls and related next steps.',
    "Clarify lovely, that's one sorted and related next steps.",
    'Clarify now, the annual show and related next steps.'
  ],
  overallTopics: ['Alarm behaviour and controls', "Lovely, that's one sorted", 'Now, the annual show'],
  executiveSummary: "Coordinate the meeting's main workstreams and next steps around alarm behaviour and controls and lovely, that's one sorted. Lovely, that's one sorted. Now, the annual show."
};

test('isolated polish removes repetition without changing the structural topics', async () => {
  let requestBody;
  const result = await polishInitialUnderstanding(input, {
    apiKey: 'test', model: 'test', url: 'https://example.test',
    fetchImpl: async (_url, request) => {
      requestBody = JSON.parse(request.body);
      return {
        ok: true,
        text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({
          meetingPurpose: 'Coordinate the main workstreams, dependencies and next steps around alarm behaviour and controls.',
          objectives: ['Review alarm behaviour and controls.'],
          executiveSummary: 'The meeting reviewed alarm behaviour and controls and the related next steps.'
        }) } }] })
      };
    }
  });
  assert.equal(result.used, true);
  assert.equal(result.meetingPurpose, 'Coordinate the main workstreams, dependencies and next steps around alarm behaviour and controls.');
  assert.doesNotMatch(result.meetingPurpose, /lovely|one sorted/i);
  assert.deepEqual(result.objectives, ['Review alarm behaviour and controls.']);
  assert.match(requestBody.messages[1].content, /\[MEETING_TITLE\] Client T761 Eakin SW Weekly Checkin/);
  assert.match(requestBody.messages[1].content, /Return JSON only as \{"meetingPurpose"/);
  assert.doesNotMatch(requestBody.messages[1].content, /\[TRANSCRIPT\]/i);
  assert.deepEqual(input.overallTopics, ['Alarm behaviour and controls', "Lovely, that's one sorted", 'Now, the annual show']);
});

test('polish rejects invented protected facts', () => {
  const validation = validateInitialUnderstandingRevision(input, {
    meetingPurpose: 'Coordinate alarm behaviour and controls.',
    objectives: ['Andrew will review alarm behaviour by Friday.'],
    executiveSummary: 'Andrew agreed to complete the MDR review by Friday.'
  });
  assert.equal(validation.ok, false);
  assert.equal(validation.reason, 'new_protected_fact');
});

test('validator accepts a compressed third-person meeting executive summary', () => {
  const source = {
    meetingTitle: 'Importer obligations client call follow-up',
    meetingPurpose: 'Align internally on the client call, outstanding information gaps and next working sessions.',
    objectives: ['Review country and language evidence and related next steps.'],
    overallTopics: ['Country and language evidence', 'Translation, labelling and market requirements', 'Health authority information', 'Label snapshot'],
    executiveSummary: 'Country and language evidence was needed to assess translation, labelling and market requirements. Because many company authorities have their own databases, information needs to be submitted to health authorities. They were not keen to share it, but I took a snapshot of the label.'
  };
  const validation = validateInitialUnderstandingRevision(source, {
    meetingPurpose: 'Align on outstanding country and language evidence needed for translation, labelling and market requirements.',
    objectives: ['Review country and language evidence for translation, labelling and market requirements.'],
    executiveSummary: 'The meeting reviewed outstanding country and language evidence for translation, labelling and market requirements. Further health authority information and supporting label information remain required.'
  });
  assert.equal(validation.ok, true);
});

test('validator accepts final presentation cleanup of a transcript-shaped objective label', () => {
  const source = {
    meetingTitle: 'Eakin SW minutes PDF',
    meetingPurpose: 'Clarify the current setup, flash behaviour and related next steps.',
    objectives: [
      'Clarify david noted the current setup the flash and related next steps.',
      'Review electrical-compliance testing evidence.'
    ],
    overallTopics: ['Current setup and flash behaviour', 'Electrical-compliance testing evidence'],
    executiveSummary: 'Clarify the current setup, flash behaviour and related next steps. Electrical-compliance testing evidence was discussed.'
  };
  const validation = validateInitialUnderstandingRevision(source, {
    meetingPurpose: 'Clarify the current setup, flash behaviour and related next steps.',
    objectives: [
      'Confirm the current setup and flash behaviour.',
      'Review electrical-compliance testing evidence.'
    ],
    executiveSummary: 'The meeting reviewed the current setup, flash behaviour and electrical-compliance testing evidence.'
  });
  assert.equal(validation.ok, true);
});

test('validator accepts final cleanup when the source summary is visibly transcript-shaped', () => {
  const source = {
    meetingTitle: 'QIP assessment tool case study',
    meetingPurpose: 'Review the quality-system case study and related assessment-tool requirements.',
    objectives: ['Review quality system and quality culture operating requirements.'],
    overallTopics: ['Quality system and quality culture', 'Assessment tool requirements', 'Site review requirements'],
    executiveSummary: "Review the quality-system case study and related assessment-tool requirements. For a site in the areas of quality system, quality culture operating. We'd just be speaking to them to understand what's what."
  };
  const validation = validateInitialUnderstandingRevision(source, {
    meetingPurpose: 'Review the quality-system case study and related assessment-tool requirements.',
    objectives: ['Review quality-system and quality-culture requirements.'],
    executiveSummary: 'The meeting reviewed quality-system and quality-culture requirements for the assessment-tool case study. Further site input is required to clarify the relevant operating requirements.'
  });
  assert.equal(validation.ok, true);
});

test('validator rejects transcript-shaped objectives after Trooper cleanup', () => {
  assert.equal(objectiveIssue('Clarify david noted the current setup the flash and related next steps.'), 'speaker_transcript_objective');
  const validation = validateInitialUnderstandingRevision(input, {
    meetingPurpose: 'Coordinate alarm behaviour and controls.',
    objectives: ['Clarify David noted the current setup the flash and related next steps.'],
    executiveSummary: 'The meeting reviewed alarm behaviour and controls and the related next steps.'
  });
  assert.equal(validation.ok, false);
  assert.equal(validation.reason, 'speaker_transcript_objective');
});

test('deterministic fallback drops unsafe objective labels and unsafe summary fragments', () => {
  const fallback = deterministicPresentationFallback({
    meetingTitle: 'QIP assessment tool case study',
    meetingPurpose: "Review the quality-system case study and lovely, that's one sorted.",
    objectives: [
      'Clarify david noted the current setup the flash and related next steps.',
      'Review assessment tool requirements.'
    ],
    overallTopics: ['Assessment tool requirements', 'Quality system and quality culture'],
    executiveSummary: "Review the quality-system case study and related assessment-tool requirements. For a site in the areas of quality system, quality culture operating. We'd just be speaking to them to understand what's what."
  }, 'malformed_objective');
  assert.equal(fallback.used, true);
  assert.equal(fallback.reason, 'deterministic_malformed_objective');
  assert.deepEqual(fallback.objectives, [
    'Review assessment tool requirements.',
    'Review quality system and quality culture.'
  ]);
  assert.equal(fallback.meetingPurpose, 'Review assessment tool requirements.');
  assert.doesNotMatch(fallback.meetingPurpose, /lovely|one sorted/i);
  assert.doesNotMatch(fallback.executiveSummary, /\bWe'd\b|what's what|For a site in the areas/i);
});

test('validator rejects first-person transcript wording in an executive summary', () => {
  const validation = validateInitialUnderstandingRevision(input, {
    meetingPurpose: 'Coordinate alarm behaviour and controls.',
    objectives: ['Review alarm behaviour and controls.'],
    executiveSummary: 'We reviewed alarm behaviour and controls, and I confirmed the next steps.'
  });
  assert.equal(validation.ok, false);
  assert.equal(validation.reason, 'first_person_summary');
});

test('polish fails open when Trooper is unavailable', async () => {
  const result = await polishInitialUnderstanding(input, {});
  assert.equal(result.used, false);
  assert.equal(result.reason, 'unavailable');
  assert.deepEqual(result.objectives, input.objectives);
});
