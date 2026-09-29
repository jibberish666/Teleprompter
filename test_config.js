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
    assert.equal(def.ui.box_width_pct, 68);
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
    assert.equal(store.get('ui.box_width_pct'), 68);
  });
});
