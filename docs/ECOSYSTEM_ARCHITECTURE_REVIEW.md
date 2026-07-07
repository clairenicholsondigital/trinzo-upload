# HelixScribe / Claire Nicholson Digital — Ecosystem Architecture Review

**Date:** 7 July 2026
**Scope:** all seven repositories: `helixscribe-api`, `helixscribe-create-official`, `helixscribe-website-builder`, `clairenicholsondigital-website`, `Run-Smart-Decision`, `love-of-tennis`, `trinzo-upload`
**Intended audience:** every engineer who joins the company. Read this before touching any repo.

**How this document separates fact from inference:** statements grounded in code carry file references or are stated plainly. Anything inferred is marked *(inference)* with a confidence level. Where I am genuinely uncertain, I say so.

---

## 1. Overall ecosystem

### 1.1 What exists

| Product | Repo | What it is | Domain | Status |
|---|---|---|---|---|
| **HelixScribe Platform API** | `helixscribe-api` | Central AI knowledge engine + content backend: knowledge buckets → items → chunks → embeddings, RAG, inbox triage, autonomous AI tasks/aims, workflow engine, versioned prompts | `api.helixscribe.cloud` | Live, production (v2.0.0) |
| **HelixScribe Create** | `helixscribe-create-official` | AI content-creation SaaS for solo expert founders — "Brand DNA" memory, RAG-grounded generation, closed learning loop | `create.helixscribe.ai` | Live functional beta; **no billing** |
| **HelixScribe Website Builder** | `helixscribe-website-builder` | Agency-operated client workspace: template CMS, CRM, maps, shareable event calendars, per-client custom domains | `helixscribe.com`, `nwr.virtual-hub.online` | Live for one client (NWR) |
| **Claire Nicholson Digital website** | `clairenicholsondigital-website` | Agency marketing site + blog CMS + lead funnel; primary promotional surface for HelixScribe | `clairenicholsondigital.com` | Live, production |
| **Run Smart+** | `Run-Smart-Decision` | Mobile running decision-support app; a tenant app on the Platform API (`app_key: run_smart`) | Expo/EAS, `com.clairenicholson.runsmart` | Pre-launch hardening (v1.0.2 build 5) |
| **For The Love of Tennis** | `love-of-tennis` | Tennis fan app: live scores, players, tournaments, podcast, AI match summaries | App Store/Play (versionCode 53), `for.theloveoftennis.co.uk` | Published; oldest codebase, security issues |
| **Trinzo Upload** | `trinzo-upload` | Internal consultancy tool: meeting transcripts → client-ready minutes; project transcripts → versioned status reports, with per-project RAG memory | `trinzo.virtual-hub.online` | Active internal prototype |

### 1.2 What problem each solves, and for whom

- **Platform API** — infrastructure, not a user-facing product. It gives every HelixScribe app a shared account system, a per-user/per-app knowledge store with embeddings, RAG retrieval, scheduled AI tasks, and content generation — all running on self-hosted models. Users: the other apps (and an admin console in `frontend/`).
- **Create** — solo founders/consultants who want AI-written content grounded in *their* voice and material rather than generic chatbot output. The moat is the persistent brand profile + private knowledge base + learn-from-edits loop.
- **Website Builder** — the agency's "we build and host it for you" tier: CND provisions a small client site, the client gets a simple editor for content, branding, blog and event calendars. Current real client: NWR, a community/membership organisation.
- **CND website** — top of funnel for the agency (websites, apps, SEO, AI services) and the marketing front door for HelixScribe.
- **Run Smart+** — recreational runners deciding *whether and how* to run today. Deliberately not a GPS tracker; four readiness sliders in, a run recommendation with rationale out, plus a growing personal memory.
- **Love of Tennis** — tennis fans following the pro tours; companion app to the podcast/brand of the same name.
- **Trinzo Upload** — internal tool for Trinzo consultants: turns raw transcripts into structured minutes and status reports with evidence-grounded AI.

### 1.3 How the products relate (fact vs inference)

**Verified relationships:**

- **Run Smart+ is a true platform tenant.** It authenticates against `api.helixscribe.cloud` (`/auth/*`), stores everything in the app-knowledge RAG layer (`/app-knowledge/buckets/run-smart-memory/...`), and uses server endpoints for insight generation. The Platform API contains Run-Smart-specific code (insight lenses, digest endpoints, fixtures in `tests/fixtures/run_smart_insights`).
- **Create is a partially decoupled satellite.** Its core user flows now run on an *embedded* FastAPI backend (`api/app.py`, SQLite), but the admin console still calls the central Platform API for knowledge buckets, reasoning, prompts and workflows (`src/lib/helixscribe-admin-api.js`, `knowledgeBucketApi.js`). It migrated *off* Supabase (project `fnukrzlhqmodflfnyhzl`, archived under `legacy/`).
- **Trinzo deliberately clones the platform's design without sharing infrastructure.** `docs/project-update-robustness-todo.md` is explicit: *"`helixscribe-api` is a read-only reference — we copy its patterns (schema shape, embedding queue, retrieval fallbacks), never its code paths, and we never modify, redeploy, or share infrastructure with it."* Same bucket→item→chunk shape, embedding queue, `retrieval_mode` diagnostics, `/ask` endpoint — different embeddings (MiniLM 384-dim vs nomic-embed 768-dim) and different LLM (Gemini vs Ollama).
- **The CND website is the marketing hub for everything.** Dozens of CTAs to `create.helixscribe.ai`, a HelixScribe tracking snippet from `app.helixscribe.cloud`, and portfolio entries for Love of Tennis and Run Smart. Trinzo is never mentioned publicly.
- **Website Builder and Create cross-promote** ("Create with HelixScribe" footer links) but share no code or backend.
- **Love of Tennis is architecturally an outsider**: it predates the platform (*(inference, high confidence)* — GPT-3.5-era DanteAI integration, unused scraping deps, versionCode 53), runs on its own legacy backend (`for.theloveoftennis.co.uk/hcgi/api`), and does not use the Platform API. Create's `legacy/personal-admin-archive` still contains tennis admin pages (`AdminLiveMatchesPage.jsx`, `TennisArticleGeneratorPage.jsx`), showing the two products share template DNA from an earlier all-in-one personal admin app.

**One company, two brands** *(inference, high confidence)*: Claire Nicholson Digital is the agency (services, client work — Website Builder, CND site, Trinzo for the consultancy relationship); HelixScribe is the product brand (Platform, Create, and the mobile apps published under it). Trinzo appears to be a client or partner consultancy for whom the tooling is built — the code separates `participants.client` from `participants.trinzo`, and the doc's insistence on infrastructure separation suggests a commercial boundary *(inference, medium confidence)*.

### 1.4 Production-ready vs experimental

**Production:** CND website, Platform API, Love of Tennis (published but with security debt), Website Builder (live, single tenant).
**Beta / pre-launch:** Create (works end-to-end; blocked on billing), Run Smart+ (blocked on device QA and store forms).
**Internal prototype:** Trinzo Upload (self-described test workflows, `node_modules` committed, in-memory sessions).

### 1.5 Where code is duplicated today

- **Auth is implemented five separate times**: Platform API (PBKDF2 + Supabase JWT + legacy tokens), Create's embedded API (custom HMAC JWT + PBKDF2), Website Builder (hardcoded users + HMAC cookie), Trinzo (PBKDF2 + in-memory sessions), Love of Tennis (none). All hand-rolled, all slightly different.
- **The RAG stack exists three times**: Platform API (pgvector + nomic-embed + Ollama), Create's embedded API (SQLite + Ollama/Gemini embeddings), Trinzo (pgvector + MiniLM + Gemini). Same bucket/item/chunk model each time.
- **SEO prerender pipeline** (`prerender.js`, `generate-sitemap.js`, `tools/generate-llms.js`, nginx `try_files` serving) is duplicated between the CND website and Create.
- **The Vite + shadcn + Tailwind + Horizons-artifact stack** is duplicated between the CND website and Create (including dead `plugins/visual-editor` folders in both).
- **Prompt guardrails** (British English enforcement, anti-hallucination "do not invent facts/statistics/clients", banned-phrase lists) are re-written per repo: Platform API's `constants.py`, Create's `api/app.py` + `config.py`, Trinzo's `google_ai_studio_minutes.py`.
- **DB-backed job queues with retry/dead-letter** exist in the Platform API (three families) and again in Trinzo (`meeting_jobs`).
- **Docker + Traefik + Let's Encrypt compose files** are near-identical across four repos.

### 1.6 What could become shared

In rough order of leverage (detailed in §6): the HelixScribe API client (already written generically in Run Smart's `knowledgeClient.ts`), authentication/tenancy, the RAG/knowledge service (it already exists — Create and Trinzo re-built it anyway), prompt registry + guardrail library, billing, the SEO prerender toolkit, and a shared UI theme package (Archivo font + gradient/glass design tokens already recur everywhere).

---

## 2. Repository-by-repository review

### 2.1 `helixscribe-api` — the Platform

- **Purpose:** self-hosted AI knowledge engine and content backend powering Create's admin tools, Run Smart+, and NWR workflow apps. Despite the name, there is **no audio transcription anywhere** — "Scribe" is metaphorical.
- **Tech stack:** Python 3.12, FastAPI + Uvicorn, psycopg 3 with **raw SQL (no ORM)**, httpx, BeautifulSoup/lxml/Playwright (scraping), croniter, PyJWT, pydantic. No AI SDKs — all AI is raw HTTP to Ollama.
- **Architecture:** a flat monolith of ~70 top-level modules; one `APIRouter` per feature file, 31 routers wired in `app_main.py`. Three parallel DB-backed queue/worker/scheduler families (AI tasks, workflow v2, embeddings) with claim/retry/dead-letter semantics. A dual-mode launcher (`run_service.py`, `SERVICE_MODE=api|scheduler`) matches the two compose services.
- **Folder structure:** almost everything at repo root. `ai_task_execution_refactor/` is the one properly packaged module (a clean rewrite: execution/steps/profiles/prompts/quality/search/persistence). `sql/` holds 11 forward-only migrations; `docs/` has 17 genuinely useful runbooks; `frontend/` is a plain-JS admin console; `tests/` has ~37 pytest modules. Junk: a committed `.venv/` (**1,137 of 1,435 tracked files**), `Dockerfile.save` (corrupt), zero-byte files literally named `[api]` and `[scheduler]` (shell-redirect accidents), committed prompt-optimiser run artifacts and 105KB workflow-export JSON.
- **Main entry points:** `app_main.py` (FastAPI app), `run_service.py`, `scheduler_runner.py`, `ai_task_run_worker.py`, `workflow_v2_worker_runner.py`.
- **APIs:** `/auth`, `/app-knowledge` (28 endpoints — the heart of multi-tenancy), `/knowledge-buckets`, `/chunks`, `/rag`, `/search` (SearXNG), `/inbox-notes` + AI triage, `/ai-tasks` + schedules + worker, `/aims` (objectives that plan and spawn tasks), `/workflow-v2` (+ legacy v1), `/skeleton` + `/prompts` + `/prompt-reliability`, `/marketing-content`, `/api/helixscribe/hs-exec-socialpost`, `/scrape`, and an **OpenAI-compatible `/v1/chat/completions` shim** proxying to Ollama.
- **Database:** self-hosted Postgres (host `pgsql`, db `helixscribe`) with **pgvector** for embeddings. Domain model (from `DB_SCHEMA_REFERENCE.md`): knowledge buckets/items/chunks with edit-mode locking; reasoning buckets, core topics, skeleton items with claim-level evaluations; versioned system prompts with routing; workflows v1+v2; AI tasks → plan steps → runs → step runs → queue; tenancy tables (`app_users`, `user_app_memberships`, `app_knowledge_buckets`). Schema is created both by migration files *and* lazily at request time via `ensure_*_tables()` — a hybrid that works but blurs migration history.
- **Authentication:** three mechanisms tried in order — legacy DB bearer tokens (on by default), **Supabase JWT** (HS256 against `SUPABASE_JWT_SECRET`, with JIT provisioning of local user + membership + default bucket), and password auth (PBKDF2, 260k iterations; a legacy sha256 fallback lingers). Multi-tenancy is genuine: isolation by `(user_id, app_key, bucket_slug)`, RBAC-lite roles per app membership. Rate limiting exists at both Traefik and app level but is in-memory/single-process.
- **AI integrations:** **Ollama only** — `llama3.2:3b`, `qwen2.5:0.5b`, `nomic-embed-text`, and custom Modelfiles `helixscribe-blog`, `helixscribe-social`, `helixscribe-quality-check`, `openclaw-llama3.2-16k:3b`. Role-based model routing with env-chain fallbacks and per-role temperatures; JSON-schema-constrained generation; a semaphore/slot system (`ollama_limits.py`) protecting the single Ollama box; a research → brief → draft → quality-check content pipeline; large banned-phrase lists and an American→British spelling map; versioned prompts in the DB; an offline genetic prompt-optimiser harness (`cmd_optimizer*`, the `[CMD]@...` DSL).
- **External services:** SearXNG (self-hosted meta-search for autonomous research), SendGrid (email), Supabase (JWT issuer only), Playwright scraping. No payments, storage buckets, or transcription.
- **Deployment:** Docker + Traefik + Let's Encrypt on a VPS; separate `api` and `scheduler` containers; Traefik-level rate limits on `/auth`; external Docker networks to Postgres and SearXNG containers.
- **Strengths:** rich and thoughtful domain model; durable queues; genuine multi-tenancy; disciplined anti-slop prompt engineering; real test suite for newer code; excellent in-repo runbooks; the refactor package shows the team knows what good structure looks like.
- **Weaknesses / debt:** committed `.venv` (~79% of tracked files); god-files (`app_knowledge_routes.py` 192KB, `workflow_v2_routes.py` 152KB, `inbox_ai_routes.py` 111KB); helper functions re-implemented across modules; two coexisting workflow engines; wildcard imports; unpinned `requirements.txt`; no Sentry/APM; permissive credentialed CORS including all `*.replit.app`; API docs public by default; `AUTH_DEBUG_RESET_TOKEN` backdoor if ever set; in-memory rate limiters that assume a single process.
- **Unusual:** the OpenAI-compat shim (lets external agents treat the stack as an OpenAI endpoint); the prompt-optimisation harness with committed experiment artifacts; "aims" as an agentic layer above tasks.

### 2.2 `helixscribe-create-official` — the flagship SaaS

- **Purpose:** AI content creation grounded in per-user "Brand DNA" for solo expert founders. Marketing site + product app + large admin console in one repo.
- **Tech stack:** Vite 7, React 18 (JSX, not TS), shadcn/ui + Tailwind 3, framer-motion, react-router v6, Context-only state (no react-query despite the app's size), react-quill/marked/dompurify editor stack, jspdf/mammoth/pdfjs import-export. Plus an **embedded Python FastAPI backend** in `api/` — `app.py` is a single ~8,100-line file — with **SQLite** storage created via imperative `CREATE TABLE IF NOT EXISTS` (no migrations).
- **Architecture:** SPA + same-origin `/api/*` backend behind Traefik. Mid-migration in two directions at once: fully migrated **off Supabase** (archived in `legacy/supabase-archive`, old project ref `fnukrzlhqmodflfnyhzl`), and partially migrated **off the central Platform API** (user flows are local; admin knowledge/reasoning/prompt tooling still calls `api.helixscribe.cloud`).
- **Entry points / routes:** `src/main.jsx` → `App.jsx` (V2 routes) + `AppRoutes.jsx` (catch-all: marketing, admin, legacy redirects). V2 product surface: register/login, 8-step Brand Profile wizard, `/v2/create` (flagship, ~1,541 lines), library, documents + editor, `/v2/improve` (approve/reject learned rules), source material, notifications, settings. ~45 admin routes.
- **Database tables** (SQLite): `users`, `password_reset_tokens`, `learn_events`, `contacts`, `resources`, `documents`, `app_knowledge_buckets/items/chunks`, `jobs`, `notifications`.
- **Authentication:** custom HMAC-SHA256 JWTs signed with `CREATE_AUTH_JWT_SECRET` (boot-time guard refuses default/short secrets — good practice), PBKDF2-style password hashing, localStorage token, roles checked by `AdminRoute` (`platform_owner`/`super_admin`/`admin`), trial gating via `user_status`/`trial_ends_at`. Two overlapping auth contexts (`AuthContext`, `AuthV2Context`) wrap the same client — consolidation half-done. No teams; `workspace_id` columns are vestigial.
- **AI integrations:** primary generation on **local Ollama custom models** (`helixscribe-social`, `-email-campaign`, `-rewrite`, `-business-profile`) with **Gemini 2.5 Flash Lite as fallback** (`GOOGLE_AI_STUDIO_API_KEY`); embeddings via `nomic-embed-text` or `gemini-embedding-001`; RAG over `app_knowledge_chunks` with hybrid vector+keyword retrieval; a closed learning loop (user edits → heuristic rule proposals → approve/reject → rules injected into future prompts); prompt registry (`api/prompt_registry.py`) with an admin editor; brand-leakage sentinels blocking internal names (RNAssist, CND, HelixScribe) from user output. **Honesty caveat verified by the repo's own audit:** effectiveness scoring and edit-change analysis are regex/heuristics presented alongside AI features.
- **Payments:** not production-ready. Hardcoded Stripe **test** publishable key and test Price ID; deprecated client-only `redirectToCheckout`; **no server-side Stripe, no webhooks, no subscription tables**. `BILLING_ENFORCED` exists but there is nothing to upgrade to. The internal audit calls this the launch blocker: *"There is no way to take money."*
- **External services:** SendGrid; `@atproto/api` (Bluesky) and `openai` npm packages are dependencies but **unused** — vestigial.
- **Deployment:** Docker + Traefik + LE on the VPS; nginx serving the Vite build, uvicorn container for the API; `create.helixscribe.ai`.
- **Design:** "Brand DNA" double-helix identity; purple→blue→teal `brand-gradient` (`#7C3AED → #0B85F4 → #14B8A6`); Archivo typography; dark mode; framer-motion polish; dedicated mobile smoke tests.
- **Strengths:** the core loop genuinely works end-to-end; boot-time secret validation; layered rate limiting; Playwright smoke tests + a prompt-quality benchmark harness; unusually honest self-documentation (`docs/audit-2026-07-create.md`).
- **Weaknesses / debt:** 8.1k-line backend monolith on SQLite with no migrations; no unit tests; large dead-code surface (whole `legacy/` tree, ~12 stub pages, near-duplicate admin files); Horizons artifacts (globally silenced `console.warn`, visual-editor plugins); three competing product vocabularies; unused deps.
- **Unusual:** the repo ships its own founder-commissioned product audit; there is a `premium-saas-design` Claude skill in `.claude/skills` — the codebase is visibly co-developed with AI agents.

### 2.3 `helixscribe-website-builder` — the agency CMS

- **Purpose:** invite-only workspace where the agency builds template-based client sites and hands the client an editor — plus a CRM (contacts, CSV import, geocoded maps) and shareable event calendars. The README ("Blank Next.js starter") is badly stale; this is ~7,700 lines of working multi-tenant MVP.
- **Tech stack:** Next.js 15.3.4, React 19, App Router, server actions, strict TypeScript, **zero runtime dependencies beyond next/react** — auth, hashing and storage use Node built-ins. One hand-written 2,605-line `globals.css`; no Tailwind, no shadcn (a deliberate outlier vs the web apps — *(inference, medium confidence)* chosen for zero-dependency simplicity).
- **Architecture / storage:** **no database — JSON files** (`sites.json`, `contacts.json`, `event-calendars.json`) on a mounted volume, read-modify-write per mutation, no locking. Fine for one small tenant; a race-condition and scale hazard beyond that.
- **Entry points / routes:** login at `/`; client dashboard (`/dashboard/*`: website-builder, branding, event-calendars); admin (`/dashboard/admin`, `/user-management`); CRM (`/contacts/*`, `/map-groups/*`); **public rendered client sites** at `/sites/[slug]/[[...pagePath]]` with `middleware.ts` rewriting the client's custom domain (`nwr.virtual-hub.online` → `/sites/nwr`). Config-driven per-organisation dashboard modules show the multi-tenancy is intentional.
- **Authentication:** hand-rolled but competent — PBKDF2-SHA256 (210k iterations), `timingSafeEqual`, HMAC-signed httpOnly cookie, 8-hour expiry, per-action role re-checks, admin impersonation. But users are a **hardcoded 2-entry array with committed password hashes** in `lib/auth.ts`, and sessions cannot be revoked.
- **AI:** none. "Website builder" here means a fixed-schema CMS; the AI builder is Create, which it links to.
- **External services:** postcodes.io + Nominatim geocoding, OSM/Carto tiles rendered with hand-written tile math (no map library).
- **Known defects:** public site renderer ignores the branding the client sets (`siteStyle()` hardcodes the default palette) — a shipped feature that silently does nothing; the public calendar-event and RSVP endpoints accept unauthenticated writes with no rate limiting.
- **Deployment:** Docker standalone + Traefik + LE; `helixscribe.com`, `www`, and the NWR custom domain; named volume for the JSON data.
- **Strengths:** modern idioms, `server-only` boundaries, path-traversal guards, upload MIME whitelisting, resilient layered geocoding.
- **Weaknesses:** JSON-file persistence, hardcoded users, the branding bug, open public writes, stale README, monolithic CSS.

### 2.4 `clairenicholsondigital-website` — the marketing hub

- **Purpose:** agency marketing site, blog/CMS, lead funnel; the primary promotional surface for HelixScribe. Strong life-science/scientific-communication niche.
- **Tech stack:** Vite 5, React 18 (JSX), react-router v6, shadcn/ui + Tailwind, framer-motion, react-quill admin editor, recharts analytics. Supabase (`@supabase/supabase-js`) is the only backend.
- **Architecture:** SPA with ~35 lazy-loaded routes plus an admin CMS (`/admin/*`, Supabase email/password auth) managing posts, page SEO, head-snippet injection, redirects and first-party analytics.
- **Supabase:** project `kedwhanehzknoywrssve` — tables `blog_posts`, `blog_settings`, `contacts`, `analytics_events`, `redirects`, `head_snippets`, `page_seo_settings`; storage bucket `blog_images`; one edge function (`get-ip`). Anon key + URL hardcoded in `src/lib/customSupabaseClient.js` (public-tier by design; everything rests on RLS being right).
- **The SEO prerender pipeline is the repo's crown jewel:** at build time `prerender.js` connects to Supabase, pulls all published posts, and emits fully static `dist/<route>/index.html` files — real crawlable body HTML, meta/OG tags, JSON-LD `BlogPosting`, sitemaps, robots.txt — which nginx serves via `try_files`. This gives SSG-grade SEO from an SPA without an SSR runtime. Cost: **deploys fail if Supabase is unreachable at build time**. A `tools/generate-llms.js` step emits `llms.txt` for LLM crawlers.
- **External services:** GoHighLevel/LeadConnector CDN hosts nearly all media (the agency evidently runs its CRM there — *(inference, high confidence)* from the `msgsndr` asset URLs); HelixScribe tracking snippet from `app.helixscribe.cloud`; Google Fonts; YouTube embeds. Contact forms write straight to the Supabase `contacts` table.
- **AI:** none in code — AI is subject matter.
- **Deployment:** multi-stage Docker (node build → nginx) + Traefik + LE; health endpoint; immutable asset caching.
- **Strengths:** disciplined SEO engineering with a verification checklist; clean feature-based components; cookie-consent-gated first-party analytics.
- **Weaknesses / debt:** Hostinger Horizons leftovers (dead visual-editor plugins, `.htaccess`, babel AST tooling in build hooks); both `react-helmet` and `react-helmet-async` used; obsolete prerender stubs; owner's home IP hardcoded in `analytics.js` as an exclusion filter; only 6 commits (history was not imported).

### 2.5 `Run-Smart-Decision` — the platform-native mobile app

- **Purpose:** "Run Smart+" — decide whether/how to run today from four readiness sliders; records restraint as success; builds a personal memory that powers insights. Deliberately no GPS, no health-platform integrations (expo-location was removed).
- **Tech stack:** pnpm monorepo (Replit full-stack template), Expo SDK 54, expo-router v6, RN 0.81.5, React 19.1, New Architecture + React Compiler, Context + light react-query, SecureStore for tokens.
- **Architecture:** the real product is `artifacts/mobile/`. The monorepo's other packages — `api-server` (healthz only), `lib/db` (empty Drizzle schema), `api-spec`/`api-zod`/`api-client-react` (generated from the healthz spec), `mockup-sandbox` (a Vite/Radix design prototype) — are **unused template scaffolding**.
- **Backend:** entirely the Platform API, scoped by `app_key: 'run_smart'`. Auth (`/auth/register|login|me`, `DELETE /auth/account` — verified to purge RAG data), knowledge buckets, `retrieve`, `ask`, `process`, `insight-blocks` (server-generated structured insight blocks with prompt versioning and snapshot caching), experiments logging. `utils/knowledgeClient.ts` is explicitly written as a *generic, reusable HelixScribe API client* — the seam intended for sibling apps.
- **AI split:** the "smart" run recommendation is a **deterministic on-device rule engine** (`utils/suggestion.ts`: composite readiness score + recent-history modifiers + recovery signature), with LLM work (RAG Q&A, insight blocks) deferred to the server. No AI keys in the repo at all — a clean pattern.
- **Deployment:** EAS (Android APK/app-bundle profiles; no iOS profiles yet), OTA updates via `u.expo.dev`, owner `clairenicholson078`.
- **Strengths:** clean domain model; careful error handling (bucket auto-create, soft-delete fallbacks); supply-chain hardening (`minimumReleaseAge`); a bulk API test harness with 29 fixture users including safety-critical cases; honest QA docs that caught and fixed "prototype smells".
- **Weaknesses / debt:** zero unit/component tests; typecheck is red (Expo/RN typing issues); config drift (slug still `mobile`); two overlapping suggestion functions (logged-in vs guest) that can diverge; all the dead template scaffolding.
- **Status:** near-shipping; remaining gaps are device smoke tests, token-expiry UX verification, and store data-safety forms.

### 2.6 `love-of-tennis` — the legacy mobile app

- **Purpose:** "For The Love of Tennis" — live scores (ATP/WTA/ITF/wheelchair), players, tournaments, news, podcast player, share cards, "Analyse with AI" match summaries. Published: iOS ASC app id present, versionCode 53.
- **Tech stack:** Expo SDK 54 / RN 0.81.5 / React 19.1 (recently modernised shell) but React Navigation v6 rather than expo-router, no global state beyond one Context, and a **flat repo root of ~50 screen files** with giant screens (`UpcomingMatches.js` 66KB).
- **Data sources:** its own legacy backend (`for.theloveoftennis.co.uk/hcgi/api` — push registration, head-to-head, players, news), **RapidAPI tennis API called directly from the client with a hardcoded key** (the repo's own audit doc says this must live server-side), Acast RSS (regex-parsed), and a Google Apps Script webhook for news notifications. The cheerio/html-parser deps are unused leftovers from a scraping era.
- **Auth:** none — anonymous device ID for push tokens.
- **AI:** a dated DanteAI wrapper (`gpt-3.5-turbo`, hardcoded key and conversation ID) for match analysis.
- **Security — the worst findings in the ecosystem:** committed **Android release signing keystore** (`release.keystore` is git-tracked; `.gitignore` blocks `*.jks` but not `*.keystore`), hardcoded RapidAPI and DanteAI keys, Firebase configs, and the Apps Script webhook URL. No analytics or crash reporting at all, so production issues are invisible.
- **Strengths:** the newer `services/api.js` + `matchEnrichmentClient.js` layer is genuinely excellent (timeouts, retry-with-backoff on idempotent methods only, request queue, concurrency cap, TTL cache, in-flight dedup); custom ESLint rule for unwrapped text; some real tests.
- **Weaknesses:** everything above, plus repo hygiene accidents (files literally named `et --hard <sha>`, `=0.8.1`, a `%ProgramData%` directory) and a version split (package.json `2.0.0` vs app.json `43.0.7`).
- **Reading:** *(inference, high confidence)* an older codebase recently re-skinned and framework-upgraded rather than rewritten; the "donor" repos `tennis-app-new` / `tennis-web-app` referenced in its audit doc are not in this workspace.

### 2.7 `trinzo-upload` — the internal consultancy tool

- **Purpose:** "Trinzo Upload — Option B Workflow": upload a `.docx`/`.txt` transcript → extract → structure into meeting minutes → human review in a browser UI → finalise to a **Power Automate** webhook. A second, newer workflow produces versioned project status reports (health RAG, milestones, risks, trends) with per-project RAG memory. Users: internal Trinzo consultants (self-registration disabled).
- **Tech stack:** Node/Express 5 orchestrating **Python NLP subprocesses** per request (temp-file IPC): sentence-transformers **MiniLM all-MiniLM-L6-v2** for evidence extraction and embeddings, rapidfuzz, and **Gemini 2.5 Flash** for rewriting — degrading gracefully to MiniLM-only when Gemini is absent or rate-limited. Postgres via `pg` with raw SQL (~25 tables, 8 dated migrations, pgvector with `REAL[]` fallback).
- **Not what its name says:** the `@microsoft/agents-*` and `openai` packages are never imported; the Copilot Studio path (Direct Line REST) is legacy. It is an Express web app, not an M365 agent.
- **Auth:** PBKDF2 passwords, but sessions in an **in-memory Map** (die on restart) and password-reset tokens returned in the HTTP response — acceptable only because it is internal.
- **Prompt discipline is the house style at its best:** *"Use only the evidence supplied. Do not invent dates, attendees, owners, deadlines… Keep British English spelling… Do not mention MiniLM, Gemini, evidence packs…"*; knowledge Q&A must cite `[chunk:<id>]` and return JSON only. There is a real **golden-eval regression harness** with 20+ tagged real/synthetic transcripts.
- **Hygiene:** `node_modules` committed (~97% of tracked files, ~70MB); manual timestamped backups of source files committed inside a git repo; a fragile `runPsql` pipe-delimited compatibility layer; some numeric-ID string interpolation into SQL (mitigated by `Number()` coercion).
- **Secrets:** clean — all env-driven, nothing committed.
- **Relationship:** explicitly copies helixscribe-api's knowledge architecture as a *pattern*, never its infrastructure (see §1.3).

---

## 3. Shared patterns across repositories

**Where the ecosystem is consistent (mostly by convention, not by shared code):**

1. **Self-hosted-first infrastructure.** Docker Compose + Traefik + Let's Encrypt on a VPS is the deployment story for every web property (Platform API, Create, Website Builder, CND site, Trinzo effectively too). No Vercel/Netlify/managed PaaS anywhere.
2. **Local/owned AI over cloud APIs.** Ollama with custom Modelfiles is the primary LLM; Gemini is the only cloud model, used as fallback (Create) or rewrite layer (Trinzo). No OpenAI or Anthropic calls in production code anywhere, despite `openai` appearing in two package.jsons (both vestigial).
3. **The knowledge model: bucket → item → chunk → embedding**, with an embedding queue, retrieval with keyword fallback and a `retrieval_mode` diagnostic, and an `/ask` endpoint. Implemented three times (Platform, Create-embedded, Trinzo).
4. **Prompt house style:** British English enforced; evidence-grounding ("use only supplied material"); explicit anti-invention rules; banned-phrase/anti-slop lists; JSON-only structured outputs; abstention when evidence is weak. This is a genuine, distinctive engineering asset — but it is copy-pasted, not shared.
5. **Hand-rolled auth with PBKDF2 + signed tokens** — five implementations, no shared library, differing iteration counts (120k/210k/260k), token schemes and session models.
6. **Raw SQL, no ORM** in every backend (psycopg, pg, SQLite) with parameterisation in newer code.
7. **DB-as-queue background jobs** with claim/retry/dead-letter (Platform ×3, Trinzo).
8. **React patterns:** the two Vite apps share shadcn/Radix + Tailwind + Context-only state + react-router v6 + framer-motion; the Website Builder deliberately diverges (App Router + server actions + zero deps); mobile splits between expo-router (Run Smart) and React Navigation (Tennis).
9. **Design tokens:** Archivo is the brand typeface in CND, Create, Run Smart and Tennis; dark, gradient-heavy "premium AI" aesthetics recur.
10. **SEO as engineering:** prerender-at-build + sitemaps + `llms.txt` in both public web repos.
11. **AI-agent-driven development:** commit authors include Replit Agent, Claude, Miso and OpenClaw Assistant across five repos; `.claude/skills`, `.agents/` skill libraries and `skills-lock.json` files appear in multiple repos. *(fact from git history)*
12. **Naming/config conventions:** `app_key` tenancy scoping; env-var chains with sensible defaults; `VITE_*`/`EXPO_PUBLIC_*` prefixes where applicable; British English in code comments and content.

**Where standardisation would save real effort:** auth (5 implementations), the knowledge/RAG stack (3), prompt guardrails (3+), Docker/Traefik compose boilerplate (5), SEO prerender toolkit (2), API clients (each frontend hand-rolls fetch wrappers; Run Smart's generic client is the best and should be the template), and design tokens (each app re-declares Archivo + gradients).

---

## 4. Product strategy (inferred from evidence only)

**What HelixScribe is becoming** *(inference, high confidence)*: a **platform** — a self-hosted AI memory/knowledge engine with per-app tenancy — on top of which vertical apps are built quickly. The evidence: the Platform API's generic `app_key` tenancy and app-knowledge layer; Run Smart+ built as a pure tenant; Run Smart's deliberately generic `knowledgeClient.ts`; Trinzo copying the platform's shape for a separate deployment; Create spinning out of the same backbone; and the marketing line "not a chatbot… a system that learns your brand tone" — memory/grounding is the consistent differentiator across every product.

**How the products fit together** *(fact + inference)*: CND website (funnel) → Create (self-serve SaaS, the monetisable flagship) and Website Builder (managed agency tier) → Platform API (shared engine) → mobile apps (Run Smart+, Tennis) as consumer showcases and portfolio proof. Trinzo is a consultancy-facing sibling kept at arm's length.

**Overlap that exists today:**
- Create's embedded API vs the Platform API — the same knowledge/RAG/prompt features implemented twice, with Create's admin still pointing at the Platform. This is the biggest strategic fork in the codebase: either Create re-converges on the Platform or becomes fully standalone; currently it is neither.
- Website Builder vs Create: "website builder" branding on a CMS product vs an AI content product on a domain literally named `create` — the naming invites confusion (`helixscribe.com` hosts the CMS, `create.helixscribe.ai` the AI product).
- Two Supabase projects linger (one live for CND, one archived for Create's past).

**Opportunities with evidence behind them:**
- **Billing for Create** — the audit says the free pilot ends September and there is no way to take money. This is the single highest-value gap in the whole ecosystem.
- **Tennis app onto the platform** — it already ships an "Analyse with AI" feature on a dated third-party wrapper; the Platform's OpenAI-compat shim or app-knowledge layer could replace DanteAI and simultaneously fix the client-side key problem.
- **The OpenAI-compat shim** suggests intent to let external tools consume HelixScribe models *(inference, medium confidence)*.
- **Trinzo's evidence-grounded reporting** is a credible B2B product seed (audit/consultancy deliverables automation) if it graduates from internal tool.

**Missing products/integrations (evidence-based, not invented):** no billing anywhere in the ecosystem; no shared analytics/telemetry (Create builds founder-metrics from scratch, Tennis has nothing, CND has first-party events); no unified account across HelixScribe properties (Create accounts ≠ Platform accounts ≠ Website Builder users); no mobile app for Create despite the mobile-capable platform; no webhook/event integration between Website Builder client sites and the CRM-ish contacts data the agency already collects.

---

## 5. Code quality review — cross-cutting

**Recurring technical debt (in order of impact):**
1. **Repo hygiene: committed things that should never be committed.** `.venv` (helixscribe-api, 1,137 files), `node_modules` (trinzo, ~9,300 files), an Android **release signing keystore** (love-of-tennis), password hashes in source (website-builder), test-run artifacts and manual backup folders (helixscribe-api, trinzo), shell-accident files (`[api]`, `et --hard <sha>`).
2. **God files.** `app_knowledge_routes.py` 192KB, `workflow_v2_routes.py` 152KB, Create's `api/app.py` ~8,100 lines, `UpcomingMatches.js` 66KB, `utils/db.js` ~2,380 lines. The pattern: features accrete into the file that already owns the route.
3. **Duplicate/parallel implementations left standing.** Workflow v1 + v2; `AuthContext` + `AuthV2Context`; two suggestion engines in Run Smart; `ai_task_execution.py` shim + refactor package; legacy Supabase archives shipped in the production bundle; near-duplicate admin pages.
4. **Vestigial dependencies** (`openai` ×2, `@atproto/api`, `@microsoft/agents-*`, cheerio/html-parser, react-helmet + react-helmet-async, paper + elements) — misleading to every new engineer and to dependency scanners.
5. **No test culture for frontends/mobile.** Backends have real tests (Platform ~37 pytest modules, Trinzo golden evals); the React apps and both mobile apps have essentially none (smoke scripts at best).
6. **Single-process assumptions**: in-memory rate limiters (Platform), in-memory sessions (Trinzo), JSON-file storage (Website Builder), SQLite (Create) — all block horizontal scaling.
7. **Migration discipline is mixed**: forward-only SQL files + lazy `ensure_*_tables()` (Platform), imperative DDL with no migrations (Create), manual `run_sql_migration.js` (Trinzo).

**Recurring anti-patterns:** hardcoding config that has an env mechanism available (Tennis keys, CND anon key and blocked IP, Stripe key); "test" surfaces left in production paths (trinzo `-test` routes, Create test Stripe page); READMEs that describe a previous life of the repo.

**Particularly well-designed areas worth studying and reusing:**
- The Platform's `ai_task_execution_refactor/` package and its queue/retry/dead-letter machinery.
- The anti-slop prompt engineering system (banned patterns, British English maps, quality-check models) and the DB-versioned prompt registry.
- Trinzo's golden-eval harness and graceful-degradation ladder (Gemini → MiniLM-only).
- Run Smart's generic `knowledgeClient.ts` / `appKnowledge.ts` split and its safety-case test fixtures.
- Love of Tennis's `matchEnrichmentClient.js` network layer.
- CND's prerender/SEO pipeline.

**Improvements ranked by impact:** (1) rotate + purge the Tennis keystore and keys; (2) ship Stripe properly in Create; (3) converge Create's backend onto the Platform (or formally fork it — decide); (4) extract the shared auth + API client; (5) split the god files along the refactor package's example; (6) delete dead code/deps across all repos; (7) add error tracking everywhere; (8) move Website Builder to Postgres.

---

## 6. Reusable platform opportunities (ranked by long-term benefit)

1. **Authentication & tenancy service (highest ROI).** Five hand-rolled auth systems today. The Platform API's `(user_id, app_key, role)` model already exists and JIT-provisions users. Making it the single issuer (with a small shared TS/Python client library) collapses the most duplicated, most security-sensitive code in the company. Evidence it's wanted: Create still half-points at the Platform; Run Smart already uses it fully.
2. **The knowledge/RAG layer as *the* product API.** It exists, is multi-tenant, and has already been re-implemented twice by its own siblings (Create, Trinzo). Version it, document it as an external contract, and make Create and (if commercial boundaries allow) Trinzo consume it instead of cloning it.
3. **AI orchestration + prompt management.** The DB-versioned prompt registry, model-role routing, Ollama concurrency slots, quality-check pipeline and banned-phrase guardrails should be one shared library/service consumed by Create and Trinzo instead of three prompt cultures drifting apart. The `[CMD]` optimiser harness gives evaluation for free.
4. **Billing (Stripe) module.** Needed by Create now, Website Builder next *(inference)*. Build once, server-side, with webhooks and a `subscriptions` table pattern.
5. **Shared API client packages.** Run Smart's `knowledgeClient.ts` should be extracted to a package and used by every JS frontend; a Python equivalent for internal services.
6. **Notification/email service.** SendGrid wrappers exist twice (Platform `sendgrid_email.py`, Create `api/emails.py`); Expo push logic exists twice (both mobile apps). One shared service with templates.
7. **Design system.** Archivo + gradient/glass tokens + shadcn config as a package for the web apps; a tokens file for the mobile apps (both already have hand-rolled `designTokens`).
8. **Deployment/ops kit.** One documented Traefik+compose pattern, shared Sentry/uptime/backup conventions, and a secrets checklist — cheap and repays itself on every deployment.
9. **Analytics/audit logging.** CND's `analytics_events`, Create's `learn_events`/founder metrics and the Platform's in-app counters are three partial answers to one question.
10. **File handling** — lower priority; only Trinzo and Create handle uploads meaningfully today.

---

## 7. Design language

**Recurring decisions (consistent):** dark, gradient-heavy "premium AI" aesthetic; Archivo as the display typeface across CND, Create, Run Smart and Tennis; glassmorphism cards and glow accents; framer-motion micro-animation on the web; shadcn/Radix primitives on the web (accessibility baseline for free); British English copy everywhere; cookie-consent gates on both public sites.

**UX philosophy** *(inference from repeated evidence, high confidence)*: honesty and groundedness as brand values — anti-hallucination prompts, Run Smart's "restraint is progress" framing and its QA pass that removed overclaiming copy, Create's audit calling out features that pretend to be AI. The products try not to lie to users; the design language sells "engineered, not magic".

**Inconsistencies:** brand palettes differ per property (CND deep purple `#1c0c30` + teal `#58E1B4`; Create violet→blue→teal `#7C3AED→#0B85F4→#14B8A6`) — related but not a single system; the Website Builder shares no styling DNA with the rest (hand-written CSS, no tokens); Tennis mixes two component libraries plus hand-rolled tokens; Run Smart uses expo-router idioms while Tennis uses React Navigation. Mobile friendliness is strong where measured (Create has mobile smoke tests; both apps are mobile-native) but the Website Builder's public sites and admin have no documented responsive testing. Accessibility: Radix gives the web apps a decent baseline; Tennis has a custom text-wrapping lint rule; there is no a11y test suite anywhere.

---

## 8. AI architecture

**Providers in production:**
| Provider | Where | Used for |
|---|---|---|
| **Ollama (self-hosted)** | Platform API, Create API | All generation + embeddings on the Platform; primary generation in Create. Models: `llama3.2:3b`, `qwen2.5:0.5b`, `nomic-embed-text` (768-dim), custom Modelfiles `helixscribe-blog/-social/-quality-check/-email-campaign/-rewrite/-business-profile`, `openclaw-llama3.2-16k:3b` |
| **Google Gemini (AI Studio)** | Create (fallback), Trinzo (rewrite + Q&A) | `gemini-2.5-flash` / `-flash-lite`, `gemini-embedding-001` fallback |
| **sentence-transformers MiniLM** (local Python) | Trinzo | Evidence extraction + 384-dim embeddings |
| **DanteAI (gpt-3.5-turbo wrapper)** | Love of Tennis | Match summaries — legacy, key exposed client-side |

No OpenAI or Anthropic API usage exists in production code anywhere. *(fact, grep-verified per repo)*

**Prompts & prompt engineering:** three homes on the Platform — DB-versioned `system_prompts` with mapping/routing, code-built prompt builders, and the offline `[CMD]` DSL optimiser (genetic tuning with committed best-run artifacts). Create adds a keyed `prompt_registry.py` plus brand-leakage sentinels. Trinzo embeds prompts in its Python pipeline with the strictest evidence rules. Shared traits: British English, "use only supplied evidence", no invented facts/statistics/people, banned-phrase lists, JSON-schema-constrained output, quality-check second pass with a dedicated model.

**Context & memory:** the bucket→item→chunk model with edit-mode locking (locked / append_only / refine_only) is the memory system; Run Smart demonstrates the full loop (typed items → embedding queue → filtered vector retrieval → `ask`/`insight-blocks` with prompt versioning and server-side snapshot caching). Create's learning loop (edit diffs → proposed rules → human approve/reject → injected into prompts) is a second, distinctive memory mechanism.

**Embeddings:** pgvector on the Platform (nomic-embed, cosine `<=>`), pgvector-with-fallback in Trinzo (MiniLM 384-dim, `ivfflat`), SQLite-stored vectors in Create. Chunking ~950 chars with 120 overlap, top-k 10 (Platform).

**Model routing:** role-based (`router_model`, `analysis_model`, `embed_model`, per-profile draft/quality models) with env-chain fallbacks; per-user and global Ollama concurrency slots; Create routes Ollama-first with Gemini fallback; Trinzo degrades Gemini→MiniLM-only. The OpenAI-compat shim exposes the whole stack as `/v1/chat/completions`.

**Evaluation:** prompt-reliability routes, the CMD-vs-normal comparison harness and skeleton-item claim evaluations (Platform); a prompt-quality benchmark (Create); a golden-eval regression suite with real transcripts (Trinzo). Evaluation exists everywhere AI matters — unusual and commendable for a team this size — but each harness is bespoke.

**How it fits together:** one Ollama box is the beating heart *(fact for the Platform; Create points at the same host via `host.docker.internal`, so almost certainly the same instance — inference, high confidence)*. That gives cost control, privacy and fine-tuned house-style models, at the price of a single point of failure and a hard capacity ceiling (see risks).

---

## 9. Business risks, ranked by severity

1. **CRITICAL — committed Android signing keystore + live API keys in `love-of-tennis`.** Anyone with repo access (and the keystore password) could sign updates as the published app; the RapidAPI/DanteAI keys are abusable for cost. Action: rotate/rekey, purge from git history, fix `.gitignore` (`*.keystore`), proxy third-party APIs through the backend.
2. **HIGH — single-VPS, single-Ollama architecture with no visible backup/DR story.** Postgres, Ollama, SearXNG, Traefik and every product appear to live on one box (verified for the compose files; backup posture unverified — nothing in any repo mentions backups). One disk failure could take out the company. Action: automated off-site Postgres dumps + volume backups, documented restore drill.
3. **HIGH — no revenue mechanism.** Create's trial ends September (per its audit) with no billing path. Commercial risk rather than technical.
4. **HIGH — no observability.** No Sentry/APM/crash reporting in any repo; the mobile apps are blind in production; the Platform has only in-app counters. Failures will be discovered by users.
5. **MEDIUM-HIGH — auth sprawl.** Five bespoke auth systems multiply the chance one has a hole: Platform's permissive credentialed CORS (all `*.replit.app`) + public API docs + legacy token/sha256 fallbacks; Website Builder's committed hashes and unrevocable sessions; Trinzo's reset-token-in-response.
6. **MEDIUM — scalability ceilings baked in**: SQLite (Create), JSON files (Website Builder), in-memory rate limits/sessions, an in-process scheduler daemon. All fine at current scale; all cliff-edges under growth.
7. **MEDIUM — RLS dependency on the CND Supabase**: the anon key is public by design; if RLS on `contacts`/`blog_posts`/`analytics_events` is misconfigured, lead data leaks or content gets defaced. Needs a one-time audit (not verifiable from the repo).
8. **MEDIUM — key-person and agent-development risk**: one human maintainer with AI agents contributing heavily across seven divergent codebases; this document exists because the bus factor is 1.
9. **LOW-MEDIUM — vendor lock-in is actually low** (self-hosted everything, Gemini swappable, Supabase used narrowly) — the flip side is *self*-dependence: you are your own cloud provider.
10. **LOW — deploy-time coupling** (CND build fails if Supabase is down; unpinned Python deps make rebuilds non-reproducible).

---

## 10. Engineering roadmap (ranked by return on engineering time)

**Quick wins (< 1 day each):**
1. Rotate the Tennis keystore + all hardcoded keys; purge from history; add `*.keystore` to `.gitignore`. *(also risk #1)*
2. Remove `.venv` from helixscribe-api and `node_modules` from trinzo (git rm -r --cached + history rewrite when convenient); delete `Dockerfile.save`, `[api]`, `[scheduler]`, shell-accident files, obsolete prerender stubs.
3. Pin `requirements.txt`; disable public API docs and Replit CORS origins in Platform prod config; confirm `AUTH_DEBUG_RESET_TOKEN` is unset.
4. Add Sentry (or self-hosted GlitchTip, given the house style) to the two Python backends and both mobile apps.
5. Fix Website Builder's `siteStyle()` branding bug (feature already sold to the client).
6. Update stale READMEs (website-builder, trinzo) — cheap onboarding leverage.
7. Nightly `pg_dump` + volume snapshot cron with off-site copy.

**Medium projects (1–2 weeks):**
1. **Stripe billing in Create** — server-side checkout sessions, webhooks, subscription state, wire `BILLING_ENFORCED`. Highest commercial ROI in the ecosystem.
2. Extract the shared **HelixScribe JS client** from Run Smart and adopt it in Create's admin (kills three bespoke fetch layers).
3. Website Builder → Postgres (schema is small; removes the race-condition class) + persisted user management.
4. Run Smart launch checklist: device smoke test, token-expiry UX, store forms, fix slug drift, green typecheck.
5. Delete dead code at scale: Create's `legacy/` + stub pages + vestigial deps; Tennis's unused libraries; Run Smart's template scaffolding. (Faster builds, smaller bundles, honest dependency surface.)
6. Route Tennis's RapidAPI + AI calls through its backend (or the Platform), removing client-side keys.

**Major projects (1–3 months):**
1. **Converge Create onto the Platform API** (or formally decide to fork): one auth, one knowledge store, one prompt registry. This is the fork in the road — every month of delay grows both codebases apart.
2. **Split the god files**: finish the `ai_task_execution_refactor` pattern across `app_knowledge_routes.py` and `workflow_v2_routes.py`; break Create's `api/app.py` into routers/services; retire workflow v1.
3. **Shared auth/tenancy + billing as platform services** consumed by Create, Website Builder, and future apps.
4. **Ollama capacity & failover**: second inference node or a queue-with-priority + documented Gemini failover path across all consumers.
5. Test foundations: component tests for Create's V2 surface, unit tests for Run Smart's suggestion engine (pure functions — easy wins), CI that runs the existing pytest/golden-eval suites on every push (no CI exists in any repo today).

**Foundational work:** single sign-on across HelixScribe properties; a `helixscribe-core` monorepo or package registry for the shared client/auth/prompt libraries; migration framework (Alembic) for the Platform; secrets management (even `sops`/age files) replacing ad-hoc `.env`s on the VPS.

**Long-term vision** *(inference from trajectory)*: HelixScribe as a multi-app AI-memory platform with Create as the flagship revenue product, the Website Builder as the managed tier, mobile apps as showcases, and the OpenAI-compat surface as a possible API product. The engineering that serves that vision is exactly the consolidation above: one platform, one auth, one knowledge API, many thin apps.

---

## 11. Knowledge graph — how everything connects

```
                                USERS
   solo founders      agency clients      runners        tennis fans     Trinzo consultants
        │                  │                 │                │                  │
        ▼                  ▼                 ▼                ▼                  ▼
 ┌──────────────┐  ┌────────────────┐ ┌─────────────┐ ┌──────────────┐ ┌───────────────┐
 │ CREATE (SPA) │  │ WEBSITE BUILDER│ │ RUN SMART+  │ │ LOVE OF      │ │ TRINZO UPLOAD │
 │ create.helix │  │ helixscribe.com│ │ (Expo/EAS)  │ │ TENNIS (Expo)│ │ trinzo.       │
 │ scribe.ai    │  │ + nwr.virtual- │ │             │ │ published    │ │ virtual-hub   │
 └──────┬───────┘  │   hub.online   │ └──────┬──────┘ └──────┬───────┘ └───────┬───────┘
        │          └───────┬────────┘        │               │                 │
        │ core flows       │ JSON files      │ app_key=      │ legacy backend  │ own Postgres
        ▼                  ▼ on volume       │ run_smart     ▼ (hcgi/api) +    ▼ + pgvector
 ┌──────────────┐   (no shared infra)        │        RapidAPI/DanteAI   MiniLM + Gemini
 │ CREATE API   │                            │        (client-side keys)  (pattern-copy of
 │ FastAPI +    │────admin tools────┐        │                             platform, no
 │ SQLite       │                   ▼        ▼                             shared infra)
 └──────┬───────┘            ┌─────────────────────────┐
        │                    │  HELIXSCRIBE PLATFORM   │◄── CND website promotes everything
        │ Ollama-first,      │  api.helixscribe.cloud  │    (clairenicholsondigital.com,
        │ Gemini fallback    │  FastAPI · 31 routers   │     Supabase kedwh… : blog/leads/
        ▼                    │  auth · app-knowledge   │     analytics, GoHighLevel media)
 ┌─────────────────┐         │  RAG · tasks · workflows│
 │  SHARED VPS     │         └───────────┬─────────────┘
 │  Docker+Traefik │                     │ raw SQL + pgvector
 │  Let's Encrypt  │         ┌───────────┼─────────────────┐
 └─────────────────┘         ▼           ▼                 ▼
                      ┌────────────┐ ┌─────────┐  ┌──────────────┐
                      │ POSTGRES   │ │ OLLAMA  │  │ SearXNG      │
                      │ (self-host │ │ llama3.2│  │ (self-hosted │
                      │ +pgvector) │ │ +custom │  │  web search) │
                      └────────────┘ │ models  │  └──────────────┘
                                     └─────────┘
        External SaaS (narrow, deliberate): Supabase (CND data + Platform JWT issuer),
        Google Gemini, SendGrid, Expo/EAS+FCM, Stripe (test only), GoHighLevel,
        Power Automate (Trinzo), Acast/RapidAPI/DanteAI (Tennis legacy)
```

**In words:** users reach five product surfaces. Two of them (Create's core, Run Smart+) run on HelixScribe engines — Run Smart directly on the central Platform, Create on an embedded copy that still leans on the Platform for admin. The Platform sits on self-hosted Postgres+pgvector, a single Ollama instance with custom fine-tuned models, and SearXNG for research — all Docker/Traefik on what appears to be one VPS. The Website Builder and Trinzo deliberately do *not* share that infrastructure (files-on-volume and a separate Postgres respectively), and Love of Tennis predates it entirely. The CND website is the marketing layer over the top, running on the ecosystem's only live Supabase project. External SaaS is used narrowly and deliberately: Gemini as the only cloud model, SendGrid for email, Expo for mobile delivery, Supabase as a JWT issuer and one site's datastore.

---

## 12. What I would do differently, designing this ecosystem from scratch today

Taking the same goals — AI products grounded in user memory, self-hosted models, a solo-founder-plus-agents team — here is what I would change, and what I would deliberately keep.

**Keep (these were good calls):**
- **Self-hosted Ollama with custom Modelfiles.** Cost, privacy and a differentiated house voice. I would keep it — but add a documented cloud failover from day one.
- **The bucket→item→chunk memory model with app_key tenancy.** It has proven itself three times over. It *is* the platform.
- **The evidence-grounded, British-English, anti-slop prompt culture and the evaluation harnesses.** This is rarer than the code around it.
- **Traefik + Docker on owned infrastructure** — appropriate for the economics; just with backups and monitoring as part of the definition of "deployed".

**Change:**
1. **One backend, from the start.** The single costliest decision in this ecosystem was letting Create grow an embedded clone of the Platform (SQLite, own auth, own RAG) while its admin still points at the real one. From scratch: the Platform API is the *only* backend; Create, Website Builder and every app are thin clients with their own UX but no own datastore beyond caches. Trinzo's commercial isolation could still be honoured with a separate *deployment* of the same codebase rather than a pattern-copy.
2. **One identity.** A single auth service (the Platform's, hardened: no legacy fallbacks, short-lived tokens, revocation) with one shared client library in TS and Python. Never five PBKDF2 implementations.
3. **A small monorepo for shared code** (`platform-client-ts`, `platform-client-py`, `prompt-guardrails`, `design-tokens`, `traefik-deploy-kit`) — the repos can stay separate per product, but the seams that are currently copy-pasted would be packages.
4. **Postgres everywhere, one instance, many schemas/databases.** No SQLite in a product with paying-user ambitions, no JSON files as a database. pgvector is already the standard — make it universal.
5. **TypeScript on every frontend** and one web stack (the shadcn/Vite pattern is fine; the Website Builder's zero-dependency App Router experiment is elegant but created a third styling culture for no product reason).
6. **Billing and observability before beta, not after.** Stripe webhooks + Sentry + uptime checks + nightly backups are a week of work at the start and a permanent scramble when retrofitted. Create reaching a public trial deadline with no payment path is the avoidable emergency here.
7. **Repo hygiene enforced by machines, not memory.** Pre-commit hooks + CI secret scanning + `.gitignore` templates would have prevented every committed keystore, venv, node_modules and password hash in this review. Given how much code is written by AI agents, automated gates matter *more* here, not less: agents faithfully commit whatever the working tree contains.
8. **Name the tiers honestly.** "Website Builder" (a CMS), "Create" (the AI product), `helixscribe.com` vs `.ai` vs `.cloud` vs `.co.uk` — from scratch I would put the marketing site on the apex, the app on one subdomain, the API on another, and give the managed-CMS tier a name that doesn't collide with the AI builder.
9. **Fold the mobile apps into the platform pattern from day one.** Run Smart shows the right shape (thin client + platform memory + on-device deterministic logic). Tennis shows what happens without it: client-side keys, a legacy backend, and an unmaintainable outlier.
10. **Write this document first.** The ecosystem's best repos already do this instinctively (the Platform's runbooks, Create's self-audit, Trinzo's roadmap doc). Making "the doc is part of the feature" a rule is free and is the only thing that scales a bus-factor-of-one company.

---

*Compiled from a full read of all seven repositories on 7 July 2026. Facts are file-grounded; inferences are marked with confidence levels. Corrections welcome — treat this as a living onboarding document.*
