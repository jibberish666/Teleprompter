# Changelog

All notable changes to this project will be documented in this file.

## [v1.2.0] - 2026-09-02

### 🎯 Speech Synchronization & Alignment Engine Redesign
- **Strict Locality-First Matching**: Prioritizes immediate next words within a tight window (0–4 words) with distance penalties to ensure smooth word-by-word advancement and prevent skipping.
- **Mandatory Multi-Word Sequence Confirmation**: Forward jumps beyond the local window now strictly require at least 2 consecutive matching words (or 3 for short words), completely eliminating single-word false positive leaps (e.g. from common words like `"with"`, `"that"`, `"our"`, `"car"`, `"machine"`).
- **Stem & Morphological Inflection Matching**: Intelligently handles valid word forms and inflections (e.g. `"balance"` $\leftrightarrow$ `"balancing"`, `"assembly"` $\leftrightarrow$ `"assemblies"`, `"technics"` $\leftrightarrow$ `"techniques"`, `"accelerates"` $\leftrightarrow$ `"accelerating"`) while strictly isolating short words ($\le 3$ chars) to exact matches only.
- **Compound Word Support**: Resolves split ASR tokens (`["high", "speed"]` $\rightarrow$ `"highspeed"`) and compound script words (`"turbocharger"` $\rightarrow$ `["turbo", "charger"]`).
- **Comprehensive Automated Test Suite**: Added `test_aligner.py` with 18 unit and playback simulation tests against real recorded sessions.

### 🎙️ Audio Input & Microphone Flexibility
- **Live Audio Input Selector**: Added dynamic audio source selection in the UI (*Script & Options* panel) to switch between **Browser Microphone (Live WebRTC · Recommended)** and host hardware audio devices without restarting the server.
- **Silent Input Warning**: Real-time silence detection alerts the user if a selected hardware microphone produces no audio signal (`MIC SILENT`), prompting a quick switch.
- **Bi-directional Seek Synchronization**: Manual navigation (Arrow keys, clicking any word in the script, or the new **Restart Script** button) instantly syncs the backend aligner cursor to the selected position.

### 🎨 UI & Brand Enhancements
- **Restart Script Control**: Added a dedicated top-bar button to rewind to word 0 without modifying or clearing text.
- **Custom Favicon Suite**: Added complete custom icon set (`favicon.ico`, `favicon-16x16.png`, `favicon-32x32.png`, `apple-touch-icon.png`).
- **Improved Default Reading View**: Adjusted default visible lines to 7 and font size to 25px for improved readability.

---

## [v1.1.0] - 2026-09-02

### 🎙️ Multi-Format Audio & Video Recording Export

#### 🔊 Audio Export Options
- **MP3 (`.mp3`)**: High-quality compressed audio (192 kbps) encoded 100% locally in-browser using embedded `lamejs`—no cloud services or network connection required.
- **WAV (`.wav`)**: Studio-grade lossless 16-bit PCM uncompressed audio for professional editing and mastering.
- **WebM (`.webm`)**: High-efficiency Opus audio recording.

#### 🎬 Video Export Options
- **MP4 (`.mp4`)**: Universal H.264/AAC video container for direct playback on any platform, media player, or video editor.
- **WebM (`.webm`)**: Lightweight VP9/VP8 web video format.

#### 🎛️ UI & Workflow Improvements
- **Dynamic Format Selector**: Added an intuitive **Save Format** selector in the Recording settings panel that dynamically updates available formats based on the chosen mode (*Video & Audio* vs *Audio Only*).
- **Context-Aware Stop Button**: Top action button dynamically reflects your target format (e.g. `Stop & Save Video (MP4)`, `Stop & Save Audio (MP3)`).
- **Preference Persistence**: Automatically preserves your selected recording modes and preferred formats across sessions in `localStorage`.
- **100% Offline Capable**: All encoders and converters run locally on your machine with zero cloud dependencies.

---

## [v1.0.0] - 2026-09-01

### 🚀 Initial Release
- 100% local speech-synchronized AI teleprompter.
- Local speech recognition with `faster-whisper` (`tiny.en`, `base.en`, `small.en`).
- Speech presets: Ultra Fast (0.4s sync), Fast (0.6s sync), Standard (1.2s sync).
- Real-time vocal energy VU meter.
- Dynamic script upload support (`.txt`, `.md`, `.docx`, `.pdf`).
- Camera feed overlay with zoom, mirror, and toggle controls.
- Automatic word-by-word scrolling with manual keyboard override.
