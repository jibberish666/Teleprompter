/**
 * TeleprompterConfig - Client-side configuration manager & schema persistence engine.
 *
 * Encapsulates:
 * 1. Canonical configuration schema with default fallbacks.
 * 2. Transparent migration from legacy flat localStorage keys (`teleprompter_*`).
 * 3. Observable state store with subscription hooks for UI reactivity.
 * 4. Optimistic local updates and bi-directional WebSocket delta patch synchronization.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    // Node.js / CommonJS
    module.exports = factory();
  } else {
    // Browser global
    root.TeleprompterConfig = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STORAGE_KEY = 'teleprompter_config';

  const DEFAULT_CONFIG = {
    version: 1,
    server: {
      host: '127.0.0.1',
      port: 8000
    },
    engine: {
      profile: 'fast',
      model: 'base.en',
      compute_type: 'int8',
      device: 'cpu',
      align_window: 5,
      align_tolerance: 5
    },
    audio: {
      source_type: 'hardware', // 'hardware' | 'browser'
      device_id: null,
      device_name: ''
    },
    recording: {
      mode: 'video',          // 'video' | 'audio'
      video_format: 'mp4',    // 'mp4' | 'webm'
      audio_format: 'wav'     // 'wav' | 'mp3' — WAV default avoids MP3 encoding latency during multi-section splitting
    },
    ui: {
      box_width_pct: 68,
      font_size: 36,
      font_weight: 500,
      box_opacity: 0.9,
      visible_lines: 7,
      mic_sensitivity: 15,
      mirror_display: false,
      font_family: 'open-sans',
      auto_format_on_paste: true,
      persist_transcript: true,
      sync_fumble_filter: false,
      difficult_color: '#f59e0b',
      difficult_style: 'pill',
      difficult_words: [],
      retake_hotkey: 'r'
    },
    script: {
      saved_transcript: '',
      rehearsal_words: [],
      protected_terms: []   // Per-production protected noun phrases; overrides formatter defaults when non-empty
    }
  };

  const AVAILABLE_FONTS = [
    {
      id: 'open-sans',
      name: 'Open Sans',
      tagline: 'Natural Reading',
      family: "'Open Sans', Arial, sans-serif"
    },
    {
      id: 'inter',
      name: 'Inter',
      tagline: 'Clean & Modern',
      family: "'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    },
    {
      id: 'source-sans-3',
      name: 'Source Sans 3',
      tagline: 'Comfortable & Neutral',
      family: "'Source Sans 3', 'Source Sans Pro', Arial, sans-serif"
    },
    {
      id: 'atkinson',
      name: 'Atkinson Hyperlegible',
      tagline: 'High Legibility',
      family: "'Atkinson Hyperlegible', Arial, sans-serif"
    },
    {
      id: 'lexend',
      name: 'Lexend',
      tagline: 'Reading Fluency',
      family: "'Lexend', Arial, sans-serif"
    },
    {
      id: 'noto-sans',
      name: 'Noto Sans',
      tagline: 'International',
      family: "'Noto Sans', Arial, sans-serif"
    }
  ];

  const VALID_FONTS = new Set(AVAILABLE_FONTS.map(f => f.id));
  const VALID_FONT_WEIGHTS = new Set([400, 500, 600, 700]);
  const VALID_PROFILES = new Set(['fast', 'balanced', 'accurate']);
  const VALID_RECORD_MODES = new Set(['video', 'audio']);
  const VALID_VIDEO_FORMATS = new Set(['mp4', 'webm']);
  const VALID_AUDIO_FORMATS = new Set(['mp3', 'wav']);
  const VALID_DIFFICULT_STYLES = new Set(['pill', 'glow', 'underline']);

  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function getDefaultConfig() {
    return deepClone(DEFAULT_CONFIG);
  }

  function validateAndSanitize(raw) {
    if (!raw || typeof raw !== 'object') {
      return getDefaultConfig();
    }

    const result = getDefaultConfig();

    // -- Server --
    if (raw.server && typeof raw.server === 'object') {
      if (typeof raw.server.host === 'string' && raw.server.host.trim()) {
        result.server.host = raw.server.host.trim();
      }
      const p = parseInt(raw.server.port, 10);
      if (!isNaN(p) && p >= 1 && p <= 65535) {
        result.server.port = p;
      }
    }

    // -- Engine --
    if (raw.engine && typeof raw.engine === 'object') {
      if (VALID_PROFILES.has(raw.engine.profile)) {
        result.engine.profile = raw.engine.profile;
      }
      if (typeof raw.engine.model === 'string' && raw.engine.model.trim()) {
        result.engine.model = raw.engine.model.trim();
      }
      if (typeof raw.engine.compute_type === 'string' && raw.engine.compute_type.trim()) {
        result.engine.compute_type = raw.engine.compute_type.trim();
      }
      if (typeof raw.engine.device === 'string' && raw.engine.device.trim()) {
        result.engine.device = raw.engine.device.trim();
      }
      const aw = parseInt(raw.engine.align_window, 10);
      if (!isNaN(aw)) result.engine.align_window = Math.max(1, Math.min(50, aw));
      const at = parseInt(raw.engine.align_tolerance, 10);
      if (!isNaN(at)) result.engine.align_tolerance = Math.max(1, Math.min(50, at));
    }

    // -- Audio --
    if (raw.audio && typeof raw.audio === 'object') {
      if (raw.audio.source_type === 'browser' || raw.audio.source_type === 'hardware') {
        result.audio.source_type = raw.audio.source_type;
      }
      if (raw.audio.device_id !== undefined && raw.audio.device_id !== null) {
        const didStr = String(raw.audio.device_id).trim();
        result.audio.device_id = didStr || null;
      }
      if (typeof raw.audio.device_name === 'string') {
        result.audio.device_name = raw.audio.device_name.trim();
      }
    }

    // -- Recording --
    if (raw.recording && typeof raw.recording === 'object') {
      if (VALID_RECORD_MODES.has(raw.recording.mode)) {
        result.recording.mode = raw.recording.mode;
      }
      if (VALID_VIDEO_FORMATS.has(raw.recording.video_format)) {
        result.recording.video_format = raw.recording.video_format;
      }
      if (VALID_AUDIO_FORMATS.has(raw.recording.audio_format)) {
        result.recording.audio_format = raw.recording.audio_format;
      }
    }

    // -- UI --
    if (raw.ui && typeof raw.ui === 'object') {
      const bw = parseInt(raw.ui.box_width_pct, 10);
      if (!isNaN(bw)) {
        result.ui.box_width_pct = Math.max(30, Math.min(100, bw));
      }
      const fs = parseInt(raw.ui.font_size, 10);
      if (!isNaN(fs)) {
        result.ui.font_size = Math.max(16, Math.min(36, fs));
      }
      const fw = parseInt(raw.ui.font_weight, 10);
      if (!isNaN(fw)) {
        if (VALID_FONT_WEIGHTS.has(fw)) {
          result.ui.font_weight = fw;
        } else {
          let closest = 500;
          let minDiff = Infinity;
          for (const w of VALID_FONT_WEIGHTS) {
            const diff = Math.abs(w - fw);
            if (diff < minDiff) {
              minDiff = diff;
              closest = w;
            }
          }
          result.ui.font_weight = closest;
        }
      }
      const bo = parseFloat(raw.ui.box_opacity);
      if (!isNaN(bo)) {
        result.ui.box_opacity = Math.round(Math.max(0.2, Math.min(1.0, bo)) * 100) / 100;
      }
      const vl = parseInt(raw.ui.visible_lines, 10);
      if (!isNaN(vl)) {
        result.ui.visible_lines = Math.max(2, Math.min(12, vl));
      }
      const ms = parseInt(raw.ui.mic_sensitivity, 10);
      if (!isNaN(ms)) {
        result.ui.mic_sensitivity = Math.max(5, Math.min(30, ms));
      }
      if (typeof raw.ui.mirror_display === 'boolean') {
        result.ui.mirror_display = raw.ui.mirror_display;
      }
      if (typeof raw.ui.font_family === 'string') {
        const cleanedFont = raw.ui.font_family.trim().toLowerCase();
        if (VALID_FONTS.has(cleanedFont)) {
          result.ui.font_family = cleanedFont;
        } else {
          // Graceful fallback for removed fonts (montserrat, roboto-mono) or unknown fonts
          result.ui.font_family = 'open-sans';
        }
      }
      if (typeof raw.ui.auto_format_on_paste === 'boolean') {
        result.ui.auto_format_on_paste = raw.ui.auto_format_on_paste;
      }
      if (typeof raw.ui.persist_transcript === 'boolean') {
        result.ui.persist_transcript = raw.ui.persist_transcript;
      }
      if (typeof raw.ui.sync_fumble_filter === 'boolean') {
        result.ui.sync_fumble_filter = raw.ui.sync_fumble_filter;
      }
      if (typeof raw.ui.difficult_color === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(raw.ui.difficult_color)) {
        result.ui.difficult_color = raw.ui.difficult_color;
      }
      if (VALID_DIFFICULT_STYLES.has(raw.ui.difficult_style)) {
        result.ui.difficult_style = raw.ui.difficult_style;
      }
      if (Array.isArray(raw.ui.difficult_words)) {
        result.ui.difficult_words = raw.ui.difficult_words
          .map(w => String(w).trim().toLowerCase())
          .filter(Boolean);
      }
      if (typeof raw.ui.retake_hotkey === 'string' && raw.ui.retake_hotkey.trim()) {
        result.ui.retake_hotkey = raw.ui.retake_hotkey.trim().toLowerCase().slice(0, 10);
      }
    }

    // -- Script --
    if (raw.script && typeof raw.script === 'object') {
      if (typeof raw.script.saved_transcript === 'string') {
        result.script.saved_transcript = raw.script.saved_transcript;
      }
      if (Array.isArray(raw.script.rehearsal_words)) {
        result.script.rehearsal_words = raw.script.rehearsal_words
          .map(w => {
            if (w && typeof w === 'object') {
              const word = String(w.word || w.clean || '').trim();
              const clean = String(w.clean || word).trim().toLowerCase();
              const reason = String(w.reason || 'stumbled').trim();
              if (!word || clean === '[object object]' || word.toLowerCase() === '[object object]') return null;
              return { word, clean, reason };
            }
            const s = String(w).trim();
            if (!s || s.toLowerCase() === '[object object]') return null;
            return s.toLowerCase();
          })
          .filter(Boolean);
      }
      if (Array.isArray(raw.script.protected_terms)) {
        result.script.protected_terms = raw.script.protected_terms
          .map(t => String(t).trim())
          .filter(t => t && t.toLowerCase() !== '[object object]');
      }
    }

    return result;
  }

  /**
   * Transparently migrates any legacy individual localStorage keys into the unified configuration object.
   */
  function migrateLegacyStorage(storage) {
    if (!storage) return getDefaultConfig();

    try {
      const existing = storage.getItem(STORAGE_KEY);
      if (existing) {
        const parsed = JSON.parse(existing);
        const validated = validateAndSanitize(parsed);
        // Fallback: If unified storage has empty saved_transcript, but legacy key has one, migrate it
        if (!validated.script || !validated.script.saved_transcript || !validated.script.saved_transcript.trim()) {
          const legacyScript = storage.getItem('teleprompter_saved_transcript');
          if (legacyScript && legacyScript.trim()) {
            validated.script = validated.script || {};
            validated.script.saved_transcript = legacyScript;
            try {
              storage.setItem(STORAGE_KEY, JSON.stringify(validated));
            } catch (_) {}
          }
        }
        return validated;
      }
    } catch (_) {
      // Malformed json in storage, fallback to migration or defaults
    }

    const migrated = getDefaultConfig();
    let hasLegacy = false;

    try {
      // UI domain migrations
      const bw = storage.getItem('teleprompter_box_width_pct');
      if (bw !== null) {
        migrated.ui.box_width_pct = parseInt(bw, 10) || 68;
        hasLegacy = true;
      }
      const af = storage.getItem('teleprompter_auto_format_paste');
      if (af !== null) {
        migrated.ui.auto_format_on_paste = af !== 'false';
        hasLegacy = true;
      }
      const pt = storage.getItem('teleprompter_persist_transcript');
      if (pt !== null) {
        migrated.ui.persist_transcript = pt !== 'false';
        hasLegacy = true;
      }
      const sf = storage.getItem('teleprompter_sync_fumble_filter');
      if (sf !== null) {
        migrated.ui.sync_fumble_filter = sf === 'true';
        hasLegacy = true;
      }
      const dc = storage.getItem('teleprompter_difficult_color');
      if (dc) {
        migrated.ui.difficult_color = dc;
        hasLegacy = true;
      }
      const ds = storage.getItem('teleprompter_difficult_style');
      if (ds) {
        migrated.ui.difficult_style = ds;
        hasLegacy = true;
      }
      const dw = storage.getItem('teleprompter_difficult_words');
      if (dw) {
        try {
          migrated.ui.difficult_words = JSON.parse(dw);
          hasLegacy = true;
        } catch (_) {}
      }

      // Script domain migrations
      const st = storage.getItem('teleprompter_saved_transcript');
      if (st) {
        migrated.script.saved_transcript = st;
        hasLegacy = true;
      }
      const rw = storage.getItem('teleprompter_rehearsal_words');
      if (rw) {
        try {
          migrated.script.rehearsal_words = JSON.parse(rw);
          hasLegacy = true;
        } catch (_) {}
      }

      // Audio domain migrations
      const dev = storage.getItem('teleprompter_audio_device');
      if (dev !== null) {
        migrated.audio.source_type = dev === 'browser' ? 'browser' : 'hardware';
        migrated.audio.device_id = dev === 'browser' ? null : dev;
        hasLegacy = true;
      }
      const devName = storage.getItem('teleprompter_audio_device_name');
      if (devName) {
        migrated.audio.device_name = devName;
        hasLegacy = true;
      }

      // Engine domain migrations
      const eng = storage.getItem('teleprompter_engine_speed');
      if (eng && VALID_PROFILES.has(eng)) {
        migrated.engine.profile = eng;
        hasLegacy = true;
      }

      // Recording domain migrations
      const rm = storage.getItem('teleprompter_record_mode');
      if (rm && VALID_RECORD_MODES.has(rm)) {
        migrated.recording.mode = rm;
        hasLegacy = true;
      }
      const vf = storage.getItem('teleprompter_video_format');
      if (vf && VALID_VIDEO_FORMATS.has(vf)) {
        migrated.recording.video_format = vf;
        hasLegacy = true;
      }
      const aFormat = storage.getItem('teleprompter_audio_format');
      if (aFormat && VALID_AUDIO_FORMATS.has(aFormat)) {
        migrated.recording.audio_format = aFormat;
        hasLegacy = true;
      }

      const sanitized = validateAndSanitize(migrated);
      if (hasLegacy) {
        storage.setItem(STORAGE_KEY, JSON.stringify(sanitized));
      }
      return sanitized;
    } catch (_) {
      return getDefaultConfig();
    }
  }

  /**
   * Factory creating a ConfigStore instance.
   */
  function createConfigStore(options = {}) {
    const storage = options.storage || (typeof window !== 'undefined' ? window.localStorage : null);
    const onPatch = typeof options.onPatch === 'function' ? options.onPatch : null;

    let state = options.initialConfig
      ? validateAndSanitize(options.initialConfig)
      : migrateLegacyStorage(storage);

    const subscribers = new Set();

    function persist() {
      if (storage) {
        try {
          storage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch (_) {}
      }
    }

    function notify(path, value, domain) {
      for (const sub of subscribers) {
        try {
          sub({ path, value, domain, state: deepClone(state) });
        } catch (e) {
          console.error('[TeleprompterConfig] Subscriber error:', e);
        }
      }
    }

    return {
      get(path) {
        if (!path) return deepClone(state);
        const parts = path.split('.');
        let curr = state;
        for (const p of parts) {
          if (curr === null || curr === undefined || typeof curr !== 'object') {
            return undefined;
          }
          curr = curr[p];
        }
        return typeof curr === 'object' && curr !== null ? deepClone(curr) : curr;
      },

      set(path, value, { sync = true } = {}) {
        if (!path || typeof path !== 'string') return;
        const parts = path.split('.');
        const domain = parts[0];

        let curr = state;
        for (let i = 0; i < parts.length - 1; i++) {
          const p = parts[i];
          if (!curr[p] || typeof curr[p] !== 'object') {
            curr[p] = {};
          }
          curr = curr[p];
        }

        const lastKey = parts[parts.length - 1];
        curr[lastKey] = value;

        // Re-sanitize to enforce types and bounds
        state = validateAndSanitize(state);
        persist();
        notify(path, this.get(path), domain);

        if (sync && onPatch) {
          const patchData = {};
          patchData[lastKey] = this.get(path);
          onPatch(domain, patchData);
        }
      },

      update(domain, patchData, { sync = true } = {}) {
        if (!domain || !state[domain] || typeof patchData !== 'object' || patchData === null) return;

        Object.assign(state[domain], patchData);
        state = validateAndSanitize(state);
        persist();
        notify(domain, this.get(domain), domain);

        if (sync && onPatch) {
          onPatch(domain, patchData);
        }
      },

      reconcileServerConfig(serverConfig) {
        if (!serverConfig || typeof serverConfig !== 'object') return;

        // Deep merge server config into client state
        const merged = deepClone(state);
        for (const domain of Object.keys(DEFAULT_CONFIG)) {
          if (domain === 'version') continue;
          if (serverConfig[domain] && typeof serverConfig[domain] === 'object') {
            if (domain === 'script') {
              const clientScript = (merged.script && typeof merged.script.saved_transcript === 'string')
                ? merged.script.saved_transcript
                : '';
              const serverScript = (serverConfig.script && typeof serverConfig.script.saved_transcript === 'string')
                ? serverConfig.script.saved_transcript
                : '';

              merged[domain] = Object.assign({}, merged[domain], serverConfig[domain]);
              // Client's active local draft takes precedence over server on connect;
              // If client has no draft, adopt the server's persisted transcript.
              if (clientScript && clientScript.trim()) {
                merged.script.saved_transcript = clientScript;
              } else if (serverScript && serverScript.trim()) {
                merged.script.saved_transcript = serverScript;
              }
            } else {
              merged[domain] = Object.assign({}, merged[domain], serverConfig[domain]);
            }
          }
        }

        state = validateAndSanitize(merged);
        persist();
        notify('*', state, '*');
      },

      subscribe(callback) {
        if (typeof callback === 'function') {
          subscribers.add(callback);
          return () => subscribers.delete(callback);
        }
        return () => {};
      },

      toObject() {
        return deepClone(state);
      }
    };
  }

  return {
    STORAGE_KEY,
    DEFAULT_CONFIG,
    AVAILABLE_FONTS,
    VALID_FONTS,
    VALID_FONT_WEIGHTS,
    getDefaultConfig,
    validateAndSanitize,
    migrateLegacyStorage,
    createConfigStore
  };
});
