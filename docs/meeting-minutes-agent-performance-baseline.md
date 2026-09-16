# Meeting Minutes Agent performance baseline

This document defines the measurement contract required before any compact-path
optimisation is enabled. The deployed generation semantics remain the control.

## Event contract

All events are JSON and contain `event` plus a draft-scoped `journeyId`. They do
not contain transcript text, model responses, user names or evidence excerpts.

| Event | Measures |
| --- | --- |
| `meeting_agent_preparation` | transcript reading, MiniLM preparation, metadata building, draft persistence and total upload time |
| `meeting_agent_pass` | pass, request ID, prompt characters, candidate count, attempts, elapsed time, output counts and stable failure class |
| `meeting_agent_stage_performance` | processing, final persistence, optimistic retries, conflicts, total stage time and pass contribution summary |
| `meeting_agent_poll_observed` | delay between the persisted completion revision and the browser's first completion poll |

Stored private provenance also records whether each logical pass materially
contributed to published minutes, review proposals or supporting context. A
contribution count is non-exclusive: a Primary discovery and the Referee that
adjudicated it can both be material to the same final record.

Failure classes are stable and intentionally broad:

- `response_contract`: invalid structures, missing/duplicate dispositions and
  grounded discovery responses that normalise to empty despite substantive candidates.
- `rate_limit`: HTTP 429 and usage/throttling errors.
- `transport`: upstream 5xx, timeouts, hand-off and connectivity failures.
- `other`: a coded failure outside the preceding categories.

## Baseline capture

Use clean drafts and the fixed representative set: T733, T761, T788, M204,
Parking and Brewery when available. Do not reuse model pass caches between
variants. Use at least five complete runs per representative transcript for
latency percentiles; frozen-response replay remains the semantic attribution
test but is not a latency measurement.

Collect PM2 JSON events without exposing environment variables, then build the
report:

```sh
node scripts/meeting_minutes_agent_performance_report.js trinzo-events.jsonl > baseline-report.json
```

The report includes p50, p90 and p95 preparation, stage, pass, persistence and
poll-observation timings, prompt sizes, candidate counts, retries, failure
classes, and the number of exact model calls that materially contributed to
the final minutes.

Quality results from the existing representative benchmark must be added under
`quality` using these stable keys:

- `actionRecall`
- `actionPrecision`
- `evidenceReferenceCoverage`
- `supportedActionRate`
- `reviewerAcceptanceRate`

The last value comes from reviewer decisions/corrections over the controlled
evaluation set; it must not be guessed from action counts.

## Variant matrix

Run each variant from the same code revision and frozen configuration, changing
only the named feature flag. Every new performance feature defaults to disabled.

1. `production-control`: all new performance flags disabled.
2. `compact-all`: compact pipeline enabled; speculative generation remains disabled.
3. One run group per independent optimisation:
   - authoritative-referee short circuit
   - bounded prompts
   - speculative Action discovery
   - deterministic Summary
   - persistent transcript preparation

No broad experimental branch may be used as the control or ported wholesale.
The reference implementation in `/srv/m365-agent-test` also contains identity,
survival, evidence, dedupe and presentation experiments. Phase 2 must extract
only scheduling/call-elision behavior and retain the deployed normalisers,
candidate identity and final reconciliation semantics.

## Release gates

The executable thresholds are in
`config/meeting-minutes-agent-performance-gates.json`. Compare reports with:

```sh
node scripts/meeting_minutes_agent_performance_report.js \
  --compare baseline-report.json candidate-report.json \
  config/meeting-minutes-agent-performance-gates.json
```

The command fails unless:

- Action p50 improves by at least 30% and is no more than 120 seconds;
- Summary p50 is no more than 5 seconds;
- preparation p50 is no more than 10 seconds; and
- every required quality metric is present and no worse than control.

Evidence-reference loss, unsupported-action growth and reviewer-correction
growth are release blockers even if the latency threshold passes.

## Phase 2 extraction boundary

The guarded compact implementation can inform four isolated mechanisms:

1. a Primary prompt that receives the existing bounded deterministic inventory;
2. conditional Recovery after the normal grounded-completeness check;
3. one global Action referee only below a separately tested candidate ceiling;
4. Critic/Salvage elision only after exact candidate accounting and disposition validation.

Each mechanism needs its own disabled-by-default flag and frozen-response parity
test. Stable fingerprints, namespaced IDs, survival rules, evidence/action-state
changes, new dedupe, presentation guards, diagnostic agents and Salvage-skip
experiments are outside this performance programme.
