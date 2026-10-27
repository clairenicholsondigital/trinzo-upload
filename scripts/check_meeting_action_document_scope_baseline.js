'use strict';
// Offline acceptance replay, not a release test that blesses the current bug.
// Default exits non-zero while supported work is lost. --verify-capture checks
// the frozen observations, still reporting readyForRelease:false.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const Module = require('node:module');
const args = process.argv.slice(2);
const fixtureDir = args.find(arg => !arg.startsWith('--'));
if (!fixtureDir) throw Error('Supply the private frozen fixture directory; see docs/meeting-minutes-document-scope-baseline-20261027.md');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const manifestBytes = fs.readFileSync(path.join(fixtureDir, 'manifest.json'));
const manifest = JSON.parse(manifestBytes);
const publicManifest = require('../tests/fixtures/action-document-scope/baseline-manifest.json');
assert.equal(hash(manifestBytes), publicManifest.privateManifestSha256, 'Frozen manifest changed');
for (const entry of manifest.entries) {
  const filename = path.resolve(fixtureDir, entry.path);
  assert.ok(filename.startsWith(path.resolve(fixtureDir) + path.sep));
  assert.equal(hash(fs.readFileSync(filename)), entry.sha256, 'Frozen fixture changed: ' + entry.path);
}
const read = filename => JSON.parse(fs.readFileSync(path.join(fixtureDir, filename)));
let databaseCalls = 0, providerCalls = 0;
const db = require('../utils/db');
for (const [key, value] of Object.entries(db)) if (typeof value === 'function') {
  db[key] = () => { databaseCalls++; throw Error('Database access forbidden in frozen replay'); };
}
const originalLoad = Module._load;
let A, V;
try {
  Module._load = function(request, parent, isMain) {
    if (request === 'node-fetch') return async () => { providerCalls++; throw Error('Provider calls forbidden in frozen replay'); };
    return originalLoad.call(this, request, parent, isMain);
  };
  A = require('../routes/api').stagedEvaluation;
  V = require('../utils/meetingMinutesAgentV2');
} finally {
  Module._load = originalLoad;
}
const source = read('source.json');
const protectedInputs = read('protected-inputs.json');
assert.equal(source.generationSourceUnits.length, 17);
assert.equal(source.normalisationSourceUnits.length, 392);
assert.deepEqual(protectedInputs, require('../tests/fixtures/action-document-scope/protected-inputs.json'));
const original = read('original-organisation-reference.json');
assert.equal(original.role, 'generation_negative_reference_only');
assert.ok(original.actions.some(a => a.id === original.assessmentActionId && /supplied standards/.test(a.action) && /nebulizing port/.test(a.action)));
const spelling = value => String(value || '').trim().replace(/[.!?]+$/, '').replace(/\s+/g, ' ').toLowerCase();
const pipeline = (first, second, units, details = {}) => {
  const before = JSON.stringify([first, second, units]);
  const combined = A.unionActionDiscoveryResults(first && structuredClone(first), second && structuredClone(second));
  const normal = V.normaliseAgentResult(combined || {}, units, 'actions', { meetingDate: details.meetingDate });
  const proposals = A.normaliseAgentDeclaredProposals(combined || {}, units, { meetingDate: details.meetingDate });
  assert.equal(JSON.stringify([first, second, units]), before, 'Replay mutated its source fixture');
  return { actions: normal.actions, proposals, flags: normal.reviewFlags };
};
const response = (round, name, route, arm, trial) => read(`${round}/${name}-${route}-${arm}-${trial}.json`).result;
const observations = [], protectionChecks = [];
for (const round of ['first', 'second']) {
  for (let trial = 1; trial <= 3; trial++) {
    const first = response(round, 'eakin', 'primary', 'revised', trial);
    const second = response(round, 'eakin', 'primary-2', 'revised', trial);
    // Frozen row selectors, never production matching rules. Keeping wording is
    // part of this bounded correction; a separate rewrite needs explicit review.
    const expected = [...(first.actions || []), ...(first.actionProposals || []), ...(second.actions || []), ...(second.actionProposals || [])]
      .filter(row => /\b27427\b/.test(row.action) && /\bassess/i.test(row.action))
      .map(row => spelling(V.cleanActionWording(row.action)));
    assert.ok(expected.length, 'Missing frozen assessment selector');
    for (const [availability, left, right] of [['both', first, second], ['primary-only', first, null], ['secondary-only', null, second]]) {
      const result = pipeline(left, right, source.normalisationSourceUnits, source.details);
      const retained = [...result.actions, ...result.proposals].some(row => expected.includes(spelling(row.action)));
      observations.push({ round, trial, availability, assessmentRetained: retained });
    }
  }
  for (const name of Object.keys(protectedInputs)) for (const route of ['primary', 'primary-2']) {
    const captured = response(round, name, route, 'revised', 1);
    const result = pipeline(captured, null, protectedInputs[name].sourceUnits, { meetingDate: '2026-10-27' });
    const rows = [...result.actions, ...result.proposals];
    const sending = rows.filter(row => /^(?:send|email)\b/i.test(row.action));
    const assessing = rows.filter(row => /^assess\b/i.test(row.action));
    let passed = false;
    if (name === 'joint') passed = assessing.some(row => /pressure protocol/i.test(row.action) && /cybersecurity checklist/i.test(row.action));
    if (name === 'different_purposes') passed = assessing.some(row => /pressure protocol/i.test(row.action))
      && !assessing.some(row => /cybersecurity/i.test(row.action)) && sending.some(row => /both documents/i.test(row.action));
    if (name === 'ambiguous_reference') passed = result.actions.length === 0 && result.proposals.length > 0
      && result.proposals.every(row => !/^(?:review|assess) (?:the )?(?:installation guide|test protocol)\.?$/i.test(row.action));
    if (name === 'recipient_not_acceptance') passed = sending.some(row => row.owners.includes('Lena Morris'))
      && !assessing.some(row => row.owners.some(owner => /Omar/i.test(owner)));
    if (name === 'conditional_separate_work') passed = sending.length > 0
      && sending.every(row => /legal/i.test(row.timing.wording) && row.timing.kind === 'dependency')
      && assessing.some(row => /installation guide/i.test(row.action)) && !assessing.some(row => /risk report/i.test(row.action))
      && rows.some(row => /^follow up/i.test(row.action) && row.owners.includes('Sam Reed'))
      && !rows.some(row => row.owners.some(owner => /^Jo\b/i.test(owner)));
    protectionChecks.push({ round, name, route, passed });
  }
}
// Diagnostic counterfactual only: adding a true identity passage can satisfy
// the score, but does not by itself prove the document-to-work relationship.
const missingIdentityProbes = [];
for (const trial of [1, 2]) {
  const routes = trial === 1 ? ['primary', 'primary-2'] : ['primary-2'];
  for (const route of routes) {
    const captured = response('first', 'eakin', route, 'revised', trial);
    const proposal = captured.actionProposals.find(row => /27427/.test(row.action));
    assert.ok(proposal);
    const textFor = ids => ids.map(id => source.normalisationSourceUnits.find(unit => unit.id === id))
      .filter(Boolean).map(unit => unit.speaker + ': ' + unit.text).join(' ');
    const originalScore = V.evidenceSupportScore(proposal.action, textFor(proposal.evidenceIds));
    const withIdentityScore = V.evidenceSupportScore(proposal.action, textFor([...new Set([...proposal.evidenceIds, 'T0370'])]));
    missingIdentityProbes.push({ trial, route, originalScore, withIdentityScore,
      rejectedByCurrentProposalPath: A.normaliseAgentDeclaredProposals({ actionProposals: [proposal] }, source.normalisationSourceUnits).length === 0,
      diagnosticOnlyNotAuthority: true });
  }
}
const pairedFailures = observations.filter(row => row.availability === 'both' && !row.assessmentRetained);
const singleFailures = observations.filter(row => row.availability !== 'both' && !row.assessmentRetained);
const report = {
  codeBaseline: manifest.codeRevision, checksummedFixtures: manifest.entries.length,
  originalOvergeneralisationFrozen: true, capturedResponses: manifest.providerResponses,
  pairedAssessmentMissing: pairedFailures.length, singleResponseAssessmentMissing: singleFailures.length,
  protectedChecks: protectionChecks.length, protectedPassed: protectionChecks.filter(row => row.passed).length,
  offlineRetentionGatePassed: pairedFailures.length === 0 && singleFailures.length === 0 && protectionChecks.every(row => row.passed),
  readyForRelease: false, // This replay cannot replace generation and deployment qualification.
  databaseCalls, providerCalls, missingIdentityProbes, observations, protectionChecks
};
assert.equal(databaseCalls, 0); assert.equal(providerCalls, 0);
console.log(JSON.stringify(report, null, 2));
if (args.includes('--verify-capture')) {
  assert.equal(pairedFailures.length, manifest.expectedCurrentFailures.pairedAssessmentMissing);
  assert.equal(singleFailures.length, manifest.expectedCurrentFailures.singleResponseAssessmentMissing);
  assert.ok(protectionChecks.every(row => row.passed), 'Protected case changed');
  assert.ok(missingIdentityProbes.every(row => row.originalScore === 0 && row.withIdentityScore >= 0.22 && row.rejectedByCurrentProposalPath), 'Missing-identity failure no longer matches the frozen baseline');
} else if (!report.offlineRetentionGatePassed) {
  process.exitCode = 1;
}
