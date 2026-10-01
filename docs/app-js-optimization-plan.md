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

## Option 5 — Extract Server Control Modal → `static/server_control.js`

**Effort:** Medium | **Risk:** Low | **Lines saved:** ~100 from `app.js`

### Problem
The server control sub-system (~lines 1865–1952) manages two confirmation flows (restart / shutdown), two in-progress state views, and hooks into WebSocket lifecycle flags (`isRestartingServer`, `serverShutDown`). It also contains large inline SVG strings and raw innerHTML injection.

### What moves out
- `showServerRestartConfirm()` / `showServerShutdownConfirm()`
- `showServerRestartingState()` / `showServerShutdownState()`
- `executeServerRestart()` / `executeServerShutdown()`
- `closeServerActionModal()`
- All SVG markup (moved to `<template>` tags in HTML or constants in the new module)

### Bonus win
Moving the SVG out of JS strings and into HTML `<template>` tags would eliminate the inline SVG blobs entirely — improving readability and making the icons editable without touching JS.

---

## Option 6 — Move Audio Device Selection UI into `media.js`

**Effort:** Medium–High | **Risk:** Medium | **Lines saved:** ~100 from `app.js`

### Problem
`updateAudioSourceUI()` and the `optAudioSource` change handler (~lines 547–620) are tightly coupled to `MediaSession` but live in `app.js`. Similarly the record mode / format UI (~lines 623–701) is essentially a configuration view for `MediaSession.startRecording()`.

### What moves out
- `updateAudioSourceUI(deviceId, devicesList)`
- `optAudioSource` change handler
- `btnRefreshAudioDevices` handler
- `VIDEO_FORMATS` / `AUDIO_FORMATS` constants
- `updateFormatUI()`
- `optRecordMode` / `optRecordFormat` change handlers

### Consideration
This has slightly more risk than the modal extractions because `activeAudioSource` is referenced in the session start/stop path. The interface would need a clean getter/setter or event callback to keep `app.js` in sync.

---

## Option 7 — Absorb Cue Event Wiring into `cues.js`

**Effort:** Medium | **Risk:** Low | **Lines saved:** ~80 from `app.js`

### Problem
All the event listeners for the Difficult Words modal (~lines 381–545) are wired in `app.js` but deal exclusively with the `cues` object (a `RehearsalCues` instance from `cues.js`). The `openDifficultWordsModal()` / `closeDifficultWordsModal()` lifecycle, and all the add/remove/batch/filter/color/style handlers are pure cue management — `app.js` is just the middleman.

### What moves out
- `openDifficultWordsModal()` / `closeDifficultWordsModal()`
- All `btnAddDifficultWord`, `btnClearDifficultWords`, `btnClearRehearsalWords`, `colorSwatchesContainer`, `pickerDifficultColor`, `difficultStyleRadios`, `rehearsalFilterGroup`, `rehearsalTagsList`, `difficultTagsList` event wiring
- `updateCuesUI()` (already just calls `cues` methods)

### API surface back to `app.js`
`app.js` retains only a `cues.mount(containerEl)` call and a callback for when cue data changes that triggers `parseAndRenderTranscript()`.

---

## Summary Table

| # | Option | Effort | Risk | Lines Saved | New File? |
|---|--------|--------|------|-------------|-----------|
| 1 | Shared `showToast()` utility | Low | Very Low | ~40 | No |
| 2 | Merge Start/Rehearse into `startSession()` | Low–Med | Low | ~70 | No |
| 3 | Unify `keydown` handlers | Low | Low | ~20 | No |
| 4 | Extract Script Editor Modal | Medium | Low | ~150 | Yes — `script_editor.js` |
| 5 | Extract Server Control Modal | Medium | Low | ~100 | Yes — `server_control.js` |
| 6 | Move Audio Device UI into `media.js` | Med–High | Medium | ~100 | No (absorbed) |
| 7 | Absorb Cue wiring into `cues.js` | Medium | Low | ~80 | No (absorbed) |

**If all options are implemented:** estimated reduction from ~1,987 lines to ~**1,400–1,500 lines**, with better module cohesion throughout.

> [!TIP]
> Options 1–3 are pure internal cleanup with no new files and very low risk — a good warm-up before tackling the modal extractions.

> [!NOTE]
> Each option is independently safe to implement. None require changes to the Python backend or HTML structure (except Option 5's optional SVG template bonus).
