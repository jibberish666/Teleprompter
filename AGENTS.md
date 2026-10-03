# Teleprompter Project — Agent Guide

## Active Architecture & Files

### Frontend Subsystems (loaded by `static/index.html`):
- **`static/index.html`** — HTML markup, shell, and dialog modals.
- **`static/app.js`** — UI event coordinator, WebSocket message dispatcher, start/stop lifecycle.
- **`static/timeline.js`** — `SectionTimeline` managing wall-clock boundary cuts, cadence lookback, and boundary resolution.
- **`static/media.js`** — `MediaSession`, Web Audio graph, LAME MP3 / RIFF WAV encoding, device selector & format UI binding (`bindUI`), and take slicing (`processAudioTakes`).
- **`static/export.js`** — Multi-file export adapters (File System Access API, PKZIP archive, and direct download).
- **`static/formatter.js`** — Natural 5–8 word cadence chunking, section extraction, and breath pause insertion.
- **`static/cues.js`** — Visual cue markers, rehearsal fumble tracking, and Difficult Words modal controller (`bindUI`).
- **`static/viewport.js`** — Dynamic layout geometry, word highlight spans, and smooth scroll interpolation.
- **`static/script_editor.js`** — `TeleprompterScriptEditor` modal controller with live stats, font sizing, and script synchronization.
- **`static/server_control.js`** — `TeleprompterServerControl` modal controller for server restart and shutdown lifecycle.
- **`static/config.js`** — Unified reactive configuration store and schema migration.
- **`static/style.css`** — Stylesheet.

### Backend Pipeline (Python):
- **`server.py`** — HTTP static server + WebSocket `SyncHub` broadcaster.
- **`session.py`** — `PrompterSession` coordinating transcriber, aligner, audio source, and client messages.
- **`aligner.py`** — Locality-first monotonic text alignment engine with section boundary lookahead.
- **`transcriber.py`** — Faster-Whisper background processing loop with dynamic speed profiles, plus `transcribe_full()` for one-off word-timestamped transcription of a finished recording.
- **`refine.py`** — Post-recording boundary refinement: matches full-file word timestamps to script sections (`align_sections`) and reassembles chunked browser audio uploads (`RefineUpload`). Primary source of take-slicing boundaries; live `timeline.js` boundaries are the fallback.
- **`audio_capture.py`** — Thread-safe circular audio buffer (sounddevice hardware or WebSocket stream).
- **`telemetry.py`** — Rehearsal metrics observer (detects skipped, stumbled, and repeated words).
- **`config.py`** — Server-side configuration persistence (`teleprompter.json`).

## Orphaned / Standalone
- **`teleprompter.html`** — Standalone single-file legacy version; NOT served by `server.py`. Do not edit unless explicitly instructed.

## Testing & Environment Runbook
Always run automated tests with the local virtual environment Python:
- Backend: `.venv/bin/python -m unittest test_aligner.py test_refine.py`
- Frontend: `node test_timeline.js && node test_media.js && node test_simulation.js`
- Full JS Suite: `node --test test_*.js`

Changes to `server.py`, `session.py`, `aligner.py`, or `transcriber.py` require a server restart (`./run.sh` or `.venv/bin/python server.py`).

### STRICT GIT & VERSION CONTROL CONSTRAINTS
- NEVER execute, script, or call any `git` commands (including `git log`, `git diff`, `git show`, `git blame`, `git checkout`, or `git status`).
- NEVER inspect historical commits, diffs, or git metadata directly via the terminal or indirectly via wrappers (such as Python `subprocess`, Node `child_process`, or shell scripts).
- Treat the current working tree on disk as the SOLE source of truth. Debug all regressions, bugs, and tasks exclusively by reading and analyzing active workspace files.
- Modifying local files directly is expected, but all git operations (staging, diffing history, committing, pushing) are strictly reserved for the human user.
- If past revision context or commit history is genuinely required to solve an issue, STOP and ask the user directly rather than querying git.

### RESTRICTED RECONNAISSANCE & FILE SEARCHING
- DO NOT perform recursive grep or multi-file codebase scans unless explicitly ordered.
- Cap exploratory reads to a maximum of 2 files and no more than 100 lines per turn.
- If the target file or component is already known, inspect ONLY that specific file.
- Never read documentation files, markdown logs, or changelogs when debugging application runtime bugs.