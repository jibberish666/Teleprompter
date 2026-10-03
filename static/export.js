/**
 * TeleprompterExport - Export Session, Storage Adapters & Multi-Take Delivery Subsystem.
 *
 * Encapsulates:
 * 1. Pluggable Storage Adapters:
 *    - FileSystemDirectoryAdapter: Direct disk write via Chromium/Brave File System Access API
 *    - DirectDownloadAdapter: Headless/Safari fallback using anchor download
 *    - InMemoryStorageAdapter: Headless Node test adapter for fast verification
 * 2. LocalFileSaver coordinator for zero-prompt saving to user's selected folder
 * 3. File System Access dialog helper (saveBlobWithDialog) with MIME sanitization
 * 4. ExportSession modal manager: take list rendering, Blob URL lifecycle, batch ZIP, Save All
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    // Node.js / CommonJS
    module.exports = factory(root);
  } else {
    // Browser global
    root.TeleprompterExport = factory(root);
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';

  // ---- Duration Formatting --------------------------------------------------
  function formatDuration(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}:${String(rem).padStart(2, '0')}`;
  }

  // ---- Direct Download Helper ----------------------------------------------
  function downloadBlob(blob, filename) {
    if (typeof document === 'undefined' || !document.createElement) {
      return false;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.position = 'fixed';
    a.style.left = '-9999px';
    a.style.top = '-9999px';
    a.style.opacity = '0';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      try {
        if (a.parentNode) document.body.removeChild(a);
      } catch (_) {}
      if (typeof URL !== 'undefined' && URL.revokeObjectURL) {
        URL.revokeObjectURL(url);
      }
    }, 60000);
    return true;
  }

  // ---- Storage Adapters ----------------------------------------------------

  /**
   * FileSystemDirectoryAdapter:
   * Writes directly into a chosen directory handle using the File System Access API.
   * Zero dialogs/prompts on save once the directory has been chosen.
   */
  class FileSystemDirectoryAdapter {
    constructor(dirHandle = null) {
      this._dirHandle = dirHandle;
    }

    setDirectoryHandle(handle) {
      this._dirHandle = handle;
    }

    getDirectoryHandle() {
      return this._dirHandle;
    }

    get isAvailable() {
      return Boolean(this._dirHandle);
    }

    async save(blob, filename) {
      if (!this._dirHandle) {
        throw new Error('Directory handle not set');
      }
      const fileHandle = await this._dirHandle.getFileHandle(filename, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
      return { ok: true, method: 'directory', folder: this._dirHandle.name || 'Folder' };
    }
  }

  /**
   * DirectDownloadAdapter:
   * Saves files via standard browser download mechanism (into ~/Downloads).
   */
  class DirectDownloadAdapter {
    constructor(downloadFn = null) {
      this._downloadFn = downloadFn || downloadBlob;
    }

    async save(blob, filename) {
      const ok = this._downloadFn(blob, filename);
      return { ok: Boolean(ok !== false), method: 'download', folder: 'Downloads' };
    }
  }

  /**
   * InMemoryStorageAdapter:
   * For automated testing without DOM or browser File System dependencies.
   */
  class InMemoryStorageAdapter {
    constructor() {
      this._files = new Map();
    }

    async save(blob, filename) {
      this._files.set(filename, blob);
      return { ok: true, method: 'memory', folder: 'memory' };
    }

    has(filename) {
      return this._files.has(filename);
    }

    get(filename) {
      return this._files.get(filename);
    }

    get count() {
      return this._files.size;
    }

    clear() {
      this._files.clear();
    }

    get files() {
      return Array.from(this._files.keys());
    }
  }

  // ---- LocalFileSaver Coordinator -------------------------------------------
  class LocalFileSaverCoordinator {
    constructor({ directoryAdapter, downloadAdapter } = {}) {
      this._dirAdapter = directoryAdapter || new FileSystemDirectoryAdapter(null);
      this._dlAdapter = downloadAdapter || new DirectDownloadAdapter();
    }

    setDirectoryHandle(handle) {
      this._dirAdapter.setDirectoryHandle(handle);
    }

    getDirectoryHandle() {
      return this._dirAdapter.getDirectoryHandle();
    }

    async save(blob, filename) {
      if (this._dirAdapter.isAvailable) {
        try {
          return await this._dirAdapter.save(blob, filename);
        } catch (dirErr) {
          console.warn('Failed writing to directory handle, falling back to direct download:', dirErr);
        }
      }
      return await this._dlAdapter.save(blob, filename);
    }
  }

  const defaultLocalFileSaver = new LocalFileSaverCoordinator();

  // ---- Dialog Save Helper (Save As...) ---------------------------------------
  async function saveBlobWithDialog(blob, filename) {
    const ext = (filename.split('.').pop() || '').toLowerCase();

    // Sanitize MIME type: strip parameter attributes (e.g. ";codecs=...") to comply with Chromium/Brave File System Access API
    let rawMime = (blob && blob.type) ? blob.type.split(';')[0].trim().toLowerCase() : '';
    if (!rawMime || rawMime === 'application/octet-stream') {
      if (ext === 'mp3') rawMime = 'audio/mpeg';
      else if (ext === 'wav') rawMime = 'audio/wav';
      else if (ext === 'mp4') rawMime = 'video/mp4';
      else if (ext === 'webm') rawMime = 'video/webm';
      else if (ext === 'zip') rawMime = 'application/zip';
      else rawMime = 'application/octet-stream';
    }

    if (typeof window !== 'undefined' && 'showSaveFilePicker' in window) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: filename,
          types: [{
            description: `${ext.toUpperCase()} File (*.${ext})`,
            accept: { [rawMime]: [`.${ext}`] }
          }]
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return 'saved';
      } catch (err) {
        if (err.name === 'AbortError') {
          // User intentionally closed or cancelled the file picker dialog
          return 'cancelled';
        }
        console.warn('showSaveFilePicker encountered issue, using direct download:', err);
      }
    }

    // Direct browser download fallback for Safari or environments where File System Access fails
    downloadBlob(blob, filename);
    return 'downloaded';
  }

  // ---- ExportSession Class --------------------------------------------------
  // Owns all export modal state: takes[], objectUrls[], listener registration.
  // Listeners wired once in constructor — not per open() call.
  // Blob URL lifecycle owned here: created on open(), revoked on close().
  class ExportSession {
    constructor({
      modalEl,
      takesList,
      summaryEl,
      badgeEl,
      localFileSaver,
      saveBlobFn,
      createZipFn,
      speechHudEl,
      onNotification
    } = {}) {
      this._modal = modalEl;
      this._list = takesList;
      this._summary = summaryEl;
      this._badge = badgeEl;
      this._localFileSaver = localFileSaver || defaultLocalFileSaver;
      this._saveBlobFn = saveBlobFn || saveBlobWithDialog;
      this._createZipFn = createZipFn || (typeof root !== 'undefined' && root && root.TeleprompterMedia && root.TeleprompterMedia.createZipBlob ? root.TeleprompterMedia.createZipBlob : null);
      this._speechHud = speechHudEl;
      this._onNotification = onNotification || ((msg) => {
        if (this._speechHud) this._speechHud.textContent = msg;
      });
      this._takes = [];
      this._objectUrls = [];
      this._currentAudio = null;
      this._playingTakeIdx = null;

      this._wireStaticControls();
    }

    _notify(msg) {
      if (typeof this._onNotification === 'function') {
        this._onNotification(msg);
      }
    }

    _wireStaticControls() {
      if (typeof document === 'undefined') return;

      // Wire modal close handlers once (buttons, backdrop, and Escape key)
      const closeEls = [
        document.getElementById('btn-close-export-modal'),
        document.getElementById('btn-dismiss-export-modal'),
      ];
      closeEls.forEach((el) => el && el.addEventListener('click', () => this.close()));

      if (this._modal && this._modal.addEventListener) {
        this._modal.addEventListener('click', (e) => {
          if (e.target === this._modal) this.close();
        });
      }

      if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape' && this._modal && this._modal.classList && !this._modal.classList.contains('hidden')) {
            this.close();
          }
        });
      }

      // Wire Save All to Disk once
      const btnSaveAll = document.getElementById('btn-save-all-disk');
      if (btnSaveAll) {
        btnSaveAll.addEventListener('click', async () => {
          if (this._takes.length === 0) return;
          btnSaveAll.disabled = true;
          btnSaveAll.innerHTML = `<span>Saving all to disk…</span>`;
          try {
            let savedCount = 0;
            for (const take of this._takes) {
              const res = await this._localFileSaver.save(take.blob, take.filename);
              if (res && res.ok) savedCount++;
            }
            btnSaveAll.innerHTML = `<svg class="w-3.5 h-3.5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg><span class="text-green-400 font-semibold">All ${savedCount} Saved to recordings/</span>`;
            this._notify(`All ${savedCount} takes saved directly to project recordings/ folder!`);
          } catch (err) {
            console.error('Error saving all takes to disk:', err);
            btnSaveAll.innerHTML = `<span>Save All to recordings/</span>`;
          } finally {
            btnSaveAll.disabled = false;
          }
        });
      }

      // Wire ZIP download once
      const btnZip = document.getElementById('btn-download-all-zip');
      if (btnZip) {
        btnZip.addEventListener('click', async () => {
          if (this._takes.length === 0) return;
          if (!this._createZipFn) {
            this._notify('⚠ ZIP compression utility not available');
            return;
          }
          btnZip.disabled = true;
          btnZip.innerHTML = `<span>Creating ZIP…</span>`;
          try {
            const zipFiles = this._takes.map((t) => ({ name: t.filename, data: t.blob }));
            const zipBlob = await this._createZipFn(zipFiles);
            const now = new Date();
            const pad = (n) => String(n).padStart(2, '0');
            const zipName = `Teleprompter-Takes-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}.zip`;
            const res = await this._saveBlobFn(zipBlob, zipName);
            if (res === 'saved' || res === 'downloaded') {
              this._notify(`ZIP archive saved (${zipName})!`);
            }
          } catch (err) {
            console.error('Error generating ZIP:', err);
            this._notify('⚠ Error generating ZIP: ' + (err && err.message ? err.message : String(err)));
          } finally {
            btnZip.disabled = false;
            btnZip.innerHTML = `
              <svg class="w-4 h-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
              <span>Download All (.ZIP)</span>
            `;
          }
        });
      }

      // Event delegation on the takes list — one listener wired once for all per-take buttons
      if (this._list) {
        this._list.addEventListener('click', async (e) => {
          const previewBtn = e.target.closest('.btn-preview-take');
          if (previewBtn) {
            const idx = parseInt(previewBtn.getAttribute('data-take-idx'), 10);
            this.togglePreview(idx);
            return;
          }

          const saveDiskBtn = e.target.closest('.btn-save-disk');
          const saveAsBtn = e.target.closest('.btn-download-single');
          if (!saveDiskBtn && !saveAsBtn) return;

          const btn = saveDiskBtn || saveAsBtn;
          const idx = parseInt(btn.getAttribute('data-take-idx'), 10);
          const take = this._takes[idx];
          if (!take) return;

          const originalContent = btn.innerHTML;
          btn.disabled = true;

          if (saveDiskBtn) {
            btn.innerHTML = `<span>Saving to disk…</span>`;
            try {
              const res = await this._localFileSaver.save(take.blob, take.filename);
              const ok = res && res.ok;
              btn.innerHTML = ok
                ? `<svg class="w-3.5 h-3.5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg><span class="text-green-400 font-semibold">Saved to recordings/</span>`
                : `<span class="text-red-400">Save Failed</span>`;
              if (!ok) setTimeout(() => { btn.innerHTML = originalContent; }, 3000);
            } catch (err) {
              console.error('Error saving take to disk:', err);
              btn.innerHTML = `<span class="text-red-400">Save Failed</span>`;
              setTimeout(() => { btn.innerHTML = originalContent; }, 3000);
            }
          } else {
            btn.innerHTML = `<span>Saving…</span>`;
            try {
              const result = await this._saveBlobFn(take.blob, take.filename);
              if (result === 'saved' || result === 'downloaded') {
                btn.innerHTML = `<svg class="w-3.5 h-3.5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg><span class="text-green-400 font-semibold">${result === 'saved' ? 'Saved' : 'Downloaded'}</span>`;
              } else {
                btn.innerHTML = originalContent;
              }
            } catch (saveErr) {
              console.error('Save error:', saveErr);
              btn.innerHTML = originalContent;
            }
          }
          btn.disabled = false;
        });
      }
    }

    togglePreview(idx) {
      if (this._playingTakeIdx === idx) {
        this.stopPlayback();
        return;
      }
      this.playTake(idx);
    }

    stopPlayback() {
      if (this._currentAudio) {
        try {
          this._currentAudio.pause();
          this._currentAudio.currentTime = 0;
        } catch (_) {}
        this._currentAudio = null;
      }
      this._playingTakeIdx = null;
      this._updatePreviewUI();
    }

    playTake(idx) {
      this.stopPlayback();
      const url = this._objectUrls[idx];
      if (!url) return;

      if (typeof Audio === 'undefined') {
        this._playingTakeIdx = idx;
        this._updatePreviewUI();
        return;
      }

      try {
        const audio = new Audio(url);
        this._currentAudio = audio;
        this._playingTakeIdx = idx;
        this._updatePreviewUI();

        audio.onended = () => {
          if (this._currentAudio === audio) {
            this.stopPlayback();
          }
        };

        audio.onerror = (err) => {
          console.warn('Audio preview playback error:', err);
          if (this._currentAudio === audio) {
            this.stopPlayback();
          }
        };

        const playPromise = audio.play();
        if (playPromise !== undefined) {
          playPromise.catch((err) => {
            console.warn('Audio preview playback failed:', err);
            if (this._currentAudio === audio) {
              this.stopPlayback();
            }
          });
        }
      } catch (err) {
        console.warn('Audio initialization failed:', err);
        this.stopPlayback();
      }
    }

    _updatePreviewUI() {
      if (!this._list || typeof this._list.querySelectorAll !== 'function') return;
      const previewBtns = this._list.querySelectorAll('.btn-preview-take');
      if (!previewBtns || !previewBtns.forEach) return;

      previewBtns.forEach((btn) => {
        const takeIdx = parseInt(btn.getAttribute('data-take-idx'), 10);
        const isPlaying = (takeIdx === this._playingTakeIdx);

        if (isPlaying) {
          btn.className = 'btn-preview-take px-3 py-1.5 bg-amber-950/70 hover:bg-amber-900/90 text-amber-300 font-semibold text-xs rounded-lg border border-amber-600/60 ring-1 ring-amber-500/40 transition flex items-center gap-1.5 cursor-pointer shadow-sm';
          btn.innerHTML = `
            <svg class="w-3.5 h-3.5 text-amber-400 fill-current animate-pulse" viewBox="0 0 24 24"><path d="M6 6h12v12H6z"/></svg>
            <span>Stop</span>
          `;
          btn.setAttribute('title', 'Stop playback');
        } else {
          btn.className = 'btn-preview-take px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white text-xs font-medium rounded-lg border border-gray-700 transition flex items-center gap-1.5 cursor-pointer shadow-sm';
          btn.innerHTML = `
            <svg class="w-3.5 h-3.5 text-indigo-400 fill-current" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
            <span>Preview</span>
          `;
          btn.setAttribute('title', 'Preview audio take');
        }
      });
    }

    // Opens the modal and updates all internal state + DOM. Blob URLs created here.
    open(takes, mode, format) {
      if (!this._modal || !this._list) return;
      this.close(); // revoke previous URLs
      this._takes = takes || [];
      this._objectUrls = (typeof URL !== 'undefined' && URL.createObjectURL)
        ? this._takes.map((t) => {
            try {
              return (t && t.blob) ? URL.createObjectURL(t.blob) : '';
            } catch (_) {
              return '';
            }
          })
        : [];

      if (this._badge) {
        this._badge.textContent = `${(mode || 'audio').toUpperCase()} (${(format || 'wav').toUpperCase()})`;
      }
      if (this._summary) {
        this._summary.textContent = `${this._takes.length} ${this._takes.length === 1 ? 'file' : 'files'} ready to export`;
      }

      this._list.innerHTML = this._takes.map((take, idx) => {
        const isMaster = take.isMaster;
        const borderClass = isMaster ? 'export-take-master' : '';
        const objectUrl = this._objectUrls[idx] || '#';
        return `
          <div class="export-take-row ${borderClass}">
            <div class="flex items-center gap-3 min-w-0 flex-1">
              <div class="w-8 h-8 rounded-lg shrink-0 ${isMaster ? 'bg-indigo-500/20 text-indigo-400 border border-indigo-400/30' : 'bg-gray-800 text-gray-300 border border-gray-700'} flex items-center justify-center">
                ${isMaster
                  ? '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"/></svg>'
                  : '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3"/></svg>'
                }
              </div>
              <div class="min-w-0 flex-1">
                <div class="font-semibold text-white flex items-center gap-2 truncate">
                  <span class="truncate">${take.filename}</span>
                  ${isMaster ? '<span class="text-[9px] font-mono px-1.5 py-0.5 rounded bg-indigo-950 text-indigo-300 border border-indigo-700/50 shrink-0">STITCHED MASTER</span>' : ''}
                </div>
                <div class="text-[11px] text-gray-400 flex items-center gap-2">
                  <span>${take.title}</span>
                  <span>•</span>
                  <span class="font-mono text-gray-400">${formatDuration(take.duration)}</span>
                </div>
                ${(take.sectionMarkers && take.sectionMarkers.length > 0) ? `
                <div class="mt-1.5 space-y-0.5">
                  <p class="text-[10px] text-indigo-400 font-semibold uppercase tracking-wider mb-0.5">Section cut points</p>
                  ${take.sectionMarkers.map((sm) => {
                    const start = sm.startSec !== null ? formatDuration(sm.startSec) : '–';
                    const end = sm.endSec !== null ? formatDuration(sm.endSec) : '–';
                    return `<p class="text-[10px] font-mono text-gray-500">[${sm.title}] ${start} – ${end}</p>`;
                  }).join('')}
                </div>` : ''}
              </div>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <button data-take-idx="${idx}" type="button" class="btn-preview-take px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white text-xs font-medium rounded-lg border border-gray-700 transition flex items-center gap-1.5 cursor-pointer shadow-sm" title="Preview audio take">
                <svg class="w-3.5 h-3.5 text-indigo-400 fill-current" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                <span>Preview</span>
              </button>
              <button data-take-idx="${idx}" type="button" class="btn-save-disk px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-lg shadow transition flex items-center gap-1.5 cursor-pointer" title="Save ${take.filename} directly to project recordings/ folder on your Mac">
                <svg class="w-3.5 h-3.5 text-indigo-200" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4"/></svg>
                <span>Save to Disk</span>
              </button>
              <a href="${objectUrl}" download="${take.filename}" class="btn-direct-download p-2 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 text-xs font-medium rounded-lg border border-gray-700 transition flex items-center justify-center cursor-pointer" title="Direct browser download for ${take.filename}">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
              </a>
            </div>
          </div>
        `;
      }).join('');

      // Show/hide batch buttons based on take count
      if (typeof document !== 'undefined') {
        const btnZip = document.getElementById('btn-download-all-zip');
        const btnSaveAll = document.getElementById('btn-save-all-disk');
        if (btnZip) btnZip.classList.toggle('hidden', this._takes.length <= 1);
        if (btnSaveAll) btnSaveAll.classList.toggle('hidden', this._takes.length <= 1);
      }

      this._modal.classList.remove('hidden');
    }

    // Closes modal, stops preview playback, revokes all blob URLs.
    close() {
      this.stopPlayback();
      if (this._modal) this._modal.classList.add('hidden');
      if (typeof URL !== 'undefined' && URL.revokeObjectURL) {
        this._objectUrls.forEach((url) => { try { URL.revokeObjectURL(url); } catch (_) {} });
      }
      this._objectUrls = [];
    }

    // Read-only accessor for takes
    get takes() {
      return this._takes;
    }
  }

  // ---- Pre-defined Save Folder Controller -----------------------------------
  function bindFolderControls({
    localFileSaver = defaultLocalFileSaver,
    btnChooseFolder,
    btnClearFolder,
    lblSaveFolder,
    saveFolderHint
  } = {}) {
    if (typeof window === 'undefined') return;

    if (btnChooseFolder) {
      btnChooseFolder.addEventListener('click', async () => {
        if ('showDirectoryPicker' in window) {
          try {
            const handle = await window.showDirectoryPicker({
              id: 'teleprompter_save_dir',
              mode: 'readwrite',
            });
            localFileSaver.setDirectoryHandle(handle);
            if (lblSaveFolder) lblSaveFolder.textContent = handle.name;
            if (btnClearFolder) btnClearFolder.classList.remove('hidden');
            if (saveFolderHint) {
              saveFolderHint.textContent = `Auto-saving to folder "${handle.name}" on Stop.`;
              saveFolderHint.className = 'text-[10px] text-green-400 mt-1 leading-snug font-medium';
            }
          } catch (err) {
            if (err.name !== 'AbortError') console.warn('showDirectoryPicker error:', err);
          }
        } else {
          alert('Directory picker is not supported in this browser. Recordings will save to your default Downloads folder.');
        }
      });
    }

    if (btnClearFolder) {
      btnClearFolder.addEventListener('click', (e) => {
        e.stopPropagation();
        localFileSaver.setDirectoryHandle(null);
        if (lblSaveFolder) lblSaveFolder.textContent = 'Downloads (Default)';
        btnClearFolder.classList.add('hidden');
        if (saveFolderHint) {
          saveFolderHint.textContent = 'Pick any folder to auto-save recordings instantly on Stop.';
          saveFolderHint.className = 'text-[10px] text-gray-500 mt-1 leading-tight';
        }
      });
    }
  }

  // ---- Bootstrap Factory ----------------------------------------------------
  function init({
    modalEl,
    takesList,
    summaryEl,
    badgeEl,
    localFileSaver = defaultLocalFileSaver,
    saveBlobFn = saveBlobWithDialog,
    createZipFn,
    speechHudEl,
    onNotification,
    btnChooseFolder = (typeof document !== 'undefined' ? document.getElementById('btn-choose-folder') : null),
    btnClearFolder = (typeof document !== 'undefined' ? document.getElementById('btn-clear-folder') : null),
    lblSaveFolder = (typeof document !== 'undefined' ? document.getElementById('lbl-save-folder') : null),
    saveFolderHint = (typeof document !== 'undefined' ? document.getElementById('save-folder-hint') : null),
  } = {}) {
    bindFolderControls({
      localFileSaver,
      btnChooseFolder,
      btnClearFolder,
      lblSaveFolder,
      saveFolderHint
    });

    return new ExportSession({
      modalEl,
      takesList,
      summaryEl,
      badgeEl,
      localFileSaver,
      saveBlobFn,
      createZipFn,
      speechHudEl,
      onNotification
    });
  }

  return {
    formatDuration,
    downloadBlob,
    FileSystemDirectoryAdapter,
    DirectDownloadAdapter,
    InMemoryStorageAdapter,
    LocalFileSaverCoordinator,
    LocalFileSaver: defaultLocalFileSaver,
    saveBlobWithDialog,
    ExportSession,
    bindFolderControls,
    init,
  };
});
