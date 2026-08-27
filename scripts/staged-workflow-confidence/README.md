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
