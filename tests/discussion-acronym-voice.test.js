'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isRawTranscriptDiscussionPoint, finaliseDiscussionPointForMinutes
} = require('../utils/stagedEditorial');
const { removeRawGeneratedDiscussionRows } = require('../utils/canonicalMinutes/discussionOrganiser');

test('country and regulatory initialisms do not turn declarative discussion into personal speech', () => {
  for (const text of [
    'Serial-number implementation starts this week, with final approval pending from the US team.',
    'Before-market registration remains required for products supplied through US distributors.',
    'Approval remains pending from the (US) team, subject to the existing review.',
    'Approval remains pending from the US-based team, subject to the existing review.',
    'Approval remains pending from the US team’s reviewer, subject to the existing review.',
    'Approval remains pending from the U.S. team, subject to the existing review.',
    'Approval remains pending from the EU team under the ISO process.',
    'Registration remains required before release under the US FDA process.'
  ]) assert.equal(isRawTranscriptDiscussionPoint(text), false, text);
});

test('initialisms never exempt a whole row or weaken actual personal speech and malformed-line guards', () => {
  for (const text of [
    'Working with us on the approval process.',
    'Working with Us on the approval process.',
    'Working on the approval process, we will help.',
    'Working on the approval process, We will help.',
    'Working with US staff, we will help.',
    'Working with US staff; send us the approval request.',
    'Working with US staff, WE will help.',
    'Working with US staff, WE’RE waiting for approval.',
    "Working with US staff, WE'LL review the request.",
    'Working with US staff, I will help.',
    "Working with US staff, I'M waiting for approval.",
    'Working with US staff, OUR approval is pending.',
    'Working with US staff, send ME the approval request.',
    'Working with US staff, YOU need the approval request.',
    'WORKING WITH US ON THE APPROVAL PROCESS.',
    'Well, US approval is still pending.',
    'Morgan 12:41 US approval is still pending.',
    'Approval from US staff is, is still pending.'
  ]) assert.equal(isRawTranscriptDiscussionPoint(text), true, text);
});

test('reported statements and questions use the same case-sensitive country/pronoun distinction', () => {
  assert.equal(finaliseDiscussionPointForMinutes(
    'Morgan reported that registration remains required before market release for US devices.'),
  'Registration remains required before market release for US devices.');
  assert.equal(finaliseDiscussionPointForMinutes(
    'Morgan asked whether registration remains required before market release for US devices.'),
  'The discussion considered whether registration remains required before market release for US devices.');
  for (const text of [
    'Morgan reported that we need approval from US staff before release.',
    'Morgan asked whether US staff can help us before release.',
    'Morgan reported that WE NEED APPROVAL BEFORE RELEASE.'
  ]) assert.equal(finaliseDiscussionPointForMinutes(text), '', text);
});

const kickoff = 'Serial-number implementation starts this week, with final approval pending from the US team.';
const condition = 'Before-market registration remains required for products supplied through US distributors.';
const topics = () => [{ id: 'registration', topic: 'Registration and traceability',
  points: [{ id: 'kickoff', text: kickoff, evidenceIds: ['T0001'], reviewFlagIds: ['source-check'],
    supportingDetails: [{ id: 'condition', text: condition, evidenceIds: ['T0002'], reviewFlagIds: ['source-check'] },
      { id: 'spoken', text: 'Working with US staff, we will help.', evidenceIds: ['T0003'] }] },
  { id: 'manual', text: 'Working with us on the approval process.', evidenceIds: ['T0003'],
    reviewFlagIds: [], supportingDetails: [], reviewerAuthored: true }],
  decisions: [], openQuestions: [] }];

test('actual primary and supporting cleanup preserves text, timing, qualifications, citations and reviewer locks', () => {
  const input = topics();
  const before = structuredClone(input);
  const cleaned = removeRawGeneratedDiscussionRows(input);
  assert.deepEqual(input, before, 'cleanup does not mutate the supplied tree');
  assert.deepEqual(cleaned[0].points.map(row => row.id), ['kickoff', 'manual']);
  assert.deepEqual(cleaned[0].points[0], { ...before[0].points[0], supportingDetails: [before[0].points[0].supportingDetails[0]] });
  assert.deepEqual(cleaned[0].points[1], before[0].points[1]);
  assert.deepEqual(removeRawGeneratedDiscussionRows(JSON.parse(JSON.stringify(cleaned))), cleaned);
});

// The real public and export builders share the same cleaned discussion.
// No provider or database call is allowed while exercising those boundaries.
process.env.MEETING_MINUTES_AGENT_SPECULATIVE_PIPELINE_V1 = '0';
const fetchPath = require.resolve('node-fetch');
const originalFetch = require(fetchPath);
let externalCalls = 0;
const forbidden = () => { externalCalls += 1; throw new Error('External calls are forbidden in acronym regressions'); };
require.cache[fetchPath].exports = forbidden;
const db = require('../utils/db');
const originalDb = { ...db };
for (const [key, value] of Object.entries(db)) if (typeof value === 'function') db[key] = forbidden;
const api = require('../routes/api').stagedEvaluation;
Object.assign(db, originalDb);
require.cache[fetchPath].exports = originalFetch;
test.after(() => assert.equal(externalCalls, 0));

test('source-backed acronym content reaches public, Word and PDF boundaries without adding claims', async () => {
  const discussion = removeRawGeneratedDiscussionRows(topics());
  const draft = { draftId: 'acronym-voice', revision: 1, payloadVersion: 5,
    details: { meetingTitle: 'Registration review', meetingType: 'General', meetingDate: '2026-10-21' },
    sourceUnits: [{ id: 'T0001', speaker: 'Morgan', text: kickoff }, { id: 'T0002', speaker: 'Morgan', text: condition },
      { id: 'T0003', speaker: 'Morgan', text: 'Working with us on the approval process.' }],
    discussion, actions: [], reviewFlags: [{ id: 'source-check', kind: 'unclear_reference', status: 'open',
      message: 'Check the registration source wording.', evidenceIds: ['T0001', 'T0002'], correctionNote: '' }],
    executiveSummary: '', meetingObjectives: [], qualityState: { discussion: { topicArrangementVersion: 1 } } };
  const before = structuredClone(draft);
  for (const output of [api.publicMeetingAgentDraft(draft), api.meetingAgentDraftForDocx(draft)]) {
    const rows = output.discussion.flatMap(topic => topic.points);
    const row = rows.find(item => item.id === 'kickoff');
    assert.equal(row?.text, kickoff);
    assert.deepEqual(row.evidenceIds, ['T0001']);
    assert.deepEqual(row.reviewFlagIds, ['source-check']);
    assert.equal(row.supportingDetails.find(detail => detail.id === 'condition')?.text, condition);
    assert.equal(rows.find(item => item.id === 'manual')?.reviewerAuthored, true);
  }
  const pdf = api.meetingAgentDraftForPdf(draft, true);
  assert.ok(pdf.discussion.some(topic => topic.points.includes(kickoff)));
  assert.ok(pdf.supportingDetails.some(detail => detail.text === condition));
  const JSZip = require('jszip');
  const { generateMeetingMinutesAgentDocx } = require('../utils/meetingMinutesAgentDocx');
  const document = await JSZip.loadAsync(await generateMeetingMinutesAgentDocx(api.meetingAgentDraftForDocx(draft), true));
  const xml = await document.file('word/document.xml').async('string');
  assert.ok(xml.includes(kickoff));
  assert.ok(xml.includes(condition));
  assert.deepEqual(draft, before);
});
