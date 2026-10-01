/**
 * TeleprompterTimeline - Section Timeline & Retake Navigation Subsystem.
 *
 * Encapsulates:
 * 1. Wall-clock elapsed timestamp tracking for script sections.
 * 2. Active section transitions and boundary cuts (startSec, endSec).
 * 3. Section retake state machine and rewind seek index calculations.
 * 4. Marker export for audio/video take slicing.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    // Node.js / CommonJS
    module.exports = factory(root);
  } else {
    // Browser global
    root.TeleprompterTimeline = factory(root);
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';

  class SectionTimeline {
    /**
     * @param {Array<Object>} sections - Array of section descriptor objects:
     *   { id, title, startIndex, lineIdx, startSec, endSec }
     * @param {Function} getElapsedSec - Function returning elapsed seconds from session start.
     * @param {Object} [options]
     * @param {Function} [options.onActiveSectionChange] - Callback invoked when the active section changes: (section) => void
     */
    constructor(sections = [], getElapsedSec = () => 0, options = {}) {
      this._sections = sections;
      this._getElapsedSec = typeof getElapsedSec === 'function' ? getElapsedSec : () => 0;
      this._onActiveSectionChange = typeof options.onActiveSectionChange === 'function' ? options.onActiveSectionChange : null;
      this._activeId = null;
    }

    /**
     * Updates sections reference.
     */
    setSections(sections) {
      this._sections = sections || [];
    }

    /**
     * Called on each word progression during session.
     * Tracks boundary transitions and stamps startSec / endSec.
     */
    wordSeen(word, isSessionActive = true) {
      if (!word) return;
      const secId = word.sectionId;
      if (!secId) return;

      const nowSec = Math.max(0, Number(this._getElapsedSec()) || 0);

      if (secId !== this._activeId) {
        // Close previously active section
        if (this._activeId && isSessionActive) {
          const prev = this._sections.find((s) => s.id === this._activeId);
          if (prev && prev.startSec !== null && prev.endSec === null) {
            prev.endSec = nowSec;
          }
        }

        this._activeId = secId;

        // Open newly active section
        const cur = this._sections.find((s) => s.id === secId);
        if (cur && isSessionActive && cur.startSec === null) {
          cur.startSec = Math.max(0, nowSec - 0.1);
        }

        if (this._onActiveSectionChange && cur) {
          this._onActiveSectionChange(cur);
        }
      } else if (isSessionActive) {
        // Same section — ensure startSec is initialized
        const cur = this._sections.find((s) => s.id === secId);
        if (cur && cur.startSec === null) {
          cur.startSec = Math.max(0, nowSec - 0.1);
        }
      }
    }

    /**
     * Resets timestamps for the current section (or first section) and yields rewind seek target.
     * @returns {{ seekIndex: number, title: string, id: string } | null}
     */
    retake() {
      const target = this._sections.find((s) => s.id === this._activeId) || this._sections[0];
      if (!target || target.startIndex === null || target.startIndex === undefined) {
        return null;
      }
      target.startSec = null;
      target.endSec = null;
      return {
        seekIndex: target.startIndex,
        title: target.title || '',
        id: target.id,
      };
    }

    /**
     * Closes the active section at the given elapsed second.
     */
    close(nowSec) {
      if (!this._activeId) return;
      const sec = this._sections.find((s) => s.id === this._activeId);
      const closeSec = nowSec !== undefined ? Number(nowSec) : Math.max(0, Number(this._getElapsedSec()) || 0);
      if (sec && sec.startSec !== null && sec.endSec === null) {
        sec.endSec = closeSec;
      }
      this._activeId = null;
    }

    /**
     * Returns section markers array for take splitting.
     */
    getSectionMarkers() {
      return this._sections;
    }

    /**
     * Resets all timestamps on all sections (called at session start).
     */
    reset(activeId = null) {
      this._sections.forEach((s) => {
        s.startSec = null;
        s.endSec = null;
      });
      this._activeId = activeId || null;
      if (this._onActiveSectionChange && this._activeId) {
        const cur = this._sections.find((s) => s.id === this._activeId);
        if (cur) this._onActiveSectionChange(cur);
      }
    }

    get activeId() {
      return this._activeId;
    }

    set activeId(id) {
      this._activeId = id;
    }

    get activeSection() {
      return this._sections.find((s) => s.id === this._activeId) || null;
    }
  }

  return {
    SectionTimeline,
  };
});
