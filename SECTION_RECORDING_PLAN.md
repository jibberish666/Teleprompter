# Section-Based Audio/Video Recording & Export Plan

## Overview & Goal
Enable the teleprompter transcript input to recognize square-bracketed section markers (e.g., `[1]`, `[2]`, `[Introduction]`). During a recording session, the teleprompter will track section boundaries, provide a user-definable **Re-take** feature for redos, and on completion offer an export dialog to save clean individual takes (`1.wav`, `2.wav`) alongside a master take (`everything.wav`), with options for individual downloads or a bundled ZIP archive.

---

## Architecture & Data Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. Transcript Input & Formatting                                           │
│    [1]                           Parsed as structural Section Markers      │
│    Introducing the Turbo...      - cleanCues() preserves [Section] tags     │
│    [2]                           - Prompter renders styled Section Dividers │
│    By balancing the core...      - Speech Tracker skips reading "[1]"       │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. Live Session & Dynamic Section Tracking                                  │
│    - When speech aligns to word 0 of Section 1: Mark Section 1 Start        │
│    - When speech transitions to Section 2: Mark Section 1 End / 2 Start     │
│    - Padding: 250ms silence buffer applied to avoid clipped consonants      │
│    - Hotkey 'R' (User-customizable) or Toolbar Button: "Re-take [Section]"  │
│      -> Rewinds prompter & alignment to section start                       │
│      -> Discards bad attempt, captures fresh clean take                     │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 3. Audio & Video Slicing / Stitching                                        │
│    - Audio: High-precision AudioBuffer slicing in the browser               │
│      • 1.wav, 2.wav: Clean final takes of each section                      │
│      • everything.wav: Spliced combination of clean takes                  │
│    - Video (Hybrid): Standalone section clips + continuous master           │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 4. Export & Download Modal                                                  │
│    - Pop-up modal displaying all generated takes and duration info          │
│    - "Download All as ZIP" (avoids browser multi-download blocks)           │
│    - Direct download buttons for individual clips (1.wav, 2.wav, everything)│
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Detailed Specifications

### 1. Section Syntax & Prompter Parsing
- **Delimiter**: Standalone lines with `[Name]` (e.g. `[1]`, `[2]`, `[Introduction]`).
- **Filename Sanitization**: Bracket contents become the filename (`[1]` -> `1.wav`, `[Take 2: Intro]` -> `Take_2_Intro.wav`).
- **Leading Text**: Any text appearing before the first bracket tag defaults to section `intro`.
- **Backward Compatibility**: If no brackets exist in the script, standard single-file recording (`Session_Audio.wav`) is preserved.
- **Non-Spoken Headers**:
  - In `formatter.js`, preserve bracketed section tags while formatting sentences and cadence within each section.
  - Section tags render as visual divider banners/pills in the teleprompter window.
  - Section tags do **not** generate speech alignment tokens, so the Whisper speech tracking engine never waits for the user to speak the section name aloud.

### 2. Live Session Tracking & Silence Padding
- **Timestamp Tracking**:
  - The frontend maps each script word to its parent section.
  - When speech alignment triggers word index progression across a section boundary, start and end timestamps are recorded.
  - A 250ms silence padding window is applied to the cut boundaries to preserve natural attack/decay without clipping syllables.
- **Re-take Mechanic**:
  - Top toolbar button: `Re-take [Current Section]`.
  - Configurable hotkey in Options (defaulting to **`R`**).
  - Pressing Re-take:
    1. Rewinds the prompter scroll and speech alignment pointer to the start of the current section.
    2. Resets the recorded timestamp/slice data for this section so the new attempt replaces the previous one.

### 3. Audio & Video Export Slicing
- **Audio Mode**:
  - Master decoded Web Audio `AudioBuffer` is cleanly sliced into discrete section buffers (`1.wav`, `2.wav`) with zero generational loss.
  - Spliced master take (`everything.wav`): stitched together exclusively from the clean final takes of each section (concatenating the clean section buffers).
  - Supports both WAV and MP3 depending on the user's active audio format selection.
- **Video Mode (Hybrid)**:
  - Captures standalone video files for each section plus a continuous master video (`everything.mp4`/`.webm`) of the entire session.

### 4. Export & Delivery Experience
- When the user clicks `Stop & Save`:
  - An export modal appears showing a list of all recorded section clips, their durations, and the spliced `everything` file.
  - Primary button: **Download All (.ZIP)** using in-browser ZIP generation (e.g., via lightweight JSZip or streaming zip builder).
  - Secondary buttons: Individual download icons next to each take for selective saving.

---

## Target Files & Scope of Work

1. **`static/formatter.js`**:
   - Update `cleanCues(text)`: Preserve standalone bracketed section lines while still cleaning inline stage directions like `(pause)` or `(smiling)`.
   - Update `formatScript()`: Maintain section demarcation blocks during dynamic 5–8 word sentence re-chunking.
   - Update `parseTokens()`: Tag lines and words with their parent `sectionId` and `sectionTitle`.

2. **`static/app.js`**:
   - Section state management: track `currentSectionIndex`, `sectionBoundaries`, and `sectionTakes`.
   - Re-take controls: top toolbar button `btnRetakeSection` + user-configurable keydown listener (persisted in config/localStorage).
   - Prompter rendering: visual section header banners with distinct styling.
   - Stop session handler: calculate section time slices and trigger the Export Modal.

3. **`static/media.js`**:
   - Add buffer slicing utility: `sliceAudioBuffer(audioBuffer, startSeconds, endSeconds)`.
   - Add buffer concatenation utility: `concatAudioBuffers([buffer1, buffer2, ...])`.
   - Add ZIP packaging helper to bundle multiple blobs into a single `.zip` download.

4. **`static/index.html` & `static/style.css`**:
   - Add Re-take button to top navigation bar.
   - Add Re-take hotkey setting input to the Options drawer.
   - Add Export Modal markup and styling (section summary list, ZIP button, individual download buttons).

5. **Unit Tests**:
   - `test_formatter.js`: Add tests for section header preservation, word-to-section mapping, and leading intro handling.
   - `test_media.js`: Add tests for audio buffer slicing, concatenation, and filename sanitization.
