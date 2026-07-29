# Classifier Datasets and Candidate Runs — 2026-07-29

## Source files

Claire supplied two saved ChatGPT MHTML exports:

```text
/data/.openclaw/media/inbound/Dataset_creation_assistance_1---85e3ed55-efd1-4a49-b6fa-b6758201202e.mht
/data/.openclaw/media/inbound/Dataset_creation_assistance_2---5dd85af1-4cb1-4f45-a275-906d843391c9.mht
```

The exports contained generated Python dataset scripts rather than raw CSV attachments.

The first visible 3-file generator in the page failed with:

```text
AssertionError: Duplicate text in project_status_classifier_targeted_supplement.csv
```

A corrected generator later in the page succeeded. That corrected code was extracted and run locally.

Generated local files:

```text
/data/.openclaw/workspace/generated_classifier_datasets_20260729_from_mht/project_status_classifier_targeted_supplement.csv
/data/.openclaw/workspace/generated_classifier_datasets_20260729_from_mht/meeting_type_classifier_training.csv
/data/.openclaw/workspace/generated_classifier_datasets_20260729_from_mht/classifier_holdout_eval.csv
```

Uploaded to VPS:

```text
/root/project-update-status-model/source_uploads/project_status_classifier_targeted_supplement.csv
/root/project-update-status-model/source_uploads/meeting_type_classifier_training.csv
/root/project-update-status-model/source_uploads/classifier_holdout_eval.csv
```

## Dataset validation

### `project_status_classifier_targeted_supplement.csv`

```text
Rows: 120
Columns: id,text,overall_status,action_state,signals,source,rationale,reviewed
Blank IDs: 0
Blank text rows: 0
Duplicate IDs: 0
Duplicate text rows: 0
Reviewed: true for all rows
```

Distribution:

```text
completed_supplier_review_history: 40
approved_supplier_topic_negative: 30
approved_supplier_real_action: 25
approved_supplier_blocker: 25
```

Labels are compatible with the current project-status production schema.

### `meeting_type_classifier_training.csv`

```text
Rows: 300
Columns: id,text,meeting_type,input_quality,recommended_mode,signals,source,rationale,reviewed
Blank IDs: 0
Blank text rows: 0
Duplicate IDs: 0
Duplicate text rows: 0
Reviewed: true for all rows
```

Meeting-type distribution:

```text
formal_action_meeting: 34
project_status_review: 34
decision_meeting: 34
discussion_strategy_call: 33
webinar_content_planning: 33
document_review: 33
training_or_demo: 33
low_substance_noise: 33
unknown_or_mixed: 33
```

Input-quality distribution:

```text
complete_transcript: 48
partial_transcript: 48
large_time_gap: 48
low_context: 48
messy_transcript: 48
too_short: 33
usable_with_caution: 27
```

### `classifier_holdout_eval.csv`

```text
Rows: 120
Columns: id,text,expected_project_status,expected_action_state,expected_project_signals,expected_meeting_type,expected_input_quality,expected_recommended_mode,source,rationale
Blank IDs: 0
Blank text rows: 0
Duplicate IDs: 0
Duplicate text rows: 0
```

Source distribution:

```text
known_misread: 24
clear_positive: 24
discussion_only: 24
webinar_planning: 24
partial_noisy: 24
```

## Project-status targeted supplement candidate

Draft:

```text
/root/project-update-status-model/drafts/claire-20260729-targeted-supplement
```

Run:

```text
/root/project-update-status-model/runs/draft-claire-20260729-targeted-supplement-20260729T121035Z
```

Training metrics:

```text
Rows: 1024
overall_status_cv_macro_f1: 0.6170454145913384
overall_status_cv_micro_f1: 0.619140625
action_state_cv_macro_f1: 0.502154233410057
action_state_cv_micro_f1: 0.5927734375
signals_cv_micro_f1: 0.6247630158961645
signals_cv_macro_f1: 0.5875849381905643
```

Baseline reference:

```text
Frozen production baseline: /root/project-update-status-model/baselines/production-freeze-20260729T114011Z
Baseline action_state_cv_macro_f1: ~0.526
Baseline signals_cv_macro_f1: ~0.588
```

### Holdout evaluation: production vs candidate

Holdout output:

```text
/root/project-update-status-model/runs/draft-claire-20260729-targeted-supplement-20260729T121035Z/holdout_eval_project_status.json
```

Summary:

```text
Production status accuracy: 0.5667
Candidate status accuracy: 0.8167

Production action accuracy: 0.0833
Candidate action accuracy: 0.3333

Production signal-contains-expected accuracy: 0.6917
Candidate signal-contains-expected accuracy: 0.7333
```

The candidate is a genuine improvement on the synthetic holdout, especially on completed-history and several known-misread cases.

### Why this candidate was still not promoted

The hand probe still showed risky behaviour for the exact meeting-minutes failure class.

Examples:

```text
"November one will be, is your AI vendor an approved supplier?"
```

Candidate result:

```text
Status: unknown_or_insufficient_info improved
Action: action_required too high
Signals: supplier_action_needed / timeline / internal_action_needed still too high
```

```text
"Is your AI vendor an approved supplier?"
```

Candidate result:

```text
Status: unknown_or_insufficient_info improved
Action: action_required too high
Signals: supplier_action_needed and internal_action_needed too high
```

```text
"Should governance come before validation in the series?"
```

Candidate result on holdout-style rows:

```text
Status: unknown_or_insufficient_info correct
Action: decision_required incorrect
```

Decision:

```text
Do not promote the project-status candidate yet.
```

Reason:

```text
The candidate improves broad holdout accuracy but still over-triggers action/dependency signals on approved-supplier/topic-planning language, which is the live failure we are trying to reduce.
```

## Separate meeting-type/input-quality classifier

A new separate scaffold was created on the VPS:

```text
/root/meeting-type-input-quality-model
```

This follows the embedding-classifier scaffold but does **not** copy trained project-status weights.

For the template trainer:

```text
meeting_type -> overall_status
input_quality -> action_state
signals -> signals
recommended_mode -> kept as an extra data column / derived integration target
```

Schema:

```text
/root/meeting-type-input-quality-model/labels/status_schema.json
```

Training data:

```text
/root/meeting-type-input-quality-model/data/training_data.csv
```

Initial run:

```text
/root/meeting-type-input-quality-model/runs/initial-20260729T1215Z/model_bundle/classifier.joblib
```

### Cross-validation metrics

Meeting type:

```text
overall_status_cv_macro_f1: 1.0
overall_status_cv_micro_f1: 1.0
```

This is likely inflated because the training set is synthetic and templated.

Input quality:

```text
action_state_cv_macro_f1: ~0.68
action_state_cv_micro_f1: ~0.69
```

Signals:

```text
signals_cv_micro_f1: 0.958
signals_cv_macro_f1: 0.958
```

### Holdout evaluation for router behaviour

Holdout output:

```text
/root/meeting-type-input-quality-model/runs/initial-20260729T1215Z/holdout_eval_meeting_type.json
```

Summary:

```text
meeting_type_acc: 0.725
input_quality_acc: 0.3167
recommended_mode_acc: 0.8083
```

By source:

```text
known_misread recommended_mode_acc: 0.5417
clear_positive recommended_mode_acc: 1.0
discussion_only recommended_mode_acc: 1.0
webinar_planning recommended_mode_acc: 1.0
partial_noisy recommended_mode_acc: 0.5
```

Interpretation:

- Meeting type / recommended mode is useful enough to continue.
- Input quality is weak and should not be trusted as a standalone production signal yet.
- The router is strongest on the exact behaviour we care about next: choosing non-formal output modes for webinar planning and discussion-only transcripts.

## Current decision

No production classifier was replaced.

Recommended next implementation step:

1. Keep the project-status production model unchanged.
2. Add deterministic guardrails for topic-planning language in the meeting-minutes evidence layer.
3. Use the separate meeting-type/router candidate experimentally to choose generation mode:
   - `formal_minutes` for true action/project/decision meetings;
   - `discussion_summary` or `topic_summary_with_caution` for webinar/content-planning/discussion transcripts;
   - `sparse_minutes` or ask-for-better-transcript behaviour for partial/noisy input.
4. Before production promotion of the router, test it on real Trinzo transcripts and the known golden cases.
