# Qwen meeting-actions trial

This is an isolated experimental path for `/staged-meeting-minutes-finetune`:

1. Accept a `.docx`, `.txt`, or `.csv` transcript using the existing upload reader.
2. Run the existing meeting-minutes-usefulness v3 MiniLM denoiser.
3. Send the entire denoised transcript in one prompt to a local Qwen model.
4. Return review-only JSON containing `action` and `owner`.

It does not change or fall back to the normal `/staged-meeting-minutes` workflow.

## Pinned models

- Adapter: `clairenicholson078/qwen3-06b-meeting-actions-lora` at `0361e1efb3b6158ee2e5cb868405ded4402f48b3`
- Base: `Qwen/Qwen3-0.6B` at `c1899de289a04d12100db370d81485cdf75e47ca`

The adapter repository contains a PEFT LoRA adapter, not a complete model. The
base model is therefore required as well. Model files live under ignored
`.models/` directories and can be reproduced with:

```bash
python3 scripts/install_qwen_meeting_actions_model.py
python3 -m venv --system-site-packages .venv-qwen-actions
.venv-qwen-actions/bin/pip install -r requirements-qwen-actions.txt
```

Run the worker with:

```bash
scripts/run_qwen_meeting_actions_worker.sh
```

It binds to `127.0.0.1:8768` by default and loads the model once. The Node API
uses `QWEN_ACTIONS_WORKER_URL` and a five-minute default timeout.

## Important trial limitations

- The adapter model card does not document its training prompt, evaluation
  results, or licence. Confirm the licence before treating this as distributable.
- A basic smoke test returned valid JSON, but also showed that the model can
  incorrectly merge a suggestion into a confirmed action. Every row must be
  reviewed against the transcript.
- This route tests action and owner only. It does not extract deadlines or
  replace the staged minutes workflow.
- The worker currently runs CPU float32 and uses about 3.2 GB resident memory on
  this VPS. Only one generation runs at a time.
