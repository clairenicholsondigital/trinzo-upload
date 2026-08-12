# Canonical staged backend experiment — baseline v1

Run date: 12 August 2026

This experiment compares the existing staged no-edit pipeline with the isolated
`canonical_staged_v1` backend path. Both runs use the same ten core golden
transcripts and the same deterministic lexical-semantic proxy scorer.

The canonical path does not call the existing staged builders, action ledger,
recovery inventory, retry chain, fallback extractor, or preservation/merge
stack. It consists of five isolated modules (571 lines at this baseline):

1. transcript evidence preparation;
2. canonical state and no-edit acceptance transitions;
3. a two-mode evidence-topology assessment (`standard` or `distributed_recap`);
4. context, content, and action proposals;
5. final rendering plus semantic-lock and completeness audits.

## Summary

| Metric | Existing staged path | Canonical staged v1 |
|---|---:|---:|
| Mean score | 80.7% | 94.6% |
| Cases at or above 75% | 9/10 | 10/10 |
| Semantic-lock audit passes | Not represented | 10/10 |
| Model calls in canonical runner | N/A | 0 |
| Correct zero-action output | Yes | Yes |

## Case scores

| Case | Existing | Canonical | Delta |
|---|---:|---:|---:|
| 01 Explicit action recap | 49.4 | 91.2 | +41.8 |
| 02 Scattered actions | 75.0 | 88.8 | +13.8 |
| 03 Superseded actions | 90.0 | 100.0 | +10.0 |
| 04 Completed vs outstanding | 75.0 | 100.0 | +25.0 |
| 05 Hypothetical language | 90.0 | 100.0 | +10.0 |
| 06 Ownership chaos | 90.0 | 100.0 | +10.0 |
| 07 Deadline torture | 75.0 | 85.0 | +10.0 |
| 08 Attendee provenance | 90.0 | 100.0 | +10.0 |
| 09 No-action meeting | 82.5 | 88.8 | +6.3 |
| 10 Chaos goblin | 90.0 | 92.5 | +2.5 |

## Interpretation

The experiment supports continuing the simpler architecture. It improves the
proxy mean by 13.9 points while providing an explicit authoritative-state
contract. The evidence-topology router activates only when it detects an
explicit action recap with multiple cross-turn assignments; it raised case 01
from 63.1 to 91.2 without changing cases 2–10.

It is not yet a production replacement: raw discussion prose has not had a
human-quality comparison against the four real benchmark pairs, and the new
distributed-recap mode needs unrelated examples to confirm it generalises
beyond the supplied rehearsal fixture.

The next validation should therefore focus on qualitative false positives,
discussion wording, and the real transcript/human-minutes benchmarks rather
than adding more extraction layers to chase the remaining synthetic score.

## Broader generalisation check

The topology router was also run over all 27 transcripts in the older final
golden pack plus the four human-reference transcripts:

- 31/31 unrelated repository transcripts stayed on `standard`;
- 0 false `distributed_recap` activations were observed;
- an unrelated synthetic planning recap activated `distributed_recap` and
  retained both cross-turn owners and assignments;
- ordinary references to previous actions and a single-assignment action
  heading stayed on `standard`.

The broader run also exposed an important limitation in the pipeline as a
whole. Against the older 27-case final-minutes evaluator, only 2/27 cases passed.
Most failures came from the deliberately narrow standard action vocabulary and
raw discussion rendering, not from the new topology router. Therefore 94.6%
must be read as the score for the ten-case core extraction suite, not as proof
that the experimental pipeline is ready to replace the production minutes
workflow. The next work should broaden the single standard extraction pass and
add clean discussion synthesis while preserving the two-mode architecture.

## Reproduction

```bash
node scripts/run_canonical_staged_golden.js /tmp/canonical-staged-baseline
```

The endpoint exercising the same runner is:

```text
POST /api/staged-meeting-minutes/canonical-no-edit-pass
```

## MiniLM-first v2 experiment

The next isolated iteration replaces verb-vocabulary eligibility with one
batched MiniLM semantic profile. It uses the existing trained evidence bundle
for evidence type, action state and signal probabilities, plus embedding topic
clusters. JavaScript is limited to transcript parsing, bounded commitment
threads, owner/deadline validation, canonical state transitions and rendering.

The route exposes the experiment as `canonical_staged_v2` with strategy
`semantic_v2`. Its diagnostic contract includes:

- every event's class probabilities, primary class, confidence and margin;
- topic cluster membership, evidence IDs and cohesion;
- commitment threads and unresolved-thread warnings;
- uncaptured high-confidence evidence in the completeness audit;
- topology as an observation/boundary, not a separate extraction implementation;
- semantic-lock verification after deterministic final rendering.

Initial calibration results are intentionally retained as a learning baseline:

| Suite | Result | Interpretation |
|---|---:|---|
| Core ten | 48.8% mean; 1/10 at 75% | Raw classifier gating is too conservative for commitments and too noisy for decisions/risks. |
| Older final 27 | 3/27 pass | One better than the original simplified path, but not a release candidate. |
| Semantic locks | 10/10 | The canonical-state invariant remains intact. |

This does **not** supersede the 94.6% v1 core baseline. It identifies the next
maintainable improvement: retrain/calibrate the MiniLM classifier on general
meeting speech acts and thread-level labels rather than restoring transcript-
specific rewrites. The required labels are commitment, request, acceptance,
decision, risk, completed history, hypothetical, rejection/supersession,
informational and administrative. Evaluation should optimise both item recall
and abstention, with the core ten and older 27 always reported separately.

Reproduce the broad semantic run and score it with:

```bash
node scripts/run_canonical_final_golden.js /tmp/canonical-final-minilm-v2 semantic_v2
python3 scripts/run_meeting_minutes_final_golden_eval.py \
  --precomputed-dir /tmp/canonical-final-minilm-v2 --json
```

## AI-authored classifier augmentation experiment

An isolated augmentation pipeline now produces semantic contrast families
without copying text or expected answers from either frozen golden suite. The
first candidate has 240 rows across 20 scenario families and twelve speech
acts. Each family contains positive and hard-negative forms of the same
underlying work: commitment, request/acceptance, minutes-style assignment,
ownerless need, hypothetical, completed history, rejection, decision,
unconfirmed option, risk, informational update and administration.

Controls:

- every generated row is marked `candidate_human_review_required`;
- the trainer refuses unreviewed rows unless explicitly run in experimental
  mode;
- all semantic siblings share one `group_id` and one split;
- duplicate text and cross-split group leakage block dataset creation;
- frozen golden wording is not used in training;
- candidate bundles are written separately and never activated automatically.

Results on the untouched core ten:

| MiniLM candidate | Core mean | Notes |
|---|---:|---|
| Existing evidence bundle | 48.8% | Pre-augmentation MiniLM-first v2 baseline. |
| AI contrast rows only | 61.6% | Better semantic coverage but loses older domain breadth. |
| Reviewed master + AI contrast rows | 60.4% | Retains older coverage; preferred candidate for further review. |

The increase is meaningful, but neither candidate passes the release gate.
Decision/risk false positives and varied conversational commitment threads are
the next augmentation targets. Human review of candidate labels should precede
the next training run.

Reproduce:

```bash
python3 scripts/build_canonical_speech_act_training.py
python3 scripts/merge_canonical_speech_act_training.py \
  --master /root/meeting-minutes-evidence-model/data/training_data_complete_master_v2_20260812.csv \
  --candidates /root/meeting-minutes-evidence-model/data/canonical_speech_act_candidates_v1.csv \
  --output /root/meeting-minutes-evidence-model/data/canonical_speech_act_augmented_master_v1.csv
```
