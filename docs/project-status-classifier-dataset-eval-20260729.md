# Project Status Classifier Dataset Evaluation — 2026-07-29

## Uploaded dataset

Claire supplied:

```text
project_status_classifier_training_batch---b4713702-5773-412f-b37a-9c528e10cefe.csv
```

Local media path:

```text
/data/.openclaw/media/inbound/project_status_classifier_training_batch---b4713702-5773-412f-b37a-9c528e10cefe.csv
```

VPS archived source uploads:

```text
/root/project-update-status-model/source_uploads/project_status_classifier_training_batch_original_20260729.csv
/root/project-update-status-model/source_uploads/project_status_classifier_training_batch_schema_mapped_20260729.csv
/root/project-update-status-model/source_uploads/project_status_classifier_training_batch_schema_mapped_20260729_core.csv
```

## Format validation

The CSV is in the correct base format for the existing project-status classifier workflow.

Required columns were present:

```csv
id,text,overall_status,action_state,signals,source,rationale,reviewed
```

Validation result:

```text
Rows: 300
Blank IDs: 0
Blank text rows: 0
Reviewed values: true only
Invalid overall_status values: 0
Invalid action_state values: 0
Duplicate IDs: 0
```

## Important schema note

The uploaded CSV uses a richer signal vocabulary than the current production schema.

Current production schema supports 21 signals:

```text
approval_needed
budget
client_action_needed
decision_needed
delivery
dependency
internal_action_needed
missing_access
no_material_change
no_usable_status
positive_progress
quality
resourcing
scope
security_privacy
sign_off
stakeholder
supplier_action_needed
technical
testing
timeline
```

The uploaded file included 98 distinct signal names, including useful but currently unsupported labels such as:

```text
hypothetical_language
owner_present
signoff_completed
signoff_not_confirmed
review_completed
review_needed
timeline_delay
scope_confirmed
quality_issue
access_issue
external_dependency
```

Because the current Trinzo evidence layer expects the existing production schema, the dataset was preserved in original form but a **schema-compatible mapped copy** was created for training/evaluation.

## Drafts created

### 1. Full mapped draft

```text
/root/project-update-status-model/drafts/claire-20260729-project-status-misreads
```

Rows: 300

Source: full uploaded dataset, mapped to the current production signal schema.

Run:

```text
/root/project-update-status-model/runs/draft-claire-20260729-project-status-misreads-20260729T114635Z
```

Metrics:

```text
Rows: 1204
overall_status_cv_macro_f1: 0.5719070961223381
overall_status_cv_micro_f1: 0.5789036544850499
action_state_cv_macro_f1: 0.4404950603162713
action_state_cv_micro_f1: 0.5382059800664452
signals_cv_micro_f1: 0.5839361436767274
signals_cv_macro_f1: 0.5547114241952634
```

### 2. Raw-label draft

```text
/root/project-update-status-model/drafts/claire-20260729-project-status-misreads-raw
```

Rows: 300

Source: original uploaded signal labels without mapping.

Run:

```text
/root/project-update-status-model/runs/draft-claire-20260729-project-status-misreads-raw-20260729T114930Z
```

Metrics:

```text
Rows: 1204
overall_status_cv_macro_f1: 0.5719070961223381
overall_status_cv_micro_f1: 0.5789036544850499
action_state_cv_macro_f1: 0.4404950603162713
action_state_cv_micro_f1: 0.5382059800664452
signals_cv_micro_f1: 0.5723270440251572
signals_cv_macro_f1: 0.5405439651420755
```

This is not production-compatible without schema expansion because many signal labels are invalid under the current schema.

### 3. Core mapped draft

```text
/root/project-update-status-model/drafts/claire-20260729-project-status-misreads-core
```

Rows: 160

Included sources:

```text
true_positive: 60
webinar_planning: 50
hedged_suggestion: 50
```

Run:

```text
/root/project-update-status-model/runs/draft-claire-20260729-project-status-misreads-core-20260729T115114Z
```

Metrics:

```text
Rows: 1064
overall_status_cv_macro_f1: 0.6246542240406557
overall_status_cv_micro_f1: 0.6259398496240601
action_state_cv_macro_f1: 0.4579093237147531
action_state_cv_micro_f1: 0.543233082706767
signals_cv_micro_f1: 0.5991983967935872
signals_cv_macro_f1: 0.5686724738270443
```

## Baseline comparison

Frozen production baseline:

```text
/root/project-update-status-model/baselines/production-freeze-20260729T114011Z
```

Baseline production metrics from latest promoted run:

```text
Rows: 804
overall_status_cv_macro_f1: 0.629427135571594
overall_status_cv_micro_f1: 0.6256218905472637
action_state_cv_macro_f1: 0.5259556074943352
action_state_cv_micro_f1: 0.6119402985074627
signals_cv_micro_f1: 0.6233269598470363
signals_cv_macro_f1: 0.5882157231268794
```

The core candidate is closest to baseline for `overall_status`, but still lower on action-state and signal metrics.

## Targeted probe results

Candidate probe outputs were saved at:

```text
/root/project-update-status-model/runs/draft-claire-20260729-project-status-misreads-20260729T114635Z/old_vs_candidate_probe.md
/root/project-update-status-model/runs/draft-claire-20260729-project-status-misreads-core-20260729T115114Z/old_vs_candidate_probe.md
```

### Improvements seen

The core candidate improved several known webinar/topic-planning false positives:

- “Would we not want to put that as the first one in September?”
  - Old: `decision_required` action top, high `timeline` / `decision_needed`.
  - Core candidate: `unknown_or_insufficient_info` much higher and `no_action` top action.
- “It’s a great topic to address.”
  - Old: `on_track` and `in_progress`.
  - Core candidate: `unknown_or_insufficient_info`, `no_action`, high `no_usable_status`.
- “Maybe we should think about doing a short section on approved suppliers.”
  - Old: action/decision/supplier signals high.
  - Core candidate: more cautious; `unknown_or_insufficient_info` and `no_action` stronger.
- “If the client asks about validation…”
  - Old: high `client_action_needed` / `decision_needed`.
  - Core candidate: stronger `unknown_or_insufficient_info` and `no_usable_status`.

### Regressions / not-yet-fixed issues

The candidate is **not promotion-safe** yet.

Known issues:

- “Claire already sent the supplier list last week and Conor reviewed it yesterday.”
  - Expected: completed history / no new action.
  - Core candidate still incorrectly leans toward action/follow-up/internal-action signals.
- “Is your AI vendor an approved supplier?”
  - Expected: topic question unless assigned.
  - Core candidate still keeps `supplier_action_needed` very high.
- `sign_off` for weak review text improved only slightly and remains too high.
- Headline action-state and signal metrics are below the frozen baseline.

## Promotion decision

No production model was promoted.

Reason:

```text
The trained candidates improve some target false positives, but they still regress or fail on important controls and headline action/signal metrics are below the frozen production baseline.
```

Production remains on the frozen baseline model:

```text
/root/project-update-status-model/models/production/classifier.joblib
```

Rollback remains available at:

```text
/root/project-update-status-model/baselines/production-freeze-20260729T114011Z/model/classifier.joblib
```

## What remaining data is required?

### Required before promoting project-status classifier update

1. **Holdout evaluation CSV**

A separate holdout set is still needed. It should not be used in training.

Recommended size: 80–150 rows.

It should include:

- known misread examples;
- exact approved-supplier topic-vs-action contrasts;
- past-completed vs future-action contrasts;
- review vs sign-off contrasts;
- clear blocker/action/dependency positive controls;
- boring neutral/no-action rows.

2. **More exact completed-history negatives**

The uploaded dataset has completed-work examples, but the probe still fails on mixed wording like:

```text
Claire already sent the supplier list last week and Conor reviewed it yesterday.
```

Need more examples combining:

- supplier/vendor language;
- past-tense completion;
- review language;
- no new action.

3. **More approved-supplier hard negatives**

The dataset helped slightly but did not fix this enough:

```text
Is your AI vendor an approved supplier?
```

Need more contrast pairs:

- approved supplier as a webinar/topic/title/question;
- approved supplier as a real action with owner/deadline;
- approved supplier as a real blocker/dependency.

4. **Schema decision for richer signals**

Claire’s generated data includes potentially useful labels not currently in production, such as:

```text
hypothetical_language
review_completed
signoff_not_confirmed
owner_present
external_dependency
access_issue
quality_issue
timeline_delay
```

Before using those directly, decide whether to:

- keep the current compact schema and map them down, or
- expand the production schema and update downstream consumers.

Recommendation: keep the current compact schema for this classifier for now; create a separate meeting-type/input-quality classifier for transcript mode.

### Separate remaining data for #2 meeting-type classifier

Still needed:

```text
meeting_type_classifier_training.csv
classifier_holdout_eval.csv
```

The current uploaded file is for #1 only. It does not provide the `meeting_type`, `input_quality`, or `recommended_mode` columns needed for the separate meeting-type/input-quality classifier.

## Next recommended action

Do not promote the current candidates.

Recommended next step:

1. Generate/label a holdout set.
2. Add a smaller second batch focused on the two remaining hard failures:
   - approved-supplier topic questions;
   - completed supplier/review history with no new action.
3. Re-run candidate training and compare against both:
   - frozen production baseline;
   - holdout set.
4. Only then promote.
