'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { polishInitialUnderstanding, validateInitialUnderstandingRevision } = require('../utils/stagedInitialUnderstandingPolish');

const input = {
  meetingTitle: 'Client T761 Eakin SW Weekly Checkin',
  meetingPurpose: "Coordinate the meeting's main workstreams and next steps around alarm behaviour and controls.",
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
          objectives: ['Review alarm behaviour and controls.'],
          executiveSummary: 'The meeting reviewed alarm behaviour and controls and the related next steps.'
        }) } }] })
      };
    }
  });
  assert.equal(result.used, true);
  assert.deepEqual(result.objectives, ['Review alarm behaviour and controls.']);
  assert.match(requestBody.messages[1].content, /\[MEETING_TITLE\] Client T761 Eakin SW Weekly Checkin/);
  assert.doesNotMatch(requestBody.messages[1].content, /\[TRANSCRIPT\]/i);
  assert.deepEqual(input.overallTopics, ['Alarm behaviour and controls', "Lovely, that's one sorted", 'Now, the annual show']);
});

test('polish rejects invented protected facts', () => {
  const validation = validateInitialUnderstandingRevision(input, {
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
    objectives: ['Review country and language evidence for translation, labelling and market requirements.'],
    executiveSummary: 'The meeting reviewed outstanding country and language evidence for translation, labelling and market requirements. Further health authority information and supporting label information remain required.'
  });
  assert.equal(validation.ok, true);
});

test('validator rejects first-person transcript wording in an executive summary', () => {
  const validation = validateInitialUnderstandingRevision(input, {
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
