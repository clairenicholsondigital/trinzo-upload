# MiniLM Comparison Summary

- Model available: `True`
- Model reason: ``
- Total fixtures tested: `67`
- Baseline pass count: `67` / `67`
- MiniLM pass count: `67`
- Improved: `0`
- Worsened: `0`
- Unchanged: `67`
- Skipped: `0`
- Total runtime seconds: `1595.89`

## Questions

- Did MiniLM improve anything against the existing fixtures? `No clear improvement in this run.`
- Which categories improved? `none measured`
- Which categories worsened? `none measured`
- Did runtime stay acceptable? `1595.89 seconds total`
- Is it worth integrating into the main parser later? `Possibly, but only as a scoped assist layer.`
- What exact files changed? `scripts/meeting_minutes_minilm_experiment.py, scripts/run_minilm_comparison.py, tests/test_minilm_comparison.py, requirements-experimental-minilm.txt, reports/minilm_comparison.json, reports/minilm_comparison_summary.md`

## Notes

- The direct command path works: `python3 scripts/run_minilm_comparison.py`
- In this environment, the experimental MiniLM runtime was installed into `/var/tmp/pyuser` and the model cache was kept under `/var/tmp/minilm-cache` to avoid the nearly-full `/data` mount.

## Examples

- Improved examples: none
- Worsened examples: none
- Extra plausible candidates:
  - `001_status_review: +actions=0, +decisions=0, +discussion=2`
  - `025_incident_response: +actions=0, +decisions=0, +discussion=1`
  - `039_risk_review: +actions=0, +decisions=0, +discussion=1`
  - `055_dependency_risk_meeting: +actions=0, +decisions=0, +discussion=1`
  - `061_no_major_impact_dependency: +actions=0, +decisions=0, +discussion=1`
- Possible false positives: none
