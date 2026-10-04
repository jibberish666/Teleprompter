/**
 * Unit tests for TeleprompterConfig module using Node.js built-in test runner.
 * Run with: node test_config.js
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Config = require('./static/config.js');

function createMockStorage(initialData = {}) {
  const store = new Map(Object.entries(initialData));
  return {
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
    clear() { store.clear(); },
    get size() { return store.size; },
    dump() { return Object.fromEntries(store.entries()); }
  };
}

describe('TeleprompterConfig - Schema Validation & Defaults', () => {
  test('returns default configuration with proper domains', () => {
    const def = Config.getDefaultConfig();
    assert.equal(def.version, 1);
    assert.equal(def.ui.box_width_pct, 55);
    assert.equal(def.ui.line_spacing, 'comfortable');
    assert.equal(def.ui.auto_format_on_paste, true);
    assert.equal(def.engine.profile, 'fast');
    assert.equal(def.recording.mode, 'video');
  });

  test('clamps out-of-bound numerical settings', () => {
    const sanitized = Config.validateAndSanitize({
      ui: { box_width_pct: 15 } // minimum is 30
    });
    assert.equal(sanitized.ui.box_width_pct, 30);

    const clampedMax = Config.validateAndSanitize({
      ui: { box_width_pct: 180 } // maximum is 100
    });
    assert.equal(clampedMax.ui.box_width_pct, 100);

    const clampedFont = Config.validateAndSanitize({
      ui: { font_size: 10 }
    });
    assert.equal(clampedFont.ui.font_size, 16);

    const clampedOpacity = Config.validateAndSanitize({
      ui: { box_opacity: 0.05 }
    });
    assert.equal(clampedOpacity.ui.box_opacity, 0.2);

    const clampedLines = Config.validateAndSanitize({
      ui: { visible_lines: 50 }
    });
    assert.equal(clampedLines.ui.visible_lines, 12);

    const clampedSens = Config.validateAndSanitize({
      ui: { mic_sensitivity: 0 }
    });
    assert.equal(clampedSens.ui.mic_sensitivity, 5);
  });

  test('validates font family selection against AVAILABLE_FONTS', () => {
    assert.equal(Config.AVAILABLE_FONTS.length, 6);
    assert.ok(Config.VALID_FONTS.has('open-sans'));
    assert.ok(Config.VALID_FONTS.has('inter'));
    assert.ok(Config.VALID_FONTS.has('source-sans-3'));
    assert.ok(Config.VALID_FONTS.has('atkinson'));
    assert.ok(Config.VALID_FONTS.has('lexend'));
    assert.ok(Config.VALID_FONTS.has('noto-sans'));
    assert.ok(!Config.VALID_FONTS.has('montserrat'));
    assert.ok(!Config.VALID_FONTS.has('roboto-mono'));

    const valid = Config.validateAndSanitize({
      ui: { font_family: 'lexend' }
    });
    assert.equal(valid.ui.font_family, 'lexend');

    const invalid = Config.validateAndSanitize({
      ui: { font_family: 'wingdings' }
    });
    assert.equal(invalid.ui.font_family, 'open-sans');

    const legacy = Config.validateAndSanitize({
      ui: { font_family: 'montserrat' }
    });
    assert.equal(legacy.ui.font_family, 'open-sans');
  });

  test('validates and snaps font weight against VALID_FONT_WEIGHTS and migrates 600 to 500', () => {
    assert.ok(Config.VALID_FONT_WEIGHTS.has(400));
    assert.ok(Config.VALID_FONT_WEIGHTS.has(500));
    assert.ok(!Config.VALID_FONT_WEIGHTS.has(600));
    assert.ok(Config.VALID_FONT_WEIGHTS.has(700));

    // Semi-Bold (600) gracefully migrates to Medium (500)
    const migrated = Config.validateAndSanitize({ ui: { font_weight: 600 } });
    assert.equal(migrated.ui.font_weight, 500);

    const valid = Config.validateAndSanitize({ ui: { font_weight: 700 } });
    assert.equal(valid.ui.font_weight, 700);

    const snapped = Config.validateAndSanitize({ ui: { font_weight: 420 } });
    assert.equal(snapped.ui.font_weight, 400);

    const snappedHigh = Config.validateAndSanitize({ ui: { font_weight: 900 } });
    assert.equal(snappedHigh.ui.font_weight, 700);
  });

  test('validates and sanitizes line_spacing presets', () => {
    assert.ok(Config.VALID_LINE_SPACINGS.has('tight'));
    assert.ok(Config.VALID_LINE_SPACINGS.has('comfortable'));
    assert.ok(Config.VALID_LINE_SPACINGS.has('relaxed'));

    const tight = Config.validateAndSanitize({ ui: { line_spacing: 'tight' } });
    assert.equal(tight.ui.line_spacing, 'tight');

    const relaxed = Config.validateAndSanitize({ ui: { line_spacing: 'relaxed' } });
    assert.equal(relaxed.ui.line_spacing, 'relaxed');

    const invalid = Config.validateAndSanitize({ ui: { line_spacing: 'enormous' } });
    assert.equal(invalid.ui.line_spacing, 'comfortable');
  });

  test('enforces enum constraints on profiles and recording options', () => {
    const sanitized = Config.validateAndSanitize({
      engine: { profile: 'super_turbo' },
      recording: { mode: 'telepathy' }
    });
    assert.equal(sanitized.engine.profile, 'fast');
    assert.equal(sanitized.recording.mode, 'video');
  });
});

describe('TeleprompterConfig - Legacy LocalStorage Migration', () => {
  test('migrates fragmented legacy keys into consolidated schema', () => {
    const mockStorage = createMockStorage({
      teleprompter_box_width_pct: '85',
      teleprompter_auto_format_paste: 'false',
      teleprompter_difficult_color: '#3b82f6',
      teleprompter_difficult_style: 'glow',
      teleprompter_audio_device: '2',
      teleprompter_audio_device_name: 'Studio Mic',
      teleprompter_engine_speed: 'accurate',
      teleprompter_record_mode: 'audio',
      teleprompter_saved_transcript: 'Test script body'
    });

    const migrated = Config.migrateLegacyStorage(mockStorage);
    assert.equal(migrated.ui.box_width_pct, 85);
    assert.equal(migrated.ui.auto_format_on_paste, false);
    assert.equal(migrated.ui.difficult_color, '#3b82f6');
    assert.equal(migrated.ui.difficult_style, 'glow');
    assert.equal(migrated.audio.device_id, '2');
    assert.equal(migrated.audio.device_name, 'Studio Mic');
    assert.equal(migrated.engine.profile, 'accurate');
    assert.equal(migrated.recording.mode, 'audio');
    assert.equal(migrated.script.saved_transcript, 'Test script body');

    // Consolidated key was saved to storage
    assert.ok(mockStorage.getItem(Config.STORAGE_KEY));
  });

  test('uses existing unified config if already present in storage', () => {
    const existing = Config.getDefaultConfig();
    existing.ui.box_width_pct = 72;

    const mockStorage = createMockStorage({
      [Config.STORAGE_KEY]: JSON.stringify(existing)
    });

    const loaded = Config.migrateLegacyStorage(mockStorage);
    assert.equal(loaded.ui.box_width_pct, 72);
  });

  test('migrates legacy teleprompter_saved_transcript when unified storage has empty saved_transcript', () => {
    const existing = Config.getDefaultConfig();
    const mockStorage = createMockStorage({
      [Config.STORAGE_KEY]: JSON.stringify(existing),
      teleprompter_saved_transcript: 'Fallback script from legacy key'
    });

    const loaded = Config.migrateLegacyStorage(mockStorage);
    assert.equal(loaded.script.saved_transcript, 'Fallback script from legacy key');
  });
});

describe('TeleprompterConfig - Store State, Patches, & Subscriptions', () => {
  test('updates value, persists to storage, and invokes patch callback', () => {
    const patches = [];
    const mockStorage = createMockStorage();
    const store = Config.createConfigStore({
      storage: mockStorage,
      onPatch: (domain, patch) => patches.push({ domain, patch })
    });

    store.set('ui.box_width_pct', 80);
    assert.equal(store.get('ui.box_width_pct'), 80);

    // Verify storage received updated json
    const stored = JSON.parse(mockStorage.getItem(Config.STORAGE_KEY));
    assert.equal(stored.ui.box_width_pct, 80);

    // Verify patch callback fired
    assert.equal(patches.length, 1);
    assert.equal(patches[0].domain, 'ui');
    assert.deepEqual(patches[0].patch, { box_width_pct: 80 });
  });

  test('notifies subscribers on setting mutation', () => {
    const mockStorage = createMockStorage();
    const store = Config.createConfigStore({ storage: mockStorage });
    const notifications = [];

    const unsubscribe = store.subscribe((evt) => {
      notifications.push(evt);
    });

    store.set('recording.video_format', 'webm');
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].path, 'recording.video_format');
    assert.equal(notifications[0].value, 'webm');

    unsubscribe();
    store.set('recording.video_format', 'mp4');
    assert.equal(notifications.length, 1); // No new notification after unsubscribe
  });

  test('reconciles server config into client state seamlessly', () => {
    const mockStorage = createMockStorage();
    const store = Config.createConfigStore({ storage: mockStorage });

    store.reconcileServerConfig({
      audio: {
        device_id: 'usb-mic-1',
        device_name: 'Podcaster USB'
      },
      engine: {
        profile: 'balanced'
      }
    });

    assert.equal(store.get('audio.device_id'), 'usb-mic-1');
    assert.equal(store.get('audio.device_name'), 'Podcaster USB');
    assert.equal(store.get('engine.profile'), 'balanced');
    // UI defaults preserved
    assert.equal(store.get('ui.box_width_pct'), 55);
  });

  test('does not clobber non-empty client script with empty server script', () => {
    const store = Config.createConfigStore({ storage: createMockStorage() });
    store.set('script.saved_transcript', 'Client drafting script');
    assert.equal(store.get('script.saved_transcript'), 'Client drafting script');

    store.reconcileServerConfig({
      script: {
        saved_transcript: '',
        rehearsal_words: []
      }
    });

    assert.equal(store.get('script.saved_transcript'), 'Client drafting script');
  });

  test('prioritizes active non-empty client script over stale server script', () => {
    const store = Config.createConfigStore({ storage: createMockStorage() });
    store.set('script.saved_transcript', 'Active client draft');

    store.reconcileServerConfig({
      script: {
        saved_transcript: 'Stale server script from disk',
        rehearsal_words: []
      }
    });

    assert.equal(store.get('script.saved_transcript'), 'Active client draft');
  });

  test('adopts non-empty server script when client script is empty', () => {
    const store = Config.createConfigStore({ storage: createMockStorage() });
    assert.equal(store.get('script.saved_transcript'), '');

    store.reconcileServerConfig({
      script: {
        saved_transcript: 'Persisted server script',
        rehearsal_words: []
      }
    });
    assert.equal(store.get('script.saved_transcript'), 'Persisted server script');
  });

  test('sanitizes rehearsal_words objects and filters out corrupted [object object] entries', () => {
    const raw = {
      script: {
        rehearsal_words: [
          { word: 'Synergy', clean: 'synergy', reason: 'stumbled' },
          'Paradigm',
          '[object Object]',
          '[object object]',
          { word: '[object Object]', clean: '[object object]', reason: 'skipped' },
        ],
        protected_terms: ['AGY', '[object Object]', 'WebAudio']
      }
    };
    const sanitized = Config.validateAndSanitize(raw);
    assert.deepEqual(sanitized.script.rehearsal_words, [
      { word: 'Synergy', clean: 'synergy', reason: 'stumbled' },
      'paradigm'
    ]);
    assert.deepEqual(sanitized.script.protected_terms, ['AGY', 'WebAudio']);
  });
});

