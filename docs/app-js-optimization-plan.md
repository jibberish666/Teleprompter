# `app.js` Optimization Plan

> **Context:** [`static/app.js`](file:///Users/philkershaw/Documents/work/Tools/teleprompter/static/app.js) is currently ~1,987 lines / 81KB. It acts as a God IIFE — a single function that handles all state, DOM wiring, WebSocket protocol, UI rendering, modal controllers, audio routing, session lifecycle, and server control. The options below are independent and can be picked up in any order.

---

## Option 1 — Shared `showToast()` utility

**Effort:** Low | **Risk:** Very Low | **Lines saved:** ~40

### Problem
Three structurally identical toast functions exist:
- `showFormatToast(msg)` — main UI toast
- `showModalStatus(msg)` — difficult words modal
- `showModalScriptToast(msg)` — script editor modal

All three do the same thing: set `textContent`, toggle opacity classes, and clear after a timeout. They just target different DOM elements.

### Fix
Replace all three with a single shared utility:

```js
function showToast(el, msg, durationMs = 2000) {
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('opacity-0');
  el.classList.add('opacity-100');
  setTimeout(() => {
    el.classList.remove('opacity-100');
    el.classList.add('opacity-0');
  }, durationMs);
}
```

Call sites become: `showToast(formatToast, 'Formatted ✓')`, `showToast(modalScriptToast, 'Saved & Applied ✓', 1800)`, etc.

---

## Option 2 — Merge Start / Rehearse into `startSession(isRehearsal)`

**Effort:** Low–Medium | **Risk:** Low | **Lines saved:** ~70

### Problem
The `btnStart` and `btnRehearse` click handlers (lines ~1540–1685) are 90% identical. Both:
- Call `parseAndRenderTranscript()` and reset word index
- Check and init the audio stream
- Call `ensureAudioContext()`
- Conditionally start browser audio streaming
- Build `sectionBoundaries` and send a `start` message
- Update button visibility and set badges

The only meaningful differences are: `isRehearsal = true/false`, skipping `startRecording()` in rehearsal mode, and the badge/HUD text on completion.

### Fix
Extract a shared `async function startSession(rehearsal = false)` that both buttons call. A single `if (rehearsal)` block covers the diverging logic paths.

---

## Option 3 — Unify `window.keydown` handlers

**Effort:** Low | **Risk:** Low | **Lines saved:** ~20

### Problem
There are at least **3 separate** `window.addEventListener('keydown', ...)` calls scattered through the file:
1. Escape key for the difficult words modal (~line 403)
2. Escape + Cmd/Ctrl+E for the script editor modal (~line 1421)
3. Arrow keys and retake hotkey for navigation (~line 1795)

Having them split means they execute independently and can interact in non-obvious ways (e.g. Escape propagating through multiple handlers).

### Fix
Consolidate into a **single keyboard router** at the top of the keyboard section. Each logical concern becomes a named helper that the router calls, making intent explicit and preventing accidental event propagation.

---

## Option 4 — Extract Script Editor Modal → `static/script_editor.js`

**Effort:** Medium | **Risk:** Low | **Lines saved:** ~150 from `app.js`

### Problem
The Script Editor Modal controller (~lines 1262–1436) is a self-contained sub-system with its own state, open/close lifecycle, stats calculation, font-size toggling, and event wiring. It follows the same pattern already established by `cues.js`, `viewport.js`, and `export.js`.

### What moves out
- `updateModalStats()`
- `showModalScriptToast()`
- `openScriptModal()` / `closeScriptModal()` / `applyModalScript()`
- `setModalFontSize(size)`
- All `btnModal*` event listeners

### API surface back to `app.js`
```js
const scriptEditor = new TeleprompterScriptEditor({
  transcriptInput,
  modalEl: modalScriptEditor,
  onApply: (text) => { saveTranscriptIfEnabled(); parseAndRenderTranscript(); updateStartButton(); },
  formatFn: formatScriptForPrompter,
  persistFn: saveTranscriptIfEnabled,
});
```

---

## Option 5 — Extract Server Control Modal → `static/server_control.js` *(Completed)*

**Effort:** Medium | **Risk:** Low | **Lines saved:** ~100 from `app.js`

### Implementation Summary
- Extracted into [`static/server_control.js`](file:///Users/philkershaw/Documents/work/Tools/teleprompter/static/server_control.js) with UMD pattern (`TeleprompterServerControl`).
- Created SVG icon `<template>` elements in [`static/index.html`](file:///Users/philkershaw/Documents/work/Tools/teleprompter/static/index.html) (`#tmpl-icon-restart`, `#tmpl-icon-shutdown`, `#tmpl-icon-spinner`, `#tmpl-icon-check`) with built-in fallbacks.
- Encapsulated confirmation flows, in-progress spinner state, process termination display, dismissal prevention, and reconnect lifecycle synchronization.
- Automated unit tests added in [`test_server_control.js`](file:///Users/philkershaw/Documents/work/Tools/teleprompter/test_server_control.js) (7/7 passing).

---

## Option 6 — Move Audio Device Selection UI into `media.js` *(Completed)*

**Effort:** Medium–High | **Risk:** Medium | **Lines saved:** ~140 from `app.js`

### Implementation Summary
- Absorbed `VIDEO_FORMATS` and `AUDIO_FORMATS` presets directly into [`static/media.js`](file:///Users/philkershaw/Documents/work/Tools/teleprompter/static/media.js) and exported them on `TeleprompterMedia`.
- Extended `MediaSession` with `bindUI()`, `updateAudioSourceUI()`, `updateFormatUI()`, and `setControlsDisabled()`.
- Centralized audio device matching, selection badges, description updates, and recording format synchronization inside `MediaSession`.
- Removed ~140 lines of manual dropdown population, format toggling, and duplicated event handlers from [`static/app.js`](file:///Users/philkershaw/Documents/work/Tools/teleprompter/static/app.js).
- Added comprehensive unit tests in [`test_media.js`](file:///Users/philkershaw/Documents/work/Tools/teleprompter/test_media.js) (5/5 new tests passing, 28/28 total suite tests passing).

---

## Option 7 — Absorb Cue Event Wiring into `cues.js` *(Completed)*

**Effort:** Medium | **Risk:** Low | **Lines saved:** ~238 from `app.js`

### Implementation Summary
- Extended `RehearsalCues` in [`static/cues.js`](file:///Users/philkershaw/Documents/work/Tools/teleprompter/static/cues.js) with `bindUI()`, `openModal()`, `closeModal()`, `isOpen()`, `updateUI()`, and built-in status toast notifications (`showToast`).
- Centralized all Difficult Words modal interactions directly inside `RehearsalCues`: single and batch word adding, clearing, modal opening and closing, swatch selection, color input, highlight treatment radios, and rehearsal fumble actions (removing or promoting to configured difficult words with "+ Keep").
- Made UI rendering self-synchronizing: state mutations in `saveDifficultWords()`, `saveRehearsalWords()`, and `saveSyncPrompterFlag()` automatically trigger `this.updateUI()` to keep tag chips, counts, and badges refreshed.
- Replaced over 230 lines of manual element lookups and event listener delegations in [`static/app.js`](file:///Users/philkershaw/Documents/work/Tools/teleprompter/static/app.js) with a single `cues.bindUI()` call.
- Unified modal dismissal in the global keydown router with `cues.isOpen()` and `cues.closeModal()`.
- Added automated unit tests in [`test_cues.js`](file:///Users/philkershaw/Documents/work/Tools/teleprompter/test_cues.js) (5/5 new tests passing, 19/19 module tests passing, 117/117 total suite tests passing).

---

## Summary Table

| # | Option | Status | Effort | Risk | Lines Saved | New File? |
|---|--------|--------|--------|------|-------------|-----------|
| 1 | Shared `showToast()` utility | Completed | Low | Very Low | ~40 | No |
| 2 | Merge Start/Rehearse into `startSession()` | Completed | Low–Med | Low | ~70 | No |
| 3 | Unify `keydown` handlers | Completed | Low | Low | ~20 | No |
| 4 | Extract Script Editor Modal | Completed | Medium | Low | ~150 | Yes — `script_editor.js` |
| 5 | Extract Server Control Modal | Completed | Medium | Low | ~100 | Yes — `server_control.js` |
| 6 | Move Audio Device UI into `media.js` | Completed | Med–High | Medium | ~140 | No (absorbed) |
| 7 | Absorb Cue wiring into `cues.js` | Completed | Medium | Low | ~238 | No (absorbed) |

**Result:** `static/app.js` has been reduced from **1,987 lines** to **1,366 lines** (**621 lines saved**, a 31% reduction), with clear single-responsibility subsystems throughout.

> [!NOTE]
> All 7 options in the optimization plan are now completed, fully tested, and passing all automated test suites.
