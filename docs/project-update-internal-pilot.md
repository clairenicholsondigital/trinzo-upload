# Project Update Internal Pilot

Status: ready for a real-data pilot.

Use this when testing whether the project-update workspace is good enough for
routine internal use, not just fixture/smoke-test confidence.

## Pilot Scope

Choose one real project and run 3-5 real project update transcripts through the
workspace.

Minimum setup:

- one project with a clear project name and client;
- 5-10 agreed milestones;
- any known standing constraints, decisions, SoW notes or delivery risks added
  as project knowledge;
- at least one previous report approved as official memory if available.

## Run Checklist

For each transcript:

1. Open `https://trinzo.virtual-hub.online/project-update-test`.
2. Select the pilot project.
3. Confirm Setup has the current milestones and standing knowledge.
4. Process the transcript in the Process stage.
5. Review generated:
   - overall health;
   - milestone statuses and carried-forward milestones;
   - risks and suggested mitigations;
   - actions/next steps;
   - evidence snippets.
6. Save the report as draft.
7. Correct obvious issues in the report detail view.
8. Approve only if the report is good enough to become future project memory.
9. Check Insights after approval.
10. Ask one useful question in Ask this project before processing the next
    transcript.

## Correction Log

Record every manual correction. Use one row per issue.

| Field | Values / guidance |
| --- | --- |
| transcript_id | Stable label for the transcript, e.g. `pilot-001` |
| report_id | Saved report ID, if created |
| section | `overall_health`, `milestone`, `risk`, `action`, `evidence`, `memory`, `ui`, `other` |
| severity | `minor`, `material`, `blocking` |
| issue | What was wrong |
| expected | What the tool should have produced |
| actual | What the tool produced |
| likely_cause | `transcript_quality`, `setup_gap`, `parser`, `model`, `retrieval`, `ui`, `unknown` |
| fixed_in_report | `yes`, `no`, `not_applicable` |
| should_be_golden_case | `yes`, `no` |

## Pass Criteria

The pilot passes if:

- at least 3 real transcripts are processed;
- no transcript requires more than light editing before internal use;
- no retrieved project knowledge is presented as transcript evidence;
- carried-forward milestones remain visible when not discussed;
- approving a report improves later project memory;
- no blocking UI issue prevents Setup -> Process -> Reports -> Insights;
- all material corrections are converted into follow-up tickets or golden cases.

The pilot fails if:

- a report gives the wrong overall health in a way that would mislead a client;
- active milestones disappear without a deliberate archive/complete action;
- the same existing risk repeatedly appears as duplicate new risks;
- Ask this project returns irrelevant or misleading memory for normal project
  questions;
- report editing/approval is too awkward for a non-developer operator.

## Before And After Checks

Before the pilot:

```bash
npm test
python3 scripts/run_project_update_golden_eval.py --mode all --skip-minilm
```

After the pilot:

- add any repeated material failure as a golden case;
- update `docs/project-update-robustness-todo.md`;
- keep generated reports only if they are useful; archive/delete obvious test
  junk.
