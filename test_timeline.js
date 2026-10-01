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
    });
    // Timestamps reset
    assert.equal(sampleSections[1].startSec, null);
    assert.equal(sampleSections[1].endSec, null);
  });

  test('retake falls back to first section if none active', () => {
    const retakeResult = timeline.retake();
    assert.deepEqual(retakeResult, {
      seekIndex: 0,
      title: 'Intro',
      id: 'sec-1',
    });
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

    assert.equal(resolved[0].startSec, 1.0);
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

    assert.equal(resolved[0].startSec, 1.0);
    assert.equal(resolved[0].endSec, 5.0);
    assert.equal(resolved[1].startSec, null);
    assert.equal(resolved[1].endSec, null);
  });
});
