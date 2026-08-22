'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createCanonicalState, acceptProposal } = require('../utils/canonicalMinutes/state');
const { auditConfirmedAgainstScreen } = require('../utils/canonicalMinutes/runner');

// Whether the reviewer can tell the tool listened.
//
// Everything else in this work makes corrections stick. This is what makes that visible:
// a correction that was honoured and one that was quietly dropped are indistinguishable
// on screen otherwise, and being unable to tell the difference is the reason to stop
// trusting the tool. The audit answers "what became of what I changed", per screen.

function stateWithConfirmedSummary(overrides = {}) {
  const state = createCanonicalState({ transcriptText: 'transcript', fileName: 't.txt', meeting: {} });
  return acceptProposal(state, {
    objectives: [{ text: 'Agree who carries the importer obligations' }],
    topics: [{ text: 'Where the goods physically go' }, { text: 'What HPRA will ask for' }],
    meeting: { purpose: 'Agree who owns what before the HPRA submission.' },
    meetingUnderstanding: {
      meetingPurpose: 'Agree who owns what before the HPRA submission.',
      criticalFacts: [{ id: 'f1', text: 'Final storage is at DITA Park West in Dublin.' }]
    },
    ...overrides
  }, { source: 'stage_1_human_confirmation' });
}

test('the audit reports which confirmed values a screen was built from', () => {
  const state = stateWithConfirmedSummary();
  const screen = {
    meetingPurpose: 'Agree who owns what before the HPRA submission.',
    objectives: ['Agree who carries the importer obligations'],
    overallTopics: ['Where the goods physically go', 'What HPRA will ask for']
  };
  const audit = auditConfirmedAgainstScreen(state, 'summary', screen);

  assert.equal(audit.stage, 'summary');
  assert.equal(audit.confirmedCount, 4);
  assert.equal(audit.carriedCount, 4);
  assert.deepEqual(audit.missing, []);
  assert.deepEqual(
    audit.carried.map((item) => item.label).sort(),
    ['objective', 'purpose', 'topic', 'topic']
  );
});

test('the audit names a confirmed value the screen dropped, rather than leaving it to be noticed', () => {
  const state = stateWithConfirmedSummary();
  const screen = {
    meetingPurpose: 'Agree who owns what before the HPRA submission.',
    objectives: ['Agree who carries the importer obligations'],
    overallTopics: ['Where the goods physically go']
  };
  const audit = auditConfirmedAgainstScreen(state, 'summary', screen);

  assert.equal(audit.carriedCount, 3);
  assert.deepEqual(audit.missing, [{ label: 'topic', value: 'What HPRA will ask for' }]);
});

test('the discussion screen is audited against the topics and key facts, not the objectives', () => {
  // Each stage is asked only about what it could carry. Reporting a summary objective as
  // missing from Discussion would be noise, and noise is how a real one gets ignored.
  const state = stateWithConfirmedSummary();
  const cards = [
    { topic: 'Where the goods physically go', points: ['Final storage is at DITA Park West in Dublin.'] },
    { topic: 'What HPRA will ask for', points: ['Registration evidence was discussed.'] }
  ];
  const audit = auditConfirmedAgainstScreen(state, 'discussion', cards);

  assert.equal(audit.confirmedCount, 3, 'two topics and one key fact');
  assert.deepEqual(audit.missing, []);
  assert.ok(audit.carried.some((item) => item.label === 'key fact'));
  assert.ok(!audit.carried.some((item) => item.label === 'objective'));
});

test('a reviewer who confirmed nothing is told nothing', () => {
  // The panel this feeds must stay silent on a first pass, or it becomes furniture.
  const state = createCanonicalState({ transcriptText: 'transcript', fileName: 't.txt', meeting: {} });
  const audit = auditConfirmedAgainstScreen(state, 'summary', { meetingPurpose: 'Anything at all.' });
  assert.equal(audit.confirmedCount, 0);
  assert.equal(audit.carriedCount, 0);
  assert.deepEqual(audit.missing, []);
});

test('confirmed action owners are audited on the actions screen', () => {
  const state = createCanonicalState({ transcriptText: 'transcript', fileName: 't.txt', meeting: {} });
  const confirmed = acceptProposal(state, {
    actions: [
      { owner: 'Mark Kelleher', action: 'Circulate the DoC pack', deadline: 'Friday' },
      { owner: 'Not stated', action: 'Confirm the language list', deadline: 'Not stated' }
    ]
  }, { source: 'stage_3_human_confirmation' });

  const audit = auditConfirmedAgainstScreen(confirmed, 'actions', [
    { owner: 'Mark Kelleher', action: 'Circulate the DoC pack', deadline: 'Friday' }
  ]);

  // "Not stated" is the absence of an owner, so it is not something the reviewer
  // confirmed and must not be reported as carried or missing.
  assert.ok(!audit.carried.concat(audit.missing).some((item) => item.value === 'Not stated'));
  assert.ok(audit.carried.some((item) => item.label === 'owner' && item.value === 'Mark Kelleher'));
  assert.deepEqual(audit.missing.map((item) => item.value), ['Confirm the language list']);
});
