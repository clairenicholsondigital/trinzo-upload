# Staged meeting-minutes golden benchmark — 13 August 2026

## Scope

This benchmark preserves the existing simplified `/staged-meeting-minutes` flow and runs the ten canonical golden transcripts through the enriched MiniLM evidence pipeline with no human edits.

The evaluator now uses semantic token normalisation and one-to-one matching. The original 47-error report remains in the historical run directory; re-scoring those unchanged outputs with the corrected evaluator produces a 37-error comparison baseline.

## Result

| Metric | Reported live baseline | Corrected unchanged-output baseline | Updated local pipeline |
|---|---:|---:|---:|
| Total errors | 47 | 37 | 11 |
| Blocking errors | 14 | 8 | 5 |
| Maximum errors in one transcript | 15 | 15 | 3 |
| Average weighted score | 74.0 | — | 93.8 |
| Transcripts below 5 errors | 6/10 | 8/10 | 10/10 |

## Per-transcript result

| Case | Errors | Blocking | Weighted score |
|---|---:|---:|---:|
| 01 Explicit action recap | 0 | 0 | 100 |
| 02 Scattered actions | 3 | 2 | 82 |
| 03 Superseded actions | 0 | 0 | 100 |
| 04 Completed vs outstanding | 0 | 0 | 100 |
| 05 Hypothetical language | 1 | 0 | 96 |
| 06 Ownership chaos | 1 | 1 | 92 |
| 07 Deadline torture | 1 | 0 | 96 |
| 08 Attendee provenance | 3 | 2 | 82 |
| 09 No-action meeting | 0 | 0 | 100 |
| 10 Chaos goblin | 2 | 0 | 90 |

## Changes under test

- Semantic, one-to-one golden matching prevents paraphrased actions from being counted as both missing and extra.
- Existing enriched-head outputs suppress bare agreement, historical confirmation, recap and context-only evidence.
- Candidate-level decision and risk consolidation resolves repeated evidence into canonical entities.
- Distributed action recaps merge duplicate expressions and attach bounded preparation/live-session timing.
- Conversational UI instructions and unresolved second-person fragments do not survive action promotion.

No stage, screen, confirmation boundary or human-authoritative-state behavior changed.

## Verification

- Full repository suite: 273 Python tests and 78 Node tests passed.
- Fresh ten-transcript no-edit golden run: 11 errors, 5 blocking, maximum 3 errors per case.
