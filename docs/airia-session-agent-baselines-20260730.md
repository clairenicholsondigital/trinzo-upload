# Agent Baselines for Airia / Trooper Session — Sign-off Draft

_Prepared: 2026-07-30 · For review and sign-off in the Airia session (next Wednesday)_

> **Purpose:** a short written baseline for both agents — current state, known
> issues, and Q4 target — so the session can focus on *agreeing* the baseline
> rather than building it live. This is a working draft, not a formal report.
>
> **Terminology:** "Airia" and "Trooper" refer to the same thing and are used
> interchangeably here. Trooper is the LLM generation engine that sits behind
> the Meeting Minutes agent.

---

## 1. Meeting Minutes Agent

### Current state

The Meeting Minutes tool is **live** behind the authenticated Trinzo site
(`https://trinzo.virtual-hub.online/meeting-minutes-final/`) and runs on a
queued background-job workflow: upload/paste a transcript → job is queued → a
worker generates draft minutes → the completed job appears for review, editing,
copy, PDF export, and finalisation.

**Where testing / scoring has landed:**

- The fixed golden evaluation pack is the scoring baseline. The full suite is
  currently **27/27 passing with 0 schema failures** (latest stabilising
  release, commit `73924dd`). The pack covers ~20 representative cases tagged by
  meeting type and behaviour, plus universal checklist checks: clean
  titles/participants, no conversational or first-person leakage, real concise
  actions, deadlines separated out, no emojis/timecodes, and British-English
  spelling.
- Regression coverage deliberately uses **varied transcript fixtures** rather
  than only the original webinar-rehearsal example, and favours semantic
  confidence / abstention over transcript-specific phrase patches.
- The scoring runner supports dry-run (fixture/scoring validation), local
  extractor, and live-API modes, so we can score fixtures offline or score the
  deployed API directly.

**The pre-LLM parsing / cleaning fix** — this is the key reliability change
since the webinar-transcript issue:

- A **conservative pre-router runs before the model is called.** It is *not* a
  broad meeting classifier — it only catches high-confidence failure patterns:
  partial transcripts, large timestamp gaps, very low-substance / audio-check
  input, and webinar/content-planning language.
- **Partial-transcript and timestamp-gap detection:** cues such as "I just
  turned on the transcript" and large jumps (e.g. `1:26` → `30:30`) are detected
  and fed into the generation prompt and diagnostics.
- **Transcript cleaning before generation:** speaker prefixes, visible
  transcript artefacts, and timecodes are stripped/normalised so the model sees
  clean text rather than raw capture noise.
- **Deterministic safety gate after generation:** even if the model tries to
  over-extract, cautious modes strip weak actions/decisions and add a
  transcript-quality caveat rather than inventing deadlines or owners.

The net effect: the tool now **prefers sparse, cautious output over fake formal
certainty**. This directly resolves the earlier webinar-transcript failure,
where a fragmentary discussion-led transcript was being forced into an
action-heavy formal minute.

### Known issues / honest caveats

- **Some green-suite fixes are still fixture-shaped.** A portion of the 27/27
  pass relies on transcript-supported deterministic recovery rules that are
  content-specific (e.g. recovering certain action clusters, plus a
  priority boost for a few canonical action phrasings). These are **not**
  hardcoded by fixture name, file name, job ID, or case number — they still
  require transcript evidence — but they are closer to golden-suite tuning than
  the long-term architecture should be. The agreed next step is to refactor this
  into generic, evidence-driven extraction (generic action-table parser +
  semantic topic recovery + evidence-quality ranking) while keeping 27/27 green.
- **Speed.** The full suite passes but is slow; the target is end-to-end
  generation under ~30 seconds where practical. Planned work: trim unnecessary
  Trooper retries where deterministic fallback already suffices, reuse the
  MiniLM/classifier layer, and add per-stage timing observability.
- **Draft-assist, not fully automated final minutes.** Output still needs human
  review — especially for incomplete transcripts, noisy auto-captions,
  discussion-led (vs action-led) meetings, and regulatory/compliance-heavy
  conversations. This is the correct posture for now, not a defect.
- **Deployment alias gap:** the standard deploy script does not yet reliably
  restart `trinzo-minutes-final-worker`, so meeting-minutes deploys currently
  need an explicit worker restart. Tracked as a fix.

### Q4 target — on track?

Target: **working minutes for specific use cases, automated saving, and a
searchable archive.**

| Q4 target element | Status | Notes |
| --- | --- | --- |
| Working minutes for specific use cases | **On track** | Strong for formal, action-led meetings (27/27 golden green); correctly cautious/sparse for partial or discussion-led transcripts. Generalisation refactor is the main remaining quality work. |
| Automated saving | **On track / partly in place** | Autosave transcript snapshots + a meeting-minutes DB schema (meetings, objectives, participants, minute items, next steps) exist; finalisation posts approved JSON to Power Automate. |
| Searchable archive | **Foundations in place** | The persistence schema exists; the searchable retrieval pattern is already proven on the RAG side (below). Wiring a first-class searchable minutes archive is the clearest remaining build item. |

**Summary:** the Meeting Minutes agent is on track for the Q4 target. The core
generation is stabilised and scored; the remaining work is (a) making the
extraction less fixture-shaped, (b) speed/observability, and (c) finishing the
searchable-archive surface on top of persistence that mostly already exists.

---

## 2. RAG (Project-Update project knowledge / "Ask this project")

> **Scope note:** "RAG" here refers to the retrieval layer inside the
> Project-Update workspace (`/project-update-test`) — project memory, knowledge
> ingestion/embedding, semantic retrieval, and "Ask this project". This is the
> piece you flagged as possibly **further along than officially recorded**, and
> that is accurate — see below.

### Current state — further along than the logged status suggests

The RAG stack is **built and verified in production**, beyond what earlier
status notes implied:

- **Schema and storage:** `project_knowledge_items` / `project_knowledge_chunks`
  are live via migration `20260703_add_project_knowledge_schema.sql`. pgvector
  is installed on production Postgres; project knowledge is now a **pgvector-only
  feature** (`VECTOR(384)` MiniLM embeddings; the old `REAL[]` fallback has been
  removed).
- **Full ingest → embed → retrieve loop, verified end-to-end in production**
  (2026-07-27 smoke test, then cleaned up):
  - manual Setup knowledge created an active official item + queued chunk;
  - the embed worker moved the chunk to `embedded`;
  - retrieval returned it in **semantic** mode;
  - "Ask this project" returned a retrieval-only answer even when generation was
    unavailable;
  - approved-report ingestion was **idempotent** (`{ ok, itemsCreated,
    chunksCreated }`; re-ingesting the same version created no duplicates);
  - project cleanup preserved official/manual knowledge and archived generated
    non-official knowledge.
- **Retrieval is honest about its mode:** it reports `semantic`,
  `keyword_fallback`, or `none`, so callers can tell a real semantic match from a
  keyword/no-knowledge state. Crucially, **retrieved knowledge is supplemental
  background only and is never presented as transcript evidence** — this is
  enforced and regression-tested.
- **Regression / golden coverage is real, not aspirational:** the strict
  project-update golden eval passes (**20/20**, `--mode all`), including a case
  that specifically asserts retrieved knowledge supplements context without
  becoming evidence. `npm test` runs 224 deploy-facing Python tests + Node tests
  green.
- **Workspace maturity:** the project-first workspace UI (Setup → Process →
  Reports → Insights) is built and authenticated across pages, uploads, mutating
  and read endpoints; report lifecycle (draft / in-review / approved / archived,
  "mark official", "tidy draft data") is implemented with a cold-user polish
  pass done.

**In short:** the officially-logged status under-represents this. The retrieval
loop is not a prototype — it is deployed, smoke-verified in production, and
covered by passing golden evals. The deep-dive should capture it at that level.

### Known issues / open items

- **Needs a real-data internal pilot.** Everything above is proven on fixtures +
  a production smoke project; it has not yet had a proper pass on 3–5 real
  project-update transcripts on one real project. A pilot checklist, correction
  log, and pass/fail criteria are written and ready to run.
- **Status classifier is diagnostics-only.** A separate MiniLM status classifier
  exists (baseline frozen 2026-07-29; ~0.63 macro-F1 on overall status) and is
  wired into the upload path as **diagnostics only** (`decisionUse:
  diagnostics_only`, fail-open). It does **not** yet influence user-facing
  health/status decisions — a deliberate product decision, pending pilot-data
  comparison, before it's allowed any influence.
- **DB hardening in slices.** The critical project-update query paths are
  parameterised; some older meeting/admin compatibility paths still build SQL
  strings and are being converted in small, tested slices.
- **Client-facing polish before external use.** Auth boundary is decided and
  applied; remaining items are an authenticated desktop+mobile screenshot pass,
  roles/permissions if non-admin users are added, and a first-time-user
  walkthrough.

### Q4 target — position

The RAG layer's core capability — **searchable, retrievable project memory that
supplements (never fabricates) transcript evidence** — is **already functional
and verified**. The remaining path to Q4 is confidence-building and hardening
rather than net-new build: run the internal pilot, decide the status-classifier
role from real data, finish DB parameterisation, and complete the client-facing
polish. The same retrieval pattern is the natural basis for the Meeting Minutes
"searchable archive" target above.

---

## What sign-off in the session would confirm

1. **Meeting Minutes:** scoring baseline is 27/27 golden green; the pre-LLM
   router/cleaning fix is in and resolves the webinar-transcript failure mode;
   on track for the Q4 target, with generalisation + searchable-archive as the
   named remaining work.
2. **RAG:** the retrieval/project-memory stack is materially further along than
   the logged status — deployed, production-smoke-verified, and golden-green —
   and the baseline should record it at that level, with the internal pilot as
   the next gate.
3. **Agreed next steps** (already documented, not new decisions to make live):
   refactor fixture-shaped minutes recovery into generic extraction; run the
   RAG internal pilot; take a data-driven decision on the status classifier.
