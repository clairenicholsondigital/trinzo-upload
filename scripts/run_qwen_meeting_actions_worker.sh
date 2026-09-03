#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
exec .venv-qwen-actions/bin/python scripts/qwen_meeting_actions_worker.py
