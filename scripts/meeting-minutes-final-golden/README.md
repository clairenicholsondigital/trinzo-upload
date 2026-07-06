# Meeting Minutes Final Golden Evaluation Pack

This pack is the fixed production-readiness suite for `/meeting-minutes-final`.
It contains 28 representative transcript/PDF/DOCX-text cases, mostly copied from `scripts/transcript-tests`, and focuses on semantic behaviour rather than transcript-specific wording:

- decisions are captured only when the transcript supports them;
- actions require concrete ownership or commitment evidence;
- hallucinated raw chatter and unsupported facts are penalised;
- low-substance or action-free meetings should abstain from forced actions and decisions.

Each case has a `coverage` block in `expected.json`:

- `sourceFixture` records the fixture it was copied or derived from;
- `meetingTypes` tags the meeting/domain represented by the case;
- `behaviours` tags the extraction behaviour or failure mode under test.

The runner includes these tags in `--json` output and prints aggregate coverage counts in normal output.
Dry-run also checks `manifest.json`, so the suite fails if a required coverage tag is removed accidentally.

Current meeting-type coverage:

- `board_update`, `leadership_update`, `leadership_internal`
- `client_onboarding`, `client_status_review`, `customer_complaint_review`
- `contract_negotiation`, `client_vendor_review`
- `document_review`, `planning_check_in`, `policy_briefing`, `importer_obligations_review`
- `finance_budget_review`, `hr_interview_debrief`
- `incident_bug_triage`, `operations_review`, `support_metrics_review`
- `low_substance`
- `project_status_review`, `project_status_update`, `risk_review`, `software_technical_file_review`, `technical_file_review`, `internal_followup_review`
- `sales_pipeline_review`, `supplier_onboarding_review`, `webinar_rehearsal`
- `regulatory_register_review`, `lookalike_domain_meeting`
- real client transcript, real DOCX extraction, and real client minutes-PDF text examples

Current behaviour coverage:

- action-heavy, concrete owner actions, single actions, deadline capture
- decision-only, hidden decisions, supported decisions, rejected alternatives
- discussion-only/no-action/no-decision abstention
- low-substance/sparse transcript abstention and noise filtering
- messy speaker/timestamp, compressed transcript, real PDF/DOCX extraction, and speaker-label filtering
- pending approval, suggestion-not-decision, risk-not-blocker, budget trade-off, candidate assessment, rehearsal handling
- raw transcript/chatter leakage filtering, internal follow-up planning, and owner/deadline table preservation
- cross-client contamination guarding (case 028): a synthetic lookalike meeting for a *different* fictional client shares regulatory vocabulary (HPRA, UDI, mute button, working sessions, PPE/DoC) with the real client transcripts the coverage guardrails were authored from, and asserts that none of those meetings' owners, deadlines, canned decisions or client-specific content leak into its minutes

Two enforcement notes:

- the production pipeline now *enforces* the MiniLM QC evidence comparison (`--qc-advisory` restores report-only behaviour): items flagged as unsupported by both the evidence pack and the transcript are removed from the published output and reported in the payload's `qualityControl` block;
- `mustNotContain` checks are one-directional (`forbidden_match`): the forbidden phrase must actually appear inside a visible value, so a legitimate short value (e.g. an owner name) can no longer false-positive against a longer forbidden chatter phrase.

The runner also applies universal quality checks drawn from Claire's Notion checklist for perfect meeting minutes:

- clean meeting titles and participant names;
- no first-person wording, emojis, timestamps, or conversational leakage;
- action items must be concise, real follow-ups;
- action deadlines should live in the deadline field, not inside the action text;
- visible output should preserve British English spelling.

Run a schema/fixture dry validation:

```bash
python3 scripts/run_meeting_minutes_final_golden_eval.py --dry-run
```

**Default mode runs the real production path** -- the same `meeting_minutes_final_colab.py` pipeline that ships, including the live Gemini rewrite pass (needs `GOOGLE_AI_STUDIO_API_KEY`/`GEMINI_API_KEY` set; if unset, it gracefully degrades to the extractor-only fallback output, same as production does):

```bash
python3 scripts/run_meeting_minutes_final_golden_eval.py
```

Each case's report includes a `rewriter` block (`rewriterAvailable`/`rewriterReason`/`rewriterTokenUsage`) and the summary reports `rewriterUsedCases` -- check this before trusting a low score, since a rate-limited or key-less run looks like a content regression otherwise. Requests are paced (`--pace-seconds`, default 3.5s) to stay under the Google AI Studio free-tier's 20 requests/minute limit; increase it if you still hit 429s, or pass `--cases` to score a smaller subset.

For the old fast, free, deterministic dev-loop (no Gemini calls, no API key needed):

```bash
python3 scripts/run_meeting_minutes_final_golden_eval.py --skip-rewrite
```

Run the same scoring pack against the deployed web-app API:

```bash
python3 scripts/run_meeting_minutes_final_golden_eval.py --base-url https://trinzo.virtual-hub.online
```

**Semantic matching (optional).** `mustContain`/`requiredDiscussionTopics` checks try an exact literal match first, then fall back to MiniLM cosine-similarity matching (via `scripts/meeting_minutes_minilm_experiment.MiniLMBackend`, same backend `/project-update-test`'s golden eval already depends on) so a correctly-paraphrased Gemini output isn't marked as a failure just for using different words. This needs `sentence-transformers` installed (`pip install -r requirements-experimental-minilm.txt`) **and** network access to download `all-MiniLM-L6-v2` from Hugging Face on first use -- neither is a hard requirement: without them, scoring silently falls back to today's literal-substring-only behaviour, exactly as before this feature existed.

For the full repeatable process, interpretation guidance, and safe-change checklist, see `RUNBOOK.md`.
