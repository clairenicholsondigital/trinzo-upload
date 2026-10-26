'use strict';

// The people and glossary lists the Settings page edits.
//
// The agent reads them synchronously through getPeople() and getTerms(). They
// start as the built-in defaults and are replaced by the database copy once it
// loads, then refreshed every so often and straight after every edit. If the
// database is missing or unreachable the last good copy (or the defaults) stays
// in use, so a database problem never stops minutes being produced.
//
// version() changes whenever the lists change, so callers can cache anything
// they build from them and rebuild only when it moves.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DEFAULT_PEOPLE, DEFAULT_TERMS } = require('./settingsDefaults');

const REFRESH_AFTER_MS = Number(process.env.SETTINGS_REFRESH_MS || 30000);

let state = { version: 0, source: 'defaults', people: DEFAULT_PEOPLE, terms: DEFAULT_TERMS };
let lastRefreshAt = 0;
let refreshing = null;

function getPeople() { return state.people; }
function getTerms() { return state.terms; }
function version() { return state.version; }
function source() { return state.source; }

function freeze(people, terms) {
  return {
    people: Object.freeze(people.map((person) => Object.freeze({
      id: person.id,
      name: person.name,
      side: person.side === 'client' ? 'client' : 'internal',
      spellings: Object.freeze([...(person.spellings || [])])
    }))),
    terms: Object.freeze(terms.map((term) => Object.freeze({
      id: term.id,
      term: term.term,
      meaning: term.meaning || '',
      heardAs: Object.freeze([...(term.heardAs || [])])
    })))
  };
}

// Used by tests, and by the store itself once the database answers.
function setSettings({ people, terms, source: from = 'test' } = {}) {
  const next = freeze(people || state.people, terms || state.terms);
  state = { version: state.version + 1, source: from, ...next };
  writePythonSnapshot();
  return state;
}

function resetToDefaults() {
  state = { version: state.version + 1, source: 'defaults', people: DEFAULT_PEOPLE, terms: DEFAULT_TERMS };
  if (process.env.TRINZO_SETTINGS_SNAPSHOT) delete process.env.TRINZO_SETTINGS_SNAPSHOT;
}

// The older Python minutes path reads its people and glossary from JSON files.
// When the lists come from the database, a copy is written for it and the path
// is passed to the scripts through the environment they inherit.
function writePythonSnapshot() {
  if (state.source !== 'database') return;
  try {
    const file = path.join(os.tmpdir(), `trinzo-settings-${process.pid}.json`);
    const temporary = `${file}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ people: state.people, terms: state.terms }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, file);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    process.env.TRINZO_SETTINGS_SNAPSHOT = file;
  } catch (error) {
    console.error('[settings] could not write the Python settings snapshot', error.message);
  }
}

async function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const settingsDb = require('./settingsDb');
      if (!settingsDb.isAvailable()) return state;
      const { people, terms } = await settingsDb.loadSettings();
      lastRefreshAt = Date.now();
      return setSettings({ people, terms, source: 'database' });
    } catch (error) {
      lastRefreshAt = Date.now();
      console.error('[settings] using the last known settings:', error.message);
      return state;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

async function refreshIfStale() {
  if (Date.now() - lastRefreshAt < REFRESH_AFTER_MS) return state;
  return refresh();
}

// Express middleware: keeps the lists fresh for every API request without ever
// failing the request.
function refreshMiddleware(req, res, next) {
  refreshIfStale().then(() => next(), () => next());
}

module.exports = {
  getPeople,
  getTerms,
  version,
  source,
  setSettings,
  resetToDefaults,
  refresh,
  refreshIfStale,
  refreshMiddleware
};
