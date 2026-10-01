---
name: media-recording-and-take-export
description: >-
  Architecture, state lifecycle, debugging procedures, and testing for the teleprompter media recording,
  audio slicing, section take extraction, and export subsystems (static/media.js, static/timeline.js,
  static/export.js, static/app.js). Use whenever modifying MediaRecorder capture, section take slicing,
  WAV/MP3 audio conversion, file system export adapters, or take packaging.
---

# Media Recording, Take Slicing & Export Skill

This skill provides the comprehensive guide, runbook, architecture reference, and verification procedures for the session recording, section take extraction, audio encoding, and multi-file export subsystem in the local AI teleprompter.

---

## 1. System Architecture Overview

```
[User Mic / Camera Stream]
             │
             ▼
   [MediaRecorder] (static/media.js - MediaSession)
   - Audio: audio/webm (Chromium/Brave) or audio/mp4
   - Video: video/webm;codecs=vp9,opus or video/mp4
             │
             │ (Live session speech tracking in parallel)
             │ ───► [SectionTimeline] (static/timeline.js)
             │      Stamps startSec / endSec on active sections
             │
   [User Clicks Stop]
             │
             ▼
   [Stop Flush Window] (500ms in static/app.js)
   - Halts mic streaming: stopBrowserAudioStream()
   - Keeps sync receiver open for pending Whisper ASR tokens
   - Calls sectionTimeline.close(totalSessionSec)
             │
             ▼
   [Recording Finalizer] (finalizeRecording() in static/media.js)
   - Decodes recorded WebM Blob -> AudioBuffer via AudioContext
   - Safeguard: 2000ms race timeout against Chromium decode hangs
             │
             ▼
   [Take Slicing Engine] (processAudioTakes() in static/media.js)
   - Skips unreached sections (startSec === null)
   - Slices valid sections: [startSec - pad, endSec + pad]
   - Encodes discrete takes: audioBufferToMp3() (192kbps) or audioBufferToWav()
   - Concatenates clean sections -> everything.mp3 / everything.wav
             │
             ▼
   [Export Subsystem] (TeleprompterExport in static/export.js)
   - Option A: Native File System Access API (showDirectoryPicker)
   - Option B: In-browser PKZIP multi-file archive download
   - Option C: Direct sequential browser downloads
   - Metadata: Section markers for DaVinci Resolve
```

---

## 2. Core Modules & Responsibilities

| File | Primary Responsibility | Critical Invariants |
| :--- | :--- | :--- |
| [`static/media.js`](file:///Users/philkershaw/Documents/work/Tools/teleprompter/static/media.js) | Owns `MediaSession`, `MediaRecorder`, Web Audio decoding, LAME MP3 encoding, and `processAudioTakes` | Must downsample/resample cleanly. Must guard against Chromium `decodeAudioData` hangs. Must never slice unreached sections (`startSec == null`). |
| [`static/timeline.js`](file:///Users/philkershaw/Documents/work/Tools/teleprompter/static/timeline.js) | `SectionTimeline` deep module tracking wall-clock section boundaries and retake seek targets | When active section transitions, closes previous section at `nowSec` and opens next at `nowSec - 0.1s`. `retake()` resets target section timestamps. |
| [`static/export.js`](file:///Users/philkershaw/Documents/work/Tools/teleprompter/static/export.js) | `TeleprompterExport` module managing storage adapters (Directory Picker, Direct Download, In-Memory) | Falls back gracefully from File System Access API to direct download. Formats durations cleanly. |
| [`static/app.js`](file:///Users/philkershaw/Documents/work/Tools/teleprompter/static/app.js) | UI coordinator binding start/stop, retake button, HUD status badges, and export modal | Must provide a 500ms flush window before stopping MediaRecorder. Must prevent duplicate stop calls with `isStopping` guard. |

---

## 3. Critical Slicing & Boundary Invariants

When modifying section slicing or timeline recording:

1. **Unreached Section Guard**:
   - Never slice a section where `sec.startSec === null || sec.startSec === undefined || isNaN(Number(sec.startSec))`.
   - Missing start timestamps mean the user never reached or spoke that section. Slicing from `0` to `totalDuration` creates catastrophic duplicate audio files.
2. **Silence Padding Rule**:
   - Default padding is `pad = 0.25` seconds (250ms).
   - `sStart = Math.max(0, startSec - pad)`
   - `sEnd = Math.min(totalDuration, endSec + pad)`
   - Only slice if `sEnd > sStart`.
3. **Master Concatenation Locality**:
   - `everything.[format]` must be concatenated **strictly** from `cleanSectionBuffers` (only reached sections).
   - If no sections were reached, `finalizeRecording` must supply the original un-sliced recording as the master take so recordings are never lost.
4. **Flush Before Close**:
   - Speech recognition (faster-whisper) has ~300–500ms pipeline latency.
   - Clicking **Stop** must halt microphone input immediately, wait 400–600ms to allow in-flight WebSocket sync messages to register transitions, and only *then* call `sectionTimeline.close()` and stop `mediaRecorder`.
5. **Safety Timer Cancellation on onstop**:
   - In `mediaSession.stopRecording()`, `safetyTimer` must be cancelled via `clearTimeout(safetyTimer)` immediately when `this.mediaRecorder.onstop` begins executing.
   - Never allow `safetyTimer` to run during `finalizeRecording()`. Software MP3 encoding (via LAME JS) takes 1.5–5 seconds for multi-take sessions. If `safetyTimer` is not cleared, it will prematurely resolve with an emergency fallback, dropping all section takes and leaving only a single "Master Session Audio" file.
6. **Eliminate Redundant Full-Buffer Encoding**:
   - When sections are present, use the stitched master take from `processAudioTakes()` as `finalBlob` rather than redundantly encoding the entire un-sliced audio buffer to MP3 before slicing.

---

## 4. Verification & Testing Runbook

Always run the full test suite when making changes to media, timeline, or export logic:

### Running Media & Export Unit Tests
```bash
node test_media.js
node test_export.js
node test_timeline.js
```

### Running the Complete Node Test Suite
```bash
node --test test_*.js
```

---

## 5. Troubleshooting & Debugging Guide

### Symptom 1: Export modal only shows "Master Session Audio" with zero section takes
- **Check**: Did `safetyTimer` in `mediaSession.stopRecording()` expire during MP3 encoding? Ensure `clearTimeout(safetyTimer)` is called at the very top of `mediaRecorder.onstop`.
- **Check**: Did `decodeAudioData` time out? Verify the decode timeout in `finalizeRecording` is at least 15s, not 2s.
- **Check**: Are sections with `startSec: null` being processed? Verify that `processAudioTakes` in `static/media.js` skips unreached sections without dropping reached ones.

### Symptom 2: Browser hangs on "Processing MP3/WAV audio…"
- **Check**: Chromium/Brave `decodeAudioData` bug. Short WebM blobs without duration headers can hang indefinitely. Ensure the 2000ms `Promise.race` timeout in `finalizeRecording` is intact.

### Symptom 3: File System Directory picker throws security error
- **Check**: Browser security context. `showDirectoryPicker()` requires a secure context (`localhost` or HTTPS) and must be invoked directly from a user activation (click event). `TeleprompterExport` must fall back to direct downloads if rejected.
