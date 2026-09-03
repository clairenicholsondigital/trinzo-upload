# Trooper chunked meeting-actions trial

This is an isolated experimental path for `/staged-meeting-minutes-finetune`:

1. Accept a `.docx`, `.txt`, or `.csv` transcript using the existing upload reader.
2. Run the existing meeting-minutes-usefulness v3 MiniLM denoiser.
3. Ask Trooper to write a simple Discussion section and divide the numbered transcript into contiguous conversation chunks.
4. Extract action candidates from each chunk and classify each as a real action, planned activity, or not an action.
5. Return review-only JSON containing `action`, `owner`, `deadline`, and verbatim evidence for real actions.

It does not change or fall back to the normal `/staged-meeting-minutes` workflow.

## Previous local-model trial

- Adapter: `clairenicholson078/qwen3-06b-meeting-actions-multiaction-v1` at `511773a88fbf0c0b45f6a619f69c53771403c4c0`
- Base: `Qwen/Qwen3-0.6B` at `c1899de289a04d12100db370d81485cdf75e47ca`

The earlier version of this route used the adapter below. It is retained locally
for reproducibility but is no longer called by the finetune page:

```bash
python3 scripts/install_qwen_meeting_actions_model.py
python3 -m venv --system-site-packages .venv-qwen-actions
.venv-qwen-actions/bin/pip install -r requirements-qwen-actions.txt
```

The current route uses the configured Trooper endpoint and model.

## Important trial limitations

- Chunk boundaries, evidence coverage and verbatim evidence are validated
  deterministically before results are returned.
- This route tests action, owner and deadline extraction. It does not replace
  the staged minutes workflow.
- Runtime and API usage increase with the number of chunks and extracted
  candidates because each candidate receives a separate final classification.
