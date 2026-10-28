'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const STAGES = Object.freeze(['summary', 'discussion', 'actions']);
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const fail = (code, message) => Object.assign(new Error(message), {code});
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const string = value => typeof value === 'string';

function decodeReply(raw) {
  let value;
  try { value = JSON.parse(raw); } catch { throw fail('INVALID_JSON', 'Microsoft returned a non-JSON response.'); }
  if (value?.error) throw fail('PROVIDER_ERROR', 'Microsoft reported an error.');
  const candidate = value?.lastResponse || (Array.isArray(value?.responses) ? value.responses.at(-1) : null) || value;
  try { return typeof candidate === 'string' ? JSON.parse(candidate) : candidate; }
  catch { throw fail('INVALID_AGENT_JSON', 'The specialist did not return strict JSON.'); }
}
function validateResult(stage, result, evidence) {
  if (!object(result) || result.schemaVersion !== 1 || result.specialist !== stage) throw fail('INVALID_CONTRACT', 'The specialist response has the wrong schema or identity.');
  // Validate a copy so the provider response remains available verbatim for diagnostics.
  if (stage === 'actions') result = structuredClone(result);
  const allowedIds = new Set(evidence.map(e => e.id));
  const ids = new Set();
  function cited(record, textKey = 'text', allowEmpty = false, requireId = true) {
    if (!object(record) || !string(record[textKey]) || (!allowEmpty && !record[textKey].trim()) || !Array.isArray(record.evidenceIds)) throw fail('INVALID_RECORD', 'A generated record is missing text or evidence.');
    if (record[textKey].trim() && !record.evidenceIds.length) throw fail('MISSING_EVIDENCE', 'A generated record has no evidence references.');
    if (record.evidenceIds.some(id => !string(id) || !allowedIds.has(id))) throw fail('UNKNOWN_EVIDENCE', 'A generated record cites evidence outside the shared packet.');
    if (requireId && (!string(record.id) || !record.id.trim())) throw fail('MISSING_ID', 'A generated record has no stable identifier.');
    if (record.id !== undefined) {
      if (!string(record.id) || !record.id.trim() || ids.has(record.id)) throw fail('DUPLICATE_ID', 'A specialist returned missing or duplicate record identifiers.');
      ids.add(record.id);
    }
  }
  function records(value) { if (!Array.isArray(value)) throw fail('INVALID_CONTRACT', 'A required output array is absent.'); return value; }
  records(result.reviewFlags).forEach(flag => {
    if (!string(flag?.kind) || !flag.kind.trim()) throw fail('INVALID_FLAG', 'A specialist flag has no kind.');
    cited(flag, 'message', false, false);
  });
  if (stage === 'summary') {
    cited(result.executiveSummary, 'text', true, false);
    if (result.executiveSummary.text.trim().split(/\s+/).filter(Boolean).length > 150) throw fail('SUMMARY_TOO_LONG', 'The executive summary exceeds 150 words.');
    const objectives = records(result.meetingObjectives);
    if (objectives.length > 4) throw fail('OBJECTIVES_TOO_MANY', 'The specialist returned more than four objectives.');
    objectives.forEach(x => cited(x));
  } else if (stage === 'discussion') {
    if (Object.hasOwn(result, 'items')) {
      if (Object.keys(result).some(key => !['schemaVersion','specialist','items','reviewFlags'].includes(key)))
        throw fail('INVALID_CONTRACT', 'The flat discussion response contains unexpected sections.');
      records(result.items).forEach(item => {
        cited(item);
        if (Object.keys(item).some(key => !['id','text','evidenceIds'].includes(key)))
          throw fail('INVALID_RECORD', 'A flat discussion item contains unexpected fields.');
      });
    } else records(result.discussion).forEach(topic => {
      if (!object(topic) || !string(topic.id) || !string(topic.topic) || !topic.topic.trim()) throw fail('INVALID_TOPIC', 'A discussion topic has no identity or heading.');
      if (ids.has(topic.id)) throw fail('DUPLICATE_ID', 'A discussion topic identifier is repeated.');
      ids.add(topic.id);
      for (const key of ['points','decisions','openQuestions']) records(topic[key]).forEach(x => cited(x));
      if (!['points','decisions','openQuestions'].some(k => topic[k].length)) throw fail('EMPTY_TOPIC', 'The discussion specialist returned an empty topic.');
    });
  } else {
    for (const key of ['actions','actionProposals']) records(result[key]).forEach(action => {
      cited(action, 'action');
      if (!Array.isArray(action.owners) || action.owners.some(x => !string(x) || !x.trim())) throw fail('INVALID_OWNERS', 'An action has invalid owner fields.');
      if (!object(action.timing) || !['deadline','target','dependency','not_stated','stated'].includes(action.timing.kind) || !string(action.timing.wording) || !string(action.timing.exactDate)) throw fail('INVALID_TIMING', 'An action has invalid timing fields.');
      const exact = action.timing.exactDate;
      if (exact && (!/^\d{4}-\d{2}-\d{2}$/.test(exact) || Number.isNaN(Date.parse(exact)) || new Date(exact).toISOString().slice(0,10) !== exact)) throw fail('INVALID_DATE', 'An action contains an invalid calendar date.');
      // Published specialists sometimes use not_stated to mean no deadline/date,
      // while still supplying event-relative timing. Preserve that wording in a
      // neutral application kind: do not guess deadline strength or a calendar date.
      if (action.timing.kind === 'not_stated' && (action.timing.wording.trim() || exact))
        action.timing.kind = 'stated';
      if (action.timing.kind === 'not_stated' && (action.timing.wording || exact)) throw fail('INVALID_TIMING', 'An action without stated timing contains a timing value.');
      if (action.timing.kind === 'stated' && !action.timing.wording.trim() && !exact) throw fail('INVALID_TIMING', 'Stated timing requires wording or a valid supplied date.');
      if (key === 'actionProposals' && (!string(action.reason) || !action.reason.trim())) throw fail('INVALID_PROPOSAL', 'An action proposal has no reason.');
    });
  }
  return result;
}

// Storage/display compatibility only: preserve the exact flat wording, order,
// identifiers and citations. No inferred categories, grouping or additional calls.
function discussionForMinutes(result) {
  if (!result) return null;
  if (!Object.hasOwn(result, 'items')) return result.discussion;
  return result.items.length ? [{id:'flat-discussion',topic:'Discussion',hideHeading:true,
    points:result.items,decisions:[],openQuestions:[]}] : [];
}

async function runSpecialists(packet, configuration, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const now = options.now || (() => Date.now());
  const timeoutMs = options.timeoutMs || 180000;
  const packetHash = hash(packet);
  const prompt = JSON.stringify({requestId: options.requestId, schemaVersion:1, task:'Generate your specialist section from the following shared evidence packet. Return your exact specialist JSON schema only.', ...packet});
  const startedAt = now();
  const tasks = STAGES.map(async stage => {
    const start = now();
    const detail = { stage, packetHash, startedAt: new Date(start).toISOString(), status:'running' };
    try {
      const url = configuration[stage]?.webhookUrl;
      if (!url || new URL(url).protocol !== 'https:') throw fail('NOT_CONFIGURED', 'The specialist webhook is not configured.');
      const response = await fetchImpl(url, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({prompt}), signal:AbortSignal.timeout(timeoutMs)});
      const raw = await response.text();
      if (!response.ok) throw fail(`PROVIDER_HTTP_${response.status}`, `Microsoft returned HTTP ${response.status}.`);
      if (Buffer.byteLength(raw) > 4 * 1024 * 1024) throw fail('RESPONSE_TOO_LARGE', 'The provider response exceeds the prototype limit.');
      const decoded = decodeReply(raw);
      const result = validateResult(stage, decoded, packet.evidence);
      const timingCompatibility = stage === 'actions'
        ? ['actions','actionProposals'].flatMap(key => result[key].flatMap((item,index) =>
          decoded[key][index].timing.kind === 'not_stated' && item.timing.kind === 'stated'
            ? [{collection:key,id:item.id,from:'not_stated',to:'stated'}] : []))
        : [];
      return {...detail, status:'completed', completedAt:new Date(now()).toISOString(), elapsedMs:now()-start, result,
        ...(timingCompatibility.length ? {timingCompatibility:{version:1,records:timingCompatibility}} : {})};
    } catch (error) {
      return {...detail, status:'failed', completedAt:new Date(now()).toISOString(), elapsedMs:now()-start, error:{code:error.code || (error.name === 'TimeoutError' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE'), message: error.code ? error.message : 'The specialist could not complete its request.'}};
    }
  });
  // All three promises have started before any result is awaited.
  const branches = Object.fromEntries((await Promise.all(tasks)).map(x => [x.stage, x]));
  const complete = STAGES.every(s => branches[s].status === 'completed');
  const any = STAGES.some(s => branches[s].status === 'completed');
  return {status:complete?'completed':any?'partial':'failed', packetHash, parallelElapsedMs:now()-startedAt, branches,
    minutes:{details:packet.meetingDetails, executiveSummary:branches.summary.result?.executiveSummary?.text ?? null,
      executiveSummaryEvidenceIds:branches.summary.result?.executiveSummary?.evidenceIds ?? null,
      meetingObjectives:branches.summary.result?.meetingObjectives ?? null,
      discussion:discussionForMinutes(branches.discussion.result),
      actions:branches.actions.result?.actions ?? null,
      actionProposals:branches.actions.result?.actionProposals ?? null,
      reviewFlags:STAGES.flatMap(s=>(branches[s].result?.reviewFlags||[]).map(f=>({...f,specialist:s})))},
    limitations:['Independent transcript-based summary; cross-specialist consistency has not been adjudicated.','Evidence references and response structure were validated; semantic completeness and truth require review.']};
}

module.exports = {STAGES, hash, decodeReply, validateResult, discussionForMinutes, runSpecialists};
