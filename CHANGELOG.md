# Changelog

All notable changes to this project will be documented in this file.

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
