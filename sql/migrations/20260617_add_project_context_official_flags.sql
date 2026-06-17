-- Add official/sticky markers for /project-update-test context housekeeping.
-- Official rows survive bulk cleanup; non-official rows can be archived/deactivated safely.

ALTER TABLE project_core_milestones
  ADD COLUMN IF NOT EXISTS is_official BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS official_label TEXT,
  ADD COLUMN IF NOT EXISTS official_at TIMESTAMPTZ;

ALTER TABLE project_core_risks
  ADD COLUMN IF NOT EXISTS is_official BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS official_label TEXT,
  ADD COLUMN IF NOT EXISTS official_at TIMESTAMPTZ;

ALTER TABLE project_context_snapshots
  ADD COLUMN IF NOT EXISTS is_official BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS official_label TEXT,
  ADD COLUMN IF NOT EXISTS official_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_project_core_milestones_project_official
  ON project_core_milestones(project_id, is_official, is_active, sort_order);
CREATE INDEX IF NOT EXISTS idx_project_core_risks_project_official
  ON project_core_risks(project_id, is_official, is_active);
CREATE INDEX IF NOT EXISTS idx_project_context_snapshots_project_official
  ON project_context_snapshots(project_id, is_official, created_at DESC);
