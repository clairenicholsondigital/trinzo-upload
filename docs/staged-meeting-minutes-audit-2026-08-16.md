# Staged meeting-minutes audit — 16 August 2026

## Scope

This audit re-runs the ten canonical golden transcripts through the current `/staged-meeting-minutes` canonical pipeline (`canonical_staged_v2`) with no human edits, at branch head `b16ba3f` (“Improve staged meeting minutes robustness”). It measures the branch’s robustness work against the 13 August benchmark and the earlier live baselines.

Method note: the sandbox used for this run cannot reach huggingface.co, so embeddings were served through the pipeline’s supported `MINUTES_MINILM_WORKER_URL` hook from an ONNX conversion of the same `sentence-transformers/all-MiniLM-L6-v2` model (mean pooling, L2-normalised — numerically equivalent within float tolerance). No pipeline code was modified for the run.

## Headline result

| Metric | Reported live baseline | Corrected unchanged-output baseline | 13 Aug benchmark | This audit (16 Aug) |
|---|---:|---:|---:|---:|
| Total errors | 47 | 37 | 11 | 5 |
| Blocking errors | 14 | 8 | 5 | 3 |
| Maximum errors in one transcript | 15 | 15 | 3 | 2 |
| Average weighted score | 74.0 | — | 93.8 | 96.6 |
| Transcripts below 5 errors | 6/10 | 8/10 | 10/10 | 10/10 |

Additional checks in this run: mean coverage score 97.8, all ten cases scored ≥ 75, the semantic-lock audit passed on all ten cases (final presentation never altered locked canonical semantics), and all ten cases ran in `minilm_commitment_threads` extraction mode.

## Per-transcript result

| Case | Errors | Blocking | Weighted score |
|---|---:|---:|---:|
| 01 Explicit action recap | 1 | 1 | 92 |
| 02 Scattered actions | 1 | 1 | 92 |
| 03 Superseded actions | 0 | 0 | 100 |
| 04 Completed vs outstanding | 0 | 0 | 100 |
| 05 Hypothetical language | 0 | 0 | 100 |
| 06 Ownership chaos | 0 | 0 | 100 |
| 07 Deadline torture | 0 | 0 | 100 |
| 08 Attendee provenance | 1 | 1 | 92 |
| 09 No-action meeting | 2 | 0 | 90 |
| 10 Chaos goblin | 0 | 0 | 100 |
## Remaining defects

Five errors remain, in two families:

1. **Conversational fragments still surviving action promotion (3 blocking errors).**
   - Case 01: “Tom Whitfield: Find that little clock top right” — a screen-share/UI aside promoted to an action.
   - Case 02: “Not stated: Just run through where the Hartwell site’s at, I don’t want this to take long” — a meeting-facilitation request promoted to an action.
   - Case 08: “Not stated: Just watch it closely [due: next week]” — a monitor-only remark promoted to an action with an inferred deadline.
   - Pattern: short imperative utterances (“find…”, “just run through…”, “just watch…”) that are meeting mechanics or watch-items rather than work commitments. The existing UI-instruction and rhetorical-remark filters do not yet catch bare imperatives without an object that names deliverable work.

2. **Risk phrasing not editorialised in the no-action meeting (2 non-blocking errors, one underlying issue).**
   - Case 09 captures the supplier-B batch-variation watch item, but publishes it as three stitched raw conversational turns instead of a minuted risk statement (expected: “Batch variation on supplier B within spec; monitor only (no action)”). The evaluator counts this once as a missing key risk and once as an extra risk, but the content is present — this is an editorial-normalisation miss, not an extraction miss.

## Verification

- Full repository suite at branch head: 276 Python tests and 166 Node tests passed.
- Fresh ten-transcript no-edit golden run: 5 errors, 3 blocking, maximum 2 errors per case, semantic lock passed 10/10.

## Recommended next steps

- Extend action-promotion rejection to bare meeting-mechanics imperatives (“run through”, “watch it”, “find that…”) unless corroborated by an owner assignment or recap, closing the three remaining blocking errors.
- Route agreed watch-items through the risk editorial rewrite so monitor-only risks publish as minuted statements rather than stitched transcript turns (case 09).
- Re-record the canonical golden run directory (`scripts/record_canonical_staged_golden.js`) once the above land, so the recorded baseline matches branch behaviour.
