BEGIN;
-- Optional public field; existing tasks and their statuses are preserved.
ALTER TABLE internal_ai_tasks
  ADD COLUMN IF NOT EXISTS next_action TEXT NOT NULL DEFAULT '';
COMMIT;
