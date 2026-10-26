BEGIN;
-- Private research text is deliberately not projected into ordinary task APIs.
ALTER TABLE internal_ai_tasks
  ADD COLUMN IF NOT EXISTS root_cause TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS affected_tool TEXT NOT NULL DEFAULT ''
    CHECK (affected_tool IN ('', 'Project updates', 'Meeting minutes', 'Shared'));
COMMIT;
