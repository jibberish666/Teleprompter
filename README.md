# 🎙️ Local AI Teleprompter

[![Latest Release](https://img.shields.io/github/v/release/jibberish666/Teleprompter?color=indigo&label=Release)](https://github.com/jibberish666/Teleprompter/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

A 100% local, speech-synchronized AI teleprompter. It captures your microphone, transcribes speech in real time with a local Whisper model (`faster-whisper`), and pushes the spoken word index back to the browser so the prompter scrolls **word-for-word in sync** with what you say.

Everything runs on your local machine—no cloud APIs, no accounts, and no speech/data sent anywhere.

## 📢 What's New in v1.5.0

- **Section-Based Audio Recording & Precision Take Slicing**: Organize your script with section tags (e.g. `[1]`, `[2]`, `[3]` or `[Intro]`, `[Body]`, `[Outro]`). As you speak, the teleprompter tracks speech progression across section boundaries in real-time, automatically slicing individual audio takes (`1.wav`, `2.wav`, etc.) while also producing a seamless full master read (`everything.wav`).
- **Two-Pass Whisper Boundary Refinement**: After a recording take finishes, an optional full-track Whisper transcription pass (`refine.py`) matches script section boundaries against true spoken audio word timestamps, delivering millisecond-accurate section cuts and eliminating live streaming drift.
- **In-Session Section Retakes (`R` key)**: Flubbed a line? Press `R` or click **Retake** during recording to immediately restart the active section. The system automatically rewinds the prompter and replaces the previous pass of that section.
- **Multi-File Export & In-Browser ZIP Archive**: Export all sliced takes directly into a chosen folder using the **File System Access API** (zero download clutter), or bundle them into a single timestamped `.zip` archive generated right inside your browser.
- **Interactive Progress Bar Modal**: Real-time visual progress updates and spinner during post-recording processing steps: audio downsampling, Whisper refinement, section slicing, and export encoding.
- **Fullscreen Script Editor & Highlight Management**: Dedicated modal script editor with live stats (word count, estimated speaking duration, section count) and a one-click **Clear Highlights** button to reset rehearsal cues without affecting script text.
- **Modular Frontend Architecture**: Decoupled, single-responsibility modules (`timeline.js`, `media.js`, `export.js`, `formatter.js`, `cues.js`, `viewport.js`, `script_editor.js`, `server_control.js`, `config.js`) covered by over 220 automated unit and integration tests.
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
5. **Trial Run (Rehearse)**:
   - Click the green **Rehearse** button to do a dry run. The teleprompter scrolls and follows your voice without recording video or audio.
   - Any stumbled, skipped, or repeated words are caught automatically and highlighted directly on your script as visual cues.
6. **Customize Cues & Difficult Words**:
   - Open **Script & Options** $\rightarrow$ **Difficult Words & Colors…** to review detected fumbles, filter by tag (*Skipped*, *Stumbled*, *Repeated*), and customize highlight styling (*Filled Pill*, *Text Glow*, or *Underline Accent*).
7. **Record Live Take & Automatic Slicing**:
   - Organize your text with section tags like `[1]`, `[2]`, `[3]` or `[Intro]`, `[Body]`, `[Outro]`.
   - Click **Start Session** when ready. Speak naturally—the teleprompter scrolls in real-time with your voice.
   - If you stumble during a section, tap **`R`** (or click **Retake**) to restart the current section without stopping the session.
   - Click **Stop & Save** when finished. The system downsamples the audio, optionally refines section boundaries using full-file Whisper word timestamps, and slices individual takes (`1.wav`, `2.wav`) plus a master track (`everything.wav`).
   - Choose to save all takes directly to a selected folder (via File System Access API) or download a bundled `.zip` archive.

---

## ✂️ Section Recording, In-Session Retakes & Take Slicing

Writing video scripts or voiceover reads in distinct sections makes recording far more manageable:

- **Section Markup**: Add bracketed headers like `[1]`, `[2]`, `[3]`, or `[Intro]`, `[Main Feature]`, `[Call to Action]` anywhere in your script. The teleprompter automatically recognizes them as discrete takes.
- **Real-Time Section Timeline (`static/timeline.js`)**: As you read across section boundaries, the system timestamps start and end boundaries with cadence lookback protection (ensuring delayed speech recognition never truncates the opening words of a section).
- **One-Key Retakes (`R` Hotkey)**: If you flub a take mid-session, hit **`R`** on your keyboard (or click the **Retake** button). The prompter instantly resets that section's boundary timer and rewinds your reading cursor back to the start of the current section.
- **Two-Pass Whisper Boundary Refinement (`refine.py`)**: When your recording ends, the browser can send the complete recorded audio to the local Whisper engine for a high-accuracy timestamp pass. It matches your script boundaries to exact word audio timestamps down to the millisecond, correcting any live streaming latency.
- **Multi-File Export (`static/export.js`)**:
  - **Direct Folder Export**: Uses the modern browser **File System Access API** (`showDirectoryPicker`) to write all section files directly into a folder on your drive with zero browser download popups.
  - **In-Browser PKZIP**: Assembles all individual takes and the complete session audio into a timestamped `.zip` file using a fast, native client-side ZIP generator.

---

## 🎭 Trial Rehearsal Mode & Fumble Catcher

Rehearsal Mode is designed for zero-pressure practice before hitting record:

- **Zero-Pressure Practice**: Runs speech synchronization and automatic prompter scrolling with local Whisper while **completely disabling audio and video recording**. No temporary files or unwanted recordings are written to disk.
- **Automatic Fumble Categorization**:
  - 🔴 **Skipped Words**: Words you jumped over, omitted, or skipped in the text.
  - 🟡 **Stumbled Words**: Words where pronunciation hesitations, stutters, or low-confidence recognition occurred (<0.85 phonetic similarity).
  - 🟣 **Repeated Words**: Words repeated within the local context (false starts or stammering).
- **Persistent Visual Cues**: When you stop your rehearsal, all detected fumbles remain clearly highlighted on the prompter text, giving you real-time visual heads-up warnings during your actual recording session.
- **Difficult Words & Highlights Dialog**:
  - **Filter Tabs**: Toggle between `All`, `Skipped`, `Stumbled`, and `Repeated` with real-time fumble count badges.
  - **Sync with Prompter**: Check this option to only highlight words on screen matching your currently active filter tab.
  - **Custom Color Swatches**: Select from 6 vibrant color palettes (Amber, Coral/Rose, Emerald, Cyan, Fuchsia, Gold) or enter an arbitrary hex color.
  - **Styling Treatments**: Choose between **Filled Pill** badge, **Text Glow**, or **Underline Accent** for script cues.
  - **Manual Difficult Words**: Type or batch-paste complex vocabulary or technical terms into the dialog to highlight them alongside rehearsal fumbles.
  - **Clear Highlights**: One-click action to clear all visual rehearsal cues without modifying the script text.

---

## 🎛️ Keyboard & UI Controls

- **`R` Key / Retake Button**: Rewind and re-record the current active section during a live recording session.
- **Rehearse Button**: Start a trial read-through without saving recording files, capturing fumbles in real time.
- **Edit Script Modal**: Open the fullscreen script editor with live stats (word count, reading duration, section count).
- **Clear Highlights**: Instantly clear rehearsal fumbles and highlight cues from the text display.
- **Difficult Words & Colors**: Open the configuration panel to review fumbles, filter categories, and change cue styling.
- **Prompter Box Width Slider**: Adjust prompter reading width dynamically between 60% and 96% (saved in `localStorage`).
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

The project includes automated test suites covering speech alignment, multi-word lookahead confirmation, rehearsal telemetry, section timeline state machines, audio slicing, and export adapters:

```bash
# Run backend Python tests (89 tests)
.venv/bin/python -m unittest discover -p "test_*.py"

# Run frontend JavaScript test suite (135 tests)
node --test test_*.js

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
server.py            # Main server CLI, HTTP & WebSocket SyncHub broadcaster
session.py           # PrompterSession coordinating transcriber, aligner, audio & clients
audio_capture.py     # sounddevice InputStream, ring buffer & dynamic device routing
transcriber.py       # faster-whisper real-time inference loop & transcribe_full
refine.py            # Post-recording section alignment with word-level Whisper timestamps
aligner.py           # Locality-first fuzzy word aligner with multi-word lookahead
telemetry.py         # Rehearsal metrics observer (detects skipped, stumbled, repeated words)
config.py            # Atomic configuration manager and persistence (teleprompter.json)
test_*.py            # Python backend test suite (89 unit and playback simulation tests)
test_*.js            # Frontend JavaScript test suite (135 tests)
static/              # Modular Web UI frontend
├── index.html       # Prompter markup, dialog shells, and modals
├── app.js           # UI coordinator, WebSocket dispatcher & lifecycle
├── timeline.js      # SectionTimeline state machine & boundary lookback resolution
├── media.js         # MediaSession, Web Audio graph, take slicing & buffer encoding
├── export.js        # File System Access API & in-browser PKZIP export adapters
├── formatter.js     # Cadence chunking & natural breath pause insertion
├── cues.js          # Rehearsal fumble tracking & visual cue markers
├── viewport.js      # Dynamic typography geometry & smooth scroll interpolation
├── script_editor.js # Script editor modal controller with live stats
├── server_control.js# Server restart & shutdown controller
├── config.js        # Reactive client-side configuration store
└── style.css        # Responsive stylesheet
teleprompter.command # macOS double-clickable launcher
run.sh               # Shell startup script
.agents/             # Agent skills and audio tracking reference documentation
```

---

## 📄 License

MIT License. Free for personal and commercial use.
