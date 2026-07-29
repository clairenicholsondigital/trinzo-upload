# Meeting Type / Input Quality Existing-Data Improvement — 2026-07-29

## Question

Claire asked whether existing data could be used to improve the meeting-type / input-quality router further, especially after the input-quality metric moved from 31.7% to 39.2%.

## Existing data used

No new external/user-provided data was added for this pass.

Existing sources evaluated:

- synthetic meeting-type training data generated from the dataset-assistance export;
- real current failure supplements created from golden fixtures and job 61;
- synthetic holdout;
- real failure holdout;
- real quality-gap holdout.

Private transcript excerpts remain outside GitHub.

## Experiment 1: high-confidence deterministic quality cues

A hybrid router was prototyped on the VPS using deterministic cues plus classifier predictions.

High-confidence cues tested:

- explicit partial transcript language, e.g. “just turned on the transcript”;
- large timestamp gaps, e.g. jumps around 30 minutes;
- very short / no-substance input;
- webinar/topic-planning language;
- explicit low-context cues.

Evaluation output:

```text
/root/meeting-type-input-quality-model/runs/real-quality-gap-20260729T1234Z/hybrid_router_eval.json
/root/meeting-type-input-quality-model/runs/real-quality-gap-20260729T1234Z/hybrid_router_eval_v2.json
```

### Result

The first naive hybrid was too blunt and damaged the synthetic holdout by treating concise-but-valid snippets as too short.

The tightened high-confidence hybrid improved the hardest real quality-gap holdout:

```text
quality_gap_holdout, real_quality_gap model-only:
- input_quality_acc: 0.5455
- recommended_mode_acc: 0.6364

quality_gap_holdout, real_quality_gap + hybrid_v2:
- input_quality_acc: 0.7273
- recommended_mode_acc: 0.7273
```

But it still hurt broader synthetic holdout performance:

```text
synthetic_holdout, real_quality_gap model-only:
- input_quality_acc: 0.3917
- recommended_mode_acc: 0.7250

synthetic_holdout, real_quality_gap + hybrid_v2:
- input_quality_acc: 0.1333
- recommended_mode_acc: 0.4417
```

Interpretation:

```text
High-confidence rules are useful for very specific live failure patterns, but should not be applied as broad overrides yet.
```

## Experiment 2: train recommended_mode directly

The earlier router derived `recommended_mode` from predicted meeting type + predicted input quality.

A new direct-mode classifier was trained to predict:

- meeting type;
- input quality;
- recommended output mode;
- signals.

Run:

```text
/root/meeting-type-input-quality-model/runs/router-mode-direct-20260729T1308Z/model_bundle/classifier.joblib
```

Training data:

```text
416 rows total
= synthetic base + real failure train supplement + real quality-gap train supplement
```

Cross-validation:

```text
meeting_type macro F1: 0.91
input_quality macro F1: 0.58
recommended_mode macro F1: 0.77
signals macro F1: 0.87
```

Holdout evaluation output:

```text
/root/meeting-type-input-quality-model/runs/router-mode-direct-20260729T1308Z/direct_mode_holdout_eval.json
```

### Result

On synthetic holdout:

```text
initial derived recommended_mode_acc: 0.8333
real_quality_gap derived recommended_mode_acc: 0.7250
direct_mode recommended_mode_acc: 0.7583
```

On real failure holdout:

```text
initial derived recommended_mode_acc: 0.2143
real_quality_gap derived recommended_mode_acc: 0.4286
direct_mode recommended_mode_acc: 0.2857
```

On real quality-gap holdout:

```text
initial derived recommended_mode_acc: 0.0909
real_quality_gap derived recommended_mode_acc: 0.6364
direct_mode recommended_mode_acc: 0.5455
```

Interpretation:

```text
Directly predicting recommended_mode is promising conceptually, but this candidate is not better than the real_quality_gap derived-mode candidate on real failure data.
```

## Best current existing-data candidate

For input-quality recognition, the best broad model-only candidate remains:

```text
/root/meeting-type-input-quality-model/runs/real-quality-gap-20260729T1234Z/model_bundle/classifier.joblib
```

It improved the original target metric:

```text
synthetic holdout input_quality_acc: 0.3167 -> 0.3917
```

And improved real failure holdout input quality:

```text
real failure holdout input_quality_acc: 0.2143 -> 0.3571
```

For the hardest real quality-gap subset, high-confidence cues on top of that model are useful:

```text
quality_gap_holdout input_quality_acc: 0.5455 -> 0.7273
quality_gap_holdout recommended_mode_acc: 0.6364 -> 0.7273
```

## Promotion decision

No model or hybrid router should be promoted yet.

Reason:

```text
The existing data can improve input-quality classification, but the best input-quality improvements still trade off against recommended-mode reliability on broader holdouts. The router needs selective use of cues, not a global replacement.
```

## Recommended implementation path

Use existing data to build a **selective pre-router**, not a full model swap:

1. Keep `/meeting-minutes-final` production generation unchanged for now.
2. Add a small router utility that detects only high-confidence transcript conditions:
   - explicit partial-transcript cue;
   - large timestamp gap;
   - obvious no-substance / audio-check-only input;
   - webinar/content-planning cues.
3. Use these conditions to set a cautious `recommended_mode` before generation:
   - `topic_summary_with_caution` for webinar/content-planning;
   - `sparse_minutes` for partial/large-gap/non-formal input;
   - `ask_for_better_transcript` only for genuinely tiny/no-substance input.
4. Use the classifier as a secondary confidence signal, especially when deterministic cues are absent.
5. Re-evaluate on:
   - job 61;
   - all 27 golden fixtures;
   - synthetic holdout;
   - real failure holdout;
   - quality-gap holdout.

This is safer than promoting the current classifier directly and is more aligned with the product goal: avoid fake formal minutes while still producing useful output.
