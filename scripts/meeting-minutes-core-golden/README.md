# Trinzo meeting-minutes core golden set v1.0

This directory is the current core golden set for Trinzo meeting-minutes testing.
It was added from `Trinzo_Meeting_Minutes_Test_Suite_v1.0.zip` on 2026-08-12
and should be treated as the baseline set for present staged meeting-minutes
regression and evaluation work.

This package is a reproducible, extendable evaluation suite for the staged meeting-minutes workflow. It combines ten numbered adversarial regression cases with four real-world transcript/human-minutes benchmark pairs.

## Quick start

1. Run each `cases/*/transcript.docx` through the same ingest path as production.
2. Save the tool result as JSON using `schemas/output.schema.json`, or map it into that shape.
3. Run `python tools/validate_suite.py` to verify the package.
4. Run `python tools/score_output.py CASE_DIR OUTPUT.json` for a deterministic baseline score.
5. Record qualitative differences against `gold_minutes.md`, especially wording-equivalent actions, discussion coverage and unsupported claims.

## Directory layout

- `cases/`: ten fixed adversarial cases. Each has `transcript.docx`, `manifest.json`, and `gold_minutes.md`.
- `human_benchmarks/`: four Jacqui transcript and human-minutes pairs for real-world semantic review.
- `schemas/`: stable manifest and normalised-output contracts.
- `tools/`: validation and baseline scoring scripts.
- `templates/`: case-extension and run-record templates.
- `source_reference/`: useful supplied material without a paired human oracle.

## Evaluation rules

- Compare meanings, not exact prose.
- Do not award an action unless owner, action state and due-date evidence are supported.
- An invented owner, deadline, attendee or action is more serious than a harmless wording difference.
- Completed, rejected, hypothetical and superseded work must stay out of outstanding actions.
- Mentioned people and organisations must not leak into attendee lists.
- Case 9 must retain an empty actions list.

## Adding a case

Copy `templates/new_case/`, replace its transcript, complete every manifest field, then run the validator. Give the case the next two-digit prefix and keep the filenames unchanged. Add a focused test purpose and explicit forbidden claims so failures remain diagnosable.
