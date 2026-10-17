'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Load the actual data-access module with an isolated pg boundary. No test can
// accidentally use production credentials or alter real drafts.
function libraryDatabase() {
  const filename = path.resolve(__dirname, '../utils/db.js');
  const realRequire = createRequire(filename);
  const calls = [];
  class Pool {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('COUNT(*)::int AS total')) return { rows: [{ total: 1 }] };
      if (sql.includes('SELECT id, revision, status, title, file_name, payload, created_at, updated_at')) {
        return { rows: [{ id: 7, revision: 2, status: 'draft', title: 'Meeting', payload: {} }] };
      }
      return { rows: [] };
    }
  }
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports,
    require: (name) => name === 'pg' ? { Pool } : realRequire(name),
    process: { env: { DATABASE_URL: 'postgres://isolated-test-only' } },
    setTimeout, console
  }, { filename });
  return { list: module.exports.listMeetingMinutesAgentDraftPage, calls };
}

test('Library pagination always sends bounded integers to PostgreSQL', async () => {
  const { list, calls } = libraryDatabase();
  for (const [options, limit, offset] of [
    [{}, 10, 0],
    [{ limit: '4.8', offset: '10.9' }, 4, 10],
    [{ limit: -7, offset: -10 }, 1, 0],
    [{ limit: 'Infinity', offset: 'Infinity' }, 50, 100000],
    [{ limit: 'invalid', offset: 'invalid' }, 10, 0],
    [{ limit: 99, offset: 999999 }, 50, 100000]
  ]) {
    const page = await list(12, options);
    assert.equal(page.limit, limit, JSON.stringify(options));
    assert.equal(page.offset, offset, JSON.stringify(options));
    const rows = calls.findLast((call) => call.sql.includes('LIMIT $4 OFFSET $5'));
    assert.equal(rows.params[3], limit);
    assert.equal(rows.params[4], offset);
    assert.equal(page.drafts[0].draftId, '7');
    assert.equal(page.total, 1);
  }
});

test('Library search escapes wildcard characters and every query is scoped to its owner', async () => {
  const { list, calls } = libraryDatabase();
  await list(12, { search: '  release_50%\\draft  ', status: 'COMPLETE', sort: 'title_desc' });
  const reads = calls.filter((call) => call.sql.startsWith('SELECT'));
  assert.equal(reads.length, 2);
  for (const call of reads) {
    assert.match(call.sql, /user_id = \$1/);
    assert.match(call.sql, /title ILIKE/);
    assert.match(call.sql, /file_name ILIKE/);
    assert.deepEqual(Array.from(call.params.slice(0, 3)), [12, 'release\\_50\\%\\\\draft', 'complete']);
  }
  assert.match(reads[1].sql, /ORDER BY LOWER\(title\) DESC, created_at DESC, id DESC/);
});

test('Library sort and status inputs cannot become SQL syntax', async () => {
  const { list, calls } = libraryDatabase();
  const malicious = "complete'; DELETE FROM meeting_minutes_agent_drafts; --";
  await list(23, { sort: malicious, status: malicious });
  const reads = calls.filter((call) => call.sql.startsWith('SELECT'));
  for (const call of reads) {
    assert.equal(call.sql.includes(malicious), false);
    assert.deepEqual(Array.from(call.params.slice(0, 3)), [23, '', '']);
  }
  assert.match(reads[1].sql, /ORDER BY created_at DESC, id DESC/);
});
