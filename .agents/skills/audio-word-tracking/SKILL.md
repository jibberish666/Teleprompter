---
name: audio-word-tracking
description: >-
  Workflows, architecture, debugging procedures, and testing for the 100% local AI teleprompter
  audio input pipeline (sounddevice, browser audio WebSocket stream, Silero VAD, faster-whisper)
  and real-time script word tracking and alignment (aligner.py, transcriber.py, server.py, static/app.js).
  Use whenever modifying audio capture, transcription parameters, alignment algorithms, sync latency,
  speech jumping behavior, or adding tests for speech tracking.
---

# Audio Input & Script Word Tracking Skill

This skill provides the comprehensive guide, runbook, architecture reference, and verification procedures for the audio capture and speech-synchronized word tracking engine in the local AI teleprompter.

---

## 1. System Architecture Overview

```
[Microphone (sounddevice)]  OR  [Browser Audio (16kHz PCM)]
                  │
                  ▼
         [audio_capture.py]
      (Rolling ring buffer, 16kHz float32)
                  │
                  ▼
         [transcriber.py]
      (faster-whisper background loop _tick())
      - VAD filter + peak normalization
      - Rolling window (2.5s - 4.0s)
      - Committed timestamp boundary deduplication
                  │ (Emits newly committed normalized words)
                  ▼
          [aligner.py]
      (Locality-first fuzzy alignment)
      - Tier 1: Local window (0-4 words) with distance penalty
      - Tier 2: Mandatory multi-word confirmation for forward jumps (> 4 words)
      - Compound word resolution ("high" + "speed" <-> "highspeed")
      - Stem & inflection matching ("balance" <-> "balancing")
                  │ (Emits monotonically rising word index)
                  ▼
          [server.py] (SyncHub)
      (Broadcasts WebSocket sync payload: {"type": "sync", "word_index": idx})
                  │
                  ▼
       [static/app.js] (Frontend)
      - Highlights active word (#w-idx)
      - Translates viewport (translateY(-lineIdx * 45px))
      - Supports manual seek overrides (click / arrow keys)
```

---

## 2. Core Modules & Responsibilities

| File | Primary Responsibility | Critical Invariants |
| :--- | :--- | :--- |
| [`audio_capture.py`](file:///Users/philkershaw/Documents/work/Tools/teleprompter/audio_capture.py) | Owns PyAudio/sounddevice mic or receives browser WebSocket PCM stream | Sample rate must remain 16,000 Hz, mono float32. Ring buffer must be thread-safe. |
| [`transcriber.py`](file:///Users/philkershaw/Documents/work/Tools/teleprompter/transcriber.py) | Faster-Whisper background loop (`_tick()`), model caching, dynamic speed profiles | Audio normalized to peak 1.0 for Silero VAD. `committed_abs_end` prevents duplicate ASR word emission. |
| [`aligner.py`](file:///Users/philkershaw/Documents/work/Tools/teleprompter/aligner.py) | Monotonic text alignment of ASR tokens to script word positions | Strict locality-first matching. Jumps $>4$ words strictly require multi-word confirmation. Short words $\le 3$ chars strictly exact match. |
| [`server.py`](file:///Users/philkershaw/Documents/work/Tools/teleprompter/server.py) | Hosts HTTP static server + WebSocket sync hub | Routes `start`, `stop`, `seek`, `set_engine`, and broadcasts `sync` and `status` payloads. |
| [`static/app.js`](file:///Users/philkershaw/Documents/work/Tools/teleprompter/static/app.js) | UI state, transcript chunking, line scrolling, manual seek handlers | Word highlighting class `bg-yellow-400 text-black font-bold`. Line height = 45px. |

---

## 3. Alignment Engine Rules & Invariants

When modifying [`aligner.py`](file:///Users/philkershaw/Documents/work/Tools/teleprompter/aligner.py), always enforce the following invariants:

1. **Short Word Guard ($\le 3$ characters)**:
   - Never allow fuzzy or prefix matching on words of length $\le 3$ (e.g. `"the"`, `"car"`, `"our"`, `"to"`, `"in"`, `"you"`, `"and"`, `"for"`).
   - Must return `1.0` if `a == b` else `0.0`.
2. **First-Letter Match for Edit Distance**:
   - Guard against rhyming substitutions (e.g. `"rotor"` vs `"motor"`, `"light"` vs `"night"`). If `a[0] != b[0]`, return `0.0`.
3. **Common Stem / Inflection Matching**:
   - Allow morphological stems (e.g. `"balance"` $\leftrightarrow$ `"balancing"`, `"assembly"` $\leftrightarrow$ `"assemblies"`) only when `min_len >= 5` and common prefix ratio $\ge 0.75$.
4. **Locality Distance Penalty**:
   - Within tight window ($0 \le k < 5$): $\text{Score}(k) = \text{Similarity} - 0.10 \times k$. Immediate words always beat lookahead words.
5. **Mandatory Multi-Word Confirmation for Jumps**:
   - Any match $> 4$ words ahead **must** have at least 2 consecutive matching words ($sim \ge 0.75$).
   - If combined length $< 7$ chars (e.g. `"in the"`, `"to a"`), require a 3rd consecutive matching word.
6. **Compound Word Resolution**:
   - Handle split ASR tokens (`["high", "speed"]` $\rightarrow$ `"highspeed"`) and compound script words (`"turbocharger"` $\rightarrow$ `["turbo", "charger"]`).

---

## 4. Verification & Testing Runbook

Always run the full test suite when making changes to speech sync or audio processing:

### Running Automated Tests
```bash
.venv/bin/python -m unittest test_aligner.py -v
```

### Running Playback Simulation on Real Session Recordings
To test against real recorded session audio:
```bash
.venv/bin/python .agents/skills/audio-word-tracking/scripts/simulate_session.py
```

---

## 5. Troubleshooting & Debugging Guide

### Symptom 1: Teleprompter jumps sentences ahead unexpectedly
- **Check**: Did a single word trigger a jump? Verify that Phase 2 in `aligner.py` enforces multi-word sequence confirmation.
- **Check**: Is `_similarity()` matching common short words like `"the"` to `"these"`? Ensure short word isolation ($\le 3$ chars) is intact.

### Symptom 2: Teleprompter stops advancing (hangs / lags)
- **Check**: Microphone levels. Ensure input audio is not completely silent or clipped.
- **Check**: Silero VAD threshold. Transcriber normalizes peak audio to 1.0 so quiet mics are not rejected by VAD.
- **Check**: Profile tick interval. Switch profile via UI or WebSocket (`set_engine` to `ultrafast` for 0.4s or `fast` for 0.6s).
- **Check**: `align_window` parameter. Standard tight window is 5.

### Symptom 3: Duplicate word sync events
- **Check**: `committed_abs_end` boundary in `transcriber.py`. Words starting before `committed_abs_end - 0.15` must be discarded to avoid rolling-window re-emissions.

---

## 6. References & Deep-Dives

- [Alignment Math & Similarity Specification](./references/alignment_math.md)
- [Audio & Faster-Whisper Pipeline Architecture](./references/audio_pipeline.md)
- [WebSocket Sync Protocol & Payloads](./references/websocket_protocol.md)
