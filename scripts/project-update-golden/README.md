# Project update golden evaluation pack

This folder contains repeatable evaluation cases for `/project-update-test`.

## Important caveat

The current cases under `synthetic/` are **AI-generated synthetic examples**. They are designed to exercise known behaviours and regression risks, such as semantic milestone matching, reworded risk matching, carried-forward context, and retrieval boundary rules.

Passing this pack means the workflow passes these designed synthetic scenarios. It does **not** prove real-world performance on real client/project transcripts.

Add real examples over time under `real/` using the same case shape. Keep real examples anonymised/sanitised unless explicitly allowed otherwise.

## Runner

```bash
python3 scripts/run_project_update_golden_eval.py --mode synthetic
python3 scripts/run_project_update_golden_eval.py --mode all
```

The runner uses behavioural checks rather than exact prose matching.

It separates:

- **Required failures** — safety/contract behaviours that must pass, such as schema existence, graceful execution, carried-forward required rows, and retrieved knowledge never being marked as transcript evidence.
- **Advisory warnings** — quality expectations from the synthetic examples, such as “this transcript should probably create a new risk” or “overall health should probably be amber”. These are deliberately reported without failing the suite because the examples are AI-generated and may describe aspirational quality rather than current guaranteed behaviour.

A clean required pass with warnings should be read as:

> The workflow passed the synthetic safety/contract gate, and the warnings identify quality gaps or expectations to review.

It checks things like:

- output schema exists;
- expected overall health is reported as an advisory quality signal;
- milestones/risks can be found by label fragments;
- carried-forward rows appear when expected;
- trend/matching provenance is acceptable when the analyser exposes it;
- retrieved knowledge is not marked as transcript evidence;
- sparse/garbage cases do not hallucinate excessive updates.
