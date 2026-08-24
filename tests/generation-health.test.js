'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { assessGenerationHealth } = require('../routes/api').stagedEvaluation;

// The per-generation health judgement.
//
// Every silent failure in the staged pipeline followed the same script: a component
// degraded, said nothing, and the output looked plausible. Each of the incidents below was
// dug out of pm2 logs and the database by hand, and each is now a named degradation on the
// generation that suffered it. The tests are organised around those incidents rather than
// around the code, because "would this have caught the last five" is the only acceptance
// test a health record has.
//
// The counter-rule matters as much as the rule: a step that chose not to run - wrong
// stage, nothing to do, reviewer already confirmed the text - is quiet. Flagging the
// ordinary path teaches reviewers to ignore the flag, which is the exact failure this
// exists to end.

const FULL = { stage: 'summary', trooper: { used: false, reason: 'Trooper is not used for this stage.' }, summaryPolish: { attempted: true, used: true, reason: 'accepted_cited' }, grammarPolish: { attempted: true, used: false, reason: 'superseded_by_evidence_polish' }, wordingRepair: {} };

test('the ordinary full path is quiet', () => {
  const health = assessGenerationHealth(FULL);
  assert.equal(health.served, 'full');
  assert.deepEqual(health.degradations, []);
});

test('incident: the summary polish rejected invisibly and the fallback served', () => {
  // The original silent failure: a validator refused a correct summary, the deterministic
  // floor reproduced the thin output that prompted the work, and nothing said so.
  const health = assessGenerationHealth({ ...FULL, summaryPolish: { attempted: true, used: false, reason: 'new_substantive_wording' } });
  assert.equal(health.served, 'degraded');
  assert.equal(health.degradations[0].step, 'summary_polish');
});

test('incident: a token ceiling presented as a wording complaint', () => {
  // The 422-truncation chain. The polish "worked" - used=true - but the response was cut
  // short and the retry dropped the evidence pack, and both facts vanished into a reason
  // string about vocabulary.
  const health = assessGenerationHealth({ ...FULL, summaryPolish: { attempted: true, used: true, reason: 'accepted_cited', truncated: true, degraded: true } });
  assert.equal(health.served, 'degraded');
  assert.deepEqual(health.degradations.map((item) => item.reason).sort(), ['response_truncated', 'retried_without_evidence']);
});

test('incident: the actions rewrite failed over HTTP and raw wording served', () => {
  const health = assessGenerationHealth({ stage: 'actions', trooper: { used: false, reason: 'Trooper canonical actions rewrite failed with status 500.' }, summaryPolish: {}, grammarPolish: {}, wordingRepair: {} });
  assert.equal(health.served, 'degraded');
  assert.equal(health.degradations[0].step, 'trooper_rewrite');
});

test('incident: the wording repair could not run, flagged rows shipped as extracted', () => {
  // Repair failing its guards on a row is NOT a degradation - those rows carry their own
  // flag. Only a repair that could not run at all is one, and the label says what that
  // means for the reviewer: the flagged rows published as extracted.
  const transportFailure = assessGenerationHealth({ stage: 'actions', trooper: { used: true, reason: 'ok' }, summaryPolish: {}, grammarPolish: {}, wordingRepair: { attempted: 3, repaired: 0, reason: 'http_500' } });
  assert.equal(transportFailure.served, 'degraded');
  assert.match(transportFailure.degradations[0].label, /3 flagged rows published as extracted/);

  const guardsRefused = assessGenerationHealth({ stage: 'actions', trooper: { used: true, reason: 'ok' }, summaryPolish: {}, grammarPolish: {}, wordingRepair: { attempted: 3, repaired: 1, reason: '' } });
  assert.equal(guardsRefused.served, 'full');
});

test('steps that chose not to run stay quiet', () => {
  // Missing key on a details stage, nothing to rewrite, reviewer-confirmed text, the
  // grammar pass superseded by the evidence polish - all ordinary, none flagged.
  for (const quiet of [
    { ...FULL, stage: 'details' },
    { ...FULL, trooper: { used: false, reason: 'No bounded evidence pack.' } },
    { ...FULL, trooper: { used: false, reason: 'No published actions to rewrite.' } },
    { ...FULL, grammarPolish: { attempted: true, used: false, reason: 'reviewer_confirmed' } },
    { ...FULL, summaryPolish: { attempted: false } }
  ]) {
    assert.equal(assessGenerationHealth(quiet).served, 'full', JSON.stringify(quiet));
  }
});

test('a validator doing its job is not a degradation; a pass that could not run is', () => {
  // The grammar pass refusing its own suggestion serves the text it was handed - nothing
  // lost, guard working, quiet. The same pass failing over HTTP means nothing checked the
  // grammar at all. The summary polish is deliberately judged the other way: its validator
  // refusing serves the deterministic floor, which is a genuinely lesser screen and was
  // the original silent incident.
  const guardWorked = assessGenerationHealth({ ...FULL, grammarPolish: { attempted: true, used: false, reason: 'protected_fact_removed' } });
  assert.equal(guardWorked.served, 'full');
  const couldNotRun = assessGenerationHealth({ ...FULL, grammarPolish: { attempted: true, used: false, reason: 'http_500' } });
  assert.equal(couldNotRun.served, 'degraded');
});

test('an actions stage with no Trooper key is a degradation, not a quiet skip', () => {
  // The reviewer sees deterministic wording believing it was polished. That is precisely
  // the state the record exists to name.
  const health = assessGenerationHealth({ stage: 'actions', trooper: { used: false, reason: 'TROOPER_API_KEY is not configured.' }, summaryPolish: {}, grammarPolish: {}, wordingRepair: {} });
  assert.equal(health.served, 'degraded');
});
