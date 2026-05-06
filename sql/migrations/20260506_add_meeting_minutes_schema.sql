-- Adds a normalized meeting-minutes schema aligned to the structured JSON payload.

CREATE TABLE IF NOT EXISTS meetings (
  id BIGSERIAL PRIMARY KEY,
  meeting_title TEXT NOT NULL DEFAULT '',
  meeting_date DATE,
  meeting_location TEXT NOT NULL DEFAULT '',
  meeting_description TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'trinzo-upload',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS meeting_objectives (
  id BIGSERIAL PRIMARY KEY,
  meeting_id BIGINT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  objective_text TEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS meeting_participants (
  id BIGSERIAL PRIMARY KEY,
  meeting_id BIGINT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  participant_name TEXT NOT NULL,
  participant_group TEXT NOT NULL CHECK (participant_group IN ('client', 'trinzo')),
  sort_order INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS meeting_minutes_items (
  id BIGSERIAL PRIMARY KEY,
  meeting_id BIGINT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  topic TEXT NOT NULL DEFAULT '',
  discussion_points JSONB NOT NULL DEFAULT '[]'::jsonb,
  sort_order INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS meeting_next_steps (
  id BIGSERIAL PRIMARY KEY,
  meeting_id BIGINT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  action_text TEXT NOT NULL DEFAULT '',
  owner_name TEXT NOT NULL DEFAULT '',
  deadline DATE,
  sort_order INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS meeting_autosaves (
  id BIGSERIAL PRIMARY KEY,
  meeting_id BIGINT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  transcript_text TEXT NOT NULL DEFAULT '',
  transcript_length INT NOT NULL DEFAULT 0,
  saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_meetings_meeting_date ON meetings(meeting_date);
CREATE INDEX IF NOT EXISTS idx_autosaves_meeting_id_saved_at ON meeting_autosaves(meeting_id, saved_at DESC);
