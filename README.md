# 🎙️ Local AI Teleprompter

[![Latest Release](https://img.shields.io/github/v/release/jibberish666/Teleprompter?color=indigo&label=Release)](https://github.com/jibberish666/Teleprompter/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

A 100% local, speech-synchronized AI teleprompter. It captures your microphone, transcribes speech in real time with a local Whisper model (`faster-whisper`), and pushes the spoken word index back to the browser so the prompter scrolls **word-for-word in sync** with what you say.

Everything runs on your local machine—no cloud APIs, no accounts, and no speech/data sent anywhere.

---

## 📢 What's New in v1.1.0

- **Multi-Format Audio Export**: Save audio sessions directly as **MP3** (`.mp3` @ 192 kbps), **WAV** (`.wav` lossless 16-bit PCM), or **WebM** (`.webm`).
- **MP4 & WebM Video Export**: Save video recordings directly in universal **MP4** (`.mp4`) format or lightweight **WebM** (`.webm`).
- **Dynamic Format Selector**: Intuitive dropdown in the Recording panel automatically adapts based on chosen record mode (*Video & Audio* vs *Audio Only*).
- **100% Local & Offline**: Audio conversions and MP3 encoding run completely client-side with embedded encoders.
- See full notes in [CHANGELOG.md](file:///Users/philkershaw/Documents/work/Tools/teleprompter/CHANGELOG.md) or the [Releases Page](https://github.com/jibberish666/Teleprompter/releases).

---

## 📋 Prerequisites & Setup

### Requirements
- **Python**: 3.10+ (Python 3.12 recommended)
- **Microphone**: System default microphone (or custom via `--mic`)
- **Internet**: Required **only once** on initial run to automatically download the Whisper model (~145 MB). Subsequent runs are 100% offline.

### Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/jibberish666/Teleprompter.git
   cd Teleprompter
   ```

2. **Setup virtual environment**:
   ```bash
   # Create virtual environment if not present
   python3 -m venv .venv

   # Activate virtual environment
   source .venv/bin/activate    # On macOS/Linux
   # .venv\Scripts\activate     # On Windows

   # Install required dependencies
   pip install --upgrade pip
   pip install faster-whisper sounddevice websockets numpy
   ```

---

## 🚀 How to Run

### Method 1: Double-Click Launcher (macOS)
Double-click **`teleprompter.command`** in Finder. It launches the Python server in a Terminal window and opens your browser automatically.

### Method 2: Shell Script (macOS / Linux)
```bash
./run.sh
```

### Method 3: Direct CLI execution
```bash
source .venv/bin/activate
python server.py
```

---

## 🎯 Quick Start / Usage

1. Open your browser to **`http://127.0.0.1:8000`**.
2. **Permissions**: Allow Camera + Microphone access when prompted by the browser.
3. **Load Script**: Paste your script or upload a file (`.txt`, `.md`, `.docx`, `.pdf`).
4. **Select Speech Preset** (UI header):
   - **Ultra Fast**: `0.4s` sync rate (`tiny.en` model)
   - **Fast**: `0.6s` sync rate (`base.en` model - recommended)
   - **Standard**: `1.2s` sync rate (`base.en` model)
5. Click **Start Session**: Speak aloud and watch the text highlight and scroll automatically in real-time sync with your voice.
6. **Save Recordings**:
   - **Video Mode**: Save as **MP4** (`.mp4`) or **WebM** (`.webm`).
   - **Audio Mode**: Save as **MP3** (`.mp3`), **WAV** (`.wav` lossless PCM), or **WebM** (`.webm`).
   - Click **Stop & Save** to download your session recording immediately to your computer.

---

## 🎛️ Keyboard & UI Controls

- **Arrow Up / Down**: Manually adjust/override highlight position (resumes auto-sync on next word match).
- **Speech Preset Dropdown**: Switch latency and models dynamically on the fly.
- **Display Adjustments**: Mirror display (flip horizontal), font size, line spacing, box opacity, visible line count, camera overlay toggle & zoom.

---

## ⚙️ Command-Line Options

```bash
python server.py --port 8000 --host 127.0.0.1 --model base.en \
                 --compute-type int8 --mic <device> --tick 1.2 \
                 --window 4.0 --align-window 5 --align-tolerance 3 \
                 [--browser-audio]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--port` | `8000` | HTTP & WebSocket server port (saved in `teleprompter.json`) |
| `--host` | `127.0.0.1` | Bind host address |
| `--model` | `base.en` | `faster-whisper` model name (`tiny.en`, `base.en`, `small.en`) |
| `--compute-type` | `int8` | `ctranslate2` compute quantization type |
| `--device` | `cpu` | Inference device (`cpu` or `cuda`) |
| `--mic` | system default | Microphone device index, name substring, or device name |
| `--tick` | `1.2` | Transcription interval pass in seconds |
| `--window` | `4.0` | Rolling audio window size (seconds) re-transcribed each tick |
| `--align-window` | `5` | Script word search radius around cursor |
| `--align-tolerance` | `3` | Consecutive ASR misses allowed before pausing |
| `--browser-audio` | off | Stream 16 kHz PCM audio from browser over WebSocket instead of host mic |

All options support environment variable fallbacks: `TELEPROMPTER_PORT`, `TELEPROMPTER_HOST`, `TELEPROMPTER_MODEL`, `TELEPROMPTER_COMPUTE_TYPE`, `TELEPROMPTER_DEVICE`, `TELEPROMPTER_MIC`.

---

## 🔧 macOS Mic Conflict & Troubleshooting

### Audio / Sync Issue (macOS)
By default, the backend captures audio via `sounddevice` while the browser requests camera/mic for video recording. On some macOS configurations, audio routing may conflict between clients.

If the prompter does not advance when speaking:
1. Select your specific mic index via `--mic <index>` (run `python server.py` to view available device indices).
2. Or use the WebSocket browser audio fallback:
   ```bash
   ./run.sh --browser-audio
   ```

### Status Badges
- **OFFLINE ENGINE READY**: Model loaded successfully into memory.
- **Start button disabled**: Model is currently downloading/loading. Check server terminal for progress.

---

## 📁 Repository Structure

```
server.py            # Main server CLI, HTTP & WebSocket server
audio_capture.py     # sounddevice InputStream & ring buffer
transcriber.py       # faster-whisper inference engine & profile manager
aligner.py           # ASR-to-script fuzzy word alignment logic
static/              # Web UI (index.html, app.js, style.css)
teleprompter.command # macOS double-clickable launcher
run.sh               # Shell startup script
```

---

## 📄 License

MIT License. Free for personal and commercial use.
