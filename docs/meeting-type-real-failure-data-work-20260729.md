# Meeting Type / Input Quality Real Failure Data Work — 2026-07-29

## Purpose

Claire asked to use real current failures to fill as many data gaps as possible for the separate meeting-type / input-quality classifier.

The main weak metric before this work was input-quality holdout accuracy:

```text
initial_synthetic_only input_quality_acc: 0.3167
```

## Real sources used

Real/current failure material was mined from:

- the 27 current `/meeting-minutes-final` golden fixtures under `scripts/meeting-minutes-final-golden/`;
- the real uploaded webinar/content-planning failure, queued job `61`, where the transcript included an explicit partial-recording cue and a large timestamp gap;
- real long-form Trinzo client transcript fixtures for DITA, Eakin, QIP, and Abbott cases.

Private transcript excerpts were **not committed** to this repo.

Local private artifact directory:

```text
/data/.openclaw/workspace/generated_classifier_datasets_20260729_real_failures/
```

VPS model artifact directory:

```text
/root/meeting-type-input-quality-model/source_uploads/
```

## Real failure supplement 1

Generated file, private artifact only:

```text
meeting-type-real-failure-supplement-20260729.csv
```

Rows: `69`

Distribution by input quality:

```text
messy_transcript: 31
complete_transcript: 17
low_context: 15
large_time_gap: 4
too_short: 1
partial_transcript: 1
```

Train/holdout split:

```text
train: 55
holdout: 14
```

The supplement mostly captured the real pattern of current failures: raw Teams chatter, long messy transcripts, low-context excerpts, and the job 61 webinar/time-gap failure.

### Candidate run

```text
/root/meeting-type-input-quality-model/runs/real-failure-supplement-20260729T1228Z/model_bundle/classifier.joblib
```

Training rows:

```text
synthetic base: 300
real train rows: 55
combined: 355
```

Cross-validation:

```text
meeting_type / overall_status macro F1: 0.95
input_quality / action_state macro F1: 0.64
signals macro F1: 0.91
```

Holdout comparison:

```text
Synthetic holdout input_quality_acc:
- initial synthetic-only: 0.3167
- real-failure supplement: 0.2500

Real failure holdout input_quality_acc:
- initial synthetic-only: 0.2143
- real-failure supplement: 0.3571

Real failure holdout recommended_mode_acc:
- initial synthetic-only: 0.2143
- real-failure supplement: 0.6429
```

Interpretation:

- Real-failure behaviour improved.
- Synthetic benchmark regressed.
- The data was still imbalanced: lots of `messy_transcript`, not enough `partial_transcript`, `too_short`, or `usable_with_caution`.

## Real quality-gap supplement 2

Generated file, private artifact only:

```text
meeting-type-real-quality-gap-supplement-20260729.csv
```

Rows: `72`

Distribution by input quality:

```text
too_short: 27
low_context: 18
usable_with_caution: 15
partial_transcript: 6
large_time_gap: 6
```

Train/holdout split:

```text
train: 61
holdout: 11
```

This supplement deliberately targeted the underfilled classes using real fixture excerpts and job 61 windows.

### Candidate run

```text
/root/meeting-type-input-quality-model/runs/real-quality-gap-20260729T1234Z/model_bundle/classifier.joblib
```

Training rows:

```text
synthetic base: 300
real supplement 1 train: 55
real quality-gap train: 61
combined: 416
```

Cross-validation:

```text
meeting_type / overall_status macro F1: 0.91
input_quality / action_state macro F1: 0.58
signals macro F1: 0.87
```

Synthetic holdout comparison:

```text
input_quality_acc:
- initial synthetic-only: 0.3167
- real-quality-gap candidate: 0.3917

meeting_type_acc:
- initial synthetic-only: 0.7250
- real-quality-gap candidate: 0.7000

recommended_mode_acc:
- initial synthetic-only: 0.8333
- real-quality-gap candidate: 0.7250
```

Real failure holdout comparison:

```text
input_quality_acc:
- initial synthetic-only: 0.2143
- real-quality-gap candidate: 0.3571

meeting_type_acc:
- initial synthetic-only: 0.1429
- real-quality-gap candidate: 0.5714

recommended_mode_acc:
- initial synthetic-only: 0.2143
- real-quality-gap candidate: 0.4286
```

## Result

The target input-quality metric moved in the right direction:

```text
Original synthetic holdout input_quality_acc: 31.7%
After real quality-gap supplement: 39.2%

Original real failure holdout input_quality_acc: 21.4%
After real quality-gap supplement: 35.7%
```

This is a real improvement, but still not production-ready.

## Promotion decision

No router model was promoted.

Reason:

```text
The real-quality-gap candidate improves input-quality classification, but it reduces recommended-mode accuracy versus the initial router. Since recommended mode is what protects users from fake formal minutes, it is not safe to promote purely for input-quality accuracy.
```

## Recommended next step

Use the real-quality-gap candidate as evidence for the next integration design, not as a drop-in production model.

Best next implementation path:

1. Keep the current production meeting-minutes pipeline unchanged.
2. Add a small deterministic pre-router for obvious cases:
   - explicit partial cue;
   - large timestamp gap;
   - very short/low-substance input;
   - webinar/topic-planning language.
3. Use the meeting-type classifier as a secondary signal, not a sole decision-maker.
4. Derive `recommended_mode` from a combination of deterministic cues + classifier probabilities.
5. Re-test on:
   - job 61;
   - all 27 golden fixtures;
   - synthetic holdout;
   - real failure holdout.

This should preserve the useful recommended-mode behaviour while still benefiting from better real-data input-quality recognition.
