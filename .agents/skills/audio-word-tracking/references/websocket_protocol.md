# WebSocket Sync Protocol & Message Schema

The teleprompter communicates over a bidirectional WebSocket connection on the same port as the static HTTP server.

---

## 1. Client-to-Server Messages

### Start Session
```json
{
  "type": "start",
  "words": ["Today", "I'm", "going", "to", "give", "you", "..."],
  "wpm": 140
}
```
*Effect*: Resets `Aligner` with provided transcript words, resets ring buffer, sets `running = True`.

### Stop Session
```json
{
  "type": "stop"
}
```
*Effect*: Stops transcription detection loop and sets `running = False`.

### Seek / Manual Word Jump
```json
{
  "type": "seek",
  "word_index": 42
}
```
*Effect*: Immediately moves `Aligner.cursor` to index 42, resets consecutive miss `streak` to 0.

### Switch Speed / Engine Profile
```json
{
  "type": "set_engine",
  "mode": "ultrafast" // "ultrafast" | "fast" | "standard"
}
```
*Effect*: Updates tick interval, rolling window size, and switches Whisper model in background.

### Browser Audio Frame (when `--browser-audio` is active)
```json
{
  "type": "audio",
  "data": [0.0012, -0.0034, 0.0056, ...]
}
```

---

## 2. Server-to-Client Messages

### Word Sync
```json
{
  "type": "sync",
  "word_index": 14,
  "state": "speaking"
}
```
*Frontend Action*: Highlights word `#w-14`, scrolls viewport to line `#line-{lineIdx}`.

### Engine Status
```json
{
  "type": "status",
  "model": "base.en",
  "ready": true,
  "profile": "fast",
  "tick": 0.6
}
```

### Configuration
```json
{
  "type": "config",
  "browser_audio": false,
  "profile": "fast",
  "profiles": { ... }
}
```

### Error
```json
{
  "type": "error",
  "message": "Model load failed: ..."
}
```
