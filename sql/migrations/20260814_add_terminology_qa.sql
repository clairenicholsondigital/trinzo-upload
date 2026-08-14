CREATE TABLE IF NOT EXISTS terminology_qa_decisions (
  id BIGSERIAL PRIMARY KEY,
  original_text TEXT NOT NULL,
  suggested_text TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('accepted', 'rejected')),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'client', 'project')),
  scope_key TEXT NOT NULL DEFAULT '',
  field_path TEXT NOT NULL DEFAULT '',
  draft_id TEXT NOT NULL DEFAULT '',
  user_id BIGINT REFERENCES auth_users(id) ON DELETE SET NULL,
  user_email TEXT NOT NULL DEFAULT '',
  context_hash TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_terminology_qa_scope
  ON terminology_qa_decisions (scope_type, scope_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_terminology_qa_pair
  ON terminology_qa_decisions (LOWER(original_text), LOWER(suggested_text), decision);
