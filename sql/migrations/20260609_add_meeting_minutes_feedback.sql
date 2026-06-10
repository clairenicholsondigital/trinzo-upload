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

ALTER TABLE meeting_minutes_feedback
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'submitted';

ALTER TABLE meeting_minutes_feedback
  ADD COLUMN IF NOT EXISTS claire_comments TEXT NOT NULL DEFAULT '';

ALTER TABLE meeting_minutes_feedback
  ADD COLUMN IF NOT EXISTS fix_details TEXT NOT NULL DEFAULT '';

ALTER TABLE meeting_minutes_feedback
  ADD COLUMN IF NOT EXISTS fixed_at TIMESTAMPTZ;

ALTER TABLE meeting_minutes_feedback
  ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_meeting_minutes_feedback_status
  ON meeting_minutes_feedback (status);
