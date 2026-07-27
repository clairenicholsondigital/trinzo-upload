-- Phase 1: per-project knowledge store for /project-update-test.
-- MiniLM all-MiniLM-L6-v2 embeddings are 384-dimensional.
-- Trinzo production requires pgvector. Retrieval and embedding workers use
-- vector casts/operators directly; do not create a REAL[] fallback schema.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS project_knowledge_settings (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  embedding_backend TEXT NOT NULL DEFAULT 'minilm',
  vector_mode TEXT NOT NULL DEFAULT 'pgvector' CHECK (vector_mode = 'pgvector'),
  embedding_dimensions INT NOT NULL DEFAULT 384,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO project_knowledge_settings (id, vector_mode, embedding_dimensions)
VALUES (TRUE, 'pgvector', 384)
ON CONFLICT (id) DO UPDATE
SET vector_mode = 'pgvector',
    embedding_dimensions = 384,
    updated_at = NOW();

CREATE TABLE IF NOT EXISTS project_knowledge_items (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  item_type TEXT NOT NULL DEFAULT 'note'
    CHECK (item_type IN ('note','report_summary','key_update','milestone_summary','risk','evidence','decision','background_doc')),
  source_report_id BIGINT REFERENCES project_reports(id) ON DELETE SET NULL,
  source_report_version_id BIGINT REFERENCES project_report_versions(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  is_official BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_knowledge_items_version_unique
  ON project_knowledge_items (source_report_version_id, item_type, title)
  WHERE source_report_version_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_project_knowledge_items_project_created
  ON project_knowledge_items (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_project_knowledge_items_project_status_type
  ON project_knowledge_items (project_id, status, item_type);
CREATE INDEX IF NOT EXISTS idx_project_knowledge_items_source_version
  ON project_knowledge_items (source_report_version_id);

CREATE TABLE IF NOT EXISTS project_knowledge_chunks (
  id BIGSERIAL PRIMARY KEY,
  item_id BIGINT NOT NULL REFERENCES project_knowledge_items(id) ON DELETE CASCADE,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  chunk_index INT NOT NULL DEFAULT 0,
  chunk_text TEXT NOT NULL,
  embedding VECTOR(384),
  embedding_status TEXT NOT NULL DEFAULT 'queued'
    CHECK (embedding_status IN ('queued','processing','embedded','failed','skipped_empty')),
  embedding_attempts INT NOT NULL DEFAULT 0,
  embedding_error TEXT,
  embedding_enqueued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  embedding_processed_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (item_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_project_knowledge_chunks_project_item
  ON project_knowledge_chunks (project_id, item_id);
CREATE INDEX IF NOT EXISTS idx_project_knowledge_chunks_queue
  ON project_knowledge_chunks (embedding_status, embedding_enqueued_at);
CREATE INDEX IF NOT EXISTS idx_project_knowledge_chunks_project_created
  ON project_knowledge_chunks (project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_project_knowledge_chunks_embedding_ivfflat
  ON project_knowledge_chunks USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 50)
  WHERE embedding_status = 'embedded' AND embedding IS NOT NULL;
