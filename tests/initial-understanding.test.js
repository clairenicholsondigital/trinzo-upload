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
  assert.ok((summary.objectives || []).some((objective) => /^Coordinate\b/i.test(objective)));
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
