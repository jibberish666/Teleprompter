# Teleprompter Project — Agent Guide

## Active Architecture & Files

### Frontend Subsystems (loaded by `static/index.html`):
- **`static/index.html`** — HTML markup, shell, and dialog modals.
- **`static/app.js`** — UI event coordinator, WebSocket message dispatcher, start/stop lifecycle.
- **`static/timeline.js`** — `SectionTimeline` managing wall-clock boundary cuts, cadence lookback, and boundary resolution.
- **`static/media.js`** — `MediaSession`, Web Audio graph, LAME MP3 / RIFF WAV encoding, and take slicing (`processAudioTakes`).
- **`static/export.js`** — Multi-file export adapters (File System Access API, PKZIP archive, and direct download).
- **`static/formatter.js`** — Natural 5–8 word cadence chunking, section extraction, and breath pause insertion.
- **`static/cues.js`** — Visual cue markers, rehearsal fumble tracking, and custom phonetic guides.
- **`static/viewport.js`** — Dynamic layout geometry, word highlight spans, and smooth scroll interpolation.
- **`static/config.js`** — Unified reactive configuration store and schema migration.
- **`static/style.css`** — Stylesheet.

### Backend Pipeline (Python):
- **`server.py`** — HTTP static server + WebSocket `SyncHub` broadcaster.
- **`session.py`** — `PrompterSession` coordinating transcriber, aligner, audio source, and client messages.
- **`aligner.py`** — Locality-first monotonic text alignment engine with section boundary lookahead.
- **`transcriber.py`** — Faster-Whisper background processing loop with dynamic speed profiles.
- **`audio_capture.py`** — Thread-safe circular audio buffer (sounddevice hardware or WebSocket stream).
- **`telemetry.py`** — Rehearsal metrics observer (detects skipped, stumbled, and repeated words).
- **`config.py`** — Server-side configuration persistence (`teleprompter.json`).

## Orphaned / Standalone
- **`teleprompter.html`** — Standalone single-file legacy version; NOT served by `server.py`. Do not edit unless explicitly instructed.

## Testing & Environment Runbook
Always run automated tests with the local virtual environment Python:
- Backend: `.venv/bin/python -m unittest test_aligner.py`
- Frontend: `node test_timeline.js && node test_media.js && node test_simulation.js`
- Full JS Suite: `node --test test_*.js`

Changes to `server.py`, `session.py`, `aligner.py`, or `transcriber.py` require a server restart (`./run.sh` or `.venv/bin/python server.py`).