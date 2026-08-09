#!/bin/bash
# Double-clickable macOS launcher for the Local AI Teleprompter.
# Opens a new Terminal window, runs the server, then opens the browser.
cd "$(dirname "$0")"

PORT="${TELEPROMPTER_PORT:-8000}"
HOST="${TELEPROMPTER_HOST:-127.0.0.1}"

.venv/bin/python server.py --port "$PORT" --host "$HOST" &
SERVER_PID=$!

sleep 2
open "http://${HOST}:${PORT}"

# Keep the window open while the server runs; Ctrl+C / closing stops it.
wait "$SERVER_PID"
