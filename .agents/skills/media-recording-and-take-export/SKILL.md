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
             │      - Stamps startSec / endSec on active transitions
             │      - Cadence Lookback: ~140 WPM (~400ms/word) for missed boundary words
             │
   [User Clicks Stop]
             │
             ▼
   [Stop Flush Window] (1200ms in static/app.js)
   - Halts mic streaming: stopBrowserAudioStream()
   - Keeps sync receiver open for pending Whisper ASR tokens (600ms CPU tick + 500ms margin)
   - Calls sectionTimeline.close(totalSessionSec)
   - Calls sectionTimeline.resolveBoundaries(totalSessionSec)
             │
             ▼
   [Recording Finalizer] (finalizeRecording() in static/media.js)
   - Decodes recorded WebM Blob -> AudioBuffer via AudioContext
   - Safeguard: 15s race timeout against Chromium decode hangs
             │
             ▼
   [Take Slicing Engine] (processAudioTakes() in static/media.js)
   - Runs reconcileSectionBoundaries() pass:
     If buffer extends beyond Section 1, unstarted sections get proportional slices
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
| [`static/media.js`](file:///Users/philkershaw/Documents/work/Tools/teleprompter/static/media.js) | Owns `MediaSession`, `MediaRecorder`, Web Audio decoding, LAME MP3 encoding, `processAudioTakes`, format presets (`VIDEO_FORMATS`, `AUDIO_FORMATS`), and audio device/format UI binding (`bindUI`) | Must downsample/resample cleanly. Must guard against Chromium `decodeAudioData` hangs. Runs `reconcileSectionBoundaries()` so unstarted sections with recorded audio produce takes. Encapsulates hardware/browser device selection and recording format UI synchronization. |
| [`static/timeline.js`](file:///Users/philkershaw/Documents/work/Tools/teleprompter/static/timeline.js) | `SectionTimeline` deep module tracking wall-clock section boundaries and retake seek targets | When active section transitions, closes previous section. Missing boundary words use cadence lookback (~400ms/word). `resolveBoundaries()` resolves unstarted sections against unaccounted audio. |
| [`static/export.js`](file:///Users/philkershaw/Documents/work/Tools/teleprompter/static/export.js) | `TeleprompterExport` module managing storage adapters (Directory Picker, Direct Download, In-Memory) | Falls back gracefully from File System Access API to direct download. Formats durations cleanly. |
| [`static/app.js`](file:///Users/philkershaw/Documents/work/Tools/teleprompter/static/app.js) | UI coordinator binding start/stop, retake button, HUD status badges, and export modal | Must provide a 1200ms flush window before stopping MediaRecorder. Must prevent duplicate stop calls with `isStopping` guard. |

---

## 3. Critical Slicing & Boundary Invariants

When modifying section slicing or timeline recording:

1. **Fallback Boundary Recovery & Unstarted Section Guard**:
   - `reconcileSectionBoundaries()` evaluates sections before slicing: if recorded audio extends beyond Section 1, unstarted trailing sections receive their proportional slice of the unaccounted audio rather than being skipped.
   - If the recorded buffer duration does *not* extend beyond Section 1 (e.g. user stopped immediately), unreached sections remain un-sliced to prevent empty ghost takes.
2. **Silence Padding Rule**:
   - Default padding is `pad = 0.25` seconds (250ms).
   - `sStart = Math.max(0, startSec - pad)`
   - `sEnd = Math.min(totalDuration, endSec + pad)`
   - Only slice if `sEnd > sStart`.
3. **Master Concatenation Locality**:
   - `everything.[format]` must be concatenated **strictly** from `cleanSectionBuffers` (only reached sections).
   - If no sections were reached, `finalizeRecording` must supply the original un-sliced recording as the master take so recordings are never lost.
4. **Flush Before Close (1200ms Window)**:
   - Faster-whisper on CPU has a 600ms tick loop and a 500ms commit margin.
   - Clicking **Stop** must halt microphone input immediately, wait 1200ms to allow in-flight Whisper frames to emit final section transitions, and only *then* seal `sectionTimeline.close()`, run `sectionTimeline.resolveBoundaries()`, and finalize `mediaRecorder`.
5. **Cadence-Aware Boundary Lookback**:
   - When a word inside Section 2 (or any section) is first recognized, if it is not the very first word of that section (`globalIdx > startIndex`), the true start time looks back based on average speaking pace (~140 WPM, ~400ms per word).
   - The estimated start time is cleanly anchored after the preceding section's end, and if the preceding section was active, it closes cleanly at that boundary.
6. **Safety Timer Cancellation on onstop**:
   - In `mediaSession.stopRecording()`, `safetyTimer` must be cancelled via `clearTimeout(safetyTimer)` immediately when `this.mediaRecorder.onstop` begins executing.
   - Never allow `safetyTimer` to run during `finalizeRecording()`. Software MP3 encoding (via LAME JS) takes 1.5–5 seconds for multi-take sessions. If `safetyTimer` is not cleared, it will prematurely resolve with an emergency fallback, dropping all section takes and leaving only a single "Master Session Audio" file.
7. **Eliminate Redundant Full-Buffer Encoding**:
   - When sections are present, use the stitched master take from `processAudioTakes()` as `finalBlob` rather than redundantly encoding the entire un-sliced audio buffer to MP3 before slicing.

---

## 3b. Post-Recording Boundary Refinement (primary boundary source)

**Root cause it fixes:** live boundaries come from when the *live* Whisper first reports a word in the next section, which lags real speech by several seconds on CPU. `_estimateStartSec` in `timeline.js` caps cadence lookback at 1.2s, so a large lag leaves the cut far too late (Section 1 swallows most of Section 2). Do NOT try to fix this by tuning the live lookback; the audio itself is the source of truth.

**Flow:**
```
[Stop] -> finalizeRecording() decodes AudioBuffer
   -> opts.refineBoundaries(audioBuffer, sections)  (app.js: requestRefinedBoundaries)
   -> audioBufferToPcm16k()  (media.js: mono, 16 kHz, int16)
   -> WebSocket JSON chunks {type:'refine_chunk', id, seq, data(base64)} (~400 KB each; server max_size is 2 MB)
   -> {type:'refine_end', id, sections:[{id,text}]}
   -> server.py handle_client intercepts messages whose first 64 chars contain "refine_" (so `type` must be the FIRST JSON key); everything else still goes to prompter.dispatch
   -> worker thread: refine.RefineUpload.to_samples() -> transcriber.transcribe_full() (word timestamps, model from engine.refine_model, default small.en, shares _MODEL_CACHE)
   -> refine.align_sections() (difflib monotonic match of script tokens to spoken tokens; fuzzy, e.g. VSR400 vs VSR 400)
   -> {type:'refine_result', id, ok, boundaries:{sectionId:{startSec,endSec}|null}} via hub.schedule
   -> media.js applyRefinedBoundaries() overwrites startSec/endSec, then processAudioTakes() slices as normal
```

**Invariants:**
1. Failure is always silent-fallback: timeout (max(60s, 2x duration), cap 600s), error, closed socket, or null section => keep live boundaries. Never let refinement block or lose a recording.
2. The browser sends decoded PCM so the server never decodes WebM.
3. `applyRefinedBoundaries` only accepts finite ranges with end > start.
4. Python changes (`server.py`, `transcriber.py`, `refine.py`) need a server restart; JS changes need a hard refresh.

**Known gaps:** retakes (section read twice) give a blended match (intended rule: use the LAST complete read); `engine.refine_model` is read from `teleprompter.json` but not in the config schema/UI; optional future step is snapping cuts to the nearest silence.

---

## 4. Verification & Testing Runbook

Always run the full test suite when making changes to media, timeline, or export logic:

### Running Media & Export Unit Tests
```bash
node test_media.js
node test_export.js
node test_timeline.js
node test_simulation.js
node --test test_refine_media.js
```

Backend (refinement matching): `.venv/bin/python -m unittest test_refine.py`

### Running the Complete Node Test Suite
```bash
node --test test_*.js
```

---

## 5. Troubleshooting & Debugging Guide

### Symptom 1: Export modal only shows "Master Session Audio" with zero section takes
- **Check**: Did `safetyTimer` in `mediaSession.stopRecording()` expire during MP3 encoding? Ensure `clearTimeout(safetyTimer)` is called at the very top of `mediaRecorder.onstop`.
- **Check**: Did `decodeAudioData` time out? Verify the decode timeout in `finalizeRecording` is at least 15s.
- **Check**: Did `reconcileSectionBoundaries()` run? If Whisper missed Section 2 words, `reconcileSectionBoundaries` guarantees Section 2 is assigned its slice rather than falling back to Master Session Audio.

### Symptom 2: Beginning of Section 2 audio is cut off in 2.mp3
- **Check**: Cadence lookback in `static/timeline.js`. If the speaker started Section 2 but Whisper missed words 0–2, verify `_estimateStartSec` applied the ~400ms/word lookback.

### Symptom 3: Browser hangs on "Processing MP3/WAV audio…"
- **Check**: Chromium/Brave `decodeAudioData` bug. Short WebM blobs without duration headers can hang indefinitely. Ensure the race timeout in `finalizeRecording` is intact.

### Symptom 4: File System Directory picker throws security error
- **Check**: Browser security context. `showDirectoryPicker()` requires a secure context (`localhost` or HTTPS) and must be invoked directly from a user activation (click event). `TeleprompterExport` must fall back to direct downloads if rejected.

### Symptom 5: Cuts land late; Section 1 contains most of Section 2
- **Cause**: live Whisper lag + the 1.2s lookback cap (see Section 3b). Check the browser console: `[REFINE]` warnings mean refinement fell back to live boundaries; the `[DIAG]` block shows the live values.
- **Check**: Was the server restarted after Python changes? Is `engine.refine_model` valid? Did the first run have to download the model (slow, may hit the timeout)?
- **Check**: If a section comes back null, the transcript did not match the script text; compare the spoken words to the script wording.

