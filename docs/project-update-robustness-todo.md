# /project-update-test — Stored Context & RAG Robustness To-Do List

**Goal:** make https://trinzo.virtual-hub.online/project-update-test robust around stored
context, retrieval, and report generation by (a) hardening what already exists and
(b) adding a per-project semantic knowledge layer modelled on helixscribe-api's
app-knowledge buckets.

**Scope rule:** ALL changes land in `trinzo-upload`. `helixscribe-api` is a
**read-only reference** — we copy its *patterns* (schema shape, embedding queue,
retrieval fallbacks), never its code paths, and we never modify, redeploy, or
share infrastructure with it. Nothing in this plan touches the helixscribe
database, Ollama instance, or API.

**Design principle:** the structured context (milestones / risks / health with
latest-vs-previous lineage) stays the source of truth for trend comparison.
RAG is a *supplementary* layer for unstructured memory (past report narratives,
evidence, decisions, background docs) and for fuzzy matching. Retrieval failures
must never fail an upload — every new step degrades gracefully, following the
fallback discipline already present in `routes/api.js` (context-load error →
still run; primary script error → legacy fallback; save error → reported in payload).

---

## Phase 0 — Harden what exists (no new architecture)

Highest value-per-effort. Everything here is independent of the RAG work and
worth doing even if the knowledge-bucket plan changes.

### 0.1 Replace the `psql` shell-out with a real Postgres client
- **Where:** `utils/db.js` (`runPsql`, `q`, `qJson`, `qDate`, `parseJsonLines`, `parseOptionalId`).
- **Problem:** every query spawns a `psql` process with string-interpolated SQL.
  Manual `''` escaping via `q()`, output parsed as "lines starting with `{`",
  `-F '|'` field separator. A milestone name containing an unexpected character,
  a NOTICE line, or multi-line JSON output silently drops or corrupts rows.
  No connection pooling; one OS process per query; ~15+ queries per context build.
- **Task:** introduce the `pg` npm package with a shared `Pool`. Rewrite the
  internals of `utils/db.js` to use parameterized queries (`$1, $2 …`) while
  **keeping every exported function signature identical** so `routes/api.js`
  needs no changes. `json_build_object(...)::text` selects can become plain
  column selects or `row_to_json`, letting `pg` return real objects instead of
  parsing text lines.
- **Approach:** do this incrementally — add a `query(sql, params)` helper next to
  `runPsql`, migrate function-by-function (start with the read paths used by
  `getProjectContext`), delete `runPsql`/`q`/`qJson` last. Keep
  `hasDatabaseConfig()` / `getDatabaseConfigError()` behaviour exactly as-is
  (routes rely on the 503 pattern).
- **Config:** honour the existing `DATABASE_URL` or `PG*` env vars; add
  `PGPOOL_MAX` (default 5) and a connect timeout so a dead DB fails fast
  instead of hanging uploads.
- **Acceptance:** all existing endpoints return byte-identical JSON shapes;
  a milestone named `O'Brien's "phase|1" review` round-trips correctly;
  `npm test` / Python contract tests (0.4) pass.

### 0.2 Add authentication to destructive / admin project-update endpoints
- **Where:** `routes/api.js`. Note `requireAuth` already exists
  (`routes/auth.js:75`) and is used only on the meeting-minutes feedback routes
  (`routes/api.js:751-812`).
- **Problem:** all `/api/project-update-test/*` endpoints are unauthenticated,
  including destructive ones: `POST reports/bulk-delete`, `DELETE reports/:id`,
  `PATCH reports/:id`, `POST milestones/bulk-inactivate`,
  `DELETE milestones/:id`, `PATCH milestones/:id`,
  `POST context/mark-official`, `POST context/cleanup-tests`. Anyone with the
  URL can wipe stored context.
- **Task:** add `requireAuth` to every mutating project-update endpoint
  (POST/PATCH/DELETE). Decide explicitly whether the *upload* endpoint
  (`POST /project-update-test`) and read endpoints stay open for testing — if
  they stay open, say so in a comment and README. Update the frontend pages
  (`views/project-update-reports.html`, `project-update-milestones.html`,
  `project-update-context.html`) to send the session credential the same way
  the feedback admin page does, and to show a login prompt on 401.
- **Acceptance:** unauthenticated `POST /api/project-update-test/reports/bulk-delete`
  returns 401; the admin pages still function after login; upload flow unaffected.

### 0.3 Deterministic project resolution
- **Where:** `utils/db.js` (`getProjectIdForContext`, and the project lookup
  inside `saveProjectUpdateDraft`), `routes/api.js` (`POST /project-update-test`).
- **Problem:** the project is chosen by name via a heuristic ("the project with
  this name that has the most active milestones/risks/reports"). Two projects
  with the same name → context silently reads/writes the wrong one. Name comes
  from body/query/`PROJECT_UPDATE_DEFAULT_PROJECT` with a hardcoded final
  fallback.
- **Tasks:**
  - Accept an optional `projectId` in `POST /project-update-test` (body/query)
    and in the context/milestone/report list endpoints; when present, it wins
    and the name heuristic is bypassed.
  - When resolving by name, if more than one `projects` row matches, include a
    `projectResolution` block in the response diagnostics
    (`{ matchedBy: 'name'|'id', candidates: n, projectId }`) so ambiguity is visible.
  - Add a `GET /api/project-update-test/projects` listing endpoint (id, name,
    counts, updatedAt) so the UI can offer an explicit project picker.
  - Frontend: add the project picker to `views/project-update-test.html` and
    persist the selection (localStorage), sending `projectId` on upload.
- **Acceptance:** with two projects named identically, an upload with explicit
  `projectId` saves to and reads context from that project only.

### 0.4 Contract tests for the context payload (Node → Python boundary)
- **Where:** new `tests/test_project_context_contract.py` (Python side) and a
  new Node test (e.g. `tests/context-contract.test.js` run via `npm test`).
- **Problem:** `getProjectContext()` output is written to a temp JSON file and
  consumed by `project_update_minilm.py` (`load_project_context`,
  `annotate_report_with_project_context`, `build_context_first_milestones`).
  There is no shared schema; a rename on either side breaks trends silently
  (the pipeline treats missing keys as "no context" and carries on).
- **Tasks:**
  - Author a single fixture file `tests/fixtures/project_context_contract.json`
    that captures the canonical context shape: `projectName`, `found`,
    `activeMilestones[]` (with `comparisonKey`, `latestAssessment`,
    `previousAssessment`), `activeRisks[]`, `recentReports[]`, `healthHistory[]`,
    `milestoneHistory[]`, `riskSuggestions[]`, `latestSnapshot`, `generatedAt`.
  - Python test: feed the fixture through `annotate_report_with_project_context`
    and `build_context_first_milestones`; assert milestones are compared
    (`diagnostics.milestonesCompared > 0`), trends inferred, carried-forward
    rows produced for milestones absent from the transcript.
  - Node test: run `getProjectContext` against a seeded test DB (or mock the
    query layer once 0.1 lands) and validate the output against the same
    fixture's key set — any key rename fails the build on *both* sides.
- **Acceptance:** deleting `comparisonKey` from the Node output fails the Node
  test; renaming it in the Python reader fails the Python test.

### 0.5 Small robustness fixes (batch these together)
- `routes/api.js:836-840`: in the context-error path, `--context-file` is pushed
  before the temp dir exists; if `fs.mkdtemp` throws, the arg list is left with a
  dangling `--context-file`. Restructure so the flag and path are pushed together
  after the file is written.
- Add a `limit`/size guard on `transcriptText` persisted to
  `project_report_sources` (already has `transcript_sha256` — use it to skip
  duplicate re-saves of an identical transcript for the same project+period).
- `project_context_snapshot_items.item_key` collisions: `projectContextItemKey`
  falls back to `item`; two unnamed risks collide. Suffix with the source id
  (`risk_<id>`) consistently (partially done — audit all call sites in
  `utils/db.js:830-895`).
- Timeouts: `PROJECT_UPDATE_TIMEOUT_MS` exists for the primary script; give the
  legacy fallback (`python_llm.py`) its own explicit timeout too, so a hung
  fallback can't hold the request open indefinitely.
- Log a single structured line per upload (project id, context found?, script
  used, fallback?, save ok?, duration) to make production incidents diagnosable
  from `agent.log`.

---

## Phase 1 — Per-project knowledge store (the "bucket" layer)

Port the helixscribe pattern (`app_knowledge_db.py`, `app_knowledge_embeddings.py`,
`app_knowledge_embedding_queue.py` — reference only) into trinzo's own schema and
runtime. Everything is namespaced per project instead of per user/app-key.

### 1.1 Schema migration
- **Where:** new `sql/migrations/2026XXXX_add_project_knowledge_schema.sql`,
  run via the existing `node scripts/run_sql_migration.js` runner.
- **Tables** (mirroring helixscribe's bucket→item→chunk shape, minus the
  bucket table — the project *is* the bucket):
  - `project_knowledge_items`: `id BIGSERIAL PK`, `project_id → projects ON DELETE CASCADE`,
    `title TEXT`, `content TEXT`, `summary TEXT DEFAULT ''`,
    `item_type TEXT DEFAULT 'note'` with CHECK
    (`'note','report_summary','key_update','milestone_summary','risk','evidence','decision','background_doc'`),
    `source_report_id BIGINT REFERENCES project_reports ON DELETE SET NULL`,
    `source_report_version_id BIGINT REFERENCES project_report_versions ON DELETE SET NULL`,
    `status TEXT DEFAULT 'active'` CHECK (`'active','archived'`),
    `is_official BOOLEAN DEFAULT FALSE` (reuse the official/sticky convention from
    `20260617_add_project_context_official_flags.sql` so cleanup-tests spares it),
    `metadata JSONB DEFAULT '{}'`, `created_at/updated_at TIMESTAMPTZ`.
  - `project_knowledge_chunks`: `id BIGSERIAL PK`, `item_id → items ON DELETE CASCADE`,
    `project_id` (denormalised for fast filtering), `chunk_index INT`,
    `chunk_text TEXT NOT NULL`, `embedding` (see 1.2), `embedding_status TEXT
    DEFAULT 'queued'` CHECK (`'queued','processing','embedded','failed','skipped_empty'`),
    `embedding_attempts INT DEFAULT 0`, `embedding_error TEXT`,
    `embedding_enqueued_at TIMESTAMPTZ DEFAULT now()`,
    `embedding_processed_at TIMESTAMPTZ`, `metadata JSONB`, timestamps.
  - Indexes: `(project_id, item_id)`, `(embedding_status, embedding_enqueued_at)`,
    `(project_id, created_at DESC)`, plus the vector index if pgvector is used.
- **pgvector decision (must resolve first — see Open Questions):** the migration
  should attempt `CREATE EXTENSION IF NOT EXISTS vector` inside a guarded
  `DO $$ ... EXCEPTION WHEN insufficient_privilege / undefined_file THEN ... $$`
  block. If unavailable, fall back to `embedding REAL[]` and rank in Python
  (fine at per-project scale of hundreds–low-thousands of chunks). Record which
  mode is active in a `project_knowledge_settings` one-row table or derive at
  runtime from `pg_extension`. MiniLM `all-MiniLM-L6-v2` is 384-dim — use
  `VECTOR(384)` (helixscribe uses 768 for nomic-embed; do NOT copy that number).

### 1.2 Embedding runtime (MiniLM, local — no Ollama)
- **Where:** new `scripts/project_knowledge_embed_worker.py` plus a small shared
  module (e.g. `scripts/project_knowledge_embeddings.py`).
- **Why MiniLM:** sentence-transformers is already a production dependency
  (`requirements-experimental-minilm.txt`, used by `project_update_minilm.py`),
  so no new infrastructure. Do not introduce an Ollama dependency (that's
  helixscribe's stack, not trinzo's).
- **Tasks:**
  - Chunker: port the sliding-window approach (chunk_size ~1200 chars,
    overlap ~150) as a pure function with unit tests, but prefer
    sentence/paragraph boundaries when within tolerance (report summaries are
    short; most items will be 1–3 chunks).
  - Queue worker: mirror helixscribe's `process_app_knowledge_embedding_queue`
    semantics exactly — `SELECT ... WHERE embedding_status IN ('queued','failed')
    AND embedding_attempts < MAX ORDER BY embedding_enqueued_at FOR UPDATE SKIP
    LOCKED LIMIT batch`, mark `processing`, embed, mark
    `embedded/failed/skipped_empty`, cap attempts (default 3), never throw out
    of the batch. Batch size and max attempts via env
    (`PROJECT_KNOWLEDGE_EMBED_BATCH_SIZE`, `..._MAX_ATTEMPTS`).
  - Invocation: two triggers — (a) fire-and-forget spawn after ingestion
    (Node `spawn`s the worker the same way `runPythonTranscriptScript` runs
    pipeline scripts, but detached and non-blocking), and (b) a safety-net
    interval (either a `setInterval` in `server.js` guarded by
    `PROJECT_KNOWLEDGE_EMBED_INTERVAL_MS`, or an external cron — document
    whichever is chosen in the README). Writes must never wait on embedding.
  - Model loading: reuse the exact model-cache pattern from
    `project_update_minilm.py` / `minutes_minilm_worker.py` so cold starts and
    offline environments behave the same way (skip gracefully, leave chunks
    `queued`).
- **Acceptance:** inserting an item leaves chunks `queued`; running the worker
  transitions them to `embedded`; killing the embedder mid-batch leaves
  recoverable `processing/failed` rows that a rerun picks up; an environment
  without the model installed leaves everything `queued` and logs once.

### 1.3 Automatic ingestion from reports
- **Where:** `utils/db.js` — hook into `saveProjectUpdateDraft` (line ~1316) and
  into the approval path in `saveProjectReportDetail`.
- **Policy:** ingest on **approval** (report_status → `approved`), not on every
  draft — drafts are noisy and cleanup-tests archives them. Optionally also
  ingest drafts behind a flag (`PROJECT_KNOWLEDGE_INGEST_DRAFTS=false` default).
- **What gets ingested per approved version** (each as its own item, with
  `source_report_id`/`source_report_version_id` and `metadata` carrying
  `periodLabel`, `overallHealth`, `event_date` = period end or created_at):
  - `report_summary`: the `projectReport.summary` text.
  - `key_update`: one item per key update entry.
  - `milestone_summary`: one item per milestone row that has a real transcript
    update (`transcript_update_status = 'updated_from_transcript'`), title =
    milestone name, content = status + summary + next steps.
  - `risk`: one item per accepted/suggested risk (title, description, mitigation).
  - `evidence`: the strongest evidence quotes (respect a cap, e.g. top 10 by
    confidence) with speaker/turn metadata.
- **Idempotency:** ingesting the same report version twice must not duplicate —
  key on `(source_report_version_id, item_type, title)`; re-approval replaces
  (archive old items for that version, insert fresh).
- **Failure handling:** ingestion errors are caught and reported in the API
  response payload (`knowledgeIngestion: { ok, itemsCreated, error }`) exactly
  like `projectReportPersistence` — never fail the approval.
- **Acceptance:** approving a report creates items + queued chunks; approving it
  again does not duplicate; DB down at ingestion time still approves the report.

### 1.4 Manual ingestion — background/standing knowledge ("the SoW bucket")
- **Where:** new endpoints in `routes/api.js` + UI on
  `views/project-update-context.html`.
- **Endpoints** (all `requireAuth`, all per-project):
  - `POST /api/project-update-test/knowledge/items` — body: `projectId`/`projectName`,
    `title`, `content` (pasted text; support the existing `/extract-docx` flow
    for .docx → text first), `itemType` (default `background_doc`),
    `isOfficial` (default true for manual items so cleanup spares them), `metadata`.
    Validates size (e.g. 200KB max content), chunks, inserts, enqueues embeddings,
    spawns the worker.
  - `GET /api/project-update-test/knowledge/items?projectId=&itemType=&status=` — list
    with chunk/embedding-status counts (port helixscribe's `_embedding_counters`
    summary idea: `{queued, processing, embedded, failed}` per item).
  - `PATCH /api/project-update-test/knowledge/items/:itemId` — edit
    title/content/status; content edits re-chunk (delete + re-insert chunks,
    re-queue).
  - `DELETE /api/project-update-test/knowledge/items/:itemId` — archive by
    default (`status='archived'`), hard delete only with `?hard=1`.
  - `POST /api/project-update-test/knowledge/embeddings/process` — manual queue
    kick for ops (mirrors helixscribe's `/embeddings/process`).
- **UI (`project-update-context.html`):** a "Project knowledge" section — paste
  box / docx upload, item list with type + embedding status pills, archive
  button. Keep visual language consistent with the existing context page.
- **Cleanup integration:** extend `cleanupProjectUpdateTestContext` in
  `utils/db.js` to archive non-official knowledge items (never official ones),
  keeping the mark-official / cleanup-tests workflow coherent.
- **Acceptance:** paste a fake SoW, see it chunked + embedded, run
  cleanup-tests → official SoW survives, test junk is archived.

### 1.5 Retrieval helper with layered fallback
- **Where:** new `scripts/project_knowledge_retrieval.py` (used by the pipeline,
  1.2's worker sibling) and a Node wrapper `utils/knowledge.js` (used by the ask
  endpoint in Phase 3).
- **Behaviour** (port helixscribe's `retrieve_relevant_app_chunks` +
  `_keyword_chunk_search` semantics):
  1. **Semantic:** embed the query with MiniLM; cosine over embedded chunks for
     the project (pgvector `<=>` if available, otherwise fetch `embedded` chunk
     vectors for the project and rank in Python).
  2. **Keyword fallback:** if the model is unavailable, embedding fails, or zero
     semantic hits — tokenize the query (drop stopwords, keep terms ≥3 chars),
     `ILIKE`-match against `chunk_text`/`title`, rank by hit count and recency.
  3. **Empty:** return `retrieval_mode: 'none'` with an empty list — callers
     always know what happened.
- Filters: `item_types`, `date_from/date_to` (against `metadata.event_date`),
  `status='active'`, `top_k` (default 8, cap 25). Always return
  `retrieval_mode` (`semantic | keyword_fallback | none`) in the payload — this
  is the single most useful diagnostic in helixscribe and must be preserved.
- **Acceptance:** with embeddings present → semantic; with embeddings stripped →
  keyword_fallback; with no items → none. All three paths unit-tested.

---

## Phase 2 — Use the knowledge layer inside the report pipeline

### 2.1 `retrievedKnowledge` in the context file
- **Where:** `routes/api.js` (`POST /project-update-test` context-building block,
  ~lines 826-842) and `scripts/project_update_minilm.py`.
- **Tasks:**
  - After `getProjectContext(...)` succeeds, call the retrieval helper with a
    query derived from the transcript (first ~2000 chars + any detected
    milestone names) and `top_k` ~8, filtered to
    `item_types = ['background_doc','decision','report_summary','risk']`.
    Merge into the temp context JSON as
    `context.retrievedKnowledge = { retrievalMode, chunks: [...] }`.
    Wrap in try/catch: on any error write
    `retrievedKnowledge: { retrievalMode: 'error', error: msg }` and continue —
    identical philosophy to the existing `_contextLoadError` path.
  - In `project_update_minilm.py`: extend `load_project_context` to accept the
    new key; surface retrieved chunks to (a) the risk-suggestion stage (known
    standing risks from background docs shouldn't be re-suggested as "new"),
    (b) the report annotation stage as a `knowledgeUsed` diagnostics block
    (`chunks considered / cited`), and (c) the optional rewrite pass as
    grounding context, clearly separated from transcript evidence so the
    abstention rules stay intact (never let retrieved text be presented as
    transcript evidence).
  - `skipContext` / a new `skipKnowledge` flag must bypass retrieval entirely.
- **Acceptance:** upload with a project that has an ingested SoW → response
  diagnostics show `retrievedKnowledge.retrievalMode: 'semantic'` and the
  report references standing constraints; DB/model down → report generates
  exactly as today with `retrievalMode: 'error' | 'none'`.

### 2.2 Embedding-based milestone & risk matching (with existing matcher as fallback)
- **Where:** `scripts/project_update_minilm.py` —
  `milestone_match_score` / `build_context_first_milestones` (~lines 741-1077)
  and the risk matching in `annotate_report_with_project_context` (~lines 918-939).
- **Problem:** matching is normalized-name equality then token-overlap ≥ 0.6;
  risks match on exact normalized title only. Renames sever trend lineage.
- **Tasks:**
  - When the MiniLM backend is loaded (it already is, for evidence extraction),
    embed stored milestone `name + description` and transcript segment
    `milestone + summary`; match by cosine with a conservative threshold
    (start ~0.55–0.6, tune against fixtures), resolving via greedy or Hungarian
    assignment so two segments can't claim one milestone.
  - Keep the token-overlap matcher as the fallback when embeddings are
    unavailable (`--skip-minilm` path) and as a tie-breaker; require agreement
    OR high semantic confidence before accepting a non-exact match. Below
    threshold → abstain (current behaviour), never force a match.
  - Record match provenance per milestone in diagnostics:
    `{ matchedBy: 'exact_key' | 'semantic' | 'token_overlap' | 'none', score }`.
  - Same treatment for risk titles against `activeRisks` + prior
    `riskSuggestions` so a reworded risk maps to its core risk instead of
    spawning `new_risk`.
- **Tests:** extend `tests/test_project_update_minilm.py` with rename cases
  ("Data migration phase 1" ↔ "Phase 1 data cutover" matches; genuinely new
  milestone does NOT match anything; FakeBackend pattern already exists in the
  suite — reuse it for deterministic vectors).
- **Acceptance:** golden/eval pack (2.3) shows no lineage breaks on the rename
  fixtures and no false merges on the distinct-milestone fixtures.

### 2.3 Evaluation pack for the project-update flow
- **Where:** new `scripts/project-update-golden/` + runner
  `scripts/run_project_update_golden_eval.py`, modelled on the existing
  `scripts/meeting-minutes-final-golden/` +
  `run_meeting_minutes_final_golden_eval.py` (same dry-run / local / live-API
  modes, same tagged-case structure).
- **Cases to include (10–15):** first report ever (no context); second report
  with clean milestone-name matches; renamed milestones; a completed milestone
  reopened (replanned trend); risk reworded; transcript mentioning nothing about
  two active milestones (carried-forward rows must appear); background-doc
  retrieval case; context DB unavailable; empty/garbage transcript (abstention);
  duplicate transcript re-upload (dedupe via sha256).
- **Checks:** trend values per milestone, carried-forward presence,
  `retrievalMode`, no transcript-evidence leakage from retrieved knowledge,
  British English, response-time budget.
- **Acceptance:** runner passes in dry-run mode in CI-less environments and
  against the deployed API with `--base-url https://trinzo.virtual-hub.online`.

---

## Phase 3 — Ask / insights over project memory (optional, after 1+2 are stable)

### 3.1 `POST /api/project-update-test/knowledge/ask`
- Port the shape of helixscribe's `/buckets/{slug}/ask`: retrieve top-k
  (semantic → keyword → none), and return
  `{ answerMode: 'generated' | 'retrieval_only' | 'no_context', retrievalMode,
  retrievedChunks, answer? }`.
- **Generation backend:** Google AI Studio / Gemini via the existing
  `GOOGLE_AI_STUDIO_API_KEY` + `scripts/google_ai_studio_minutes.py` pattern
  (NOT Ollama — again, that's helixscribe's infra). If the key is missing or the
  call fails, return `retrieval_only` with the chunks — the endpoint still works
  with zero LLM availability, exactly like helixscribe's exception path.
- Grounding prompt: require citations of chunk ids; instruct "answer only from
  provided project memory; say when memory is insufficient" (port
  `build_app_knowledge_rag_prompt`'s structure).

### 3.2 UI
- Add an "Ask this project" box to `views/project-update-reports.html` or the
  context page: question in, answer + cited snippets (with report/period labels
  from chunk metadata) out. Show `answerMode`/`retrievalMode` as a small status
  pill so degraded modes are visible during testing.

### 3.3 Trend insights (stretch)
- Optional port of helixscribe's insights idea: a periodic "programme insights"
  summary generated from the last N `report_summary` items, saved back as an
  `item_type='decision'`-style memory item (with `save_to_memory` semantics and
  tags excluding generated content from future retrieval by default — copy the
  `exclude generated_content` default from helixscribe's `bucket_insights`).

---

## Phase 4 — Operations, monitoring, lifecycle

- **Embedding queue health endpoint:** `GET /api/project-update-test/knowledge/status`
  (auth'd) returning per-project counts by `embedding_status`, oldest queued age,
  last worker run. Surfaces "embedder has been dead for 3 days" before users
  notice retrieval quality drop.
- **Backfill script:** one-off `scripts/backfill_project_knowledge.js` (or .py)
  that walks existing approved `project_report_versions` and runs the 1.3
  ingestion for history — idempotent, dry-run flag, per-project filter.
- **Retention/compaction:** knowledge grows monotonically. Add to cleanup-tests:
  archive `report_summary`/`key_update`/`evidence` items older than N approved
  reports back (configurable, default keep-all), never touching
  `background_doc`/official items.
- **README updates:** document the new env vars
  (`PROJECT_KNOWLEDGE_EMBED_BATCH_SIZE`, `..._MAX_ATTEMPTS`,
  `..._EMBED_INTERVAL_MS`, `PROJECT_KNOWLEDGE_INGEST_DRAFTS`, `PGPOOL_MAX`),
  the migration order, pgvector requirement/fallback, and the worker invocation.
- **Deploy checklist:** run migration → deploy app → run backfill → verify
  `/knowledge/status` → run golden eval with `--base-url` against production.

---

## Explicit non-goals / guardrails

- **No changes to helixscribe-api** — no code, schema, config, or deploy changes;
  no shared DB or Ollama usage. If a helper there looks reusable, re-implement it
  in trinzo-upload.
- No cross-project or cross-user retrieval: every knowledge query is scoped by
  `project_id` (mirror helixscribe's strict `user_id + app_key + bucket_id`
  scoping — this was a deliberate isolation property, keep it).
- Retrieved knowledge is never presented as transcript evidence; abstention
  rules from the README ("prefer sparse or empty output when semantic evidence
  is weak") take precedence over anything retrieval suggests.
- The upload endpoint's latency budget stands: retrieval adds one embed + one
  query (~hundreds of ms); embedding ingestion is always async.

## Open questions to resolve before Phase 1

1. **Does the deployed Postgres allow `CREATE EXTENSION vector`?** Check with
   `SELECT * FROM pg_available_extensions WHERE name='vector';` on the
   production DB. If yes → `VECTOR(384)` + ivfflat index; if no → `REAL[]`
   storage + Python-side ranking (the schema in 1.1 supports both).
2. **Should the upload + read endpoints require auth too**, or stay open while
   this page is in test? (0.2 currently proposes auth on mutations only.)
3. **Ingest drafts or approved-only?** Plan assumes approved-only (cleaner
   memory); flip `PROJECT_KNOWLEDGE_INGEST_DRAFTS` if drafts should count.
4. **Worker scheduling:** in-process `setInterval` in `server.js` (simplest,
   dies with the app) vs. external cron on the host (survives, needs host
   access). Pick one and document it.

## Suggested execution order

| Step | Items | Depends on |
|------|-------|------------|
| 1 | 0.1 DB client, 0.2 auth, 0.5 small fixes | — |
| 2 | 0.3 project resolution, 0.4 contract tests | 0.1 |
| 3 | 1.1 schema, 1.2 embedding worker | Open Q1 |
| 4 | 1.3 auto-ingestion, 1.4 manual ingestion + UI, 1.5 retrieval helper | 1.1, 1.2 |
| 5 | 2.1 retrievedKnowledge, 2.2 semantic matching | 1.5 |
| 6 | 2.3 golden eval pack | 2.1, 2.2 |
| 7 | 3.x ask/insights, 4.x ops | everything above |

Each step should be a separate commit (or small commit series) on
`claude/trinzo-context-rag-robustness-ioruz3`, keeping the app deployable at
every point — every phase is additive and flag-guarded.
