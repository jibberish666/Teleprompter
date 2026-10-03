---
name: teleprompter-state-persistence
description: >-
  Architecture, data flow, defensive boundaries, and debugging procedures for teleprompter script persistence,
  unified configuration store (static/config.js, config.py, teleprompter.json), and UMD/browser-global
  modular controller integration. Use whenever modifying configuration schemas, autosave, script restoration,
  or extracting UI subsystems from static/app.js.
---

# Teleprompter State Persistence & Subsystem Lifecycle Skill

This skill documents the end-to-end architecture, lifecycle contracts, data synchronization flows, and defensive patterns governing script persistence, configuration storage, and modular frontend controllers in the 100% Local AI Teleprompter.

---

## 1. System Architecture & Data Flow

State in the teleprompter flows through a multi-tiered pipeline bridging the browser UI, client-side persistence, and the Python backend:

```
 [User Types in Script Textarea / Modal Editor]
                     │
                     ▼
          [Debounced Autosave (1000ms)]
                     │
        ┌────────────┴────────────┐
        ▼                         ▼
 [Unified ConfigStore]    [Legacy LocalStorage]
 (teleprompter_config_v1) (teleprompter_saved_transcript)
        │
        ▼ (WebSocket send: config_patch)
   [server.py] (SyncHub handler)
        │
        ▼
   [config.py] (validate_and_sanitize)
        │
        ▼
 [teleprompter.json] (Atomic write via NamedTemporaryFile)
```

### On Page Load (Boot Restoration Sequence)
1. `configStore` loads and migrates `teleprompter_config_v1` from browser `localStorage`.
2. UI subsystems (`scriptEditor`, `exportSession`, `serverControl`) initialize in defensive blocks.
3. The `Boot` sequence runs:
   - Reads `script.saved_transcript` from `configStore`, falling back to `teleprompter_saved_transcript`.
   - Populates `#transcript-input.value`.
   - Calls `scriptEditor.syncFromSource()` if present.
   - Executes `parseAndRenderTranscript()` to generate word and line spans.
   - Calls `connect()` to establish the WebSocket link.
4. When WebSocket opens, the server sends `{"type": "config", "config": ...}`:
   - `configStore.reconcileServerConfig()` integrates server settings without clobbering active client edits.

---

## 2. Defensive Subsystem Boundaries

The teleprompter's startup must never be vulnerable to bugs in secondary dialogs or optional widgets:

1. **Isolation Rule**:
   - Secondary modal instantiations (`TeleprompterScriptEditor`, `TeleprompterExport`, `TeleprompterServerControl`) must always be wrapped in individual `try...catch` blocks.
   - If an optional modal fails to initialize, log a console error and set its handle to `null`.
2. **Boot Protection**:
   - The core `Boot` sequence must execute even if one or more UI widgets encountered an exception.
   - Wrap the `Boot` sequence in a top-level `try...catch` so that unexpected DOM conditions log cleanly rather than causing an unhandled white-screen freeze.

---

## 3. UMD & Browser-Global Controller Packaging

When extracting modal controllers or components from `static/app.js` into standalone files (such as `static/server_control.js` or `static/script_editor.js`):

### The Constructor Requirement
In raw browser environments without bundlers, `<script src="/static/component.js">` assigns the module export directly to the global window object (`root.TeleprompterServerControl`).
- **Antipattern**: Returning a plain object wrapper `{ TeleprompterServerControl: class ... }` causes `new TeleprompterServerControl(...)` to throw `TypeError: TeleprompterServerControl is not a constructor`.
- **Correct Pattern**: Return the constructor function directly, with helper classes and constants attached as static properties:
  ```javascript
  (function (root, factory) {
    if (typeof module === 'object' && module.exports) {
      module.exports = factory(root);
    } else {
      root.TeleprompterServerControl = factory(root);
    }
  })(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
    class TeleprompterServerControl { ... }

    TeleprompterServerControl.TeleprompterServerControl = TeleprompterServerControl;
    TeleprompterServerControl.ICONS = ICONS;
    TeleprompterServerControl.STYLES = STYLES;
    return TeleprompterServerControl;
  });
  ```

### Dual-Resolution Calling Convention
In `static/app.js`, always resolve classes safely:
```javascript
const ControllerClass = (typeof TeleprompterController !== 'undefined')
  ? (TeleprompterController.TeleprompterController || TeleprompterController)
  : null;
```

---

## 4. Rich Object Sanitization (`rehearsal_words`)

Rehearsal stumble data recorded in `static/cues.js` consists of structured objects:
```json
{ "word": "Synergy", "clean": "synergy", "reason": "stumbled" }
```

### The Serialization Trap
Naive type coercion (`String(w)` in JS or `str(w)` in Python) transforms these objects into `"[object Object]"` strings or raw python dict strings, corrupting `teleprompter.json` on disk.

### Dual-Platform Sanitization Rules
Both `static/config.js` (`validateAndSanitize`) and `config.py` (`validate_and_sanitize`) must:
1. Accept both plain strings and structured dictionaries `{ word, clean, reason }`.
2. Explicitly filter out any item whose string value or `clean` attribute matches `"[object object]"` (case-insensitive).
3. Preserve the structured representation for downstream rendering in the Difficult Words modal.

---

## 5. Verification Runbook & Automated Regression Testing

### 1. Simulated Browser-Global Testing in Node
Because Node's `require()` destructures `module.exports`, it can mask global browser packaging mismatches. Always test the module in an isolated VM context:
```javascript
const fs = require('fs');
const vm = require('vm');
const code = fs.readFileSync('./static/server_control.js', 'utf8');

const browserContext = { self: {}, console };
browserContext.globalThis = browserContext.self;
vm.createContext(browserContext);
vm.runInContext(code, browserContext);

const GlobalClass = browserContext.self.TeleprompterServerControl;
assert.equal(typeof GlobalClass, 'function');
const instance = new GlobalClass();
assert.ok(instance instanceof GlobalClass);
```

### 2. Browser Verification Procedure
- Open `http://127.0.0.1:8000/`.
- Open DevTools Console: verify **zero errors** during initialization.
- Type into `#transcript-input`, wait 1.2s, and reload the browser page.
- Assert that `#transcript-input` immediately displays the saved script and `#prompter-words` renders active word spans.
