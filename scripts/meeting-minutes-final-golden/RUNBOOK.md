# Meeting Minutes Final Production-Readiness Test Runbook

This runbook records the repeatable process for testing whether `/meeting-minutes-final` is ready to handle varied meeting types.

The test is intentionally separate from the frontend. It should not require changes to `views/`, `public/`, `routes/api.js`, or the API response shape.

## What The Test Answers

Use this pack to answer:

- Does the tool work across representative meeting types, not just one demo transcript?
- Does it capture supported decisions, actions, owners, deadlines, and discussion points?
- Does it abstain when the transcript does not support decisions or actions?
- Does it avoid obvious meeting-minutes quality issues, such as raw transcript leakage, bad titles, first-person wording, timestamps, emojis, or deadline text inside action text?

The suite currently contains 27 golden transcript cases under `scripts/meeting-minutes-final-golden/`.

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
Meeting-minutes-final golden eval: mode=dry-run, cases=27, schema_failures=0, executed=0, passed=0, failed=0
Coverage: meeting_types=31, behaviours=43, source_fixtures=27
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

This calls `scripts/meeting_minutes_trooper.py` -- the same script `/api/meeting-minutes-final`
runs in production (see `routes/api.js`) -- and evaluates the extracted output against the golden
criteria. Pass `--extractor meeting_minutes_final_colab.py` or `--extractor meeting_minutes_minilm_only.py`
to score older predecessors for comparison only; nothing calls those from the live route.

If MiniLM semantic scoring is slow/unavailable locally, add `--literal-only` for a deterministic literal-only score, or use the live API mode instead.

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

Current local Trooper extractor alignment run (2026-07-28, against `meeting_minutes_trooper.py`, matching the live route in `routes/api.js`):

```text
Command: python3 scripts/run_meeting_minutes_final_golden_eval.py --skip-rewrite --literal-only --json
27 cases executed
16 passed
11 failed
```

This is a deliberately strict literal-only score: it disables optional MiniLM semantic matching so the run is deterministic/offline and does not hang on model loading. The expectations have been calibrated case-by-case for the live Trooper output shape so ordinary paraphrases and evidence metadata are no longer treated as failures, while unsupported output remains red.

Current passing Trooper-calibrated cases:

```text
001_decision_heavy_no_actions
002_incident_actions_decision
005_project_status_pending_leadership
006_client_onboarding_split_rollout
007_operations_review_internal_cover
008_sales_pipeline_review
009_board_launch_delay
010_webinar_rehearsal_trim
011_finance_budget_review
012_hiring_interview_debrief
013_messy_speaker_timestamp_formats
015_hidden_decision_meeting
018_support_metrics_action_heavy
019_contract_negotiation_review
020_customer_complaint_review
023_real_eakin_t733_weekly_transcript
```

Current failing cases should stay red until the extractor/runtime quality improves or a fresh case review proves the expectation is stale:

- `003`, `004`, `014`, `016`, `017`: Trooper is still producing unsupported actions/decisions or discussion output where the transcript should abstain more strongly.
- `021`, `022`, `024`, `025`, `026`, `027`: current direct Trooper runs return `HTTP 422: JSON generation failed`, causing fallback failure text instead of useful minutes.

Do not mark these green by lowering thresholds alone; fix extraction/runtime behaviour first, then update expectations only with reviewed output evidence.

Historical local-extractor run (2026-07-02, against the older `meeting_minutes_final_colab.py` path that the live
route no longer uses):

```text
27 cases executed
21 passed
6 failed
```

The 6 known-failing cases are all "real client transcript" cases (021, 022, 023, 024, 025) plus one synthetic
case (018) with a pre-existing minor `Mark:` speaker-label leak. They fail primarily on `abstention`/`actions`
count mismatches against `expected.json` thresholds that were set before a July 2026 pass fixed a critical bug:
the transcript parser did not handle the message-glued-to-timestamp layout mammoth's raw-text extraction
produces for real `.docx` Teams exports (`Jacqui Fox   0:03Perfect and...` with no space), which meant every
real transcript case previously collapsed to a single "Unknown speaker" turn and was scored against a much
weaker extraction than what real users see. Now that parsing is fixed, several of these cases extract
genuinely more (and more specific) content than their `expected.json` thresholds allow for, so the current
failures are mostly stale expectations rather than new defects -- but they have not yet been re-baselined, so
treat them as a known gap rather than a false "all green" signal. Do not close this gap by loosening
`expected.json` counts without checking the actual output is not also introducing new noise.

Before the July 2026 Colab baseline pass, the suite defaulted to scoring `meeting_minutes_minilm_only.py`, an older sibling script the
live route did not use, so the same parser bug was previously invisible to this whole suite. The current default now follows the live
Trooper route (`meeting_minutes_trooper.py`). Continue treating the suite as a regression baseline rather than a guarantee that every
real-world transcript will be perfect, and re-run live API mode (`--base-url`) before claiming production readiness, since it is the only
mode that reflects the deployed service configuration.

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
