-- Adds project-update context snapshot support for /project-update-test trend/history work.
-- This is intentionally scoped to project reporting and does not touch meeting-minutes tables.

CREATE TABLE IF NOT EXISTS project_context_snapshots (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_report_version_id BIGINT REFERENCES project_report_versions(id) ON DELETE SET NULL,
  snapshot_type TEXT NOT NULL DEFAULT 'generated'
    CHECK (snapshot_type IN ('generated', 'manual', 'imported')),
  context_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  summary TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS project_context_snapshot_items (
  id BIGSERIAL PRIMARY KEY,
  snapshot_id BIGINT NOT NULL REFERENCES project_context_snapshots(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL
    CHECK (item_type IN ('health_area', 'milestone', 'risk', 'action', 'summary')),
  item_key TEXT NOT NULL,
  item_label TEXT,
  status TEXT,
  previous_status TEXT,
  trend TEXT NOT NULL DEFAULT 'unknown'
    CHECK (trend IN ('improving', 'stable', 'deteriorating', 'new_update', 'new_risk', 'resolved', 'unknown')),
  confidence NUMERIC(4,3) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Existing project report trend constraints were created before true history comparison.
-- Broaden them so future project-update analysis can persist new_update/resolved trends.
DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  SELECT conname INTO constraint_name
  FROM pg_constraint
  WHERE conrelid = 'project_report_health'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%trend%'
    AND pg_get_constraintdef(oid) LIKE '%improving%'
  LIMIT 1;

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE project_report_health DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;

ALTER TABLE project_report_health
  ADD CONSTRAINT project_report_health_trend_check
  CHECK (trend IN ('improving', 'stable', 'deteriorating', 'new_update', 'new_risk', 'resolved', 'unknown'));

DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  SELECT conname INTO constraint_name
  FROM pg_constraint
  WHERE conrelid = 'project_report_milestone_assessments'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%trend%'
    AND pg_get_constraintdef(oid) LIKE '%improving%'
  LIMIT 1;

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE project_report_milestone_assessments DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;

ALTER TABLE project_report_milestone_assessments
  ADD CONSTRAINT project_report_milestone_assessments_trend_check
  CHECK (trend IN ('improving', 'stable', 'deteriorating', 'new_update', 'new_risk', 'resolved', 'unknown'));

DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  SELECT conname INTO constraint_name
  FROM pg_constraint
  WHERE conrelid = 'project_report_risk_assessments'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%trend%'
    AND pg_get_constraintdef(oid) LIKE '%improving%'
  LIMIT 1;

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE project_report_risk_assessments DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;

ALTER TABLE project_report_risk_assessments
  ADD CONSTRAINT project_report_risk_assessments_trend_check
  CHECK (trend IN ('improving', 'stable', 'deteriorating', 'new_update', 'new_risk', 'resolved', 'unknown'));

CREATE INDEX IF NOT EXISTS idx_project_context_snapshots_project_created
  ON project_context_snapshots(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_project_context_snapshots_source_version
  ON project_context_snapshots(source_report_version_id);
CREATE INDEX IF NOT EXISTS idx_project_context_snapshot_items_snapshot_type
  ON project_context_snapshot_items(snapshot_id, item_type, item_key);
CREATE INDEX IF NOT EXISTS idx_project_context_snapshot_items_trend
  ON project_context_snapshot_items(trend);
