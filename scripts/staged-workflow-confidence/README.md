# Staged workflow confidence benchmark

This is an evaluation tool, not part of the `/staged-meeting-minutes` reviewer UI.

It validates the 13-case evidence-grounded corpus, executes the authenticated deployed
UI-mirror route three times per transcript, refuses to mix serving revisions, and writes
an immutable JSON/HTML report under `benchmark-results/staged-workflow-confidence/`.

```bash
npm run benchmark:staged-confidence:validate

STAGED_BENCHMARK_EMAIL='...' \
STAGED_BENCHMARK_PASSWORD='...' \
STAGED_BENCHMARK_BASE_URL='https://trinzo.virtual-hub.online' \
npm run benchmark:staged-confidence
```

For an existing authenticated session, `STAGED_BENCHMARK_COOKIE='auth_session=…'`
can be used instead of an email and password by both the mirror runner and browser smoke.

Resume an interrupted run without repeating completed calls:

```bash
node scripts/staged-workflow-confidence/benchmark.js run \
  --resume benchmark-results/staged-workflow-confidence/2026-08-27T18-00-00-000Z
```

Live benchmark runs are reliability-strict by default. Discussion or Actions output that
used the canonical fallback is stored under `reliability-attempts/`, cooled down and
retried; it is never silently included in a completed quality report. Control pacing with
`STAGED_BENCHMARK_COOLDOWN_MS` and the bounded retry count with
`STAGED_BENCHMARK_RELIABILITY_RETRIES`.

Production staged Trooper calls are process-wide serialised by default. The request gap,
transport retries and initial retry delay can be configured with
`TROOPER_MIN_INTERVAL_MS`, `TROOPER_MAX_RETRIES` and `TROOPER_RETRY_BASE_MS`.

Score a complete raw result directory again only when it does not already contain an
immutable report:

```bash
STAGED_BENCHMARK_SKIP_CLOUD=1 node scripts/staged-workflow-confidence/benchmark.js score \
  --runs 3 --resume /path/to/result-directory
```

The optional real-browser smoke checks use the same credentials and cover T733 grouping,
the Two-Jos owner collision and the parking/no-action negative control:

```bash
npm run benchmark:staged-confidence:browser
```

`curate_expected_v2.py --write` rebuilds the v2 corpus from the legacy expectations and
source transcripts using MiniLM evidence alignment. It never receives production output.
Generated v2 items are scored only when their support is `transcript_supported`; contextual
and `review_pending` items remain visible but excluded.
