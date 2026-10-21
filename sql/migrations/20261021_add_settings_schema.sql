-- Settings page: people (internal vs client, other spellings), glossary terms
-- (meaning, wrong spellings to correct) and a change history.
-- The app also creates these on first use and seeds them once from
-- utils/settingsDefaults.js (see utils/settingsDb.js).

CREATE TABLE IF NOT EXISTS settings_people (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('internal', 'client')),
  spellings JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_settings_people_name ON settings_people (LOWER(name));

CREATE TABLE IF NOT EXISTS settings_terms (
  id BIGSERIAL PRIMARY KEY,
  term TEXT NOT NULL,
  meaning TEXT NOT NULL DEFAULT '',
  heard_as JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_settings_terms_term ON settings_terms (LOWER(term));

CREATE TABLE IF NOT EXISTS settings_changes (
  id BIGSERIAL PRIMARY KEY,
  item_type TEXT NOT NULL CHECK (item_type IN ('person', 'term')),
  item_id BIGINT,
  action TEXT NOT NULL CHECK (action IN ('added', 'changed', 'deleted')),
  before JSONB,
  after JSONB,
  user_email TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_settings_changes_created ON settings_changes (created_at DESC);

CREATE TABLE IF NOT EXISTS settings_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
