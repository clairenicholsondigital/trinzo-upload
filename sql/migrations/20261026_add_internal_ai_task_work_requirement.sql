BEGIN;
-- A task's need for outside input is independent of its category and status.
-- Leave existing records unclassified until they have been reviewed.
ALTER TABLE internal_ai_tasks
  ADD COLUMN IF NOT EXISTS work_requirement TEXT NOT NULL DEFAULT 'Unclassified'
    CHECK (work_requirement IN ('Unclassified', 'Code only', 'Needs input'));
COMMIT;
