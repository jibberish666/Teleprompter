/**
 * Unit tests for TeleprompterExport module using Node.js built-in test runner.
 * Run with: node test_export.js
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const ExportModule = require('./static/export.js');

describe('TeleprompterExport - Duration Formatting', () => {
  test('formats seconds into MM:SS correctly', () => {
    assert.equal(ExportModule.formatDuration(0), '0:00');
    assert.equal(ExportModule.formatDuration(9), '0:09');
    assert.equal(ExportModule.formatDuration(65), '1:05');
    assert.equal(ExportModule.formatDuration(120), '2:00');
    assert.equal(ExportModule.formatDuration(3665), '61:05');
  });

  test('handles invalid or non-numeric inputs gracefully', () => {
    assert.equal(ExportModule.formatDuration(null), '0:00');
    assert.equal(ExportModule.formatDuration(undefined), '0:00');
    assert.equal(ExportModule.formatDuration(-15), '0:00');
    assert.equal(ExportModule.formatDuration('not-a-number'), '0:00');
  });
});

describe('TeleprompterExport - Storage Adapters', () => {
  test('InMemoryStorageAdapter saves, retrieves, and checks files', async () => {
    const mem = new ExportModule.InMemoryStorageAdapter();
    assert.equal(mem.count, 0);

    const dummyBlob = { size: 1024, type: 'audio/wav' };
    const res = await mem.save(dummyBlob, 'take_01.wav');

    assert.equal(res.ok, true);
    assert.equal(res.method, 'memory');
    assert.equal(mem.count, 1);
    assert.equal(mem.has('take_01.wav'), true);
    assert.equal(mem.get('take_01.wav'), dummyBlob);
    assert.deepEqual(mem.files, ['take_01.wav']);

    mem.clear();
    assert.equal(mem.count, 0);
  });

  test('FileSystemDirectoryAdapter writes through mock directory handle', async () => {
    let writtenBlob = null;
    let writtenFilename = null;
    let closed = false;

    const mockDirHandle = {
      name: 'ProjectRecordings',
      async getFileHandle(filename, opts) {
        writtenFilename = filename;
        return {
          async createWritable() {
            return {
              async write(b) { writtenBlob = b; },
              async close() { closed = true; },
            };
          }
        };
      }
    };

    const dirAdapter = new ExportModule.FileSystemDirectoryAdapter(mockDirHandle);
    assert.equal(dirAdapter.isAvailable, true);
    assert.equal(dirAdapter.getDirectoryHandle(), mockDirHandle);

    const blob = { size: 2048, type: 'video/webm' };
    const res = await dirAdapter.save(blob, 'Take-Intro.webm');

    assert.equal(res.ok, true);
    assert.equal(res.method, 'directory');
    assert.equal(res.folder, 'ProjectRecordings');
    assert.equal(writtenFilename, 'Take-Intro.webm');
    assert.equal(writtenBlob, blob);
    assert.equal(closed, true);
  });

  test('FileSystemDirectoryAdapter throws if directory handle is not set', async () => {
    const dirAdapter = new ExportModule.FileSystemDirectoryAdapter(null);
    assert.equal(dirAdapter.isAvailable, false);
    await assert.rejects(
      async () => dirAdapter.save({}, 'test.wav'),
      /Directory handle not set/
    );
  });

  test('DirectDownloadAdapter invokes provided download callback', async () => {
    let dlBlob = null;
    let dlFilename = null;

    const dlAdapter = new ExportModule.DirectDownloadAdapter((blob, filename) => {
      dlBlob = blob;
      dlFilename = filename;
      return true;
    });

    const blob = { data: 'test' };
    const res = await dlAdapter.save(blob, 'session.wav');

    assert.equal(res.ok, true);
    assert.equal(res.method, 'download');
    assert.equal(res.folder, 'Downloads');
    assert.equal(dlFilename, 'session.wav');
    assert.equal(dlBlob, blob);
  });
});

describe('TeleprompterExport - LocalFileSaverCoordinator', () => {
  test('saves to directory adapter when handle is present', async () => {
    const memDir = new ExportModule.InMemoryStorageAdapter();
    const memDl = new ExportModule.InMemoryStorageAdapter();

    // Use a coordinator wrapping custom adapters
    const coordinator = new ExportModule.LocalFileSaverCoordinator({
      directoryAdapter: {
        isAvailable: true,
        save: async (b, f) => memDir.save(b, f),
      },
      downloadAdapter: {
        save: async (b, f) => memDl.save(b, f),
      }
    });

    const res = await coordinator.save({ data: 1 }, 'take1.wav');
    assert.equal(memDir.count, 1);
    assert.equal(memDl.count, 0);
  });

  test('falls back to download adapter when directory adapter fails', async () => {
    const memDl = new ExportModule.InMemoryStorageAdapter();

    const coordinator = new ExportModule.LocalFileSaverCoordinator({
      directoryAdapter: {
        isAvailable: true,
        save: async () => { throw new Error('Disk write failed'); },
      },
      downloadAdapter: {
        save: async (b, f) => memDl.save(b, f),
      }
    });

    const res = await coordinator.save({ data: 2 }, 'take2.wav');
    assert.equal(memDl.count, 1);
    assert.equal(memDl.has('take2.wav'), true);
  });
});

describe('TeleprompterExport - ExportSession Lifecycle & Notifications', () => {
  function createMockElement() {
    return {
      classList: {
        _classes: new Set(['hidden']),
        add(c) { this._classes.add(c); },
        remove(c) { this._classes.delete(c); },
        contains(c) { return this._classes.has(c); },
        toggle(c, force) {
          if (force === undefined) {
            this._classes.has(c) ? this._classes.delete(c) : this._classes.add(c);
          } else if (force) {
            this._classes.add(c);
          } else {
            this._classes.delete(c);
          }
        }
      },
      textContent: '',
      innerHTML: '',
      addEventListener() {},
    };
  }

  test('open updates DOM elements, sets takes, and unhides modal', () => {
    const modalEl = createMockElement();
    const listEl = createMockElement();
    const summaryEl = createMockElement();
    const badgeEl = createMockElement();
    let notification = '';

    const session = new ExportModule.ExportSession({
      modalEl,
      takesList: listEl,
      summaryEl,
      badgeEl,
      onNotification: (msg) => { notification = msg; }
    });

    const testTakes = [
      {
        filename: 'Take-1-Intro.wav',
        title: 'Intro Section',
        duration: 12.4,
        isMaster: false,
        blob: new Blob(['audio data 1'], { type: 'audio/wav' })
      },
      {
        filename: 'Master-Take.wav',
        title: 'Stitched Master',
        duration: 45.2,
        isMaster: true,
        blob: new Blob(['audio data 2'], { type: 'audio/wav' })
      }
    ];

    session.open(testTakes, 'audio', 'wav');

    assert.equal(modalEl.classList.contains('hidden'), false);
    assert.equal(badgeEl.textContent, 'AUDIO (WAV)');
    assert.equal(summaryEl.textContent, '2 files ready to export');
    assert.equal(session.takes.length, 2);
    assert.match(listEl.innerHTML, /Take-1-Intro\.wav/);
    assert.match(listEl.innerHTML, /Master-Take\.wav/);
    assert.match(listEl.innerHTML, /STITCHED MASTER/);

    session.close();
    assert.equal(modalEl.classList.contains('hidden'), true);
  });
});
