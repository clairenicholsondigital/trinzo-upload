# Meeting Minutes Final Golden Evaluation Pack

This pack is the fixed production-readiness suite for `/meeting-minutes-final`.
It focuses on semantic behaviour rather than transcript-specific wording:

- decisions are captured only when the transcript supports them;
- actions require concrete ownership or commitment evidence;
- hallucinated raw chatter and unsupported facts are penalised;
- low-substance or action-free meetings should abstain from forced actions and decisions.

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
