-- Adds a normalized project-reporting schema for /project-update-test outputs.
--
-- This schema keeps long-lived project baselines separate from weekly/monthly
-- report versions so approved reports can later feed trend and portfolio views.

CREATE TABLE IF NOT EXISTS projects (
  id BIGSERIAL PRIMARY KEY,
  project_name TEXT NOT NULL,
  client_name TEXT,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'completed', 'archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS project_reporting_periods (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  period_type TEXT NOT NULL
    CHECK (period_type IN ('week', 'month', 'quarter')),
  period_label TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (end_date >= start_date)
);

CREATE TABLE IF NOT EXISTS project_core_milestones (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  reporting_period_id BIGINT REFERENCES project_reporting_periods(id) ON DELETE SET NULL,
  category TEXT NOT NULL,
  milestone_name TEXT NOT NULL,
  baseline_finish_date DATE,
  forecast_finish_date DATE,
  sort_order INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS project_core_risks (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  category TEXT NOT NULL DEFAULT 'General',
  risk_title TEXT NOT NULL,
  description TEXT,
  mitigation TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS project_reports (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  reporting_period_id BIGINT REFERENCES project_reporting_periods(id) ON DELETE SET NULL,
  file_name TEXT,
  report_status TEXT NOT NULL DEFAULT 'draft'
    CHECK (report_status IN ('draft', 'in_review', 'approved', 'archived')),
  include_in_global_analysis BOOLEAN NOT NULL DEFAULT FALSE,
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  approved_version_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS project_report_versions (
  id BIGSERIAL PRIMARY KEY,
  report_id BIGINT NOT NULL REFERENCES project_reports(id) ON DELETE CASCADE,
  version_number INT NOT NULL,
  change_type TEXT NOT NULL
    CHECK (change_type IN ('ai_generated', 'user_edit', 'approved', 'revision')),
  change_summary TEXT,
  saved_by TEXT,
  report_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (report_id, version_number)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_project_reports_approved_version'
  ) THEN
    ALTER TABLE project_reports
      ADD CONSTRAINT fk_project_reports_approved_version
      FOREIGN KEY (approved_version_id)
      REFERENCES project_report_versions(id)
      ON DELETE SET NULL
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS project_report_sources (
  id BIGSERIAL PRIMARY KEY,
  report_id BIGINT NOT NULL REFERENCES project_reports(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL
    CHECK (source_type IN ('text', 'docx', 'txt', 'csv')),
  file_name TEXT,
  transcript_text TEXT,
  transcript_length INT,
  transcript_sha256 TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS project_report_health (
  id BIGSERIAL PRIMARY KEY,
  report_version_id BIGINT NOT NULL REFERENCES project_report_versions(id) ON DELETE CASCADE,
  area TEXT NOT NULL
    CHECK (area IN ('scope', 'schedule', 'financial', 'resources', 'other_issue_risk')),
  status TEXT NOT NULL
    CHECK (status IN ('on_track', 'at_risk', 'off_track', 'completed', 'unknown')),
  trend TEXT NOT NULL DEFAULT 'stable'
    CHECK (trend IN ('improving', 'stable', 'deteriorating', 'new_risk', 'unknown')),
  confidence NUMERIC(4,3) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  rationale TEXT
);

CREATE TABLE IF NOT EXISTS project_report_milestone_assessments (
  id BIGSERIAL PRIMARY KEY,
  report_version_id BIGINT NOT NULL REFERENCES project_report_versions(id) ON DELETE CASCADE,
  milestone_id BIGINT NOT NULL REFERENCES project_core_milestones(id) ON DELETE CASCADE,
  status TEXT NOT NULL
    CHECK (status IN ('completed', 'on_track', 'at_risk', 'delayed', 'blocked', 'not_started', 'unknown')),
  trend TEXT NOT NULL DEFAULT 'stable'
    CHECK (trend IN ('improving', 'stable', 'deteriorating', 'new_risk', 'unknown')),
  confidence NUMERIC(4,3) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  summary TEXT,
  forecast_finish_date DATE
);

CREATE TABLE IF NOT EXISTS project_report_risk_assessments (
  id BIGSERIAL PRIMARY KEY,
  report_version_id BIGINT NOT NULL REFERENCES project_report_versions(id) ON DELETE CASCADE,
  risk_id BIGINT NOT NULL REFERENCES project_core_risks(id) ON DELETE CASCADE,
  status TEXT NOT NULL
    CHECK (status IN ('not_observed', 'active', 'increasing', 'reducing', 'resolved', 'unknown')),
  trend TEXT NOT NULL DEFAULT 'stable'
    CHECK (trend IN ('improving', 'stable', 'deteriorating', 'new_risk', 'unknown')),
  confidence NUMERIC(4,3) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  summary TEXT
);

CREATE TABLE IF NOT EXISTS project_ai_risk_suggestions (
  id BIGSERIAL PRIMARY KEY,
  report_version_id BIGINT NOT NULL REFERENCES project_report_versions(id) ON DELETE CASCADE,
  risk_title TEXT NOT NULL,
  description TEXT,
  suggested_mitigation TEXT,
  confidence NUMERIC(4,3) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  review_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (review_status IN ('pending', 'accepted', 'dismissed')),
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS project_report_evidence (
  id BIGSERIAL PRIMARY KEY,
  report_version_id BIGINT NOT NULL REFERENCES project_report_versions(id) ON DELETE CASCADE,
  linked_type TEXT NOT NULL
    CHECK (linked_type IN ('health', 'milestone', 'core_risk', 'ai_risk', 'summary', 'key_update')),
  linked_id BIGINT,
  evidence_text TEXT NOT NULL,
  speaker TEXT,
  turn_index INT,
  confidence NUMERIC(4,3) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_project_reporting_periods_project_dates ON project_reporting_periods(project_id, start_date, end_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_reporting_periods_unique_label ON project_reporting_periods(project_id, period_type, period_label);
CREATE INDEX IF NOT EXISTS idx_project_core_milestones_project_active ON project_core_milestones(project_id, is_active, sort_order);
CREATE INDEX IF NOT EXISTS idx_project_core_risks_project_active ON project_core_risks(project_id, is_active);
CREATE INDEX IF NOT EXISTS idx_project_reports_project_period ON project_reports(project_id, reporting_period_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_project_reports_status ON project_reports(report_status);
CREATE INDEX IF NOT EXISTS idx_project_report_versions_report_created ON project_report_versions(report_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_project_report_sources_report ON project_report_sources(report_id);
CREATE INDEX IF NOT EXISTS idx_project_report_health_version_area ON project_report_health(report_version_id, area);
CREATE INDEX IF NOT EXISTS idx_project_report_milestone_assessments_version ON project_report_milestone_assessments(report_version_id);
CREATE INDEX IF NOT EXISTS idx_project_report_milestone_assessments_milestone ON project_report_milestone_assessments(milestone_id);
CREATE INDEX IF NOT EXISTS idx_project_report_risk_assessments_version ON project_report_risk_assessments(report_version_id);
CREATE INDEX IF NOT EXISTS idx_project_report_risk_assessments_risk ON project_report_risk_assessments(risk_id);
CREATE INDEX IF NOT EXISTS idx_project_ai_risk_suggestions_version_status ON project_ai_risk_suggestions(report_version_id, review_status);
CREATE INDEX IF NOT EXISTS idx_project_report_evidence_version_type ON project_report_evidence(report_version_id, linked_type);
