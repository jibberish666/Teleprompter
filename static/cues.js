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

    updateCountBadge(countBadgeEl) {
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

    applyColorStyles(previewEl, swatchesContainer, pickerEl, radios) {
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

    renderDifficultTags(tagsListEl, wordsCountEl) {
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

    renderRehearsalTags(tagsListEl, wordsCountEl, countElements = {}, filterGroupEl, clearBtnEl) {
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
  }

  return {
    RehearsalCues,
    cleanWord,
    escapeHtml,
    hexToRgba,
  };
});
