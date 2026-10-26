-- Internal AI project only. Apply explicitly during an approved deployment.
BEGIN;
CREATE SEQUENCE IF NOT EXISTS internal_ai_task_number_seq START WITH 16;
CREATE TABLE IF NOT EXISTS internal_ai_tasks (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE CHECK (project_id = 19),
  task_key TEXT NOT NULL CHECK (task_key ~ '^AI-[0-9]{3,}$'),
  title TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 240),
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'To do' CHECK (status IN ('To do','In progress','Blocked','Done')),
  priority TEXT NOT NULL DEFAULT 'P2' CHECK (priority IN ('P0','P1','P2','P3')),
  category TEXT NOT NULL DEFAULT 'Technical' CHECK (category IN ('Technical','Usability','Validation','Decision','External dependency','Research')),
  owner TEXT NOT NULL DEFAULT '',
  due_date DATE,
  source_references JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(source_references) = 'array'),
  ai_implementation_guidance JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(ai_implementation_guidance) = 'object'),
  revision INTEGER NOT NULL DEFAULT 1,
  created_by BIGINT REFERENCES auth_users(id) ON DELETE SET NULL,
  created_by_name TEXT NOT NULL,
  updated_by BIGINT REFERENCES auth_users(id) ON DELETE SET NULL,
  updated_by_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  import_source TEXT,
  UNIQUE (project_id, task_key),
  CHECK ((status = 'Done') = (completed_at IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS internal_ai_task_comments (
  id BIGSERIAL PRIMARY KEY,
  task_id BIGINT NOT NULL REFERENCES internal_ai_tasks(id) ON DELETE CASCADE,
  author_id BIGINT REFERENCES auth_users(id) ON DELETE SET NULL,
  author_name TEXT NOT NULL,
  body TEXT NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 8000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS internal_ai_task_comments_task ON internal_ai_task_comments(task_id, created_at, id);
COMMIT;
