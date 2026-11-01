# Live product map

This map describes the source tree deployed by [PR #233](https://github.com/clairenicholsondigital/trinzo-upload/pull/233),
revision `65b6a9dbb8300c27d07776b9a9d7fadcb8025f8f`, verified tree
`ed710d0b7e3da8b886193b4c5aeb8b913fd96056`.
That cleanup preserved the frontend, saved formats and Original/Beta behavior.
[PR #237](https://github.com/clairenicholsondigital/trinzo-upload/pull/237) updates the
post-upload editor UI; the backend owners, saved formats and engine selection
remain the same.
[Repository simplification status](REPO_SIMPLIFICATION_STATUS.md) records the
original criteria, measured reductions, retained exceptions and verification.

The earlier investigation and per-batch narrative remain in Git history:
[map before consolidation](https://github.com/clairenicholsondigital/trinzo-upload/blob/37d3440ae370572431c0919c360f2147ddf2c512/docs/LIVE_PRODUCT_MAP.md).
That history describes intermediate states; the owners below describe this tree.

## Processes and persistence

| Entry point | Implementation and responsibility |
| --- | --- |
| Express web | [server.js](../server.js), PM2 `trinzo`, cwd `/srv/m365-agent-test`; serves pages/API and runs main-editor minutes generation in process. Default port 3978. |
| Generation queue | [meeting_minutes_final_worker.js](../scripts/meeting_minutes_final_worker.js), PM2 `trinzo-minutes-final-worker`; claims meeting-minutes and project-update jobs from PostgreSQL. |
| Local rewriter | [minutes_local_rewriter_worker.py](../scripts/minutes_local_rewriter_worker.py), PM2 `trinzo-minutes-rewriter`; imports `LocalMinutesRewriter` from `meeting_minutes_minilm_experiment.py`. It is an external process entry point even without a repo importer. |
| Shared embeddings | `global-minilm.service` under `/srv/global-minilm`, loopback port 8767. Repo compatibility source: [global_minilm_worker.py](../ops/global-minilm/global_minilm_worker.py). It has its own deployment. |
| Knowledge embedding | [knowledge.js](../utils/knowledge.js) spawns Python embedding/retrieval scripts on demand. An optional web-process interval is the safety net; there is no separate Trinzo PM2 knowledge process. |

[db.js](../utils/db.js) owns PostgreSQL access and `sql/` contains migrations.
The Microsoft integration also has file-backed subscriptions/events, defaulting
to `/var/lib/m365-agent-test/transcript-subscriptions.json`. Preserve its
webhooks, callbacks and durable file storage when changing routes.

[settingsDb.js](../utils/settingsDb.js) and [settingsStore.js](../utils/settingsStore.js)
persist people/glossary settings and publish a temporary Python snapshot.
Provider endpoints, credentials and published instructions have external
configuration; tracked files alone do not recreate that deployment. Configuration
can differ between the web process and workers.

## Pages and route owners

[server.js](../server.js) owns page mounts and redirects. Local `/static/*`
assets come from `public/`, with the timing helper served directly from
`utils/meetingMinutesTiming.js`. Mounted legacy screens retain their contracts.

| Surface | Routes and owners |
| --- | --- |
| Main editor | `/` redirects to `/meeting-minutes-agent`; [view](../views/meeting-minutes-agent.html), [browser code](../public/meeting-minutes-agent.js), API composition in [api.js](../routes/api.js). Processed drafts use document editing; Edit structure retains the step screens. Both share the existing draft, revision-checked saves and undo. Preview and Finalise are read-only; Reopen explicitly returns a complete draft to editing. Transcript/check drawers and structured action controls stay in this browser owner. Due captions distinguish dates, rough timing and dependencies without changing stored wording. Phones use the existing document menu for Edit structure and a compact editing bar; Finalised controls retain full labels and print excludes editing controls. |
| Library | `/jobs`, `/jobs/:jobId`, `/jobs/:jobId/result` and `/meeting-minutes-final/jobs*` aliases; [jobs view](../views/meeting-minutes-jobs.html), [Library routes](../routes/meetingMinutesLibrary.js), [job commands](../routes/meetingMinutesJobs.js), [queue routes](../routes/generationJobs.js). Current drafts and historical queued results are both supported. |
| Project workspace | `/project-update-test`: Setup, Process, Reports, Insights, Memory, Settings and Tasks. [Workspace view](../views/project-update-workspace.html), `public/project-workspace.js` and `project-stage-*.js`; [records](../routes/projectRecords.js), [context](../routes/projectContext.js), [knowledge](../routes/projectKnowledge.js), [tasks](../routes/internalAiTasks.js); generation/handoff adapters remain in API. |
| Project deep links | Report, milestone and context-snapshot URLs under `/project-update-test`, plus `/project-update-test/roadmap` and `/roadmap`. Old list URLs redirect into workspace stages. |
| Settings and insights | `/settings`, `/insights`; [settings routes](../routes/settings.js), settings helpers and Library insights. |
| Older minutes surfaces | `/meeting-minutes-final`, `/staged-meeting-minutes`, its `/client-output`, `/pre-testing`, `/analytics`, plus `/staged-meeting-minutes-analytics`; retained views and API adapters. Availability is established; recent traffic was not measured. |
| Feedback | `/meeting-minutes-feedback*`, `/review-feedback`; [minutes feedback](../routes/minutesFeedback.js), [review feedback](../routes/reviewFeedback.js), retained final-submission adapter. |
| Microsoft integration | `/meeting-agent`, `/meeting-agent/auth-redirect`; `client/meeting-agent*.js` builds to `public/meeting-agent*.js`; [meetingAgent routes](../routes/meetingAgent.js) own identity, uploads, transcript subscriptions and notifications. |
| Login | `/dashboard`, `/auth`, `/auth/login`, `/login`, `/auth/forgot-password`; [auth routes](../routes/auth.js). `/auth/register` and `/register-success` redirect to login; API self-registration remains disabled. |

The cleanup preserves all 94 effective API route registrations, their ordering,
middleware, authentication and response contracts.

## Original, Beta and preparation

Both engines use `POST /api/meeting-minutes-agent/prepare`. Its API adapter reads
the upload, applies configured phrase corrections and uses
[stagedMiniLmTrooper.js](../utils/stagedMiniLmTrooper.js) with
`scripts/staged_simplified_minilm.py`. The Python path imports the usefulness
classifier and can use shared embeddings. The JS default model is
`artifacts/meeting-minutes-usefulness-v3/classifier.joblib`; configuration can
select retained older models. Preparation stores the draft and starts the
selected engine through the shared lifecycle.

Original remains the default. Explicit Beta selection remains an admin
per-upload choice, persisted as `generationProvider: parallel-specialists-v1`.

| Responsibility | Current owner |
| --- | --- |
| Initial engine dispatch | [meetingMinutesProcessing.js](../utils/meetingMinutesProcessing.js), composed by [GenerationLifecycle](../utils/meetingMinutesGenerationLifecycle.js) with separate Original/Beta entry points. |
| Original stage composition | [meetingMinutesOriginalStages.js](../utils/meetingMinutesOriginalStages.js); Summary, Discussion and Actions have their own modules. Execution, discovery, edits, finalization, features and prompts have direct owners. |
| Provider requests and retries | [meetingMinutesAgentTransport.js](../utils/meetingMinutesAgentTransport.js), including deadlines, response decoding, failures and call context. |
| Background execution | [meetingMinutesGenerationLifecycle.js](../utils/meetingMinutesGenerationLifecycle.js), including speculation/adoption, serialized writes, progress, completion/recovery and generation/status handlers. |
| Shared live state | [meetingMinutesGenerationRuntime.js](../utils/meetingMinutesGenerationRuntime.js) owns the existing Maps and boot identity. [CandidatePrewarm](../utils/meetingMinutesCandidatePrewarm.js) owns one queue/runtime composed once by API; [CandidateLedger](../utils/meetingMinutesCandidateLedger.js) and [StageProtocol](../utils/meetingMinutesStageProtocol.js) share canonical state and stage identities. |
| Beta | [meetingMinutesParallel.js](../utils/meetingMinutesParallel.js) owns selection, draft projection and runner state; [ParallelEngine](../utils/meetingMinutesParallelEngine.js) launches Summary, Discussion and Actions concurrently. Prompts are in `config/meeting-minutes-parallel/`. |

Original stage composition receives five genuine prewarm/embedding-worker ports.
Deterministic date/context, response/referee, evidence/grounding, flags,
normalization, duplicate, discovery/recovery and action-promotion policies are
direct shared imports. API retains composition adapters and compatibility exports.
The retained V2 facade and `utils/canonicalMinutes/` remain live dependencies.

Background work in the main editor runs in the web process independently of the
browser connection. The existing owned-draft `/generation` endpoint adds a bounded
`progress` snapshot for observed Original/Beta milestones and section counts.
For an active Beta run, checked sections also have bounded read-only text previews
in the existing progress panel. Previews are separate from the editable draft,
excluded from print/exports, and hidden after failures or changed meeting inputs.
The normal editor opens from the final saved result; advisory writes share the
draft queue and preserve run identity and reviewer edits. Beta retries a section
once after a JSON parse failure if at least ten seconds remain in the original
180-second budget, retaining other checked sections and the same strict validation.
Bounded response-shape diagnostics stay in private branch results; the existing
progress panel identifies the retrying section. Other failure types and Original's
retry policy retain their existing behavior.
Queue jobs use the separate worker below.

## Draft review, publication and exports

| Responsibility | Current owner and preserved contract |
| --- | --- |
| Stored draft migration | [meetingMinutesDraftStorage.js](../utils/meetingMinutesDraftStorage.js); stored payload version 5, separate from provider wire schema version 4. Database storage imports the small migration owner directly. |
| Browser projection | [meetingMinutesDraftView.js](../utils/meetingMinutesDraftView.js), including private-field omission and current/historical draft shapes; [DraftHttp](../utils/meetingMinutesDraftHttp.js) owns authenticated reads/failure responses. |
| Reviewer transactions | [meetingMinutesReviewer.js](../routes/meetingMinutesReviewer.js), using [ReviewerState](../utils/meetingMinutesReviewerState.js), [DraftPersistence](../utils/meetingMinutesDraftPersistence.js), proposal/review/timing owners and real database operations. |
| Proposals and history | [meetingMinutesProposals.js](../utils/meetingMinutesProposals.js), shared record/action identity and review policies. Save, stale conflicts, source restore, proposal decisions, undo/redo and the existing history cap retain their authority rules. |
| Displayed/exported content | [meetingMinutesPublication.js](../utils/meetingMinutesPublication.js), [DiscussionSelection](../utils/meetingMinutesDiscussionSelection.js), [DiscussionFinalization](../utils/meetingMinutesDiscussionFinalization.js), [SummaryPublication](../utils/meetingMinutesSummaryPublication.js). |
| Library and exports | [meetingMinutesLibrary.js](../routes/meetingMinutesLibrary.js) owns the eight read/delete/project-link/export registrations and directly imports storage, view and renderer owners. |
| Renderers | [meetingMinutesAgentDocx.js](../utils/meetingMinutesAgentDocx.js) with JSZip; [stagedMinutesPdf.js](../utils/stagedMinutesPdf.js) with Playwright Chromium and installed Roboto. Both engines share these exports. |

Reviewer completion preserves intervening edits, supporting details, source
citations and proposal/history receipts. The Library/reviewer ownership graph
includes lazy restoration dependencies and is API/V2-free and acyclic for that
boundary. Public API/V2 compatibility exports retain canonical identities.

## Staged processing, evaluation and queued ingestion

| Boundary | Current owner |
| --- | --- |
| Shared transcript/people context | [stagedMinutesContext.js](../utils/stagedMinutesContext.js), with the single people-registry cache and existing alias/text/evidence preparation. |
| Deterministic Details | [stagedMinutesDetails.js](../utils/stagedMinutesDetails.js), using Context. |
| Canonical response | [stagedMinutesCanonicalResponse.js](../utils/stagedMinutesCanonicalResponse.js), with existing provider/worker calls, presentation/diagnostics and one serving-revision cache. |
| Evaluation | [stagedMinutesEvaluation.js](../utils/stagedMinutesEvaluation.js), using canonical response and Details directly. |
| Queue | [stagedMinutesQueue.js](../utils/stagedMinutesQueue.js), including transcript identity, stage resume URLs, progress, completion/failure persistence and launch scheduling. |

Queued Details use deterministic extraction. Queued Discussion and Actions keep
the measured MiniLM/Trooper path; other queued stage branches use canonical
response. Evaluation intentionally uses canonical processing. These distinct
paths retain their existing behavior.

Older minutes jobs also use [meetingMinutesGenerator.js](../utils/meetingMinutesGenerator.js)
and `scripts/meeting_minutes_trooper.py`. Preserve job types, aliases, polling and
historical payloads. The new owners import actual dependencies directly; their
shared policies are preserved rather than supplied through API callback bags.

## Project handoff and retained supporting material

`POST /api/project-update-test/from-minutes` validates the saved revision, then
[minutesForProjectUpdate.js](../utils/minutesForProjectUpdate.js) carries reviewed
text and actions into a queued report. The worker uses
[projectUpdateGenerator.js](../utils/projectUpdateGenerator.js),
`scripts/project_update_minilm.py`, Python fallback and knowledge retrieval.
The project's Beta toggle selects the minutes engine feeding this process.
Project-report generation retains its separate implementation.

| Material | Why it stays |
| --- | --- |
| Runtime classifier binaries, metrics and configurable older models | Model/configuration and Python consumers remain. |
| `scripts/meeting-minutes-core-golden/` cases, benchmarks, run records and outputs; `artifacts/pre_testing_latest.json` | [meetingMinutesCoreGolden.js](../utils/meetingMinutesCoreGolden.js) reads them for the mounted pre-testing screen. |
| `docs/CURRENT_PROJECT_STATUS.md` and frozen task-import proposal | Explicit [task-import workflow](internal-ai-tasks.md) and tests consume this historical snapshot. It is an input document with frozen references. |
| SQL/backfills, topic-arranger backfill, cache warming and shell entry points | Operational/manual entry points can update persisted state or support live services. |
| `client/` and generated Microsoft browser bundles | [build_meeting_agent.js](../scripts/build_meeting_agent.js) defines the source/output relationship. |
| Uncertain-use diagnostics and standalone evaluations | External schedules, manual use and provider effects need evidence before further retirement. |

Verified research-only material is recoverable through
[research-archive.json](../research-archive.json), its source revision and the VPS
archive `/root/trinzo-research-archive-20261030`. No Git history was rewritten.
External/manual use and generated-minute factual quality remain outside the
equivalence claims established by software tests.

Use [README](../README.md) for installation, compact/changed/release checks and
deployment. Each future task should name a concrete behavior or maintenance
problem and a finite stopping point; extra splitting is optional work.
