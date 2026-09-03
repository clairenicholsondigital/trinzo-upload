#!/usr/bin/env python3
"""Local HTTP worker for the experimental Qwen meeting-action LoRA.

The model is loaded once at process start. Transcript text is never logged.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
HOST = os.environ.get("QWEN_ACTIONS_HOST", "127.0.0.1")
PORT = int(os.environ.get("QWEN_ACTIONS_PORT", "8768"))
BASE_MODEL = Path(os.environ.get("QWEN_ACTIONS_BASE_MODEL", ROOT / ".models/qwen3-0.6b"))
ADAPTER_MODEL = Path(
    os.environ.get(
        "QWEN_ACTIONS_ADAPTER_MODEL",
        ROOT / ".models/qwen3-0.6b-meeting-actions-multiaction-v1",
    )
)
MAX_BODY_BYTES = int(os.environ.get("QWEN_ACTIONS_MAX_BODY_BYTES", str(4 * 1024 * 1024)))
MAX_NEW_TOKENS = int(os.environ.get("QWEN_ACTIONS_MAX_NEW_TOKENS", "1024"))
MAX_ACTIONS = int(os.environ.get("QWEN_ACTIONS_MAX_ACTIONS", "100"))

MODEL_ID = "clairenicholson078/qwen3-06b-meeting-actions-multiaction-v1"
ADAPTER_REVISION = "511773a88fbf0c0b45f6a619f69c53771403c4c0"
BASE_MODEL_ID = "Qwen/Qwen3-0.6B"
BASE_REVISION = "c1899de289a04d12100db370d81485cdf75e47ca"

SYSTEM_PROMPT = """You extract outstanding meeting actions from transcripts.
Return JSON only. Do not add commentary or markdown.

An action must be a task that somebody accepted, committed to, or was clearly assigned.
Exclude suggestions that were not accepted, questions, general discussion, status updates,
work already completed, and meeting administration or run-of-show instructions.

For owner, use the person who explicitly accepted the task or was explicitly assigned it.
Do not use a person merely because they requested the work, were mentioned, or receive it.
If the owner is not explicit, use \"Not stated\".

Use exactly this shape:
{\"actions\":[{\"action\":\"Clear task wording\",\"owner\":\"Person name or Not stated\"}]}"""


def extract_json_object(raw: str) -> dict[str, Any]:
    cleaned = str(raw or "").strip()
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s*```$", "", cleaned)
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("The model did not return a JSON object.")
    parsed = json.loads(cleaned[start : end + 1])
    if not isinstance(parsed, dict):
        raise ValueError("The model response was not a JSON object.")
    return parsed


def normalize_actions(payload: dict[str, Any]) -> list[dict[str, str]]:
    rows = payload.get("actions")
    if not isinstance(rows, list):
        raise ValueError("The model JSON did not contain an actions array.")

    actions: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for row in rows[:MAX_ACTIONS]:
        if not isinstance(row, dict):
            continue
        action = re.sub(r"\s+", " ", str(row.get("action") or "")).strip()[:1000]
        owner = re.sub(r"\s+", " ", str(row.get("owner") or "Not stated")).strip()[:200]
        if not action:
            continue
        owner = owner or "Not stated"
        key = (action.casefold(), owner.casefold())
        if key in seen:
            continue
        seen.add(key)
        actions.append({"action": action, "owner": owner})
    return actions


class MeetingActionModel:
    def __init__(self) -> None:
        import torch
        from peft import PeftModel
        from transformers import AutoModelForCausalLM, AutoTokenizer

        torch.set_num_threads(max(1, int(os.environ.get("QWEN_ACTIONS_CPU_THREADS", "6"))))
        self.torch = torch
        self.tokenizer = AutoTokenizer.from_pretrained(
            BASE_MODEL, local_files_only=True, use_fast=True
        )
        base = AutoModelForCausalLM.from_pretrained(
            BASE_MODEL, local_files_only=True, dtype=torch.float32
        )
        self.model = PeftModel.from_pretrained(base, ADAPTER_MODEL, local_files_only=True)
        self.model.eval()
        configured_context = int(getattr(self.model.config, "max_position_embeddings", 32768))
        self.max_input_tokens = min(
            int(os.environ.get("QWEN_ACTIONS_MAX_INPUT_TOKENS", "30000")),
            configured_context - MAX_NEW_TOKENS,
        )
        self.lock = threading.Lock()

    def extract(self, transcript: str) -> dict[str, Any]:
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": "DENOISED MEETING TRANSCRIPT:\n\n" + transcript.strip(),
            },
        ]
        rendered = self.tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True,
            enable_thinking=False,
        )
        inputs = self.tokenizer(rendered, return_tensors="pt", add_special_tokens=False)
        input_tokens = int(inputs["input_ids"].shape[1])
        if input_tokens > self.max_input_tokens:
            error = ValueError(
                f"The denoised transcript is too long for one model prompt "
                f"({input_tokens} tokens; maximum {self.max_input_tokens})."
            )
            error.status_code = 413  # type: ignore[attr-defined]
            raise error

        started = time.monotonic()
        with self.lock, self.torch.inference_mode():
            output = self.model.generate(
                **inputs,
                max_new_tokens=MAX_NEW_TOKENS,
                do_sample=False,
                pad_token_id=self.tokenizer.eos_token_id,
            )
        generated = output[0, input_tokens:]
        raw = self.tokenizer.decode(generated, skip_special_tokens=True).strip()
        actions = normalize_actions(extract_json_object(raw))
        return {
            "actions": actions,
            "rawModelOutput": raw,
            "inputTokens": input_tokens,
            "outputTokens": int(generated.shape[0]),
            "generationMs": round((time.monotonic() - started) * 1000),
        }


MODEL: MeetingActionModel | None = None


class Handler(BaseHTTPRequestHandler):
    server_version = "TrinzoQwenActions/1"

    def log_message(self, format_string: str, *args: Any) -> None:
        # Log route/status only; never include request bodies.
        print(f"[qwen-actions] {self.address_string()} {format_string % args}", flush=True)

    def send_json(self, status: int, payload: dict[str, Any]) -> None:
        encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:
        if self.path != "/health":
            self.send_json(404, {"ok": False, "error": "Not found."})
            return
        self.send_json(
            200,
            {
                "ok": MODEL is not None,
                "model": MODEL_ID,
                "modelRevision": ADAPTER_REVISION,
                "baseModel": BASE_MODEL_ID,
                "baseRevision": BASE_REVISION,
                "device": "cpu",
            },
        )

    def do_POST(self) -> None:
        if self.path != "/extract-actions":
            self.send_json(404, {"ok": False, "error": "Not found."})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > MAX_BODY_BYTES:
                self.send_json(413, {"ok": False, "error": "Request body is empty or too large."})
                return
            payload = json.loads(self.rfile.read(length))
            transcript = payload.get("denoisedTranscript") if isinstance(payload, dict) else None
            if not isinstance(transcript, str) or not transcript.strip():
                self.send_json(400, {"ok": False, "error": "denoisedTranscript is required."})
                return
            if MODEL is None:
                self.send_json(503, {"ok": False, "error": "Model is not loaded."})
                return
            result = MODEL.extract(transcript)
            self.send_json(
                200,
                {
                    "ok": True,
                    "model": MODEL_ID,
                    "modelRevision": ADAPTER_REVISION,
                    "baseModel": BASE_MODEL_ID,
                    "baseRevision": BASE_REVISION,
                    **result,
                },
            )
        except json.JSONDecodeError:
            self.send_json(400, {"ok": False, "error": "Request body must be valid JSON."})
        except Exception as error:  # worker boundary
            status = int(getattr(error, "status_code", 502))
            print(f"[qwen-actions] generation failed: {type(error).__name__}: {error}", flush=True)
            self.send_json(status, {"ok": False, "error": str(error)})


def main() -> None:
    global MODEL
    started = time.monotonic()
    MODEL = MeetingActionModel()
    print(
        json.dumps(
            {
                "event": "qwen_actions_model_loaded",
                "model": MODEL_ID,
                "baseModel": BASE_MODEL_ID,
                "loadMs": round((time.monotonic() - started) * 1000),
                "host": HOST,
                "port": PORT,
            }
        ),
        flush=True,
    )
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
