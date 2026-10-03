---
name: teleprompter-diag-logging
description: >-
  Runbook for adding, reading, and interpreting runtime diagnostic console.log
  dumps in the teleprompter app to diagnose section boundary, take slicing, and
  audio duration bugs without needing MCP or a live debugger. Use whenever the
  user reports unexpected take durations, boundary collapse, or missing sections
  in the export modal, and real runtime values are needed to confirm the root cause.
---

# Teleprompter Diagnostic Logging Runbook

When a take slicing or boundary bug is reported, **real runtime values always beat code
analysis alone**. This skill describes the standard diagnostic logging pattern used in
this project: add a temporary `[DIAG]` block to the stop handler, do a test run, paste
the console output into chat.

---

## 1. Where to Add the Log

The canonical location is **inside the 1200ms flush `setTimeout` in `static/app.js`**,
immediately after:

```js
sectionTimeline.close(totalSessionSec);
sectionTimeline.resolveBoundaries(totalSessionSec);
```

This is the exact moment all boundaries are sealed and resolved — the values here
are what `processAudioTakes()` will use to slice the audio.

---

## 2. Standard [DIAG] Block

This block is already present in `static/app.js` (look for the `── [DIAG]` banner).
If it has been removed, paste this verbatim at that location:

```js
// ── [DIAG] Section Boundary Dump ────────────────────────────────────────
// Paste the console output from here into chat to diagnose boundary issues.
// Remove this block once the take slicing is confirmed correct.
try {
  const markers = sectionTimeline.getSectionMarkers();
  console.group('[DIAG] Section boundaries at Stop (totalSessionSec=' + totalSessionSec.toFixed(3) + 's)');
  markers.forEach((s, i) => {
    const dur = (s.startSec !== null && s.endSec !== null)
      ? (s.endSec - s.startSec).toFixed(3) + 's'
      : 'N/A';
    console.log(
      `  [${i + 1}] id=${s.id}  title="${s.title}"` +
      `  startSec=${s.startSec !== null ? s.startSec.toFixed(3) : 'null'}` +
      `  endSec=${s.endSec !== null ? s.endSec.toFixed(3) : 'null'}` +
      `  _lastSeenSec=${s._lastSeenSec !== null ? Number(s._lastSeenSec).toFixed(3) : 'null'}` +
      `  duration=${dur}`
    );
  });
  console.groupEnd();
} catch (_diagErr) { /* never block the stop flow */ }
// ── end [DIAG] ──────────────────────────────────────────────────────────
```

---

## 3. How to Capture the Output

1. Open **Brave/Chrome DevTools** → **Console** tab before starting the session.
2. Filter by `[DIAG]` in the console filter box to isolate output.
3. Do a real test run: start prompting, read the script naturally, click Stop.
4. When the export modal opens, switch to the Console tab.
5. Expand the `[DIAG] Section boundaries at Stop` group.
6. **Right-click → Copy** the group, or screenshot it, and paste into chat.

---

## 4. How to Read the Output

Example healthy two-section output:

```
[DIAG] Section boundaries at Stop (totalSessionSec=24.812s)
  [1] id=1  title="Section [1]"  startSec=1.900  endSec=12.650  _lastSeenSec=12.310  duration=10.750s
  [2] id=2  title="Section [2]"  startSec=12.650  endSec=24.812  _lastSeenSec=23.100  duration=12.162s
```

**What to check:**

| Field | Healthy value | Red flag |
|---|---|---|
| `startSec` sec-1 | ~1–3s (first real spoken word) | `0.000` or `0.001` → startup stamp bug |
| `endSec` sec-1 | Should match approx. last spoken word in sec-1 | Matches `startSec` or < 1s → collapse |
| `_lastSeenSec` | Should be close to `endSec` | `0.001` → startup stamp never overwritten |
| `duration` | Should reflect real spoken duration | `0.500s` or less for a 10s section → collapse |
| `totalSessionSec` | Real wall-clock session length | Much shorter than expected → sessionStartTime bug |

---

## 5. Common Failure Patterns & Interpretation

### Pattern A: `startSec=0.000`, `_lastSeenSec=0.001`, `duration=0.xxx`
**Cause**: The startup `updateHighlighting(0)` call stamped the timeline at t≈0.
**Fix**: The `isPrompting=false` guard in `startSession()` should prevent this. If this
appears, the guard was removed or bypassed.

### Pattern B: `startSec` is reasonable, `endSec` matches `startSec` (duration≈0)
**Cause**: Cadence lookback set `curStartSec` equal to or before `prev.startSec`.
Check `_lastSeenSec` — if null or near-zero, no real words were tracked for that section.

### Pattern C: `startSec=null` for all sections
**Cause**: `isPrompting` was false during the entire session, or `parsedSections` was
empty. Check the script parser output and session start lifecycle.

### Pattern D: `totalSessionSec` is < 2s
**Cause**: `sessionStartTime` was reset after Stop was clicked, or the timing reference
is wrong. Check the `sessionStartTime = Date.now()` line in `startSession()`.

### Pattern E: Only `1.mp3` shown, no `2.mp3`
**Cause**: Section 2 `startSec` is null — `resolveBoundaries` did not fire, or
`totalSessionSec` equalled Section 1's `endSec` exactly (no unaccounted time).

---

## 6. Escalating the Diagnostic

If the boundary dump alone is insufficient, add a per-transition trace inside
`static/timeline.js → wordSeen()` at the `secId !== this._activeId` branch:

```js
console.log('[DIAG TRANSITION]', {
  from: this._activeId, to: secId,
  nowSec: nowSec.toFixed(3),
  curStartSec: curStartSec !== null ? curStartSec.toFixed(3) : 'null',
  prevEndSec: prev && prev.endSec !== null ? prev.endSec.toFixed(3) : 'null',
});
```

This reveals every section change in real time as Whisper tokens arrive.

---

## 7. Removing the Diagnostic

Once confirmed and fixed, remove the `[DIAG]` block. It is delimited by:

```
── [DIAG] Section Boundary Dump ──
...
── end [DIAG] ──
```

Locate it quickly with:

```bash
grep -n '\[DIAG\]' static/app.js
```
