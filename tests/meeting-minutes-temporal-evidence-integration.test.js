'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../utils/meetingMinutesAgentV2');

const claim = 'Morgan will circulate the inspection report Friday.';
const phase = 'Morgan will send the inspection report Friday';
const source = `${phase} and supplier training will begin Monday.`;
const binding = (overrides = {}) => ({ schemaVersion: 1, claimText: claim, sourceId: 'T0001',
  sourceQuote: phase, workSourceQuote: 'send the inspection report',
  workClaimQuote: 'circulate the inspection report', qualificationQuotes: [], ...overrides });

function fixture(row = claim, units = [{ id: 'T0001', speaker: 'Chair', text: source }], evidenceIds = ['T0001']) {
  const discussion = [{ id: 'schedule', topic: 'Inspection schedule', points: [
    { id: 'report', text: row, evidenceIds, reviewFlagIds: [], supportingDetails: [] }
  ], decisions: [], openQuestions: [] }];
  const items = V.discussionFidelityCheckItems(discussion, units, { meetingDate: '2026-10-21' });
  return { discussion, items };
}

function apply(f, temporalEvidence, overrides = {}) {
  return V.applyDiscussionFidelityResults(f.discussion, f.items, [{
    id: f.items[0].id, verdict: 'supported', evidenceQuote: phase, temporalEvidence, ...overrides
  }]);
}

test('discussion critic receives complete identified source records and their actual anchor IDs', () => {
  const f = fixture();
  const prompt = V.discussionFidelityCheckPrompt(f.items);
  const payload = JSON.parse(prompt.split('ITEMS:\n')[1]);
  assert.deepEqual(payload[0].evidenceIds, ['T0001']);
  assert.deepEqual(payload[0].sourceRecords, [{ id: 'T0001', type: 'discussion', speaker: 'Chair', text: source }]);
  assert.match(prompt, /temporalEvidence/);
  assert.match(prompt, /qualificationQuotes/);
  assert.match(prompt, /sourceQuote/);
  assert.match(prompt, /For a temporal row, choose "uncertain"/);
  assert.equal(payload[0].row, claim);
});

test('source-bound phase paraphrase clears the actual discussion warning without rewriting content', () => {
  const f = fixture(), before = structuredClone(f);
  const result = apply(f, binding());
  assert.equal(result.accounting.complete, true);
  assert.equal(result.accounting.counts.supported, 1);
  assert.deepEqual(result.flags, []);
  assert.deepEqual(result.discussion, f.discussion);
  assert.deepEqual(f, before);
});

test('an invalid supplied temporal witness cannot fall back to a legacy exact-text success', () => {
  const row = `${phase}.`, f = fixture(row, [{ id: 'T0001', speaker: 'Chair', text: row }]);
  for (const temporalEvidence of [null, [], {}, binding({ claimText: row, sourceId: 'foreign' }),
    binding({ claimText: 'A stale draft sentence.' }), binding({ claimText: row, unexpected: true })]) {
    const result = apply(f, temporalEvidence, { evidenceQuote: phase });
    assert.equal(result.accounting.complete, false, JSON.stringify(temporalEvidence));
    assert.equal(result.flags.filter(flag => flag.kind === 'timing').length, 1);
    assert.equal(result.discussion[0].points[0].text, row);
  }
});

test('a nearby source record is not an own-citation witness for the proposed row', () => {
  const row = `${phase}.`;
  const f = fixture(row, [
    { id: 'T0001', speaker: 'Chair', text: 'The supplier review is ready.' },
    { id: 'T0002', speaker: 'Chair', text: row }
  ]);
  assert.ok(f.items[0].passageUnits.some(unit => unit.id === 'T0002'));
  const result = apply(f, binding({ claimText: row, sourceId: 'T0002', workClaimQuote: 'send the inspection report' }));
  assert.equal(result.accounting.complete, false);
  assert.equal(result.flags.filter(flag => flag.kind === 'timing').length, 1);
});

test('a temporal correction needs its own complete validated witness before changing the row', () => {
  const wrong = claim.replace('Friday', 'Tuesday'), f = fixture(wrong);
  const overrides = { verdict: 'corrected', problemQuote: wrong, correctedText: claim };
  const valid = apply(f, binding(), overrides);
  assert.equal(valid.accounting.complete, true);
  assert.equal(valid.accounting.counts.corrected, 1);
  assert.equal(valid.discussion[0].points[0].text, claim);
  const invalid = apply(f, binding({ sourceQuote: 'supplier training will begin Monday.' }), overrides);
  assert.equal(invalid.accounting.complete, false);
  assert.equal(invalid.discussion[0].points[0].text, wrong);
  assert.ok(invalid.flags.some(flag => flag.kind === 'timing'));
});

test('missing new evidence preserves existing legacy-supported and missing-reply accounting', () => {
  const row = `${phase}.`, f = fixture(row, [{ id: 'T0001', speaker: 'Chair', text: row }]);
  const legacy = V.applyDiscussionFidelityResults(f.discussion, f.items, [{ id: f.items[0].id,
    verdict: 'supported', evidenceQuote: phase }]);
  assert.equal(legacy.accounting.complete, true);
  const missing = V.applyDiscussionFidelityResults(f.discussion, f.items, []);
  assert.equal(missing.accounting.complete, false);
  assert.equal(missing.accounting.counts.missing, 1);
  assert.equal(missing.discussion[0].points[0].text, row);
});

test('a valid mapping cannot excuse a missing, fabricated or overlong legacy evidence quote', () => {
  const f = fixture();
  for (const evidenceQuote of ['', 'A fabricated quotation about the timetable.', source.repeat(8)]) {
    const result = apply(f, binding(), { evidenceQuote });
    assert.equal(result.accounting.complete, false);
    assert.ok(result.flags.some(flag => flag.kind === 'timing'));
    assert.equal(result.discussion[0].points[0].text, claim);
  }
});

test('independently validated temporal paraphrases survive removal of an unsupported parent', () => {
  const f = fixture();
  const child = f.discussion[0].points[0];
  f.discussion[0].points = [{ id: 'parent', text: 'The inspection report has been approved.',
    evidenceIds: ['T0001'], reviewFlagIds: [], supportingDetails: [child] }];
  f.items = V.discussionFidelityCheckItems(f.discussion, [{ id: 'T0001', speaker: 'Chair', text: source }]);
  const replies = [{ id: f.items[0].id, verdict: 'uncertain', issue: 'added_detail',
    problemQuote: f.items[0].row, evidenceQuote: phase, reason: 'The source schedules sending; approval is not established.' },
  { id: f.items[1].id, verdict: 'supported', evidenceQuote: phase, temporalEvidence: binding() }];
  const result = V.applyDiscussionFidelityResults(f.discussion, f.items, replies);
  assert.deepEqual(result.discussion[0].points.map(row => row.id), ['report']);
  assert.equal(result.discussion[0].points[0].text, claim);
  assert.ok(result.withheld.some(row => row.record.id === 'parent'));
  const childState = result.accounting.items.find(row => row.id === f.items[1].id);
  assert.equal(childState.status, 'supported');
  assert.equal(childState.temporalBinding.claimText, claim);
  assert.equal(result.flags.filter(flag => flag.kind === 'timing').length, 0);
});

test('a mapped temporal child cannot become standalone while its dependency is an unresolved reference', () => {
  const row = 'The inspection is scheduled for Monday after that is completed.';
  const units = [{ id: 'T0001', speaker: 'Chair', text: row }];
  const f = fixture(row, units);
  f.discussion[0].points = [{ id: 'parent', text: 'The inspection has been approved.',
    evidenceIds: ['T0001'], reviewFlagIds: [], supportingDetails: f.discussion[0].points }];
  f.items = V.discussionFidelityCheckItems(f.discussion, units);
  const replies = [{ id: f.items[0].id, verdict: 'uncertain', issue: 'added_detail',
    problemQuote: f.items[0].row, evidenceQuote: row, reason: 'Approval is not established.' },
  { id: f.items[1].id, verdict: 'supported', evidenceQuote: row,
    temporalEvidence: binding({ claimText: row, sourceQuote: row, workSourceQuote: 'The inspection', workClaimQuote: 'The inspection' }) }];
  const result = V.applyDiscussionFidelityResults(f.discussion, f.items, replies);
  assert.equal(result.discussion.flatMap(topic => topic.points).length, 0);
  assert.ok(result.accounting.parentWithheldChildren.some(child => child.recordId === 'report' && child.disposition === 'withheld'));
});

test('a new unresolved timing reason preserves independently eligible content with its warning, without certifying it', () => {
  const row = 'The workshop visit is scheduled for five days.';
  const quoted = 'The workshop visit is scheduled for five days in summer';
  const units = [{ id: 'T0001', speaker: 'Chair', text: `${quoted} and report preparation will begin Monday.` }];
  const f = fixture(row, units);
  f.discussion[0].points = [{ id: 'parent', text: 'The workshop visit has been approved.',
    evidenceIds: ['T0001'], reviewFlagIds: [], supportingDetails: f.discussion[0].points }];
  f.items = V.discussionFidelityCheckItems(f.discussion, units);
  const replies = [{ id: f.items[0].id, verdict: 'uncertain', issue: 'added_detail',
    problemQuote: f.items[0].row, evidenceQuote: quoted, reason: 'Approval is not established.' },
  { id: f.items[1].id, verdict: 'supported', evidenceQuote: quoted,
    temporalEvidence: binding({ claimText: row, sourceQuote: quoted, workSourceQuote: 'workshop visit', workClaimQuote: 'workshop visit' }) }];
  const result = V.applyDiscussionFidelityResults(f.discussion, f.items, replies);
  assert.deepEqual(result.discussion[0].points.map(point => point.text), [row]);
  const state = result.accounting.items.find(item => item.id === f.items[1].id);
  assert.equal(state.status, 'rejected');
  assert.equal(state.reason, 'temporal_source_qualification_not_retained');
  assert.equal(result.flags.filter(flag => flag.kind === 'timing' && flag.status === 'open').length, 1);
  assert.equal(result.accounting.complete, false);
  assert.equal(state.temporalBinding, undefined);
  for (const includePrefixInQuote of [false, true]) {
    const spokenUnits = [{ ...units[0], text: 'So then obviously just ' + units[0].text }];
    const spokenItems = V.discussionFidelityCheckItems(f.discussion, spokenUnits);
    const spokenQuote = (includePrefixInQuote ? 'So then obviously just ' : '') + quoted;
    const spokenReply = { ...replies[1], evidenceQuote: spokenQuote,
      temporalEvidence: { ...replies[1].temporalEvidence, sourceQuote: 'So then obviously just ' + quoted } };
    const spoken = V.applyDiscussionFidelityResults(f.discussion, spokenItems, [replies[0], spokenReply]);
    assert.deepEqual(spoken.discussion[0].points.map(point => point.text), [row]);
    assert.equal(spoken.flags.filter(flag => flag.kind === 'timing' && flag.status === 'open').length, 1);
    assert.equal(spoken.accounting.items.find(item => item.id === replies[1].id).status, 'rejected');
  }
  for (const changes of [{ sourceId: 'foreign' }, { claimText: 'A stale draft.' }, { sourceQuote: 'An invented quote.' },
    { qualificationQuotes: ['If an invented condition is approved'] }, { unexpected: true }]) {
    const invalid = V.applyDiscussionFidelityResults(f.discussion, f.items, [replies[0],
      { ...replies[1], temporalEvidence: { ...replies[1].temporalEvidence, ...changes } }]);
    assert.equal(invalid.discussion[0].points.length, 0, JSON.stringify(changes));
  }
});

test('verified phase evidence survives ordinary finalization, saved state, public view and Word/PDF output', async () => {
  const Module = require('node:module'), originalLoad = Module._load;
  let externalCalls = 0;
  const forbidden = () => { externalCalls += 1; throw new Error('Offline timing publication test'); };
  Module._load = function(request, parent, isMain) {
    if (request === 'node-fetch') return forbidden;
    if (/(?:^|\/)utils\/(?:db|copilot|knowledge)$/.test(request)) return new Proxy({}, { get: () => forbidden });
    return originalLoad.call(this, request, parent, isMain);
  };
  let A;
  try { A = require('../routes/api').stagedEvaluation; }
  finally { Module._load = originalLoad; }
  const O = require('../utils/canonicalMinutes/discussionOrganiser');
  const JSZip = require('jszip');
  const { generateMeetingMinutesAgentDocx } = require('../utils/meetingMinutesAgentDocx');
  const { renderStagedMinutesPdfHtml } = require('../utils/stagedMinutesPdf');
  const row = 'Report preparation is scheduled for Tuesday.';
  const sourceText = 'Report writing is scheduled for Tuesday and supplier training will begin Friday.';
  const units = [{ id: 'T0001', speaker: 'Chair', text: sourceText }];
  const f = fixture(row, units);
  const checked = apply(f, binding({ claimText: row, sourceQuote: 'Report writing is scheduled for Tuesday',
    workSourceQuote: 'Report writing', workClaimQuote: 'Report preparation' }),
  { evidenceQuote: 'Report writing is scheduled for Tuesday' });
  assert.equal(checked.accounting.complete, true);
  const discussion = await O.finaliseDiscussionForPublication(checked.discussion, { sourceUnits: units });
  assert.ok(discussion.flatMap(topic => topic.points).some(point => point.text === row));
  let saved = { draftId: 'offline-timing', revision: 1, payloadVersion: V.PAYLOAD_VERSION, currentStep: 2,
    details: { meetingTitle: 'Inspection planning', meetingType: 'General', meetingDate: '2026-10-21' },
    sourceUnits: units, preparedTranscript: V.preparedTranscriptFromUnits(units), discussion: [], actions: [], reviewFlags: [], qualityState: {} };
  const copy = value => JSON.parse(JSON.stringify(value));
  const result = { changes: { discussion, qualityState: { discussion: { fidelityReview: checked.accounting } } }, reviewFlags: checked.flags };
  const persisted = await A.persistMeetingAgentBackgroundStage({ draftId: saved.draftId, userId: 'offline-reviewer', stage: 'discussion',
    sourceDraft: copy(saved), result, getDraft: async () => copy(saved), saveDraft: async (_, changes) => {
      saved = copy({ ...saved, ...changes, revision: saved.revision + 1 }); return copy(saved);
    } });
  assert.deepEqual(persisted.conflictFields, []);
  const publicDraft = A.publicMeetingAgentDraft(copy(saved));
  assert.ok(publicDraft.discussion.flatMap(topic => topic.points).some(point => point.text === row));
  assert.equal(publicDraft.reviewFlags.filter(flag => flag.kind === 'timing').length, 0);
  const buffer = await generateMeetingMinutesAgentDocx(A.meetingAgentDraftForDocx(copy(saved)), false);
  const xml = await (await JSZip.loadAsync(buffer)).file('word/document.xml').async('string');
  const pdfHtml = renderStagedMinutesPdfHtml(A.meetingAgentDraftForPdf(copy(saved)));
  assert.ok(xml.includes(row));
  assert.ok(pdfHtml.includes(row));
  const proof = saved.qualityState.discussion.fidelityReview.items[0].temporalBinding;
  assert.equal(sourceText.slice(proof.start, proof.end), proof.sourceQuote);
  assert.equal(proof.claimText, row);
  assert.equal(externalCalls, 0);
});
