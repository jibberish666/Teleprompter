# Local AI Teleprompter

A 100% local, AI-driven teleprompter. It captures your Mac microphone
(`sounddevice`), transcribes speech with a local Whisper model
(`faster-whisper`, `base.en`), and pushes the spoken word index back to the
browser so the prompter scrolls **word-for-word in sync** with what you say.

Everything runs on your machine. No cloud, no accounts, no speech sent anywhere.

## How to run

```bash
./run.sh
```

Then open <http://127.0.0.1:8000> (it prints the URL), allow Camera + Microphone,
paste or upload a script, and press **Start Session**. Speak and watch the words
highlight in sync. **Stop & Save Video** downloads a `.webm` of the session with
the narration audio included.

Or double-click **`teleprompter.command`** (macOS): it starts the server and
opens the browser for you.

First run downloads the `base.en` Whisper model (~145 MB) to
`~/.cache/huggingface` — you need internet once. After that it runs fully offline.

## Requirements

- Python 3.12 with the pre-provisioned `.venv` in this folder
  (`faster-whisper`, `sounddevice`, `websockets`, `numpy`, ...).
- A microphone (system default is used unless `--mic` is given).

## Command-line options

```
python server.py --port 8000 --host 127.0.0.1 --model base.en \
                 --compute-type int8 --mic <device> --tick 1.2 \
                 --window 4.0 --align-window 5 --align-tolerance 3 \
                 [--browser-audio]
```

| Flag | Default | Meaning |
|------|---------|---------|
| `--port` | `8000` | HTTP/WebSocket port (persisted across runs in `teleprompter.json`) |
| `--host` | `127.0.0.1` | Bind address |
| `--model` | `base.en` | faster-whisper model name |
| `--compute-type` | `int8` | ctranslate2 compute type |
| `--device` | `cpu` | Inference device (cpu / cuda) |
| `--mic` | system default | Mic index, name substring, or `BlackHole` |
| `--tick` | `1.2` | Seconds between transcription passes |
| `--window` | `4.0` | Rolling audio window (seconds) re-transcribed each tick |
| `--align-window` | `5` | Script words searched around the cursor for each ASR word |
| `--align-tolerance` | `3` | Consecutive misses tolerated before pausing |
| `--browser-audio` | off | Browser streams 16 kHz PCM over WebSocket instead of the backend mic |

Every option also has an env fallback: `TELEPROMPTER_PORT`, `TELEPROMPTER_HOST`,
`TELEPROMPTER_MODEL`, `TELEPROMPTER_COMPUTE_TYPE`, `TELEPROMPTER_DEVICE`,
`TELEPROMPTER_MIC`.

Example on a different port:

```bash
./run.sh --port 9000
```

## macOS "Both sources" mic conflict

By default the backend owns the mic via `sounddevice` **and** the browser
requests it too (so the saved video keeps your narration). macOS may sometimes
route only one client's audio. If transcription isn't advancing, either pick a
specific mic with `--mic`, or use the escape hatch:

```bash
./run.sh --browser-audio
```

In this mode the browser captures the mic and streams 16 kHz audio to the server
over the same WebSocket; the backend does not open the mic itself. This is the
reliable fallback when the two clients conflict.

## Other controls

- **Arrow Up/Down** in the browser step the highlight manually (a local
  override; the next server sync resumes from there).
- **Mic Sensitivity** only tunes the local visual VU meter (green bar). Scrolling
  itself is driven by Whisper word sync, not the VU meter.
- **Speech Recognition Preset**: Select between **Ultra Fast** (0.4s sync · `tiny.en`), **Fast** (0.6s sync · `base.en`), and **Standard** (1.2s sync · `base.en`) dynamically directly within the UI.
- **Mirror Display**, **Font Size**, **Box Opacity**, **Camera Toggle & Zoom**, **Visible Lines** controls.
- Accepts `.txt`, `.md`, `.docx`, `.pdf` and pasted text.

## Files

```
server.py           # CLI, HTTP+WS co-host, session orchestration
audio_capture.py    # sounddevice InputStream + ring buffer (16 kHz float32)
transcriber.py      # faster-whisper load + rolling-window transcription loop with profile caching
aligner.py          # ASR-word -> script-word fuzzy alignment (monotonic cursor)
static/             # index.html, app.js, style.css (browser UI)
teleprompter.html   # original single-file reference (kept intact)
teleprompter.json   # persisted config (port) — created on first run
run.sh              # launcher
teleprompter.command# double-clickable macOS launcher
```

## Troubleshooting

- **Nothing advances:** check `http://127.0.0.1:8000` loads, the header badge
  shows "OFFLINE ENGINE READY" (model downloaded), and confirm the right mic is
  selected (`--mic <index>` from the printed input device list). Try
  `--browser-audio`.
- **Start button stays disabled:** the local model is still downloading/loading.
  Watch the header status, then Start enables.
- **No audio in saved video:** the two mic clients can conflict on macOS; use
  `--mic` or `--browser-audio`.
