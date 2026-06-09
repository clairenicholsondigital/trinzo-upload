-- Adds safe, page-level feedback persistence for /meeting-minutes-final.
-- This intentionally stores only user-entered feedback and lightweight page context,
-- not transcripts or generated meeting content.

CREATE TABLE IF NOT EXISTS meeting_minutes_feedback (
  id BIGSERIAL PRIMARY KEY,
  route TEXT NOT NULL,
  feedback_type TEXT NOT NULL DEFAULT 'general',
  message TEXT NOT NULL,
  contact_name TEXT,
  contact_email TEXT,
  user_agent TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_meeting_minutes_feedback_created_at
  ON meeting_minutes_feedback (created_at DESC);
