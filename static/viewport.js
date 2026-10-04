/**
 * TeleprompterViewport - Prompter Display, Geometry & Scrolling Engine.
 *
 * Encapsulates:
 * 1. Typography and line-height geometry calculations.
 * 2. Viewport window sizing, cursor bar positioning, and prompter line height CSS variables.
 * 3. Script token HTML generation with cues integration.
 * 4. Active word and line highlight state machine (active, upcoming, past).
 * 5. Smooth translateY transform scroll calculations.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    // Node.js / CommonJS
    module.exports = factory(root);
  } else {
    // Browser global
    root.TeleprompterViewport = factory(root);
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';

  /**
   * Calculates responsive line height based on typography font size (~1.4 ratio).
   * Ensures a minimum line height of 28px.
   */
  function getLineHeightForFontSize(fontSize) {
    const size = (fontSize !== undefined && fontSize !== null && !isNaN(Number(fontSize))) ? Number(fontSize) : 36;
    return Math.max(28, Math.round(size * 1.4));
  }

  /**
   * Computes the translateY CSS offset for a given line index and line height.
   */
  function getScrollTranslateY(lineIndex, lineHeight) {
    const idx = Math.max(0, Number(lineIndex) || 0);
    const lh = Math.max(1, Number(lineHeight) || 36);
    return idx === 0 ? 0 : -(idx * lh);
  }

  /**
   * Generates HTML markup for prompter lines and words with cues styling.
   *
   * @param {Array<Object>} linesData - Array of line objects containing words, section headers, or blank markers.
   * @param {Object} [cues] - Optional cues manager exposing getCue(wordOriginal).
   * @returns {string} HTML string
   */
  function renderLinesHTML(linesData, cues) {
    if (!Array.isArray(linesData) || linesData.length === 0) {
      return '<p class="prompter-line text-gray-400 italic">Paste script & press Start Session...</p>';
    }

    return linesData.map((line) => {
      if (line.isSectionHeader) {
        return `<div id="line-${line.lineIdx}" class="prompter-line prompter-line-section select-none"><span class="prompter-section-pill">[${line.sectionTitle}]</span></div>`;
      }
      if (line.isBlank) {
        return `<div id="line-${line.lineIdx}" class="prompter-line prompter-line-blank select-none"><span class="inline-block w-8 h-[2px] bg-indigo-400/50 rounded-full"></span></div>`;
      }

      const wordsHTML = (line.words || [])
        .map((w) => {
          let extraClasses = '';
          if (cues && typeof cues.getCue === 'function') {
            const cue = cues.getCue(w.original);
            if (cue && cue.classes) {
              extraClasses = ` ${cue.classes}`;
            }
          }
          return `<span id="w-${w.globalIdx}" class="prompter-word${extraClasses}">${w.original}</span>`;
        })
        .join(' ');

      return `<div id="line-${line.lineIdx}" class="prompter-line line-upcoming">${wordsHTML}</div>`;
    }).join('');
  }

  class PrompterViewport {
    /**
     * @param {Object} options
     * @param {HTMLElement} [options.linesContainer] - DOM element containing rendered prompter lines
     * @param {HTMLElement} [options.scrollingContent] - Scrollable container moved via translateY
     * @param {HTMLElement} [options.viewingWindow] - Fixed height window bounding the visible lines
     * @param {HTMLElement} [options.cursorBar] - Highlight bar positioned behind the active reading line
     * @param {number} [options.initialFontSize=25]
     * @param {number} [options.activeLineOffset=1] - 0-indexed line position of the reading cursor (1 = 2nd line)
     */
    constructor(options = {}) {
      this.linesContainer = options.linesContainer || null;
      this.scrollingContent = options.scrollingContent || null;
      this.viewingWindow = options.viewingWindow || null;
      this.cursorBar = options.cursorBar || null;

      this.activeLineOffset = options.activeLineOffset !== undefined ? options.activeLineOffset : 1;
      this.fontSize = options.initialFontSize || 36;
      this.lineHeight = getLineHeightForFontSize(this.fontSize);
      this.currentLineIndex = 0;
      this.currentWordIndex = 0;
      this.fontFamily = options.initialFontFamily || 'open-sans';
      if (this.linesContainer && this.fontFamily) {
        this.setFontFamily(this.fontFamily);
      }
      this.fontWeight = options.initialFontWeight || 500;
      if (this.linesContainer && this.fontWeight) {
        this.setFontWeight(this.fontWeight);
      }
    }

    /**
     * Updates font family for rendered prompter lines.
     */
    setFontFamily(fontId) {
      this.fontFamily = fontId || 'open-sans';
      if (this.linesContainer && this.linesContainer.classList) {
        for (const cls of Array.from(this.linesContainer.classList)) {
          if (cls.startsWith('font-teleprompter-')) {
            this.linesContainer.classList.remove(cls);
          }
        }
        this.linesContainer.classList.add(`font-teleprompter-${this.fontFamily}`);
      }
      return this.fontFamily;
    }

    /**
     * Updates font weight for rendered prompter lines.
     */
    setFontWeight(weight) {
      const w = Number(weight) || 500;
      this.fontWeight = w;
      if (this.linesContainer && this.linesContainer.style) {
        this.linesContainer.style.fontWeight = String(w);
      }
      return this.fontWeight;
    }

    /**
     * Updates font size, recalculates geometry, and repositions scroll offset.
     */
    setFontSize(fontSize, numLines = 3) {
      this.fontSize = Number(fontSize) || 36;
      this.lineHeight = getLineHeightForFontSize(this.fontSize);

      if (this.linesContainer) {
        this.linesContainer.style.fontSize = `${this.fontSize}px`;
      }

      this.updateViewportLines(numLines);
      this.scrollToLine(this.currentLineIndex);
      return this.lineHeight;
    }

    /**
     * Sets prompter window geometry based on visible line count.
     */
    updateViewportLines(numLines) {
      const n = Math.max(1, Number(numLines) || 3);
      const lh = this.lineHeight;

      if (typeof document !== 'undefined' && document.documentElement) {
        document.documentElement.style.setProperty('--prompter-line-height', `${lh}px`);
      }
      if (this.viewingWindow) {
        this.viewingWindow.style.height = `${n * lh}px`;
      }
      if (this.cursorBar) {
        this.cursorBar.style.top = `${this.activeLineOffset * lh}px`;
        this.cursorBar.style.height = `${lh}px`;
      }
      if (this.scrollingContent) {
        this.scrollingContent.style.paddingTop = `${this.activeLineOffset * lh}px`;
      }
    }

    /**
     * Smoothly scrolls the content container to align the given line index with the cursor bar.
     */
    scrollToLine(lineIndex) {
      this.currentLineIndex = Math.max(0, Number(lineIndex) || 0);
      const translateY = getScrollTranslateY(this.currentLineIndex, this.lineHeight);
      if (this.scrollingContent) {
        this.scrollingContent.style.transform = `translateY(${translateY}px)`;
      }
      return translateY;
    }

    /**
     * Renders script lines into the linesContainer.
     */
    renderScript(linesData, cues) {
      const html = renderLinesHTML(linesData, cues);
      if (this.linesContainer) {
        this.linesContainer.innerHTML = html;
      }
      this.currentWordIndex = 0;
      this.currentLineIndex = 0;
      return html;
    }

    /**
     * Updates active word highlight and adjusts line classes (active, upcoming, past).
     *
     * @param {number} wordIndex - Global word index
     * @param {Array<Object>} allWords - Array of word descriptors with globalIdx and lineIdx
     * @returns {{ activeWordObj: Object|null, lineIdx: number }}
     */
    highlightWord(wordIndex, allWords = []) {
      if (!Array.isArray(allWords) || allWords.length === 0) {
        return { activeWordObj: null, lineIdx: 0 };
      }

      const activeWordObj = allWords[wordIndex];
      if (!activeWordObj) {
        return { activeWordObj: null, lineIdx: this.currentLineIndex };
      }

      this.currentWordIndex = wordIndex;
      this.currentLineIndex = activeWordObj.lineIdx;

      if (this.linesContainer) {
        // Clear previous active word
        const oldWord = this.linesContainer.querySelector('.word-active');
        if (oldWord) oldWord.classList.remove('word-active');

        // Highlight new active word
        const wordSpan = (typeof document !== 'undefined') ? document.getElementById(`w-${wordIndex}`) : null;
        if (wordSpan) wordSpan.classList.add('word-active');

        // Update line states
        const allLineDivs = this.linesContainer.querySelectorAll('.prompter-line');
        allLineDivs.forEach((lineEl, idx) => {
          if (idx === this.currentLineIndex) {
            lineEl.classList.remove('line-upcoming', 'line-past');
            lineEl.classList.add('line-active');
          } else if (idx > this.currentLineIndex) {
            lineEl.classList.remove('line-active', 'line-past');
            lineEl.classList.add('line-upcoming');
          } else {
            lineEl.classList.remove('line-active', 'line-upcoming');
            lineEl.classList.add('line-past');
          }
        });
      }

      this.scrollToLine(this.currentLineIndex);

      return {
        activeWordObj,
        lineIdx: this.currentLineIndex,
      };
    }
  }

  return {
    getLineHeightForFontSize,
    getScrollTranslateY,
    renderLinesHTML,
    PrompterViewport,
  };
});
