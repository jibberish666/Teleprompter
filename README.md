# 🎙️ Local AI Teleprompter

[![Latest Release](https://img.shields.io/github/v/release/jibberish666/Teleprompter?color=indigo&label=Release)](https://github.com/jibberish666/Teleprompter/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

A 100% local, speech-synchronized AI teleprompter. It captures your microphone, transcribes speech in real time with a local Whisper model (`faster-whisper`), and pushes the spoken word index back to the browser so the prompter scrolls **word-for-word in sync** with what you say.

Everything runs on your local machine—no cloud APIs, no accounts, and no speech/data sent anywhere.

## 📢 What's New in v1.4.0

- **Rehearsal & Practice Mode**: Rehearse scripts with zero pressure without recording files. Features real-time speech analytics (stutter, pause, and hesitation detection), automatic **Difficult Words** identification, detailed trial performance metrics (WPM, Fluency score, word latency), and trial/run tag filtering.
- **Screen Space & Responsive Layout**: Adjust the prompter box width dynamically from 60% to 96% with a dedicated slider. Font size changes now dynamically scale line height (`getLineHeightForFontSize`) and scroll offsets, and the active highlight bar cleanly adapts to the prompter width.
- **Dynamic Programming Script Auto-Formatter**: Script auto-formatting now uses a dynamic programming algorithm to find optimal 5–8 word spoken phrases, heavily penalizing dangling prepositions and conjunctions at line ends while preserving compound terms and adding visual breath pauses.
- **Persistent Script Input**: Scripts are automatically saved in `localStorage`, preventing lost scripts on accidental refresh or navigation.
- **Privacy-First Camera Startup**: Camera video feed starts disabled by default upon application launch, saving resources until manually activated.
- **Agent Text Formatter Skill**: Includes the `.agents/skills/teleprompter-text-formatter/` skill for AI agents to format text according to teleprompter delivery rules.
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
   - Use the **Auto-Format** button (or leave **Auto-format on paste / import** checked) to instantly convert long paragraphs into 5–8 word spoken phrases with breath pauses.
4. **Select Speech Preset** (UI header):
   - **Ultra Fast**: `0.4s` sync rate (`tiny.en` model)
   - **Fast**: `0.6s` sync rate (`base.en` model - recommended)
   - **Standard**: `1.2s` sync rate (`base.en` model)
5. Click **Start Session**: Speak aloud and watch the text highlight and scroll automatically in real-time sync with your voice.
6. **Save Recordings**:
   - **Video Mode**: Save as **MP4** (`.mp4`) or **WebM** (`.webm`).
   - **Audio Mode**: Save as **MP3** (`.mp3`), **WAV** (`.wav` lossless PCM), or **WebM** (`.webm`).
   - Click **Stop & Save** to download your session recording immediately (saved with a timestamped filename like `teleprompter_2026-09-02_16-20-00.mp4`).

---

## 🎛️ Keyboard & UI Controls

- **Rehearse / Practice Mode**: Toggle rehearsal mode to practice scripts without saving recordings, tracking pauses, stutters, and difficult words across trial runs.
- **Trial & Difficult Words Filter**: View and filter detected difficult words and pacing feedback by specific rehearsal runs.
- **Auto-Format Script**: Click **Auto-Format** in the transcript panel to break paragraphs into 5–8 word rhythmic phrases with breath pauses.
- **Auto-Format on Paste**: Checkbox toggle to automatically format text on paste or file upload (persisted in preferences).
- **Restart Script Button**: Rewind instantly back to the first word without modifying or clearing text.
- **Click to Seek**: Click any word in the transcript display to immediately move the highlight and resynchronize the backend aligner.
- **Arrow Up / Down**: Manually step the highlight backward or forward (backend aligner syncs automatically).
- **Speech Preset Dropdown**: Switch latency and models dynamically on the fly (*Ultra Fast*, *Fast*, *Standard*).
- **Microphone Input Selector**: Open **Script & Options** $\rightarrow$ **Microphone Input** to select between **Browser Microphone** (zero host conflicts) and detected hardware sound devices.
- **Display Adjustments**: Prompter box width slider (60% to 96%), font size, line spacing, box opacity, visible line count, mirror display (flip horizontal for physical glass rigs), camera overlay toggle & zoom.

---

## 🧪 Automated Testing

A dedicated test suite tests the alignment logic, multi-word lookahead confirmation, compound words, morphological inflections, rehearsal mode metrics, and real-session playback:

```bash
# Run test suite
python3 test_aligner.py
# or using the virtual environment:
.venv/bin/python3 test_aligner.py
```

---

## ⚙️ Command-Line Options

```bash
python server.py --port 8000 --host 127.0.0.1 --model base.en \
                 --compute-type int8 --mic <device> --tick 1.2 \
                 --window 4.0 --align-window 5 --align-tolerance 5 \
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
| `--align-tolerance` | `5` | Consecutive ASR misses allowed before pausing |
| `--browser-audio` | off | Stream 16 kHz PCM audio from browser over WebSocket instead of host mic |

All options support environment variable fallbacks: `TELEPROMPTER_PORT`, `TELEPROMPTER_HOST`, `TELEPROMPTER_MODEL`, `TELEPROMPTER_COMPUTE_TYPE`, `TELEPROMPTER_DEVICE`, `TELEPROMPTER_MIC`.

---

## 🔧 Audio Routing & Troubleshooting

### Audio / Sync Issue (macOS & multi-mic setups)
By default on macOS, hardware audio devices can experience exclusivity or sample-rate conflicts if both the browser (recording video) and Python backend (`sounddevice`) attempt to access the microphone simultaneously.

**Solutions**:
1. **In-UI Audio Source (Recommended)**:
   In **Script & Options**, leave or set **Microphone Input** to **`Browser Microphone (WebRTC · Recommended)`**. This streams the audio directly from your active browser tab to the backend over WebSocket with zero device contention.
2. **Hardware Device**:
   Select your specific hardware microphone from the **Microphone Input** dropdown or specify `--mic <index>` on startup.
3. **Silent Mic Detection**:
   If no audio signal is detected for 4 consecutive ticks, the teleprompter displays a pulsing `MIC SILENT` badge to alert you to check microphone permissions or switch audio sources.

### Status Badges
- **OFFLINE ENGINE READY**: Model loaded successfully into memory.
- **SYNCING – VOICE DETECTED**: Audio active and words matching.
- **MIC SILENT**: Selected microphone is producing no audio signal.
- **Start button disabled**: Model is currently downloading/loading. Check server terminal for progress.

---

## 📁 Repository Structure

```
server.py            # Main server CLI, HTTP & WebSocket server
audio_capture.py     # sounddevice InputStream, ring buffer & dynamic device routing
transcriber.py       # faster-whisper inference engine & profile manager
aligner.py           # Redesigned locality-first fuzzy word aligner with lookahead verification
test_aligner.py      # Test suite (21 unit & real-session playback tests)
static/              # Web UI (index.html, app.js, style.css, favicons, encoders)
teleprompter.command # macOS double-clickable launcher
run.sh               # Shell startup script
.agents/             # Agent skills and audio tracking reference documentation
```

---

## 📄 License

MIT License. Free for personal and commercial use.
