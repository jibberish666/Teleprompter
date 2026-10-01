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
      this._sections = sections || [];
      this._normalizeSections();
      this._getElapsedSec = typeof getElapsedSec === 'function' ? getElapsedSec : () => 0;
      this._onActiveSectionChange = typeof options.onActiveSectionChange === 'function' ? options.onActiveSectionChange : null;
      this._minDwellSec = typeof options.minDwellSec === 'number' ? options.minDwellSec : 2.0;
      this._activeId = null;
    }

    _normalizeSections() {
      if (Array.isArray(this._sections)) {
        for (const s of this._sections) {
          if (s.startSec === undefined) s.startSec = null;
          if (s.endSec === undefined) s.endSec = null;
        }
      }
    }

    /**
     * Updates sections reference.
     */
    setSections(sections) {
      this._sections = sections || [];
      this._normalizeSections();
    }

    /**
     * Estimates startSec for a section, taking cadence lookback into account if boundary words were missed.
     */
    _estimateStartSec(cur, word, nowSec) {
      if (!cur) return Math.max(0, nowSec - 0.1);
      const curIdx = this._sections.indexOf(cur);
      const prev = curIdx > 0 ? this._sections[curIdx - 1] : null;

      const hasMissed = cur.startIndex !== null && cur.startIndex !== undefined &&
        word && word.globalIdx !== null && word.globalIdx !== undefined &&
        word.globalIdx > cur.startIndex;

      let estStart;
      if (hasMissed) {
        const missedWords = word.globalIdx - cur.startIndex;
        // ~140 WPM => ~400ms (0.4s) per word
        const lookbackSec = missedWords * 0.4;
        estStart = Math.max(0, nowSec - lookbackSec);
      } else {
        estStart = Math.max(0, nowSec - 0.1);
      }

      // Anchored cleanly after previous section's end
      if (prev && prev.endSec !== null && prev.endSec !== undefined && !isNaN(Number(prev.endSec))) {
        estStart = Math.max(Number(prev.endSec), estStart);
      }
      return estStart;
    }

    /**
     * Called on each word progression during session.
     * Tracks boundary transitions and stamps startSec / endSec.
     */
    wordSeen(word, isSessionActive = true, force = false) {
      if (!word) return;
      const secId = word.sectionId;
      if (!secId) return;

      const nowSec = Math.max(0, Number(this._getElapsedSec()) || 0);

      if (secId !== this._activeId) {
        // Minimum section dwell guard:
        // Prevent accidental/false-positive micro-take transitions from voice progression
        // unless forced (e.g. manual navigation/seek) or the section has met the dwell threshold.
        if (!force && this._activeId && isSessionActive) {
          const prev = this._sections.find((s) => s.id === this._activeId);
          if (prev && prev.startSec !== null) {
            const dwellSec = nowSec - prev.startSec;
            const prevWordCount = (prev.endIndex !== null && prev.startIndex !== null)
              ? (prev.endIndex - prev.startIndex + 1)
              : 0;
            const minRequired = Math.min(this._minDwellSec, Math.max(0.5, prevWordCount * 0.25));
            if (dwellSec < minRequired) {
              return;
            }
          }
        }

        const cur = this._sections.find((s) => s.id === secId);
        const hasMissed = cur && cur.startIndex !== null && cur.startIndex !== undefined &&
          word && word.globalIdx !== null && word.globalIdx !== undefined &&
          word.globalIdx > cur.startIndex;

        let curStartSec = null;
        if (cur && isSessionActive && cur.startSec === null) {
          curStartSec = this._estimateStartSec(cur, word, nowSec);
        }

        // Close previously active section
        if (this._activeId && isSessionActive) {
          const prev = this._sections.find((s) => s.id === this._activeId);
          if (prev && prev.startSec !== null && prev.endSec === null) {
            if (hasMissed && curStartSec !== null && curStartSec < nowSec) {
              prev.endSec = Math.max(prev.startSec || 0, curStartSec);
            } else {
              prev.endSec = nowSec;
            }
          }
        }

        this._activeId = secId;

        // Open newly active section
        if (cur && isSessionActive && cur.startSec === null) {
          cur.startSec = curStartSec !== null ? curStartSec : this._estimateStartSec(cur, word, nowSec);
        }

        if (this._onActiveSectionChange && cur) {
          this._onActiveSectionChange(cur);
        }
      } else if (isSessionActive) {
        // Same section — ensure startSec is initialized
        const cur = this._sections.find((s) => s.id === secId);
        if (cur && cur.startSec === null) {
          cur.startSec = this._estimateStartSec(cur, word, nowSec);
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
     * Resolves and reconciles section boundaries before take slicing.
     * Any section that was reached or has elapsed time unaccounted for after Section 1
     * automatically resolves its startSec to the previous section's endSec.
     *
     * @param {number} [totalDuration] - Total duration of the recording session in seconds
     * @returns {Array<Object>} Reconciled section descriptors
     */
    resolveBoundaries(totalDuration) {
      const dur = (totalDuration !== undefined && !isNaN(Number(totalDuration)))
        ? Math.max(0, Number(totalDuration))
        : Math.max(0, Number(this._getElapsedSec()) || 0);

      if (!this._sections || this._sections.length === 0) {
        return [];
      }

      // Close active section if still open
      if (this._activeId) {
        this.close(dur);
      }

      for (let i = 1; i < this._sections.length; i++) {
        const sec = this._sections[i];
        const prev = this._sections[i - 1];
        const prevEnd = (prev && prev.endSec !== null && !isNaN(Number(prev.endSec)))
          ? Number(prev.endSec)
          : null;

        if (sec.startSec === null && prevEnd !== null) {
          const hasUnaccountedTime = dur > prevEnd;
          const wasReached = this._activeId === sec.id;

          if (wasReached || hasUnaccountedTime) {
            sec.startSec = prevEnd;
            if (sec.endSec === null) {
              // Calculate proportional slice of remaining unaccounted duration
              let unstartedCount = 0;
              for (let k = i; k < this._sections.length; k++) {
                if (this._sections[k].endSec === null) unstartedCount++;
              }
              const remainingTime = Math.max(0, dur - prevEnd);
              const slice = unstartedCount > 0 ? (remainingTime / unstartedCount) : remainingTime;
              sec.endSec = Math.min(dur, prevEnd + slice);
            }
          }
        }
      }

      return this._sections;
    }

    /**
     * Returns section markers array for take splitting.
     */
    getSectionMarkers(totalDuration) {
      if (totalDuration !== undefined) {
        this.resolveBoundaries(totalDuration);
      }
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
