'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
let externalCalls = 0;
const forbidden = () => { externalCalls += 1; throw new Error('Exact-twin tests prohibit external calls'); };
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'node-fetch') return forbidden;
  if (/(?:^|\/)utils\/(?:db|copilot|knowledge)$/.test(request)) return new Proxy({}, { get: () => forbidden });
  return originalLoad.call(this, request, parent, isMain);
};
const A = require('../routes/api').stagedEvaluation;
Module._load = originalLoad;
const V = require('../utils/meetingMinutesAgentV2');
process.env.MEETING_MINUTES_AGENT_CORRECTNESS_V1 = '1';
test.after(() => assert.equal(externalCalls, 0));

const meetingDate = '2026-06-17';
const claim = 'Plan to change barcodes to 2D data matrix including lot number; label format still pending sign-off; new products must be entered into the catalogue immediately; existing products must be entered by 19th November 2026; no product information was found in the catalogue as of last Friday.';
const units = V.normaliseSourceUnits([
  { speaker: 'Morgan', text: 'We plan to change the barcodes to a 2D data matrix including the lot number.' },
  { speaker: 'Morgan', text: 'The label format is still pending sign-off.' },
  { speaker: 'Morgan', text: 'New products must be entered into the catalogue immediately.' },
  { speaker: 'Morgan', text: 'For all other items, they need to be in the catalogue by the 19th of November this year.' },
  { speaker: 'Morgan', text: 'No product information was found in the catalogue when we checked last Friday.' },
  ...Array.from({ length: 8 }, () => ({ speaker: 'Chair', text: 'The next item is room bookings.' })),
  { speaker: 'Casey', text: 'The factory roof inspection is finished.' }
]);
const ids = ['T0001', 'T0002', 'T0003', 'T0004', 'T0005'];
const candidate = (candidateId, sourcePass, evidenceIds = []) => ({
  candidateId, sourcePass, recordType: 'discussion_point', topic: 'Product records', text: claim,
  evidenceIds, priority: sourcePass === 'primary' ? 14 : 5,
  record: { id: `${candidateId}-record`, text: claim, evidenceIds, reviewFlagIds: [], supportingDetails: [] }
});
const fixture = () => [candidate('recovery-twin', 'recovery'), candidate('primary-twin', 'primary', [...ids])];
const disposition = { candidateId: 'recovery-twin', disposition: 'core', reason: 'The registration deadline is material.', evidenceIds: [] };
const reconstruct = (candidates, sourceUnits = units, dispositions = [disposition]) => A.reconstructMissingRefereeDiscussion(
  [], dispositions, candidates, sourceUnits, { meetingDate }
);
const point = result => result.discussion.flatMap(topic => topic.points)[0];
const compact = result => A.compactDiscussionPropositions(result.discussion, [], units, { meetingDate, promoteMaterialSupporting: false });

test('an uncited exact representative retains its validated twin evidence through reconstruction and publication', () => {
  const candidates = fixture();
  const original = structuredClone(candidates);
  assert.notDeepEqual(new Set(point(reconstruct([candidates[0]])).evidenceIds), new Set(ids),
    'automatic source recovery does not retain the existing full twin bundle');
  const out = reconstruct(candidates);
  assert.equal(point(out).id, 'recovery-twin');
  assert.equal(point(out).text, claim);
  assert.deepEqual(new Set(point(out).evidenceIds), new Set(ids));
  assert.deepEqual(out.reconstructedTargetIds, ['recovery-twin']);
  assert.deepEqual(out.unresolvedTargetIds, []);
  assert.deepEqual(candidates, original);
  const discussion = compact(out);
  assert.equal(discussion.flatMap(topic => topic.points).filter(row => row.text === claim).length, 1);
  const draft = { details: { meetingTitle: 'Product records', meetingDate }, sourceUnits: units,
    discussion, actions: [], reviewFlags: [], qualityState: {} };
  for (const visible of [A.publicMeetingAgentDraft(draft), A.meetingAgentDraftForDocx(draft)]) {
    const row = visible.discussion.flatMap(topic => topic.points).find(row => row.id === 'recovery-twin');
    assert.ok(row);
    assert.deepEqual(new Set(row.evidenceIds), new Set(ids));
  }
  const pdf = A.meetingAgentDraftForPdf(draft, true);
  assert.ok(pdf.discussion.flatMap(topic => topic.points).some(text => /existing products must be entered by 19(?:th)? November 2026/.test(text)));
  assert.deepEqual(new Set(pdf.evidenceAppendix.map(unit => unit.id)), new Set(ids));
});

test('evidence recovery leaves nominee identities, order and contract selection unchanged', () => {
  const candidates = fixture();
  const before = A.meetingAgentRefereeCandidates('discussion', candidates);
  const snapshot = structuredClone(before);
  reconstruct(candidates);
  assert.deepEqual(A.meetingAgentRefereeCandidates('discussion', candidates), snapshot);
  assert.deepEqual(candidates, fixture());
});

for (const [name, change] of [
  ['year', text => text.replace('2026', '2027')],
  ['date', text => text.replace('19th', '20th')],
  ['amount', text => `${text} The approved budget is 900 pounds.`],
  ['actor', text => text.replace('new products', 'Morgan’s new products')],
  ['operation', text => text.replace('entered into', 'removed from')],
  ['negation', text => text.replace('must be entered', 'must not be entered')],
  ['condition', text => `${text} Only if the panel approves.`],
  ['case-sensitive meaning', text => text.replace('Plan', 'PLAN')]
]) {
  test(`a changed ${name} claim cannot donate citations to the original`, () => {
    const candidates = fixture();
    candidates[1].text = change(claim);
    candidates[1].record.text = candidates[1].text;
    assert.deepEqual(reconstruct(candidates), reconstruct([candidates[0]]));
  });
}

for (const [name, alter] of [
  ['record kind', candidate => { candidate.recordType = 'decision'; }],
  ['structured actor', candidate => { candidate.record.actors = ['Casey']; }],
  ['structured date', candidate => { candidate.record.timing = { kind: 'deadline', exactDate: '2026-11-20' }; }],
  ['structured qualification', candidate => { candidate.record.qualification = 'subject to approval'; }],
  ['explicit transcript version', candidate => { candidate.transcriptSha256 = 'different-transcript'; }],
  ['rejected discovery', candidate => { candidate.record.discoveryDisposition = 'reject'; }],
  ['reviewer authorship', candidate => { candidate.record.reviewerAuthored = true; }],
  ['weak source diagnostic', candidate => { candidate.record._weakEvidenceIds = [...ids]; }],
  ['rejected source diagnostic', candidate => { candidate.record._unsupportedEvidenceIds = [...ids]; }],
  ['unversioned staged donor', candidate => { candidate.sourcePass = 'staged'; }]
]) {
  test(`a twin with different ${name} cannot supply evidence`, () => {
    const candidates = fixture();
    alter(candidates[1]);
    assert.deepEqual(reconstruct(candidates), reconstruct([candidates[0]]));
  });
}

test('an explicitly rejected exact donor cannot reopen its source evidence', () => {
  const candidates = fixture();
  const rejected = { candidateId: 'primary-twin', disposition: 'reject', reason: 'The evidence is not accepted.', evidenceIds: ids };
  assert.deepEqual(reconstruct(candidates, units, [disposition, rejected]), reconstruct([candidates[0]]));
});

test('a receiver whose nested full claim differs cannot borrow another claim’s evidence', () => {
  const candidates = fixture();
  candidates[0].record.text = claim.replace('19th', '20th');
  assert.deepEqual(reconstruct(candidates), reconstruct([candidates[0]]));
});

for (const [name, evidenceIds, sourceUnits] of [
  ['invalid IDs', ['T9999'], units],
  ['unrelated known IDs', ['T0014'], units],
  ['removed source', ids, units.map(unit => ({ ...unit, classification: 'remove' }))],
  ['stale source text', ids, units.map(unit => ({ ...unit, text: 'The factory roof inspection is finished.' }))]
]) {
  test(`${name} do not become accepted donor evidence`, () => {
    const candidates = fixture();
    candidates[1].evidenceIds = [...evidenceIds];
    candidates[1].record.evidenceIds = [...evidenceIds];
    assert.deepEqual(reconstruct(candidates, sourceUnits), reconstruct([candidates[0]], sourceUnits));
  });
}

test('source and donor ordering, JSON round trips and repeated normalization preserve the recovered claim', () => {
  const candidates = fixture();
  const expected = point(reconstruct(candidates));
  assert.equal(expected.evidenceIds.length, ids.length);
  for (const pool of [candidates, [...candidates].reverse(), JSON.parse(JSON.stringify(candidates))]) {
    const out = reconstruct(pool, [...units].reverse());
    assert.equal(point(out).text, claim);
    assert.deepEqual(new Set(point(out).evidenceIds), new Set(expected.evidenceIds));
    const normalized = V.normaliseAgentResult(JSON.parse(JSON.stringify(out)), units, 'discussion', { meetingDate });
    assert.deepEqual(new Set(normalized.discussion[0].points[0].evidenceIds), new Set(expected.evidenceIds));
  }
});

test('a ninth candidate citation is never truncated or reprioritized into the receiver', () => {
  const candidates = fixture();
  const second = candidate('second-primary', 'primary', ['T0006', 'T0007', 'T0008', 'T0009']);
  candidates.push(second);
  assert.deepEqual(reconstruct(candidates), reconstruct([candidates[0]]), 'an over-cap exact union is left unresolved');
});

test('an already cited receiver keeps its original evidence and duplicate winner', () => {
  const candidates = fixture();
  candidates[0].evidenceIds = ['T0004'];
  candidates[0].record.evidenceIds = ['T0004'];
  const expected = reconstruct([candidates[0]]);
  assert.deepEqual(reconstruct(candidates), expected);
  assert.deepEqual(compact(reconstruct(candidates)), compact(expected));
});
