'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { createOriginalEditStage } = require('../utils/meetingMinutesOriginalEdits');
const originalLoad = Module._load;
const forbidden = [];
const deny = label => () => {
  forbidden.push(label);
  throw new Error('Direct Original edits fixture forbids ' + label);
};
let services;
Module._load = function (name) {
  if (name === 'node-fetch') return deny('provider transport');
  if (name === 'pg') return { Pool: class { constructor() { deny('pg.Pool')(); } } };
  if (name === 'child_process') return new Proxy({}, { get: (_target, key) => deny('child_process.' + String(key)) });
  return originalLoad.apply(this, arguments);
};
try { services = require('../routes/api').stagedEvaluation.originalMinutesStageServices; }
finally { Module._load = originalLoad; }

const point = (id, text, extra = {}) => ({ id, text, evidenceIds: ['T0001'],
  supportingDetails: [], reviewFlagIds: [], ...extra });
const topic = points => ({ id: 'delivery', topic: 'Delivery planning', points, decisions: [], openQuestions: [] });
function draft() {
  return {
    details: { meetingTitle: 'Delivery planning', meetingType: 'General', meetingDate: '2026-10-19' },
    preparedTranscript: 'Alex: The pack is ready for review. There were some lighthearted remarks. Alex will send the form after approval. '.repeat(2),
    sourceUnits: [{ id: 'T0001', speaker: 'Alex',
      text: 'The pack is ready for review. There were some lighthearted remarks. Alex will send the form after approval.' }],
    discussion: [topic([point('manual', 'There were some lighthearted remarks.', { reviewerAuthored: true }),
      point('pack', 'The pack is ready.')])],
    actions: [], currentStep: 2, qualityState: {}, salientDetails: [], reviewFlags: [], meetingObjectives: []
  };
}
function generator(reply, retryReply) {
  const calls = [];
  const run = createOriginalEditStage({ ...services,
    askPowerAutomateMeetingMinutesAgent: async prompt => {
      calls.push({ kind: 'primary', prompt });
      return structuredClone(reply);
    },
    askPowerAutomateMeetingMinutesAgentWithRetry: async (prompt, options) => {
      calls.push({ kind: 'review', prompt, options });
      return { result: await retryReply(prompt, options) };
    }
  });
  return { run, calls };
}

test('Original fallback and edits reject short and oversized UTF-8 transcripts before transport', async () => {
  const f = generator({});
  for (const [preparedTranscript, statusCode] of [['too short', 400], ['€'.repeat(70000), 413]]) {
    await assert.rejects(f.run({ ...draft(), preparedTranscript }, 'discussion', 'Keep the wording.'), error => error.statusCode === statusCode);
  }
  assert.equal(f.calls.length, 0);
  assert.deepEqual(forbidden, []);
});

test('Original explicit edits preserve copied reviewer wording and postpone coverage until Actions exist', async () => {
  const before = draft();
  before.sourceUnits.push({ id: 'T0002', speaker: 'Alex',
    text: 'Calibration valves require twelve replacement cartridges.' });
  before.salientDetails = [{ id: 'detail-calibration', kind: 'quantity',
    text: 'Calibration valves require twelve replacement cartridges.', evidenceIds: ['T0002'] }];
  const reply = { discussion: [topic([point('manual', 'There were some lighthearted remarks.'),
    point('pack', 'The pack is ready for review.')])] };
  const f = generator(reply);
  const snapshot = structuredClone({ before, reply });
  const early = await f.run(before, 'discussion', 'Expand the pack status while keeping the other text.');
  assert.deepEqual(early.changes.discussion[0].points.map(row => row.text),
    ['There were some lighthearted remarks.', 'The pack is ready for review.']);
  assert.equal(early.changes.discussion[0].points[0].reviewerAuthored, true);
  assert.equal(early.changes.discussion[0].points[1].reviewerAuthored, undefined);
  assert.equal(early.replaceCoverageFlags, false);
  assert.ok(!early.reviewFlags.some(flag => flag.id === 'coverage-detail-calibration'));
  const later = await f.run({ ...structuredClone(before), currentStep: 3 }, 'discussion', 'Keep both points.');
  assert.equal(later.replaceCoverageFlags, true);
  assert.ok(later.reviewFlags.some(flag => flag.id === 'coverage-detail-calibration'));
  assert.deepEqual({ before, reply }, snapshot);
  assert.deepEqual(forbidden, []);
});

test('Original fallback normalizes dated discussion using the actual confirmed meeting-date policy', async () => {
  const before = draft();
  before.details.meetingDate = '2026-06-17';
  before.sourceUnits = [{ id: 'T0001', speaker: 'Robin',
    text: 'Existing products must be entered into the product register by 28 November this year.' }];
  before.preparedTranscript = 'Robin: ' + before.sourceUnits[0].text.repeat(2);
  before.discussion = [];
  const row = point('register', 'Existing products must be entered into the product register by 28 November 2026.');
  const f = generator({ discussion: [{ ...topic([row]), topic: 'Product registration' }] });
  const confirmed = await f.run(before, 'discussion', '');
  assert.deepEqual(confirmed.changes.discussion[0].points[0].evidenceIds, ['T0001']);
  const conflictedDraft = { ...structuredClone(before), qualityState: { preparation: {
    dateContext: { source: 'transcript_header', conflict: true, invalid: [] }
  } } };
  const conflicted = await f.run(conflictedDraft, 'discussion', '');
  assert.deepEqual(conflicted.changes.discussion[0].points[0].evidenceIds, []);
  assert.equal(conflictedDraft.details.meetingDate, '2026-06-17');
  assert.deepEqual(forbidden, []);
});

test('Original Summary fallback grounds prose and forwards its timing review through the provider retry port', async () => {
  const before = draft();
  const statement = 'The supplier report is due Friday.';
  before.details.meetingDate = '2026-06-17';
  before.discussion = [{ topic: 'Supplier report', points: [point('supplier', statement)], decisions: [], openQuestions: [] }];
  before.sourceUnits = [{ id: 'T0001', speaker: 'Alex', text: statement }];
  before.qualityState = { preparation: { preserved: true }, summary: { retained: 'existing-summary-state' } };
  const f = generator({ executiveSummary: statement + ' Penguins deliver moon rockets.', meetingObjectives: [],
    reviewFlags: [{ id: 'model-summary-noise', kind: 'uncertain_fact', message: 'Model-created duplicate notice.' }] }, prompt => ({
    results: JSON.parse(prompt.slice(prompt.indexOf('ITEMS:\n') + 'ITEMS:\n'.length))
      .map(item => ({ id: item.id, verdict: 'supported', evidenceQuote: item.row }))
  }));
  const result = await f.run(before, 'summary', 'Keep the supplier deadline.');

  assert.equal(result.changes.executiveSummary, statement);
  assert.equal(result.changes.qualityState.summary.temporalReview.complete, true);
  assert.equal(result.changes.qualityState.summary.retained, 'existing-summary-state');
  assert.deepEqual(result.changes.qualityState.preparation, { preserved: true });
  assert.equal(result.replaceCoverageFlags, true);
  assert.ok(!result.reviewFlags.some(flag => flag.id === 'model-summary-noise'));
  const review = f.calls.find(call => call.kind === 'review');
  assert.equal(review.options.pass, 'summary:critic-summary-timing-1');
  assert.equal(review.options.responseKind, 'correction_check');
  assert.ok(review.options.deadlineAt > Date.now());
  assert.deepEqual(forbidden, []);
});
