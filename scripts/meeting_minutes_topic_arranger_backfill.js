#!/usr/bin/env node
'use strict';

require('dotenv').config();

const { Pool } = require('pg');
const { stagedEvaluation } = require('../routes/api');
const {
  discussionTopicArrangementInput,
  validateDiscussionTopicArrangement,
  applyDiscussionTopicArrangement
} = require('../utils/canonicalMinutes/discussionOrganiser');

const applyChanges = process.argv.includes('--apply');
const draftIds = process.argv.slice(2)
  .filter((value) => value !== '--apply')
  .map(Number)
  .filter((value) => Number.isSafeInteger(value) && value > 0);

if (!draftIds.length) {
  console.error('Usage: node scripts/meeting_minutes_topic_arranger_backfill.js [--apply] <draft-id> [...]');
  process.exit(2);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || undefined,
  host: process.env.DATABASE_URL ? undefined : process.env.PGHOST,
  port: process.env.DATABASE_URL ? undefined : Number(process.env.PGPORT || 5432),
  database: process.env.DATABASE_URL ? undefined : process.env.PGDATABASE,
  user: process.env.DATABASE_URL ? undefined : process.env.PGUSER,
  password: process.env.DATABASE_URL ? undefined : process.env.PGPASSWORD,
  max: 2
});

function topicRows(topic = {}) {
  return ['points', 'decisions', 'openQuestions'].flatMap((kind) =>
    (Array.isArray(topic[kind]) ? topic[kind] : []).map((record) => ({ kind, record })));
}

function discussionRows(discussion = []) {
  return (Array.isArray(discussion) ? discussion : []).flatMap(topicRows);
}

function recordSnapshot(discussion = []) {
  return new Map(discussionRows(discussion).map(({ kind, record }) => [
    String(record?.id || ''), { kind, json: JSON.stringify(record) }
  ]));
}

function assertRecordsUnchanged(beforeDiscussion, afterDiscussion, draftId) {
  const before = recordSnapshot(beforeDiscussion);
  const after = recordSnapshot(afterDiscussion);
  if (before.has('') || after.has('') || before.size !== after.size) {
    throw new Error(`Draft ${draftId}: stable record accounting changed.`);
  }
  for (const [recordId, expected] of before) {
    const actual = after.get(recordId);
    if (!actual || actual.kind !== expected.kind || actual.json !== expected.json) {
      throw new Error(`Draft ${draftId}: record ${recordId} or its type changed.`);
    }
  }
}

function removeDanglingFlagReferences(discussion = [], reviewFlags = []) {
  const validIds = new Set((Array.isArray(reviewFlags) ? reviewFlags : [])
    .map((flag) => String(flag?.id || '')).filter(Boolean));
  let removed = 0;
  const clean = (record) => {
    if (Array.isArray(record?.reviewFlagIds)) {
      const kept = record.reviewFlagIds.filter((id) => validIds.has(String(id)));
      removed += record.reviewFlagIds.length - kept.length;
      if (kept.length) record.reviewFlagIds = kept;
      else delete record.reviewFlagIds;
    }
    for (const detail of record?.supportingDetails || []) clean(detail);
  };
  for (const { record } of discussionRows(discussion)) clean(record);
  return removed;
}

async function arrangeDraft(row) {
  const payload = row.payload || {};
  const input = discussionTopicArrangementInput(payload.discussion, payload.sourceUnits);
  const response = await stagedEvaluation.askPowerAutomateMeetingMinutesAgentWithRetry(
    stagedEvaluation.meetingMinutesAgentTopicArrangementPrompt({
      discussion: payload.discussion,
      sourceUnits: payload.sourceUnits
    }),
    {
      pass: 'topic-arranger-backfill',
      responseKind: 'topic_arrangement',
      maxAttempts: 2,
      validateResult: (result) => validateDiscussionTopicArrangement(result, input, { maximumRows: 8 }),
      repairPrompt: stagedEvaluation.meetingMinutesAgentTopicArrangementRepairPrompt
    }
  );
  const arranged = applyDiscussionTopicArrangement(
    payload.discussion, response.result, payload.sourceUnits,
    { input, maximumRows: 8 }
  );
  if (!arranged.applied) throw arranged.error || new Error(`Draft ${row.id}: arrangement failed.`);
  assertRecordsUnchanged(payload.discussion, arranged.discussion, row.id);
  const removedFlagRefs = removeDanglingFlagReferences(arranged.discussion, payload.reviewFlags);
  const backfilledAt = new Date().toISOString();
  const nextPayload = {
    ...payload,
    discussion: arranged.discussion,
    qualityState: {
      ...(payload.qualityState || {}),
      discussion: {
        ...(payload.qualityState?.discussion || {}),
        topicArrangementVersion: 1,
        topicArrangement: {
          enabled: true,
          applied: true,
          version: 1,
          diagnostics: arranged.diagnostics,
          fallbackReason: '',
          backfilledAt
        }
      }
    }
  };
  return {
    id: Number(row.id),
    revision: Number(row.revision),
    title: row.title,
    payload: nextPayload,
    attempts: response.timings.length,
    removedFlagRefs,
    diagnostics: arranged.diagnostics,
    topics: arranged.discussion.map((topic) => topic.topic)
  };
}

async function main() {
  const rows = (await pool.query(
    'SELECT id, revision, title, payload FROM meeting_minutes_agent_drafts WHERE id = ANY($1::bigint[]) ORDER BY id',
    [draftIds]
  )).rows;
  if (rows.length !== new Set(draftIds).size) {
    throw new Error(`Requested ${new Set(draftIds).size} drafts but found ${rows.length}.`);
  }
  const prepared = [];
  for (const row of rows) {
    const item = await arrangeDraft(row);
    prepared.push(item);
    console.log(JSON.stringify({
      id: item.id,
      title: item.title,
      revision: item.revision,
      attempts: item.attempts,
      removedFlagRefs: item.removedFlagRefs,
      diagnostics: item.diagnostics,
      topics: item.topics
    }));
  }
  if (!applyChanges) {
    console.log(JSON.stringify({ event: 'topic_arranger_backfill_dry_run', drafts: prepared.length }));
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const item of prepared) {
      const locked = (await client.query(
        'SELECT revision FROM meeting_minutes_agent_drafts WHERE id = $1 FOR UPDATE', [item.id]
      )).rows[0];
      if (!locked || Number(locked.revision) !== item.revision) {
        throw new Error(`Draft ${item.id}: revision changed while the arrangement was being prepared.`);
      }
      const updated = await client.query(
        `UPDATE meeting_minutes_agent_drafts
         SET revision = revision + 1, payload = $2::jsonb, updated_at = NOW()
         WHERE id = $1 AND revision = $3`,
        [item.id, JSON.stringify(item.payload), item.revision]
      );
      if (updated.rowCount !== 1) throw new Error(`Draft ${item.id}: optimistic update failed.`);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  console.log(JSON.stringify({
    event: 'topic_arranger_backfill_committed',
    drafts: prepared.map((item) => ({ id: item.id, revision: item.revision + 1 }))
  }));
}

main()
  .catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  })
  .finally(() => pool.end());
