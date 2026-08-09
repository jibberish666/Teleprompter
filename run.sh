#!/usr/bin/env bash
# Local AI Teleprompter launcher.
set -euo pipefail
cd "$(dirname "$0")"

PORT="${TELEPROMPTER_PORT:-8000}"
exec .venv/bin/python server.py --port "$PORT" "$@"
