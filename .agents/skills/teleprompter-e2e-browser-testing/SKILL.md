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

- After making changes to `static/app.js`, `static/media.js`, `static/timeline.js`, `static/viewport.js`, `static/script_editor.js`, `static/server_control.js`, `static/cues.js`, or `static/index.html`.
- To verify session start, live speech tracking, section transition stamping, and take export behavior in an actual browser environment.
- To verify modal controllers and hotkeys (Script Editor via `Cmd/Ctrl+E`, Difficult Words via `#btn-open-difficult-words`, Server Control restart/shutdown confirmations, and dismissal via `Escape`).
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
   - Confirm status badge transitions to `FINALIZING…` during the 1200ms flush window (allowing in-flight Whisper frames to settle).
   - Confirm `#export-modal` unhides (`classList.contains('hidden') === false`).
7. **Inspect Generated Takes**:
   Query the rendered take elements:
   ```javascript
   const takes = Array.from(document.querySelectorAll('#export-takes-list > div')).map(el => el.textContent.trim());
   console.log('Exported Takes:', takes);
   ```
   **Pass Criteria**:
   - `Section One` take (`1.mp3` or `1.wav`) exists with non-zero duration.
   - `Section Two` take (`2.mp3` or `2.wav`) exists with non-zero duration (even if boundary words were dropped, via cadence lookback or fallback resolution).
   - Spliced master (`everything.[format]`) exists.
   - No duplicate unreached section files exist.

### Workflow B: Modal & Dialog Verification
To verify modal controllers, focus handling, and keydown routers:

1. **Script Editor Modal**:
   - Press `Cmd+E` (or `Ctrl+E`). Confirm `#modal-script-editor` opens and `#modal-transcript-input` receives focus.
   - Edit text, verify stats (word count, duration, section count) update in real-time.
   - Press `Escape` or click `#btn-modal-cancel`. Confirm modal closes without saving unapplied changes.
   - Click `#btn-modal-apply`. Confirm text synchronizes to main `#transcript-input` and triggers prompter re-render.
2. **Difficult Words Modal**:
   - Click `#btn-open-difficult-words`. Confirm `#modal-difficult-words` opens.
   - Type a word into `#input-difficult-word` and press `Enter`. Confirm a new tag chip is rendered and badge count increments.
   - Change treatment style (Pill / Glow / Underline) and color swatch. Confirm `--difficult-color` and preview element update.
   - Press `Escape` or click outside dialog to confirm clean dismissal.
3. **Server Control Dialog**:
   - Click `#btn-restart-server` or `#btn-shutdown-server`. Confirm confirmation modal appears with appropriate title and buttons.
   - Press `Escape` or click backdrop to confirm dismissal when idle.
   - During restart/shutdown in-progress states, verify dismissal is locked (`canDismiss() === false`).

### Workflow C: Transcript Persistence & Boot Verification Test
To verify that script persistence, local storage fallback, and server configuration recovery function across page refreshes:

1. **Verify Startup State**:
   - Navigate to `http://127.0.0.1:8000/`.
   - Inspect console logs: confirm there are **zero unhandled exceptions** or `TypeError: ... is not a constructor`.
   - Confirm `#transcript-input` contains the persisted script.
   - Confirm `#prompter-words` (or line spans) are fully rendered and `#btn-start` is enabled.
2. **Mutate & Trigger Autosave**:
   - Enter a distinct test string into `#transcript-input` (e.g. `Persistence Smoke Test Script`).
   - Wait 1 second for the debounced autosave to trigger.
   - Verify `configStore.get('script.saved_transcript')` and `localStorage.getItem('teleprompter_saved_transcript')` match the input.
3. **Reload & Confirm Restoration**:
   - Perform a full page reload (`window.location.reload()` or browser refresh).
   - Verify that `#transcript-input` immediately displays `Persistence Smoke Test Script`.
   - Verify `#prompter-words` immediately renders word spans matching the script.
   - Verify WebSocket connects successfully (`ws.readyState === 1`).

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
   - Cadence lookback properly anchored Section 2 after Section 1's `endSec`.
   - `sectionTimeline.resolveBoundaries(totalDuration)` eliminates `startSec: null` if audio extended past Section 1.
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

---

## 6. Modular Controller Architecture & Boot Safety Guardrails

When extracting or refactoring modular frontend controllers (e.g. `static/server_control.js`, `static/script_editor.js`):

1. **Constructor Function Export Pattern (Browser Global vs UMD)**:
   - In browser script tags, `root.ModuleName` must resolve directly to a callable constructor, not a plain object container.
   - Attach inner helper classes and constants directly to the constructor function:
     ```javascript
     TeleprompterServerControl.TeleprompterServerControl = TeleprompterServerControl;
     TeleprompterServerControl.ICONS = ICONS;
     TeleprompterServerControl.STYLES = STYLES;
     return TeleprompterServerControl;
     ```
   - In calling code (`static/app.js`), safely resolve classes using dual resolution:
     ```javascript
     const ControllerClass = (typeof TeleprompterController !== 'undefined')
       ? (TeleprompterController.TeleprompterController || TeleprompterController)
       : null;
     ```

2. **Defensive Subsystem Isolation**:
   - Secondary dialog modals (server restart/shutdown, script editor, export dialog) must be instantiated inside `try...catch` blocks.
   - Never allow an error in an auxiliary UI modal to interrupt the primary execution thread or block the `Boot` stage.
   - Always wrap the core `Boot` sequence (`optFontsize`, `optBoxWidth`, `persistTranscript`, `parseAndRenderTranscript`, `connect()`) defensively.

3. **Complex Object Sanitization (`rehearsal_words`)**:
   - Rehearsal stumble items are rich objects (`{ word, clean, reason }`).
   - Never cast array elements with naive `String(w)` or `str(w)`, which produces `"[object Object]"` strings that corrupt `teleprompter.json`.
   - Explicitly preserve dictionary structures and filter out any corrupted `"[object object]"` entries in both `static/config.js` and `config.py`.

4. **Testing Simulated Browser Globals**:
   - Node's `require()` destructures `module.exports` and will mask browser global object wrapping bugs.
   - Always include a Node test utilizing `vm.runInContext` to evaluate the module script with `module` and `exports` undefined, asserting that `root.ModuleName` is a valid constructor function.
