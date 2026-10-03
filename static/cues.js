/**
 * TeleprompterCues - Vocabulary, Pronunciation & Rehearsal Fumble Subsystem.
 *
 * Encapsulates:
 * 1. Word normalization and punctuation stripping.
 * 2. Difficult words collection, custom highlight styles, and hex-to-rgba color transforms.
 * 3. Trial run rehearsal fumble tracking (skipped, stumbled, repeated) with deduplication.
 * 4. Tag filtering ('all' | 'skipped' | 'stumbled' | 'repeated') and prompter synchronization.
 * 5. Persistence across configStore and localStorage with memory fallback for tests.
 * 6. Modal DOM binding and rendering for tag chips, counts, and style previews.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    // Node.js / CommonJS
    module.exports = factory(root);
  } else {
    // Browser global
    root.TeleprompterCues = factory(root);
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';

  // ---- Utility Helpers -----------------------------------------------------

  /**
   * Strips leading/trailing punctuation and downcases words for stable matching.
   */
  function cleanWord(str) {
    if (!str || typeof str !== 'string') return '';
    return str.toLowerCase().replace(/^[^\w]+|[^\w]+$/g, '');
  }

  /**
   * HTML escape helper safe for browser DOM or mock strings.
   */
  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Converts a 3 or 6 digit hex color code to rgba() CSS string.
   */
  function hexToRgba(hex, alpha) {
    if (!hex || typeof hex !== 'string') return `rgba(245, 158, 11, ${alpha})`;
    let c = hex.replace('#', '');
    if (c.length === 3) c = c.split('').map((x) => x + x).join('');
    const num = parseInt(c, 16);
    if (isNaN(num)) return `rgba(245, 158, 11, ${alpha})`;
    const r = (num >> 16) & 255;
    const g = (num >> 8) & 255;
    const b = num & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  // ---- RehearsalCues Subsystem Class ----------------------------------------

  class RehearsalCues {
    constructor(options = {}) {
      this.configStore = options.configStore || null;
      this.storage = options.storage || (typeof localStorage !== 'undefined' ? localStorage : null);
      this.onChange = typeof options.onChange === 'function' ? options.onChange : null;

      // Difficult words state
      this.difficultWordsList = [];
      this.difficultWordsSet = new Set();
      this.difficultColor = '#f59e0b';
      this.difficultStyle = 'pill'; // 'pill' | 'glow' | 'underline'

      // Rehearsal fumbles state
      this.rehearsalWordsList = [];
      this.rehearsalWordsSet = new Set();
      this.rehearsalFilter = 'all'; // 'all' | 'skipped' | 'stumbled' | 'repeated'
      this.syncPrompterWithFilter = false;

      // Bound UI elements
      this.elements = null;
      this._toastTimer = null;
      this.toastFn = null;

      this.load();
    }

    /**
     * Loads persisted state from configStore or web storage fallback.
     */
    load() {
      // 1. Difficult words
      try {
        if (this.configStore && Array.isArray(this.configStore.get('ui.difficult_words'))) {
          this.difficultWordsList = [...this.configStore.get('ui.difficult_words')];
        } else if (this.storage && this.storage.getItem) {
          const saved = this.storage.getItem('teleprompter_difficult_words');
          if (saved) this.difficultWordsList = JSON.parse(saved);
        }
      } catch (_) {
        this.difficultWordsList = [];
      }
      this._rebuildDifficultSet();

      // Difficult styles & colors
      try {
        if (this.configStore) {
          this.difficultColor = this.configStore.get('ui.difficult_color') || '#f59e0b';
          this.difficultStyle = this.configStore.get('ui.difficult_style') || 'pill';
        } else if (this.storage && this.storage.getItem) {
          this.difficultColor = this.storage.getItem('teleprompter_difficult_color') || '#f59e0b';
          this.difficultStyle = this.storage.getItem('teleprompter_difficult_style') || 'pill';
        }
      } catch (_) {}

      // 2. Rehearsal fumbles
      try {
        if (this.configStore && Array.isArray(this.configStore.get('script.rehearsal_words'))) {
          this.rehearsalWordsList = [...this.configStore.get('script.rehearsal_words')];
        } else if (this.storage && this.storage.getItem) {
          const savedRehearsal = this.storage.getItem('teleprompter_rehearsal_words');
          if (savedRehearsal) this.rehearsalWordsList = JSON.parse(savedRehearsal);
        }
      } catch (_) {
        this.rehearsalWordsList = [];
      }
      this._rebuildRehearsalSet();

      // Sync filter with prompter flag
      try {
        if (this.configStore) {
          this.syncPrompterWithFilter = !!this.configStore.get('ui.sync_fumble_filter');
        } else if (this.storage && this.storage.getItem) {
          this.syncPrompterWithFilter = this.storage.getItem('teleprompter_sync_fumble_filter') === 'true';
        }
      } catch (_) {}
    }

    _rebuildDifficultSet() {
      this.difficultWordsSet = new Set(
        this.difficultWordsList.map((w) => cleanWord(w)).filter(Boolean)
      );
    }

    _rebuildRehearsalSet() {
      this.rehearsalWordsSet = new Set(
        this.rehearsalWordsList
          .map((item) => (typeof item === 'string' ? item : item.clean || item.word))
          .map(cleanWord)
          .filter(Boolean)
      );
    }

    /**
     * Persists difficult words state.
     */
    saveDifficultWords() {
      this._rebuildDifficultSet();
      if (this.configStore && typeof this.configStore.update === 'function') {
        this.configStore.update('ui', {
          difficult_words: this.difficultWordsList,
          difficult_color: this.difficultColor,
          difficult_style: this.difficultStyle,
        });
      }
      if (this.storage && this.storage.setItem) {
        try {
          this.storage.setItem('teleprompter_difficult_words', JSON.stringify(this.difficultWordsList));
          this.storage.setItem('teleprompter_difficult_color', this.difficultColor);
          this.storage.setItem('teleprompter_difficult_style', this.difficultStyle);
        } catch (_) {}
      }
      this.updateUI();
    }

    /**
     * Persists rehearsal fumbles state.
     */
    saveRehearsalWords() {
      this._rebuildRehearsalSet();
      if (this.configStore && typeof this.configStore.set === 'function') {
        this.configStore.set('script.rehearsal_words', this.rehearsalWordsList);
      }
      if (this.storage && this.storage.setItem) {
        try {
          this.storage.setItem('teleprompter_rehearsal_words', JSON.stringify(this.rehearsalWordsList));
        } catch (_) {}
      }
      this.updateUI();
    }

    /**
     * Persists the fumble prompter sync flag.
     */
    saveSyncPrompterFlag() {
      if (this.configStore && typeof this.configStore.set === 'function') {
        this.configStore.set('ui.sync_fumble_filter', this.syncPrompterWithFilter);
      }
      if (this.storage && this.storage.setItem) {
        try {
          this.storage.setItem('teleprompter_sync_fumble_filter', String(this.syncPrompterWithFilter));
        } catch (_) {}
      }
      this.updateUI();
    }

    // ---- Difficult Words Operations -----------------------------------------

    /**
     * Adds single or batch difficult words (comma, semicolon, or newline delimited).
     * Returns true if at least one new word was added.
     */
    addDifficultWord(rawWord) {
      if (!rawWord || typeof rawWord !== 'string' || !rawWord.trim()) return false;
      const parts = rawWord.split(/[,;\n\r\t]+/).map((s) => s.trim()).filter(Boolean);
      let added = false;
      for (const p of parts) {
        const cleaned = p.replace(/^[^\w]+|[^\w]+$/g, '');
        if (!cleaned) continue;
        const lower = cleaned.toLowerCase();
        if (!this.difficultWordsList.some((w) => w.toLowerCase() === lower)) {
          this.difficultWordsList.push(cleaned);
          added = true;
        }
      }
      if (added) {
        this.saveDifficultWords();
        if (this.onChange) this.onChange();
      }
      return added;
    }

    removeDifficultWord(index) {
      if (index >= 0 && index < this.difficultWordsList.length) {
        this.difficultWordsList.splice(index, 1);
        this.saveDifficultWords();
        if (this.onChange) this.onChange();
        return true;
      }
      return false;
    }

    clearDifficultWords() {
      if (this.difficultWordsList.length === 0) return 0;
      const count = this.difficultWordsList.length;
      this.difficultWordsList = [];
      this.saveDifficultWords();
      if (this.onChange) this.onChange();
      return count;
    }

    setColor(hex) {
      if (!hex || typeof hex !== 'string') return;
      this.difficultColor = hex;
      this.saveDifficultWords();
      if (this.onChange) this.onChange();
    }

    setStyle(style) {
      if (style !== 'pill' && style !== 'glow' && style !== 'underline') return;
      this.difficultStyle = style;
      this.saveDifficultWords();
      if (this.onChange) this.onChange();
    }

    // ---- Rehearsal Fumbles Operations ---------------------------------------

    /**
     * Ingests fumbles (single or array) detected during trial runs.
     * Optional callback onNewlyAdded(fumble) invoked for live DOM styling.
     */
    recordFumbles(incomingFumbles, onNewlyAdded) {
      const fumbles = Array.isArray(incomingFumbles)
        ? incomingFumbles
        : (incomingFumbles ? [incomingFumbles] : []);
      let added = false;

      fumbles.forEach((f) => {
        if (!f) return;
        const raw = f.clean || f.word || '';
        const clean = cleanWord(raw);
        if (!clean) return;

        if (!this.rehearsalWordsSet.has(clean)) {
          const item = {
            word: f.word || clean,
            clean: clean,
            reason: f.reason || 'stumbled',
          };
          this.rehearsalWordsList.push(item);
          this.rehearsalWordsSet.add(clean);
          added = true;
        }

        if (typeof onNewlyAdded === 'function') {
          onNewlyAdded(f);
        }
      });

      if (added) {
        this.saveRehearsalWords();
        if (this.onChange) this.onChange();
      }
      return added;
    }

    removeRehearsalWord(index) {
      if (index >= 0 && index < this.rehearsalWordsList.length) {
        this.rehearsalWordsList.splice(index, 1);
        this.saveRehearsalWords();
        if (this.onChange) this.onChange();
        return true;
      }
      return false;
    }

    /**
     * Promotes a trial fumble into a permanent configured difficult word.
     */
    promoteToDifficult(index) {
      if (index >= 0 && index < this.rehearsalWordsList.length) {
        const item = this.rehearsalWordsList[index];
        const word = typeof item === 'string' ? item : (item.word || item.clean);
        this.addDifficultWord(word);
        this.rehearsalWordsList.splice(index, 1);
        this.saveRehearsalWords();
        if (this.onChange) this.onChange();
        return true;
      }
      return false;
    }

    clearRehearsalWords(filterOverride) {
      const filter = filterOverride || this.rehearsalFilter;
      if (this.rehearsalWordsList.length === 0) return 0;

      if (filter === 'all') {
        const removed = this.rehearsalWordsList.length;
        this.rehearsalWordsList = [];
        this.saveRehearsalWords();
        if (this.onChange) this.onChange();
        return removed;
      }

      const initialCount = this.rehearsalWordsList.length;
      this.rehearsalWordsList = this.rehearsalWordsList.filter((item) => {
        const r = (typeof item === 'object' && item.reason ? item.reason : 'stumbled').toLowerCase();
        return r !== filter;
      });
      const removed = initialCount - this.rehearsalWordsList.length;
      if (removed > 0) {
        this.saveRehearsalWords();
        if (this.onChange) this.onChange();
      }
      return removed;
    }

    setFilter(filter) {
      if (this.rehearsalFilter === filter) return;
      this.rehearsalFilter = filter || 'all';
      if (this.syncPrompterWithFilter && this.onChange) {
        this.onChange();
      }
    }

    setSyncPrompterWithFilter(bool) {
      this.syncPrompterWithFilter = !!bool;
      this.saveSyncPrompterFlag();
      if (this.onChange) this.onChange();
    }

    // ---- Counts & Queries ----------------------------------------------------

    getCounts() {
      const counts = {
        all: this.rehearsalWordsList.length,
        skipped: 0,
        stumbled: 0,
        repeated: 0,
        difficult: this.difficultWordsList.length,
      };
      this.rehearsalWordsList.forEach((item) => {
        const r = (typeof item === 'object' && item.reason ? item.reason : 'stumbled').toLowerCase();
        if (counts[r] !== undefined) counts[r]++;
        else counts.stumbled++;
      });
      return counts;
    }

    getRehearsalReasonMap() {
      const map = new Map();
      this.rehearsalWordsList.forEach((item) => {
        const clean = cleanWord(typeof item === 'string' ? item : item.clean || item.word);
        if (clean && !map.has(clean)) {
          const r = typeof item === 'object' && item.reason ? item.reason.toLowerCase() : 'stumbled';
          map.set(clean, r);
        }
      });
      return map;
    }

    /**
     * Resolves the highlight styling and cue reason for any given script word.
     */
    getCue(rawWord) {
      const clean = cleanWord(rawWord);
      if (!clean) {
        return { isDifficult: false, isRehearsal: false, reason: null, classes: '' };
      }

      const isDifficult = this.difficultWordsSet.has(clean);
      if (isDifficult) {
        return {
          isDifficult: true,
          isRehearsal: false,
          reason: null,
          classes: `prompter-word-difficult style-${this.difficultStyle}`,
        };
      }

      // Check rehearsal fumbles
      let rehearsalReason = null;
      for (const item of this.rehearsalWordsList) {
        const itemClean = cleanWord(typeof item === 'string' ? item : item.clean || item.word);
        if (itemClean === clean) {
          rehearsalReason = typeof item === 'object' && item.reason ? item.reason.toLowerCase() : 'stumbled';
          break;
        }
      }

      if (rehearsalReason) {
        let isRehearsal = true;
        if (this.syncPrompterWithFilter && this.rehearsalFilter !== 'all') {
          isRehearsal = (rehearsalReason === this.rehearsalFilter);
        }
        if (isRehearsal) {
          return {
            isDifficult: false,
            isRehearsal: true,
            reason: rehearsalReason,
            classes: `prompter-word-difficult style-${this.difficultStyle} prompter-word-rehearsal prompter-word-rehearsal-${rehearsalReason}`,
          };
        }
      }

      return { isDifficult: false, isRehearsal: false, reason: null, classes: '' };
    }

    // ---- DOM UI Integration --------------------------------------------------

    updateCountBadge(countBadgeEl = (this.elements && this.elements.diffCountBadge)) {
      if (!countBadgeEl) return;
      const diffCount = this.difficultWordsList.length;
      const rehCount = this.rehearsalWordsList.length;
      if (diffCount > 0 && rehCount > 0) {
        countBadgeEl.textContent = `${diffCount} diff · ${rehCount} fumbled`;
      } else if (rehCount > 0) {
        countBadgeEl.textContent = `${rehCount} ${rehCount === 1 ? 'fumble' : 'fumbles'}`;
      } else {
        countBadgeEl.textContent = `${diffCount} ${diffCount === 1 ? 'word' : 'words'}`;
      }
    }

    applyColorStyles(
      previewEl = (this.elements && this.elements.previewEl),
      swatchesContainer = (this.elements && this.elements.colorSwatches),
      pickerEl = (this.elements && this.elements.colorPicker),
      radios = (this.elements && this.elements.styleRadios)
    ) {
      if (typeof document !== 'undefined' && document.documentElement) {
        document.documentElement.style.setProperty('--difficult-color', this.difficultColor);
        document.documentElement.style.setProperty('--difficult-bg', hexToRgba(this.difficultColor, 0.22));
        document.documentElement.style.setProperty('--difficult-border', hexToRgba(this.difficultColor, 0.55));
      }

      if (previewEl) {
        previewEl.className = `prompter-word prompter-word-difficult style-${this.difficultStyle}`;
      }

      if (swatchesContainer) {
        const swatches = swatchesContainer.querySelectorAll('.color-swatch');
        swatches.forEach((sw) => {
          const col = sw.getAttribute('data-color');
          if (col && col.toLowerCase() === this.difficultColor.toLowerCase()) {
            sw.classList.add('active-swatch');
          } else {
            sw.classList.remove('active-swatch');
          }
        });
      }

      if (pickerEl && pickerEl.value.toLowerCase() !== this.difficultColor.toLowerCase()) {
        pickerEl.value = this.difficultColor;
      }

      if (radios) {
        radios.forEach((r) => {
          if (r.value === this.difficultStyle) r.checked = true;
        });
      }
    }

    renderDifficultTags(
      tagsListEl = (this.elements && this.elements.difficultTagsList),
      wordsCountEl = (this.elements && this.elements.difficultWordsCount)
    ) {
      if (wordsCountEl) wordsCountEl.textContent = String(this.difficultWordsList.length);
      if (!tagsListEl) return;

      if (this.difficultWordsList.length === 0) {
        tagsListEl.innerHTML = '<span class="text-gray-500 italic text-[11px]">No difficult words added yet. Type a word above.</span>';
        return;
      }

      tagsListEl.innerHTML = this.difficultWordsList.map((word, idx) => `
        <span class="difficult-tag-chip">
          <span>${escapeHtml(word)}</span>
          <button type="button" class="remove-btn" data-idx="${idx}" title="Remove word">×</button>
        </span>
      `).join('');
    }

    renderRehearsalTags(
      tagsListEl = (this.elements && this.elements.rehearsalTagsList),
      wordsCountEl = (this.elements && this.elements.rehearsalWordsCount),
      countElements = (this.elements && this.elements.filterCounts) || {},
      filterGroupEl = (this.elements && this.elements.rehearsalFilterGroup),
      clearBtnEl = (this.elements && this.elements.btnClearRehearsal)
    ) {
      if (wordsCountEl) wordsCountEl.textContent = String(this.rehearsalWordsList.length);
      const counts = this.getCounts();

      if (countElements.all) countElements.all.textContent = String(counts.all);
      if (countElements.skipped) countElements.skipped.textContent = String(counts.skipped);
      if (countElements.stumbled) countElements.stumbled.textContent = String(counts.stumbled);
      if (countElements.repeated) countElements.repeated.textContent = String(counts.repeated);

      if (filterGroupEl) {
        filterGroupEl.querySelectorAll('.rehearsal-filter-btn').forEach((btn) => {
          if (btn.getAttribute('data-filter') === this.rehearsalFilter) {
            btn.classList.add('active');
          } else {
            btn.classList.remove('active');
          }
        });
      }

      if (clearBtnEl) {
        if (this.rehearsalFilter === 'all') {
          clearBtnEl.textContent = 'Clear rehearsal fumbles';
          clearBtnEl.disabled = this.rehearsalWordsList.length === 0;
        } else {
          const matchCount = counts[this.rehearsalFilter] || 0;
          clearBtnEl.textContent = `Clear ${this.rehearsalFilter} (${matchCount})`;
          clearBtnEl.disabled = matchCount === 0;
        }
      }

      const clearHighlightsEl = (this.elements && this.elements.btnClearHighlights);
      if (clearHighlightsEl) {
        const hasFumbles = this.rehearsalWordsList.length > 0;
        clearHighlightsEl.disabled = !hasFumbles;
        if (hasFumbles) {
          clearHighlightsEl.classList.remove('opacity-30', 'cursor-not-allowed');
          clearHighlightsEl.classList.add('cursor-pointer');
        } else {
          clearHighlightsEl.classList.add('opacity-30', 'cursor-not-allowed');
          clearHighlightsEl.classList.remove('cursor-pointer');
        }
      }

      if (!tagsListEl) return;
      if (this.rehearsalWordsList.length === 0) {
        tagsListEl.innerHTML = '<span class="text-gray-500 italic text-[11px]">No trial fumbles detected yet. Run "Rehearse" to trial-test your script.</span>';
        return;
      }

      const indexedList = this.rehearsalWordsList.map((item, originalIdx) => ({ item, originalIdx }));
      const filtered = this.rehearsalFilter === 'all'
        ? indexedList
        : indexedList.filter(({ item }) => {
            const r = (typeof item === 'object' && item.reason ? item.reason : 'stumbled').toLowerCase();
            return r === this.rehearsalFilter;
          });

      if (filtered.length === 0) {
        tagsListEl.innerHTML = `<span class="text-gray-500 italic text-[11px]">No ${escapeHtml(this.rehearsalFilter)} fumbles found.</span>`;
        return;
      }

      tagsListEl.innerHTML = filtered.map(({ item, originalIdx }) => {
        const word = typeof item === 'string' ? item : (item.word || item.clean);
        const reason = typeof item === 'object' && item.reason ? item.reason : 'stumbled';
        const reasonLabel = reason === 'skipped' ? 'Skipped' : reason === 'repeated' ? 'Repeated' : 'Stumbled';
        const badgeClass = `rehearsal-badge rehearsal-badge-${reason === 'repeated' ? 'repeated' : reason === 'skipped' ? 'skipped' : 'stumbled'}`;
        return `
          <span class="rehearsal-tag-chip">
            <span>${escapeHtml(word)}</span>
            <span class="${badgeClass}">${reasonLabel}</span>
            <button type="button" class="keep-btn" data-idx="${originalIdx}" title="Keep permanently as difficult word">+ Keep</button>
            <button type="button" class="remove-btn" data-idx="${originalIdx}" title="Remove this specific fumble">×</button>
          </span>
        `;
      }).join('');
    }

    updateUI() {
      if (!this.elements) return;
      const el = this.elements;
      this.applyColorStyles(el.previewEl, el.colorSwatches, el.colorPicker, el.styleRadios);
      this.renderDifficultTags(el.difficultTagsList, el.difficultWordsCount);
      this.renderRehearsalTags(el.rehearsalTagsList, el.rehearsalWordsCount, el.filterCounts, el.rehearsalFilterGroup, el.btnClearRehearsal);
      this.updateCountBadge(el.diffCountBadge);
    }

    isOpen() {
      return Boolean(this.elements && this.elements.modalEl && !this.elements.modalEl.classList.contains('hidden'));
    }

    openModal() {
      if (!this.elements || !this.elements.modalEl) return;
      this.updateUI();
      this.elements.modalEl.classList.remove('hidden');
      if (this.elements.inputWord) {
        setTimeout(() => this.elements.inputWord.focus(), 50);
      }
    }

    open() {
      this.openModal();
    }

    closeModal() {
      if (!this.elements || !this.elements.modalEl) return;
      this.elements.modalEl.classList.add('hidden');
      if (this.elements.batchContainer) this.elements.batchContainer.classList.add('hidden');
      if (this.elements.inputWord) this.elements.inputWord.value = '';
      if (this.elements.textareaBatch) this.elements.textareaBatch.value = '';
    }

    close() {
      this.closeModal();
    }

    showToast(msg = 'Saved & Applied ✓', durationMs = 1800) {
      if (this.toastFn) {
        this.toastFn(msg, durationMs);
        return;
      }
      const el = this.elements && this.elements.toastEl;
      if (!el) return;
      el.textContent = msg;
      el.classList.remove('opacity-0');
      el.classList.add('opacity-100');
      if (this._toastTimer) clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => {
        el.classList.remove('opacity-100');
        el.classList.add('opacity-0');
      }, durationMs);
    }

    bindUI(elements = {}, options = {}) {
      const doc = typeof document !== 'undefined' ? document : null;
      const get = (id) => (doc ? doc.getElementById(id) : null);

      this.elements = {
        diffCountBadge: elements.diffCountBadge !== undefined ? elements.diffCountBadge : get('difficult-count-badge'),
        modalEl: elements.modalEl !== undefined ? elements.modalEl : (elements.modalDifficultWords !== undefined ? elements.modalDifficultWords : get('modal-difficult-words')),
        btnOpen: elements.btnOpen !== undefined ? elements.btnOpen : (elements.btnOpenDifficultWords !== undefined ? elements.btnOpenDifficultWords : get('btn-open-difficult-words')),
        btnClose: elements.btnClose !== undefined ? elements.btnClose : (elements.btnCloseDifficultWords !== undefined ? elements.btnCloseDifficultWords : get('btn-close-difficult-words')),
        btnSave: elements.btnSave !== undefined ? elements.btnSave : (elements.btnSaveDifficultWords !== undefined ? elements.btnSaveDifficultWords : get('btn-save-difficult-words')),
        inputWord: elements.inputWord !== undefined ? elements.inputWord : (elements.inputDifficultWord !== undefined ? elements.inputDifficultWord : get('input-difficult-word')),
        btnAdd: elements.btnAdd !== undefined ? elements.btnAdd : (elements.btnAddDifficultWord !== undefined ? elements.btnAddDifficultWord : get('btn-add-difficult-word')),
        btnClearDifficult: elements.btnClearDifficult !== undefined ? elements.btnClearDifficult : (elements.btnClearDifficultWords !== undefined ? elements.btnClearDifficultWords : get('btn-clear-difficult-words')),
        btnToggleBatch: elements.btnToggleBatch !== undefined ? elements.btnToggleBatch : (elements.btnToggleBatchWords !== undefined ? elements.btnToggleBatchWords : get('btn-toggle-batch-words')),
        batchContainer: elements.batchContainer !== undefined ? elements.batchContainer : (elements.batchWordsContainer !== undefined ? elements.batchWordsContainer : get('batch-words-container')),
        textareaBatch: elements.textareaBatch !== undefined ? elements.textareaBatch : (elements.textareaBatchWords !== undefined ? elements.textareaBatchWords : get('textarea-batch-words')),
        btnImportBatch: elements.btnImportBatch !== undefined ? elements.btnImportBatch : (elements.btnImportBatchWords !== undefined ? elements.btnImportBatchWords : get('btn-import-batch-words')),
        colorPicker: elements.colorPicker !== undefined ? elements.colorPicker : (elements.pickerDifficultColor !== undefined ? elements.pickerDifficultColor : get('picker-difficult-color')),
        colorSwatches: elements.colorSwatches !== undefined ? elements.colorSwatches : (elements.colorSwatchesContainer !== undefined ? elements.colorSwatchesContainer : get('color-swatches-container')),
        btnClearHighlights: elements.btnClearHighlights !== undefined ? elements.btnClearHighlights : (elements.btnClearHighlightsBtn !== undefined ? elements.btnClearHighlightsBtn : get('btn-clear-highlights')),
        btnClearRehearsal: elements.btnClearRehearsal !== undefined ? elements.btnClearRehearsal : (elements.btnClearRehearsalWords !== undefined ? elements.btnClearRehearsalWords : get('btn-clear-rehearsal-words')),
        rehearsalFilterGroup: elements.rehearsalFilterGroup !== undefined ? elements.rehearsalFilterGroup : get('rehearsal-filter-group'),
        checkboxFilterPrompter: elements.checkboxFilterPrompter !== undefined ? elements.checkboxFilterPrompter : get('checkbox-filter-prompter'),
        difficultTagsList: elements.difficultTagsList !== undefined ? elements.difficultTagsList : get('difficult-tags-list'),
        rehearsalTagsList: elements.rehearsalTagsList !== undefined ? elements.rehearsalTagsList : get('rehearsal-tags-list'),
        difficultWordsCount: elements.difficultWordsCount !== undefined ? elements.difficultWordsCount : get('difficult-words-count'),
        rehearsalWordsCount: elements.rehearsalWordsCount !== undefined ? elements.rehearsalWordsCount : get('rehearsal-words-count'),
        previewEl: elements.previewEl !== undefined ? elements.previewEl : (elements.difficultPreviewEl !== undefined ? elements.difficultPreviewEl : get('difficult-word-preview')),
        styleRadios: elements.styleRadios !== undefined ? elements.styleRadios : (elements.difficultStyleRadios !== undefined ? elements.difficultStyleRadios : (doc ? doc.querySelectorAll('input[name="difficult-style"]') : null)),
        toastEl: elements.toastEl !== undefined ? elements.toastEl : (elements.difficultModalStatus !== undefined ? elements.difficultModalStatus : get('difficult-modal-status')),
        filterCounts: elements.filterCounts || {
          all: get('filter-count-all'),
          skipped: get('filter-count-skipped'),
          stumbled: get('filter-count-stumbled'),
          repeated: get('filter-count-repeated'),
        },
      };

      this.toastFn = typeof options.onToast === 'function' ? options.onToast : null;

      if (this.elements.checkboxFilterPrompter) {
        this.elements.checkboxFilterPrompter.checked = this.syncPrompterWithFilter;
      }

      this._initUIEventListeners();
      this.updateUI();
      return this;
    }

    _initUIEventListeners() {
      const el = this.elements;
      if (!el) return;

      if (el.btnOpen) {
        el.btnOpen.addEventListener('click', () => this.openModal());
      }
      if (el.btnClose) {
        el.btnClose.addEventListener('click', () => this.closeModal());
      }
      if (el.btnSave) {
        el.btnSave.addEventListener('click', () => {
          if (el.inputWord && el.inputWord.value.trim()) {
            this.addDifficultWord(el.inputWord.value.trim());
            el.inputWord.value = '';
          }
          this.closeModal();
        });
      }
      if (el.modalEl) {
        el.modalEl.addEventListener('click', (e) => {
          if (e.target === el.modalEl) this.closeModal();
        });
      }
      if (el.btnAdd && el.inputWord) {
        el.btnAdd.addEventListener('click', () => {
          if (this.addDifficultWord(el.inputWord.value.trim())) {
            this.showToast('Word added ✓');
          }
          el.inputWord.value = '';
          el.inputWord.focus();
        });
        el.inputWord.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (this.addDifficultWord(el.inputWord.value.trim())) {
              this.showToast('Word added ✓');
            }
            el.inputWord.value = '';
          }
        });
      }
      if (el.btnToggleBatch && el.batchContainer) {
        el.btnToggleBatch.addEventListener('click', () => {
          el.batchContainer.classList.toggle('hidden');
          if (!el.batchContainer.classList.contains('hidden') && el.textareaBatch) {
            el.textareaBatch.focus();
          }
        });
      }
      if (el.btnImportBatch && el.textareaBatch) {
        el.btnImportBatch.addEventListener('click', () => {
          if (this.addDifficultWord(el.textareaBatch.value)) {
            this.showToast('Batch words imported ✓');
          }
          el.textareaBatch.value = '';
          if (el.batchContainer) el.batchContainer.classList.add('hidden');
        });
      }
      if (el.btnClearDifficult) {
        el.btnClearDifficult.addEventListener('click', () => {
          if (this.difficultWordsList.length === 0) return;
          this.clearDifficultWords();
          this.showToast('Cleared all words');
        });
      }
      if (el.btnClearRehearsal) {
        el.btnClearRehearsal.addEventListener('click', () => {
          if (this.rehearsalWordsList.length === 0) return;
          const filter = this.rehearsalFilter;
          const removed = this.clearRehearsalWords(filter);
          if (removed > 0) {
            if (filter === 'all') {
              this.showToast('Cleared rehearsal fumbles ✓');
            } else {
              this.showToast(`Cleared ${removed} ${filter} fumble${removed === 1 ? '' : 's'} ✓`);
            }
          }
        });
      }
      if (el.btnClearHighlights) {
        el.btnClearHighlights.addEventListener('click', () => {
          if (this.rehearsalWordsList.length === 0) return;
          const removed = this.clearRehearsalWords('all');
          if (removed > 0) {
            this.showToast(`Cleared ${removed} rehearsal fumble${removed === 1 ? '' : 's'} ✓`);
          }
        });
      }
      if (el.rehearsalFilterGroup) {
        el.rehearsalFilterGroup.addEventListener('click', (e) => {
          const btn = e.target.closest('.rehearsal-filter-btn');
          if (!btn) return;
          const filter = btn.getAttribute('data-filter');
          if (filter) {
            this.setFilter(filter);
            this.renderRehearsalTags();
          }
        });
      }
      if (el.checkboxFilterPrompter) {
        el.checkboxFilterPrompter.addEventListener('change', (e) => {
          this.setSyncPrompterWithFilter(e.target.checked);
        });
      }
      if (el.difficultTagsList) {
        el.difficultTagsList.addEventListener('click', (e) => {
          const btn = e.target.closest('.remove-btn');
          if (!btn) return;
          const idx = parseInt(btn.getAttribute('data-idx'), 10);
          if (!isNaN(idx)) {
            this.removeDifficultWord(idx);
          }
        });
      }
      if (el.rehearsalTagsList) {
        el.rehearsalTagsList.addEventListener('click', (e) => {
          const removeBtn = e.target.closest('.remove-btn');
          if (removeBtn) {
            const idx = parseInt(removeBtn.getAttribute('data-idx'), 10);
            if (!isNaN(idx)) {
              this.removeRehearsalWord(idx);
              this.showToast('Fumbled word removed ✓');
            }
            return;
          }
          const keepBtn = e.target.closest('.keep-btn');
          if (keepBtn) {
            const idx = parseInt(keepBtn.getAttribute('data-idx'), 10);
            if (!isNaN(idx)) {
              this.promoteToDifficult(idx);
              this.showToast('Saved to Configured Difficult Words ✓');
            }
          }
        });
      }
      if (el.colorSwatches) {
        el.colorSwatches.addEventListener('click', (e) => {
          const swatch = e.target.closest('.color-swatch');
          if (!swatch) return;
          const col = swatch.getAttribute('data-color');
          if (col) {
            this.setColor(col);
            this.showToast('Color updated ✓');
          }
        });
      }
      if (el.colorPicker) {
        el.colorPicker.addEventListener('input', (e) => {
          this.setColor(e.target.value);
        });
      }
      if (el.styleRadios) {
        el.styleRadios.forEach((radio) => {
          radio.addEventListener('change', (e) => {
            this.setStyle(e.target.value);
            this.showToast('Style updated ✓');
          });
        });
      }
    }
  }

  return {
    RehearsalCues,
    cleanWord,
    escapeHtml,
    hexToRgba,
  };
});
