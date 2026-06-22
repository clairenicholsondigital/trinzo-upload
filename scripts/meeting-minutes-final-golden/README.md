# Meeting Minutes Final Golden Evaluation Pack

This pack is the fixed production-readiness suite for `/meeting-minutes-final`.
It contains 22 representative transcript/PDF-text cases, mostly copied from `scripts/transcript-tests`, and focuses on semantic behaviour rather than transcript-specific wording:

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
- `project_status_review`, `project_status_update`, `risk_review`, `software_technical_file_review`
- `sales_pipeline_review`, `supplier_onboarding_review`, `webinar_rehearsal`
- real client transcript and real client minutes-PDF text examples

Current behaviour coverage:

- action-heavy, concrete owner actions, single actions, deadline capture
- decision-only, hidden decisions, supported decisions, rejected alternatives
- discussion-only/no-action/no-decision abstention
- low-substance/sparse transcript abstention and noise filtering
- messy speaker/timestamp, compressed transcript, real PDF extraction, and speaker-label filtering
- pending approval, suggestion-not-decision, risk-not-blocker, budget trade-off, candidate assessment, rehearsal handling
- raw transcript leakage filtering and owner/deadline table preservation

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

Run against the local MiniLM final extractor when the model/runtime is available:

```bash
python3 scripts/run_meeting_minutes_final_golden_eval.py
```

Run the same scoring pack against the deployed web-app API:

```bash
python3 scripts/run_meeting_minutes_final_golden_eval.py --base-url https://trinzo.virtual-hub.online
```

For the full repeatable process, interpretation guidance, and safe-change checklist, see `RUNBOOK.md`.
