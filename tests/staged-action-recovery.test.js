'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildEvidenceBoundStagedActionInventory,
  parseDeadlineEvidence,
  parseTranscriptTurns
} = require('../utils/stagedActionRecovery');

test('deadline parser rejects incomplete relative-date fragments', () => {
  assert.equal(parseDeadlineEvidence('Complete this by the end of the'), null);
  assert.equal(parseDeadlineEvidence('Complete this by end of next'), null);
  assert.equal(parseDeadlineEvidence('Complete this by next week').normalised, 'Next week');
  assert.equal(parseDeadlineEvidence('Complete this by the end of next week').normalised, 'End of next week');
});

const REPO_DIR = path.resolve(__dirname, '..');

test('parses Teams speaker blocks into attributed turns', () => {
  const turns = parseTranscriptTurns([
    'Rebecca Cuckoo   23:08',
    'I am updating the risk file.',
    'I will share it on Wednesday.',
    'Jacqui Fox   23:43',
    'Thanks.'
  ].join('\n'));

  assert.deepEqual(turns, [
    {
      turnIndex: 0,
      speaker: 'Rebecca Cuckoo',
      text: 'I am updating the risk file. I will share it on Wednesday.',
      segments: ['I am updating the risk file.', 'I will share it on Wednesday.']
    },
    { turnIndex: 1, speaker: 'Jacqui Fox', text: 'Thanks.', segments: ['Thanks.'] }
  ]);
});

test('recovers the T761 risk action only from one grounded speaker turn', () => {
  const transcript = [
    'Rebecca Cuckoo   23:08',
    'I was in the middle of inputting it onto the risk management file.',
    'We are looking at one port lock for the USB on the back of the device.',
    'The screen element can also be accessed, so a control is needed on the screen.',
    'I am tidying up the risk management file sheet to share back and I am hoping to get that done for Wednesday.'
  ].join('\n');

  assert.deepEqual(buildEvidenceBoundStagedActionInventory(transcript), [{
    owner: 'Rebecca Cuckoo',
    action: 'Update the risk management file to address USB port-lock controls and screen-access controls',
    evidenceAction: '',
    deadline: 'Wednesday',
    reviewDisposition: 'confirmed_action',
    source: 'evidence_bound_transcript_action',
    evidence: 'We are looking at one port lock for the USB on the back of the device. The screen element can also be accessed, so a control is needed on the screen. I am tidying up the risk management file sheet to share back and I am hoping to get that done for Wednesday.',
    sourceTurnIds: [0],
    recoveryRule: 'risk_controls'
  }]);
});

test('does not combine disconnected keywords into an Eakin action', () => {
  const transcript = [
    'Alex Smith   0:01',
    'The risk management file was mentioned as background to the audit.',
    'Priya Shah   18:20',
    'A USB screen was used during the demonstration on Wednesday.',
    'Morgan Lee   32:10',
    'The old port lock was replaced last year.'
  ].join('\n');

  assert.deepEqual(buildEvidenceBoundStagedActionInventory(transcript), []);
});

test('does not recover a future action from completed historical work', () => {
  const transcript = [
    'Rebecca Cuckoo   23:08',
    'The risk management file already covered the USB port lock and screen controls. The work was completed last year.'
  ].join('\n');

  assert.deepEqual(buildEvidenceBoundStagedActionInventory(transcript), []);
});

test('recovers multiple evidence-bound actions from the real T761 fixture without affecting Abbott', () => {
  const t761 = fs.readFileSync(path.join(
    REPO_DIR,
    'scripts/meeting-minutes-final-golden/025_real_t761_eakin_sw_weekly_transcript/transcript.txt'
  ), 'utf8');
  const abbott = fs.readFileSync(path.join(
    REPO_DIR,
    'scripts/meeting-minutes-final-golden/027_real_abbott_audit_kickoff_transcript/transcript.txt'
  ), 'utf8');

  const t761Inventory = buildEvidenceBoundStagedActionInventory(t761);
  const t761Actions = t761Inventory.map((item) => item.action);
  const abbottActions = buildEvidenceBoundStagedActionInventory(abbott).map((item) => item.action);

  assert.ok(t761Actions.some((action) => /mute button/i.test(action)));
  assert.ok(t761Actions.some((action) => /clinical review/i.test(action)));
  assert.ok(t761Actions.some((action) => /electrical compliance/i.test(action)));
  assert.ok(t761Actions.some((action) => /USB port-lock/i.test(action)));
  assert.ok(!abbottActions.some((action) => /USB|mute button|clinical review|electrical compliance/i.test(action)));

  const electrical = t761Inventory.find((item) => /electrical compliance testing/i.test(item.action));
  const fanLogic = t761Inventory.find((item) => /fan logic/i.test(item.action));
  const clinical = t761Inventory.find((item) => /clinical review/i.test(item.action));
  assert.equal(electrical.deadline, '23rd of July');
  assert.equal(fanLogic.deadline, 'Not stated');
  assert.equal(fanLogic.owner, 'Not stated');
  assert.equal(clinical.owner, 'Not stated');
});

test('reads trailing owners from a minutes-style action table', () => {
  const minutes = fs.readFileSync(path.join(
    REPO_DIR,
    'scripts/meeting-minutes-final-golden/022_real_eakin_sw_minutes_pdf/transcript.txt'
  ), 'utf8');
  const inventory = buildEvidenceBoundStagedActionInventory(minutes);
  const mute = inventory.find((item) => /mute button flash sequence/i.test(item.action));
  const clinical = inventory.find((item) => /clinical review of code changes/i.test(item.action));
  const electrical = inventory.find((item) => /^Complete Electrical compliance testing$/i.test(item.action));
  const retrospective = inventory.find((item) => /retrospective test data/i.test(item.action));

  assert.equal(mute.owner, 'Andrew');
  assert.equal(mute.deadline, '19th June');
  assert.equal(clinical.owner, 'Rebecca');
  assert.equal(clinical.deadline, '26th June');
  assert.equal(electrical.owner, 'Andrew');
  assert.equal(electrical.deadline, '23rd July');
  assert.equal(retrospective.owner, 'Andrew');
});

test('parses DOCX-style inline Teams speaker timestamps through the canonical parser', () => {
  const turns = parseTranscriptTurns([
    'Orla Skally 7:41Yeah, no problem. I’ll take a look at it.',
    'Mark Kelleher 7:44Thank you.',
    'Orla Skally 7:46This week.',
    'Jacqui Fox 7:47OK, this is the QMS manual.'
  ].join('\n'));

  assert.equal(turns.length, 4);
  assert.equal(turns[0].speaker, 'Orla Skally');
  assert.match(turns[0].text, /take a look/i);
  assert.equal(turns[2].speaker, 'Orla Skally');
});

test('recovers DITA follow-ups only from the real DITA evidence windows', () => {
  const dita = fs.readFileSync(path.join(
    REPO_DIR,
    'scripts/meeting-minutes-final-golden/021_real_dita_importer_obligations_transcript/transcript.txt'
  ), 'utf8');
  const abbott = fs.readFileSync(path.join(
    REPO_DIR,
    'scripts/meeting-minutes-final-golden/027_real_abbott_audit_kickoff_transcript/transcript.txt'
  ), 'utf8');

  const ditaActions = buildEvidenceBoundStagedActionInventory(dita).map((item) => item.action);
  const abbottActions = buildEvidenceBoundStagedActionInventory(abbott).map((item) => item.action);

  assert.ok(ditaActions.includes('Follow up on the Med Envoy project plan or task list'));
  assert.ok(ditaActions.includes('Review the HPRA authorised-representative bill'));
  assert.ok(ditaActions.includes('Update the declarations of conformity with the PPE risk rationale'));
  assert.ok(ditaActions.includes('Review the QMS Manual'));
  assert.ok(ditaActions.includes('Review the updated label from an importer perspective'));
  assert.ok(ditaActions.includes('Prepare the country and language list'));
  assert.equal(ditaActions.length, 6);
  assert.ok(!abbottActions.some((action) => /Med Envoy|HPRA|PPE risk rationale/i.test(action)));
});

test('recovers the DITA working-session action from locally grouped scheduling evidence', () => {
  const ditaInternal = fs.readFileSync(path.join(
    REPO_DIR,
    'scripts/meeting-minutes-final-golden/024_real_dita_internal_followup_transcript/transcript.txt'
  ), 'utf8');
  const actions = buildEvidenceBoundStagedActionInventory(ditaInternal).map((item) => item.action);

  assert.ok(actions.includes('Set up working sessions with the client'));
});
