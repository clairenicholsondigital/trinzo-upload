# Meeting Minutes Final Production-Readiness Test Runbook

This runbook records the repeatable process for testing whether `/meeting-minutes-final` is ready to handle varied meeting types.

The test is intentionally separate from the frontend. It should not require changes to `views/`, `public/`, `routes/api.js`, or the API response shape.

## What The Test Answers

Use this pack to answer:

- Does the tool work across representative meeting types, not just one demo transcript?
- Does it capture supported decisions, actions, owners, deadlines, and discussion points?
- Does it abstain when the transcript does not support decisions or actions?
- Does it avoid obvious meeting-minutes quality issues, such as raw transcript leakage, bad titles, first-person wording, timestamps, emojis, or deadline text inside action text?

The suite currently contains 20 golden transcript cases under `scripts/meeting-minutes-final-golden/`.

Each case has:

- `transcript.txt`: the input transcript.
- `expected.json`: semantic expectations, pass threshold, and coverage metadata.

The coverage contract is stored in `manifest.json`. Dry-run validates that the expected meeting-type and behaviour coverage is still present.

## Before Running

From the repo root:

```bash
cd /root/.openclaw/workspace/trinzo-upload
git status --short
```

If the working tree is dirty, check that changes are intentional before testing or committing.

## 1. Validate Fixtures And Coverage

Run this first. It does not require MiniLM or the live app.

```bash
python3 scripts/run_meeting_minutes_final_golden_eval.py --dry-run
```

Expected healthy shape:

```text
Meeting-minutes-final golden eval: mode=dry-run, cases=20, schema_failures=0, executed=0, passed=0, failed=0
Coverage: meeting_types=23, behaviours=27, source_fixtures=20
```

This confirms:

- all cases have `transcript.txt` and `expected.json`;
- each case has required scoring categories;
- each case has coverage metadata;
- `manifest.json` still matches the suite coverage.

For machine-readable reporting:

```bash
python3 scripts/run_meeting_minutes_final_golden_eval.py --dry-run --json
```

## 2. Run Local Syntax And Focused Unit Checks

```bash
python3 -m py_compile scripts/run_meeting_minutes_final_golden_eval.py
python3 -m unittest tests.test_meeting_minutes_minilm_quality tests.test_meeting_minutes_numbers tests.test_meeting_minutes_parser
```

Known note: `pytest` may not be installed in the local environment. The focused `unittest` command is the current repeatable fallback.

## 3. Run Against The Local Extractor

Only use this when the local MiniLM runtime and dependencies are installed:

```bash
python3 scripts/run_meeting_minutes_final_golden_eval.py
```

This calls `scripts/meeting_minutes_minilm_only.py` with `--skip-rewrite` and evaluates the extracted output against the golden criteria.

If MiniLM is unavailable locally, use the live API mode instead.

## 4. Run Against The Deployed Web App API

This is the most important production-readiness check because it tests the endpoint Trinzo would actually use.

```bash
python3 scripts/run_meeting_minutes_final_golden_eval.py --base-url https://trinzo.virtual-hub.online --timeout 300 --json
```

The endpoint tested is:

```text
POST https://trinzo.virtual-hub.online/api/meeting-minutes-final?includeDiagnostics=true
```

If the run fails with a MiniLM worker connection error immediately after deploy, wait for the worker to finish loading and rerun. A transient failure shortly after restart is different from a quality failure.

## 5. Interpret Results

The runner returns:

- `totalCases`: number of golden cases.
- `executedCases`: cases actually run against extractor/API.
- `passedCases` and `failedCases`.
- `coverage`: meeting-type, behaviour, and source-fixture counts.
- per-case `score`, `passThreshold`, `categoryScores`, `failures`, and output counts.

A case passes only if:

- weighted score is at or above `passThreshold`; and
- there are no explicit failures, including quality-check failures.

Important failure categories:

- `decisions`: missed or unsupported decisions.
- `actions`: missed actions, extra actions, owner/deadline mistakes.
- `hallucinations`: forbidden unsupported content appears.
- `abstention`: too much or too little output for the evidence available.
- `quality`: Notion-checklist issues such as bad title, first-person wording, timestamps, emoji, conversational leakage, or bad action/deadline formatting.

## Current Baseline

Last recorded live API run after expanding the suite:

```text
20 cases executed
2 passed
18 failed
```

This means the deployed tool is not yet production-ready across meeting types.

The main observed failure themes were:

- missed action recall;
- weak discussion capture;
- rejected alternatives leaking into output;
- titles containing `Transcript`;
- some no-action/no-decision cases producing unsupported actions;
- some valid discussion-only cases being too sparse.

## Safe Change Process

When improving the tool, keep these boundaries:

- Do not touch frontend UI files unless explicitly required.
- Avoid changing `views/`, `public/`, `routes/api.js`, or response shape while working on evaluator-only changes.
- Prefer fixing extraction/runtime quality in backend scripts and validating with this pack.
- Run dry-run and focused unit tests before any commit.
- Run live API mode before claiming production readiness.

## Adding A New Golden Case

1. Choose a source transcript from `scripts/transcript-tests/` where possible.
2. Create a new folder under `scripts/meeting-minutes-final-golden/NNN_short_name/`.
3. Add `transcript.txt`.
4. Add `expected.json` with:
   - `description`
   - `passThreshold`
   - `coverage.sourceFixture`
   - `coverage.meetingTypes`
   - `coverage.behaviours`
   - `criteria.decisions`
   - `criteria.actions`
   - `criteria.hallucinations`
   - `criteria.abstention`
5. Update `manifest.json` if the case adds a required meeting type or behaviour.
6. Run:

```bash
python3 scripts/run_meeting_minutes_final_golden_eval.py --dry-run
python3 -m py_compile scripts/run_meeting_minutes_final_golden_eval.py
```

## Production-Readiness Rule Of Thumb

Do not call `/meeting-minutes-final` production-ready merely because it produces minutes.

A credible handover should include:

- representative suite coverage;
- live API pass/fail result;
- known failure themes;
- clear thresholds;
- evidence that sparse output is preferred over invented actions or decisions.

