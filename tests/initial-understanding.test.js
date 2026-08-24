'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runCanonicalLiveStage, buildConfirmedState } = require('../utils/canonicalMinutes/liveStages');
const { buildInitialUnderstanding } = require('../utils/canonicalMinutes/initialUnderstanding');
const { prepareEvidence } = require('../utils/canonicalMinutes/evidence');
const { loadMiniLMProfileSync } = require('../utils/canonicalMinutes/minilm');
const { assessEvidenceTopology } = require('../utils/canonicalMinutes/topology');
const { groundProposal } = require('../utils/canonicalMinutes/grounding');
const semanticStages = require('../utils/canonicalMinutes/semanticStages');

function fixturePath(name) {
  return path.join(__dirname, '..', 'scripts', 'meeting-minutes-final-golden', name, 'transcript.txt');
}

function summaryFor(fixture, details) {
  const transcript = fs.readFileSync(fixturePath(fixture), 'utf8');
  return runCanonicalLiveStage(transcript, {
    stage: 'summary',
    fileName: 'transcript.txt',
    confirmed: { details }
  }).screens.summary;
}

function combinedSummaryText(summary) {
  return [
    summary.meetingPurpose,
    summary.executiveSummary,
    ...(summary.objectives || []),
    ...(summary.overallTopics || [])
  ].join('\n');
}

test('cold DITA summary proposes purpose rather than reviewed-topic enumeration', () => {
  const summary = summaryFor('021_real_dita_importer_obligations_transcript', {
    meetingTitle: 'Client DITA T819 Importer Obligations review plan',
    meetingType: 'Importer Obligations Review'
  });
  assert.match(summary.meetingPurpose, /understand DITA's actual operational processes/i);
  assert.match(summary.meetingPurpose, /importer-obligation procedures/i);
  assert.doesNotMatch(summary.meetingPurpose, /^The meeting reviewed\b/i);
  assert.ok((summary.overallTopics || []).some((topic) => /goods flow|storage/i.test(topic)));
  assert.ok((summary.overallTopics || []).some((topic) => /procedure|QMS/i.test(topic)));
  assert.equal(summary.keyFacts, undefined);
  assert.equal(summary.initialUnderstanding.provenance, 'model_inferred');
});

test('cold Abbott summary frames audit preparation and rejects fragment topics', () => {
  const summary = summaryFor('027_real_abbott_audit_kickoff_transcript', {
    meetingTitle: 'Client Abbott T796 Audit kick off Sylmar',
    meetingType: 'Audit kick-off / planning'
  });
  const text = combinedSummaryText(summary);
  assert.match(summary.meetingPurpose, /align the audit team/i);
  assert.match(summary.meetingPurpose, /Sylmar/i);
  assert.match(summary.meetingPurpose, /software/i);
  assert.doesNotMatch(summary.meetingPurpose, /^The meeting reviewed\b/i);
  assert.ok((summary.overallTopics || []).some((topic) => /audit scope|timing|logistics/i.test(topic)));
  assert.ok((summary.overallTopics || []).some((topic) => /preparation|confidentiality|access/i.test(topic)));
  assert.doesNotMatch(text, /\bUSB\b|\bGUI\b/i);
  assert.doesNotMatch(text, /\bEven gone through\b/i);
});

test('cold T761 summary frames weekly technical-file coordination instead of taxonomy', () => {
  const summary = summaryFor('025_real_t761_eakin_sw_weekly_transcript', {
    meetingTitle: 'Client T761 Eakin SW Weekly Checkin',
    meetingType: 'Software Weekly Review'
  });
  assert.match(summary.meetingPurpose, /coordinate progress, evidence gaps, blockers and next steps/i);
  assert.match(summary.meetingPurpose, /software-change and technical-file programme/i);
  assert.doesNotMatch(summary.meetingPurpose, /^The meeting reviewed\b/i);
  assert.ok((summary.overallTopics || []).some((topic) => /alarm/i.test(topic)));
  assert.ok((summary.overallTopics || []).some((topic) => /change control|version traceability/i.test(topic)));
  assert.ok((summary.overallTopics || []).some((topic) => /electrical compliance/i.test(topic)));
  // Objectives used to be a fixed list attached to the meeting type, identical
  // for every software weekly review. They are now drawn from this meeting's
  // own actions, so the assertion is that they are specific to this transcript
  // rather than that they open with the profile's verb.
  const objectives = (summary.objectives || []).map((objective) => objective.text || objective);
  assert.ok(objectives.length, 'the summary still proposes objectives');
  assert.ok(objectives.some((objective) => /usb|mute button|electrical compliance|alarm/i.test(objective)),
    `expected objectives specific to this meeting, got: ${JSON.stringify(objectives)}`);
  assert.ok(!objectives.some((objective) => /technical-file package|change-control workstreams/i.test(objective)),
    'the fixed meeting-type objectives should no longer be emitted');
});

test('initial understanding keeps fragmentary evidence out of high-level workstreams', () => {
  const evidence = prepareEvidence([
    'Jacqui Fox  00:01',
    'Even gone through.',
    'Niamh Byrne  00:04',
    'We need to confirm the audit scope and complete the confidentiality access steps before the audit starts.'
  ].join('\n'));
  const understanding = buildInitialUnderstanding({
    evidence,
    meeting: { title: 'Client Audit Kick Off Sylmar', type: 'Audit kick-off / planning' },
    topics: [
      { id: 'bad', text: 'Even gone through', representativeText: 'Even gone through', evidenceIds: [evidence.events[0].id] },
      { id: 'good', text: 'Audit scope and access preparation', representativeText: evidence.events[1].text, evidenceIds: [evidence.events[1].id] }
    ]
  });
  assert.equal(understanding.primaryWorkstreams.some((item) => /Even gone through/i.test(item.label)), false);
  assert.ok(understanding.primaryWorkstreams.some((item) => /audit scope|preparation|access/i.test(item.label)));
});

test('cold Eakin sanity fixture remains grounded outside the three primary regressions', () => {
  const summary = summaryFor('023_real_eakin_t733_weekly_transcript', {
    meetingTitle: 'Client Eakin T733 Tech File review weekly',
    meetingType: 'Technical file review'
  });
  assert.match(summary.meetingPurpose, /technical-file programme|change package/i);
  assert.doesNotMatch(summary.meetingPurpose, /^The meeting reviewed\b/i);
  assert.equal(summary.initialUnderstanding.provenance, 'model_inferred');
  assert.ok((summary.initialUnderstanding.meetingSpine || []).every((item) => (item.evidenceIds || []).length));
});

test('T761 cold understanding does not publish the previous broad Colm topic-list action', () => {
  const transcript = fs.readFileSync(fixturePath('025_real_t761_eakin_sw_weekly_transcript'), 'utf8');
  const details = {
    meetingTitle: 'Client T761 Eakin SW Weekly Checkin',
    meetingType: 'Software Weekly Review'
  };
  const summary = runCanonicalLiveStage(transcript, {
    stage: 'summary',
    fileName: 't761.txt',
    confirmed: { details }
  }).screens.summary;
  const evidence = prepareEvidence(transcript);
  const profile = loadMiniLMProfileSync(evidence, {});
  const topology = assessEvidenceTopology(evidence);
  const state = buildConfirmedState(transcript, 't761.txt', { details, summary });
  const proposal = groundProposal(semanticStages.actionsStage(evidence, state, profile, topology), evidence);
  const confirmed = (proposal.actions || []).map((item) => `${item.owner || ''} - ${item.action || ''}`).join('\n');
  assert.doesNotMatch(confirmed, /Colm\s+-\s+Review the language support and localisation, cybersecurity and access controls, electrical compliance testing/i);
  assert.doesNotMatch(confirmed, /Colm\s+-\s+Review .*software change control/i);
});

test('T761 cold actions do not inherit importer-obligation process-discovery wording', () => {
  const transcript = fs.readFileSync(fixturePath('025_real_t761_eakin_sw_weekly_transcript'), 'utf8');
  const details = {
    meetingTitle: 'Client T761 Eakin SW Weekly Checkin',
    meetingType: 'Software Weekly Review'
  };
  const summary = runCanonicalLiveStage(transcript, {
    stage: 'summary',
    fileName: 't761.txt',
    confirmed: { details }
  }).screens.summary;
  const discussion = runCanonicalLiveStage(transcript, {
    stage: 'discussion',
    fileName: 't761.txt',
    confirmed: { details, summary }
  }).screens.discussion;
  const actions = runCanonicalLiveStage(transcript, {
    stage: 'actions',
    fileName: 't761.txt',
    confirmed: { details, summary, discussion },
    includeEvidencePack: true
  });
  const candidateText = JSON.stringify(actions.validationFlags || []);
  assert.doesNotMatch(candidateText, /importer-obligation|process-discovery working sessions/i);
});

test('DITA cold understanding retains legitimate importer process-discovery context', () => {
  const summary = summaryFor('021_real_dita_importer_obligations_transcript', {
    meetingTitle: 'Client DITA T819 Importer Obligations review plan',
    meetingType: 'Importer Obligations Review'
  });
  const text = combinedSummaryText(summary);
  assert.match(text, /importer-obligation|procedure|goods flow|storage/i);
  assert.match(text, /process|operational/i);
});

test('cold fixture sequence remains isolated across Abbott, T761 and DITA', () => {
  const t761First = summaryFor('025_real_t761_eakin_sw_weekly_transcript', {
    meetingTitle: 'Client T761 Eakin SW Weekly Checkin',
    meetingType: 'Software Weekly Review'
  });
  const abbottAfterT761 = summaryFor('027_real_abbott_audit_kickoff_transcript', {
    meetingTitle: 'Client Abbott T796 Audit kick off Sylmar',
    meetingType: 'Audit kick-off / planning'
  });
  const ditaAfterAbbott = summaryFor('021_real_dita_importer_obligations_transcript', {
    meetingTitle: 'Client DITA T819 Importer Obligations review plan',
    meetingType: 'Importer Obligations Review'
  });
  const abbottText = combinedSummaryText(abbottAfterT761);
  const t761Text = combinedSummaryText(t761First);
  const ditaText = combinedSummaryText(ditaAfterAbbott);
  assert.doesNotMatch(abbottText, /\bUSB\b|\bGUI\b|alarm-code|mute button/i);
  assert.doesNotMatch(t761Text, /importer-obligation|MedEnvoy|sunglasses/i);
  assert.doesNotMatch(ditaText, /Sylmar|mute button|alarm-code|USB|GUI/i);
});

// The hint-free objective rung.
//
// Objectives had two rungs and both needed scaffolding the informal meetings lack: hints
// come from a meeting-type profile, and per-workstream derivation needs workstreams. An
// allotment committee has neither, so a meeting with six clean deterministic actions
// published ONE objective while its human minutes listed five - each of which was one of
// those actions abstracted ("Confirm repair action for the broken water butt tap"). The
// meeting's own selected actions are the best statement of what it set out to do, and
// they need no profile to say so.
test('a meeting with no profile and no workstreams still gets objectives from its own actions', () => {
  const { buildObjectives } = require('../utils/canonicalMinutes/initialUnderstanding');
  const objectives = buildObjectives('', [], { evidenceIds: [] }, [
    { action: 'Replace the broken water butt tap on Saturday', evidenceIds: ['e1'] },
    { action: 'Email the top three people on the waiting list', evidenceIds: ['e2'] }
  ], []);
  const texts = objectives.map((item) => item.text.toLowerCase());
  assert.ok(texts.some((text) => text.includes('water butt')), JSON.stringify(texts));
  assert.ok(texts.some((text) => text.includes('waiting list')), JSON.stringify(texts));
  // Each carries its own action's evidence, not a pooled set.
  assert.deepEqual(objectives.map((item) => item.evidenceIds), [['e1'], ['e2']]);
});

test('the floor never publishes an objective in the speaker\'s voice', () => {
  // An action can carry its speaker's voice onto the actions screen, where the rewrite
  // and repair passes exist to fix it. An objective has no repair pass, so "and I'll use
  // the word liability" must not become one - and mechanical redundancy is deleted first
  // because deleting a repeated phrase never changes the claim.
  const { buildObjectives } = require('../utils/canonicalMinutes/initialUnderstanding');
  const objectives = buildObjectives('', [], { evidenceIds: [] }, [
    { action: "Write to the council again, and I'll use the word liability", evidenceIds: ['e1'] },
    { action: 'Get one from the, from the place on Mill Road', evidenceIds: ['e2'] }
  ], []);
  const texts = objectives.map((item) => item.text);
  assert.ok(!texts.some((text) => /\bI'll\b/i.test(text)), JSON.stringify(texts));
  assert.ok(texts.some((text) => /from the place on Mill Road/.test(text) && !/the, from the/.test(text)), JSON.stringify(texts));
});

test('an action-derived objective never becomes a topic heading', () => {
  // The topics-from-objectives stopgap strips a leading verb and publishes the rest as a
  // heading, which only makes sense for topic-shaped objectives. "Redline the exit
  // clause" is an instruction; stripping its verb makes a worse instruction, not a
  // subject - measured: 21 instructions became headings across 14 transcripts on the
  // first draft of this rung, and the actionDerived flag is what pulled them back.
  const { buildObjectives } = require('../utils/canonicalMinutes/initialUnderstanding');
  const objectives = buildObjectives('', [], { evidenceIds: [] }, [
    { action: 'Redline the exit clause by Friday', evidenceIds: ['e1'] }
  ], []);
  assert.equal(objectives[0].actionDerived, true);
});
