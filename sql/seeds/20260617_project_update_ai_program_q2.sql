-- Seed the active /project-update-test baseline for AI Program – Q2.
-- This deliberately affects only the Project update test project context tables.

BEGIN;

WITH project_upsert AS (
  INSERT INTO projects (project_name, client_name, description, status, updated_at)
  VALUES (
    'Project update test',
    'Trinzo',
    'AI Program – Q2. Project Lead: Conor Flynn.',
    'active',
    NOW()
  )
  ON CONFLICT DO NOTHING
  RETURNING id
), project_row AS (
  SELECT id FROM project_upsert
  UNION ALL
  SELECT id FROM projects WHERE project_name = 'Project update test'
  ORDER BY id
  LIMIT 1
), project_update AS (
  UPDATE projects
  SET client_name = 'Trinzo',
      description = 'AI Program – Q2. Project Lead: Conor Flynn.',
      status = 'active',
      updated_at = NOW()
  WHERE id = (SELECT id FROM project_row)
  RETURNING id
), period_upsert AS (
  INSERT INTO project_reporting_periods (project_id, period_type, period_label, start_date, end_date)
  SELECT id, 'quarter', 'AI Program – Q2 2026', DATE '2026-04-01', DATE '2026-06-30'
  FROM project_row
  ON CONFLICT (project_id, period_type, period_label) DO UPDATE
    SET start_date = EXCLUDED.start_date,
        end_date = EXCLUDED.end_date
  RETURNING id, project_id
), period_row AS (
  SELECT id, project_id FROM period_upsert
  UNION ALL
  SELECT rp.id, rp.project_id
  FROM project_reporting_periods rp
  JOIN project_row p ON p.id = rp.project_id
  WHERE rp.period_type = 'quarter' AND rp.period_label = 'AI Program – Q2 2026'
  ORDER BY id
  LIMIT 1
), deactivate_milestones AS (
  UPDATE project_core_milestones
  SET is_active = FALSE
  WHERE project_id = (SELECT id FROM project_row)
  RETURNING id
), deactivate_risks AS (
  UPDATE project_core_risks
  SET is_active = FALSE
  WHERE project_id = (SELECT id FROM project_row)
  RETURNING id
), milestone_data(sort_order, category, milestone_name, baseline_finish_date, forecast_finish_date) AS (
  VALUES
    (1, 'Product Build', 'Repeatable AI Use Cases #1 & #2 Delivered', DATE '2026-06-30', DATE '2026-05-22'),
    (2, 'Product Build', 'Use Case Intake Funnel Implemented', DATE '2026-05-28', DATE '2026-05-15'),
    (3, 'Product Build', 'Pilot Review & Kill Decision Forum', DATE '2026-06-30', DATE '2026-06-25'),
    (4, 'Product Build', 'StageGate Internal Review Completed', DATE '2026-06-30', DATE '2026-05-28'),
    (5, 'Marketing & Product Market Fit', 'AI Pipeline Strategy Defined', DATE '2026-04-30', DATE '2026-04-24'),
    (6, 'Marketing & Product Market Fit', '3 Webinars Delivered (Apr–Jun)', DATE '2026-06-26', DATE '2026-06-26'),
    (7, 'Marketing & Product Market Fit', 'AI Commercial Impact Report', DATE '2026-06-29', DATE '2026-06-29'),
    (8, 'Marketing & Product Market Fit', 'Deliver on adhoc SOW''s', DATE '2026-06-30', DATE '2026-06-30'),
    (9, 'Building the Coalition', 'StageGate & Vendor Strategy Rolled Out', DATE '2026-05-15', DATE '2026-05-15'),
    (10, 'Finance & Governance', 'EI Grant Feedback Reviewed & Plan Set', DATE '2026-06-30', DATE '2026-06-30')
), inserted_milestones AS (
  INSERT INTO project_core_milestones (
    project_id,
    reporting_period_id,
    category,
    milestone_name,
    baseline_finish_date,
    forecast_finish_date,
    sort_order,
    is_active,
    is_official,
    official_label,
    official_at
  )
  SELECT
    p.id,
    pr.id,
    md.category,
    md.milestone_name,
    md.baseline_finish_date,
    md.forecast_finish_date,
    md.sort_order,
    TRUE,
    TRUE,
    'AI Program Q2 official baseline',
    NOW()
  FROM milestone_data md
  CROSS JOIN project_row p
  CROSS JOIN period_row pr
  RETURNING id
), risk_data(category, risk_title, description, mitigation) AS (
  VALUES
    (
      'Key Risks',
      'Delivery Capacity vs SOW Commitments Risk',
      'New SOWs may be signed without full visibility of current delivery bandwidth. Existing team members are already stretched across Product Build, Coalition, and Marketing. Overcommitment may result in missed deadlines, reduced quality, or reputational impact with clients.',
      'Introduce formal capacity sign-off before SOW approval; align sales forecasts with delivery planning; prioritise revenue and strategic accounts; define clear acceptance criteria before committing to new work.'
    ),
    (
      'Key Risks',
      'Key Personnel Attrition and Capability Loss Risk',
      'Recent departures have reduced internal expertise and delivery capacity. Limited backup capability for AI, technical, and digital initiatives increases execution risk and slows progress. Further attrition would significantly impact programme momentum.',
      'Conduct skills gap assessment; identify critical single points of failure; accelerate targeted hiring or contractor engagement; document processes and technical knowledge; introduce succession and cross-training plan; monitor workload and morale closely.'
    ),
    (
      'Key Risks',
      'Skill and Capability Gaps in AI & Data Delivery',
      'Internal AI and data expertise remains limited, affecting product quality and delivery timelines.',
      'Continue AI literacy training; leverage SMEs and contractors; partner with Insight Centre for specialist input.'
    )
), inserted_risks AS (
  INSERT INTO project_core_risks (project_id, category, risk_title, description, mitigation, is_active, is_official, official_label, official_at)
  SELECT p.id, rd.category, rd.risk_title, rd.description, rd.mitigation, TRUE, TRUE, 'AI Program Q2 official baseline', NOW()
  FROM risk_data rd
  CROSS JOIN project_row p
  RETURNING id
)
SELECT
  (SELECT COUNT(*) FROM inserted_milestones) AS active_milestones_seeded,
  (SELECT COUNT(*) FROM inserted_risks) AS active_risks_seeded;

COMMIT;
