# Audio & Faster-Whisper Pipeline Architecture

This document describes the audio capture, VAD filtering, rolling-window buffer, and timestamp deduplication mechanics in [`audio_capture.py`](file:///Users/philkershaw/Documents/work/Tools/teleprompter/audio_capture.py) and [`transcriber.py`](file:///Users/philkershaw/Documents/work/Tools/teleprompter/transcriber.py).

---

## 1. Dual Audio Ingestion Modes

1. **Local System Audio (`sounddevice`)**:
   - `audio_capture.AudioCapture(mic=...)`
   - Spawns background PyAudio/sounddevice input stream at 16,000 Hz, 1-channel (mono), 32-bit float.
   - Pushes frames into an internal numpy ring buffer (`latest(seconds)`).
2. **Browser WebSocket Audio (`--browser-audio`)**:
   - macOS double-mic conflict escape hatch.
   - Frontend captures mic via `getUserMedia` $\rightarrow$ downsamples to 16,000 Hz via `ScriptProcessorNode` / `AudioWorklet` $\rightarrow$ streams raw float32 arrays over WebSocket (`{"type": "audio", "data": [...]}`).
   - `capture.write_frames(np.asarray(data, dtype=np.float32))` fills the ring buffer identically.

---

## 2. Faster-Whisper Rolling Window Loop

The `Transcriber` runs a dedicated background worker thread (`_loop`):

```python
while not self._stop.is_set():
    if not self._running.is_set() or not self.is_ready:
        time.sleep(0.1)
        continue
    self._tick()
    time.sleep(self.tick)
```

### Engine Profiles:
| Profile | Model | Tick Interval | Rolling Audio Window | Beam Size | Latency |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `ultrafast` | `tiny.en` | 0.4s | 2.5s | 1 | ~150ms |
| `fast` | `base.en` | 0.6s | 3.0s | 1 | ~250ms |
| `standard` | `base.en` | 1.2s | 4.0s | 5 | ~500ms |

---

## 3. Timestamp Deduplication & Commit Boundary

To prevent duplicate words across rolling windows:

1. **Peak Normalization**:
   ```python
   peak = float(np.max(np.abs(audio)))
   if peak > 1e-5 and abs(peak - 1.0) > 1e-3:
       audio = audio / peak
   ```
   Ensures Silero VAD (`vad_filter=True`) does not reject soft speech.

2. **Commit Boundary Protection**:
   - `commit_margin_s = 0.5`: Words ending within 0.5s of the rolling window tail are held back for the next tick to prevent half-spoken words from being prematurely committed.
   - `committed_abs_end`: High-water mark timestamp. Words with `abs_end <= committed_abs_end` or `abs_start < committed_abs_end - 0.15` are discarded.
