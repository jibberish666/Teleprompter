/**
 * TeleprompterScriptEditor - Expanded Script Editor Modal Controller.
 *
 * Encapsulates:
 * 1. Modal visibility lifecycle (open, close, backdrop click dismiss)
 * 2. Word count, section count, and estimated duration calculation
 * 3. Modal font size scaling (small, medium, large)
 * 4. Bi-directional synchronization with the main transcript input
 * 5. Script formatting, file import triggering, and clear actions
 * 6. Visual status toast notifications
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    // Node.js / CommonJS
    module.exports = factory(root);
  } else {
    // Browser global
    root.TeleprompterScriptEditor = factory(root);
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';

  function calculateStats(text) {
    const raw = text || '';
    const words = raw.trim() ? raw.trim().split(/\s+/).filter((w) => !w.startsWith('#')).length : 0;
    const sections = (raw.match(/^#[^\n]+/gm) || []).length;
    const totalSecs = Math.round((words / 135) * 60);
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    const durationStr = mins > 0 ? `~${mins}m ${secs}s` : `~${secs}s`;
    return { words, sections, totalSecs, durationStr };
  }

  function showToast(el, msg, durationMs = 1800) {
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('opacity-0');
    el.classList.add('opacity-100');
    setTimeout(() => {
      el.classList.remove('opacity-100');
      el.classList.add('opacity-0');
    }, durationMs);
  }

  class TeleprompterScriptEditor {
    constructor(options = {}) {
      this.modalEl = options.modalEl || (typeof document !== 'undefined' ? document.getElementById('modal-script-editor') : null);
      this.modalInput = options.modalInput || (typeof document !== 'undefined' ? document.getElementById('modal-transcript-input') : null);
      this.sourceInput = options.sourceInput || (typeof document !== 'undefined' ? document.getElementById('transcript-input') : null);
      this.fileInput = options.fileInput || (typeof document !== 'undefined' ? document.getElementById('file-input') : null);

      this.toastEl = options.toastEl || (typeof document !== 'undefined' ? document.getElementById('modal-script-toast') : null);
      this.statWordsEl = options.statWordsEl || (typeof document !== 'undefined' ? document.getElementById('modal-stat-words') : null);
      this.statDurationEl = options.statDurationEl || (typeof document !== 'undefined' ? document.getElementById('modal-stat-duration') : null);
      this.statSectionsEl = options.statSectionsEl || (typeof document !== 'undefined' ? document.getElementById('modal-stat-sections') : null);

      this.btnFontSm = options.btnFontSm || (typeof document !== 'undefined' ? document.getElementById('btn-modal-font-sm') : null);
      this.btnFontMd = options.btnFontMd || (typeof document !== 'undefined' ? document.getElementById('btn-modal-font-md') : null);
      this.btnFontLg = options.btnFontLg || (typeof document !== 'undefined' ? document.getElementById('btn-modal-font-lg') : null);

      this.btnClose = options.btnClose || (typeof document !== 'undefined' ? document.getElementById('btn-close-script-modal') : null);
      this.btnCancel = options.btnCancel || (typeof document !== 'undefined' ? document.getElementById('btn-modal-cancel') : null);
      this.btnApply = options.btnApply || (typeof document !== 'undefined' ? document.getElementById('btn-modal-apply') : null);
      this.btnAutoFormat = options.btnAutoFormat || (typeof document !== 'undefined' ? document.getElementById('btn-modal-auto-format') : null);
      this.btnImportFile = options.btnImportFile || (typeof document !== 'undefined' ? document.getElementById('btn-modal-import-file') : null);
      this.btnClear = options.btnClear || (typeof document !== 'undefined' ? document.getElementById('btn-modal-clear') : null);
      this.btnExpand = options.btnExpand || (typeof document !== 'undefined' ? document.getElementById('btn-expand-transcript') : null);

      this.onApply = options.onApply || null;
      this.onSync = options.onSync || null;
      this.onClear = options.onClear || null;
      this.formatFn = options.formatFn || null;
      this.getAutoFormatEnabled = typeof options.getAutoFormatEnabled === 'function'
        ? options.getAutoFormatEnabled
        : () => Boolean(options.autoFormatOnPaste !== false);

      if (this.sourceInput && this.modalInput) {
        if (this.sourceInput.value && !this.modalInput.value) {
          this.modalInput.value = this.sourceInput.value;
        } else if (this.modalInput.value && !this.sourceInput.value) {
          this.sourceInput.value = this.modalInput.value;
        }
        this.updateStats();
      }

      this.initEventListeners();
    }

    isOpen() {
      return Boolean(this.modalEl && !this.modalEl.classList.contains('hidden'));
    }

    open() {
      if (!this.modalEl) return;
      if (this.modalInput && this.sourceInput) {
        this.modalInput.value = this.sourceInput.value;
      }
      this.updateStats();
      this.modalEl.classList.remove('hidden');
      if (this.modalInput) {
        setTimeout(() => {
          this.modalInput.focus();
        }, 50);
      }
    }

    close() {
      if (this.modalInput && this.sourceInput) {
        if (this.modalInput.value !== this.sourceInput.value) {
          this.sourceInput.value = this.modalInput.value;
          if (typeof this.onSync === 'function') {
            this.onSync(this.sourceInput.value);
          }
        }
      }
      if (this.modalEl) {
        this.modalEl.classList.add('hidden');
      }
    }

    updateStats() {
      if (!this.modalInput) return null;
      const stats = calculateStats(this.modalInput.value || '');
      if (this.statWordsEl) {
        this.statWordsEl.textContent = `${stats.words} ${stats.words === 1 ? 'word' : 'words'}`;
      }
      if (this.statDurationEl) {
        this.statDurationEl.textContent = stats.durationStr;
      }
      if (this.statSectionsEl) {
        this.statSectionsEl.textContent = `${stats.sections} ${stats.sections === 1 ? 'section' : 'sections'}`;
      }
      return stats;
    }

    showToast(msg = 'Saved & Applied ✓') {
      showToast(this.toastEl, msg, 1800);
    }

    apply() {
      if (this.modalInput && this.sourceInput) {
        this.sourceInput.value = this.modalInput.value;
      }
      const val = this.sourceInput ? this.sourceInput.value : (this.modalInput ? this.modalInput.value : '');
      if (typeof this.onApply === 'function') {
        this.onApply(val);
      } else if (typeof this.onSync === 'function') {
        this.onSync(val);
      }
      this.showToast('Saved & Applied ✓');
    }

    syncFromSource() {
      if (this.modalInput && this.sourceInput) {
        this.modalInput.value = this.sourceInput.value;
      }
      this.updateStats();
    }

    setFontSize(size) {
      if (!this.modalInput) return;
      this.modalInput.classList.remove('text-xs', 'text-sm', 'text-base', 'text-lg');
      if (size === 'sm') {
        this.modalInput.classList.add('text-xs');
      } else if (size === 'lg') {
        this.modalInput.classList.add('text-base');
      } else {
        this.modalInput.classList.add('text-sm');
      }

      const buttons = [this.btnFontSm, this.btnFontMd, this.btnFontLg];
      buttons.forEach((btn) => {
        if (btn) {
          btn.classList.remove('bg-gray-800', 'text-indigo-300', 'font-semibold');
          btn.classList.add('text-gray-400');
        }
      });
      const activeBtn = size === 'sm' ? this.btnFontSm : size === 'lg' ? this.btnFontLg : this.btnFontMd;
      if (activeBtn) {
        activeBtn.classList.remove('text-gray-400');
        activeBtn.classList.add('bg-gray-800', 'text-indigo-300', 'font-semibold');
      }
    }

    initEventListeners() {
      if (this.btnExpand) {
        this.btnExpand.addEventListener('click', () => this.open());
      }
      if (this.sourceInput) {
        this.sourceInput.addEventListener('dblclick', () => this.open());
      }
      if (this.btnClose) {
        this.btnClose.addEventListener('click', () => this.close());
      }
      if (this.btnCancel) {
        this.btnCancel.addEventListener('click', () => this.close());
      }
      if (this.btnApply) {
        this.btnApply.addEventListener('click', () => {
          this.apply();
          this.close();
        });
      }
      if (this.modalEl) {
        this.modalEl.addEventListener('click', (e) => {
          if (e.target === this.modalEl) {
            this.close();
          }
        });
      }
      if (this.modalInput) {
        this.modalInput.addEventListener('input', () => {
          if (this.sourceInput) {
            this.sourceInput.value = this.modalInput.value;
          }
          if (typeof this.onSync === 'function') {
            this.onSync(this.sourceInput ? this.sourceInput.value : this.modalInput.value);
          }
          this.updateStats();
        });

        this.modalInput.addEventListener('paste', () => {
          setTimeout(() => {
            if (!this.modalInput) return;
            const val = this.modalInput.value || '';
            let formattedVal = val;
            if (typeof this.formatFn === 'function' && typeof this.getAutoFormatEnabled === 'function' && this.getAutoFormatEnabled()) {
              if (val.trim()) {
                formattedVal = this.formatFn(val);
                this.modalInput.value = formattedVal;
                this.showToast('Auto-formatted ✓');
              }
            }
            if (this.sourceInput) {
              this.sourceInput.value = this.modalInput.value;
            }
            if (typeof this.onSync === 'function') {
              this.onSync(this.sourceInput ? this.sourceInput.value : this.modalInput.value);
            }
            this.updateStats();
          }, 50);
        });
      }
      if (this.btnAutoFormat && this.modalInput) {
        this.btnAutoFormat.addEventListener('click', () => {
          if (!this.modalInput.value || !this.modalInput.value.trim()) return;
          const formatted = typeof this.formatFn === 'function' ? this.formatFn(this.modalInput.value) : this.modalInput.value;
          this.modalInput.value = formatted;
          if (this.sourceInput) {
            this.sourceInput.value = formatted;
          }
          if (typeof this.onSync === 'function') {
            this.onSync(formatted);
          }
          this.updateStats();
          this.showToast('Auto-formatted ✓');
        });
      }
      if (this.btnImportFile && this.fileInput) {
        this.btnImportFile.addEventListener('click', () => {
          this.fileInput.click();
        });
      }
      if (this.btnClear && this.modalInput) {
        this.btnClear.addEventListener('click', () => {
          if (!this.modalInput.value.trim()) return;
          if (this.modalInput.value.trim().length > 30) {
            if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
              if (!window.confirm('Are you sure you want to clear the transcript?')) return;
            }
          }
          this.modalInput.value = '';
          if (this.sourceInput) {
            this.sourceInput.value = '';
          }
          if (typeof this.onClear === 'function') {
            this.onClear();
          } else if (typeof this.onSync === 'function') {
            this.onSync('');
          }
          this.updateStats();
          this.showToast('Cleared');
        });
      }
      if (this.btnFontSm) this.btnFontSm.addEventListener('click', () => this.setFontSize('sm'));
      if (this.btnFontMd) this.btnFontMd.addEventListener('click', () => this.setFontSize('md'));
      if (this.btnFontLg) this.btnFontLg.addEventListener('click', () => this.setFontSize('lg'));
    }
  }

  return {
    calculateStats,
    TeleprompterScriptEditor,
  };
});
