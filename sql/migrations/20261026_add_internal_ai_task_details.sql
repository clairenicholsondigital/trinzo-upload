BEGIN;
-- Add public, human-written task context without changing existing records.
ALTER TABLE internal_ai_tasks
  ADD COLUMN IF NOT EXISTS current_implications TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS plan_to_fix TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS fix_details TEXT NOT NULL DEFAULT '';
COMMIT;
