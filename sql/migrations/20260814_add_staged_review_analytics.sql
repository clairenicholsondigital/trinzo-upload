CREATE TABLE IF NOT EXISTS staged_meeting_minutes_review_events (
  id BIGSERIAL PRIMARY KEY,
  draft_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'in_review'
    CHECK (review_status IN ('in_review', 'final_review', 'completed')),
  meeting_title TEXT NOT NULL DEFAULT '',
  meeting_date DATE,
  meeting_location TEXT NOT NULL DEFAULT '',
  meeting_type TEXT NOT NULL DEFAULT '',
  project_key TEXT NOT NULL DEFAULT '',
  source_job_id TEXT NOT NULL DEFAULT '',
  transcript_sha256 TEXT NOT NULL DEFAULT '',
  active_screen INT NOT NULL DEFAULT 0,
  current_stage TEXT NOT NULL DEFAULT '',
  generated_versions JSONB NOT NULL DEFAULT '{}'::jsonb,
  approved_versions JSONB NOT NULL DEFAULT '{}'::jsonb,
  field_diffs JSONB NOT NULL DEFAULT '[]'::jsonb,
  edit_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  regeneration_events JSONB NOT NULL DEFAULT '[]'::jsonb,
  terminology_decisions JSONB NOT NULL DEFAULT '[]'::jsonb,
  unresolved_workstreams JSONB NOT NULL DEFAULT '[]'::jsonb,
  final_review_completed BOOLEAN NOT NULL DEFAULT FALSE,
  review_duration_ms INT NOT NULL DEFAULT 0,
  review_edit_count INT NOT NULL DEFAULT 0,
  user_id BIGINT REFERENCES auth_users(id) ON DELETE SET NULL,
  user_email TEXT NOT NULL DEFAULT '',
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (draft_id, event_key)
);

CREATE INDEX IF NOT EXISTS idx_staged_review_events_draft
  ON staged_meeting_minutes_review_events (draft_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_staged_review_events_status
  ON staged_meeting_minutes_review_events (review_status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_staged_review_events_project
  ON staged_meeting_minutes_review_events (project_key, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_staged_review_events_field_diffs
  ON staged_meeting_minutes_review_events USING GIN (field_diffs);
