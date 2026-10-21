'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const JSZip = require('jszip');
const blocked = [];
const deny = label => () => { blocked.push(label); throw new Error(`Offline child regression forbids ${label}`); };
const load = Module._load;
Module._load = function (name) {
  if (name === 'node-fetch') return deny('node-fetch');
  if (name === 'pg') return { Pool: class { constructor() { deny('pg.Pool')(); } } };
  if (name === 'child_process') return new Proxy({}, { get: (_, key) => deny(`child_process.${String(key)}`) });
  const loaded = load.apply(this, arguments);
  // Exercise the ordinary lexical fallback without contacting a model worker.
  if (/(?:^|\/)semanticDedupe$/.test(name)) return { ...loaded, encodeViaWorker: async () => null,
    duplicateGroups: async () => [] };
  return loaded;
};
const v2Path = require.resolve('../utils/meetingMinutesAgentV2');
if (process.env.TRINZO_INDEPENDENT_CHILD_BASELINE) {
  const compiled = new Module(v2Path, module);
  compiled.filename = v2Path;
  compiled.paths = Module._nodeModulePaths(path.dirname(v2Path));
  compiled._compile(fs.readFileSync(process.env.TRINZO_INDEPENDENT_CHILD_BASELINE, 'utf8'), v2Path);
  require.cache[v2Path] = compiled;
}
const V = require(v2Path);
const A = require('../routes/api').stagedEvaluation;
const O = require('../utils/canonicalMinutes/discussionOrganiser');
const { generateMeetingMinutesAgentDocx } = require('../utils/meetingMinutesAgentDocx');
const { renderStagedMinutesPdfHtml } = require('../utils/stagedMinutesPdf');
Module._load = load;
const copy = value => JSON.parse(JSON.stringify(value));
const point = (id, text, evidenceIds, extra = {}) => ({ id, text, evidenceIds, reviewFlagIds: [], supportingDetails: [], ...extra });
const topic = points => ({ id: 'topic', topic: 'Inspection arrangements', points, decisions: [], openQuestions: [] });
const unit = (id, text, extra = {}) => ({ id, sequence: Number(id.replace(/\D/g, '')), speaker: 'Chair', text, ...extra });
const parentText = 'The inspection is scheduled in July and Morgan is the lead inspector.';
function assess(tree, units, replies = {}, options = {}) {
  const items = V.discussionFidelityCheckItems(tree, units, { meetingDate: '2026-06-17' });
  const results = items.flatMap(item => {
    const record = item.path.reduce((value, key) => value[key], tree);
    const reply = Object.hasOwn(replies, record.id) ? replies[record.id]
      : record.id === 'parent' ? { verdict: 'uncertain', issue: 'added_detail', problemQuote: item.row,
        evidenceQuote: '', reason: 'The source does not state the added month or role.' }
        : { verdict: 'supported', evidenceQuote: record.text };
    return reply ? (Array.isArray(reply) ? reply : [reply]).map(row => ({ id: item.id, ...row })) : [];
  });
  if (options.changeItems) options.changeItems(items);
  const result = V.applyDiscussionFidelityResults(tree, items, results);
  return { ...result, items, results };
}
function mixed() {
  const values = {
    good: 'The supplier register is ready for inspection.',
    bad: 'The supplier register has an approved July launch.',
    missing: 'The calibration records are ready for review.',
    dependent: 'It is ready for the final inspection.',
    nested: 'If the supplier approval is received, the calibration review can proceed.'
  };
  const units = [unit('T0001', 'The inspection arrangements are being reviewed.'),
    ...Object.values(values).map((value, index) => unit(`T000${index + 2}`, value))];
  const children = Object.entries(values).map(([id, value], index) => point(id, value, [`T000${index + 2}`]));
  return { values, units, tree: [topic([point('parent', parentText, ['T0001'], { supportingDetails: children })])] };
}

test('a withheld parent keeps independently reviewed children and excludes false, unreviewed and dependent siblings', () => {
  const { values, units, tree } = mixed(), before = copy(tree);
  const result = assess(tree, units, {
    bad: { verdict: 'uncertain', issue: 'added_detail', problemQuote: values.bad, evidenceQuote: '', reason: 'Unsupported month.' },
    missing: null
  });
  assert.deepEqual(result.discussion[0].points.map(row => row.id), ['good', 'nested']);
  assert.equal(result.withheld.some(row => row.record.id === 'parent'), true);
  assert.equal(result.withheld.some(row => row.record.id === 'bad'), true);
  assert.deepEqual(result.discussion[0].points[0], before[0].points[0].supportingDetails[0]);
  assert.equal(result.discussion[0].points[1].text, values.nested, 'the entire source condition is unchanged');
  assert.deepEqual(tree, before, 'the source tree is immutable');
  const dispositions = result.accounting.parentWithheldChildren;
  assert.deepEqual(dispositions.filter(row => row.disposition === 'retained').map(row => row.recordId), ['good', 'nested']);
  assert.equal(dispositions.find(row => row.recordId === 'missing').reviewStatus, 'missing');
  assert.equal(dispositions.find(row => row.recordId === 'dependent').reason, 'child_depends_on_parent_context');
});

test('an independently reviewed grandchild survives rejected intermediate wrappers in stable source order', () => {
  const units = [unit('T0001', 'The arrangements were discussed.'),
    unit('T0002', 'The equipment records are available for inspection.'),
    unit('T0003', 'The supplier approval is required before calibration can proceed.')];
  const first = point('first', units[1].text, ['T0002'], { reviewFlagIds: ['existing-source-review'] });
  const second = point('second', units[2].text, ['T0003']);
  const inner = point('inner', 'The inspection was approved in December by Morgan.', ['T0001'], { supportingDetails: [first] });
  const tree = [topic([point('before', 'The inspection arrangements are recorded for review.', ['T0001']),
    point('parent', parentText, ['T0001'], { supportingDetails: [inner, second] }),
    point('after', 'The inspection arrangements remain subject to review.', ['T0001'])])];
  const result = assess(tree, units, { inner: { verdict: 'uncertain', issue: 'added_detail', problemQuote: inner.text,
    evidenceQuote: '', reason: 'Unsupported month and actor.' } });
  assert.deepEqual(result.discussion[0].points.map(row => row.id), ['before', 'first', 'second', 'after']);
  assert.deepEqual(result.discussion[0].points[1], first);
  assert.deepEqual(result.discussion[0].points[2], second);
  assert.deepEqual(result.accounting.parentWithheldChildren.find(row => row.recordId === 'first').recordPath,
    [0, 'points', 1, 'supportingDetails', 0, 'supportingDetails', 0]);
});

test('detached context from an excluded decision becomes a point without inheriting approval status', () => {
  const own = point('child', 'The supplier register is ready for inspection.', ['T0002']);
  const tree = [{ ...topic([]), decisions: [point('parent', parentText, ['T0001'], { supportingDetails: [own] })] }];
  const result = assess(tree, [unit('T0001', 'The inspection arrangements were discussed.'), unit('T0002', own.text)]);
  assert.deepEqual(result.discussion[0].decisions, []);
  assert.deepEqual(result.discussion[0].points, [own]);
});

test('a source-proved narrow phase survives with its existing timing warning, while added specificity cannot escape', () => {
  const source = 'The on-site presence is scheduled for the 20th for five days and report writing follows from the 27th to the 7th of August.';
  const quote = 'The on-site presence is scheduled for the 20th for five days';
  const phase = point('phase', 'On-site presence is scheduled for the 20th for five days.', ['T0002']);
  const units = [unit('T0001', 'The arrangements were discussed.'), unit('T0002', source)];
  const bad = [
    phase.text.replace('20th', '20th of July'),
    phase.text.replace('20th', '21st'),
    phase.text.replace('five days', 'seven days'),
    phase.text.replace('On-site presence', "Morgan's on-site inspection")
  ];
  for (const value of [phase.text, ...bad]) {
    const child = { ...phase, text: value };
    const tree = [topic([point('parent', parentText, ['T0001'], { supportingDetails: [child] })])];
    const result = assess(tree, units, { phase: { verdict: 'supported', evidenceQuote: quote } });
    if (value === phase.text) {
      assert.deepEqual(result.discussion[0].points.map(row => row.id), ['phase']);
      const state = result.accounting.items.find(row => row.id === result.items.find(item => item.row === value).id);
      assert.equal(state.status, 'rejected');
      assert.equal(state.reason, 'temporal_source_binding_not_proved');
      assert.ok(result.flags.some(flag => flag.kind === 'timing' && result.discussion[0].points[0].reviewFlagIds.includes(flag.id)));
      assert.equal(result.accounting.complete, false, 'retention is not clean verification');
    } else assert.deepEqual(result.discussion[0].points, [], value);
  }
});

test('own known citations and a source-bound quote are mandatory even for non-temporal supported replies', () => {
  const value = 'The supplier register is ready for inspection.';
  const own = unit('T0002', value), other = unit('T0003', 'The training register is ready for inspection.');
  const cases = [
    { evidenceIds: ['T0003'], evidenceQuote: value },
    { evidenceIds: ['T9999'], evidenceQuote: value },
    { evidenceIds: [], evidenceQuote: value },
    { evidenceIds: ['T0002'], evidenceQuote: '' },
    { evidenceIds: ['T0002'], evidenceQuote: other.text },
    { evidenceIds: ['T0002'], evidenceQuote: value, _weakEvidenceIds: ['T0002'] },
    { evidenceIds: ['T0002'], evidenceQuote: value, _unsupportedEvidenceIds: ['T9999'] }
  ];
  for (const entry of cases) {
    const { evidenceQuote, ...fields } = entry;
    const tree = [topic([point('parent', parentText, ['T0001'], {
      supportingDetails: [point('child', value, fields.evidenceIds, fields)] })])];
    assert.deepEqual(assess(tree, [unit('T0001', 'The arrangements were discussed.'), own, other], {
      child: { verdict: 'supported', evidenceQuote }
    }).discussion[0].points, [], JSON.stringify(entry));
  }
  const tree = [topic([point('parent', parentText, ['T0001'], {
    supportingDetails: [point('child', value, ['T0003'])] })])];
  assert.deepEqual(assess(tree, [unit('T0001', 'The arrangements were discussed.'), own, other], {
    child: { verdict: 'supported', evidenceQuote: other.text }
  }).discussion[0].points, [], 'a real own-source quote about different work is not sufficient');
  assert.deepEqual(assess(tree, [unit('T0001', 'The arrangements were discussed.'), { ...other, classification: 'remove' }], {
    child: { verdict: 'supported', evidenceQuote: other.text }
  }).discussion[0].points, [], 'a removed source cannot authorize reparenting');
});

test('missing, duplicate, malformed, stale and incomplete-context child reviews cannot authorize promotion', () => {
  const value = 'The supplier register is ready for inspection.';
  const units = [unit('T0001', 'The arrangements were discussed.'), unit('T0002', value)];
  for (const mode of ['missing', 'duplicate', 'malformed', 'stale', 'context']) {
    const tree = [topic([point('parent', parentText, ['T0001'], { supportingDetails: [point('child', value, ['T0002'])] })])];
    const reply = { verdict: 'supported', evidenceQuote: value };
    const replies = { child: mode === 'missing' ? null : mode === 'duplicate' ? [reply, reply]
      : mode === 'malformed' ? { ...reply, evidenceQuote: { bad: true } } : reply };
    const result = assess(tree, units, replies, { changeItems(items) {
      const item = items.find(item => item.row === value);
      if (mode === 'stale') item.row = 'A different saved snapshot.';
      if (mode === 'context') item.contextCoverage = { omittedAnchorIds: ['T0002'] };
    } });
    assert.deepEqual(result.discussion[0].points, [], mode);
    assert.equal(result.accounting.parentWithheldChildren.find(row => row.recordId === 'child').disposition, 'withheld');
  }
});

test('a child cannot lose a source condition or strengthen source uncertainty when detached', () => {
  for (const [claim, quote] of [
    ['The supplier register is ready for inspection.', 'If approval is received, the supplier register is ready for inspection.'],
    ['The supplier register is ready for inspection.', 'The supplier register might be ready for inspection.'],
    ['The supplier register is ready for inspection.', 'The supplier register is not ready for inspection.']
  ]) {
    const tree = [topic([point('parent', parentText, ['T0001'], { supportingDetails: [point('child', claim, ['T0002'])] })])];
    assert.deepEqual(assess(tree, [unit('T0001', 'The arrangements were discussed.'), unit('T0002', quote)], {
      child: { verdict: 'supported', evidenceQuote: quote }
    }).discussion[0].points, []);
  }
});

test('a genuine own quote cannot hide a governing condition or uncertainty outside the quoted span', () => {
  const claim = 'The pump calibration is required.';
  for (const source of [
    `If access is approved, ${claim.toLowerCase()}`,
    `${claim} unless the access request is rejected.`,
    `Only once approval is received, ${claim.toLowerCase()}`,
    `It remains uncertain whether ${claim.toLowerCase()}`,
    `The recommendation is provisional: ${claim.toLowerCase()}`,
    `It is not established whether ${claim.toLowerCase()}`,
    `Pending access approval, ${claim.toLowerCase()}`,
    `${claim} contingent on permission being granted.`,
    `Subject to permission, ${claim.toLowerCase()}`
  ]) {
    const tree = [topic([point('parent', parentText, ['T0001'], { supportingDetails: [point('child', claim, ['T0002'])] })])];
    const result = assess(tree, [unit('T0001', 'The arrangements were discussed.'), unit('T0002', source)], {
      child: { verdict: 'supported', evidenceQuote: claim }
    });
    assert.deepEqual(result.discussion[0].points, [], source);
    assert.equal(result.accounting.parentWithheldChildren.find(row => row.recordId === 'child').disposition, 'withheld');
  }
});

test('detachment cannot change a condition or transfer a source recipient or sibling actor into a role', () => {
  for (const [claim, source] of [
    ['The pump calibration is required if access is denied.', 'If access is approved, the pump calibration is required.'],
    ['Morgan is the inspection lead.', 'The inspection lead told Morgan to wait.'],
    ['Morgan is responsible for the inspection.', 'Casey is responsible for the inspection and Morgan is preparing the files.'],
    ['Morgan is responsible for the inspection on the 20th.', 'Casey is responsible for the inspection on the 20th and Morgan is preparing the files.'],
    ['Morgan is the inspection lead on the 20th.', 'Morgan told the inspection lead to wait on the 20th.']
  ]) {
    const tree = [topic([point('parent', parentText, ['T0001'], { supportingDetails: [point('child', claim, ['T0002'])] })])];
    const result = assess(tree, [unit('T0001', 'The arrangements were discussed.'), unit('T0002', source)], {
      child: { verdict: 'supported', evidenceQuote: source }
    });
    assert.deepEqual(result.discussion[0].points, [], claim);
    assert.equal(result.accounting.parentWithheldChildren.find(row => row.recordId === 'child').disposition, 'withheld');
  }
  for (const claim of ['If access is approved, the pump calibration is required.', 'Morgan is the inspection lead.']) {
    const child = point('child', claim, ['T0002']);
    const tree = [topic([point('parent', parentText, ['T0001'], { supportingDetails: [child] })])];
    assert.deepEqual(assess(tree, [unit('T0001', 'The arrangements were discussed.'), unit('T0002', claim)]).discussion[0].points, [child]);
  }
});

test('an exact selected quote cannot turn a rejected or merely proposed embedded statement into a fact', () => {
  for (const [claim, source] of [
    ['Morgan is the inspection lead.', 'The proposal that Morgan is the inspection lead was rejected.'],
    ['Morgan is the inspection lead.', 'The claim that Morgan is the inspection lead is incorrect.'],
    ['Morgan is the inspection lead.', 'The report says Morgan is the inspection lead, but this is disputed.'],
    ['Morgan is the inspection lead on Monday.', 'The proposal that Morgan is the inspection lead on Monday was rejected and report preparation will follow Friday.'],
    ['Report writing will follow on Monday.', 'The report says that report writing will follow on Monday.'],
    ['Report writing will follow on Monday.', 'Report writing will follow on Monday was the proposal that was rejected.']
  ]) {
    const tree = [topic([point('parent', parentText, ['T0001'], { supportingDetails: [point('child', claim, ['T0002'])] })])];
    const result = assess(tree, [unit('T0001', 'The arrangements were discussed.'), unit('T0002', source)], {
      child: { verdict: 'supported', evidenceQuote: claim }
    });
    assert.deepEqual(result.discussion[0].points, [], source);
  }
});

test('a source question cannot become an independent factual statement through punctuation normalization', () => {
  for (const claim of ['The pump calibration is required.', 'The pump calibration is scheduled for Monday.']) {
    const source = claim.replace(/\.$/, '?');
    const tree = [topic([point('parent', parentText, ['T0001'], { supportingDetails: [point('child', claim, ['T0002'])] })])];
    const result = assess(tree, [unit('T0001', 'The arrangements were discussed.'), unit('T0002', source)], {
      child: { verdict: 'supported', evidenceQuote: claim }
    });
    assert.deepEqual(result.discussion[0].points, [], source);
    assert.equal(result.accounting.parentWithheldChildren.find(row => row.recordId === 'child').reason, 'child_source_question_modality');
  }
});

test('an own source correction survives independently without inheriting the rejected parent details', () => {
  const old = 'The procedure update informed the review feedback.';
  const corrected = 'The review feedback informed the procedure update.';
  const child = point('child', old, ['T0002'], { reviewFlagIds: ['own-existing-review'] });
  const tree = [topic([point('parent', parentText, ['T0001'], { reviewFlagIds: ['parent-review'], supportingDetails: [child] })])];
  const units = [unit('T0001', 'The arrangements were discussed.'), unit('T0002', corrected)];
  const reply = { verdict: 'corrected', issue: 'altered_meaning', problemQuote: old, evidenceQuote: corrected,
    correctedText: corrected, reason: 'The source places the feedback before the procedure update.' };
  const result = assess(tree, units, { child: reply });
  assert.equal(result.discussion[0].points[0]?.text, corrected);
  assert.equal(result.discussion[0].points[0]?.id, child.id);
  assert.deepEqual(result.discussion[0].points[0]?.evidenceIds, child.evidenceIds);
  assert.equal(result.discussion[0].points[0]?.reviewFlagIds.includes('own-existing-review'), true);
  assert.equal(result.discussion[0].points[0]?.reviewFlagIds.includes('parent-review'), false);
  assert.equal(result.accounting.parentWithheldChildren.find(row => row.recordId === 'child').reviewStatus, 'corrected');
  assert.deepEqual(assess(tree, units, { child: { ...reply, evidenceQuote: 'A different update was reviewed.' } }).discussion[0].points, []);
});

test('reviewer-authored topics, rows and the established reviewer-descendant parent exception stay locked', () => {
  const value = 'Keep the reviewer wording exactly as written.';
  const units = [unit('T0001', 'The arrangements were discussed.'), unit('T0002', value)];
  const cases = [
    [{ ...topic([point('parent', parentText, ['T0001'])]), reviewerAuthored: true }],
    [topic([point('parent', parentText, ['T0001'], { reviewerAuthored: true })])],
    [topic([point('parent', parentText, ['T0001'], { supportingDetails: [point('manual', value, ['T0002'], { reviewerAuthored: true })] })])]
  ];
  for (const tree of cases) {
    const result = assess(tree, units);
    assert.equal(result.discussion[0].points[0].text, parentText);
    assert.equal(result.withheld.length, 0);
    if (tree[0].reviewerAuthored || tree[0].points[0].reviewerAuthored) assert.deepEqual(result.discussion, tree);
    else assert.deepEqual(result.discussion[0].points[0].supportingDetails, tree[0].points[0].supportingDetails);
  }
});

test('survivors remain independent through final compaction, repeated review, JSON persistence and public Word/PDF output', async () => {
  const child = point('child', 'The supplier register is ready for inspection.', ['T0002'], { reviewFlagIds: ['existing-check'] });
  const units = [unit('T0001', 'The arrangements were discussed.'), unit('T0002', child.text)];
  const tree = [topic([point('parent', parentText, ['T0001'], { supportingDetails: [child] })])];
  const checked = assess(tree, units);
  assert.deepEqual(checked.discussion[0].points, [child]);
  let discussion = await O.finaliseDiscussionForPublication(copy(checked.discussion), { sourceUnits: units });
  discussion = await O.dedupeAdjacentRestatements(discussion, { sourceUnits: units });
  discussion = await O.demoteContainedPrimaryRows(discussion, { sourceUnits: units });
  discussion = await O.dedupeGlobalRestatements(discussion, { sourceUnits: units });
  discussion = O.normaliseDiscussionPresentation(O.removeRawGeneratedDiscussionRows(discussion));
  assert.ok(discussion.flatMap(topic => topic.points).some(row => row.id === child.id && row.text === child.text));
  assert.deepEqual(assess(copy(discussion), units).discussion, discussion, 'a fresh own review is idempotent');
  let saved = { draftId: 'child-offline', revision: 1, payloadVersion: V.PAYLOAD_VERSION, status: 'draft', currentStep: 2,
    details: { meetingTitle: 'Inspection planning', meetingType: 'General', meetingDate: '2026-06-17' },
    sourceUnits: units, preparedTranscript: V.preparedTranscriptFromUnits(units), discussion: [], actions: [], reviewFlags: [], qualityState: {} };
  const sourceDraft = copy(saved);
  const result = { changes: { discussion, qualityState: { discussion: {
    completedAt: new Date().toISOString(), fidelityReview: checked.accounting, fidelityWithheldRows: checked.withheld
  } } }, reviewFlags: checked.flags };
  const persisted = await A.persistMeetingAgentBackgroundStage({ draftId: saved.draftId, userId: 'offline-reviewer',
    stage: 'discussion', sourceDraft, result, getDraft: async () => copy(saved), saveDraft: async (_, changes) => {
      saved = copy({ ...saved, ...changes, revision: saved.revision + 1 }); return copy(saved);
    } });
  assert.deepEqual(persisted.conflictFields, []);
  const publicDraft = A.publicMeetingAgentDraft(copy(saved));
  assert.ok(publicDraft.discussion.flatMap(topic => topic.points).some(row => row.id === child.id && row.text === child.text));
  assert.equal(JSON.stringify(publicDraft.discussion).includes(parentText), false);
  const docx = await generateMeetingMinutesAgentDocx(A.meetingAgentDraftForDocx(copy(saved)), false);
  const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml').async('string');
  const pdf = renderStagedMinutesPdfHtml(A.meetingAgentDraftForPdf(copy(saved)));
  assert.ok(xml.includes(child.text));
  assert.ok(pdf.includes(child.text));
  assert.equal(xml.includes(parentText), false);
  assert.equal(pdf.includes(parentText), false);
  assert.deepEqual(saved.qualityState.discussion.fidelityReview.parentWithheldChildren, checked.accounting.parentWithheldChildren);
  assert.deepEqual(blocked, [], 'provider, database and subprocess boundaries were never called');
});
