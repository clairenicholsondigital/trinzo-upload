-- Add a 'replanned' project-update trend for items that were previously complete/settled
-- but are now active again without necessarily representing deterioration.

DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  SELECT conname INTO constraint_name
  FROM pg_constraint
  WHERE conrelid = 'project_context_snapshot_items'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%trend%'
    AND pg_get_constraintdef(oid) LIKE '%improving%'
  LIMIT 1;

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE project_context_snapshot_items DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;

ALTER TABLE project_context_snapshot_items
  ADD CONSTRAINT project_context_snapshot_items_trend_check
  CHECK (trend IN ('improving', 'stable', 'deteriorating', 'replanned', 'new_update', 'new_risk', 'resolved', 'unknown'));

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
  CHECK (trend IN ('improving', 'stable', 'deteriorating', 'replanned', 'new_update', 'new_risk', 'resolved', 'unknown'));

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
  CHECK (trend IN ('improving', 'stable', 'deteriorating', 'replanned', 'new_update', 'new_risk', 'resolved', 'unknown'));

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
  CHECK (trend IN ('improving', 'stable', 'deteriorating', 'replanned', 'new_update', 'new_risk', 'resolved', 'unknown'));
