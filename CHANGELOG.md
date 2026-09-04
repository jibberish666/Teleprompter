# Changelog

All notable changes to this project will be documented in this file.

## [v1.4.0] - 2026-09-04

### 🎭 Trial Rehearsal Mode & Fumble Catcher
- **Dedicated Rehearse Action Button**: Added a prominent emerald **Rehearse** button to the top header for zero-pressure dry runs. Rehearse mode synchronizes speech and scrolls the prompter in real-time with local Whisper while **completely disabling audio and video recording**.
- **Real-Time Fumble Detection Engine**: Backend alignment engine (`aligner.py`) automatically tracks and categorizes speaking hiccups during trial runs:
  - **Skipped Words** (red cue): Words inadvertently omitted or jumped over in the script.
  - **Stumbled Words** (amber cue): Words with phonetic hesitation, pronunciation delays, or low-confidence recognition (<0.85 similarity).
  - **Repeated Words** (purple cue): False starts, stammering, or repeated words within the local context.
- **Live Script Cueing for Final Takes**: All detected trial fumbles are automatically highlighted directly in the teleprompter script, serving as visual warning cues when doing your final live recording.
- **Difficult Words & Custom Highlights Modal**:
  - Accessible from **Script & Options** $\rightarrow$ **Difficult Words & Colors…**
  - Displays caught **Trial Rehearsal Fumbles** alongside manually added difficult terms and batch-pasted vocabulary lists.
  - **Fumble Category Filtering**: Filter by **All**, **Skipped**, **Stumbled**, or **Repeated** with dynamic count badges.
  - **Sync with Prompter**: Checkbox to restrict teleprompter script cues strictly to the active filter tab.
  - **Visual Treatment Styling**: Choose between **Filled Pill**, **Text Glow**, or **Underline Accent** treatments.
  - **Color Palette Customization**: 6 curated preset swatches (Amber, Rose, Emerald, Cyan, Fuchsia, Gold) plus an interactive hex color picker.
  - **Fumble Management**: Remove individual fumbled words via `×` chips or clear fumbles by filter category.

### 📐 Screen Space & Responsive Layout Optimizations
- **Adjustable Prompter Box Width**: Added a new slider in display settings to dynamically adjust the teleprompter box width from 60% to 96% (defaulting to 90% for an expansive, clean reading view).
- **Proportional Line Height Scaling**: Prompter line height and scrolling translations now dynamically compute and adapt to the active font size (16px–36px) via `getLineHeightForFontSize` and CSS custom property `--prompter-line-height`.
- **Responsive Active Highlight Bar**: Active reading bar (`#cursor-bar`) and text viewing window automatically expand to fill 100% of the prompter box width without horizontal overflow.

### ✍️ Dynamic Programming Script Auto-Formatter
- **Optimal Cadence Chunking**: Upgraded the script auto-formatter to use dynamic programming (DP) optimization to break continuous prose into natural 5–8 word spoken phrases.
- **Dangling Word Prevention**: Heavily penalizes line endings ending on prepositions, conjunctions, or determiners (`of`, `for`, `with`, `and`, `the`, `in`, `to`, etc.), ensuring lines start with forward momentum.
- **Compound Phrase Protection**: Safeguards technical compound terms and semantic noun clusters from being split across line boundaries.
- **Intelligent Visual Breath Pauses**: Automatically inserts visual breath pause breaks between sentences and major clauses for natural speaker delivery.

### 💾 Persistence & Privacy Improvements
- **Persistent Script Input**: Script text in the transcript editor is automatically saved in browser `localStorage` (`teleprompter_saved_transcript`), preventing script loss across page refreshes.
- **Privacy-First Camera Startup**: Camera video feed starts disabled by default upon application launch, saving resources and preserving privacy until manually toggled.
- **Settings Persistence**: Prompter box width slider settings and trial filters are automatically remembered across sessions.

### 🤖 Teleprompter Text Formatter Agent Skill
- **Agent Formatting Cheatsheet**: Added `.agents/skills/teleprompter-text-formatter/` skill with comprehensive instructions and examples for AI agents to automatically cadence, chunk, and format scripts according to teleprompter presentation rules.

---

## [v1.3.0] - 2026-09-02

### ✍️ Intelligent Script Auto-Formatting & Rhythmic Phrasing
- **Rhythmic Cadence Formatting**: Structures paragraphs and continuous prose into 5–8 word spoken phrases matched to natural speech cadence.
- **Grammatical Clause Splitting**: Breaks lines naturally at clause boundaries, conjunctions, and prepositions while keeping compound technical terms and noun phrases intact.
- **Visual Breath Pauses**: Inserts breath pause indicator dashes between sentences and major clauses for natural pacing.
- **Auto-Format on Paste / Import**: Automatically formats text pasted into the editor or imported from `.txt`, `.md`, `.docx`, or `.pdf` files, with user toggle preference persisted in `localStorage`.
- **Dedicated Auto-Format Button**: Added one-click action button with visual feedback toast in the *Transcript Input* header.

### 🎨 Refactored Prompter Display & Typography
- **Centered 720px Reader Column**: Text container is centered horizontally with strict left-alignment and consistent 20px padding, eliminating horizontal eye bounce between lines.
- **Proportional Active Highlight Bar**: Highlight banner restricted to the exact 720px column width with rounded corners (`border-radius: 8px`) and matching inset padding.
- **Subtle Underline Word Tracker**: Softened active word indicator with a clean gold underline (`border-bottom: 3px solid #eab308;`) and subtle accent tint, replacing the harsh solid yellow box.
- **Preview Line Visual Hierarchy**: Upcoming preview lines styled with `line-height: 1.7` and `opacity: 0.55` so the speaker naturally focuses on the current spoken line.
- **Zero Justification**: Strictly enforced standard spacing (`word-spacing: normal; letter-spacing: normal; text-align: left; text-align-last: left;`).

### 📦 Export & File Management
- **Timestamped Recording Filenames**: Exported media files now automatically include precise local timestamps (`teleprompter_YYYY-MM-DD_HH-MM-SS.mp4 / .mp3 / .wav / .webm`) to prevent file collisions.

---

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
