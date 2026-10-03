/**
 * Unit tests for TeleprompterTimeline module using Node.js built-in test runner.
 * Run with: node test_timeline.js
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const TimelineModule = require('./static/timeline.js');

describe('TeleprompterTimeline - Section Boundary & Retake State Machine', () => {
  let sampleSections;
  let elapsedSec;
  let timeline;
  let changedSection;

  beforeEach(() => {
    elapsedSec = 0;
    sampleSections = [
      { id: 'sec-1', title: 'Intro', startIndex: 0, lineIdx: 0, startSec: null, endSec: null },
      { id: 'sec-2', title: 'Main Story', startIndex: 50, lineIdx: 10, startSec: null, endSec: null },
      { id: 'sec-3', title: 'Outro', startIndex: 120, lineIdx: 25, startSec: null, endSec: null },
    ];
    changedSection = null;
    timeline = new TimelineModule.SectionTimeline(
      sampleSections,
      () => elapsedSec,
      {
        onActiveSectionChange: (sec) => {
          changedSection = sec;
        },
      }
    );
  });

  test('initializes with inactive state and null timestamps', () => {
    assert.equal(timeline.activeId, null);
    assert.equal(timeline.activeSection, null);
    const markers = timeline.getSectionMarkers();
    assert.equal(markers.length, 3);
    assert.equal(markers[0].startSec, null);
    assert.equal(markers[0].endSec, null);
  });

  test('wordSeen stamps startSec and fires onActiveSectionChange callback', () => {
    elapsedSec = 2.5;
    const word = { sectionId: 'sec-1', original: 'Welcome', globalIdx: 0 };

    timeline.wordSeen(word, true);

    assert.equal(timeline.activeId, 'sec-1');
    assert.equal(changedSection.title, 'Intro');
    assert.equal(sampleSections[0].startSec, 2.4); // 2.5 - 0.1
    assert.equal(sampleSections[0].endSec, null);
  });

  test('section transition closes previous section and opens new section', () => {
    // Start in Sec 1 at t=1.0s
    elapsedSec = 1.0;
    timeline.wordSeen({ sectionId: 'sec-1', original: 'Welcome' }, true);
    assert.equal(sampleSections[0].startSec, 0.9);

    // Transition to Sec 2 at t=10.0s
    elapsedSec = 10.0;
    timeline.wordSeen({ sectionId: 'sec-2', original: 'Next' }, true);

    // Previous section closed
    assert.equal(sampleSections[0].endSec, 10.0);
    // New section opened
    assert.equal(sampleSections[1].startSec, 9.9);
    assert.equal(sampleSections[1].endSec, null);
    assert.equal(timeline.activeId, 'sec-2');
    assert.equal(changedSection.title, 'Main Story');
  });

  test('rejects premature section transitions during early dwell window (< minDwellSec)', () => {
    // Start in Sec 1 at t=1.0s (sec-1 has 50 words: startIndex=0, sec-2 startIndex=50)
    sampleSections[0].endIndex = 49;
    elapsedSec = 1.0;
    timeline.wordSeen({ sectionId: 'sec-1', original: 'Welcome', globalIdx: 0 }, true);
    assert.equal(sampleSections[0].startSec, 0.9);
    assert.equal(timeline.activeId, 'sec-1');

    // Premature wordSeen from sec-2 at t=1.8s (only 0.8s elapsed dwell, minDwellSec is 2.0s)
    elapsedSec = 1.8;
    timeline.wordSeen({ sectionId: 'sec-2', original: 'Spurious', globalIdx: 50 }, true);

    // Section 1 should NOT be closed, and activeId should remain sec-1
    assert.equal(timeline.activeId, 'sec-1');
    assert.equal(sampleSections[0].endSec, null);
    assert.equal(sampleSections[1].startSec, null);

    // Forced transition (manual seek) at t=1.8s DOES transition immediately
    timeline.wordSeen({ sectionId: 'sec-2', original: 'Spurious', globalIdx: 50 }, true, true);
    assert.equal(timeline.activeId, 'sec-2');
    assert.equal(sampleSections[0].endSec, 1.8);
    assert.equal(sampleSections[1].startSec, 1.7);
  });

  test('ignores timestamp mutation when isSessionActive is false', () => {
    elapsedSec = 5.0;
    timeline.wordSeen({ sectionId: 'sec-1', original: 'Test' }, false);

    assert.equal(timeline.activeId, 'sec-1');
    assert.equal(sampleSections[0].startSec, null);
    assert.equal(sampleSections[0].endSec, null);
  });

  test('retake resets timestamps for current section and yields seek target', () => {
    elapsedSec = 15.0;
    timeline.wordSeen({ sectionId: 'sec-2', original: 'Word' }, true);
    sampleSections[1].endSec = 18.0;

    const retakeResult = timeline.retake();

    assert.deepEqual(retakeResult, {
      seekIndex: 50,
      title: 'Main Story',
      id: 'sec-2',
      retakeSec: 15.0,
    });
    // Timestamps reset but retakeSec preserved
    assert.equal(sampleSections[1].startSec, null);
    assert.equal(sampleSections[1].endSec, null);
    assert.equal(sampleSections[1].retakeSec, 15.0);
  });

  test('retake falls back to first section if none active', () => {
    const retakeResult = timeline.retake();
    assert.deepEqual(retakeResult, {
      seekIndex: 0,
      title: 'Intro',
      id: 'sec-1',
      retakeSec: 0,
    });
  });

  test('retake timestamps prevent boundary resolution from pulling back into aborted take', () => {
    // Section 1 completes at t=8.0s
    sampleSections[0].startSec = 0.0;
    sampleSections[0].endSec = 8.0;

    // Retake triggered on Section 2 at t=14.0s
    timeline.activeId = 'sec-2';
    elapsedSec = 14.0;
    timeline.retake();

    // Resolving boundaries for 20s recording must anchor Section 2 start at retakeSec (14.0s), not prevEnd (8.0s)
    const markers = timeline.getSectionMarkers(20.0);
    assert.equal(markers[1].startSec, 14.0);
    assert.ok(markers[1].endSec > 14.0);
  });

  test('retake with explicit section ID transitions activeId and seals previous section', () => {
    // Session in Section 1
    timeline.activeId = 'sec-1';
    sampleSections[0].startSec = 1.0;
    sampleSections[0]._lastSeenSec = 6.5;
    sampleSections[0].endSec = null;

    // Retake invoked targeting Section 2 directly
    const result = timeline.retake(10.0, 'sec-2');

    assert.equal(result.id, 'sec-2');
    assert.equal(result.seekIndex, 50);
    assert.equal(timeline.activeId, 'sec-2');
    assert.equal(sampleSections[0].endSec, 6.5); // Sealed previous section
    assert.equal(sampleSections[1].retakeSec, 10.0);
    assert.equal(changedSection.title, 'Main Story');
  });

  test('retake with word index resolves to the correct enclosing section', () => {
    sampleSections[0].endIndex = 49;
    sampleSections[1].endIndex = 119;
    sampleSections[2].endIndex = 150;

    timeline.activeId = 'sec-1';
    sampleSections[0].startSec = 1.0;

    // Prompter is at word index 65 (inside Section 2: 50..119)
    const result = timeline.retake(12.0, 65);

    assert.equal(result.id, 'sec-2');
    assert.equal(result.seekIndex, 50);
    assert.equal(timeline.activeId, 'sec-2');
    assert.equal(sampleSections[1].retakeSec, 12.0);
  });

  test('close sets endSec for active section and clears activeId', () => {
    elapsedSec = 2.0;
    timeline.wordSeen({ sectionId: 'sec-1', original: 'A' }, true);

    timeline.close(35.5);

    assert.equal(sampleSections[0].endSec, 35.5);
    assert.equal(timeline.activeId, null);
  });

  test('reset clears all timestamps across all sections', () => {
    sampleSections[0].startSec = 1.0;
    sampleSections[0].endSec = 5.0;
    sampleSections[1].startSec = 5.0;

    timeline.reset('sec-2');

    assert.equal(timeline.activeId, 'sec-2');
    assert.equal(sampleSections[0].startSec, null);
    assert.equal(sampleSections[0].endSec, null);
    assert.equal(sampleSections[1].startSec, null);
    assert.equal(sampleSections[1].endSec, null);
    assert.equal(changedSection.title, 'Main Story');
  });

  test('missed boundary words use cadence lookback', () => {
    // Section 1 active at t=1.0s
    elapsedSec = 1.0;
    timeline.wordSeen({ sectionId: 'sec-1', original: 'Welcome', globalIdx: 0 }, true);
    assert.equal(sampleSections[0].startSec, 0.9);

    // Speaker progresses and Whisper skips words 50..52 in Section 2, first seeing word 53 at t=12.0s
    elapsedSec = 12.0;
    timeline.wordSeen({ sectionId: 'sec-2', original: 'Deep', globalIdx: 53 }, true);

    // 3 missed words * 0.4s = 1.2s lookback => 12.0 - 1.2 = 10.8s
    assert.equal(sampleSections[0].endSec, 10.8);
    assert.equal(sampleSections[1].startSec, 10.8);
    assert.equal(timeline.activeId, 'sec-2');
  });

  test('unreached trailing sections resolve correctly when unaccounted time remains', () => {
    sampleSections[0].startSec = 1.0;
    sampleSections[0].endSec = 4.0;
    sampleSections[1].startSec = null;
    sampleSections[1].endSec = null;
    sampleSections[2].startSec = null;
    sampleSections[2].endSec = null;

    // Session recorded 10.0s of audio, leaving 6.0s unaccounted for across sec-2 and sec-3
    const resolved = timeline.resolveBoundaries(10.0);

    // Section 1 startSec is always anchored to 0 by resolveBoundaries
    assert.equal(resolved[0].startSec, 0);
    assert.equal(resolved[0].endSec, 4.0);

    // sec-2 gets 4.0 to 7.0 (3.0s slice)
    assert.equal(resolved[1].startSec, 4.0);
    assert.equal(resolved[1].endSec, 7.0);

    // sec-3 gets 7.0 to 10.0 (3.0s slice)
    assert.equal(resolved[2].startSec, 7.0);
    assert.equal(resolved[2].endSec, 10.0);
  });

  test('unreached trailing sections without unaccounted elapsed time remain null', () => {
    sampleSections[0].startSec = 1.0;
    sampleSections[0].endSec = 5.0;
    sampleSections[1].startSec = null;
    sampleSections[1].endSec = null;

    // Session ended exactly when Section 1 ended
    const resolved = timeline.resolveBoundaries(5.0);

    // Section 1 startSec is always anchored to 0 by resolveBoundaries
    assert.equal(resolved[0].startSec, 0);
    assert.equal(resolved[0].endSec, 5.0);
    assert.equal(resolved[1].startSec, null);
    assert.equal(resolved[1].endSec, null);
  });

  test('resolveBoundaries anchors Section 1 startSec to 0 when Whisper CPU latency caused late recognition (real-world regression)', () => {
    // Reproduces the exact failure observed in the field:
    // totalSessionSec=18.583s, speaker read each section for ~12s.
    // Whisper on CPU ran ~15s behind: first Section 1 token arrived at t=14.989s.
    // Without anchor: Section 1 sliced to [14.989, 16.989] = 2.0s (missing 12s of speech).
    // With anchor: Section 1 sliced from t=0, capturing the full recording.
    sampleSections[0].startSec = 14.989; // Whisper's late recognition stamp
    sampleSections[0].endSec = 16.989;
    sampleSections[0]._lastSeenSec = 15.089;
    sampleSections[1].startSec = 16.161;
    sampleSections[1].endSec = 18.583;
    sampleSections[1]._lastSeenSec = 17.930;

    const resolved = timeline.resolveBoundaries(18.583);

    // Section 1 MUST be anchored to 0, not left at 14.989
    assert.equal(resolved[0].startSec, 0,
      'Section 1 startSec must be anchored to 0 — Whisper latency must not collapse the take window');
    assert.equal(resolved[0].endSec, 16.989, 'Section 1 endSec unchanged');
    assert.ok(resolved[0].endSec - resolved[0].startSec >= 12.0,
      `Section 1 duration must cover ~12s of spoken audio, got: ${resolved[0].endSec - resolved[0].startSec}s`);

    // Section 2 boundaries should be preserved
    assert.equal(resolved[1].startSec, 16.161);
    assert.equal(resolved[1].endSec, 18.583);
  });

  test('caps cadence lookback and enforces duration floor preventing section collapse on delayed speech recognition', () => {
    // Section 1 has 10 words (startIndex: 0, endIndex: 9)
    sampleSections[0].startIndex = 0;
    sampleSections[0].endIndex = 9;

    // Speaker starts Section 1 at t=1.0s and speaks until t=7.0s
    elapsedSec = 1.0;
    timeline.wordSeen({ sectionId: 'sec-1', original: 'Welcome', globalIdx: 0 }, true);
    assert.equal(sampleSections[0].startSec, 0.9);

    elapsedSec = 7.0;
    timeline.wordSeen({ sectionId: 'sec-1', original: 'LastWord', globalIdx: 9 }, true);

    // Section 2 first recognized word at t=7.5s, but Whisper skips 15 words deep (globalIdx: 65, startIndex: 50)
    // Without lookback capping, lookback would be 15 * 0.4s = 6.0s => 7.5 - 6.0 = 1.5s, collapsing Section 1.
    // With capping to 1.2s max, lookback is at most 1.2s => 7.5 - 1.2 = 6.3s.
    // Furthermore, duration floor ensures Section 1 endSec is at least its last seen word (7.0s).
    elapsedSec = 7.5;
    timeline.wordSeen({ sectionId: 'sec-2', original: 'DeepWord', globalIdx: 65 }, true);

    assert.equal(timeline.activeId, 'sec-2');
    assert.ok(sampleSections[0].endSec >= 7.0, `Section 1 endSec (${sampleSections[0].endSec}) must not collapse below spoken duration floor (7.0s)`);
    assert.ok(sampleSections[0].endSec - sampleSections[0].startSec >= 6.0, 'Section 1 must retain full spoken duration');
  });

  test('startup highlight call with isSessionActive=false must NOT freeze Section 1 startSec at t≈0', () => {
    // Simulates app.js calling updateHighlighting(0) at session start (t≈0.001s)
    // with isPrompting temporarily set to false — wordSeen must skip all timestamp mutations.
    elapsedSec = 0.001; // t≈0 just after sessionStartTime assigned

    // This mirrors the startup positional-only call (isSessionActive=false guard)
    timeline.wordSeen({ sectionId: 'sec-1', original: 'Welcome', globalIdx: 0 }, false /* isSessionActive=false */);

    // startSec must remain null — no timestamp frozen at startup
    assert.equal(sampleSections[0].startSec, null,
      'Section 1 startSec must not be stamped at t≈0 by the startup positioning call');
    assert.equal(sampleSections[0]._lastSeenSec, null,
      'Section 1 _lastSeenSec must not be stamped at t≈0 by the startup positioning call');

    // Now real speech arrives at t=3.5s — startSec must be stamped correctly
    elapsedSec = 3.5;
    timeline.wordSeen({ sectionId: 'sec-1', original: 'Welcome', globalIdx: 0 }, true /* isSessionActive=true */);

    assert.equal(sampleSections[0].startSec, 3.4,
      'Section 1 startSec must be stamped from first real spoken word, not from startup positioning call');
    assert.equal(sampleSections[0]._lastSeenSec, 3.5);

    // Section 2 arrives at t=12.0s — Section 1 end boundary must reflect actual spoken duration, not t≈0 start
    elapsedSec = 12.0;
    timeline.wordSeen({ sectionId: 'sec-2', original: 'Next', globalIdx: 50 }, true);

    assert.equal(sampleSections[0].endSec, 12.0);
    assert.ok(sampleSections[0].endSec - sampleSections[0].startSec >= 8.0,
      `Section 1 must span its full spoken duration (~8.6s), not collapse to near-zero. Got: ${sampleSections[0].endSec - sampleSections[0].startSec}s`);
  });

  test('resolveBoundaries respects retakeSec on Section 1 and does not anchor to 0 if retaken', () => {
    sampleSections[0].retakeSec = 8.5;
    sampleSections[0].startSec = 8.7;
    sampleSections[0].endSec = 15.0;

    const resolved = timeline.resolveBoundaries(15.0);

    assert.equal(resolved[0].startSec, 8.5, 'Section 1 must be anchored to its retakeSec, not 0');
    assert.equal(resolved[0].endSec, 15.0);
  });

  test('resolveBoundaries clamps active section startSec to retakeSec if speech recognition stamped earlier', () => {
    sampleSections[0].startSec = 0;
    sampleSections[0].endSec = 10.0;
    sampleSections[1].retakeSec = 14.0;
    sampleSections[1].startSec = 11.5; // Stamped during aborted take
    sampleSections[1].endSec = 22.0;

    const resolved = timeline.resolveBoundaries(22.0);

    assert.equal(resolved[1].startSec, 14.0, 'Section 2 startSec must be clamped to retakeSec (14.0s)');
    assert.equal(resolved[1].endSec, 22.0);
  });
});

