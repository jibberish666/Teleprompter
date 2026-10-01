---
name: teleprompter-e2e-browser-testing
description: >-
  Workflows, procedures, and runbooks for end-to-end browser testing and interactive verification of the
  teleprompter application running at http://127.0.0.1:8000/. Use to drive real browser sessions, simulate
  speech tracking across section boundaries, inspect console logs, and verify export modals and audio take slicing.
---

# Teleprompter End-to-End Browser Testing Skill

This skill provides the operational runbook and verification procedures for conducting automated and interactive browser tests of the 100% Local AI Teleprompter web application running locally (`http://127.0.0.1:8000/`).

---

## 1. When to Use This Skill

- After making changes to `static/app.js`, `static/media.js`, `static/timeline.js`, `static/viewport.js`, or `static/index.html`.
- To verify session start, live speech tracking, section transition stamping, and take export behavior in an actual browser environment.
- When troubleshooting browser-specific quirks (e.g. MediaRecorder WebM encoding, AudioContext decoding timeouts, or modal styling).

---

## 2. Prerequisites & Server Health Check

Before starting browser interactions, ensure the local Python server is running:

```bash
# Check if server is listening on port 8000
lsof -i :8000
# Or check process
ps aux | grep server.py | grep -v grep
```

If not running, launch it:
```bash
python3 server.py --port 8000
```

---

## 3. End-to-End Verification Workflows

### Workflow A: Synthetic Speech & Section Slicing Test
To verify section boundary transitions and take slicing without requiring live microphone audio:

1. **Open Teleprompter Page**:
   Navigate to `http://127.0.0.1:8000/`.
2. **Inject Test Script with Section Markers**:
   Paste a formatted multi-section script into `#transcript-input`:
   ```text
   [Section One]
   Welcome to the teleprompter test recording session today.
   We are verifying that the audio engine slices sections cleanly.

   [Section Two]
   Now we have advanced into the second section of the presentation.
   Every section should produce its own independent audio take file.
   ```
3. **Verify Section Parsing**:
   Verify that the retake button displays `Re-take [Section One]`.
4. **Trigger Session Start**:
   Click `#btn-start`. Confirm `#badge-vad` updates to `LISTENING (LOCAL WHISPER)` or `RECORDING`.
5. **Simulate Section Progression (via Console Evaluation)**:
   In the browser console, simulate word progression across the section boundary:
   ```javascript
   // Advance to section 1 words
   window.dispatchEvent(new MessageEvent('message', {
     data: JSON.stringify({ type: 'sync', word_index: 3, state: 'speaking' })
   }));
   // Wait 1-2 seconds, then advance into section 2 words
   setTimeout(() => {
     window.dispatchEvent(new MessageEvent('message', {
       data: JSON.stringify({ type: 'sync', word_index: 22, state: 'speaking' })
     }));
   }, 1500);
   ```
6. **Trigger Session Stop**:
   Click `#btn-stop`.
   - Confirm status badge transitions to `FINALIZING…` during the 500ms flush window.
   - Confirm `#export-modal` unhides (`classList.contains('hidden') === false`).
7. **Inspect Generated Takes**:
   Query the rendered take elements:
   ```javascript
   const takes = Array.from(document.querySelectorAll('#export-takes-list > div')).map(el => el.textContent.trim());
   console.log('Exported Takes:', takes);
   ```
   **Pass Criteria**:
   - `Section One` take exists with non-zero duration.
   - `Section Two` take exists with non-zero duration.
   - Durations are distinct and match section lengths.
   - Spliced master (`everything.[format]`) exists.
   - No duplicate unreached section files exist.

---

## 4. Browser Console & Audio Diagnostics Runbook

When debugging unexplained behavior in the browser:

1. **Inspect Section Timeline State**:
   Evaluate current section timestamps:
   ```javascript
   console.table(sectionTimeline.getSectionMarkers());
   ```
   Verify:
   - `startSec` and `endSec` are finite numbers for reached sections.
   - Unreached sections have `startSec: null` and `endSec: null`.
2. **Inspect Active MediaRecorder State**:
   ```javascript
   console.log({
     state: mediaSession.mediaRecorder ? mediaSession.mediaRecorder.state : 'none',
     chunks: mediaSession.recordedChunks ? mediaSession.recordedChunks.length : 0,
     activeMode: mediaSession.activeRecordMode,
     audioFormat: mediaSession.activeAudioFormat
   });
   ```
3. **Inspect WebSocket Connection**:
   ```javascript
   console.log('WS State:', ws ? ws.readyState : 'none'); // 1 = OPEN
   ```

---

## 5. Clean-Up & Server Restart Rule

Whenever changes are made to `static/app.js` or `static/index.html`:
- The client-side bundle is loaded directly by the browser. Always perform a hard refresh (`Cmd+Shift+R`) in the active tab to bust cache.
