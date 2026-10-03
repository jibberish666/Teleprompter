/**
 * Unit tests for TeleprompterScriptEditor module using Node.js built-in test runner.
 * Run with: node test_script_editor.js
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const ScriptEditorModule = require('./static/script_editor.js');

describe('TeleprompterScriptEditor - Stats Calculation', () => {
  const { calculateStats } = ScriptEditorModule;

  test('calculates word count excluding headers and returns estimated duration', () => {
    const text = '# Introduction\nWelcome to this test broadcast where we examine words and timing.';
    const stats = calculateStats(text);
    assert.equal(stats.sections, 1);
    assert.equal(stats.words, 12);
    assert.ok(stats.durationStr.includes('s'));
  });

  test('handles empty and whitespace-only text gracefully', () => {
    const stats = calculateStats('   \n  \t  ');
    assert.equal(stats.sections, 0);
    assert.equal(stats.words, 0);
    assert.equal(stats.durationStr, '~0s');
  });

  test('counts multiple markdown section headers', () => {
    const text = '# Section 1\nSome text.\n# Section 2\nMore text.\n# Section 3\nConcluding text.';
    const stats = calculateStats(text);
    assert.equal(stats.sections, 3);
    assert.equal(stats.words, 12);
  });
});

describe('TeleprompterScriptEditor - Headless Lifecycle & Sync', () => {
  const { TeleprompterScriptEditor } = ScriptEditorModule;

  function createMockElement(initialClasses = []) {
    const classes = new Set(initialClasses);
    const listeners = {};
    return {
      value: '',
      textContent: '',
      classList: {
        add: (...names) => names.forEach((n) => classes.add(n)),
        remove: (...names) => names.forEach((n) => classes.delete(n)),
        contains: (name) => classes.has(name),
      },
      addEventListener: (evt, fn) => {
        listeners[evt] = listeners[evt] || [];
        listeners[evt].push(fn);
      },
      trigger: (evt, data) => {
        (listeners[evt] || []).forEach((fn) => fn(data || {}));
      },
      focus: () => {},
      click: () => {},
    };
  }

  test('manages open/close state and syncs source input', () => {
    const modalEl = createMockElement(['hidden']);
    const modalInput = createMockElement();
    const sourceInput = createMockElement();
    const statWordsEl = createMockElement();

    sourceInput.value = 'Hello world teleprompter test';

    const editor = new TeleprompterScriptEditor({
      modalEl,
      modalInput,
      sourceInput,
      statWordsEl,
    });

    assert.equal(editor.isOpen(), false);
    editor.open();
    assert.equal(editor.isOpen(), true);
    assert.equal(modalInput.value, 'Hello world teleprompter test');

    editor.close();
    assert.equal(editor.isOpen(), false);
  });

  test('constructor synchronizes initial text between source and modal', () => {
    const sourceInput = createMockElement();
    const modalInput = createMockElement();
    sourceInput.value = 'Initial source script draft';

    new TeleprompterScriptEditor({
      sourceInput,
      modalInput,
    });

    assert.equal(modalInput.value, 'Initial source script draft');
  });

  test('close flushes desynced modal edits to source and triggers onSync', () => {
    const modalEl = createMockElement();
    const modalInput = createMockElement();
    const sourceInput = createMockElement();
    let syncedText = null;

    sourceInput.value = 'Original';

    const editor = new TeleprompterScriptEditor({
      modalEl,
      modalInput,
      sourceInput,
      onSync: (val) => {
        syncedText = val;
      },
    });

    modalInput.value = 'Edited in modal without clicking apply';
    editor.close();

    assert.equal(sourceInput.value, 'Edited in modal without clicking apply');
    assert.equal(syncedText, 'Edited in modal without clicking apply');
  });

  test('handles paste on modalInput with formatting and sync', async () => {
    const modalInput = createMockElement();
    const sourceInput = createMockElement();
    let syncedText = null;

    new TeleprompterScriptEditor({
      modalInput,
      sourceInput,
      formatFn: (txt) => txt.toUpperCase(),
      getAutoFormatEnabled: () => true,
      onSync: (val) => {
        syncedText = val;
      },
    });

    modalInput.value = 'paste this script text';
    modalInput.trigger('paste');

    // Wait for the 50ms paste timeout
    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.equal(modalInput.value, 'PASTE THIS SCRIPT TEXT');
    assert.equal(sourceInput.value, 'PASTE THIS SCRIPT TEXT');
    assert.equal(syncedText, 'PASTE THIS SCRIPT TEXT');
  });

  test('apply updates source input and triggers onApply callback', () => {
    const modalEl = createMockElement();
    const modalInput = createMockElement();
    const sourceInput = createMockElement();
    let appliedText = null;

    modalInput.value = 'New updated script content';

    const editor = new TeleprompterScriptEditor({
      modalEl,
      modalInput,
      sourceInput,
      onApply: (text) => {
        appliedText = text;
      },
    });

    editor.apply();
    assert.equal(sourceInput.value, 'New updated script content');
    assert.equal(appliedText, 'New updated script content');
  });

  test('setFontSize modifies classes appropriately', () => {
    const modalInput = createMockElement(['text-sm']);
    const btnFontSm = createMockElement();
    const btnFontMd = createMockElement();
    const btnFontLg = createMockElement();

    const editor = new TeleprompterScriptEditor({
      modalInput,
      btnFontSm,
      btnFontMd,
      btnFontLg,
    });

    editor.setFontSize('lg');
    assert.equal(modalInput.classList.contains('text-base'), true);
    assert.equal(modalInput.classList.contains('text-sm'), false);

    editor.setFontSize('sm');
    assert.equal(modalInput.classList.contains('text-xs'), true);
    assert.equal(modalInput.classList.contains('text-base'), false);
  });
});

