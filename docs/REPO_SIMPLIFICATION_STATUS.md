# Repository simplification status

Runtime snapshot: [PR #233](https://github.com/clairenicholsondigital/trinzo-upload/pull/233),
deployed revision `65b6a9dbb8300c27d07776b9a9d7fadcb8025f8f`, tested tree
`ed710d0b7e3da8b886193b4c5aeb8b913fd96056`.
[Live product map](LIVE_PRODUCT_MAP.md) gives current implementation owners.

This cleanup has reduced tracked dependency/research clutter and established
clearer owners for generation, review, persistence and publication. Own source, including tests, tools and generated code,
is slightly larger overall. Shared modules still select broad regression
coverage. These results support closing the bounded cleanup phase with the
exceptions below; they do not establish that every original simplification goal
has been fully met.

## Scope and original criteria

The seven-stage phase was agreed after the PR #207 release. The original
completion criteria for its three remaining acceptance areas were:

- **Stage 3:** affected processing tests use their actual helper modules without
  loading API, with the complete dependency chain checked and shared state kept.
- **Stage 6:** upload/generation, retries, recovery and polling stay identical,
  without duplicate workers/caches; API primarily registers and connects services.
- **Stage 7:** every deletion has evidence, retained legacy features have
  documented owners, and the product map describes the resulting structure.

| Area | Assessment and evidence |
| --- | --- |
| 1: Context/knowledge routes | Achieved, [PR #208](https://github.com/clairenicholsondigital/trinzo-upload/pull/208); original handlers, scoping and embedding behavior retained. |
| 2: Job management | Achieved, PR #208; historical job formats and edited results retain their contracts. |
| 3: Shared processing ownership | Achieved for the extracted owners: deterministic policies use direct imports and Original's 140 supplied entries reduce to five genuine execution ports. Existing helper tests follow owners; integration/facade tests deliberately retain real API/V2 entry points. Complete isolation of every consumer and uniformly small shared-owner selections remain exceptions. |
| 4: Publication/Library/exports | Achieved, [PR #220](https://github.com/clairenicholsondigital/trinzo-upload/pull/220) and [PR #221](https://github.com/clairenicholsondigital/trinzo-upload/pull/221); separate acceptance covers read/export ownership and the formerly unresolved restoration graph. |
| 5: Reviewer saves/history | Achieved, PR #221; save/reload, stale edits, restoration, proposal decisions and undo/redo retain reviewer authority. |
| 6: Generation lifecycle | Owned and verified across [PR #222](https://github.com/clairenicholsondigital/trinzo-upload/pull/222) through [PR #231](https://github.com/clairenicholsondigital/trinzo-upload/pull/231): transport, prewarm, speculation, lifecycle, Original policies, canonical Context/Details/Evaluation and Queue. API retains supported legacy adapters and compatibility exports. |
| 7: Verified deletion and current map | Verified research archive, dead private code and imports have evidence/recovery history. [PR #232](https://github.com/clairenicholsondigital/trinzo-upload/pull/232) removes 50 imports; PR #233 removes 62 imports and six unreachable functions. This documentation consolidation records owners and exceptions. |
| Whole-phase closeout | Runtime cleanup is accepted. Independent documentation and original-criteria acceptance remain the closeout gate. The original goal of broadly smaller application source and uniformly focused shared-module checks remains partially achieved. |

Further source removal or splitting is a separate task tied to a demonstrated
benefit. Retained compatibility and uncertain-use tools do not silently become a
new mandatory cleanup programme.

## Measured size

These are Git blob-content metrics at the runtime snapshot above, **before this
documentation consolidation**. They exclude filesystem allocation, ignored
dependencies/model caches and compressed Git-history size. The documentation-only
PR records its own file/line/byte delta separately.

| Metric | Before any cleanup: `8a2bc04` | Product-map baseline: `ea18d4a` | Runtime snapshot |
| --- | ---: | ---: | ---: |
| All tracked files | 10,691 | 1,341 | 1,467 |
| All tracked bytes | 75,656,780 | 28,168,558 | 28,474,866 |
| Own tracked files, excluding installed dependencies | 1,355 | 1,341 | 1,467 |
| Own tracked bytes, excluding installed dependencies | 33,083,428 | 28,168,558 | 28,474,866 |
| Own source files by the suffix definition below | 749 | 748 | 873 |
| Own source bytes | 12,486,249 | 12,461,343 | 12,690,444 |
| Own source LF lines | 213,574 | 213,294 | 217,328 |
| API LF lines | 21,456 | 21,456 | 3,642 |
| V2 LF lines | 8,000 | 7,862 | 3,499 |

Own source uses `.js .cjs .mjs .py .html .css .sql .sh .ts .tsx .jsx`,
excluding `node_modules/`. It includes tests, tools and generated source.
The definition is identical across revisions.

From the initial checkout, all tracked content falls by **9,224 files (86.3%)**
and **47,181,914 bytes (62.4%)**. Most of that is dependency/research removal.
Own source grows by **204,195 bytes and 3,754 LF lines**. Since the later
product-map baseline, all tracked content grows by 126 files and 306,308 bytes.
Smaller API/V2 files largely measure relocation into named owners.

The same literal local-`require` traversal from `server.js` and
`scripts/meeting_minutes_final_worker.js` grows from 171 files/70,092 LF lines
initially, through 173/70,107 at the product-map baseline, to 268/71,041.
Its content grows from 4,119,354 to 4,163,702 bytes. This conservative static
graph includes lazy references and relocation; it excludes Python bridges,
browser loading, dynamic imports and actual branch execution. It supplies no
claim of fewer loaded modules, lower memory or faster startup.

The runtime process model remains one web process, two Trinzo PM2 workers and
the shared MiniLM service. Entry-point ownership is clearer; process count has
not been reduced.

## Verification and future changes

[README](../README.md#testing-without-running-everything-for-every-edit) and
[AGENTS.md](../AGENTS.md) define the existing commands:

| Command | Use |
| --- | --- |
| `npm test` | Compact product checks. |
| `npm run test:changed -- --base origin/main` | Actual changed paths plus compact coverage; fetch/use the real PR base. |
| `npm run test:changed -- --base <candidate> --file <path> --list` | Explain an isolated proposed edit on a clean candidate. Listing runs no tests. |
| `npm run test:release -- --base <deployed-revision>` | Required deployed-diff selection with persistence coverage. `deploy.sh` uses `.openclaw-deployed-revision`; use `--all` when no usable baseline exists. |
| `npm run test:integration` | All eight PostgreSQL/browser fixture files, with an explicit disposable database named `trinzo_tasks_test`. |
| `npm run test:full` | Retained broad JavaScript/Python regressions. |
| `test:project-update-golden`, `test:meeting-minutes-drift` | Explicit quality evaluation/historical diagnostics; provider prompt changes also need representative transcript review. |

Push/merge alone do not require a repeated manual run. Standard `deploy.sh`
executes its own release gate; let that be the single release run. The source-only
rollouts in this cleanup used separately reviewed receipt/hash-bound scripts in
VPS evidence; `deploy.sh` does not automatically reuse those receipts or offer a
skip flag. Documentation-only follow-ups receive source/link/selection checks
under AGENTS.md's explicit guidance.

Representative **selection-only** probes at the runtime candidate show the
practical limit. File counts include compact coverage; these are not executed
test counts or elapsed-time measurements.

| Proposed edit | JavaScript files | Python profile | Database required |
| --- | ---: | --- | --- |
| Beta Summary prompt | 59 | Core | No; transcript quality review required |
| Project processing browser script | 75 | Focused | No |
| API composition | 193 | Focused, five files | Yes |
| Project Context routes | 167 | Focused | Yes |
| Stage persistence | 167 | Core | Yes |
| Publication | 230 | Focused | Yes |
| Shared evidence context | 280 | Core | Yes |

Broad selections remain for shared behavior and retained facade/compatibility
dependencies. Coverage is preserved; the counts do not imply duplicated user
journeys. The measured offline four-scenario retry check improved from
102.3 seconds to 1.5 seconds in [PR #217](https://github.com/clairenicholsondigital/trinzo-upload/pull/217).
That measured improvement applies to those scenarios, rather than every release.

Latest runtime acceptance: **364.289879 seconds**, one required native
profile, 2,228 JavaScript passes, 106 focused Python passes and
59 database passes across all eight fixtures, with 0 skips.
Eight desktop/mobile comparisons are pixel-identical; 20 watched business tables,
17 read-route fingerprints and ordinary/evidence Word/PDF contents match.
Task verification resources are removed and services are healthy.

VPS evidence: `/root/trinzo-dead-cleanup-evidence-20261101/` contains the frozen
source/deletion/reader proof, required release, deployment, cleanup and independent
completion receipts. Its `closeout/` directory records the reproduced original
inventory, exact Git metrics and selector probes. The original live-map inventory
is `/root/trinzo-live-map-20261030/inventory.json`.

## Retained exceptions and stopping point

- API/V2 compatibility exports and older mounted/queued paths remain supported.
  Recent traffic, external automation and manual use were not measured.
- Four source-pinned import bindings, the complete `isUsableStagedTopic`
  declaration, `STAGED_TOPIC_RULES`, existing environment-derived constants and
  factory initialization remain to preserve existing contracts and effects.
- Canonical response internal splitting (the 1,412-line function inside a
  1,735-line owner) and the 368-line asynchronous Discussion publication extraction
  are optional/deferred. Async extraction needs separate timing-semantics review.
- Python dependencies, local model weights, pgvector and external provider
  configuration retain the setup requirements documented in README.
- Generated-minute factual quality requires separate transcript evaluation.
  Source movement, software checks and screenshot equivalence do not establish it.

The finite documentation closeout ends when current owners/criteria/metrics are
accurate, accepted runtime evidence is bound to the deployed tree, and an
independent review records the achieved and partial goals above. Routine work
then follows the documented compact/changed/release workflow; further extraction
requires a concrete new maintenance or product problem.
