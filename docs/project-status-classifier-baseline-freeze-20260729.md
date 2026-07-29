# Project Status Classifier Baseline Freeze — 2026-07-29

This records the production baseline before any new training data is imported or promoted for the project-status embedding classifier.

## Baseline location

VPS baseline directory:

```text
/root/project-update-status-model/baselines/production-freeze-20260729T114011Z
```

## Production model frozen

Current production model path at freeze time:

```text
/root/project-update-status-model/models/production/classifier.joblib
```

Rollback copy:

```text
/root/project-update-status-model/baselines/production-freeze-20260729T114011Z/model/classifier.joblib
```

Model SHA256:

```text
4924a384ba996fca3c49b8f1f23249130246adcb0aef74062fd49c43d92c80a1
```

Embedding model:

```text
sentence-transformers/all-MiniLM-L6-v2
```

## Metrics captured

Full model status output is saved at:

```text
/root/project-update-status-model/baselines/production-freeze-20260729T114011Z/model_status.txt
```

Key metrics from the latest promoted run:

```text
Latest run: runs/full-promoted-gap5-20260710T1928Z
Rows: 804
overall_status_cv_macro_f1: 0.629427135571594
overall_status_cv_micro_f1: 0.6256218905472637
action_state_cv_macro_f1: 0.5259556074943352
action_state_cv_micro_f1: 0.6119402985074627
signals_cv_micro_f1: 0.6233269598470363
signals_cv_macro_f1: 0.5882157231268794
```

At freeze time, `model_status.py` reported:

```text
Training rows: 904
Draft batches: 14
Runs: 19
Production model: yes
```

Note: training rows include later/draft data, but the latest promoted production run reports 804 rows.

## Probe outputs saved

Known misreads/control probe outputs are saved at:

```text
/root/project-update-status-model/baselines/production-freeze-20260729T114011Z/probes/known_misreads_and_controls.json
/root/project-update-status-model/baselines/production-freeze-20260729T114011Z/probes/known_misreads_and_controls.md
```

The probe includes the current behaviour for:

- webinar/session-title wording such as “November one will be…”;
- content sequencing such as “first one in September”;
- topic validation such as “great topic to address”;
- terminology/regulatory topic fragments;
- approved-supplier question wording;
- soft/modal suggestions;
- hypothetical/conditional talking points;
- completed past work;
- partial transcript cues;
- weak review wording;
- clear action/deadline positive control;
- clear blocker/dependency positive control.

## Snapshot artifacts included

The baseline directory includes:

```text
BASELINE.md
metadata.json
model/classifier.joblib
model/metrics.json
model/per_signal_cv_metrics.csv
model/training_data_used.csv
model_sha256.txt
model_status.txt
registry__model_registry.csv
data__training_data.csv
labels__status_schema.json
probes/known_misreads_and_controls.json
probes/known_misreads_and_controls.md
```

## Rollback note

If a future promoted classifier regresses, the frozen model can be restored from:

```text
/root/project-update-status-model/baselines/production-freeze-20260729T114011Z/model/
```

Before rollback, compare SHA256 hashes and preserve the newer model bundle in a separate timestamped folder.
