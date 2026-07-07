# 90-Day Execution Plan

**Date:** 7 July 2026 · **Derived from:** `docs/ECOSYSTEM_ARCHITECTURE_REVIEW.md`
**Team assumption:** one main developer + AI coding agents. Agents do the mechanical sweeps (dead code, config, boilerplate, tests); the developer owns decisions, secrets, deploys and anything touching money or signing keys.

**Selection rule:** a task is in this plan only if it (a) reduces business risk, (b) enables revenue, or (c) prevents architectural pain that gets more expensive every month. Everything else was cut — see "Deliberately not in this plan" at the end.

**The three bets this plan makes:**
1. **Create is the revenue product.** Billing ships in weeks 2–4, before anything architectural.
2. **The Platform API is the future.** Create converges onto it in month 2 rather than growing further apart.
3. **You are your own cloud provider**, so backups, monitoring and secrets hygiene are product features, not chores.

---

## Phase 1 — Week 1: emergency fixes

Stop the bleeding: leaked signing material, no backups, no visibility, known auth holes. Nothing here takes more than a day; most take an hour or two.

### 1.1 Rotate and purge the Tennis signing keystore and API keys
- **Repo:** `love-of-tennis`
- **Files:** `release.keystore` (git-tracked), `.gitignore` (add `*.keystore`), `liveMatchesService.js:6` (RapidAPI key), `AIAnalysis.js:54` (DanteAI key), `NotificationScheduler.js:10` + `TennisNewsNotifications.js:10` (Apps Script webhook URL), `google-services.json`, `GoogleService-Info.plist`, `app.config.js` (env-var plumbing already exists — use it)
- **Why it matters:** anyone with repo access can potentially sign malicious updates as the published app and burn your RapidAPI quota. This is the single worst finding in the ecosystem.
- **Risk if skipped:** app-identity compromise on a live App Store product; API-cost abuse; the exposure grows with every clone/fork/agent that touches the repo.
- **Size:** quick (rotation + `.gitignore` same day; history purge with `git filter-repo` can follow once nothing else is mid-flight on the repo)
- **Dependencies:** none. Developer-only task — do not delegate key handling to agents.
- **Done when:** new keystore generated and stored outside git (password manager + offline copy); new RapidAPI/DanteAI keys issued and old ones revoked; keys read from env/EAS secrets; history rewritten and force-pushed; a fresh clone contains no keystore and no keys; app still builds and pushes notifications.

### 1.2 Nightly backups with an off-site copy and a tested restore
- **Repo:** none (VPS) — document the runbook in `helixscribe-api/docs/` (e.g. `docs/backup_restore_runbook.md`)
- **Files:** new cron/systemd timer on the VPS; covers self-hosted Postgres (`pg_dump` of `helixscribe` + Trinzo's DB), the Website Builder data volume (`helixscribe_website_builder_data` — `sites.json`, `contacts.json`, `event-calendars.json`, uploads), Create's SQLite file (`CREATE_API_DB_PATH`), Traefik/LE certs
- **Why it matters:** every product, every customer record and every fine-tuned model config appears to live on one box. No repo shows any backup mechanism.
- **Risk if skipped:** one disk failure or bad `rm` ends the company's data. This is the highest-severity risk after the keystore.
- **Size:** quick
- **Dependencies:** none
- **Done when:** nightly dumps run, are copied off the VPS (object storage or even a second cheap box), retention is set, and **one restore has actually been performed** into a scratch database/volume and verified. An untested backup is a hope, not a backup.

### 1.3 Harden the Platform API's production posture
- **Repo:** `helixscribe-api`
- **Files:** `app_main.py:190-201` (CORS: remove `*.replit.app` / `*.replit.dev` / localhost from the credentialed allowlist in prod; align with the divergent Traefik CORS labels in `docker-compose.yml`), env config (`HELIXSCRIBE_API_DOCS_ENABLED=false`; confirm `AUTH_DEBUG_RESET_TOKEN` is unset on the VPS), `auth_routes.py` (verify the debug path is dead), `requirements.txt` (pin versions while you're in there)
- **Why it matters:** any Replit-hosted page can currently make credentialed calls against the API that holds all user knowledge; `/docs` advertises the full attack surface; the debug reset token is a standing backdoor if ever set.
- **Risk if skipped:** credentialed CSRF-style access to user data; trivially mapped API surface; unreproducible builds when a transitive dep breaks.
- **Size:** quick
- **Dependencies:** check whether any Replit-hosted dev frontends still need access (Run Smart's docs reference a Replit app URL); if so, allowlist that one exact origin, not the wildcard.
- **Done when:** prod CORS lists only real origins (create.helixscribe.ai, admin surfaces); `/docs` and `/openapi.json` return 404 in prod; debug token confirmed unset; `pip install -r requirements.txt` is reproducible; smoke tests still pass from real origins.

### 1.4 Error tracking on the two Python backends
- **Repo:** `helixscribe-api`, `helixscribe-create-official`
- **Files:** `helixscribe-api/app_main.py` + `api_errors.py` (init hook), `helixscribe-create-official/api/app.py` + `api/config.py` (DSN env var), both `docker-compose.yml` files
- **Why it matters:** there is no Sentry/APM anywhere. With billing about to launch (task 2.1), you cannot run a paid product where the first error report comes from a customer.
- **Risk if skipped:** silent failures in generation, auth and (soon) payment webhooks; debugging by user complaint.
- **Size:** quick (sentry-sdk FastAPI integration is ~10 lines per service; self-hosted GlitchTip is an option consistent with the self-hosting ethos, but hosted Sentry free tier is the fastest path — pick one, don't deliberate)
- **Dependencies:** none
- **Done when:** an unhandled exception in each backend appears in the dashboard with release + environment tags, and alerts reach your inbox/phone.

### 1.5 Audit RLS on the CND website's Supabase project
- **Repo:** `clairenicholsondigital-website` (policies live in Supabase project `kedwhanehzknoywrssve`, not in the repo)
- **Files:** reference `src/lib/customSupabaseClient.js` (hardcoded anon key — the reason this matters), tables `contacts`, `blog_posts`, `analytics_events`, `blog_settings`, `redirects`, `head_snippets`, `page_seo_settings`, storage bucket `blog_images`
- **Why it matters:** the anon key ships in the browser bundle by design; RLS is the *only* thing between the public and your lead pipeline (`contacts`) or blog defacement (`head_snippets` allows arbitrary head-code injection — if that table is anon-writable, it's stored XSS on the agency's front door).
- **Risk if skipped:** lead-data leak (GDPR exposure for a UK business) or site compromise via injected head snippets.
- **Size:** quick
- **Dependencies:** none
- **Done when:** anon role verified as insert-only on `contacts`/`analytics_events`, read-only on published `blog_posts`, and no access to `head_snippets`/`redirects`/settings writes; verified with an anon-key `curl` attempt, not just by reading the dashboard.

---

## Phase 2 — Weeks 2–4: revenue and reliability

One goal dominates: **Create can take money before the free pilot ends in September.** Everything else in this phase protects products that are already in users' hands.

### 2.1 Real Stripe billing in Create ⭐ the revenue task
- **Repo:** `helixscribe-create-official`
- **Files:** new `api/billing.py` (checkout session creation, customer portal, webhook handler with signature verification); `api/app.py` (mount router; add `subscriptions`/`stripe_customers` tables next to the existing DDL at `:907-1106`; extend `_require_active_generation_access` at `:1242-1254` to honour subscription state); `api/config.py` (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, price IDs — extend the boot-time secret guard at `:119-129`); `docker-compose.yml` (`BILLING_ENFORCED=true`, new env); frontend: `src/lib/stripe.js:4` (env-driven publishable key), pricing page CTA, `TrialBanner`/`TrialExpiredModal` upgrade paths; delete `src/pages/admin/AdminStripeCheckoutPage.jsx` (deprecated client-only checkout)
- **Why it matters:** the product works end-to-end and has trial users, and the internal audit's verdict stands: *"there is no way to take money."* This is the only task in 90 days that directly creates revenue.
- **Risk if skipped:** the pilot ends with momentum and no conversion path; every other investment in Create returns nothing.
- **Size:** medium (1–2 weeks including test-mode E2E; the trial-gating scaffold already exists, which shortens this)
- **Dependencies:** 1.4 (you want webhook failures visible from day one). Live Stripe keys handled by the developer only.
- **Done when:** a test-mode user can subscribe via Checkout, webhooks (`checkout.session.completed`, `invoice.paid`, `customer.subscription.updated/deleted`) update local subscription state, expired-trial users are blocked from generation and shown the upgrade path, cancellation via the customer portal downgrades correctly, and one real live-mode transaction has been executed and refunded.

### 2.2 Crash reporting + minimal analytics in both mobile apps
- **Repo:** `Run-Smart-Decision`, `love-of-tennis`
- **Files:** Run Smart: `artifacts/mobile/app/_layout.tsx` (init), `app.json` (plugin), existing `ErrorBoundary`. Tennis: `App.js` (init), `app.json`
- **Why it matters:** one app is published (Tennis, versionCode 53), one is about to launch (Run Smart). Neither has any telemetry — production issues are invisible.
- **Risk if skipped:** Run Smart launches blind; Tennis regressions surface as App Store reviews.
- **Size:** quick per app (sentry-expo)
- **Dependencies:** none; ship with the next OTA/build of each app.
- **Done when:** a forced test crash from a device build appears in the dashboard for both apps, tagged with release/OTA channel.

### 2.3 Run Smart+ launch checklist
- **Repo:** `Run-Smart-Decision`
- **Files:** `artifacts/mobile/app.json` (fix slug drift `mobile` → `run-smart-plus` — verify OTA `runtimeVersion` implications before changing), typecheck fixes (BlurView/GestureHandler/LinearGradient JSX typings flagged in `docs/run-smart-end-to-end-qa.md`), `context/AuthContext.tsx` + `utils/auth.ts` (token-expiry UX verification on device), `eas.json` (add iOS profiles if iOS is in scope this quarter — otherwise explicitly Android-first), store data-safety forms (console work, not code)
- **Why it matters:** the product is one focused week from launch; its remaining gaps are exactly the ones its own QA docs list. Shipping it converts months of prior work into a live product.
- **Risk if skipped:** a 95%-done product decays (Expo SDK drift, store policy changes) and the platform's flagship tenant never proves the platform.
- **Size:** medium (~1 week)
- **Dependencies:** 2.2 (launch with crash reporting). EAS internal build needs a physical device.
- **Done when:** EAS internal build smoke-tested on a real device (register → profile → suggestion → log → insight → logout/expiry → delete account), typecheck green, store listing + data-safety forms submitted, v1.0.x live on Play (and TestFlight if iOS is in scope).

### 2.4 Move Tennis's third-party API calls server-side
- **Repo:** `love-of-tennis` (+ its backend at `for.theloveoftennis.co.uk/hcgi/api`, which is not in this workspace — if that backend is hard to change, add a thin proxy route on the Platform API instead)
- **Files:** `liveMatchesService.js` (point at proxy, delete key handling), `AIAnalysis.js` (same — and this is the natural moment to swap DanteAI/gpt-3.5 for the Platform's `/v1/chat/completions` shim in `helixscribe-api/openai_compat_routes.py`), backend proxy endpoints with caching
- **Why it matters:** completes 1.1 — rotated keys are only safe if they stop shipping in the client bundle. Piggybacks a product win: match analysis moves onto your own models, cutting a legacy vendor.
- **Risk if skipped:** the new keys leak exactly like the old ones at the next `eas build`; DanteAI remains an unmonitored dependency.
- **Size:** medium
- **Dependencies:** 1.1 (new keys), decision on where the proxy lives (existing tennis backend vs Platform API — prefer whichever you can deploy fastest; the Platform already has rate limiting and an Ollama路 shim).
- **Done when:** the shipped bundle contains zero third-party API keys (verified by grepping the built JS bundle), live scores and AI analysis work through the proxy with caching, and an OTA update has rolled it out.

### 2.5 Fix the Website Builder's two client-facing defects
- **Repo:** `helixscribe-website-builder`
- **Files:** `app/sites/[slug]/[[...pagePath]]/page.tsx:41-46` (`siteStyle()` ignores the tenant's branding — apply the saved palette to `--site-*` CSS vars); `app/api/public-calendar-event/route.ts` + `app/api/public-event-rsvp/route.ts` + `app/actions.ts:466-492` (add per-IP rate limiting, honeypot field, and payload caps to the unauthenticated public writes)
- **Why it matters:** a paying agency client (NWR) is using a branding feature that silently does nothing, and their public calendar accepts unauthenticated writes with no abuse controls.
- **Risk if skipped:** client trust damage when they notice; calendar spam/defacement on a domain carrying the client's name.
- **Size:** quick
- **Dependencies:** none
- **Done when:** branding changes made in `/dashboard/branding` visibly render on `nwr.virtual-hub.online`; a scripted burst against the public endpoints gets rate-limited; existing calendar flows still work.

---

## Phase 3 — Month 2: platform consolidation

The strategic month. The review's central finding: the same platform has been built three times, and Create — the revenue product — is the costly middle case (own SQLite, own auth, own RAG, admin half-pointed at the real platform). Month 2 stops the divergence.

### 3.1 Decide: converge Create onto the Platform, or formally fork (½ day, gates everything below)
- **Repo:** decision recorded in both `helixscribe-create-official/docs/` and `helixscribe-api/docs/`
- **Why it matters:** every subsequent task's shape depends on it. The plan below assumes **converge**, which the evidence favours (admin already calls the Platform; the Platform's knowledge layer is a superset; two backends is double maintenance for a team of one). If you choose fork instead, replace 3.3/3.4 with "Create on Postgres + Alembic" and delete the admin's Platform dependencies.
- **Risk if skipped:** month 2 becomes drift-management instead of consolidation; both codebases keep growing apart at AI-agent speed.
- **Done when:** a one-page ADR exists stating the decision, the migration order, and what happens to Create's SQLite data.

### 3.2 Extract the shared HelixScribe API client
- **Repo:** new small package repo (or `packages/` in `helixscribe-api`); consumers: `Run-Smart-Decision`, `helixscribe-create-official`
- **Files:** source of truth is `Run-Smart-Decision/artifacts/mobile/utils/knowledgeClient.ts` (already written as a "generic, reusable HelixScribe API client") + auth patterns from `utils/auth.ts`; replace Create's hand-rolled `src/lib/helixscribe-admin-api.js`, `src/lib/knowledgeBucketApi.js`, `src/lib/helixscribe-utils.js`
- **Why it matters:** it is the cheap first step of convergence (no data migration), kills three divergent fetch layers, and creates the seam every future app uses.
- **Risk if skipped:** convergence work in 3.3/3.4 gets hand-rolled a fourth time.
- **Size:** medium (agent-friendly: extraction + adoption is mechanical; the developer reviews the auth-token handling)
- **Dependencies:** 3.1
- **Done when:** one published/vendored package (`@helixscribe/client` or similar) with typed auth + app-knowledge methods; Run Smart and Create's admin both consume it; Create's three bespoke API libs are deleted.

### 3.3 Single auth issuer: Create validates Platform identities
- **Repo:** `helixscribe-create-official`, `helixscribe-api`
- **Files:** Create: `api/app.py` (JWT validation swapped to Platform-issued tokens; user rows keyed by platform user id), `src/lib/createAuthClient.js` (login/register against `api.helixscribe.cloud` with `app_key: 'create'`), consolidate `AuthContext` + `AuthV2Context` into one; Platform: `auth_dependencies.py` / `auth_routes.py` (ensure `app_key='create'` membership + roles cover Create's `platform_owner/super_admin/admin` checks in `src/components/routes/RouteProtection.jsx:36`)
- **Why it matters:** auth is the most duplicated security-sensitive code in the company (five implementations). Create is the highest-value consumer; after this, HelixScribe accounts are one identity, enabling cross-product SSO later.
- **Risk if skipped:** two account systems forever under one brand; every auth bug fixed twice; password databases in two places.
- **Size:** major (the code is medium; user migration — existing Create users' password hashes moving to the Platform's PBKDF2 scheme or a forced-reset flow — is what makes it major)
- **Dependencies:** 3.1, 3.2; do **not** start until billing (2.1) has been stable for a couple of weeks — don't destabilise auth while payment webhooks are bedding in. Sequence trial/subscription state carefully: billing state stays in Create's DB, keyed by the platform user id.
- **Done when:** new registrations and logins in Create go through the Platform; existing users migrated or reset with comms; both legacy auth contexts deleted; billing and admin role gates verified working against platform identities.

### 3.4 Create's knowledge/RAG onto the Platform's store
- **Repo:** `helixscribe-create-official`, `helixscribe-api`
- **Files:** Create `api/app.py` (replace local `app_knowledge_buckets/items/chunks` SQLite tables + embedding calls with Platform `/app-knowledge/*` calls via the shared client, or — if latency argues for it — direct Postgres access as a second Platform service); one-off migration script SQLite → Platform buckets; Platform `app_knowledge_routes.py` (any missing capabilities Create needs, e.g. its hybrid keyword+vector retrieval nuances)
- **Why it matters:** ends the SQLite scale ceiling and the duplicate RAG implementation in one move; Create's data lands in the store that already has queues, retries and tenancy.
- **Risk if skipped:** the revenue product sits on a single SQLite file with no migrations as its user count grows — the most predictable future incident in the ecosystem.
- **Size:** major
- **Dependencies:** 3.3 (users must be platform identities first so bucket ownership maps cleanly); 1.2 (backups) before any data migration.
- **Done when:** generation in Create retrieves from Platform-hosted buckets; migrated users' source material and learned rules intact (spot-check against pre-migration exports); SQLite knowledge tables dropped; Create's `api/app.py` shrinks accordingly.

### 3.5 CI across the five active repos
- **Repo:** `helixscribe-api`, `helixscribe-create-official`, `helixscribe-website-builder`, `Run-Smart-Decision`, `trinzo-upload`
- **Files:** `.github/workflows/ci.yml` in each — run what already exists: Platform's ~37 pytest modules, Create's Playwright smoke scripts + ESLint, Trinzo's golden-eval + node/python tests, Run Smart's typecheck (green after 2.3), Website Builder's `tsc`/build; plus secret scanning (gitleaks) everywhere
- **Why it matters:** no repo has CI. With AI agents authoring much of the code, machine gates are the review layer that scales; secret scanning is what prevents the next keystore incident (this is the direct institutional fix for finding 1.1).
- **Risk if skipped:** month-2's large refactors land unguarded; regressions and leaked secrets discovered in production.
- **Size:** medium total (quick per repo; highly agent-delegable)
- **Dependencies:** none technically, but land it **before** 3.3/3.4 merge — those are the changes it exists to protect.
- **Done when:** every push to the five repos runs tests + secret scan; a deliberately planted fake key fails the build; the convergence PRs of 3.3/3.4 merge green.

### 3.6 Website Builder onto Postgres
- **Repo:** `helixscribe-website-builder`
- **Files:** `lib/sites.ts`, `lib/contacts.ts`, `lib/event-calendars.ts`, `lib/map-groups.ts`, `lib/crm-imports.ts` (swap JSON read-modify-write for a Postgres data layer — the interfaces are already clean); `lib/auth.ts` (move the hardcoded user array + committed password hashes into a `users` table; rotate both passwords); `docker-compose.yml` (join the existing Postgres network); migration script for the JSON volume
- **Why it matters:** removes the lost-write race condition on a system holding a real client's CRM data, and gets production password hashes out of git. Uses the Postgres you already run — no new infrastructure.
- **Risk if skipped:** concurrent edits silently lose client data; the product cannot take tenant #2 (which is its whole premise).
- **Size:** medium
- **Dependencies:** 1.2 (backups first); independent of the Create work, so it can interleave.
- **Done when:** all reads/writes hit Postgres; JSON files migrated and archived; both passwords rotated and hashes removed from source (then purged from history); user management persists via the existing `/user-management` UI; NWR's site, CRM and calendars verified intact.

---

## Phase 4 — Month 3: clean-up and standardisation

Lock in the gains. Everything here is cheap individually and mostly agent-delegable; its value is preventing the next generation of drift.

### 4.1 Repo-history hygiene sweep
- **Repo:** `helixscribe-api` (committed `.venv/` — 1,137 of 1,435 tracked files; `Dockerfile.save`; `[api]`/`[scheduler]` zero-byte files; committed test-run artifacts and 105KB workflow exports), `trinzo-upload` (committed `node_modules/` — ~97% of tracked files; `scripts/backups/` manual copies), `love-of-tennis` (`et --hard <sha>` files, `=0.8.1`, `%ProgramData%`)
- **Why it matters:** clone size, agent context pollution (agents read the repo — a repo that is 79–97% junk wastes every agent run), and the professional-hygiene baseline for any future hire, investor or client audit.
- **Risk if skipped:** compounding friction on every clone, CI run and agent task; the junk normalises more junk.
- **Size:** quick per repo (`git rm -r --cached` + `git filter-repo`; coordinate force-pushes with 1.1's history rewrite where applicable)
- **Dependencies:** CI (3.5) in place so nothing regresses; no other work mid-flight on the repo being rewritten.
- **Done when:** fresh clones contain no venv/node_modules/backup folders/shell accidents; repo sizes drop accordingly (helixscribe-api well under 5MB, trinzo under 15MB); builds still pass from a clean clone.

### 4.2 Dead code and vestigial dependency purge
- **Repo:** all seven; the big three:
  - `helixscribe-create-official`: delete `legacy/` (supabase-archive + personal-admin-archive), ~12 V2 stub pages, unreachable legacy pages, near-duplicate admin files (`AdminKnowledgeBucketList*` variants), deps `openai`, `@atproto/api`; decommission the archived Supabase project `fnukrzlhqmodflfnyhzl` (console task)
  - `love-of-tennis`: deps `react-native-cheerio`, `react-native-html-parser`, `react-native-xml2js`, `rss-parser`, `react-native-calendar` (singular), one of paper/elements
  - `Run-Smart-Decision`: `artifacts/api-server/`, `lib/db`, `lib/api-spec`, `lib/api-zod`, `lib/api-client-react`, `mockup-sandbox/` (superseded by the real product + shared client from 3.2)
  - Plus both Horizons `plugins/` trees (Create + CND site), CND's dup helmet lib and obsolete prerender stubs, Trinzo's unused `@microsoft/agents-*`/`openai` deps
- **Why it matters:** post-convergence (3.3/3.4), a lot of this code is not just dead but *misleading* — it describes an architecture that no longer exists. Dead deps also feed false positives to the new secret/vuln scanning.
- **Risk if skipped:** every future agent and engineer wastes time reading and preserving code that lies about the system.
- **Size:** medium in aggregate, near-fully agent-delegable with CI as the safety net
- **Dependencies:** 3.3/3.4 merged (don't delete legacy auth until the new auth is proven); 3.5 (CI green gates each deletion PR).
- **Done when:** each repo builds and passes CI with the deletions in; bundle sizes measurably drop (record before/after); `depcheck`/`pip-extra-reqs` style scans come back clean; READMEs in `helixscribe-website-builder` and `trinzo-upload` rewritten to describe what the repos actually are.

### 4.3 Split the god files along the proven pattern
- **Repo:** `helixscribe-api` (primary), `helixscribe-create-official` (whatever remains of `api/app.py` after 3.3/3.4)
- **Files:** `app_knowledge_routes.py` (192KB) and `workflow_v2_routes.py` (152KB) decomposed following the in-repo exemplar `ai_task_execution_refactor/` (routes → services → persistence); retire workflow **v1** (`workflow_routes.py`) after confirming no live consumers (check NWR workflow apps); dedupe the re-implemented helpers (`_env_*`, `row_get`, `_safe_text`, rate-limiter copies) into shared modules
- **Why it matters:** these two files are where most future platform work will land — post-convergence they serve *all* products. Their current size makes every change risky and every agent edit context-starved.
- **Risk if skipped:** change velocity on the platform keeps dropping exactly as the platform becomes load-bearing for everything.
- **Size:** major (mechanical but large; agents execute module-by-module with the pytest suite + CI as the harness)
- **Dependencies:** 3.4 (know what Create needs from these routes before reshaping them); 3.5.
- **Done when:** no route file exceeds ~1,000 lines; workflow v1 deleted or explicitly documented as frozen; pytest suite green throughout; helper duplication measurably reduced (one `env_utils`, one rate-limit module).

### 4.4 One deploy/secrets pattern for the VPS fleet
- **Repo:** all deployed repos; documented once in `helixscribe-api/docs/deploy_standard.md`
- **Files:** the five near-identical `docker-compose.yml` files (Platform, Create, Website Builder, CND site, Trinzo's ad-hoc `nohup` — bring Trinzo into compose); standardise Traefik labels, health checks, restart policies, log rotation; adopt one secrets mechanism (even `sops`-encrypted env files in a private ops repo) replacing hand-edited `.env`s on the box; align the Platform's duplicate CORS definitions (FastAPI vs Traefik) left from 1.3
- **Why it matters:** you run five-plus services on owned infrastructure; the marginal cost of every future service should be a copied template, not archaeology. Trinzo running under `nohup` is the reliability outlier.
- **Risk if skipped:** snowflake deploys keep accumulating; the next incident's first hour is spent rediscovering how each service runs.
- **Size:** medium
- **Dependencies:** 1.2 (backup paths become part of the standard)
- **Done when:** every service (including Trinzo) runs under compose with the standard template; secrets provisioned through the one mechanism; a new-service checklist exists; a reboot of the VPS brings everything back healthy without manual steps.

### 4.5 Uptime monitoring and alerting
- **Repo:** none (ops) — config alongside 4.4's docs
- **Files:** external uptime checks on `api.helixscribe.cloud/health`-equivalent, `create.helixscribe.ai`, `clairenicholsondigital.com/health`, `helixscribe.com`, `trinzo.virtual-hub.online`, plus an Ollama liveness probe (`OLLAMA_MONITORING_TOKEN` endpoint already exists in the Platform)
- **Why it matters:** completes the observability story from 1.4/2.2: crashes are visible; now outages are too. The single-Ollama dependency especially needs a heartbeat — when it stalls, every AI feature in two products degrades at once.
- **Risk if skipped:** downtime discovered by customers; Ollama saturation misdiagnosed as app bugs.
- **Size:** quick
- **Dependencies:** 1.4
- **Done when:** all public endpoints + Ollama are probed on a schedule with phone-reaching alerts, and one simulated outage (stop a container) produced an alert within minutes.

---

## Sequencing at a glance

```
Week 1     1.1 keystore/keys → 1.2 backups → 1.3 API hardening → 1.4 Sentry(backends) → 1.5 RLS audit
Weeks 2-4  2.1 STRIPE ██████████ (the priority)
           2.2 mobile Sentry → 2.3 Run Smart launch ██████
           2.4 tennis proxy ████   2.5 website-builder fixes ██
Month 2    3.1 ADR → 3.2 shared client ███ → 3.3 single auth ██████ → 3.4 knowledge convergence ██████
           3.5 CI ███ (before 3.3 merges)      3.6 website-builder→Postgres ████ (interleaved)
Month 3    4.1 history hygiene ██  4.2 dead-code purge ████  4.3 god-file split ██████
           4.4 deploy standard ███  4.5 uptime ██
```

**Developer-only (never delegate):** 1.1, 1.2, 1.5, live Stripe keys in 2.1, user migration in 3.3, force-pushes in 4.1.
**Agent-heavy (delegate with CI as the harness):** 2.4's mechanical parts, 3.2, 3.5, 3.6's data-layer swap, all of 4.1–4.3.

## Deliberately NOT in this plan (and why)

- **Tennis app restructure** (flat layout, 66KB screens, React Navigation → expo-router): it's published and stable; security is fixed by 1.1/2.4; a rewrite returns less than everything above.
- **Design system / shared UI tokens package:** real value, but it saves polish time, not risk or revenue. Revisit in Q4 when there's a second web product actively styled.
- **Ollama second node / HA inference:** monitor first (4.5); buy hardware only when saturation is observed, not predicted. Create already has a Gemini fallback; document the manual failover instead.
- **SSO across all properties, notification service, shared analytics platform:** correct end-states, premature until 3.3 proves single identity on one product.
- **Trinzo productisation** (sessions in Postgres, per-request Python → worker pool): it's internal, its users are in the building, and its commercial boundary is unresolved. Fix nothing beyond bringing it into compose (4.4) and CI (3.5).
- **Alembic migration framework for the Platform:** the forward-only SQL + runbook pattern is working; adopt Alembic opportunistically during 4.3, not as its own project.
- **CND website changes** beyond the RLS audit: it's the healthiest deployed asset in the fleet. Leave it alone.

---

*If only three things get finished in 90 days, make them: **the keystore rotation (1.1), backups (1.2), and Stripe billing (2.1)**. Everything else compounds; those three are existential.*
