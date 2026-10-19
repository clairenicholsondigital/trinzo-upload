'use strict';

const { isReviewerAuthored } = require('./canonicalMinutes/state');
const { normaliseAgentResult } = require('./meetingMinutesAgentV2');

const KINDS = ['points', 'decisions', 'openQuestions'];
const rows = (value) => Array.isArray(value) ? value : [];
const authored = (row) => isReviewerAuthored(row) || /^manual(?:-topic|-action)?-/.test(String(row?.id || ''));
const textOf = (row) => String(row?.text || '');
const hasAuthoredContent = (row) => isReviewerAuthored(row)
  || rows(row?.supportingDetails).some(hasAuthoredContent);

function uniqueBy(values, identity) {
  const result = new Map();
  for (const row of rows(values)) {
    if (!row?.id) continue;
    const key = identity(row);
    result.set(key, result.has(key) ? null : row);
  }
  return result;
}
const uniqueIds = (values) => uniqueBy(values, (row) => row.id);

function recordSignature(row) {
  return [row?.id, textOf(row), rows(row?.supportingDetails).map(recordSignature)];
}

function topicSignature(topic) {
  return JSON.stringify([topic?.topic, Boolean(topic?.hideHeading), ...KINDS.map((kind) =>
    rows(topic?.[kind]).map(recordSignature))]);
}

function actionSignature(action) {
  const timing = action?.timing || {};
  return JSON.stringify([action?.action, action?.owners || [], timing.kind || 'not_stated', timing.wording || '', timing.exactDate || '']);
}

const recordIdentity = (record) => JSON.stringify(recordSignature(record));
const actionIdentity = (action) => JSON.stringify([action?.id, actionSignature(action)]);
const topicIdentity = (topic) => JSON.stringify([topic?.id, topicSignature(topic)]);
const topicContainer = (topic) => JSON.stringify([topic?.id, topic?.topic, Boolean(topic?.hideHeading)]);

// Restore only rows actually returned by the model. Missing rows remain absent,
// and changed wording remains generated. A copied row filtered by normalisation
// is inserted beside its surviving neighbours from the returned list.
function mergeCopiedRows(normalised, raw, copied, identity, allowUniqueIdFallback = false) {
  const result = [...(normalised || [])];
  const claimed = new Set();
  const rawById = allowUniqueIdFallback ? uniqueIds(raw) : new Map();
  const normalisedById = allowUniqueIdFallback ? uniqueIds(normalised) : new Map();
  for (const row of copied || []) {
    const key = identity(row);
    let existing = result.findIndex((item) => !claimed.has(item) && identity(item) === key);
    // Ordinary action normalisation may alter an owner, timing or wording. If
    // the returned and normalised IDs are both unique, replace that occurrence
    // rather than displaying its generated rewrite beside the human original.
    if (existing < 0 && rawById.get(row.id) && normalisedById.get(row.id)) {
      existing = result.findIndex((item) => !claimed.has(item) && item === normalisedById.get(row.id));
    }
    if (existing >= 0) {
      result[existing] = row;
      claimed.add(row);
      continue;
    }
    const rawIndex = (raw || []).findIndex((item) => identity(item) === key);
    const following = (raw || []).slice(rawIndex + 1).find((item) => result.some((current) => identity(current) === identity(item)));
    const preceding = (raw || []).slice(0, rawIndex).reverse().find((item) => result.some((current) => identity(current) === identity(item)));
    const at = following ? result.findIndex((item) => identity(item) === identity(following))
      : preceding ? result.findIndex((item) => identity(item) === identity(preceding)) + 1 : result.length;
    result.splice(at, 0, row);
    claimed.add(row);
  }
  return result;
}

function preserveCopiedReviewerContent(previous, raw, normalised, stage) {
  // Provider arrays may contain malformed containers; ordinary normalisation
  // already tolerates them, so copied-content reconciliation must do so too.
  raw = { ...raw, actions: rows(raw.actions), discussion: rows(raw.discussion).filter((topic) => topic && typeof topic === 'object')
    .map((topic) => ({ ...topic, ...Object.fromEntries(KINDS.map((kind) => [kind, rows(topic[kind])])) })) };
  if (stage === 'actions') {
    const oldByContent = uniqueBy(previous.actions, actionIdentity);
    const claimed = new Set();
    const copied = (raw.actions || []).flatMap((row) => {
      const key = actionIdentity(row);
      const old = oldByContent.get(key);
      if (!old || !authored(old) || claimed.has(key)) return [];
      claimed.add(key);
      return [{ ...old, reviewerAuthored: true }];
    });
    return copied.length ? { ...normalised, actions: mergeCopiedRows(normalised.actions, raw.actions, copied, actionIdentity, true) } : normalised;
  }
  if (stage !== 'discussion') return normalised;
  const oldTopics = uniqueBy(previous.discussion, topicIdentity);
  const previousRecords = (previous.discussion || []).flatMap((topic) => KINDS.flatMap((kind) =>
    (topic[kind] || []).map((record) => ({ ...record, inheritedAuthorship: authored(topic) }))));
  const oldRecords = uniqueIds(previousRecords);
  const oldRecordsByContent = uniqueBy(previousRecords, recordIdentity);
  const rawRecords = uniqueIds((raw.discussion || []).flatMap((topic) => KINDS.flatMap((kind) => topic[kind] || [])));
  const claimedRecords = new Set();
  const claimedTopics = new Set();
  const candidates = (raw.discussion || []).filter((topic) => {
    const key = topicIdentity(topic);
    if (!topic.id || claimedTopics.has(key)) return false;
    claimedTopics.add(key);
    return true;
  }).map((topic) => {
    const oldTopic = oldTopics.get(topicIdentity(topic));
    const next = { id: topic.id, topic: topic.topic, ...(topic.hideHeading === true ? { hideHeading: true } : {}) };
    if (oldTopic && authored(oldTopic) && topicSignature(oldTopic) === topicSignature(topic)) next.reviewerAuthored = true;
    for (const kind of KINDS) {
      next[kind] = (topic[kind] || []).flatMap((record) => {
        // IDs are reused in historical drafts and occasionally in model output.
        // Exact content disambiguates those rows; only one returned occurrence
        // can inherit a uniquely identified saved reviewer's authorship.
        const key = recordIdentity(record);
        const old = rawRecords.get(record?.id) && oldRecords.get(record?.id)
          || oldRecordsByContent.get(key);
        if (!old || claimedRecords.has(key)) return [];
        const oldDetails = uniqueIds(old.supportingDetails);
        const authority = authored(old) || old.inheritedAuthorship;
        const candidate = { ...record, reviewerAuthored: undefined, confirmedTopic: undefined, source: undefined };
        // A copied primary sentence can coexist with explicitly changed detail.
        // Keep that returned detail rather than restoring the original subtree.
        if (authority && textOf(record) === textOf(old)) candidate.reviewerAuthored = true;
        candidate.supportingDetails = rows(record.supportingDetails).map((detail) => {
          const prior = oldDetails.get(detail?.id);
          return { ...detail, reviewerAuthored: Boolean(prior && (authority || authored(prior)) && textOf(prior) === textOf(detail)), confirmedTopic: undefined, source: undefined };
        });
        if (!hasAuthoredContent(candidate)) return [];
        claimedRecords.add(key);
        return [candidate];
      });
    }
    return next;
  }).filter((topic) => KINDS.some((kind) => topic[kind].length));
  if (!candidates.length) return normalised;
  const copied = normaliseAgentResult({ discussion: candidates }, previous.sourceUnits || [], '', {
    enforceEvidence: false, dedupeActions: false, mergeTopics: false, preserveReviewerEdits: true
  }).discussion;
  let discussion = (normalised.discussion || []).map((topic) => ({ ...topic, ...Object.fromEntries(KINDS.map((kind) => [kind, [...(topic[kind] || [])]])) }));
  for (const topic of copied) {
    let target = discussion.find((item) => topicContainer(item) === topicContainer(topic));
    for (const kind of KINDS) {
      for (const record of topic[kind]) {
        const key = recordIdentity(record);
        if (target?.[kind].some((row) => recordIdentity(row) === key)) continue;
        // A copied row may have been merged into another topic or record type.
        // Move one matching occurrence, never every row sharing its ID.
        let removed = false;
        for (const item of discussion) {
          for (const otherKind of KINDS) {
            const index = item[otherKind].findIndex((row) => recordIdentity(row) === key);
            if (!removed && index >= 0) { item[otherKind].splice(index, 1); removed = true; }
          }
        }
      }
    }
    if (!target) {
      target = { ...topic, points: [], decisions: [], openQuestions: [] };
      discussion = mergeCopiedRows(discussion, raw.discussion, [target], topicContainer);
    }
    const rawTopic = raw.discussion.find((item) => topicContainer(item) === topicContainer(topic));
    for (const kind of KINDS) target[kind] = mergeCopiedRows(target[kind], rawTopic?.[kind], topic[kind], recordIdentity);
    // Normalisation may have merged a second generated topic into this one.
    // Those extra rows must not inherit the copied topic's authorship.
    if (topic.reviewerAuthored && topicSignature(target) === topicSignature(rawTopic)) target.reviewerAuthored = true;
    else delete target.reviewerAuthored;
  }
  discussion = discussion.filter((topic) => KINDS.some((kind) => topic[kind].length));
  return { ...normalised, discussion };
}

module.exports = { preserveCopiedReviewerContent };
