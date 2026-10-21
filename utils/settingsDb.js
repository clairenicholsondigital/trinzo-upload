'use strict';

// Database storage for the Settings page: people, glossary terms and a change
// history. Tables are created on first use and seeded once from the built-in
// defaults, so deleting a row on the page is never undone by a re-seed.

const { query, withTransaction, hasDatabaseConfig } = require('./db');
const { DEFAULT_PEOPLE, DEFAULT_TERMS } = require('./settingsDefaults');

const LIMITS = Object.freeze({ name: 120, term: 80, meaning: 300, spelling: 120, heardAs: 80, listItems: 30, minHeardAs: 3 });

function clean(value) { return String(value == null ? '' : value).replace(/\s+/g, ' ').trim(); }
function key(value) {
  return clean(value).normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[’‘`]/g, "'").toLowerCase();
}

function cleanList(value, max) {
  const list = Array.isArray(value) ? value : String(value || '').split(/\r?\n/);
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const text = clean(item).slice(0, max);
    if (!text || seen.has(key(text))) continue;
    seen.add(key(text));
    out.push(text);
  }
  return out;
}

class SettingsValidationError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

// Checks a person against the others. Returns the cleaned person or throws a
// message written for the person filling in the form.
function validatePerson(input = {}, others = []) {
  const name = clean(input.name);
  if (!name) throw new SettingsValidationError('Add the person’s name.');
  if (name.length > LIMITS.name) throw new SettingsValidationError(`Keep the name under ${LIMITS.name} characters.`);
  if (!/\p{L}/u.test(name)) throw new SettingsValidationError('The name needs at least one letter.');
  const side = input.side === 'client' ? 'client' : input.side === 'internal' ? 'internal' : '';
  if (!side) throw new SettingsValidationError('Choose Internal or Client.');
  const spellings = cleanList(input.spellings, LIMITS.spelling).filter((item) => key(item) !== key(name));
  if (spellings.length > LIMITS.listItems) throw new SettingsValidationError(`Add at most ${LIMITS.listItems} other spellings.`);
  const taken = new Map();
  for (const other of others) {
    taken.set(key(other.name), other.name);
    for (const spelling of other.spellings || []) taken.set(key(spelling), other.name);
  }
  if (taken.has(key(name))) throw new SettingsValidationError(`${name} is already on the list as ${taken.get(key(name))}.`);
  for (const spelling of spellings) {
    if (taken.has(key(spelling))) {
      throw new SettingsValidationError(`“${spelling}” is already used for ${taken.get(key(spelling))}.`);
    }
  }
  return { name, side, spellings };
}

function validateTerm(input = {}, others = []) {
  const term = clean(input.term);
  if (!term) throw new SettingsValidationError('Add the term.');
  if (term.length > LIMITS.term) throw new SettingsValidationError(`Keep the term under ${LIMITS.term} characters.`);
  const meaning = clean(input.meaning);
  if (meaning.length > LIMITS.meaning) throw new SettingsValidationError(`Keep the meaning under ${LIMITS.meaning} characters.`);
  const heardAs = cleanList(input.heardAs, LIMITS.heardAs).filter((item) => key(item) !== key(term));
  if (heardAs.length > LIMITS.listItems) throw new SettingsValidationError(`Add at most ${LIMITS.listItems} wrong spellings.`);
  for (const item of heardAs) {
    if (item.replace(/[^\p{L}\p{N}]/gu, '').length < LIMITS.minHeardAs) {
      throw new SettingsValidationError(`“${item}” is too short to correct safely. Use at least ${LIMITS.minHeardAs} letters.`);
    }
    if (!/^[\p{L}\p{N}]/u.test(item) || !/[\p{L}\p{N}]$/u.test(item)) {
      throw new SettingsValidationError(`“${item}” should start and end with a letter or number.`);
    }
  }
  const taken = new Map();
  for (const other of others) {
    taken.set(key(other.term), { owner: other.term, kind: 'term' });
    for (const item of other.heardAs || []) taken.set(key(item), { owner: other.term, kind: 'heard' });
  }
  if (taken.get(key(term))?.kind === 'term') throw new SettingsValidationError(`${term} is already in the glossary.`);
  if (taken.get(key(term))?.kind === 'heard') {
    throw new SettingsValidationError(`${term} is listed as a wrong spelling of ${taken.get(key(term)).owner}.`);
  }
  for (const item of heardAs) {
    const clash = taken.get(key(item));
    if (clash) throw new SettingsValidationError(`“${item}” is already used for ${clash.owner}.`);
  }
  return { term, meaning, heardAs };
}

let schemaReady = false;

async function ensureSettingsSchema() {
  if (schemaReady) return;
  await query(`
    CREATE TABLE IF NOT EXISTS settings_people (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      side TEXT NOT NULL CHECK (side IN ('internal', 'client')),
      spellings JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_by TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await query('CREATE UNIQUE INDEX IF NOT EXISTS idx_settings_people_name ON settings_people (LOWER(name))');
  await query(`
    CREATE TABLE IF NOT EXISTS settings_terms (
      id BIGSERIAL PRIMARY KEY,
      term TEXT NOT NULL,
      meaning TEXT NOT NULL DEFAULT '',
      heard_as JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_by TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await query('CREATE UNIQUE INDEX IF NOT EXISTS idx_settings_terms_term ON settings_terms (LOWER(term))');
  await query(`
    CREATE TABLE IF NOT EXISTS settings_changes (
      id BIGSERIAL PRIMARY KEY,
      item_type TEXT NOT NULL CHECK (item_type IN ('person', 'term')),
      item_id BIGINT,
      action TEXT NOT NULL CHECK (action IN ('added', 'changed', 'deleted')),
      before JSONB,
      after JSONB,
      user_email TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await query('CREATE INDEX IF NOT EXISTS idx_settings_changes_created ON settings_changes (created_at DESC)');
  await query('CREATE TABLE IF NOT EXISTS settings_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT \'\', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  await withTransaction(async (client) => {
    // One server seeds; the others wait here and then see the marker.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('trinzo_settings_seed'))");
    const seeded = await client.query("SELECT key FROM settings_meta WHERE key IN ('people_seeded', 'terms_seeded')");
    const done = new Set(seeded.rows.map((row) => row.key));
    if (!done.has('people_seeded')) {
      for (const person of DEFAULT_PEOPLE) {
        await client.query(
          `INSERT INTO settings_people (name, side, spellings, updated_by) VALUES ($1, $2, $3::jsonb, 'built-in')
           ON CONFLICT DO NOTHING`,
          [person.name, person.side, JSON.stringify(person.spellings)]
        );
      }
      await client.query("INSERT INTO settings_meta (key, value) VALUES ('people_seeded', 'defaults')");
    }
    if (!done.has('terms_seeded')) {
      for (const term of DEFAULT_TERMS) {
        await client.query(
          `INSERT INTO settings_terms (term, meaning, heard_as, updated_by) VALUES ($1, $2, $3::jsonb, 'built-in')
           ON CONFLICT DO NOTHING`,
          [term.term, term.meaning, JSON.stringify(term.heardAs)]
        );
      }
      await client.query("INSERT INTO settings_meta (key, value) VALUES ('terms_seeded', 'defaults')");
    }
  });
  schemaReady = true;
}

function personRow(row) {
  return {
    id: Number(row.id), name: row.name, side: row.side,
    spellings: Array.isArray(row.spellings) ? row.spellings : [],
    updatedBy: row.updated_by || '', updatedAt: row.updated_at
  };
}

function termRow(row) {
  return {
    id: Number(row.id), term: row.term, meaning: row.meaning || '',
    heardAs: Array.isArray(row.heard_as) ? row.heard_as : [],
    updatedBy: row.updated_by || '', updatedAt: row.updated_at
  };
}

function isAvailable() { return hasDatabaseConfig(); }

async function loadSettings() {
  await ensureSettingsSchema();
  const people = await query('SELECT * FROM settings_people ORDER BY LOWER(name)');
  const terms = await query('SELECT * FROM settings_terms ORDER BY LOWER(term)');
  return { people: people.rows.map(personRow), terms: terms.rows.map(termRow) };
}

async function listChanges(limit = 50) {
  await ensureSettingsSchema();
  const result = await query(
    'SELECT * FROM settings_changes ORDER BY created_at DESC, id DESC LIMIT $1',
    [Math.max(1, Math.min(200, Number(limit) || 50))]
  );
  return result.rows.map((row) => ({
    id: Number(row.id), itemType: row.item_type, itemId: row.item_id == null ? null : Number(row.item_id),
    action: row.action, before: row.before, after: row.after, userEmail: row.user_email, createdAt: row.created_at
  }));
}

async function recordChange(client, { itemType, itemId, action, before, after, userEmail }) {
  await client.query(
    `INSERT INTO settings_changes (item_type, item_id, action, before, after, user_email)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)`,
    [itemType, itemId, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, userEmail || '']
  );
}

function notFound(label) {
  const error = new Error(`That ${label} no longer exists. Refresh the page.`);
  error.status = 404;
  return error;
}

function plainPerson(person) { return person && { name: person.name, side: person.side, spellings: person.spellings }; }
function plainTerm(term) { return term && { term: term.term, meaning: term.meaning, heardAs: term.heardAs }; }

async function savePerson({ id = null, input, userEmail = '' }) {
  await ensureSettingsSchema();
  return withTransaction(async (client) => {
    await client.query('LOCK TABLE settings_people IN SHARE ROW EXCLUSIVE MODE');
    const all = (await client.query('SELECT * FROM settings_people')).rows.map(personRow);
    const before = id == null ? null : all.find((person) => person.id === Number(id));
    if (id != null && !before) throw notFound('person');
    const person = validatePerson(input, all.filter((item) => item.id !== Number(id)));
    const result = before
      ? await client.query(
        `UPDATE settings_people SET name=$1, side=$2, spellings=$3::jsonb, updated_by=$4, updated_at=NOW() WHERE id=$5 RETURNING *`,
        [person.name, person.side, JSON.stringify(person.spellings), userEmail, before.id]
      )
      : await client.query(
        `INSERT INTO settings_people (name, side, spellings, updated_by) VALUES ($1, $2, $3::jsonb, $4) RETURNING *`,
        [person.name, person.side, JSON.stringify(person.spellings), userEmail]
      );
    const saved = personRow(result.rows[0]);
    await recordChange(client, {
      itemType: 'person', itemId: saved.id, action: before ? 'changed' : 'added',
      before: plainPerson(before), after: plainPerson(saved), userEmail
    });
    return saved;
  });
}

async function deletePerson({ id, userEmail = '' }) {
  await ensureSettingsSchema();
  return withTransaction(async (client) => {
    const result = await client.query('DELETE FROM settings_people WHERE id=$1 RETURNING *', [Number(id)]);
    if (!result.rows.length) throw notFound('person');
    const removed = personRow(result.rows[0]);
    await recordChange(client, { itemType: 'person', itemId: removed.id, action: 'deleted', before: plainPerson(removed), userEmail });
    return removed;
  });
}

async function saveTerm({ id = null, input, userEmail = '' }) {
  await ensureSettingsSchema();
  return withTransaction(async (client) => {
    await client.query('LOCK TABLE settings_terms IN SHARE ROW EXCLUSIVE MODE');
    const all = (await client.query('SELECT * FROM settings_terms')).rows.map(termRow);
    const before = id == null ? null : all.find((term) => term.id === Number(id));
    if (id != null && !before) throw notFound('term');
    const term = validateTerm(input, all.filter((item) => item.id !== Number(id)));
    const result = before
      ? await client.query(
        `UPDATE settings_terms SET term=$1, meaning=$2, heard_as=$3::jsonb, updated_by=$4, updated_at=NOW() WHERE id=$5 RETURNING *`,
        [term.term, term.meaning, JSON.stringify(term.heardAs), userEmail, before.id]
      )
      : await client.query(
        `INSERT INTO settings_terms (term, meaning, heard_as, updated_by) VALUES ($1, $2, $3::jsonb, $4) RETURNING *`,
        [term.term, term.meaning, JSON.stringify(term.heardAs), userEmail]
      );
    const saved = termRow(result.rows[0]);
    await recordChange(client, {
      itemType: 'term', itemId: saved.id, action: before ? 'changed' : 'added',
      before: plainTerm(before), after: plainTerm(saved), userEmail
    });
    return saved;
  });
}

async function deleteTerm({ id, userEmail = '' }) {
  await ensureSettingsSchema();
  return withTransaction(async (client) => {
    const result = await client.query('DELETE FROM settings_terms WHERE id=$1 RETURNING *', [Number(id)]);
    if (!result.rows.length) throw notFound('term');
    const removed = termRow(result.rows[0]);
    await recordChange(client, { itemType: 'term', itemId: removed.id, action: 'deleted', before: plainTerm(removed), userEmail });
    return removed;
  });
}

module.exports = {
  LIMITS,
  SettingsValidationError,
  validatePerson,
  validateTerm,
  isAvailable,
  ensureSettingsSchema,
  loadSettings,
  listChanges,
  savePerson,
  deletePerson,
  saveTerm,
  deleteTerm
};
