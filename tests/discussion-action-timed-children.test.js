'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { removeDiscussionActionDuplicates } = require('../utils/discussionShape');
const people = ['Morgan Lee', 'Dana Reed'];
const row = (id, text, extra = {}) => ({ id, text, evidenceIds: ['T0002'], supportingDetails: [], ...extra });
const parent = details => ({ id: 'parent', text: 'Morgan Lee will send the maintenance email this week.',
  evidenceIds: ['T0001'], supportingDetails: details, reviewFlagIds: ['review-note'] });
const topic = point => ({ id: 'maintenance', topic: 'Maintenance arrangements', points: [point], decisions: [], openQuestions: [] });
const parentAction = { id: 'email', action: 'Send the maintenance email this week.', owners: ['Morgan Lee'], evidenceIds: ['T0001'] };
const run = (details, actions = []) => removeDiscussionActionDuplicates([topic(parent(details))], [parentAction, ...actions], people);
const kept = result => result.discussion[0]?.points[0];

test('a duplicated parent retains independently timed supporting work without rewriting or promoting it', () => {
  const detail = row('reading', 'Morgan Lee will capture the instrument readings tomorrow.');
  const input = [topic(parent([detail]))], before = structuredClone(input);
  const result = removeDiscussionActionDuplicates(input, [parentAction], people);
  assert.deepEqual(kept(result), before[0].points[0]);
  assert.equal(result.dropped.length, 0);
  assert.equal(result.discussion[0].points.length, 1, 'no supporting claim is promoted into a new main point');
  assert.deepEqual(input, before);
});

test('complete same-owner same-source child wording in an accepted action allows the redundant parent to leave', () => {
  const detail = row('reading', 'Morgan Lee will capture the instrument readings tomorrow.');
  const action = { id: 'reading-action', action: 'Capture the instrument readings tomorrow.', owners: ['Morgan Lee'],
    evidenceIds: ['T0002'], timing: { kind: 'target', wording: 'tomorrow', exactDate: '' } };
  const result = run([detail], [action]);
  assert.equal(result.discussion.length, 0);
  assert.deepEqual(result.dropped.map(r => r.pointId), ['parent']);
});

test('an accepted action can represent explicit child owners and identical structured timing', () => {
  const timing = { kind: 'target', wording: 'between Monday and Wednesday', exactDate: '' };
  const detail = row('test', 'Test the cooling circuit.', { owners: ['Morgan Lee'], timing });
  const action = { id: 'test-action', action: detail.text, owners: ['Morgan Lee'], evidenceIds: ['T0002'], timing: { ...timing } };
  assert.equal(run([detail], [action]).discussion.length, 0);
  assert.ok(kept(run([detail], [{ ...action, timing: { ...timing, wording: 'Monday' } }])));
});

test('same-date similarity cannot erase a different operation, object, owner, recipient or direction', () => {
  const cases = [
    ['Morgan Lee will capture the instrument readings tomorrow.', 'Review the instrument readings tomorrow.', ['Morgan Lee']],
    ['Morgan Lee will capture the instrument readings tomorrow.', 'Capture the pump photographs tomorrow.', ['Morgan Lee']],
    ['Dana Reed will capture the instrument readings tomorrow.', 'Capture the instrument readings tomorrow.', ['Morgan Lee']],
    ['Morgan Lee will send the instrument readings to Dana Reed tomorrow.', 'Send the instrument readings to Evan Cole tomorrow.', ['Morgan Lee']],
    ['Morgan Lee will send equipment from warehouse North to warehouse South tomorrow.', 'Send equipment from warehouse South to warehouse North tomorrow.', ['Morgan Lee']],
    ['Morgan Lee will capture five instrument readings tomorrow.', 'Capture six instrument readings tomorrow.', ['Morgan Lee']]
  ];
  for (const [text, action, owners] of cases) {
    assert.ok(kept(run([row('detail', text)], [{ id: 'other', action, owners, evidenceIds: ['T0002'] }])), text);
  }
});

test('different timing, hedges, ranges, recurrence, clocks and zones keep the parent with its exact child', () => {
  const pairs = [
    ['Morgan Lee will capture the instrument readings tomorrow.', 'Capture the instrument readings next week.'],
    ['Morgan Lee will capture the instrument readings ideally on Friday.', 'Capture the instrument readings on Friday.'],
    ['Morgan Lee will inspect the cooling circuit between Monday and Wednesday.', 'Inspect the cooling circuit Monday.'],
    ['Morgan Lee will inspect the cooling circuit every Friday.', 'Inspect the cooling circuit Friday.'],
    ['Morgan Lee will inspect the cooling circuit for five hours.', 'Inspect the cooling circuit for six hours.'],
    ['Morgan Lee will capture the instrument readings at 09:00 UTC.', 'Capture the instrument readings at 10:00 UTC.'],
    ['Morgan Lee will capture the instrument readings at 09:00 UTC.', 'Capture the instrument readings at 09:00 BST.'],
    ['Morgan Lee will not send the instrument readings before approval.', 'Send the instrument readings before approval.']
  ];
  for (const [text, action] of pairs) {
    const detail = row('detail', text);
    const result = run([detail], [{ id: 'other', action, owners: ['Morgan Lee'], evidenceIds: ['T0002'] }]);
    assert.deepEqual(kept(result).supportingDetails, [detail], text);
  }
});

test('day-first May, shortened months, monthless ordinals, dayparts and numeric dates are retained conservatively', () => {
  for (const text of [
    'The documents must arrive by 13 May.', 'The documents must arrive by May 13.',
    'The documents must arrive by the thirteenth of May.', 'The documents must arrive in May.',
    'The documents must arrive by 13 Sept.', 'The documents must arrive by the 17th.',
    'The documents must arrive in the afternoon.', 'The documents must arrive by 03/04/2026.',
    'The documents must arrive within a fortnight.', 'The documents must arrive at 13.50.',
    'The documents must arrive by Wed.', 'The documents are collected on Fridays.',
    'The documents must arrive by close of business.', 'The register should be checked yearly.',
    'The documents should arrive at midday.'
  ]) assert.ok(kept(run([row('date', text)])), text);
});

test('unknown ownership, absent provenance and conflicting structured dates do not count as coverage', () => {
  const text = 'Capture the instrument readings tomorrow.';
  const action = { id: 'reading', action: text, owners: ['Morgan Lee'], evidenceIds: ['T0002'] };
  assert.ok(kept(run([row('unknown-owner', text)], [action])));
  const detail = row('reading', `Morgan Lee will ${text[0].toLowerCase() + text.slice(1)}`);
  assert.ok(kept(run([detail], [{ ...action, evidenceIds: ['T0099'] }])));
  assert.ok(kept(run([detail], [{ ...action, timing: { kind: 'target', wording: 'next week', exactDate: '' } }])));
  assert.ok(kept(run([detail], [{ ...action, timing: { kind: 'deadline', wording: 'tomorrow', exactDate: '2026-05-13' } }])));
});

test('one represented child cannot hide a second distinct timed child or nested timed context', () => {
  const captured = row('captured', 'Morgan Lee will capture the instrument readings tomorrow.');
  const accepted = { id: 'reading', action: 'Capture the instrument readings tomorrow.', owners: ['Morgan Lee'], evidenceIds: ['T0002'] };
  const extra = row('review', 'Dana Reed will review the instrument readings on Friday.');
  assert.equal(kept(run([captured, extra], [accepted])).supportingDetails.length, 2);
  const nested = row('background', 'The maintenance process was discussed.', { supportingDetails: [extra] });
  assert.deepEqual(kept(run([nested], [accepted])).supportingDetails, [nested]);
});

test('manual supporting content and reviewer-owned parent/topic survive even when untimed or already represented', () => {
  for (const marker of [{ reviewerAuthored: true }, { confirmedTopic: true }, { source: 'stage_3_human_confirmation' }]) {
    const detail = row('manual', 'The reviewer retained this background.', marker);
    assert.deepEqual(kept(run([detail])).supportingDetails, [detail]);
    const point = { ...parent([]), ...marker };
    assert.deepEqual(kept(removeDiscussionActionDuplicates([topic(point)], [parentAction], people)), point);
    const manualTopic = { ...topic(parent([])), ...marker };
    assert.deepEqual(removeDiscussionActionDuplicates([manualTopic], [parentAction], people).discussion, [manualTopic]);
  }
});

test('ordinary untimed context and raw transcript alone retain previous action-duplicate behavior', () => {
  assert.equal(run([row('context', 'The instrument has an engraved serial label.')]).discussion.length, 0);
  assert.equal(run([row('raw', 'So we should, you know, maybe inspect it tomorrow.')]).discussion.length, 0);
  assert.equal(run([]).discussion.length, 0);
});

test('V2 can import this preservation gate first without a circular temporal-review dependency', () => {
  const result = spawnSync(process.execPath, ['-e',
    "const V=require('./utils/meetingMinutesAgentV2');const D=require('./utils/discussionShape');if(typeof V.normaliseAgentResult!=='function'||typeof D.removeDiscussionActionDuplicates!=='function')process.exit(1);"
  ], { cwd: require('node:path').join(__dirname, '..'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /circular dependency/i);
});

test('decimal prices and percentage rates are ordinary untimed context, not dotted clock claims', () => {
  for (const text of [
    'The cover costs £13.50.', 'The cover costs $13.50.', 'The surcharge is set at 13.50%.',
    'The surcharge is set at 13.50 percent.', 'The cover is priced at 13.50 pounds.',
    'The cover is priced at 13.50 USD.'
  ]) assert.equal(run([row('price', text)]).discussion.length, 0, text);
  assert.ok(kept(run([row('time', 'The documents must arrive at 13.50.')])));
});
