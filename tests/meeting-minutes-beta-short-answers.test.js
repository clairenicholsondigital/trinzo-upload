'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const P = require('../utils/meetingMinutesParallel');
const V = require('../utils/meetingMinutesAgentV2');

// Execute the actual upload handler with isolated persistence/generation and a
// preparation spy. No Microsoft requests or production draft writes in tests.
async function upload(provider, flag) {
  const source = fs.readFileSync(path.join(__dirname, '../routes/api.js'), 'utf8');
  const start = source.indexOf("router.post('/meeting-minutes-agent/prepare'");
  const end = source.indexOf('\nregisterMeetingMinutesLibraryList(router)', start + 1);
  let handler, options, persisted;
  const context = {
    router: { post(route, auth, fn) { handler = fn; } },
    requireAuth() {}, withTestUpload: fn => fn,
    parallelMinutes: { ...P, chooseProvider: () => provider,
      preserveMeaningfulShortAnswers: p => P.preserveMeaningfulShortAnswers(p,
        { MEETING_MINUTES_BETA_SHORT_ANSWERS_V1: flag }) },
    readTestTranscript: async req => ({ text: req.body.text, fileName: 'Controlled test.txt' }),
    validateTranscriptText() {}, applyTranscriptPhraseCorrections: text => ({ text, applied: [] }),
    prepareMiniLmTranscript: async (text, passed) => {
      options = passed;
      return { sourceUnits: [{id:'T0001',speaker:'Sam',timestamp:'0:02',text:'Twenty four.',classification:'uncertain'}] };
    },
    extractStagedDetailsFromTranscript: () => ({screens:{details:{meetingTitle:'Controlled test'}}}),
    meetingAgentDateContext: () => ({invalid:[],conflict:false}),
    sanitiseMeetingAgentDetails: x => x,
    normaliseSourceUnits: V.normaliseSourceUnits,
    preparedTranscriptFromUnits: V.preparedTranscriptFromUnits,
    salientDetailInventory: () => [],
    createMeetingMinutesAgentDraft: async input => { persisted = input; return {draftId:'test',...input.payload}; },
    meetingAgentDraftPayload: x => x,
    startInitialMeetingAgentProcessing: async x => x,
    publicMeetingAgentDraft: x => x,
    meetingMinutesAgentHybridEnabled: () => false,
    meetingMinutesAgentSpeculativePipelineEnabled: () => false,
    crypto, process: {env:{}}, console: {info() {},warn() {},log() {}},
    sendTestError(res, error) { throw error; },
  };
  vm.runInNewContext(source.slice(start, end), context);
  const res = {json(body) { this.body = body; return this; }};
  await handler({authUser:{userId:'test'},body:{text:'Alex: How many languages?\nSam: Twenty four.'}}, res);
  return {options,persisted,response:res.body};
}

test('only an enabled Beta provider can activate bounded source preservation', () => {
  for (const flag of [undefined,'','0','false','off','junk','true-ish']) {
    assert.equal(P.preserveMeaningfulShortAnswers(P.PROVIDER,{MEETING_MINUTES_BETA_SHORT_ANSWERS_V1:flag}),false);
  }
  for (const flag of ['1','true','TRUE','yes','on']) {
    assert.equal(P.preserveMeaningfulShortAnswers(P.PROVIDER,{MEETING_MINUTES_BETA_SHORT_ANSWERS_V1:flag}),true);
    assert.equal(P.preserveMeaningfulShortAnswers('legacy',{MEETING_MINUTES_BETA_SHORT_ANSWERS_V1:flag}),false);
  }
});

test('upload route passes the resolved gate and persists the same preparation version', async () => {
  for (const [provider,flag,enabled] of [
    [P.PROVIDER,undefined,false], [P.PROVIDER,'1',true],
    [P.PROVIDER,'0',false], ['legacy','1',false], ['legacy','0',false],
  ]) {
    const {options,persisted,response} = await upload(provider,flag);
    assert.equal(options.preserveMeaningfulShortAnswers,enabled);
    assert.equal(options.preserveShortContextFragments,true);
    assert.equal(options.preserveShortTemporalFragments,true);
    assert.equal(options.keepShortReplies,false);
    assert.equal(persisted.payload.qualityState.preparation.meaningfulShortAnswersVersion,Number(enabled));
    assert.equal(response.performance.meaningfulShortAnswersVersion,Number(enabled));
    assert.equal(persisted.payload.generationProvider,provider===P.PROVIDER ? provider : undefined);
    assert.equal(persisted.rawTranscript,'Alex: How many languages?\nSam: Twenty four.');
  }
});

test('Beta regeneration preserves the saved preparation and packet identity', () => {
  const draft = {generationProvider:P.PROVIDER,sourceUnits:[{id:'T0001',speaker:'Sam',timestamp:'0:02',text:'Twenty four.',classification:'uncertain'}],
    qualityState:{preparation:{meaningfulShortAnswersVersion:1}},details:{meetingTitle:'Test'}};
  const next = P.initialPayload(draft);
  assert.deepEqual(next.qualityState.preparation,draft.qualityState.preparation);
  assert.deepEqual(P.packet(next),P.packet(draft));
  assert.notEqual(P.inputHash(draft),P.inputHash({...draft,sourceUnits:[]}));
  assert.equal(P.publicDraft({...draft,draftId:'test'}).qualityState,undefined);
});
