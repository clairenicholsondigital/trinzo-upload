'use strict';

// Generic cases only: none of these sentences come from the evaluation corpus.
const test = require('node:test');
const assert = require('node:assert/strict');
const { preselectActionProposal, echoesPublishedAction } = require('../routes/api').stagedEvaluation;
const { resolveOfferedDateChoice, isNotAnAction, normaliseSourceUnits } = require('../utils/meetingMinutesAgentV2');

const action = (id, text, owners, evidenceIds = ['T0004']) => ({
  id, action: text, owners, timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds, reviewFlagIds: []
});

test('a suggestion for work already in the list is not pre-ticked, whoever owns it', () => {
  const published = [action('a', 'Schedule and hold the follow-up review session once the supplier answers are in.', ['Dana Moss'])];
  const proposal = { changes: [{ id: 'c1', type: 'add', before: null,
    after: action('b', 'Arrange the follow-up review session for the ninth or tenth of July as discussed.', ['Lee Hart'], ['T0009']) }] };
  const out = preselectActionProposal(proposal, published, []);
  assert.equal(out.changes[0].selected, false);
  assert.match(out.changes[0].reviewContext.label, /already in the list/);
  assert.ok(echoesPublishedAction(published[0], proposal.changes[0].after));
});

test('separate work with words in common is still pre-tickable', () => {
  assert.ok(!echoesPublishedAction(
    { action: 'Send the risk analysis to the auditor before she arrives.' },
    { action: 'Send the audit tracker to the auditor during the audit week.' }));
});

test('an offered choice of dates resolves to the day the meeting settled on', () => {
  const units = normaliseSourceUnits([
    { id: 'T0001', speaker: 'Chair', text: "Let's put the follow-up in for the ninth or the tenth of July.", classification: 'keep' },
    { id: 'T0002', speaker: 'Lee Hart', text: 'The tenth suits better.', classification: 'keep' },
    { id: 'T0003', speaker: 'Chair', text: 'Tenth it is.', classification: 'keep' }
  ]);
  const resolved = resolveOfferedDateChoice(
    { kind: 'target', wording: 'ninth or tenth of July', exactDate: '' }, units, ['T0001'], { meetingDate: '2026-06-24' });
  assert.match(resolved.wording, /tenth of July/);
  assert.ok(!/ninth/.test(resolved.wording));
  // No choice made: the offer stands as it was said.
  const undecided = normaliseSourceUnits([units[0], { id: 'T0002', speaker: 'Lee Hart', text: 'Either works for me.', classification: 'keep' }]);
  assert.equal(resolveOfferedDateChoice({ kind: 'target', wording: 'ninth or tenth of July', exactDate: '' },
    undecided, ['T0001'], { meetingDate: '2026-06-24' }).wording, 'ninth or tenth of July');
});

test('a standing rule is not an action', () => {
  assert.ok(isNotAnAction('Always ask about dietary requirements to ensure any needs are addressed.'));
  assert.ok(isNotAnAction('Never share the tracker outside the audit team.'));
  assert.ok(!isNotAnAction('Ask the venue about dietary requirements before Friday.'));
});
