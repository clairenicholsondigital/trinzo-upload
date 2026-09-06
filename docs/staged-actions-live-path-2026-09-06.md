# Staged actions: live-path measurement and the sampled/tiered pipeline (2026-09-06)

## What was wrong with the measurements

`scripts/staged_minutes_scorecard.js` scored `canonicalStagedResponse`, the Node path the
Actions screen stopped using at `43275ac`. The queued stage
(`POST /api/staged-meeting-minutes/jobs?stage=actions`) runs `generateMiniLmTrooperStage`:
MiniLM-v3 denoise -> `staged_trooper_chunk_pipeline.py` -> four-word gate -> UI. The scorecard
now calls that function, with the meeting type routed through the same helper
(`stagedGenerationMeetingType`) as the queued stage.

`scripts/live_action_path_eval.py --label X --runs 3` runs the live path over the 13
fixtures and saves `artifacts/live-action-path-eval/X/run-N.json`;
`scripts/score_live_action_runs.py X/run-*.json` reports, per fixture and in total, rows shown,
expected actions matched (MiniLM cosine >= 0.55), duplicate rows, noise rows, the lexical
scorecard match for comparison, and the same for tier 1 alone. Always run three times: the same
code varies by +/-10 rows and +/-3 matched actions between runs.

## What the deployed baseline (f60188f) actually did

Three runs, medians: **278 rows shown, 72/102 matched (70.6%), 166 noise rows**. Rows that
recurred in all three runs hit an expected action 55% of the time; rows in one run only, 17%.
Requiring >=2/3 support kept 73 of 77 matched actions and removed 52 rows - variance is a
usable signal.

Two defects found by reading raw candidates: the extractor writes bare verbs ("send",
"build out") for some of the strongest commitments (Jacqui's "I'll get that over to you today"
= the code of conduct) and the four-word gate deleted them; and the two-pass consensus selector
removed almost nothing (its rejection codes overlap, so agreeing on one was luck).

## Changes, in the order they were measured

| Configuration | Table rows | Matched | Noise | Reachable incl. panel |
|---|---:|---:|---:|---:|
| Deployed baseline f60188f (3 runs, median) | 278 | 72 | 166 | - |
| + deterministic fixes (COMPLETED drop, bare-verb repair from cited turns, identical-wording pool, small-chunk merge, looser consensus, narrower protection regex) | 300 | 75 | 180 | - |
| + 3 samples, same chunking, majority tier | 250 | 73 | 144 | 82 |
| **+ 3 samples over different chunkings, majority tier (default now)** | **214** | **71** | **119** | **93** |

Final configuration, three runs: tier 1 (table) median 214 rows / 71 matched / 119 noise;
tier 2 (collapsed "raised" panel) median 343 rows adding 22 expected actions; tier 3 (dropped:
single-sample rows every sample read as a proposal) median 87 rows costing 2 expected actions.

Per fixture (medians, tier 1 rows / matched / noise; panel rows / adds):
Abbott 29/6/22, 48/2 - Importer 25/6/18, 53/3 - T733 consultancy 18/6/10, 22/2 -
T733 tech file 12/6/6, 33/3 - Webinar 23/7/15, 40/4 - T761 SW 26/10/11, 37/2 -
T761 tech file 32/9/20, 45/3 - Allotment 12/6/4 - Panto 9/5/2 - Lean gen 10/3/6 -
Brewery 7/3/4 - Race 8/5/2 - Parking 1/0/1.

Importer obligations went from 2/10 matched (its bespoke selector discarded 3 of the 6
candidates that matched the reviewed minutes) to 6/10 in the table and 9/10 reachable, at the
cost of a 25-row table and a 53-row panel. The legacy selector is behind
`STAGED_IMPORTER_LEGACY_SELECTOR=1`.

## What did not work, with numbers

- **Deliverable-identity merging** (LLM names each candidate's deliverable noun phrase + verb
  class; merge on phrase similarity, compatible owner, compatible verb, turn locality): -17 to
  -37 rows of 851 across every threshold. Reading the pairs the scorer calls duplicates: most
  are distinct sub-tasks the human minutes consolidated into one broader action ("Electrical
  compliance testing" by Andrew vs "final documents update" by David; "hasp purchase" vs
  "hasp fitting"). That is a granularity difference between atomic extraction and the
  reference set, not a dedupe failure. Kept behind `STAGED_ACTION_DELIVERABLE_MERGE=1`.
- **Sampling the same chunking three times**: 3/3-support rows hit 43% vs 29% for 1/3 -
  correlated samples. Giving each sample a different chunking (model boundaries; boundaries
  shifted to the midpoints; fixed windows) restored the 55%/22% separation.
- **Extractor status as a tier**: ASSIGNED rows hit 55%, REQUIRED 34%, COMMITTED 37%,
  PROPOSED 27%. Useful only combined with support.

## Operational notes

- Trooper allows 10 in-flight requests per key and returns 429 above that. `call_trooper`
  now caps its own in-flight calls (`TROOPER_MAX_INFLIGHT`, default 8) and backs off on
  429/5xx. Two reviewers generating at once previously exceeded the limit.
- Long-turn transcripts (T761 software review) overran the selector prompt and returned 422;
  selector batches are now bounded by characters as well as count.
- Three samples cost roughly three times the extraction calls; the actions stage took
  ~55 s per meeting in the harness at two meetings in parallel.
- `STAGED_ACTION_SAMPLES=1` restores single-pass extraction with every row in tier 1.
